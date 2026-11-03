package session

import (
	"bytes"
	"testing"
)

// 回放起点必须落在"终端能安全开始解析"的位置。
//
// 环形缓冲写满后，开头是从缓冲区任意位置切出来的：可能落在一个 CSI 序列
// 的参数里（"1049l"），也可能落在 UTF-8 多字节字符的中间。这些残字如果
// 直接灌进终端，终端会把它们当成序列参数一路吞下去，连带吃掉后面正常的
// 输出 —— 用户看到的不是"少了开头"，而是"整屏都乱了"。
func TestAlignReplayStart(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "utf8 续字节开头：跳过残字与半行文本",
			in:   "\x80\x80abc\ndef",
			want: "def",
		},
		{
			name: "半个转义序列：跳到下一个 ESC",
			in:   "?1049l\x1b[1;1Hhello",
			want: "\x1b[1;1Hhello",
		},
		{
			name: "首字节就是 ESC：跳到下一个 ESC",
			in:   "\x1b[38;5;1;1Hhello\x1b[0m",
			want: "\x1b[0m",
		},
		{
			name: "普通文本：从下一个换行之后开始",
			in:   "ef install done\nroot@nas:~# ",
			want: "root@nas:~# ",
		},
		{
			name: "普通文本没有换行：退到下一个 ESC",
			in:   "tail of a line\x1b[2J\x1b[H",
			want: "\x1b[2J\x1b[H",
		},
		{
			name: "空输入",
			in:   "",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(alignReplayStart([]byte(tc.in))); got != tc.want {
				t.Fatalf("alignReplayStart(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// 每次回放之前都要先复位再清屏：屏幕、字符属性、自动换行、滚动缓冲。
// 少了这一步，重连后旧画面会和新回放叠在一起。
func TestPrepareReplayPrefixesReset(t *testing.T) {
	out := PrepareReplay([]byte("hello"), false)
	if !bytes.HasPrefix(out, []byte(replayResetPrefix)) {
		t.Fatalf("回放缺少复位前缀：%q", out)
	}
	if !bytes.HasSuffix(out, []byte("hello")) {
		t.Fatalf("回放内容丢失：%q", out)
	}

	for _, seq := range []string{"\x1b[0m", "\x1b[H", "\x1b[2J", "\x1b[3J"} {
		if !bytes.Contains([]byte(replayResetPrefix), []byte(seq)) {
			t.Fatalf("复位前缀缺少 %q", seq)
		}
	}
}

func TestPrepareReplayTruncatedAligns(t *testing.T) {
	out := string(PrepareReplay([]byte("?1049l\x1b[1;1Hhi"), true))
	if !bytes.HasSuffix([]byte(out), []byte("\x1b[1;1Hhi")) {
		t.Fatalf("截断回放没有对齐：%q", out)
	}
	if bytes.Contains([]byte(out), []byte("?1049l")) {
		t.Fatalf("半截序列没被丢掉：%q", out)
	}
}

// 环形缓冲里只剩半截序列时，对齐完可能什么都不剩 —— 但复位前缀必须还在，
// 否则前端会保留上一次连接留下的画面。
func TestPrepareReplayEmptyStillResets(t *testing.T) {
	out := string(PrepareReplay([]byte("\x1b[38;5;"), true))
	if out != replayResetPrefix {
		t.Fatalf("out = %q, want reset prefix only", out)
	}
}
