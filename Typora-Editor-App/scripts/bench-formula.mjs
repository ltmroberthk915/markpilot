// 公式点击基准：滚动到文档中/后部，点击渲染好的公式预览，测「点击→源码可编辑」延迟
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

// --- 1) 探查公式 DOM 结构（滚动前） ---
const struct = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const s = d.querySelector('.vditor-ir .vditor-reset');
  const k = d.querySelector('.katex');
  const chains = [];
  if (k) {
    let el = k;
    for (let i = 0; i < 5 && el; i++) { chains.push(el.tagName + '.' + (el.className||'').toString().split(' ').slice(0,3).join('.')); el = el.parentElement; }
  }
  return {
    totalKatex: d.querySelectorAll('.katex').length,
    katexChain: chains,
    scrollMax: Math.round(s.scrollHeight - s.clientHeight),
  };
})()`);
console.log('公式结构:', JSON.stringify(struct, null, 1));

// --- 2) 依次在 50% / 75% / 95% 位置测公式点击 ---
const box = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
for (const pct of [0.5, 0.75, 0.95]) {
  // 滚到目标位置并等懒渲染
  await ev(`(() => {
    const d = document.getElementById('editor').contentDocument;
    const s = d.querySelector('.vditor-ir .vditor-reset');
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * ${pct});
  })()`);
  await sleep(1500); // 等公式懒渲染进入视口
  const found = await ev(`(() => {
    const d = document.getElementById('editor').contentDocument;
    const vw = d.defaultView;
    const all = [...d.querySelectorAll('.katex')];
    const vis = all.filter(k => { const r = k.getBoundingClientRect(); return r.top > 60 && r.bottom < vw.innerHeight - 40 && r.height > 5; });
    if (!vis.length) return null;
    const k = vis[Math.floor(vis.length / 2)];
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(20, r.width / 2)), y: Math.round(r.y + r.height / 2), total: all.length, visible: vis.length, parentCls: k.parentElement?.className };
  })()`);
  if (!found || !found.x) { console.log(`位置 ${pct * 100}%: 视口内没有已渲染公式 (全部 ${found?.total ?? 0} 个渲染)`); continue; }

  // 装页内探针：点击→源码进入可编辑（判定：选区光标落在公式源码文本节点）
  await ev(`(() => {
    const w = document.getElementById('editor').contentWindow;
    w.__fbench = null;
    const t0 = w.performance.now();
    const check = () => {
      const sel = w.getSelection();
      const node = sel && sel.anchorNode;
      const inSource = node && node.nodeType === 3 && /\\\\|\\\\frac|[a-zA-Z]/.test(node.textContent || '') &&
        node.parentElement && (node.parentElement.closest('.vditor-ir__marker') || /marker/.test(node.parentElement.className || ''));
      if (inSource) { w.__fbench = Math.round(w.performance.now() - t0); return; }
      if (w.performance.now() - t0 < 10000) w.requestAnimationFrame(check);
      else w.__fbench = -1;
    };
    w.requestAnimationFrame(check);
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  await sleep(3500);
  const ms = await ev(`document.getElementById('editor').contentWindow.__fbench`);
  console.log(`位置 ${pct * 100}%: 点击(${found.x},${found.y}) 公式(可见${found.visible}/${found.total}) → 源码可编辑: ${ms}ms`);
}

console.log('DONE');
ws.close();
process.exit(0);
