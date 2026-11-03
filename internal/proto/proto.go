// Package proto 定义浏览器与后端之间的二进制帧格式。
//
// 首字节是类型，其后是负载。不做 base64、不做转义 —— TUI 高频重绘时
// 任何一层编码都是纯开销。
package proto

const (
	// 客户端 -> 服务端
	KindInput  byte = 0x01 // 原始键盘字节（UTF-8）
	KindResize byte = 0x02 // {"cols":N,"rows":M}
	KindSignal byte = 0x03 // {"signal":"INT"}
	KindAck    byte = 0x04 // {"n":N} 预留，M2 启用信用窗口

	// 服务端 -> 客户端
	KindOutput  byte = 0x01 // 原始终端输出
	KindExit    byte = 0x02 // {"code":N,"signal":N}
	KindReady   byte = 0x03 // 会话就绪，负载是 JSON 元信息
	KindError   byte = 0x04 // 纯文本错误
	KindCredit  byte = 0x05 // 预留，M2
	KindRevoked byte = 0x06 // 被其他窗口接管，转只读
)

// Frame 把类型和负载拼成一帧。
func Frame(kind byte, payload []byte) []byte {
	out := make([]byte, len(payload)+1)
	out[0] = kind
	copy(out[1:], payload)
	return out
}
