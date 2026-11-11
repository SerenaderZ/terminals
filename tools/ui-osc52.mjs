/*
 * 复制出去的行数必须和框住的行数一致，以及程序自己发起的复制（OSC 52）。
 *
 * 起因：在 Claude Code 里框了 5 行（3 行字 + 2 行空），粘出来只有 3 行；
 * 屏幕上那行 "sent 72 chars via OSC 52" 说明它确实把 5 行交出来了，只是
 * 没人接。两处都要修：
 *
 *   1) 选区取字：结尾的空行不再裁，N 行就是 N 行（N-1 个换行）
 *   2) OSC 52：程序发来的复制请求要真的写进剪贴板
 *
 * 这一套是端到端的：OSC 序列由真实程序写 stdout，经 PTY 到终端再被解析，
 * 不是拿 term.write 伪造的。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-osc52';
const PROFILE = ROOT + '\\.build\\edge-osc52';
const GEN_LINES = ROOT + '\\.build\\osc-lines.js';
const GEN_OSC = ROOT + '\\.build\\osc-emit.js';
const PORT = 18194;
const DBG = 9394;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 屏幕上摆 5 行：3 行有字，后面 2 行是空的 —— 和 Claude Code 欢迎框下面的
// 留白一个样子。
fs.writeFileSync(GEN_LINES, [
  "process.stdout.write('L1-COPY\\r\\n');",
  "process.stdout.write('L2-COPY\\r\\n');",
  "process.stdout.write('L3-COPY\\r\\n');",
  "process.stdout.write('\\r\\n');",
  "process.stdout.write('\\r\\n');",
].join('\n') + '\n');

// 程序主动复制：发一条 OSC 52，内容两行，中文也带上（验 UTF-8 解码）。
fs.writeFileSync(GEN_OSC, [
  "const text = 'OSC-AAA\\nOSC-中文';",
  "const b64 = Buffer.from(text, 'utf8').toString('base64');",
  "process.stdout.write('\\x1b]52;c;' + b64 + '\\x07');",
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
  // 截获剪贴板写入：headless 下真实剪贴板读不到，验"写进去的是什么"就够了。
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    if (navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: (t) => { window.__copied.push(t); return Promise.resolve(); },
        });
      } catch (e) { /* 只读就跳过 */ }
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
    for (let y = 0; y < s.term.buffer.active.length; y++) {
      const l = b.getLine(y);
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
  const copied = () => page.evaluate(() => (window.__copied || []).slice(-1)[0] || '');

  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);

  // ---------- 1. 框 5 行，取出来必须是 5 行 ----------
  await send(`node ${GEN_LINES}\r`);
  await sleep(2200);

  const r1 = await findRow('L1-COPY');
  const r3 = await findRow('L3-COPY');
  check('三行内容在屏幕上', r1 >= 0 && r3 === r1 + 2, `rows=${r1},${r3}`);

  if (r1 >= 0) {
    await dragRows(r1, r1 + 4);           // 3 行字 + 2 行空 = 5 行
    const t = await plain();
    console.log('   取出:', JSON.stringify(t));
    check('框 5 行 → 取出来 5 行', t.split('\n').length === 5, `lines=${t.split('\n').length}`);
    check('内容就是那三行、后面两个空行',
      t === 'L1-COPY\nL2-COPY\nL3-COPY\n\n', JSON.stringify(t));

    // 右键复制（有选区 → 复制），剪贴板里也必须是 5 行
    const mid = await page.evaluate(() => {
      const box = window.__ts.app.activePane().host.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await sleep(500);
    const c = await copied();
    check('右键复制：剪贴板里也是 5 行', c.split('\n').length === 5, JSON.stringify(c));
  }

  // ---------- 2. 程序自己发 OSC 52 ----------
  await send(`node ${GEN_OSC}\r`);
  await sleep(1800);
  const osc = await copied();
  check('OSC 52：文本进了剪贴板', osc === 'OSC-AAA\nOSC-中文', JSON.stringify(osc));

  // ---------- 3. 查询剪贴板不回 ----------
  const before = await page.evaluate(() => (window.__copied || []).length);
  await page.evaluate(() => {
    window.__ts.app.activePane().session.term.write('\x1b]52;c;?\x07');
  });
  await sleep(300);
  const after = await page.evaluate(() => (window.__copied || []).length);
  check('OSC 52 查询（?）不会写剪贴板', after === before, `${before} → ${after}`);

  // ---------- 4. 回放历史时不动剪贴板 ----------
  const b64 = Buffer.from('FROM-HISTORY\nOLD', 'utf8').toString('base64');
  await page.evaluate((payload) => new Promise((res) => {
    const s = window.__ts.app.activePane().session;
    const before = (window.__copied || []).length;
    s.writeHistory('\x1b[2J\x1b[H' + payload + 'REPLAYED\r\n', () => {
      window.__copiedBeforeReplay = before;
      res();
    });
  }), `\x1b]52;c;${b64}\x07`);
  await sleep(400);
  const nb = await page.evaluate(() => window.__copiedBeforeReplay);
  const na = await page.evaluate(() => (window.__copied || []).length);
  check('回放历史里的 OSC 52 不写剪贴板', na === nb, `${nb} → ${na}`);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
