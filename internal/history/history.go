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
	// Touched 是最近一次活动的时间：开始、继续、有输出、结束都会刷新。
	//
	// 列表显示和排序用的都是它（见 When）。用户的原话是"以我最后关闭
	// 那个窗口的时间为准" —— 一条记录被重新打开过、又关掉了，它就该带着
	// 新的时间回到列表最前面，而不是停在第一次建立的那天。
	Touched int64 `json:"touched"`
	Bytes   int64 `json:"bytes"`
	Exit  int   `json:"exit"`
	Live    bool  `json:"live,omitempty"`
}

// newerFirst 是列表的排序规则：先比"最后活动时间"，同一秒内再看创建时间。
//
// 只比活动时间的话，同一秒里建起来的几条会随机排队 —— 排序不稳定，用户
// 每刷新一次看到的顺序都不一样。
func newerFirst(a, b *Entry) bool {
	if wa, wb := a.When(), b.When(); wa != wb {
		return wa > wb
	}
	return a.Created > b.Created
}

// When 返回列表该显示、该排序用的时间。
//
// 关闭过就用关闭时间，还在跑就用最后一次活动时间。老索引里没有 Touched
// 字段，退回到 Created，保证升级后老记录不会跳到 1970 年。
func (e Entry) When() int64 {
	if e.Ended > 0 {
		return e.Ended
	}
	if e.Touched > 0 {
		return e.Touched
	}
	return e.Created
}

// Store 是历史记录仓库。零值不可用，走 New。
type Store struct {
	dir   string
	index string

	mu    sync.Mutex
	idx   map[string]*Entry
	files map[string]*os.File
	// refs 记每个日志文件被几个会话共用。
	//
	// "继续一条老记录"之后，两个标签可能同时往同一个日志里写：谁先关都
	// 不该把文件关掉，另一个还在写。引用归零才真正关闭。
	refs map[string]int
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
		refs:  make(map[string]int),
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
			// 0.3.1 之前的索引没有 Touched，补一个，免得列表按 0 排序。
			if e.Touched == 0 {
				e.Touched = e.When()
			}
		} else {
			// 索引里没有：日志还在，说明这条记录是从更早的版本或一次
			// 崩溃里活下来的。按文件时间补一条，内容照样能打开。
			s.idx[id] = &Entry{
				ID:      id,
				Created: st.ModTime().Unix(),
				Ended:   st.ModTime().Unix(),
				Touched: st.ModTime().Unix(),
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
	sort.Slice(list, func(i, j int) bool { return newerFirst(&list[i], &list[j]) })

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
// 什么时候调用很关键：现在不是"会话一建立就开"，而是"用户敲下第一条
// 命令才开"。只是点开一个标签、看了一眼提示符就关掉的窗口不该留下记录 ——
// 用户的原话是"我根本就没做什么"。
//
// 打不开日志文件不算致命：终端照常用，只是这一条不进历史。
func (s *Store) Begin(e Entry) {
	if s == nil || !validID(e.ID) {
		return
	}
	now := time.Now().Unix()
	if e.Created == 0 {
		e.Created = now
	}
	e.Touched = now
	e.Ended = 0
	f, err := os.OpenFile(filepath.Join(s.dir, e.ID+".log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		log.Printf("历史日志 %s 打不开：%v", e.ID, err)
		return
	}
	s.mu.Lock()
	if old := s.files[e.ID]; old != nil {
		_ = old.Close()
	}
	s.files[e.ID] = f
	s.refs[e.ID] = 1
	s.idx[e.ID] = &e
	s.saveLocked()
	s.mu.Unlock()
}

// Resume 接着往一条已有记录里写。
//
// 这是"点开一条历史，后续输入还留在这一条里"的落点：新会话沿用老记录的
// id 写日志，列表里始终只有这一行（像浏览器历史里同一个页面被访问多次）。
// 返回 false 表示没有这条记录（老记录被删了、id 是编的），调用方应当退回
// "新开一条"。
// 返回的 start 是"这次接手时日志已经写到哪"。前端只回放 [0,start) 这一段：
// 新 shell 的启动输出（含清屏序列）已经追加在后面了，整段灌回去会把刚铺好
// 的历史擦掉 —— 用户看到的就是"点开历史只剩一个空提示符"。
func (s *Store) Resume(id string) (int64, bool) {
	if s == nil || !validID(id) {
		return 0, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.idx[id]
	if !ok {
		return 0, false
	}
	var start int64
	if f := s.files[id]; f != nil {
		s.refs[id]++
		start = e.Bytes
	} else {
		f, err := os.OpenFile(filepath.Join(s.dir, id+".log"),
			os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			log.Printf("历史日志 %s 打不开：%v", id, err)
			return 0, false
		}
		s.files[id] = f
		s.refs[id] = 1
		if st, err := f.Stat(); err == nil {
			e.Bytes = st.Size()
			start = st.Size()
		}
	}
	// 又被打开了：从"已结束"回到"运行中"，时间跟着刷新。
	e.Ended = 0
	e.Touched = time.Now().Unix()
	s.saveLocked()
	return start, true
}

// Append 把一块 PTY 输出追加到日志。
//
// 每个输出块都会走这里，所以只做两件事：写、刷新活动时间。字节数在内存里
// 累加，索引等会话结束再落盘 —— 每 32KB 重写一遍 JSON 纯属浪费。
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
			e.Touched = time.Now().Unix()
		}
	}
	s.mu.Unlock()
}

// End 收尾：记结束时间与退出码，最后一个使用者退出时才关文件。
func (s *Store) End(id string, exit int) {
	if s == nil || id == "" {
		return
	}
	s.mu.Lock()
	if n := s.refs[id]; n > 1 {
		// 还有别的标签在往同一条记录里写，别关。
		s.refs[id] = n - 1
	} else {
		if f := s.files[id]; f != nil {
			_ = f.Close()
			delete(s.files, id)
		}
		delete(s.refs, id)
	}
	if e := s.idx[id]; e != nil {
		now := time.Now().Unix()
		e.Touched = now
		if s.refs[id] == 0 {
			e.Ended = now
			e.Exit = exit
			if st, err := os.Stat(filepath.Join(s.dir, id+".log")); err == nil {
				e.Bytes = st.Size()
			}
		}
		s.saveLocked()
	}
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

	sort.Slice(list, func(i, j int) bool { return newerFirst(&list[i], &list[j]) })
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
	if !validID(id) {
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
	delete(s.refs, id)
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
	s.refs = make(map[string]int)
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
	s.refs = make(map[string]int)
	s.mu.Unlock()
}

// CleanTitle 把一段文本收拾成一行能当标题显示的样子。
//
// 现在的标题来自用户敲的第一条命令，所以这里做的是命令行该有的收敛：
// 去掉控制字符、压掉连续空白、按长度截断。历史入口和会话命名都用它。
func CleanTitle(t string) string {
	t = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, t)
	t = strings.Join(strings.Fields(t), " ")
	if len(t) > maxTitleLen {
		t = t[:maxTitleLen]
	}
	return t
}

// validID 挡住拼接路径的 id。
//
// 会话号是 s + 10 位十六进制，历史入口的 id 直接来自 URL，所以宁可严格：
// 只允许字母数字，长度也有上限。
func validID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return true
}
