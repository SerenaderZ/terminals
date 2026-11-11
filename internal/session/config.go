package session

import (
	"runtime"

	"terminals/internal/history"
)

// Version 是协议与实现版本，会随 READY 帧发给前端。
const Version = "0.5.2"

// Config 是会话管理器的配置。
type Config struct {
	Shell       string
	ShellArgs   []string
	Cwd         string
	ReplayCap   int
	MaxSessions int
	Version     string

	// RunAs 是 shell 要降权到的账户。默认就是一个普通账户（飞牛的管理员），
	// 不是 root —— 需要 root 时在终端里自己 `sudo -i`。
	// 只有显式配置成 "root" 才会保留 root shell。
	RunAs string

	// RunAsHome 是 RunAs 账户的 home，同时是会话的默认工作目录。
	RunAsHome string

	// Sudo 表示该账户是否能提权，只用于日志和前端提示。
	Sudo bool

	// Backend 是会话后端：
	//   native 我们自己持 PTY（默认，兼容性最好）
	//   tmux   会话跑在 tmux 里，能扛住 core 重启与升级
	// 两者对前端完全透明，前端看到的始终是一个 PTY。
	Backend string

	// TmuxConf 是生成出来的 tmux 配置路径。
	TmuxConf string

	// StatePath 是会话清单落盘位置，core 重启后靠它认领 tmux 会话。
	StatePath string

	// History 是历史记录仓库。nil 表示不记录 —— 开发时不想留痕迹、
	// 或者磁盘只读，都会走这条分支。
	History *history.Store
}

// 后端取值。
const (
	BackendNative = "native"
	BackendTmux   = "tmux"
)

// DefaultShell 返回当前平台的默认 shell。
// Windows 只是本地开发用，正式目标是飞牛的 Linux。
func DefaultShell() string {
	if runtime.GOOS == "windows" {
		return "powershell.exe"
	}
	return "/bin/bash"
}

// DefaultConfig 给出一份可用的默认配置。
func DefaultConfig() Config {
	shell := DefaultShell()
	cfg := Config{
		Shell:       shell,
		Cwd:         "",
		ReplayCap:   DefaultReplayCap,
		MaxSessions: 32,
		Version:     Version,
		Backend:     BackendNative,
	}
	if runtime.GOOS != "windows" {
		cfg.ShellArgs = []string{"-l"}
		// Cwd 留空，等 PrepareRunAs 解析出目标账户的 home 再填。
		// 原来这里写死 /root，降权之后会变成一个进不去的目录。
	}
	return cfg
}
