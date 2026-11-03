//go:build windows

package session

import (
	"fmt"
	"os"
	"os/exec"
)

// probeExec 在 Windows 上只做静态检查。
//
// 本地开发不涉及降权，失败原因基本只有两种：可执行文件找不到、目录不存在。
// 不去真跑是因为不同 shell 的参数差异大（cmd.exe 用 /c，PowerShell 用 -c），
// 试探反而可能误判。
func probeExec(shell, dir, user string) error {
	if _, err := exec.LookPath(shell); err != nil {
		return err
	}
	st, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s 不是目录", dir)
	}
	return nil
}

// isMissingOrDenied 在 Windows 上不启用重试：本地只是调试用，
// 目录不存在应该直接报出来，而不是悄悄换一个。
func isMissingOrDenied(err error) bool { return false }

// DiagnoseEnv 在 Windows 上不输出：本地调试看报错就够了。
func DiagnoseEnv() string { return "" }
