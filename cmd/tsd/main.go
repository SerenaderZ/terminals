// Command tsd 是 TerminalS 的后端。
//
// 开发模式监听 TCP（默认 127.0.0.1:18086）；作为飞牛应用运行时监听
// unix socket，由统一网关转发过来。
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"terminals/internal/config"
	"terminals/internal/diag"
	"terminals/internal/files"
	"terminals/internal/history"
	"terminals/internal/server"
	"terminals/internal/session"
)

func main() {
	var (
		listenAddr = flag.String("listen", "127.0.0.1:18086", "开发模式下的 TCP 监听地址")
		socketPath = flag.String("socket", "", "unix socket 路径；设置后不再监听 TCP")
		base       = flag.String("base", "", "网关前缀，例如 /app/terminals")
		shell      = flag.String("shell", "", "默认 shell（留空用平台默认）")
		shellArgs  = flag.String("shell-args", "", "shell 参数，空格分隔")
		cwd        = flag.String("cwd", "", "默认工作目录")
		maxSess    = flag.Int("max-sessions", 32, "最大并发会话数")
		replayKB   = flag.Int("replay-kb", 256, "断线回放缓冲大小（KB）")
		requireAdm = flag.Bool("require-admin", false, "校验网关注入的 X-Trim-Isadmin")
		dev        = flag.Bool("dev", true, "开发模式：放宽 Origin 校验")
		runAs      = flag.String("run-as", "", "shell 降权到的账户；留空自动探测（飞牛管理员）。填 root 才给 root shell")
		backend    = flag.String("backend", "native", "会话后端：native（自持 PTY）或 tmux（可扛住 core 重启）")
		statePath  = flag.String("state", "", "会话清单落盘路径；留空则放 --data-dir 下，tmux 后端需要")
		tmuxConf   = flag.String("tmux-conf", "", "生成的 tmux 配置路径；留空用临时目录")
		layoutPath = flag.String("layout", "", "标签与分屏布局的落盘路径；留空则放 --data-dir 下")
		dataDir    = flag.String("data-dir", "", "数据目录（布局/会话清单）；留空自动选一个可写的")
		check      = flag.Bool("check", false, "只做环境自检并退出，不启动服务")
	)
	flag.Parse()

	// 数据目录先算出来：布局和会话清单都放它下面，--check 也要打印它。
	// 以前这里默认 "." —— 从 / 或 systemd 的 WorkingDirectory 启动时，
	// 布局会写到一个不可写的位置然后静默失败，表现为"刷新后分屏没了"。
	dir := resolveDataDir(*dataDir, *socketPath)

	cfg := session.DefaultConfig()
	cfg.MaxSessions = *maxSess
	cfg.ReplayCap = *replayKB * 1024
	cfg.Version = session.Version
	cfg.RunAs = *runAs

	if err := session.PrepareRunAs(&cfg); err != nil {
		log.Printf("降权账户解析失败：%v；将沿用当前进程身份运行", err)
		cfg.RunAs = ""
		cfg.RunAsHome = ""
	}

	if *shell != "" {
		cfg.Shell = *shell
	}
	if *shellArgs != "" {
		cfg.ShellArgs = strings.Fields(*shellArgs)
	}
	if *cwd != "" {
		cfg.Cwd = *cwd
	}

	// home 先补齐：passwd 里的 home 在飞牛上经常根本没建，而它同时是会话的
	// 默认工作目录和 HOME。不补的话，普通用户既进不去目录，也建不出 ~/.claude。
	if note := session.EnsureHome(&cfg, dir); note != "" {
		log.Print(note)
	}

	// 工作目录与 shell 一起试跑。原来的写法是"stat 一下，不行就回退到账户 home"，
	// 但 home 本身可能就是那个不存在的目录 —— 于是每个会话都拿到
	// "fork/exec /bin/bash: no such file or directory"，看着像 bash 没了。
	plan := session.PrepareSpawn(&cfg)
	for _, f := range plan.Failed {
		log.Printf("试跑未通过：%s", f)
	}
	for _, n := range plan.Notes {
		log.Print(n)
	}
	log.Printf("会话参数：shell=%s cwd=%s 账户=%s", cfg.Shell, cfg.Cwd, orDash(cfg.RunAs, "当前身份"))
	if len(plan.Failed) > 0 && !plan.OK {
		if snap := session.DiagnoseEnv(); snap != "" {
			log.Print(snap)
		}
	}

	// 会话后端。Windows 上只能 native —— tmux 是 unix 的东西，
	// 本地开发验证走 native，正好也是默认值。
	cfg.Backend = *backend
	if runtime.GOOS == "windows" {
		if cfg.Backend == session.BackendTmux {
			log.Print("Windows 上不支持 tmux 后端，已回退到 native")
		}
		cfg.Backend = session.BackendNative
	}
	if cfg.Backend == session.BackendTmux {
		conf, err := session.PrepareTmux(*tmuxConf)
		switch {
		case err == nil:
			cfg.TmuxConf = conf
		case *check:
			// 自检模式不在这里退出：让 diag 把"缺 tmux"作为一条 FAIL 打出来，
			// 用户能一次看到全部问题，而不是改一个报一个。
			cfg.Backend = session.BackendNative
		default:
			log.Fatalf("tmux 后端不可用：%v", err)
		}
		cfg.StatePath = filepath.Join(dir, "sessions.json")
	} else if cfg.Backend != session.BackendNative {
		log.Fatalf("未知的 --backend 取值 %q，可选 native / tmux", cfg.Backend)
	}
	if *statePath != "" {
		cfg.StatePath = *statePath
	}

	// 权限策略在启动时一次性说清楚，省得以后怀疑"为什么我不是 root"。
	// Windows 只用于本地调试，不涉及 sudo，跳过这段。
	if runtime.GOOS != "windows" {
		switch {
		case cfg.RunAs == "" || cfg.RunAs == "root":
			log.Printf("警告：会话将以 root 身份运行（--run-as root），任何能打开本页面的人都等于拿到 root")
		case cfg.Sudo:
			log.Printf("会话账户 %s（uid 非 0），可用 sudo -i 自行提权", cfg.RunAs)
		default:
			log.Printf("会话账户 %s（uid 非 0），但当前没有 sudo 权限；需要 root 请把该账户加入 sudo 组", cfg.RunAs)
		}
	}

	// 走 unix socket 基本就是正式运行，默认收紧成"必须管理员"。
	if *socketPath != "" && !isFlagPassed("require-admin") {
		*requireAdm = true
		*dev = false
	}

	// 布局与设置都放数据目录：卸载应用时整目录删掉即可，不留残渣。
	layoutFile := *layoutPath
	if layoutFile == "" {
		layoutFile = filepath.Join(dir, "layout.json")
	}
	settingsStore := config.NewStore(filepath.Join(dir, "settings.json"))

	// 自检在建 Manager 之前返回 —— 它不该产生任何会话，也不该碰 tmux。
	if *check {
		os.Exit(diag.Run(os.Stdout, diag.Options{
			Version:    session.Version,
			Config:     cfg,
			Shell:      cfg.Shell,
			DataDir:    dir,
			LayoutFile: layoutFile,
			StateFile:  cfg.StatePath,
			ListenAddr: *listenAddr,
			SocketPath: *socketPath,
			Backend:    *backend,
			Spawn:      plan,
		}))
	}

	// 历史记录放在数据目录下的 history/ 里：删应用目录 = 删历史，
	// 不需要额外的清理逻辑。
	hist := history.New(filepath.Join(dir, "history"))
	if hist != nil {
		log.Printf("历史目录：%s", hist.Dir())
	}
	cfg.History = hist

	mgr := session.NewManager(cfg)

	// tmux 后端下先把上次留下的会话认领回来，这样前端存着的 sid 一连接就续上。
	if n := mgr.Restore(); n > 0 {
		log.Printf("已认领 %d 个上次运行留下的 tmux 会话", n)
	}

	// 定期清理已退出且无人挂着的会话。注意不按空闲时间杀会话。
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for range t.C {
			mgr.Reap()
		}
	}()

	layoutStore := server.NewLayoutStore(layoutFile)

	// 文件面板。
	//
	// 本机视图走的是"终端里那个账户"的身份：tsd 以 root 起，shell 却降权到
	// 管理员，如果面板以 root 写盘，传上去的文件属主就是 root —— 终端里的
	// 用户反而改不动自己刚传的东西。远程连接清单放在数据目录，密码加密。
	filesStore, ferr := files.NewStore(dir)
	if ferr != nil {
		log.Printf("远程连接清单不可用：%v（文件面板只提供本机）", ferr)
		filesStore = nil
	}
	fileSvc := files.NewService(files.NewLocal(fileCredential(cfg), cfg.RunAsHome), filesStore)

	log.Printf("数据目录：%s", dir)
	log.Printf("布局文件：%s", layoutFile)
	log.Printf("设置文件：%s", filepath.Join(dir, "settings.json"))

	srv := server.New(mgr, server.Options{
		Base:         *base,
		RequireAdmin: *requireAdm,
		Dev:          *dev,
		Version:      session.Version,
		Layout:       layoutStore,
		Settings:     settingsStore,
		History:      hist,
		Files:        fileSvc,
	})

	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	var ln net.Listener
	var err error
	if *socketPath != "" {
		_ = os.Remove(*socketPath)
		ln, err = net.Listen("unix", *socketPath)
		if err != nil {
			log.Fatalf("监听 unix socket 失败: %v", err)
		}
		if runtime.GOOS != "windows" {
			if err := os.Chmod(*socketPath, 0o600); err != nil {
				log.Printf("设置 socket 权限失败: %v", err)
			}
		}
		log.Printf("TerminalS %s 已启动，socket=%s base=%s", session.Version, *socketPath, *base)
	} else {
		ln, err = net.Listen("tcp", *listenAddr)
		if err != nil {
			log.Fatalf("监听 TCP 失败: %v", err)
		}
		log.Printf("TerminalS %s 已启动，http://%s%s/", session.Version, *listenAddr, *base)
	}

	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务异常退出: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	log.Print("正在退出…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)

	// 关掉历史日志句柄。数据早就写进去了，这一步是让"正在写的文件"
	// 变成一个干净的闭合文件 —— 下次启动扫描时字节数才是准的。
	if hist != nil {
		hist.Close()
	}
	fileSvc.Close()

	if *socketPath != "" {
		_ = os.Remove(*socketPath)
	}
}

// isFlagPassed 判断某个 flag 是否由用户显式指定。
func isFlagPassed(name string) bool {
	found := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

// fileCredential 算出文件面板该用哪个身份。
//
// 三条判断，缺一不可：
//   - 非 root 进程：本来就是这个身份，没什么可切的；
//   - --run-as root（或没配）：终端也是 root，文件跟着 root；
//   - 查不到这个账户：退回进程身份，让面板至少能用。
//
// 只在 Linux 上真的会切换（见 internal/files/cred_linux.go）。
func fileCredential(cfg session.Config) files.Credential {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		return files.None()
	}
	if cfg.RunAs == "" || cfg.RunAs == "root" {
		return files.None()
	}
	u, err := user.Lookup(cfg.RunAs)
	if err != nil {
		log.Printf("文件面板：查不到账户 %s，将按当前身份访问文件", cfg.RunAs)
		return files.None()
	}
	uid, err1 := strconv.Atoi(u.Uid)
	gid, err2 := strconv.Atoi(u.Gid)
	if err1 != nil || err2 != nil {
		return files.None()
	}
	return files.Credential{UID: uid, GID: gid}
}

// resolveDataDir 决定布局文件与会话清单落在哪里。
//
// 优先级：--data-dir > --socket 所在目录（应用模式下卸载能整目录清掉）
// > $TERMINALS_DATA > 用户级状态目录。
//
// 以前这里是 "."，等于赌"启动时的当前目录可写且不会被清理"。
// 从 systemd 或应用中心拉起来时 CWD 通常是 /，于是布局写失败、
// 而且失败是静默的 —— 用户只看到"刷新后分屏没了"。
func resolveDataDir(explicit, socketPath string) string {
	if explicit != "" {
		return explicit
	}
	if socketPath != "" {
		return filepath.Dir(socketPath)
	}
	if v := strings.TrimSpace(os.Getenv("TERMINALS_DATA")); v != "" {
		return v
	}
	if runtime.GOOS != "windows" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, ".local", "state", "terminals")
		}
		return filepath.Join(os.TempDir(), "terminals")
	}
	if d, err := os.UserConfigDir(); err == nil && d != "" {
		return filepath.Join(d, "terminals")
	}
	return filepath.Join(os.TempDir(), "terminals")
}

// orDash 在值为空时给一个可读的占位，避免日志里出现 "账户=" 这种半截行。
func orDash(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
