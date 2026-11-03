// 验证会话保活与回放：
//   1. 建一个会话，跑一条命令留下标记
//   2. 断开连接（模拟关页面）
//   3. 用同一个 sid 重连
//   4. 必须拿到同一个 sid，且回放里能看到断开前的那条命令
//   5. 重连后还能继续输入
//
// 这是整个项目的立身之本，失败就说明"刷新页面会话还在"是假的。

const base = process.argv[2] || 'ws://127.0.0.1:18088/api/ws';
const MARK1 = 'PERSIST-MARK-ONE';
const MARK2 = 'PERSIST-MARK-TWO';

const dec = new TextDecoder();
const enc = new TextEncoder();

function frame(kind, payload) {
  const f = new Uint8Array(payload.length + 1);
  f[0] = kind;
  f.set(payload, 1);
  return f;
}

// 建一条连接，返回 { ready, output, waitFor, close, send }
function open(sid, cols, rows) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ cols: String(cols || 100), rows: String(rows || 30) });
    if (sid) q.set('sid', sid);
    const ws = new WebSocket(`${base}?${q}`);
    ws.binaryType = 'arraybuffer';

    const state = { ready: null, output: '', ws };

    const to = setTimeout(() => reject(new Error('连接超时')), 15000);

    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      const kind = buf[0];
      const payload = buf.subarray(1);
      if (kind === 0x03) {
        state.ready = JSON.parse(dec.decode(payload));
        clearTimeout(to);
        resolve(state);
      } else if (kind === 0x01) {
        state.output += dec.decode(payload);
      } else if (kind === 0x04) {
        clearTimeout(to);
        reject(new Error(dec.decode(payload)));
      }
    };
    ws.onerror = () => reject(new Error('连接失败'));
  });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时: ${label}`);
}

function send(state, text) {
  state.ws.send(frame(0x01, enc.encode(text)));
}

(async () => {
  // 1. 建会话
  const a = await open(null);
  const sid = a.ready.sid;
  console.log('步骤1 建立会话 sid =', sid);

  await new Promise((r) => setTimeout(r, 600));
  send(a, `echo ${MARK1}\r`);
  await waitFor(() => a.output.split(MARK1).length - 1 >= 2, 8000, '第一条命令执行');

  // 2. 断开
  a.ws.close();
  console.log('步骤2 已断开连接');
  await new Promise((r) => setTimeout(r, 800));

  // 检查服务端仍然持有这个会话
  const httpBase = base.replace(/^ws/, 'http').replace(/\/api\/ws.*$/, '');
  const list = await (await fetch(`${httpBase}/api/sessions`)).json();
  const found = (list.data || []).find((s) => s.sid === sid);
  if (!found) throw new Error('会话在断开后就消失了 —— 保活失败');
  if (!found.alive) throw new Error('会话已退出，保活失败');
  console.log('步骤3 服务端仍在持有该会话，clients =', found.clients);

  // 3. 重连
  const b = await open(sid);
  if (b.ready.sid !== sid) {
    throw new Error(`重连拿到了新的 sid（${b.ready.sid}），说明没有续上原会话`);
  }
  console.log('步骤4 重连成功，sid 与原会话一致');

  // 4. 回放里必须有断开前的内容
  await waitFor(() => b.output.includes(MARK1), 5000, '断开前的回放内容');
  console.log('步骤5 回放里包含断开前的输出，长度 =', b.output.length);

  // 5. 重连后能继续输入
  send(b, `echo ${MARK2}\r`);
  await waitFor(() => b.output.split(MARK2).length - 1 >= 2, 8000, '重连后的输入');
  console.log('步骤6 重连后输入正常');

  b.ws.close();
  console.log('\nPASS: 会话保活与回放验证通过');
  process.exit(0);
})().catch((e) => {
  console.log('\nFAIL:', e.message);
  process.exit(1);
});
