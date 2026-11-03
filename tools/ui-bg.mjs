/*
 * 后台会话实测：Shift + 点 × 移出界面、进程继续活着、能接回来，
 * 以及「结束全部」里的「只关界面，保留后台」。
 *
 * 关键断言不是"界面上少了几个格子"，而是服务端的会话还在（alive、clients=0），
 * 并且接回来拿到的是同一个 sid —— 换一个新 shell 出来就等于没保住进程。
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,800']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(1200);

const sessions = () => page.evaluate(async () => {
  const r = await fetch('api/sessions', { cache: 'no-store' });
  const j = await r.json();
  return j.data || [];
});
const panes = () => page.$$eval('.tabview:not(.hidden) .pane', (n) => n.length);

// ---- 1. 跑一个长命令，作为"不能被杀掉的后台任务" ----
await page.click('.pane.focused .terminal-host');
await sleep(300);
await page.keyboard.press('Enter');
await sleep(800);
await page.keyboard.type('ping -n 600 127.0.0.1');
await page.keyboard.press('Enter');
await sleep(4000);

const running = await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  const b = st.term.buffer.active;
  let hits = 0;
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line && line.translateToString(true).includes('127.0.0.1')) hits++;
  }
  return { sid: st.sid, hits };
});
check('长命令有输出', running.hits > 0, `sid=${running.sid} hits=${running.hits}`);

// ---- 2. 分屏，Shift + 点 × 把正在跑命令的那格移出界面 ----
await page.keyboard.down('Control');
await page.keyboard.down('Alt');
await page.keyboard.press('Minus');
await page.keyboard.up('Alt');
await page.keyboard.up('Control');
await sleep(1000);

const beforePanes = await panes();
check('分屏成 2 格', beforePanes === 2, `panes=${beforePanes}`);

// 分屏后焦点在新格子上，要按 sid 找回"跑着 ping 的那个格子"再点它的 ×，
// 否则关掉的是新开的那一个，测的就不是"留住正在跑的任务"。
const targetPane = await page.evaluate((sid) => {
  const t = window.__ts.app.activeTab();
  for (const k in t.panes) {
    if (t.panes[k] && t.panes[k].sid === sid) return t.panes[k].id;
  }
  return null;
}, running.sid);
check('找得到跑命令的那个窗格', !!targetPane, `pane=${targetPane}`);

const closeBox = await page.$(`.pane[data-pane="${targetPane}"] .pane-close`);
check('× 可见', !!closeBox);
await page.keyboard.down('Shift');
await closeBox.click();
await page.keyboard.up('Shift');
await sleep(900);

const afterDetach = await page.evaluate(() => ({
  panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
  bg: window.__ts.app.background.map((b) => ({ sid: b.sid, title: b.title })),
  badge: document.getElementById('bg-count').hidden ? null : document.getElementById('bg-count').textContent
}));
check('界面上只剩 1 格', afterDetach.panes === 1, `panes=${afterDetach.panes}`);
check('后台清单记下了这个会话', afterDetach.bg.length === 1, JSON.stringify(afterDetach.bg));
check('标题栏徽标显示 1', afterDetach.badge === '1', `badge=${afterDetach.badge}`);

const list1 = await sessions();
const sess1 = list1.find((s) => s.sid === running.sid);
check('服务端会话还活着', !!sess1 && sess1.alive, JSON.stringify(sess1 || {}));
check('会话已无客户端挂着', !!sess1 && sess1.clients === 0, `clients=${sess1 ? sess1.clients : '-'}`);

// ---- 3. 打开后台面板，接回 ----
await page.click('#btn-bg');
await page.waitForSelector('#bg-panel:not([hidden])', { timeout: 5000 });
await sleep(600);
const rows = await page.$$eval('#bg-list .bg-item', (n) => n.map((x) => x.querySelector('.bg-title').textContent));
check('面板里列出了一条后台会话', rows.length === 1, JSON.stringify(rows));

await page.click('#bg-list .bg-item .btn');
await sleep(3200);

const restored = await page.evaluate(() => {
  const t = window.__ts.app.tabs[window.__ts.app.tabs.length - 1];
  const p = t.activePane();
  const b = p.session.term.buffer.active;
  let hits = 0;
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line && line.translateToString(true).includes('127.0.0.1')) hits++;
  }
  return {
    sid: p.sid,
    hits,
    bg: window.__ts.app.background.length,
    tabs: window.__ts.app.tabs.length
  };
});
check('接回的是同一个 sid', restored.sid === running.sid, `${restored.sid} vs ${running.sid}`);
check('回放里有原来的输出', restored.hits > 0, `hits=${restored.hits}`);
check('接回后从后台清单里移除', restored.bg === 0, `bg=${restored.bg}`);

// ---- 4. 「结束全部」→「只关界面，保留后台」 ----
await page.click('#btn-close-all');
await page.waitForSelector('#confirm:not([hidden])', { timeout: 5000 });
const altVisible = await page.$eval('#cf-alt', (b) => !b.hidden && b.textContent.trim());
check('确认框有第三个按钮', !!altVisible, `label=${altVisible}`);

const sidsBefore = (await sessions()).map((s) => s.sid);
await page.click('#cf-alt');
await sleep(1500);

const afterKeep = await page.evaluate(() => ({
  panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
  tabs: window.__ts.app.tabs.length,
  bg: window.__ts.app.background.map((b) => b.sid),
  badge: document.getElementById('bg-count').hidden ? null : document.getElementById('bg-count').textContent
}));
check('界面收敛成一个干净窗格', afterKeep.tabs === 1 && afterKeep.panes === 1,
  `tabs=${afterKeep.tabs} panes=${afterKeep.panes}`);
check('两个会话都进了后台', afterKeep.bg.length === 2, JSON.stringify(afterKeep.bg));
check('徽标显示 2', afterKeep.badge === '2', `badge=${afterKeep.badge}`);

const list2 = await sessions();
const keptAlive = sidsBefore.filter((sid) => {
  const s = list2.find((x) => x.sid === sid);
  return s && s.alive;
});
check('原来的会话一个都没被杀', keptAlive.length === sidsBefore.length,
  `${keptAlive.length}/${sidsBefore.length}`);

// ---- 5. 刷新后后台清单还在（layout 持久化） ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(1800);

const afterReload = await page.evaluate(() => ({
  bg: window.__ts.app.background.length,
  badge: document.getElementById('bg-count').hidden ? null : document.getElementById('bg-count').textContent
}));
check('刷新后后台清单还在', afterReload.bg === 2, `bg=${afterReload.bg}`);
check('刷新后徽标仍然是 2', afterReload.badge === '2', `badge=${afterReload.badge}`);

// 打开面板确认条目能渲染出来
await page.click('#btn-bg');
await page.waitForSelector('#bg-panel:not([hidden])', { timeout: 5000 });
await sleep(700);
const rows2 = await page.$$eval('#bg-list .bg-item', (n) => n.length);
check('刷新后面板仍列出 2 条', rows2 === 2, `rows=${rows2}`);

// ---- 6. 从面板结束一个后台会话：真的发 DELETE ----
await page.click('#bg-list .bg-item .btn.danger');
await page.waitForSelector('#confirm:not([hidden])', { timeout: 5000 });
await page.click('#cf-ok');
await sleep(1200);
const list3 = await sessions();
check('结束后台会话后服务端少一个', list3.length === list2.length - 1,
  `${list2.length} -> ${list3.length}`);

// ---- 7. 「结束全部」的提示要自己消失 ----
// 这条提示当时没传 kind，banner 里没有任何分支管它，于是 "已结束 N 个会话"
// 会永久压在底边上，直到下一次有别的提示把它顶掉。
await page.click('#btn-close-all');
await page.waitForSelector('#confirm:not([hidden])', { timeout: 5000 });
await page.click('#cf-ok');
await sleep(1200);
const doneTip = await page.evaluate(() => {
  const el = document.getElementById('banner');
  return { hidden: el.hidden, text: el.textContent };
});
check('结束全部后给出提示', !doneTip.hidden && /已结束|没有任何会话/.test(doneTip.text),
  JSON.stringify(doneTip));
await sleep(4500);
const tipGone = await page.evaluate(() => document.getElementById('banner').hidden);
check('这条提示过几秒自己消失', tipGone === true);

// ---- 收尾 ----
await page.evaluate(() => fetch('api/sessions', { method: 'DELETE' }));
await browser.close();

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
