# TerminalS

面向 [fnOS](https://www.fnnas.com/)（飞牛私有云）的 Web 终端工作区。目标是接近本地终端的使用体验：多标签、任意分屏、布局持久化、会话保活，能正常跑 Claude Code 这类全屏 CLI。

一个 Go 单文件服务 + xterm.js 前端，前端资源全部内嵌进二进制，部署时只需要扔一个文件上去。

[English](README.en.md)

## 特性

**工作区**

- 多标签，每个标签一棵独立的布局树；隐藏的标签只是不显示，进程和连接都还在
- 横竖任意嵌套分屏，拖分隔条调比例，关窗格自动折叠空的分割节点
- 布局存在服务端，刷新、关窗口、换设备回来，接回的是**同一批进程**
- 每个窗格右侧一条竖轨道：顶端 `×` 关窗格，下面是自绘滚动条，拖、点、滚轮都能翻历史

**会话**

- 常驻 PTY + `sid` 重连 + 256KB 环形回放；断线重连接着输出，不用重新起命令
- 备用屏幕（alt-screen）追踪，vim / htop / Claude Code 重连后画面能重建
- 关窗格会结束整棵进程树，后台任务不会留在服务端
- 想留进程：`Shift` + 点 ×，把窗格移出界面但保留进程，随时可以接回
- `--backend tmux` 可选，会话跑在 tmux 里，应用重启/升级后按 sid 原地认领

**终端体验**

- 默认降权到普通账户运行，要 root 自己在终端里 `sudo -i`，不写任何 sudoers 文件
- 快捷键全部走 `Ctrl+Alt`（`Ctrl+Shift+T/W` 被浏览器强占，`Alt+Shift` 是输入法热键）
- 右键语义只看有没有选区：有选区 = 复制，没选区 = 粘贴，一次点击
- 拖选自动复制（可关）；`Ctrl+Shift+C/V`、`Ctrl+Insert`/`Shift+Insert` 都能用
- 设置存服务端：主题、字号、光标闪烁、WebGL 开关、回看行数、选中即复制
- 连接状态是个按钮：断开时悬停能看原因、服务是否还活着、下次重连还有几秒，点一下立刻重连

## 安装

### 在 fnOS 上安装

从 [Releases](https://github.com/SerenaderZ/terminals/releases) 下载对应架构的 `.fpk`：

| 文件 | 适用 |
|---|---|
| `terminals_<版本>_x86.fpk` | Intel / AMD：N100、N305、J4125 等绝大多数机器 |
| `terminals_<版本>_arm.fpk` | ARM：RK3588 一类开发板 |

**应用中心 → 设置 → 手动安装**，选对应的包。装好后从桌面打开，访问入口是 `/app/terminals`。

服务通过 unix socket 交给飞牛网关转发，不占用任何 TCP 端口。

### 从源码运行

需要 Go 1.23+：

```bash
git clone https://github.com/SerenaderZ/terminals.git
cd terminals
go run ./cmd/tsd
# 打开 http://127.0.0.1:18086/
```

Windows 上通过 ConPTY 启动 `powershell.exe`，只用于验证前后端链路；中文、TUI 这类真实行为要在 Linux 上验。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+T` / `W` | 新建标签 / 关闭当前窗格 |
| `Ctrl+Alt+=` / `-` | 向右 / 向下分屏 |
| `Ctrl+Alt+←↑↓→` | 按方向移动焦点 |
| `Ctrl+Alt+[` `]` / `1..9` | 切换标签 |
| `Ctrl+Alt+K` | 清屏（连 scrollback） |
| `Ctrl+Alt+Q` | 结束全部会话 |
| `Ctrl+Alt+,` | 设置 |
| `Ctrl+Shift+C/V` | 复制 / 粘贴 |
| `Ctrl+Insert` / `Shift+Insert` | 复制 / 粘贴（浏览器不占用，最可靠） |
| `Ctrl+V` | 浏览器原生粘贴 |
| `Ctrl+=` / `-` / `0` | 字号增减 / 复位 |
| `Shift+Enter` | 发送 `ESC CR`，Claude Code 里换行不提交 |

鼠标：`Shift` + 点窗格右侧的 `×` = 移出界面并保留进程；点右上角状态灯 = 立刻重连。

## 配置

启动参数（默认值适用于应用模式；手工运行多为 `127.0.0.1:18086`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--listen` | `127.0.0.1:18086` | TCP 监听地址 |
| `--socket` | 空 | unix socket 路径，设置后不监听 TCP |
| `--base` | 空 | 网关前缀，如 `/app/terminals` |
| `--shell` | 平台默认 | Linux 是 `/bin/bash -l`，Windows 是 `powershell.exe` |
| `--cwd` | 目标账户 home | 不可用时自动回退 |
| `--run-as` | 自动探测 | 降权到的账户 |
| `--backend` | `native` | `native` 自持 PTY；`tmux` 可扛住应用重启 |
| `--data-dir` | 见下 | `layout.json` 与 `sessions.json` 所在目录 |
| `--max-sessions` | 32 | 上限只拦新建，不杀正在用的会话 |
| `--replay-kb` | 256 | 断线回放缓冲大小 |
| `--check` | false | 只做环境自检并退出 |

`--data-dir` 依次取 `--socket` 所在目录 → `$TERMINALS_DATA` → `~/.local/state/terminals`（Linux）/ `%APPDATA%\terminals`（Windows）。

装成应用后还可以写 `/var/apps/terminals/var/config.env` 固定运行参数：

```bash
RUN_AS=yourname
BACKEND=tmux
# TERMINAL_SHELL=/bin/bash
# TERMINAL_CWD=/vol1/1000
```

改完重启应用生效。

## 构建与打包

```powershell
.\tools\build.ps1          # linux/amd64 + linux/arm64 静态二进制，输出到 dist/
.\tools\pack.ps1 -Arch both # 打 x86 / arm 两个 .fpk
```

打包用飞牛官方 `fnpack`（脚本会自动下载），不手搓 tar。有两个坑必须知道：

1. **Windows 上打包会丢可执行位**：NTFS 没有 unix 权限位，`fnpack` 会把所有文件写成 `0666`，`cmd/main` 不可执行 → 装得上但点"启动"没反应、日志也没内容。所以流程里强制多一步 `tools/fpkfix` 重写 tar 头，把 `cmd/*` 和 `app/bin/tsd` 设成 `0755`。
2. **`cmd/` 下必须是 LF 换行**：CRLF 会让 bash 报 `bad interpreter`。`pack.ps1` 打包前会检查，发现 CR 直接失败。

## 目录结构

```
cmd/tsd/            入口（参数、自检、信号处理）
internal/diag/      --check 环境自检
internal/proto/     帧协议常量
internal/session/   PTY 会话管理（ring / alt / manager / pty / tmux / user / probe）
internal/server/    HTTP + WebSocket + 布局存储
ui/                 前端（xterm 5.5.0，资源内嵌进二进制）
package/            fnOS 安装包源目录
tools/              构建、打包、部署、测试脚本
DESIGN.md           架构设计
docs/               故障排查与实现笔记
```

## 故障排查

完整版见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)，几个最常见的：

**打开显示 404** — 桌面入口地址和服务端前缀没对上。0.1.1 起服务端会补尾斜杠、也能处理网关剥掉前缀的情况；还不行就直接问后端：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  --unix-socket /var/apps/terminals/target/gateway.sock http://localhost/app/terminals/
```

200 说明服务没问题，问题在网关转发。

**启动会话报 `fork/exec /bin/bash: no such file or directory`** — 通常不是 bash 缺失，而是工作目录不存在。Go 在子进程 `chdir` 失败时返回的 errno 同样是 `ENOENT`，被统一包装成这个提示。程序会自动按 `--cwd` → 账户 home → `$HOME` → `/tmp` → `/` 回退。

**TUI 退出后留残影** — 先按 `Ctrl+Alt+K` 清屏。反复出现就在控制台跑 `__ts.diag()`，对比每个窗格的 xterm 尺寸和 PTY 尺寸。

**局域网直连显示未连接、远程访问正常** — 网关把 `Host` 的端口去掉了，被来源校验判成跨站。当前实现先比完整 `host:port`、再比主机名，同主机不同端口照样放行。`/api/wscheck` 可以单独看判定结果。

## 已知限制

- 输出流控是"队列满就丢帧"，慢客户端可能丢输出
- `native` 后端下服务重启即会话丢失；需要扛重启用 `--backend tmux`
- WebGL 只给前 4 个窗格，其余走 canvas（浏览器 context 上限约 16，超了会静默丢最旧的）
- 布局是整个工作区一份，不是每人一份；两个管理员同时改会互相覆盖
- 非 HTTPS 访问读不到系统剪贴板：右键粘的是本页最近复制的内容，粘别处复制的东西要用 `Ctrl+V`
- Windows 后端仅供开发，不承诺体验

## 许可

MIT，见 [LICENSE](LICENSE)。

## 作者

[SerenaderZ](https://github.com/SerenaderZ)
