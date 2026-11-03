/*
 * 界面级冒烟测试：用本机 Edge 真跑一遍前端。
 *
 * 验证的是 M2 的四件事：标签、分屏、布局落盘、刷新后恢复。
 * 这些都是"代码看起来对但一跑就错"的高发区，必须真浏览器过一遍。
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

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(800);

  const state = () => page.evaluate(() => ({
    tabs: document.querySelectorAll('#tabstrip .tab').length,
    panes: document.querySelectorAll('.pane').length,
    visiblePanes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
    visibleViews: document.querySelectorAll('.tabview:not(.hidden)').length,
    hasXterm: !!document.querySelector('.xterm')
  }));

  let s = await state();
  check('初始 1 标签 1 窗格', s.tabs === 1 && s.panes === 1, JSON.stringify(s));
  check('xterm 已挂载', s.hasXterm);

  // 向右分屏
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Equal');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(900);

  s = await state();
  check('Ctrl+Alt+= 分成两格', s.panes === 2, `panes=${s.panes}`);

  const splitDir = await page.evaluate(() =>
    document.querySelector('.tabview:not(.hidden) > .split')?.className || '');
  check('分割方向是横向（左右）', splitDir.includes('dir-row'), splitDir);

  // 上下分屏嵌套
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Minus');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(900);

  s = await state();
  check('再按 Ctrl+Alt+- 共三格', s.panes === 3, `panes=${s.panes}`);

  const nested = await page.evaluate(() =>
    document.querySelectorAll('.tabview:not(.hidden) .split.dir-col').length);
  check('嵌套出纵向分割', nested >= 1, `dir-col=${nested}`);

  // 新标签
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyT');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(900);

  s = await state();
  check('Ctrl+Alt+T 新建标签', s.tabs === 2, `tabs=${s.tabs}`);
  check('只有当前标签可见', s.visibleViews === 1, `visible=${s.visibleViews}`);

  // 布局是否真的写到了服务端
  await sleep(700);
  const laid = await page.evaluate(async (base) => {
    const r = await fetch(base + 'api/layout', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  }, BASE);
  check('布局已落盘', !!laid && Array.isArray(laid.tabs) && laid.tabs.length === 2,
    laid ? `tabs=${laid.tabs.length}` : 'null');

  const leafCount = laid ? (function count(n) {
    return !n ? 0 : n.type === 'leaf' ? 1 : n.children.reduce((a, c) => a + count(c), 0);
  })(laid.tabs[0].root) : 0;
  check('第一标签的分割树有 3 个叶子', leafCount === 3, `leaves=${leafCount}`);

  const sids = laid ? Object.values(laid.tabs[0].leaves || {}).map((l) => l.sid).filter(Boolean) : [];
  check('每个窗格都记了 sid', sids.length === 3, `sids=${sids.length}`);

  const sidsBefore = sids.slice().sort();

  await page.screenshot({ path: 'tools/ui-m2.png' });

  // 刷新后是否恢复
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane', { timeout: 8000 });
  await sleep(1200);

  const after = await state();
  // 4 = 标签1 的 3 个窗格 + 标签2 的 1 个
  check('刷新后标签数保持', after.tabs === 2, `tabs=${after.tabs}`);
  check('刷新后窗格数保持', after.panes === 4, `panes=${after.panes}`);
  check('当前标签仍是单窗格', after.visiblePanes === 1, `visiblePanes=${after.visiblePanes}`);

  const laidAfter = await page.evaluate(async (base) => {
    const r = await fetch(base + 'api/layout', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  }, BASE);
  const sidsAfter = laidAfter
    ? Object.values(laidAfter.tabs[0].leaves || {}).map((l) => l.sid).filter(Boolean).sort()
    : [];
  check('刷新后 sid 完全一致（是接回不是重建）',
    JSON.stringify(sidsBefore) === JSON.stringify(sidsAfter),
    `before=${sidsBefore.length} after=${sidsAfter.length}`);

  // 服务端是否还挂着这三个会话（说明真的接回而不是重建）
  const alive = await page.evaluate(async (base) => {
    const r = await fetch(base + 'api/sessions');
    const j = await r.json();
    return (j.data || []).filter((x) => x.alive).length;
  }, BASE);
  check('服务端会话仍然存活', alive >= 3, `alive=${alive}`);

  check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 界面冒烟全部通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
