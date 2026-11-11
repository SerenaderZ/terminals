/*
 * 复制一块空白（一个空行）也该有结果。
 *
 * 用户的说法：Windows 终端里把空行选中复制，粘出去就是一个换行，希望这里
 * 也一样。之前的实现把每行的行尾空白裁掉、末尾再裁一次，整块空白选区就
 * 裁成了空串 —— 上层见到空串就当"没选中"：右键落到粘贴、松手后选区当场
 * 被收掉，"复制空行"这个动作完全不存在。
 *
 * 现在按行数给换行：N 行给 N-1 个，只选一行也给一个。
 *
 * 造数据用 node 写 UTF-8，不用 PowerShell（代码页会把 NBSP 变 '?'）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-blank';
const PROFILE = ROOT + '\\.build\\edge-blank';
const GEN = ROOT + '\\.build\\blankgen.js';
const PORT = 18194;
const DBG = 9394;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 两行内容 + 后面四行纯空白
fs.writeFileSync(GEN, [
  "const pad = '\\u00a0'.repeat(120);",
  "process.stdout.write('AAA' + pad + '\\r\\n');",
  "process.stdout.write('\\r\\n');",
  "process.stdout.write('BBB' + pad + '\\r\\n');",
  "process.stdout.write('\\r\\n'.repeat(4));",
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
    await sleep(350);
  };

  const sel = () => page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return { text: s.selectionText(), hasRange: !!s.selRange, hasSnap: !!s.selSnap };
  });
  const clearSel = () => page.evaluate(() => window.__ts.app.activePane().session.clearSelection());
  const bannerText = () => page.evaluate(() => {
    const b = document.querySelector('#banner, .banner');
    return b ? b.textContent.trim() : '';
  });

  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);
  await send(`node ${GEN}\r`);
  await sleep(2000);

  const a = await findRow('AAA');
  const b = await findRow('BBB');
  check('两行内容 + 空白行都在屏幕上', a >= 0 && b === a + 2, `rows=${a},${b}`);

  if (a >= 0 && b === a + 2) {
    // ---------- 1. 选两行空白 → 一个换行 ----------
    await dragRows(b + 1, b + 2);
    const s1 = await sel();
    check('两行空白：取出来是一个换行', s1.text === '\n', JSON.stringify(s1.text));
    check('两行空白：选区没被当场收掉', s1.hasRange && s1.hasSnap);

    // ---------- 2. 选三行空白 → 两个换行 ----------
    await clearSel();
    await dragRows(b + 1, b + 3);
    const s2 = await sel();
    check('三行空白：取出来是两个换行', s2.text === '\n\n', JSON.stringify(s2.text));

    // ---------- 3. 只选一行空白 → 也留一个 ----------
    await clearSel();
    await dragRows(b + 1, b + 1);
    const s3 = await sel();
    check('一行空白：也留一个换行', s3.text === '\n', JSON.stringify(s3.text));

    // ---------- 4. 右键 = 复制（不是粘贴） ----------
    await clearSel();
    await dragRows(b + 1, b + 2);
    const g = await page.evaluate((row) => {
      const p = window.__ts.app.activePane();
      const m = p.session.cellMetrics();
      const box = p.host.getBoundingClientRect();
      const vp = p.session.term.buffer.active.viewportY;
      return {
        x: box.left + m.left + 60,
        y: box.top + m.top + (row - vp) * m.h + m.h / 2,
      };
    }, b + 1);
    await page.evaluate(() => { window.__copied.length = 0; });
    await page.mouse.click(g.x, g.y, { button: 'right' });
    await sleep(400);
    const copied = await page.evaluate(() => (window.__copied || []).slice(-1)[0]);
    check('右键空白选区：复制到的是换行', copied === '\n', JSON.stringify(copied));
    check('右键之后选区被收掉（下一次右键是粘贴）', !(await sel()).hasRange);
    const bt = await bannerText();
    check('提示说的是空行，不是"N 个字符"', /空行/.test(bt), JSON.stringify(bt));
  }

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
