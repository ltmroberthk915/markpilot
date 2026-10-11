/** 微探针：块公式源码里按 Shift+← 时，我们自己的方向键补丁到底有没有跑、有没有抛异常。
 *  用法：node scripts/acceptance/probe-arrow-fault.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-arrow-fault');
const IF = `document.getElementById('editor').contentWindow`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'arrow.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-arrow-fault', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);
    await session.js(`(() => { const w = ${IF}; w.vditor.setValue('前段甲\\n\\n$$\\na+b=1\\n$$\\n\\n后段乙\\n'); return 1; })()`);
    await sleep(1500);
    const point = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      const code = surface.children[1].querySelector('code[data-type="math-block"]');
      const preview = surface.children[1].querySelector('.vditor-ir__preview');
      const box = preview.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {x: Math.round(fr.x + box.left + box.width / 2), y: Math.round(fr.y + box.top + box.height / 2)}; })()`);
    await session.click(point.x, point.y);
    await sleep(500);
    const before = await session.js(`(() => { const w = ${IF}; const s = w.getSelection(); const r = s.getRangeAt(0);
      return {node: r.startContainer.nodeName, offset: r.startOffset, expanded: !!r.startContainer.parentElement?.closest('.vditor-ir__node--expand')}; })()`);
    console.log('点后光标：' + JSON.stringify(before));
    // 装一个"我们的补丁有没有跑"的探针：代理 setBaseAndExtent / extend，看谁调的
    await session.js(`(() => { const w = ${IF}; if (w.__arrowProbe) return; w.__arrowProbe = [];
      for (const name of ['extend', 'setBaseAndExtent', 'collapse', 'removeAllRanges', 'addRange']) {
        const original = w.Selection.prototype[name];
        w.Selection.prototype[name] = function (...args) {
          w.__arrowProbe.push({op: name, by: String((new Error()).stack || '').split('\\n').slice(1, 4).map(l => l.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+\\//, '')).join(' ← ')});
          return original.apply(this, args);
        };
      }
      return 1; })()`);
    // 手动复算 patchMathCaret 里那串守卫：看它到底在哪一步 return
    const gates = await session.js(`(() => { const w = ${IF}, d = w.document;
      const PREVIEW = '.vditor-ir__preview';
      const s = w.getSelection(), r = s.getRangeAt(0);
      const elementAt = node => node && node.nodeType === 3 ? node.parentElement : node;
      const owner = elementAt(s.focusNode)?.closest?.('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]');
      const code = owner ? (owner.querySelector('code[data-type="math-inline"]') || owner.querySelector('code[data-type="math-block"]')) : null;
      return {
        在预览里: !!elementAt(s.focusNode)?.closest?.(PREVIEW),
        焦点节点: s.focusNode.nodeName + '@' + s.focusOffset,
        owner: owner ? owner.nodeName.toLowerCase() + '[' + (owner.dataset.type || '') + ']' : null,
        owner展开: !!owner?.classList.contains('vditor-ir__node--expand'),
        code: code ? code.nodeName + '[' + (code.dataset.type || '') + ']' : null,
        code在owner里: !!(owner && code && owner.contains(code)),
        owner含anchor: !!(owner && owner.contains(s.anchorNode)),
        owner含focus: !!(owner && owner.contains(s.focusNode)),
        surface是root: !!d.querySelector('.vditor-ir .vditor-reset')?.contains(owner),
      }; })()`);
    console.log('守卫复算：' + JSON.stringify(gates));
    const state = await session.js(`(() => { const w = ${IF};
      return {vditor键: Object.keys(w.vditor || {}).slice(0, 24).join(','),
        有ir: !!(w.vditor && w.vditor.ir), 有editor: !!(w.vditor && w.vditor.vditor)}; })()`);
    console.log('编辑器状态：' + JSON.stringify(state));
    // 对照组：行内公式外侧按 → 会不会"进公式"（那是同一个 handler 的 !enclosing 分支）
    await session.js(`(() => { const w = ${IF}, d = w.document; const surface = d.querySelector('.vditor-ir .vditor-reset');
      w.vditor.setValue('前段甲 $ab$ 后段乙\\n'); return 1; })()`);
    await sleep(1400);
    await session.js(`(() => { const w = ${IF}, d = w.document; const surface = d.querySelector('.vditor-ir .vditor-reset');
      surface.focus(); const t = surface.children[0].firstChild;
      const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
      const s = w.getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`);
    await sleep(300);
    await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
    await sleep(400);
    const inlineAfter = await session.js(`(() => { const w = ${IF}, d = w.document; const s = w.getSelection(); const r = s.getRangeAt(0);
      const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
      return {容器: at.nodeName + (at.dataset && at.dataset.type ? '[' + at.dataset.type + ']' : ''), 偏移: r.startOffset,
        在源码里: !!at.closest('code[data-type="math-inline"]')}; })()`);
    console.log('对照组（行内公式外侧按 →，期望"进源码"）：' + JSON.stringify(inlineAfter));
    await session.js(`(() => { const w = ${IF}; w.vditor.setValue('前段甲\\n\\n$$\\na+b=1\\n$$\\n\\n后段乙\\n'); return 1; })()`);
    await sleep(1400);
    await session.click(point.x, point.y);
    await sleep(500);
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, modifiers: harness.MOD.shift});
    await sleep(500);
    const calls = await session.js(`(() => { const w = ${IF}; return w.__arrowProbe || []; })()`);
    console.log('Shift+← 之后的 Selection API 调用：');
    for (const call of calls) console.log(`  ${call.op.padEnd(18)} ← ${call.by}`);
    const trace = await session.js(`(() => { const w = ${IF}; return w.__arrowTrace || []; })()`);
    console.log('\nArrow keydown 轨迹：' + JSON.stringify(trace));
    const errors = await session.js(`(() => { const w = ${IF}; return (w.__acc && w.__acc.errors) || []; })()`);
    console.log('\n页面内异常：' + JSON.stringify(errors));
    const after = await session.js(`(() => { const w = ${IF}; const s = w.getSelection(); const r = s.getRangeAt(0);
      const d = w.document; const path = node => { const at = node.nodeType === 3 ? node.parentElement : node; const out = [];
        for (let cur = at; cur && cur !== d.body; cur = cur.parentElement) out.push(cur.nodeName.toLowerCase() + (cur.dataset && cur.dataset.type ? '[' + cur.dataset.type + ']' : ''));
        return out.slice(0, 4).join('<'); };
      return {collapsed: r.collapsed, text: JSON.stringify(s.toString()), start: path(r.startContainer) + '@' + r.startOffset, end: path(r.endContainer) + '@' + r.endOffset}; })()`);
    console.log('Shift+← 之后选区：' + JSON.stringify(after));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
