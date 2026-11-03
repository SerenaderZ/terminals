/*
 * 底部提示条必须会自己消失。
 *
 * 这里守的是一条具体回归：banner() 只在带了类型（ok / warn / info / ask）
 * 时才设定时器，没带类型的提示一个都不会走 —— 「已结束 N 个会话」就是
 * 这么永久压在终端底边上的，结束全部、移到后台、接回后台会话也都是。
 *
 * 启动方式与其它 ui-* 不同：这里用固定调试端口 + connect，而不是
 * puppeteer.launch。本机 Edge 156 下 launch 起不来（自动端口读不到
 * DevToolsActivePort，浏览器被当成启动失败），connect 这条路稳定。
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
const DATA = ROOT + '\\.build\\testdata-banner';
const PROFILE = ROOT + '\\.build\\edge-banner';
const PORT = 18120;
const DBG = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };

let browser = null;
for (let i = 0; i < 40; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}` }); break; }
  catch (e) { await sleep(250); }
}
if (!browser) { console.log('SKIP  浏览器没起来'); cleanup(); process.exit(0); }

const origin = `http://127.0.0.1:${PORT}/`;
let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(origin + 'api/healthz'); if (r.ok) { up = true; break; } } catch (e) { }
  await sleep(250);
}
if (!up) { console.log('SKIP  服务没起来'); await browser.disconnect(); cleanup(); process.exit(0); }

const page = await browser.newPage();
await page.goto(origin, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(2000);

// ---- 结束全部：提示出现，然后自己走 ----
await page.click('#btn-close-all');
await page.waitForSelector('#confirm:not([hidden])', { timeout: 5000 });
await page.click('#cf-ok');
await sleep(1200);

const shown = await page.evaluate(() => {
  const el = document.getElementById('banner');
  return { hidden: el.hidden, text: el.textContent };
});
check('结束全部后给出提示', !shown.hidden && /已结束|没有任何会话/.test(shown.text), JSON.stringify(shown));

await sleep(4500);
const gone = await page.evaluate(() => document.getElementById('banner').hidden);
check('4 秒后提示自己消失', gone === true);

// ---- 顺手确认：新窗格还在，界面没被这条提示带崩 ----
const state = await page.evaluate(() => ({
  panes: document.querySelectorAll('.tabview:not(.hidden) .pane').length,
  tabs: window.__ts.app.tabs.length
}));
check('结束全部后界面收敛成一个干净窗格', state.panes === 1 && state.tabs === 1, JSON.stringify(state));

await page.close();
await browser.disconnect();
cleanup();

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
