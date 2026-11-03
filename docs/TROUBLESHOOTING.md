# 故障排查与实现笔记

开发和实机调试过程中攒下来的排错记录、版本变更与实现细节。
项目概览见 [README](../README.md)，架构设计见 [DESIGN](../DESIGN.md)。

## 当前进度

**M2 完成** —— 多标签 + 分屏 + 布局服务端持久化。M1 的会话模型（`sid` 重连、
环形回放、alt-screen 复原）是它的地基，已经复用。

已完成：

- 常驻 PTY 会话 + `sid` 重连 + 环形回放缓冲（256KB）
- 备用屏幕（alt-screen）追踪，全屏 TUI 重连后画面能重建
- **多标签**：每个标签一棵独立布局树，隐藏的标签只是不显示，进程和 WS 都还在
- **分屏**：横竖任意嵌套，拖分隔条调比例，关窗格自动折叠空的分割节点
- **窗格轨道**：每个窗格右侧一列竖轨道 —— 顶端小 `×` 关掉这个窗格，下面是滚动条，
  拖滑块或点轨道都能翻回看；只有一个窗格的标签不显示 `×`，只留滑块
- **滚轮随处可滚**：鼠标在终端文字区、滚动条上、甚至 `×` 上，滚轮都作用于这一格
- **复制粘贴**：拖选文字自动进剪贴板（可在设置里关）。右键有选区即复制，
  没选区即粘贴——HTTPS 下读系统剪贴板，http 下粘本页刚复制的那段，
  `Ctrl+V` / `Ctrl+Insert` / `Shift+Insert` 也都能用
- **关窗格 = 停掉里面的一切**：会话连同进程树一起结束，后台任务不会留在服务端。
  想留进程就按住 `Shift` 点 ×，见下文「把程序留在后台」
- **持久化**：分屏、标签、每个窗格的 sid 都存在服务端（`layout.json`）。刷新、
  关掉窗口再打开、换设备进来，接回的都是**同一批进程**——关窗期间命令继续跑，
  回来能看到它接着输出
- **结束全部**（标题栏电源图标 / `Ctrl+Alt+Q`）：二次确认后停掉所有窗格里的程序、
  清空布局，留一个干净窗格；**窗口本身不关**
- 接回正在跑 TUI（claude/vim）的会话时，服务端会让 PTY 尺寸抖一下，触发一次整屏重绘，
  避免回放按旧尺寸画的增量字节出现花屏
- Unicode11 字宽 + `locale -a` 探测 UTF-8 locale（中文输入的地基）
- 二进制帧协议（首字节类型，不 base64）
- 前端字体就绪后再 `open()`，避免 cell 尺寸抖动
- **默认降权到管理员账户**，要 root 自己在终端里 `sudo -i`；不写任何 sudoers 文件
- **`--backend tmux`**：会话跑在 tmux 里，core 重启/升级后按 `sessions.json` 原地认领，sid 不变
- **设置页**（`Ctrl+Alt+,`）：主题 / 字号 / 光标 / WebGL / 回看行数 / 选中即复制，
  存服务端，改完立即作用到已开窗格
- **把程序留在后台**：`Shift` + 点窗格上的 × 只把界面收走，进程照跑；
  标题栏的后台会话入口可以看清单、随时接回或结束（详见下文）
- **连接状态可诊断**：右上角的「已连接」其实是个按钮。断开时指示灯变红、
  光标变手型，悬停能看到断开原因、服务端本身是否还活着、下一次自动重连还有几秒，
  点一下立刻重连；连上之后它不可点，鼠标移上去也不会有任何提示（详见下文）
- **反代后面也能连**：来源校验改成先比 `host:port`、再比主机名。网关把 Host 的端口
  吃掉（nginx 的 `$host` 就会）时不再把正常访问误判成跨站——这正是局域网直连
  显示"未连接"、远程访问却正常的根因（详见下文）
- **`--check` 环境自检** + `tools/deploy.ps1` 一键上机（探架构、上传、远端自检、后台拉起）
- **可安装的 fpk**：`tools/pack.ps1` 出 x86 / arm 两个包，应用中心直接装

**现在可以打包安装了**（`dist/terminals_*.fpk`）。飞牛实机上的中文输入、TUI 重绘、
Claude Code 已由用户验收通过；设置页里的各项均可在实机上直接验证。

未做：输出流控（队列溢出目前直接丢帧）、标签重命名、zmodem、
core/web 双进程拆分（现在 `kill tsd` 会带走所有会话）。

## 快捷键

全部用 `Ctrl+Alt`：`Ctrl+Shift+T/W` 被浏览器强占（重开标签、关窗口），
`Alt+Shift` 在 Windows 上还是输入法切换热键，两边都不能用。

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+T` | 新建标签 |
| `Ctrl+Alt+W` | 关闭当前窗格（最后一个窗格关掉即关标签） |
| `Ctrl+Alt+=` | 向右分屏 |
| `Ctrl+Alt+-` | 向下分屏 |
| `Ctrl+Alt+←/→/↑/↓` | 按方向移动焦点，几何就近 |
| `Ctrl+Alt+[` / `]` | 上一个 / 下一个标签 |
| `Ctrl+Alt+1..9` | 跳到第 n 个标签 |
| `Ctrl+Alt+K` | 清屏（连 scrollback 一起清）—— TUI 异常退出留残影时用 |
| `Ctrl+Alt+Q` | 结束全部会话（二次确认，窗口保留） |
| `Ctrl+Alt+,` | 打开设置 |
| `Ctrl+Shift+C` / `V` | 复制 / 粘贴（Chrome 把 `Ctrl+Shift+C` 给了开发者工具，失效时用下面两个） |
| `Ctrl+Insert` / `Shift+Insert` | 复制 / 粘贴（浏览器不占用，最可靠） |
| `Ctrl+V` | 浏览器原生粘贴。http 页面上唯一能粘"别处复制的内容"的键，也是最省事的（见下） |
| 右键 | 有选区 = 复制，没选区 = 粘贴（一次点击，http / https 都可以） |
| `Ctrl+=` / `-` / `0` | 字号增减 / 复位 |
| `Shift+Enter` | 发送 `ESC CR`，Claude Code 里换行不提交 |

鼠标手势：`Shift` + 点窗格右侧的 × = 移出界面但保留进程（进后台清单）；
点右上角的连接状态按钮 = 立刻重连（只在断开时可点）。

## 设置

`Ctrl+Alt+,` 或标题栏的齿轮打开。设置**存在服务端**（`<数据目录>/settings.json`），
换浏览器、用手机打开看到的是同一份；localStorage 只做一层缓存，避免刷新时先闪一下默认主题。

| 项 | 说明 | 生效时机 |
|---|---|---|
| 主题 | 深色 / 浅色 | 立即，作用到所有已开窗格 |
| 字号 | 10 - 24，也可以用 `Ctrl+=` / `Ctrl+-` | 立即 |
| 光标闪烁 | 开 / 关 | 立即 |
| WebGL 渲染 | 关掉改用 canvas，兼容性更好、发热更低 | 立即（会当场归还显卡上下文） |
| 回看行数 | 每窗格保留 2000 / 10000 / 50000 行 | 立即 |
| 选中即复制 | 拖选文字自动写剪贴板 | 立即 |

### 把程序留在后台

会话本身不绑定在页面上：WebSocket 断开只是 `Detach`，shell 和它启动的进程都还在跑。
所以"关掉界面、程序继续跑"不需要额外机制，只要**不往服务端发 `DELETE`**。

三种用法：

- **`Shift` + 点 ×**：把单个窗格移出界面，记进后台清单。标签里只剩它一个时，
  整个标签一起收掉，再补一个干净窗格，界面上不会留下空壳。
- **结束全部 →「只关界面，保留后台」**：一次把界面上所有会话收进后台，一条进程都不停。
- **标题栏的后台会话按钮**：列出所有还活着、但界面上没挂的会话（包括页面崩过留下的），
  每条可以「接回」或「结束」。按钮右上角的数字是数量。

清单写在服务端 `layout.json` 的 `background` 字段里，刷新、换设备都还在；
每次打开面板会用 `GET /api/sessions` 校正一次，已经退出的会话自动从清单里剔掉。

边界：

- 只有后台面板里的「结束」才会真的发 `DELETE`，它会结束整棵进程树，和点 × 一样。
- `--backend native`（默认）下 core 重启、升级或崩溃，PTY 跟着 core 走，
  所有会话都会消失，后台清单里的记录下次打开就会被清掉。要扛住重启用 `--backend tmux`，
  或者把程序放进独立的 tmux / `setsid` 里。
- 单窗格时轨道上的 × 是隐藏的（只留滚动条），这时用「结束全部 → 只关界面」。
- 后台会话没有客户端挂着时，输出仍然写进 256KB 的回放缓冲，接回时只能看到最近一段。

### 断线时怎么办

右上角那盏灯其实是一个按钮。

| 状态 | 灯 | 按钮 | 悬停 |
|---|---|---|---|
| 已连接 | 绿 | 不可点，`pointer-events: none`，也不在 Tab 序列里 | 什么都不会出现 |
| 连接中 | 黄 | 不可点 | 什么都不会出现 |
| 未连接 | 红 | 可点，光标变手型 | 弹出浮层，给出原因 |
| 部分断开 | 黄 | 可点（分屏里只有一格断） | 同上，标题写「部分窗格已断开」 |

浮层里的三行：

- **原因**：WebSocket 关闭码翻成的话。`1006`（服务没响应 / 被网关掐断）、
  `1001`（服务端在关）、`1012`（服务端重启）、`1013`（繁忙）、构造函数失败（地址或混合内容被拦）。
  浏览器不给 `1006` 任何细节，所以这一行只能到"服务没响应"这个粒度。
- **服务**：`GET /api/healthz` 的探测结果，用来区分两件事——
  「服务不可达」说明应用停了/NAS 不通，该去看应用中心；
  「服务在线，只是 WebSocket 没连上」说明多半是网关或反向代理把 `Upgrade` 拦了。
- **重连**：第几次、还有几秒。退避是 0.5s 起翻倍、封顶 8s。
- **网关**（只在必要时出现）：当服务端判定"页面来源和请求 Host 对不上"时，
  这一行会把两边的主机名直接摊开。0.2.6 之前局域网直连就是这么挂的。

点按钮会**跳过退避立刻重连**，成功后状态栏回到绿色并提示「连接已恢复」。
状态是按所有窗格聚合的：分屏时一格断了会显示「部分断开」，
不会被焦点那一格掩盖。已经退出的窗格（程序跑完了）不参与判断。

### 局域网连不上、远程访问却正常

0.2.6 修的问题。来源校验要防 CSWSH，所以会比对页面的 `Origin` 和请求的 `Host`。
旧实现是逐字比字符串，而 nginx 的 `proxy_set_header Host $host;` 会把端口去掉：

- 局域网：页面在 `http://<ip>:5666`，`Origin` 带 `:5666`，`Host` 只剩 `<ip>` → 判成跨站，403，浏览器报 `1006`；
- 远程：页面在 `https://<域名>`（443），两边都不带端口 → 刚好对上。

现在先比完整 `host:port`，对不上再退一步只比主机名。同主机不同端口照样放行，
跨站域名仍然会被拒。`/api/wscheck` 可以单独看服务端的判定：
`curl -H 'Origin: http://<ip>:5666' http://<ip>:5666/app/terminals/api/wscheck`。

### 右键粘贴：http 和 https 都是「一次点击」

右键的语义只看一件事——**有没有选区**：

| 状态 | 右键的动作 |
|---|---|
| 有选区 | 复制（终端画在 canvas 上，浏览器的原生「复制」拿不到那些字，必须自己做） |
| 没选区、HTTPS / localhost | 读系统剪贴板并粘贴 |
| 没选区、http 直连 IP | 粘**本页最近一次复制的那段文字**（应用内剪贴板） |
| 没选区、http 且内部没有可用内容 | 弹出浏览器原生菜单，点「粘贴」 |

为什么 http 要分两种：Clipboard API 只在**安全上下文**里可用（HTTPS 或
`http://localhost`），局域网直连是 `http://192.0.2.20:5666`，`navigator.clipboard`
直接是 `undefined`，`document.execCommand('paste')` 也被禁。网页没有任何接口能
主动读剪贴板——这是浏览器的硬限制，不是实现偷懒。

所以 http 下改用**应用内剪贴板**：本页每次复制（右键复制、`Ctrl+Insert`、
拖选自动复制）都会把文字留一份在内存里。它覆盖的正是最常用的那条路：

> 选中文字 → 右键复制 → 左键点一下取消选区 → 右键粘贴

内容一定是对的，因为就是你刚复制的那段。两条失效条件，任一命中就作废、
退回原生菜单（宁多多点一次，也不粘错内容）：

- **页面失焦**：切到别的窗口，用户多半在别处复制了新东西；
- **超过两分钟**：陈年旧内容，粘上去只会莫名其妙。

想粘**从别的应用复制的内容**，http 下用 `Ctrl+V`（浏览器原生粘贴，
`clipboardData` 会通过 `paste` 事件交给终端），或者右键走原生菜单那一档。

`Ctrl+V` / `Shift+Insert` / `Ctrl+Shift+V` 在 http 页面上全部放行给浏览器，
应用一个都不拦——`Ctrl+Shift+V` 会被 Chrome 当成「粘贴为纯文本」处理。

反过来说，**https 下粘贴不用记快捷键**：没选区时右键一次就是粘贴（读系统剪贴板），
`Ctrl+V` 只是习惯键。也正因为浏览器把这个键固定成了粘贴，终端这边不再把它当
`0x16` 发出去——以前一次按键会既粘一份、又给 PTY 塞一个 `^V`（vim 里还会顺带
进块选择），现在只剩粘贴。

## 目录

```
cmd/tsd/            入口（参数、自检入口、信号处理）
internal/diag/      `--check` 环境自检
internal/proto/     帧协议常量
internal/session/   PTY 会话管理（ring / alt / manager / pty_* / tmux_* / user_* / probe_* / state）
internal/server/    HTTP + WebSocket + 布局存储（layout.go）
ui/                 前端（xterm 5.5.0，资源已内嵌进二进制）
  app.js            Workspace → Tab（布局树）→ Pane（xterm + WS）
package/            飞牛安装包的源目录（manifest / cmd / config / 图标 / ui）
tools/              构建、打包、部署、WS 冒烟、界面测试（puppeteer + 本机 Edge）
  build.ps1         三平台编译
  pack.ps1          打 fpk（调官方 fnpack）
  deploy.ps1        手工部署到 NAS（SSH 隧道模式）
  icongen/          生成应用图标（纯 Go，无第三方库）
  fpkfix/           修正 fpk 内文件权限（Windows 打包必需）
```

## 本地开发（Windows）

仓库不带 Go 工具链。放一份便携版到 `.tools/go`，或自行安装后改 `tools/build.ps1` 里的路径。

```powershell
# 取便携版 Go
curl.exe -L -o .tools\go.zip https://mirrors.aliyun.com/golang/go1.26.10.windows-amd64.zip
Expand-Archive .tools\go.zip -DestinationPath .tools -Force

# 依赖（国内网络需要镜像）
$env:GOPROXY = 'https://goproxy.cn,direct'
.tools\go\bin\go.exe mod tidy

# 本地跑起来
.tools\go\bin\go.exe run .\cmd\tsd
# 打开 http://127.0.0.1:18086/
```

Windows 上通过 ConPTY 启动 `powershell.exe`，只用于验证前后端链路。
**中文、TUI、Claude Code 的验收必须在飞牛上做** —— Windows 的 ConPTY 和 Linux 的 PTY 行为不一致。

## 交叉编译

```powershell
.\tools\build.ps1          # 出 linux/amd64 与 linux/arm64 两个静态二进制
```

产物在 `dist/`，是单个可执行文件，前端资源已内嵌。

## 打包成可安装的 fpk

```powershell
.\tools\pack.ps1              # 只出 x86
.\tools\pack.ps1 -Arch both   # x86 + arm 各一个
```

产物：

| 文件 | 给谁 |
|---|---|
| `dist/terminals_0.1.0_x86.fpk` | Intel / AMD：N100、N305、J4125 等绝大多数飞牛机器 |
| `dist/terminals_0.1.0_arm.fpk` | ARM：RK3588 一类开发板 |

安装：**应用中心 → 设置 → 手动安装**，选对应的 `.fpk`。

打包用的是飞牛官方 `fnpack`（`tools\pack.ps1` 会自动从官方地址下载到 `.tools\`），
不是手搓 tar —— 这个格式对文件顺序、权限、结构有隐性要求，手写很容易错在细节上。

### 包结构

```
package/
├── manifest                 应用元信息（appname / version / platform / 桌面入口名）
├── ICON.PNG                 64px 图标
├── ICON_256.PNG             256px 图标
├── config/privilege         run-as: root（再由 tsd 自己降权到管理员账户）
├── config/resource
├── cmd/main                 start / stop / status
├── cmd/*_init|*_callback    8 个生命周期钩子，当前都是 exit 0
└── app/
    ├── bin/tsd              静态二进制，打包时从 dist 复制
    └── ui/config            桌面入口：type=iframe + gatewaySocket
```

服务以 **unix socket**（`target/gateway.sock`）形式运行，由飞牛网关转发，
**不占用任何 TCP 端口**。访问入口是 `/app/terminals`。

### 两个必须知道的坑

1. **Windows 上打包会丢可执行位。** NTFS 没有 unix 权限位，`fnpack.exe` 把所有文件
   都写成 `0666`，结果是 `cmd/main` 不可执行 —— 装得上，但点"启动"毫无反应，
   而且日志里什么都没有。所以打包流程强制多一步 `tools/fpkfix`，重写包内 tar 头，
   把 `cmd/*` 和 `app/bin/tsd` 设成 `0755`。**跳过这一步的包一定是坏的。**
2. **`cmd/` 下必须是 LF 换行。** CRLF 会让 bash 报 `bad interpreter`，
   同样表现为"装好了但起不来"。`pack.ps1` 会在打包前检查，发现 CR 直接失败。

### 装好之后

| 项 | 位置 |
|---|---|
| 日志 | `/var/apps/terminals/var/terminals.log` |
| 布局与会话清单 | `/var/apps/terminals/var/layout.json`、`sessions.json` |
| 程序 | `/var/apps/terminals/target/bin/tsd` |
| 网关 socket | `/var/apps/terminals/target/gateway.sock` |

打不开时先看日志，再在 NAS 上跑一次自检：

```bash
/var/apps/terminals/target/bin/tsd --check --data-dir /var/apps/terminals/var
```

#### 打开显示 404

0.1.0 的桌面入口配的是 `/app/terminals`（无尾斜杠），而服务端只注册了带前缀的
路由并用 `StripPrefix` 剥离，两者匹配不上就直接 404。0.1.1 起做了两件事：

1. `app/ui/config` 的 `url` 改成 `/app/terminals/`；
2. 服务端增加 `basePath` 中间件 —— 无尾斜杠自动 302 补斜杠，带前缀剥掉前缀，
   不带前缀（网关自己剥掉了）也照常服务。所以网关保留还是去掉 `/app/terminals`，
   都能打开。

排查用两条命令，能立刻分清是网关还是本进程的问题：

```bash
# 直连 socket 问后端：200 说明服务本身没问题，问题在网关转发
curl -s -o /dev/null -w '%{http_code}\n' \
  --unix-socket /var/apps/terminals/target/gateway.sock http://localhost/app/terminals/

# 0.1.1 起所有 4xx/5xx 都会写日志（含网关实际传来的路径）
grep 'HTTP 4' /var/apps/terminals/var/terminals.log
```

日志里**完全没有** 404 记录，说明请求没走到 tsd（网关没转发 / 应用没起来）；
有记录，就照记录里的路径判断前缀是否被网关改写。

#### 启动会话报 `fork/exec /bin/bash: no such file or directory`

**这不是 bash 缺失**，别去装 bash。Go 的 `os/exec` 在子进程 `chdir` 失败时
返回的 errno 同样是 `ENOENT`，而它把错误统一包装成
`fork/exec <argv[0]>: ...` —— 于是"工作目录不存在"被显示成"shell 不存在"。

真实原因通常是会话的工作目录不可用：默认 cwd 取自降权账户的 home，而飞牛上
`/etc/passwd` 里的 home 可能指向一个并不存在的路径（或者 app 沙箱里看不到）。

0.1.2 起启动时会**真跑一次** shell + 目录的组合来定案：

```
试跑未通过：/bin/bash @ /home/xxx：fork/exec /bin/bash: no such file or directory
工作目录回退到 /tmp（/home/xxx 不存在或该账户进不去）
会话参数：shell=/bin/bash cwd=/tmp 账户=xxx
```

回退顺序是 `--cwd` → 账户 home → `$HOME` → `/tmp` → `/`，shell 顺序是
`--shell` → `$SHELL` → `/bin/bash` → `/usr/bin/bash` → `/bin/sh` → … →
`/bin/zsh`。全部失败时会额外打一份环境快照（`/bin` 是不是软链、`/bin/bash`
的 mode、`/proc/self/root` 指向），那份快照能直接证明是不是沙箱看不到 `/bin`。

#### 分屏多了以后某个窗格整块变黑

浏览器对每个页面的 WebGL 上下文有硬上限（Chrome 约 16 个），超了会**静默**
丢掉最旧的那个，表现就是某个窗格突然全黑。0.1.3 起改成上下文池：最多 4 个窗格
用 WebGL，其余走 canvas 渲染器，焦点切过去时换人。

在浏览器控制台敲 `__ts.webglCount()` 能看到当前占用数；正常不会超过 4。
如果出现黑屏而计数正常，那是渲染器问题不是上下文问题，把控制台报错发我。

想固定下来，就在 `/var/apps/terminals/var/config.env` 里写：

```bash
RUN_AS=yourname
BACKEND=native
# 也可以直接指定，跳过自动探测
# TERMINAL_SHELL=/bin/bash
# TERMINAL_CWD=/vol1/1000
```

### 可选配置

写 `/var/apps/terminals/var/config.env`，然后重启应用：

```bash
# 降权到哪个账户，默认自动探测（sudo 组 → wheel 组 → 第一个普通账户）
RUN_AS=yourname
# 会话后端：native（默认）或 tmux（能扛住应用升级）
BACKEND=tmux
```

## 部署到飞牛（手工验证）

**先说明白：现在还不能"打包安装"。** 仓库里没有 `pkg/`，也没有 fpk 的
`manifest` / `cmd/main` / `privilege`，所以应用中心装不上。
当前阶段是**把裸二进制扔上去手工跑**，用来验证真实体验；fpk 打包在 M4。

用一个脚本搞定（默认走 SSH 隧道，服务只监听 127.0.0.1）：

```powershell
# 第一条命令建议先只做自检，把环境问题一次看全
.\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Check

# 确认没问题再启动
.\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Start

# 看日志 / 停掉
.\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Logs
.\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Stop
```

脚本会自动探测远端架构（`uname -m`）挑 amd64 还是 arm64 的产物、上传、
在远端跑一次 `--check`、再后台拉起，最后把访问方式打出来。

**为什么默认不绑 0.0.0.0：** 服务没有内置登录。绑到所有网卡等于把 shell
交给整个局域网，而它默认降权到的账户通常还能 `sudo -i`。所以默认走隧道：

```bash
ssh -p 22 -N -L 18086:127.0.0.1:18086 admin@192.0.2.10
# 然后浏览器开 http://127.0.0.1:18086/
```

确实需要局域网直连时加 `-Lan`，脚本会打警告。**验证完立刻 `-Stop`。**

### 上机自检（`--check`）

不启动服务，只把环境探一遍，有事说事：

```bash
./tsd --check
```

它会检查并逐条给出结论：shell 是否存在、`locale -a` 里有没有 UTF-8（中文地基）、
降权账户解析出谁及其 sudo 能力、**tmux 版本和各项能力门槛**、数据目录能否真写入、
端口能否绑定、以及是否绑到了 0.0.0.0。有阻断项时退出码为 2，可以直接进脚本判断。

跨平台也能跑（Windows 上显示的是开发环境的信息），所以本地就能验自检逻辑本身。

### TUI 退出后屏幕留残影 / 乱码

`vim`、`htop`、`claude` 这类全屏程序退出时，会在屏幕上留下错位的旧字符。排查顺序：

1. **先按 `Ctrl+Alt+K` 清一次屏**。TUI 被 kill 掉（没走正常收尾）时一定会有残影，
   这不是 bug，普通终端也一样。
2. 清完还反复出现，就在浏览器控制台跑 `__ts.diag()`。它会列出每个窗格的
   `xterm` 尺寸和 `pty` 尺寸，`一致` 一列是 `false` 就说明两边宽度不同 ——
   这才是真正的病根（TUI 按错宽度排版，换行位置全错，退出时自然对不上）。
3. 0.1.4 起每次连上都会拿 READY 帧里的 PTY 尺寸和 xterm 对一次账，不一致立刻掰回来；
   缓冲区从备用屏幕切回主屏时还会整屏重画并清掉 WebGL 字形图集，
   专门治"退出后留幽灵字符"。


## 启动参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--listen` | `127.0.0.1:18086` | 开发模式 TCP 地址 |
| `--socket` | 空 | unix socket 路径；设置后不监听 TCP |
| `--base` | 空 | 网关前缀，如 `/app/terminals` |
| `--shell` | 平台默认 | `linux` 是 `/bin/bash -l`，`windows` 是 `powershell.exe` |
| `--cwd` | 目标账户 home | 工作目录，不可用时自动回退 |
| `--run-as` | 自动探测 | shell 降权到的账户。留空则按 `TERMINALS_USER` → sudo 组 → wheel 组 → 第一个普通账户的顺序猜 |
| `--backend` | `native` | `native` 自持 PTY；`tmux` 让会话扛住 core 重启（见下） |
| `--data-dir` | 见下 | 数据目录，`layout.json` 与 `sessions.json` 都放这里 |
| `--state` | `--data-dir/sessions.json` | 会话清单落盘位置，tmux 后端认领会话需要 |
| `--tmux-conf` | 临时目录 | 生成的 tmux 配置路径（内容由程序覆盖） |
| `--layout` | `--data-dir/layout.json` | 存标签/分屏/sid |
| `--check` | false | 只做环境自检并退出，不启动服务 |
| `--max-sessions` | 32 | 上限只拦新建，绝不杀正在用的会话 |
| `--replay-kb` | 256 | 断线回放缓冲大小 |
| `--require-admin` | false | 校验 `X-Trim-Isadmin`；用 `--socket` 时自动开启 |

**`--data-dir` 的默认值**按顺序取：`--socket` 所在目录（应用模式下卸载能整目录清掉）
→ `$TERMINALS_DATA` → `~/.local/state/terminals`（Linux）/ `%APPDATA%\terminals`（Windows）。

早期版本这里默认是 `.`（启动时的当前目录）。从 systemd 或应用中心拉起来时
CWD 通常是 `/`，布局会写失败，而且**失败是静默的** —— 用户只能看到"刷新后分屏没了"。
这个默认值已经改掉。


### 权限

默认 shell 是**普通账户**，不是 root。要 root 就在终端里敲 `sudo -i`。
程序不会写 `/etc/sudoers.d`、不改任何系统 sudo 配置 —— 提权这道门保持 sudo 自己的密码交互。

如果启动日志说"没有 sudo 权限"，把该账户加进 sudo 组即可：

```bash
usermod -aG sudo <账户名>   # 重新登录后生效
```

只有显式 `--run-as root` 才会给 root shell，启动时会打警告。

启动时还会补一次 home：passwd 里写的目录如果不存在（飞牛上很常见），
就先建出来并 `chown` 给该账户；建不出来（只读根、命名空间里没有 `/home`）
就退到 `<数据目录>/home/<账户>` 并把 HOME 指过去。
不补这一下的话，普通用户既没有可写的 HOME，`~/.claude` 之类也建不出来。

### tmux 后端

```bash
./tsd --socket /var/apps/terminals/tsd.sock --backend tmux
```

会话跑在 `tmux -L terminals` 里，配置文件由程序生成并强制使用（不读 `~/.tmux.conf`）。
core 重启或升级后，读 `sessions.json` 对每个 sid 跑 `tmux has-session`，命中的原地认领 ——
**sid 不变**，前端 localStorage 里那个 sid 一连就接回来了，进程是真的还在跑。

它同样救不了 NAS 重启（同机用户进程一起死）。tmux 版本要求：`extended-keys` 要 3.2+，
`allow-passthrough` 要 3.3+，`sync` 要 3.4+。

## 已知限制

- 流控是"队列满就丢帧"，慢客户端会丢输出。M3 换信用窗口 + 降级恢复。
- `native` 后端下服务重启即会话丢失（快照恢复在 M4）；需要扛重启就开 `--backend tmux`。
- tmux 后端已在 Linux 上交叉编译通过，但**尚未在飞牛实机运行验证**。
- WebGL 只给前 4 个窗格，再多走 canvas 渲染 —— 浏览器 context 上限约 16 个，
  超了会静默丢最旧的，表现是某个窗格黑屏。宁可稳。
- 非 HTTPS 访问时浏览器不提供剪贴板 API：右键粘贴粘的是本页最近复制的内容，
  粘「别处复制的东西」要用 `Ctrl+V` 或浏览器原生菜单。
- 布局是"整个工作区一份"，不是每人一份：两个管理员同时改布局会互相覆盖。
- Windows 后端仅供开发，不承诺体验。

### Claude Code 退出后屏幕留痕，不是本终端的问题

Claude Code 用 inline 渲染：退出时只清掉自己占用的"动态区域"（`❯` 输入框、两条
分隔线），而 `Press Ctrl-C again to exit`、`● high ·/effort`、`※ recap: ...` 这些是
当普通文本写进主屏的，不会被清 —— **Windows Terminal、macOS Terminal 一样会留**，
换任何终端都清不掉。

本终端能保证的是"不留错位幽灵字符"（0.1.4 起：连上时与 PTY 对账尺寸、缓冲区切换后
整屏重绘）。内容本身按原样留在 scrollback 里，这正是 inline 模式的设计 —— 那段对话
记录是可以往上滚回看的，自动清掉反而是损失。

- 想立刻清干净：`Ctrl+Alt+K`（连 scrollback 一起清）。
- 用 `Ctrl-C` 中断退出时，Claude Code 有时来不及换行，shell 提示符会接在状态栏
  尾部同一行；用 `/exit` 或正常结束就不会有这一条。
