//go:build windows

package session

// Account 是自检要展示的账户信息。
type Account struct {
	Name   string
	UID    int
	GID    int
	Home   string
	Sudo   bool
	Exists bool
}

// LookupAccount 在 Windows 上只回显当前账户，不做 unix 语义的判断。
func LookupAccount(name string) Account {
	if name == "" {
		name = currentUser()
	}
	return Account{Name: name, Home: homeDir(), Exists: true}
}

// LocaleCandidates 在 Windows 上没有意义。
func LocaleCandidates() []string { return nil }

// LocaleInUse 在 Windows 上不设置 locale，返回空串。
func LocaleInUse() string { return "" }

// TmuxInfo 在 Windows 上恒为未安装。
func TmuxInfo() (string, bool) { return "", false }

// CurrentEUID 在 Windows 上没有 uid 概念。
func CurrentEUID() int { return -1 }
