package session

import "bytes"

// 进入 / 离开备用屏幕（全屏 TUI 用的那块屏幕）的转义序列。
var (
	altEnterSeqs = [][]byte{[]byte("\x1b[?1049h"), []byte("\x1b[?47h")}
	altLeaveSeqs = [][]byte{[]byte("\x1b[?1049l"), []byte("\x1b[?47l")}
)

// tailKeep 要保留的尾部字节数。最长的序列是 8 字节（ESC[?1049h），
// 保留 8 字节就能覆盖"序列被读取块切断"的情况。
const tailKeep = 8

// altScanner 跟踪会话当前是否处于备用屏幕。
//
// 为什么需要它：全屏 TUI 在备用屏幕上持续重绘，重连时如果把回放字节流
// 直接灌进终端，客户端没先进备用屏幕，TUI 的重绘就画到主屏上了，界面全乱。
type altScanner struct {
	tail  []byte
	inAlt bool
}

// scan 处理一块新输出，更新状态。
func (s *altScanner) scan(chunk []byte) {
	if len(chunk) == 0 {
		return
	}

	combined := chunk
	if len(s.tail) > 0 {
		combined = make([]byte, 0, len(s.tail)+len(chunk))
		combined = append(combined, s.tail...)
		combined = append(combined, chunk...)
	}

	lastEnter, lastLeave := -1, -1
	for _, seq := range altEnterSeqs {
		if i := bytes.LastIndex(combined, seq); i > lastEnter {
			lastEnter = i
		}
	}
	for _, seq := range altLeaveSeqs {
		if i := bytes.LastIndex(combined, seq); i > lastLeave {
			lastLeave = i
		}
	}
	// 两者都有时，靠后的那个生效。
	if lastEnter >= 0 || lastLeave >= 0 {
		s.inAlt = lastEnter > lastLeave
	}

	if len(combined) >= tailKeep {
		s.tail = append(s.tail[:0], combined[len(combined)-tailKeep:]...)
	} else {
		s.tail = append(s.tail[:0], combined...)
	}
}

// InAlt 返回当前是否处于备用屏幕。
func (s *altScanner) InAlt() bool { return s.inAlt }

// replayNeedAltEnter 判断回放内容里是否已经带了"进入备用屏幕"的起点。
//
// 返回 true 表示：会话现在在备用屏幕里，但回放缓冲里找不到那个入口
// （多半是被容量截断掉了），客户端需要自己先切进去再回放。
func replayNeedAltEnter(replay []byte, inAlt bool) bool {
	if !inAlt {
		return false
	}
	for _, seq := range altEnterSeqs {
		if bytes.Contains(replay, seq) {
			return false
		}
	}
	return true
}
