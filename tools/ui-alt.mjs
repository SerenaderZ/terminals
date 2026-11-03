/*
 * 全屏 TUI 进出备用屏幕的验证。
 *
 * 针对用户实际报的现象：「claude 退出后屏幕上留一堆乱码」。
 * 这类残影有三个来源，这里逐条盯住：
 *   1. xterm 的尺寸和 PTY 的尺寸不一致 → TUI 按错宽度排版，退出时错位；
 *   2. 缓冲区从备用屏幕切回主屏时只做了增量重绘 → 留下幽灵字符；
 *   3. 重绘时把主屏内容（scrollback）也一起清了 → 变成另一种"看不到了"。
 *
 * 所以断言是：尺寸始终一致、切回主屏后缓冲区确实回到 normal、原有内容还在、
 * 且没有 JS 报错。
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

const getState = () => ({
  rows: window.__ts.diag(),
  buffer: (function () {
    const s = window.__ts.app.activeTab().activePane().session;
    return s.term.buffer.active.type;
  })(),
  text: (function () {
    const s = window.__ts.app.activeTab().activePane().session;
    const b = s.term.buffer.active;
    let out = '';
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (line) out += line.translateToString(true) + '\n';
    }
    return out;
  })()
});

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--window-size=1400,900']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane.focused', { timeout: 8000 });
  await page.waitForFunction('window.__ts && window.__ts.diag', { timeout: 5000 });
  await sleep(1200);

  // ---- 1. 初始尺寸是否对得上
  let st = await page.evaluate(getState);
  check('初始 xterm 与 PTY 尺寸一致', st.rows[0] && st.rows[0].一致 === true, JSON.stringify(st.rows[0]));

  // ---- 2. 改窗口大小后是否仍然对得上（resize 帧丢失的老毛病）
  await page.setViewport({ width: 1040, height: 640 });
  await sleep(900);
  st = await page.evaluate(getState);
  const after = st.rows[0];
  check('缩窗后尺寸仍一致', after && after.一致 === true,
    after ? `xterm=${after.xterm} pty=${after.pty}` : 'no pane');
  check('缩窗后列数确实变了', after && after.xterm !== '0x0', after ? after.xterm : '');

  // ---- 3. 模拟全屏 TUI：进备用屏幕、铺满整行、再退出
  const marker = 'MAIN-BUFFER-MARKER-' + Date.now();
  const run = async (fn, arg) => page.evaluate(fn, arg);

  await run((m) => {
    const s = window.__ts.app.activeTab().activePane().session;
    s.term.write('\r\n' + m + '\r\n');
  }, marker);
  await sleep(300);

  await run(() => {
    const s = window.__ts.app.activeTab().activePane().session;
    const t = s.term;
    // 进备用屏幕，写满每一行（最容易触发错位残字的形状）
    t.write('\x1b[?1049h\x1b[H\x1b[2J');
    const line = new Array(t.cols + 1).join('#');
    let buf = '';
    for (let i = 0; i < t.rows; i++) buf += line + '\r\n';
    t.write(buf);
  });
  await sleep(500);

  let inAlt = await page.evaluate(() => {
    const s = window.__ts.app.activeTab().activePane().session;
    return s.term.buffer.active.type;
  });
  check('能进入备用屏幕', inAlt === 'alternate', `buffer=${inAlt}`);

  await run(() => {
    const s = window.__ts.app.activeTab().activePane().session;
    s.term.write('\x1b[?1049l');
  });
  await sleep(600);

  st = await page.evaluate(getState);
  check('退出后缓冲区回到主屏', st.buffer === 'normal', `buffer=${st.buffer}`);
  check('主屏内容没被重绘清掉', st.text.includes(marker), st.text.includes(marker) ? '' : 'marker 丢失');
  check('退出后尺寸仍一致', st.rows[0] && st.rows[0].一致 === true, JSON.stringify(st.rows[0]));
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 备用屏幕切换与尺寸对账通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
