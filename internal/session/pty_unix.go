//go:build !windows

package session

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

type unixPTY struct {
	f   *os.File
	cmd *exec.Cmd
}

func spawnPTY(o spawnOpts) (ptyProcess, error) {
	cmd := exec.Command(o.Shell, o.Args...)
	cmd.Dir = o.Cwd
	cmd.Env = o.Env

	// 降权：核心凭据在 fork 阶段就切好，子进程一出生就是目标账户。
	// 注意 pty.StartWithSize 会复用已存在的 SysProcAttr，只往里补 Setsid /
	// Setctty，所以这里设置的 Credential 不会被覆盖。
	cred, err := credentialFor(o.User)
	if err != nil {
		return nil, err
	}
	if cred != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	}

	f, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: uint16(o.Rows),
		Cols: uint16(o.Cols),
	})
	if err != nil {
		return nil, err
	}
	return &unixPTY{f: f, cmd: cmd}, nil
}

func (p *unixPTY) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *unixPTY) Close() error                { return p.f.Close() }
func (p *unixPTY) Pid() int                    { return p.cmd.Process.Pid }

func (p *unixPTY) Resize(cols, rows int) error {
	if cols < 2 {
		cols = 2
	}
	if rows < 2 {
		rows = 2
	}
	return pty.Setsize(p.f, &pty.Winsize{
		Rows: uint16(rows),
		Cols: uint16(cols),
	})
}

func (p *unixPTY) Wait() (int, error) {
	err := p.cmd.Wait()
	if err == nil {
		return 0, nil
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), nil
	}
	return -1, err
}
