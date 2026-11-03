//go:build !windows

package session

import (
	"os"
	"os/exec"
	"os/user"
	"strings"
	"sync"
)

var (
	localeOnce     sync.Once
	cachedLocale   string
	localeListOnce sync.Once
	cachedLocales  []string
)

// localeList 取系统实际安装的 locale 列表，只跑一次。
//
// 用 `locale -a` 而不是读 /etc/locale.gen：前者反映真正编译出来的结果，
// 后者只是"打算生成"的清单，两者经常不一致。
func localeList() []string {
	localeListOnce.Do(func() {
		out, err := exec.Command("locale", "-a").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				cachedLocales = append(cachedLocales, line)
			}
		}
	})
	return cachedLocales
}

// matchLocale 在可用列表里找完全匹配（忽略大小写）的项。
//
// 刻意不用 strings.Contains：`zh_CN.UTF-8` 是 `zh_CN.UTF-8@stroke` 的子串，
// 用包含判断会挑中一个其实另有含义的 locale。
func matchLocale(prefs []string) string {
	avail := localeList()
	for _, p := range prefs {
		for _, a := range avail {
			if strings.EqualFold(a, p) {
				return a
			}
		}
	}
	return ""
}

// detectLocale 主动挑一个系统真实支持的 UTF-8 locale。
//
// 刻意不继承父进程的 LANG —— 从 systemd / 应用中心拉起来时很容易是 POSIX 或空，
// 那样 bash 会按字节处理输入：中文退格删半个字、Tab 补全错乱、中文文件名为空。
func detectLocale() string {
	localeOnce.Do(func() {
		if v := matchLocale([]string{"zh_CN.UTF-8", "zh_CN.utf8", "en_US.UTF-8", "C.UTF-8", "C.utf8"}); v != "" {
			cachedLocale = v
			return
		}
		// 首选没有就退一步：任何一个 UTF-8 locale 都比 C / POSIX 强，
		// 因为它至少能让 readline 按多字节处理输入。
		for _, a := range localeList() {
			la := strings.ToLower(a)
			if strings.Contains(la, "utf-8") || strings.Contains(la, "utf8") {
				cachedLocale = a
				return
			}
		}
		cachedLocale = "C.UTF-8"
	})
	return cachedLocale
}

func currentUser() string {
	for _, k := range []string{"USER", "LOGNAME"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
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
	return "/root"
}

// buildEnv 构造给 PTY 子进程的环境变量。
//
// TERM / COLORTERM 显式指定，让 TUI 程序走真彩色路径；LANG / LC_ALL 用探测到的
// UTF-8 locale，这是中文能正常输入的地基。
//
// runAs / home 来自 PrepareRunAs：降权之后 HOME/USER 必须是目标账户的，
// 否则 bash 会去读 root 的 .bashrc，而那个文件普通用户根本读不到。
func buildEnv(shell, cwd, runAs, home string) []string {
	loc := detectLocale()

	u := runAs
	if u == "" {
		u = currentUser()
	}
	if home == "" {
		home = homeDir()
	}

	env := []string{
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=terminals",
		"TERM_PROGRAM_VERSION=" + Version,
		"HOME=" + home,
		"USER=" + u,
		"LOGNAME=" + u,
		"SHELL=" + shell,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=" + loc,
		"LC_ALL=" + loc,
		"LESS=-R",
		"PAGER=less",
	}
	if cwd != "" {
		env = append(env, "PWD="+cwd)
	}
	return env
}
