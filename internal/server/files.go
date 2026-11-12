package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"

	"terminals/internal/files"
)

// maxPathBody 是路径类请求体的上限。正常只有一两百字节，给 64KB 很宽裕。
const maxPathBody = 64 << 10

// handleFiles 是 /api/files/* 的总入口。
//
// 和 /api/layout 一样，路由按"没有网关前缀"注册，前缀由 basePath 剥掉。
func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	sub := strings.TrimPrefix(r.URL.Path, "/api/files/")
	switch sub {
	case "conns":
		s.handleFileConns(w, r)
	case "conns/test":
		s.handleFileConnTest(w, r)
	case "list":
		s.handleFileList(w, r)
	case "home":
		s.handleFileHome(w, r)
	case "cwd":
		s.handleFileCwd(w, r)
	case "file":
		s.handleFileBlob(w, r)
	case "mkdir":
		s.handleFileMkdir(w, r)
	case "rename":
		s.handleFileRename(w, r)
	case "remove":
		s.handleFileRemove(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "未知接口"})
	}
}

// fileFS 按 ?conn= 取文件视图。缺省是本机。
func (s *Server) fileFS(w http.ResponseWriter, r *http.Request) (files.FS, bool) {
	svc := s.opt.Files
	if svc == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok": false, "error": "文件面板没有启用（缺少数据目录）",
		})
		return nil, false
	}
	id := r.URL.Query().Get("conn")
	fs, err := svc.FS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": fileErrText(err)})
		return nil, false
	}
	return fs, true
}

func (s *Server) handleFileList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	fs, ok := s.fileFS(w, r)
	if !ok {
		return
	}
	l, err := fs.List(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": l})
}

func (s *Server) handleFileHome(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	svc := s.opt.Files
	if svc == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "文件面板没有启用"})
		return
	}
	id := r.URL.Query().Get("conn")
	home, err := svc.Home(id)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"home": home}})
}

// handleFileCwd 返回某个终端会话此刻的工作目录，用于"侧栏跟着终端走"。
//
// 拿不到就返回空串而不是报错：面板会退回自己记的位置，不该因为"这个
// 平台读不到进程 cwd"就让整个侧栏报一次错。
func (s *Server) handleFileCwd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	sid := r.URL.Query().Get("sid")
	out := map[string]any{"cwd": ""}
	if sid != "" {
		if sess, ok := s.mgr.Get(sid); ok {
			out["cwd"] = sess.LiveCwd()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": out})
}

// handleFileBlob 处理下载（GET）与上传（PUT）。
//
// 两头都是流式的：上传不把整个文件读进内存，下载边读边发。侧栏最常见的
// 用法就是拖一个几百 MB 的文件上去，任何一处全量缓冲都会把内存吃光。
func (s *Server) handleFileBlob(w http.ResponseWriter, r *http.Request) {
	fs, ok := s.fileFS(w, r)
	if !ok {
		return
	}
	target := r.URL.Query().Get("path")

	switch r.Method {
	case http.MethodGet:
		rc, size, err := fs.Open(target)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
			return
		}
		defer rc.Close()

		name := path.Base(fs.Clean(target))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", downloadDisposition(name))
		w.Header().Set("Cache-Control", "no-store")
		if size >= 0 {
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		}
		_, _ = io.Copy(w, rc)

	case http.MethodPut:
		if strings.TrimSpace(target) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少目标路径"})
			return
		}
		n, err := fs.Create(target, r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"size": n}})

	default:
		w.Header().Set("Allow", "GET, PUT")
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

type filePathBody struct {
	Conn      string `json:"conn"`
	Path      string `json:"path"`
	From      string `json:"from"`
	To        string `json:"to"`
	Recursive bool   `json:"recursive"`
}

func decodePathBody(w http.ResponseWriter, r *http.Request) (filePathBody, bool) {
	var b filePathBody
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPathBody+1))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "读取请求体失败"})
		return b, false
	}
	if len(body) > maxPathBody {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体过大"})
		return b, false
	}
	if err := json.Unmarshal(body, &b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "不是合法的 JSON"})
		return b, false
	}
	return b, true
}

func (s *Server) bodyFS(w http.ResponseWriter, id string) (files.FS, bool) {
	svc := s.opt.Files
	if svc == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "文件面板没有启用"})
		return nil, false
	}
	fs, err := svc.FS(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": fileErrText(err)})
		return nil, false
	}
	return fs, true
}

func (s *Server) handleFileMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	b, ok := decodePathBody(w, r)
	if !ok {
		return
	}
	fs, ok := s.bodyFS(w, b.Conn)
	if !ok {
		return
	}
	if strings.TrimSpace(b.Path) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少路径"})
		return
	}
	if err := fs.Mkdir(b.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleFileRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	b, ok := decodePathBody(w, r)
	if !ok {
		return
	}
	fs, ok := s.bodyFS(w, b.Conn)
	if !ok {
		return
	}
	if b.From == "" || b.To == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少源路径或目标路径"})
		return
	}
	if err := fs.Rename(b.From, b.To); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleFileRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	b, ok := decodePathBody(w, r)
	if !ok {
		return
	}
	fs, ok := s.bodyFS(w, b.Conn)
	if !ok {
		return
	}
	if b.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少路径"})
		return
	}
	var err error
	if b.Recursive {
		err = fs.RemoveAll(b.Path)
	} else {
		err = fs.Remove(b.Path)
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ------------------------------------------------------------ 远程连接

type connBody struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	Auth    string `json:"auth"`
	KeyPath string `json:"keyPath"`
	// 用指针区分"没带这个字段"（保持原密码）和"带了一个空串"。
	Password   *string `json:"password"`
	Passphrase *string `json:"passphrase"`
}

func (b connBody) toConn() files.Conn {
	c := files.Conn{
		ID: b.ID, Name: b.Name, Host: b.Host, Port: b.Port, User: b.User,
		Auth: b.Auth, KeyPath: b.KeyPath,
	}
	if b.Password != nil {
		c.Password = *b.Password
	}
	if b.Passphrase != nil {
		c.Passphrase = *b.Passphrase
	}
	return c
}

func (s *Server) handleFileConns(w http.ResponseWriter, r *http.Request) {
	svc := s.opt.Files
	if svc == nil || svc.Store() == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "文件面板没有启用"})
		return
	}
	store := svc.Store()

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": store.List()})

	case http.MethodPost, http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, maxPathBody+1))
		if err != nil || len(body) > maxPathBody {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "读取请求体失败"})
			return
		}
		var b connBody
		if err := json.Unmarshal(body, &b); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "不是合法的 JSON"})
			return
		}
		if b.Port == 0 {
			b.Port = 22
		}
		c, err := store.Save(b.toConn(), b.Password, b.Passphrase)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
			return
		}
		// 配置变了，旧连接不能再复用：主机、账号、密钥都可能换过。
		svc.DropConn(c.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": c})

	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少连接 id"})
			return
		}
		if err := store.Delete(id); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": fileErrText(err)})
			return
		}
		svc.DropConn(id)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// handleFileConnTest 试连一次，不保存。
//
// 编辑已有连接时前端不回填密码，所以这里要能把保存过的密码补上 ——
// 否则每次"测一下"都得让用户重新输一遍。
func (s *Server) handleFileConnTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	svc := s.opt.Files
	if svc == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "文件面板没有启用"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPathBody+1))
	if err != nil || len(body) > maxPathBody {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "读取请求体失败"})
		return
	}
	var b connBody
	if err := json.Unmarshal(body, &b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "不是合法的 JSON"})
		return
	}
	if b.Port == 0 {
		b.Port = 22
	}
	c := b.toConn()
	if b.ID != "" && svc.Store() != nil {
		if old, ok := svc.Store().Get(b.ID); ok {
			if b.Password == nil || *b.Password == "" {
				c.Password = old.Password
			}
			if b.Passphrase == nil || *b.Passphrase == "" {
				c.Passphrase = old.Passphrase
			}
			c.HostKey = old.HostKey
			if b.Host != old.Host || b.Port != old.Port {
				c.HostKey = ""
			}
		}
	}
	home, err := svc.Test(c)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fileErrText(err)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"home": home}})
}

// downloadDisposition 生成下载头。
//
// 中文文件名必须走 RFC 5987 的 filename*，只在 filename= 里塞 UTF-8 会被
// 各家浏览器按 latin1 解，存下来是一串问号。
func downloadDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r < 32 || r > 126 || r == '"' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	return `attachment; filename="` + ascii + `"; filename*=UTF-8''` + url.PathEscape(name)
}

// fileErrText 把底层错误翻成人看得懂的一句话。
//
// 直接把 "open /vol1/x: permission denied" 摊给用户，不如说清是哪一类问题；
// 认不出来的错误原样透出，至少不会丢信息。
func fileErrText(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, files.ErrNotFound):
		return "没有这条连接，可能在别处被删掉了"
	case errors.Is(err, files.ErrNotDir):
		return "这不是一个目录"
	case errors.Is(err, files.ErrNotEmpty):
		return "目录里还有东西，要连里面的内容一起删才行"
	case errors.Is(err, os.ErrNotExist):
		return "找不到这个路径"
	case errors.Is(err, os.ErrPermission):
		return "没有权限（面板用的是终端里那个账户的身份）"
	case errors.Is(err, os.ErrExist):
		return "同名的东西已经存在了"
	}
	return err.Error()
}
