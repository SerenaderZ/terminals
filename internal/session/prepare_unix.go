//go:build !windows

package session

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// probeExec 真的把 shell 跑一次，用和真实会话完全相同的身份与工作目录。
//
// 不能只 os.Stat：
//   - 文件在但动态链接器不在（镜像里缺 libc），execve 照样返回 ENOENT；
//   - 文件在但工作目录不存在，execve 之前的 chdir 也会返回 ENOENT，
//     而 Go 会把它包装成 "fork/exec <shell>: no such file or directory"。
// 跑一次能同时把这三件事（文件、加载器、cwd、以及降权后的可进入性）验完。
func probeExec(shell, dir, user string) error {
	cmd := exec.Command(shell, "-c", "exit 0")
	cmd.Dir = dir
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + dir,
		"TERM=dumb",
	}

	cred, err := credentialFor(user)
	if err != nil {
		return err
	}
	if cred != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	}
	return cmd.Run()
}

// isMissingOrDenied 判断错误是不是"目录不存在 / 没权限"这一类。
// 只有这类错误值得退到 / 重试一次；PTY 耗尽之类的重试也没用。
func isMissingOrDenied(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.EACCES)
}

// DiagnoseEnv 在试跑全失败时输出一份环境快照。
//
// 这一步是为了避免"再来一轮安装包才知道原因"：如果连 /bin/sh 都起不来，
// 那问题就不在 cwd，而在 app 的挂载命名空间里 —— 快照能直接把这件事坐实。
func DiagnoseEnv() string {
	var b strings.Builder

	link := func(p string) {
		if target, err := os.Readlink(p); err == nil {
			fmt.Fprintf(&b, "%s -> %s\n", p, target)
			return
		}
		st, err := os.Stat(p)
		if err != nil {
			fmt.Fprintf(&b, "%s 不可用：%v\n", p, err)
			return
		}
		fmt.Fprintf(&b, "%s mode=%s size=%d\n", p, st.Mode(), st.Size())
	}

	b.WriteString("环境快照：\n")
	link("/bin")
	link("/bin/bash")
	link("/usr/bin/bash")
	link("/bin/sh")
	link("/usr/bin/sh")
	if root, err := os.Readlink("/proc/self/root"); err == nil {
		fmt.Fprintf(&b, "/proc/self/root -> %s\n", root)
	}
	fmt.Fprintf(&b, "euid=%d egid=%d\n", os.Geteuid(), os.Getegid())
	return strings.TrimRight(b.String(), "\n")
}
