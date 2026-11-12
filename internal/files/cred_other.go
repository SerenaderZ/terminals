//go:build !linux

package files

import "errors"

// errProtected 表示这是一个被保护、不允许通过面板删除的路径。
var errProtected = errors.New("这个位置不能通过面板删除，请到终端里操作")

// Credential 在非 Linux 平台上不做身份切换。
//
// 目标平台是飞牛的 Linux，这里主要服务 Windows 上的本地开发：那种场景下
// 进程和终端本来就是同一个身份，没有可切的东西。
type Credential struct {
	UID int
	GID int
}

// None 表示按进程当前身份操作。
func None() Credential { return Credential{UID: -1, GID: -1} }

// Run 直接执行 fn。
func (c Credential) Run(fn func() error) error { return fn() }
