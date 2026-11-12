/*
 * 文件侧栏的回归：默认隐藏、开关状态持久化、列目录、新建、上传、宽度联动。
 *
 * 这个面板最容易坏在三个地方，所以每条都单独断言：
 *
 * 1) 默认必须是关的。它存在服务端设置里，一旦默认值写成 true，所有新装的
 *    用户一打开页面就多出一块东西 —— 而且这类"默认值写反"在手工点一遍时
 *    根本发现不了（开发机的 settings.json 里早就有值了）。
 * 2) 开关要真的落盘。用户关掉浏览器再回来，位置必须和上次一样。
 * 3) 开合必须让终端重新 fit。否则侧栏一出现，右边终端还用老列数画，
 *    最后一列会被吃掉或者右边空一条。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-files';
const PROFILE = ROOT + '\\.build\\edge-files';
const TMP = ROOT + '\\.build\\files-upload.txt';
const PORT = 18138;
const DBG = 9344;
const URL = `http://127.0.0.1:${PORT}/`;
const API = `http://127.0.0.1:${PORT}/api/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// 每次从干净的数据目录起：默认值这条断言只有在"没有历史设置"时才成立。
for (const d of [DATA, PROFILE]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { }
}
fs.writeFileSync(TMP, 'uploaded by ui-files test\n第二行\n', 'utf8');

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { edge.kill(); } catch (e) { }
  try { tsd.kill(); } catch (e) { }
  try { fs.rmSync(TMP, { force: true }); } catch (e) { }
};
process.on('exit', cleanup);

async function settings() {
  const r = await fetch(API + 'settings');
  const j = await r.json();
  return (j && j.data) || {};
}

(async () => {
  await sleep(2600);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  // ---------- 1. 首次安装：默认隐藏 ----------
  const hidden0 = await page.evaluate(() => document.getElementById('files').hidden);
  const st0 = await settings();
  check('首次打开侧栏是隐藏的', hidden0 === true, `hidden=${hidden0}`);
  check('服务端设置里 filesOpen 默认 false', st0.filesOpen === false, JSON.stringify(st0.filesOpen));

  // ---------- 2. 点标题栏按钮打开 ----------
  const colsBefore = await page.evaluate(() =>
    window.__ts.app.activePane().session.term.cols);
  await page.click('#btn-files');
  await sleep(900);

  const opened = await page.evaluate(() => ({
    hidden: document.getElementById('files').hidden,
    w: document.getElementById('files').getBoundingClientRect().width,
    cols: window.__ts.app.activePane().session.term.cols
  }));
  check('点按钮后侧栏出现', opened.hidden === false);
  check('侧栏宽度是默认的 300', Math.abs(opened.w - 300) <= 2, `${opened.w}px`);
  check('侧栏占用宽度后终端重新排了列', opened.cols < colsBefore,
    `${colsBefore} → ${opened.cols}`);

  // ---------- 3. 列出了 home ----------
  const listed = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#files-list .frow'));
    return {
      n: rows.length,
      names: rows.slice(0, 5).map((r) => r.querySelector('.fname').textContent),
      path: document.getElementById('files-path').value,
      info: document.getElementById('files-info').textContent
    };
  });
  check('列出了 home 里的内容', listed.n > 0, `${listed.n} 项 ${JSON.stringify(listed.names)}`);
  check('路径栏显示的是绝对路径', /^([A-Za-z]:\\|\/)/.test(listed.path), listed.path);

  // ---------- 4. 目录树建好了祖先链 ----------
  const tree = await page.evaluate(() => ({
    nodes: document.querySelectorAll('#files-tree .tnode').length,
    active: document.querySelectorAll('#files-tree .tnode.active').length
  }));
  check('目录树有祖先链', tree.nodes >= 2, `${tree.nodes} 个节点`);
  check('当前目录在树上是点亮的', tree.active === 1, `active=${tree.active}`);

  // ---------- 5. 新建文件夹 ----------
  const mkName = 'ui-files-' + Date.now().toString(36);
  await page.click('#files-mkdir');
  await sleep(200);
  await page.type('.fname-input', mkName);
  await page.keyboard.press('Enter');
  await sleep(1000);

  const afterMk = await page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('#files-list .frow'));
    const hit = rows.find((r) => r.querySelector('.fname').textContent === n);
    return { hit: !!hit, dir: hit ? hit.classList.contains('is-dir') : false };
  }, mkName);
  check('新建的文件夹出现在列表里', afterMk.hit && afterMk.dir, mkName);

  // ---------- 6. 上传 ----------
  const input = await page.$('input[type=file]');
  check('页面里有上传用的 file input', !!input);
  if (input) {
    await input.uploadFile(TMP);
    await sleep(1600);
    const up = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#files-list .frow'));
      const hit = rows.find((r) => r.querySelector('.fname').textContent === 'files-upload.txt');
      return { hit: !!hit, meta: hit ? hit.querySelector('.fmeta').textContent : '' };
    });
    check('上传的文件出现在列表里', up.hit, up.meta);
  }

  // ---------- 7. 双击进入目录 ----------
  // 新建的名字以 u 开头，在 home 里很可能排在列表下方、不在可视区。
  // 不先滚进视野的话，getBoundingClientRect 给的坐标落在面板外面，
  // 点下去打的是终端 —— 看起来像"双击没反应"。
  await page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('#files-list .frow'));
    const hit = rows.find((r) => r.querySelector('.fname').textContent === n);
    if (hit) hit.scrollIntoView({ block: 'center' });
  }, mkName);
  await sleep(250);

  const enter = await page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('#files-list .frow'));
    const hit = rows.find((r) => r.querySelector('.fname').textContent === n);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  }, mkName);
  if (enter) {
    // 真实双击 = 先点一次（clickCount 1），再点一次（clickCount 2）。
    // 只发一次 clickCount:2 不会派发 dblclick —— 浏览器认定"之前那下没发生"。
    await page.mouse.click(enter.x, enter.y);
    await sleep(60);
    await page.mouse.click(enter.x, enter.y, { clickCount: 2 });
    await sleep(900);
    const inside = await page.evaluate((n) => ({
      path: document.getElementById('files-path').value,
      empty: !!document.querySelector('#files-list .files-hint')
    }), mkName);
    check('双击进入新建的目录', inside.path.endsWith(mkName), inside.path);
    check('空目录给了提示', inside.empty === true);
  }

  // ---------- 8. 开关状态落盘 ----------
  const st1 = await settings();
  check('打开状态已存到服务端', st1.filesOpen === true, JSON.stringify(st1.filesOpen));
  check('侧栏宽度也存了', st1.filesWidth === 300, String(st1.filesWidth));

  // ---------- 9. 刷新后仍然开着 ----------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2800);
  const afterReload = await page.evaluate(() => ({
    hidden: document.getElementById('files').hidden,
    rows: document.querySelectorAll('#files-list .frow').length
  }));
  check('刷新之后侧栏还是开着的', afterReload.hidden === false);
  check('刷新之后列表也重新读出来了', afterReload.rows > 0, `${afterReload.rows} 项`);

  // ---------- 10. 关掉，再刷一次应该保持关着 ----------
  await page.click('#files-close');
  await sleep(600);
  const st2 = await settings();
  check('关闭状态已存到服务端', st2.filesOpen === false, JSON.stringify(st2.filesOpen));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2600);
  const closedAgain = await page.evaluate(() => document.getElementById('files').hidden);
  check('刷新之后侧栏仍然是关的', closedAgain === true);

  // ---------- 11. 键盘快捷键也能开 ----------
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('f');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(800);
  const byKey = await page.evaluate(() => document.getElementById('files').hidden);
  check('Ctrl+Alt+F 能打开侧栏', byKey === false);

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.close();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('测试本身出错:', e && e.message);
  cleanup();
  process.exit(1);
});
