//go:build !windows

package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// tmuxConf 是我们强制使用的 tmux 配置。
//
// 关键点：会话内的 TERM 是 tmux-256color，和外面的 xterm-256color 不是一回事。
// Claude Code 这类 CLI 会按 TERM + 能力探测决定要不要用真彩色、同步输出、
// 扩展键；tmux 默认不转发其中几项，于是"在 tmux 里跑 Claude Code"就出毛病。
// 下面每一行都是针对一个具体能力，且**作用域按 tmux 源码核对过**：
// server 选项必须用 `set -s`，窗口选项必须用 `setw -g`，写错会报 unknown option。
const tmuxConf = `# TerminalS 托管的 tmux 配置。请勿手动修改，程序会覆盖。
# 由 --backend tmux 启动的会话使用本配置。

# ---- 持久化：这两行是"刷新/断开/重启不丢"的地基 ----
set -g destroy-unattached off
set -s exit-empty off

# ---- 终端能力（server 作用域）----
# default-terminal 决定内层看到的 TERM。tmux-256color 在 ncurses 6.1+ 自带。
set -s default-terminal "tmux-256color"
# 告诉 tmux：外层（xterm.js）支持哪些能力。声明了 tmux 才会原样下发，
# 不声明它就会自己截掉。这里刻意不含 usstyle（xterm.js 不渲染波浪下划线），
# 也不含 extkeys（见文件末尾注释）。
set -as terminal-features ",xterm*:RGB:clipboard:bpaste:focus:title:strikethrough"
# 真彩色：外层支持 RGB，别把 24 位色降成 256 色。
set -as terminal-overrides ",*:Tc"
# 内层程序请求扩展键（modifyOtherKeys / CSI u）时，tmux 负责翻译并转发。
set -s extended-keys on
# OSC 52 剪贴板：内层 y 复制走这条通道。
set -s set-clipboard on
# 焦点事件：切回来时 TUI 才知道要重绘。
set -s focus-events on
# 按键不要延迟。默认 500ms 会让 Esc 有明显的黏滞感。
set -sg escape-time 0

# ---- 透传 ----
# window 作用域。OSC 8 超链接、OSC 9/777 通知、图片协议都走这里。
setw -g allow-passthrough on

# ---- 交互：我们要的是"透明层"，不是 tmux 的功能 ----
# 我们有自己的标签和分屏，tmux 的状态栏只会让可用行数少一行。
set -g status off
# 鼠标交给浏览器端的 xterm.js 处理，否则选区会被 tmux 抢走，
# 复制出来是一堆空格的经典问题就是这么来的。
set -g mouse off
set -g history-limit 20000
# 内层环境里这几个变量要从客户端同步过来，否则 locale 会退回 C。
set -g update-environment "TERM COLORTERM LANG LC_ALL HOME USER SHELL"
set -g base-index 0
setw -g pane-base-index 0
# 窗口尺寸不随最小客户端跳变。
setw -g aggressive-resize off

# 关于 extkeys：不向 tmux 声明外层支持扩展键（那样 tmux 会给我们发 CSI u，
# 而 xterm.js 5.5 解不了，反而会让按键变乱）。Shift+Enter 这类组合由前端
# 直接发 \x1b\r（Alt+Enter 语义），tmux 只当普通字节转发，两种后端都成立。
`

// TmuxSocket 是我们独占的 tmux server 名字，避免和用户自己的 tmux 打架。
const TmuxSocket = "terminals"

// ensureTmuxConf 把配置写到磁盘（内容有变化才写），返回路径。
func ensureTmuxConf(path string) (string, error) {
	if path == "" {
		path = filepath.Join(os.TempDir(), "terminals-tmux.conf")
	}
	if old, err := os.ReadFile(path); err == nil && string(old) == tmuxConf {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(tmuxConf), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// tmuxAvailable 检查系统里有没有 tmux，顺带拿到版本。
func tmuxAvailable() (string, bool) {
	out, err := exec.Command("tmux", "-V").Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// tmuxHasSession 判断某个 tmux 会话是否还活着。core 重启后靠它认领旧会话。
func tmuxHasSession(name string) bool {
	return exec.Command("tmux", "-L", TmuxSocket, "has-session", "-t", name).Run() == nil
}

// tmuxKillSession 结束一个 tmux 会话。会话不存在时返回 nil。
func tmuxKillSession(name string) error {
	err := exec.Command("tmux", "-L", TmuxSocket, "kill-session", "-t", name).Run()
	if err != nil {
		// 已经被内层程序自己退出带走了，不算错。
		return nil
	}
	return nil
}

// buildTmuxArgs 组装 `tmux ... new-session -A -s <sid>` 的参数。
//
// 用 -A 是刻意的：同名会话存在就直接 attach，不存在才新建。
// 这样"新建"和"core 重启后认领"走的是完全同一条代码路径，
// 少了整整一个分支，也就少了一整类只在重启时才暴露的 bug。
func buildTmuxArgs(conf, sid, cwd, shell string, shellArgs []string, loc string) []string {
	args := []string{
		"-L", TmuxSocket,
		"-f", conf,
		"new-session", "-A",
		"-s", sid,
	}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	args = append(args, "--", "env",
		"LANG="+loc,
		"LC_ALL="+loc,
		"COLORTERM=truecolor",
	)
	args = append(args, shell)
	args = append(args, shellArgs...)
	return args
}

// PrepareTmux 在启用 tmux 后端时做一次前置检查，错误信息要能直接告诉用户缺什么。
func PrepareTmux(confPath string) (string, error) {
	v, ok := tmuxAvailable()
	if !ok {
		return "", fmt.Errorf("未找到 tmux 可执行文件，无法使用 tmux 后端；请先安装 tmux（apt install tmux）")
	}
	_ = v
	conf, err := ensureTmuxConf(confPath)
	if err != nil {
		return "", fmt.Errorf("写入 tmux 配置失败：%w", err)
	}
	return conf, nil
}
