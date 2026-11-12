//go:build linux

package files

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
)

// errProtected 表示这是一个被保护、不允许通过面板删除的路径。
var errProtected = errors.New("这个位置不能通过面板删除，请到终端里操作")

// Credential 是文件操作要使用的身份。
//
// 为什么不能直接用进程身份：tsd 以 root 启动，终端里的 shell 却降权到
// 普通管理员账户。文件面板若以 root 写盘，上传的文件属主就是 root ——
// 终端里那个用户反而改不了自己刚传上去的文件。这是功能性错误，不是
// 理论上的风险。
type Credential struct {
	// UID < 0 表示不切换身份。
	UID int
	GID int
}

// None 表示按进程当前身份操作。
func None() Credential { return Credential{UID: -1, GID: -1} }

// Run 在目标身份下执行 fn。
func (c Credential) Run(fn func() error) error {
	// 进程本来就是目标账户（本地开发、或者应用本身就以该账户运行）时，
	// 切过去没有任何意义，跳过。
	if c.UID < 0 || os.Geteuid() == c.UID {
		return fn()
	}

	// fsuid 是 per-thread 的：锁住 OS 线程之后，这里改的只是"这一个线程
	// 用什么身份访问文件"，别的 goroutine 在别的线程上不受影响。反过来，
	// 不锁线程的话 goroutine 可能在设置与恢复之间飘到另一个线程上 ——
	// 既漏掉了降权，又把另一个线程的身份改坏，那种 bug 很难查。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := setFSUID(c.UID); err != nil {
		return err
	}
	defer func() { _ = setFSUID(0) }()

	if c.GID >= 0 {
		if err := setFSGID(c.GID); err != nil {
			return err
		}
		defer func() { _ = setFSGID(0) }()
	}

	return fn()
}

// setFSUID 设置当前线程的文件系统用户。
//
// Linux 的 setfsuid 成功时返回"旧的" fsuid，失败时返回当前 fsuid，而且
// 两种情况下都不设置 errno —— 所以不能凭返回值判断成败，必须再查一次。
func setFSUID(uid int) error {
	_, _, _ = syscall.Syscall(syscall.SYS_SETFSUID, uintptr(uid), 0, 0)
	if cur := queryFSUID(); cur != uid {
		return fmt.Errorf("无法以 uid=%d 身份访问文件（当前 %d），"+
			"多半是账户配置不对或进程没有权限", uid, cur)
	}
	return nil
}

func queryFSUID() int {
	r, _, _ := syscall.Syscall(syscall.SYS_SETFSUID, uintptr(^uint32(0)), 0, 0)
	return int(r)
}

func setFSGID(gid int) error {
	_, _, _ = syscall.Syscall(syscall.SYS_SETFSGID, uintptr(gid), 0, 0)
	r, _, _ := syscall.Syscall(syscall.SYS_SETFSGID, uintptr(^uint32(0)), 0, 0)
	if int(r) != gid {
		return fmt.Errorf("无法以 gid=%d 身份访问文件（当前 %d）", gid, int(r))
	}
	return nil
}
