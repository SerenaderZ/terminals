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

	s.Begin(Entry{ID: "s01", Title: "git status", Cwd: "/home/eason", Shell: "/bin/bash", Created: 1000})
	s.Append("s01", []byte("hello\n"))
	s.Append("s01", []byte("world\n"))
	s.End("s01", 0)

	list := s.List()
	if len(list) != 1 {
		t.Fatalf("列表长度 = %d，期望 1", len(list))
	}
	e := list[0]
	if e.Title != "git status" {
		t.Errorf("标题 = %q，期望 git status", e.Title)
	}
	if e.Bytes != 12 {
		t.Errorf("字节数 = %d，期望 12", e.Bytes)
	}
	if e.Ended == 0 {
		t.Error("结束时间没记上")
	}
	if e.When() != e.Ended {
		t.Errorf("列表时间 = %d，期望等于结束时间 %d", e.When(), e.Ended)
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

// 点开一条老记录继续用：日志接在老内容后面，列表里仍然只有一行，
// 时间刷成"这一次关闭"的时间。
func TestResumeKeepsOneRow(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	defer s.Close()

	s.Begin(Entry{ID: "s01", Title: "npm run dev", Created: 1000})
	s.Append("s01", []byte("old output\n"))
	s.End("s01", 0)
	first, _ := s.Get("s01")

	start, ok := s.Resume("s01")
	if !ok {
		t.Fatal("已有的记录应当能继续")
	}
	if start != first.Bytes {
		t.Errorf("接续位置 = %d，期望等于原来的字节数 %d", start, first.Bytes)
	}
	mid, _ := s.Get("s01")
	if mid.Ended != 0 {
		t.Errorf("继续之后应当回到运行中，Ended = %d", mid.Ended)
	}
	if !mid.Live {
		t.Error("继续中的记录应当标成 live")
	}
	if mid.Bytes != first.Bytes {
		t.Errorf("继续时不该重复计数：%d → %d", first.Bytes, mid.Bytes)
	}

	s.Append("s01", []byte("new output\n"))
	s.End("s01", 0)

	list := s.List()
	if len(list) != 1 {
		t.Fatalf("继续老记录不该多出新行：列表 %d 条", len(list))
	}
	e := list[0]
	if e.Title != "npm run dev" {
		t.Errorf("标题被改掉了：%q", e.Title)
	}
	if e.Bytes != int64(len("old output\nnew output\n")) {
		t.Errorf("字节数 = %d，日志没有续在同一个文件里", e.Bytes)
	}
	if e.Ended < first.Ended {
		t.Errorf("结束时间该往前推：%d → %d", first.Ended, e.Ended)
	}
	b, err := os.ReadFile(filepath.Join(dir, "s01.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "old output\nnew output\n" {
		t.Errorf("日志内容 = %q", string(b))
	}
}

// 两个标签同时接着同一条记录写：谁先关都不该把文件关掉。
func TestResumeRefCount(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()

	s.Begin(Entry{ID: "s01", Title: "make"})
	s.End("s01", 0)

	if _, ok1 := s.Resume("s01"); !ok1 {
		t.Fatal("第一次继续该成功")
	}
	if _, ok2 := s.Resume("s01"); !ok2 {
		t.Fatal("第二次继续该成功")
	}
	s.End("s01", 0) // 第一个标签关掉
	if _, ok := s.Get("s01"); !ok {
		t.Fatal("记录不该消失")
	}
	s.Append("s01", []byte("still writing\n"))
	e, _ := s.Get("s01")
	if e.Bytes != int64(len("still writing\n")) {
		t.Errorf("还有一个使用者在写，日志不该被关：字节数 = %d", e.Bytes)
	}
}

func TestResumeUnknown(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()
	if _, ok := s.Resume("nope"); ok {
		t.Error("不存在的记录不该继续成功")
	}
	if _, ok := s.Resume(""); ok {
		t.Error("空 id 不该继续成功")
	}
	if _, ok := s.Resume("../evil"); ok {
		t.Error("非法 id 不该继续成功")
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

// 被重新打开过的老记录，应当凭"最后关闭时间"排到前面，而不是停在最初那天。
func TestResumeMovesToTop(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()

	s.Begin(Entry{ID: "old", Title: "claude", Created: 100})
	s.End("old", 0)
	s.Begin(Entry{ID: "new", Title: "htop", Created: 200})
	s.End("new", 0)

	// 把两条记录的结束时间往前错开。真实时间里"谁先关"分得清，但测试里
	// 两次 End 落在同一秒，得给个确定的先后。
	s.mu.Lock()
	s.idx["old"].Ended -= 20
	s.idx["old"].Touched = s.idx["old"].Ended
	s.idx["new"].Ended -= 10
	s.idx["new"].Touched = s.idx["new"].Ended
	s.mu.Unlock()

	if s.List()[0].ID != "new" {
		t.Fatal("初始顺序不对")
	}
	if _, ok := s.Resume("old"); !ok {
		t.Fatal("继续失败")
	}
	s.Append("old", []byte("x"))
	s.End("old", 0)

	if got := s.List()[0].ID; got != "old" {
		t.Errorf("继续过的记录应当排在最前，实际第一条是 %s", got)
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
	if e.When() == 0 {
		t.Error("恢复出来的记录没有时间，会在列表里排到最后")
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

// Begin 也走同一条校验：id 来自会话号，但历史入口是从 HTTP 进来的。
func TestBeginRejectsBadID(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	defer s.Close()
	s.Begin(Entry{ID: "../evil", Title: "x"})
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil.log")); !os.IsNotExist(err) {
		t.Error("非法 id 在目录外建出文件了")
	}
	if len(s.List()) != 0 {
		t.Error("非法 id 不该进索引")
	}
}

func TestNilStoreIsSafe(t *testing.T) {
	var s *Store
	s.Begin(Entry{ID: "x"})
	s.Append("x", []byte("y"))
	s.End("x", 0)
	if _, ok := s.Resume("x"); ok {
		t.Error("nil store 不该继续成功")
	}
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
