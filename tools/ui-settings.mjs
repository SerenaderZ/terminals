/*
 * 设置页的验证：面板能开、改了立刻生效、刷新后还在、服务端确实落盘。
 *
 * 重点盯两件容易做错的事：
 *   1. 设置存服务端，换浏览器/刷新应该还是同一份 —— 只写 localStorage 会漏；
 *   2. 外观类改动必须立刻作用到"已经存在的窗格"，不能等下一个新标签。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const API = BASE + 'api/settings';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let failed = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverSettings() {
  const r = await fetch(API, { cache: 'no-store' });
  const j = await r.json();
  return j.data || {};
}

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
  await sleep(600);

  // ---- 1. 面板默认关闭，齿轮按钮存在
  const before = await page.evaluate(() => ({
    hidden: document.getElementById('settings').hidden,
    hasBtn: !!document.getElementById('btn-settings'),
    theme: document.documentElement.dataset.theme
  }));
  check('默认不显示设置面板', before.hidden === true);
  check('标题栏有设置按钮', before.hasBtn === true);

  // ---- 2. 点齿轮打开
  await page.click('#btn-settings');
  await sleep(200);
  const opened = await page.evaluate(() => ({
    hidden: document.getElementById('settings').hidden,
    focus: document.activeElement && document.activeElement.id
  }));
  check('点齿轮后面板打开', opened.hidden === false);
  check('焦点落在面板里（不漏键到终端）', opened.focus === 'set-close', `focus=${opened.focus}`);

  // ---- 3. 主题切浅色：CSS 变量 + xterm 内建主题都要变
  await page.select('#set-theme', 'light');
  await sleep(350);
  const light = await page.evaluate(() => {
    const st = window.__ts.app.activeTab().activePane().session;
    return {
      attr: document.documentElement.dataset.theme,
      bg: st.term.options.theme && st.term.options.theme.background,
      styleBg: getComputedStyle(document.body).backgroundColor
    };
  });
  check('页面切到浅色主题', light.attr === 'light', `attr=${light.attr}`);
  check('xterm 内建主题跟着换（不是只有 CSS 变了）',
    light.bg === '#ffffff', `term.theme.background=${light.bg}`);
  check('页面背景变亮', /255|25[0-5]/.test(light.styleBg) && light.styleBg !== 'rgb(12, 12, 12)',
    light.styleBg);

  // ---- 4. 字号：改一个值，所有窗格一起变
  await page.evaluate(() => {
    const i = document.getElementById('set-fontsize');
    i.value = '18';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(350);
  const font = await page.evaluate(() => {
    const rows = window.__ts.diag();
    return {
      setting: window.__ts.app.settings.fontSize,
      pane: window.__ts.app.activeTab().activePane().session.term.options.fontSize,
      allSame: document.querySelectorAll('.pane').length >= 1
    };
  });
  check('字号写入设置', font.setting === 18, `settings.fontSize=${font.setting}`);
  check('已存在的窗格立刻用新字号', font.pane === 18, `term.options.fontSize=${font.pane}`);

  // ---- 5. 关掉 WebGL：上下文要当场归还，不能等刷新
  const glBefore = await page.evaluate(() => window.__ts.webglCount());
  await page.click('#set-webgl');
  await sleep(600);
  const glAfter = await page.evaluate(() => window.__ts.webglCount());
  check('关掉 WebGL 后上下文归零', glAfter === 0, `before=${glBefore} after=${glAfter}`);

  // ---- 6. 服务端确实落盘
  const srv = await serverSettings();
  check('服务端已保存主题', srv.theme === 'light', `theme=${srv.theme}`);
  check('服务端已保存字号', srv.fontSize === 18, `fontSize=${srv.fontSize}`);
  check('服务端已保存 WebGL 开关', srv.webgl === false, `webgl=${srv.webgl}`);

  // ---- 7. 后台手势说明必须在设置里能看到（这是用户唯一能发现 Shift+点 × 的地方）
  const note = await page.evaluate(() => {
    const n = document.querySelector('.set-note');
    return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  check('设置里有"把程序留在后台"的说明', /Shift/.test(note) && /×/.test(note), note.slice(0, 80));
  check('补换行设置项已移除', (await page.$('#set-wrap')) === null);

  // ---- 8. Esc 关闭
  await page.keyboard.press('Escape');
  await sleep(200);
  const closed = await page.evaluate(() => document.getElementById('settings').hidden);
  check('Esc 关闭面板', closed === true);

  // ---- 9. Ctrl+Alt+, 再开
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Comma');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(250);
  const reopened = await page.evaluate(() => document.getElementById('settings').hidden);
  check('Ctrl+Alt+, 能打开面板', reopened === false);

  // ---- 10. 刷新后设置还在（这条才能证明不是只写了 localStorage）
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(900);
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    fontSize: window.__ts.app.settings.fontSize,
    webgl: window.__ts.app.settings.webgl,
    gl: window.__ts.webglCount()
  }));
  check('刷新后主题保持', after.theme === 'light', `theme=${after.theme}`);
  check('刷新后字号保持', after.fontSize === 18, `fontSize=${after.fontSize}`);
  check('刷新后 WebGL 仍是关闭', after.webgl === false && after.gl === 0,
    `webgl=${after.webgl} count=${after.gl}`);

  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 设置页验证通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
