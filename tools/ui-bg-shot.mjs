/*
 * 只出图：后台会话面板、设置里的手势说明、三按钮确认框。
 * 人工看版式用，不做断言。
 */
import puppeteer from 'puppeteer-core';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.TS_BASE || 'http://127.0.0.1:18090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 设置面板：新加的说明块
await page.click('#btn-settings');
await sleep(600);
await page.evaluate(() => {
  const n = document.querySelector('.set-note');
  if (n) n.scrollIntoView({ block: 'center' });
});
await sleep(400);
await page.screenshot({ path: 'tools/shot-bg-note.png' });
await page.click('#set-close');
await sleep(400);

// 分屏 → 把一格移到后台
await page.keyboard.down('Control');
await page.keyboard.down('Alt');
await page.keyboard.press('Minus');
await page.keyboard.up('Alt');
await page.keyboard.up('Control');
await sleep(900);

await page.click('.pane.focused .terminal-host');
await sleep(200);
await page.keyboard.type('ping -n 600 127.0.0.1');
await page.keyboard.press('Enter');
await sleep(2000);

const target = await page.evaluate(() => window.__ts.app.activePane().id);
const box = await page.$(`.pane[data-pane="${target}"] .pane-close`);
await page.keyboard.down('Shift');
await box.click();
await page.keyboard.up('Shift');
await sleep(900);

await page.click('#btn-bg');
await sleep(900);
await page.screenshot({ path: 'tools/shot-bg-panel.png' });
await page.click('#bg-close');
await sleep(300);

// 三按钮确认框
await page.click('#btn-close-all');
await sleep(500);
await page.screenshot({ path: 'tools/shot-bg-confirm.png' });

await page.evaluate(() => fetch('api/sessions', { method: 'DELETE' }));
await browser.close();
console.log('shots ok');
