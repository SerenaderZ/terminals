/*
 * Ctrl+V 的"真实按键"回归（需要真实窗口）。
 *
 * headless Chrome 的系统剪贴板是隔离的：keydown 之后 paste 事件照样派发，
 * 但 clipboardData 是空的，所以 ui-clip.mjs 里"真的粘进去了吗"这一步只能
 * 跳过。这里用有窗口的浏览器跑同一条路径，把最后一步补上：
 *
 *   1. 按一次 Ctrl+V，终端里应出现剪贴板里的文字；
 *   2. PTY 不应额外收到 0x16（^V）—— xterm 以前会把它当普通输入发出去，
 *      而同一次按键浏览器又在粘贴，等于一次按键干了两件事。
 *
 * 会弹出一个浏览器窗口，跑完自动关。串行跑，别和别的 ui-* 同时开。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// 浏览器路径：TS_EDGE 可覆盖。
const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 项目根：脚本都在 tools/ 下，默认取上一级，换机器不用改（TS_ROOT 可覆盖）。
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-clip';
const PORT = 18099;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const child = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });

const origin = `http://127.0.0.1:${PORT}/`;
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(origin + 'api/healthz'); if (r.ok) { up = true; break; } } catch (e) { }
  await sleep(250);
}
if (!up) { console.log('SKIP  服务没起来'); child.kill(); process.exit(0); }

const browser = await puppeteer.launch({ executablePath: EDGE, headless: false,
  args: ['--no-first-run', '--window-size=1280,800'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.goto(origin, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(2000);

await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  window.__sent = [];
  const orig = st.send;
  st.send = function (type, data) {
    if (type === 1) window.__sent.push(Array.from(data).slice(0, 60));
    return orig.apply(this, arguments);
  };
});

execSync('echo CLIP_HEADFUL_7Q|clip', { shell: 'C:\\Windows\\System32\\cmd.exe' });
await page.click('.pane.focused .terminal-host');
await sleep(300);
await page.evaluate(() => { window.__sent = []; });
await page.keyboard.down('Control');
await page.keyboard.press('v');
await page.keyboard.up('Control');
await sleep(2000);

const sent = await page.evaluate(() => window.__sent);
check('Ctrl+V 不再向 PTY 多发一个 ^V', !sent.some((b) => b.includes(22)), JSON.stringify(sent));

const got = await page.evaluate(() => {
  const b = window.__ts.app.activePane().session.term.buffer.active;
  let text = '';
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line) text += line.translateToString(true) + '\n';
  }
  return text.includes('CLIP_HEADFUL_7Q');
});
check('Ctrl+V 真的把系统剪贴板送进了终端', got);

await browser.close();
child.kill();

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
