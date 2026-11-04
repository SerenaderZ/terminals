/*
 * 关掉网页再打开的回放回归。
 *
 * 这是用户反复反馈的那条路：关掉标签页、重新打开，屏幕上出现"上一次的残影
 * 叠着新内容"的乱字。根因是回放的字节流是在另一个列数下写的 —— 终端输出
 * 是字节流，同一段字节按 120 列和按 100 列解析出来是两幅不同的画面，
 * readline / Ink 那些靠 "\r + 光标移动"重画的字节落到错位置就是叠字。
 *
 * 这里验三件事：
 *   1. 同尺寸重开：照常回放，内容完整。
 *   2. 换尺寸重开：服务端标记 replaySkipped，不回放（让程序自己重画）。
 *   3. 两种情况下都不能出现替换字符/半截控制序列（那些是解析错位的痕迹）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-reopen';
const PROFILE = ROOT + '\\.build\\edge-reopen';
const PORT = 18163;
const DBG = 9359;
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
  '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

const dump = `(() => {
  const s = window.__ts.app.activePane().session;
  const t = s.term;
  const b = t.buffer.active;
  const out = [];
  for (let y = 0; y < t.rows; y++) { const l = b.getLine(b.viewportY + y); out.push(l ? l.translateToString(true) : ''); }
  return { cols: t.cols, rows: t.rows, lines: out, ready: s.lastReady || null };
})()`;

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();

  const open = async (w, h) => {
    const p = await ctx.newPage();
    await p.setCacheEnabled(false);
    await p.setViewport({ width: w, height: h });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    return p;
  };

  const MARK = 'TYPED_LINE_KEEP_ME';
  let page = await open(1300, 820);
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.send(1, new TextEncoder().encode('echo ' + 'TYPED_LINE_KEEP_ME ' + '一二三四五六七八九十'.repeat(6) + '\r'));
  });
  await sleep(1500);
  let d = await page.evaluate(dump);
  check('初次连接拿到了回放长度字段', !!d.ready && typeof d.ready.replayLen === 'number');
  const cols0 = d.cols;
  await page.close();
  await sleep(1200);

  // 1) 同尺寸重开：应该回放
  page = await open(1300, 820);
  await sleep(1600);
  d = await page.evaluate(dump);
  const text = d.lines.join('\n');
  check('同尺寸重开：列数一致', d.cols === cols0, `${cols0} → ${d.cols}`);
  check('同尺寸重开：服务端给了回放', !!d.ready && d.ready.replayLen > 0, `replayLen=${d.ready && d.ready.replayLen}`);
  check('同尺寸重开：内容完整', text.includes(MARK));
  check('同尺寸重开：没有解析错的痕迹', !/[\ufffd]|\[\d+m|\[m/.test(text));
  await page.close();
  await sleep(1000);

  // 2) 换尺寸重开：必须跳过回放（旧宽度的字节按新宽度解析就是叠字）
  page = await open(980, 690);
  await sleep(1800);
  d = await page.evaluate(dump);
  const text2 = d.lines.join('\n');
  check('换尺寸重开：列数变了', d.cols !== cols0, `${cols0} → ${d.cols}`);
  check('换尺寸重开：服务端跳过回放', !!d.ready && d.ready.replaySkipped === true && d.ready.replayLen === 0,
    `skipped=${d.ready && d.ready.replaySkipped} len=${d.ready && d.ready.replayLen}`);
  check('换尺寸重开：没有解析错的痕迹', !/[\ufffd]|\[\d+m|\[m/.test(text2));

  await page.close();
  await browser.disconnect();

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
