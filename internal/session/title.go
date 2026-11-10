package session

import "strings"

// titleScanner 从 PTY 输出里捡终端标题。
//
// 标题是 OSC 序列：ESC ] 0 ; <text> BEL，或 ESC ] 0 ; <text> ESC \。
// 0 和 2 都是"窗口标题"，程序习惯用 2（xterm 语义），Claude Code 用 0。
//
// 为什么在后端解析：历史记录要能离线列出标题。只靠前端上报的话，
// 没人打开页面时标题永远空着，列表里全是"终端"。
//
// 跨块是常态 —— 32KB 的读缓冲随时可能把一个序列劈成两半，所以必须
// 带状态。它只认标题，其它 OSC（剪贴板 52、超链接 8）一律跳过。
type titleScanner struct {
	state int // 0 正常 1 收到 ESC 2 OSC 里 3 OSC 里收到 ESC 4 太长，丢弃到结束
	buf   []byte
}

const maxOSCTitle = 512

// Scan 喂一段输出，返回这一段里出现的最后一个标题。
func (s *titleScanner) Scan(p []byte) (string, bool) {
	var last string
	var got bool
	for _, b := range p {
		switch s.state {
		case 0:
			if b == 0x1b {
				s.state = 1
			}
		case 1:
			if b == ']' {
				s.state = 2
				s.buf = s.buf[:0]
			} else if b == 0x1b {
				// 连续 ESC，继续等
			} else {
				s.state = 0
			}
		case 2:
			switch {
			case b == 0x07: // BEL
				if t, ok := oscTitle(s.buf); ok {
					last, got = t, true
				}
				s.state = 0
			case b == 0x1b:
				s.state = 3
			case len(s.buf) >= maxOSCTitle:
				// 太长，多半不是标题（比如 OSC 52 剪贴板）。别再攒了，
				// 一路吃到终止符为止。
				s.state = 4
			default:
				s.buf = append(s.buf, b)
			}
		case 3:
			if b == '\\' { // ST：ESC \
				if t, ok := oscTitle(s.buf); ok {
					last, got = t, true
				}
				s.state = 0
			} else {
				// 不是 ST，把 ESC 当成普通内容继续（有些程序会在标题里塞 ESC）。
				s.buf = append(s.buf, 0x1b)
				s.state = 2
			}
		case 4:
			if b == 0x07 {
				s.state = 0
			} else if b == 0x1b {
				s.state = 3
			}
		}
	}
	return last, got
}

// oscTitle 从 "0;标题" / "2;标题" 里取值。其它 OSC 命令返回 false。
func oscTitle(buf []byte) (string, bool) {
	if len(buf) < 3 || (buf[0] != '0' && buf[0] != '2') || buf[1] != ';' {
		return "", false
	}
	t := strings.TrimSpace(string(buf[2:]))
	if t == "" {
		return "", false
	}
	return t, true
}
