/*
 * 右键语义的回归：有选中 → 复制；没选中 → 粘贴。终端里外一条规则。
 *
 * 三个曾经出问题的地方：
 *
 * 1) 全屏程序（Claude Code / vim / htop）会周期性重发 \x1b[?1000h。xterm 的
 *    activeProtocol setter 没有幂等判断，每次重设都会 fire 一次
 *    onProtocolChange，选区服务收到就清空 —— 用户 Shift 拖完一松手，高亮
 *    就没了，来不及右键。现在重复设置同一协议被短路掉。
 *
 * 2) 复制之后选区必须收掉。否则下一次右键照样"有选区"，又复制一遍，
 *    用户永远粘不上。
 *
 * 3) 粘贴不能被"程序接管了鼠标"卡住 —— 那是上一版加的保护，副作用是
 *    复制完就再也粘不进去。
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
const PORT = 18136;
const DBG = 9342;
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
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  const boxOf = () => page.evaluate(() => {
    const r = window.__ts.app.activePane().session.host.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const state = () => page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    const b = document.getElementById('banner');
    return {
      has: s.term.hasSelection(),
      text: (s.term.getSelection() || '').trim(),
      banner: b ? b.textContent : '',
      hidden: b ? b.hidden : true,
      alt: s.term.buffer.active.type,
    };
  });

  // 让 term.paste 只做记录，方便断言"到底粘了什么"
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    window.__pasted = [];
    s.term.paste = function (t) { window.__pasted.push(t); };
  });
  const pasted = () => page.evaluate(() => window.__pasted.slice());
  const resetPasted = () => page.evaluate(() => { window.__pasted.length = 0; });

  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
  const dragSelect = async (x0, y, x1, shift) => {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x1, y, { steps: 8 });
    // up 之前等一帧，让 xterm 把最后一段 mousemove 处理完。
    // 连着发 up 会把整段拖动并进一次点击，选不出东西。
    await frame();
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
    await sleep(250);
  };

  // ---------- 普通缓冲区 ----------
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.focus();
    s.term.write('\x1b[H\x1b[2J');
    s.term.write('PLAIN_LINE_ONE\r\nPLAIN_LINE_TWO\r\n');
  });
  await sleep(500);
  let box = await boxOf();
  // 第一次鼠标交互在 headless 里只用来把焦点交给窗口/终端，不产生选区。
  // 先点一下空白，再开始真正的拖选。
  await page.mouse.click(box.x + 400, box.y + 300);
  await sleep(250);
  await dragSelect(box.x + 4, box.y + 9, box.x + 200, 9);
  let s1 = await state();
  check('普通区域能选中', s1.has && s1.text.length > 0, JSON.stringify(s1.text.slice(0, 20)));

  await resetPasted();
  await page.mouse.click(box.x + 120, box.y + 8, { button: 'right' });
  await sleep(500);
  let s2 = await state();
  check('有选中时右键 = 复制', /已复制/.test(s2.banner), JSON.stringify(s2.banner));
  check('复制后选区被收掉', !s2.has);
  check('复制没有触发粘贴', (await pasted()).length === 0);

  await page.mouse.click(box.x + 120, box.y + 8, { button: 'right' });
  await sleep(500);
  let p1 = await pasted();
  check('紧接着再右键 = 粘贴（同一段内容）', p1.length === 1 && p1[0].trim() === s1.text, JSON.stringify(p1));

  // ---------- 全屏程序 + 鼠标追踪 ----------
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
    s.term.write('TUI_LINE_ALPHA\r\nTUI_LINE_BETA\r\n');
  });
  await sleep(700);

  box = await boxOf();
  await dragSelect(box.x + 8, box.y + 8, box.x + 150, true);
  let t1 = await state();
  check("TUI 里 Shift 拖动能选中", t1.has && t1.text.length > 0, JSON.stringify(t1.text.slice(0, 24)));

  // 程序周期性重发鼠标模式（Claude Code 的实际行为）
  await page.evaluate(() => {
    window.__flood = setInterval(() => {
      const s = window.__ts.app.activePane().session;
      s.term.write('\x1b[?1000h');
    }, 100);
  });
  await sleep(900);
  let t2 = await state();
  check('程序反复重设鼠标模式后选区仍在', t2.has && t2.text === t1.text, `has=${t2.has}`);
  await page.evaluate(() => clearInterval(window.__flood));

  await resetPasted();
  await page.mouse.click(box.x + 120, box.y + 8, { button: 'right' });
  await sleep(500);
  let t3 = await state();
  check('TUI 里右键 = 复制', /已复制/.test(t3.banner), JSON.stringify(t3.banner));
  check('TUI 里复制后选区被收掉', !t3.has);

  await page.mouse.click(box.x + 120, box.y + 8, { button: 'right' });
  await sleep(600);
  let p2 = await pasted();
  check('TUI 里再右键能粘贴', p2.length === 1 && p2[0] === t1.text, JSON.stringify(p2));

  // ---------- 没选过就直接右键，应当是粘贴 ----------
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.clearSelection();
    s.term.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l\r\n');
  });
  await sleep(600);
  await resetPasted();
  box = await boxOf();
  await page.mouse.click(box.x + 120, box.y + 40, { button: 'right' });
  await sleep(600);
  let p3 = await pasted();
  check('从没选过时右键 = 粘贴', p3.length === 1, JSON.stringify(p3).slice(0, 80));

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
