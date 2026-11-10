package session

import "testing"

func TestCmdScanner(t *testing.T) {
	cases := []struct {
		name  string
		in    []string // 分块喂，模拟键盘事件和数据包边界
		want  string
		found bool
	}{
		{name: "普通命令", in: []string{"ls -la\r"}, want: "ls -la", found: true},
		{name: "CRLF 只算一次换行", in: []string{"git status\r\n"}, want: "git status", found: true},
		{name: "分块到达", in: []string{"npm", " run", " dev", "\r"}, want: "npm run dev", found: true},
		{name: "空行不算命令", in: []string{"\r\r  ls\r"}, want: "ls", found: true},
		{name: "Ctrl+C 放弃当前行", in: []string{"abc\x03ls\r"}, want: "ls", found: true},
		{name: "退格改字", in: []string{"ls -lZ\x7f\r"}, want: "ls -l", found: true},
		{name: "Ctrl+U 清行", in: []string{"nonsense\x15make test\r"}, want: "make test", found: true},
		{name: "方向键不参与命名", in: []string{"\x1b[A\x1b[Bhtop\r"}, want: "htop", found: true},
		{name: "终端自动应答不参与命名", in: []string{"\x1b[?1;2c\x1b[12;40Rvim\r"}, want: "vim", found: true},
		{name: "只有控制序列时不命名", in: []string{"\x1b[A\x1b[B\r"}, want: "", found: false},
		{name: "只有空行时不命名", in: []string{"\r\n\r\n"}, want: "", found: false},
		{name: "中文命令", in: []string{"echo 你好\r"}, want: "echo 你好", found: true},
		{name: "收掉多余空白", in: []string{"  git   log  \r"}, want: "git log", found: true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s cmdScanner
			var got string
			found := false
			for _, chunk := range c.in {
				if v, ok := s.Scan([]byte(chunk)); ok {
					got, found = v, true
					break
				}
			}
			if found != c.found {
				t.Fatalf("found = %v，期望 %v（拿到 %q）", found, c.found, got)
			}
			if got != c.want {
				t.Errorf("命令 = %q，期望 %q", got, c.want)
			}
		})
	}
}

// 定名之后就不再改名字：后面的输入不该覆盖它。
func TestCmdScannerStopsAfterFirst(t *testing.T) {
	var s cmdScanner
	if v, ok := s.Scan([]byte("claude\r")); !ok || v != "claude" {
		t.Fatalf("第一条命令 = %q, %v", v, ok)
	}
	if v, ok := s.Scan([]byte("rm -rf /\r")); ok {
		t.Errorf("定名之后不该再返回命令，拿到 %q", v)
	}
}

// 一行特别长时按标题长度截断，不能把整条命令行塞进列表。
func TestCmdScannerTruncates(t *testing.T) {
	var s cmdScanner
	long := make([]byte, 0, 400)
	for i := 0; i < 400; i++ {
		long = append(long, 'a')
	}
	long = append(long, '\r')
	v, ok := s.Scan(long)
	if !ok {
		t.Fatal("没认出命令")
	}
	if len(v) > 200 {
		t.Errorf("标题长度 = %d，没有被截断", len(v))
	}
}
