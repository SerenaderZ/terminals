// Package files 提供文件浏览与读写，供前端的文件侧栏使用。
//
// 两种来源：本机文件系统（和终端里看到的是同一个，走同一个降权身份），
// 以及远程 SFTP。两者对上层是同一个 FS 接口，HTTP 层不用区分。
package files

import (
	"errors"
	"io"
	"sort"
	"strings"
	"syscall"
)

// MaxEntries 是一次列目录最多返回多少项。
//
// 侧栏只是让人找东西，不是文件管理器：几千项已经翻不动了，再多的意义只是
// 让浏览器卡住。超过这个数就截断并告诉前端，别无声无息地少一半。
const MaxEntries = 5000

// ErrNotDir 表示目标不是目录。
var ErrNotDir = errors.New("不是一个目录")

// ErrNotEmpty 表示目录里还有东西，不能直接删。
//
// 单独定义它是因为上层要据此决定"要不要弹一个『连里面一起删』的确认框"。
// 靠原始错误文本去猜太脆：Linux 给 ENOTEMPTY，Windows 给
// ERROR_DIR_NOT_EMPTY，SFTP 服务器又各说各话。
var ErrNotEmpty = errors.New("目录里还有东西")

// isNotEmpty 判断错误是不是"目录非空"。文本兜底是给 SFTP 服务器用的 ——
// 它们返回的是自己拼的字符串（比如 "Failure"），只能看关键字。
func isNotEmpty(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.ENOTEMPTY) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "not empty") ||
		strings.Contains(msg, "directory not empty")
}

// Entry 是列表里的一行。
type Entry struct {
	Name string `json:"name"`
	// Path 是绝对路径。前端双击、右键都拿它当唯一标识，不要自己拼。
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
	// Link 表示这是符号链接。链接指向目录时 Dir 也为 true（按目标算），
	// 这样点进去的体验和真目录一样。
	Link bool `json:"link"`
	Size int64 `json:"size"`
	// Mode 是 "rwxr-xr-x" 这样的权限位，前端只显示右侧九位。
	Mode  string `json:"mode"`
	MTime int64  `json:"mtime"`
	// Err 非空表示这一项 stat 不出来（链接指向的东西没了、没权限）。
	// 这种项照样列出来：看得见"有个东西在但读不了"比它凭空消失有用。
	Err string `json:"err,omitempty"`
}

// Listing 是一次列目录的结果。和 layout 一样，多出来的字段前端自己忽略，
// 后端加字段不用同步改前端。
type Listing struct {
	Path   string  `json:"path"`
	Parent string  `json:"parent"`
	Items  []Entry `json:"items"`
	// Truncated 表示目录项超过 MaxEntries，只返回了一部分。
	Truncated bool `json:"truncated"`
}

// FS 是一个文件系统视图。
//
// 所有 path 都是绝对路径，由 Clean 规范化过。实现自己负责把 "/" 这种
// 边界处理好，上层不做路径拼接。
type FS interface {
	// List 列目录。path 为空时用 Home。
	List(path string) (Listing, error)
	// Open 打开一个文件用于读取，同时给出大小（未知时为 -1）。
	Open(path string) (io.ReadCloser, int64, error)
	// Create 覆盖写入一个文件，返回写入字节数。
	Create(path string, r io.Reader) (int64, error)
	// Mkdir 建目录，父目录必须存在。
	Mkdir(path string) error
	// Remove 删除文件或空目录；目录里还有东西时返回错误。
	// 递归删除由上层显式调用 RemoveAll 完成 —— 这一个动作太危险，
	// 不能靠"删目录时顺手递归"这种默认行为。
	Remove(path string) error
	// RemoveAll 递归删除。
	RemoveAll(path string) error
	// Rename 改名或移动。
	Rename(from, to string) error
	// Home 返回这个视图的起始目录。
	Home() string
	// Clean 把用户输入的路径规范化成绝对路径。
	Clean(path string) string
}

// sortEntries 按"目录在前、然后不分大小写按名字"排。
//
// 不按修改时间排：找东西时人记得的是名字，不是哪天改的；按时间排还会让
// 整个列表在每次刷新后重排，刚要点的那一行瞬间换了位置。
func sortEntries(items []Entry) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if la != lb {
			return la < lb
		}
		return a.Name < b.Name
	})
}

// trimListing 把结果截到 MaxEntries，并报告是否截断。
func trimListing(l *Listing) {
	if len(l.Items) > MaxEntries {
		l.Items = l.Items[:MaxEntries]
		l.Truncated = true
	}
	sortEntries(l.Items)
}

// safeName 判断一个用户给的文件名能不能直接当文件名用。
//
// 上传接口收的是"目录 + 文件名"两个字段，而不是一个拼好的路径 ——
// 拼路径的话，名字里带一个 "/" 就能写到别的目录里去。
func safeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("文件名为空")
	}
	if name == "." || name == ".." {
		return "", errors.New("文件名不能是 . 或 ..")
	}
	if strings.ContainsAny(name, "/\\") {
		return "", errors.New("文件名不能包含斜杠")
	}
	if strings.ContainsRune(name, 0) {
		return "", errors.New("文件名不能包含控制字符")
	}
	return name, nil
}
