package session

import (
	"os"
	"testing"
	"time"

	"terminals/internal/history"
)

// TestResumedSessionStaysQuietUntilFirstCommand 锁住"点开历史不该留下痕迹"。
//
// 用户报的现象：从历史记录点开一条，屏幕上多一行 eason@host:~$；什么都不做
// 再关掉，下次点开又长一行。原因是新 shell 的欢迎语、以及前端为了让用户
// 看到提示符补的那个回车，输出都被追加进了老日志。
func TestResumedSessionStaysQuietUntilFirstCommand(t *testing.T) {
	dir := t.TempDir()
	st := history.New(dir)
	defer st.Close()

	const id = "s01"
	const old = "old output\r\n$ "
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

	s := &Session{
		cfg:         Config{History: st},
		histID:      id,
		histNamed:   true,
		histResumed: true,
		histQuiet:   true,
		Created:     time.Now(),
	}

	// 打开动作产生的输出：shell 的欢迎语 + 前端补的回车换来的提示符。
	s.histRecord([]byte("Welcome to fnOS\r\n$ "))
	s.histNameFromInput([]byte("\r")) // 空行不算"操作"
	s.histRecord([]byte("$ "))

	if got := readLog(t, path); got != old {
		t.Fatalf("打开动作不该往日志里写东西，实际 %q", got)
	}
	if !s.histQuiet {
		t.Fatal("空行不该解除抑制")
	}

	// 真敲了一条命令：从这里开始记账。
	s.histNameFromInput([]byte("ls\r"))
	s.histRecord([]byte("ls\r\nfile.txt\r\n"))
	s.histNameFromInput([]byte("pwd\r"))
	s.histRecord([]byte("pwd\r\n/home\r\n"))

	want := old + "ls\r\nfile.txt\r\npwd\r\n/home\r\n"
	if got := readLog(t, path); got != want {
		t.Fatalf("日志 = %q，期望 %q", got, want)
	}
	if s.histQuiet {
		t.Error("敲了命令之后不该还抑制")
	}
}

// TestHistQuietDoesNotSwallowCommandEcho 确认抑制解除的时机：命令本身的回显
// 必须落进日志，否则回看时那一条命令会凭空消失。
//
// 时序要按真实的来：回显是 PTY 打出来的输出，用户敲的每个字都在静默期
// 单独到一次，回车之后才是 shell 的回报。以前的写法把回显和输出塞在同一块
// 里、还排在回车之后，等于假装回显没被丢过 —— 于是这个 bug 一直没被测出来。
func TestHistQuietDoesNotSwallowCommandEcho(t *testing.T) {
	dir := t.TempDir()
	st := history.New(dir)
	defer st.Close()

	const id = "s02"
	st.Begin(history.Entry{ID: id, Title: "old"})
	st.Append(id, []byte("old\r\n$ "))
	st.End(id, 0)
	if _, ok := st.Resume(id); !ok {
		t.Fatal("接手老记录失败")
	}
	path, _ := st.LogPath(id)

	s := &Session{
		cfg:       Config{History: st},
		histID:    id,
		histNamed: true,
		histQuiet: true,
	}
	// 前端补的那个回车换来的提示符
	s.histRecord([]byte("$ "))
	s.histNameFromInput([]byte("\r"))
	// 用户敲命令：输入走 Write，回显随后到 readLoop —— 此时还在静默期
	s.histNameFromInput([]byte("echo hi"))
	s.histRecord([]byte("echo hi"))
	// 回车：解除静默，之后才是 shell 的回报
	s.histNameFromInput([]byte("\r"))
	s.histRecord([]byte("\r\nhi\r\n"))

	if got, want := readLog(t, path), "old\r\n$ echo hi\r\nhi\r\n"; got != want {
		t.Fatalf("日志 = %q，期望 %q", got, want)
	}
}

// TestHistQuietDoesNotInventEcho 确认补回显只搬真的回显过的字节。
//
// 密码提示那种不回显的输入，静默期尾巴里根本没有那几个字 —— 这时宁可不补，
// 也不能把密码写进日志。
func TestHistQuietDoesNotInventEcho(t *testing.T) {
	dir := t.TempDir()
	st := history.New(dir)
	defer st.Close()

	const id = "s03"
	st.Begin(history.Entry{ID: id, Title: "old"})
	st.End(id, 0)
	if _, ok := st.Resume(id); !ok {
		t.Fatal("接手老记录失败")
	}
	path, _ := st.LogPath(id)

	s := &Session{
		cfg:       Config{History: st},
		histID:    id,
		histNamed: true,
		histQuiet: true,
	}
	s.histRecord([]byte("[sudo] password for eason: "))
	s.histNameFromInput([]byte("hunter2\r"))
	s.histRecord([]byte("\r\nroot@host:~# "))

	if got, want := readLog(t, path), "\r\nroot@host:~# "; got != want {
		t.Fatalf("日志 = %q，期望 %q（不该凭空补出没回显过的输入）", got, want)
	}
}

// TestTailAppend 只留最后 max 个字节：静默期尾巴是固定开销，不能跟着刷屏长大。
func TestTailAppend(t *testing.T) {
	buf := tailAppend(nil, []byte("abc"), 4)
	if string(buf) != "abc" {
		t.Fatalf("短块 = %q", buf)
	}
	buf = tailAppend(buf, []byte("defg"), 4)
	if string(buf) != "defg" {
		t.Fatalf("接长之后 = %q，期望 defg", buf)
	}
	buf = tailAppend(buf, []byte("hi"), 4)
	if string(buf) != "fghi" {
		t.Fatalf("尾部保留 = %q，期望 fghi", buf)
	}
	// 一次来一块比上限还大的：只留最后 max 个，不能整块吃下。
	buf = tailAppend(buf, []byte("0123456789"), 4)
	if string(buf) != "6789" {
		t.Fatalf("超长块 = %q，期望 6789", buf)
	}
	// 复用缓冲时不能把旧内容带出来（append(buf[:0], ...) 是原地覆盖）。
	buf = tailAppend(buf, []byte("XY"), 4)
	if string(buf) != "89XY" {
		t.Fatalf("覆盖后 = %q，期望 89XY", buf)
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
