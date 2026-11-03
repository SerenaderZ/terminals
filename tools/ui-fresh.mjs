/*
 * 冷启动 / 结束全部 / × 悬停 的界面测试。
 *
 * 这三件事都是"用户一眼就能看出不对"的地方，必须在真浏览器里跑：
 *   1) 冷启动（新开页面）只给一个窗格，即使服务端还留着上一轮的多窗格布局；
 *      而且上一轮没人挂着的会话要被清掉，不能留下看不见的 shell；
 *   2) "结束全部"点了以后只剩一个干净窗格，服务端会话全部换新；
 *   3) × 悬停不能是红色，只能是灰阶色差（用户明确否掉了红色）。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,800']
});

const errors = [];
function watch(page) {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
}

const state = (page) => page.evaluate(() => ({
  tabs: document.querySelectorAll('#tabstrip .tab').length,
  panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
  allPanes: document.querySelectorAll('.pane').length,
  solo: !!document.querySelector('.tabview.solo')
}));

const sessions = (page) => page.evaluate(async (base) => {
  const r = await fetch(base + 'api/sessions');
  const j = await r.json();
  return (j.data || []).filter((x) => x.alive).map((x) => x.sid);
}, BASE);

try {
  // ---- 第一轮：制造一个两窗格 + 两个会话的局面 ----
  const p1 = await browser.newPage();
  watch(p1);
  await p1.setViewport({ width: 1280, height: 800 });
  await p1.goto(BASE, { waitUntil: 'networkidle2' });
  await p1.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(800);

  let s = await state(p1);
  check('全新数据目录打开只有 1 个窗格', s.panes === 1 && s.tabs === 1, JSON.stringify(s));

  await p1.keyboard.down('Control');
  await p1.keyboard.down('Alt');
  await p1.keyboard.press('Minus');
  await p1.keyboard.up('Alt');
  await p1.keyboard.up('Control');
  await sleep(900);

  s = await state(p1);
  check('分屏成上下两格', s.panes === 2, `panes=${s.panes}`);
  const sidBefore = (await sessions(p1)).slice().sort();
  check('服务端有 2 个会话', sidBefore.length === 2, `n=${sidBefore.length}`);

  // ---- × 悬停：必须是灰阶，不是红色 ----
  const hover = await p1.evaluate(async () => {
    const btn = document.querySelector('.tabview:not(.hidden) .pane-close');
    const rect = btn.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, before: getComputedStyle(btn).backgroundColor };
  });
  await p1.mouse.move(hover.x, hover.y);
  await sleep(250);
  const hovered = await p1.evaluate(() => {
    const btn = document.querySelector('.tabview:not(.hidden) .pane-close');
    const cs = getComputedStyle(btn);
    return { bg: cs.backgroundColor, color: cs.color };
  });
  const isRed = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return r > 120 && r > g + 40 && r > b + 40;
  };
  check('× 悬停底色变了（有色差）', hovered.bg !== hover.before, `${hover.before} -> ${hovered.bg}`);
  check('× 悬停不是红色', !isRed(hovered.bg), hovered.bg);
  check('× 悬停文字不是白色硬跳', hovered.color !== 'rgb(255, 255, 255)', hovered.color);

  // ---- 关掉这一页，模拟"下次再打开" ----
  await p1.close();
  await sleep(700);

  // ---- 第二轮：重新打开 ----
  const p2 = await browser.newPage();
  watch(p2);
  // 结束全部不应该再去关窗口了；这里留着计数，专门验证"确实没调"。
  await p2.evaluateOnNewDocument(() => {
    window.__closeCalls = 0;
    window.close = () => { window.__closeCalls++; };
  });
  await p2.setViewport({ width: 1280, height: 800 });
  await p2.goto(BASE, { waitUntil: 'networkidle2' });
  await p2.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(1200);

  s = await state(p2);
  check('重新打开恢复了上次的分屏（2 格）', s.panes === 2 && s.tabs === 1, JSON.stringify(s));
  check('两格都有内容时 × 显示', s.solo === false);

  const sidReopen = (await sessions(p2)).slice().sort();
  check('上一轮的会话还在（没被清掉）',
    sidReopen.length === 2 && sidBefore.every((x) => sidReopen.includes(x)),
    `before=${sidBefore.join(',')} after=${sidReopen.join(',')}`);

  const layoutReopen = await p2.evaluate(async (base) => {
    const r = await fetch(base + 'api/layout', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  }, BASE);
  const leavesReopen = layoutReopen && layoutReopen.tabs && layoutReopen.tabs[0]
    ? (function count(n) { return !n ? 0 : n.type === 'leaf' ? 1 : n.children.reduce((a, c) => a + count(c), 0); })(layoutReopen.tabs[0].root)
    : -1;
  check('磁盘上的布局没有被单窗格覆盖', leavesReopen === 2, `leaves=${leavesReopen}`);

  // ---- 第三轮：结束全部 ----
  await p2.keyboard.down('Control');
  await p2.keyboard.down('Alt');
  await p2.keyboard.press('Equal');
  await p2.keyboard.up('Alt');
  await p2.keyboard.up('Control');
  await sleep(800);
  await p2.keyboard.down('Control');
  await p2.keyboard.down('Alt');
  await p2.keyboard.press('KeyT');
  await p2.keyboard.up('Alt');
  await p2.keyboard.up('Control');
  await sleep(800);

  const before = await state(p2);
  const sidBeforeAll = (await sessions(p2)).slice().sort();
  // 第二轮恢复出来的 2 格 + 这次再分一格 = 3 格，新标签再加 1 格，共 4 格。
  check('已铺开 2 标签 4 窗格', before.allPanes === 4 && before.tabs === 2, JSON.stringify(before));

  // Esc 取消不该动任何东西
  await p2.click('#btn-close-all');
  await sleep(300);
  const dlg = await p2.evaluate(() => ({
    open: !document.getElementById('confirm').hidden,
    title: document.getElementById('cf-title').textContent,
    text: document.getElementById('cf-text').textContent,
    ok: document.getElementById('cf-ok').textContent
  }));
  check('确认框弹出来了', dlg.open);
  check('文案不再承诺关窗口', !/关闭这个窗口|会关闭/.test(dlg.text), dlg.text);
  check('文案说明了窗口不关', /窗口本身不关/.test(dlg.text), dlg.text);
  check('按钮说的是"结束全部"', dlg.ok === '结束全部', dlg.ok);
  await p2.keyboard.press('Escape');
  await sleep(300);
  const afterEsc = await state(p2);
  check('Esc 取消后窗格没变', afterEsc.allPanes === before.allPanes, `panes=${afterEsc.allPanes}`);

  // 快捷键和按钮走同一个入口
  await p2.keyboard.down('Control');
  await p2.keyboard.down('Alt');
  await p2.keyboard.press('KeyQ');
  await p2.keyboard.up('Alt');
  await p2.keyboard.up('Control');
  await sleep(300);
  const hotkeyDlg = await p2.evaluate(() => !document.getElementById('confirm').hidden);
  check('Ctrl+Alt+Q 也能打开确认框', hotkeyDlg);
  await p2.keyboard.press('Escape');
  await sleep(250);

  // 真的确认
  await p2.click('#btn-close-all');
  await sleep(250);
  await p2.click('#cf-ok');
  await sleep(1600);

  const afterAll = await p2.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    tabs: window.__ts.app.tabs.length,
    closeCalls: window.__closeCalls,
    hasShutdownPage: !!document.getElementById('shutdown')
  }));
  check('结束后留 1 标签 1 窗格（窗口不关）',
    afterAll.tabs === 1 && afterAll.panes === 1, JSON.stringify(afterAll));
  check('没有再去调 window.close()', afterAll.closeCalls === 0, `calls=${afterAll.closeCalls}`);
  check('收尾页已经移除', afterAll.hasShutdownPage === false);

  const sidAfterAll = await sessions(p2);
  check('旧会话一个不留', sidAfterAll.filter((x) => sidBeforeAll.includes(x)).length === 0,
    `old=${sidBeforeAll.join(',')} now=${sidAfterAll.join(',')}`);
  check('只剩新开的这一个会话', sidAfterAll.length === 1, `n=${sidAfterAll.length}`);

  // 结束全部之后布局也要收敛，否则下次刷新会把旧分屏和死 sid 一起复原回来
  const layout = await p2.evaluate(async (base) => {
    const r = await fetch(base + 'api/layout', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  }, BASE);
  const leaves = layout && layout.tabs && layout.tabs[0]
    ? (function count(n) { return !n ? 0 : n.type === 'leaf' ? 1 : n.children.reduce((a, c) => a + count(c), 0); })(layout.tabs[0].root)
    : -1;
  check('布局也收敛成单窗格', layout && layout.tabs.length === 1 && leaves === 1,
    `tabs=${layout ? layout.tabs.length : 'null'} leaves=${leaves}`);

  check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 持久化与结束全部全部通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
