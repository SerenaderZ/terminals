//go:build windows

package session

import (
	"context"
	"strings"

	"github.com/UserExistsError/conpty"
)

// winPTY 只用于本地开发调试。正式目标是飞牛的 Linux 环境，
// 但如果没有它，Windows 上连"跑起来看一眼"都做不到，只能盲写代码。
type winPTY struct {
	c *conpty.ConPty
}

func spawnPTY(o spawnOpts) (ptyProcess, error) {
	line := o.Shell
	if len(o.Args) > 0 {
		line += " " + strings.Join(o.Args, " ")
	}

	opts := []conpty.ConPtyOption{
		conpty.ConPtyDimensions(o.Cols, o.Rows),
	}
	if o.Cwd != "" {
		opts = append(opts, conpty.ConPtyWorkDir(o.Cwd))
	}
	if len(o.Env) > 0 {
		opts = append(opts, conpty.ConPtyEnv(o.Env))
	}

	c, err := conpty.Start(line, opts...)
	if err != nil {
		return nil, err
	}
	return &winPTY{c: c}, nil
}

func (p *winPTY) Read(b []byte) (int, error)  { return p.c.Read(b) }
func (p *winPTY) Write(b []byte) (int, error) { return p.c.Write(b) }
func (p *winPTY) Close() error                { return p.c.Close() }
func (p *winPTY) Pid() int                    { return p.c.Pid() }

func (p *winPTY) Resize(cols, rows int) error {
	if cols < 2 {
		cols = 2
	}
	if rows < 2 {
		rows = 2
	}
	return p.c.Resize(cols, rows)
}

func (p *winPTY) Wait() (int, error) {
	code, err := p.c.Wait(context.Background())
	if err != nil {
		return -1, err
	}
	return int(code), nil
}
