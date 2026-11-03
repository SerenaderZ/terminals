//go:build !windows

package session

import "os"

// Account 是自检要展示的账户信息。
type Account struct {
	Name   string
	UID    int
	GID    int
	Home   string
	Sudo   bool
	Exists bool
}

// LookupAccount 查账户，供自检输出使用。
func LookupAccount(name string) Account {
	if name == "" {
		name = currentUser()
	}
	pw, err := lookupUser(name)
	if err != nil {
		return Account{Name: name}
	}
	return Account{
		Name:   pw.Name,
		UID:    pw.UID,
		GID:    pw.GID,
		Home:   pw.Home,
		Sudo:   hasSudo(pw.Name),
		Exists: true,
	}
}

// LocaleCandidates 返回系统实际安装的 locale 列表。
func LocaleCandidates() []string { return localeList() }

// LocaleInUse 返回会话实际会使用的 locale。
func LocaleInUse() string { return detectLocale() }

// TmuxInfo 返回 tmux 版本串（形如 "tmux 3.5a"）以及是否安装。
func TmuxInfo() (string, bool) { return tmuxAvailable() }

// CurrentEUID 返回当前进程的有效 uid。
// 只有 euid==0 时才能真正降权，自检要据此判断"降权会不会生效"。
func CurrentEUID() int { return os.Geteuid() }
