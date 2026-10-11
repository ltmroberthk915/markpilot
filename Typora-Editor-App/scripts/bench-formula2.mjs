// 公式点击基准 v2：点击视口内长公式 → 源码可见/光标进入源码 的延迟
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

for (const pct of [0.5, 0.75, 0.95]) {
  await ev(`(() => {
    const d = document.getElementById('editor').contentDocument;
    const s = d.querySelector('.vditor-ir .vditor-reset');
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * ${pct});
  })()`);
  await sleep(1800);
  const t = await ev(`(() => {
    const d = document.getElementById('editor').contentDocument;
    const vw = d.defaultView;
    const lms = [...d.querySelectorAll('.language-math[data-math]')].filter(lm => {
      const src = lm.getAttribute('data-math') || '';
      if (src.length < 20 || src.length > 120) return false;
      const k = lm.querySelector('.katex');
      if (!k) return false;
      const r = k.getBoundingClientRect();
      return r.top > 60 && r.bottom < vw.innerHeight - 40 && r.width > 40 && r.height > 12;
    });
    if (!lms.length) return null;
    const lm = lms[Math.floor(lms.length / 2)];
    const k = lm.querySelector('.katex');
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), src: lm.getAttribute('data-math') };
  })()`);
  if (!t) { console.log(`位置 ${pct * 100}%: 视口内无合适长公式`); continue; }

  // 页内探针：源码可见（data-math 字符串出现在文本节点）或光标进入含反斜杠的 marker
  await ev(`(() => {
    const w = document.getElementById('editor').contentWindow;
    const d = w.document;
    const src = ${JSON.stringify(t.src)};
    w.__fbench = null;
    const t0 = w.performance.now();
    const mid = src.slice(0, Math.min(12, src.length));
    const check = () => {
      const sel = w.getSelection();
      const node = sel && sel.anchorNode;
      const caretInSrc = node && node.nodeType === 3 && (node.textContent || '').includes(mid);
      const walker = d.createTreeWalker(d.body, 4 /* TEXT */);
      let srcVisible = false;
      let n;
      while ((n = walker.nextNode())) {
        if ((n.textContent || '').includes(src.slice(0, Math.min(20, src.length)))) { srcVisible = true; break; }
        if (walker.currentNode && d.body.contains(n) === false) break;
      }
      if (caretInSrc || srcVisible) { w.__fbench = Math.round(w.performance.now() - t0); return; }
      if (w.performance.now() - t0 < 15000) w.requestAnimationFrame(check);
      else w.__fbench = -1;
    };
    w.requestAnimationFrame(check);
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 });

  // Node 侧等探针出结果（最多 16s）
  let ms = null;
  for (let i = 0; i < 160; i++) {
    ms = await ev(`document.getElementById('editor').contentWindow.__fbench`);
    if (ms !== null && ms !== undefined) break;
    await sleep(100);
  }
  console.log(`位置 ${pct * 100}%: 公式源码 "${t.src.slice(0, 24)}…" 点击(${t.x},${t.y}) → 源码可编辑: ${ms === -1 ? '未检测到(>15s)' : ms + 'ms'}`);
}

console.log('DONE');
ws.close();
process.exit(0);
