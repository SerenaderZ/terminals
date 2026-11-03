/*
 * 连接状态按钮实测：连上时不可点、不可悬停；断开后能说出原因、能点着重连。
 *
 * 这个脚本自己拉起、杀掉、再拉起 tsd —— 断线必须真的把服务端停掉，
 * 用 ws.close() 模拟出来的是 1000/1005，包不出 1006 那条真实路径。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// 浏览器路径：TS_EDGE 可覆盖。
const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 项目根：脚本都在 tools/ 下，默认取上一级，换机器不用改（TS_ROOT 可覆盖）。
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-conn';
const BASE = 'http://127.0.0.1:18090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

let child = null;

function startServer() {
  child = spawn(EXE, [
    '--listen', '127.0.0.1:18090',
    '--base', '/',
    '--dev',
    '--data-dir', DATA,
    '--max-sessions', '8'
  ], { stdio: 'ignore' });
  child.on('error', (e) => console.log('SERVER ERROR:', e.message));
}

async function alive(timeout = 600) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(BASE + 'api/healthz', { signal: ctrl.signal, cache: 'no-store' });
    return r.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitAlive(want, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await alive()) === want) return true;
    await sleep(120);
  }
  return false;
}

async function stopServer() {
  if (!child) return;
  try { child.kill(); } catch (e) { }
  // Windows 上是 TerminateProcess，但监听端口要过一会儿才真正释放。
  await waitAlive(false, 8000);
  child = null;
}

// 断线时按钮的"外貌"一次性取回来，后面几条断言都用它。
const statusInfo = () => page.evaluate(() => {
  const b = document.getElementById('status');
  const tip = document.getElementById('conn-tip');
  const cs = getComputedStyle(b);
  return {
    text: document.getElementById('statustext').textContent,
    led: document.getElementById('led').className,
    down: b.classList.contains('down'),
    ariaDisabled: b.getAttribute('aria-disabled'),
    tabIndex: b.tabIndex,
    title: b.title,
    pointer: cs.pointerEvents,
    cursor: cs.cursor,
    tipHidden: tip.hidden,
    tipTitle: document.getElementById('ct-title').textContent,
    reason: document.getElementById('ct-reason').textContent,
    server: document.getElementById('ct-server').textContent,
    retry: document.getElementById('ct-retry').textContent
  };
});

// ---------------------------------------------------------------- 启动

startServer();
const up = await waitAlive(true);
check('测试服务已就绪', up);
if (!up) process.exit(1);

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

// ---- 1. 已连接：按钮完全不可交互 ----
const online = await statusInfo();
check('连上时显示"已连接"', online.text === '已连接', online.text);
check('指示灯是绿色', /online/.test(online.led), online.led);
check('连上时没有 down 类', online.down === false);
check('连上时 aria-disabled=true', online.ariaDisabled === 'true', online.ariaDisabled);
check('连上时跳出 Tab 序列', online.tabIndex === -1, String(online.tabIndex));
check('连上时 pointer-events 为 none', online.pointer === 'none', online.pointer);
check('连上时 title 已清空', online.title === '', JSON.stringify(online.title));

// 悬停在按钮位置，浮层不应该出现
const box = await page.$eval('#status', (b) => {
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await sleep(400);
check('连上时悬停不出浮层', (await statusInfo()).tipHidden === true);

// ---- 2. 停掉服务端：状态要变，原因要说清楚 ----
await stopServer();
const wentDown = await (async () => {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const s = await statusInfo();
    if (s.down) return s;
    await sleep(150);
  }
  return await statusInfo();
})();

check('断线后显示"未连接"', wentDown.text === '未连接', wentDown.text);
check('指示灯变红', /offline/.test(wentDown.led), wentDown.led);
check('断线后进入可点状态', wentDown.down === true && wentDown.pointer === 'auto',
  `down=${wentDown.down} pointer=${wentDown.pointer}`);
check('可点时鼠标变成手型', wentDown.cursor === 'pointer', wentDown.cursor);
check('aria-disabled=false', wentDown.ariaDisabled === 'false', wentDown.ariaDisabled);
check('断线后才进 Tab 序列', wentDown.tabIndex === 0, String(wentDown.tabIndex));

// ---- 3. 悬停：浮层给出原因 ----
await page.mouse.move(box.x, box.y);
await sleep(500);
const tip = await statusInfo();
check('悬停弹出浮层', tip.tipHidden === false);
check('浮层标题说明断开', /断开/.test(tip.tipTitle), tip.tipTitle);
// 服务端被硬停，浏览器看到的是 1006；文案必须指向"中断/没响应"这一类
check('原因指向连接中断', /中断|没响应|网络|关闭/.test(tip.reason), tip.reason);
// 探活是异步的（先 400ms 再最多 3s），给它时间
await sleep(2200);
const tip2 = await statusInfo();
check('探活结论为服务不可达', /不可达/.test(tip2.server), tip2.server);
check('重连一栏有退避信息', /重试|连接|等待/.test(tip2.retry), tip2.retry);

// ---- 4. 重启服务端，点按钮立即重连 ----
startServer();
await waitAlive(true, 10000);
await sleep(300);

const clicked = await page.evaluate(() => {
  const b = document.getElementById('status');
  b.click();
  return true;
});
check('点击按钮已派发', clicked);
await sleep(600);
const bannerText = await page.$eval('#banner', (e) => (e.hidden ? '' : e.textContent));
check('点击后提示正在重连', /重连/.test(bannerText), bannerText);

const backOnline = await (async () => {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const s = await statusInfo();
    if (s.text === '已连接') return s;
    await sleep(200);
  }
  return await statusInfo();
})();
check('点击后回到已连接（不用等退避）', backOnline.text === '已连接', backOnline.text);
check('恢复后浮层已收起', backOnline.tipHidden === true);
check('恢复后按钮再次不可点', backOnline.pointer === 'none' && backOnline.down === false,
  `pointer=${backOnline.pointer}`);

// ---- 5. 刷新后仍然正常（状态是算出来的，不靠刷新前的残留） ----
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(1500);
const afterReload = await statusInfo();
check('刷新后重新接上', afterReload.text === '已连接', afterReload.text);

// ---- 6. 分屏后一格断开 → "部分断开"，仍然可以点 ----
await page.keyboard.down('Control');
await page.keyboard.down('Alt');
await page.keyboard.press('Equal');
await page.keyboard.up('Alt');
await page.keyboard.up('Control');
await sleep(900);

const partial = await page.evaluate(async () => {
  const app = window.__ts.app;
  const t = app.activeTab();
  const panes = Object.keys(t.panes).map((k) => t.panes[k]);
  // 白盒：把其中一格的 dataset.state 直接标成 offline，验证聚合文案。
  const victim = panes.find((p) => p !== t.activePane()) || panes[0];
  victim.el.dataset.state = 'offline';
  app.setStatus();
  const b = document.getElementById('status');
  const tipHidden = document.getElementById('conn-tip').hidden;
  return {
    text: document.getElementById('statustext').textContent,
    down: b.classList.contains('down'),
    tipHidden
  };
});
check('一格断开时显示"部分断开"', partial.text === '部分断开', partial.text);
check('部分断开时按钮可点', partial.down === true);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');

await browser.close();
await stopServer();
process.exit(failed ? 1 : 0);
