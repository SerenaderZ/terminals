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

	altMu sync.Mutex
	alt   altScanner

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
func newSession(cfg Config, id string, cols, rows int) (*Session, error) {
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

			_, _ = s.ring.Write(chunk)

			s.altMu.Lock()
			s.alt.scan(chunk)
			s.altMu.Unlock()

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

	close(s.done)
}

// Attach 挂载一个客户端，返回客户端句柄和需要回放的输出。
//
// truncated 表示回放缓冲已经写满过、开头被覆盖 —— 前端拿到这种回放必须先
// 把屏幕清干净再灌，否则旧画面会和回放叠在一起。
func (s *Session) Attach() (c *Client, replay []byte, inAlt, needAltEnter, truncated bool) {
	payload := s.ring.Snapshot()
	truncated = s.ring.Truncated()

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

	return c, payload, inAlt, needAltEnter, truncated
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.proc.Write(p)
	return err
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
func (s *Session) Ready(inAlt, needAltEnter bool, replayLen int, truncated bool) Ready {
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
	}
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
