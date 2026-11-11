/*
 * "从历史打开 → 敲几下 → 直接关掉整个窗口 → 再打开" 的回归。
 *
 * 用户报的现象（按他的顺序）：
 *   1. 从历史点开一条记录，敲了几个空回车和一条无效命令
 *   2. 不结束会话，直接点窗口右上角的 ×（整个网页关掉）
 *   3. 再打开：右上角灯一直是黄色"连接中"，但命令还能敲
 *   4. 再敲的新内容没有进历史；关掉标签再从历史打开，那几条也没了
 *
 * 这里就照着走一遍，验四件事：
 *   - 接手之后敲的东西（包括空回车）都进同一条日志
 *   - 重开之后状态灯必须是"已连接"
 *   - 重开之后敲的东西仍然写进同一条日志
 *   - 关掉标签、再从历史点开，能看到刚才敲的内容
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-histreopen';
const PROFILE = ROOT + '\\.build\\edge-histreopen';
const PORT = 18171;
const DBG = 9367;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = 'echo SEED_HIST_7F3';
const BAD = 'sb';

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
  '--window-size=1200,820', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

const logDir = DATA + '\\history';
const readLog = (id) => {
  try { return fs.readFileSync(logDir + '\\' + id + '.log', 'utf8'); } catch (e) { return ''; }
};
// 提示符的样子随平台变（PS C:\...> / eason@host:~$），只数行尾那个标记。
const promptCount = (s) => (s.match(/(PS [A-Za-z]:[^>\r\n]*>|[$#] )/g) || []).length;

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();

  const open = async () => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await p.setCacheEnabled(false);
    await p.setViewport({ width: 1100, height: 780 });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(2600);
    return p;
  };

  const type = (page, s) => page.evaluate((c) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(c));
  }, s);

  const typeCharByChar = async (page, cmd) => {
    for (const ch of cmd) { await type(page, ch); await sleep(40); }
    await sleep(250);
    await type(page, '\r');
  };

  const status = (page) => page.evaluate(() => ({
    text: document.getElementById('statustext').textContent,
    led: document.getElementById('led').className,
    panes: Array.from(document.querySelectorAll('.pane')).map((e) => e.dataset.state),
  }));

  const termText = (page, i) => page.evaluate((idx) => {
    const app = window.__ts.app;
    const t = app.tabs[idx == null ? app.tabs.length - 1 : idx];
    const p = t && t.activePane();
    if (!p || !p.session || !p.session.term) return '';
    const term = p.session.term;
    const b = term.buffer.active;
    const out = [];
    for (let y = 0; y < term.rows; y++) {
      const l = b.getLine(b.viewportY + y);
      out.push(l ? l.translateToString(true) : '');
    }
    return out.join('\n');
  }, i);

  const items = (page) => page.evaluate(async () => {
    const r = await fetch('api/history');
    const j = await r.json();
    return (j && j.ok && j.data && j.data.items) || [];
  });

  const openHistory = async (page) => {
    await page.evaluate(() => {
      const app = window.__ts.app;
      app.closeHistoryPanel();
      app.openHistoryPanel();
    });
    await sleep(900);
  };

  const killActiveTab = async (page) => {
    await page.evaluate(() => {
      const app = window.__ts.app;
      app.killPane(app.tabs[app.tabs.length - 1].activePane());
    });
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const l = await items(page);
      if (l[0] && !l[0].live) break;
    }
  };

  // ---------- 1. 造一条历史 ----------
  let page = await open();
  await type(page, SEED + '\r');
  await sleep(1400);
  let list = await items(page);
  check('先有一条记录', list.length === 1, `items=${list.length}`);
  const id = list[0] && list[0].id;
  check('日志落盘了', !!id && readLog(id).indexOf('SEED_HIST_7F3') >= 0);

  // ---------- 2. 关掉这个标签，让它变成"可点开的旧记录" ----------
  await killActiveTab(page);
  list = await items(page);
  check('记录变成已结束', !!list[0] && !list[0].live, `live=${list[0] && list[0].live}`);

  // ---------- 3. 从历史点开，敲空回车 + 一条无效命令 ----------
  await openHistory(page);
  await page.click('.hist-item');
  await sleep(1800);
  check('从历史开出了新标签', await page.evaluate(() => window.__ts.app.tabs.length) === 2);

  const beforeTyping = readLog(id);
  for (let i = 0; i < 3; i++) { await type(page, '\r'); await sleep(220); }
  await typeCharByChar(page, BAD);
  await sleep(1200);

  let body = readLog(id);
  let delta = body.slice(beforeTyping.length);
  check('接手后敲的空回车有落盘', promptCount(delta) >= 4,
    `新增提示符 ${promptCount(delta)} 个，delta=${JSON.stringify(delta.slice(0, 120))}`);
  check('接手后敲的无效命令有落盘', delta.indexOf(BAD) >= 0,
    JSON.stringify(delta.slice(-120)));

  // ---------- 4. 直接关掉整个页面（不结束会话） ----------
  await page.close();
  await sleep(1500);

  // ---------- 5. 重新打开 ----------
  page = await open();
  const st = await status(page);
  check('重开之后是"已连接"', st.text === '已连接', JSON.stringify(st));
  check('灯不是黄色', !/connecting/.test(st.led), st.led);
  check('接回了原来的标签', await page.evaluate(() => window.__ts.app.tabs.length) === 2,
    `tabs=${await page.evaluate(() => window.__ts.app.tabs.length)}`);

  const afterReopen = readLog(id);
  check('重开没有把日志弄丢', afterReopen.indexOf(BAD) >= 0 && afterReopen.length >= body.length,
    `${body.length} → ${afterReopen.length}`);

  await typeCharByChar(page, 'echo AFTER_REOPEN_9C1');
  await sleep(1400);
  body = readLog(id);
  check('重开之后敲的命令写进了同一条记录', body.indexOf('AFTER_REOPEN_9C1') >= 0,
    JSON.stringify(body.slice(-160)));
  list = await items(page);
  check('仍然只有一条记录', list.length === 1, `items=${list.length}`);
  check('id 没变', list[0] && list[0].id === id, `${id} → ${list[0] && list[0].id}`);

  // ---------- 6. 关掉标签，再从历史点开：刚才的东西都在 ----------
  await killActiveTab(page);
  await openHistory(page);
  const rows = await page.$$eval('.hist-item', (els) => els.length);
  check('历史面板里只有一行', rows === 1, `rows=${rows}`);
  await page.click('.hist-item');
  await sleep(2000);

  let shown = '';
  for (let i = 0; i < 40; i++) {
    shown = await termText(page);
    if (shown.indexOf('AFTER_REOPEN_9C1') >= 0) break;
    await sleep(200);
  }
  check('回看到重开后敲的内容', shown.indexOf('AFTER_REOPEN_9C1') >= 0,
    JSON.stringify(shown.slice(-200)));
  check('回看到无效命令', shown.indexOf(BAD + ' ') >= 0 || shown.indexOf('>' + BAD) >= 0 ||
    shown.indexOf(BAD + '\n') >= 0, JSON.stringify(shown.slice(-240)));

  // 分界线之后是"这一次接手"的部分：三个空回车 + sb + echo 各一行提示符。
  const after = shown.split('── 以上是历史记录 ──')[0] || '';
  check('回看到刚才那几个空行', promptCount(after) >= 5,
    `提示符 ${promptCount(after)} 个`);

  await page.close();
  await sleep(300);
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.message); process.exit(1); });
