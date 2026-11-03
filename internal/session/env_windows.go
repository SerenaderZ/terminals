//go:build windows

package session

import (
	"os"
	"os/user"
)

// buildEnv 在 Windows 上直接继承父进程环境，只补上 TERM 相关变量。
// 这个平台只用于本地开发验证，中文与 TUI 的最终验收在飞牛上进行。
// runAs / home 在 Windows 上没有降权语义，忽略即可。
func buildEnv(shell, cwd, runAs, home string) []string {
	env := os.Environ()
	env = append(env,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=terminals",
		"TERM_PROGRAM_VERSION="+Version,
	)
	return env
}

func currentUser() string {
	if v := os.Getenv("USERNAME"); v != "" {
		return v
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "root"
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "C:\\"
}

// detectLocale 在 Windows 上没有意义（locale 是 unix 概念），
// 留一个同名函数让跨平台代码能编译。
func detectLocale() string { return "C.UTF-8" }
