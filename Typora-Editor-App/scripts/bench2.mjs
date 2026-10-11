// 大文件基准 v2：页内精确计时（消除 CDP 轮询噪声）
const CDP = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const call = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, (r) => res(r)); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expression, awaitPromise = false) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'exc');
  return r.result?.value;
});

// --- 0) 文档当前状态 ---
const info = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const s = d.querySelector('.vditor-ir .vditor-reset');
  return {
    textLen: (d.body.innerText || '').length,
    nodes: d.querySelectorAll('*').length,
    katex: d.querySelectorAll('.katex').length,
    scrollMax: Math.round((s?.scrollHeight||0) - (s?.clientHeight||0)),
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1,
  };
})()`);
console.log('文档状态:', JSON.stringify(info));

// --- 1) 输入延迟（页内 rAF 精确计时） ---
const marker = 'BENCHXYZ';
// 装好页内探针后再输入
await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  const d = w.document;
  w.__bench = null;
  const t0 = w.performance.now();
  const check = () => {
    if (d.body.innerText.includes('${marker}')) {
      w.__bench = Math.round(w.performance.now() - t0);
      return;
    }
    w.requestAnimationFrame(check);
  };
  w.requestAnimationFrame(check);
})()`);
await ev('document.getElementById("editor").contentWindow.focus()');
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 854, y: 200, button: 'left', clickCount: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 854, y: 200, button: 'left', clickCount: 1 });
await call('Input.insertText', { text: marker });
await sleep(3000);
const inputMs = await ev(`document.getElementById('editor').contentWindow.__bench`);
console.log(`输入到 DOM 出现（页内精确）: ${inputMs}ms`);
// 撤销
await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await sleep(1500);

// --- 2) 滚动流畅度：2 秒连续滚轮期间统计帧率 ---
await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  w.__fps = { frames: 0, start: 0, done: false };
  const loop = () => {
    if (!w.__fps.start) w.__fps.start = w.performance.now();
    if (w.performance.now() - w.__fps.start < 2000) { w.__fps.frames++; w.requestAnimationFrame(loop); }
    else w.__fps.done = true;
  };
  w.requestAnimationFrame(loop);
})()`);
const box = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
for (let i = 0; i < 40; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 200 }); await sleep(30); }
await sleep(2500);
const fps = await ev(`document.getElementById('editor').contentWindow.__fps`);
const fpsVal = fps && fps.frames ? Math.round(fps.frames / 2) : -1;
console.log(`滚动期间帧率(页内 rAF): ${fpsVal} fps (${fps?.frames} 帧/2s)`);

// --- 3) 单次跳顶/跳底（Home/End 类操作） ---
const jump = await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  const s = w.document.querySelector('.vditor-ir .vditor-reset');
  const t0 = w.performance.now();
  s.scrollTop = s.scrollHeight;
  // 强制同步布局，测一次完整 reflow
  void s.offsetHeight;
  const reflow = Math.round(w.performance.now() - t0);
  return { reflowMs: reflow, top: Math.round(s.scrollTop) };
})()`);
console.log(`跳底+强制回流: ${jump.reflowMs}ms`);

console.log('DONE');
ws.close();
process.exit(0);
