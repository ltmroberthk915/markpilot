// 验证标题目录两种形态：1) 工具栏大纲面板  2) 文档内 [toc] 语法
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
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

// 换一份带多级标题 + [toc] 的文档
const doc = [
  '# 目录测试文档', '',
  '[toc]', '',
  '## 第一章', '',
  '内容一', '',
  '### 1.1 小节', '',
  '内容 1.1', '',
  '## 第二章', '',
  '内容二', '',
  '### 2.1 小节', '',
  '内容 2.1', '',
  '#### 2.1.1 更深层', '',
  '内容', '',
].join('\n');
await ev(`window.hostApi.invoke('tree-create', ${JSON.stringify({ parentDir: 'E:/MarkPilot/Typora-Editor-App/.testws', name: '目录测试.md', isDir: false })})`, true);
await sleep(500);
await ev(`window.hostApi.invoke('open-file', ${JSON.stringify({ path: 'E:/MarkPilot/Typora-Editor-App/.testws/目录测试.md' })})`, true);
await sleep(1500);
// 写入内容（经 vditor，走正常渲染管线）
await ev(`document.getElementById('editor').contentWindow.vditor.setValue(${JSON.stringify(doc)})`);
await sleep(1200);

// 1) 工具栏大纲按钮 + 面板
const outlineBtn = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const btn = [...d.querySelectorAll('.vditor-toolbar button')].find(b => (b.className||'').includes('outline') || b.getAttribute('data-type')==='outline');
  if (!btn) return { found: false };
  btn.click();
  return { found: true, pressed: btn.className.includes('vditor-toolbar--active') || true };
})()`);
await sleep(600);
const outlinePanel = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const ol = d.querySelector('.vditor-outline');
  const items = ol ? [...ol.querySelectorAll('li')].map(li => li.textContent.trim()) : [];
  return { has: !!ol, visible: ol && ol.offsetWidth > 0, count: items.length, items: items.slice(0, 8) };
})()`);
console.log('outline button:', JSON.stringify(outlineBtn));
console.log('outline panel:', JSON.stringify(outlinePanel));

// 2) 文档内 [toc] 渲染
const tocInDoc = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const block = d.querySelector('.vditor-toc, .vditor-reset [data-type="toc-block"], .vditor-ir .vditor-toc');
  const links = d.querySelectorAll('.vditor-toc a, [data-type="toc-block"] a');
  return {
    tocNode: !!block,
    linkCount: links.length,
    titles: [...links].slice(0, 6).map(a => a.textContent.trim()),
  };
})()`);
console.log('in-doc [toc]:', JSON.stringify(tocInDoc));

ws.close();
process.exit(0);
