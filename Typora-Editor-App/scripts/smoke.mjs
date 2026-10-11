// CDP 冒烟/回归测试：通过 DevTools 协议驱动真实应用验证核心链路
// 用法：先启动应用（--remote-debugging-port=9222），再 node scripts/smoke.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP_HTTP = 'http://127.0.0.1:9222';
const TEST_MD = 'E:/MarkPilot/Typora-Editor-App/.testws/欢迎测试.md';
const TEST_DIR = 'E:/MarkPilot/Typora-Editor-App/.testws';
const results = [];
let failed = 0;

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 最小 CDP 客户端（Node 24 原生 WebSocket）----
async function connectPage() {
  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /\/shell/.test(t.url));
  if (!page) throw new Error('shell page target not found: ' + JSON.stringify(list.map((t) => t.url)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const evq = (expression, awaitPromise = false) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (r) => {
      if (r.exceptionDetails) rej(new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)));
      else res(r.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws: ' + e.message)); });
  return {
    ev: evq,
    invoke: (cmd, args) => evq(`window.hostApi.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`, true),
    close: () => ws.close(),
  };
}

// ---- 开始 ----
const cdp = await connectPage();
const { ev, invoke } = cdp;

// 1. 外壳与文件树（工作区应为 .testws）
const treeRows = await ev(`[...document.querySelectorAll('#tree .row')].map(r=>({d:r.dataset.isDir==='1',n:r.querySelector('.name')?.textContent}))`);
ok('文件树渲染', treeRows.length >= 3, `${treeRows.length} 行: ${treeRows.map((r) => r.n).join(' | ')}`);
ok('文件树含测试文档与子文件夹', treeRows.some((r) => !r.d && /欢迎测试/.test(r.n || '')) && treeRows.some((r) => r.d && /子文件夹/.test(r.n || '')));
ok('当前文件高亮', await ev(`!!document.querySelector('#tree .row.active')`));

// 2. 编辑器 iframe（Vditor 初始化 + 内容 + 数学公式渲染）
await sleep(1000);
const ed = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const ir = d.querySelector('.vditor-ir');
  return {
    loaded: !!d.querySelector('.vditor'),
    ir: !!ir,
    toolbarBtns: d.querySelectorAll('.vditor-toolbar button').length,
    text: (ir?.innerText || d.body.innerText || '').slice(0, 300),
    katex: d.querySelectorAll('.katex').length,
    hljs: !!d.querySelector('.vditor-reset pre code, .vditor-ir pre code, .hljs'),
  };
})()`);
ok('Vditor 初始化(IR 模式)', ed.loaded && ed.ir, JSON.stringify(ed.text).slice(0, 100));
ok('文档内容加载', /欢迎测试文档/.test(ed.text) && /列表与代码/.test(ed.text));
ok('KaTeX 公式渲染', ed.katex >= 2, `${ed.katex} 个公式节点`);
ok('0.1.7 完整工具栏', ed.toolbarBtns >= 20, `${ed.toolbarBtns} 个按钮`);
ok('代码块渲染', ed.hljs);

// 3. 保存链路：change → dirty → save → 磁盘（save 仅在 dirty 时写盘，可一并证明脏标记）
//    内容加长到可滚动，供下一步滚动测试
const edited = '# 欢迎测试文档\n\n由冒烟测试写入的修改 ' + Date.now() + '\n\n$E=mc^2$\n\n' +
  Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行填充内容，用于产生可滚动高度。`).join('\n');
await ev(`document.getElementById('editor').contentWindow.vscodeEvent.emit('change', ${JSON.stringify(edited)})`);
await sleep(300);
await invoke('save', {});
await sleep(500);
const onDisk = readFileSync(TEST_MD, 'utf8');
ok('保存链路(change→dirty→save→磁盘)', onDisk === edited, `磁盘 ${onDisk.length} 字节`);

// 4. 滚动持久化（在外部修改重载之前测，避免 setValue 后滚动归零干扰）
//    先让 iframe 里的文档真正变长（直接 emit change 不会更新编辑器 DOM）
await ev(`document.getElementById('editor').contentWindow.vditor.setValue(${JSON.stringify(edited)})`);
await sleep(600);
const appliedTop = await ev(`(() => {
  const d = document.getElementById('editor').contentDocument;
  const sc = d.querySelector('.vditor-ir .vditor-reset') || d.querySelector('.vditor-ir');
  sc.scrollTop = 300;
  sc.dispatchEvent(new Event('scroll'));
  return { top: sc.scrollTop, canScroll: sc.scrollHeight > sc.clientHeight };
})()`);
await sleep(900);
const stateFile = resolve(process.env.APPDATA || '', 'markpilot', 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const scrollVals = Object.values(state.scrollStore || {});
ok('滚动位置持久化', appliedTop?.canScroll && scrollVals.some((v) => v >= 250), `applied=${JSON.stringify(appliedTop)} store=${JSON.stringify(state.scrollStore || {})}`);

// 5. 外部修改 → 自动 setValue
writeFileSync(TEST_MD, '# 外部修改\n\n外部写入的内容 ' + Date.now() + '\n', 'utf8');
await sleep(1500);
const afterExt = await ev(`document.getElementById('editor').contentWindow.vditor?.getValue() || ''`);
ok('外部修改自动重载(setValue)', /外部修改/.test(afterExt), JSON.stringify(String(afterExt).slice(0, 60)));

// 6. 文件树管理：新建 → 打开 → 重命名 → 删除
const created = await invoke('tree-create', { parentDir: TEST_DIR, name: '树测试.md', isDir: false });
ok('新建文件', created?.path && existsSync(created.path), created?.path || String(created));
const opened = await invoke('open-file', { path: created.path });
await sleep(800);
const switchText = await ev(`document.getElementById('editor').contentWindow.vditor?.getValue() || ''`);
ok('树中新文件可打开', opened?.ok && existsSync(created.path) && String(switchText).trim() === '', JSON.stringify(switchText).slice(0, 40));
const renamed = await invoke('tree-rename', { from: created.path, name: '树测试改.md' });
ok('重命名文件', renamed?.path && existsSync(renamed.path) && !existsSync(created.path), renamed?.path || String(renamed));
const trashed = await invoke('tree-delete', { path: renamed.path });
ok('删除到回收站', trashed?.ok && !existsSync(renamed.path));

// 7. 切回原文档 + 树刷新
await invoke('open-file', { path: TEST_MD });
await sleep(800);
const backText = await ev(`document.getElementById('editor').contentWindow.vditor?.getValue() || ''`);
ok('切回文档', /外部修改/.test(backText), JSON.stringify(backText).slice(0, 40));
const rowsAfter = await ev(`document.querySelectorAll('#tree .row').length`);
ok('树刷新', rowsAfter >= 3, `${rowsAfter} 行`);
ok('当前文件高亮(切换后)', await ev(`!!document.querySelector('#tree .row.active')`));

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} (${results.length} tests)`);
cdp.close();
process.exit(failed === 0 ? 0 : 1);
