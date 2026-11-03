package session

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"strings"
)

// SpawnReport 是启动前试跑的结果，给日志和自检用。
//
// 为什么要有这一步：Go 的 os/exec 在子进程 chdir 失败时，返回的仍然是
// `fork/exec <argv[0]>: no such file or directory` —— 看起来像 shell 不存在，
// 实际是工作目录不存在（或者降权后的账户进不去）。上机第一次就撞上了这个，
// 报错"启动 shell 失败: fork/exec /bin/bash: no such file or directory"，
// 而 /bin/bash 明明在。与其让人去猜，不如启动时真跑一次。
type SpawnReport struct {
	Shell   string
	Cwd     string
	OK      bool     // 是否找到一组真的能起来的组合
	Changed bool     // shell 或 cwd 与配置不同
	Notes   []string // 给人看的说明
	Failed  []string // 每个失败组合的原因，启动时写日志
}

// PrepareSpawn 把 shell 与工作目录试跑一遍，选出一组真的能起来的组合写回 cfg。
//
// 顺序：先按原配置试（正常情况一次 fork 就过），失败再依次降级。
// shell 在外层，cwd 在内层 —— 因为 cwd 更可能是问题所在，而换掉 shell 的
// 代价比换目录大（会影响补全、快捷键、Claude Code 的体验）。
func PrepareSpawn(cfg *Config) SpawnReport {
	origShell, origCwd := cfg.Shell, cfg.Cwd
	rep := SpawnReport{Shell: origShell, Cwd: origCwd}

	shells := shellCandidates(origShell)
	cwds, skipped := cwdCandidates(cfg)
	skipSet := make(map[string]bool, len(skipped))
	for _, d := range skipped {
		skipSet[d] = true
	}
	if len(skipped) > 0 {
		// 不存在的目录不去试：试也是白 fork 一次，还会在日志里留一条
		// "no such file or directory"，看着像 shell 缺失。
		rep.Notes = append(rep.Notes, "跳过不存在的工作目录："+strings.Join(skipped, "、"))
	}

	seen := make(map[string]bool, len(shells)*len(cwds))
	for _, sh := range shells {
		for _, dir := range cwds {
			key := sh + "\x00" + dir
			if seen[key] {
				continue
			}
			seen[key] = true

			if err := probeExec(sh, dir, cfg.RunAs); err != nil {
				rep.Failed = append(rep.Failed, fmt.Sprintf("%s @ %s：%v%s", sh, dir, err, probeHint(dir, err)))
				continue
			}

			cfg.Shell, cfg.Cwd = sh, dir
			rep.Shell, rep.Cwd = sh, dir
			rep.OK = true
			rep.Changed = sh != origShell || (origCwd != "" && dir != origCwd)
			if sh != origShell {
				rep.Notes = append(rep.Notes, "shell 回退到 "+sh+"（"+origShell+" 跑不起来）")
			}
			// 只有"用户显式指定过 cwd"时，换目录才算回退；cwd 为空是我们自己
			// 从账户 home 里挑的，挑中哪个都不值得报警。
			if origCwd != "" && dir != origCwd {
				if skipSet[origCwd] {
					rep.Notes = append(rep.Notes, "工作目录 "+origCwd+" 不存在，已改用 "+dir)
				} else {
					rep.Notes = append(rep.Notes, "工作目录回退到 "+dir+"（"+
						origCwd+" 该账户进不去）")
				}
			}
			return rep
		}
	}

	// 一组都没跑通。保持原配置，让第一个会话把详细错误带给用户，
	// 同时把这些失败原因写进日志 —— 这时候日志就是唯一的线索。
	cfg.Shell, cfg.Cwd = origShell, origCwd
	rep.Notes = append(rep.Notes,
		"没有任何 shell + 工作目录组合能起来，详见日志里的试跑记录")
	return rep
}

// shellCandidates 返回按优先级排列的候选 shell。
//
// /usr/bin/bash 单独列出来是因为有些系统没有 usr-merge，
// 或者 app 沙箱里 /bin 与 /usr/bin 是两个独立的挂载。
func shellCandidates(preferred string) []string {
	var out []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		for _, x := range out {
			if x == p {
				return
			}
		}
		out = append(out, p)
	}

	add(preferred)
	if runtime.GOOS == "windows" {
		add("powershell.exe")
		add("pwsh.exe")
		add("cmd.exe")
		return out
	}
	// $SHELL 放在 /bin/bash 之后：用户自己 export 了一个坏路径时，
	// 不应该因为环境变量就打断启动。
	add(os.Getenv("SHELL"))
	for _, s := range []string{
		"/bin/bash", "/usr/bin/bash",
		"/bin/sh", "/usr/bin/sh",
		"/bin/zsh", "/usr/bin/zsh",
		"/bin/ash", "/usr/bin/ash",
		"/bin/fish", "/usr/bin/fish",
	} {
		add(s)
	}
	return out
}

// probeHint 把 fork/exec 的错误模糊性再削掉一层。
//
// 光看 "no such file or directory" 分不清是 shell 不在、目录不在，还是
// 动态链接器不在 —— Go 把这三种都包装成同一句话。所以这里补一次 stat：
// 目录明明在，就说明问题在 exec 侧，可以少走一轮排查。
func probeHint(dir string, err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if st, serr := os.Stat(dir); serr == nil && st.IsDir() {
			return "（目录存在 → 问题在 exec 侧：shell 或它的动态链接器在这个命名空间里看不到）"
		}
		return "（目录不存在）"
	case errors.Is(err, fs.ErrPermission):
		return "（该账户进不去这个目录）"
	}
	return ""
}

// cwdCandidates 返回按优先级排列的候选工作目录，以及被跳过的目录。
// 最后一个一定是 /（Windows 是盘根）—— 它永远存在，是"至少能进去"的兜底。
func cwdCandidates(cfg *Config) (out []string, skipped []string) {
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		// 目录不存在就别拿去试了（见 probeHint 的说明）。
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			skipped = append(skipped, p)
			return
		}
		for _, x := range out {
			if x == p {
				return
			}
		}
		out = append(out, p)
	}

	add(cfg.Cwd)
	add(cfg.RunAsHome)
	if home, err := os.UserHomeDir(); err == nil {
		add(home)
	}
	if runtime.GOOS == "windows" {
		if d := os.Getenv("SystemDrive"); d != "" {
			add(d + `\`)
		}
		return out, skipped
	}
	add("/tmp")
	add("/")
	return out, skipped
}
