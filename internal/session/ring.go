package session

// Ring 是固定容量的字节环形缓冲，保存最近的终端输出，供断线重连时回放。
//
// 为什么不用 []byte + append 再从头部切片：那样写满之后每次写入都要把剩余
// 内容往前搬一遍（O(n) 拷贝）。256KB 的缓冲在高频输出下会不停搬运内存，
// 纯粹白烧 CPU。环形缓冲写满后是原地覆盖，恒定 O(1)。
type Ring struct {
	buf []byte
	w   int // 下一个写入位置
	n   int // 当前有效字节数
}

// NewRing 创建容量为 capacity 字节的环形缓冲。
func NewRing(capacity int) *Ring {
	if capacity < 0 {
		capacity = 0
	}
	return &Ring{buf: make([]byte, capacity)}
}

// Write 实现 io.Writer。
func (r *Ring) Write(p []byte) (int, error) {
	total := len(p)
	if len(r.buf) == 0 || total == 0 {
		return total, nil
	}

	// 一次写入就超过整个容量：只保留最后 capacity 字节，其余直接丢弃。
	if total >= len(r.buf) {
		copy(r.buf, p[total-len(r.buf):])
		r.w = 0
		r.n = len(r.buf)
		return total, nil
	}

	k := copy(r.buf[r.w:], p)
	if k < total {
		copy(r.buf, p[k:])
	}
	r.w = (r.w + total) % len(r.buf)
	if r.n+total > len(r.buf) {
		r.n = len(r.buf)
	} else {
		r.n += total
	}
	return total, nil
}

// Snapshot 按时间顺序返回当前内容。返回的是新切片，调用方可安全持有。
func (r *Ring) Snapshot() []byte {
	if r.n == 0 {
		return nil
	}
	if r.n < len(r.buf) {
		out := make([]byte, r.n)
		copy(out, r.buf[:r.n])
		return out
	}
	// 已写满：从写指针处绕回来
	out := make([]byte, 0, len(r.buf))
	out = append(out, r.buf[r.w:]...)
	out = append(out, r.buf[:r.w]...)
	return out
}

// Len 返回当前有效字节数。
func (r *Ring) Len() int { return r.n }

// Cap 返回容量。
func (r *Ring) Cap() int { return len(r.buf) }
