// Package diag 实现 `tsd --check`：只做环境探测，不启动服务。
//
// 存在的理由很具体 —— 这个项目最终要装进飞牛，而开发机是 Windows。
// 上机之后如果只是"打不开"，能拿到的信息几乎为零；有了这一条命令，
// 缺 tmux、locale 不对、账户探测错、端口被占、目录不可写，全部一次说清，
// 不用靠来回改参数试。
package diag

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"terminals/internal/session"
)

// Options 是自检的输入。凡是最终生效的值都从 main 传进来，
// 自检不自己再猜一遍 —— 否则"自检说可以"和"服务真的跑起来"会不一致。
type Options struct {
	Version    string
	Config     session.Config
	Shell      string
	DataDir    string
	LayoutFile string
	StateFile  string
	ListenAddr string
	SocketPath string
	Backend    string
	// Spawn 是启动前试跑的结果。自检不再自己猜一遍 shell/cwd，
	// 直接用试跑得到的结论，两边才可能说一致。
	Spawn session.SpawnReport
}

// 输出前缀。刻意用 ASCII 方括号而不是勾叉符号：Windows 控制台代码页下
// 勾叉经常变成乱码，而这条命令恰恰是给"环境不对"的时候用的。
const (
	ok   = "[ OK ]"
	warn = "[WARN]"
	fail = "[FAIL]"
	note = "[ -- ]"
)

type report struct {
	w     io.Writer
	bad   int
	warnd int
}

func (r *report) line(tag, key, val string) {
	fmt.Fprintf(r.w, "%s %s %s\n", tag, pad(key, 12), val)
}

// pad 按显示宽度补空格。
//
// 不能用 fmt 的 %-12s：它数的是字节，而"降权账户"是 12 字节 / 4 个字，
// 中文环境下整张表会错位。这里按"中文算两格"粗略折算，够用了。
func pad(s string, width int) string {
	n := 0
	for _, r := range s {
		if r > 0x2e80 {
			n += 2
		} else {
			n++
		}
	}
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

func (r *report) badLine(key, val string) {
	r.bad++
	r.line(fail, key, val)
}

func (r *report) warnLine(key, val string) {
	r.warnd++
	r.line(warn, key, val)
}

func (r *report) section(title string) {
	fmt.Fprintf(r.w, "\n── %s ──\n", title)
}

// Run 打印自检结果，返回退出码：0 表示可以启动，2 表示有阻断项。
func Run(w io.Writer, o Options) int {
	r := &report{w: w}

	fmt.Fprintf(w, "TerminalS %s  自检（不启动服务）\n", o.Version)
	fmt.Fprintf(w, "时间 %s  平台 %s/%s  Go %s\n",
		time.Now().Format("2006-01-02 15:04:05"), runtime.GOOS, runtime.GOARCH, runtime.Version())

	r.env(o)
	r.account(o)
	r.backend(o)
	r.storage(o)
	r.network(o)

	fmt.Fprintln(w)
	if r.bad > 0 {
		fmt.Fprintf(w, "结论：%d 项阻断问题，先处理上面的 [FAIL] 再启动。\n", r.bad)
		return 2
	}
	if r.warnd > 0 {
		fmt.Fprintf(w, "结论：可以启动，但有 %d 项警告（不影响起服务，影响体验）。\n", r.warnd)
	} else {
		fmt.Fprintln(w, "结论：可以启动，没有发现问题。")
	}
	fmt.Fprintf(w, "启动命令：%s\n", suggest(o))
	return 0
}

func (r *report) env(o Options) {
	r.section("环境")

	// shell 不存在会直接导致每个会话都起不来，是最该先查的一条。
	// 这里判断的不是"文件在不在"，而是"启动时试跑有没有跑通"——
	// 因为 Go 的 fork/exec 在 chdir 失败时也报 no such file or directory，
	// 只看 errno 会把"工作目录不存在"误判成"shell 不存在"。
	if o.Shell == "" {
		r.badLine("shell", "未解析出来")
	} else if st, err := os.Stat(o.Shell); err == nil {
		if st.IsDir() {
			r.badLine("shell", o.Shell+" 是目录")
		} else {
			r.line(ok, "shell", o.Shell+"（以登录 shell 启动）")
		}
	} else if p, lerr := exec.LookPath(o.Shell); lerr == nil {
		r.line(ok, "shell", p+"（从 PATH 解析）")
	} else {
		r.badLine("shell", fmt.Sprintf("%s 不存在（%v）", o.Shell, err))
	}

	switch {
	case !o.Spawn.OK:
		r.badLine("试跑", fmt.Sprintf("%d 组 shell/目录组合都起不来，第一个会话会失败",
			len(o.Spawn.Failed)))
		for _, f := range o.Spawn.Failed {
			r.line(note, "", f)
		}
	case o.Spawn.Changed:
		r.warnLine("试跑", strings.Join(o.Spawn.Notes, "；"))
	default:
		r.line(ok, "试跑", fmt.Sprintf("%s 在 %s 下能起来（含降权后的身份）",
			o.Spawn.Shell, o.Spawn.Cwd))
	}

	r.locale()
}

// locale 单独成段：中文能不能正常输入，八成取决于这一条。
func (r *report) locale() {
	if runtime.GOOS == "windows" {
		r.line(note, "locale", "Windows 不设置（本地仅作调试）")
		return
	}

	used := session.LocaleInUse()
	cands := session.LocaleCandidates()

	if used == "" {
		r.badLine("locale", "探测失败，会话内 LANG 会为空，中文退格与补全会出错")
		return
	}
	if len(cands) == 0 {
		r.warnLine("locale", "`locale -a` 无输出，硬回退到 "+used)
		return
	}

	utf8Count := 0
	for _, c := range cands {
		if isUTF8(c) {
			utf8Count++
		}
	}

	switch {
	case !isUTF8(used):
		r.badLine("locale", used+" 不是 UTF-8，中文会出问题")
	case strings.HasPrefix(strings.ToLower(used), "zh_cn"):
		r.line(ok, "locale", used+"（中文）")
	default:
		r.line(ok, "locale", used+"（系统无中文 locale，用它兜底；多字节输入正常，只是程序输出没有中文翻译）")
	}
	r.line(note, "可用", fmt.Sprintf("%d 个 locale，其中 UTF-8 %d 个", len(cands), utf8Count))

	if utf8Count == 0 {
		r.warnLine("中文", "系统没有任何 UTF-8 locale；执行 dpkg-reconfigure locales 生成 zh_CN.UTF-8")
	}
}

func (r *report) account(o Options) {
	r.section("账户与权限")

	cfg := o.Config
	if runtime.GOOS == "windows" {
		name := cfg.RunAs
		if name == "" {
			name = "当前用户"
		}
		r.line(note, "账户", name+"（Windows 不做降权，仅供本地调试）")
		return
	}

	euid := session.CurrentEUID()
	r.line(note, "进程 euid", strconv.Itoa(euid))

	if cfg.RunAs == "" {
		r.warnLine("降权账户", "未解析出来，会话会沿用当前进程身份（可能就是 root）")
		return
	}

	acc := session.LookupAccount(cfg.RunAs)
	if !acc.Exists {
		r.badLine("降权账户", fmt.Sprintf("%q 不存在；用 --run-as 指定一个已有账户", cfg.RunAs))
		return
	}

	if acc.UID == 0 {
		r.warnLine("降权账户", fmt.Sprintf("%s 的 uid 是 0 —— root shell，任何能打开页面的人都等于拿到 root", acc.Name))
	} else {
		r.line(ok, "降权账户", fmt.Sprintf("%s uid=%d gid=%d home=%s", acc.Name, acc.UID, acc.GID, acc.Home))
	}

	if acc.UID != 0 {
		if euid == 0 {
			r.line(ok, "降权方式", "内核凭据（fork 阶段切 uid/gid，不经 runuser）")
		} else {
			r.warnLine("降权方式", fmt.Sprintf("服务以 euid=%d 启动，无法切换账户；会话身份就是当前用户", euid))
		}
	}

	if acc.Sudo {
		r.line(ok, "sudo", "可用（终端里 sudo -i 可提权到 root）")
	} else {
		r.warnLine("sudo", "不可用；要 root 请执行 usermod -aG sudo "+acc.Name)
	}

	if cfg.Cwd == "" {
		r.warnLine("默认 cwd", "未解析出来，会话可能落在 / 或启动失败")
	} else if st, err := os.Stat(cfg.Cwd); err != nil || !st.IsDir() {
		r.badLine("默认 cwd", cfg.Cwd+" 不可用；会话会因为 chdir 失败而起不来（报错看起来像 shell 不存在）")
	} else {
		r.line(ok, "默认 cwd", cfg.Cwd)
	}
}

func (r *report) backend(o Options) {
	r.section("会话后端")

	ver, installed := session.TmuxInfo()

	if !installed {
		r.line(note, "tmux", "未安装")
		if o.Backend == "tmux" {
			r.badLine("后端", "指定了 --backend tmux 但找不到 tmux；apt install tmux，或改回 --backend native")
			return
		}
		r.line(ok, "后端", "native（自持 PTY；刷新/断网不丢，服务重启会丢）")
		r.line(note, "扛重启", "装 tmux 后加 --backend tmux")
		return
	}

	maj, min := parseTmux(ver)
	r.line(ok, "tmux", fmt.Sprintf("%s（%d.%d）", ver, maj, min))
	r.gate("extended-keys", 3, 2, maj, min)
	r.gate("allow-passthrough", 3, 3, maj, min)
	r.gate("sync 2026", 3, 4, maj, min)

	if o.Backend == "tmux" {
		r.line(ok, "后端", "tmux（服务重启/升级后按 sessions.json 认领会话）")
	} else {
		r.line(ok, "后端", "native（可用 --backend tmux 换取扛重启）")
	}
}

func (r *report) gate(name string, needMaj, needMin, maj, min int) {
	if maj > needMaj || (maj == needMaj && min >= needMin) {
		r.line(ok, name, fmt.Sprintf("需要 tmux %d.%d+，已满足", needMaj, needMin))
		return
	}
	r.warnLine(name, fmt.Sprintf("需要 tmux %d.%d+，当前 %d.%d，这一项配置会被忽略", needMaj, needMin, maj, min))
}

func (r *report) storage(o Options) {
	r.section("存储")

	if o.DataDir == "" {
		r.badLine("数据目录", "未解析出来")
		return
	}
	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		r.badLine("数据目录", fmt.Sprintf("%s 无法创建：%v", o.DataDir, err))
		return
	}
	r.line(ok, "数据目录", o.DataDir)

	// 真写一次，而不是只看权限位 —— 只读挂载、配额满、ACL 都能骗过 mode 检查。
	probe := filepath.Join(o.DataDir, ".write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		r.badLine("可写性", fmt.Sprintf("写入失败：%v", err))
	} else {
		_ = os.Remove(probe)
		r.line(ok, "可写性", "已写入并删除测试文件")
	}

	r.line(note, "布局文件", o.LayoutFile)
	if o.StateFile != "" {
		r.line(note, "会话清单", o.StateFile+"（tmux 后端认领会话需要）")
	}
}

func (r *report) network(o Options) {
	r.section("网络")

	if o.SocketPath != "" {
		dir := filepath.Dir(o.SocketPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			r.badLine("socket", fmt.Sprintf("%s 目录无法创建：%v", dir, err))
			return
		}
		if _, err := os.Stat(o.SocketPath); err == nil {
			r.line(warn, "socket", o.SocketPath+" 已存在（无进程监听时会被接管）")
		} else {
			r.line(ok, "socket", o.SocketPath)
		}
		r.line(note, "模式", "unix socket，自动强制校验网关注入的 X-Trim-Isadmin")
		return
	}

	if o.ListenAddr == "" {
		r.badLine("监听", "既没给 --socket 也没给 --listen")
		return
	}

	ln, err := net.Listen("tcp", o.ListenAddr)
	if err != nil {
		r.badLine("监听", fmt.Sprintf("%s 不可用：%v", o.ListenAddr, err))
		return
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	r.line(ok, "监听", addr+"（TCP 端口可绑定）")

	// 必须用 SplitHostPort：`0.0.0.0` 在双栈机器上会解析成 `[::]:端口`，
	// 用按冒号切分的办法拿到的 host 是 "["，警告就永远不会触发。
	if host, _, err := net.SplitHostPort(addr); err == nil {
		if host == "" || host == "0.0.0.0" || host == "::" {
			r.warnLine("暴露面", "绑在所有网卡且没有内置登录，同网段任何人都能拿到这个 shell")
			r.line(note, "更安全", "改 --listen 127.0.0.1:18086，本地用 ssh -L 转发")
		}
	}
}

func isUTF8(s string) bool {
	l := strings.ToLower(s)
	return strings.Contains(l, "utf-8") || strings.Contains(l, "utf8")
}

// parseTmux 从 "tmux 3.5a" 里取主次版本号。
func parseTmux(v string) (int, int) {
	f := strings.Fields(v)
	if len(f) < 2 {
		return 0, 0
	}
	parts := strings.SplitN(f[1], ".", 2)
	maj, _ := strconv.Atoi(leadingDigits(parts[0]))
	min := 0
	if len(parts) == 2 {
		min, _ = strconv.Atoi(leadingDigits(parts[1]))
	}
	return maj, min
}

// leadingDigits 取前缀数字，"5a" -> "5"。
func leadingDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}

// suggest 给一条可以直接复制粘贴的启动命令。
func suggest(o Options) string {
	bin := "tsd"
	args := ""
	if o.SocketPath != "" {
		args = " --socket " + o.SocketPath
	} else {
		args = " --listen " + o.ListenAddr
	}
	if o.DataDir != "" {
		args += " --data-dir " + o.DataDir
	}
	return bin + args + " --backend " + o.Backend
}
