/*
 * 复制带换行的文本：换行、空行必须原样留下。
 *
 * 0.4.5 修的是"三行粘出五行"——每行末尾被 TUI 用 U+00A0 补满整宽，粘到会
 * 折行的地方就多出空行。裁的是行尾**填充**，不是换行。这里盯住这件事：
 *
 *   1) 选三行（中间一行是空行）→ 取出来还是三行，中间那个空行还在
 *   2) 行尾的 U+00A0 默认不出现（0.4.5 的行为不能被这次改动带回去）
 *   3) Ctrl+Shift+Insert 的原样通道：行尾 NBSP 保留、行数不变
 *   4) 选到末尾空行时，默认去掉末尾那个换行（免得粘贴多顶一行），
 *      原样通道则保留
 *
 * 造数据用 node 写 UTF-8，不用 PowerShell —— 控制台代码页会把 NBSP 变成 '?'。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-raw';
const PROFILE = ROOT + '\\.build\\edge-raw';
const GEN = ROOT + '\\.build\\rawgen.js';
const PORT = 18193;
const DBG = 9393;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// AAA / 空行 / BBB / 空行：行尾一律用 NBSP 补满整宽
fs.writeFileSync(GEN, [
  "const pad = '\\u00a0'.repeat(120);",
  "process.stdout.write('AAA' + pad + '\\r\\n');",
  "process.stdout.write('\\r\\n');",
  "process.stdout.write('BBB' + pad + '\\r\\n');",
  "process.stdout.write('\\r\\n');",
].join('\n') + '\n');

fs.rmSync(DATA, { recursive: true, force: true });
const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  // 截获剪贴板写入：headless 下真实剪贴板读不到，但要验的是"按键有没有
  // 走到原样通道、写进去的是什么"，记下来就够了。
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    if (navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: (t) => { window.__copied.push(t); return Promise.resolve(); },
        });
      } catch (e) { /* 只读就跳过，后面看 __copied 为空即可 */ }
    }
  });
  await page.setViewport({ width: 1100, height: 820 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  const send = (c) => page.evaluate((x) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(x));
  }, c);

  const findRow = (name) => page.evaluate((n) => {
    const s = window.__ts.app.activePane().session;
    const b = s.term.buffer.active;
    for (let y = 0; y < s.term.rows; y++) {
      const l = b.getLine(b.viewportY + y);
      if (!l) continue;
      if (l.translateToString(false).replace(/[\s\u200b\ufeff]+$/, '') === n) return y;
    }
    return -1;
  }, name);

  const dragRows = async (row0, row1) => {
    const g = await page.evaluate((a) => {
      const p = window.__ts.app.activePane();
      const s = p.session;
      const m = s.cellMetrics();
      const box = p.host.getBoundingClientRect();
      const vp = s.term.buffer.active.viewportY;
      return {
        x0: box.left + m.left + 1,
        x1: box.left + m.left + (s.term.cols - 1) * m.w,
        y0: box.top + m.top + (a.row0 - vp) * m.h + m.h / 2,
        y1: box.top + m.top + (a.row1 - vp) * m.h + m.h / 2,
      };
    }, { row0, row1 });
    await page.mouse.move(g.x0, g.y0);
    await page.mouse.down();
    await page.mouse.move(g.x1, g.y1, { steps: 12 });
    await page.mouse.up();
    await sleep(400);
  };

  const plain = () => page.evaluate(() => window.__ts.app.activePane().session.rangeText(false));
  const raw = () => page.evaluate(() => window.__ts.app.activePane().session.rangeText(true));
  const clearSel = () => page.evaluate(() => window.__ts.app.activePane().session.clearSelection());

  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);

  await send(`node ${GEN}\r`);
  await sleep(2000);

  const a = await findRow('AAA');
  const b = await findRow('BBB');
  check('两行内容都在屏幕上、中间隔一行', a >= 0 && b === a + 2, `rows=${a},${b}`);

  // ---------- 1/2. 三行（含中间空行）默认复制 ----------
  if (a >= 0 && b === a + 2) {
    await dragRows(a, b);
    const t = await plain();
    console.log('   默认取出:', JSON.stringify(t));
    check('换行没被吃掉：还是三行', t.split('\n').length === 3, `lines=${t.split('\n').length}`);
    check('中间的空行还在', t.split('\n')[1] === '', JSON.stringify(t.split('\n')[1]));
    check('内容原样', t === 'AAA\n\nBBB', JSON.stringify(t));
    check('行尾 NBSP 没被带出来', !/[\u00a0]/.test(t));

    // ---------- 3. 原样通道 ----------
    const r = await raw();
    check('原样通道：行数也是三行', r.split('\n').length === 3, `lines=${r.split('\n').length}`);
    check('原样通道：行尾 NBSP 留着', /AAA\u00a0{10,}/.test(r) && /BBB\u00a0{10,}/.test(r),
      `len=${r.length}`);

    // 按键要真的接到这个通道上（Ctrl+Shift+Insert）
    await page.evaluate(() => window.__ts.app.activePane().session.focus());
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Insert');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await sleep(400);
    const copied = await page.evaluate(() => (window.__copied || []).slice(-1)[0] || '');
    check('Ctrl+Shift+Insert 真的走进原样通道',
      /AAA\u00a0{10,}/.test(copied) && copied.split('\n').length === 3, `len=${copied.length}`);
  }

  // ---------- 4. 选到末尾空行 ----------
  if (a >= 0 && b === a + 2) {
    await clearSel();
    await dragRows(a, b + 1);
    const t = await plain();
    check('选到末尾空行：默认不留尾换行', !/\n$/.test(t), JSON.stringify(t.slice(-6)));
    const r = await raw();
    check('选到末尾空行：原样通道留着尾换行', /\n$/.test(r) || /\u00a0$/.test(r),
      JSON.stringify(r.slice(-6)));
  }

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
