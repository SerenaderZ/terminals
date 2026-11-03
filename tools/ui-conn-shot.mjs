/*
 * 只出图：连接状态按钮在已连接/已断开两种状态下的样子，以及悬停浮层。
 * 人工看版式用，不做断言。
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
const DATA = ROOT + '\\.build\\testdata-shot';
const BASE = 'http://127.0.0.1:18090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [
  '--listen', '127.0.0.1:18090', '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '8'
], { stdio: 'ignore' });

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(BASE + 'api/healthz', { cache: 'no-store' });
    if (r.ok) break;
  } catch (e) { }
  await sleep(150);
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--window-size=1280,800']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(1500);

// 已连接：整条标题栏
await page.screenshot({ path: 'tools/shot-conn-online.png', clip: { x: 0, y: 0, width: 1280, height: 46 } });

// 停掉服务，等状态翻成断开
try { child.kill(); } catch (e) { }
for (let i = 0; i < 60; i++) {
  const down = await page.evaluate(() => document.getElementById('status').classList.contains('down'));
  if (down) break;
  await sleep(150);
}

// 探活要几秒，等它落定再截，否则截到"正在检测…"
await sleep(2500);

const box = await page.$eval('#status', (b) => {
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await sleep(600);
await page.screenshot({ path: 'tools/shot-conn-tip.png', clip: { x: 640, y: 0, width: 640, height: 250 } });

console.log('shots written');
await browser.close();
process.exit(0);
