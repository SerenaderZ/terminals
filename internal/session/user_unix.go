//go:build !windows

package session

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// 用户名白名单。先校验再查系统，避免把奇怪的东西拼进 syscall.Credential
// 或者日志里。和 fnos-terminal 的 session-shell 用的是同一套思路。
var userNameRE = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,31}$`)

// pwEntry 是 getent passwd 解析出来的一行。
type pwEntry struct {
	Name string
	UID  int
	GID  int
	Home string
}

// lookupUser 用 getent 查账户。
//
// 刻意不用 os/user.Lookup：Go 的纯 Go 实现在静态编译（CGO_ENABLED=0）时
// 会去解析 /etc/passwd，但遇到 NSS / LDAP 后端就查不到人；getent 走的是
// 系统完整链路，行为和我们后面要跑的 runuser 一致。
func lookupUser(name string) (pwEntry, error) {
	if !userNameRE.MatchString(name) {
		return pwEntry{}, fmt.Errorf("非法用户名 %q", name)
	}
	out, err := exec.Command("getent", "passwd", name).Output()
	if err != nil {
		return pwEntry{}, fmt.Errorf("账户 %q 不存在", name)
	}
	f := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(f) < 7 {
		return pwEntry{}, fmt.Errorf("账户 %q 的 passwd 记录异常", name)
	}
	uid, err1 := strconv.Atoi(f[2])
	gid, err2 := strconv.Atoi(f[3])
	if err1 != nil || err2 != nil {
		return pwEntry{}, fmt.Errorf("账户 %q 的 uid/gid 非法", name)
	}
	home := f[5]
	if home == "" {
		home = "/"
	}
	return pwEntry{Name: f[0], UID: uid, GID: gid, Home: home}, nil
}

// firstGroupMember 取某个组里第一个存在的普通账户（uid >= 1000）。
func firstGroupMember(group string) string {
	out, err := exec.Command("getent", "group", group).Output()
	if err != nil {
		return ""
	}
	f := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(f) < 4 || f[3] == "" {
		return ""
	}
	for _, m := range strings.Split(f[3], ",") {
		m = strings.TrimSpace(m)
		if m == "" || m == "root" {
			continue
		}
		if pw, err := lookupUser(m); err == nil && pw.UID >= 1000 {
			return pw.Name
		}
	}
	return ""
}

// firstHumanUser 兜底：从 passwd 里挑第一个有真实 shell 的普通账户。
func firstHumanUser() string {
	out, err := exec.Command("getent", "passwd").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 7 {
			continue
		}
		uid, err := strconv.Atoi(f[2])
		if err != nil || uid < 1000 {
			continue
		}
		sh := f[6]
		if strings.HasSuffix(sh, "nologin") || strings.HasSuffix(sh, "/false") {
			continue
		}
		return f[0]
	}
	return ""
}

// autodetectUser 在没显式指定 --run-as 时猜一个该降权到的账户。
//
// 优先级：环境变量给的提示 → sudo 组 → wheel 组 → 第一个普通账户。
// 飞牛的管理员账户通常在 sudo 组里，这条链基本第一次就命中。
func autodetectUser() string {
	for _, k := range []string{"TERMINALS_USER", "FNOS_USER", "SUDO_USER"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" && v != "root" {
			if _, err := lookupUser(v); err == nil {
				return v
			}
		}
	}
	for _, g := range []string{"sudo", "wheel", "adm"} {
		if u := firstGroupMember(g); u != "" {
			return u
		}
	}
	return firstHumanUser()
}

// hasSudo 判断该账户是否能提权。
//
// 只看两点：在 sudo/wheel 组里，或者 /etc/sudoers.d 里有针对它的条目。
// 不执行 sudo 探测密码，避免在启动阶段留下失败的审计记录。
func hasSudo(name string) bool {
	if name == "" || name == "root" {
		return true
	}
	for _, g := range []string{"sudo", "wheel"} {
		if out, err := exec.Command("getent", "group", g).Output(); err == nil {
			f := strings.Split(strings.TrimSpace(string(out)), ":")
			if len(f) >= 4 {
				for _, m := range strings.Split(f[3], ",") {
					if strings.TrimSpace(m) == name {
						return true
					}
				}
			}
		}
	}
	// sudoers.d 里的条目可能是 `user ALL=(ALL) NOPASSWD:ALL` 这种写法。
	if out, err := exec.Command("grep", "-rls", "--", name, "/etc/sudoers.d").Output(); err == nil {
		return len(strings.TrimSpace(string(out))) > 0
	}
	return false
}

// PrepareRunAs 解析降权账户，并把 home / sudo 状态写回配置。
//
// 语义刻意定成：**默认就是普通用户，想拿 root 自己 sudo -i**。
// 只有显式 --run-as root 才会保留 root shell，并且会在日志里喊一声。
func PrepareRunAs(cfg *Config) error {
	if os.Geteuid() != 0 {
		// 不是 root 就没什么可降的，如实记录现状即可。
		if cfg.RunAs == "" {
			cfg.RunAs = currentUser()
		}
		cfg.RunAsHome = homeDir()
		cfg.Sudo = hasSudo(cfg.RunAs)
		return nil
	}

	name := cfg.RunAs
	if name == "" {
		name = autodetectUser()
	}
	if name == "" || name == "root" {
		cfg.RunAs = name
		if name == "root" {
			cfg.RunAsHome = "/root"
			cfg.Sudo = true
		}
		return nil
	}

	pw, err := lookupUser(name)
	if err != nil {
		return err
	}
	if pw.UID == 0 {
		return fmt.Errorf("账户 %q 的 uid 是 0，拒绝用它做降权目标", name)
	}
	cfg.RunAs = pw.Name
	cfg.RunAsHome = pw.Home
	cfg.Sudo = hasSudo(pw.Name)
	return nil
}

// spawnCred 是降权凭据。unix 下就是内核凭据结构。
type spawnCred = syscall.Credential

// credentialFor 生成降权用的 SysProcAttr.Credential。
//
// 用内核凭据而不是 runuser 进程，理由是：少 fork 一次、环境变量不被 su
// 类程序改写、退出码直接来自 shell 而不是中间层。
func credentialFor(name string) (*spawnCred, error) {
	if name == "" || name == "root" {
		return nil, nil
	}
	if os.Geteuid() != 0 {
		return nil, nil
	}
	pw, err := lookupUser(name)
	if err != nil {
		return nil, err
	}
	if pw.UID == 0 {
		return nil, fmt.Errorf("拒绝以 uid 0 启动")
	}
	groups := []uint32{}
	if u, err := user.Lookup(pw.Name); err == nil {
		if ids, err := u.GroupIds(); err == nil {
			for _, s := range ids {
				if g, err := strconv.Atoi(s); err == nil {
					groups = append(groups, uint32(g))
				}
			}
		}
	}
	if len(groups) == 0 {
		groups = []uint32{uint32(pw.GID)}
	}
	return &syscall.Credential{
		Uid:    uint32(pw.UID),
		Gid:    uint32(pw.GID),
		Groups: groups,
	}, nil
}
