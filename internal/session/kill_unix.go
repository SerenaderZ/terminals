//go:build !windows

package session

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// terminateTree 结束一个 PTY 会话的整棵进程树。
//
// 为什么不能只关 pty 主设备：
//   - 关闭主设备时，内核只给这个终端的**前台进程组**发 SIGHUP；
//   - 忽略 SIGHUP 的程序（部分守护化的 CLI、nohup 起来的、被 setsid 过的）
//     会原地活下来；
//   - bash 的 job control 会把后台任务放进**另一个进程组**，
//     这些任务收不到 SIGHUP，关掉窗格后照样在跑。
//
// 用户的预期是"关掉这个窗格 = 里面的东西全停"，所以这里按进程树收网：
// 先 SIGHUP 给它们一个体面退出的机会（TUI 能恢复终端、能存盘），
// 短暂等待后对还活着的发 SIGKILL。
func terminateTree(pid int) {
	if pid <= 0 {
		return
	}

	pids := processTree(pid)

	for _, p := range pids {
		_ = syscall.Kill(p, syscall.SIGHUP)
	}
	// pid 是 setsid 出来的会话首进程，-pid 正好是整个进程组（前台那批）。
	_ = syscall.Kill(-pid, syscall.SIGHUP)

	// 给 TUI 一点收尾时间。80ms 足够它们恢复屏幕、写回状态文件，
	// 又短到用户在界面上感觉不到延迟。
	time.Sleep(80 * time.Millisecond)

	for _, p := range pids {
		_ = syscall.Kill(p, syscall.SIGKILL)
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
}

// processTree 返回 pid 及其全部后代。
//
// 读 /proc 而不是调 ps：ps 的输出格式各平台不一致，还要额外 fork 一个进程；
// /proc 在 Linux 上是权威且无副作用的。拿不到 /proc（macOS 开发机、受限容器）
// 时退化成只有 pid 本身 —— 至少进程组那一刀还在。
func processTree(pid int) []int {
	children := map[int][]int{}

	entries, err := os.ReadDir("/proc")
	if err == nil {
		for _, e := range entries {
			name := e.Name()
			if name[0] < '0' || name[0] > '9' {
				continue
			}
			child, ok := readPPID(name)
			if !ok {
				continue
			}
			children[child] = append(children[child], atoi(name))
		}
	}

	out := []int{pid}
	seen := map[int]bool{pid: true}
	for i := 0; i < len(out); i++ {
		for _, c := range children[out[i]] {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}

	// 杀的顺序无所谓，但后人的习惯是子进程先走，方便日志好看。
	sort.Sort(sort.Reverse(sort.IntSlice(out)))
	return out
}

// readPPID 从 /proc/<pid>/stat 里取父进程号。
//
// 格式是：pid (comm) state ppid ...，其中 comm 是进程名，可能含空格和括号。
// 所以不能按空格切，要先找**最后一个** ')' 再把后面切开。
func readPPID(pid string) (int, bool) {
	data, err := os.ReadFile("/proc/" + pid + "/stat")
	if err != nil {
		return 0, false
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 || i+2 > len(s) {
		return 0, false
	}
	fields := strings.Fields(s[i+1:])
	// fields[0] 是 state，fields[1] 才是 ppid。
	if len(fields) < 2 {
		return 0, false
	}
	n, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, false
	}
	return n, true
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
