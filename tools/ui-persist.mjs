/*
 * 持久化实测（贴近真实用法）：应用窗口里跑一个长命令，关掉窗口，再打开，
 * 看分屏布局、会话、命令输出是否都还在。
 */
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const PORT = 19224;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const profile = `${process.env.TEMP}\\ts-persist-${Math.random().toString(36).slice(2, 8)}`;
const p = spawn(EDGE, [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--app=${BASE}`
], { detached: true, stdio: 'ignore' });
p.unref();
const killEdge = () => { try { execSync('taskkill /F /IM msedge.exe /T', { stdio: 'ignore' }); } catch (e) { } };

let browser = null;
for (let i = 0; i < 60 && !browser; i++) {
  await sleep(300);
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null }); } catch (e) { }
}
if (!browser) { console.log('FAIL 连不上浏览器'); killEdge(); process.exit(1); }

let page = null;
for (let i = 0; i < 30 && !page; i++) {
  page = (await browser.pages()).find((x) => x.url().startsWith(BASE.slice(0, -1)));
  if (!page) await sleep(300);
}
await page.waitForSelector('.pane.focused', { timeout: 10000 });
await sleep(1500);

// ---- 先分屏，再在第一个窗格里跑长命令 ----
await page.keyboard.down('Control');
await page.keyboard.down('Alt');
await page.keyboard.press('Minus');
await page.keyboard.up('Alt');
await page.keyboard.up('Control');
await sleep(900);

const before = await page.evaluate(() => {
  const t = window.__ts.app.activeTab();
  const sids = [];
  for (const k in t.panes) if (t.panes[k]) sids.push(t.panes[k].sid);
  return { panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length, sids };
});
check('分屏成 2 格', before.panes === 2, JSON.stringify(before));

await page.click('.pane.focused .terminal-host');
await sleep(200);
await page.keyboard.type('ping -n 600 127.0.0.1');
await page.keyboard.press('Enter');
await sleep(2500);

const mid = await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  const b = st.term.buffer.active;
  let hits = 0;
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line && line.translateToString(true).includes('127.0.0.1')) hits++;
  }
  return { sid: st.sid, hits, len: b.length };
});
check('命令已经有输出', mid.hits > 0, `hits=${mid.hits} lines=${mid.len}`);

// ---- 关掉窗口（模拟用户点 ×）----
// 应用窗口关掉后 Edge 会连进程一起退，CDP 连接就断了。先留一个空白页占住
// 浏览器进程，模拟"浏览器还开着、只是这个窗口被关了"的情形。
const keeper = await browser.newPage();
await keeper.goto('about:blank');
await page.close();
await sleep(1200);
const stillAlive = await page.evaluate(() => 1).then(() => true).catch(() => false);
check('窗口确实关掉了', stillAlive === false);

// ---- 重新打开 ----
const p2 = await browser.newPage();
await p2.setViewport({ width: 1280, height: 800 });
await p2.goto(BASE, { waitUntil: 'networkidle2' });
await p2.waitForSelector('.pane.focused', { timeout: 10000 });
await sleep(2500);

const after = await p2.evaluate(() => {
  const app = window.__ts.app;
  const panes = document.querySelectorAll('.tabview:not(.hidden) .pane');
  const sids = [];
  for (const key in app.tabs[0].panes) sids.push(app.tabs[0].panes[key].sid);
  return { panes: panes.length, tabs: app.tabs.length, sids, focused: app.activePane() ? app.activePane().sid : null };
});
check('重新打开恢复了 2 格分屏', after.panes === 2 && after.tabs === 1, JSON.stringify(after));
check('sid 与关闭前一致（接回原进程）', after.sids.sort().join() === before.sids.sort().join(),
  `${before.sids.join(',')} -> ${after.sids.join(',')}`);

// 关窗期间命令还在跑：重开后缓冲区里应该有更多行
const resumed = await p2.evaluate((sid) => {
  const app = window.__ts.app;
  let target = null;
  for (const k in app.tabs[0].panes) if (app.tabs[0].panes[k].sid === sid) target = app.tabs[0].panes[k];
  if (!target) return { hits: -1 };
  const b = target.session.term.buffer.active;
  let hits = 0;
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line && line.translateToString(true).includes('127.0.0.1')) hits++;
  }
  return { hits };
}, mid.sid);
check('关窗期间输出仍在累积（进程没被杀）', resumed.hits > mid.hits, `${mid.hits} -> ${resumed.hits}`);

let psOut = '';
try { psOut = execSync('tasklist /FI "IMAGENAME eq PING.EXE" /NH', { encoding: 'utf8' }); } catch (e) { }
check('系统里确实还有这个进程', /PING\.EXE/i.test(psOut), psOut.trim().split('\n')[0]);

await keeper.close().catch(() => { });
browser.disconnect();
killEdge();
try { execSync('taskkill /F /IM PING.EXE', { stdio: 'ignore' }); } catch (e) { }
console.log(failed === 0 ? '\nPASS' : `\nFAIL ${failed}`);
process.exit(failed === 0 ? 0 : 1);
