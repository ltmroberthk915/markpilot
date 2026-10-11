// 诊断：真实点击一个公式后，解剖 DOM 与选区，找到"源码已打开"的可靠信号
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
const ev = (expression) => call('Runtime.evaluate', { expression, returnByValue: true }).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'exc');
  return r.result?.value;
});

// 滚到 75%
await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const s = d.querySelector('.vditor-ir .vditor-reset');
  s.scrollTop = (s.scrollHeight - s.clientHeight) * 0.75;
})()`);
await sleep(2000);

const target = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const vw = d.defaultView;
  const all = [...d.querySelectorAll('.katex')];
  const vis = all.filter(k => { const r = k.getBoundingClientRect(); return r.top > 60 && r.bottom < vw.innerHeight - 40 && r.height > 5; });
  if (!vis.length) return null;
  const k = vis[Math.floor(vis.length / 2)];
  const r = k.getBoundingClientRect();
  const lm = k.closest('.language-math');
  return {
    x: Math.round(r.x + Math.min(20, r.width / 2)), y: Math.round(r.y + r.height / 2),
    lmHtmlBefore: lm ? lm.outerHTML.slice(0, 260) : null,
    lmCls: lm?.className, lmParentCls: lm?.parentElement?.className,
  };
})()`);
console.log('目标公式:', JSON.stringify(target, null, 1));

// 记录点击时间戳（页内）
await ev(`document.getElementById('editor').contentWindow.__t0 = document.getElementById('editor').contentWindow.performance.now()`);
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
await sleep(2500);

const after = await ev(`(() => {
  const w = document.getElementById('editor').contentWindow;
  const d = w.document;
  const sel = w.getSelection();
  const anchor = sel && sel.anchorNode;
  const info = (n) => n ? { type: n.nodeType, name: n.nodeName, cls: (n.parentElement && n.parentElement.className || '').toString().slice(0, 60), text: (n.textContent || '').slice(0, 50), caretIn: null } : null;
  const lm = d.querySelectorAll('.language-math');
  return {
    elapsedMs: Math.round(w.performance.now() - w.__t0),
    selection: info(anchor),
    rangeCount: sel ? sel.rangeCount : 0,
    mathCount: lm.length,
    // 第一个"展开态"的公式（若有）
    expanded: [...d.querySelectorAll('.vditor-ir__node--expand, [data-typora-source-start]')].length,
    markers: d.querySelectorAll('.vditor-ir__marker').length,
    sampleExpandedHtml: (() => {
      const e = d.querySelector('.language-math.vditor-ir__node--expand, .vditor-ir__node--expand .language-math');
      return e ? e.outerHTML.slice(0, 300) : null;
    })(),
  };
})()`);
console.log('点击后状态:', JSON.stringify(after, null, 1));
ws.close();
process.exit(0);
