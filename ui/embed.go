// Package ui 把前端资源嵌进二进制，部署时只有单个可执行文件。
package ui

import "embed"

//go:embed index.html app.js style.css vendor
var FS embed.FS
