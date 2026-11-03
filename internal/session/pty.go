package session

import "io"

// ptyProcess 是伪终端的抽象。Linux 走 creack/pty，Windows 走 ConPTY，
// 两边行为一致：可以读写、可以改尺寸、能等到退出码。
type ptyProcess interface {
	io.ReadWriteCloser
	Resize(cols, rows int) error
	Wait() (int, error)
	Pid() int
}

// spawnOpts 是启动一个 PTY 所需的全部参数。
type spawnOpts struct {
	Shell string
	Args  []string
	Cwd   string
	Env   []string
	Cols  int
	Rows  int

	// User 是 shell 要降权到的账户；空或用 "root" 表示沿用当前进程身份。
	User string
}
