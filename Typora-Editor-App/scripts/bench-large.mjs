// 大文件基准：打开耗时 / 输入延迟 / 滚动 / 堆内存 / 状态栏统计
import { readFileSync } from 'node:fs';

const CDP = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
let list = null;
for (let i = 0; i < 60; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); break; }
  catch { await sleep(250); }
}
const tCdp = Date.now() - t0;
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
if (!page) { console.log('no shell target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const ev = (expression, awaitPromise = false) => new Promise((res, rej) => {
  const id = ++seq;
  pend.set(id, (r) => { if (r.exceptionDetails) rej(new Error(r.exceptionDetails.exception?.description || 'exc')); else res(r.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
});

// 文档末尾标记（用于判定全量渲染完成）
const md = readFileSync('E:/MarkPilot/Typora-Editor-App/.testws/教材合订本.md', 'utf8');
const tail = md.slice(-400).match(/([^\n]{6,40})\s*$/)?.[1] || 'EOF';
console.log(`文件: ${md.length} 字符, 末尾标记: "${tail.slice(0, 30)}"`);

// 1) 打开耗时：等 vditor 出现 + 末尾文本进入 DOM
let tOpen = -1;
const tStart = Date.now();
for (let i = 0; i < 600; i++) {
  const done = await ev(`(() => {
    const d = document.getElementById('editor')?.contentDocument;
    if (!d || !d.querySelector('.vditor')) return false;
    const t = d.body.innerText || '';
    return t.includes(${JSON.stringify(tail.slice(0, 20))}) && t.length > 100000;
  })()`);
  if (done) { tOpen = Date.now() - tStart; break; }
  await sleep(100);
}
console.log(`CDP 就绪: ${tCdp}ms | 全文进入 DOM: ${tOpen >= 0 ? tOpen + 'ms' : 'TIMEOUT'}`);

// 2) 状态栏统计
await sleep(800);
const stats = await ev(`(() => ({
  bar: document.getElementById('statusbar')?.textContent.replace(/\\s+/g, ' ').trim(),
  words: document.getElementById('st-words')?.textContent,
}))()`);
console.log('状态栏:', JSON.stringify(stats));

// 3) 堆内存
const heap = await ev('performance && (performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1)');
const dHeap = await ev(`(() => { try { return Math.round((performance.memory||{}).usedJSHeapSize/1048576) } catch(e) { return -1 } })()`);
console.log(`渲染进程 JS 堆: ${dHeap} MB`);

// 4) 输入延迟：点击编辑区中部，插入文本，10ms 轮询到 DOM 出现
const center = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + 120)}; })()`);
await ev('document.getElementById("editor").contentWindow.focus()');
const call = (method, params) => new Promise((res) => {
  const id = ++seq;
  pend.set(id, (r) => res(r));
  ws.send(JSON.stringify({ id, method, params }));
});
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 });
const marker = 'BENCHMARKXYZ';
const tType = Date.now();
await call('Input.insertText', { text: marker });
let tInput = -1;
for (let i = 0; i < 500; i++) {
  const found = await ev(`document.getElementById('editor').contentDocument.body.innerText.includes('${marker}')`);
  if (found) { tInput = Date.now() - tType; break; }
  await sleep(10);
}
console.log(`输入到 DOM 渲染延迟: ${tInput >= 0 ? tInput + 'ms' : 'TIMEOUT'}`);
// 撤销这次插入（Ctrl+Z）
await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });

// 5) 滚动到底耗时（20 次滚轮）
const box = await ev(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
const tScr = Date.now();
for (let i = 0; i < 20; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 400 }); await sleep(25); }
const scrDone = Date.now() - tScr;
const scr = await ev(`(() => { const d=document.getElementById('editor').contentDocument; const s=d.querySelector('.vditor-ir .vditor-reset'); return {top: Math.round(s?.scrollTop||0), max: Math.round((s?.scrollHeight||0)-(s?.clientHeight||0))}; })()`);
console.log(`20 次滚轮总耗时 ${scrDone}ms, 滚动位置: ${scr.top}/${scr.max}`);

console.log('DONE');
ws.close();
process.exit(0);
