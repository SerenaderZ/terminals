package files

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// ErrNotFound 表示没有这条连接。
var ErrNotFound = errors.New("没有这条连接")

// Conn 是一条远程 SFTP 连接。
//
// Password / Passphrase 是明文，只在内存和请求体里出现，落盘一律加密；
// 对外输出（List/Get 的 JSON）永远不带它们，前端只能看到 HasPassword。
type Conn struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	Auth    string `json:"auth"` // password | key
	KeyPath string `json:"keyPath"`
	Home    string `json:"home"`
	HostKey string `json:"hostKey"`

	Password   string `json:"-"`
	Passphrase string `json:"-"`

	// HasPassword 由 Store 填，告诉前端"这条连接的密码已经存过了"，
	// 编辑时留空即代表不修改。
	HasPassword bool `json:"hasPassword"`
}

// diskConn 是落盘格式。和 Conn 分开是为了让"加密字段"这件事只在一个地方
// 发生，不会出现某个接口不小心把明文密码写进 JSON 的情况。
type diskConn struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	Auth          string `json:"auth"`
	KeyPath       string `json:"keyPath"`
	Home          string `json:"home"`
	HostKey       string `json:"hostKey"`
	PasswordEnc   string `json:"passwordEnc,omitempty"`
	PassphraseEnc string `json:"passphraseEnc,omitempty"`
}

type diskFile struct {
	Version int        `json:"version"`
	Conns   []diskConn `json:"conns"`
}

// Store 是远程连接清单的存储。
//
// 和设置、布局一样放在服务端：换浏览器、用手机打开，连接列表都还在。
type Store struct {
	path string
	box  *secretBox

	mu    sync.Mutex
	conns []*Conn
}

// NewStore 打开（或初始化）连接清单。dir 是数据目录。
func NewStore(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("缺少数据目录，无法保存远程连接")
	}
	box, err := loadSecretBox(filepath.Join(dir, "sftp.key"))
	if err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "sftp.json"), box: box}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var f diskFile
	if err := json.Unmarshal(b, &f); err != nil {
		// 坏文件不覆盖：宁可这次看不到连接，也别把它抹掉。
		return fmt.Errorf("sftp.json 解析失败：%w", err)
	}
	for _, d := range f.Conns {
		c := &Conn{
			ID: d.ID, Name: d.Name, Host: d.Host, Port: d.Port, User: d.User,
			Auth: d.Auth, KeyPath: d.KeyPath, Home: d.Home, HostKey: d.HostKey,
		}
		if c.Port == 0 {
			c.Port = 22
		}
		if v, err := s.box.open(d.PasswordEnc); err == nil {
			c.Password = v
		}
		if v, err := s.box.open(d.PassphraseEnc); err == nil {
			c.Passphrase = v
		}
		c.HasPassword = c.Password != ""
		s.conns = append(s.conns, c)
	}
	return nil
}

func (s *Store) writeLocked() error {
	f := diskFile{Version: 1}
	for _, c := range s.conns {
		pw, err := s.box.seal(c.Password)
		if err != nil {
			return err
		}
		pp, err := s.box.seal(c.Passphrase)
		if err != nil {
			return err
		}
		f.Conns = append(f.Conns, diskConn{
			ID: c.ID, Name: c.Name, Host: c.Host, Port: c.Port, User: c.User,
			Auth: c.Auth, KeyPath: c.KeyPath, Home: c.Home, HostKey: c.HostKey,
			PasswordEnc: pw, PassphraseEnc: pp,
		})
	}
	b, err := json.MarshalIndent(f, "", "  ")
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

// List 返回全部连接（密码已脱敏）。
func (s *Store) List() []Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Conn, 0, len(s.conns))
	for _, c := range s.conns {
		out = append(out, *c)
	}
	return out
}

// Get 取一条连接。返回副本，改它不会影响存储。
func (s *Store) Get(id string) (Conn, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		if c.ID == id {
			return *c, true
		}
	}
	return Conn{}, false
}

// Save 新建或更新一条连接。
//
// password / passphrase 为 nil 表示"这次没改"，保持原值；指向空串表示
// "清掉"。前端编辑时不回填密码，所以不能拿空串当"要清空"。
func (s *Store) Save(in Conn, password, passphrase *string) (Conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateConn(in); err != nil {
		return Conn{}, err
	}

	var target *Conn
	for _, c := range s.conns {
		if c.ID == in.ID && in.ID != "" {
			target = c
			break
		}
	}
	if target == nil {
		in.ID = newID()
		target = &Conn{ID: in.ID}
		s.conns = append(s.conns, target)
	}

	// 换了主机/账号，之前记住的主机密钥就不作数了 —— 不然新机器会被
	// 当成"密钥变了"直接拒掉，用户完全不知道该怎么清。
	if target.Host != in.Host || target.Port != in.Port {
		target.HostKey = ""
		target.Home = ""
	}
	target.Name = strings.TrimSpace(in.Name)
	target.Host = strings.TrimSpace(in.Host)
	target.Port = in.Port
	target.User = strings.TrimSpace(in.User)
	target.Auth = in.Auth
	target.KeyPath = strings.TrimSpace(in.KeyPath)

	if password != nil {
		target.Password = *password
	}
	if passphrase != nil {
		target.Passphrase = *passphrase
	}
	if target.Auth != "key" {
		target.Passphrase = ""
	}
	if target.Auth != "password" {
		target.Password = ""
	}
	target.HasPassword = target.Password != ""

	if err := s.writeLocked(); err != nil {
		return Conn{}, err
	}
	return *target, nil
}

// Delete 删掉一条连接。
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.conns {
		if c.ID == id {
			s.conns = append(s.conns[:i], s.conns[i+1:]...)
			return s.writeLocked()
		}
	}
	return ErrNotFound
}

// SetHostKey 记住首次连接时看到的主机密钥指纹。
func (s *Store) SetHostKey(id, fp string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		if c.ID == id && c.HostKey == "" {
			c.HostKey = fp
			_ = s.writeLocked()
			return
		}
	}
}

// SetHome 记住远端 home，下次打开直接落在那里。
func (s *Store) SetHome(id, home string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		if c.ID == id && c.Home != home {
			c.Home = home
			_ = s.writeLocked()
			return
		}
	}
}

func validateConn(c Conn) error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("主机地址不能为空")
	}
	if strings.TrimSpace(c.User) == "" {
		return errors.New("用户名不能为空")
	}
	if c.Port <= 0 || c.Port > 65535 {
		return errors.New("端口必须在 1-65535 之间")
	}
	switch c.Auth {
	case "password", "key":
	default:
		return errors.New("认证方式只能是 password 或 key")
	}
	if c.Auth == "key" && strings.TrimSpace(c.KeyPath) == "" {
		return errors.New("使用密钥认证时必须填私钥路径")
	}
	return nil
}

func newID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "c" + strconv.FormatInt(int64(len(b)), 16)
	}
	return hex.EncodeToString(b)
}
