/*
 * 历史记录的回归。
 *
 * 用户要的是浏览器历史页那种东西：一个列表、能搜、能删、点一条能在
 * 新工作区里打开。打开不是只读回看 —— 上面是那一次会话的完整输出，
 * 下面接一个能继续敲的 shell。
 *
 * 这里按顺序验：
 *   1. 会话输出真的落进了历史（接口里能看到字节数）
 *   2. 面板能列出、能按关键词过滤
 *   3. 点一条 → 新标签 → 历史文字出现在终端里
 *   4. 那个新标签里的 shell 是活的，能执行命令
 *   5. 删除单条 → 从列表消失，接口返回 404
 *   6. 清空 → 列表空
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

  const type = (cmd) => page.evaluate((c) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(c));
  }, cmd);

  // ---------- 1. 会话输出落进历史 ----------
  await type('echo ' + MARK + '\r');
  await sleep(900);
  check('会话里有标记输出', (await termText()).indexOf(MARK) >= 0);

  let list = await apiList();
  check('历史接口里有记录', !!(list.ok && list.data.items.length >= 1),
    JSON.stringify(list.data && list.data.total));
  const first = list.data.items[0];
  check('记录带上了字节数', first.bytes > 0, `bytes=${first.bytes}`);
  check('记录带上了工作目录', !!first.cwd, first.cwd || '(空)');

  const logProbe = await page.evaluate(async (id) => {
    const r = await fetch('api/history/' + encodeURIComponent(id) + '/log');
    const t = await r.text();
    return { status: r.status, len: t.length, head: t.slice(0, 60), off: r.headers.get('X-History-Offset'), total: r.headers.get('X-History-Total') };
  }, first.id);
  check('日志接口能拿到内容', logProbe.status === 200 && logProbe.len > 0,
    JSON.stringify(logProbe));

  // ---------- 2. 面板 ----------
  await page.click('#btn-history');
  await sleep(700);
  let rows = await page.$$eval('.hist-item', (els) => els.length);
  check('面板列出历史条目', rows >= 1, `rows=${rows}`);

  await page.click('#hist-search');
  await page.type('#hist-search', 'zzz-no-such-thing');
  await sleep(300);
  rows = await page.$$eval('.hist-item', (els) => els.length);
  const emptyText = await page.$eval('#hist-list', (e) => e.textContent);
  check('搜不到时给空状态', rows === 0 && /没有匹配/.test(emptyText), emptyText.slice(0, 30));

  await page.evaluate(() => {
    const s = document.getElementById('hist-search');
    s.value = '';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(250);

  // ---------- 3. 点开一条 ----------
  const beforeTabs = await page.evaluate(() => window.__ts.app.tabs.length);
  await page.click('.hist-item');
  await sleep(1200);
  const afterTabs = await page.evaluate(() => window.__ts.app.tabs.length);
  check('点一条会新开一个标签', afterTabs === beforeTabs + 1, `${beforeTabs} → ${afterTabs}`);

  let restored = '';
  for (let i = 0; i < 40; i++) {
    restored = await termText(afterTabs - 1);
    if (restored.indexOf(MARK) >= 0) break;
    await sleep(200);
  }
  check('新标签里回放出了历史输出', restored.indexOf(MARK) >= 0,
    JSON.stringify(restored.slice(0, 100)));

  // ---------- 4. 回放之后 shell 还能用 ----------
  await type('echo ALIVE_' + MARK + '\r');
  await sleep(1200);
  const after = await termText(afterTabs - 1);
  check('回放之后 shell 能继续执行命令', after.indexOf('ALIVE_' + MARK) >= 0,
    JSON.stringify(after.slice(-160)));

  // ---------- 5. 删除单条 ----------
  const delBefore = (await apiList()).data.items.length;
  await page.click('#btn-history');
  await sleep(700);
  const targetId = await page.$eval('.hist-item', (e) => e.dataset.id);
  await page.click('.hist-item .hist-del');
  await sleep(700);
  const delAfter = (await apiList()).data.items.length;
  check('删除一条后数量减一', delAfter === delBefore - 1, `${delBefore} → ${delAfter}`);
  const goneStatus = await page.evaluate(async (id) => {
    const r = await fetch('api/history/' + encodeURIComponent(id));
    return r.status;
  }, targetId);
  check('被删的那条接口 404', goneStatus === 404, `status=${goneStatus}`);

  // ---------- 6. 清空 ----------
  if (await page.$eval('#hist-panel', (e) => e.hidden)) {
    await page.click('#btn-history');
    await sleep(600);
  }
  await page.click('#hist-clear');
  await sleep(500);
  await page.click('#cf-ok');
  await sleep(900);

  const cleared = (await apiList()).data.items.length;
  check('清空后接口为空', cleared === 0, `items=${cleared}`);
  const emptyPanel = await page.$eval('#hist-list', (e) => e.textContent);
  check('清空后列表给空状态', /还没有历史记录/.test(emptyPanel), emptyPanel.slice(0, 30));

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
