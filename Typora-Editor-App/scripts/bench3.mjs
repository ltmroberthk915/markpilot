// 完整基准 v3：从应用启动开始计时（打开耗时/输入延迟/滚动帧率/回流）
const CDP = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TAIL = 'A.7.3 补登记';
const t0 = Date.now();

// 轮询等 CDP + shell 页
let page = null;
let ws = null;
for (let i = 0; i < 120; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
    if (page) break;
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!page) { console.log('FAIL: shell never appeared'); process.exit(1); }
const tShell = Date.now() - t0;
ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const call = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, (r) => res(r)); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expression) => call('Runtime.evaluate', { expression, returnByValue: true }).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'exc');
  return r.result?.value;
});

// 打开耗时：vditor 初始化完成 + 尾标记进入 DOM
let tVditor = -1;
let tFull = -1;
for (let i = 0; i < 900; i++) {
  const st = await ev(`(() => {
    const d = document.getElementById('editor')?.contentDocument;
    if (!d) return 0;
    if (!d.querySelector('.vditor')) return 0;
    const t = d.body.innerText || '';
    if (t.includes('${TAIL}')) return 2;
    return 1;
  })()`);
  if (st >= 1 && tVditor < 0) tVditor = Date.now() - t0;
  if (st === 2) { tFull = Date.now() - t0; break; }
  await sleep(100);
}
console.log(`shell 页出现: ${tShell}ms`);
console.log(`vditor 初始化(编辑器可交互): ${tVditor >= 0 ? tVditor + 'ms' : 'TIMEOUT'}`);
console.log(`全文进入 DOM(含尾标记): ${tFull >= 0 ? tFull + 'ms' : 'TIMEOUT'}`);

// DOM 规模与内存
const info = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  return {
    nodes: d.querySelectorAll('*').length,
    katex: d.querySelectorAll('.katex').length,
    textLen: (d.body.innerText || '').length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1,
  };
})()`);
console.log('DOM 规模:', JSON.stringify(info));

// 输入延迟（页内 rAF 计时）
const marker = 'BENCHXYZ';
await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  const d = w.document;
  w.__bench = null;
  const t0 = w.performance.now();
  const check = () => {
    if (d.body.innerText.includes('${marker}')) { w.__bench = Math.round(w.performance.now() - t0); return; }
    w.requestAnimationFrame(check);
  };
  w.requestAnimationFrame(check);
})()`);
const box = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + 150)}; })()`);
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await call('Input.insertText', { text: marker });
await sleep(3000);
const inputMs = await ev(`document.getElementById('editor').contentWindow.__bench`);
console.log(`输入→DOM 出现(页内精确): ${inputMs}ms`);
await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await sleep(1500);

// 滚动帧率：页内统计 2 秒 rAF，期间连续滚轮
await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  w.__fps = { frames: 0, start: 0 };
  const loop = () => {
    if (!w.__fps.start) w.__fps.start = w.performance.now();
    if (w.performance.now() - w.__fps.start < 2000) { w.__fps.frames++; w.requestAnimationFrame(loop); }
  };
  w.requestAnimationFrame(loop);
})()`);
for (let i = 0; i < 40; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: 380, deltaX: 0, deltaY: 200 }); await sleep(30); }
await sleep(2500);
const fps = await ev(`document.getElementById('editor').contentWindow.__fps`);
console.log(`滚动期间帧率: ${fps?.frames ? Math.round(fps.frames / 2) : '?'} fps (${fps?.frames} 帧 / 2s)`);

// 单次强制回流
const reflow = await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  const s = w.document.querySelector('.vditor-ir .vditor-reset');
  const t0 = w.performance.now();
  s.scrollTop = s.scrollHeight;
  void s.offsetHeight;
  return Math.round(w.performance.now() - t0);
})()`);
console.log(`跳底+强制回流: ${reflow}ms`);

console.log('DONE');
ws.close();
process.exit(0);
