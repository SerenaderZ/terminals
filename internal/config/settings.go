// Package config 保存用户可见的设置项。
//
// 和布局一样存在服务端而不是 localStorage：换个浏览器、用手机打开，
// 看到的应该是同一份设置。localStorage 只做一层缓存，避免刷新时闪一下
// 默认主题再跳变。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// maxSettingsBytes 是设置文件的大小上限。正常不到 1KB，给 64KB 足够。
const maxSettingsBytes = 64 << 10

// Settings 是全部可配置项。字段顺序即设置页从上到下的顺序。
type Settings struct {
	// Theme 取值 dark / light。
	Theme string `json:"theme"`
	// FontSize 是终端字号，范围 10..24。
	FontSize int `json:"fontSize"`
	// WebGL 表示是否用显卡渲染（关掉走 canvas，慢一点但兼容性最好）。
	WebGL bool `json:"webgl"`
	// CursorBlink 光标是否闪烁。
	CursorBlink bool `json:"cursorBlink"`
	// Scrollback 是每个窗格保留的回看行数，范围 1000..50000。
	Scrollback int `json:"scrollback"`

	// FilesOpen 表示左侧文件侧栏是否展开。
	//
	// 这个状态存在服务端而不是 localStorage：和布局、主题一样，换个浏览器
	// 打开应该还是同一副样子。默认 false —— 首次安装打开页面时它是收起的，
	// 不占地方；用户自己打开一次，之后就一直保持那个状态。
	FilesOpen bool `json:"filesOpen"`
	// FilesConn 是侧栏上次用的来源："local" 或某条远程连接 id。
	FilesConn string `json:"filesConn"`
	// FilesWidth 是侧栏宽度（像素）。
	FilesWidth int `json:"filesWidth"`
	// FilesTreeH 是侧栏里目录树占的高度（百分比），剩下的是文件列表。
	FilesTreeH int `json:"filesTreeH"`
}

// 取值范围。设置页的输入框和这里的校验用同一套边界。
const (
	FontSizeMin     = 10
	FontSizeMax     = 24
	ScrollbackMin   = 1000
	ScrollbackMax   = 50000
	ThemeDark       = "dark"
	ThemeLight      = "light"
	DefaultFontSize = 14
	// DefaultScrollback 和 xterm 的默认值对齐（10000 行，约 4MB 内存/窗格）。
	DefaultScrollback = 10000
	// 侧栏宽度的取值范围。上限放到 1200：4K 屏上 300px 的栏太窄，
	// 但再宽就不叫侧栏了，那是把窗口分了一半出去。
	FilesWidthMin = 200
	FilesWidthMax = 1200
	// 目录树占比，剩下的是文件列表。
	FilesTreeMin = 15
	FilesTreeMax = 85
)

// Default 返回一份默认设置。
func Default() Settings {
	return Settings{
		Theme:          ThemeDark,
		FontSize:       DefaultFontSize,
		WebGL:          true,
		CursorBlink:    true,
		Scrollback:     DefaultScrollback,
		FilesOpen:      false,
		FilesConn:      "local",
		FilesWidth:     300,
		FilesTreeH:     40,
	}
}

// Normalize 把越界或空值拉回合法范围，而不是报错。
//
// 设置是给人用的，某个字段写坏不该让整个设置页打不开 ——
// 读的时候修正、下一次保存时自然就写回去了。
func (s Settings) Normalize() Settings {
	d := Default()
	if s.Theme != ThemeDark && s.Theme != ThemeLight {
		s.Theme = d.Theme
	}
	if s.FontSize < FontSizeMin || s.FontSize > FontSizeMax {
		s.FontSize = d.FontSize
	}
	if s.Scrollback < ScrollbackMin || s.Scrollback > ScrollbackMax {
		s.Scrollback = d.Scrollback
	}
	if s.FilesWidth < FilesWidthMin || s.FilesWidth > FilesWidthMax {
		s.FilesWidth = d.FilesWidth
	}
	if s.FilesTreeH < FilesTreeMin || s.FilesTreeH > FilesTreeMax {
		s.FilesTreeH = d.FilesTreeH
	}
	if s.FilesConn == "" {
		s.FilesConn = d.FilesConn
	}
	return s
}

// patch 把一份"只带部分字段"的 JSON 合并进来。
//
// 用 map[string]json.RawMessage 而不是直接反序列化到结构体：结构体反序列化
// 会把没出现的字段置零 —— 前端只改一个开关，结果字号和主题被清空。
// 未知字段直接忽略，这样前端升级、后端没跟上也不会 400。
func (s Settings) patch(raw map[string]json.RawMessage) (Settings, error) {
	out := s
	for k, v := range raw {
		var err error
		switch k {
		case "theme":
			err = json.Unmarshal(v, &out.Theme)
		case "fontSize":
			err = json.Unmarshal(v, &out.FontSize)
		case "webgl":
			err = json.Unmarshal(v, &out.WebGL)
		case "cursorBlink":
			err = json.Unmarshal(v, &out.CursorBlink)
		case "scrollback":
			err = json.Unmarshal(v, &out.Scrollback)
		case "filesOpen":
			err = json.Unmarshal(v, &out.FilesOpen)
		case "filesConn":
			err = json.Unmarshal(v, &out.FilesConn)
		case "filesWidth":
			err = json.Unmarshal(v, &out.FilesWidth)
		case "filesTreeH":
			err = json.Unmarshal(v, &out.FilesTreeH)
		default:
			continue // 未知字段不报错
		}
		if err != nil {
			return s, fmt.Errorf("字段 %s 格式不对：%w", k, err)
		}
	}
	if out.Theme != ThemeDark && out.Theme != ThemeLight {
		return s, fmt.Errorf("theme 只能是 dark 或 light")
	}
	if out.FontSize < FontSizeMin || out.FontSize > FontSizeMax {
		return s, fmt.Errorf("fontSize 必须在 %d..%d 之间", FontSizeMin, FontSizeMax)
	}
	if out.Scrollback < ScrollbackMin || out.Scrollback > ScrollbackMax {
		return s, fmt.Errorf("scrollback 必须在 %d..%d 之间", ScrollbackMin, ScrollbackMax)
	}
	if out.FilesWidth < FilesWidthMin || out.FilesWidth > FilesWidthMax {
		return s, fmt.Errorf("filesWidth 必须在 %d..%d 之间", FilesWidthMin, FilesWidthMax)
	}
	if out.FilesTreeH < FilesTreeMin || out.FilesTreeH > FilesTreeMax {
		return s, fmt.Errorf("filesTreeH 必须在 %d..%d 之间", FilesTreeMin, FilesTreeMax)
	}
	if len(out.FilesConn) > 64 {
		return s, fmt.Errorf("filesConn 太长")
	}
	if out.FilesConn == "" {
		out.FilesConn = Default().FilesConn
	}
	return out, nil
}

// Store 是设置文件的读写封装。所有方法都是并发安全的。
type Store struct {
	path string
	mu   sync.RWMutex
	cur  Settings
}

// NewStore 创建存储并读一次盘。path 为空表示不落盘（只在内存里）。
//
// 文件损坏时用默认值启动并保留原文件不覆盖 —— 宁可设置丢一次，
// 也不要让一个坏字节把用户的文件名写没了。
func NewStore(path string) *Store {
	s := &Store{path: path, cur: Default()}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	if len(b) == 0 || len(b) > maxSettingsBytes {
		return s
	}
	// 先铺默认值再反序列化：新增字段（比如后来的 copyOnSelect）在旧文件里
	// 根本不存在，直接反序列化到零值会让升级后的用户被"默认关闭"，
	// 而他要的只是保持原来的行为。出现的字段仍然覆盖默认值，包括显式的 false。
	got := Default()
	if err := json.Unmarshal(b, &got); err != nil {
		return s
	}
	s.cur = got.Normalize()
	return s
}

// Get 返回当前设置的一份副本。
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Update 合并补丁、校验、落盘，返回合并后的完整设置。
func (s *Store) Update(raw map[string]json.RawMessage) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	next, err := s.cur.patch(raw)
	if err != nil {
		return s.cur, err
	}
	if err := s.writeLocked(next); err != nil {
		return s.cur, err
	}
	s.cur = next
	return next, nil
}

// writeLocked 原子写：先写 .tmp 再 rename。
// 设置页保存得很快，但断电/崩溃时半个 JSON 会让下次启动退回默认值。
func (s *Store) writeLocked(v Settings) error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
