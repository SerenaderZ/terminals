# TerminalS 设计文档

飞牛 fnOS 的 Web 终端工作区。目标：**接近 Windows Terminal 的使用体验**，带分屏、布局持久化、  
会话保活，并且能正常跑 Claude Code 这类全屏 CLI。

- 状态：设计 v2（未开始编码）
- 应用名：`terminals`
- 二进制：`ts-core`（持 PTY）、`ts-web`（对浏览器）
- 网关前缀：`/app/terminals`
- 日期：2026-10-30

---

## 0. 先把边界说清楚

你的核心诉求是：**刷新网页后，所有标签、分屏布局、里面正在跑的进程都还在。**

这件事分三个层次，前两层能 100% 做到，第三层物理上做不到：

| 场景                               | 能否恢复         | 怎么做到                                    |
| -------------------------------- | ------------ | --------------------------------------- |
| 刷新页面 / 关掉浏览器 / 换浏览器              | ✅ 完美，进程不中断   | core 常驻持 PTY，前端按布局树 attach 回 sid        |
| `ts-web` 崩溃 / 升级 / 重启            | ✅ 完美，进程不中断   | 双进程架构，core 不受影响                         |
| **`ts-core` 重启 / NAS 重启 / 系统升级** | 分两种后端，见下     | tmux 后端能真正保活；native 后端只能"看起来一样"      |

第三层做不到的原因是物理性的：进程存活必须有父进程持有 PTY，父进程死了 PTY 就没了。  
除 CRIU 那种内存快照恢复外没有别的解法，而 CRIU 在 NAS 上不现实。

**native 后端**（默认）在第三层做成"视觉恢复"：重启后点开图标，标签数量、分屏比例、
每个 pane 的标题、工作目录、滚动历史都回来了，屏幕上还显示着上次的最后内容，
只是提示符是新起的。你看到的是连续的画面，但 `npm run dev` 已经不在了 ——
这个必须提前知道，否则会误判成 bug。

**tmux 后端**（`--backend tmux`）能真正撑住「core 重启」这一层：tmux server 是独立进程，
core 被杀不会带走它，新 core 起来按 `sessions.json` 原地认领，**进程真的还在跑，sid 也不变**。
NAS 重启它一样救不了（同机所有用户进程一起死）。

**tmux 和 Claude Code 不是互斥的**，见 3.3：那一节逐条列出了真彩色、扩展键、同步输出、
剪贴板对应的开关。其中 `extended-keys` 是关键 —— 没有它 Shift+Enter 和 Enter 无法区分，
Claude Code 的多行输入直接残废；开了就正常。

---

## 1.**&#x20;目标与非目标**

### **目标**

1. **会话独立于连接：**&#x5173;页面、断网、刷新、Web 层重启，PTY 都不受影响。
2. **布局持久化：**&#x5206;屏树、pane 归属、标签标题、每 pane 的滚动历史，全部落盘可恢复。
3. **分屏**：一个标签内可拆多个 pane，横竖任意嵌套，可拖拽调整比例。
4. **Windows Terminal 级键位**：能拦截的全部对齐 WT 默认键位，拦不住的给出替代并说明。
5. **CLI 兼容**：Claude Code、vim、htop、btop、lazygit 要能正常显示和交互。
6. **权限完整**：默认给到等效 root，不需要反复 `sudo`。
7. **单二进制、无外部运行时**：不依赖 NAS 上的 node / python。

### 非目标

| 不做                  | 理由                             |
| ------------------- | ------------------------------ |
| 跨重启保活进程             | 见第 0 节，物理限制。做到视觉恢复为止           |
| 自研终端模拟器             | xterm.js 足够，重写零收益              |
| SFTP 图形化文件管理器       | 用 zmodem 和 `scp`               |
| 命令 block 化（Warp 那种） | 需要 shell 深度集成，收益/成本不划算，M4 之后再看 |
| 远程桌面 / X11          | 越界                             |

---

## 2. 权限模型

**定稿（v3）：默认就是一个普通账户，要 root 自己在终端里 `sudo -i`。**

这条语义不模糊，代码里已经按它实现了：

| | 行为 |
| --- | --- |
| 默认 | daemon 以 root 启动（应用框架给的），**shell 立刻降权到管理员账户**，`uid != 0` |
| 提权 | 在终端里敲 `sudo -i`，拿到完整 root shell。密码走 sudo 自己的交互，PTY 有 tty，能正常提示 |
| `--run-as root` | 只有显式写这个参数才给 root shell，启动时打一条警告 |
| 不做什么 | **不写 `/etc/sudoers.d`**，不改系统里任何 sudo 配置 |

为什么不用 NOPASSWD sudo：那等于把 root 权限变成"打开网页就有"，和直接给 root shell 的安全性完全一样，只多一层心理安慰。而**保留 sudo 的密码交互**，等于给提权加了一道真实的门 —— 这道门在 NAS 被映射到公网时是唯一还有效的东西。

### 2.1 实现要点（已落地）

- **降权用内核凭据，不是 `runuser` 进程。** `syscall.Credential{Uid, Gid, Groups}` 在 `fork` 阶段就切好，子进程一出生就是目标账户。少 fork 一次、环境变量不被 `su` 类程序改写、退出码直接来自 shell。`Groups` 走 `user.GroupIds()` 拿到全部附加组，否则降权后会出现"属于 sudo 组但 sudo 说你不是 sudoer"的怪事。
- **`HOME` / `USER` / `LOGNAME` 必须跟着换。** 不换的话 bash 会去读 `/root/.bashrc`，普通用户读不到，于是登录时静默跳过所有配置 —— 表现为"提示符是光秃秃的 `$`，别名全没了"。这类问题很难被归因到权限上。
- **默认 cwd 换成目标账户的 home。** 原来写死 `/root`，降权之后直接 `chdir` 失败，PTY 起不来。
- **启动日志把权限形态说清楚**，三选一：`可用 sudo -i 自行提权` / `已是 root（警告）` / `没有 sudo 权限，需要 root 请加入 sudo 组`。不要让人靠猜。

### 2.2 一个必须承认的残留风险

`sudo -i` 之后 shell 变成了 root，此时 `~` 指向 `/root`，在里面新建的文件属主是 root。这是 sudo 的固有行为，不是我们的 bug。规避方式写进使用建议：需要长期以 root 跑的任务用 `sudo -i` 单独开一个标签，别和普通工作混在同一个标签里。

---

## 3. 架构

### 3.1 双进程

```
浏览器（xterm 5.5 × N pane · 布局树 · 快捷键 · WebGL 池）
   │  wss  /app/terminals/api/ws?pane=<id>&mode=control
   ▼
ts-web        axum：鉴权 / Origin / 布局 API / 静态资源 / 心跳 / 流控
   │  私有 unix socket（二进制帧 + 协议版本）
   ▼
ts-core       持全部 PTY：sid / 回放环形缓冲 / alt-screen / SIGWINCH / reap / 快照落盘
   │  openpty
   ▼
bash / zsh    管理员账户，可用 sudo
```

拆两个进程的理由：`ts-web` 需要频繁改动（UI 迭代、鉴权调整），`ts-core` 最好一年不动。  
分开之后 Web 层重启不影响会话，core 的代码面也能压到极小 —— 只有 PTY、环形缓冲、会话表，  
不碰网络、不解析 HTTP、不做热更新。

### 3.2 布局与持久化模型

#### 数据结构

```jsonc
// 一个工作区 = 一棵分割树
{
  "v": 1,
  "updated": 1761800000,
  "activeTab": 0,
  "tabs": [
    {
      "id": "t1",
      "title": "~/work/api",
      "root": {
        "type": "split",
        "dir": "row",          // row = 左右分，column = 上下分
        "ratio": 0.5,
        "children": [
          { "type": "leaf", "pane": "p1", "sid": "s1-a3f2", "cwd": "/root/work/api", "title": "api" },
          { "type": "split", "dir": "column", "ratio": 0.6, "children": [
              { "type": "leaf", "pane": "p2", "sid": "s3-c811", "cwd": "/var/log" },
              { "type": "leaf", "pane": "p3", "sid": "s4-77de", "cwd": "/root" }
          ]}
        ]
      }
    }
  ]
}
```

- 递归分割树，任意嵌套。`ratio` 是子节点占比，拖拽分隔条时更新。
- 每个 `leaf` 绑定一个 `sid`。**布局恢复 = 遍历树，对每个 leaf 用 sid 去 attach。**
- 保存位置：**以服务端为准**（`${TRIM_PKGVAR}/layout.json`），不是 localStorage。  
  你换浏览器、用手机打开，看到的都是同一份布局。localStorage 只存"上一次活跃的 pane"。

#### 三层持久化

| 层         | 触发            | 做法                                               | 结果                               |
| --------- | ------------- | ------------------------------------------------ | -------------------------------- |
| **L1 连接** | 刷新、断网、切浏览器    | core 内存里的 PTY + 256KB 环形回放                       | 完全无感，连命令都还在跑                     |
| **L2 布局** | 任何布局变化        | 防抖 400ms 写 `layout.json`                         | 刷新后原样恢复分屏、标签、标题                  |
| **L3 快照** | 每 30s + 会话退出时 | 把每个会话的回放缓冲 + 尺寸 + alt 状态写到 `snapshots/<sid>.bin` | core 重启后"重生"幽灵会话：新 shell + 旧屏幕内容 |

L3 的"重生"流程：

1. core 启动时扫 `snapshots/`，对每个快照创建一个**新的 PTY**（新 shell）。
2. 把快照里的字节流回放进这个新 PTY？**不行** —— 回放给 PTY 会把内容喂给 shell 当输入。
3. 正确做法：快照内容**不进 PTY**，由 `ts-web` 在 attach 时作为 `READY.ghostHistory` 字段发给前端，  
   前端直接 `term.write()` 到屏幕上，然后再接新 shell 的输出。
4. 视觉上：旧内容在上，新提示符在下。标签标题、cwd 从快照元数据恢复。
5. 前端标注"这是上次的残留，进程已结束"，避免误判。

> 这一步和普通重连的回放路径不同，代码上要分开：普通回放走 PTY 侧字节流，  
> 幽灵历史走 READY 里的独立字段，否则会污染 shell 输入。

### 3.3 tmux 可选后端（已实现，`--backend tmux`）

**它补的是「core 重启」这一层，不是「NAS 重启」。** tmux server 由 `setsid` 拉成独立进程组，
core 被 kill 不会带走它；但机器重启时它同样是普通用户进程，一样死。

#### 为什么它和 Claude Code 能共存

先纠正一个常见误解：**tmux 不是"改坏"终端能力，而是"需要在它这一层把能力重新声明一遍"。**
Claude Code 这类基于 Ink 的 CLI 判断能不能用真彩色、同步输出、扩展键，
是看 `TERM` + 主动探测；进到 tmux 里之后 `TERM` 变成 `tmux-256color`，
tmux 默认只转发它自己知道的能力，于是探测结果被系统性压低 —— 看起来像"tmux 和 Claude Code 不兼容"。

实际上每一项都有对应的开关。这一版的做法是：**配置由程序生成并强制 `-f` 指定**，
不读用户的 `~/.tmux.conf`。行为可复现，也不会被谁的旧配置改坏。

| 能力 | 不开时的症状 | 配置项（作用域已按 tmux 源码核对） |
| --- | --- | --- |
| 真彩色 | 配色发灰、256 色降级 | `set -s terminal-overrides ",*:Tc"` + `terminal-features ",xterm*:RGB"` |
| 剪贴板 | CLI 里复制不进系统剪贴板 | `set -s set-clipboard on` + feature `clipboard` |
| 括号粘贴 | 多行粘贴被当成逐条回车，Claude Code 连发多条 | feature `bpaste` |
| 透传 | OSC 8 超链接、OSC 9/777 通知全被吞 | `setw -g allow-passthrough on`（**窗口作用域**） |
| 焦点事件 | 切回来 TUI 不知道要重绘 | `set -s focus-events on` + feature `focus` |
| 扩展键 | 内层程序请求 modifyOtherKeys 时拿不到 | `set -s extended-keys on` |
| 按键延迟 | `Esc` 有 500ms 黏滞感 | `set -s escape-time 0` |
| **保活** | 刷新页面会话没了 | `destroy-unattached off` + `set -s exit-empty off` |

#### 一个必须纠正的说法：Shift+Enter 不靠 tmux 解决

我一开始的想法是"给 tmux 声明 `extkeys`，让它把扩展键转发给前端"。核对 `tty-features.c` 之后
这条要放弃：声明 `extkeys` 等于告诉 tmux **外层终端会解析 CSI u**，tmux 就会把这些序列发给我们；
而 xterm.js 5.5 并不解析 CSI u，结果是按键变乱 —— 比不声明更糟。

正确做法是把这一层收回到我们自己的前端：**Shift+Enter 直接发 `
`（Alt+Enter 语义）**，
Claude Code 认这个序列。它是普通字节，tmux 只当普通输入转发，`escape-time 0` 又保证了没有延迟。
好处是**这条逻辑两个后端完全一致** —— native 下能用，tmux 下也能用，不依赖 tmux 版本。

所以结论是：`extended-keys on` 保留（照顾内层主动请求的 TUI），但**不需要**为了让
Claude Code 好用而向外层声明 `extkeys`。这类"以为要配 tmux、其实该改前端"的点，
是这个项目最容易走偏的地方。

#### 怎么接（一条代码路径，不分支）

```
tmux -L terminals -f <生成的配置> new-session -A -s <sid> -c <cwd> -- env LANG=.. LC_ALL=.. <shell> -l
```

`-A` 是关键：**同名会话存在就 attach，不存在才新建。**
这样"新建"和"core 重启后认领"走的是同一条路径，少了一整类只在重启时才暴露的 bug。

配套的 `sessions.json` 落盘（`--state`，默认与 socket 同目录）只存四样：
`sid / cwd / created / tmux`。core 启动时读它，对每个 sid 跑一次 `tmux has-session`，
命中的就原地认领 —— **sid 不变**，所以前端 localStorage 里那个 sid 一连就接回来了，
用户看到的是"标签还在，`npm run dev` 还在输出"。

`-L terminals` 用独立 socket，不碰用户自己的 tmux。`kill-session` 在关标签时显式执行：
我们开了 `destroy-unattached off`，不显式清理就会留下永远跑着的孤儿 shell —— 那是泄漏，不是保活。

#### 代价（为什么不做默认）

| 代价 | 说明 |
| --- | --- |
| 概念冲突 | tmux 自己也有 pane 和前缀键，和我们 UI 的分屏叠在一起会让人困惑"这个分割是谁做的"。所以 `mouse off` + `status off`，把 tmux 压成透明层 |
| 版本门槛 | `extended-keys` 要 3.2+，`allow-passthrough` 要 3.3+，`sync` 要 3.4+。fnOS 自带的版本需要实测，低于 3.3 要提示降级而不是静默失效 |
| 一层额外进程 | 每个会话多一个 tmux 进程，几十 MB 内存量级。可以接受，但不再是"单进程" |
| 内层 TERM 不同 | 走 tmux 时内层看到 `tmux-256color`。极少数只看 TERM 字符串做判断的脚本会走不同分支 |

> **结论：`--backend native` 是默认，`tmux` 是可选的"扛升级"模式。**
> 两者对前端完全透明 —— 前端看到的始终是一个 PTY，不需要知道底下是谁。
> 实现已完成并通过交叉编译；**运行时验证要在飞牛上做**，本地没有 Linux 环境可跑 tmux。

---

## 4. 分屏架构

### 4.1 渲染模型

一个 pane = 一个 xterm 实例 + 一条独立 WebSocket + 一个独立 PTY。  
不是"一个大终端切成几块" —— 每个窗格都是完整独立的会话，可以各跑各的东西。

### 4.2 WebGL context 池（关键地雷）

浏览器对 WebGL context 有硬上限（Chrome 约 16 个，超出会静默丢弃最旧的）。  
32 个 pane 全开 WebGL 必然炸，症状是某些 pane 突然变黑或退化成极慢的 DOM 渲染。

策略：

| 可见 pane 数 | 渲染器分配                            |
| --------- | -------------------------------- |
| ≤ 4       | 全部 WebGL                         |
| 5–16      | 只有 active pane 用 WebGL，其余 canvas |
| > 16      | 全部 canvas，WebGL 关闭               |

切换时机：pane 获得焦点、tab 切换、pane 数量变化。切换时**不重建 xterm**，只换 renderer，  
并立即 `refresh(0, rows-1)` 重绘，避免闪白。

xterm 5.5 的 canvas renderer 性能对终端场景足够（2D canvas 主要是 fillText），  
只有超大滚动和极端重绘时和 WebGL 有差距。**宁可稳，不要为了炫技让第 5 个 pane 变黑。**

### 4.3 布局交互

- 拖拽分隔条调整比例，松手后写 layout（防抖 400ms）。
- 双击分隔条 = 均分。
- pane 边界有 4px 命中区（视觉上 1px 线），鼠标变 `col-resize` / `row-resize`。
- 关闭 pane 时把空间还给兄弟节点；只剩一个 leaf 时整个 tab 关闭（可配置）。
- 拖拽 pane 到另一个 pane 上 = 交换位置（M3）。

### 4.4 多客户端与 sid 抢占

同一个 sid 可能被两个浏览器同时打开（比如桌面和手机）。策略：

|   |   |
| - | - |

|   |   |
| - | - |

- attach 带 `mode=control | view`。
- 默认新建的都是 `control`。**新的 control 会抢占**，旧的降级为 view 并提示"已被其他窗口接管"。
- `view` 客户端只收输出，输入被丢弃并在状态栏提示"只读"。

这样不会出现两边同时输入导致命令交叉的灾难，语义也清楚。

---

## 5. 快捷键

### 5.1 现实约束

浏览器会抢走一部分按键，这是无法绕过的。分三类处理：

| 类别       | 例子                                           | 处理                                                                 |
| -------- | -------------------------------------------- | ------------------------------------------------------------------ |
| **能拦**   | `Ctrl+Shift+W`、`Alt+Shift+方向`、`Ctrl+Shift+P` | 直接 `preventDefault`，对齐 WT                                          |
| **拦不住**  | `Ctrl+W`、`Ctrl+T`、`Ctrl+N`、`Ctrl+Tab`、`F11`  | **换键位**，并在帮助面板里标注原因                                                |
| **全屏可解** | 上面那批                                         | 进入全屏后调用 `navigator.keyboard.lock()`，Chromium 下可捕获 `Ctrl+W/T/N/Tab` |

`navigator.keyboard.lock()` 需要全屏 + 用户手势，且仅 Chromium 系支持。Firefox/Safari 无解。  
所以默认键位必须**在完全不锁键盘的情况下也可用**，锁键盘是加分项不是前提。


### 5.2 键位表

| 功能           | Windows Terminal                | TerminalS 默认              | 说明                        |
| ------------ | ------------------------------- | ------------------------- | ------------------------- |
| 新建标签         | `Ctrl+Shift+T`                  | 同                         | 锁键盘后可用；未锁时用 `Alt+Shift+T` |
| 关闭标签         | `Ctrl+Shift+W`                  | 同                         | 有 pane 时先关 pane           |
| 下一个/上一个标签    | `Ctrl+Tab` / `Ctrl+Shift+Tab`   | `Alt+]` / `Alt+[`         | **`Ctrl+Tab` 浏览器强制拦截，放弃** |
| 跳到第 N 个标签    | `Ctrl+Alt+数字`                   | 同                         |                           |
| 垂直分屏         | `Alt+Shift++`                   | 同                         | 左右分                       |
| 水平分屏         | `Alt+Shift+-`                   | 同                         | 上下分                       |
| 关闭 pane      | `Ctrl+Shift+W`                  | 同                         |                           |
| pane 间移动     | `Alt+方向`                        | 同                         |                           |
| 调整 pane 大小   | `Alt+Shift+方向`                  | 同                         |                           |
| 最大化当前 pane   | `Ctrl+Shift+M`                  | 同                         | 临时全屏这个 pane               |
| 命令面板         | `Ctrl+Shift+P`                  | 同                         | 含命令历史检索                   |
| 搜索           | `Ctrl+Shift+F`                  | 同                         | 搜当前 pane 的滚动缓冲            |
| 字号           | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`  | 同                         |                           |
| 复制 / 粘贴      | `Ctrl+Shift+C` / `Ctrl+Shift+V` | 同                         |                           |
| 选中即复制        | 默认关                             | 默认关                       | 可开                        |
| 全屏           | `F11`                           | 工具栏按钮 + `Alt+Shift+Enter` | `F11` 被浏览器占用              |
| 重命名标签        | `Ctrl+Shift+,`                  | 同                         |                           |
| 广播输入到所有 pane | —                               | `Alt+Shift+B`             | WT 没有，多机运维时很有用            |

自定义：`keybindings.json` 一样的前端配置，存服务端，支持 `unbound` 和 `multi` 动作。  
shell 内的按键（`Ctrl+C/D/R/L/A/E/U/K/W`）必须**原样透传给 PTY**，任何情况下不拦截。

### 5.3 一个容易做错的点

`Alt+方向` 用于切 pane，但有些 CLI（如部分 TUI 编辑器）也用 `Alt+方向` 移动。冲突时以终端为准，  
并提供"透传模式"（`Ctrl+Shift+Alt+P`）临时禁用所有应用层快捷键，把按键全交给 PTY。

---

## 6. CLI 兼容性（重点：Claude Code）

Claude Code 基于 Ink（React for CLI），对终端能力的要求比 vim/htop 更挑剔。逐条对齐：

| 能力                            | 要求                    | 实现                                                 |
| ----------------------------- | --------------------- | -------------------------------------------------- |
| 24bit 真彩色                     | `COLORTERM=truecolor` | PTY 环境变量显式设置                                       |
| 256 色                         | `TERM=xterm-256color` | 同上                                                 |
| bracketed paste (DECSET 2004) | 多行粘贴靠它，**必须双向正确**     | 前端不禁用、不吞这个序列；粘贴时保留 2004 包裹                         |
| **DECRQM 查询**（`CSI ? Ps $ p`） | Ink 启动会查一堆能力          | **必须用 xterm 5.5.0**。6.0 处理 DECRQM 有 bug，全屏 CLI 会空白 |
| alt-screen                    | 全屏模式                  | 服务端跟踪 `ESC[?1049h/l`，重连时补入口                        |
| 同步输出 (DECSET 2026)            | 避免逐帧闪烁                | 验证 xterm 5.5 支持度，作为 M2 验收项                         |
| 高频局部重绘                        | 打字即重绘                 | 输出合并窗口取 **8ms**（不要 30ms，那会感觉卡）                     |
| 光标形状 (DECSCUSR)               | 输入模式切换                | xterm 原生支持，确保不被 CSS 覆盖                             |
| OSC 0/2 标题                    | 标签标题自动跟随              | 已计划                                                |
| 鼠标事件                          | 部分 TUI 用              | `onBinary` 处理 8 位序列                                |
| `isTTY` 检测                    | CLI 靠它判断能否交互          | PTY 天然满足                                           |
| 输入法                           | 中文输入                  | Unicode11 + locale 探测（见下）                          |

### 中文与字宽

三层都要做，缺一层就出问题：

1. **字宽**：`Unicode11Addon` + `term.unicode.activeVersion = '11'` + `allowProposedApi: true`  
   （5.x 里这是 proposed API，不开会静默无效）。
2. **locale**：core 启动时跑 `locale -a` 探测，优先 `zh_CN.UTF-8`，兜底 `C.UTF-8`，  
   同时设 `LANG` 和 `LC_ALL`。**不要继承父进程环境**（很容易是 POSIX）。
3. **字体**：自托管 woff2 子集（常用 7000 汉字 + 等宽拉丁），`font-display: block`，  
   **字体 ready 后再 `term.open()`**。否则字体晚到会让 cell 尺寸变化 → resize → PTY 重排 →  
   TUI 重绘两次，肉眼可见的抖动。

---

## 7. 命令历史

两层，分开做：

1. **shell 原生历史**：PTY 天然支持，上下箭头。不用管。
2. **应用层历史面板**：`Ctrl+Shift+P` 打开命令面板，一个输入框同时做三件事：
   - 模糊搜标签标题 → 跳转
   - 模糊搜历史命令 → 选中后**只注入到当前 pane，不自动回车**（安全，避免误执行）
   - 搜动作（分屏、主题、字号…）


历史来源：`~/.bash_history`、`~/.zsh_history`（注意 zsh 的 `extended_history` 格式），
按当前 pane 的 `cwd` 加权排序，同目录的历史排前面。

不做 block 级捕获（Warp 那种）—— 需要 shell 里注入 hook，会污染用户环境，不划算。

---

## 8. 协议

### 8.1 浏览器 ↔ ts-web

| 方向 | 类型 | 负载 |
|---|---|---|
| C→S | `0x01` INPUT | 原始键盘字节（UTF-8） |
| C→S | `0x02` RESIZE | `{"cols":N,"rows":M}` |
| C→S | `0x03` SIGNAL | `{"signal":"INT"}` |
| C→S | `0x04` ACK | `{"n":消耗块数}` |
| S→C | `0x01` OUTPUT | 原始终端输出 |
| S→C | `0x02` EXIT | `{"code":N,"signal":N}` |
| S→C | `0x03` READY | `{"sid","pane","shell","cwd","cols","rows","altScreen","needAltEnter","degraded","ghostHistory?"}` |
| S→C | `0x04` ERROR | 文本 |
| S→C | `0x05` CREDIT | `{"n":剩余窗口}` |
| S→C | `0x06` REVOKED | `{"reason":"taken_over"}` → 前端转只读 |

### 8.2 ts-web ↔ ts-core

同构帧 + envelope，首帧必须握手：

| 方向 | 类型 | 负载 |
|---|---|---|
| C→W | `0x7F` HELLO | `{"v":1,"role":"web"}` |
| W→C | `0x7E` HELLO_ACK | `{"v":1,"maxSessions":32}` |
| W→C | `0x12` CREATE | `{"cols","rows","cmd"}` |
| C→W | `0x20` META | `{"sid","pid","cwd","title",...}` |
| W→C | `0x10` ATTACH | `{"sid","mode":"control"}` |
| W→C | `0x11` DETACH | `{"sid"}` |
| W→C | `0x13` KILL | `{"sid"}` |
| W→C | `0x14` LIST | `—` |
| W→C | `0x15` SNAPSHOT | `{"sid"}` 立即落盘 |

版本号是硬门槛：**core 必须拒绝版本不匹配的 web**。否则升级时新旧错配会出现
"帧解析偏移一位"这种极难查的错。

### 8.3 流控：降级而不是踢人

1. 窗口充足 → 正常发送。
2. 窗口耗尽（degraded）→ 只发关键帧（EXIT / alt-screen 切换 / READY），普通输出丢弃并置 dirty。
   **PTY 读取绝不停**，否则一个慢客户端能把整个会话卡死。
3. 恢复 → 客户端 ACK 补回窗口后，发 `SIGWINCH` 让 TUI 自己重绘；普通 shell 则重放缓冲。

---

## 9. 目录结构

```
Terminal/
├── DESIGN.md
├── Cargo.toml                 workspace
├── core/                      不碰网络，只持 PTY
│   ├── src/session.rs         spawn / attach / alt-screen / SIGWINCH / reap
│   ├── src/ring.rs            环形回放缓冲
│   ├── src/snapshot.rs        快照落盘与读取
│   ├── src/ipc.rs             core↔web 协议
│   └── src/main.rs            unix socket，0600
├── web/                       可随时重启
│   ├── src/auth.rs            网关头 / Origin / 头剥离
│   ├── src/ws.rs              attach / 信用窗口 / 合并发送 / 心跳
│   ├── src/layout.rs          layout.json 读写
│   └── src/static.rs          CSP / 路径穿越防护
├── ui/                        TS
│   ├── src/terminal.ts        单 pane 会话
│   ├── src/layout.ts          分割树 / 拖拽 / 序列化
│   ├── src/tabs.ts            标签管理
│   ├── src/keys.ts            键位映射 + keyboard lock
│   ├── src/palette.ts         命令面板 / 历史检索
│   └── fonts/                 CJK 等宽 woff2 子集
├── pkg/                       fnpack：manifest / cmd / wizard / privilege / sudoers
└── tools/                     泄漏测试 / VT 回归 / 重连验证 / 分屏布局测试
```

---

## 10. 里程碑

### M1 — 单标签能用（不拆进程、不分屏）

- [x] 单 PTY，`stty size` 与浏览器一致（`stty size` 待 NAS 上实机确认）
- [x] 会话独立于浏览器连接：断线、刷新、关页面都不结束进程
- [x] 断线重连回放（环形缓冲 256KB）+ alt-screen 画面复原
- [x] 降权到管理员账户，`sudo -i` 可自行提权（见第 2 节）
- [x] `--backend tmux`：会话可扛住 core 重启，sid 不变，前端无感接回（见 3.3）
- [ ] vim / htop / btop / lazygit 正常
- [ ] **Claude Code 能正常跑**：打字不闪、粘贴多行正常、全屏切换正确
- [ ] 中文输入/退格/补全/文件名全对，中英混排光标对齐
- [ ] 已装字体、WebGL 渲染器、字体 ready 后再 open

> M1 不分屏、不拆进程。分屏和双进程都是放大器，会掩盖基础问题的信号。
>
> **已定：M1 就是单标签单进程。** 验收以"Claude Code 和中文都对"为硬门槛，
> 不是"能打开一个黑框"。

### M2 — 分屏 + 布局持久化（已完成）

- [x] 分割树：横竖任意嵌套，拖拽调比例，关闭 pane 自动折叠空节点
- [x] 布局写 `layout.json`，刷新后完整恢复（标签数、比例、标题、**sid**）
- [x] 每个 pane 独立 WS + 独立 PTY，互不干扰
- [x] 键盘：`Ctrl+Alt+T/W/=/-`、方向键移焦点、`Ctrl+Alt+[`/`]` 切标签
- [x] `backend = tmux` 开关（见 3.3）；**运行时验证**：kill core 后 tmux 会话仍在，重启后自动认领
- [ ] WebGL context 池的**复用**策略：当前只限制"前 4 个窗格用 WebGL"，不做释放与再分配
- [ ] 多客户端抢占语义（control/view + REVOKED）—— 服务端已有 REVOKED 帧，前端未接

> **实现取舍**：布局用「叶子 + 分割」的二叉树，`sizes` 存的是**比例**不是像素。
> 存像素的话换个屏幕宽度，分屏就全乱了。拖拽过程中只改 `flex-grow`，
> 松手才写回模型并重排 —— 否则每个 mousemove 都会让 TUI 重绘一次。
>
> 渲染不重建 DOM：结构变化时把已有的 `.pane` 节点**搬**进新结构里。
> 重建会连 xterm 的滚动历史一起丢掉，那正是用户最在意的"刚才的输出还在不在"。

### M1.5 — 上机验证（当前所在阶段）

这一阶段不加功能，目标只有两个：**能装上去**、**装上去之后能一眼看出哪里不对**。

- [x] `--data-dir`：布局/会话清单统一落在一个可写目录。
      修掉了 `layoutDir = "."` 这个隐患 —— CWD 为 `/` 时写失败且**静默**，
      表现是"刷新后分屏没了"，极难归因。
- [x] `--check` 自检：shell / locale / 降权账户 / tmux 版本与能力门槛 /
      数据目录真写入测试 / 端口绑定 / 是否绑 0.0.0.0，一次全报，退出码 2 表示有阻断项。
- [x] `tools/deploy.ps1`：探远端架构 → 上传 → 远端自检 → 后台拉起（setsid + nohup），
      默认 SSH 隧道模式，`-Lan` 才绑 0.0.0.0 并且打警告。
- [x] **fpk 安装包**：`tools/pack.ps1` 调官方 `fnpack` 出 x86 / arm，
      自带 `tools/fpkfix` 修正权限（见 14.3）。
- [ ] **在飞牛上跑一次 `--check` 并记录结果**（尤其 tmux 版本）
- [ ] 验收 M1 剩余的四项：vim/htop/lazygit、Claude Code、中文输入、字体与 WebGL 渲染

> fpk 比计划提前做了：原计划放 M4，但"能点图标打开"这件事对验收体验是前置条件 ——
> 手工 `ssh -L` 隧道再多一步，就很难判断"卡"到底是终端的问题还是隧道的问题。

### M3 — 体验对齐 Windows Terminal

- [ ] 完整键位表 + `keybindings.json`
- [ ] 全屏 + `navigator.keyboard.lock()`，`Ctrl+W/T/N/Tab` 可用
- [ ] 命令面板 + 历史检索（按 cwd 加权）
- [ ] 搜索、重命名标签、最大化 pane、广播输入
- [ ] 主题 / 字号记忆，跟随 fnOS 深浅色

### M4 — 可靠性

- [ ] 拆 core / web，`kill ts-web` 后会话存活
- [ ] 会话内 `catch_unwind`，单会话 panic 不影响其他
- [ ] 快照落盘 + 幽灵会话恢复（L3）
- [ ] 泄漏测试：500 次建销，RSS/fd/线程/僵尸无增长
- [ ] zmodem 上传下载 + 拖文件到 pane

---

## 11. 优化清单

### 性能

| 优先级 | 优化 | 为什么 |
|---|---|---|
| **P0** | 回放缓冲用**环形缓冲** | 原实现用 `Vec` 从头部删，O(n) 拷贝。256KB 缓冲高频输出时纯烧 CPU |
| **P0** | **输出合并窗口 8ms / 16KB** | TUI 每块单独成帧，帧数极高。但别超过 10ms，否则打字发黏 |
| **P0** | 显式**关闭 `permessage-deflate`** | ANSI 文本本来就"半压缩"，deflate 收益低而 CPU 高，是负优化 |
| **P0** | **WebGL context 池** | 见 4.2，这是分屏最容易踩的地雷 |
| **P1** | 自适应心跳（有输出时不发） | 数据本身即保活，空闲 45s 才发 |
| **P1** | 静态资源内容哈希 + 强缓存，仅 index.html no-cache | 对照 fnos-terminal 那个 1.28MB 单文件全量重传 |
| **P2** | PTY 读取改 `epoll`/`AsyncFd` 统一事件循环 | 32 会话省 32 线程，但复杂度明显上升 |

### 体验

| 优先级 | 优化 | 为什么 |
|---|---|---|
| **P0** | 字体 ready 后再 `term.open()` | 否则字体晚到导致 resize→PTY 重排→TUI 重绘两次，可见抖动 |
| **P0** | WebGL context loss **尝试重建** | 驱动重置会丢 context，原实现直接退回 canvas 再也回不来 |
| **P1** | 布局写入防抖 400ms + 原子替换（写临时文件再 rename） | 高频拖拽会写爆磁盘；直接覆盖可能写出半个 JSON |
| **P1** | 标签/pane 标题跟随 OSC + 手动重命名优先 | 自动标题有时是乱码路径 |
| **P2** | 移动端 `visualViewport` 处理软键盘 | 手机能用即可 |

### 安全

| 优先级 | 优化 | 为什么 |
|---|---|---|
| **P0** | **sid 不进 URL** | query 会进浏览器历史、Referer、网关访问日志 |
| **P0** | **会话归属校验** | 原项目都没有。管理员 A 拿 sid 就能看 B 的会话 |
| **P1** | 审计日志（不含终端内容） | 谁在何时开了几个会话，出事能查 |

### 可维护

| 优先级 | 优化 | 为什么 |
|---|---|---|
| **P0** | `panic = "unwind"` + 每会话 `catch_unwind` | 明确反着抄 nas-webterm 的 `panic = "abort"` |
| **P0** | 泄漏测试进 CI | 建销 500 次，盯 RSS/fd/线程/僵尸 |
| **P1** | `/api/metrics` 暴露会话数、RSS、fd、pane 数 | 让测试有断言依据 |
| **P1** | core↔web 协议版本号 + 拒绝错配 | 见 8.2 |

---

## 12. 风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| 浏览器占用 `Ctrl+W/T/N/Tab` | 键位无法 100% 对齐 WT | 默认键位避开，全屏 + keyboard lock 补齐，文档写明 |
| WebGL context 上限 | 多 pane 黑屏 / 退化 | context 池 + canvas 回落，M2 专项测试 17 pane |
| 快照"伪恢复"被误解为 bug | 用户以为进程还在 | 前端明确标注"上次残留，进程已结束" |
| 分屏后 resize 风暴 | 拖拽时疯狂发 resize 导致 TUI 卡顿 | resize 防抖 80ms，且只在松手时发最终尺寸 |
| `sudoers.d` 写坏 | 整机 sudo 失效 | `visudo -c` 校验失败即回滚，且有备份 |
| xterm 6.0 的 DECRQM bug | 全屏 CLI 空白 | 锁 5.5.0，升级前必须跑 VT 回归 |

---

## 13. 待决项

### 已定

| 项 | 结论 |
|---|---|
| 项目名 | TerminalS（应用名 `terminals`，二进制 `tsd`） |
| 权限默认 | `user` —— 管理员账户，**不写 sudoers**，要 root 自己 `sudo -i` |
| M1 范围 | 单标签、单进程 |
| 后端语言 | **Go 1.26**（见第 14 节） |
| tmux | `--backend tmux` 已实现，默认仍 `native`（见 3.3） |

### 待定

1. **tmux 版本门槛** —— 已由 `--check` 解决（会直接报版本和三项能力是否满足）。
   剩下的是"低于 3.3 时要不要做降级分支"，取决于飞牛实际版本号。
2. **cgroup 语义**：飞牛应用框架停服务时是杀进程树还是杀 systemd scope？
   如果是后者，**tmux 也救不了升级**（同 cgroup 一起死），3.3 的收益要重新评估。这条要在 NAS 上验。
3. zmodem 放 M4 还是提前。
4. 前端构建：Vite（推荐）还是 esbuild 手写。
5. **wizard 要不要做**：现在没有安装向导，降权账户靠自动探测 +
   `var/config.env` 覆盖。要不要在安装时让用户选账户，取决于实机上自动探测准不准。

---

## 14. 工具链现状

### 14.1 为什么是 Go 而不是 Rust

开发机是 Windows，目标产物是 Linux（x86_64 + aarch64）。实测：

| 工具 | 状态 |
|---|---|
| Node / npm / git | ✅ v22.22.2 / 10.9.7 / 2.55 |
| **Rust / cargo** | ❌ 未安装 |
| **WSL** | ❌ 被安全策略拦截（Program Blacklist），无法启动 |
| **Docker** | ❌ 未安装 |

这个组合决定了：**Rust 要在 Windows 上交叉编译到 Linux 很痛苦**（自备 musl/gnu 链接器，
无 WSL 兜底），只能"NAS 上编译再 scp"，M1 迭代成本高到不可接受。

**Go 在这个前提下几乎是量身定做**：一条命令就能在 Windows 上直接出 NAS 能跑的静态二进制，
零运行时依赖。本项目的瓶颈在 IO 和网络，不在 CPU，Go 的性能劣势无所谓；
每会话一个 goroutine 也比线程池自然。

Rust 只剩两个优势：二进制 3–5MB vs 8–12MB，内存更低。不值得为此付迭代成本。

### 14.2 已就绪的工具链

| 项 | 位置 / 版本 |
|---|---|
| Go | `.tools/go`（1.26.10 便携版，不动系统） |
| 前端依赖 | `ui/vendor/`（xterm 5.5.0 + fit + unicode11 + webgl，`npm pack` 离线解包，无构建步骤） |
| 产物 | `dist/tsd.exe` 9.9MB、`dist/tsd-linux-amd64` 10MB、`dist/tsd-linux-arm64` 9.3MB，前端已 `embed` 进二进制 |

`tools/build.ps1` 三平台一次出。交叉编译只需要设置 `GOOS` / `GOARCH` 两个环境变量，
再跑一次 `go build`，不需要链接器和 sysroot。

### 14.3 fnOS 打包（fpk）

用官方 `fnpack` 而不是手搓 tar。这个格式对文件顺序、权限、`cmd/` 里的脚本集合
都有隐含要求，手写出错的代价是"装得上但起不来"，且报错信息几乎没有。

```
fnpack create terminals   # 官方模板，结构以它为准
fnpack build --directory <stage>
```

包结构（对照官方模板核对过）：

```
package/
├── manifest               appname / version / platform / desktop_applaunchname ...
├── ICON.PNG (64)  ICON_256.PNG (256)
├── config/privilege       run-as: root —— 再由 tsd 自己降权到管理员账户
├── config/resource
├── cmd/main               start | stop | status
├── cmd/*_init|*_callback  8 个钩子，当前都是 exit 0
└── app/
    ├── bin/tsd            静态二进制
    └── ui/config           type=iframe + gatewayPrefix + gatewaySocket
```

**运行形态**：`type=iframe` + `gatewaySocket` 意味着网关把 `/app/terminals/*`
转发到 `target/gateway.sock`，**不占 TCP 端口**。所以 `cmd/main` 启动时传
`--socket`，而 `--socket` 又会自动打开 `--require-admin`（校验 `X-Trim-Isadmin`），
正好对上网关的注入行为。

#### 一个只有 Windows 打包才会踩的坑

NTFS 没有 unix 可执行位，`fnpack.exe` 把所有 tar 条目都写成 `0666`。
装到 NAS 上之后 `cmd/main` 不可执行 —— 应用中心显示安装成功，点启动毫无反应，
日志里也没有任何记录。**这个失败模式没有任何提示，只能靠提前处理。**

`tools/fpkfix` 在打包后重写 fpk 的 tar 头：`cmd/*` 与 `app/bin/tsd` 设 `0755`，
其余 `0644`，目录 `0755`；内层 `app.tgz` 一并处理（它的根是 `app/` 本身，
所以路径是 `bin/tsd` 而不是 `app/bin/tsd`，这点容易漏）。

在 Linux 上打包时 fnpack 自己会写对权限，本工具是幂等的，所以不构成平台分叉。

---

## 15. 参考

| 项目 | 借鉴 | 明确不借鉴 |
|---|---|---|
| [nas-webterm](https://github.com/Xinghe-0203/nas-webterm) | 会话模型、回放、alt-screen 恢复、Unicode11、locale 探测、二进制帧 | `panic = "abort"`、默认 root、sid 放 URL、踢慢客户端 |
| [fnos-terminal](https://github.com/Eric0101/fnos-terminal) | 降权启动器、Origin 校验、头剥离、剪贴板处理、zmodem | ttyd 的连接即进程模型、1.28MB 单文件页、nodejs_v22 依赖 |
| Windows Terminal | 分屏交互、键位体系、命令面板、UI 布局 | DirectWrite 渲染（Web 层做不到） |
