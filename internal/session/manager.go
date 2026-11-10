package session

import (
	"fmt"
	"sort"
	"sync"
)

// Manager 管理所有会话。
//
// 容量上限只拦新建，绝不为腾位置去杀用户正在用的会话 ——
// 这是刻意的：宁可让用户看到"已达上限"，也不能把他跑着的任务干掉。
type Manager struct {
	cfg   Config
	store *store

	mu sync.Mutex
	m  map[string]*Session
}

// NewManager 创建管理器。
//
// 建之前先解析降权账户并把 home 填进默认 cwd —— 会话一旦降权，
// 原来的 /root 就进不去了，必须换成目标账户自己的家目录。
func NewManager(cfg Config) *Manager {
	if cfg.MaxSessions <= 0 {
		cfg.MaxSessions = 32
	}
	if cfg.ReplayCap <= 0 {
		cfg.ReplayCap = DefaultReplayCap
	}
	if cfg.Cwd == "" {
		cfg.Cwd = cfg.RunAsHome
	}
	return &Manager{
		cfg:   cfg,
		store: newStore(cfg.StatePath),
		m:     make(map[string]*Session),
	}
}

// Config 返回当前配置。
func (m *Manager) Config() Config { return m.cfg }

// Create 新建一个会话。
//
// histID 非空表示"接着这条历史记录往下写"（用户点开了历史列表里的某一条）。
func (m *Manager) Create(histID string, cols, rows int) (*Session, error) {
	m.mu.Lock()
	if len(m.m) >= m.cfg.MaxSessions {
		n := m.cfg.MaxSessions
		m.mu.Unlock()
		return nil, fmt.Errorf("会话数已达上限（%d 个），请先关闭一个标签页再新建", n)
	}
	m.mu.Unlock()

	s, err := newSession(m.cfg, "", histID, cols, rows)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.m[s.ID] = s
	m.mu.Unlock()

	m.persist()
	return s, nil
}

// Restore 认领上次运行留下的 tmux 会话。
//
// 这是 tmux 后端唯一的实质收益：core 崩溃、被升级、被重启之后，
// 里面的 vim / npm run dev / Claude Code 还在跑，sid 也不变，
// 前端 localStorage 里那个 sid 一连就接回来了。
//
// 只认领 tmuxHasSession 为真的会话，其余的（已经自己退出的）直接丢弃。
func (m *Manager) Restore() int {
	if m.cfg.Backend != BackendTmux {
		return 0
	}
	n := 0
	for _, p := range m.store.load() {
		if p.SID == "" || !tmuxHasSession(p.SID) {
			continue
		}
		if len(m.m) >= m.cfg.MaxSessions {
			break
		}
		// 认领回来的 tmux 会话：日志接着上次那条写，时间也跟着刷新。
		s, err := newSession(m.cfg, p.SID, p.SID, 120, 32)
		if err != nil {
			continue
		}
		m.mu.Lock()
		m.m[p.SID] = s
		m.mu.Unlock()
		n++
	}
	m.persist()
	return n
}

// persist 把当前会话清单落盘。只在 tmux 后端下有意义。
func (m *Manager) persist() {
	if m.store == nil || m.cfg.Backend != BackendTmux {
		return
	}
	m.mu.Lock()
	list := make([]persistedSession, 0, len(m.m))
	for _, s := range m.m {
		list = append(list, persistedSession{
			SID:     s.ID,
			Cwd:     s.Cwd,
			Created: s.Created.Unix(),
			Tmux:    true,
		})
	}
	m.mu.Unlock()
	m.store.save(list)
}

// Get 按 sid 取会话。
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.m[id]
	return s, ok
}

// GetOrCreate 有 sid 且存活就复用，否则新建。刷新页面能续上就靠它。
func (m *Manager) GetOrCreate(id, histID string, cols, rows int) (*Session, error) {
	if id != "" {
		if s, ok := m.Get(id); ok && s.Alive() {
			return s, nil
		}
	}
	return m.Create(histID, cols, rows)
}

// Kill 结束并移除一个会话。
func (m *Manager) Kill(id string) bool {
	m.mu.Lock()
	s, ok := m.m[id]
	if ok {
		delete(m.m, id)
	}
	m.mu.Unlock()

	if ok {
		s.Kill()
		m.persist()
	}
	return ok
}

// CloseAll 结束所有会话，返回实际结束的个数。
//
// 给界面上的"结束全部"用：用户要的是"把我开的东西全停掉"，不是"关掉这个窗格"。
// 连 tmux 后端也一起杀（Kill 内部处理），不然升级后会话会从 sessions.json 复活。
func (m *Manager) CloseAll() int {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.m))
	for id, s := range m.m {
		delete(m.m, id)
		all = append(all, s)
	}
	m.mu.Unlock()

	for _, s := range all {
		s.Kill()
	}
	if len(all) > 0 {
		m.persist()
	}
	return len(all)
}

// CloseIdle 结束没有页面挂着的会话，返回实际结束的个数。
//
// 用于冷启动：新开一个页面时，上一轮留在服务端的 shell 已经没有入口了，
// 再留着就是看不见的进程。正在别的标签页/手机上用的会话有客户端挂着，
// 不会被误杀 —— 这也是不直接用 CloseAll 的原因。
func (m *Manager) CloseIdle() int {
	m.mu.Lock()
	idle := make([]*Session, 0)
	for id, s := range m.m {
		if s.ClientCount() == 0 {
			delete(m.m, id)
			idle = append(idle, s)
		}
	}
	m.mu.Unlock()

	for _, s := range idle {
		s.Kill()
	}
	if len(idle) > 0 {
		m.persist()
	}
	return len(idle)
}

// List 返回全部会话摘要，按创建时间排序。
func (m *Manager) List() []Info {
	m.mu.Lock()
	list := make([]Info, 0, len(m.m))
	for _, s := range m.m {
		list = append(list, s.Info())
	}
	m.mu.Unlock()

	sort.Slice(list, func(i, j int) bool { return list[i].Created < list[j].Created })
	return list
}

// Count 返回当前会话数。
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.m)
}

// Reap 清理已退出且没有客户端挂着的会话。
//
// 这里不按空闲时间杀会话：默认 0 = 永不回收，终端可以连开几天。
// 只有程序自己退出、且没有页面还挂着它，才会被清掉。
func (m *Manager) Reap() {
	m.mu.Lock()
	dead := make([]*Session, 0)
	for id, s := range m.m {
		if !s.Alive() && s.ClientCount() == 0 {
			delete(m.m, id)
			dead = append(dead, s)
		}
	}
	m.mu.Unlock()

	for _, s := range dead {
		s.Kill()
	}
	if len(dead) > 0 {
		m.persist()
	}
}
