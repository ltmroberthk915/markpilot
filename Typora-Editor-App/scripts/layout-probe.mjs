// 布局探针：侧边栏/编辑区几何、工具栏可见性、溢出检查
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const ev = (expression) => new Promise((res, rej) => {
  const id = ++seq;
  pend.set(id, (r) => { if (r.exceptionDetails) rej(new Error(r.exceptionDetails.exception?.description || 'exc')); else res(r.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});
console.log(JSON.stringify(await ev(`(() => {
  const sb = document.getElementById('sidebar').getBoundingClientRect();
  const ed = document.getElementById('editor').getBoundingClientRect();
  const d = document.getElementById('editor').contentDocument;
  const tb = d.querySelector('.vditor-toolbar');
  return {
    sidebar: { x: Math.round(sb.x), w: Math.round(sb.width) },
    editor: { x: Math.round(ed.x), w: Math.round(ed.width), h: Math.round(ed.height) },
    toolbarVisible: !!tb && tb.getBoundingClientRect().height > 20,
    bodyOverflowX: d.body.scrollWidth > d.body.clientWidth,
    darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
  };
})()`), null, 1));
ws.close();
