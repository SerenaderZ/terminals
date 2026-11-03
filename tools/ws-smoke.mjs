// WebSocket 链路的端到端冒烟测试：连上去 → 输入一条命令 → 确认输出回来了。
//
// 判断标准是标记出现两次：一次是 shell 回显我们敲的命令，一次是命令真正执行的结果。
// 只看一次的话，本地回显会造成假阳性。

const url = process.argv[2] || 'ws://127.0.0.1:18088/api/ws?cols=100&rows=30';
const MARK = 'TS-SMOKE-OK';

function frame(kind, payload) {
  const f = new Uint8Array(payload.length + 1);
  f[0] = kind;
  f.set(payload, 1);
  return f;
}

const dec = new TextDecoder();
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

let ready = null;
let out = '';
let exitCode = null;

const timer = setTimeout(() => {
  console.log('TIMEOUT');
  console.log('ready =', JSON.stringify(ready));
  console.log('exitCode =', exitCode);
  console.log('output tail =', JSON.stringify(out.slice(-400)));
  process.exit(1);
}, 20000);

ws.onopen = () => {
  // 等 shell 把提示符画完再输入
  setTimeout(() => {
    ws.send(frame(0x01, new TextEncoder().encode(`echo ${MARK}\r`)));
  }, 500);
};

ws.onmessage = (ev) => {
  const buf = new Uint8Array(ev.data);
  const kind = buf[0];
  const payload = buf.subarray(1);

  if (kind === 0x03) {
    ready = JSON.parse(dec.decode(payload));
    return;
  }
  if (kind === 0x01) {
    out += dec.decode(payload);
    const hits = out.split(MARK).length - 1;
    if (hits >= 2) {
      clearTimeout(timer);
      console.log('PASS');
      console.log('  sid   =', ready && ready.sid);
      console.log('  shell =', ready && ready.shell);
      console.log('  pid   =', ready && ready.pid);
      console.log('  size  =', ready && `${ready.cols}x${ready.rows}`);
      ws.close();
      process.exit(0);
    }
    return;
  }
  if (kind === 0x02) {
    exitCode = JSON.parse(dec.decode(payload));
    clearTimeout(timer);
    console.log('FAIL: 会话提前退出', JSON.stringify(exitCode));
    process.exit(1);
  }
  if (kind === 0x04) {
    console.log('FAIL: 服务端错误:', dec.decode(payload));
    process.exit(1);
  }
};

ws.onerror = () => {
  console.log('FAIL: WebSocket 连接失败');
  process.exit(1);
};
