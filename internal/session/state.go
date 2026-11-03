package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// persistedSession 是落盘的一条会话元信息。
//
// 只存"认领会话所必需"的最小集合：sid、工作目录、创建时间、是否 tmux。
// 刻意不存屏幕内容和标题 —— 那些属于 M3 的快照层，现在存只会让格式提前僵化。
type persistedSession struct {
	SID     string `json:"sid"`
	Cwd     string `json:"cwd"`
	Created int64  `json:"created"`
	Tmux    bool   `json:"tmux"`
}

type stateFile struct {
	Version  int                `json:"version"`
	Sessions []persistedSession `json:"sessions"`
}

const stateVersion = 1

// store 负责把会话清单一进一出地写到磁盘。
type store struct {
	path string
	mu   sync.Mutex
}

func newStore(path string) *store { return &store{path: path} }

// load 读回会话清单。文件不存在或损坏都返回空清单 —— 恢复是尽力而为，
// 不能因为一个坏文件导致服务起不来。
func (s *store) load() []persistedSession {
	if s == nil || s.path == "" {
		return nil
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	var f stateFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil
	}
	if f.Version != stateVersion {
		return nil
	}
	return f.Sessions
}

// save 覆盖写。先写临时文件再 rename，避免半截文件。
func (s *store) save(list []persistedSession) {
	if s == nil || s.path == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return
	}
	b, err := json.MarshalIndent(stateFile{Version: stateVersion, Sessions: list}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}
