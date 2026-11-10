package server

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"terminals/internal/history"
)

// maxHistoryTail 是单次回放的上限。
//
// 日志本身全部保留（用户要求"一条都别丢"），但一次性往浏览器里灌几十 MB
// 只会让页面卡死 —— 终端回看缓冲默认也就一万行，再多也留不住。所以默认
// 只取尾巴，接口留 ?tail= 让调用方自己定。
const maxHistoryTail = 64 << 20

// handleHistory 是历史列表与清空的入口。
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	h := s.opt.History
	if h == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{
			"ok":    false,
			"error": "服务端未启用历史记录（缺少 --data-dir）",
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		items := h.List()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"data": map[string]any{
				"items": items,
				"total": len(items),
			},
		})

	case http.MethodDelete:
		n := h.Clear()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"removed": n}})

	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 GET / DELETE"})
	}
}

// handleHistoryByID 处理 /api/history/<id> 与 /api/history/<id>/log。
func (s *Server) handleHistoryByID(w http.ResponseWriter, r *http.Request) {
	h := s.opt.History
	if h == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "服务端未启用历史记录"})
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/history/")
	id, sub, _ := strings.Cut(rest, "/")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少记录 id"})
		return
	}
	if _, ok := h.Get(id); !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "这条历史记录不存在"})
		return
	}

	switch sub {
	case "":
		switch r.Method {
		case http.MethodGet:
			e, _ := h.Get(id)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": e})
		case http.MethodDelete:
			h.Delete(id)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			w.Header().Set("Allow", "GET, DELETE")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 GET / DELETE"})
		}

	case "log":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 GET"})
			return
		}
		s.serveHistoryLog(w, r, h, id)

	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "未知路径"})
	}
}

// serveHistoryLog 把原始日志发给前端。
//
// 用 ServeContent 而不是自己 io.Copy：它自带 Range 支持，断点续传和
// 浏览器取消都能正常工作。
func (s *Server) serveHistoryLog(w http.ResponseWriter, r *http.Request, h *history.Store, id string) {
	path, ok := h.LogPath(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "日志文件不存在"})
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "日志文件打不开"})
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "读不到日志大小"})
		return
	}

	// 默认取最后 2MB：够铺满回看缓冲，又不会让浏览器卡住。
	tail := int64(2 << 20)
	if v := r.URL.Query().Get("tail"); v != "" {
		if v == "0" || v == "all" {
			tail = 0
		} else if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			tail = n
		}
		if tail > maxHistoryTail {
			tail = maxHistoryTail
		}
	}

	start := int64(0)
	size := st.Size()
	if tail > 0 && size > tail {
		start = size - tail
		// 从整行开始，别把半截转义序列灌给终端 —— 半截 CSI 会把后面
		// 一整段正常输出当成它的参数吞掉，看起来就是"打开历史一片乱码"。
		start = alignToLine(f, start, size)
		size -= start
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-History-Offset", strconv.FormatInt(start, 10))
	w.Header().Set("X-History-Total", strconv.FormatInt(st.Size(), 10))
	http.ServeContent(w, r, "", st.ModTime(), io.NewSectionReader(f, start, size))
}

// alignToLine 把起点往后挪到下一个换行之后，最多挪 4KB（再长就不要了）。
func alignToLine(f *os.File, start, size int64) int64 {
	const window = 4096
	n := int64(window)
	if start+n > size {
		n = size - start
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return start
	}
	if i := bytes.IndexByte(buf, '\n'); i >= 0 {
		return start + int64(i) + 1
	}
	return start
}
