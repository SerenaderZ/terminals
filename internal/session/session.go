package session

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"terminals/internal/history"
	"terminals/internal/proto"
)

const (
	// DefaultReplayCap 是回放缓冲容量。够放几十屏输出，更早的历史交给
	// 浏览器端的 scrollback 承担。
	DefaultReplayCap = 256 * 1024

	// clientQueueLen 是单客户端待发队列长度（帧数）。
	// M1 的流控很朴素：队列满就丢弃这一帧。M2 换成信用窗口 + 降级恢复。
	clientQueueLen = 256
)

// ExitInfo 是会话的退出信息。
type ExitInfo struct {
	Code   int `json:"code"`
	Signal int `json:"signal"`
}

// Ready 是会话就绪时发给前端的元信息。
type Ready struct {
	SID          string `json:"sid"`
	Shell        string `json:"shell"`
	Cwd          string `json:"cwd"`
	PID          int    `json:"pid"`
	Cols         int    `json:"cols"`
	Rows         int    `json:"rows"`
	AltScreen    bool   `json:"altScreen"`
	NeedAltEnter bool   `json:"needAltEnter"`
	Version      string `json:"version"`

	// ReplayLen 是紧随 READY 之后那一帧回放的字节数（0 表示没有回放）。
	// 前端据此判断"要不要先把屏幕清空" —— 不清空就直接灌，重连后旧画面
	// 会和新回放叠在一起，看起来就是一堆重影和错位字符。
	ReplayLen int `json:"replayLen"`

	// ReplayTruncated 表示回放的开头被环形缓冲覆盖掉了，起点落在半截
	// 序列上。前端收到 true 时必须整屏重建，不能试图接着旧内容往下写。
	ReplayTruncated bool `json:"replayTruncated"`

	// HistStart 只在"接着一条老记录"时出现：日志里前这么多字节是上一次
	// 留下的完整内容，前端只回放这一段。再往后是新 shell 的启动输出，
	// 其中带清屏序列，整段灌回去会把刚铺好的历史擦掉。
	HistStart   *int64 `json:"histStart,omitempty"`
	HistResumed bool   `json:"histResumed,omitempty"`

	// ReplaySkipped 表示这次挂载**故意没给回放**：缓冲里的历史是在另一个
	// 列数下写的，按现在的宽度灌回去只会得到一屏叠字。前端清屏后等程序
	// 自己重画（Resize 会补一个 SIGWINCH）。
	ReplaySkipped bool `json:"replaySkipped"`
}

// Info 是会话列表里的一项。
type Info struct {
	SID       string `json:"sid"`
	Shell     string `json:"shell"`
	Cwd       string `json:"cwd"`
	PID       int    `json:"pid"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Clients   int    `json:"clients"`
	Alive     bool   `json:"alive"`
	AltScreen bool   `json:"altScreen"`
	Created   int64  `json:"created"`
}

// Client 是一条已挂载的浏览器连接。
//
// 这里刻意不 close 数据通道：Close 只关 done，发送方检查 done 后就不再写。
// 直接 close(ch) 会让并发发送 panic，而终端输出的并发度很高。
type Client struct {
	ID   uint64
	ch   chan []byte
	done chan struct{}
	once sync.Once
	// over 记录"队列满导致的关闭"。
	//
	// 队列满不能用丢帧来对付：终端输出是字节流，少一帧就少几个字节，
	// 轻则画面错字，重则丢在 CSI 序列中间 —— 之后整段输出都会被终端当成
	// 序列参数吞掉，屏幕永久错乱（典型的"退出全屏程序后一屏乱码"）。
	// 所以这里唯一的正确动作是：断开这条连接，让前端重连后靠回放重建。
	over atomic.Bool
}

// Send 非阻塞投递一帧。返回 false 表示投递失败。
//
// 返回 false 有且只有两种原因：连接已关，或者待发队列满了。后者会顺手把
// 连接标记成 overflowed —— 调用方据此断开，而不是继续往里塞。
func (c *Client) Send(frame []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.ch <- frame:
		return true
	default:
		// 队列满：这是"客户端跟不上"，不是"这一帧可以不要"。
		c.over.Store(true)
		return false
	}
}

// Overflowed 报告这条连接是否因为队列满被放弃。
func (c *Client) Overflowed() bool { return c.over.Load() }

// Close 关闭客户端。可重复调用。
func (c *Client) Close() { c.once.Do(func() { close(c.done) }) }

// Out 返回待发帧通道。
func (c *Client) Out() <-chan []byte { return c.ch }

// Done 在客户端关闭时收到信号。
func (c *Client) Done() <-chan struct{} { return c.done }

// Session 是一个真实的伪终端会话。它的生命周期与浏览器连接无关 ——
// 关页面、断网都不会结束它，这是整个项目的立身之本。
type Session struct {
	ID      string
	Shell   string
	Cwd     string
	PID     int
	Created time.Time

	cfg  Config
	proc ptyProcess

	cols int32
	rows int32

	mu      sync.Mutex
	clients map[uint64]*Client
	alive   bool
	exit    *ExitInfo
	seq     uint64

	ring *Ring

	// 回放缓冲里的字节是在哪个宽度下产生的。
	//
	// 终端输出是字节流：同一段字节按 120 列解析和按 100 列解析，画出来是
	// 两幅完全不同的画面。readline / Ink 这些程序重画一行靠的是 "\r + 光标
	// 移动 + 擦除"，宽度一变，这些定位就全落到错的地方 —— 屏幕上出现的是
	// 两行字叠在一起的乱码，而不是"排版变了"。
	//
	// 所以这里记两件事：写缓冲时的列数（replayCols），以及这个列数是从
	// 第几个字节开始生效的（replayMark）。挂载客户端时只回放同一列数下
	// 写出来的那段；列数对不上就干脆不回放，让程序自己重画。
	//
	// 只有 readLoop 一个 goroutine 会写，Attach 会读，用 replayMu 护住。
	replayMu   sync.Mutex
	replayCols int32
	replayMark int64
	written    int64

	altMu sync.Mutex
	alt   altScanner

	// 历史记录：写哪个文件、有没有定名、定名前攒着的输出。
	//
	// histID 和 ID 不一定相同。从历史列表点进来的会话是新会话，但日志要接
	// 着那条老记录往下写 —— 这就是"我打开了老的记录，后续输入的指令还保存
	// 在这一条里"。
	//
	// 命名要等用户敲下第一条命令：只是打开一个窗口、什么都没干，不该留下
	// 记录。在那之前输出先攒在 histBuf 里（shell 的欢迎语、第一条提示符），
	// 定名时一次性补进日志，回看时开头不会是空白。
	histID    string
	histMu    sync.Mutex
	histNamed bool
	histBuf   []byte
	histCmd   cmdScanner
	// histStart 是接手一条老记录时，日志里已经有多少字节属于"上一次"。
	// 前端只回放这一段；再往后是新 shell 的启动输出。
	histStart   int64
	histResumed bool
	// histQuiet 表示"这段输出先别写进日志"。
	//
	// 接手一条老记录时会打开：新 shell 的欢迎语、以及前端为了让用户看到
	// 提示符而补的那个回车，都不属于用户的任何一次操作。不拦的话，每次
	// 点开历史再关掉，日志里就多一行 eason@host:~$ —— 点几次长几行。
	// 等用户真的敲下一条命令，它才转成 false，从那一刻起照常记账。
	histQuiet bool

	writeMu sync.Mutex

	// resizeMu 把"改尺寸"串行化。
	//
	// Resize 来自 WebSocket 读循环，Nudge 来自建连后的补抖。两个 goroutine
	// 各发各的 ioctl，交错顺序不受控：抖动那次的"恢复"可能先落地、浏览器的
	// 真实尺寸后落地，也可能反过来 —— 最后 PTY 停在哪个值全看调度。
	// 尺寸只要错一列，全屏程序（claude / htop）画的横线就短一截，
	// 退出后留在主屏上就是错位的字符。
	resizeMu sync.Mutex

	// killOnce 让 Kill 幂等：关窗格、结束全部、退出清理可能都指向同一个会话，
	// 重复对已经回收的 pid 发信号，运气不好会打到被复用的 pid 上。
	killOnce sync.Once

	done     chan struct{}
	readDone chan struct{}
}

func newID() string {
	var b [5]byte
	_, _ = rand.Read(b[:])
	return "s" + hex.EncodeToString(b[:])
}

// newSession 创建一个真实会话。
//
// id 非空表示"认领一个已存在的会话"（core 重启后接管 tmux 会话），
// 此时 sid 沿用旧值，前端 localStorage 里存着它，重连就自动接上了。
//
// histID 非空表示"接着一条历史记录往下写"。它和 id 是两回事：沿用老记录的
// 会话会有一个全新的 id，日志却写在老记录的文件里。
func newSession(cfg Config, id, histID string, cols, rows int) (*Session, error) {
	if cols < 2 {
		cols = 2
	}
	if rows < 2 {
		rows = 2
	}

	if id == "" {
		id = newID()
	}

	s := &Session{
		ID:       id,
		Shell:    cfg.Shell,
		Cwd:      cfg.Cwd,
		Created:  time.Now(),
		cfg:      cfg,
		clients:  make(map[uint64]*Client),
		alive:    true,
		ring:     NewRing(cfg.ReplayCap),
		done:     make(chan struct{}),
		readDone: make(chan struct{}),
	}

	env := buildEnv(cfg.Shell, cfg.Cwd, cfg.RunAs, cfg.RunAsHome)
	atomic.StoreInt32(&s.cols, int32(cols))
	atomic.StoreInt32(&s.rows, int32(rows))

	// tmux 模式下，真正要 exec 的是 tmux 客户端；对内层程序来说 TERM 由
	// tmux 决定，对我们来说看到的还是那个 PTY，前端无感知。
	spawnShell, spawnArgs := cfg.Shell, cfg.ShellArgs
	if cfg.Backend == BackendTmux {
		spawnShell = "tmux"
		spawnArgs = buildTmuxArgs(cfg.TmuxConf, id, cfg.Cwd, cfg.Shell, cfg.ShellArgs, detectLocale())
	}

	proc, err := spawnPTY(spawnOpts{
		Shell: spawnShell,
		Args:  spawnArgs,
		Cwd:   cfg.Cwd,
		Env:   env,
		Cols:  cols,
		Rows:  rows,
		User:  cfg.RunAs,
	})
	if err != nil && cfg.Cwd != "" && cfg.Cwd != "/" && isMissingOrDenied(err) {
		// 启动时已经试跑过，但目录可能在运行期消失（用户删了自己的 home、
		// 挂载点掉了）。这种情况不该让整个会话起不来，退到根目录继续。
		log.Printf("工作目录 %s 起不来（%v），本次会话改用 /", cfg.Cwd, err)
		cfg.Cwd = "/"
		env = buildEnv(cfg.Shell, cfg.Cwd, cfg.RunAs, cfg.RunAsHome)
		proc, err = spawnPTY(spawnOpts{
			Shell: spawnShell,
			Args:  spawnArgs,
			Cwd:   cfg.Cwd,
			Env:   env,
			Cols:  cols,
			Rows:  rows,
			User:  cfg.RunAs,
		})
	}
	if err != nil {
		// 这条错误会直接显示在页面上，所以写清楚：Go 的 fork/exec 在 chdir
		// 失败时同样报 no such file or directory，光看那句话会误以为是 shell 没了。
		return nil, fmt.Errorf(
			"启动 shell 失败（shell=%s，工作目录=%s）：%w；"+
				"若提示 no such file or directory，通常是工作目录不存在或该账户无权进入，不一定是 shell 缺失",
			spawnShell, cfg.Cwd, err)
	}

	s.proc = proc
	s.PID = proc.Pid()

	// 历史记录从这里开始记账，但**不一定**马上开一条：默认要等用户敲下
	// 第一条命令（见 histName），什么都没干的窗口不该出现在历史里。
	//
	// 从历史列表点进来的（histID 非空）沿用老记录：直接接上去，后面所有
	// 输出都追加进同一个文件，列表里始终只有那一行。
	if h := cfg.History; h != nil {
		s.histID = id
		resume := id
		if histID != "" {
			resume = histID
		}
		if start, ok := h.Resume(resume); ok {
			s.histID = resume
			s.histNamed = true
			s.histStart = start
			s.histResumed = true
			// 先别往老记录里写：接下来这一秒的输出（欢迎语、以及前端补的
			// 那个回车换来的提示符）都是打开动作的副产物，不是用户干的事。
			// 见 histQuiet 的说明。
			s.histQuiet = true
		}
	}

	go s.readLoop()
	go s.waitLoop()

	return s, nil
}

// readLoop 把 PTY 输出写进环形缓冲，再广播给所有已挂载的客户端。
func (s *Session) readLoop() {
	defer close(s.readDone)

	buf := make([]byte, 32*1024)
	for {
		n, err := s.proc.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.noteWidth(n)
			_, _ = s.ring.Write(chunk)

			s.altMu.Lock()
			s.alt.scan(chunk)
			s.altMu.Unlock()

			// 历史把原始字节照抄一份。注意顺序：先写日志再广播 ——
			// 广播可能因为队列满把连接踢掉，但历史不该受这个影响。
			s.histRecord(chunk)

			s.broadcast(chunk)
		}
		if err != nil {
			return
		}
	}
}

// waitLoop 等进程退出，然后给读协程一点时间把残余输出吐完，再收尾。
func (s *Session) waitLoop() {
	code, _ := s.proc.Wait()

	select {
	case <-s.readDone:
	case <-time.After(2 * time.Second):
	}
	s.finish(code)
}

func (s *Session) broadcast(chunk []byte) {
	frame := proto.Frame(proto.KindOutput, chunk)

	s.mu.Lock()
	var drop []*Client
	for id, c := range s.clients {
		if !c.Send(frame) && c.Overflowed() {
			// 跟不上就断开，绝不丢帧。丢一帧等于往字节流里挖个洞，
			// 落在 CSI 序列中间时后面的输出会被整个吞掉。
			// 断开之后前端重连，回放缓冲里有完整的内容。
			delete(s.clients, id)
			drop = append(drop, c)
		}
	}
	s.mu.Unlock()

	for _, c := range drop {
		c.Close()
	}
}

func (s *Session) finish(code int) {
	s.mu.Lock()
	if !s.alive {
		s.mu.Unlock()
		return
	}
	s.alive = false
	s.exit = &ExitInfo{Code: code}
	clients := make([]*Client, 0, len(s.clients))
	for _, c := range s.clients {
		clients = append(clients, c)
	}
	s.clients = make(map[uint64]*Client)
	s.mu.Unlock()

	payload, _ := json.Marshal(s.exit)
	frame := proto.Frame(proto.KindExit, payload)
	for _, c := range clients {
		c.Send(frame)
		// 给写协程一点时间把退出帧刷出去再关
		go func(c *Client) {
			time.Sleep(200 * time.Millisecond)
			c.Close()
		}(c)
	}

	// 收尾历史：关文件、记结束码。放在 close(done) 之前 —— Wait 那边
	// 只会等 done，之后 Manager 可能立刻把会话删掉，别让记录卡在"还在跑"。
	if h := s.cfg.History; h != nil && s.histID != "" {
		h.End(s.histID, code)
	}

	close(s.done)
}

// noteWidth 在把一块输出写进回放缓冲**之前**调用，记下这块字节是在哪个
// 列数下产生的。列数变了就把"有效起点"挪到当前写入位置 —— 之前的字节
// 都是按旧宽度排的版，不能和新宽度的混着回放。
func (s *Session) noteWidth(n int) {
	cols := atomic.LoadInt32(&s.cols)
	s.replayMu.Lock()
	if cols != s.replayCols {
		s.replayCols = cols
		s.replayMark = s.written
	}
	s.written += int64(n)
	s.replayMu.Unlock()
}

// Attach 挂载一个客户端，返回客户端句柄和需要回放的输出。
//
// truncated 表示回放的开头可能是半截字节（环形缓冲绕回了，或者被下面的
// 宽度裁剪切掉了）—— 前端拿到这种回放必须先清屏、并把起点对齐到安全位置。
//
// ok 为 false 表示"这段历史没法回放"：客户端现在的列数和写这段字节时的
// 列数对不上。这时候回放过去只会得到一屏叠在一起的乱字，不如不回放 ——
// 调用方随后会让 PTY 按新尺寸 Resize，内核补一个 SIGWINCH，全屏程序整屏
// 重绘，shell 也会重画提示符。
func (s *Session) Attach(cols int) (c *Client, replay []byte, inAlt, needAltEnter, truncated, ok bool) {
	payload := s.ring.Snapshot()
	truncated = s.ring.Truncated()

	// 只保留"当前列数这一档"写出来的尾巴。回放缓冲里可能留着切换过宽度
	// 之前的旧字节，那段按现在的宽度解析就是错位。
	s.replayMu.Lock()
	mark, width, written := s.replayMark, int(s.replayCols), s.written
	s.replayMu.Unlock()

	if tail := written - mark; tail >= 0 && tail < int64(len(payload)) {
		payload = payload[int64(len(payload))-tail:]
		truncated = true
	}
	// width 为 0 表示还没有任何输出（刚起会话），没有可回放的东西。
	ok = cols <= 0 || width == 0 || width == cols
	if !ok {
		payload = nil
		truncated = false
	}

	s.altMu.Lock()
	inAlt = s.alt.InAlt()
	s.altMu.Unlock()
	needAltEnter = replayNeedAltEnter(payload, inAlt)

	s.mu.Lock()
	s.seq++
	c = &Client{
		ID:   s.seq,
		ch:   make(chan []byte, clientQueueLen),
		done: make(chan struct{}),
	}
	s.clients[c.ID] = c
	s.mu.Unlock()

	return c, payload, inAlt, needAltEnter, truncated, ok
}

// Detach 解绑一个客户端。挂载守卫保证无论任务如何结束都会调用。
func (s *Session) Detach(c *Client) {
	if c == nil {
		return
	}
	s.mu.Lock()
	delete(s.clients, c.ID)
	s.mu.Unlock()
	c.Close()
}

// Write 把浏览器输入写进 PTY。
func (s *Session) Write(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	s.histNameFromInput(p)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.proc.Write(p)
	return err
}

// 定名前最多攒这么多输出。正常 shell 在第一条命令之前只吐几百字节，
// 512KB 足够兜住一屏登录脚本；再多就只保留前半段，绝不无限吃内存。
const histBufCap = 512 << 10

// histRecord 把一块输出记进历史。
//
// 还没定名的时候只往内存里攒：这个窗口最后可能什么都不算（用户就是扫了
// 一眼提示符），那就一个字节都不该落盘。
func (s *Session) histRecord(chunk []byte) {
	if s.cfg.History == nil {
		return
	}
	s.histMu.Lock()
	if s.histQuiet {
		// 接手老记录、用户还没敲过东西：这段输出直接丢掉。不缓存 ——
		// 它包含清屏序列，下次回放时会把铺好的历史擦掉。
		s.histMu.Unlock()
		return
	}
	if !s.histNamed {
		if len(s.histBuf) < histBufCap {
			s.histBuf = append(s.histBuf, chunk...)
		}
		s.histMu.Unlock()
		return
	}
	id := s.histID
	s.histMu.Unlock()
	s.cfg.History.Append(id, chunk)
}

// histNameFromInput 盯着用户敲的第一条命令，用它给这次会话命名。
//
// 一旦定名就开一条记录，并把定名前攒下的输出补在最前面 —— 这样日志的开头
// 仍然是 shell 的欢迎语和第一条提示符，而不是半截命令。
//
// 接手老记录的会话（histQuiet）走另一条路：名字沿用老的，不用再定；这里
// 只负责认出"用户终于敲了第一条真命令"，把闸门打开。
func (s *Session) histNameFromInput(p []byte) {
	if s.cfg.History == nil {
		return
	}
	s.histMu.Lock()
	named := s.histNamed
	quiet := s.histQuiet
	s.histMu.Unlock()
	if named && !quiet {
		return
	}
	cmd, ok := s.histCmd.Scan(p)
	if !ok {
		return
	}

	h := s.cfg.History
	s.histMu.Lock()
	defer s.histMu.Unlock()
	if quiet {
		// 从这一步开始，回显的命令和它的输出才进日志。之前那一行提示符
		// 不再补写：老记录的末尾本来就是上一次留下的提示符，接得上。
		s.histQuiet = false
		return
	}
	if s.histNamed { // 并发下只认第一条
		return
	}
	s.histNamed = true
	h.Begin(history.Entry{
		ID:      s.histID,
		Title:   cmd,
		Cwd:     s.Cwd,
		Shell:   s.Shell,
		Created: s.Created.Unix(),
	})
	if len(s.histBuf) > 0 {
		h.Append(s.histID, s.histBuf)
	}
	s.histBuf = nil
}

// Resize 调整 PTY 行列数。
func (s *Session) Resize(cols, rows int) error {
	if cols < 2 {
		cols = 2
	}
	if rows < 2 {
		rows = 2
	}

	s.resizeMu.Lock()
	defer s.resizeMu.Unlock()

	atomic.StoreInt32(&s.cols, int32(cols))
	atomic.StoreInt32(&s.rows, int32(rows))
	return s.proc.Resize(cols, rows)
}

// Nudge 让 PTY 尺寸抖一下，逼全屏程序整屏重画。
//
// 为什么需要：接回会话时回放的是"按旧尺寸画的"字节流，新窗口尺寸对不上就是
// 一片花；而 TUI 只在收到 SIGWINCH 时才重绘，尺寸恰好没变的话它永远不重画。
//
// 为什么抖高度而不是宽度：抖动期间程序会按临时尺寸重排一次，万一"恢复"
// 那一步没落到（连接刚好断、浏览器又发了新尺寸），宽度错一列就是永久的
// —— claude 退出时那条横线会短一截、主屏错位。高度差一行只会多刷一次屏，
// 视觉上无感，恢复失败也不影响横向排版。
//
// 为什么读当前尺寸、而不是接受调用方传参：抖动要花 80ms，这期间浏览器可能
// 已经 fit 完、把最终行列数发过来了。拿调用瞬间的旧值恢复，会把新尺寸盖回去 ——
// 表现就是换一台分辨率不同的机器打开时，TUI 按小尺寸重绘，画面只占左上角一块。
// 前后两次都重新读原子变量，谁后写谁生效。
func (s *Session) Nudge() {
	if s.proc == nil {
		return
	}

	s.resizeMu.Lock()
	defer s.resizeMu.Unlock()

	cols := int(atomic.LoadInt32(&s.cols))
	rows := int(atomic.LoadInt32(&s.rows))
	if cols < 3 || rows < 4 {
		return
	}
	_ = s.proc.Resize(cols, rows-1)
	time.Sleep(80 * time.Millisecond)
	_ = s.proc.Resize(int(atomic.LoadInt32(&s.cols)), int(atomic.LoadInt32(&s.rows)))
}

// Kill 结束会话，连同里面跑着的一切。
//
// 顺序有讲究：先关 PTY 主设备，让前台进程组收到 SIGHUP（TUI 能借这个信号
// 恢复终端、存盘），再按进程树收网。只关 PTY 是不够的 —— 后台任务
// （`cmd &` 起的、job control 放到别的进程组的）收不到 SIGHUP，
// 关掉窗格后会一直留在后台。用户点 × 的预期是"这一格彻底停掉"。
//
// tmux 后端还要再显式 kill 掉 tmux 会话：我们配置了 destroy-unattached off，
// 不显式清理的话关标签会留下一个永远跑着的 shell —— 那是资源泄漏，不是"保活"。
func (s *Session) Kill() {
	s.killOnce.Do(func() {
		if s.proc == nil {
			return
		}
		pid := s.proc.Pid()
		_ = s.proc.Close()
		terminateTree(pid)
		if s.cfg.Backend == BackendTmux {
			_ = tmuxKillSession(s.ID)
		}
	})
}

// Alive 返回会话是否还在运行。
func (s *Session) Alive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.alive
}

// ClientCount 返回当前挂载数。
func (s *Session) ClientCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.clients)
}

// Ready 组装发给前端的就绪信息。
func (s *Session) Ready(inAlt, needAltEnter bool, replayLen int, truncated, skipped bool) Ready {
	return Ready{
		SID:             s.ID,
		Shell:           s.Shell,
		Cwd:             s.Cwd,
		PID:             s.PID,
		Cols:            int(atomic.LoadInt32(&s.cols)),
		Rows:            int(atomic.LoadInt32(&s.rows)),
		AltScreen:       inAlt,
		NeedAltEnter:    needAltEnter,
		Version:         s.cfg.Version,
		ReplayLen:       replayLen,
		ReplayTruncated: truncated,
		ReplaySkipped:   skipped,
		HistStart:       s.histStartPtr(),
		HistResumed:     s.histResumed,
	}
}

// histStartPtr 只在接手老记录时给出起点，普通会话给 nil（JSON 里不出现）。
func (s *Session) histStartPtr() *int64 {
	if !s.histResumed {
		return nil
	}
	v := s.histStart
	return &v
}

// Info 返回会话摘要。
func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.altMu.Lock()
	inAlt := s.alt.InAlt()
	s.altMu.Unlock()

	return Info{
		SID:       s.ID,
		Shell:     s.Shell,
		Cwd:       s.Cwd,
		PID:       s.PID,
		Cols:      int(atomic.LoadInt32(&s.cols)),
		Rows:      int(atomic.LoadInt32(&s.rows)),
		Clients:   len(s.clients),
		Alive:     s.alive,
		AltScreen: inAlt,
		Created:   s.Created.Unix(),
	}
}

// Done 在会话结束时关闭。
func (s *Session) Done() <-chan struct{} { return s.done }
