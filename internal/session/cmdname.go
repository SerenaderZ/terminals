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
	// acted 表示这段输入里有没有"用户真的按了东西"的字节。
	//
	// 它和"有没有认出命令"是两件事：用户可能只是敲了个空回车、按了退格，
	// 或者敲了半行还没回车。这些都不构成一条命令，但确实是人在操作 ——
	// 接手一条老记录时，从这一刻起就该往日志里记账了（见 histNameFromInput）。
	//
	// 转义序列不算：程序当年的查询（DA/DSR）会让 xterm 自动应答一串
	// ESC[?1;0c，那是终端在说话，不是人。整段被状态机吃掉，不置这一位。
	acted bool
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
	c.acted = false
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
			// ESC 只是序列的开头，本身不是"用户按了一个键" —— 自动应答
			// 也以它开头，所以这一位不能在这里置。
			c.esc = escStart
			c.crlf = false
		case '\r':
			c.acted = true
			c.crlf = true
			if cmd := c.take(); cmd != "" {
				return cmd, true
			}
		case '\n':
			c.acted = true
			// CR LF 算一次换行，不能因为多了个 LF 又"提交"一次空行。
			if c.crlf {
				c.crlf = false
				continue
			}
			if cmd := c.take(); cmd != "" {
				return cmd, true
			}
		case 0x7f, 0x08:
			c.acted = true
			c.backspace()
		case 0x15, 0x03: // Ctrl+U 清整行、Ctrl+C 放弃这一行
			c.acted = true
			c.buf = c.buf[:0]
		default:
			c.acted = true
			if b >= 0x20 {
				c.buf = append(c.buf, b)
			}
		}
	}
	return "", false
}

// Acted 报告上一次 Scan 的输入里有没有"用户真的按了东西"的字节。
// 只对紧接着的那次 Scan 有效 —— 每次 Scan 开头都会清掉。
func (c *cmdScanner) Acted() bool { return c.acted }

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
