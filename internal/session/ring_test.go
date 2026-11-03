package session

import (
	"bytes"
	"sync"
	"testing"
)

func TestRingWrapsInOrder(t *testing.T) {
	r := NewRing(16)
	if _, err := r.Write([]byte("0123456789")); err != nil {
		t.Fatal(err)
	}
	if got := string(r.Snapshot()); got != "0123456789" {
		t.Fatalf("snapshot = %q", got)
	}
	if _, err := r.Write([]byte("abcdefgh")); err != nil {
		t.Fatal(err)
	}
	// 写满后从写指针绕回：保留最后 16 字节 "23456789abcdefgh"
	if got := string(r.Snapshot()); got != "23456789abcdefgh" {
		t.Fatalf("snapshot = %q", got)
	}
	if !r.Truncated() {
		t.Fatal("写满过的缓冲应该报告 Truncated")
	}
}

func TestRingSingleWriteLargerThanCap(t *testing.T) {
	r := NewRing(8)
	_, _ = r.Write([]byte("0123456789abcdef"))
	if got := string(r.Snapshot()); got != "89abcdef" {
		t.Fatalf("snapshot = %q", got)
	}
	if !r.Truncated() {
		t.Fatal("应该报告 Truncated")
	}
}

func TestRingNotTruncatedWhenShort(t *testing.T) {
	r := NewRing(64)
	_, _ = r.Write([]byte("hi"))
	if r.Truncated() {
		t.Fatal("没写满不该报告 Truncated")
	}
}

// Snapshot 与 Write 并发时不能读到撕裂的内容。
//
// 这是重连花屏的根因之一：写协程正在覆盖环形缓冲，建连协程同时取快照，
// 少了互斥就会拿到"长度对、内容半新半旧"的一段字节 —— 里面往往夹着
// 半个 CSI 序列，灌进终端后整屏解析错位。
//
// 用 race detector 只能在带 cgo 的机器上验证，所以这里做内容级校验：
// 每次写入都是 64 字节的同值块，且容量是 64 的倍数（写指针天然按 64 对齐），
// 任何一块内部出现两个不同的字节，就是读到了撕裂的中间态。
func TestRingConcurrentSnapshotNotTorn(t *testing.T) {
	const block = 64
	r := NewRing(block * 64)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		i := 0
		for {
			select {
			case <-stop:
				return
			default:
			}
			b := bytes.Repeat([]byte{byte('A' + i%2)}, block)
			_, _ = r.Write(b)
			i++
		}
	}()

	for k := 0; k < 3000; k++ {
		snap := r.Snapshot()
		for off := 0; off+block <= len(snap); off += block {
			for j := 1; j < block; j++ {
				if snap[off+j] != snap[off] {
					close(stop)
					wg.Wait()
					t.Fatalf("快照出现撕裂：块偏移 %d 内第 %d 字节不同", off, j)
				}
			}
		}
	}

	close(stop)
	wg.Wait()
}
