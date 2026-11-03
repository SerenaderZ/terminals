# TerminalS

A web terminal workspace for [fnOS](https://www.fnnas.com/) (Feiniu NAS). The goal is a local-terminal experience in the browser: multiple tabs, arbitrary splits, persistent layout, and sessions that survive a page reload — including full-screen CLIs like Claude Code.

One Go binary plus an xterm.js frontend, with every frontend asset embedded in the binary. Deployment is a single file.

[简体中文](README.md)

## Features

**Workspace**

- Multiple tabs, each with its own layout tree; hidden tabs simply stop rendering — their processes and sockets keep running
- Nested splits in any direction, drag the divider to resize, empty nodes collapse automatically
- Layout lives on the server: reload, close the window, or open from another device and you get **the same processes** back
- A vertical rail on each pane: the `×` at the top closes the pane, the track below is a hand-drawn scrollbar — drag it, click it, or just scroll

**Sessions**

- Long-lived PTY, `sid` reattach, and a 256 KB ring buffer — reconnect and the output continues where it left off
- Alt-screen tracking, so vim / htop / Claude Code redraw correctly after a reconnect
- Closing a pane kills the whole process tree, so background jobs never linger on the server
- Want to keep the process? `Shift` + click the `×` — the pane leaves the UI, the process keeps running, and you can reattach later
- Optional `--backend tmux`: sessions live in tmux and are re-adopted by `sid` after an application restart or upgrade

**Terminal behaviour**

- Runs as an unprivileged account by default; `sudo -i` inside the terminal if you need root — no sudoers file is ever written
- All shortcuts use `Ctrl+Alt` (`Ctrl+Shift+T/W` are taken by the browser, `Alt+Shift` is an IME hotkey on Windows)
- Right-click depends only on selection: with a selection it copies, without one it pastes — a single click either way; the selection is dropped right after copying, so copy → right-click → paste chains up
- Full-screen programs (vim, htop, Claude Code) capture the mouse; hold `Shift` while dragging to select, and the highlight survives the program's redraws
- Auto-copy on selection (can be disabled); `Ctrl+Shift+C/V` and `Ctrl+Insert`/`Shift+Insert` also work
- Settings are stored server-side: theme, font size, cursor blink, WebGL toggle, scrollback, copy-on-select
- The connection indicator is a button: when disconnected, hover to see the reason, whether the server itself is alive, and the countdown to the next retry; click to reconnect immediately

## Install

### On fnOS

Download the `.fpk` for your architecture from [Releases](https://github.com/SerenaderZ/terminals/releases):

| File | Target |
|---|---|
| `terminals_<version>_x86.fpk` | Intel / AMD — N100, N305, J4125 and most other boxes |
| `terminals_<version>_arm.fpk` | ARM — RK3588-class boards |

**App Center → Settings → Manual install**, then pick the package. Open it from the desktop; the entry point is `/app/terminals`.

The service is exposed through a unix socket handed to the fnOS gateway, so it occupies no TCP port.

### From source

Go 1.23 or newer:

```bash
git clone https://github.com/SerenaderZ/terminals.git
cd terminals
go run ./cmd/tsd
# open http://127.0.0.1:18086/
```

On Windows it launches `powershell.exe` over ConPTY — useful for exercising the frontend/backend link, but CJK rendering and TUI behaviour must be verified on Linux.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+T` / `W` | New tab / close current pane |
| `Ctrl+Alt+=` / `-` | Split right / split down |
| `Ctrl+Alt+←↑↓→` | Move focus by direction |
| `Ctrl+Alt+[` `]` / `1..9` | Switch tabs |
| `Ctrl+Alt+K` | Clear screen including scrollback |
| `Ctrl+Alt+Q` | Close all sessions |
| `Ctrl+Alt+,` | Settings |
| `Ctrl+Shift+C/V` | Copy / paste |
| `Ctrl+Insert` / `Shift+Insert` | Copy / paste (browsers leave these alone — most reliable) |
| `Ctrl+V` | Native browser paste |
| `Ctrl+=` / `-` / `0` | Font size up / down / reset |
| `Shift+Enter` | Send `ESC CR` — newline without submitting in Claude Code |

Mouse: `Shift` + click the pane's `×` moves it out of the UI but keeps the process; click the status light to reconnect.

## Configuration

| Flag | Default | Description |
|---|---|---|
| `--listen` | `127.0.0.1:18086` | TCP listen address |
| `--socket` | empty | Unix socket path; when set, no TCP listener is created |
| `--base` | empty | Gateway prefix, e.g. `/app/terminals` |
| `--shell` | platform default | `/bin/bash -l` on Linux, `powershell.exe` on Windows |
| `--cwd` | target account home | Falls back automatically when unavailable |
| `--run-as` | auto-detected | Account to drop privileges to |
| `--backend` | `native` | `native` owns the PTY; `tmux` survives application restarts |
| `--data-dir` | see below | Where `layout.json` and `sessions.json` live |
| `--max-sessions` | 32 | Limit applies to new sessions only; running ones are never killed |
| `--replay-kb` | 256 | Replay buffer size |
| `--check` | false | Run environment checks and exit |

`--data-dir` resolves in order: the `--socket` directory → `$TERMINALS_DATA` → `~/.local/state/terminals` (Linux) / `%APPDATA%\terminals` (Windows).

When installed as an app, you can pin runtime options in `/var/apps/terminals/var/config.env`:

```bash
RUN_AS=yourname
BACKEND=tmux
# TERMINAL_SHELL=/bin/bash
# TERMINAL_CWD=/vol1/1000
```

Restart the app afterwards.

## Build and package

```powershell
.\tools\build.ps1           # static linux/amd64 + linux/arm64 binaries into dist/
.\tools\pack.ps1 -Arch both # build both x86 and arm .fpk packages
```

Packaging uses fnOS's official `fnpack` (downloaded automatically), not a hand-rolled tar. Two things will bite you:

1. **Packing on Windows drops the executable bit.** NTFS has no unix mode bits, so `fnpack` writes everything as `0666` — `cmd/main` is then non-executable, and the app installs fine but "Start" does nothing and the log stays empty. The pipeline therefore always runs `tools/fpkfix`, which rewrites the tar headers to `0755` for `cmd/*` and `app/bin/tsd`.
2. **Everything under `cmd/` must use LF line endings.** CRLF makes bash report `bad interpreter`. `pack.ps1` checks before packing and fails on any CR.

## Project layout

```
cmd/tsd/            entry point (flags, self-check, signals)
internal/diag/      --check environment probe
internal/proto/     frame protocol constants
internal/session/   PTY session management (ring / alt / manager / pty / tmux / user / probe)
internal/server/    HTTP + WebSocket + layout storage
ui/                 frontend (xterm 5.5.0, embedded into the binary)
package/            fnOS package source tree
tools/              build, package, deploy and test scripts
DESIGN.md           architecture notes
docs/               troubleshooting and implementation notes
```

## Troubleshooting

Full version: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). The usual suspects:

**404 on open** — the desktop entry and the server prefix disagree. Since 0.1.1 the server adds the trailing slash and also tolerates the gateway stripping the prefix. To isolate it, ask the backend directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  --unix-socket /var/apps/terminals/target/gateway.sock http://localhost/app/terminals/
```

A 200 means the service is fine and the problem is in the gateway forwarding.

**`fork/exec /bin/bash: no such file or directory`** — usually not a missing shell, but a missing working directory. Go reports `ENOENT` for a failed child `chdir` too, and wraps it in the same message. The server falls back through `--cwd` → account home → `$HOME` → `/tmp` → `/`.

**Ghost characters after a TUI exits** — press `Ctrl+Alt+K` first. If it keeps happening, run `__ts.diag()` in the console and compare each pane's xterm size against the PTY size.

**LAN access shows "disconnected" while remote access works** — the gateway strips the port from `Host`, so the origin check treated it as cross-site. The check now compares full `host:port` first, then falls back to the hostname. `/api/wscheck` exposes the verdict.

## Known limitations

- Output flow control is "drop frames when the queue is full" — slow clients may lose output
- With `native`, restarting the service loses all sessions; use `--backend tmux` if that matters
- WebGL is used for the first 4 panes only; the rest fall back to canvas (browsers cap contexts around 16 and silently drop the oldest)
- The layout is one per workspace, not per user — two admins editing at once will overwrite each other
- Over plain HTTP the browser exposes no clipboard API: right-click pastes what this page copied last, use `Ctrl+V` for content copied elsewhere
- The Windows backend is for development only, with no promise of a good experience

## License

MIT — see [LICENSE](LICENSE).

## Author

[SerenaderZ](https://github.com/SerenaderZ)
