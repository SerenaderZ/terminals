// Command fpkfix 修正 fnpack 在 Windows 上打出的 fpk 的文件权限。
//
// 为什么要这一步：Windows 的 NTFS 没有 unix 可执行位，fnpack.exe 在 Windows 上
// 生成 tar 头时把所有文件都写成 0666。装到飞牛上之后：
//   - cmd/main 不可执行 → 应用中心启动时报权限错误，或者直接"启动无反应"
//   - app/bin/tsd 不可执行 → 启动脚本里的 chmod 能救，但那是补救不是正解
//
// 这个工具重写 fpk 里的 tar 头（它本身就是 gzip + tar，结构简单），
// 把 cmd/ 下所有脚本和 app/bin/tsd 设成 0755，其余保持 0644。
// 在 Linux/macOS 上打包时 fnpack 自己会写对权限，所以本工具是幂等的 —— 跑一次不会坏。
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
)

type entry struct {
	name string
	mode int64
	data []byte
	dir  bool
}

// readTarGz 把 gzip+tar 读成内存里的条目列表。fpk 只有几 MB，直接全读。
func readTarGz(raw []byte) ([]entry, error) {
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("解压失败: %w", err)
	}
	defer zr.Close()

	tr := tar.NewReader(zr)
	var out []entry
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
			// 符号链接之类原样跳过：我们不需要，也不该凭空造。
			continue
		}
		e := entry{name: h.Name, mode: h.Mode, dir: h.Typeflag == tar.TypeDir}
		if !e.dir {
			b, err := io.ReadAll(tr)
			if err != nil {
				return nil, err
			}
			e.data = b
		}
		out = append(out, e)
	}
	return out, nil
}

// writeTarGz 按给定顺序写回 gzip+tar。
func writeTarGz(entries []entry) ([]byte, error) {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	tw := tar.NewWriter(zw)

	for _, e := range entries {
		h := &tar.Header{
			Name:     e.name,
			Mode:     e.mode,
			ModTime:  time.Now(),
			Uid:      0,
			Gid:      0,
			Typeflag: tar.TypeReg,
		}
		if e.dir {
			h.Typeflag = tar.TypeDir
			if h.Mode&0o111 == 0 {
				h.Mode = 0o755
			}
		} else {
			h.Size = int64(len(e.data))
		}
		if err := tw.WriteHeader(h); err != nil {
			return nil, err
		}
		if !e.dir {
			if _, err := tw.Write(e.data); err != nil {
				return nil, err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// wantedMode 决定一个路径应该有什么权限。
func wantedMode(name string, isDir bool) int64 {
	if isDir {
		return 0o755
	}
	switch {
	case name == "manifest":
		return 0o644
	case strings.HasPrefix(name, "cmd/"):
		// 生命周期脚本必须可执行，否则应用中心根本调不起来。
		return 0o755
	case name == "app/bin/tsd" || name == "bin/tsd":
		// 内层 app.tgz 的根是 app/ 目录本身，所以路径有两种写法。
		return 0o755
	}
	return 0o644
}

func main() {
	in := flag.String("in", "", "输入的 .fpk")
	out := flag.String("out", "", "输出的 .fpk；留空则原地覆盖")
	flag.Parse()

	if *in == "" {
		fmt.Fprintln(os.Stderr, "用法: fpkfix -in <file.fpk> [-out <file.fpk>]")
		os.Exit(2)
	}
	if *out == "" {
		*out = *in
	}

	raw, err := os.ReadFile(*in)
	if err != nil {
		fail("读取失败: %v", err)
	}
	entries, err := readTarGz(raw)
	if err != nil {
		fail("解析 fpk 失败: %v", err)
	}

	fixed := 0
	for i := range entries {
		want := wantedMode(entries[i].name, entries[i].dir)
		if entries[i].mode != want {
			entries[i].mode = want
			fixed++
		}

		// 内层 app.tgz 也要修：它解出来的 app/bin/tsd 同样需要可执行位。
		if entries[i].name == "app.tgz" && !entries[i].dir {
			inner, err := readTarGz(entries[i].data)
			if err != nil {
				fail("解析内层 app.tgz 失败: %v", err)
			}
			n := 0
			for j := range inner {
				w := wantedMode(inner[j].name, inner[j].dir)
				if inner[j].mode != w {
					inner[j].mode = w
					n++
				}
			}
			rebuilt, err := writeTarGz(inner)
			if err != nil {
				fail("重写 app.tgz 失败: %v", err)
			}
			entries[i].data = rebuilt
			fmt.Printf("  app.tgz: fixed %d entries\n", n)
		}
	}

	buf, err := writeTarGz(entries)
	if err != nil {
		fail("重写 fpk 失败: %v", err)
	}
	// 先写临时文件再 rename，避免中途失败留下半个包。
	tmp := *out + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		fail("写入失败: %v", err)
	}
	if err := os.Rename(tmp, *out); err != nil {
		fail("替换失败: %v", err)
	}

	fmt.Printf("  outer: fixed %d entries\n", fixed)
	fmt.Printf("  output: %s (%d bytes)\n", path.Clean(*out), len(buf))
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
