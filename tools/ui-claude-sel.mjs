/*
 * Claude Code（Ink）里的 Shift 拖选回归。
 *
 * 现象：按住 Shift 拖动，选中的高亮过一会儿就没了。
 *
 * 和 ui-tui.mjs 的区别：那边写的是静态内容，写完就停；真实的 TUI 是
 * 一直在重绘 —— 状态行刷新、反复重设鼠标协议、光标隐藏/显示。这些
 * 输出本身不改变选区，但会触发 xterm 的整屏重绘，选区高亮如果没有被
 * 一起重画，用户看到的就是"选框消失了"。
 *
 * 这里区分两件事：
 *   hasSelection()  —— 选区数据还在不在（右键能不能复制）
 *   高亮是否可见    —— 画面上有没有那层蓝底（用户看到的东西）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-sel2';
const PROFILE = ROOT + '\\.build\\edge-sel2';
const PORT = 18140;
const DBG = 9344;
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

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1100, height: 720 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // 模拟 claude：进备用屏幕、开鼠标追踪，然后像 Ink 一样每 150ms 重绘状态行。
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    const t = s.term;
    t.write('\x1b[?1049h\x1b[H\x1b[2J');
    t.write('\x1b[?1002h\x1b[?1006h');
    for (let i = 0; i < 24; i++) t.write(`\x1b[${i + 1};1HCLAUDE_LINE_${i} some text here\x1b[K`);
    t.write('\x1b[24;1H> ');
    let n = 0;
    window.__tuiTimer = setInterval(() => {
      n++;
      // Ink 的真实节奏：每帧重设一遍终端状态 —— 鼠标协议在 1002/1003 之间
      // 换、备用屏幕也重发一次、光标隐藏再显示。这些"重设"本身不该影响
      // 用户刚选中的东西。
      t.write('\x1b[?1002h\x1b[?1006h');
      t.write('\x1b[?1049h');
      t.write('\x1b[?25l');
      t.write('\x1b[24;1H\x1b[K> ' + 'tick' + (n % 10));
      t.write('\x1b[1;40H\x1b[K' + 'working ' + (n % 10));
      t.write('\x1b[?25h');
      if (n % 2 === 0) t.write('\x1b[?1003h'); else t.write('\x1b[?1002h');
    }, 150);
  });
  await sleep(800);

  const box = await page.evaluate(() => {
    const r = window.__ts.app.activePane().session.host.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // Shift 拖动第 2 行
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 12, box.y + 34);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 34, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(250);

  const immediately = await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return { has: s.term.hasSelection(), text: (s.term.getSelection() || '').trim() };
  });
  check('Shift 拖动后立刻有选区', immediately.has && immediately.text.length > 0, JSON.stringify(immediately.text.slice(0, 40)));

  // 让 TUI 继续重绘 1.5 秒
  await sleep(1500);

  const later = await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return { has: s.term.hasSelection(), text: (s.term.getSelection() || '').trim() };
  });
  check('持续重绘 1.5 秒后选区仍在', later.has && later.text.length > 0, `has=${later.has} text=${JSON.stringify(later.text.slice(0, 40))}`);

  // 用户能不能直接右键复制
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    window.__copied = null;
    s.copyText = function (t) { window.__copied = t; };
  });
  await page.mouse.click(box.x + 320, box.y + 34, { button: 'right' });
  await sleep(300);
  const copied = await page.evaluate(() => window.__copied);
  check('重绘之后右键仍能复制', !!copied && copied.length > 0, JSON.stringify(String(copied || '').slice(0, 40)));

  await page.evaluate(() => clearInterval(window.__tuiTimer));
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
