package session

import (
	"strings"

	"terminals/internal/history"
)

// cmdScanner 从用户输入里认出"第一条指令"。
//
// 历史记录的名字由它决定（用户的原话：按我输入的第一条指令命名）。所以这里
// 要做的不是完整的行编辑器，而是从键盘字节流里剥出第一行**有内容**的文本：
//
//   - 方向键、Tab、功能键发的是转义序列，整段丢掉。不认的话，回放历史时
//     xterm 自动应答的 DA/DSR（ESC[?1;2c 之类）会被当成命令名。
//   - 退格、Ctrl+U 按语义作用在已经攒下的字符上，而不是原样塞进去。
//   - 回车时这一行是空的（敲了个空行、或者只按了 Ctrl+C），不命名，继续等。
//
// 一句会话的名字只由第一条命令决定，定名之后扫描器就不再工作。
type cmdScanner struct {
	buf  []byte
	esc  int
	crlf bool
	done bool
}

const (
	escNone = iota
	escStart
	escCSI
	escOSC
	escSS3
)

// Scan 吃一段用户输入，返回第一条指令（还没等到换行时返回 "", false）。
func (c *cmdScanner) Scan(p []byte) (string, bool) {
	if c.done {
		return "", false
	}
	for _, b := range p {
		switch c.esc {
		case escStart:
			switch b {
			case '[':
				c.esc = escCSI
			case ']':
				c.esc = escOSC
			case 'O':
				c.esc = escSS3
			default:
				// ESC 加一个普通字节：Alt+字母、ESC ESC 这类两字节序列。
				c.esc = escNone
			}
			continue
		case escCSI:
			// CSI 到 0x40..0x7e 才算结束（ESC[1;5C、ESC[200~ 都是）。
			if b >= 0x40 && b <= 0x7e {
				c.esc = escNone
			}
			continue
		case escOSC:
			// OSC 以 BEL 或 ST（ESC \）结束。终端标题、超链接都走这条路。
			if b == 0x07 {
				c.esc = escNone
			} else if b == 0x1b {
				c.esc = escStart
			}
			continue
		case escSS3:
			c.esc = escNone
			continue
		}

		switch b {
		case 0x1b:
			c.esc = escStart
			c.crlf = false
		case '\r':
			c.crlf = true
			if cmd := c.take(); cmd != "" {
				return cmd, true
			}
		case '\n':
			// CR LF 算一次换行，不能因为多了个 LF 又"提交"一次空行。
			if c.crlf {
				c.crlf = false
				continue
			}
			if cmd := c.take(); cmd != "" {
				return cmd, true
			}
		case 0x7f, 0x08:
			c.backspace()
		case 0x15, 0x03: // Ctrl+U 清整行、Ctrl+C 放弃这一行
			c.buf = c.buf[:0]
		default:
			if b >= 0x20 {
				c.buf = append(c.buf, b)
			}
		}
	}
	return "", false
}

// take 结掉当前这一行。有内容就当作指令返回，空行只清空缓冲。
func (c *cmdScanner) take() string {
	line := strings.TrimSpace(string(c.buf))
	c.buf = c.buf[:0]
	if line == "" {
		return ""
	}
	c.done = true
	return history.CleanTitle(line)
}

// backspace 删掉最后一个字符（按字节退到 UTF-8 起始字节）。
func (c *cmdScanner) backspace() {
	if len(c.buf) == 0 {
		return
	}
	i := len(c.buf) - 1
	for i > 0 && c.buf[i]&0xc0 == 0x80 {
		i--
	}
	c.buf = c.buf[:i]
}
