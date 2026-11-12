package files

import (
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Remote 是一条远程 SFTP 连接上的文件视图。
type Remote struct {
	conn Conn
	pool *Pool
}

// NewRemote 创建远程视图。
func NewRemote(c Conn, p *Pool) *Remote { return &Remote{conn: c, pool: p} }

// ConnID 返回连接 id。HTTP 层拿它做日志和错位排查。
func (r *Remote) ConnID() string { return r.conn.ID }

// Home 返回远端 home。还没探测到时先给 "/"，前端拿到真实值后会再跳一次。
func (r *Remote) Home() string {
	if r.conn.Home != "" {
		return r.conn.Home
	}
	return "/"
}

// Clean 规范化远端路径。
//
// 远端一律用 POSIX 语义，不能借道 filepath —— 那在 Windows 上开发时会把
// 反斜杠当成路径分隔符，测出来的行为和服务端完全不一样。
func (r *Remote) Clean(p string) string {
	p = strings.TrimSpace(p)
	home := r.Home()
	if p == "" || p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return path.Join(home, p[2:])
	}
	if !strings.HasPrefix(p, "/") {
		return path.Join(home, p)
	}
	return path.Clean(p)
}

// List 列远端目录。
func (r *Remote) List(p string) (Listing, error) {
	dir := r.Clean(p)
	out := Listing{Path: dir, Parent: remoteParent(dir)}
	var items []Entry

	err := r.read(func(c *sftp.Client) error {
		items = items[:0]
		out.Truncated = false
		fis, err := c.ReadDir(dir)
		if err != nil {
			return err
		}
		for i, fi := range fis {
			if i >= MaxEntries {
				out.Truncated = true
				break
			}
			e := Entry{
				Name:  fi.Name(),
				Path:  path.Join(dir, fi.Name()),
				Size:  fi.Size(),
				Mode:  fi.Mode().Perm().String(),
				MTime: fi.ModTime().Unix(),
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				e.Link = true
				if st, err := c.Stat(e.Path); err == nil {
					e.Dir = st.IsDir()
					e.Size = st.Size()
				} else {
					e.Err = "链接目标不可用"
				}
			} else {
				e.Dir = fi.IsDir()
			}
			if e.Dir {
				e.Size = 0
			}
			items = append(items, e)
		}
		return nil
	})
	if err != nil {
		return Listing{}, err
	}
	out.Items = items
	trimListing(&out)
	return out, nil
}

// Open 打开远端文件用于下载。
func (r *Remote) Open(p string) (io.ReadCloser, int64, error) {
	file := r.Clean(p)
	var (
		f    *sftp.File
		size int64 = -1
	)
	err := r.read(func(c *sftp.Client) error {
		st, err := c.Stat(file)
		if err != nil {
			return err
		}
		if st.IsDir() {
			return ErrNotDir
		}
		size = st.Size()
		f, err = c.Open(file)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return f, size, nil
}

// Create 覆盖写入远端文件。上传大文件时这条链路是流式的，不会整个读进内存。
func (r *Remote) Create(p string, rd io.Reader) (int64, error) {
	file := r.Clean(p)
	var n int64
	err := r.write(func(c *sftp.Client) error {
		f, err := c.Create(file)
		if err != nil {
			return err
		}
		n, err = io.Copy(f, rd)
		if err != nil {
			f.Close()
			return err
		}
		return f.Close()
	})
	return n, err
}

// Mkdir 建远端目录。
func (r *Remote) Mkdir(p string) error {
	dir := r.Clean(p)
	return r.write(func(c *sftp.Client) error { return c.Mkdir(dir) })
}

// Remove 删除远端文件或空目录。
func (r *Remote) Remove(p string) error {
	target := r.Clean(p)
	if target == "/" {
		return errProtected
	}
	return r.write(func(c *sftp.Client) error {
		if err := c.Remove(target); err != nil {
			if isNotEmpty(err) {
				return ErrNotEmpty
			}
			return err
		}
		return nil
	})
}

// RemoveAll 递归删除远端目录。
func (r *Remote) RemoveAll(p string) error {
	target := r.Clean(p)
	if target == "/" {
		return errProtected
	}
	return r.write(func(c *sftp.Client) error { return c.RemoveAll(target) })
}

// Rename 改名或移动。
func (r *Remote) Rename(from, to string) error {
	a, b := r.Clean(from), r.Clean(to)
	if a == "/" {
		return errProtected
	}
	return r.write(func(c *sftp.Client) error { return c.Rename(a, b) })
}

// read 执行一个只读操作，连接断了就重连一次。
//
// 只对读操作重试：写操作重试可能把半个文件重复写进去，或者把一个已经
// 成功的 mkdir 当成失败再报一次。
func (r *Remote) read(fn func(*sftp.Client) error) error {
	c, err := r.pool.Client(r.conn)
	if err != nil {
		return err
	}
	first := fn(c)
	if first == nil {
		return nil
	}
	r.pool.Drop(r.conn.ID)
	c2, err := r.pool.Client(r.conn)
	if err != nil {
		return first
	}
	return fn(c2)
}

// write 执行一个写操作。失败时丢掉连接，让下一次请求重新握手。
func (r *Remote) write(fn func(*sftp.Client) error) error {
	c, err := r.pool.Client(r.conn)
	if err != nil {
		return err
	}
	err = fn(c)
	if err != nil {
		r.pool.Drop(r.conn.ID)
	}
	return err
}

func remoteParent(p string) string {
	parent := path.Dir(p)
	if parent == p {
		return ""
	}
	return parent
}

// ---------------------------------------------------------------- 连接池

// Pool 缓存已建立的 SSH/SFTP 连接。
//
// 为什么要池：一次 SFTP 操作要经过 TCP + SSH 握手 + 密钥交换，几百毫秒
// 起步。用户点开一个目录就要列一次，每次重连根本没法用。
type Pool struct {
	// OnHostKey / OnHome 在首次连接成功后回调，由 Store 落盘。
	OnHostKey func(id, fingerprint string)
	OnHome    func(id, home string)

	mu sync.Mutex
	m  map[string]*pooled
}

type pooled struct {
	ssh  *ssh.Client
	sftp *sftp.Client
	fp   string
}

// NewPool 创建连接池。
func NewPool() *Pool { return &Pool{m: make(map[string]*pooled)} }

// Client 取得（必要时建立）一条连接。
func (p *Pool) Client(c Conn) (*sftp.Client, error) {
	p.mu.Lock()
	if e, ok := p.m[c.ID]; ok {
		p.mu.Unlock()
		return e.sftp, nil
	}
	p.mu.Unlock()

	// 网络 IO 不放在锁里：一次连接最长 12 秒，拿着锁会让整个面板卡死。
	e, err := dialRemote(c)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	if old, ok := p.m[c.ID]; ok {
		// 另一个请求已经先连上了，用它的，把这条多余的关掉。
		p.mu.Unlock()
		_ = e.sftp.Close()
		_ = e.ssh.Close()
		return old.sftp, nil
	}
	p.m[c.ID] = e
	p.mu.Unlock()

	if c.HostKey == "" && p.OnHostKey != nil && e.fp != "" {
		p.OnHostKey(c.ID, e.fp)
	}
	if c.Home == "" && p.OnHome != nil {
		if wd, err := e.sftp.Getwd(); err == nil && wd != "" {
			p.OnHome(c.ID, wd)
		}
	}
	return e.sftp, nil
}

// Home 返回远端 home；没探测过就连一次问出来。
func (p *Pool) Home(c Conn) (string, error) {
	sc, err := p.Client(c)
	if err != nil {
		return "", err
	}
	if c.Home != "" {
		return c.Home, nil
	}
	return sc.Getwd()
}

// Drop 关掉并移除一条连接。
func (p *Pool) Drop(id string) {
	p.mu.Lock()
	e := p.m[id]
	delete(p.m, id)
	p.mu.Unlock()
	if e != nil {
		_ = e.sftp.Close()
		_ = e.ssh.Close()
	}
}

// Close 关掉全部连接，进程退出时用。
func (p *Pool) Close() {
	p.mu.Lock()
	all := p.m
	p.m = make(map[string]*pooled)
	p.mu.Unlock()
	for _, e := range all {
		_ = e.sftp.Close()
		_ = e.ssh.Close()
	}
}

func dialRemote(c Conn) (*pooled, error) {
	var auths []ssh.AuthMethod
	switch c.Auth {
	case "key":
		key, err := os.ReadFile(c.KeyPath)
		if err != nil {
			return nil, fmt.Errorf("读不到私钥 %s：%w", c.KeyPath, err)
		}
		var signer ssh.Signer
		if c.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(c.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(key)
		}
		if err != nil {
			return nil, fmt.Errorf("私钥解析失败（可能设了口令，或者格式不被支持）：%w", err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	default:
		if c.Password == "" {
			return nil, fmt.Errorf("这条连接没有保存密码，请回到连接设置里重新填写")
		}
		auths = append(auths, ssh.Password(c.Password))
	}

	var fp string
	hostKey := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp = ssh.FingerprintSHA256(key)
		// 首次连接没有记录，直接接受并记下来（和第一次 SSH 时回答 yes 一样）。
		// 之后每次都比对：换了机器、或者有人在中间，指纹一定对不上。
		if c.HostKey != "" && fp != c.HostKey {
			return fmt.Errorf("主机密钥和上次记录的不一致（现在是 %s）。"+
				"要么这台机器重装过，要么有人在中间劫持；确认无误后删除这条连接重新添加", fp)
		}
		return nil
	}

	cfg := &ssh.ClientConfig{
		User:            c.User,
		Auth:            auths,
		HostKeyCallback: hostKey,
		Timeout:         12 * time.Second,
	}
	addr := net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	sc, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, fmt.Errorf("连不上 %s：%w", addr, err)
	}
	fc, err := sftp.NewClient(sc)
	if err != nil {
		_ = sc.Close()
		return nil, fmt.Errorf("SSH 已连上，但 SFTP 子系统不可用：%w", err)
	}
	return &pooled{ssh: sc, sftp: fc, fp: fp}, nil
}
