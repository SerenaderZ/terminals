package server

import (
	"encoding/json"
	"io"
	"net/http"

	"terminals/internal/config"
)

// maxSettingsBody 是设置请求体上限。正常几百字节。
const maxSettingsBody = 64 << 10

// handleSettings 是 /api/settings。GET 取全部，PUT 合并一部分。
//
// PUT 接受"只带改动字段"的 JSON，例如 {"webgl":false}，
// 其余字段保持原值 —— 设置页每改一项就存一次，不能要求前端每次发全量。
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	store := s.opt.Settings
	if store == nil {
		// 没有存储也照样工作：返回默认值，PUT 只回显不落盘。
		// 这样开发模式下不配 --data-dir 也能打开设置页。
		store = config.NewStore("")
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": store.Get()})

	case http.MethodPut, http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, maxSettingsBody+1))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "读取请求体失败"})
			return
		}
		if len(body) > maxSettingsBody {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "设置内容过大"})
			return
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(body, &raw); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "不是合法的 JSON 对象"})
			return
		}
		next, err := store.Update(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": next})

	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只支持 GET / PUT"})
	}
}
