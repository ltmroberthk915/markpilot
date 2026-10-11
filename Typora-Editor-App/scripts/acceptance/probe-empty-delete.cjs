/** 追捕 A 的"span"：空块公式里按一次删除，markdown 里为什么会多出一行字面 `span`。
 *
 *  给 iframe 装上一圈代理（DOM 改动 + 选区 + execCommand + input 事件），每一步都记调用栈；
 *  按键前后的 DOM / markdown / 提示一起打出来。
 *
 *  用法：node scripts/acceptance/probe-empty-delete.cjs
 *        node scripts/acceptance/probe-empty-delete.cjs --key=Backspace
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-empty-delete');
const IF = `document.getElementById('editor').contentWindow`;

const INSTALL = `(() => { const w = ${IF}, d = w.document;
  if (w.__trace) return 'already';
  const log = w.__trace = [];
  const where = () => String((new Error()).stack || '').split('\\n').slice(2, 6)
    .map(line => line.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+\\//, '')).join(' ← ');
  const note = (kind, detail) => log.push({kind, detail: String(detail).slice(0, 90), where: where()});
  const patch = (target, name, wrapper) => {
    const original = target[name];
    target[name] = function (...args) { wrapper.call(this, args); return original.apply(this, args); };
  };
  patch(w.Selection.prototype, 'collapse', function () { note('selection.collapse', ''); });
  patch(w.Selection.prototype, 'removeAllRanges', function () { note('selection.removeAllRanges', ''); });
  patch(w.Selection.prototype, 'addRange', function (args) { note('selection.addRange', args[0] && args[0].startContainer && args[0].startContainer.nodeName); });
  patch(w.Node.prototype, 'replaceWith', function (args) { note('replaceWith', [...args].map(n => n.nodeName || JSON.stringify(String(n))).join(',')); });
  patch(w.Node.prototype, 'remove', function () { note('remove', this.nodeName); });
  patch(w.Element.prototype, 'replaceChildren', function (args) { note('replaceChildren', this.nodeName + '.' + (this.className || '') + ' ← ' + [...args].map(n => n.nodeName).join(',')); });
  patch(w.Element.prototype, 'removeChild', function (args) { note('removeChild', args[0] && args[0].nodeName); });
  patch(w.Element.prototype, 'appendChild', function (args) { note('appendChild', args[0] && args[0].nodeName); });
  patch(w.Element.prototype, 'insertBefore', function (args) { note('insertBefore', args[0] && (args[0].nodeName + ':' + JSON.stringify(String(args[0].textContent || '').slice(0, 20)))); });
  patch(d, 'execCommand', function (args) { note('execCommand', args[0]); });
  const descriptor = Object.getOwnPropertyDescriptor(w.CharacterData.prototype, 'data');
  Object.defineProperty(w.CharacterData.prototype, 'data', {configurable: true, get: descriptor.get,
    set (value) { note('text.data=' + JSON.stringify(String(value).slice(0, 30)), this.parentElement ? this.parentElement.nodeName : ''); descriptor.set.call(this, value); }});
  patch(w.Node.prototype, 'normalize', function () { note('normalize', ''); });
  d.addEventListener('input', event => note('input', event.inputType + (event.data ? ' ' + JSON.stringify(event.data) : '') + ' trusted=' + event.isTrusted), true);
  d.addEventListener('keydown', event => note('keydown', event.key + ' prevented=' + event.defaultPrevented), false);
  d.addEventListener('keyup', event => note('keyup', event.key), true);
  return 'installed'; })()`;

const RESET = `(() => { const w = ${IF}; if (!w.__trace) return 'off'; w.__trace.length = 0; return 'cleared'; })()`;
const DUMP = `(() => { const w = ${IF}; return w.__trace || null; })()`;
const MD = `(() => { const w = ${IF}; return w.vditor.getValue(); })()`;
const TOAST = `(() => { const w = ${IF}; const node = w.document.querySelector('.typora-context-toast'); return node ? node.textContent : null; })()`;
const STATE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const s = w.getSelection();
  const owner = surface ? surface.children[1] : null;
  const code = owner ? owner.querySelector('code[data-type="math-block"]') : null;
  const caret = s.rangeCount ? (() => { const r = s.getRangeAt(0); const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    return {collapsed: r.collapsed, container: r.startContainer.nodeName + '@' + r.startOffset, layer: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文'}; })() : null;
  return {md: w.vditor.getValue(), caret, toast: (d.querySelector('.typora-context-toast') || {}).textContent || null,
    empty: code ? JSON.stringify(code.textContent) : null,
    html: owner ? String(owner.outerHTML).replace(/></g, '>\\n<').slice(0, 900) : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'empty.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-empty-delete', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  const argOf = (name, fallback) => {
    const hit = process.argv.find(value => value.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const KEY = argOf('key', 'Delete');
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);
    console.log('记录器：' + await session.js(INSTALL));
    const md = '前段甲\n\n$$\n\n$$\n\n后段乙\n';
    await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(md)}); return 1; })()`);
    await sleep(1500);
    const click = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      const block = surface.children[1];
      const box = block.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {x: Math.round(fr.x + box.left + box.width / 2), y: Math.round(fr.y + box.top + box.height * 0.55)}; })()`);
    await session.click(click.x, click.y);
    await sleep(400);
    console.log('\n── 点进空块之后 ──');
    console.log(JSON.stringify((await session.js(STATE)), null, 1));
    await session.js(RESET);
    console.log(`\n════ 按 ${KEY} ════`);
    await session.key({key: KEY, code: KEY, vk: KEY === 'Delete' ? 46 : 8});
    await sleep(600);
    const trace = await session.js(DUMP);
    console.log('调用序列（时间顺序）：');
    for (const item of trace) console.log(`  ${item.kind.padEnd(28)} ${item.detail.padEnd(46)} ← ${item.where}`);
    console.log('\n── 按键之后 ──');
    console.log(JSON.stringify((await session.js(STATE)), null, 1));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
