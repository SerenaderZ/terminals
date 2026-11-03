/*
 * 窗格右侧轨道（× 关闭 + 自绘滚动条）的界面测试。
 *
 * 三件事必须真浏览器验，光看代码不算数：
 *   1) 单窗格时只有滑块、没有 ×；分屏后 × 出现，且和滑块同一列、水平对齐；
 *   2) 有回看内容时滑块出现、短于轨道、贴底；拖到顶能翻到第一行；
 *   3) 点 × 能真的关掉这个窗格（不是只把 DOM 摘掉，会话也要停）。
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
  await sleep(900);

  const rail = () => page.evaluate(() => {
    const view = document.querySelector('.tabview:not(.hidden)');
    const pane = view && view.querySelector('.pane');
    if (!pane) return null;
    const close = pane.querySelector('.pane-close');
    const track = pane.querySelector('.pane-track');
    const thumb = pane.querySelector('.pane-thumb');
    const cb = close.getBoundingClientRect();
    const tb = track.getBoundingClientRect();
    const mb = thumb.getBoundingClientRect();
    return {
      solo: view.classList.contains('solo'),
      closeVisibility: getComputedStyle(close).visibility,
      close: { l: Math.round(cb.left), r: Math.round(cb.right), t: Math.round(cb.top), w: Math.round(cb.width), h: Math.round(cb.height) },
      track: { l: Math.round(tb.left), r: Math.round(tb.right), t: Math.round(tb.top), w: Math.round(tb.width), h: Math.round(tb.height) },
      thumbHidden: thumb.hidden,
      thumb: { t: Math.round(mb.top), h: Math.round(mb.height) }
    };
  });

  // ---- 1. 单窗格：只有滑块，没有 × ----
  let r = await rail();
  check('单窗格打了 solo 标记', r.solo === true);
  check('单窗格时 × 不可见（但保留占位）', r.closeVisibility === 'hidden', r.closeVisibility);
  check('单窗格也有滚动条轨道', r.track.h > 100, `trackH=${r.track.h}`);

  // ---- 2. 灌满回看缓冲，滑块要出来 ----
  await page.evaluate((lines) => {
    const p = window.__ts.app.activePane();
    let s = '';
    for (let i = 1; i <= lines; i++) s += `ROW-${String(i).padStart(4, '0')} --------\r\n`;
    return new Promise((res) => p.session.term.write(s, res));
  }, 400);
  await sleep(600);

  r = await rail();
  check('有回看内容后滑块出现', r.thumbHidden === false);
  check('滑块短于轨道（说明按比例算的）', r.thumb.h > 0 && r.thumb.h < r.track.h,
    `thumb=${r.thumb.h} track=${r.track.h}`);
  const atBottom = Math.abs((r.thumb.t + r.thumb.h) - (r.track.t + r.track.h)) <= 2;
  check('刚输出完时滑块贴底', atBottom,
    `thumbBottom=${r.thumb.t + r.thumb.h} trackBottom=${r.track.t + r.track.h}`);

  // ---- 3. 拖滑块到顶，视图要跟到第一行 ----
  const thumbBox = await page.evaluate(() => {
    const b = document.querySelector('.tabview:not(.hidden) .pane-thumb').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.move(thumbBox.x, thumbBox.y);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x, thumbBox.y - 400, { steps: 12 });
  await page.mouse.move(thumbBox.x, 20, { steps: 12 });
  await page.mouse.up();
  await sleep(500);

  const scrolled = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    const b = st.term.buffer.active;
    return { viewportY: b.viewportY, baseY: b.baseY };
  });
  check('拖到顶后视图停在第一行', scrolled.viewportY === 0,
    `viewportY=${scrolled.viewportY} baseY=${scrolled.baseY}`);

  r = await rail();
  check('滑块跟着跑到顶部', Math.abs(r.thumb.t - r.track.t) <= 2,
    `thumbTop=${r.thumb.t} trackTop=${r.track.t}`);

  // 滚回底部，后面截图好看一点
  await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    st.term.scrollToBottom();
  });
  await sleep(300);

  // ---- 4. 分屏后 × 出现，且和滑块同列对齐 ----
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Equal');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(1000);

  r = await rail();
  check('分屏后取消 solo', r.solo === false);
  check('分屏后 × 可见', r.closeVisibility === 'visible', r.closeVisibility);
  check('× 与滚动条同宽同列', r.close.w === r.track.w && r.close.l === r.track.l && r.close.r === r.track.r,
    `close=${r.close.l}-${r.close.r} track=${r.track.l}-${r.track.r}`);
  check('× 在滚动条正上方（底边不越过轨道顶边）', r.close.t + r.close.h <= r.track.t,
    `closeBottom=${r.close.t + r.close.h} trackTop=${r.track.t}`);

  await page.screenshot({ path: 'tools/ui-rail.png' });

  // ---- 5. 点 × 关掉这一格 ----
  const before = await page.evaluate(() => ({
    panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
    sids: window.__ts.app.tabs[0] && Object.keys(window.__ts.app.tabs[0].panes).length
  }));

  // 点"不是焦点那个"窗格上的 ×，顺便验证不会抢焦点
  await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll('.tabview:not(.hidden) .pane'));
    const other = panes.find((p) => !p.classList.contains('focused')) || panes[0];
    other.querySelector('.pane-close').click();
  });
  await sleep(900);

  const after = await page.evaluate(() => ({
    panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
    solo: document.querySelector('.tabview:not(.hidden)').classList.contains('solo'),
    alive: null
  }));
  check('点 × 后少一个窗格', after.panes === before.panes - 1,
    `before=${before.panes} after=${after.panes}`);
  check('关到只剩一个时回到 solo（× 自动消失）', after.solo === true);

  const alive = await page.evaluate(async (base) => {
    const res = await fetch(base + 'api/sessions');
    const j = await res.json();
    return (j.data || []).filter((x) => x.alive).length;
  }, BASE);
  check('服务端会话也一起没了（不是只摘 DOM）', alive <= before.panes - 1,
    `alive=${alive} panes=${before.panes}`);

  check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 窗格轨道全部通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
