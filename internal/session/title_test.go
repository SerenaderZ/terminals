package session

import "testing"

func TestTitleScanner(t *testing.T) {
	cases := []struct {
		name string
		in   []string // 分块喂入，模拟 32KB 读缓冲把序列劈开
		want string
		ok   bool
	}{
		{
			name: "BEL 结尾",
			in:   []string{"\x1b]0;claude\x07"},
			want: "claude", ok: true,
		},
		{
			name: "OSC 2 也认",
			in:   []string{"\x1b]2;vim main.go\x07"},
			want: "vim main.go", ok: true,
		},
		{
			name: "ST 结尾",
			in:   []string{"\x1b]0;npm run dev\x1b\\"},
			want: "npm run dev", ok: true,
		},
		{
			name: "跨块：断在 ESC 之后",
			in:   []string{"abc\x1b", "]0;split\x07"},
			want: "split", ok: true,
		},
		{
			name: "跨块：断在标题中间",
			in:   []string{"\x1b]0;half", "way\x07"},
			want: "halfway", ok: true,
		},
		{
			name: "跨块：断在 ST 中间",
			in:   []string{"\x1b]0;st\x1b", "\\"},
			want: "st", ok: true,
		},
		{
			name: "OSC 52 剪贴板不是标题",
			in:   []string{"\x1b]52;c;aGVsbG8=\x07"},
			ok:   false,
		},
		{
			name: "普通输出",
			in:   []string{"just some text\r\n"},
			ok:   false,
		},
		{
			name: "空标题忽略",
			in:   []string{"\x1b]0;\x07"},
			ok:   false,
		},
		{
			name: "多个标题取最后一个",
			in:   []string{"\x1b]0;first\x07 middle \x1b]2;second\x07"},
			want: "second", ok: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s titleScanner
			var got string
			var ok bool
			for _, part := range c.in {
				if v, k := s.Scan([]byte(part)); k {
					got, ok = v, true
				}
			}
			if ok != c.ok {
				t.Fatalf("ok = %v，期望 %v（got=%q）", ok, c.ok, got)
			}
			if ok && got != c.want {
				t.Errorf("标题 = %q，期望 %q", got, c.want)
			}
		})
	}
}

// 超长 OSC（比如整段剪贴板）不能把后续标题一起吞掉。
func TestTitleScannerOverflowRecovers(t *testing.T) {
	var s titleScanner
	big := make([]byte, 600)
	for i := range big {
		big[i] = 'a'
	}
	s.Scan([]byte("\x1b]52;c;"))
	s.Scan(big)
	s.Scan([]byte("\x07"))

	if v, ok := s.Scan([]byte("\x1b]0;after\x07")); !ok || v != "after" {
		t.Fatalf("超长 OSC 之后没能恢复：got=%q ok=%v", v, ok)
	}
}
