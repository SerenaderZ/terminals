/*
 * 重连回放 / 全屏程序退出的回归。
 *
 * 1) 重连不能叠屏：同一个窗格断线重连，服务端会把整段回放重新灌一遍。
 *    如果客户端不先清屏，旧画面会和回放叠在一起，出现重影和错行。
 *
 * 2) 全屏程序（claude / vim / htop）退出后，主屏必须干净：备用屏幕里画的
 *    东西全部丢弃、横线长度必须正好等于列数（短一截或者折行都是 PTY 尺寸
 *    和 xterm 不一致的症状），收尾信息要落在横线下面。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-replay';
const PROFILE = ROOT + '\\.build\\edge-replay';
const PORT = 18138;
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

const bufText = (page) => page.evaluate(() => {
  const b = window.__ts.app.activePane().session.term.buffer.active;
  let t = '';
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    if (l) t += l.translateToString(true) + '\n';
  }
  return t;
});

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // ---------- 1. 真实输出 + 强制重连，屏幕不能被回放叠一遍 ----------
  await page.keyboard.type('echo REPLAY_MARKER_ONE');
  await page.keyboard.press('Enter');
  await sleep(1500);

  const before = await bufText(page);
  const beforeCount = before.split('REPLAY_MARKER_ONE').length - 1;
  check('命令回显与输出都在屏幕上', beforeCount >= 2, `出现 ${beforeCount} 次`);

  await page.evaluate(() => window.__ts.app.activePane().session.retryNow());
  await sleep(3000);

  const after = await bufText(page);
  const afterCount = after.split('REPLAY_MARKER_ONE').length - 1;
  check('重连后回放不叠屏', afterCount === beforeCount, `${beforeCount} → ${afterCount} 次`);
  check('重连后内容仍完整', after.includes('REPLAY_MARKER_ONE'));

  // ---------- 2. 全屏程序退出：主屏干净、横线宽度正确 ----------
  const tui = await page.evaluate(async () => {
    const s = window.__ts.app.activePane().session;
    const t = s.term;
    const cols = t.cols;

    t.write('\x1b[?1049h\x1b[H\x1b[2J');
    t.write('TUI_SCREEN_LINE\r\n');
    t.write('TUI_BOTTOM_LINE\r\n');
    await new Promise((r) => setTimeout(r, 120));
    t.write('\x1b[?1049l');
    t.write('\r\n' + '\u2500'.repeat(cols) + '\r\n');
    t.write('Resume this session with:\r\n');
    t.write('claude --resume deadbeef\r\n');
    return { cols };
  });
  await sleep(900);

  const state = await page.evaluate(() => {
    const t = window.__ts.app.activePane().session.term;
    const b = t.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      lines.push(l ? l.translateToString(true) : '');
    }
    return { type: b.type, cols: t.cols, lines };
  });

  check('退出全屏程序后回到主屏', state.type === 'normal', `buffer=${state.type}`);

  const altLeft = state.lines.some((l) => l.includes('TUI_SCREEN_LINE') || l.includes('TUI_BOTTOM_LINE'));
  check('备用屏幕的内容没有漏到主屏', !altLeft);

  const rule = state.lines.find((l) => l.trim() && /^\u2500+$/.test(l.trim()));
  const ruleLen = rule ? rule.trim().length : 0;
  check('分隔线长度等于终端列数', ruleLen === state.cols || ruleLen === tui.cols,
    `线长=${ruleLen} term=${state.cols} 写入时=${tui.cols}`);

  const ruleIdx = state.lines.findIndex((l) => l.trim() && /^\u2500+$/.test(l.trim()));
  const resumeIdx = state.lines.findIndex((l) => l.includes('Resume this session with:'));
  check('收尾信息落在分隔线之后', ruleIdx >= 0 && resumeIdx > ruleIdx, `线=${ruleIdx} 收尾=${resumeIdx}`);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
