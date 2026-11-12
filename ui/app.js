/*
 * TerminalS 前端。
 *
 * 结构：Workspace（标签集合）→ Tab（一棵布局树）→ Pane（一个 xterm + 一条 WS）。
 * 布局树的每个叶子对应一个真实会话，sid 存在服务端的 layout.json 里，
 * 所以换浏览器、换设备看到的都是同一套分屏结构，点开就能接回原来的进程。
 */
(function () {
  'use strict';

  // 与服务端 internal/proto 一一对应
  var C = { INPUT: 0x01, RESIZE: 0x02, SIGNAL: 0x03, ACK: 0x04, QUIET: 0x05 };
  var S = { OUTPUT: 0x01, EXIT: 0x02, READY: 0x03, ERROR: 0x04, CREDIT: 0x05, REVOKED: 0x06 };

  var BASE = location.pathname.endsWith('/')
    ? location.pathname
    : location.pathname.replace(/[^/]*$/, '');
  var API = BASE + 'api/';
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API + 'ws';

  var ACTIVE_KEY = 'terminals.active.v1';
  // 和服务端 internal/config 里的边界保持一致，否则会出现
  // "本地能调到 8，保存时被服务端打回"的割裂感。
  var FONT_MIN = 10;
  var FONT_MAX = 24;

  // 设置的主副本在服务端（<数据目录>/settings.json），这里是缓存：
  // 刷新时先用它立即上色，避免先闪一下深色再切到浅色。
  var SETTINGS_KEY = 'terminals.settings.v1';
  var SETTINGS_DEFAULT = {
    theme: 'dark',
    fontSize: 14,
    webgl: true,
    cursorBlink: true,
    scrollback: 10000
  };

  function cachedSettings() {
    var out = {}, k;
    for (k in SETTINGS_DEFAULT) out[k] = SETTINGS_DEFAULT[k];
    try {
      var raw = JSON.parse(load(SETTINGS_KEY) || '{}');
      for (k in out) {
        if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
      }
    } catch (e) { /* 坏数据就用默认 */ }
    return out;
  }

  // 首屏上色必须早于任何 DOM 渲染，否则会看到一次深色闪变。
  var sett = cachedSettings();
  document.documentElement.dataset.theme = sett.theme;

  // 浏览器 WebGL context 上限约 16 个，超了会静默丢最旧的，表现是某个窗格黑屏。
  // 所以只在窗格总数不超过这个数时才启用 WebGL，宁可用 canvas 慢一点。
  var WEBGL_MAX = 4;

  var FONT_STACK =
    '"Cascadia Mono","Sarasa Mono SC","Noto Sans Mono CJK SC","Microsoft YaHei Mono",' +
    '"Consolas","DejaVu Sans Mono",monospace';

  var LIGHT_THEME = {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#1f1f1f',
    cursorAccent: '#ffffff',
    // 选区底色由我们自己画（installSelectionLayer），这里必须是全透明 ——
    // 两层都画的话叠起来会明显偏深，看着像选中了两次。
    selectionBackground: 'rgba(0,0,0,0)',
    selectionInactiveBackground: 'rgba(0,0,0,0)'
  };

  var DARK_THEME = {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    // 同上：选区底色自己画，这里留空。
    selectionBackground: 'rgba(0,0,0,0)',
    selectionInactiveBackground: 'rgba(0,0,0,0)',
    black: '#0c0c0c',
    red: '#e5534b',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#4c8dff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#cccccc',
    brightBlack: '#666666',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79b8ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc'
  };

  // ------------------------------------------------------------------ 工具

  function $(id) { return document.getElementById(id); }

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }
  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function uid(prefix) {
    var s = '';
    for (var i = 0; i < 6; i++) s += Math.floor(Math.random() * 16).toString(16);
    return prefix + s;
  }

  function banner(text, kind) {
    var el = $('banner');
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.className = kind || '';
    el.hidden = false;
    if (kind === 'warn' || kind === 'error') {
      clearTimeout(banner._t);
      banner._t = setTimeout(function () { el.hidden = true; }, 6000);
    } else if (kind === 'ok') {
      // 成功提示一闪即走：复制这类动作用户只需要一个"确实生效了"的确认，
      // 不希望它挂在屏幕下方挡着终端。
      clearTimeout(banner._t);
      banner._t = setTimeout(function () { el.hidden = true; }, 1400);
    } else if (kind === 'info') {
      // 进行中的状态（正在重连）同样是临时的，不能像普通提示那样一直挂着。
      clearTimeout(banner._t);
      banner._t = setTimeout(function () { el.hidden = true; }, 2500);
    } else if (kind === 'ask') {
      // 需要用户动手的提示（"按 Ctrl+V 粘贴"）。比 info 久一点：
      // 2.5 秒不够人把手从鼠标挪到键盘，提示已经没了。
      clearTimeout(banner._t);
      banner._t = setTimeout(function () { el.hidden = true; }, 5000);
    } else {
      // 没指定 kind 的普通提示。这里以前什么都不做 —— 于是每一条都会永久
      // 挂在底边上，点了「结束全部」之后的「已结束 N 个会话」就是这么赖着
      // 不走的。默认 4 秒：比 ok 长（不是一闪而过的动作确认），比 warn 短
      // （也不是要人处理的错误）。有意要常驻的提示必须显式说明，不能靠漏传。
      clearTimeout(banner._t);
      banner._t = setTimeout(function () { el.hidden = true; }, 4000);
    }
  }

  function el(tag, cls) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
  }

  // 应用内剪贴板：记住本页最近一次复制出去的文字。
  //
  // 存在的唯一理由是非安全上下文（http 直连 IP）读不到系统剪贴板，
  // 而"选中 → 右键复制 → 点空白 → 右键粘贴"是终端里最常见的动作，
  // 这一段完全可以在页面内部闭环 —— 内容就是刚复制的那段，不会错。
  //
  // 两个失效条件：
  //   - 页面失焦（用户去了别的窗口，很可能复制了别的东西）；
  //   - 超过两分钟（陈年旧内容，粘上去只会莫名其妙）。
  // 任何一条命中就作废，右键退回"弹浏览器原生菜单"，宁多多点一次也别粘错。
  var innerClip = null;
  var INNER_CLIP_TTL = 120000;

  // 拖选结束之后的这个窗口里，程序发来的 OSC 52 都当作"它在回放这次拖选"。
  //
  // 程序收到鼠标报告就知道你选了东西，会立刻发一条自己的复制序列；如果链路
  // 稍慢（远程 SSH、手机热点），这条序列可能在你下一次按下鼠标时才到。窗口
  // 给宽一点也无妨：真要让程序复制东西（vim 的 y、tmux 的插件），通常不会
  // 卡在你松手后两秒内。
  var DRAG_ECHO_MS = 2000;

  function rememberClip(text) {
    if (!text) return;
    innerClip = { text: text, at: Date.now() };
  }

  function readInnerClip() {
    if (!innerClip) return '';
    if (Date.now() - innerClip.at > INNER_CLIP_TTL) {
      innerClip = null;
      return '';
    }
    return innerClip.text;
  }

  window.addEventListener('blur', function () { innerClip = null; });

  // base64Text 把 OSC 52 的负载解成字符串。
  //
  // 程序一般按 UTF-8 编码后再 base64，所以先还原成字节再解码 —— 直接
  // atob 出来的字符串按 UTF-16 处理，中文会全变成乱码。负载里也可能出现
  // URL-safe 的 -_ 变体，顺手换回来。解不出来就返回空串，让调用方当作
  // "这条序列没有内容"跳过。
  function base64Text(b64) {
    try {
      var bin = window.atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
      var len = bin.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return ''; }
  }

  // baseName 取路径最后一段，后台清单里用它当没有标题时的显示名。
  function baseName(p) {
    if (!p) return '终端';
    var s = String(p).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    var out = i >= 0 ? s.slice(i + 1) : s;
    return out || s || '终端';
  }

  function agoText(ts) {
    if (!ts) return '';
    var d = Math.floor(Date.now() / 1000) - ts;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // splitBoot 把一段回放的"启动清屏"和"画面内容"分开。
  //
  // 接手一条老记录时，回放开头是一串只改状态、不上屏的字节：服务端自己加
  // 的复位前缀（ESC[0m ESC[?7h ESC[H ESC[2J ESC[3J），紧接着是新 shell 的
  // 启动输出（PowerShell 还会打几十个空行把屏幕腾出来，里面又带一次清屏）。
  // 这段必须先单独执行掉 —— 直接接在历史后面写，那几下清零就把刚铺好的
  // 历史擦没了。
  //
  // 做法是从头一路吃掉"看不见的"字节，直到第一个会显示出来的字符为止；
  // 中途见过清屏（ED 2 / ED 3）才认为这一段是启动清屏，否则整段都算内容
  // （bash 起来通常就是这种情况，前面直接是提示符）。
  function splitBoot(s) {
    if (!s) return { head: '', rest: '' };
    var invis = /^(?:\x1b\[[0-9;?]*[HfJmKhl]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\n]|\x07)/;
    var i = 0, sawClear = false;
    // 上限只是防呆：正常启动输出也就几十截。
    for (var k = 0; k < 4000; k++) {
      var mm = invis.exec(s.slice(i, i + 4096));
      if (!mm) break;
      if (mm[0].indexOf('J') >= 0) sawClear = true;
      i += mm[0].length;
    }
    if (!sawClear) return { head: '', rest: s };
    return { head: s.slice(0, i), rest: s.slice(i) };
  }

  // shortTitle 把"程序给自己设的窗口标题"收拾成能放进标签栏的样子。
  //
  // 只处理一种情况：整个标题就是一个路径（盘符或 / 开头、没有空格）。
  // PowerShell 的 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  // 属于这一类。像 "vim - /etc/nginx/nginx.conf" 这种带说明的标题不动。
  function shortTitle(t) {
    var s = String(t == null ? '' : t).trim();
    if (!s) return s;
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(s) && !/\s/.test(s)) {
      var b = baseName(s).replace(/\.(exe|com|bat|cmd)$/i, '');
      if (b) return b;
    }
    return s;
  }

  // ---- 历史记录列表用到的几个小工具 ----

  // histTitle 就是"那次会话的第一条命令"，后端在用户敲下回车时记下来的。
  //
  // 以前这里取的是终端标题（OSC 0/2），但那个名字是程序随手设的：npm 跑起来
  // 会短暂把标题改成 npm，PowerShell 更是直接设成 exe 的全路径。用户要的是
  // "按我输入的第一条指令命名"，所以现在标题只有一个来源 —— 第一条命令。
  //
  // 两个例外仍然要兜：0.3.1 之前留下的记录没有命令标题；崩溃后从日志恢复
  // 出来的记录也可能没有。那就退回目录名，总比一片空白强。
  function histTitle(it) {
    var t = it && it.title ? String(it.title).trim() : '';
    if (t) {
      // 老记录里可能存着整条 exe 路径，取文件名。
      if (/[\\/]/.test(t) && !/\s/.test(t)) t = baseName(t).replace(/\.(exe|com|bat|cmd)$/i, '');
      if (t) return t;
    }
    var b = baseName(it && it.cwd);
    if (b) return b;
    var s = it && it.shell ? baseName(it.shell) : '';
    return (s || '终端').replace(/\.(exe|com|bat|cmd)$/i, '');
  }

  // histWhen 是列表显示、排序、分组统一用的时间：关闭过就是关闭时间，
  // 还在跑就是最后一次活动时间。和后端 Entry.When() 是同一套规则 ——
  // 用户要的"以我最后关闭那个窗口的时间为准"。
  function histWhen(it) {
    if (!it) return 0;
    if (it.ended) return it.ended;
    if (it.touched) return it.touched;
    return it.created || 0;
  }

  function baseName(p) {
    if (!p) return '';
    var s = String(p).replace(/[\\/]+$/, '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function histSub(it) {
    var parts = [];
    if (it.cwd) parts.push(it.cwd);
    if (typeof it.bytes === 'number' && it.bytes > 0) parts.push(fmtBytes(it.bytes));
    return parts.join(' · ');
  }

  function histClock(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    var g = histDayGroup(ts);
    if (g === '今天') return hh + ':' + mm;
    if (g === '昨天') return '昨天 ' + hh + ':' + mm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
  }

  // histDayGroup 按"自然日"分组，不按 24 小时 —— 凌晨 0:30 和前一天
  // 23:30 差不到一小时，但用户心里那是两天。
  function histDayGroup(ts) {
    var d = new Date(ts * 1000);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((today - that) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return '最近 7 天';
    return '更早';
  }

  function histEmpty(text) {
    var d = el('div', 'hist-empty');
    d.textContent = text;
    return d;
  }

  // ------------------------------------------------------------- 单个 pane

  function Pane(ws, spec) {
    this.ws = ws;
    this.id = spec.id || uid('p');
    this.sid = spec.sid || null;
    this.title = spec.title || '终端';
    // 从历史记录打开时，连上之后再把这那一次的输出铺上去（见
    // Session.loadHistory）。historyId 传给 Session，由它在 READY 之后处理。
    this.historyId = spec.historyId || null;
    this.exited = false;
    this.focused = false;
    this.el = null;
    this.host = null;
    this.session = null;
  }

  // mount 只在创建时调用一次。之后无论布局怎么变，都只是把这个
  // el 挪来挪去 —— 不能重建，重建就等于把 xterm 连同回放一起扔掉。
  Pane.prototype.mount = function () {
    var self = this;
    var useWebgl = this.ws.paneCount() < WEBGL_MAX;

    this.el = el('div', 'pane');
    this.el.dataset.pane = this.id;
    // 先标成"连接中"：Session 构造时就会 setState，那会儿这个窗格还没
    // 进 tab.panes，聚合状态读不到它，会短暂显示成"已连接"。
    this.el.dataset.state = 'connecting';

    this.host = el('div', 'terminal-host');
    this.el.appendChild(this.host);
    this.mountRail();

    this.session = new Session({
      owner: this.ws,
      fontSize: this.ws.settings.fontSize,
      cursorBlink: this.ws.settings.cursorBlink,
      scrollback: this.ws.settings.scrollback,
      sid: this.sid,
      webgl: useWebgl && this.ws.settings.webgl,
      historyId: this.historyId,
      onScroll: function () { self.scheduleScrollSync(); },
      onState: function (state) {
        self.el.dataset.state = state;
        self.ws.setStatus();
      },
      onTitle: function (title) {
        self.title = title;
        self.ws.onPaneTitle(self);
      },
      onExit: function () {
        self.exited = true;
        self.el.classList.add('exited');
        self.ws.onPaneExit(self);
      },
      onReady: function (info) {
        // 服务端可能重建了会话（旧进程已退出），sid 变了要写回布局，
        // 否则下次刷新会拿着一个死 sid 去连。
        if (info.sid && info.sid !== self.sid) {
          self.sid = info.sid;
          self.ws.save();
        }
        self.setAlt(!!info.altScreen);
      },
      // 全屏标记跟着"这一格是否被全屏程序占着"走，而不是跟着"最后一次连接
      // 时的状态"走 —— 否则切到别的窗格、或者 vim 退出，标记都会停在原地。
      onAlt: function (on) { self.setAlt(on); },
      // 终端自己接管的拖动会把 mousedown 就地 stopPropagation（不然 xterm
      // 和里面的程序会重复选一遍），事件因此传不到本 pane 的 mousedown 监听，
      // 蓝框就永远停在原来那一格 —— 分屏后点另一个窗格，它还是"没被选中"。
      // 所以接管的时候得自己喊一声，把焦点和蓝框一起带过来。
      onGrab: function () {
        if (!self.focused || self.ws.activePane() !== self) self.ws.focusPane(self);
        else self.session.focus();
      }
    });

    this.session.mountSection(this.host);

    this.el.addEventListener('mousedown', function () {
      self.ws.focusPane(self);
    });

    // 滚轮统一由这里接管（捕获阶段，事件到 xterm 之前就被拦下）。
    //
    // 三个原因：
    //   1) 鼠标停在右侧轨道或 × 上时，事件根本落不到 xterm 的 viewport，
    //      用户的感觉是"这一格滚不动，只能拿鼠标去拖滑块"；
    //   2) 触摸板的小增量需要自己累积，见 scrollByWheel；
    //   3) 滚哪一格，焦点就跟到哪一格 —— 不用先点一下再滚。
    // 备用屏幕（vim/htop/claude）里 canScroll 为 false，直接放行给 xterm，
    // 让它把滚轮翻译成方向键发给程序。
    this.el.addEventListener('wheel', function (e) {
      if (!self.session || !self.session.canScroll()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!self.focused) self.ws.focusPane(self, true);
      self.session.scrollByWheel(e);
    }, { passive: false, capture: true });

    return this.el;
  };

  // 每个窗格右侧一条竖轨道：最上面一个 ×（关掉这个窗格），下面是自己画的滚动条。
  //
  // 为什么不用 xterm 自带的原生滚动条：
  //   1) 原生滚动条没法在它顶端腾出一个按钮的位置；
  //   2) 宽度和配色各浏览器不一致，深色主题下经常"看不见"，用户以为不能翻。
  // 轨道用 flex 占一列，而不是绝对定位盖在终端上 —— 盖住最右一列字，而且那一列
  // 的点击会落到轨道上，光标点不过去。
  Pane.prototype.mountRail = function () {
    var self = this;

    this.rail = el('div', 'pane-rail');
    // 点轨道不算点终端，别去抢焦点。
    this.rail.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    this.closeEl = el('button', 'pane-close');
    this.closeEl.type = 'button';
    this.closeEl.title = '关闭这个窗格（按住 Shift 点：移到后台，里面的程序继续跑）';
    this.closeEl.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      // Shift + 点 = 移出界面但保留进程，见 detachPane。
      self.ws.closePane(self, { detach: e.shiftKey });
    });

    this.track = el('div', 'pane-track');
    this.thumb = el('div', 'pane-thumb');
    this.track.appendChild(this.thumb);

    this.rail.appendChild(this.closeEl);
    this.rail.appendChild(this.track);
    this.el.appendChild(this.rail);

    this.track.addEventListener('mousedown', function (e) {
      var sess = self.session;
      if (!sess) return;
      var box = self.track.getBoundingClientRect();
      var thumbH = self.thumb.offsetHeight;
      if (!box.height || !thumbH) return;
      e.preventDefault();
      e.stopPropagation();

      var span = Math.max(1, box.height - thumbH);
      var startTop = parseFloat(self.thumb.style.top) || 0;
      var startY = e.clientY;

      // 点在空白轨道上：先把视图跳到手指位置，再接着当拖动 ——
      // 这样"点一下翻一屏"和"按住拖"是同一个手势，不用分两套逻辑。
      if (!self.thumb.contains(e.target)) {
        startTop = Math.max(0, Math.min(span, e.clientY - box.top - thumbH / 2));
        sess.scrollToRatio(startTop / span);
        self.thumb.style.top = startTop + 'px';
      }

      self.draggingThumb = true;
      self.thumb.classList.add('dragging');

      function move(ev) {
        var top = Math.max(0, Math.min(span, startTop + (ev.clientY - startY)));
        self.thumb.style.top = top + 'px';
        sess.scrollToRatio(top / span);
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        self.draggingThumb = false;
        self.thumb.classList.remove('dragging');
        self.syncScroll();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };

  // syncScroll 把 xterm 的视口位置画成滑块的 top/height。
  // 备用屏幕（vim/htop/claude）没有回看缓冲，scrollMetrics 返回 null，滑块直接藏掉。
  Pane.prototype.syncScroll = function () {
    if (!this.thumb || !this.track || this.draggingThumb) return;
    var st = this.session && this.session.scrollMetrics();
    // 轨道高度会触发一次同步 layout，输出洪流里每帧读一次不划算，
    // 缓存到下一次 fit（窗口/分屏尺寸变化都由 fit 兜住）。
    if (!this._trackH) this._trackH = this.track.clientHeight;
    var trackH = this._trackH;
    if (!st || trackH <= 0) { this.thumb.hidden = true; return; }

    var h = Math.round(trackH * st.rows / (st.max + st.rows));
    h = Math.max(18, Math.min(trackH, h));
    var top = Math.round((trackH - h) * (st.top / st.max));
    top = Math.max(0, Math.min(trackH - h, top));

    this.thumb.hidden = false;
    this.thumb.style.height = h + 'px';
    this.thumb.style.top = top + 'px';
  };

  // 输出洪流里每来一块数据都算一次位置太浪费，合并到一帧里做。
  Pane.prototype.scheduleScrollSync = function () {
    if (this._scrollRaf) return;
    var self = this;
    this._scrollRaf = requestAnimationFrame(function () {
      self._scrollRaf = 0;
      self.syncScroll();
    });
  };

  // setAlt 记下"这一格是不是被全屏程序占着"，焦点在这一格时同时刷标题栏。
  // 记在 Pane 上而不是全局，是因为分屏后每个窗格各有各的状态：一格在跑
  // Claude Code，另一格是普通 shell，徽章只能反映焦点那一格。
  Pane.prototype.setAlt = function (on) {
    this.alt = !!on;
    if (this.focused) this.ws.setAlt(this.alt);
  };

  Pane.prototype.focus = function () {
    this.focused = true;
    this.el.classList.add('focused');
    this.ws.setStatus();
    this.ws.setAlt(!!this.alt);
    this.session.focus();
  };

  Pane.prototype.blur = function () {
    this.focused = false;
    this.el.classList.remove('focused');
    this.session.blur();
  };

  Pane.prototype.fit = function () {
    this.session.fit();
    // fit 之后行列变了，滑块长度得跟着重算；轨道高度可能也变了。
    this._trackH = 0;
    this.scheduleScrollSync();
  };

  // connect 一律直接连。历史记录由 Session 在收到 READY 之后再铺 ——
  // 先连后铺是因为新会话的回放（shell 的欢迎语）会在 READY 之后立刻到达，
  // 而 READY 分支会 reset 一次屏幕；先铺的历史会被这一次 reset 清掉。
  Pane.prototype.connect = function () {
    this.session.connect();
  };

  Pane.prototype.dispose = function () {
    if (this._scrollRaf) { cancelAnimationFrame(this._scrollRaf); this._scrollRaf = 0; }
    this.session.dispose();
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };

  // ------------------------------------------------------------- Session

  // closeReason 把 WebSocket 的关闭码翻成一句人话。
  //
  // 1006 是最常见的那个，也是最没信息量的：握手没完成、连接被硬中断、
  // 网关把空闲连接掐了，在浏览器这边长得完全一样，连服务端日志都不一定有。
  // 所以这条文案如实说"不知道具体原因"，再由探活（GET /api/healthz）
  // 去区分是服务整个没了，还是只有 WebSocket 这条路不通。
  function closeReason(ev) {
    var code = ev && typeof ev.code === 'number' ? ev.code : 0;
    var reason = (ev && ev.reason) || '';
    var msg;

    switch (code) {
      case 1000: msg = '连接被正常关闭'; break;
      case 1001: msg = '服务端关闭了连接（应用可能正在重启或已经停止）'; break;
      case 1005: msg = '连接被关闭，没有给出原因'; break;
      case 1006: msg = '连接异常中断：服务没有响应，或连接被网关掐断'; break;
      case 1008: msg = '服务端拒绝了连接（来源校验没通过，或会话已被别的窗口接管）'; break;
      case 1011: msg = '服务端内部错误'; break;
      case 1012: msg = '服务端正在重启'; break;
      case 1013: msg = '服务端繁忙，拒绝了新连接'; break;
      case 1015: msg = 'TLS 握手失败'; break;
      default:
        msg = code ? ('连接已关闭，代码 ' + code) : '连接已关闭';
    }

    if (reason) msg += '：' + reason;
    return msg;
  }

  function Session(opts) {
    this.opts = opts;
    this.sid = opts.sid || null;
    this.term = null;
    this.fitAddon = null;
    this.host = null;
    this.ws = null;
    this.retry = 0;
    this.retryTimer = null;
    this.disposed = false;
    this.exited = false;
    this.pendingAltEnter = false;
    this.resizeTimer = null;
    this.fontSize = opts.fontSize;
    this.cursorBlink = opts.cursorBlink !== false;
    this.scrollback = opts.scrollback || 10000;
    // owner 是 Workspace：字号、主题这类全局设置由它统一分发，
    // 一个窗格改完所有窗格一起变。
    this.owner = opts.owner || null;
    this.webgl = null;
    this.focused = false;
    this.bufSub = null;
    // PTY 侧的真实行列数（来自 READY 帧）。它和 term.cols/rows 一旦不一致，
    // 全屏 TUI 就会在错误宽度上排版 —— 退出时留在屏幕上的就是错位残字。
    this.ptyCols = 0;
    this.ptyRows = 0;
    // everWrote 记录"这一格屏幕上曾经落过东西"。重连时只要它为真，就必须
    // 先清屏再灌回放 —— 单看服务端是否带回放不够，回放为空的情形下同样是
    // 旧画面摞新画面。
    this.everWrote = false;
    // fitted 表示 term 的行列数是按真实 DOM 布局算出来的。没 fit 之前
    // 它只是 xterm 的默认 80x24，任何"报给服务端"的动作都必须先看这个。
    this.fitted = false;
    // 布局稳定之前不建连。见 waitLayout。
    this.layoutReady = false;
    this.layoutCols = 0;
    this.waiters = null;
    // 回放是在哪个列数下灌进去的。灌完这一屏如果再变宽度，xterm 会把整屏
    // 重新折行，readline/Ink 那种"光标定位重画"的字节就会落到错的地方 ——
    // 屏幕上留一堆重叠的乱字。真遇上这种情况宁可重连一次，按新宽度重新灌。
    this.replayCols = 0;
    this.replayAt = 0;
    this.widthFixes = 0;
    // 选区完全由我们自己维护，不再借用 xterm 的选区模型。
    //
    // 为什么：全屏程序（Claude Code / Ink）每一帧都会重设终端状态、并且
    // 真的会消费鼠标报告，xterm 的选区在这些路径上会被清掉，它画的高亮层
    // 也会被重绘冲掉 —— 前面几版一直在堵这些窟窿，堵一个冒一个。
    // 自己的模型只依赖两样东西：鼠标坐标和缓冲区里的文字，程序怎么重绘
    // 都改不了它。框和文字同时留在手里，右键就不可能再退回粘贴。
    //
    //   selRange —— 选中范围（缓冲区绝对行号/列号，结束列不含）
    //   selDrag  —— 正在拖动时的锚点
    //   selSnap  —— 上一次选中的文本（复制不再回头问终端要）
    //   lastDragAt —— 上一次拖选结束的时刻，用来吞掉程序的"回放"
    this.selEl = null;
    this.selRange = null;
    this.selDrag = null;
    this.selSnap = null;
    this.lastDragAt = 0;
    this.selPaintRAF = 0;
    this.paintTimer = 0;
    this.widthTimer = 0;
    this.replayPainted = false;
    // 从历史记录打开时用：historyId 是那条记录的 id，historyLoaded 保证
    // 只铺一次（同一窗格重连后不再重铺，否则内容会叠）。
    this.historyText = null;
    this.historyLoaded = false;
    this.historyTimer = 0;
    // 重连回一条"接着老记录写"的会话时要整段重铺（见 stitchResume）。
    // histHold 暂存重铺期间到达的实时输出：铺的开头会 reset 一次屏幕，
    // 先到的那些字会被抹掉，先攥在手里，铺完再按原顺序补回去。
    this.histRendering = false;
    this.histHold = [];
    // 重铺历史时先把服务端回放攥在手里（captureReplay / replayText），
    // histTok 用来作废已经过期的那次重铺，histTimer 是它的兜底。
    this.captureReplay = false;
    this.replayText = null;
    this.replayDec = null;
    this.histTok = 0;
    this.histTimer = 0;
    // 回放期间不要把终端的"自动应答"发回 PTY。
    //
    // 回放是把历史输出重演一遍，而历史里可能有程序当初发出的查询序列
    // （DA：ESC[c、DSR：ESC[6n 之类）。xterm 不知道这是重演，会按规矩
    // 应答，应答经 onData 走 INPUT 送进 PTY —— bash 收到就是一串
    // "1;2c: command not found"。这就是"每次重连都冒乱码"的来源。
    //
    // replayPending 是 READY 里 replayLen 的余额，按到达的字节数递减；
    // 减到 0 的那一帧写完后解锁。replaying 期间用户按键也会被丢掉，
    // 但回放只有几十毫秒，比收到半段历史再执行强得多。
    this.replaying = false;
    this.replayPending = 0;
    this.replayTimer = 0;
    // 回放期间挡住鼠标/焦点追踪开关的那几个处理器（见 guardReplayModes）。
    this.replayGuards = [];
    // 滚轮增量的余量，攒够 40px 走一行（触摸板的小增量靠它才滚得动）。
    this.wheelAcc = 0;
    // 最近一次连接失败的原因与关闭码。状态栏那个按钮的悬停说明全靠它，
    // 连上的瞬间会被清空 —— 陈旧的原因比没有原因更容易误导人。
    this.lastError = '';
    this.lastCode = 0;
    this.lastErrorAt = 0;
    this.retryAt = 0;
  }

  // 名字里带 Section 是因为 mount 在早期版本里是 pane 的入口，
  // 保留一个明确的名字避免和 Pane.mount 混在一起看错。
  Session.prototype.mountSection = function (host) {
    var self = this;
    this.host = host;

    var term = new window.Terminal({
      allowProposedApi: true,
      cursorBlink: this.cursorBlink,
      cursorStyle: 'bar',
      fontFamily: FONT_STACK,
      fontSize: this.fontSize,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: this.scrollback,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
      theme: document.documentElement.dataset.theme === 'light' ? LIGHT_THEME : DARK_THEME
    });

    // 中日韩全角字符宽度。不开这个，中文后面接英文字符时光标位置就错。
    try {
      var u11 = new window.Unicode11Addon.Unicode11Addon();
      term.loadAddon(u11);
      if (term.unicode) term.unicode.activeVersion = '11';
    } catch (e) { /* 老浏览器忽略 */ }

    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);

    term.open(host);
    this.term = term;
    this.fitAddon = fit;
    this.installSelectionLayer(host);

    // Ctrl+V 不能同时当"终端按键"和"浏览器粘贴"。
    //
    // 终端语义里它是 0x16：bash/zsh 的 quoted-insert、vim 的块选择、tmux 的
    // 前缀组合。但浏览器把它固定成粘贴，网页拦不住。结果是按一次 Ctrl+V，
    // PTY 收到一个 ^V，同一次按键浏览器又粘了一份 —— 粘进去的内容前头多了
    // 一个控制字符，在 vim 里还会顺手进入块选择。
    //
    // 这里只让 xterm 别处理这个键（返回 false = 不吞、不发字节），按键原样
    // 交给浏览器：粘贴照旧走 paste 事件，**http 下同样有效**，而终端不再
    // 多收一个 ^V。代价是 vim 的 Ctrl+V 在网页终端里让位 —— 它在浏览器里
    // 本来就保不住，现在至少不会一半粘贴一半块选择。
    // Ctrl+Shift+V / Shift+Insert 不在此列：安全上下文中它们由 onKeydown
    // 接管，非安全上下文一律放行给浏览器。
    if (term.attachCustomKeyEventHandler) {
      term.attachCustomKeyEventHandler(function (e) {
        if (e.type !== 'keydown') return true;
        var mod = e.ctrlKey || e.metaKey;
        if (mod && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) return false;
        return true;
      });
    }

    this.installProtocolGuard();
    this.installClipboardBridge(term);

    term.onData(function (data) {
      // 回放历史时不外发：那里面可能有程序当年发的 DA/DSR 查询，
      // xterm 的自动应答会顺着这条路进到 PTY，被 shell 当成命令执行。
      if (self.replaying) return;
      self.send(C.INPUT, new TextEncoder().encode(data));
    });

    term.onBinary(function (data) {
      if (self.replaying) return;
      var bytes = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      self.send(C.INPUT, bytes);
    });

    term.onTitleChange(function (title) {
      if (title) self.opts.onTitle && self.opts.onTitle(title);
    });

    term.onResize(function (size) {
      // 回放刚灌完就变宽度：这一屏是按旧列数折的行，xterm 会整屏重折，
      // 那些靠光标定位重画的字节就落到错的位置，屏幕上留下重叠的乱字。
      // 与其让它斑驳着，不如重连一次、按新宽度重新灌一遍（只做一次，
      // 避免尺寸本身在抖的时候来回重连）。
      if (self.replayCols && size.cols !== self.replayCols &&
          Date.now() - self.replayAt < 4000 && self.widthFixes < 1) {
        self.widthFixes += 1;
        self.replayCols = 0;
        self.reloadForWidth();
        return;
      }
      // 和 PTY 现在的大小一样就别发了。
      //
      // TIOCSWINSZ 不管宽高有没有变，都会给前台进程拍一个 SIGWINCH；
      // 全屏程序（以及 Windows 上的 PowerShell）收到就整屏重绘一遍。
      // 刷新页面时窗口尺寸通常没变，这一下白来的重绘会从屏幕左上角开始
      // 重画，把刚铺好的历史整片盖掉 —— 看起来正是"历史又没了"。
      if (self.ptyCols === size.cols && self.ptyRows === size.rows) {
        self.opts.onScroll && self.opts.onScroll();
        return;
      }
      self.sendResize(size.cols, size.rows);
      self.opts.onScroll && self.opts.onScroll();
    });

    // 视口滚动 / 新输出落屏，都要通知外面重画滑块。前者是用户滚轮或拖动，
    // 后者是回看缓冲变长了 —— 少了任一，滑块就会"卡"在旧位置。
    try { term.onScroll(function () { self.opts.onScroll && self.opts.onScroll(); }); } catch (e) { }
    try { term.onWriteParsed(function () { self.opts.onScroll && self.opts.onScroll(); }); } catch (e) { }

    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(function () { self.scheduleFit(); });
      this.ro.observe(host);
    }
    window.addEventListener('resize', function () { self.scheduleFit(); });

    host.addEventListener('keydown', function (e) { self.onKeydown(e); }, true);

    // 拖选：整个选区（范围、文字、高亮）都由我们自己算。
    //
    // 三种情况分开处理，边界和真实终端一致：
    //   程序开着鼠标追踪 + 不按 Shift  → 原样交给程序（点按钮、拖滑块都靠它）
    //   程序开着鼠标追踪 + 按住 Shift  → 我们接管，并且不再传给它
    //   程序没开鼠标追踪               → 直接拖选，和普通终端一样
    //
    // 接管时必须 stopPropagation：xterm 收到这些事件会自己再选一遍（多一层
    // 不可见的高亮），还会把拖动打包成鼠标报告发给程序 —— Claude Code 收到
    // 后会自己选中、自己 copy、再整屏重绘，把我们的框和程序自己的 UI 全搅在
    // 一起（它那行 "copied N chars to clipboard" 就是这么来的）。
    host.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var c = self.cellAt(e);
      if (!c) return;
      var tracking = self.mouseTracking();
      var own = !tracking || e.shiftKey;
      // 双击选词、三击选整行。以前这两个是 xterm 送的，现在选区自己管，
      // 得自己实现 —— 少了它会明显感觉"不如以前好用"。
      if (e.detail >= 2) {
        self.selectToken(c, e.detail);
        if (own) {
          e.stopPropagation();
          e.preventDefault();
          self.grab();
        }
        return;
      }
      if (tracking && !e.shiftKey) {
        // 程序自己在处理这个拖动：Claude Code 会画它自己的蓝色选框，还会
        // 打一行 "copied N chars to clipboard"。但在 http 页面上它写不进
        // 系统剪贴板，那行提示其实是假的 —— 右键粘贴只能粘到上一次的东西。
        //
        // 所以照样记一份我们自己的范围，只是**不拦事件**：程序该怎么反应
        // 还怎么反应，我们只负责"屏幕上看见什么，右键就能复制什么"。
        self.beginSelection(c, e, false);
        return;
      }
      // 按住 Shift（或者在普通终端里直接拖）：这次拖动归我们，
      // 事件不再往下传 —— 否则程序会自己再选一遍、还会整屏重绘。
      self.beginSelection(c, e, true);
      e.stopPropagation();
      e.preventDefault();
      self.grab();
    }, true);

    // 拖动和松手挂在 window 上：鼠标拖出终端区域时也要继续更新。
    window.addEventListener('mousemove', function (e) {
      var d = self.selDrag;
      if (!d) return;
      var c = self.cellAt(e);
      if (!c) return;
      self.dragSelection(c, e);
      // 只有"这次拖动归我们"的时候才拦事件。程序自己在处理的那种
      // （鼠标追踪 + 没按 Shift），必须让它继续收到 mousemove，
      // 否则它自己的选框、拖拽交互就全断了。
      if (d.block) e.stopPropagation();
    }, true);

    window.addEventListener('mouseup', function (e) {
      var d = self.selDrag;
      if (!d || e.button !== 0) return;
      self.endSelection();
      if (d.block) e.stopPropagation();
    }, true);

    // 键盘一按，选中的东西就不再是"用户刚选的东西"了：收掉框和快照，
    // 这样紧接着右键又回到粘贴。放到 window 上，焦点不在终端时也生效。
    //
    // 三种情况不处理：
    //   单独的修饰键 —— 按一下 Shift 准备拖选，不该把上一次的选中也带走
    //   复制快捷键   —— 那是"要拿走选中的内容"，收掉就没得复制了
    //   粘贴快捷键   —— 同理
    window.addEventListener('keydown', function (e) {
      if (!(self.selRange || self.selSnap)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' ||
          e.key === 'Meta' || e.key === 'CapsLock') return;
      if (mod && (e.key === 'Insert' || ((e.key === 'C' || e.key === 'c') && e.shiftKey))) return;
      if (e.shiftKey && e.key === 'Insert') return;
      if (mod && (e.key === 'V' || e.key === 'v') && e.shiftKey) return;
      self.clearSelection();
    }, true);

    // 右键的语义按"有没有选中东西"来定，两个动作都只要一次点击：
    //   有选区 → 复制（用户刚拖完文字，想做的一定是拿走它）
    //   没选区 → 粘贴
    //
    // 复制必须自己来 —— 终端画在 canvas 上，浏览器的原生"复制"拿不到那些字。
    //
    // 粘贴在安全上下文（HTTPS / localhost）直接读 clipboard API。http 直连 IP
    // 读不到系统剪贴板，那就用**应用内剪贴板**：本页最近一次复制的文字。
    // 这正好覆盖最常用的那条路 —— "选中 → 右键复制 → 点一下空白 → 右键粘贴"，
    // 内容一定是对的，因为就是刚复制的那段。
    //
    // 应用内剪贴板只在页面没离开过焦点时有效：窗口一 blur，用户多半是去别的
    // 应用复制了别的东西，这时粘旧内容比多点一次菜单更糟，所以直接作废、
    // 把右键交还给浏览器原生菜单（那条路能粘任意内容，只是要多点一下）。
    host.addEventListener('contextmenu', function (e) {
      // 规则只有一条，程序里外都一样：
      //   有选中 → 复制；没选中 → 粘贴。
      //
      // 复制之后立刻把选区收掉，所以"复制 → 右键 → 粘贴"这个最常走的
      // 两连击是自洽的：第一次右键拿走选中内容，第二次右键因为没有选区，
      // 自然就是粘贴。留着选区的话用户会一直复制，永远粘不上。
      var text = self.selectionText();
      if (text) {
        e.preventDefault();
        self.copyText(text);
        self.clearSelection();
        var lines = text.split('\n').length;
        if (text.trim()) banner('已复制 ' + lines + ' 行（' + text.length + ' 个字符）', 'ok');
        // 纯空白选区：复制到的是换行，"字符"听起来像哪里出错了
        else banner('已复制 ' + (lines - 1) + ' 个空行', 'ok');
        return;
      }

      if (navigator.clipboard && window.isSecureContext) {
        e.preventDefault();
        self.paste();
        return;
      }

      if (self.pasteInner()) {
        e.preventDefault();
        return;
      }

      // 没有可用的内部内容：放行原生菜单。放行之前先把焦点摆到终端的隐藏
      // 输入框上 —— 原生菜单的"粘贴"作用于焦点元素，焦点在别处时它是灰的。
      self.focus();
    });

    // 拖选就只是拖选：不写剪贴板，也不动应用内那份记录。
    //
    // 以前这里是"选中即复制"（默认开），副作用是用户拖选一段、发现拖错了、
    // 左键点一下想取消 —— 那段文字其实已经在剪贴板里了，紧接着右键"粘贴"
    // 又把刚取消的东西吐了出来，看起来像是取消没生效。
    //
    // 现在只有一个时刻会把文字放进剪贴板：右键（有选区）或者 Ctrl+Insert /
    // Ctrl+Shift+C。拖选、取消都不产生任何复制，右键粘到的永远是"上一次
    // 真正复制的那段"。

    // 全屏 TUI（vim/htop/claude）进出备用屏幕时，xterm 会整块换缓冲区。
    // 这一下 WebGL 渲染器偶尔会留下上一次画面的"幽灵字符"（字形图集没刷），
    // canvas 渲染器也会在视口尺寸刚变的瞬间留残影。统一在切换后整屏重画一次，
    // 代价只是一次 refresh，肉眼无感。
    try {
      if (term.buffer && term.buffer.onBufferChange) {
        this.bufSub = term.buffer.onBufferChange(function () {
          // 进出备用屏幕要顺手更新"全屏"标记：它说的是"这一格现在被全屏
          // 程序占着"，vim 退出了就该消失，不该等到下次连上才刷新。
          var inAlt = term.buffer.active.type === 'alternate';
          self.alt = inAlt;
          self.opts.onAlt && self.opts.onAlt(inAlt);
          self.afterBufferSwap();
        });
      }
    } catch (e) { /* 老版本 xterm 没有这个事件，忽略 */ }

    requestAnimationFrame(function () { self.fit(); self.attachWebgl(); });
  };

  // afterBufferSwap 在缓冲区切换后整屏重画。
  //
  // 为什么必须重画：TUI 退出时是一串"恢复主屏 + 恢复光标"的转义序列，
  // 渲染器如果只按脏区增量更新，就会把 TUI 的残留格子留在屏幕上 ——
  // 用户看到的就是"退出后一堆乱码"。整屏重画是最便宜且确定有效的解法。
  //
  // 为什么刷两次：切换缓冲区这一刻，程序往往还会紧接着打印收尾信息
  // （claude 退出时的 "Resume this session with…" 就是），这些字节是在
  // 第一次 refresh 之后才落屏的。只刷一次，它们依旧按增量绘制，上一屏
  // 留下的脏格子就跟着一起留在画面上。第二次补刷把它们一并盖掉。
  //
  // 重画就是 refresh，**不要**顺手 clearTextureAtlas()。xterm 的字形图集
  // 是按"配置（字体/字号/配色/DPR）"缓存、多个渲染器共用的：清掉它等于
  // 把别的窗格模型里记的字形坐标变成野指针，那些窗格下一次重绘就会画成
  // 一堆错位的方块。见 paintAll 里的同一段说明。
  Session.prototype.afterBufferSwap = function () {
    var self = this;
    var paint = function () {
      if (!self.term) return;
      try { self.term.refresh(0, self.term.rows - 1); } catch (e) { }
    };
    requestAnimationFrame(paint);
    clearTimeout(this.swapTimer);
    this.swapTimer = setTimeout(paint, 80);
  };

  // clearScreen 清屏并清掉 scrollback。TUI 异常退出（比如被 kill）时不会自己
  // 收尾，屏幕上就会留一屏残骸 —— 这是给用户的即时逃生口，不碰会话本身。
  Session.prototype.clearScreen = function () {
    if (!this.term) return;
    try { this.term.write('\x1b[H\x1b[2J\x1b[3J'); } catch (e) { }
    this.afterBufferSwap();
  };

  // --------------------------------------------------------- WebGL 上下文池
  //
  // 浏览器对同一页面能同时存在的 WebGL 上下文有硬上限（Chrome 大约 16 个），
  // 超了会静默丢掉最旧的那个 —— 表现是某个窗格整块变黑，只有切窗口才恢复。
  // 所以这里限流：只给焦点最近的几个窗格挂 WebGL，其余走 canvas 渲染器；
  // 焦点切过去时换人（挤掉最久没用的那个）。

  var WEBGL_MAX = 4;
  var webglUsers = [];

  Session.prototype.attachWebgl = function () {
    if (!this.opts.webgl || this.webgl || !this.term) return;
    // 藏在别的标签里就先不占上下文，等切过去再挂。
    if (!this.host || this.host.offsetParent === null) return;

    if (webglUsers.length >= WEBGL_MAX) {
      var victim = null, i, s;
      // 先挑"藏在别的标签里、根本看不见"的，再退到"没焦点"的 ——
      // 别把正在看的窗格抢走，那会黑一下。
      for (i = 0; i < webglUsers.length; i++) {
        s = webglUsers[i];
        if (s === this) continue;
        if (s.host && s.host.offsetParent === null) { victim = s; break; }
      }
      if (!victim) {
        for (i = 0; i < webglUsers.length; i++) {
          s = webglUsers[i];
          if (s === this || s.focused) continue;
          victim = s;
          break;
        }
      }
      if (!victim) return;
      victim.detachWebgl();
    }

    try {
      var addon = new window.WebglAddon.WebglAddon();
      var self2 = this;
      addon.onContextLoss(function () {
        self2.detachWebgl();
        banner('WebGL 上下文丢失，已切回普通渲染', 'warn');
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
      webglUsers.push(this);
    } catch (e) {
      // 显卡/驱动不支持就老实回落 canvas，不弹窗打扰
    }
  };

  Session.prototype.detachWebgl = function () {
    if (!this.webgl) return;
    try { this.webgl.dispose(); } catch (e) { }
    this.webgl = null;
    var i = webglUsers.indexOf(this);
    if (i >= 0) webglUsers.splice(i, 1);
    // dispose 之后这块 canvas 是空的，必须整屏重画一次，否则留一块黑。
    if (this.term) this.term.refresh(0, this.term.rows - 1);
  };

  Session.prototype.onKeydown = function (e) {
    var mod = e.ctrlKey || e.metaKey;

    // Shift+Enter → ESC CR（Alt+Enter 语义）。
    //
    // Claude Code、Codex 这类基于 Ink 的 CLI 用这个序列表示"换行但不提交"。
    // 前端直接发字节，不去赌终端的扩展键协商：native 后端下它是裸字节，
    // tmux 后端下它是普通输入，escape-time 0 保证没有延迟 —— 两边行为一致。
    if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      this.send(C.INPUT, new TextEncoder().encode('\x1b\r'));
      return;
    }

    if (e.shiftKey && mod && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      this.copy();
      return;
    }
    if (e.shiftKey && mod && (e.key === 'V' || e.key === 'v')) {
      // 只在能读剪贴板的时候接管。http 页面上读不到，就把组合键放行给
      // 浏览器 —— Chrome/Edge 把它当"粘贴为纯文本"，走的仍然是 paste
      // 事件，xterm 接得到。拦下来只会换来一句"请按 Ctrl+V"。
      if (navigator.clipboard && window.isSecureContext) {
        e.preventDefault();
        this.paste();
      }
      return;
    }
    // Ctrl+Insert / Shift+Insert 是 Windows 传统终端的复制粘贴键，
    // 浏览器不占用，比 Ctrl+Shift+C 可靠 —— 后者在 Chrome 里会先被
    // 开发者工具吃掉，网页的 preventDefault 拦不住。
    //
    // Ctrl+Shift+Insert 是"原样复制"：行尾空白、末尾空行都留着。默认那条
    // 会把每行尾部由界面补出来的不可见空白裁掉（全屏 TUI 会拿它们把整行
    // 填满，留着就会在折行处多出空行），但偶尔要的就是原封不动。
    if (e.key === 'Insert' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.copy(true);
      return;
    }
    if (e.key === 'Insert' && mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.copy();
      return;
    }
    if (e.key === 'Insert' && e.shiftKey && !mod && !e.altKey) {
      // Shift+Insert 本身就是浏览器的原生粘贴键，而原生粘贴走的是
      // paste 事件 + clipboardData —— 在 http 页面上这是唯一还能用的通道。
      // 所以安全上下文里才接管（走 clipboard API），否则必须放行：
      // 拦住它等于把用户最后一条路也堵了。
      if (navigator.clipboard && window.isSecureContext) {
        e.preventDefault();
        this.paste();
      }
      return;
    }
    if (mod && !e.altKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        this.setFontSize(this.fontSize + 1);
      } else if (e.key === '-') {
        e.preventDefault();
        this.setFontSize(this.fontSize - 1);
      } else if (e.key === '0') {
        e.preventDefault();
        this.setFontSize(14);
      }
    }
  };

  // scrollMetrics 把 xterm 的缓冲区状态翻译成"滑块要画多长、画在哪"。
  //
  // 备用屏幕（vim/htop/claude 这类全屏程序）没有回看缓冲，baseY 恒为 0，
  // 这时返回 null —— 滑块藏起来是对的，那种界面本来就没法往上翻。
  Session.prototype.scrollMetrics = function () {
    var t = this.term;
    if (!t || !t.buffer) return null;
    var b = t.buffer.active;
    if (!b || b.type !== 'normal' || b.baseY <= 0) return null;
    return { top: b.viewportY, max: b.baseY, rows: t.rows };
  };

  Session.prototype.scrollToRatio = function (ratio) {
    var t = this.term;
    if (!t || !t.buffer) return;
    var b = t.buffer.active;
    if (!b || b.type !== 'normal' || b.baseY <= 0) return;
    var r = Math.max(0, Math.min(1, ratio));
    try { t.scrollToLine(Math.round(r * b.baseY)); } catch (e) { }
  };

  // scrollByWheel 把 wheel 增量折算成行数滚动。
  //
  // 为什么要自己累积而不能像 xterm 那样一次一取整：笔记本触摸板一次只报
  // 5~15px，除以"一行 40px"后永远是 0，整格滚轮就像坏了；鼠标滚轮一次
  // 100~120px 才刚好走三行。把余量攒起来，两种设备的手感才一致。
  Session.prototype.scrollByWheel = function (e) {
    var t = this.term;
    if (!t || !this.canScroll()) return;

    var px = e.deltaY;
    if (e.deltaMode === 1) px *= 33;
    else if (e.deltaMode === 2) px *= t.rows * 18;
    if (!px) return;

    // 换方向时清掉旧余量，否则先下滚一半再上滚会先"抵消"掉一段。
    if (px > 0 !== this.wheelAcc > 0) this.wheelAcc = 0;
    this.wheelAcc += px;

    var lines = this.wheelAcc > 0 ? Math.floor(this.wheelAcc / 40) : Math.ceil(this.wheelAcc / 40);
    if (!lines) return;
    this.wheelAcc -= lines * 40;
    // 已经滚到底还在继续滚时余量会一直攒着，攒太多会导致"反向第一下没反应"。
    if (Math.abs(this.wheelAcc) > 120) this.wheelAcc = 0;

    try { t.scrollLines(lines); } catch (err) { }
  };

  // canScroll 判断这一格现在能不能翻历史。
  //
  // 备用屏幕（vim/htop/claude）没有回看缓冲，滚轮要留给 xterm 转成方向键 ——
  // 那是这些程序自己在处理滚动，我们插一手就会变成"滚不动还乱跳"。
  Session.prototype.canScroll = function () {
    var t = this.term;
    if (!t || !t.buffer) return false;
    var b = t.buffer.active;
    return !!(b && b.type === 'normal' && b.baseY > 0);
  };

  Session.prototype.fit = function () {
    if (!this.term || !this.fitAddon || !this.host) return;
    if (this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    var before = this.term.cols + 'x' + this.term.rows;
    try { this.fitAddon.fit(); } catch (e) { return; }
    // 行列数一变，字符格的位置和大小全变了，自己画的那层选区要跟着挪。
    if (this.term.cols + 'x' + this.term.rows !== before) this.paintSelection();
    // fitted 一旦为真，说明 term.cols/rows 是真实布局算出来的，可以拿去
    // 和 PTY 对账；在此之前它们只是 xterm 的默认 80x24。
    this.fitted = true;
  };

  // resize 防抖：拖窗口时别把 PTY 刷爆，TUI 会跟着反复重排。
  Session.prototype.scheduleFit = function () {
    var self = this;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(function () { self.fit(); }, 80);
  };

  // waitLayout 等到窗格真的有尺寸、而且连续两次量到同一个列数，再放行建连。
  //
  // 为什么是"连续两次"：字体、滚动条、flex 布局生效的那一帧量出来的宽度
  // 常常还是旧的。只量一次就建连，回放就会按错宽度解析，之后布局定型再
  // 重新折行 —— 屏幕上就是顶部那一片叠字。
  //
  // 隐藏的窗格（别的标签页里的）会一直等到它被显示出来：那时
  // ResizeObserver 会触发，列数一稳定就自己连上。这比"先按 80x24 连上，
  // 之后再把 PTY 掰回来"干净得多。
  Session.prototype.waitLayout = function () {
    var self = this;
    if (this.waiters) { this.waiters.push(1); return; }
    this.waiters = [1];

    var finish = function () {
      if (self.layoutReady) return;
      self.layoutReady = true;
      self.waiters = null;
      self.connect();
    };

    var tries = 0;
    var tick = function () {
      if (self.disposed) { self.waiters = null; return; }
      if (self.ws || self.layoutReady) { self.waiters = null; return; }
      var host = self.host;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        self.fit();
        var cols = self.term ? self.term.cols : 0;
        if (cols > 0 && cols === self.layoutCols) { finish(); return; }
        self.layoutCols = cols;
      }
      // 前两秒密一点（正常的页面一帧就定了），之后退到 250ms 一轮：
      // 藏在别的标签页里的窗格会等很久，没必要一直每 60ms 去摸一次布局。
      tries += 1;
      setTimeout(tick, tries < 34 ? 60 : 250);
    };

    // 字体就绪之后再量：字体还没落地时 xterm 量到的字宽是 fallback 字体的，
    // 列数会偏大。没有 Font Loading API 就直接开始。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(tick, tick);
    } else {
      tick();
    }
  };

  // reloadForWidth 把"按旧宽度排好的一屏"丢掉，重连后按新宽度重新灌。
  //
  // 只在回放刚落地就变宽度时调用（见 onResize）。这是唯一能保住画面正确
  // 的做法：xterm 的折行对普通文本没问题，但 readline / Ink 那种靠光标
  // 定位重画的内容折一次就散了。
  Session.prototype.reloadForWidth = function () {
    var self = this;
    if (this.widthTimer) return;
    this.widthTimer = setTimeout(function () {
      self.widthTimer = null;
      if (self.disposed) return;
      self.selSnap = null;
      self.selRange = null;
      self.selDrag = null;
      self.everWrote = false;
      if (self.term) { try { self.term.reset(); } catch (e) { } }
      // 静默断开：这是自愈动作，不该弹"连接已断开"。
      self.quietClose = true;
      self.retry = 0;
      if (self.ws) { try { self.ws.close(); } catch (e) { } }
    }, 250);
  };

  // paintAll 整屏重画。
  //
  // 灌完回放之后必须来一发：回放是一大段字节，xterm 按脏区增量绘制，
  // 没被新内容覆盖到的行会留着上一次连接的字形像素 —— 用户看到的就是
  // "顶部几行是上一次的残影"。
  //
  // 这里只 refresh，**绝不能**再调 clearTextureAtlas()。
  //
  // 以前每次重画都清一遍字形图集，单窗格时没问题；多标签以后就成了
  // "打开历史的那个标签把别的标签画花"：xterm 的字形图集不是每个渲染器
  // 一份，而是按配置（字体、字号、配色、DPR）缓存的 —— 两个窗格长得一样
  // 就共用同一个图集对象。clearTextureAtlas() 会把图集内容清空，同时只把
  // **自己**那个渲染器的模型清掉；别的窗格模型里记的字形坐标还指着旧位置，
  // 而图集已经重新分配过了，于是它们下一次重绘就去错误的地方取字形 ——
  // 屏幕上是一堆错位的方块和乱码。刷新一次能救回来，正是因为重画会按新
  // 坐标重新登记字形。
  //
  // 残影是"没重画"，不是"图集脏"，refresh 就够了。
  Session.prototype.paintAll = function () {
    var self = this;
    if (!this.term) return;
    var paint = function () {
      if (self.disposed || !self.term) return;
      try { self.term.refresh(0, self.term.rows - 1); } catch (e) { }
      self.paintSelection();
    };
    requestAnimationFrame(paint);
    clearTimeout(this.paintTimer);
    this.paintTimer = setTimeout(paint, 140);
  };

  Session.prototype.setFontSize = function (size) {
    // 有 Workspace 时统一由它改（会同步到所有窗格并落盘）。
    if (this.owner) { this.owner.setFontSize(size); return; }
    this.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    if (this.term) this.term.options.fontSize = this.fontSize;
    this.fit();
  };

  Session.prototype.connect = function () {
    if (this.disposed) return;
    var self = this;

    // 布局没稳定之前不建连 —— 这一条是"关掉网页再打开，顶部一片乱字"的
    // 正解。
    //
    // 页面刚起来时窗格可能还没被排版（藏在别的标签页里、flex 还没算完），
    // fit() 量出来的列数是错的，甚至量不到（xterm 停在默认 80x24）。这时
    // 建连、灌回放，等于让终端按错的宽度解析一整段历史；等布局真正生效，
    // xterm 会把整屏重新折行 —— readline / Ink 那些靠 "\r + 光标移动"
    // 重画的字节就落到错位置，屏幕顶部留下两行叠在一起的乱码。
    //
    // 所以先等到"连续两次量到同一个列数"，再连。
    if (!this.layoutReady) { this.waitLayout(); return; }

    // 建连前先把行列数算准。URL 里的 cols/rows 会用来创建新会话，晚一步
    // 就是拿默认的 80x24 去开 PTY：shell 先按 80 列起一屏，紧接着 fit 完
    // 再改成真实宽度 —— 多出来一次 SIGWINCH，全屏程序会因此重排重印。
    this.fit();
    this.connectAt = Date.now();
    this.setState('connecting');

    var params = new URLSearchParams();
    if (this.sid) params.set('sid', this.sid);
    // 服务端据此知道"这个窗格是接着哪条历史记录开的"：新建会话时把日志追加
    // 到那条记录里，列表上不会多出一行。sid 命中存活会话时它会被忽略 ——
    // 刷新页面不会因此多开一个会话。
    if (this.opts.historyId) params.set('hist', this.opts.historyId);
    if (this.term) {
      params.set('cols', String(this.term.cols));
      params.set('rows', String(this.term.rows));
    }

    var ws;
    try {
      ws = new WebSocket(WS_URL + '?' + params.toString());
    } catch (e) {
      // 构造函数抛异常基本只有两种：地址拼错了，或者浏览器把混合内容拦了
      // （https 页面连 ws://）。这两种重试多少次都不会好，原因要留住。
      this.fail('无法建立连接：' + ((e && e.message) || '浏览器拒绝创建 WebSocket'));
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = function () {
      self.retry = 0;
      self.retryAt = 0;
      self.lastError = '';
      self.lastCode = 0;
      self.setState('online');
      // 这里不再无条件报一次尺寸：新建会话本身就是按 URL 里的 cols/rows
      // 起的 PTY，重连的会话则已经有一块 PTY，两种情况下这一报基本都是
      // "同尺寸的空操作"。而 TIOCSWINSZ 即使尺寸没变也会给前台进程一个
      // SIGWINCH，PowerShell 这类程序收到就整屏重绘，刷新页面时会把刚铺
      // 好的历史盖掉。真不一致时 READY 那边会对账（见下面的尺寸对账）。
    };

    ws.onmessage = function (ev) {
      if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength === 0) return;
      var buf = new Uint8Array(ev.data);
      var kind = buf[0];
      var payload = buf.subarray(1);

      if (kind === S.OUTPUT) {
        if (self.term) {
          if (self.replayPending > 0) {
            // 这一段属于回放：写的时候屏蔽自动应答，写完最后一段再解锁。
            self.replayPending -= payload.length;
            self.replaying = true;
            clearTimeout(self.replayTimer);
            // 兜底：服务端少发一段、或长度对不上时别把键盘永久锁死。
            self.replayTimer = setTimeout(function () {
              self.replaying = false;
              if (self.captureReplay) self.finishCapture();
              self.replayPending = 0;
            }, 3000);
            if (self.captureReplay) {
              // 这一屏先别画：它是"接手之后"的部分，要接在历史后面重铺
              // 才算完整（见 stitchResume）。按字节存、全程用同一个流式
              // 解码器，免得把跨帧的多字节字符劈成两半。
              self.replayText += self.replayDec.decode(payload, { stream: true });
              if (self.replayPending <= 0) self.finishCapture();
              return;
            }
            if (self.replayPending <= 0) {
              self.replayPending = 0;
              self.term.write(payload, function () {
                self.replaying = false;
                clearTimeout(self.replayTimer);
              });
            } else {
              self.term.write(payload);
            }
          } else if (self.histRendering) {
            // 正在整段重铺历史。铺的开头会 reset 一次屏幕，这会儿写下去的
            // 字节会被抹掉，先攥着，铺完按原顺序补回去（见 endHistHold）。
            self.histHold.push(payload);
          } else {
            self.term.write(payload);
          }
          self.everWrote = true;
          // 回放这一大段落地后整屏重画一次。
          //
          // xterm 按脏区增量绘制：回放把内容写到下半屏，上半屏没有新内容、
          // 就不会被重画，于是留着上一次连接的字符像素 —— 用户看到的是
          // "关掉网页再打开，顶部几行是上一次的残影、还叠着新内容"。
          // 清字形图集 + 整屏 refresh 是唯一确定有效的收尾。
          if (self.replayCols && !self.replayPainted) {
            self.replayPainted = true;
            self.paintAll();
          }
        }
        return;
      }

      if (kind === S.READY) {
        var info;
        try { info = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return; }

        var becameNewSession = self.sid && info.sid !== self.sid;

        // 回放马上就到，先把屏幕清干净。
        //
        // 不清的话，同一个窗格重连时上一次连接留下的画面还在，回放又从
        // 会话最开始重新灌一遍，两份内容就叠在一起 —— 重影、错行、半截
        // 控制序列，全从这儿来。TUI 退出后"满屏乱码"也是同一个成因：
        // 屏幕上还挂着备用屏幕那一帧。
        //
        // 换成另一个会话时同理，而且必须更彻底：连 scrollback 一起丢掉，
        // 免得两个会话的历史混在一条回看缓冲里。
        if (self.term && (becameNewSession || info.replayLen > 0 || info.replaySkipped || self.everWrote)) {
          self.term.reset();
          self.selSnap = null;
          self.selRange = null;
          self.paintSelection();
          self.alt = false;
          self.opts.onAlt && self.opts.onAlt(false);
        }
        if (becameNewSession) self.exited = false;
        self.sid = info.sid;

        // 记下这一屏回放是按多少列灌进去的。灌完立刻变宽度的话（布局迟到、
        // 用户拖窗口），xterm 会整屏重折，靠光标定位重画的字节就散了 ——
        // 那种情况宁可重连按新宽度重灌，见 onResize 里的 reloadForWidth。
        self.replayCols = info.replayLen > 0 && self.term ? self.term.cols : 0;
        self.replayAt = Date.now();
        self.replayPainted = false;
        // 接下来的这一段字节是重演历史，不是程序的新输出（见 ON_DATA 的守卫）。
        self.replayPending = info.replayLen || 0;
        self.replaying = false;

        // 尺寸对账：READY 里的 cols/rows 是 PTY 当前的真实大小。
        // 一旦它和 xterm 不一致，TUI 就按错宽度排版、换行位置全错，
        // 退出后屏幕上留的就是错位残字。发现不一致立刻把 PTY 掰回 xterm 的尺寸，
        // 不指望"下一次窗口 resize 会顺带修正"。
        self.ptyCols = info.cols || 0;
        self.ptyRows = info.rows || 0;
        // 只在自己真的 fit 过之后才对账。没 fit 时 term.cols/rows 还是
        // xterm 的默认值，拿它去改 PTY 等于主动把终端踩成 80x24 ——
        // 之后 fit 完再改回来，两次 SIGWINCH，全屏程序会把历史重印两遍。
        if (self.fitted && self.term && self.ptyCols && self.ptyRows &&
            (self.ptyCols !== self.term.cols || self.ptyRows !== self.term.rows)) {
          self.sendResize(self.term.cols, self.term.rows);
        }

        // 全屏 TUI 的重连：回放里没有"进入备用屏幕"的起点，
        // 客户端得先切进去，否则重绘会画到主屏上，界面全乱。
        if (info.needAltEnter && self.term) {
          self.pendingAltEnter = true;
          if (self.term.buffer.active.type !== 'alternate') {
            self.term.write('\x1b[?1049h');
          }
        }
        // 留一份最近的 READY：排障时能直接看出服务端给了多少回放、
        // 是不是按"宽度对不上"跳过了回放。
        self.lastReady = info;
        self.opts.onReady && self.opts.onReady(info);

        // 从历史面板打开的那个窗格：等这一屏回放画完，再把历史铺上去。
        //
        // 为什么不早一点：READY 之后紧跟着就是新会话的回放（shell 的欢迎语），
        // 那段写入之前 READY 分支会 reset 一次屏幕 —— 铺早了会被清掉。
        // 250ms 是给回放落地留的余量，之后再 reset + 写历史 + 补一个回车
        // 让 shell 重新打出提示符。
        //
        // histResumed / histStart 是"接着老记录写"的会话才有的：日志里前
        // histStart 个字节才是上一次的内容。新 shell 的启动输出已经接在后面，
        // 里面带清屏序列 —— 整段铺回来会把历史擦掉，所以只取到那个位置。
        if (self.opts.historyId && !self.historyLoaded) {
          self.historyLoaded = true;
          if (info.histResumed) {
            self.historyTo = info.histStart || 0;
          }
          clearTimeout(self.historyTimer);
          self.historyTimer = setTimeout(function () { self.loadHistory(); }, 250);
        } else if (info.histResumed && info.histId && !info.altScreen) {
          // 刷新页面（或者关掉网页再打开）之后接回同一个会话。
          //
          // 布局里只存了 sid，"这条会话写着哪一份历史"只有服务端知道 ——
          // 这次 READY 会把 histId / histStart 带过来。服务端的回放缓冲
          // 里只有这条会话自己产生过的输出，历史那一段在会话开始之前就
          // 写进日志了，永远进不了回放，于是刷新之后屏幕上就只剩接手之后
          // 敲的那几行，上面的历史全没了。
          //
          // 回放的这一屏先攥在手里不画，等把日志里历史那一段取回来，
          // 拼成一整段再铺（见 stitchResume）。
          clearTimeout(self.historyTimer);
          // 上一次重铺（如果有）作废：它的回调不该再往这块屏上写。
          clearTimeout(self.histTimer);
          self.histTok = (self.histTok || 0) + 1;
          self.histHold = [];
          self.histRendering = true;
          if (info.replayLen > 0) {
            self.captureReplay = true;
            self.replayText = '';
            self.replayDec = new TextDecoder();
          } else {
            // 没有回放可等（宽窄对不上被服务端跳过、或者缓冲是空的）：
            // 直接按日志整段重铺。
            self.captureReplay = false;
            self.replayDec = null;
            self.replayText = null;
            self.stitchResume();
          }
        }
        return;
      }

      if (kind === S.EXIT) {
        var code = 0;
        try { code = (JSON.parse(new TextDecoder().decode(payload)) || {}).code || 0; } catch (e) { }
        self.exited = true;
        if (self.term) {
          self.term.write('\r\n\x1b[90m[会话已结束，退出码 ' + code + ']\x1b[0m\r\n');
        }
        self.opts.onExit && self.opts.onExit(code);
        return;
      }

      if (kind === S.ERROR) {
        var msg = new TextDecoder().decode(payload);
        if (self.term) self.term.write('\r\n\x1b[31m' + msg + '\x1b[0m\r\n');
        banner(msg, 'error');
        return;
      }

      if (kind === S.REVOKED) {
        banner('该会话已被其他窗口接管，当前为只读', 'warn');
        if (self.term) self.term.options.disableStdin = true;
        return;
      }
    };

    ws.onerror = function () {
      // error 事件里没有任何可用的细节（浏览器出于安全不暴露），
      // 真正的原因得等紧跟着的 close 事件。这里只兜一个底，
      // 免得某些浏览器只发 error 不发 close 时原因空着。
      if (!self.lastError) self.fail('网络错误：连接被中断');
      try { ws.close(); } catch (e) { }
    };

    ws.onclose = function (ev) {
      self.ws = null;
      if (self.disposed) return;
      // quietClose 是我们自己为了重排而断的（见 reloadForWidth）：
      // 不是故障，别弹"连接已断开"吓人。
      var quiet = self.quietClose;
      self.quietClose = false;
      if (!quiet) {
        self.fail(closeReason(ev), ev && ev.code);
        self.setState('offline');
      }
      // 1013 = 服务端主动放弃这条连接（输出太快，队列跟不上）。
      // 这不是故障，是"重连一下就好"：清掉退避计数，别让用户对着
      // 一个已经过去的问题等 1s、2s、4s。
      if (ev && ev.code === 1013) self.retry = 0;
      if (!self.exited) self.scheduleRetry(quiet || (ev && ev.code === 1013));
    };
  };

  Session.prototype.fail = function (msg, code) {
    this.lastError = msg;
    this.lastCode = code || 0;
    this.lastErrorAt = Date.now();
  };

  // retryNow 是"点击重连"走的路：跳过退避等待，立刻重来一次。
  //
  // 旧 socket 的事件必须先摘掉再 close。留着的话，它的 onclose 会把
  // 刚建好的新连接重新标成 offline，还会再排一次重连 —— 越点越乱。
  Session.prototype.retryNow = function () {
    if (this.disposed) return false;

    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retry = 0;
    this.retryAt = 0;

    var old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try { old.close(); } catch (e) { }
    }

    this.connect();
    return true;
  };

  Session.prototype.scheduleRetry = function (immediate) {
    var self = this;
    if (this.disposed || this.retryTimer) return;
    // immediate 只用于服务端明确说"重连就好"的场景（1013 输出跟不上）。
    // 但只给前两次开绿灯：真要是服务挂了，快速重试会变成打自己的服务器。
    var fast = immediate && this.retry < 2;
    var delay = fast ? 50 : Math.min(8000, 500 * Math.pow(2, this.retry));
    this.retry += 1;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self.retryAt = 0;
      self.connect();
    }, delay);
  };

  Session.prototype.send = function (kind, payload) {
    var ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    ws.send(frame);
  };

  Session.prototype.sendResize = function (cols, rows) {
    this.ptyCols = cols;
    this.ptyRows = rows;
    this.send(C.RESIZE, new TextEncoder().encode(JSON.stringify({ cols: cols, rows: rows })));
  };

  Session.prototype.setState = function (state) {
    this.opts.onState && this.opts.onState(state);
  };

  Session.prototype.blur = function () {
    this.focused = false;
  };

  Session.prototype.focus = function () {
    this.focused = true;
    // 焦点过来时补挂 WebGL：之前可能因为池满或藏在别的标签里没挂上。
    this.attachWebgl();
    if (this.term) this.term.focus();
  };

  // grab = "用户点了这一格"。拖选接管时事件被 stopPropagation 掉了，
  // 外层 pane 收不到 mousedown，只能由终端主动上报（见 Pane.mount 的 onGrab）。
  Session.prototype.grab = function () {
    if (this.opts.onGrab) this.opts.onGrab();
    else this.focus();
  };

  // loadHistory 拉一条历史记录，铺进终端，再补一个回车让 shell 重画提示符。
  //
  // 只在这个窗格"生来就是为了展示历史"时调用一次（opts.historyId）。
  Session.prototype.loadHistory = function () {
    var self = this;
    var id = this.opts.historyId;
    if (!id || this.disposed || !this.term) return;

    // 只取到这次接手之前的位置：再往后是新 shell 的启动输出（含清屏），
    // 铺回去会把历史擦掉。
    var q = '';
    if (typeof this.historyTo === 'number') q = '?to=' + this.historyTo;
    fetch(API + 'history/' + encodeURIComponent(id) + '/log' + q)
      .then(function (r) {
        if (!r.ok) return null;
        // 服务端默认只给最后 2MB。被省略时它把总大小和起点放在这两个头里，
        // 拼一句说明，省得用户以为记录短了。
        var total = parseInt(r.headers.get('X-History-Total') || '0', 10);
        var off = parseInt(r.headers.get('X-History-Offset') || '0', 10);
        return r.text().then(function (t) { return { text: t, total: total, off: off }; });
      })
      .then(function (res) {
        if (self.disposed || !res) return;
        // 这条老记录在接手续用之前是空的（比如打开过又立刻关掉）。此时
        // 什么都别铺：reset + 一条分界线只会把新 shell 的画面擦掉。
        if (!res.text) return;
        var foot = '';
        if (res.off > 0) {
          foot = '\x1b[2m—— 更早的内容已省略（共 ' + fmtBytes(res.total) +
            '，这里显示最后 ' + fmtBytes(res.total - res.off) + '）——\x1b[0m\r\n';
        }
        // 末尾不补换行：历史最后一行通常就是一个提示符，补换行会多出一个
        // 空行；后面那个回车会让 shell 自己把提示符打到下一行。
        // 末尾补一条分界线：历史里可能有大段输出，滚到中间时没人分得清
        // "哪一行开始是新的"。这条线就是那条边。
        var tail = '\r\n\x1b[2m── 以上是历史记录 ──\x1b[0m\r\n';
        self.writeHistory(res.text + (foot ? '\r\n' + foot : '') + tail, function () {
          if (self.disposed) return;
          // 历史铺完了，可 shell 的提示符在上一步的 reset 里被清掉了。
          // 敲一个空行让它自己重画 —— 不要用 term.write 伪造一个提示符：
          // 真实提示符带 git 分支、虚拟环境、conda 那些，伪造的迟早对不上。
          //
          // 这一个回车走 QUIET：它是我们补的，不是用户按的。走普通 INPUT 的话
          // 服务端会认定"人动手了"，静默期当场结束，于是每点开一次历史就多
          // 一行提示符 —— 正是 0.4.3 修掉的那个毛病。
          self.send(C.QUIET, new Uint8Array([13]));
        });
      })
      .catch(function () { /* 拿不到历史就当作一个普通的新标签 */ });
  };

  // guardReplayModes 在回放历史期间挡住"鼠标/焦点追踪"这类模式开关。
  //
  // 历史日志里留着程序当时发出的 \x1b[?1003h —— Claude Code 这类全屏程序
  // 一进来就把鼠标追踪打开。回放是原样重演，xterm 照着把鼠标报告也打开；
  // 可回放完接手的是刚起来的 shell，它根本不要鼠标报告，于是鼠标一动就往
  // 命令行里灌一串 "35;98;8M"（SGR 报告被 shell 当输入），屏幕上看起来就是
  // 不停地冒出乱码，而且和焦点在哪个标签无关 —— 报告是终端自己发的。
  //
  // 只挡这几个模式：SGR、光标移动、擦除这些照常放行，回放的画面才对。
  Session.prototype.guardReplayModes = function () {
    this.releaseReplayModes();
    var term = this.term;
    if (!term || !term.parser || !term.parser.registerCsiHandler) return;
    var modes = {
      9: 1, 1000: 1, 1002: 1, 1003: 1, 1004: 1,
      1005: 1, 1006: 1, 1015: 1, 1016: 1,
      // bracketed paste 也一起挡：历史里留着 ?2004h 的话，回放之后 term.paste
      // 会把内容包上 \x1b[200~，而对面那个 shell 自己没开这个模式，粘贴出来的
      // 文字前头就多一截转义字符。
      2004: 1,
    };
    var block = function (params) {
      for (var i = 0; i < params.length; i++) {
        var p = params[i];
        var n = Array.isArray(p) ? p[0] : p;
        if (typeof n === 'number' && modes[n]) return true;
      }
      return false;
    };
    var self = this;
    ['h', 'l'].forEach(function (fin) {
      try {
        self.replayGuards.push(term.parser.registerCsiHandler({ prefix: '?', final: fin }, block));
      } catch (e) { /* 老版本没有这个接口，靠 writeHistory 收尾时的兜底 */ }
    });
  };

  Session.prototype.releaseReplayModes = function () {
    for (var i = 0; i < this.replayGuards.length; i++) {
      try { this.replayGuards[i].dispose(); } catch (e) { }
    }
    this.replayGuards = [];
  };

  // installClipboardBridge 替程序把 OSC 52 的文本写进剪贴板。
  //
  // 这条序列是"选中即复制"的标准做法：程序把选中的文本 base64 一下，发
  //   ESC ] 52 ; c ; <base64> BEL
  // 由终端负责塞进系统剪贴板。Claude Code、tmux、Neovim 都靠它。
  //
  // 我们以前完全不认这条序列。Claude Code 拖选之后会在自己底下打一行
  // "sent N chars via OSC 52" —— 那句话是真的，它确实发出去了，只是没人接。
  // 于是剪贴板里还是上一次复制的内容：在里面选 5 行、粘出来却是早先那 3 行。
  //
  // 只做写、不做读：data 为 "?" 是查询剪贴板，一律不回。让程序读走系统
  // 剪贴板是隐私事故，xterm 自己也不支持。
  Session.prototype.installClipboardBridge = function (term) {
    if (!term || !term.parser || !term.parser.registerOscHandler) return;
    var self = this;
    try {
      term.parser.registerOscHandler(52, function (payload) {
        // 回放历史时不照做。
        //
        // 日志里留着程序当年发的 OSC 52（Claude Code 每次复制都会写一条），
        // 重放一遍就会把剪贴板刷成几年前的旧内容 —— 用户什么都没选，剪贴板
        // 却被改掉了。真实终端重连时也不会替历史里的字节动剪贴板。
        if (self.replaying) return true;
        var i = payload.indexOf(';');
        if (i < 0) return true;
        var data = payload.slice(i + 1);
        if (!data || data === '?') return true;   // 查询：不回
        var text = base64Text(data);
        if (!text) return true;

        // 刚拖完这一小段时间里，程序发来的 OSC 52 一律当作它在回放这次拖选，
        // 直接吞掉：不写剪贴板，也不提示。
        //
        // 这条序列是程序对"用户拖选"的自动反应，内容只含它渲染出的文字行
        // （Claude Code 的欢迎块就是 3 行），用户框进去的上下空行不在里面。
        // 更麻烦的是它可能落在你"再点一下想取消"的按下与松开之间 —— 程序先
        // 收到按下就发了序列，我们才收到松开。所以这条路上任何"写剪贴板"
        // 的动作都会让"取消"变成"偷偷复制了一次"。
        //
        // 于是规则回到最简单的一条：拖选只是拖选，只有右键（有选区）才会
        // 把文字放进剪贴板。超过这个窗口的程序复制（vim / tmux / ssh 的
        // osc52 插件主动复制）照常生效。
        if (self.lastDragAt && (Date.now() - self.lastDragAt) < DRAG_ECHO_MS) {
          return true;
        }

        // 回执：程序那边只会说"我发出去了"，剪贴板里到底有没有、有多少，
        // 只有终端自己知道。数字能拿去和程序那句 "sent N chars" 对账。
        var ok = self.copyText(text, true);
        var size = text.split('\n').length + ' 行（' + text.length + ' 个字符）';
        banner(ok
          ? '程序发来的 ' + size + '已写入剪贴板'
          : '浏览器拒绝写入剪贴板：' + size + '只留在了应用内（右键粘贴可用）',
          ok ? 'receipt' : 'warn');
        return true;
      });
    } catch (e) { /* 老版本没有这个接口：当作不支持，右键复制仍然可用 */ }
  };

  // finishCapture 收下最后一段回放字节，转去重铺。
  Session.prototype.finishCapture = function () {
    if (!this.captureReplay) return;
    this.captureReplay = false;
    this.replaying = false;
    this.replayPending = 0;
    clearTimeout(this.replayTimer);
    if (this.replayDec) {
      this.replayText += this.replayDec.decode();
      this.replayDec = null;
    }
    this.stitchResume();
  };

  // stitchResume 把"老记录 + 接手之后这一屏"拼成一整段重铺回屏幕。
  //
  // 日志里 0..histStart 是上一次留下的内容；会话自己的那一屏已经攥在
  // replayText 里。为什么不用日志拼后半段：接手时会静默一段时间，那会儿
  // shell 打出来的提示符按规定不记账（不然每点开一次就多一行），所以日志
  // 尾部反而缺了那个提示符；回放里是有的。
  //
  // 接法还有个细节：新 shell 的启动输出开头就是清屏，直接接在历史后面写，
  // 那一下清零会把刚铺好的历史擦掉。所以先把它连同后面那串看不见的填空
  // 单独写掉，再从屏幕顶部开始铺历史（见 splitBoot）。
  Session.prototype.stitchResume = function () {
    var self = this;
    var info = this.lastReady || {};
    var id = info.histId || this.opts.historyId;
    var fresh = this.replayText;
    this.replayText = null;

    // 重铺是个异步过程（取日志 + 分块写），期间到达的实时输出先攥着。
    this.histRendering = true;
    var tok = this.histTok = (this.histTok || 0) + 1;
    clearTimeout(this.histTimer);
    // 兜底：取日志卡住时不能把实时输出一直扣着，那样终端看起来就是死的。
    this.histTimer = setTimeout(function () {
      if (tok !== self.histTok) return;
      self.histTok++;
      self.endHistHold();
    }, 8000);

    var done = function () {
      if (tok !== self.histTok) return;
      self.histTok++;
      clearTimeout(self.histTimer);
      self.endHistHold();
    };
    var paint = function (text) {
      if (!text) { done(); return; }
      self.writeHistory(text, done);
    };

    if (!id || this.disposed || !this.term) { done(); return; }
    var only = typeof fresh === 'string';   // 有回放就只取历史那一段
    var seam = typeof info.histStart === 'number' ? info.histStart : 0;
    var url = API + 'history/' + encodeURIComponent(id) + '/log' + (only ? '?to=' + seam : '');

    fetch(url)
      .then(function (r) {
        if (!r.ok) return null;
        var total = parseInt(r.headers.get('X-History-Total') || '0', 10);
        var off = parseInt(r.headers.get('X-History-Offset') || '0', 10);
        return r.text().then(function (t) { return { text: t, total: total, off: off }; });
      })
      .then(function (res) {
        if (tok !== self.histTok || self.disposed || !self.term) return;
        if (!res) {
          // 取不到日志：至少把回放那一屏画出来，别留一块空白。
          if (only) paint(fresh); else done();
          return;
        }
        var note = '';
        if (res.off > 0) {
          note = '\x1b[2m—— 更早的内容已省略（共 ' + fmtBytes(res.total) +
            '，这里显示最后 ' + fmtBytes(res.total - res.off) + '）——\x1b[0m\r\n';
        }
        var older, post;
        if (only) {
          older = res.text;
          post = fresh;
        } else {
          var cut = Math.max(0, Math.min(res.text.length, seam - res.off));
          older = res.text.slice(0, cut);
          post = res.text.slice(cut);
        }
        var sp = splitBoot(post);
        paint(older
          ? sp.head + note + older + '\r\n\x1b[2m── 以上是历史记录 ──\x1b[0m\r\n' + sp.rest
          : note + sp.head + sp.rest);
      })
      .catch(function () {
        if (tok !== self.histTok || self.disposed) return;
        if (only) paint(fresh); else done();
      });
  };

  // endHistHold 放开"重铺期间攒下的实时输出"，按到达顺序补回去。
  Session.prototype.endHistHold = function () {
    this.histRendering = false;
    var held = this.histHold;
    this.histHold = [];
    for (var i = 0; i < held.length; i++) {
      if (this.term) this.term.write(held[i]);
    }
  };

  // writeHistory 把一条历史记录铺进终端。写完调用 done。
  //
  // 三件事必须做对：
  //   1) 先 reset —— 新窗格已经画好了光标和提示符，历史要占满整屏；
  //   2) 分块写 —— 几 MB 一次性交给 xterm 会把主线程卡住好几秒，界面
  //      像死了一样。每块 64KB，写完让出一帧，加载过程是能看见的；
  //   3) 上 replaying 锁 —— 历史里同样有终端查询（DA / DSR），xterm 会
  //      照规矩应答，应答走 onData 就进了后面那个 shell。这正是 0.2.21
  //      修的"重连冒出 1;2c: command not found"，换了个入口而已。
  Session.prototype.writeHistory = function (text, done) {
    var self = this;
    var fin = function () {
      self.replaying = false;
      self.releaseReplayModes();
      // 兜底关掉鼠标/焦点追踪：拦截器没装上（老 xterm）或者历史里用了个
      // 没列到的模式号时，至少保证回放结束后不会继续把鼠标移动当输入发。
      try {
        if (self.term) {
          self.term.write('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l' +
            '\x1b[?1006l\x1b[?2004l\x1b[?25h');
        }
      } catch (e) { }
      clearTimeout(self.historyTimer);
      self.paintAll();
      if (done) done();
    };
    if (!this.term || !text) { fin(); return; }

    this.term.reset();
    this.replaying = true;
    this.guardReplayModes();
    clearTimeout(this.historyTimer);
    // 兜底：万一某个 write 回调没回来，别把键盘永久锁死。
    this.historyTimer = setTimeout(function () { self.replaying = false; }, 30000);

    var CHUNK = 64 * 1024;
    var pos = 0;
    var step = function () {
      if (self.disposed || !self.term) { fin(); return; }
      if (pos >= text.length) { fin(); return; }
      var end = pos + CHUNK;
      // 别把代理对劈成两半（emoji、部分扩展汉字）。
      if (end < text.length) {
        var c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
      }
      var part = text.slice(pos, end);
      pos = end;
      self.term.write(part, function () { setTimeout(step, 0); });
    };
    step();
  };

  // installProtocolGuard 堵住 xterm 的一个小疏漏：重复设置同一个鼠标协议
  // 会清掉选区。
  //
  // set activeProtocol(v) 不做幂等判断，无条件 fire onProtocolChange；而
  // SelectionService 订阅了这个事件，收到就把选区清空。全屏程序（Claude
  // Code、vim、htop）在重绘或状态变化时会反复发 \x1b[?1000h —— 协议明明
  // 没变，选区却被清掉了。用户那边的现象就是"Shift 拖完一松手，高亮就没了，
  // 根本来不及右键"。
  //
  // 这里只短路"值没变"的调用，真切换协议（1000 → 1002 → NONE）照旧触发。
  // 内部结构若在别的 xterm 版本里改名，直接放弃保护 —— 复制功能另有快照
  // 兜底，不会因此坏掉。
  Session.prototype.installProtocolGuard = function () {
    try {
      var ms = this.term && this.term._core && this.term._core.coreMouseService;
      if (!ms || ms.__tsGuarded) return;
      var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ms), 'activeProtocol');
      if (!desc || !desc.get || !desc.set) return;
      Object.defineProperty(ms, 'activeProtocol', {
        configurable: true,
        get: function () { return desc.get.call(this); },
        set: function (v) {
          if (desc.get.call(this) === v) return;
          desc.set.call(this, v);
        }
      });
      ms.__tsGuarded = true;
    } catch (e) { /* 内部结构对不上就不保护了 */ }
  };

  // installSelectionLayer 自己画选区高亮。
  //
  // 为什么不用 xterm 自带的那层：全屏程序（Claude Code / Ink）每一帧都会把
  // 终端状态重设一遍 —— 重设鼠标协议、重进备用屏幕、切光标模式。xterm 的
  // 渲染器在这条路上会把"高亮层"丢掉：选区数据还在（右键照样能复制），
  // 但屏幕上没有那层底色。用户看到的就是"按住 Shift 拖动，高亮自己没了"，
  // 而我们在模型层面无论怎么验证都是"有选区"。
  //
  // 所以干脆自己画：在终端容器上盖一层绝对定位的 div，按选区范围摆色块。
  // 它跟 xterm 内部实现完全无关，程序怎么重绘都冲不掉；位置在每次重绘、
  // 滚动、改尺寸时重算，滚动历史时也跟着走。
  //
  // 代价是 xterm 自带的选择底色必须关掉（theme 里那两项置成全透明），
  // 否则两层叠在一起会明显偏深。
  Session.prototype.installSelectionLayer = function (host) {
    var self = this;
    try {
      var el = document.createElement('div');
      el.className = 'ts-sel';
      host.appendChild(el);
      this.selEl = el;
    } catch (e) {
      this.selEl = null;
      return;
    }

    var schedule = function () {
      if (self.selPaintRAF) return;
      self.selPaintRAF = requestAnimationFrame(function () {
        self.selPaintRAF = 0;
        self.paintSelection();
      });
    };
    try { this.term.onSelectionChange(schedule); } catch (e) { }
    try { this.term.onScroll(schedule); } catch (e) { }
    try { this.term.onResize(schedule); } catch (e) { }
    try { this.term.onWriteParsed(schedule); } catch (e) { }
  };

  // cellMetrics 量出"一个字符格"在宿主元素里的位置和大小。
  // 每次重画都重新量：改字号不一定改行列数，缓存会拿到旧的字高。
  Session.prototype.cellMetrics = function () {
    var t = this.term, host = this.host;
    if (!t || !host || !t.element) return null;
    var scr = t.element.querySelector('.xterm-screen');
    if (!scr) return null;
    var sr = scr.getBoundingClientRect();
    var hr = host.getBoundingClientRect();
    var w = t.cols ? sr.width / t.cols : 0;
    var h = t.rows ? sr.height / t.rows : 0;
    try {
      var dims = t._core && t._core._renderService && t._core._renderService.dimensions;
      if (dims && dims.css && dims.css.cell && dims.css.cell.width > 0) {
        w = dims.css.cell.width;
        h = dims.css.cell.height;
      }
    } catch (e) { }
    return { w: w, h: h, left: sr.left - hr.left, top: sr.top - hr.top };
  };

  // mouseTracking 程序此刻是不是在收鼠标事件。
  //
  // 收事件的时候不能抢它的拖动（点按钮、拖滑块都靠这些事件），只有按住
  // Shift 才让给我们 —— 这和 iTerm / GNOME Terminal / Windows Terminal
  // 的约定一致：全屏程序里按 Shift 才是"我要选文字"。
  Session.prototype.mouseTracking = function () {
    try {
      var m = this.term && this.term.modes && this.term.modes.mouseTrackingMode;
      return !!m && m !== 'none';
    } catch (e) { return false; }
  };

  // cellAt 把鼠标坐标换成缓冲区里的单元格（列 / 绝对行号）。
  Session.prototype.cellAt = function (e) {
    var t = this.term, host = this.host;
    if (!t || !host) return null;
    var m = this.cellMetrics();
    if (!m || !(m.w > 0) || !(m.h > 0)) return null;
    var hr = host.getBoundingClientRect();
    var x = (e.clientX - hr.left - m.left) / m.w;
    var y = (e.clientY - hr.top - m.top) / m.h;
    var buf = t.buffer && t.buffer.active;
    if (!buf) return null;
    var col = Math.max(0, Math.min(t.cols, Math.floor(x)));
    var row = buf.viewportY + Math.max(0, Math.min(t.rows - 1, Math.floor(y)));
    return { col: col, row: row };
  };

  // selectToken 双击选一个词、三击选一行。
  //
  // 词的定义按"读起来像一段"来：字母数字和下划线算词字符；中文一个字
  // 就是一个词（一长串中文整体选中反而不好用）；落在标点/空白上时选中
  // 那一段连续的非空白字符。
  Session.prototype.selectToken = function (cell, count) {
    var t = this.term, buf = t && t.buffer && t.buffer.active;
    if (!buf) return;
    var line = buf.getLine(cell.row);
    if (!line) return;
    var text = line.translateToString(true);
    var a = Math.min(cell.col, Math.max(0, text.length - 1));
    var b;

    if (count >= 3) {
      a = 0;
      b = text.length;
    } else if (!text.length) {
      a = 0;
      b = 0;
    } else {
      var isWord = function (ch) { return !!ch && /[A-Za-z0-9_@#$%&+\-./\\:~]/.test(ch); };
      var isCJK = function (ch) { return !!ch && ch.charCodeAt(0) >= 0x2e80; };
      if (isCJK(text[a])) {
        b = a + 1;
      } else if (isWord(text[a])) {
        while (a > 0 && isWord(text[a - 1])) a--;
        b = a;
        while (b < text.length && isWord(text[b])) b++;
      } else {
        // 标点或空白：选中连续的非空白字符
        var solid = function (ch) { return !!ch && !/\s/.test(ch); };
        while (a > 0 && solid(text[a - 1])) a--;
        b = a;
        while (b < text.length && solid(text[b])) b++;
      }
    }

    this.selDrag = null;
    this.selRange = { sx: a, sy: cell.row, ex: Math.min(b, t.cols), ey: cell.row };
    var sel = this.rangeText();
    if (!sel) { this.clearSelection(); return; }
    this.selSnap = { text: sel };
    this.paintSelection();
  };

  Session.prototype.beginSelection = function (cell, e, block) {
    this.selDrag = {
      anchor: cell, focus: cell, moved: false,
      x: e ? e.clientX : 0, y: e ? e.clientY : 0,
      block: !!block,
    };
    this.selSnap = null;
    this.selRange = { sx: cell.col, sy: cell.row, ex: cell.col, ey: cell.row };
    this.paintSelection();
  };

  Session.prototype.dragSelection = function (cell, e) {
    var d = this.selDrag;
    if (!d) return;
    // "是拖动还是单击"按像素判断，不按单元格：手抖两下、或者一格里挪了
    // 半格，都还是单击；真的拖开了才算选中。按单元格判断的话，短距离
    // 拖动会被当成点击，选区当场被收掉 —— 看起来就是"一松手框就没了"。
    if (e && (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3)) d.moved = true;
    if (cell.col !== d.focus.col || cell.row !== d.focus.row) d.moved = true;
    d.focus = cell;
    this.setRangeFromDrag();
    this.paintSelection();
  };

  // setRangeFromDrag 把锚点和当前点规整成"左上 → 右下、结束列不含"的范围。
  // 反着拖（右往左、下往上）全靠这一步归一。
  Session.prototype.setRangeFromDrag = function () {
    var d = this.selDrag;
    if (!d) return;
    var a = d.anchor, f = d.focus;
    var backwards = (f.row < a.row) || (f.row === a.row && f.col < a.col);
    var s = backwards ? f : a;
    var e = backwards ? a : f;
    var cols = this.term ? this.term.cols : e.col + 1;
    this.selRange = {
      sx: s.col, sy: s.row,
      ex: Math.min(e.col + 1, cols), ey: e.row,
    };
  };

  Session.prototype.endSelection = function () {
    var d = this.selDrag;
    this.selDrag = null;
    if (!d) return;
    if (!d.moved) {
      // 只是点了一下，没有拖动 —— 不算选中。
      this.clearSelection();
      return;
    }
    var text = this.rangeText();
    if (!text) { this.clearSelection(); return; }
    this.selSnap = { text: text };
    // 只记一个时刻，不再留一份文本。
    //
    // 全屏程序开着鼠标追踪时，我们照样记范围但不拦事件：Claude Code 收到
    // 鼠标报告会自己画框、自己发一条 OSC 52，内容只含它渲染出来的文字行
    // （欢迎块就是那 3 行）。那条序列是程序在**回放这次拖选**，不是用户
    // 要求的复制；它落在 mouseup 之后，甚至可能正好落在你"再点一下想取消"
    // 的按下与松开之间（程序先收到按下、先发了序列，我们才收到松开）。
    //
    // 所以这个时刻的唯一用途是"吞掉回放"，见 installClipboardBridge。
    // 以前这里存了文本、把回声换成用户框的内容再写剪贴板，等于让拖选变成
    // 静默自动复制："拖一下 → 点一下想取消 → 却提示复制成功"，就是那么来的。
    this.lastDragAt = Date.now();
    this.paintSelection();
  };

  // rangeText 直接按范围从缓冲区里取字。
  //
  // 不经过 xterm 的选区服务：那玩意儿会被全屏程序的重绘清掉，而且清掉的
  // 时机完全不可预测。缓冲区里的文字才是唯一可靠的来源。
  //
  // **换行是保留的**：这是"一个屏幕行 = 一行文本"，行与行之间拼 '\n'，选中
  // 的中间空行也会原样留下（空行取出来是空串，join 之后就是连续两个 '\n'）。
  // 裁掉的只有每行末尾那截**终端填充**，不是换行，也不会把两行粘成一行。
  //
  // raw=true 走"原样"通道（Ctrl+Shift+Insert），除了 xterm 自己对 ASCII
  // 空格的裁剪之外不做任何加工：连行尾的 NBSP、末尾的空行都留着。给那些
  // 真的要精确空白的地方用（对齐的表格、填好的定宽文本）。
  Session.prototype.rangeText = function (raw) {
    var t = this.term, r = this.selRange;
    if (!t || !r) return '';
    var buf = t.buffer && t.buffer.active;
    if (!buf) return '';
    var out = [];
    for (var y = r.sy; y <= r.ey; y++) {
      var line = buf.getLine(y);
      if (!line) { out.push(''); continue; }
      var a = (y === r.sy) ? r.sx : 0;
      var b = (y === r.ey) ? r.ex : t.cols;
      // 行尾空白是终端补的，复制出来只会碍事 —— 而且必须是**每一行**都裁。
      //
      // xterm 的 translateToString(true) 只把 U+0020 当空格裁，别的空白
      // （U+00A0 不换行空格、U+3000 全角空格）原样留着。全屏 TUI 正好爱用
      // 它们把每行补满整宽：复制出来每行后面拖着上百个不可见字符，粘到
      // 会折行的地方（Claude Code 的输入框）就每行折出一个"空行" ——
      // 三行文本粘出来变五行。宽文本框里看不出来，所以只在某一处复发。
      var s = line.translateToString(true, a, b);
      out.push(raw ? s : s.replace(/[\s\u200b\ufeff]+$/, ''));
    }
    var text = out.join('\n');
    if (raw) return text;
    // 结尾的空行**不再裁**。
    //
    // 以前这里有个 replace(/\s+$/,'')，本意是抹掉最后一行那截终端填充。但
    // 每行的填充在上面已经按行裁过了，这一下能裁到的只剩**用户真的框进去
    // 的空行** —— 选 5 行（3 行字 + 2 行空）粘出来只剩 3 行，就是这么来的。
    // Windows 终端里框住 5 行就是 5 行，空行也算，这里保持一致：N 行就是
    // N 行、N-1 个换行，不多也不少。
    //
    // 唯一的特例：整块空白且只框了一行时 join 出来是空串，而空串会被上层
    // 当成"没选中"（右键落到粘贴、松手就清选区）。给一个换行，和 Windows
    // 终端"复制一个空行得到换行"一致。
    return text === '' ? '\n' : text;
  };

  Session.prototype.paintSelection = function () {
    var el = this.selEl;
    if (!el) return;
    try {
      this.paintSelectionInner(el);
    } catch (e) {
      // 画不出来也不能把这一层拆了：拆了以后就再也没有高亮可画。
      // 清空内容即可，下次重绘再试。
      try { el.textContent = ''; } catch (e2) { }
    }
  };

  Session.prototype.paintSelectionInner = function (el) {
    var t = this.term, r = this.selRange;
    el.textContent = '';
    if (!t || !r) return;

    var buf = t.buffer && t.buffer.active;
    if (!buf) return;
    var vp = buf.viewportY;
    var top = Math.max(r.sy, vp);
    var bottom = Math.min(r.ey, vp + t.rows - 1);
    if (bottom < top) return;

    var m = this.cellMetrics();
    if (!m || !(m.w > 0) || !(m.h > 0)) return;

    var frag = document.createDocumentFragment();
    for (var y = top; y <= bottom; y++) {
      var x0 = y === r.sy ? r.sx : 0;
      var x1 = y === r.ey ? r.ex : t.cols;
      if (x1 <= x0) continue;
      var d = document.createElement('div');
      d.style.left = (m.left + x0 * m.w) + 'px';
      d.style.top = (m.top + (y - vp) * m.h) + 'px';
      d.style.width = ((x1 - x0) * m.w) + 'px';
      d.style.height = m.h + 'px';
      frag.appendChild(d);
    }
    el.appendChild(frag);
  };

  // selectionText 返回"这次右键该复制的内容"。
  //
  // 范围还在就现取（缓冲区可能已经变了，现取最准）；范围没了就用上次的
  // 快照。快照什么时候作废由用户行为决定，不按时间：
  //   - 在别处点了左键（非 Shift）、按了键盘
  //   - 我们自己复制完主动收掉
  // 之所以不设有效期：框和文字都在我们手里，程序重绘动不了它们。
  // 以前按 15 秒过期，用户慢慢读一会儿再右键就变成粘贴。
  Session.prototype.selectionText = function (raw) {
    if (this.selRange) {
      var live = this.rangeText(raw);
      if (live) return live;
    }
    return this.selSnap ? this.selSnap.text : '';
  };

  // clearSelection 把框、范围、快照一起收掉 —— 复制完就走这条路，
  // 于是紧接着的下一次右键必然是粘贴。
  Session.prototype.clearSelection = function () {
    this.selSnap = null;
    this.selRange = null;
    this.selDrag = null;
    // 刻意不动 lastDragAt：取消之后程序那条回声可能还在路上（它是在你按下
    // 左键时发出来的，比松开还早）。这里要是把时刻清掉，回声就成了"没有
    // 框选、可以照常生效"，刚好在你点一下想取消的瞬间把剪贴板写掉 —— 取消
    // 也就白点了。让它自己按时间过期，见 DRAG_ECHO_MS。
    // xterm 自己那份选区也清掉：虽然不用它，但留着会让浏览器原生复制
    // （Ctrl+C 在非终端焦点时）拿到不一致的内容。
    try { if (this.term) this.term.clearSelection(); } catch (e) { }
    this.paintSelection();
  };

  // copy 复制当前选区（快捷键走这里），返回是否真的复制到了东西。
  // 与右键共用 selectionText，所以高亮已被冲掉时快照内容也能复制；
  // 区别是这里不清选区 —— Ctrl+Insert 之后多半还要继续用鼠标。
  Session.prototype.copy = function (raw) {
    var text = this.selectionText(raw);
    if (!text) return false;
    this.copyText(text);
    return true;
  };

  // copyText 把一段文本写进系统剪贴板。
  //
  // quiet 用于程序自己发起的复制（OSC 52）：写不进去不弹提示。Claude Code
  // 那边本来就会打一句"paste fails 就按住 Shift 选"，再叠一条我们自己的
  // 警告只是噪音；应用内剪贴板照样记下来，终端里右键粘贴仍然拿得到。
  Session.prototype.copyText = function (text, quiet) {
    if (!text) return false;

    // 无论系统剪贴板写不写得进去，都在页面内留一份 —— http 下右键粘贴
    // 靠的就是它（writeText 在非安全上下文连方法都没有）。
    rememberClip(text);

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(function () { });
      return true;
    }

    // 非安全上下文（http 直连 IP）没有 async clipboard API，
    // 退回到老办法：临时 textarea + execCommand。
    //
    // 这里必须先记下焦点。ta.select() 会把键盘焦点从 xterm 的隐藏输入框
    // 抢到临时 textarea 上，removeChild 之后焦点就掉到 body —— 浏览器从此
    // 不再把 paste 事件送给终端，Ctrl+V 按了没反应。程序自己发的 OSC 52
    // 每次拖选都会走这里，结果就是"剪贴板明明写进去了，却怎么也粘不出来"，
    // 看起来和完全没修一样。右键复制也同样中招，只是以前没人把这两件事
    // 连起来看。
    var prev = document.activeElement;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    // 焦点原样还回去。preventScroll 不能省：终端里常滚到上面几屏看输出，
    // focus 默认会把页面滚回输入框，一下就把用户正在看的内容挪走了。
    if (prev && prev !== document.body && prev.focus && document.contains(prev)) {
      try { prev.focus({ preventScroll: true }); }
      catch (e) { try { prev.focus(); } catch (e2) { } }
    }
    if (!ok && !quiet) banner('浏览器不允许写入剪贴板，请用 Ctrl+Insert 或系统复制', 'warn');
    // 返回真实结果：调用方（OSC 52 的回执）要如实说写没写进去，
    // 一律报 true 的话"程序复制了但剪贴板没变"这种情况就永远看不出来。
    return ok;
  };

  // paste 把系统剪贴板的内容送进终端。
  //
  // 读剪贴板要求"安全上下文"：HTTPS，或者 http://localhost。局域网直连
  // （http://192.0.2.20:5666）两者都不是，navigator.clipboard 整个是
  // undefined，document.execCommand('paste') 也被禁 —— 这是浏览器的硬限制，
  // 网页没有任何接口能主动读剪贴板。
  //
  // 所以 http 页面根本走不到这里：右键、Ctrl+Shift+V、Shift+Insert 全部
  // 放行给浏览器，或者直接用右键分支里的应用内剪贴板。下面这个分支只有在
  // "安全上下文但用户拒绝了权限"时才落到，那时也先试内部剪贴板兜一层。
  Session.prototype.paste = function () {
    var self = this;
    if (!this.term) return;

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.readText().then(function (text) {
        if (text) self.term.paste(text);
      }).catch(function () {
        // 权限被拒：能粘本页刚复制的那段也比什么都没有强。
        if (self.pasteInner()) return;
        self.awaitPaste();
      });
      return;
    }
    this.awaitPaste();
  };

  // pasteInner 粘应用内剪贴板（本页最近一次复制的文字），返回是否粘上了。
  // http 下的"右键一步粘贴"靠它；HTTPS 下作为权限被拒时的兜底。
  //
  // 回执报的是"这一次往终端里送了几行"，不是"屏幕上能看见几行"。
  // 全屏程序（Claude Code 的输入框）收到多行文本之后会自己决定怎么显示：
  // 消息末尾的空行几乎都会被它去掉，于是 5 行看起来只有 3 行。把发出去的
  // 行数报出来，才能分清是终端少送了还是程序少显示了。
  Session.prototype.pasteInner = function () {
    var text = readInnerClip();
    if (!text || !this.term) return false;
    this.term.paste(text);
    this.focus();
    banner('已粘贴 ' + text.split('\n').length + ' 行（' + text.length + ' 个字符）', 'info');
    return true;
  };

  // awaitPaste 是最后的兜底：把焦点摆好，把还能用的入口说准。
  //
  // 只说右键菜单，不说快捷键：这套复制粘贴从头到尾都是鼠标完成的。
  // 右键菜单里的"粘贴"由浏览器自己执行，非安全上下文照样能用。
  Session.prototype.awaitPaste = function () {
    this.focus();
    banner('这个页面读不到剪贴板：右键点一下，选菜单里的「粘贴」', 'ask');
  };

  Session.prototype.dispose = function () {
    this.disposed = true;
    this.focused = false;
    // 重铺还没走完就被销毁：把攒下的实时输出丢掉，别再往一个已经
    // dispose 过的 term 里写。
    clearTimeout(this.histTimer);
    this.histTok = (this.histTok || 0) + 1;
    this.histRendering = false;
    this.histHold = [];
    this.captureReplay = false;
    this.replayText = null;
    this.replayDec = null;
    this.detachWebgl(); // 先还上下文，再销毁 term
    if (this.bufSub) { try { this.bufSub.dispose(); } catch (e) { } this.bufSub = null; }
    clearTimeout(this.retryTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.selTimer);
    if (this.ro) { try { this.ro.disconnect(); } catch (e) { } }
    if (this.ws) { try { this.ws.close(); } catch (e) { } }
    if (this.term) { try { this.term.dispose(); } catch (e) { } }
    this.term = null;
  };

  // ------------------------------------------------------------ 布局节点
  //
  // 叶子 { type:'leaf', id }
  // 分割 { type:'split', dir:'row'|'col', sizes:[n,n...], children:[...] }
  //
  // dir='row' 表示子节点横向排列（左右分屏），'col' 表示纵向排列（上下分屏）。

  function leafNode(paneId) {
    return { type: 'leaf', id: paneId };
  }

  function splitNode(dir, a, b) {
    return { type: 'split', dir: dir, sizes: [1, 1], children: [a, b] };
  }

  function eachLeaf(node, fn) {
    if (!node) return;
    if (node.type === 'leaf') { fn(node); return; }
    for (var i = 0; i < node.children.length; i++) eachLeaf(node.children[i], fn);
  }

  function countLeaves(node) {
    var n = 0;
    eachLeaf(node, function () { n++; });
    return n;
  }

  // 在树里把 targetId 这个叶子替换成 fn(leaf) 的返回值。
  function replaceLeaf(node, targetId, fn) {
    if (node.type === 'leaf') {
      return node.id === targetId ? fn(node) : node;
    }
    for (var i = 0; i < node.children.length; i++) {
      node.children[i] = replaceLeaf(node.children[i], targetId, fn);
    }
    return node;
  }

  // 从树里摘掉一个叶子，同时顺手把只剩一个孩子的分割节点折叠掉 ——
  // 不折叠的话关窗格会留下空的白框，越用越乱。
  function removeLeaf(node, targetId) {
    if (node.type === 'leaf') return node.id === targetId ? null : node;

    var kids = [];
    var sizes = [];
    for (var i = 0; i < node.children.length; i++) {
      var r = removeLeaf(node.children[i], targetId);
      if (r) { kids.push(r); sizes.push(node.sizes[i] || 1); }
    }
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    node.children = kids;
    node.sizes = sizes;
    return node;
  }

  // ------------------------------------------------------------------ Tab

  // maxTabName 是自定义标签名的长度上限。
  //
  // 标签最宽 220px、字号 12px，再长就只剩"..."了。真正的全名在悬停提示里，
  // 所以这里只挡一个离谱的长字符串（粘一整条命令进来那种），不必精确到像素。
  var maxTabName = 40;

  function Tab(ws, spec) {
    this.ws = ws;
    this.id = spec.id || uid('t');
    this.title = spec.title || '终端';
    // custom 是用户双击标签改的名字。空字符串表示"没改过，跟着终端标题走"，
    // 而不是"名字叫空"—— 清空输入框就是恢复自动命名的意思。
    this.custom = spec.custom || '';
    this.root = spec.root || null;
    this.activePaneId = spec.activePaneId || null;
    this.panes = {};
    this.view = null;
    this.el = null;
  }

  // autoLabel 是"不干预时标签会显示什么"：跟着活动窗格的终端标题走
  // （shell、vim、claude 都会设 OSC 标题）。
  Tab.prototype.autoLabel = function () {
    var p = this.activePane();
    return p ? shortTitle(p.title) : '终端';
  };

  // label 是标签上真正显示的名字：改过就是那个名字，否则跟着程序走。
  Tab.prototype.label = function () {
    return this.custom || this.autoLabel();
  };

  // paintLabel 把名字刷进 DOM。
  //
  // 顺带同步 t.title：布局落盘存的是它，刷新之后至少先显示上次的名字，
  // 而不是一排"终端"等会话连上来再改。
  Tab.prototype.paintLabel = function () {
    var s = this.label();
    this.title = s;
    if (this.el) {
      var span = this.el.querySelector('.title');
      if (span) {
        span.textContent = s;
        // 名字被省略号截断时，鼠标停上去能看到全的。
        span.title = s;
      }
    }
    if (this.ws.activeTabId === this.id) document.title = s + ' — TerminalS';
  };

  // beginRename 把标签上的名字换成一个输入框（双击标签进入）。
  //
  // 初值给的是"现在显示的名字"并全选，而不是空的：改名十有八九是在原名
  // 基础上微调，从空白开始等于让人重新打一遍。
  Tab.prototype.beginRename = function () {
    if (!this.el || this.el.querySelector('.tab-input')) return false;

    var self = this;
    var span = this.el.querySelector('.title');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-input';
    input.maxLength = maxTabName;
    input.spellcheck = false;
    input.value = this.label();
    input.setAttribute('aria-label', '工作区名称');

    // 宽度按"现在多宽"锁死，编辑态和显示态一模一样。
    //
    // 不锁的话会被 CSS 的 min-width 或内容宽度改变：以前编辑时把 min-width
    // 抬到 200px，双击的瞬间这个标签宽出一截，后面所有标签全被挤走，标签一
    // 多就是整条标签栏跳一下，改完再跳回来。宽度只在这一段输入期间固定，
    // 结束时三个内联样式一起清掉，标签自己回到内容撑开的宽度。
    var w = this.el.getBoundingClientRect().width;
    span.style.display = 'none';
    this.el.classList.add('renaming');
    if (w > 0) {
      this.el.style.width = w + 'px';
      this.el.style.minWidth = w + 'px';
      this.el.style.maxWidth = w + 'px';
    }
    this.el.insertBefore(input, span);

    var done = false;
    var finish = function (commit) {
      if (done) return;
      done = true;
      input.remove();
      span.style.display = '';
      self.el.classList.remove('renaming');
      self.el.style.width = '';
      self.el.style.minWidth = '';
      self.el.style.maxWidth = '';
      if (!commit) return;

      // 折成一行、去掉首尾空白，再按长度截断 —— 换行会把标签撑成两行。
      var v = input.value.replace(/\s+/g, ' ').trim().slice(0, maxTabName);
      // 内容如果正好还是自动名，就当没改过。双击看一眼、顺手回车一下
      // 不该把名字钉死 —— 那样 claude、vim 之后改标题，标签就不跟着动了。
      self.custom = v && v !== self.autoLabel() ? v : '';
      self.paintLabel();
      self.ws.save();
    };

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    // 点到别处、Tab 走开都算保存 —— 和文件重命名、地址栏改网址一个约定。
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });

    // 焦点要等到这一帧的 activateTab 把终端接过去之后再抢回来：双击的两下
    // click 都会走 activateTab，它里面的 rAF 会 pane.focus()，先 focus 会被顶掉。
    requestAnimationFrame(function () {
      if (done) return;
      input.focus();
      input.select();
    });
    return true;
  };

  Tab.prototype.pane = function (id) {
    return this.panes[id] || null;
  };

  Tab.prototype.activePane = function () {
    return this.pane(this.activePaneId) || this.firstPane();
  };

  Tab.prototype.firstPane = function () {
    var found = null;
    eachLeaf(this.root, function (leaf) {
      if (!found && this.panes[leaf.id]) found = this.panes[leaf.id];
    }.bind(this));
    return found;
  };

  Tab.prototype.addPane = function (pane) {
    this.panes[pane.id] = pane;
  };

  Tab.prototype.dropPane = function (id) {
    delete this.panes[id];
  };

  // 把布局树渲染成 DOM。已有的 pane.el 会被"搬"进新结构里，
  // 不重建 —— 重建会丢掉 xterm 的滚动历史。
  Tab.prototype.render = function () {
    var self = this;
    var frag = document.createDocumentFragment();
    frag.appendChild(this.renderNode(this.root));
    this.view.replaceChildren(frag);

    // 只有一个窗格时没有"可关的东西" —— 关掉就等于关标签，所以 × 藏起来，
    // 只留滚动条。用 CSS 的 visibility 而不是 display，占位还在，
    // 滚动条的顶端位置不会因为少一个按钮往上跳。
    this.view.classList.toggle('solo', countLeaves(this.root) <= 1);

    eachLeaf(this.root, function (leaf) {
      var p = self.panes[leaf.id];
      if (p) p.el.style.display = 'flex';
    });
    // 轨道高度要等这一帧布局完才是真实值。
    requestAnimationFrame(function () {
      eachLeaf(self.root, function (leaf) {
        var p = self.panes[leaf.id];
        if (p) { p._trackH = 0; p.scheduleScrollSync(); }
      });
    });
  };

  Tab.prototype.renderNode = function (node) {
    if (node.type === 'leaf') {
      var pane = this.panes[node.id];
      if (pane) return pane.el;
      var ph = el('div', 'pane broken');
      ph.textContent = '窗格丢失';
      return ph;
    }

    var wrap = el('div', 'split ' + (node.dir === 'row' ? 'dir-row' : 'dir-col'));

    for (var i = 0; i < node.children.length; i++) {
      if (i > 0) wrap.appendChild(this.renderGutter(node, i - 1));
      var cell = el('div', 'sc');
      cell.style.flexGrow = String(node.sizes[i] || 1);
      cell.appendChild(this.renderNode(node.children[i]));
      wrap.appendChild(cell);
    }
    return wrap;
  };

  // 分隔条：拖拽调比例。
  //
  // 比例按 flex-grow 存，不存像素 —— 窗口大小变了以后比例才对得上，
  // 存像素的话换个屏幕分屏宽度就全乱了。
  Tab.prototype.renderGutter = function (node, index) {
    var self = this;
    var g = el('div', 'gutter ' + (node.dir === 'row' ? 'v' : 'h'));
    g.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();

      var wrap = g.parentNode;
      var box = wrap.getBoundingClientRect();
      var total = node.dir === 'row' ? box.width : box.height;
      if (total <= 0) return;

      var kids = wrap.querySelectorAll(':scope > .sc');
      var a = kids[index], b = kids[index + 1];
      if (!a || !b) return;

      var aStart = node.dir === 'row' ? a.getBoundingClientRect().width
        : a.getBoundingClientRect().height;
      var bStart = node.dir === 'row' ? b.getBoundingClientRect().width
        : b.getBoundingClientRect().height;
      var sum = aStart + bStart;
      var start = node.dir === 'row' ? e.clientX : e.clientY;

      document.body.classList.add('resizing');
      g.classList.add('dragging');

      function move(ev) {
        var pos = node.dir === 'row' ? ev.clientX : ev.clientY;
        var delta = pos - start;
        // 每个窗格至少留 60px，再小 xterm 会算出 1 列，看着像卡死。
        var na = Math.max(60, Math.min(sum - 60, aStart + delta));
        a.style.flexGrow = String(na);
        b.style.flexGrow = String(Math.max(60, sum - na));
      }

      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        g.classList.remove('dragging');

        // 松手后才把比例写回模型并重排：拖拽过程中算列宽会让 TUI 疯狂重绘。
        var ga = parseFloat(a.style.flexGrow) || 1;
        var gb = parseFloat(b.style.flexGrow) || 1;
        node.sizes[index] = ga / (ga + gb);
        node.sizes[index + 1] = gb / (ga + gb);
        for (var k = 0; k < node.sizes.length; k++) {
          if (k !== index && k !== index + 1) node.sizes[k] = node.sizes[k] || 1 / node.children.length;
        }
        eachLeaf(node.children[index], function (leaf) {
          var p = self.panes[leaf.id]; if (p) p.fit();
        });
        eachLeaf(node.children[index + 1], function (leaf) {
          var p = self.panes[leaf.id]; if (p) p.fit();
        });
        self.ws.save();
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return g;
  };

  // ------------------------------------------------------------- Workspace

  function Workspace() {
    this.tabs = [];
    this.activeTabId = null;
    // 已经移出界面、但在服务端还跑着的会话：{sid, title, at}。
    // 只是"我主动收起来的"记录，真正的存活情况以 GET /api/sessions 为准。
    this.background = [];
    this.settings = cachedSettings();
    this.fontSize = this.settings.fontSize;
    this.saveTimer = null;
    this.loading = true;
  }

  Workspace.prototype.paneCount = function () {
    var n = 0;
    for (var i = 0; i < this.tabs.length; i++) {
      eachLeaf(this.tabs[i].root, function () { n++; });
    }
    return n;
  };

  Workspace.prototype.tab = function (id) {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) return this.tabs[i];
    }
    return null;
  };

  Workspace.prototype.activeTab = function () {
    return this.tab(this.activeTabId) || this.tabs[0] || null;
  };

  Workspace.prototype.activePane = function () {
    var t = this.activeTab();
    return t ? t.activePane() : null;
  };

  // ------------------------------------------------------------ 持久化

  Workspace.prototype.serialize = function () {
    var self = this;
    return {
      version: 1,
      activeTabId: this.activeTabId,
      // 后台会话不进 tabs，但必须落盘：换个浏览器打开、或者关掉窗口再回来，
      // 都得能看见"还有哪些东西在跑"，否则就变成了没人认领的孤儿进程。
      background: this.background.map(function (b) {
        return { sid: b.sid, title: b.title, at: b.at };
      }),
      tabs: this.tabs.map(function (t) {
        var leaves = {};
        eachLeaf(t.root, function (leaf) {
          var p = t.panes[leaf.id];
          leaves[leaf.id] = p ? { sid: p.sid, title: p.title } : { sid: null, title: '' };
        });
        return {
          id: t.id,
          title: t.title,
          // 用户双击标签改的名字要单独存：title 是"眼下显示的那句话"，
          // 会随程序改标题而变，光存它等于每次刷新都丢掉用户起的名字。
          custom: t.custom,
          activePaneId: t.activePaneId,
          root: t.root,
          leaves: leaves
        };
      })
    };
  };

  Workspace.prototype.save = function () {
    var self = this;
    if (this.loading) return;
    clearTimeout(this.saveTimer);
    // 防抖 400ms：拖分隔条时每个 mousemove 都写盘会把磁盘写爆。
    this.saveTimer = setTimeout(function () { self.flush(); }, 400);
  };

  // keepalive 用于"写完之后页面马上就要关掉"的场景：普通 fetch 会随页面
  // 一起被取消，请求根本到不了服务端，结果就是布局没清干净、下次刷新
  // 又把死掉的分屏复原回来。
  Workspace.prototype.flush = function (keepalive) {
    var body;
    try { body = JSON.stringify(this.serialize()); } catch (e) { return; }
    var opt = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body
    };
    if (keepalive) opt.keepalive = true;
    fetch(API + 'layout', opt).catch(function () {
      banner('布局保存失败，刷新后可能回不到当前分屏', 'warn');
    });
  };

  Workspace.prototype.restore = function (data) {
    if (!data) return false;

    // 先接回后台清单，哪怕一个标签都没恢复：这些会话还在服务端跑着，
    // 不列出来用户就再也找不到它们了（只能靠刷 sessions 接口）。
    if (Object.prototype.toString.call(data.background) === '[object Array]') {
      this.background = data.background.filter(function (b) {
        return b && typeof b.sid === 'string' && b.sid;
      }).map(function (b) {
        return { sid: b.sid, title: b.title || '后台会话', at: b.at || 0 };
      });
    }

    if (!data.tabs || !data.tabs.length) return false;
    for (var i = 0; i < data.tabs.length; i++) {
      var td = data.tabs[i];
      if (!td.root) continue;
      var t = new Tab(this, {
        id: td.id,
        title: td.title,
        custom: td.custom,
        root: td.root,
        activePaneId: td.activePaneId
      });

      var leaves = {};
      eachLeaf(td.root, function (leaf) {
        var meta = (td.leaves && td.leaves[leaf.id]) || {};
        leaves[leaf.id] = { sid: meta.sid || null, title: meta.title || '终端' };
      });
      for (var pid in leaves) {
        if (!Object.prototype.hasOwnProperty.call(leaves, pid)) continue;
        t.addPane(new Pane(this, { id: pid, sid: leaves[pid].sid, title: leaves[pid].title }));
      }

      this.tabs.push(t);
    }
    if (!this.tabs.length) return false;
    this.activeTabId = this.tab(data.activeTabId) ? data.activeTabId : this.tabs[0].id;
    return true;
  };

  // ------------------------------------------------------------ 标签操作

  // spec 用来接回一个已有会话（后台清单里那个）：传 {sid, title} 就走同一个
  // 建标签流程，只是首个窗格连的是旧 sid，而不是新开一个 shell。
  Workspace.prototype.newTab = function (focus, spec) {
    var t = new Tab(this, {});
    var pane = new Pane(this, spec || {});
    pane.mount();
    t.addPane(pane);
    t.root = leafNode(pane.id);
    t.activePaneId = pane.id;

    this.tabs.push(t);
    t.view = el('div', 'tabview');
    this.buildTabEl(t);

    $('panes').appendChild(t.view);
    $('tabstrip').appendChild(t.el);

    // 先把 pane.el 搬进布局树，再激活 —— 顺序反了会先 fit 到一个
    // 还没进 DOM 的 host 上，算出 1 列，然后 TUI 收到一个荒谬的 winsize。
    t.render();
    this.activateTab(t.id, false);
    pane.connect();
    if (focus) pane.focus();
    this.save();
    return t;
  };

  // buildTabEl 建标签的 DOM 并接上事件。
  //
  // 新建标签和"从布局恢复"两条路径都走它：以前这两处各写了一遍，加一个
  // 交互（比如双击改名）就得记得改两遍，漏一处就是"刷新之后不好使"。
  Workspace.prototype.buildTabEl = function (t) {
    var self = this;
    t.el = el('div', 'tab');
    t.el.innerHTML = '<span class="title"></span><button class="close" title="关闭标签">×</button>';

    t.el.querySelector('.close').addEventListener('click', function (e) {
      e.stopPropagation();
      self.closeTab(t);
    });
    t.el.addEventListener('click', function () { self.activateTab(t.id); });
    t.el.addEventListener('dblclick', function (e) {
      // 双击关闭按钮不该进入改名 —— 那是想连点两下关掉它。
      if (e.target.closest && e.target.closest('.close')) return;
      e.preventDefault();
      self.renameTab(t);
    });

    t.paintLabel();
    return t.el;
  };

  // renameTab 双击标签时进入改名。标签不是当前标签的话先切过去，
  // 否则改完名字看不见效果（改的是背后那个标签）。
  Workspace.prototype.renameTab = function (t) {
    if (!t) return;
    if (this.activeTabId !== t.id) this.activateTab(t.id);
    t.beginRename();
  };

  Workspace.prototype.activateTab = function (id, doSave) {
    var t = this.tab(id);
    if (!t) return;
    this.activeTabId = id;

    for (var i = 0; i < this.tabs.length; i++) {
      var other = this.tabs[i];
      if (other.view) other.view.classList.toggle('hidden', other.id !== id);
      if (other.el) other.el.classList.toggle('active', other.id === id);
    }

    var pane = t.activePane();
    if (pane) this.focusPane(pane, true);
    // 后台标签期间会话可能换过标题（onPaneTitle 只看当前标签），切回来时补刷一次。
    t.paintLabel();
    store(ACTIVE_KEY, id + ':' + (pane ? pane.id : ''));

    // 切回来时窗格尺寸可能变了（隐藏期间 display:none，clientWidth 为 0），必须重排。
    //
    // 顺便整屏重画一次：隐藏期间这个画布的 WebGL 上下文还在，但浏览器把它
    // 合成上去的内容可能已经作废（画布被从图层里摘下再挂回，绘制缓冲不保证
    // 还在）。不重画的话，切回来看到的可能是上一次合成留下的旧画面或者一片
    // 错位 —— 用户那边的说法就是"切到别的标签就乱码"。refresh 一遍最省事，
    // 内容没变时肉眼也看不出来。
    var self = this;
    requestAnimationFrame(function () {
      eachLeaf(t.root, function (leaf) {
        var p = t.panes[leaf.id];
        if (!p) return;
        p.fit();
        if (p.session) p.session.paintAll();
      });
      if (pane) pane.focus();
    });

    if (doSave !== false) this.save();
  };

  Workspace.prototype.closeTab = function (t) {
    var idx = this.tabs.indexOf(t);
    if (idx < 0) return;

    eachLeaf(t.root, function (leaf) {
      var p = t.panes[leaf.id];
      if (p) this.killPane(p);
    }.bind(this));

    if (t.view && t.view.parentNode) t.view.parentNode.removeChild(t.view);
    if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
    this.tabs.splice(idx, 1);

    if (!this.tabs.length) {
      this.newTab(true);
      return;
    }
    if (this.activeTabId === t.id) {
      var next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activateTab(next.id, false);
    }
    this.save();
  };

  // closeAll 是"结束全部"：把所有窗格连同里面的程序一起停掉，回到一个干净窗格。
  //
  // 顺序很重要：先把本地 WS 全部断开，再让服务端杀会话。反过来的话，服务端一杀，
  // 每个窗格都会触发自动重连、各自再 spawn 一个 shell，等于白关。
  //
  // 窗口本身不动。曾经试过顺手把窗口也关掉，但浏览器只放行"用户点击那一瞬"
  // 的 window.close()，一旦被容器拦下就只能停在提示页，反而比不关更难受。
  //
  // keepBackground 为真时走"只关界面"：一个会话都不杀，全部记进后台清单，
  // 只断本地 WS。想留着 mc 服务器 / 长任务跑的时候用这个。
  Workspace.prototype.closeAll = function (keepBackground) {
    var self = this;
    var kept = 0;

    if (keepBackground) {
      this.eachSession(function (st, pane) {
        if (!pane.sid) return;
        self.rememberBackground(pane);
        kept++;
      });
    }

    this.eachSession(function (st) { st.dispose(); });
    this.tabs = [];
    this.activeTabId = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    $('panes').replaceChildren();
    $('tabstrip').replaceChildren();
    document.title = 'TerminalS';

    // 布局也要一起清掉。留着的话，下次刷新会把旧分屏和一堆已经死掉的 sid
    // 复原回来 —— 每个窗格再去重连、再 spawn 一个 shell，等于白结束一场。
    // 后台清单是另一回事：它必须写进去，那是"程序还在跑"的唯一线索。
    this.flush(true);

    if (!keepBackground) {
      fetch(API + 'sessions', { method: 'DELETE', keepalive: true })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var n = (j && j.data && j.data.closed) || 0;
          banner(n > 0 ? ('已结束 ' + n + ' 个会话') : '已经没有任何会话在跑了');
        })
        .catch(function () {
          banner('本地窗口已关闭，但服务端会话没能确认结束（网络错误）', 'warn');
        });
    }

    this.newTab(true);

    if (keepBackground) {
      banner(kept > 0
        ? ('界面已收起，' + kept + ' 个会话还在后台跑 —— 右上角可以接回来')
        : '界面已收起，没有需要在后台保留的会话');
      this.refreshBackgroundCount();
    }

    return this.activeTab();
  };

  Workspace.prototype.onPaneTitle = function (pane) {
    var t = this.activeTab();
    if (!t) return;
    if (t.activePane() === pane) {
      // 标签栏给的是"人看的一句话"，不是程序的完整路径。PowerShell
      // 会把标题设成 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe，
      // 原样贴上去会把整个标签撑爆。
      //
      // 用户自己改过名字的标签不会被这里覆盖：paintLabel 里 custom 优先。
      t.paintLabel();
    }
    this.save();
  };

  Workspace.prototype.onPaneExit = function (pane) {
    var t = this.activeTab();
    if (t && t.activePane() === pane) banner('会话已结束，Ctrl+Alt+W 关闭这个窗格', 'warn');
  };

  // 关窗格要连会话一起杀。只把 DOM 摘掉的话，服务端那个 shell 会一直跑着，
  // 既占内存又会在下次刷新时"诈尸"回来 —— 用户会以为关不掉。
  Workspace.prototype.killPane = function (pane) {
    if (pane.sid) {
      fetch(API + 'sessions/' + encodeURIComponent(pane.sid), { method: 'DELETE' })
        .catch(function () { });
    }
    pane.dispose();
  };

  Workspace.prototype.focusPane = function (pane, silent) {
    if (!pane) return;
    var t = this.activeTab();
    if (!t) return;

    eachLeaf(t.root, function (leaf) {
      var p = t.panes[leaf.id];
      if (!p) return;
      if (p === pane) p.focus(); else p.blur();
    });
    t.activePaneId = pane.id;
    // 标签名跟着"当前这一格"走：分屏之后每格跑的东西不一样，焦点在哪一格，
    // 标签就该显示哪一格的名字（改过名的标签不受影响，paintLabel 里 custom 优先）。
    t.paintLabel();
    if (!silent) this.save();
  };

  // ------------------------------------------------------------ 分割与关闭

  Workspace.prototype.split = function (dir) {
    var t = this.activeTab();
    var cur = t && t.activePane();
    if (!t || !cur) return;

    var pane = new Pane(this, {});
    pane.mount();
    pane.el.style.display = 'flex';
    t.addPane(pane);
    t.root = replaceLeaf(t.root, cur.id, function (leaf) {
      return splitNode(dir, leaf, leafNode(pane.id));
    });

    t.render();
    pane.connect();
    this.focusPane(pane);
    // 新窗格要等一帧才有尺寸，否则 fit 算出 1 列。
    var self = this;
    requestAnimationFrame(function () { pane.fit(); cur.fit(); self.save(); });
  };

  // clearActivePane 对应 Ctrl+Alt+K：TUI 异常退出后屏幕留残骸时的一键清场。
  // Windows Terminal 用的是 Ctrl+Shift+K，但 Ctrl+Shift+K 浏览器会抢，所以走 Ctrl+Alt。
  Workspace.prototype.clearActivePane = function () {
    var t = this.activeTab();
    var pane = t && t.activePane();
    if (pane && pane.session) pane.session.clearScreen();
  };

  Workspace.prototype.closeActivePane = function () {
    var t = this.activeTab();
    if (!t) return;
    var pane = t.activePane();
    if (pane) this.closePane(pane);
  };

  // closePane 关掉指定的窗格（不一定是焦点那个）—— 轨道上的 × 走的就是这里。
  // 会话要一起杀：只摘 DOM 的话服务端 shell 会一直跑着，刷新后还会"诈尸"回来。
  //
  // opts.detach 是按住 Shift 点 × 的路径：不杀，只把会话记进后台清单。
  Workspace.prototype.closePane = function (pane, opts) {
    var t = this.activeTab();
    if (!t || !pane || !t.panes[pane.id]) return;

    // 没有 sid 的窗格（会话还没建起来，或者已经退出）没什么能在后台活着，
    // 照常关掉 —— 否则会留下一条指向空 sid 的僵尸记录。
    if (opts && opts.detach && pane.sid && !pane.exited) {
      this.detachPane(pane);
      return;
    }

    // 只剩一个窗格时，"关窗格"就是"关标签"，否则会剩下一个没有内容的空壳。
    if (countLeaves(t.root) <= 1) {
      this.closeTab(t);
      return;
    }

    var wasActive = t.activePane() === pane;
    var nextPane = null;
    eachLeaf(t.root, function (leaf) {
      if (!nextPane && leaf.id !== pane.id) nextPane = t.panes[leaf.id];
    });

    this.killPane(pane);
    t.dropPane(pane.id);
    t.root = removeLeaf(t.root, pane.id);
    t.render();

    // 关掉的不是焦点窗格时，别把焦点从用户手上抢走。
    if (wasActive && nextPane) this.focusPane(nextPane);
    this.save();
  };

  // ------------------------------------------------------------ 后台会话
  //
  // "关掉界面、进程继续跑"在这套架构里是天然支持的：WS 断开只是 Detach，
  // 会话本身还在 Manager 里，PTY 也还开着。所以 detach 不需要服务端改任何东西，
  // 关键只有一条：不发 DELETE，并把 sid 记下来，好让用户能再找回来。

  Workspace.prototype.rememberBackground = function (pane) {
    if (!pane.sid) return;
    for (var i = 0; i < this.background.length; i++) {
      if (this.background[i].sid === pane.sid) return;
    }
    this.background.unshift({
      sid: pane.sid,
      title: pane.title || '终端',
      at: Math.floor(Date.now() / 1000)
    });
    this.renderBackgroundCount();
  };

  Workspace.prototype.forgetBackground = function (sid) {
    this.background = this.background.filter(function (b) { return b.sid !== sid; });
    this.renderBackgroundCount();
  };

  Workspace.prototype.isBackground = function (sid) {
    for (var i = 0; i < this.background.length; i++) {
      if (this.background[i].sid === sid) return true;
    }
    return false;
  };

  // focusedSids 收集当前界面上挂着的会话，用来把"后台"和"正在看"区分开。
  Workspace.prototype.mountedSids = function () {
    var out = {};
    this.eachSession(function (st, p) {
      if (p.sid) out[p.sid] = true;
    });
    return out;
  };

  // detachPane 把窗格从界面移走，但不动服务端的会话。
  Workspace.prototype.detachPane = function (pane) {
    var t = this.activeTab();
    if (!t || !pane || !t.panes[pane.id]) return;
    if (!pane.sid) { this.closePane(pane); return; }
    var wasActive = t.activePane() === pane;
    var lone = countLeaves(t.root) <= 1;
    var nextPane = null;
    eachLeaf(t.root, function (leaf) {
      if (!nextPane && leaf.id !== pane.id) nextPane = t.panes[leaf.id];
    });

    this.rememberBackground(pane);

    // 只断前端。pane.dispose() 会关 WS 和 xterm，服务端那边只是 Detach，
    // shell 和它启动的进程都还在跑。
    pane.dispose();
    t.dropPane(pane.id);

    if (lone) {
      // 这个标签里只有它：整个标签一起收掉，再补一个干净窗格。
      var idx = this.tabs.indexOf(t);
      if (t.view && t.view.parentNode) t.view.parentNode.removeChild(t.view);
      if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
      if (idx >= 0) this.tabs.splice(idx, 1);

      if (!this.tabs.length) {
        this.newTab(true);
      } else if (wasActive) {
        this.activateTab(this.tabs[Math.min(idx, this.tabs.length - 1)].id, false);
      }
      this.save();
      banner('已移到后台，进程还在跑 —— 右上角可以接回来');
      return;
    }

    t.root = removeLeaf(t.root, pane.id);
    t.render();
    if (wasActive && nextPane) this.focusPane(nextPane);
    this.save();
    banner('已移到后台，进程还在跑 —— 右上角可以接回来');
  };

  // attachBackground 把一个后台会话接回界面，作为新标签的第一个窗格。
  Workspace.prototype.attachBackground = function (sid) {
    var rec = null;
    for (var i = 0; i < this.background.length; i++) {
      if (this.background[i].sid === sid) { rec = this.background[i]; break; }
    }
    this.forgetBackground(sid);
    this.closeBackgroundPanel();
    this.newTab(true, { sid: sid, title: rec ? rec.title : '终端' });
    banner('已接回后台会话');
  };

  // killBackground 结束一个后台会话：这里才真的发 DELETE。
  Workspace.prototype.killBackground = function (sid, title) {
    var self = this;
    this.ask(
      '结束这个后台会话？',
      (title ? '「' + title + '」' : '这个会话') + '里面正在跑的程序会被停止，进程和它启动的子进程都会结束。',
      '结束',
      function () {
        self.forgetBackground(sid);
        self.closeBackgroundPanel();
        fetch(API + 'sessions/' + encodeURIComponent(sid), { method: 'DELETE' })
          .then(function () { banner('后台会话已结束'); })
          .catch(function () { banner('结束请求失败（网络错误）', 'warn'); });
        self.refreshBackgroundCount();
      }
    );
  };

  // fetchBackgroundItems 汇总"服务端还活着、界面上没挂"的会话。
  //
  // 两个来源：
  //   1) background 清单 —— 我们主动移出去的，带标题和时间；
  //   2) GET /api/sessions 里 clients 为 0、又不在清单里的 —— 页面崩过、
  //      或者别的设备关掉界面留下的。不列出来，它们就成了看不见的进程。
  Workspace.prototype.fetchBackgroundItems = function () {
    var self = this;
    return fetch(API + 'sessions', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && j.data) || [];
        var mounted = self.mountedSids();
        var alive = {};
        var now = Math.floor(Date.now() / 1000);
        var i, k;

        for (i = 0; i < list.length; i++) {
          if (list[i] && list[i].sid) alive[list[i].sid] = list[i];
        }

        var items = [];
        for (k = 0; k < self.background.length; k++) {
          var b = self.background[k];
          var a = alive[b.sid];
          if (!a) continue; // 已经退出，refresh 时会从清单里剔掉
          items.push({
            sid: b.sid,
            title: b.title || '后台会话',
            at: b.at || a.created || 0,
            cwd: a.cwd || '',
            clients: a.clients || 0
          });
        }

        for (var sid in alive) {
          if (!Object.prototype.hasOwnProperty.call(alive, sid)) continue;
          if (mounted[sid] || self.isBackground(sid)) continue;
          var it = alive[sid];
          if (it.clients > 0) continue;              // 别的窗口正在看，不算后台
          if (now - (it.created || 0) < 8) continue; // 刚建出来的，可能正在连
          items.push({
            sid: sid,
            title: baseName(it.cwd),
            at: it.created || 0,
            cwd: it.cwd || '',
            clients: 0
          });
        }

        items.sort(function (x, y) { return (y.at || 0) - (x.at || 0); });
        return { items: items, alive: alive };
      });
  };

  Workspace.prototype.setBackgroundBadge = function (n) {
    var b = $('bg-count');
    b.textContent = String(n);
    b.hidden = n <= 0;
  };

  // renderBackgroundCount 只按本地清单点亮，不发请求 —— 它在每次 save 里被调用。
  Workspace.prototype.renderBackgroundCount = function () {
    this.setBackgroundBadge(this.background.length);
  };

  // refreshBackgroundCount 用服务端清单校正一次：接回来的、被杀掉的、
  // core 重启后丢掉的，都在这里从记录里清出去。
  Workspace.prototype.refreshBackgroundCount = function () {
    var self = this;
    return this.fetchBackgroundItems().then(function (res) {
      self.setBackgroundBadge(res.items.length);
      var alive = res.alive;
      var before = self.background.length;
      self.background = self.background.filter(function (b) { return !!alive[b.sid]; });
      if (self.background.length !== before) self.save();
      return res;
    }).catch(function () {
      // 断网时别把徽标清零：本地清单还知道有哪些会话在跑。
      self.renderBackgroundCount();
      return null;
    });
  };

  Workspace.prototype.openBackgroundPanel = function () {
    var self = this;
    $('bg-panel').hidden = false;
    $('bg-list').replaceChildren();

    var loading = el('div', 'bg-empty');
    loading.textContent = '正在读取…';
    $('bg-list').appendChild(loading);
    $('bg-close').focus();

    this.refreshBackgroundCount().then(function (res) {
      if ($('bg-panel').hidden) return;
      if (res) { self.renderBackgroundPanel(res.items); return; }
      // 读不到服务端就退回本地清单：至少让用户知道"我收起来过这些东西"，
      // 而不是骗他"没有在后台跑的会话"。
      self.renderBackgroundPanel(self.background.map(function (b) {
        return { sid: b.sid, title: b.title, at: b.at, cwd: '', clients: 0 };
      }));
    });
  };

  Workspace.prototype.renderBackgroundPanel = function (items) {
    var self = this;
    var list = $('bg-list');
    list.replaceChildren();

    if (!items.length) {
      var empty = el('div', 'bg-empty');
      empty.textContent = '没有在后台跑的会话';
      list.appendChild(empty);
      return;
    }

    items.forEach(function (it) {
      var row = el('div', 'bg-item');

      var main = el('div', 'bg-main');
      var title = el('div', 'bg-title');
      title.textContent = it.title || '终端';
      title.title = it.cwd || it.sid;
      var meta = el('div', 'bg-meta');
      meta.textContent = agoText(it.at) + (it.cwd ? ' · ' + it.cwd : '') +
        (it.clients > 0 ? ' · 另一处也在看' : '');
      main.appendChild(title);
      main.appendChild(meta);

      var attach = el('button', 'btn');
      attach.type = 'button';
      attach.textContent = '接回';
      attach.addEventListener('click', function () { self.attachBackground(it.sid); });

      var kill = el('button', 'btn danger');
      kill.type = 'button';
      kill.textContent = '结束';
      kill.addEventListener('click', function () { self.killBackground(it.sid, it.title); });

      row.appendChild(main);
      row.appendChild(attach);
      row.appendChild(kill);
      list.appendChild(row);
    });
  };

  Workspace.prototype.closeBackgroundPanel = function () {
    if (!$('bg-panel').hidden) $('bg-panel').hidden = true;
  };

  Workspace.prototype.isBackgroundOpen = function () { return !$('bg-panel').hidden; };

  // ------------------------------------------------------------ 历史记录
  //
  // 一块浮层，照着浏览器历史页做：上面搜索框，下面按时间分组的列表，
  // 每条右边是时间，鼠标移上去才露出删除。
  //
  // 点一条不是"只读回看"，而是新开一个标签：先把那一次会话的输出铺满，
  // 下面接一个能用的 shell（见 Pane.openHistory）。所以用户看到的既是
  // 历史，也是一个可以接着敲的终端。

  Workspace.prototype.isHistoryOpen = function () { return !$('hist-panel').hidden; };

  Workspace.prototype.toggleHistoryPanel = function () {
    if (this.isHistoryOpen()) this.closeHistoryPanel();
    else this.openHistoryPanel();
  };

  Workspace.prototype.openHistoryPanel = function () {
    $('hist-panel').hidden = false;
    $('hist-search').value = '';
    this.historyItems = null;
    this.historyErr = '';
    this.renderHistoryPanel();
    $('hist-search').focus();
    this.loadHistory();
  };

  Workspace.prototype.loadHistory = function () {
    var self = this;
    fetch(API + 'history').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (!self.isHistoryOpen()) return;
      self.historyItems = (j && j.ok && j.data && j.data.items) || [];
      self.historyErr = '';
      self.renderHistoryPanel();
    }).catch(function () {
      if (!self.isHistoryOpen()) return;
      self.historyItems = [];
      self.historyErr = '历史记录读取失败，检查一下服务是否还在';
      self.renderHistoryPanel();
    });
  };

  Workspace.prototype.closeHistoryPanel = function () {
    if (this.isHistoryOpen()) $('hist-panel').hidden = true;
  };

  Workspace.prototype.renderHistoryPanel = function () {
    var self = this;
    var list = $('hist-list');
    list.replaceChildren();

    if (this.historyItems === null) {
      list.appendChild(histEmpty('正在读取…'));
      $('hist-count').textContent = '';
      return;
    }
    if (this.historyErr) {
      list.appendChild(histEmpty(this.historyErr));
      $('hist-count').textContent = '';
      return;
    }

    var all = this.historyItems;
    var q = ($('hist-search').value || '').trim().toLowerCase();
    var items = all.filter(function (it) {
      if (!q) return true;
      return (histTitle(it) + ' ' + (it.cwd || '') + ' ' + (it.shell || '')).toLowerCase().indexOf(q) >= 0;
    });

    // 后端已经排好了，这里再排一次是因为列表会在本地被改动（删一条、
    // 打开一条之后它的时间会变），不能让顺序停在拉取数据的那一刻。
    items = items.slice().sort(function (a, b) {
      var d = histWhen(b) - histWhen(a);
      if (d) return d;
      return (b.created || 0) - (a.created || 0);
    });

    $('hist-count').textContent = all.length
      ? (q ? items.length + ' / ' + all.length + ' 条' : all.length + ' 条')
      : '';

    if (!items.length) {
      list.appendChild(histEmpty(q ? '没有匹配的记录' : '还没有历史记录'));
      return;
    }

    // 按天分组，和浏览器历史页一样。分组的先后就是列表顺序（最新在前）。
    var group = '';
    items.forEach(function (it) {
      var g = histDayGroup(histWhen(it));
      if (g !== group) {
        group = g;
        var h = el('div', 'hist-group');
        h.textContent = g;
        list.appendChild(h);
      }

      var row = el('div', 'hist-item');
      row.dataset.id = it.id;
      if (it.live) {
        // 还在跑的那条不能重新打开：两条会话往同一个日志文件里写，回看时
        // 两段输出会交错在一起，谁也分不清哪一行属于哪一次。所以整行点不动，
        // 只留右侧的删除。
        row.classList.add('live', 'busy');
        row.setAttribute('aria-disabled', 'true');
        row.title = '这条会话还在运行，不能重新打开';
      }

      var icon = el('span', 'hist-icon');
      icon.textContent = '›_';
      row.appendChild(icon);

      var main = el('div', 'hist-main');
      var title = el('div', 'hist-title');
      title.textContent = histTitle(it);
      title.title = title.textContent;
      main.appendChild(title);

      var sub = histSub(it);
      if (sub) {
        var meta = el('div', 'hist-meta');
        meta.textContent = sub;
        meta.title = sub;
        main.appendChild(meta);
      }
      row.appendChild(main);

      var time = el('span', 'hist-time');
      time.textContent = histClock(histWhen(it));
      row.appendChild(time);

      var del = el('button', 'hist-del');
      del.type = 'button';
      del.title = '删除这条记录';
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        self.deleteHistory(it);
      });
      row.appendChild(del);

      row.addEventListener('click', function () { self.openHistoryEntry(it); });
      list.appendChild(row);
    });
  };

  Workspace.prototype.openHistoryEntry = function (it) {
    if (!it) return;
    // 运行中的记录不能重开（见上面 renderHistoryPanel 里的说明）。这里再挡
    // 一道：行上的点击可以被别的地方触发，规则只该有一处判断。
    if (it.live) {
      banner('这条会话还在运行，先把它结束掉才能重新打开', 'warn');
      return;
    }
    this.closeHistoryPanel();
    this.newTab(true, { historyId: it.id, title: histTitle(it) });
    banner('已载入这次会话的历史，下面可以直接继续操作', 'ok');
  };

  Workspace.prototype.deleteHistory = function (it) {
    var self = this;
    fetch(API + 'history/' + encodeURIComponent(it.id), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) throw new Error('delete failed');
        self.historyItems = (self.historyItems || []).filter(function (x) { return x.id !== it.id; });
        self.renderHistoryPanel();
      })
      .catch(function () { banner('删除失败，记录还在', 'warn'); });
  };

  Workspace.prototype.askClearHistory = function () {
    var self = this;
    this.ask('清空全部历史记录？', '所有会话的输出都会被删掉，不能恢复。', '清空', function () {
      fetch(API + 'history', { method: 'DELETE' })
        .then(function (r) {
          if (!r.ok) throw new Error('clear failed');
          self.historyItems = [];
          self.renderHistoryPanel();
          banner('历史记录已清空', 'ok');
        })
        .catch(function () { banner('清空失败', 'warn'); });
    });
  };

  // 方向键移动焦点：按几何位置找最近的邻居，比按树序更符合直觉。
  Workspace.prototype.moveFocus = function (dir) {
    var t = this.activeTab();
    var cur = t && t.activePane();
    if (!t || !cur) return;

    var box = cur.el.getBoundingClientRect();
    var cx = box.left + box.width / 2;
    var cy = box.top + box.height / 2;

    var best = null;
    var bestScore = Infinity;
    eachLeaf(t.root, function (leaf) {
      var p = t.panes[leaf.id];
      if (!p || p === cur || !p.el) return;
      var b = p.el.getBoundingClientRect();
      var px = b.left + b.width / 2;
      var py = b.top + b.height / 2;

      var ok = (dir === 'left' && px < cx - 4) || (dir === 'right' && px > cx + 4) ||
        (dir === 'up' && py < cy - 4) || (dir === 'down' && py > cy + 4);
      if (!ok) return;

      // 主轴距离优先，垂直方向偏离做惩罚，避免斜着跳到远处的窗格。
      var main = dir === 'left' || dir === 'right' ? Math.abs(px - cx) : Math.abs(py - cy);
      var off = dir === 'left' || dir === 'right' ? Math.abs(py - cy) : Math.abs(px - cx);
      var score = main + off * 2;
      if (score < bestScore) { bestScore = score; best = p; }
    });

    if (best) this.focusPane(best);
  };

  Workspace.prototype.cycleTab = function (step) {
    if (this.tabs.length < 2) return;
    var idx = this.tabs.indexOf(this.activeTab());
    var next = (idx + step + this.tabs.length) % this.tabs.length;
    this.activateTab(this.tabs[next].id);
  };

  // ------------------------------------------------------------ 连接状态
  //
  // 右上角那盏灯反映的是"整个界面还能不能对着服务端说话"，不是某一个窗格的。
  // 以前它只跟着焦点窗格走：分屏后下面那格断了、焦点恰好在上面那格，
  // 状态栏照样显示"已连接"，比没有状态还误导。
  //
  // 已经退出（exited）的窗格不算：那是程序跑完了，不是连接出了问题。

  Workspace.prototype.connPanes = function () {
    var out = [];
    this.eachSession(function (st, p) {
      if (st.disposed || st.exited || !p.el) return;
      out.push(p);
    });
    return out;
  };

  // visible 判断一个窗格眼下是不是真在屏幕上。
  //
  // 隐藏标签页里的窗格会一直停在"连接中"：它们要等到自己被切出来、量到
  // 真实尺寸之后才建连（见 waitLayout）。这个状态不是故障，可状态灯是
  // 按所有窗格汇总的 —— 于是只要有一个没被切出来过的标签，整个界面就
  // 永远黄灯"连接中"，而眼前的终端明明好好的，命令还能敲。
  //
  // offsetParent 为 null 就说明祖先里有 display:none（.tabview.hidden）。
  Workspace.prototype.paneVisible = function (p) {
    if (!p || !p.el) return false;
    return !!p.el.offsetParent && p.el.getClientRects().length > 0;
  };

  Workspace.prototype.connState = function () {
    var panes = this.connPanes();
    if (!panes.length) return 'online';    // 还没有窗格，不该报警

    var online = 0, offline = 0, connecting = 0;
    for (var i = 0; i < panes.length; i++) {
      var s = panes[i].el.dataset.state;
      if (s === 'offline') offline++;
      else if (s === 'online') online++;
      else if (this.paneVisible(panes[i])) connecting++;  // 藏着的还没轮到它连
    }

    if (offline && online) return 'partial';   // 分屏时一格断、一格好
    if (offline) return 'offline';
    if (connecting) return 'connecting';
    return 'online';
  };

  // setStatus 不带参数：状态是算出来的，不是喂进来的。
  // 保留这个名字是因为好几处（Pane.focus、onState）都在调它。
  Workspace.prototype.setStatus = function () {
    var state = this.connState();
    var btn = $('status');
    var down = state === 'offline' || state === 'partial';
    var wasDown = !!this._wasDown;

    // 部分断开用黄色（和"连接中"共用一档颜色），全断才是红的。
    $('led').className = 'led ' + (state === 'partial' ? 'connecting' : state);
    $('statustext').textContent =
      state === 'online' ? '已连接'
        : state === 'connecting' ? '连接中'
          : state === 'partial' ? '部分断开'
            : '未连接';

    btn.classList.toggle('down', down);
    // 连上的时候把一切交互入口都关掉：pointer-events 在 CSS 里，
    // 这里再清空 title、退出 Tab 序列，免得键盘用户停在一个点不动的按钮上。
    btn.setAttribute('aria-disabled', down ? 'false' : 'true');
    btn.tabIndex = down ? 0 : -1;
    btn.title = '';

    this._wasDown = down;

    if (!down) {
      this.hideConnTip();
      // 连上了就把上一次的诊断结论丢掉，下次断开重新探。
      this._probe = null;
      this._probeAt = 0;
      // 断开过又回来了，给一句确认。窗格被主动销毁（关标签、结束全部）
      // 也会让状态从断变好，那种情况不该说"连接已恢复"。
      if (wasDown && this.connPanes().length) banner('连接已恢复', 'ok');
      return;
    }

    this.probeSoon();
    if (!$('conn-tip').hidden) this.renderConnTip();
  };

  // connIssue 挑一个最该解释的会话：优先焦点窗格，其次任意一个断开的。
  // 全都正常时返回 null。
  Workspace.prototype.connIssue = function () {
    var active = this.activePane();
    var self = this;
    var best = null, bestScore = -1;

    this.eachSession(function (st, p) {
      if (st.disposed || st.exited || !p.el) return;
      var state = p.el.dataset.state;
      if (state === 'online') return;
      // 藏着的窗格还没轮到它建连（见 paneVisible），不该拿去解释故障。
      if (state !== 'offline' && !self.paneVisible(p)) return;
      var score = (p === active ? 4 : 0) + (state === 'offline' ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = st; }
    });

    return best;
  };

  // ------------------------------------------------------------ 断线浮层

  Workspace.prototype.showConnTip = function () {
    if (!$('status').classList.contains('down')) return;
    var tip = $('conn-tip');
    tip.hidden = false;
    this.renderConnTip();
    this.positionConnTip();
  };

  Workspace.prototype.hideConnTip = function () {
    var tip = $('conn-tip');
    if (tip && !tip.hidden) tip.hidden = true;
  };

  Workspace.prototype.positionConnTip = function () {
    var btn = $('status'), tip = $('conn-tip');
    if (!btn || !tip || tip.hidden) return;

    var r = btn.getBoundingClientRect();
    var w = tip.offsetWidth;
    // 右边缘尽量对齐按钮右边缘，放不下就往左推；箭头始终指着按钮中心。
    var left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom + 7) + 'px';

    var arrow = r.left + r.width / 2 - left - 4;
    arrow = Math.max(10, Math.min(arrow, w - 18));
    tip.style.setProperty('--ct-arrow', arrow + 'px');
  };

  Workspace.prototype.renderConnTip = function () {
    var st = this.connIssue();

    $('ct-title').textContent =
      this.connState() === 'partial' ? '部分窗格已断开' : '连接已断开';

    var reason;
    if (!st) {
      reason = '没有正在连接的窗格';
    } else if (st.lastError) {
      reason = st.lastError;
    } else if (st.ws) {
      reason = '正在建立连接…';
    } else {
      reason = '连接已关闭，但没收到原因';
    }
    $('ct-reason').textContent = reason;

    $('ct-server').textContent = this.probeText();

    // 网关这一行平时不出现，只有服务端判定"来源对不上"时才占一格：
    // 那种情况下光说"服务在线"推不出该去改什么，得把两边的主机名摊开。
    var gw = this._probe && this._probe.gateway;
    var showGw = !!(gw && gw.verdict === 'mismatch');
    $('ct-gw-row').hidden = !showGw;
    $('ct-gw').hidden = !showGw;
    if (showGw) {
      $('ct-gw').textContent = '服务端收到的 Host 是「' + (gw.host || '空') +
        '」，页面来源是「' + (gw.origin || '空') + '」，会被判成跨站';
    }

    var retry = '—';
    if (st) {
      if (st.disposed) {
        retry = '会话已关闭';
      } else if (st.retryAt) {
        var left = Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000));
        retry = '第 ' + st.retry + ' 次，约 ' + left + ' 秒后自动重试';
      } else if (st.ws) {
        retry = '正在连接…';
      } else {
        retry = '等待中';
      }
    }
    $('ct-retry').textContent = retry;
  };

  Workspace.prototype.probeText = function () {
    var r = this._probe;
    if (!r) return '正在检测…';
    if (r.ok) return '服务在线（HTTP 正常），只是 WebSocket 没连上';
    if (r.status) return '服务返回 HTTP ' + r.status;
    return '服务不可达（请求超时或被拒绝）';
  };

  // probeSoon 让探活不在状态每次抖动时都发一遍 —— 重连循环里状态会
  // offline → connecting → offline 地跳，6 秒一次足够看清这台服务器还活着没。
  Workspace.prototype.probeSoon = function () {
    var self = this;
    if (this._probeTimer || this._probePending) return;
    if (Date.now() - (this._probeAt || 0) < 6000) return;
    this._probeTimer = setTimeout(function () {
      self._probeTimer = null;
      self.probeServer();
    }, 400);
  };

  // probeServer 用 /api/healthz 区分两件事：
  //   服务整个没了（fetch 失败）→ 用户该去看应用有没有在跑、NAS 通不通；
  //   服务在、只有 WS 不通 → 多半是网关/反代把 Upgrade 拦了。
  Workspace.prototype.probeServer = function () {
    var self = this;
    if (this._probePending) return this._probePending;

    this._probeAt = Date.now();
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) { } }
    }, 3000);

    var opts = { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined };

    // 一次取两份信息：
    //   healthz —— 服务本身还在不在；
    //   wscheck —— 服务端眼里这次请求的 Origin / Host 长什么样。
    // 后者是"局域网连不上、远程却能用"这类问题的唯一线索：WebSocket 失败
    // 在浏览器里一律是 1006，脚本分不出是被网关改了 Host，还是网关压根没
    // 转发 Upgrade。
    var one = function (path) {
      return fetch(API + path, opts).then(function (r) {
        if (!r.ok) return { ok: false, status: r.status, data: null };
        return r.json().then(function (j) {
          return { ok: true, status: 0, data: (j && j.data) || null };
        }, function () {
          return { ok: true, status: 0, data: null };
        });
      }, function () {
        return { ok: false, status: 0, data: null };
      });
    };

    this._probePending = Promise.all([one('healthz'), one('wscheck')])
      .then(function (res) {
        clearTimeout(timer);
        self._probePending = null;
        // 探测期间连接可能已经自己恢复了 —— 那份"服务不可达"的结论已经作废，
        // 写回去会让下一次断开时的说明带着上一次的旧账。
        if (self.connState() === 'online') return res[0];
        var out = res[0];
        out.gateway = res[1] ? res[1].data : null;
        self._probe = out;
        if (!$('conn-tip').hidden) self.renderConnTip();
        return out;
      });

    return this._probePending;
  };

  // reconnectNow 是按钮的点击动作：跳过退避，所有断着的会话立刻重连。
  Workspace.prototype.reconnectNow = function () {
    var n = 0, busy = 0;
    this.eachSession(function (st) {
      if (st.disposed || st.exited) return;

      var rs = st.ws ? st.ws.readyState : -1;
      if (rs === WebSocket.OPEN) return;
      // 正在握手就别再叠一条连接：服务端已经把它升级成会话的话，
      // 多出来的那条一关就变成 clients=0 的孤儿，挂在后台清单里很碍眼。
      // 只有卡住太久（超过 8 秒还没结果）才强制重来。
      if (rs === WebSocket.CONNECTING && Date.now() - (st.connectAt || 0) < 8000) {
        busy++;
        return;
      }
      if (st.retryNow()) n++;
    });

    // 上一次的诊断结论已经不成立了（用户刚改了网络、重启了应用），重新探。
    this._probe = null;
    this._probeAt = 0;

    if (!n) {
      banner(busy ? '正在连接中，稍等…' : '当前没有断开的会话', 'info');
      this.setStatus();
      return;
    }

    banner(n > 1 ? ('正在重连 ' + n + ' 个会话…') : '正在重连…', 'info');
    this.setStatus();
  };

  Workspace.prototype.setAlt = function (on) {
    $('altscreen').hidden = !on;
  };

  // ------------------------------------------------------------- 设置
  //
  // 主副本在服务端（<数据目录>/settings.json），localStorage 只是缓存，
  // 换台机器打开同一个地址，设置还在。
  // 全部设置项都只影响显示（主题/字号/光标/回看/WebGL/选中即复制），
  // 改完立刻作用到现有窗格，不需要重开会话。

  function mergeSettings(src) {
    var out = {}, k;
    for (k in SETTINGS_DEFAULT) {
      out[k] = (src && src[k] !== undefined && src[k] !== null)
        ? src[k] : SETTINGS_DEFAULT[k];
    }
    return out;
  }

  Workspace.prototype.eachSession = function (fn) {
    for (var i = 0; i < this.tabs.length; i++) {
      var t = this.tabs[i];
      for (var pid in t.panes) {
        if (!Object.prototype.hasOwnProperty.call(t.panes, pid)) continue;
        var p = t.panes[pid];
        if (p && p.session) fn(p.session, p);
      }
    }
  };

  // applySettings 把当前设置铺到所有窗格上。theme 走 dataset，
  // xterm 自己那份 theme 需要单独赋一次 —— 它不会跟着 CSS 变量变。
  Workspace.prototype.applySettings = function () {
    var s = this.settings;
    document.documentElement.dataset.theme = s.theme;
    var theme = s.theme === 'light' ? LIGHT_THEME : DARK_THEME;
    this.fontSize = s.fontSize;

    this.eachSession(function (st) {
      if (!st.term) return;
      st.term.options.theme = theme;
      st.term.options.cursorBlink = !!s.cursorBlink;
      st.term.options.scrollback = s.scrollback;
      st.fontSize = s.fontSize;
      if (st.term.options.fontSize !== s.fontSize) {
        st.term.options.fontSize = s.fontSize;
      }
      st.opts.webgl = !!s.webgl;
      if (s.webgl) st.attachWebgl(); else st.detachWebgl();
      st.fit();
    });
  };

  // 保存：本地立即生效，服务端防抖 250ms 写一次。
  // 连点字号加减时不至于每一下都打一次网络请求。
  Workspace.prototype.saveSettings = function (patch) {
    var self = this, k;
    for (k in patch) this.settings[k] = patch[k];
    store(SETTINGS_KEY, JSON.stringify(this.settings));
    this.applySettings();

    clearTimeout(this._setSaveTimer);
    this._setSaveTimer = setTimeout(function () {
      fetch(API + 'settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(self.settings)
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || j.ok !== true) {
          banner('设置未能存到服务端：' + ((j && j.error) || '未知错误'), 'warn');
        }
      }).catch(function () {
        banner('设置未能存到服务端（网络错误），本次只在本浏览器生效', 'warn');
      });
    }, 250);
  };

  // 启动时拉一次服务端的设置。以服务端为准：这样手机上调过的字号，
  // 回到电脑上打开也是同一个。
  Workspace.prototype.syncSettings = function () {
    var self = this;
    fetch(API + 'settings', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true || !j.data) return;
        self.settings = mergeSettings(j.data);
        store(SETTINGS_KEY, JSON.stringify(self.settings));
        self.applySettings();
        self.fillSettingsForm();
      })
      .catch(function () { /* 离线就用缓存，不打扰用户 */ });
  };

  Workspace.prototype.setFontSize = function (size) {
    var n = Math.max(FONT_MIN, Math.min(FONT_MAX, size | 0));
    if (n === this.settings.fontSize) { this.fillSettingsForm(); return; }
    this.saveSettings({ fontSize: n });
    this.fillSettingsForm();
  };

  // --------------------------------------------------------- 设置面板

  var setOverlay = $('settings');
  var setTip = $('set-tip');

  Workspace.prototype.isSettingsOpen = function () { return !setOverlay.hidden; };

  Workspace.prototype.fillSettingsForm = function () {
    var s = this.settings;
    $('set-theme').value = s.theme;
    $('set-fontsize').value = s.fontSize;
    $('set-blink').checked = !!s.cursorBlink;
    $('set-webgl').checked = !!s.webgl;
    var sb = $('set-scrollback');
    sb.value = String(s.scrollback);
    // 服务端存的值可能不在下拉的几档里（比如手改过文件），
    // 落不下就退回"1 万行"这一档，别显示成空白。
    if (sb.selectedIndex < 0) sb.selectedIndex = 1;
  };

  Workspace.prototype.openSettings = function () {
    var p = this.activePane();
    // 先把焦点从终端挪走，否则面板开着时按键还会漏进 shell。
    if (p && p.session && p.session.term && p.session.term.textarea) {
      p.session.term.textarea.blur();
    }
    this.fillSettingsForm();
    setTip.textContent = '';
    setTip.className = '';
    setOverlay.hidden = false;
    $('set-close').focus();
  };

  Workspace.prototype.closeSettings = function () {
    if (setOverlay.hidden) return;
    setOverlay.hidden = true;
    setTip.textContent = '';
    var p = this.activePane();
    if (p) p.focus();
  };

  Workspace.prototype.toggleSettings = function () {
    if (this.isSettingsOpen()) this.closeSettings();
    else this.openSettings();
  };

  $('btn-settings').addEventListener('click', function () { app.toggleSettings(); });
  $('set-close').addEventListener('click', function () { app.closeSettings(); });

  // 点遮罩关闭：只有点在遮罩本身（不是面板内部）才算。
  setOverlay.addEventListener('mousedown', function (e) {
    if (e.target === setOverlay) app.closeSettings();
  });

  $('set-theme').addEventListener('change', function () {
    app.saveSettings({ theme: this.value });
  });

  $('set-blink').addEventListener('change', function () {
    app.saveSettings({ cursorBlink: this.checked });
  });

  $('set-webgl').addEventListener('change', function () {
    app.saveSettings({ webgl: this.checked });
    setTip.className = '';
    setTip.textContent = this.checked
      ? '已开启 WebGL 渲染（最多 4 个窗格用，其余走 canvas）'
      : '已改用 canvas 渲染，兼容性更好、发热更低';
  });

  $('set-scrollback').addEventListener('change', function () {
    app.saveSettings({ scrollback: parseInt(this.value, 10) || 10000 });
  });

  $('set-fontsize').addEventListener('change', function () {
    app.setFontSize(parseInt(this.value, 10) || SETTINGS_DEFAULT.fontSize);
  });

  (function bindSteppers() {
    var btns = document.querySelectorAll('.set-stepper .step');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        app.setFontSize(app.settings.fontSize + parseInt(this.dataset.step, 10));
      });
    }
  })();

  // Esc 关闭面板。用捕获阶段：面板里的 select/input 自己会消费 keydown，
  // 冒泡阶段可能收不到。
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!app.isSettingsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    app.closeSettings();
  }, true);

  // --------------------------------------------------------- 后台会话面板
  //
  // 这是标题栏上的下拉浮层，不是遮罩：用户经常一边看后台列表一边看终端。
  // Esc 监听放在确认框之前注册 —— 同一个元素上的捕获监听按注册顺序跑，
  // 这样"结束某个后台会话"的确认框开着时按 Esc，只会关掉确认框。

  $('btn-bg').addEventListener('click', function (e) {
    e.stopPropagation();
    if (app.isBackgroundOpen()) { app.closeBackgroundPanel(); return; }
    // 两块浮层都在右上角，同时开着会重叠。
    app.closeHistoryPanel();
    app.openBackgroundPanel();
  });

  $('bg-close').addEventListener('click', function () { app.closeBackgroundPanel(); });

  // --------------------------------------------------------- 历史记录面板
  //
  // 和后台会话面板同一套开关逻辑，只是挂在另一个按钮上。两套浮层
  // 互斥：打开一个就收起另一个，免得两块叠在右上角。

  $('btn-history').addEventListener('click', function (e) {
    e.stopPropagation();
    if (!app.isHistoryOpen()) app.closeBackgroundPanel();
    app.toggleHistoryPanel();
  });

  $('hist-close').addEventListener('click', function () { app.closeHistoryPanel(); });
  $('hist-clear').addEventListener('click', function () { app.askClearHistory(); });
  $('hist-search').addEventListener('input', function () { app.renderHistoryPanel(); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!app.isHistoryOpen()) return;
    if (app.isAsking()) return;
    e.preventDefault();
    e.stopPropagation();
    app.closeHistoryPanel();
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (!app.isHistoryOpen()) return;
    if (app.isAsking()) return;
    if ($('hist-panel').contains(e.target) || $('btn-history').contains(e.target)) return;
    app.closeHistoryPanel();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!app.isBackgroundOpen()) return;
    if (app.isAsking()) return;
    e.preventDefault();
    e.stopPropagation();
    app.closeBackgroundPanel();
  }, true);

  // 点面板外面关掉。用 mousedown 而不是 click：点终端时 click 的默认行为
  // 会把焦点给回终端，面板已经关了，没必要等两个事件。
  document.addEventListener('mousedown', function (e) {
    if (!app.isBackgroundOpen()) return;
    if (app.isAsking()) return;
    if ($('bg-panel').contains(e.target) || $('btn-bg').contains(e.target)) return;
    app.closeBackgroundPanel();
  }, true);

  // --------------------------------------------------------- 确认框
  //
  // 破坏性动作要二次确认。不用浏览器原生 confirm：它会抢走焦点，
  // 回来以后终端的焦点状态还得重新收拾一遍。

  var cfOverlay = $('confirm');

  Workspace.prototype.isAsking = function () { return !cfOverlay.hidden; };

  // alt 是可选的第三个按钮（{label, fn}），用来给"结束全部"提供一个
  // 更温和的分支："只关界面，保留后台"。
  Workspace.prototype.ask = function (title, text, okLabel, onOk, alt) {
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    $('cf-ok').textContent = okLabel || '确定';
    cfOverlay._onOk = onOk;

    var altBtn = $('cf-alt');
    if (alt && alt.label && alt.fn) {
      altBtn.textContent = alt.label;
      altBtn.hidden = false;
      cfOverlay._onAlt = alt.fn;
    } else {
      altBtn.hidden = true;
      cfOverlay._onAlt = null;
    }

    // 面板开着的时候别让按键漏进 shell。
    var p = this.activePane();
    if (p && p.session && p.session.term && p.session.term.textarea) {
      p.session.term.textarea.blur();
    }
    cfOverlay.hidden = false;
    $('cf-ok').focus();
  };

  Workspace.prototype.closeAsk = function (refocus) {
    if (cfOverlay.hidden) return;
    cfOverlay.hidden = true;
    cfOverlay._onOk = null;
    cfOverlay._onAlt = null;
    if (refocus === false) return;
    var p = this.activePane();
    if (p) p.focus();
  };

  // 按钮和 Ctrl+Alt+Q 走同一个入口，确认框只有一份文案。
  Workspace.prototype.askCloseAll = function () {
    this.ask(
      '结束全部会话？',
      '「结束全部」会关掉所有标签和窗格，里面正在运行的程序（包括 Claude Code、正在执行的任务）会被停止。\n' +
      '想留着服务器这类程序继续跑，选「只关界面，保留后台」：界面收干净，进程不动，' +
      '之后从右上角的后台会话按钮接回来。\n' +
      '两种方式都会留一个干净的新窗格，窗口本身不关。',
      '结束全部',
      function () { this.closeAll(false); }.bind(this),
      { label: '只关界面，保留后台', fn: function () { this.closeAll(true); }.bind(this) }
    );
  };

  $('btn-close-all').addEventListener('click', function () { app.askCloseAll(); });

  $('cf-cancel').addEventListener('click', function () { app.closeAsk(); });

  $('cf-ok').addEventListener('click', function () {
    var fn = cfOverlay._onOk;
    // 不把焦点还回旧窗格：这个窗格马上就要被干掉了。
    app.closeAsk(false);
    if (fn) fn();
  });

  $('cf-alt').addEventListener('click', function () {
    var fn = cfOverlay._onAlt;
    app.closeAsk(false);
    if (fn) fn();
  });

  // ---- 右上角的连接状态按钮 ----
  //
  // 三种输入都接上：鼠标悬停看原因、点击重连、键盘聚焦（Tab 到这里后
  // 回车/空格同样触发 click）。连上之后 pointer-events 是 none，
  // 这些监听全都不会触发 —— 也就不会有任何提示。
  (function () {
    var btn = $('status');

    btn.addEventListener('mouseenter', function () { app.showConnTip(); });
    btn.addEventListener('mouseleave', function () { app.hideConnTip(); });

    btn.addEventListener('focus', function () { app.showConnTip(); });
    btn.addEventListener('blur', function () { app.hideConnTip(); });

    btn.addEventListener('click', function () {
      if (!btn.classList.contains('down')) return;
      app.reconnectNow();
      // 不用手动收浮层：重连会把状态推成"连接中"，setStatus 里
      // 非 down 的分支会自己把它收掉；如果只是部分窗格重连，
      // 浮层留下并换成"正在连接…"才对。
    });

    // 窗口尺寸变了，浮层的位置和箭头就都对不上了，跟着重算。
    window.addEventListener('resize', function () {
      if (!$('conn-tip').hidden) app.positionConnTip();
    });
  })();

  cfOverlay.addEventListener('mousedown', function (e) {
    if (e.target === cfOverlay) app.closeAsk();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!app.isAsking()) return;
    e.preventDefault();
    e.stopPropagation();
    app.closeAsk();
  }, true);

  // ------------------------------------------------------------ 快捷键
  //
  // 全部用 Ctrl+Alt：Ctrl+Shift+T/W 是浏览器强占的（重开标签、关窗口），
  // Alt+Shift 在 Windows 上还是输入法切换热键。Ctrl+Alt 系列两边都不撞，
  // 而且单按 Ctrl+Alt 不会触发任何字符输入。

  Workspace.prototype.onKeydown = function (e) {
    // 确认框开着的时候，快捷键一律不响应：底下的窗格马上要没了，
    // 这时候还允许新建标签/分屏只会让人更懵。Esc 由确认框自己的监听处理。
    if (this.isAsking()) return;
    // 正在给标签改名：按键归输入框。这里的监听挂在捕获阶段，不挡的话
    // Ctrl+Alt+T 之类会在打到一半时凭空多出一个标签。
    if (document.activeElement && document.activeElement.classList
      && document.activeElement.classList.contains('tab-input')) return;
    if (!e.ctrlKey || !e.altKey || e.metaKey) return;
    var handled = true;

    switch (e.key) {
      case 't': case 'T': this.newTab(true); break;
      case 'w': case 'W': this.closeActivePane(); break;
      case '=': case '+': this.split('row'); break;
      case '-': case '_': this.split('col'); break;
      case 'ArrowLeft': this.moveFocus('left'); break;
      case 'ArrowRight': this.moveFocus('right'); break;
      case 'ArrowUp': this.moveFocus('up'); break;
      case 'ArrowDown': this.moveFocus('down'); break;
      case 'k': case 'K': this.clearActivePane(); break;
      case 'h': case 'H':
        if (!this.isHistoryOpen()) this.closeBackgroundPanel();
        this.toggleHistoryPanel();
        break;
      case 'q': case 'Q': this.askCloseAll(); break;
      case ',': case '<': this.toggleSettings(); break;
      case '[': this.cycleTab(-1); break;
      case ']': this.cycleTab(1); break;
      default:
        if (/^[1-9]$/.test(e.key)) {
          var t = this.tabs[parseInt(e.key, 10) - 1];
          if (t) this.activateTab(t.id);
          break;
        }
        handled = false;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ------------------------------------------------------------- 启动

  var app = new Workspace();

  // 调试入口：控制台里 `__ts.webglCount()` 能看到当前有多少个窗格占着 WebGL
  // 上下文。分屏黑屏时先看这个数，超过上限就说明限流没生效。
  window.__ts = {
    app: app,
    webglCount: function () { return webglUsers.length; },

    // diag 打印每个窗格的"xterm 尺寸 vs PTY 尺寸"。两边不一致 = TUI 排版必错，
    // 这正是"退出后留乱码"的头号嫌疑，所以做成一眼能看的形式。
    diag: function () {
      var rows = [];
      (app.tabs || []).forEach(function (t) {
        if (!t.panes) return;
        Object.keys(t.panes).forEach(function (k) {
          var p = t.panes[k];
          var st = p && p.session;
          if (!st || !st.term) return;
          rows.push({
            tab: t.id,
            pane: k,
            xterm: st.term.cols + 'x' + st.term.rows,
            pty: (st.ptyCols || 0) + 'x' + (st.ptyRows || 0),
            一致: st.ptyCols === st.term.cols && st.ptyRows === st.term.rows,
            buffer: st.term.buffer.active.type,
            webgl: !!st.webgl,
            ws: st.ws ? st.ws.readyState : -1
          });
        });
      });
      if (console.table) console.table(rows);
      return rows;
    }
  };

  // 布局和会话都存在服务端，所以"刷新"和"重新打开"走同一条路：先把上一轮接回来。
  //
  // 曾经把冷启动单独处理成"给一个干净窗格 + 清掉没人挂着的会话"，出发点是不想
  // 一进来就看到上次残局。但那个做法有两个致命副作用：清会话会把还在跑的任务
  // 一起杀掉；紧接着 save() 又把单窗格写回布局，磁盘上的分屏被永久覆盖。
  // 用户关一下窗口再进来，看到的就是"持久化没了、脚本也没了"。
  //
  // 现在一律恢复。TUI（claude/vim）的乱码问题在服务端解决：接回一个备用屏幕
  // 会话时让 PTY 抖一下尺寸，程序自己整屏重画（见 ws.go）。

  async function boot() {
    // 字体就绪后再 open：否则字体晚到会让 cell 尺寸变化，
    // 触发 resize → PTY 重排 → TUI 重绘两次，肉眼可见的抖动。
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { }
    }

    var restored = false;

    try {
      var res = await fetch(API + 'layout', { cache: 'no-store' });
      if (res.ok) {
        var data = await res.json();
        if (data && data.tabs) restored = app.restore(data);
      }
    } catch (e) { /* 服务端没启用布局或网络问题，退到单标签 */ }

    if (!restored) {
      app.newTab(true);
    } else {
      // 恢复出来的标签要重建 DOM 和会话
      for (var i = 0; i < app.tabs.length; i++) {
        var t = app.tabs[i];
        t.view = el('div', 'tabview');
        t.view.classList.add('hidden');
        app.buildTabEl(t);
        $('panes').appendChild(t.view);
        $('tabstrip').appendChild(t.el);

        for (var pid in t.panes) {
          if (!Object.prototype.hasOwnProperty.call(t.panes, pid)) continue;
          var p = t.panes[pid];
          p.mount();
          p.el.style.display = 'flex';
        }
        t.render();
        eachLeaf(t.root, function (leaf) {
          var p = t.panes[leaf.id];
          if (p) p.connect();
        });
      }
      app.activateTab(app.activeTabId, false);
    }

    app.loading = false;

    // 拖完分隔条 400ms 防抖还没落盘就关窗口的话，这次改动静默丢失。
    // pagehide 是页面销毁前最后的机会，请求必须 keepalive 才发得出去。
    window.addEventListener('pagehide', function () {
      if (app.loading) return;
      app.flush(true);
    });

    window.addEventListener('keydown', function (e) { app.onKeydown(e); }, true);
    window.addEventListener('focus', function () {
      var p = app.activePane();
      if (p) p.session.focus();
    });

    $('btn-new').addEventListener('click', function () { app.newTab(true); });
    $('btn-split-row').addEventListener('click', function () { app.split('row'); });
    $('btn-split-col').addEventListener('click', function () { app.split('col'); });

    app.syncSettings();
    app.save();
    // 服务端可能还有"没有页面挂着"的会话（页面崩过、上次点了只关界面）。
    // 启动时校正一次，把徽标点亮，否则用户以为那些进程不见了。
    app.refreshBackgroundCount();
    setTimeout(function () {
      var p = app.activePane();
      if (p) p.session.focus();
    }, 100);
  }

  boot();
})();
