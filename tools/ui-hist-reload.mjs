/*
 * "从历史打开一个窗格 → 敲几行 → 刷新页面" 的回归。
 *
 * 用户报的现象：从历史记录打开的工作区，关掉网页重新打开之后，上面的历史
 * 内容又消失了，只剩接手之后敲的那点东西。
 *
 * 原因：布局里只存 sid，历史那一段内容从来没进过服务端的回放缓冲 —— 回放
 * 只装了"这条会话自己产生过的输出"。刷新之后前端拿到的是干净的一屏，上面
 * 的历史自然没了。
 *
 * 这份脚本照顺序走一遍，验四件事：
 *   - 刷新之后老记录的内容还在（而且排在分界线上面）
 *   - 刷新之后接手后敲的内容也在
 *   - 两边不重不漏，分界线只出现一次
 *   - 刷新之后还能继续敲，敲的内容写进同一条记录
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-histreload';
const PROFILE = ROOT + '\\.build\\edge-histreload';
const PORT = 18172;
const DBG = 9368;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = 'echo SEED_RELOAD_A1';
const AFTER = 'echo AFTER_RESUME_B2';
const LIVE = 'echo LIVE_AFTER_RELOAD_C3';
const DIV = '── 以上是历史记录 ──';

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

// 飞牛上跑的是 bash，这里也尽量用 bash 测：Windows 自带的 PowerShell 在
// 被接手之后会用"绝对行号定位"的方式重画提示符，跑到哪一行就盖掉哪一行，
// 分界线经常被盖没 —— 那是 PowerShell 的脾气，不是这套逻辑的问题。
const BASH = process.env.TS_SHELL || (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '');
const shellArgs = BASH ? ['--shell', BASH] : [];
if (!BASH) console.log('（没找到 bash，退回默认 shell：分界线相关的断言可能被 PowerShell 重画覆盖）');

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'].concat(shellArgs), { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,820', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

const logDir = DATA + '\\history';
const readLog = (id) => {
  try { return fs.readFileSync(logDir + '\\' + id + '.log', 'utf8'); } catch (e) { return ''; }
};

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
    for (const ch of cmd) { await type(page, ch); await sleep(35); }
    await sleep(200);
    await type(page, '\r');
  };

  // 整屏文字：从 scrollback 第一行读到最后一行 —— 历史在上面，只读可视区
  // 会漏掉刚滚出去的那几行。
  const termText = (page) => page.evaluate(() => {
    const app = window.__ts.app;
    const p = app.activeTab() && app.activeTab().activePane();
    if (!p || !p.session || !p.session.term) return '';
    const term = p.session.term;
    const b = term.buffer.active;
    const out = [];
    for (let y = 0; y < b.length; y++) {
      const l = b.getLine(y);
      out.push(l ? l.translateToString(true) : '');
    }
    return out.join('\n');
  });

  const items = (page) => page.evaluate(async () => {
    const r = await fetch('api/history');
    const j = await r.json();
    return (j && j.ok && j.data && j.data.items) || [];
  });

  const waitFor = async (page, needle, ms = 9000) => {
    const t0 = Date.now();
    let s = '';
    while (Date.now() - t0 < ms) {
      s = await termText(page);
      if (s.indexOf(needle) >= 0) return s;
      await sleep(200);
    }
    return s;
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
  const list = await items(page);
  const id = list[0] && list[0].id;
  check('先有一条记录', list.length === 1 && !!id, `items=${list.length}`);

  // ---------- 2. 结束它，变成可点开的旧记录 ----------
  await killActiveTab(page);
  check('记录已结束', !(await items(page))[0].live);

  // ---------- 3. 从历史点开，再敲一条命令 ----------
  await page.evaluate(() => {
    const app = window.__ts.app;
    app.closeHistoryPanel();
    app.openHistoryPanel();
  });
  await sleep(900);
  await page.click('.hist-item');
  await sleep(2000);
  let shown = await waitFor(page, SEED);
  check('从历史打开时老内容在', shown.indexOf(SEED) >= 0, JSON.stringify(shown.slice(-120)));

  await typeCharByChar(page, AFTER);
  await sleep(1500);
  shown = await waitFor(page, 'AFTER_RESUME_B2');
  check('接手后敲的命令在屏幕上', shown.indexOf('AFTER_RESUME_B2') >= 0);

  // ---------- 4. 刷新页面 ----------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3200);
  shown = await waitFor(page, 'AFTER_RESUME_B2', 12000);

  check('刷新之后老内容还在', shown.indexOf(SEED) >= 0,
    JSON.stringify(shown.slice(-200)));
  check('刷新之后接手后敲的内容还在', shown.indexOf('AFTER_RESUME_B2') >= 0,
    JSON.stringify(shown.slice(-200)));
  const divAt = shown.indexOf(DIV);
  check('分界线在屏幕上', divAt >= 0);
  check('老内容排在分界线上方',
    divAt > 0 && shown.indexOf(SEED) < divAt,
    `div=${divAt} seed=${shown.indexOf(SEED)}`);
  check('接手的内容排在分界线下方',
    divAt >= 0 && shown.indexOf(AFTER, divAt) > divAt,
    `div=${divAt} after=${shown.indexOf(AFTER)}`);
  check('分界线只有一条', shown.split(DIV).length - 1 === 1,
    `count=${shown.split(DIV).length - 1}`);

  // ---------- 5. 刷新之后还能继续用 ----------
  await typeCharByChar(page, LIVE);
  await sleep(1600);
  shown = await waitFor(page, 'LIVE_AFTER_RELOAD_C3');
  check('刷新之后敲的命令有回显', shown.indexOf('LIVE_AFTER_RELOAD_C3') >= 0,
    JSON.stringify(shown.slice(-200)));
  const body = readLog(id);
  check('刷新之后敲的命令进了同一条记录', body.indexOf('LIVE_AFTER_RELOAD_C3') >= 0,
    JSON.stringify(body.slice(-160)));
  check('仍然只有一条记录', (await items(page)).length === 1);

  // ---------- 6. 上下文确实接上了（不只是一个画上去的假提示符）----------
  await typeCharByChar(page, 'echo CTX_$((6*7))');
  await sleep(1400);
  shown = await waitFor(page, 'CTX_42');
  check('shell 上下文是活的', shown.indexOf('CTX_42') >= 0,
    JSON.stringify(shown.slice(-160)));

  await page.close();
  await sleep(300);
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e && e.message); process.exit(1); });
