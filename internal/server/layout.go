package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// maxLayoutBytes 是布局文件的大小上限。
//
// 布局里只有标签、分割比例、sid、标题，正常几 KB 就够。给 1MB 余量，
// 超过基本可以断定不是我们的前端在写，直接拒绝比事后排查省事。
const maxLayoutBytes = 1 << 20

// LayoutStore 负责布局文件的读写。
//
// 布局刻意存在服务端而不是 localStorage：换个浏览器、用手机打开，
// 看到的应该是同一份分屏结构。localStorage 只记"上次聚焦的是哪个 pane"。
type LayoutStore struct {
	path string
	mu   sync.Mutex
}

// NewLayoutStore 创建一个布局存储。path 为空表示不启用。
func NewLayoutStore(path string) *LayoutStore {
	if path == "" {
		return nil
	}
	return &LayoutStore{path: path}
}

// Enabled 表示是否真的落盘。
func (s *LayoutStore) Enabled() bool { return s != nil && s.path != "" }

// Read 返回原始 JSON。文件不存在返回 nil。
//
// 直接返回原始字节而不反序列化：服务端不需要理解布局结构，
// 理解它的是前端。这样前端调整字段不用改后端，也就不会出现
// "后端先上线、前端被卡住"的情况。
func (s *LayoutStore) Read() []byte {
	if !s.Enabled() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	if len(b) == 0 || len(b) > maxLayoutBytes {
		return nil
	}
	return b
}

// Write 校验后原子写入。
//
// 校验只做两件事：必须是 JSON 对象、大小达标。再多就是替前端做决定了。
// 原子替换是必须的 —— 拖分隔条时每 400ms 写一次，直接覆盖会写出半个 JSON。
func (s *LayoutStore) Write(b []byte) error {
	if !s.Enabled() {
		return fmt.Errorf("未启用布局存储")
	}
	if len(b) == 0 {
		return fmt.Errorf("布局内容为空")
	}
	if len(b) > maxLayoutBytes {
		return fmt.Errorf("布局超过 %d 字节上限", maxLayoutBytes)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(b, &probe); err != nil {
		return fmt.Errorf("布局不是合法的 JSON 对象: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// handleLayout 是 /api/layout 的处理入口。
func (s *Server) handleLayout(w http.ResponseWriter, r *http.Request) {
	store := s.opt.Layout
	if !store.Enabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok":    false,
			"error": "服务端未启用布局存储（缺少 --layout 参数）",
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		b := store.Read()
		if b == nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": nil})
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)

	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, maxLayoutBytes+1))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "读取请求体失败"})
			return
		}
		if err := store.Write(body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})

	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 GET / PUT"})
	}
}
