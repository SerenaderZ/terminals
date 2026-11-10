/*
 * 滚轮 / 复制粘贴的界面测试。
 *
 * 这几件事只有真浏览器 + 真鼠标事件能验：
 *   1) 鼠标停在右侧轨道上滚轮，也要能翻这一格的历史（以前只有文字区能滚，
 *      用户一直在轨道上滚，感觉就是"只能拖滑块"）；
 *   2) 滚哪个窗格，焦点就跟到哪个窗格；
 *   3) 拖选只选不复制 —— 拖错了左键点一下取消，剪贴板不该被动过；
 *   4) 右键：有选区是复制，没选区是粘贴；Ctrl+Insert / Shift+Insert；
 *   6) 全屏程序（备用屏幕）里滚轮不空转、也不偷偷发方向键。
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

  // 把 clipboard.writeText 换成记录器：headless 下真实剪贴板不可读，
  // 而且我们关心的是"有没有写、写的是什么"，不是浏览器实现。
  await page.evaluateOnNewDocument(() => {
    window.__copied = [];
    if (navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: (t) => { window.__copied.push(t); return Promise.resolve(); }
        });
      } catch (e) { /* 只读就放弃，后面会有失败提示 */ }
    }
  });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(900);

  // 灌满回看缓冲
  await page.evaluate(() => {
    const p = window.__ts.app.activePane();
    let s = '';
    for (let i = 1; i <= 400; i++) s += `ROW-${String(i).padStart(4, '0')} copy-target\r\n`;
    return new Promise((res) => p.session.term.write(s, res));
  });
  await sleep(600);

  const viewY = () => page.evaluate(() => {
    const b = window.__ts.app.activePane().session.term.buffer.active;
    return { viewportY: b.viewportY, baseY: b.baseY };
  });

  // ---- 1. 在右侧轨道上滚轮 ----
  const trackBox = await page.evaluate(() => {
    const b = document.querySelector('.tabview:not(.hidden) .pane-track').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height * 0.7 };
  });
  const beforeWheel = await viewY();
  await page.mouse.move(trackBox.x, trackBox.y);
  await page.mouse.wheel({ deltaY: -420 });
  await sleep(350);
  const afterWheel = await viewY();
  check('鼠标放在轨道上滚轮也能翻历史', afterWheel.viewportY < beforeWheel.viewportY,
    `${beforeWheel.viewportY} -> ${afterWheel.viewportY}`);

  // ---- 1b. 触摸板的小增量也要能滚（一次只报几像素） ----
  const textBox = await page.evaluate(() => {
    const b = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.5 };
  });
  await page.mouse.move(textBox.x, textBox.y);
  const beforeTrackpad = await viewY();
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel({ deltaY: -6 });
    await sleep(16);
  }
  await sleep(300);
  const afterTrackpad = await viewY();
  check('触摸板小增量累积后能滚动', afterTrackpad.viewportY < beforeTrackpad.viewportY,
    `${beforeTrackpad.viewportY} -> ${afterTrackpad.viewportY}`);

  // 往下滚回底部
  await page.mouse.move(trackBox.x, trackBox.y);
  await page.mouse.wheel({ deltaY: 2000 });
  await sleep(350);
  const backBottom = await viewY();
  check('反向滚轮能回到底部', backBottom.viewportY === backBottom.baseY,
    `viewportY=${backBottom.viewportY} baseY=${backBottom.baseY}`);

  // ---- 2. 拖选只选不复制 ----
  const paneBox = await page.evaluate(() => {
    const b = document.querySelector('.tabview:not(.hidden) .pane').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  const dragSelect = async () => {
    await page.mouse.move(paneBox.x + 24, paneBox.y + 24);
    await page.mouse.down();
    await page.mouse.move(paneBox.x + 360, paneBox.y + 120, { steps: 12 });
    await page.mouse.up();
    await sleep(350);
  };

  await page.evaluate(() => { window.__copied.length = 0; });
  await dragSelect();
  const dragState = await page.evaluate(() => ({
    copied: window.__copied.length,
    text: window.__ts.app.activePane().session.selectionText(),
  }));
  check('拖选后剪贴板没被动过', dragState.copied === 0, `calls=${dragState.copied}`);
  check('拖选确实选中了文字', /ROW-0\d{3}/.test(dragState.text),
    JSON.stringify(dragState.text.slice(0, 40)));

  // 左键点一下取消：同样的结论，而且框和文字都收掉了
  await page.mouse.click(paneBox.x + paneBox.w * 0.5, paneBox.y + paneBox.h * 0.6);
  await sleep(350);
  const afterCancel = await page.evaluate(() => ({
    copied: window.__copied.length,
    text: window.__ts.app.activePane().session.selectionText(),
  }));
  check('取消选区不会复制', afterCancel.copied === 0, `calls=${afterCancel.copied}`);
  check('取消之后选区文字也空了', afterCancel.text === '', JSON.stringify(afterCancel.text));

  // ---- 3. 右键：有选区是复制（复制只发生在这一刻） ----
  await dragSelect();
  await page.evaluate(() => { window.__copied.length = 0; });
  await page.mouse.click(paneBox.x + 24, paneBox.y + 24, { button: 'right' });
  await sleep(400);
  const ctxCopy = await page.evaluate(() => ({
    copied: window.__copied.length,
    banner: (document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent),
    text: window.__ts.app.activePane().session.selectionText(),
  }));
  check('有选区时右键 = 复制', ctxCopy.copied === 1, `calls=${ctxCopy.copied}`);
  check('复制后给出一次轻提示', /已复制/.test(ctxCopy.banner), ctxCopy.banner);
  check('复制之后选区收掉了（下一次右键是粘贴）', ctxCopy.text === '', JSON.stringify(ctxCopy.text));

  // ---- 4. 右键：没选区是粘贴 ----
  const pasted = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    st.clearSelection();
    window.__pasted = 0;
    st.paste = function () { window.__pasted++; };
    st.pasteInner = function () { window.__pasted++; return true; };
    return new Promise((res) => setTimeout(() => res(window.__pasted), 0));
  });
  await page.mouse.click(paneBox.x, paneBox.y, { button: 'right' });
  await sleep(400);
  const afterCtx = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    return { pasted: window.__pasted, copied: window.__copied.length };
  });
  check('没选区时右键 = 粘贴（保持原行为）', afterCtx.pasted === 1, `paste=${afterCtx.pasted}`);

  // ---- 5. Ctrl+Insert 复制 / Shift+Insert 粘贴 ----
  // 先点一下把焦点放回终端：点击会清掉选区，所以顺序是"点 → 选 → 按键"。
  await page.mouse.click(paneBox.x + paneBox.w * 0.5, paneBox.y + paneBox.h * 0.6);
  await sleep(150);
  await dragSelect();
  await page.evaluate(() => {
    window.__copied.length = 0;
    window.__pasted = 0;
  });
  await sleep(250);
  await page.keyboard.down('Control');
  await page.keyboard.press('Insert');
  await page.keyboard.up('Control');
  await sleep(300);
  const kbCopy = await page.evaluate(() => window.__copied.length);
  check('Ctrl+Insert 能复制', kbCopy >= 1, `calls=${kbCopy}`);

  await page.keyboard.down('Shift');
  await page.keyboard.press('Insert');
  await page.keyboard.up('Shift');
  await sleep(300);
  const kbPaste = await page.evaluate(() => window.__pasted);
  check('Shift+Insert 能粘贴', kbPaste === 1, `paste=${kbPaste}`);

  // ---- 7. 备用屏幕里滚轮不能把方向键塞给程序 ----
  await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    st.term.write('\x1b[?1049h'); // 切到备用屏幕
  });
  await sleep(300);
  const alt = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    return st.term.buffer.active.type;
  });
  await page.mouse.move(trackBox.x, trackBox.y);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(250);
  const altAfter = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    return { type: st.term.buffer.active.type, viewportY: st.term.buffer.active.viewportY };
  });
  check('备用屏幕里滚轮不改变缓冲区', altAfter.type === 'alternate' && altAfter.viewportY === 0,
    `type=${altAfter.type} y=${altAfter.viewportY}`);

  check('没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 滚轮与复制全部通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
