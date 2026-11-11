// Package server 是对浏览器的 HTTP / WebSocket 层。
package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"terminals/internal/config"
	"terminals/internal/history"
	"terminals/internal/session"
	"terminals/ui"
)

// Options 是服务层配置。
type Options struct {
	// Base 是网关前缀，例如 /app/terminals。开发模式下为空。
	Base string
	// RequireAdmin 为 true 时校验网关注入的 X-Trim-Isadmin。
	RequireAdmin bool
	// Dev 为 true 时放宽 Origin 校验，方便本地 localhost 调试。
	Dev     bool
	Version string
	// Layout 是标签与分屏布局的存储。nil 表示不启用 /api/layout。
	Layout *LayoutStore
	// Settings 是用户设置的存储。nil 时退回一份内存默认值，
	// 这样开发模式下不配 --data-dir 也能打开设置页。
	Settings *config.Store
	// History 是会话历史仓库。nil 表示不记录 / 不提供历史面板。
	History *history.Store
}

// Server 组装路由与中间件。
type Server struct {
	mgr *session.Manager
	opt Options
	mux *http.ServeMux
}

// New 创建服务。
func New(mgr *session.Manager, opt Options) *Server {
	opt.Base = strings.TrimSuffix(opt.Base, "/")
	if opt.Settings == nil {
		opt.Settings = config.NewStore("")
	}
	s := &Server{
		mgr: mgr,
		opt: opt,
		mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) routes() {
	// 路由一律按"没有网关前缀"来注册，前缀由 basePath 中间件统一剥掉。
	// 这样同一个二进制既能挂在 /app/terminals 下，也能被网关剥掉前缀后
	// 直接以 / 为根提供服务，不需要改两份路由表。
	s.mux.HandleFunc("/api/healthz", s.handleHealthz)
	s.mux.HandleFunc("/api/config", s.handleConfig)
	s.mux.HandleFunc("/api/sessions", s.handleSessions)
	s.mux.HandleFunc("/api/sessions/", s.handleSessionByID)
	s.mux.HandleFunc("/api/ws", s.handleWS)
	s.mux.HandleFunc("/api/wscheck", s.handleWSCheck)
	s.mux.HandleFunc("/api/layout", s.handleLayout)
	s.mux.HandleFunc("/api/settings", s.handleSettings)
	s.mux.HandleFunc("/api/history", s.handleHistory)
	s.mux.HandleFunc("/api/history/", s.handleHistoryByID)

	// 静态资源：http.FileServerFS 自带路径穿越防护（会拒绝 ..），
	// 不需要自己拼路径。
	s.mux.Handle("/", s.staticUI())
}

// staticUI 提供前端资源，顺手解决升级后浏览器仍在跑旧代码的问题。
//
// 两个坑叠在一起：
//
//  1. 前端是 go:embed 进二进制的，embed.FS 的文件修改时间是零值，Go 的
//     FileServer 因此不发 Last-Modified、不发 ETag。浏览器拿不到任何校验
//     凭据，就按启发式规则自己决定缓存多久 —— 升级完打开页面，跑的还是
//     上一版 app.js。用户看到的就是"明明更新了，bug 还在"。
//  2. 老版本被缓存下来之后，光加 Cache-Control 也追不回来：那份响应的头
//     是旧的。所以要换 URL —— index.html 里的 __V__ 每次都会替换成当前
//     版本号，升级后 app.js?v=0.2.15 是一个浏览器从没见过的地址。
//
// 顺带一提：版本号取自 session.Version，与 READY 帧里报的是同一个值，
// 排查时可以拿它和设置页显示的版本对账。
func (s *Server) staticUI() http.Handler {
	files := http.FileServerFS(ui.FS)
	index, err := ui.FS.ReadFile("index.html")
	ver := url.QueryEscape(session.Version)
	if err == nil {
		index = bytes.ReplaceAll(index, []byte("__V__"), []byte(ver))
	}

	// app.js 自己也埋了一份版本号（前端顶部那个 BUILD）。
	//
	// 只给 index.html 打桩是不够的：设置页要回答"浏览器执行的到底是哪一份
	// 脚本"，而答案只能来自脚本自己。这里顺手替换掉那个占位符，代价是
	// 一份几 KB 的替换，换来的是升级之后"服务端 0.5.2 / 页面脚本 0.5.1"
	// 这种状态能一眼看出来，而不是靠猜。
	appJS, appErr := ui.FS.ReadFile("app.js")
	if appErr == nil && bytes.Contains(appJS, []byte("__V__")) {
		appJS = bytes.ReplaceAll(appJS, []byte("__V__"), []byte(session.Version))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// no-cache：可以存，但每次都要回源确认。局域网里多跑一次请求，
		// 换来的是"升级即生效"，值。
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")

		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if err != nil {
				http.Error(w, "index.html missing", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", strconv.Itoa(len(index)))
			_, _ = w.Write(index)
			return
		}
		if r.URL.Path == "/app.js" && appErr == nil {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Content-Length", strconv.Itoa(len(appJS)))
			_, _ = w.Write(appJS)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// basePath 把网关前缀从请求路径上剥掉。
//
// 两件必须做的事：
//  1. 应用中心的桌面入口配的是 /app/terminals（没有尾斜杠）。浏览器请求这个
//     地址时，mux 里只注册了 "/"，能命中目录但 FileServerFS 会把它当文件找，
//     拿不到 index.html —— 表现就是"打开显示 404"。这里补一次跳转到
//     /app/terminals/，顺便让页面里的相对路径（vendor/xterm.js 等）解析正确。
//  2. 请求路径带前缀时剥掉，交给无前缀的路由表。
func (s *Server) basePath(next http.Handler) http.Handler {
	base := s.opt.Base
	if base == "" || base == "/" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == base {
			target := base + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		if strings.HasPrefix(p, base+"/") {
			r.URL.Path = strings.TrimPrefix(p, base)
			r.URL.RawPath = ""
		}
		// 不带前缀的请求（网关已经剥掉了）原样放行。
		next.ServeHTTP(w, r)
	})
}

// Handler 返回套好中间件的入口。
func (s *Server) Handler() http.Handler {
	return s.securityHeaders(s.auth(s.errorLog(s.basePath(s.mux))))
}

// errorLog 只记录 4xx/5xx。
//
// 远端排障时最有用的信息就是这个：如果打开页面报 404，而日志里完全没有
// 对应的记录，说明请求根本没走到本进程（网关没转发或应用没起来）；有记录
// 就能直接看到网关实际传过来的路径长什么样。
func (s *Server) errorLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status >= 400 {
			// 不记 UA/Referer，nginx 已经有一份，重复记录只会让日志变长。
			log.Printf("HTTP %d %s %s (host=%s)", rec.status, r.Method, r.URL.RequestURI(), r.Host)
		}
	})
}

// statusRecorder 记住响应状态码。必须把 Hijack / Flush 原样透出去，
// 否则 gorilla/websocket 的 Upgrade 会因为拿不到 http.Hijacker 而失败。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return h.Hijack()
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap 让 http.ResponseController（以及依赖它的库）能拿到底层 writer。
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// securityHeaders 统一加安全响应头。
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; "+
				"style-src 'self' 'unsafe-inline'; script-src 'self'; "+
				"connect-src 'self' ws: wss:; font-src 'self'; "+
				"object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// auth 校验管理员身份。生产环境下网关注入 X-Trim-Isadmin。
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.opt.RequireAdmin {
			next.ServeHTTP(w, r)
			return
		}
		v := r.Header.Get("X-Trim-Isadmin")
		if v == "true" || v == "1" {
			next.ServeHTTP(w, r)
			return
		}
		writeJSON(w, http.StatusForbidden, map[string]any{
			"ok":    false,
			"error": "需要管理员权限才能使用终端",
		})
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"data": map[string]any{
			"version":  s.opt.Version,
			"sessions": s.mgr.Count(),
		},
	})
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.mgr.Config()
	// 把权限形态如实报给前端：前端据此决定要不要显示"当前为 root"的风险提示，
	// 以及"需要提权请 sudo -i"的引导。
	priv := "user"
	switch {
	case cfg.RunAs == "" || cfg.RunAs == "root":
		priv = "root"
	case cfg.Sudo:
		priv = "sudo"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"data": map[string]any{
			"version":     s.opt.Version,
			"shell":       cfg.Shell,
			"cwd":         cfg.Cwd,
			"maxSessions": cfg.MaxSessions,
			"base":        s.opt.Base + "/",
			"runAs":       cfg.RunAs,
			"privilege":   priv,
		},
	})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": s.mgr.List()})

	case http.MethodPost:
		var body struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Cols <= 0 {
			body.Cols = 120
		}
		if body.Rows <= 0 {
			body.Rows = 32
		}
		sess, err := s.mgr.Create("", body.Cols, body.Rows)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": sess.Info()})

	case http.MethodDelete:
		// 不带 id 的 DELETE 是"批量收尾"：
		//   ?idle=1 —— 只杀没有页面挂着的（冷启动时清理上一轮残留）
		//   否则     —— 全杀，对应界面上的"结束全部"
		var n int
		if v := r.URL.Query().Get("idle"); v == "1" || v == "true" {
			n = s.mgr.CloseIdle()
		} else {
			n = s.mgr.CloseAll()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"closed": n}})

	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleSessionByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// 走到这里时网关前缀已经被 basePath 剥掉了，直接按无前缀路径取值。
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少会话 id"})
		return
	}
	ok := s.mgr.Kill(id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "data": map[string]any{"sid": id}})
}
