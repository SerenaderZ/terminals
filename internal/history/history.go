// Package history 把每个终端会话的输出留一份到磁盘。
//
// 为什么不是"命令历史"：用户要的是"上次那一段对话还能翻回来"，包括
// 程序的输出、报错、Claude Code 的回复。命令历史只记得你敲了什么，
// 记不住你看到了什么。
//
// 存储分两半：
//
//	index.json   元信息（标题、目录、起止时间、字节数），列表页只读它
//	<id>.log     原始字节流，和 PTY 吐出来的一模一样
//
// 日志一律只追加、不裁剪。用户明确要求"全部保留"，所以这里没有上限、
// 没有轮转 —— 要清理只有两个入口：删单条、清空全部。
package history

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// maxTitleLen 限制标题长度。终端标题是程序随手设的，可能带整条命令行。
const maxTitleLen = 160

// Entry 是一条历史记录。
type Entry struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Cwd     string `json:"cwd"`
	Shell   string `json:"shell"`
	Created int64  `json:"created"`
	// Ended 为 0 表示会话还在跑（或者 core 上次退出时没来得及收尾）。
	Ended int64 `json:"ended"`
	Bytes int64 `json:"bytes"`
	Exit  int   `json:"exit"`
	Live  bool  `json:"live,omitempty"`
}

// Store 是历史记录仓库。零值不可用，走 New。
type Store struct {
	dir   string
	index string

	mu    sync.Mutex
	idx   map[string]*Entry
	files map[string]*os.File
}

// New 打开（或新建）一个历史目录。
//
// 目录里只有 .log 和 index.json，删目录等于清空历史，卸载应用时不用额外清理。
func New(dir string) *Store {
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("历史目录 %s 建不出来：%v；这次运行不记录历史", dir, err)
		return nil
	}
	s := &Store{
		dir:   dir,
		index: filepath.Join(dir, "index.json"),
		idx:   make(map[string]*Entry),
		files: make(map[string]*os.File),
	}
	s.load()
	return s
}

// Dir 返回历史目录，排障时打日志用。
func (s *Store) Dir() string {
	if s == nil {
		return ""
	}
	return s.dir
}

// load 读索引，并用磁盘上的实际情况校正一遍。
//
// 校正很有必要：index.json 只在会话开始/结束时落盘，中间进程被强杀
// （升级、OOM、断电）就会停在"还在跑、0 字节"的状态；反过来，索引丢了
// 但 .log 还在时，也应该能从文件名把记录捞回来 —— 日志才是唯一的事实。
func (s *Store) load() {
	if b, err := os.ReadFile(s.index); err == nil {
		var list []Entry
		if json.Unmarshal(b, &list) == nil {
			for i := range list {
				e := list[i]
				if e.ID == "" {
					continue
				}
				s.idx[e.ID] = &e
			}
		}
	}

	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	seen := make(map[string]bool, len(ents))
	for _, de := range ents {
		name := de.Name()
		if de.IsDir() || !strings.HasSuffix(name, ".log") {
			continue
		}
		id := strings.TrimSuffix(name, ".log")
		if id == "" {
			continue
		}
		seen[id] = true
		st, err := os.Stat(filepath.Join(s.dir, name))
		if err != nil {
			continue
		}
		if e, ok := s.idx[id]; ok {
			e.Bytes = st.Size()
			if e.Created == 0 {
				e.Created = st.ModTime().Unix()
			}
		} else {
			// 索引里没有：日志还在，说明这条记录是从更早的版本或一次
			// 崩溃里活下来的。按文件时间补一条，内容照样能打开。
			s.idx[id] = &Entry{
				ID:      id,
				Created: st.ModTime().Unix(),
				Ended:   st.ModTime().Unix(),
				Bytes:   st.Size(),
			}
		}
	}
	// 索引里有、磁盘上没有：日志被手工删了，条目留着只会点开一片空白。
	for id := range s.idx {
		if !seen[id] {
			delete(s.idx, id)
		}
	}

	s.mu.Lock()
	s.saveLocked()
	s.mu.Unlock()
}

// saveLocked 原子写索引。调用方必须持有 s.mu。
func (s *Store) saveLocked() {
	list := make([]Entry, 0, len(s.idx))
	for _, e := range s.idx {
		list = append(list, *e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Created > list[j].Created })

	b, err := json.Marshal(list)
	if err != nil {
		return
	}
	tmp := s.index + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("历史索引写入失败：%v", err)
		return
	}
	if err := os.Rename(tmp, s.index); err != nil {
		_ = os.Remove(tmp)
		log.Printf("历史索引替换失败：%v", err)
	}
}

// Begin 为一次新会话开一条记录。
//
// 打不开日志文件不算致命：终端照常用，只是这一条不进历史。
func (s *Store) Begin(e Entry) {
	if s == nil || e.ID == "" {
		return
	}
	if e.Created == 0 {
		e.Created = time.Now().Unix()
	}
	f, err := os.OpenFile(filepath.Join(s.dir, e.ID+".log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		log.Printf("历史日志 %s 打不开：%v", e.ID, err)
		return
	}
	s.mu.Lock()
	s.files[e.ID] = f
	s.idx[e.ID] = &e
	s.saveLocked()
	s.mu.Unlock()
}

// Append 把一块 PTY 输出追加到日志。
//
// 每个输出块都会走这里，所以只做一件事：写。字节数在内存里累加，
// 索引等会话结束再落盘 —— 每 32KB 重写一遍 JSON 纯属浪费。
func (s *Store) Append(id string, p []byte) {
	if s == nil || len(p) == 0 {
		return
	}
	s.mu.Lock()
	f := s.files[id]
	if f == nil {
		s.mu.Unlock()
		return
	}
	n, err := f.Write(p)
	if err == nil {
		if e := s.idx[id]; e != nil {
			e.Bytes += int64(n)
		}
	}
	s.mu.Unlock()
}

// SetTitle 记下终端标题（OSC 0 / OSC 2）。
//
// 只在真的变了的时候落盘：Claude Code 之类的程序会频繁重设标题，
// 每次重写一遍索引文件没必要。
func (s *Store) SetTitle(id, title string) {
	if s == nil || id == "" || title == "" {
		return
	}
	title = cleanTitle(title)
	s.mu.Lock()
	if e := s.idx[id]; e != nil && e.Title != title {
		e.Title = title
		s.saveLocked()
	}
	s.mu.Unlock()
}

// End 收尾：关文件、记结束时间与退出码。
func (s *Store) End(id string, exit int) {
	if s == nil || id == "" {
		return
	}
	s.mu.Lock()
	if f := s.files[id]; f != nil {
		_ = f.Close()
		delete(s.files, id)
	}
	if e := s.idx[id]; e != nil {
		e.Ended = time.Now().Unix()
		e.Exit = exit
		if st, err := os.Stat(filepath.Join(s.dir, id+".log")); err == nil {
			e.Bytes = st.Size()
		}
	}
	s.saveLocked()
	s.mu.Unlock()
}

// List 返回全部记录，最新的在前。
func (s *Store) List() []Entry {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	list := make([]Entry, 0, len(s.idx))
	for _, e := range s.idx {
		c := *e
		c.Live = s.files[c.ID] != nil
		list = append(list, c)
	}
	s.mu.Unlock()

	sort.Slice(list, func(i, j int) bool { return list[i].Created > list[j].Created })
	return list
}

// Get 取一条记录。
func (s *Store) Get(id string) (Entry, bool) {
	if s == nil {
		return Entry{}, false
	}
	s.mu.Lock()
	e, ok := s.idx[id]
	var c Entry
	if ok {
		c = *e
		c.Live = s.files[c.ID] != nil
	}
	s.mu.Unlock()
	return c, ok
}

// LogPath 返回日志文件路径。第二条返回值表示记录不存在。
func (s *Store) LogPath(id string) (string, bool) {
	if s == nil || id == "" {
		return "", false
	}
	if _, ok := s.Get(id); !ok {
		return "", false
	}
	// id 来自会话号（s + 十六进制），但入口是 HTTP，仍然按文件名规则挡一道。
	if strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return "", false
	}
	return filepath.Join(s.dir, id+".log"), true
}

// Delete 删掉一条（日志 + 索引）。
func (s *Store) Delete(id string) bool {
	if s == nil || id == "" {
		return false
	}
	s.mu.Lock()
	_, ok := s.idx[id]
	if f := s.files[id]; f != nil {
		_ = f.Close()
		delete(s.files, id)
	}
	delete(s.idx, id)
	if ok {
		_ = os.Remove(filepath.Join(s.dir, id+".log"))
		s.saveLocked()
	}
	s.mu.Unlock()
	return ok
}

// Clear 清空全部历史。
func (s *Store) Clear() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	n := len(s.idx)
	for id, f := range s.files {
		_ = f.Close()
		delete(s.files, id)
	}
	for id := range s.idx {
		_ = os.Remove(filepath.Join(s.dir, id+".log"))
	}
	s.idx = make(map[string]*Entry)
	s.saveLocked()
	s.mu.Unlock()
	return n
}

// Close 关掉所有打开中的日志文件。
//
// 平时不用管（进程退出时会自动关），但测试和"热重启"需要它：
// Windows 上文件被占用就等于删不掉，会一直报错。
func (s *Store) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	for id, f := range s.files {
		_ = f.Close()
		delete(s.files, id)
	}
	s.mu.Unlock()
}

// cleanTitle 把标题收拾成一行能显示的文本。
func cleanTitle(t string) string {
	t = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, t)
	t = strings.TrimSpace(t)
	if len(t) > maxTitleLen {
		t = t[:maxTitleLen]
	}
	return t
}
