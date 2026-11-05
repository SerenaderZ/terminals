/*
 * 分屏后"蓝框跟不跟鼠标"的回归。
 *
 * 现象：分成两格之后，点另一格，蓝框（.pane.focused 的 outline）不动，
 * Ctrl+Alt+方向键之类接着还是作用在原来那一格上。
 *
 * 根因：拖选改由前端自己接管之后，host 上的 mousedown 会就地
 * stopPropagation（不拦的话 xterm 和程序会各自再选一遍）。事件因此传不到
 * pane 根元素的 mousedown 监听 —— 而 focusPane 正好挂在那儿。于是"点了，
 * 但没被当成点"。修法见 Pane.mount 里的 onGrab。
 *
 * 这里覆盖两条路径：
 *   a) 普通终端里直接拖（不按 Shift）—— 走 own 分支，被拦
 *   b) 全屏程序里按住 Shift 拖  —— 同样走 own 分支，被拦
 * 两条都必须把焦点带过去；不拖、纯点一下也必须带过去。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-focus';
const PROFILE = ROOT + '\\.build\\edge-focus';
const PORT = 18146;
const DBG = 9352;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 布局是持久化的：上一次跑留下的窗格会被恢复出来，"分成两格"当场变三格。
// 每次从干净的数据目录起步，断言才有意义。
fs.rmSync(DATA, { recursive: true, force: true });

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
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
  const hotkey = async (key) => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press(key);
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await sleep(900);
  };

  // 每一格的 id + 屏幕矩形 + 是不是"蓝框那一格"
  const panes = () => page.evaluate(() => {
    const tab = document.querySelector('.tabview:not(.hidden)');
    return [...tab.querySelectorAll('.pane')].map((el) => {
      const r = el.querySelector('.terminal-host').getBoundingClientRect();
      return {
        id: el.dataset.pane,
        focused: el.classList.contains('focused'),
        x: r.x, y: r.y, w: r.width, h: r.height,
      };
    });
  });
  const focusedId = async () => (await panes()).filter((p) => p.focused).map((p) => p.id).join(',');
  const activeId = () => page.evaluate(() => window.__ts.app.activePane().id);

  await hotkey('Equal');
  let ps = await panes();
  check('Ctrl+Alt+= 分成两格', ps.length === 2, `panes=${ps.length}`);

  // 左格 = 第一格；刚分屏出来的新格在右，且是 active。
  const left = ps[0], right = ps[1];
  check('新窗格拿到焦点', right.focused && !left.focused);

  // headless 第一次鼠标交互只会把焦点交给窗口，先点一下当前格。
  await page.mouse.click(right.x + 60, right.y + 60);
  await sleep(200);

  // a) 普通终端：直接点左格
  await page.mouse.click(left.x + 80, left.y + 60);
  await sleep(300);
  check('点另一格 → 蓝框跟过去', await focusedId() === left.id, `focused=${await focusedId()}`);
  check('activePane 同步切过去', await activeId() === left.id, `active=${await activeId()}`);

  // b) 普通终端：在左格里直接拖选（不按 Shift），走 own 分支
  await page.mouse.move(left.x + 4, left.y + 9);
  await page.mouse.down();
  await page.mouse.move(left.x + 90, left.y + 9, { steps: 6 });
  await frame();
  await page.mouse.up();
  await sleep(250);
  const dragged = await page.evaluate(() => !!window.__ts.app.activePane().session.selRange);
  check('拖选本身没坏', dragged);
  check('拖选时蓝框留在左格', await focusedId() === left.id, `focused=${await focusedId()}`);

  // c) 全屏程序 + 鼠标追踪：点右格，再在右格里 Shift 拖 —— 也走 own 分支
  await page.mouse.click(right.x + 80, right.y + 60);
  await sleep(300);
  check('切回右格', await focusedId() === right.id, `focused=${await focusedId()}`);

  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
    s.term.write('TUI_LINE_ALPHA\r\nTUI_LINE_BETA\r\n');
  });
  await sleep(700);

  await page.mouse.click(left.x + 80, left.y + 60);
  await sleep(300);
  check('TUI 里点另一格 → 蓝框跟过去', await focusedId() === left.id, `focused=${await focusedId()}`);

  // 让右格重新变成 active，然后在它里面 Shift 拖
  await page.mouse.click(right.x + 80, right.y + 60);
  await sleep(300);
  await page.mouse.click(left.x + 80, left.y + 60);
  await sleep(200);
  await page.keyboard.down('Shift');
  await page.mouse.move(right.x + 4, right.y + 9);
  await page.mouse.down();
  await page.mouse.move(right.x + 90, right.y + 9, { steps: 6 });
  await frame();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(300);
  check('Shift 拖另一格 → 蓝框跟过去', await focusedId() === right.id, `focused=${await focusedId()}`);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
