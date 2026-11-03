/*
 * WebGL 上下文池的验证：开 8 个窗格，确认占用的上下文数不超过上限。
 *
 * 这条测试针对的是一个真实会踩的坑 —— 浏览器对每页 WebGL 上下文有硬上限
 * （Chrome 约 16 个），超了会静默丢掉最旧的，表现是某个窗格整块变黑。
 * 所以"能开多少窗格"和"挂几个 WebGL"必须解耦。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MAX_CTX = 4;
const PANES = 8;

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await page.waitForFunction('window.__ts && window.__ts.webglCount', { timeout: 5000 });
  await sleep(600);

  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    return !!ctx;
  });
  console.log(`环境：WebGL ${gl ? '可用' : '不可用（池逻辑仍应保持不超限）'}`);

  const initial = await page.evaluate(() => window.__ts.webglCount());
  check('初始上下文数不超过上限', initial <= MAX_CTX, `count=${initial}`);

  // 连续分屏，每次都焦点在新窗格上（这正是最坏情况：每个新窗格都想挂 WebGL）
  for (let i = 1; i < PANES; i++) {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press(i % 2 ? 'Equal' : 'Minus');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await sleep(220);
  }
  await sleep(900);

  const st = await page.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    gl: window.__ts.webglCount(),
    // 每个窗格都应该有可见的 renderer 元素，不能是空壳
    canvases: document.querySelectorAll('.pane canvas').length,
    rows: Array.from(document.querySelectorAll('.pane')).map((p) => {
      const screen = p.querySelector('.xterm-screen');
      return screen ? Math.round(screen.getBoundingClientRect().height) : 0;
    })
  }));

  check(`开出了 ${PANES} 个窗格`, st.panes === PANES, `panes=${st.panes}`);
  check('上下文数仍在上限内', st.gl <= MAX_CTX, `count=${st.gl}`);
  check('每个窗格都有渲染画布', st.canvases >= st.panes, `canvas=${st.canvases}`);
  check('没有窗格塌成 0 高度', st.rows.every((h) => h > 10), JSON.stringify(st.rows));
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: WebGL 上下文池验证通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
