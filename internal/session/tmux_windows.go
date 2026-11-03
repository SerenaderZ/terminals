//go:build windows

package session

// TmuxSocket 在 Windows 上没有意义，只为让跨平台代码能编译。
const TmuxSocket = "terminals"

func tmuxHasSession(string) bool { return false }

func tmuxKillSession(string) error { return nil }

func buildTmuxArgs(conf, sid, cwd, shell string, shellArgs []string, loc string) []string {
	return nil
}

func PrepareTmux(string) (string, error) {
	return "", nil
}
