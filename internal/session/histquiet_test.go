package session

import (
	"os"
	"testing"
	"time"

	"terminals/internal/history"
)

// resume 造一条"已经结束的老记录"，然后按接手的方式打开它。
func resume(t *testing.T, id string, old string) (*history.Store, string) {
	t.Helper()
	dir := t.TempDir()
	st := history.New(dir)
	st.Begin(history.Entry{ID: id, Title: "old", Created: time.Now().Add(-time.Minute).Unix()})
	st.Append(id, []byte(old))
	st.End(id, 0)
	// 真正"接手"这条记录：Append 只对打开中的文件有效，不 Resume 就等于
	// 往一个没打开的句柄上写，什么都写不进去。
	if _, ok := st.Resume(id); !ok {
		t.Fatal("接手老记录失败")
	}
	path, ok := st.LogPath(id)
	if !ok {
		t.Fatal("拿不到日志路径")
	}
	return st, path
}

// TestResumedSessionStaysQuietUntilUserActs 锁住"点开历史不该留下痕迹"。
//
// 用户报的现象：从历史记录点开一条，屏幕上多一行 eason@host:~$；什么都不做
// 再关掉，下次点开又长一行。原因是新 shell 的欢迎语、以及前端为了让用户
// 看到提示符补的那个回车（走 WriteQuiet，不经过 histNameFromInput），
// 输出都被追加进了老日志。
func TestResumedSessionStaysQuietUntilUserActs(t *testing.T) {
	const id = "s01"
	const old = "old output\r\n$ "
	st, path := resume(t, id, old)
	defer st.Close()

	s := &Session{
		cfg:         Config{History: st},
		histID:      id,
		histNamed:   true,
		histResumed: true,
		histQuiet:   true,
		Created:     time.Now(),
	}

	// 打开动作产生的输出：shell 的欢迎语 + 前端补的回车换来的提示符。
	// 那个回车走的是 WriteQuiet，根本不经过 histNameFromInput —— 这里只
	// 模拟它引出的输出。
	s.histRecord([]byte("Welcome to fnOS\r\n$ "))
	s.histRecord([]byte("$ "))

	if got := readLog(t, path); got != old {
		t.Fatalf("打开动作不该往日志里写东西，实际 %q", got)
	}
	if !s.histQuiet {
		t.Fatal("只是打开、没人动手，不该解除抑制")
	}

	// xterm 自己的自动应答（程序当年的 DA 查询换来的）不是人按的：
	// 里面只有转义序列，没有真实按键，不该解除抑制。
	s.histNameFromInput([]byte("\x1b[?1;0c"))
	s.histRecord([]byte("still startup\r\n"))
	if !s.histQuiet {
		t.Fatal("自动应答不该被当成用户操作")
	}
	if got := readLog(t, path); got != old {
		t.Fatalf("自动应答之后也不该写日志，实际 %q", got)
	}
}

// TestResumedSessionRecordsBlankEnters 接手之后按的空回车也要记账。
//
// 用户报的现象：从历史打开，敲了几个空行再敲一条无效命令，回看时那几个
// 空行一条都没有。根因是"解除静默"原来要等到一条完整的命令，而空回车
// 被当成了打开动作的副产物。
func TestResumedSessionRecordsBlankEnters(t *testing.T) {
	const id = "s04"
	const old = "old output\r\n$ "
	st, path := resume(t, id, old)
	defer st.Close()

	s := &Session{
		cfg:         Config{History: st},
		histID:      id,
		histNamed:   true,
		histResumed: true,
		histQuiet:   true,
	}
	// 打开动作
	s.histRecord([]byte("$ "))

	// 三个空回车：每个都是人按的，各自的提示符都该留下。
	for i := 0; i < 3; i++ {
		s.histNameFromInput([]byte("\r"))
		s.histRecord([]byte("\r\n$ "))
	}

	want := old + "\r\n$ \r\n$ \r\n$ "
	if got := readLog(t, path); got != want {
		t.Fatalf("日志 = %q，期望 %q", got, want)
	}
	if s.histQuiet {
		t.Error("按了回车之后不该还抑制")
	}
}

// TestHistQuietDoesNotSwallowCommandEcho 确认抑制解除的时机：命令本身的回显
// 必须落进日志，否则回看时那一条命令会凭空消失。
//
// 时序按真实的来：用户敲字是一次次单独到达的，回显随后到。解除发生在把
// 输入写进 PTY 之前，所以第一个字符的回显就已经该记账了 —— 不再需要在
// 静默期的尾巴里"捞回显"。
func TestHistQuietDoesNotSwallowCommandEcho(t *testing.T) {
	const id = "s02"
	const old = "old\r\n$ "
	st, path := resume(t, id, old)
	defer st.Close()

	s := &Session{
		cfg:         Config{History: st},
		histID:      id,
		histNamed:   true,
		histResumed: true,
		histQuiet:   true,
	}
	// 前端补的那个回车换来的提示符
	s.histRecord([]byte("$ "))
	// 用户敲命令，一个字一个字到，回显跟着回来
	for _, ch := range []string{"e", "c", "h", "o", " ", "h", "i"} {
		s.histNameFromInput([]byte(ch))
		s.histRecord([]byte(ch))
	}
	// 回车，然后是 shell 的回报
	s.histNameFromInput([]byte("\r"))
	s.histRecord([]byte("\r\nhi\r\n"))

	if got, want := readLog(t, path), old+"echo hi\r\nhi\r\n"; got != want {
		t.Fatalf("日志 = %q，期望 %q", got, want)
	}
}

// TestHistQuietDoesNotInventEcho 确认不回显的输入不会被写进日志。
//
// 密码提示那种不回显的输入：解除抑制之后 PTY 也不会吐回显，所以日志里
// 只有提示符和后续输出，不可能凭空冒出那几个字。
func TestHistQuietDoesNotInventEcho(t *testing.T) {
	const id = "s03"
	st, path := resume(t, id, "")
	defer st.Close()

	s := &Session{
		cfg:         Config{History: st},
		histID:      id,
		histNamed:   true,
		histResumed: true,
		histQuiet:   true,
	}
	s.histRecord([]byte("[sudo] password for eason: "))
	s.histNameFromInput([]byte("hunter2\r"))
	s.histRecord([]byte("\r\nroot@host:~# "))

	if got, want := readLog(t, path), "\r\nroot@host:~# "; got != want {
		t.Fatalf("日志 = %q，期望 %q（不该凭空补出没回显过的输入）", got, want)
	}
}

func readLog(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读日志失败：%v", err)
	}
	return string(b)
}

// TestReadyCarriesHistoryID 锁住"刷新页面之后前端找得到那条历史"。
//
// 前端布局里只存 sid，历史文件是哪一条只有服务端知道。刷新页面之后要靠
// READY 里这个 histId 把日志重新铺回屏幕上 —— 少了它，屏幕上就只剩接手
// 之后敲的那几行。
func TestReadyCarriesHistoryID(t *testing.T) {
	start := int64(411)
	s := &Session{ID: "sNew", histID: "sOld", histResumed: true, histStart: start}
	r := s.Ready(false, false, 0, false, false)
	if r.HistID != "sOld" {
		t.Fatalf("HistID = %q，期望 sOld", r.HistID)
	}
	if r.HistStart == nil || *r.HistStart != start {
		t.Fatalf("HistStart = %v，期望 %d", r.HistStart, start)
	}

	// 普通会话有自己的日志 id（写日志时用），但那是"当前这一屏"的记录，
	// 不该发出去让前端拿它重铺屏幕。
	plain := &Session{ID: "sPlain", histID: "sPlain"}
	if got := plain.Ready(false, false, 0, false, false).HistID; got != "" {
		t.Fatalf("普通会话不该带 HistID，得到 %q", got)
	}
}
