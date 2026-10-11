// 输入卡顿归因：CDP Profiler 抓 insertText 期间的热点函数
const CDP = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  else if (m.method) events.push(m);
};
await new Promise((r) => (ws.onopen = r));
const call = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, (r) => res(r)); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expression) => call('Runtime.evaluate', { expression, returnByValue: true }).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'exc');
  return r.result?.value;
});

// 回到文档顶部，准备插入
await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const s = d.querySelector('.vditor-ir .vditor-reset');
  s.scrollTop = 0;
  return true;
})()`);
await sleep(600);

// 页内探针：插入→DOM 出现
const marker = 'PROFXYZ';
await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  w.__bench = null;
  const t0 = w.performance.now();
  const check = () => {
    if (w.document.body.innerText.includes('${marker}')) { w.__bench = Math.round(w.performance.now() - t0); return; }
    w.requestAnimationFrame(check);
  };
  w.requestAnimationFrame(check);
})()`);
await ev('document.getElementById("editor").contentWindow.focus()');

// 开启 profiler（覆盖 iframe 同进程）
await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 10 }); // 10us 采样
await call('Profiler.start');
const tIns = Date.now();
await call('Input.insertText', { text: marker });
// 等 DOM 出现或最多 30s
let ms = null;
for (let i = 0; i < 300; i++) {
  ms = await ev(`document.getElementById('editor').contentWindow.__bench`);
  if (ms !== null && ms !== undefined) break;
  await sleep(100);
}
console.log(`输入→DOM 出现: ${ms}ms (wall ${Date.now() - tIns}ms)`);
const { profile } = await call('Profiler.stop', undefined);

// 撤销插入
await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });

// 解析 profile：自顶向下按函数聚合 hit
const nodes = new Map();
for (const n of profile.nodes) nodes.set(n.id, n.callFrame);
const hits = new Map();
// samples: node id per sample; timeDeltas: us
let totalUs = 0;
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] || 0;
  totalUs += dt;
  hits.set(id, (hits.get(id) || 0) + dt);
});
const byFunc = new Map();
for (const [id, us] of hits) {
  const cf = nodes.get(id) || { functionName: '?', url: '' };
  const key = (cf.functionName || '(anonymous)') + ' @ ' + (cf.url || '').split('/').slice(-1)[0];
  byFunc.set(key, (byFunc.get(key) || 0) + us);
}
const top = [...byFunc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`\nProfiler 总采样时长: ${(totalUs / 1e6).toFixed(1)}s，热点函数 Top15:`);
for (const [fn, us] of top) console.log(`  ${(us / 1e6).toFixed(2)}s  ${(us / totalUs * 100).toFixed(1)}%  ${fn}`);
ws.close();
process.exit(0);
