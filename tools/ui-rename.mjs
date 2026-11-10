/*
 * 双击标签改工作区名字的回归。
 *
 * 覆盖：
 *   1. 双击进编辑，输入框里是当前名字、全选
 *   2. 回车确认 → 标签文字变、输入框消失
 *   3. 刷新页面 → 名字还在（名字存在服务端布局里，不是 localStorage）
 *   4. 程序改终端标题（onPaneTitle）不会覆盖用户起的名字
 *   5. Esc 取消 → 名字不动
 *   6. 清空后回车 → 恢复自动命名（继续跟着程序走）
 *   7. 编辑中按 Ctrl+Alt+T 不会凭空多出标签
 *   8. 双击非当前标签 → 先切过去再编辑
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-rename';
const PROFILE = ROOT + '\\.build\\edge-rename';
const PORT = 18147;
const DBG = 9353;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 布局持久化：上一轮留下的标签会被恢复出来，双击落到哪个标签上就不确定了。
fs.rmSync(DATA, { recursive: true, force: true });

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2600);

  const labels = () => page.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
  const label = async () => (await labels())[0];
  const hasInput = () => page.evaluate(() => !!document.querySelector('.tab-input'));
  const inputValue = () => page.evaluate(() => {
    const i = document.querySelector('.tab-input');
    return i ? { v: i.value, focused: document.activeElement === i, sel: i.selectionEnd - i.selectionStart } : null;
  });
  const dblclickTab = async (idx) => {
    const box = await page.evaluate((i) => {
      const t = document.querySelectorAll('.tab')[i];
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, idx || 0);
    await page.mouse.click(box.x, box.y, { clickCount: 2 });
    await sleep(450);
  };
  const auto = () => page.evaluate(() => window.__ts.app.activeTab().autoLabel());

  // ---- 1. 双击进编辑 ----
  const before = await label();
  await dblclickTab(0);
  const iv = await inputValue();
  check('双击标签出现输入框', !!iv);
  check('输入框里是当前的名字', !!iv && iv.v === before, JSON.stringify(iv && iv.v));
  check('输入框拿到焦点并全选', !!iv && iv.focused && iv.sel === (iv.v || '').length);

  // ---- 2. 回车确认 ----
  await page.keyboard.type('build 服务');
  await page.keyboard.press('Enter');
  await sleep(400);
  check('回车后输入框收掉', !(await hasInput()));
  check('标签换成了新名字', (await label()) === 'build 服务', JSON.stringify(await label()));

  // ---- 3. 刷新之后还在 ----
  await sleep(900); // 等布局落盘（save 防抖 400ms）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2600);
  check('刷新后名字还在', (await label()) === 'build 服务', JSON.stringify(await label()));

  // ---- 4. 程序改标题不会顶掉名字 ----
  await page.evaluate(() => {
    const app = window.__ts.app;
    const t = app.activeTab();
    t.activePane().title = 'C:\\Windows\\System32\\cmd.exe';
    app.onPaneTitle(t.activePane());
  });
  await sleep(300);
  check('程序改标题不覆盖自定义名', (await label()) === 'build 服务', JSON.stringify(await label()));

  // ---- 5. Esc 取消 ----
  await dblclickTab(0);
  await page.keyboard.type('不要这个名字');
  await page.keyboard.press('Escape');
  await sleep(350);
  check('Esc 之后名字不变', (await label()) === 'build 服务', JSON.stringify(await label()));
  check('Esc 之后输入框收掉', !(await hasInput()));

  // ---- 6. 清空 = 恢复自动命名 ----
  await dblclickTab(0);
  await page.evaluate(() => {
    const i = document.querySelector('.tab-input');
    i.value = '';
  });
  await page.keyboard.press('Enter');
  await sleep(350);
  const back = await auto();
  check('清空后恢复自动命名', (await label()) === back, `${JSON.stringify(await label())} vs ${JSON.stringify(back)}`);

  // ---- 7. 编辑中按快捷键不该新建标签 ----
  await dblclickTab(0);
  const tabsBefore = await page.evaluate(() => window.__ts.app.tabs.length);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyT');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(600);
  const tabsAfter = await page.evaluate(() => window.__ts.app.tabs.length);
  check('编辑中按 Ctrl+Alt+T 不会新建标签', tabsAfter === tabsBefore, `${tabsBefore} → ${tabsAfter}`);
  await page.keyboard.press('Escape');
  await sleep(300);

  // ---- 8. 双击非当前标签：先切过去再编辑 ----
  await page.evaluate(() => window.__ts.app.newTab(true));
  await sleep(1500);
  await page.evaluate(() => window.__ts.app.activateTab(window.__ts.app.tabs[0].id));
  await sleep(500);
  const activeBefore = await page.evaluate(() => window.__ts.app.activeTabId);
  await dblclickTab(1);
  const activeAfter = await page.evaluate(() => window.__ts.app.activeTabId);
  check('双击非当前标签会切换过去', activeAfter !== activeBefore, `${activeBefore} → ${activeAfter}`);
  check('并且进入编辑', await hasInput());
  await page.keyboard.press('Escape');
  await sleep(200);

  // ---- 9. 超长名字按上限截断 ----
  await dblclickTab(1);
  await page.keyboard.type('x'.repeat(80));
  await page.keyboard.press('Enter');
  await sleep(350);
  const long = (await labels())[1];
  check('超长名字截断到 40 字', long.length === 40, `len=${long.length}`);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
