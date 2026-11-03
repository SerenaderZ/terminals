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
  var C = { INPUT: 0x01, RESIZE: 0x02, SIGNAL: 0x03, ACK: 0x04 };
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
    scrollback: 10000,
    copyOnSelect: true
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
    selectionBackground: 'rgba(0,103,192,0.25)'
  };

  var DARK_THEME = {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#cccccc',
    cursorAccent: '#0c0c0c',
    selectionBackground: 'rgba(76,194,255,0.3)',
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

  // ------------------------------------------------------------- 单个 pane

  function Pane(ws, spec) {
    this.ws = ws;
    this.id = spec.id || uid('p');
    this.sid = spec.sid || null;
    this.title = spec.title || '终端';
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
      onAlt: function (on) { self.setAlt(on); }
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

    term.onData(function (data) {
      self.send(C.INPUT, new TextEncoder().encode(data));
    });

    term.onBinary(function (data) {
      var bytes = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      self.send(C.INPUT, bytes);
    });

    term.onTitleChange(function (title) {
      if (title) self.opts.onTitle && self.opts.onTitle(title);
    });

    term.onResize(function (size) {
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
        banner('已复制 ' + text.length + ' 个字符', 'ok');
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

    // 选中即复制。终端里拖选文字，十次有十次是为了粘到别处；
    // 再要求按一次快捷键就是纯多余 —— 何况 Chrome 把 Ctrl+Shift+C
    // 给了开发者工具，网页拦不住。默认开，设置页里可以关掉。
    //
    // 防抖 160ms：拖选过程中选区每变一次都会触发，不能每变一次就写剪贴板。
    try {
      if (term.onSelectionChange) {
        term.onSelectionChange(function () {
          // 每次真的选中东西都留一份快照。作用是兜底：哪怕高亮被程序
          // 后续的输出冲掉（协议重设、清屏重绘），用户几秒内右键仍能
          // 复制到刚选的那段，而不是撞进"没选区就粘贴"。
          var sel = self.term && self.term.getSelection();
          if (sel) self.selSnap = { text: sel, at: Date.now() };

          if (!self.owner || !self.owner.settings.copyOnSelect) return;
          clearTimeout(self.selTimer);
          self.selTimer = setTimeout(function () {
            if (self.disposed || !self.term) return;
            var text = self.selectionText();
            if (!text) return;
            self.copyText(text);
          }, 160);
        });
      }
    } catch (e) { /* 老版本 xterm 没有这个事件 */ }

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

  // afterBufferSwap 在缓冲区切换后整屏重画，顺带刷掉 WebGL 的字形图集。
  //
  // 为什么必须重画：TUI 退出时是一串"恢复主屏 + 恢复光标"的转义序列，
  // 渲染器如果只按脏区增量更新，就会把 TUI 的残留格子留在屏幕上 ——
  // 用户看到的就是"退出后一堆乱码"。整屏重画是最便宜且确定有效的解法。
  //
  // 为什么刷两次：切换缓冲区这一刻，程序往往还会紧接着打印收尾信息
  // （claude 退出时的 "Resume this session with…" 就是），这些字节是在
  // 第一次 refresh 之后才落屏的。只刷一次，它们依旧按增量绘制，上一屏
  // 留下的脏格子就跟着一起留在画面上。第二次补刷把它们一并盖掉。
  Session.prototype.afterBufferSwap = function () {
    var self = this;
    var paint = function () {
      if (!self.term) return;
      try { self.term.refresh(0, self.term.rows - 1); } catch (e) { }
    };
    requestAnimationFrame(function () {
      if (!self.term) return;
      if (self.webgl && typeof self.webgl.clearTextureAtlas === 'function') {
        try { self.webgl.clearTextureAtlas(); } catch (e) { }
      }
      paint();
    });
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
    try { this.fitAddon.fit(); } catch (e) { return; }
  };

  // resize 防抖：拖窗口时别把 PTY 刷爆，TUI 会跟着反复重排。
  Session.prototype.scheduleFit = function () {
    var self = this;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(function () { self.fit(); }, 80);
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
    this.connectAt = Date.now();
    this.setState('connecting');

    var params = new URLSearchParams();
    if (this.sid) params.set('sid', this.sid);
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
      if (self.term) self.sendResize(self.term.cols, self.term.rows);
    };

    ws.onmessage = function (ev) {
      if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength === 0) return;
      var buf = new Uint8Array(ev.data);
      var kind = buf[0];
      var payload = buf.subarray(1);

      if (kind === S.OUTPUT) {
        if (self.term) self.term.write(payload);
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
        if (self.term && (info.replayLen > 0 || becameNewSession)) {
          self.term.reset();
          self.selSnap = null;
          self.alt = false;
          self.opts.onAlt && self.opts.onAlt(false);
        }
        if (becameNewSession) self.exited = false;
        self.sid = info.sid;

        // 尺寸对账：READY 里的 cols/rows 是 PTY 当前的真实大小。
        // 一旦它和 xterm 不一致，TUI 就按错宽度排版、换行位置全错，
        // 退出后屏幕上留的就是错位残字。发现不一致立刻把 PTY 掰回 xterm 的尺寸，
        // 不指望"下一次窗口 resize 会顺带修正"。
        self.ptyCols = info.cols || 0;
        self.ptyRows = info.rows || 0;
        if (self.term && self.ptyCols && self.ptyRows &&
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
        self.opts.onReady && self.opts.onReady(info);
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
      self.fail(closeReason(ev), ev && ev.code);
      self.setState('offline');
      // 1013 = 服务端主动放弃这条连接（输出太快，队列跟不上）。
      // 这不是故障，是"重连一下就好"：清掉退避计数，别让用户对着
      // 一个已经过去的问题等 1s、2s、4s。
      if (ev && ev.code === 1013) self.retry = 0;
      if (!self.exited) self.scheduleRetry(ev && ev.code === 1013);
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

  // 快照的有效期。正常路径上用不到它（协议保护会保住高亮），它是给
  // "高亮已经消失、但用户确实刚选过"这种情况兜底的。太长会误伤 ——
  // 用户选完过一会儿想粘贴，却被当成又一次复制。
  var SEL_SNAP_TTL = 15000;

  // selectionText 返回"这次右键该复制的内容"：优先当前真实选区，
  // 退回到 15 秒内的选区快照。
  Session.prototype.selectionText = function () {
    if (!this.term) return '';
    var now = this.term.getSelection();
    if (now) return now;
    if (this.selSnap && Date.now() - this.selSnap.at < SEL_SNAP_TTL) return this.selSnap.text;
    return '';
  };

  // clearSelection 连同快照一起作废 —— 复制完就走这条路，
  // 于是紧接着的下一次右键必然是粘贴。
  Session.prototype.clearSelection = function () {
    this.selSnap = null;
    try { if (this.term) this.term.clearSelection(); } catch (e) { }
  };

  // copy 复制当前选区（快捷键走这里），返回是否真的复制到了东西。
  // 与右键共用 selectionText，所以高亮已被冲掉时快照内容也能复制；
  // 区别是这里不清选区 —— Ctrl+Insert 之后多半还要继续用鼠标。
  Session.prototype.copy = function () {
    var text = this.selectionText();
    if (!text) return false;
    this.copyText(text);
    return true;
  };

  // copyText 把一段文本写进系统剪贴板。
  Session.prototype.copyText = function (text) {
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
    if (!ok) banner('浏览器不允许写入剪贴板，请用 Ctrl+Insert 或系统复制', 'warn');
    return true; // 有内容就算"复制"这个意图成立，调用方不必再退到粘贴
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
  Session.prototype.pasteInner = function () {
    var text = readInnerClip();
    if (!text || !this.term) return false;
    this.term.paste(text);
    this.focus();
    banner('已粘贴终端内复制的 ' + text.length + ' 个字符 · 外部内容请按 Ctrl+V', 'info');
    return true;
  };

  // awaitPaste 是最后的兜底：把焦点摆好，把还能用的入口说准。
  // 浏览器只把剪贴板数据交给真实按键，所以这里能做的只有提示。
  //
  // 只说 Ctrl+V，不提"右键菜单"：右键分支在安全上下文里正是刚才失败的那条
  // 路，它同样被 preventDefault 掉，让用户再点一次右键只会再看到同一句话。
  Session.prototype.awaitPaste = function () {
    this.focus();
    banner(window.isSecureContext
      ? '浏览器不允许读取剪贴板，请按 Ctrl+V 粘贴'
      : '这个 http 页面读不到剪贴板，请按 Ctrl+V 粘贴', 'ask');
  };

  Session.prototype.dispose = function () {
    this.disposed = true;
    this.focused = false;
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

  function Tab(ws, spec) {
    this.ws = ws;
    this.id = spec.id || uid('t');
    this.title = spec.title || '终端';
    this.root = spec.root || null;
    this.activePaneId = spec.activePaneId || null;
    this.panes = {};
    this.view = null;
    this.el = null;
  }

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
    t.el = el('div', 'tab');
    t.el.innerHTML = '<span class="title">终端</span><button class="close" title="关闭标签">×</button>';
    if (spec && spec.title) t.el.querySelector('.title').textContent = spec.title;
    t.el.querySelector('.close').addEventListener('click', function (e) {
      e.stopPropagation();
      this.closeTab(t);
    }.bind(this));
    t.el.addEventListener('click', function () { this.activateTab(t.id); }.bind(this));

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
    document.title = (pane ? pane.title : t.title) + ' — TerminalS';
    store(ACTIVE_KEY, id + ':' + (pane ? pane.id : ''));

    // 切回来时窗格尺寸可能变了（隐藏期间 display:none，clientWidth 为 0），必须重排。
    var self = this;
    requestAnimationFrame(function () {
      eachLeaf(t.root, function (leaf) {
        var p = t.panes[leaf.id];
        if (p) p.fit();
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
      t.el.querySelector('.title').textContent = pane.title;
      document.title = pane.title + ' — TerminalS';
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

  Workspace.prototype.connState = function () {
    var panes = this.connPanes();
    if (!panes.length) return 'online';    // 还没有窗格，不该报警

    var online = 0, offline = 0, connecting = 0;
    for (var i = 0; i < panes.length; i++) {
      var s = panes[i].el.dataset.state;
      if (s === 'offline') offline++;
      else if (s === 'online') online++;
      else connecting++;
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
    var best = null, bestScore = -1;

    this.eachSession(function (st, p) {
      if (st.disposed || st.exited || !p.el) return;
      var state = p.el.dataset.state;
      if (state === 'online') return;
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
    $('set-copyselect').checked = !!s.copyOnSelect;
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

  $('set-copyselect').addEventListener('change', function () {
    app.saveSettings({ copyOnSelect: this.checked });
    setTip.className = '';
    setTip.textContent = this.checked
      ? '已开启：拖选文字就复制，右键直接粘贴'
      : '已关闭：用 Ctrl+Insert 复制；右键在有选区时仍然可以复制';
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
    if (app.isBackgroundOpen()) app.closeBackgroundPanel();
    else app.openBackgroundPanel();
  });

  $('bg-close').addEventListener('click', function () { app.closeBackgroundPanel(); });

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
        t.el = el('div', 'tab');
        t.el.innerHTML = '<span class="title"></span><button class="close" title="关闭标签">×</button>';
        t.el.querySelector('.title').textContent = t.title;
        t.el.querySelector('.close').addEventListener('click', function (e) {
          e.stopPropagation();
          app.closeTab(this);
        }.bind(t));
        t.el.addEventListener('click', function () { app.activateTab(this.id); }.bind(t));
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
