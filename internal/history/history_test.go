package history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBeginAppendEnd(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	if s == nil {
		t.Fatal("New 返回 nil")
	}
	defer s.Close()

	s.Begin(Entry{ID: "s01", Cwd: "/home/eason", Shell: "/bin/bash", Created: 1000})
	s.Append("s01", []byte("hello\n"))
	s.Append("s01", []byte("world\n"))
	s.SetTitle("s01", "  claude  ")
	s.End("s01", 0)

	list := s.List()
	if len(list) != 1 {
		t.Fatalf("列表长度 = %d，期望 1", len(list))
	}
	e := list[0]
	if e.Title != "claude" {
		t.Errorf("标题 = %q，期望 claude", e.Title)
	}
	if e.Bytes != 12 {
		t.Errorf("字节数 = %d，期望 12", e.Bytes)
	}
	if e.Ended == 0 {
		t.Error("结束时间没记上")
	}
	if e.Live {
		t.Error("会话已结束，不该标成 live")
	}

	p, ok := s.LogPath("s01")
	if !ok {
		t.Fatal("拿不到日志路径")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读日志失败：%v", err)
	}
	if string(b) != "hello\nworld\n" {
		t.Errorf("日志内容 = %q", string(b))
	}
}

func TestOrderNewestFirst(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()
	s.Begin(Entry{ID: "a", Created: 100})
	s.Begin(Entry{ID: "b", Created: 200})
	s.Begin(Entry{ID: "c", Created: 300})

	list := s.List()
	want := []string{"c", "b", "a"}
	for i, id := range want {
		if list[i].ID != id {
			t.Fatalf("第 %d 条 = %s，期望 %s", i, list[i].ID, id)
		}
	}
}

func TestDeleteAndClear(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	defer s.Close()
	s.Begin(Entry{ID: "a", Created: 1})
	s.Append("a", []byte("x"))
	s.Begin(Entry{ID: "b", Created: 2})
	s.Append("b", []byte("y"))

	if !s.Delete("a") {
		t.Fatal("删除已有的记录应当成功")
	}
	if _, ok := s.Get("a"); ok {
		t.Error("删掉的记录还在索引里")
	}
	if _, err := os.Stat(filepath.Join(dir, "a.log")); !os.IsNotExist(err) {
		t.Error("删掉的日志文件还在")
	}
	if s.Delete("a") {
		t.Error("重复删除不该报成功")
	}

	if n := s.Clear(); n != 1 {
		t.Errorf("清空计数 = %d，期望 1", n)
	}
	if len(s.List()) != 0 {
		t.Error("清空后还有记录")
	}
}

// 升级/崩溃之后重启，索引和日志都得能对上。
func TestReloadAfterRestart(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	s.Begin(Entry{ID: "s01", Created: 500, Cwd: "/tmp"})
	s.Append("s01", []byte("one"))
	s.End("s01", 0)

	// 模拟一次"没来得及收尾"的进程：Begin 之后直接消失。
	s.Begin(Entry{ID: "s02", Created: 600})
	s.Append("s02", []byte("two"))
	s.Close() // 进程没了，句柄跟着关（Windows 上不关就删不掉临时目录）

	again := New(dir)
	defer again.Close()
	list := again.List()
	if len(list) != 2 {
		t.Fatalf("重新载入后 %d 条，期望 2", len(list))
	}
	byID := map[string]Entry{}
	for _, e := range list {
		byID[e.ID] = e
	}
	if byID["s01"].Bytes != 3 {
		t.Errorf("s01 字节数 = %d，期望 3", byID["s01"].Bytes)
	}
	if byID["s01"].Cwd != "/tmp" {
		t.Errorf("s01 目录 = %q", byID["s01"].Cwd)
	}
	if byID["s02"].Bytes != 3 {
		t.Errorf("s02 字节数 = %d，期望 3（从文件大小校正）", byID["s02"].Bytes)
	}
}

// 索引丢了、日志还在：记录应该能从文件名捞回来，而不是整条消失。
func TestLogWithoutIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "orphan.log"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(dir)
	defer s.Close()
	e, ok := s.Get("orphan")
	if !ok {
		t.Fatal("只有日志文件时没恢复出记录")
	}
	if e.Bytes != 4 {
		t.Errorf("字节数 = %d，期望 4", e.Bytes)
	}
	if _, ok := s.LogPath("orphan"); !ok {
		t.Error("恢复出来的记录拿不到路径")
	}
}

// 索引里有、文件没了：条目应当被丢掉，避免点开一片空白。
func TestIndexWithoutLog(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	defer s.Close()
	s.Begin(Entry{ID: "gone", Created: 1})
	s.End("gone", 0)
	if err := os.Remove(filepath.Join(dir, "gone.log")); err != nil {
		t.Fatal(err)
	}
	again := New(dir)
	defer again.Close()
	if _, ok := again.Get("gone"); ok {
		t.Error("日志已删，记录不该还在")
	}
}

func TestLogPathRejectsTraversal(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()
	// 直接塞进索引，避免 Begin 真的在目录外面建文件。
	s.mu.Lock()
	s.idx["../evil"] = &Entry{ID: "../evil", Created: 1}
	s.idx["a/b"] = &Entry{ID: "a/b", Created: 1}
	s.mu.Unlock()

	if _, ok := s.LogPath("../evil"); ok {
		t.Error("带 .. 的 id 不该给出路径")
	}
	if _, ok := s.LogPath("a/b"); ok {
		t.Error("带路径分隔符的 id 不该给出路径")
	}
	if _, ok := s.LogPath("missing"); ok {
		t.Error("不存在的 id 不该给出路径")
	}
}

func TestNilStoreIsSafe(t *testing.T) {
	var s *Store
	s.Begin(Entry{ID: "x"})
	s.Append("x", []byte("y"))
	s.SetTitle("x", "t")
	s.End("x", 0)
	if s.Delete("x") {
		t.Error("nil store 不该删成功")
	}
	if s.Clear() != 0 {
		t.Error("nil store 清空计数应为 0")
	}
	if s.List() != nil {
		t.Error("nil store 列表应为空")
	}
	if s.Dir() != "" {
		t.Error("nil store 目录应为空")
	}
}
