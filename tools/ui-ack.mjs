/*
 * 重连回放时"自动应答被当成键盘输入"的回归。
 *
 * 现象：每次重连（断线重连或刷新页面）都会冒出
 *   -bash: 1;2c: command not found
 *   -bash: 2c: command not found
 *
 * 根因：回放是把历史输出重演一遍，历史里可能留着程序当年发出的查询序列
 * （DA：ESC[c、DSR：ESC[6n）。xterm 不知道这是重演，按规矩应答，应答经
 * onData 走 INPUT 送进 PTY —— shell 收到就是一串命令。0.2.19 之前也有，
 * 只是那时候屏幕上更乱的东西把它盖住了。
 *
 * 这里不断页刷新，而是直接关掉 WebSocket 让前端自己重连：这样能挂住
 * session.send，精确看到"回放期间有没有字节被发回 PTY"。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const EDGE = process.env.TS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = process.env.TS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = ROOT + '\\.build\\tsd-test.exe';
const DATA = ROOT + '\\.build\\testdata-ack';
const PROFILE = ROOT + '\\.build\\edge-ack';
const PORT = 18148;
const DBG = 9354;
const URL = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (n, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

fs.rmSync(DATA, { recursive: true, force: true });

const tsd = spawn(EXE, ['--listen', `127.0.0.1:${PORT}`, '--base', '/', '--dev',
  '--data-dir', DATA, '--max-sessions', '4'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch (e) { } try { tsd.kill(); } catch (e) { } };
process.on('exit', cleanup);

(async () => {
  await sleep(2500);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DBG}`, defaultViewport: null });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 760 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2800);

  const text = () => page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    const t = s.term, b = t.buffer.active, out = [];
    for (let y = 0; y < t.rows; y++) {
      const l = b.getLine(b.viewportY + y);
      out.push(l ? l.translateToString(true) : '');
    }
    return out.join('\n');
  });

  const type = (s) => page.evaluate((cmd) => {
    window.__ts.app.activePane().session.send(1, new TextEncoder().encode(cmd));
  }, s);

  // 先挂观测：INPUT 发出去的字节，以及回放往 xterm 里写了什么。
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    window.__sent = [];
    const orig = s.send.bind(s);
    s.send = function (kind, payload) {
      try {
        if (kind === 1 && payload && payload.length) {
          let str = '';
          for (let i = 0; i < payload.length; i++) str += String.fromCharCode(payload[i]);
          window.__sent.push(str);
        }
      } catch (e) { }
      return orig(kind, payload);
    };
    window.__written = [];
    const ow = s.term.write.bind(s.term);
    s.term.write = function (data, cb) {
      try {
        let str = '';
        if (typeof data === 'string') str = data;
        else for (let i = 0; i < data.length; i++) str += String.fromCharCode(data[i]);
        window.__written.push(str);
      } catch (e) { }
      return ow(data, cb);
    };
  });

  // 让历史里带上一条 DA 查询。xterm 收到会应答，这次应答进的是 shell 的
  // stdin（真实终端也一样），用 Ctrl+C 清掉。测试跑在 Windows 上，默认
  // shell 是 PowerShell，没有 printf；用 [char]27 造 ESC。（真机上就是
  // bash 的 printf，发出去的序列完全一样。）
  //
  // 注意：ConPTY 会自己吃掉一部分查询序列，客户端未必收得到 ESC[c ——
  // 所以"回放里到底有没有 DA 查询"不能靠真实 shell 来保证，下面再单独
  // 造一帧确定性的回放来验证。
  await type('Write-Host -NoNewline ([char]27 + "[c")\r');
  await sleep(700);

  await type('\x03');           // Ctrl+C 清行
  await sleep(200);
  await type('echo __ACK_BEFORE__\r');
  await sleep(800);
  check('会话可以正常收发', /__ACK_BEFORE__/.test(await text()));

  // 清零：后面只看重连这一段。
  await page.evaluate(() => {
    window.__sent.length = 0;
    window.__written.length = 0;
    window.__replayAt0 = window.__ts.app.activePane().session.replayAt;
  });

  // 直接掐掉 WebSocket，让前端走自己的重连 + 回放。
  await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    s.ws.close();
  });
  await sleep(4000);

  const info = await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    return {
      sent: window.__sent || [],
      written: (window.__written || []).join(''),
      replayBefore: window.__replayAt0,
      replayAfter: s.replayAt,
      replayLen: s.lastReady ? s.lastReady.replayLen : -1,
      replaying: s.replaying,
      pending: s.replayPending,
    };
  });

  check('确实重连并回放了', info.replayAfter > info.replayBefore && info.replayLen > 0,
    `len=${info.replayLen} at=${info.replayAfter - info.replayBefore}ms`);

  const esc = info.sent.filter((s) => s.includes('\x1b['));
  check('真实重连期间没有自动应答漏出去', esc.length === 0, JSON.stringify(esc).slice(0, 160));
  check('回放结束后键盘没有卡住', info.replaying === false && info.pending === 0,
    `replaying=${info.replaying} pending=${info.pending}`);

  // ---------- 确定性的回放帧 ----------
  //
  // 上面那条依赖真实历史。ConPTY 会把 DA 查询自己吃掉，客户端收不到，
  // 所以这里直接按协议造一帧"回放中的输出"，里面带 ESC[c。回放窗口内的
  // 查询不能触发应答，否则应答就会变成 shell 的命令行。
  const forged = await page.evaluate(() => {
    const s = window.__ts.app.activePane().session;
    window.__sent.length = 0;
    window.__written.length = 0;
    const pay = new TextEncoder().encode('REPLAY_ACK_PROBE\x1b[c');
    s.replayPending = pay.length;
    s.replaying = false;
    const f = new Uint8Array(1 + pay.length);
    f[0] = 0x01;                    // KindOutput
    f.set(pay, 1);
    s.ws.onmessage({ data: f.buffer });
    return { wrote: (window.__written || []).join('') };
  });
  await sleep(400);
  const after = await page.evaluate(() => ({
    sent: window.__sent || [],
    replaying: window.__ts.app.activePane().session.replaying,
    pending: window.__ts.app.activePane().session.replayPending,
  }));
  check('伪造的回放帧确实写进去了', forged.wrote.indexOf('REPLAY_ACK_PROBE\x1b[c') >= 0,
    JSON.stringify(forged.wrote.slice(0, 60)));
  const acks = after.sent.filter((s) => s.indexOf('\x1b') >= 0);
  check('回放窗口内不给 DA 查询应答', acks.length === 0, JSON.stringify(acks).slice(0, 160));
  check('回放窗口结束后自动解锁', after.replaying === false && after.pending === 0,
    `replaying=${after.replaying} pending=${after.pending}`);

  // 键盘还能正常用
  await type('echo __ACK_AFTER__\r');
  await sleep(900);
  const t2 = await text();
  check('重连后输入照常执行', /__ACK_AFTER__/.test(t2));
  check('屏幕上没有串进命令报错', !/1;2c: command not found|2c: command not found/.test(t2));

  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  await browser.disconnect();
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); cleanup(); process.exit(1); });
