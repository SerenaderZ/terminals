package server

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"terminals/internal/proto"
	"terminals/internal/session"
)

// 心跳间隔必须小于网关的 proxy_read_timeout（飞牛是 300s），
// 否则空闲终端会被网关掐断。
const pingInterval = 20 * time.Second

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     checkOrigin,
}

// 来源校验的三种结论。除"不匹配"外都放行，分开只是为了让
// /api/wscheck 能把判断依据原样告诉前端。
const (
	originSame     = "same"
	originNoHeader = "no-origin"
	originMismatch = "mismatch"
)

// checkOrigin 防 CSWSH：只有同主机的页面才能建连。
// 开发模式下放开，方便 localhost / 局域网调试。
func checkOrigin(r *http.Request) bool {
	return originVerdict(r) != originMismatch
}

// originVerdict 判断页面来源是否可信。
//
// 这里不能拿 Origin 和 r.Host 逐字比，也不能用 HasSuffix 拼出来比。
// nginx 的 `proxy_set_header Host $host;` 会把端口去掉，而浏览器在非标准
// 端口上访问时 Origin 一定带端口：飞牛的局域网入口是 http://<ip>:5666，
// 远程访问是 https://<域名>（443）。逐字比的结果是"远程能用、局域网被判成
// 跨站"，用户看到的现象恰好是"服务在线，但 WebSocket 一直连不上"。
//
// 所以先比完整的 host:port，再退一步只比主机名。端口在反代后面本来就可能
// 被改写，主机名一致才是"同一个站点"更可靠的证据。
func originVerdict(r *http.Request) string {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// 非浏览器客户端（curl / 脚本）。生产环境仍由管理员头把关。
		return originNoHeader
	}

	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return originMismatch
	}

	for _, c := range originHosts(r) {
		if sameHost(c, u.Host) {
			return originSame
		}
	}
	return originMismatch
}

// originHosts 列出所有可能代表"本站"的 host。
// 网关改写 Host 的方式五花八门，多给几个候选比猜一个更靠谱。
func originHosts(r *http.Request) []string {
	out := make([]string, 0, 4)
	for _, name := range []string{"X-Forwarded-Host", "X-Forwarded-Server", "X-Original-Host"} {
		if v := firstValue(r.Header.Get(name)); v != "" {
			out = append(out, v)
		}
	}
	if r.Host != "" {
		out = append(out, r.Host)
	}
	return out
}

func sameHost(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if strings.EqualFold(a, b) {
		return true
	}
	ha, hb := hostOnly(a), hostOnly(b)
	return ha != "" && strings.EqualFold(ha, hb)
}

// hostOnly 去掉端口。带方括号的 IPv6 也一并收拾掉，
// 免得 "::1" 和 "[::1]" 被判成两台机器。
func hostOnly(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return strings.Trim(h, "[]")
}

// handleWSCheck 把"服务端眼里这次请求长什么样"报给前端。
//
// WebSocket 的失败在浏览器里一律是 1006，脚本拿不到 403/400 的区别，
// 用户只能看到"连不上"。这个端点走同一条 HTTP 链路：能通就说明网关是通的，
// 再把 Origin / Host 原样回给前端，断线浮层就能直接指出是不是网关改了 Host。
func (s *Server) handleWSCheck(w http.ResponseWriter, r *http.Request) {
	v := originVerdict(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"data": map[string]any{
			"verdict":       v,
			"accept":        v != originMismatch,
			"origin":        r.Header.Get("Origin"),
			"host":          r.Host,
			"forwardedHost": firstValue(r.Header.Get("X-Forwarded-Host")),
		},
	})
}

func firstValue(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		return strings.TrimSpace(v[:i])
	}
	return strings.TrimSpace(v)
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
		if n > 10000 {
			return def
		}
	}
	if n <= 0 {
		return def
	}
	return n
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cols := atoiDefault(q.Get("cols"), 120)
	rows := atoiDefault(q.Get("rows"), 32)
	sid := q.Get("sid")
	// hist 表示"这个窗格是为了继续某一条历史记录而开的"。
	//
	// 只在真正新建会话时生效：浏览器刷新时 URL 上还带着它，但 sid 命中的
	// 会话还活着，直接复用 —— 否则每刷新一次就给同一条记录添一个新会话。
	hist := q.Get("hist")

	up := upgrader
	if s.opt.Dev {
		up.CheckOrigin = func(*http.Request) bool { return true }
	}

	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	sess, err := s.mgr.GetOrCreate(sid, hist, cols, rows)
	if err != nil {
		_ = conn.WriteMessage(websocket.BinaryMessage,
			proto.Frame(proto.KindError, []byte(err.Error())))
		return
	}

	client, replay, inAlt, needAltEnter, truncated, replayOK := sess.Attach(cols)
	defer sess.Detach(client)

	// 宽度对不上时 Attach 会故意不给回放：那段历史是在另一个列数下写的，
	// 按现在的宽度灌回去只会得到一屏叠字。这里告诉前端"没有回放"，它清屏
	// 之后等程序自己重画 —— 前端发现 READY 的 cols 和 xterm 不一致会补一次
	// Resize，内核下发 SIGWINCH，全屏程序整屏重绘，shell 也会重画提示符。
	//
	// READY 必须在回放之前发：前端要先知道 sid 和是否在备用屏幕。
	// replayLen 一起带上，前端据此在灌回放之前把屏幕清干净 —— 不清的话
	// 重连后旧画面会和新回放叠成一团重影。
	readyJSON, _ := json.Marshal(sess.Ready(inAlt, needAltEnter, len(replay), truncated, !replayOK))
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, proto.Frame(proto.KindReady, readyJSON)); err != nil {
		return
	}
	if out := session.PrepareReplay(replay, truncated); len(out) > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, proto.Frame(proto.KindOutput, out)); err != nil {
			return
		}
	}

	// 这里刻意**不**按 URL 里的 cols/rows 去 Resize 已有会话。
	//
	// 建连那一刻浏览器往往还没 fit 完，URL 里带的是默认的 80x24。拿它去改
	// PTY，等于把真实尺寸踩成 80x24，紧接着前端 fit 完又改回来 —— 两次
	// SIGWINCH。Claude Code 用的 Ink 每收到一次就会把整个会话历史重排后
	// 重新打印，于是屏幕上出现两份一模一样的记录：用户说的"说着说着，
	// 前面的话又出现一遍"就是这么来的。
	//
	// 尺寸对账交给前端：READY 里带了 PTY 的真实 cols/rows，xterm 那边
	// 一旦不一致就发一次 Resize。一致的时候什么也不发生 —— 这才是常态
	// （刷新页面、换窗口大小没变），也就不该有 SIGWINCH。

	// 接回一个正跑着 TUI（vim / htop / claude）的会话时，回放给客户端的是
	// "按当时尺寸做的增量重绘"字节流；新窗口尺寸/重绘节奏对不上，屏上就是一片花。
	//
	// 处理办法分两种情况，不能一刀切：
	//
	//   - 尺寸真的变了：前端发现 READY 里的 cols/rows 和 xterm 对不上，会补一次
	//     Resize，内核下发 SIGWINCH，程序自己按新尺寸整屏重绘，回放留下的错位
	//     字符自然被盖掉。
	//   - 尺寸没变、回放又被环形缓冲截断了：这时没有 SIGWINCH，回放也不完整，
	//     只能主动抖一下逼程序重绘。
	//
	// 反过来，**回放完整时绝不能抖**。Claude Code 用的 Ink 收到 SIGWINCH 会把
	// 整个会话历史重排后重新打印一遍，屏幕上就出现两份一模一样的记录 ——
	// 用户看到的是"说着说着，前面的话又出现了一遍"。
	//
	// 要等一会儿再抖：此刻的 cols/rows 还是"连接建立那一刻"的值，浏览器往往还没
	// 来得及 fit（拿到的仍是默认的 80x24）。在这上面抖，TUI 会按错尺寸重绘一次，
	// 之后浏览器发来真实尺寸时抖动已经用完了 —— 用户看到的就是"内容只占左上角
	// 一块，点一下分屏才铺满"。250ms 足够 fit 完成并把最终尺寸送过来，Nudge 自己
	// 也会重新读一次当前尺寸，不会把新值盖回去。
	if inAlt && truncated {
		go func() {
			time.Sleep(250 * time.Millisecond)
			sess.Nudge()
		}()
	}

	// 单写协程：gorilla 不允许并发写，输出和心跳都从这里走。
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		ping := time.NewTicker(pingInterval)
		defer ping.Stop()

		for {
			select {
			case frame := <-client.Out():
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					conn.Close()
					return
				}
			case <-ping.C:
				if err := conn.WriteControl(websocket.PingMessage, nil,
					time.Now().Add(5*time.Second)); err != nil {
					conn.Close()
					return
				}
			case <-client.Done():
				// 队列满导致的关闭：这条连接已经跟不上 PTY 的输出了。
				//
				// 不能"把剩下的慢慢写完"——塞在队列里的 256 帧只是最近的一小段，
				// 真正的完整内容在会话的回放缓冲里。用 1013 明确告诉前端
				// "立刻重连"，前端连上后回放会把整屏重建，比在这儿硬撑更干净。
				// 硬撑的后果是前端要等这几百帧慢慢发完，这期间 PTY 还在写，
				// 队列只会更满。
				if client.Overflowed() {
					_ = conn.WriteControl(websocket.CloseMessage,
						websocket.FormatCloseMessage(1013, "输出太快，连接跟不上，正在重连"),
						time.Now().Add(time.Second))
					conn.Close()
					return
				}
				// 会话结束：把收尾的退出帧刷出去，再关连接解除读阻塞。
				time.Sleep(100 * time.Millisecond)
				conn.Close()
				return
			}
		}
	}()

	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(3 * pingInterval))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(3 * pingInterval))
	})

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage || len(data) == 0 {
			continue
		}
		switch data[0] {
		case proto.KindInput:
			_ = sess.Write(data[1:])
		case proto.KindResize:
			var rs struct {
				Cols int `json:"cols"`
				Rows int `json:"rows"`
			}
			if json.Unmarshal(data[1:], &rs) == nil && rs.Cols > 0 && rs.Rows > 0 {
				_ = sess.Resize(rs.Cols, rs.Rows)
			}
		case proto.KindSignal:
			// M1 只处理 Ctrl+C：它走 INPUT 的 \x03，这里留空。
		}
	}

	client.Close()
	<-writerDone
}
