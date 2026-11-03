//go:build windows

package session

import (
	"os/exec"
	"strconv"
	"syscall"
)

// terminateTree 结束一个 ConPTY 会话的整棵进程树。
//
// taskkill /T 会顺着父子关系把整棵树一起收掉，/F 是强杀。
// 只关 ConPTY 的话，脱离控制台起出来的子进程（服务、后台任务）会留下来，
// 用户在界面上已经关掉窗格了，进程却还在跑。
func terminateTree(pid int) {
	if pid <= 0 {
		return
	}
	cmd := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
