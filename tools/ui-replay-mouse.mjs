/*
 * 从历史记录打开新标签后，鼠标移动不能往 shell 里灌乱码。
 *
 * 用户报的现象：从历史打开一条会话，屏幕上不停冒出 "35;98;8M;35;99;8M;..."
 * 这样的东西，鼠标一动就多一段，而且和焦点在哪个标签无关。
 *
 * 那是 SGR 鼠标报告（\x1b[<35;x;yM）被 shell 当成键盘输入了。根子在于历史
 * 日志里留着程序当初发的 \x1b[?1003h（Claude Code 一进来就开鼠标追踪），
 * 回放原样重演，xterm 就把鼠标报告真的打开；可回放完接手的是刚起来的
 * bash，它根本不要这些报告。
 *
 * 验三件事：
 *   1) 回放带 ?1003h 的历史之后，终端的鼠标追踪状态是关的
 *   2) 之后鼠标在窗格上移动，PTY 一个字节都收不到
 *   3) 对照组：程序自己发 ?1003h 时鼠标报告照旧工作（别把正常功能挡掉）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-replaymouse';
const PROFILE = ROOT + '\\.build\\edge-replaymouse';
const PORT = 18195;
const DBG = 9395;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

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

  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);

  // 截下所有发往 PTY 的键盘输入
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    window.__sent = [];
    s.send = function (c, b) {
      if (c === 1) window.__sent.push(new TextDecoder().decode(b));
    };
  });

  // ---- 1. 回放一条"开了鼠标追踪"的历史 ----
  await page.evaluate(() => new Promise((res) => {
    const s = window.__ts.app.activePane().session;
    // 历史和真实日志一样：先清屏、开鼠标追踪、写两行、再进出备用屏
    const hist = '\x1b[2J\x1b[H\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h' +
      'HIST-ONE\r\nHIST-TWO\r\n';
    s.writeHistory(hist, res);
  }));
  await sleep(600);

  const mode = await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    const m = s.term.modes || {};
    return {
      mouse: m.mouseTrackingMode,
      paste: m.bracketedPasteMode,
      protocol: s.term._core && s.term._core.coreMouseService &&
        s.term._core.coreMouseService.activeProtocol,
    };
  });
  check('回放之后鼠标追踪是关的', mode.protocol === 'NONE' || mode.mouse === 'none',
    JSON.stringify(mode));
  check('回放之后 bracketed paste 也是关的', !mode.paste, String(mode.paste));

  // ---- 2. 鼠标在窗格上移动，PTY 不该收到任何东西 ----
  const box = await page.evaluate(() => {
    const p = window.__ts.app.activePane();
    const r = p.host.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + 60, w: r.width, h: r.height };
  });
  await page.evaluate(() => { window.__sent.length = 0; });
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(box.x + i * 12, box.y + i * 6);
    await sleep(60);
  }
  await sleep(400);
  const sent = await page.evaluate(() => window.__sent.slice());
  check('鼠标移动没有往 PTY 发东西', sent.length === 0, JSON.stringify(sent.slice(0, 2)));
  check('画面上也没有鼠标报告残留', await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    const b = s.term.buffer.active;
    let all = '';
    for (let y = Math.max(0, b.viewportY - 5); y < b.viewportY + s.term.rows; y++) {
      const l = b.getLine(y);
      if (l) all += l.translateToString(false) + '\n';
    }
    return /\d+;\d+;\d+M/.test(all);
  }) === false);

  // ---- 3. 对照：程序真的开追踪时，鼠标报告照常发 ----
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    // 不走回放，直接写协议序列 —— 模拟 Claude Code 启动时自己开的追踪
    s.term.write('\x1b[?1003h\x1b[?1006h');
  });
  await sleep(400);
  await page.evaluate(() => { window.__sent.length = 0; });
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(box.x + 30 + i * 10, box.y + 40 + i * 8);
    await sleep(60);
  }
  await sleep(400);
  const sent2 = await page.evaluate(() => window.__sent.slice());
  check('程序自己开追踪时鼠标报告照旧工作',
    sent2.some((t) => /\x1b\[<\d+;\d+;\d+M/.test(t)), JSON.stringify(sent2.slice(0, 2)));

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
