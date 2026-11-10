/*
 * 复制出来的文本不该带行尾填充。
 *
 * 用户报的现象：在 Claude Code 里选三行，粘回 Claude Code 的输入框变成五行 ——
 * 隔一行一个空行；粘到外面的宽文本框里却看着正常。差别在于"折行"：那些行
 * 末尾拖着上百个不可见字符，宽框里看不见，一折行就露出一个"空行"。
 *
 * 那些字符是 U+00A0（不换行空格）这类**非 ASCII 空白**。xterm 的
 * translateToString(true) 只把 U+0020 当空格裁，别的空白原样留着 ——
 * 全屏 TUI（Claude Code 就是）正好爱用它补满整宽。
 *
 * 这里验：
 *   1) 行尾是 U+00A0 填充时，取出来的每行都是干净的
 *   2) 三行还是三行
 *   3) 对照：行尾是普通空格时同样干净（这条本来就过）
 *
 * 注意：不能用 PowerShell 打 NBSP 来造数据 —— 控制台代码页会把它变成 '?'，
 * 测的就不是"不可见空白"了。这里用 node 直接写 UTF-8 字节。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-pad2';
const PROFILE = ROOT + '\\.build\\edge-pad2';
const GEN = ROOT + '\\.build\\padgen.js';
const PORT = 18192;
const DBG = 9392;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 造数据的小脚本：NBSP 补满整宽 + 一组普通空格作对照
fs.writeFileSync(GEN, [
  "const pad = (ch, n) => ch.repeat(n);",
  "for (const s of ['PADA', 'PADB', 'PADC']) process.stdout.write(s + pad('\\u00a0', 120) + '\\r\\n');",
  "for (const s of ['SPAA', 'SPAB']) process.stdout.write(s + pad(' ', 120) + '\\r\\n');",
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
  await page.setViewport({ width: 1100, height: 820 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  const send = (c) => page.evaluate((x) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(x));
  }, c);

  // 找「整行就是这个记号」的行号（视口坐标）。不能按"包含"找：命令行回显里
  // 也有这些记号。
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

  const selected = () => page.evaluate(() => window.__ts.app.activePane().session.selectionText());
  const clearSel = () => page.evaluate(() => window.__ts.app.activePane().session.clearSelection());

  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);

  // ---------- 1. 行尾用 U+00A0 补满整宽 ----------
  await send(`node ${GEN}\r`);
  await sleep(2000);

  const a = await findRow('PADA');
  const b2 = await findRow('PADB');
  const c = await findRow('PADC');
  check('三行都在屏幕上', a >= 0 && b2 === a + 1 && c === b2 + 1, `rows=${a},${b2},${c}`);

  if (a >= 0) {
    await dragRows(a, c);
    const text = await selected();
    console.log('   取出:', JSON.stringify(text.slice(0, 40)) + ` … 共 ${text.length} 字符`);
    check('三行还是三行', text.split('\n').length === 3, `lines=${text.split('\n').length}`);
    check('行尾的不可见空白没被带出来', text === 'PADA\nPADB\nPADC',
      JSON.stringify(text.slice(0, 30)));
  }

  // ---------- 2. 对照：行尾是普通空格 ----------
  await clearSel();
  const s1 = await findRow('SPAA');
  const s2 = await findRow('SPAB');
  if (s1 >= 0) {
    await dragRows(s1, s2);
    const text2 = await selected();
    check('普通空格填充：两行还是两行', text2.split('\n').length === 2,
      `lines=${text2.split('\n').length}`);
    check('普通空格填充：行尾干净', text2 === 'SPAA\nSPAB', JSON.stringify(text2));
  }

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
