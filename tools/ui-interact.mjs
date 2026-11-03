/*
 * 交互测试：拖分隔条、方向键移焦点、关窗格。
 *
 * 这三件事都有"看起来写对了、一用就错"的属性：
 * 拖拽的比例算错会让窗格越拖越窄，关窗格不杀会话会留下僵尸 shell。
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
  args: ['--no-sandbox', '--disable-gpu']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.pane.focused', { timeout: 8000 });
  await sleep(700);

  const press = async (key) => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press(key);
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await sleep(450);
  };

  const layoutOf = () => page.evaluate(async (base) => {
    const r = await fetch(base + 'api/layout', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  }, BASE);

  // 先摆出左右两格
  await press('Equal');
  await sleep(500);

  const widths = () => page.evaluate(() =>
    [...document.querySelectorAll('.tabview:not(.hidden) .pane')]
      .map((el) => Math.round(el.getBoundingClientRect().width)));

  const before = await widths();
  check('拖动前两格宽度接近', before.length === 2 && Math.abs(before[0] - before[1]) < 30,
    JSON.stringify(before));

  // 拖分隔条向右 160px
  const g = await page.$('.tabview:not(.hidden) .gutter.v');
  check('找到竖向分隔条', !!g);
  const box = await g.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 20, box.y + 40);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(700);

  const after = await widths();
  check('拖动后左格明显变宽', after[0] - before[0] > 100,
    `${before[0]} -> ${after[0]}`);
  check('两格总宽不变', Math.abs((before[0] + before[1]) - (after[0] + after[1])) <= 8,
    `${before[0] + before[1]} vs ${after[0] + after[1]}`);

  const laid = await layoutOf();
  const sizes = laid?.tabs?.[0]?.root?.sizes || [];
  check('比例写回布局树', sizes.length === 2 && sizes[0] > 0.55 && sizes[1] < 0.45,
    JSON.stringify(sizes.map((x) => Number(x.toFixed(3)))));

  // 方向键移焦点。分屏后焦点在新窗格（右边那格），所以往左按才有邻居。
  const focusedBefore = await page.evaluate(() =>
    document.querySelector('.pane.focused')?.dataset.pane);
  await press('ArrowLeft');
  const focusedAfter = await page.evaluate(() =>
    document.querySelector('.pane.focused')?.dataset.pane);
  check('Ctrl+Alt+← 焦点换到另一格',
    !!focusedAfter && focusedAfter !== focusedBefore,
    `${focusedBefore} -> ${focusedAfter}`);

  const focusCount = await page.evaluate(() =>
    document.querySelectorAll('.pane.focused').length);
  check('同一时刻只有一个窗格是焦点', focusCount === 1, `count=${focusCount}`);

  // 关窗格：会话也必须一起消失，否则会留下孤儿 shell
  const sessionsBefore = await page.evaluate(async (base) => {
    const r = await fetch(base + 'api/sessions');
    return ((await r.json()).data || []).length;
  }, BASE);

  await press('KeyW');
  await sleep(900);

  const panesAfter = await page.evaluate(() =>
    document.querySelectorAll('.tabview:not(.hidden) .pane').length);
  check('Ctrl+Alt+W 关掉一个窗格', panesAfter === 1, `panes=${panesAfter}`);

  const sessionsAfter = await page.evaluate(async (base) => {
    const r = await fetch(base + 'api/sessions');
    return ((await r.json()).data || []).length;
  }, BASE);
  check('关窗格同时结束了会话', sessionsAfter < sessionsBefore,
    `${sessionsBefore} -> ${sessionsAfter}`);

  check('没有 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nPASS: 交互测试全部通过' : `\nFAIL: ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
