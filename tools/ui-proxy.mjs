/*
 * 反代场景回归：网关把 Host 的端口吃掉时，WebSocket 还得能连上。
 *
 * 这是 0.2.6 修的那个 bug 的现场。飞牛的局域网入口是 http://<ip>:5666，
 * nginx 用 proxy_set_header Host $host; 转发（$host 不含端口），而后端用
 * Origin 和 Host 逐字比来防跨站，于是把"本机页面"判成了"跨站"——表现就是
 * "远程访问能用，局域网一直显示未连接"。
 *
 * 其它测试都是直连服务，走不到这条路径，所以单独拉一个最小反代来复现。
 * 注意：必须用不加 --dev 的二进制，--dev 会把来源校验整个放开，测了等于没测。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

// 浏览器路径：TS_EDGE 可覆盖。
const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 项目根：脚本都在 tools/ 下，默认取上一级，换机器不用改（TS_ROOT 可覆盖）。
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-proxy';
const BACKEND = 18092;
const FRONT = 5667;
const BASE = `http://127.0.0.1:${FRONT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// ---- 反代：唯一的作用是把 Host 改成不带端口的形式 ----
const proxy = http.createServer((req, res) => {
  const up = http.request({
    host: '127.0.0.1', port: BACKEND, path: req.url, method: req.method,
    headers: { ...req.headers, host: '127.0.0.1' }
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.destroy());
  req.pipe(up);
});

proxy.on('upgrade', (req, socket, head) => {
  const up = http.request({
    host: '127.0.0.1', port: BACKEND, path: req.url,
    headers: { ...req.headers, host: '127.0.0.1' }
  });
  up.on('upgrade', (res, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      socket.write(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`);
    }
    socket.write('\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  up.on('response', (res) => {
    socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
    socket.destroy();
  });
  up.on('error', () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
});

// ---- 起服务 ----
let child = null;
async function startServer() {
  child = spawn(EXE, [
    '--listen', `127.0.0.1:${BACKEND}`,
    '--base', '/',
    '--data-dir', DATA,
    '--max-sessions', '4'
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${BACKEND}/api/healthz`, { cache: 'no-store' });
      if (r.ok) return true;
    } catch (e) { }
    await sleep(200);
  }
  return false;
}

const up = await startServer();
check('测试服务已启动', up);
if (!up) process.exit(1);
await new Promise((r) => proxy.listen(FRONT, '127.0.0.1', r));

// ---- 1. 服务端的来源判定 ----
const wsc = await fetch(BASE + 'api/wscheck', {
  headers: { Origin: `http://127.0.0.1:${FRONT}` }
}).then((r) => r.json()).catch(() => null);
const d = wsc && wsc.data;
check('wscheck 经反代也能通', !!d);
check('判定为同站', d && d.verdict === 'same', d ? `host=${d.host} origin=${d.origin}` : '');
check('Host 确实被去掉了端口', d && d.host === '127.0.0.1', d ? d.host : '');

// ---- 2. 浏览器真的连上 ----
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--window-size=1280,800']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane.focused', { timeout: 15000 });
await sleep(2500);

const state = await page.evaluate(() => {
  const pane = document.querySelector('.pane');
  const st = window.__ts.app.activePane().session;
  const b = st.term.buffer.active;
  let text = '';
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line) text += line.translateToString(true) + '\n';
  }
  return {
    text: document.getElementById('statustext').textContent,
    pane: pane ? pane.dataset.state : 'none',
    sid: st.sid,
    chars: text.trim().length
  };
});
check('状态栏显示已连接', state.text === '已连接', state.text);
check('窗格状态是 online', state.pane === 'online', state.pane);
check('会话里有输出（shell 真的跑起来了）', !!state.sid && state.chars > 0,
  `sid=${state.sid} chars=${state.chars}`);

// ---- 3. 断开时不该冒出"网关"那一行（来源是对的） ----
const gwHidden = await page.evaluate(() => {
  const el = document.getElementById('ct-gw');
  return !el || el.hidden;
});
check('网关诊断行保持隐藏', gwHidden);

await browser.close();
child.kill();
proxy.close();

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
