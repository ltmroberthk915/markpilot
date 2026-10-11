// 打包版冒烟：连 CDP 9223 验证 portable exe（asar 资源、会话恢复、编辑器加载）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let list = null;
for (let i = 0; i < 25; i++) {
  try { list = await (await fetch('http://127.0.0.1:9223/json/list')).json(); break; }
  catch { await sleep(1000); }
}
if (!list) { console.log('FAIL: CDP not reachable (portable exe did not start with debugging)'); process.exit(1); }
console.log('targets:', list.map((t) => `${t.type} ${t.title}`).join(' | '));

const page = list.find((t) => t.type === 'page');
if (!page) { console.log('FAIL: no page target'); process.exit(1); }
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

await sleep(3000); // 等 vditor 异步资源（asar 内）
const probe = await ev(`(() => {
  const d = document.getElementById('editor')?.contentDocument;
  return {
    shell: !!document.getElementById('tree'),
    rows: document.querySelectorAll('#tree .row').length,
    active: !!document.querySelector('#tree .row.active'),
    iframeLoaded: !!d?.querySelector('.vditor'),
    toolbarBtns: d?.querySelectorAll('.vditor-toolbar button').length || 0,
    katex: d?.querySelectorAll('.katex').length || 0,
    text: (d?.body.innerText || '').slice(0, 40),
  };
})()`);
console.log('packaged probe:', JSON.stringify(probe, null, 1));

// 打包版保存链路
const edited = '# 打包版冒烟 ' + Date.now() + '\n\n$E=mc^2$\n';
await ev(`document.getElementById('editor').contentWindow.vscodeEvent.emit('change', ${JSON.stringify(edited)})`);
await sleep(300);
await ev(`window.hostApi.invoke('save', {})`, false);
await sleep(600);
const { readFileSync } = await import('node:fs');
const disk = readFileSync('E:/MarkPilot/Typora-Editor-App/.testws/欢迎测试.md', 'utf8');
console.log('packaged save:', disk === edited ? 'PASS' : 'FAIL', `(${disk.length} bytes)`);

ws.close();
process.exit(0);
