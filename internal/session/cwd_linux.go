//go:build linux

package session

import (
	"fmt"
	"os"
)

// LiveCwd 返回 shell 此刻的工作目录。
//
// 为什么读 /proc 而不是记 shell 的初始 Cwd：用户每 cd 一次，shell 自己
// chdir，Go 这边完全不知情。侧栏要"跟着终端走"，唯一的事实来源就是
// 那个进程的 cwd。
//
// 只对 native 后端准：tmux 后端里 PID 是 attach 客户端，它的 cwd 是
// attach 那一刻的目录，不跟着 pane 里的 shell 变。取不到就返回空串，
// 前端会退回"面板自己记的位置"，不会乱跳。
func (s *Session) LiveCwd() string {
	if s == nil || s.PID <= 0 || !s.Alive() {
		return ""
	}
	p, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", s.PID))
	if err != nil {
		return ""
	}
	return p
}
