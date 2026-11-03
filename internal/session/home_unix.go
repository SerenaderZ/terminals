//go:build !windows

package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// EnsureHome 保证降权账户有一个真实存在、并且归它所有的 HOME。
//
// 飞牛上很常见：/etc/passwd 里写着 home=/home/yourname，但这个目录从来没建过；
// 而 app 又跑在受限的挂载命名空间里，/home 干脆不可见。后果有两层：
//
//	1. 会话默认工作目录落空，chdir 失败会被 Go 报成 "fork/exec /bin/bash:
//	   no such file or directory"，看着像 bash 不存在；
//	2. 普通用户没有可写的 HOME，Claude Code 连 ~/.claude 都建不出来。
//
// 所以启动时补一次：先把 passwd 里的 home 建出来并 chown 给该账户；
// 建不出来（只读根、没有权限）就退到数据目录下的 home/<账户>。
// 返回值是给人看的一行说明，空表示本来就没问题、什么都没做。
func EnsureHome(cfg *Config, dataDir string) string {
	if cfg.RunAs == "" || cfg.RunAs == "root" {
		return ""
	}
	pw, err := lookupUser(cfg.RunAs)
	if err != nil {
		return ""
	}

	home := strings.TrimSpace(cfg.RunAsHome)
	if home != "" {
		if st, err := os.Stat(home); err == nil && st.IsDir() {
			return "" // 正常路径：home 在，什么都不用做
		}
	}

	cands := make([]string, 0, 2)
	if home != "" {
		cands = append(cands, home)
	}
	if dataDir != "" {
		cands = append(cands, filepath.Join(dataDir, "home", cfg.RunAs))
	}

	var tried []string
	for _, dir := range cands {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			tried = append(tried, dir+"（"+err.Error()+"）")
			continue
		}
		if err := os.Chown(dir, pw.UID, pw.GID); err != nil {
			tried = append(tried, dir+"（chown 失败："+err.Error()+"）")
			continue
		}
		// chown 之后再确认一次：某些挂载上 mkdir 成功但归属仍被改写。
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			tried = append(tried, dir+"（建好后仍不可用）")
			continue
		}

		changed := dir != cfg.RunAsHome
		cfg.RunAsHome = dir
		if changed && cfg.Cwd == "" {
			cfg.Cwd = dir
		}
		if changed {
			return fmt.Sprintf("账户 %s 的 home %s 不可用，已改用 %s（已 chown 给该账户）",
				cfg.RunAs, home, dir)
		}
		return fmt.Sprintf("账户 %s 的 home %s 原本不存在，已创建并 chown 给该账户", cfg.RunAs, dir)
	}

	return fmt.Sprintf("账户 %s 没有可用的 home（%s），会话会落在 /", cfg.RunAs, strings.Join(tried, "；"))
}
