// 阅读模式（路线 #3）的真实安装版终验：已安装 EXE + 私有 profile + CDP。
//  1) 合成大文档（1500 块，可入档）：编辑态基线帧 → 阅读模式 → 中段 → 末段 → 点回编辑，
//     每帧做 DOM 几何断言 + 帧字节差分（防"滚动到空白"），键帧截图入档。
//  2) 受保护素材副本（用户内容）：只做 DOM/控制台断言，截图当场删除不入档，原件 md5 不变。
// 运行：node scripts/reading-mode-installed.mjs
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = 'C:/Users/ltmroberthk/AppData/Local/Programs/markpilot/MarkPilot.exe';
const root = path.join(project, '.perf/rm-installed');
const out = path.join(root, 'out');
const profile = path.join(root, 'profile');
fs.rmSync(root, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ok: !!ok, label, detail: String(detail)});
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail !== '' ? '  [' + detail + ']' : ''));
};
const info = (label, detail) => console.log('INFO ' + label + ' = ' + detail);

// 合成大文档（≥1200 顶层块，触发窗口化；内容为合成文本，可入档）
const blocks = [];
for (let i = 0; i < 1500; i++) {
  if (i % 25 === 0) blocks.push(`## 第 ${i} 节 合成标题`);
  else if (i % 11 === 0) blocks.push('| 甲 | 乙 |\n| --- | --- |\n| ' + i + '-甲 | ' + i + '-乙 |');
  else if (i % 7 === 0) blocks.push('$$\n a_{' + i + '} + \\frac{1}{' + (i + 1) + '} = c\n$$');
  else blocks.push(`第 ${i} 段合成正文：测度 $\\mu$ 与概率 $P$ 的关系，样本空间 $\\Omega_{${i}}$ 上的事件域。这是一段用于占位高度测量的稳定文本。`);
}
const synthetic = path.join(out, 'synthetic-large.md');
fs.writeFileSync(synthetic, blocks.join('\n\n') + '\n');
const syntheticChars = fs.readFileSync(synthetic, 'utf8').length;

const material = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';
const materialCopy = path.join(out, 'material-copy.md');
fs.copyFileSync(material, materialCopy);
const hashOf = file => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
const materialHashBefore = hashOf(material);
const materialCopyHashBefore = hashOf(materialCopy);

const env = {...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const port = 9351;
const errlog = fs.openSync(path.join(out, 'stderr.log'), 'a');
const pause = ms => new Promise(r => setTimeout(r, ms));
const getJson = target => new Promise((resolve, reject) => {
  http.get({host: '127.0.0.1', port, path: target}, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data)));
  }).on('error', reject);
});

let child = null, ws = null, seq = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, m => m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result));
  ws.send(JSON.stringify({id, method, params}));
});
const shell = async expression => {
  const wrapped = `(() => { try { const w = document.getElementById('editor')?.contentWindow;
    if (!w || !w.vditor) return {ok:false, error:'editor frame not ready'};
    return {ok:true, value: w.eval(${JSON.stringify(expression)})}; }
    catch (error) { return {ok:false, error:String(error)}; } })()`;
  const {result} = await send('Runtime.evaluate', {expression: wrapped, returnByValue: true, awaitPromise: true});
  if (!result?.value?.ok) throw new Error('shell eval failed: ' + (result?.value?.error || 'unknown') + ' :: ' + expression.slice(0, 160));
  return result.value.value;
};
const until = async (expression, timeout = 180000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await shell(expression)) return true; } catch {} await pause(250); }
  return false;
};
const shot = async name => {
  const {data} = await send('Page.captureScreenshot', {format: 'png'});
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return {file, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)};
};

async function launch(file) {
  child = spawn(exe, ['--user-data-dir=' + profile, '--remote-debugging-port=' + port, '--no-sandbox', file],
    {env, windowsHide: true, stdio: ['ignore', errlog, errlog]});
  child.unref();
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    await pause(300);
    try { page = (await getJson('/json/list')).find(t => t.type === 'page' && /\/shell/.test(t.url)); } catch {}
  }
  if (!page) throw new Error('CDP page target not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push((message.params.exceptionDetails.exception?.description || '').slice(0, 200));
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(JSON.stringify(message.params.args?.map(a => a.value ?? a.description)).slice(0, 200));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await pause(1500);
}

async function main() {
  await launch(synthetic);
  await until(`!!document.getElementById('editor')`, 60000);
  await pause(2500);
  check(await until('!!vditor.vditor.__typoraPatched', 90000), 'A1 installed app renders the synthetic large doc (patched)', '');
  await until('!window.__typoraMathStats?.pending', 180000);
  const head = await shell(`vditor.getValue().slice(0,20)`);
  const valueBefore = await shell(`vditor.getValue().length`);
  check(head.startsWith('## 第 0 节'), 'A2 document loaded through the real host chain', JSON.stringify(head));

  const btn = await shell(`(() => {const b=document.querySelector('button[data-type="reading-mode"]');
    return b?{found:true, tip:b.parentElement?.getAttribute('title')||b.getAttribute('aria-label')||'', label:b.getAttribute('aria-label')}:{found:false};})()`);
  check(btn.found, 'A3 reading-mode toolbar button exists in the real toolbar', JSON.stringify(btn));

  const editGeometry = await shell(`(() => {const e=vditor.vditor;return {
    irDisplay:getComputedStyle(e.ir.element.parentElement).display,
    irNodes:e.ir.element.querySelectorAll('*').length, blocks:e.ir.element.childElementCount};})()`);
  const frame1 = await shot('01-edit-baseline.png');
  info('edit baseline', JSON.stringify({...editGeometry, frame: frame1.sha256, bytes: frame1.bytes}));

  // 真实点击工具栏按钮进入阅读模式
  await shell(`document.querySelector('button[data-type="reading-mode"]').click()`);
  check(await until('window.vditor.__typoraReading.prepared', 240000), 'A4 reading mode prepared (clicked the real toolbar button)', '');
  const readingGeometry = await shell(`(() => {const e=vditor.vditor,oc=e.outline.element,content=e.preview.element.parentElement;
    const outlineShown=oc&&getComputedStyle(oc).display!=='none'?oc.offsetWidth:0;
    const R=e.preview.previewElement;
    return {active:window.vditor.__typoraReading.active,
      readingClass:!!document.querySelector('.vditor.typora-reading'),
      irDisplay:getComputedStyle(e.ir.element.parentElement).display,
      previewDisplay:getComputedStyle(e.preview.element).display,
      surfaceWidth:Math.round(e.preview.element.getBoundingClientRect().width),
      contentWidth:Math.round(content.clientWidth), outlineWidth:Math.round(outlineShown),
      slots:document.querySelectorAll('.typora-read-slot').length,
      mounted:[...R.children].filter(n=>!n.classList.contains('typora-read-slot')).length,
      previewNodes:R.querySelectorAll('*').length,
      stats:window.vditor.__typoraReading.stats,
      pill:(document.querySelector('.typora-reading-status')?.textContent)||''};})()`);
  info('reading geometry', JSON.stringify(readingGeometry));
  check(readingGeometry.active && readingGeometry.readingClass && readingGeometry.irDisplay === 'none'
    && readingGeometry.previewDisplay !== 'none', 'A5 reading surface is the only visible surface', JSON.stringify({active: readingGeometry.active, ir: readingGeometry.irDisplay, pv: readingGeometry.previewDisplay}));
  check(readingGeometry.surfaceWidth >= readingGeometry.contentWidth - readingGeometry.outlineWidth - 4,
    'A6 reading surface is full width', `${readingGeometry.surfaceWidth} vs ${readingGeometry.contentWidth}-${readingGeometry.outlineWidth}`);
  check(readingGeometry.slots > 1000 && readingGeometry.mounted > 0 && readingGeometry.mounted < 150,
    'A7 windowing active: offscreen blocks are placeholders', `slots=${readingGeometry.slots} mounted=${readingGeometry.mounted}`);
  check(readingGeometry.stats.jumps !== undefined, 'A8 stats exposed for verification', JSON.stringify(readingGeometry.stats));
  const frame2 = await shot('02-reading-top.png');
  const coverage = () => shell(`(() => {const sc=vditor.vditor.preview.element,R=vditor.vditor.preview.previewElement,box=sc.getBoundingClientRect();
    const visible=[...R.children].filter(n=>!n.classList.contains('typora-read-slot')).filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.bottom>box.top+1&&r.top<box.bottom-1;});
    return {visible:visible.length, top:Math.round(sc.scrollTop), tags:visible.slice(0,3).map(n=>n.tagName)};})()`);
  const topCover = await coverage();
  check(topCover.visible > 0, 'A9 viewport populated in reading mode', JSON.stringify(topCover));

  const scrollTo = async fraction => {
    await shell(`(() => {const sc=vditor.vditor.preview.element;sc.scrollTop=Math.min(sc.scrollHeight-sc.clientHeight, Math.round(sc.scrollHeight*${fraction}));
      window.vditor.__typoraReading.update();return true;})()`);
    await pause(700);
    return coverage();
  };
  const midCover = await scrollTo(0.5);
  const frame3 = await shot('03-reading-middle.png');
  const endCover = await scrollTo(0.999);
  const frame4 = await shot('04-reading-end.png');
  info('scroll coverage', JSON.stringify({top: topCover, mid: midCover, end: endCover}));
  check(midCover.visible > 0 && endCover.visible > 0, 'A10 no blank viewport at middle/end', JSON.stringify({mid: midCover, end: endCover}));
  const frames = [frame1, frame2, frame3, frame4];
  const distinct = new Set(frames.map(f => f.sha256)).size;
  check(distinct === frames.length, 'A11 every keyframe differs (render really changed)', JSON.stringify(frames.map(f => f.sha256)));
  check(frame2.bytes > frame1.bytes * 0.35 && frame3.bytes > frame1.bytes * 0.35 && frame4.bytes > frame1.bytes * 0.35,
    'A12 no frame collapsed to a blank page (byte size sanity)', JSON.stringify(frames.map(f => f.bytes)));

  // 点击进编辑（视口内一个真实块）
  const target = await shell(`(() => {const sc=vditor.vditor.preview.element,R=vditor.vditor.preview.previewElement,box=sc.getBoundingClientRect();
    const el=[...R.children].find(n=>!n.classList.contains('typora-read-slot')&&(()=>{const r=n.getBoundingClientRect();return r.top>box.top+60&&r.bottom<box.bottom-60&&r.height>20;})());
    if(!el) return {error:'none'};
    const r=el.getBoundingClientRect(), f=window.frameElement.getBoundingClientRect();
    return {x:Math.round(f.left+r.left+r.width/2), y:Math.round(f.top+r.top+r.height/2)};})()`);
  if (target.error) check(false, 'A13 click target available', target.error);
  else {
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
    await pause(1200);
    const afterClick = await shell(`(() => {const e=vditor.vditor,sel=getSelection(),root=e.ir.element;
      const r=sel.rangeCount?sel.getRangeAt(0).getBoundingClientRect():null;
      return {active:window.vditor.__typoraReading.active, irDisplay:getComputedStyle(root.parentElement).display,
        inside:!!(sel.focusNode&&root.contains(sel.focusNode)), rect:r?{top:Math.round(r.top),bottom:Math.round(r.bottom)}:null,
        slots:document.querySelectorAll('.typora-read-slot').length};})()`);
    const frame5 = await shot('05-back-to-edit.png');
    info('after click', JSON.stringify(afterClick));
    check(!afterClick.active && afterClick.irDisplay !== 'none' && afterClick.inside && afterClick.slots === 0,
      'A13 click returns to editing with a caret and no residue', JSON.stringify(afterClick));
    check(frame5.sha256 !== frame2.sha256, 'A14 return frame differs from the reading frame', `${frame5.sha256} vs ${frame2.sha256}`);
  }
  // Esc 再次进出
  await shell(`document.querySelector('button[data-type="reading-mode"]').click()`);
  await until('window.vditor.__typoraReading.prepared', 240000);
  await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  await pause(1200);
  const afterEsc = await shell(`(() => {const e=vditor.vditor;return {active:window.vditor.__typoraReading.active,
    irDisplay:getComputedStyle(e.ir.element.parentElement).display, slots:document.querySelectorAll('.typora-read-slot').length,
    readingClass:!!document.querySelector('.vditor.typora-reading'), value:vditor.getValue().length};})()`);
  check(!afterEsc.active && afterEsc.irDisplay !== 'none' && afterEsc.slots === 0 && !afterEsc.readingClass,
    'A15 Esc exits reading mode inside the packaged app', JSON.stringify(afterEsc));
  check(afterEsc.value === valueBefore, 'A16 document text unchanged by the reading session', `${afterEsc.value} vs ${valueBefore}`);

  // 受保护素材副本：真实用户文档的功能检查（截图不入档）——独立启动一次，走真实文件参数链路
  ws.close(); child.kill(); await pause(2500);
  await launch(materialCopy);
  await until("!!document.getElementById('editor')", 60000);
  await pause(2500);
  await until('!!vditor.vditor.__typoraPatched', 90000);
  const loaded = await until("vditor.getValue().includes('# 第一部分 高等概率论基础')", 60000);
  check(loaded, 'B1 protected-material copy opens in the installed app', '');
  await shell(`document.querySelector('button[data-type="reading-mode"]').click()`);
  const realPrepared = await until("window.vditor.__typoraReading.active && !window.vditor.__typoraReading.preparing && vditor.vditor.preview.previewElement.childElementCount > 0 && !window.__typoraMathStats?.pending", 120000);
  const realState = await shell(`(() => {const e=vditor.vditor,R=e.preview.previewElement;return {
    active:window.vditor.__typoraReading.active, readingClass:!!document.querySelector('.vditor.typora-reading'),
    previewDisplay:getComputedStyle(e.preview.element).display, slots:document.querySelectorAll('.typora-read-slot').length,
    mounted:[...R.children].filter(n=>!n.classList.contains('typora-read-slot')).length,
    blocks:R.childElementCount, value:vditor.getValue().length,
    selected:(()=>{const s=getSelection();s.removeAllRanges();const r=document.createRange();r.selectNodeContents(R);s.addRange(r);const t=s.toString().length;s.removeAllRanges();return t;})(),
    renderedText:[...R.children].reduce((sum,n)=>sum+(n.textContent||'').length,0)};})()`);
  info('real material reading state', JSON.stringify(realState));
  const realShot = await shot('99-real-material.png');   // 用户内容：仅当场核对，随后删除
  fs.rmSync(realShot.file, {force:true});
  check(realPrepared && realState.active && realState.previewDisplay !== 'none',
    'B2 reading mode works on the real note copy', JSON.stringify({prepared: realPrepared, active: realState.active}));
  // 全选拿到的是"渲染文本"（不含 Markdown 记号），所以与阅读面自身的块文本之和比，
  // 而不是与源码长度比；同时断言 133 个块全部在场（该文档低于窗口化阈值）。
  check(realState.blocks === 133 && realState.renderedText > 0 &&
    realState.selected > realState.renderedText * 0.95,
    'B3 select-all copy covers every rendered block of the real note',
    `selected=${realState.selected} rendered=${realState.renderedText} blocks=${realState.blocks}`);
  await shell(`window.vditor.__typoraReading.exit()`);
  await pause(800);
  check(hashOf(material) === materialHashBefore, 'B4 protected original md5 unchanged', hashOf(material));
  check(hashOf(materialCopy) === materialCopyHashBefore, 'B5 material copy md5 unchanged (read-only session)', hashOf(materialCopy));

  const ownExceptions = exceptions.filter(e => !/cdn\/vditor/.test(e));
  check(ownExceptions.length === 0 && consoleErrors.length === 0, 'C1 no exceptions / console errors',
    JSON.stringify({exceptions: ownExceptions.slice(0, 3), consoleErrors: consoleErrors.slice(0, 3)}));

  const passed = results.filter(r => r.ok).length;
  console.log(`\n== installed reading-mode: ${passed}/${results.length} PASS, ${results.length - passed} FAIL ==`);
  fs.writeFileSync(path.join(project, '.perf/reading-mode-installed.json'),
    JSON.stringify({results, exceptions, consoleErrors, syntheticChars, frames: frames.map(f => ({file: path.basename(f.file), bytes: f.bytes, sha256: f.sha256}))}, null, 2));
  ws.close();
  child.kill();
  await pause(1500);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}
main().catch(async error => {
  console.error('INSTALLED VERIFY FAIL', error);
  try { fs.writeFileSync(path.join(project, '.perf/reading-mode-installed.json'), JSON.stringify({results, exceptions, consoleErrors, fatal: String(error)}, null, 2)); } catch {}
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  process.exit(1);
});
