/*
 * 历史记录的回归。
 *
 * 用户要的是一份像浏览器历史页的东西，但有几条他自己的规矩：
 *   - 名字取"我输入的第一条命令"，不是终端/程序随手设的标题
 *   - 只是打开一个窗口、什么都没敲，不该留下记录
 *   - 点开一条老记录继续用，后面敲的命令要回到那一条里，不能多出一行
 *   - 时间以"最后关闭这个窗口"为准
 *
 * 这里按顺序验：
 *   1. 空白标签（没敲过任何东西）不进历史
 *   2. 敲下第一条命令才出现记录，标题就是那条命令
 *   3. 日志落盘、字节数、工作目录、运行中标记
 *   4. 面板能列出、能按命令名搜
 *   4.5 还在跑的那条点不开（两条会话往同一个日志里写，回看会交错）
 *   5. 点一条 → 新标签 → 历史铺出来、shell 能接着用
 *   6. 继续敲命令 → 还是同一条记录（数量不变、字节数增长、标题不变）
 *   7. 关掉那个窗口 → 结束时间记上，并按新时间排到前面
 *   8. 删除单条 → 接口 404；清空 → 列表空
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-history';
const PROFILE = ROOT + '\\.build\\edge-history';
const PORT = 18150;
const DBG = 9356;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARK = 'HISTORY_MARKER_ALPHA_42';
const CMD1 = 'echo ' + MARK;
const CMD2 = 'echo ALIVE_' + MARK;
const CMD3 = 'echo THIRD_' + MARK;

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

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.setViewport({ width: 1100, height: 780 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  // tabIndex 缺省 = 最后一个标签
  const termText = (tabIndex) => page.evaluate((i) => {
    const app = window.__ts.app;
    const t = app.tabs[i == null ? app.tabs.length - 1 : i];
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
  }, tabIndex);

  const apiList = () => page.evaluate(async () => {
    const r = await fetch('api/history');
    return r.json();
  });

  const items = async () => {
    const j = await apiList();
    return (j && j.ok && j.data && j.data.items) || [];
  };

  const type = (cmd) => page.evaluate((c) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(c));
  }, cmd);

  const newTab = () => page.evaluate(() => {
    const app = window.__ts.app;
    app.newTab(true);
    return app.tabs.length;
  });

  // ---------- 1. 什么都没敲的窗口不进历史 ----------
  let list = await items();
  check('启动后没有任何记录', list.length === 0, `items=${list.length}`);

  const tabs0 = await newTab();
  await sleep(1500);
  list = await items();
  check('只开一个窗口不产生记录', list.length === 0, `items=${list.length} tabs=${tabs0}`);

  // ---------- 2. 第一条命令决定名字 ----------
  await type(CMD1 + '\r');
  await sleep(1200);
  check('会话里有标记输出', (await termText()).indexOf(MARK) >= 0);

  list = await items();
  check('敲下命令后才有记录', list.length === 1, `items=${list.length}`);
  const rec = list[0] || {};
  check('标题就是第一条命令', rec.title === CMD1, JSON.stringify(rec.title));
  check('记录带上了字节数', rec.bytes > 0, `bytes=${rec.bytes}`);
  check('记录带上了工作目录', !!rec.cwd, rec.cwd || '(空)');
  check('还在跑的记录标成运行中', rec.live === true && !rec.ended,
    `live=${rec.live} ended=${rec.ended}`);

  const logProbe = await page.evaluate(async (id) => {
    const r = await fetch('api/history/' + encodeURIComponent(id) + '/log');
    const t = await r.text();
    return { status: r.status, len: t.length, off: r.headers.get('X-History-Offset'), total: r.headers.get('X-History-Total') };
  }, rec.id);
  check('日志接口能拿到内容', logProbe.status === 200 && logProbe.len > 0,
    JSON.stringify(logProbe));

  const logHas = (id, needle) => page.evaluate(async (a) => {
    const r = await fetch('api/history/' + encodeURIComponent(a.id) + '/log');
    const t = await r.text();
    return t.indexOf(a.needle) >= 0;
  }, { id, needle });

  check('日志里有第一条命令的输出', await logHas(rec.id, MARK));

  // ---------- 3. 面板 ----------
  await page.click('#btn-history');
  await sleep(700);
  let rows = await page.$$eval('.hist-item', (els) => els.length);
  const rowTitle = await page.$eval('.hist-item .hist-title', (e) => e.textContent);
  check('面板列出历史条目', rows === 1, `rows=${rows}`);
  check('列表里显示的是命令名', rowTitle === CMD1, JSON.stringify(rowTitle));

  await page.click('#hist-search');
  await page.type('#hist-search', 'zzz-no-such-thing');
  await sleep(300);
  rows = await page.$$eval('.hist-item', (els) => els.length);
  const emptyText = await page.$eval('#hist-list', (e) => e.textContent);
  check('搜不到时给空状态', rows === 0 && /没有匹配/.test(emptyText), emptyText.slice(0, 30));

  await page.evaluate(() => {
    const s = document.getElementById('hist-search');
    s.value = 'echo HISTORY';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(250);
  rows = await page.$$eval('.hist-item', (els) => els.length);
  check('能按命令名搜到', rows === 1, `rows=${rows}`);

  await page.evaluate(() => {
    const s = document.getElementById('hist-search');
    s.value = '';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(250);

  // 运行中的记录点不开：两条会话往同一个日志里写，回看时输出会交错。
  const busyClass = await page.$eval('.hist-item', (e) => e.className);
  check('运行中的行标成不可点', /\bbusy\b/.test(busyClass), busyClass);
  const tabsBeforeBusy = await page.evaluate(() => window.__ts.app.tabs.length);
  await page.click('.hist-item');
  await sleep(700);
  const tabsAfterBusy = await page.evaluate(() => window.__ts.app.tabs.length);
  const busyBanner = await page.$eval('#banner', (e) => (e.hidden ? '' : e.textContent));
  check('点运行中的记录不会新开标签', tabsAfterBusy === tabsBeforeBusy,
    `${tabsBeforeBusy} → ${tabsAfterBusy}`);
  check('点运行中的记录给出说明', /还在运行/.test(busyBanner), JSON.stringify(busyBanner));

  // ---------- 4. 先关掉这个窗口：时间以关闭为准 ----------
  const firstEndedProbe = async () => {
    const l = await items();
    return l.length === 1 ? l[0] : null;
  };

  await page.evaluate(() => {
    const app = window.__ts.app;
    const t = app.tabs[app.tabs.length - 1];
    app.killPane(t.activePane());
  });
  let closed = null;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const e = await firstEndedProbe();
    if (e && e.ended > 0) { closed = e; break; }
  }
  check('关掉窗口后记下结束时间', !!closed && closed.ended > 0,
    closed ? `ended=${closed.ended}` : '没等到');
  check('关掉之后不再是运行中', !!closed && !closed.live, `live=${closed && closed.live}`);
  check('列表时间用的是关闭时间', !!closed && closed.ended >= closed.touched,
    closed ? `ended=${closed.ended} touched=${closed.touched}` : '');

  // ---------- 5. 点开一条：历史铺出来、shell 能接着用 ----------
  if (await page.$eval('#hist-panel', (e) => e.hidden)) {
    await page.click('#btn-history');
    await sleep(700);
  }
  // 面板是打开状态下关掉那个窗口的，重新开一次让列表刷新回来。
  await page.evaluate(() => {
    const app = window.__ts.app;
    app.closeHistoryPanel();
    app.openHistoryPanel();
  });
  await sleep(800);
  const idleClass = await page.$eval('.hist-item', (e) => e.className);
  check('关掉之后这一行恢复可点', !/\bbusy\b/.test(idleClass), idleClass);
  const beforeTabs = await page.evaluate(() => window.__ts.app.tabs.length);
  await page.click('.hist-item');
  await sleep(1400);
  const afterTabs = await page.evaluate(() => window.__ts.app.tabs.length);
  check('点一条会新开一个标签', afterTabs === beforeTabs + 1, `${beforeTabs} → ${afterTabs}`);

  let restored = '';
  for (let i = 0; i < 40; i++) {
    restored = await termText(afterTabs - 1);
    if (restored.indexOf(MARK) >= 0) break;
    await sleep(200);
  }
  check('新标签里回放出了历史输出', restored.indexOf(MARK) >= 0,
    JSON.stringify(restored.slice(0, 120)));

  // ---------- 6. 继续敲：还是同一条记录 ----------
  await type(CMD2 + '\r');
  await sleep(1400);
  const after = await termText(afterTabs - 1);
  check('回放之后 shell 能继续执行命令', after.indexOf('ALIVE_' + MARK) >= 0,
    JSON.stringify(after.slice(-160)));

  list = await items();
  const same = list.length === 1 ? list[0] : {};
  check('继续使用不会多出一行', list.length === 1, `items=${list.length}`);
  check('还是同一条记录（id 不变）', same.id === rec.id, `${rec.id} → ${same.id}`);
  check('标题没有被后来的命令改掉', same.title === CMD1, JSON.stringify(same.title));
  check('新命令写进了同一条日志', (same.bytes || 0) > (rec.bytes || 0),
    `${rec.bytes} → ${same.bytes}`);
  check('日志里两段都在', (await logHas(rec.id, MARK)) && (await logHas(rec.id, 'ALIVE_' + MARK)));

  await page.evaluate(() => {
    const app = window.__ts.app;
    const t = app.tabs[app.tabs.length - 1];
    app.killPane(t.activePane());
  });
  let again = null;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const e = await firstEndedProbe();
    if (e && e.ended > (closed ? closed.ended : 0)) { again = e; break; }
  }
  check('再次关闭会把时间往后推', !!again, again ? `ended=${again.ended}` : '没等到');
  check('两次使用仍然只有一条记录', (await items()).length === 1);

  // ---------- 7. 删除单条 ----------
  if (await page.$eval('#hist-panel', (e) => e.hidden)) {
    await page.click('#btn-history');
    await sleep(600);
  }
  const targetId = await page.$eval('.hist-item', (e) => e.dataset.id);
  await page.click('.hist-item .hist-del');
  await sleep(700);
  check('删除一条后数量归零', (await items()).length === 0);
  const goneStatus = await page.evaluate(async (id) => {
    const r = await fetch('api/history/' + encodeURIComponent(id));
    return r.status;
  }, targetId);
  check('被删的那条接口 404', goneStatus === 404, `status=${goneStatus}`);

  // ---------- 8. 清空 ----------
  await newTab();
  await sleep(800);
  await type(CMD1 + '\r');
  await sleep(1200);
  check('新窗口里的命令又能记下一条', (await items()).length === 1);
  if (await page.$eval('#hist-panel', (e) => e.hidden)) {
    await page.click('#btn-history');
    await sleep(600);
  }
  await page.click('#hist-clear');
  await sleep(500);
  await page.click('#cf-ok');
  await sleep(900);

  const cleared = (await items()).length;
  check('清空后接口为空', cleared === 0, `items=${cleared}`);
  const emptyPanel = await page.$eval('#hist-list', (e) => e.textContent);
  check('清空后列表给空状态', /还没有历史记录/.test(emptyPanel), emptyPanel.slice(0, 30));

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
