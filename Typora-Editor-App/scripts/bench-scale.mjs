// 规模对比 v2：按目标文件专属尾标记判定打开完成；插入前先点击聚焦
const CDP = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { readFileSync } = await import('node:fs');

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const call = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, (r) => res(r)); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expression, awaitPromise) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'exc');
  return r.result?.value;
});

function plainTail(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 10 && !l.includes('$') && !l.includes('\\'));
  return (lines[lines.length - 1] || '').slice(0, 20);
}

const files = [
  ['1万字', 'E:/MarkPilot/Typora-Editor-App/.testws/基准-1万字.md'],
  ['3万字', 'E:/MarkPilot/Typora-Editor-App/.testws/基准-3万字.md'],
  ['12万字', 'E:/MarkPilot/Typora-Editor-App/.testws/教材合订本.md'],
];
let run = 0;
for (const [label, file] of files) {
  run += 1;
  const diskText = readFileSync(file, 'utf8');
  const tail = plainTail(diskText);
  if (!tail) { console.log(`${label}: 找不到纯文本尾标记，跳过`); continue; }

  const t0 = Date.now();
  await ev(`window.hostApi.invoke('open-file', ${JSON.stringify({ path: file })})`, true);
  let ready = -1;
  for (let i = 0; i < 600; i++) {
    const ok = await ev(`(() => {
      const d = document.getElementById('editor')?.contentDocument;
      if (!d || !d.querySelector('.vditor')) return false;
      return (d.body.innerText || '').includes(${JSON.stringify(tail)});
    })()`);
    if (ok) { ready = Date.now() - t0; break; }
    await sleep(100);
  }
  await sleep(2500); // 懒渲染稳定窗口（对齐真实使用）

  // 输入延迟：先点击聚焦
  const marker = 'M' + run + 'XYZ';
  const box = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + 140)}; })()`);
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
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await call('Input.insertText', { text: marker });
  let ms = null;
  for (let i = 0; i < 400; i++) {
    ms = await ev(`document.getElementById('editor').contentWindow.__bench`);
    if (ms !== null && ms !== undefined) break;
    await sleep(100);
  }
  // 清理：回写原文 + 保存（保持主进程干净状态）
  await ev(`document.getElementById('editor').contentWindow.vscodeEvent.emit('change', ${JSON.stringify(diskText)})`);
  await ev(`window.hostApi.invoke('save', {})`, true);
  await sleep(600);
  console.log(`${label}: 打开 ${ready >= 0 ? ready + 'ms' : 'TIMEOUT'} | 输入→DOM ${ms ?? 'FAIL'}ms`);
}
console.log('DONE');
ws.close();
process.exit(0);
