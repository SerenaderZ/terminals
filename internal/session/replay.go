package session

import "bytes"

// replayResetPrefix 是每次回放之前先发给终端的复位序列。
//
// 为什么要这么做：回放是"把一段历史字节流重新灌进一个新终端"，而接收方
// 未必是空的 —— 同一个窗格重连时，屏幕上还留着上一次连接的画面和状态
// （颜色、下划线、自动换行、鼠标上报……）。不清掉就直接灌，两份内容会
// 叠在一起：旧文字夹在回放的新文字中间，看起来就是"退出程序后满屏乱码"。
//
// 各段的作用：
//
//	\e[0m    复位所有字符属性（颜色/加粗/反显），否则整屏可能染成红色
//	\e[?7h   打开自动换行（有些程序退出时忘了恢复，会导致后面所有行不折行）
//	\e[H     光标回左上角
//	\e[2J    清屏
//	\e[3J    清掉滚动缓冲区，避免旧历史与回放重复
const replayResetPrefix = "\x1b[0m\x1b[?7h\x1b[H\x1b[2J\x1b[3J"

// PrepareReplay 组装最终要发给客户端的回放字节。
//
// truncated 为真时，回放的开头是被环形缓冲"覆盖"出来的随机位置：可能落在
// 某个 CSI 序列的参数中间，也可能落在一个 UTF-8 多字节字符的中间。直接灌
// 进去，终端会把这些残字当成序列参数一路吞下去，连带吃掉后面正常输出 ——
// 于是用户看到的不是"少了开头"，而是"整屏都乱了"。所以要先对齐到安全起点。
func PrepareReplay(payload []byte, truncated bool) []byte {
	body := payload
	if truncated {
		body = alignReplayStart(payload)
	}

	out := make([]byte, 0, len(replayResetPrefix)+len(body))
	out = append(out, replayResetPrefix...)
	out = append(out, body...)
	return out
}

// alignReplayStart 把回放起点挪到一个"终端可以安全开始解析"的位置。
//
// 规则很朴素：宁可丢掉开头一小段，也不要丢一段半截的控制序列。丢掉的
// 内容只是更早的历史，用户本来也滚不到那么远。
func alignReplayStart(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}

	// 1) 落在 UTF-8 多字节字符中间：跳过续字节（10xxxxxx）。
	for len(b) > 0 && b[0]&0xC0 == 0x80 {
		b = b[1:]
	}
	if len(b) == 0 {
		return nil
	}

	// 2) 落在一个转义序列中间（首字节是 ESC 但不是序列开头，或者干脆是
	//    参数/终止字节）。跳到下一个完整的 ESC，从那里重新开始。
	if b[0] == 0x1b {
		if i := bytes.IndexByte(b[1:], 0x1b); i >= 0 {
			return b[i+1:]
		}
		return nil
	}
	if b[0] < 0x20 || b[0] > 0x7e {
		if i := bytes.IndexByte(b, 0x1b); i >= 0 {
			return b[i:]
		}
		return nil
	}

	// 3) 落在普通文本中间：跳到下一个换行之后，避免半行文字接在提示符后面。
	//    全屏 TUI 的字节流常常整段没有换行（改用 CUP 定位），那就退而求其次，
	//    从下一个 ESC 开始。
	if i := bytes.IndexByte(b, '\n'); i >= 0 {
		if i+1 < len(b) {
			return b[i+1:]
		}
		return nil
	}
	if i := bytes.IndexByte(b, 0x1b); i >= 0 {
		return b[i:]
	}
	return b
}
