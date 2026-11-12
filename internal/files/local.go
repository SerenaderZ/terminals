package files

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Local 是本机文件系统视图。
//
// 它刻意不是"直接用进程身份读盘"：tsd 以 root 起来，终端里的 shell 却降权
// 到普通管理员账户。文件面板如果以 root 身份写文件，传上去的东西属主会是
// root，终端里那个用户反而改不了自己刚传的文件 —— 所以每一个调用都套在
// Credential.Run 里，和终端用同一个身份。
type Local struct {
	home string
	cred Credential
}

// NewLocal 创建本机视图。home 是起始目录（一般是降权账户的 home）。
func NewLocal(cred Credential, home string) *Local {
	if home == "" {
		home = "/"
	}
	return &Local{home: filepath.Clean(home), cred: cred}
}

// Home 返回起始目录。
func (l *Local) Home() string { return l.home }

// Clean 把用户输入整理成绝对路径。
//
// 支持三种写法：空（回 home）、~/xxx、以及相对路径（相对 home）。
// 这里不做"禁止跳出 home"的限制 —— 面板的定位就是替代在终端里敲 ls/cp，
// 用户本来就能用 shell 访问这些地方，多一道栅栏只会让人困惑。
func (l *Local) Clean(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return l.home
	}
	if path == "~" {
		return l.home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Clean(filepath.Join(l.home, path[2:]))
	}
	if !filepath.IsAbs(path) {
		return filepath.Clean(filepath.Join(l.home, path))
	}
	return filepath.Clean(path)
}

// List 列目录。
func (l *Local) List(path string) (Listing, error) {
	p := l.Clean(path)
	out := Listing{Path: p, Parent: parentOf(p)}
	var items []Entry

	err := l.cred.Run(func() error {
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()

		st, err := f.Stat()
		if err != nil {
			return err
		}
		if !st.IsDir() {
			return ErrNotDir
		}

		// 用 (*File).Readdir 而不是 os.ReadDir：它直接给出 FileInfo，
		// 大小、权限、时间都在里面，省掉对每一项再 stat 一次。
		//
		// 注意 := 这里的 io.EOF：Readdir(n) 在"目录项不足 n 个"时会
		// 连数据带 EOF 一起返回（空目录就是 []+EOF）。把它当错误的话，
		// 空目录会变成一句 "EOF" —— 侧栏里看起来就像"这个文件夹打不开"。
		fis, err := f.Readdir(MaxEntries + 1)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if len(fis) > MaxEntries {
			fis = fis[:MaxEntries]
			out.Truncated = true
		}

		for _, fi := range fis {
			e := Entry{
				Name:  fi.Name(),
				Path:  filepath.Join(p, fi.Name()),
				Size:  fi.Size(),
				Mode:  fi.Mode().Perm().String(),
				MTime: fi.ModTime().Unix(),
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				e.Link = true
				// 链接按目标算：指向目录就当成目录，这样点进去和真目录一样。
				if target, err := os.Stat(e.Path); err == nil {
					e.Dir = target.IsDir()
					e.Size = target.Size()
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

// Open 打开文件用于下载。文件句柄在降权身份下打开，之后由 HTTP 层读取，
// 读的时候进程身份已经不影响这个已打开的 fd 了。
func (l *Local) Open(path string) (io.ReadCloser, int64, error) {
	p := l.Clean(path)
	var (
		f    *os.File
		size int64 = -1
	)
	err := l.cred.Run(func() error {
		var err error
		f, err = os.Open(p)
		if err != nil {
			return err
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		if st.IsDir() {
			f.Close()
			return ErrNotDir
		}
		size = st.Size()
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return f, size, nil
}

// Create 覆盖写入文件。
func (l *Local) Create(path string, r io.Reader) (int64, error) {
	p := l.Clean(path)
	var n int64
	err := l.cred.Run(func() error {
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		n, err = io.Copy(f, r)
		return err
	})
	return n, err
}

// Mkdir 建目录。
func (l *Local) Mkdir(path string) error {
	p := l.Clean(path)
	return l.cred.Run(func() error { return os.Mkdir(p, 0o755) })
}

// Remove 删除文件或空目录。
func (l *Local) Remove(path string) error {
	p := l.Clean(path)
	if err := l.guardRoot(p); err != nil {
		return err
	}
	return l.cred.Run(func() error {
		if err := os.Remove(p); err != nil {
			if isNotEmpty(err) {
				return ErrNotEmpty
			}
			return err
		}
		return nil
	})
}

// RemoveAll 递归删除。
func (l *Local) RemoveAll(path string) error {
	p := l.Clean(path)
	if err := l.guardRoot(p); err != nil {
		return err
	}
	return l.cred.Run(func() error { return os.RemoveAll(p) })
}

// Rename 改名或移动。
func (l *Local) Rename(from, to string) error {
	a, b := l.Clean(from), l.Clean(to)
	if err := l.guardRoot(a); err != nil {
		return err
	}
	return l.cred.Run(func() error { return os.Rename(a, b) })
}

// guardRoot 挡住"把根或 home 本身删掉/挪走"。
//
// 有这个能力不代表这个按钮该存在：侧栏是鼠标操作，误点的成本和终端里敲
// rm -rf 完全不是一回事。真要清空根目录，终端随时可以。
func (l *Local) guardRoot(p string) error {
	if p == "/" || p == l.home {
		return errProtected
	}
	return nil
}

// parentOf 给"上一级"按钮用。根目录返回空串，前端据此禁用按钮。
func parentOf(p string) string {
	parent := filepath.Dir(p)
	if parent == p {
		return ""
	}
	return parent
}
