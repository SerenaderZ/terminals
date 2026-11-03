package session

import "testing"

// 队列满时必须标记 overflow，让上层断开连接。
//
// 这里刻意不提供"丢掉这一帧继续"的行为：终端输出是字节流，少一帧就少几个
// 字节，丢在 CSI 序列中间会让后面整段输出被吞掉。断开重连、靠回放重建，
// 是唯一不会产生错误画面的做法。
func TestClientSendReportsOverflow(t *testing.T) {
	c := &Client{
		ch:   make(chan []byte, 2),
		done: make(chan struct{}),
	}

	if !c.Send([]byte("a")) || !c.Send([]byte("b")) {
		t.Fatal("队列未满时投递应该成功")
	}
	if c.Send([]byte("c")) {
		t.Fatal("队列已满时投递应该失败")
	}
	if !c.Overflowed() {
		t.Fatal("队列满之后必须标记 overflowed")
	}
}

func TestClientSendAfterCloseDoesNotMarkOverflow(t *testing.T) {
	c := &Client{
		ch:   make(chan []byte, 4),
		done: make(chan struct{}),
	}
	c.Close()

	if c.Send([]byte("a")) {
		t.Fatal("已关闭的连接不该接受投递")
	}
	if c.Overflowed() {
		t.Fatal("连接已关不是「跟不上」，不该标记 overflowed")
	}
}
