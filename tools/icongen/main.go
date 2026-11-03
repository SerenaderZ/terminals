// Command icongen 生成 TerminalS 的应用图标。
//
// 不引入任何第三方图形库：图标只有「圆角方块 + 折线 + 一条横杠」三个形状，
// 用解析距离场画出来比拉一个绘图库更省事，也保证每次构建结果一致。
// 形状都在 0..1 的单位坐标系里定义，按目标尺寸缩放，所以 64 和 256 是同一份设计。
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// 配色和前端 CSS 变量保持一致：深色底 + 天蓝强调色。
var (
	bgColor     = color.NRGBA{R: 0x18, G: 0x1b, B: 0x21, A: 0xff}
	accentColor = color.NRGBA{R: 0x4c, G: 0xc2, B: 0xff, A: 0xff}
)

// seg 是一条线段，用来画「>」的两笔和光标那一横。
type seg struct{ x1, y1, x2, y2 float64 }

// 单位坐标系里的形状定义。
const (
	boxCX, boxCY = 0.5, 0.5
	boxHW, boxHH = 0.46, 0.46
	boxRadius    = 0.22
	strokeR      = 0.052
)

var strokes = []seg{
	{0.29, 0.35, 0.47, 0.50}, // 「>」上半
	{0.47, 0.50, 0.29, 0.65}, // 「>」下半
	{0.565, 0.65, 0.735, 0.65}, // 光标横杠
}

const supersample = 4

// distSeg 返回点到线段的最短距离。
func distSeg(px, py float64, s seg) float64 {
	dx, dy := s.x2-s.x1, s.y2-s.y1
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return math.Hypot(px-s.x1, py-s.y1)
	}
	t := ((px-s.x1)*dx + (py-s.y1)*dy) / l2
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	return math.Hypot(px-(s.x1+t*dx), py-(s.y1+t*dy))
}

// rrect 是圆角矩形的符号距离：<0 在内部，=0 在边界。
func rrect(px, py, cx, cy, hw, hh, r float64) float64 {
	qx := math.Abs(px-cx) - (hw - r)
	qy := math.Abs(py-cy) - (hh - r)
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
}

// render 以 size 为边长渲染一张图标。
func render(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	inv := 1.0 / float64(size)
	step := inv / supersample

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// 超采样：每个像素取 supersample^2 个子样本，做覆盖率抗锯齿。
			var sr, sg, sb, sa float64
			for sy := 0; sy < supersample; sy++ {
				for sx := 0; sx < supersample; sx++ {
					px := float64(x)*inv + (float64(sx)+0.5)*step
					py := float64(y)*inv + (float64(sy)+0.5)*step
					c, a := sample(px, py)
					sr += float64(c.R) * a
					sg += float64(c.G) * a
					sb += float64(c.B) * a
					sa += a
				}
			}
			n := float64(supersample * supersample)
			if sa == 0 {
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: clamp(sr / sa),
				G: clamp(sg / sa),
				B: clamp(sb / sa),
				A: clamp(sa / n * 255),
			})
		}
	}
	return img
}

// sample 返回某一点的 RGB 与透明度（0..1）。透明即图标外缘。
func sample(px, py float64) (color.NRGBA, float64) {
	if rrect(px, py, boxCX, boxCY, boxHW, boxHH, boxRadius) > 0 {
		return color.NRGBA{}, 0
	}
	for _, s := range strokes {
		if distSeg(px, py, s) <= strokeR {
			return accentColor, 1
		}
	}
	return bgColor, 1
}

func clamp(v float64) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

func write(path string, size int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := png.Encode(f, render(size)); err != nil {
		return err
	}
	fmt.Printf("  %-40s %dx%d\n", path, size, size)
	return nil
}

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	fmt.Println("icons:")

	jobs := []struct {
		path string
		size int
	}{
		{filepath.Join(root, "package", "ICON.PNG"), 64},
		{filepath.Join(root, "package", "ICON_256.PNG"), 256},
		{filepath.Join(root, "package", "app", "ui", "images", "icon_64.png"), 64},
		{filepath.Join(root, "package", "app", "ui", "images", "icon_256.png"), 256},
	}
	for _, j := range jobs {
		if err := write(j.path, j.size); err != nil {
			fmt.Fprintf(os.Stderr, "failed to write %s: %v\n", j.path, err)
			os.Exit(1)
		}
	}
}
