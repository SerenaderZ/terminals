/*
 * 非安全上下文（http + 局域网 IP）下的粘贴路径。
 *
 * 浏览器只在安全上下文里给 navigator.clipboard：HTTPS，或 http://localhost。
 * 飞牛的局域网入口是 http://<ip>:5666，两个条件都不满足，于是
 * navigator.clipboard 是 undefined，document.execCommand('paste') 也被禁。
 * 这不是实现缺陷，是浏览器的硬限制 —— 网页没有任何接口能主动读剪贴板。
 *
 * 唯一还能用的通道是"浏览器自己执行粘贴"：用户按键（Ctrl+V / Shift+Insert /
 * Ctrl+Shift+V）或右键菜单里的"粘贴"。浏览器在执行粘贴时把 clipboardData
 * 通过 paste 事件交给焦点元素，这条在 http 下照样成立。
 *
 * 所以应用要做的不是"想办法读"，而是**别拦**：所有原生粘贴入口一律放行，
 * 右键在非安全上下文下也不 preventDefault，让原菜单出来。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import os from 'node:os';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

// 浏览器路径：TS_EDGE 可覆盖。
const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 项目根：脚本都在 tools/ 下，默认取上一级，换机器不用改（TS_ROOT 可覆盖）。
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-clip';
const PORT = 18093;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// ---- 找一个能访问的局域网地址：127.0.0.1 是安全上下文，测不出问题 ----
function lanCandidates() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const child = spawn(EXE, [
  '--listen', `0.0.0.0:${PORT}`,
  '--base', '/',
  '--dev',
  '--data-dir', DATA,
  '--max-sessions', '4'
], { stdio: 'ignore' });

let origin = null;
for (let i = 0; i < 60; i++) {
  for (const ip of lanCandidates()) {
    try {
      const r = await fetch(`http://${ip}:${PORT}/api/healthz`, { cache: 'no-store' });
      if (r.ok) { origin = `http://${ip}:${PORT}/`; break; }
    } catch (e) { }
  }
  if (origin) break;
  await sleep(250);
}
if (!origin) {
  console.log('SKIP  找不到可访问的局域网地址（或服务没起来）');
  child.kill();
  process.exit(0);
}
console.log('访问地址:', origin);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--window-size=1280,800']
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 1280, height: 800 });
await page.goto(origin, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(1800);

// ---- 0. 确认这确实是"非安全上下文" ----
const env = await page.evaluate(() => ({
  secure: window.isSecureContext,
  hasClipboard: !!navigator.clipboard
}));
check('页面确实是非安全上下文', env.secure === false, `isSecureContext=${env.secure}`);
check('navigator.clipboard 不存在', env.hasClipboard === false);

// 捕获阶段记录，xterm 的 textarea 即使 stopPropagation 也拦不住这个。
await page.evaluate(() => {
  window.__keys = [];
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Insert' || e.key === 'v' || e.key === 'V') {
      window.__keys.push({ key: e.key, shift: e.shiftKey, prevented: e.defaultPrevented });
    }
  }, true);
});

const bannerText = () => page.evaluate(() => {
  const el = document.getElementById('banner');
  return el.hidden ? '' : el.textContent;
});

// ---- 1. 右键：什么都没复制过时，必须把原生菜单放出来 ----
// 没有可用的内部内容，浏览器原生菜单是唯一能粘外部内容的路径。
// 我们一旦 preventDefault，菜单就不会出现，这条路直接被堵死。
await page.evaluate(() => {
  window.__ctx = null;
  document.addEventListener('contextmenu', (e) => {
    // 捕获阶段先记一笔，app.js 的处理器在冒泡阶段跑，这里只记原始状态。
  }, true);
  const host = document.querySelector('.pane.focused .terminal-host');
  host.addEventListener('contextmenu', (e) => {
    // 冒泡到 host 之后（app.js 的监听在 host 上，先注册先跑），
    // 用一个 setTimeout 读最终结果。
    setTimeout(() => { window.__ctx = { prevented: e.defaultPrevented }; }, 0);
  });
});
const box = await page.$eval('.pane.focused .terminal-host', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.click(box.x, box.y, { button: 'right' });
await sleep(400);
const ctx = await page.evaluate(() => window.__ctx);
check('右键没有被 preventDefault（原生菜单能弹出来）', ctx && ctx.prevented === false,
  ctx ? `prevented=${ctx.prevented}` : '没捕到事件');

const ta = await page.evaluate(() => {
  const t = document.querySelector('.pane.focused .xterm-helper-textarea');
  if (!t) return null;
  return {
    focused: document.activeElement === t,
    readOnly: t.readOnly,
    tabIndex: t.tabIndex
  };
});
check('焦点落在 xterm 的隐藏输入框上', !!ta && ta.focused === true,
  ta ? `focused=${ta.focused}` : '找不到 textarea');
check('隐藏输入框可写（原生「粘贴」不会变灰）', !!ta && ta.readOnly === false,
  ta ? `readOnly=${ta.readOnly} tabIndex=${ta.tabIndex}` : '');

// ---- 2. 有选区右键 = 复制，清掉选区再右键 = 粘贴 ----
// http 下粘的是"应用内剪贴板"：本页刚复制的那段文字。内容一定对，
// 因为就是用户刚刚拿走的东西。
await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  st.term.paste('echo CLIP_INNER_5X');
  st.term.paste('\r');
});
await sleep(1200);

const picked = await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  const b = st.term.buffer.active;
  const needle = 'CLIP_INNER_5X';
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const txt = line.translateToString(true);
    const x = txt.indexOf(needle);
    if (x >= 0) {
      st.term.select(x, y, needle.length);
      return st.term.getSelection();
    }
  }
  return '';
});
check('选中了一段可识别的文字', picked === 'CLIP_INNER_5X', JSON.stringify(picked));

await page.mouse.click(box.x, box.y, { button: 'right' });
await sleep(400);
const ctxCopy = await page.evaluate(() => window.__ctx);
const copyTip = await bannerText();
check('有选区右键 = 复制（拦掉原生菜单）', ctxCopy && ctxCopy.prevented === true,
  ctxCopy ? `prevented=${ctxCopy.prevented}` : '没捕到事件');
check('复制后给出提示', /已复制/.test(copyTip), copyTip);

// 左键点一下终端，清掉选区
await page.mouse.click(box.x + 40, box.y + 60);
await sleep(400);
const cleared = await page.evaluate(() => window.__ts.app.activePane().session.term.getSelection());
check('左键点击后选区已清空', cleared === '', JSON.stringify(cleared));

await page.mouse.click(box.x, box.y, { button: 'right' });
await sleep(600);
const ctxPaste = await page.evaluate(() => window.__ctx);
const pasteTip = await bannerText();
check('无选区右键 = 粘贴（不再弹原生菜单）', ctxPaste && ctxPaste.prevented === true,
  ctxPaste ? `prevented=${ctxPaste.prevented}` : '没捕到事件');
check('提示说明粘的是终端内复制的内容', /已粘贴终端内复制的/.test(pasteTip), pasteTip);

const pastedLine = await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  const b = st.term.buffer.active;
  const y = b.baseY + b.cursorY;
  const line = b.getLine(y);
  return line ? line.translateToString(true) : '';
});
check('粘贴的内容出现在命令行上', pastedLine.includes('CLIP_INNER_5X'), JSON.stringify(pastedLine));

// ---- 3. 页面失焦后作废：宁可弹菜单，也不能粘旧内容 ----
// 用户切到别的窗口，很可能复制了别的东西；这时粘上一段陈年文字比多点一次更糟。
await page.evaluate(() => { window.dispatchEvent(new Event('blur')); });
await page.mouse.click(box.x, box.y, { button: 'right' });
await sleep(400);
const ctxBlur = await page.evaluate(() => window.__ctx);
check('离开过页面后不再粘旧内容（改弹原生菜单）', ctxBlur && ctxBlur.prevented === false,
  ctxBlur ? `prevented=${ctxBlur.prevented}` : '没捕到事件');

// 把刚粘贴进去的半截命令清掉，免得影响后面的键盘测试
await page.click('.pane.focused .terminal-host');
await page.keyboard.down('Control');
await page.keyboard.press('c');
await page.keyboard.up('Control');
await sleep(300);

// ---- 4. Ctrl+Shift+V：放行，让浏览器当"粘贴为纯文本"处理 ----
await page.evaluate(() => { window.__keys = []; });
await page.click('.pane.focused .terminal-host');
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('v');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
await sleep(400);
const csv = await page.evaluate(() => window.__keys.find((k) => (k.key === 'v' || k.key === 'V') && k.shift));
check('Ctrl+Shift+V 没有被 preventDefault', csv && csv.prevented === false,
  csv ? `prevented=${csv.prevented}` : '没捕到事件');

// ---- 3. 原生粘贴键必须放行 ----
await page.evaluate(() => { window.__keys = []; });
await page.keyboard.down('Shift');
await page.keyboard.press('Insert');
await page.keyboard.up('Shift');
await sleep(300);
const ins = await page.evaluate(() => window.__keys.find((k) => k.key === 'Insert'));
check('Shift+Insert 没有被 preventDefault', ins && ins.prevented === false,
  ins ? `prevented=${ins.prevented}` : '没捕到事件');

await page.evaluate(() => { window.__keys = []; });
await page.keyboard.down('Control');
await page.keyboard.press('v');
await page.keyboard.up('Control');
await sleep(300);
const cv = await page.evaluate(() => window.__keys.find((k) => k.key === 'v' || k.key === 'V'));
check('Ctrl+V 没有被 preventDefault', cv && cv.prevented === false,
  cv ? `prevented=${cv.prevented}` : '没捕到事件');

// ---- 4. 真的按 Ctrl+V 能把系统剪贴板送进终端 ----
// 同时守住一个容易回归的点：xterm 默认把 Ctrl+V 当 0x16 发给 PTY，
// 而同一次按键浏览器又在粘贴 —— 终端会多收一个 ^V（vim 里还会进块选择）。
// 现在已经让 xterm 不处理这个键，PTY 必须只收到粘贴的文本。
await page.evaluate(() => {
  const st = window.__ts.app.activePane().session;
  window.__sent = [];
  if (!st.__hooked) {
    const orig = st.send;
    st.send = function (type, data) {
      if (type === 1) window.__sent.push(Array.from(data).slice(0, 60));
      return orig.apply(this, arguments);
    };
    st.__hooked = true;
  }
});

try {
  execSync('echo CLIP_TEST_9F3A|clip', { shell: 'C:\\Windows\\System32\\cmd.exe' });
  await page.click('.pane.focused .terminal-host');
  await sleep(300);
  await page.evaluate(() => { window.__sent = []; });
  await page.keyboard.down('Control');
  await page.keyboard.press('v');
  await page.keyboard.up('Control');
  await sleep(1500);

  const sent = await page.evaluate(() => window.__sent);
  const hasCtrlV = sent.some((b) => b.includes(22));
  check('Ctrl+V 不再向 PTY 多发一个 ^V', !hasCtrlV, JSON.stringify(sent));

  const got = await page.evaluate(() => {
    const st = window.__ts.app.activePane().session;
    const b = st.term.buffer.active;
    let text = '';
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (line) text += line.translateToString(true) + '\n';
    }
    return text.includes('CLIP_TEST_9F3A');
  });
  // headless 下浏览器不给 paste 事件填 clipboardData（系统剪贴板是隔离的），
  // 这时"粘上没粘上"测不出来，但上面那条 ^V 断言仍然有效。
  // 真实窗口里这一段是通的，用 tools/ui-clip-headful.mjs 复测。
  if (got) check('Ctrl+V 真的把系统剪贴板送进了终端', true);
  else console.log('SKIP  Ctrl+V 实粘（headless 剪贴板隔离，用 ui-clip-headful.mjs 复测）');
} catch (e) {
  console.log('SKIP  Ctrl+V 实粘（拿不到系统剪贴板）:', e.message.slice(0, 60));
}

await browser.close();
child.kill();

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
