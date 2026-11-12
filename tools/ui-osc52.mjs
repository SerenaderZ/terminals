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
  // 先等过"拖选回声"窗口：这一段测的是与拖选无关的程序复制。
  await sleep(2200);
  await send(`node ${GEN_OSC}\r`);
  await sleep(1800);
  const osc = await copied();
  check('OSC 52：文本进了剪贴板', osc === 'OSC-AAA\nOSC-中文', JSON.stringify(osc));
  const receipt = await page.evaluate(() => document.getElementById('banner').textContent);
  check('OSC 52 回执：字符数与换行数如实报出',
    /程序发来的 2 行（14 个字符）已写入剪贴板/.test(receipt), JSON.stringify(receipt));

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

  // ---------- 5. 拖选之后程序的"回放"必须被吞掉 ----------
  // 程序收到鼠标报告就会自己发一条 OSC 52，内容只含它渲染的那 3 行文字，
  // 用户框进去的上下空行不在里面。这条序列是程序在回放这次拖选，
  // **不能写剪贴板**：写了就等于拖选变静默自动复制，而且它可能正好落在
  // 用户"再点一下想取消"的按下与松开之间，屏幕上就冒出一条"复制成功"。
  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);
  await send(`node ${GEN_LINES}\r`);
  await sleep(2200);
  const r5 = await findRow('L1-COPY');
  check('新标签里三行内容在屏幕上', r5 >= 0, `row=${r5}`);
  if (r5 >= 0) {
    // 先放一个可辨认的基线，用来区分"剪贴板没动"和"写了别的东西"。
    const mid5 = await page.evaluate(() => {
      const box = window.__ts.app.activePane().host.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.evaluate(() => window.__ts.app.activePane().session.copyText('BASELINE'));
    const beforeEcho = await page.evaluate(() => (window.__copied || []).length);

    await dragRows(r5, r5 + 4);
    const picked = await plain();
    check('用户框了 5 行', picked.split('\n').length === 5, JSON.stringify(picked));
    // banner 里可能还挂着上一条消息，只能比"这条回放前后有没有变"。
    const recBefore = await page.evaluate(() => document.getElementById('banner').textContent);

    const short = 'L1-COPY\nL2-COPY\nL3-COPY';   // 程序只交出 3 行
    await page.evaluate((p) => {
      window.__ts.app.activePane().session.term.write('\x1b]52;c;' + p + '\x07');
    }, Buffer.from(short, 'utf8').toString('base64'));
    await sleep(400);
    const afterEcho = await page.evaluate(() => (window.__copied || []).length);
    check('拖选后的 OSC 52 回放不写剪贴板',
      afterEcho === beforeEcho, `${beforeEcho} → ${afterEcho}`);
    const rec5 = await page.evaluate(() => document.getElementById('banner').textContent);
    check('拖选后不弹"已写入剪贴板"回执',
      rec5 === recBefore, JSON.stringify(rec5));
    check('拖选之外的东西没被写进剪贴板（还是基线）',
      (await copied()) === 'BASELINE', JSON.stringify(await copied()));

    // 真正拿走内容仍然只有一条路：右键（有选区 → 复制）。
    await page.mouse.click(mid5.x, mid5.y, { button: 'right' });
    await sleep(500);
    check('右键复制拿到的仍是用户框的 5 行',
      (await copied()) === picked, JSON.stringify(await copied()));
  }

  // ---------- 6. 回声窗口过去之后，程序发起的复制照常生效 ----------
  // 拖选只是拖选；过了这个窗口，vim / tmux / ssh 插件的主动复制不能被误吞。
  await page.evaluate(() => window.__ts.app.activePane().session.clearSelection());
  await sleep(2200);
  await send(`node ${GEN_OSC}\r`);
  await sleep(1600);
  const osc6 = await copied();
  check('回声窗口之后 OSC 52 照常生效', osc6 === 'OSC-AAA\nOSC-中文', JSON.stringify(osc6));

  // ---------- 7. "拖选 → 再点一下想取消"不能变成偷偷复制 ----------
  // 这条按用户的实际操作走：框住 5 行，然后按下左键想取消。程序是先收到
  // 按下才发现鼠标还在自己那块区域，回放的 OSC 52 可能就落在按下与松开
  // 之间。此时剪贴板必须原样不动，屏幕上也不能冒出"复制成功"。
  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);
  await send(`node ${GEN_LINES}\r`);
  await sleep(2200);
  const r7 = await findRow('L1-COPY');
  check('取消用例：三行内容在屏幕上', r7 >= 0, `row=${r7}`);
  if (r7 >= 0) {
    const mid7 = await page.evaluate(() => {
      const box = window.__ts.app.activePane().host.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.evaluate(() => window.__ts.app.activePane().session.copyText('BASELINE-2'));
    await dragRows(r7, r7 + 4);
    const cnt = await page.evaluate(() => (window.__copied || []).length);
    const recBefore = await page.evaluate(() => document.getElementById('banner').textContent);

    // 按下左键（本意是取消），回放在这一刻到达
    await page.mouse.move(mid7.x, mid7.y);
    await page.mouse.down();
    await page.evaluate((p) => {
      window.__ts.app.activePane().session.term.write('\x1b]52;c;' + p + '\x07');
    }, Buffer.from('L1-COPY\nL2-COPY\nL3-COPY', 'utf8').toString('base64'));
    await sleep(150);
    await page.mouse.up();
    await sleep(400);

    const cntAfter = await page.evaluate(() => (window.__copied || []).length);
    check('取消后剪贴板没有被写', cntAfter === cnt, `${cnt} → ${cntAfter}`);
    const sel7 = await page.evaluate(() => {
      const s = window.__ts.app.activePane().session;
      return { range: !!s.selRange, snap: !!s.selSnap };
    });
    check('取消后选区已清空', sel7.range === false && sel7.snap === false, JSON.stringify(sel7));
    const rec7 = await page.evaluate(() => document.getElementById('banner').textContent);
    check('取消后不冒出新回执',
      rec7 === recBefore, JSON.stringify(rec7));
  }

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
