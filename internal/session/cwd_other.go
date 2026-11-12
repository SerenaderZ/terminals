//go:build !linux

package session

// LiveCwd 在非 Linux 平台上不可用。
//
// Windows 上没有 /proc，macOS 的 proc_pidinfo 又需要额外的 cgo 绑定。
// 本地开发时前端会退回"面板自己记的位置"，功能不受影响。
func (s *Session) LiveCwd() string { return "" }
