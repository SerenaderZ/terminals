/*
 * 全屏程序（Claude Code / vim / htop）相关的两个回归。
 *
 * 1) 尺寸：换一台分辨率不同的设备打开同一个工作区，终端行列数必须跟 PTY
 *    对上。之前接回会话时的"尺寸抖动"用的是连接建立那一刻的行列数，浏览器
 *    fit 完把新尺寸发过去后，抖动还会拿旧值恢复一次，把新尺寸盖回去 ——
 *    表现是 TUI 按小尺寸重绘，画面只占左上角一块，点一下分屏才铺满。
 *
 * 2) 选择：TUI 打开鼠标追踪后，左键拖动被当成鼠标事件转给程序，xterm 没有
 *    选区。此时右键不能按"没选区就粘贴"处理，否则会把上一段复制的内容直接
 *    灌进对方输入框。正确行为是提示按住 Shift 拖动。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-verify';
const PROFILE = ROOT + '\\.build\\edge-verify';
const PORT = 18132;
const DBG = 9338;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

const boxOf = (page) => page.evaluate(() => {
  const r = window.__ts.app.activePane().session.host.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const bufText = (page) => page.evaluate(() => {
  const b = window.__ts.app.activePane().session.term.buffer.active;
  let t = '';
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l) t += l.translateToString(true) + '\n';
  }
  return t;
});

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });

  // ---------- 1. 跨设备尺寸 ----------
  const ctxA = await browser.createBrowserContext();
  const pA = await ctxA.newPage();
  await pA.setViewport({ width: 900, height: 600 });
  await pA.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const a = await pA.evaluate(async () => {
    const s = window.__ts.app.activePane().session;
    const r = await fetch('/api/sessions').then((x) => x.json());
    const me = (r.data || []).find((x) => x.sid === s.sid) || {};
    return { term: s.term.cols + 'x' + s.term.rows, pty: me.cols + 'x' + me.rows };
  });
  await pA.close();
  await ctxA.close();
  await sleep(800);

  const ctxB = await browser.createBrowserContext();
  const pB = await ctxB.newPage();
  await pB.setViewport({ width: 1600, height: 900 });
  await pB.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  const b = await pB.evaluate(async () => {
    const s = window.__ts.app.activePane().session;
    const r = await fetch('/api/sessions').then((x) => x.json());
    const me = (r.data || []).find((x) => x.sid === s.sid) || {};
    return { term: s.term.cols + 'x' + s.term.rows, pty: me.cols + 'x' + me.rows, host: s.host.clientWidth };
  });
  check('换设备后终端尺寸与 PTY 一致', b.term === b.pty, `${a.term} → ${b.term} / pty=${b.pty} / host=${b.host}`);

  // ---------- 2. mouse tracking 下右键不该乱粘 ----------
  await pB.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.term.write('\r\nPASTE_MARKER_777\r\n');
  });
  await sleep(400);
  let box = await boxOf(pB);
  await pB.mouse.move(box.x + 10, box.y + 30);
  await pB.mouse.down();
  await pB.mouse.move(box.x + 200, box.y + 30, { steps: 6 });
  await pB.mouse.up();
  await sleep(400);
  // 现在内部剪贴板里已经有 PASTE_MARKER_777
  await pB.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.term.write('\x1b[?1049h');
    s.term.write('\x1b[?1000h\x1b[?1006h');
    s.term.write('\x1b[H\x1b[2J');
    s.term.write('TUI_TARGET_LINE\r\n');
  });
  await sleep(700);

  const modes = await pB.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return {
      alt: s.term.buffer.active.type,
      mouse: s.term.modes.mouseTrackingMode,
      badge: !document.getElementById('altscreen').hidden,
    };
  });
  check('全屏程序徽章出现', modes.alt === 'alternate' && modes.badge, `buffer=${modes.alt} badge=${modes.badge}`);

  // 右键的语义在 ui-sel.mjs 里统一验证（有选中复制、没选中粘贴，程序里外
  // 都一样）。这里只确认鼠标被程序接管时，Shift 拖动仍然能建立真正的选区 ——
  // 那是全屏程序下唯一的选择入口。
  box = await boxOf(pB);

  // 按住 Shift 拖动应当能选中
  await pB.keyboard.down('Shift');
  await pB.mouse.move(box.x + 10, box.y + 12);
  await pB.mouse.down();
  await pB.mouse.move(box.x + 240, box.y + 12, { steps: 6 });
  await pB.mouse.up();
  await pB.keyboard.up('Shift');
  await sleep(400);
  const sel = await pB.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return { has: s.term.hasSelection(), text: (s.term.getSelection() || '').trim() };
  });
  check('Shift 拖动可以选中', sel.has && sel.text.length > 0, JSON.stringify(sel.text.slice(0, 30)));

  // ---------- 3. 徽章跟随焦点 ----------
  await pB.keyboard.press('Escape');
  await pB.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.term.write('\x1b[?1000l\x1b[?1006l');
    s.term.write('\x1b[?1049l');
    s.term.write('\r\nback to normal shell\r\n');
  });
  await sleep(700);
  const badgeAfter = await pB.evaluate(() => !document.getElementById('altscreen').hidden);
  check('全屏程序退出后徽章消失', !badgeAfter);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
