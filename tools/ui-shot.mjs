import puppeteer from 'puppeteer-core';
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:18090/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
await p.goto(BASE, { waitUntil: 'networkidle2' });
await p.waitForSelector('.pane.focused');
await sleep(600);
const press = async (key, mods = ['Control', 'Alt']) => {
  for (const m of mods) await p.keyboard.down(m);
  await p.keyboard.press(key);
  for (const m of mods.slice().reverse()) await p.keyboard.up(m);
  await sleep(500);
};
await press('Equal');
await press('Equal');
await press('KeyT');
await press('Digit1');
await sleep(900);
await p.screenshot({ path: 'tools/ui-split.png' });
const info = await p.evaluate(() => {
  const panes = [...document.querySelectorAll('.tabview:not(.hidden) .pane')];
  return panes.map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) }; });
});
console.log(JSON.stringify(info));
await b.close();
