/** 「围栏当普通字符」这一轮的行为量测（只取证）。
 *
 *  用户 2026-09-17 的要求："点退格也好，方向键也好，鼠标拖拽选中也好，最好能直接把这些
 *  fence 当普通字符处理，你现在这样太别扭了，卡手"。这个探针逐个手势量：
 *    F1 行内公式后面退格（用户举的例子）→ 闭围栏那一个 `$` 没了、公式降级成字面文本？
 *    F2 行内公式前面按删除 → 开围栏那一个 `$`？
 *    F3/F4 光标站在围栏文本上按退格/删除
 *    F5/F6 块公式的闭围栏（外侧 / 围栏文本上）退格 → 围栏写成一个 `$`、Lute 怎么重排
 *    F7 把行内公式的内容删空 → 不许突变成块公式围栏（用户报的"突变"）
 *    F8 块公式源码里按住 Shift 连按 ←（每两下塌一次的旧症状）
 *    F9 文档末尾就是块公式时 Ctrl+End + 删除
 *    F10 紧贴块公式的段首退格（块级合并保护：展开+选中，文档不改）
 *    F11 拖拽选中压着行内公式再退格
 *
 *  用法：node scripts/acceptance/probe-fence-text.cjs
 *        node scripts/acceptance/probe-fence-text.cjs --only=F1,F7
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-fence-text');
const IF = `document.getElementById('editor').contentWindow`;

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const READ = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const s = w.getSelection();
  const describe = (node, offset) => {
    if (!node) return 'null';
    const at = node.nodeType === 3 ? node.parentElement : node;
    const path = [];
    for (let cur = at; cur && cur !== d.body; cur = cur.parentElement) path.push(cur.nodeName.toLowerCase() + (cur.dataset && cur.dataset.type ? '[' + cur.dataset.type + ']' : ''));
    return path.slice(0, 5).join('<') + (node.nodeType === 3 ? ':TEXT' : '') + '@' + offset;
  };
  const caret = s.rangeCount ? (() => { const r = s.getRangeAt(0);
    return {collapsed: r.collapsed, text: JSON.stringify(s.toString()).slice(0, 40), anchor: describe(s.anchorNode, s.anchorOffset), focus: describe(s.focusNode, s.focusOffset)}; })() : null;
  return {md: w.vditor.getValue(), caret,
    blocks: [...surface.children].map(node => node.nodeName.toLowerCase() + (node.dataset && node.dataset.type ? '[' + node.dataset.type + ']' : '') + ':' + JSON.stringify(String(node.innerText || '').replace(/\\n+/g, '⏎').slice(0, 34))),
    toast: (d.querySelector('.typora-context-toast') || {}).textContent || null,
    fenceTexts: [...surface.querySelectorAll('[data-type$="-marker"]')].map(node => node.textContent)}; })()`;

const K = {Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowDown: 40};

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'fence.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-fence-text', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  const only = argOf('only', '').split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name);
  const show = async label => {
    const now = await session.js(READ);
    console.log(`  · ${label}\n      块 : ${JSON.stringify(now.blocks)}\n      光标: ${JSON.stringify(now.caret)}\n      提示: ${now.toast ? JSON.stringify(now.toast) : '（无）'}\n      md : ${JSON.stringify(now.md)}`);
    return now;
  };
  const setValue = async text => {
    await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(text)}); return 1; })()`);
    await sleep(1400);
  };
  const place = async (label, js) => {
    const placed = await session.js(`(() => { const w = ${IF}, d = w.document;
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      surface.focus(); const made = (${js});
      if (!made || !made.range) return {ok: false, error: made ? made.why : '没有结果'};
      const s = w.getSelection(); s.removeAllRanges(); s.addRange(made.range);
      return {ok: true, why: made.why}; })()`);
    await sleep(320);
    if (!want(label)) return placed;
    console.log(`  ── ${label} 放位：${JSON.stringify(placed)}`);
    await show('放位后');
    return placed;
  };
  const press = async (key, modifiers = 0) => {
    await session.key({key, code: key, vk: K[key], modifiers});
    await sleep(450);
  };
  const clickBlock = async (index, share) => {
    const hit = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      const block = surface.children[${index}];
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const box = block.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {x: Math.round(fr.x + box.left + box.width / 2), y: Math.round(fr.y + box.top + box.height * ${share})}; })()`);
    await session.click(hit.x, hit.y);
    await sleep(400);
    return hit;
  };

  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);

    if (want('F1')) {
      console.log('\n════ F1 行内公式后面退格（用户举的例子）════');
      await setValue('前段甲 $a$ 后段乙\n');
      await place('F1', `(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const r = d.createRange(); r.setStartAfter(owner); r.collapse(true); return {range: r, why: '行内公式之后'}; })()`);
      await press('Backspace');
      await show('退格一次后');
      await press('Backspace');
      await show('再退格一次后');
    }

    if (want('F2')) {
      console.log('\n════ F2 行内公式前面按删除 ════');
      await setValue('前段甲 $a$ 后段乙\n');
      await place('F2', `(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const r = d.createRange(); r.setStartBefore(owner); r.collapse(true); return {range: r, why: '行内公式之前'}; })()`);
      await press('Delete');
      await show('删除一次后');
    }

    if (want('F3') || want('F4')) {
      console.log('\n════ F3/F4 光标站在围栏文本上 ════');
      await setValue('前段甲 $ab$ 后段乙\n');
      await clickBlock(0, 0.5);
      await show('点公式后（展开）');
      await place('F3', `(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const marks = [...owner.querySelectorAll('.vditor-ir__marker')]; const last = marks[marks.length - 1];
        const t = last.firstChild; const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
        return {range: r, why: '闭 $ 标记末尾'}; })()`);
      await press('Backspace');
      await show('闭围栏上退格后');
      await setValue('前段甲 $ab$ 后段乙\n');
      await clickBlock(0, 0.5);
      await place('F4', `(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const marks = [...owner.querySelectorAll('.vditor-ir__marker')]; const first = marks[0];
        const t = first.firstChild; const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
        return {range: r, why: '开 $ 标记末尾'}; })()`);
      await press('Delete');
      await show('开围栏上删除后');
    }

    if (want('F5') || want('F6')) {
      console.log('\n════ F5 块公式闭围栏之后退格 ════');
      const md = '前段甲\n\n$$\na+b\n$$\n\n后段乙\n';
      await setValue(md);
      await place('F5', `(() => { const owner = surface.children[1]; const r = d.createRange();
        r.setStartAfter(owner); r.collapse(true); return {range: r, why: '块公式之后（位置型）'}; })()`);
      await press('Backspace');
      await show('块闭围栏后退格一次');
      await press('Backspace');
      await show('再退格一次');
      console.log('\n════ F6 块公式闭围栏文本上退格 ════');
      await setValue(md);
      await clickBlock(1, 0.5);
      await show('点块公式（展开）');
      await place('F6', `(() => { const owner = surface.children[1];
        const close = owner.querySelector(':scope > span[data-type="math-block-close-marker"]');
        const t = close.firstChild; const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
        return {range: r, why: '块闭围栏末尾'}; })()`);
      await press('Backspace');
      await show('块闭围栏文本上退格一次');
    }

    if (want('F7')) {
      console.log('\n════ F7 把行内公式内容删空（不许突变成块围栏）════');
      await setValue('前段甲 $ab$ 后段乙\n');
      await clickBlock(0, 0.5);
      await place('F7a', `(() => { const code = surface.querySelector('code[data-type="math-inline"]');
        const t = code.firstChild; const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
        return {range: r, why: '公式源码末尾'}; })()`);
      await press('Backspace');
      await press('Backspace');
      await show('段落里还有文字：内容删空后');
      console.log('  ── 独占一段的行内公式 ──');
      await setValue('前段甲\n\n$ab$\n\n后段乙\n');
      await session.js(`(() => { const w = ${IF}; w.__dbg = {}; return 1; })()`);
      await clickBlock(1, 0.5);
      await place('F7b', `(() => { const code = surface.querySelector('code[data-type="math-inline"]');
        const t = code.firstChild; const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true);
        return {range: r, why: '公式源码末尾'}; })()`);
      await press('Backspace');
      await press('Backspace');
      await show('独占一段：内容删空后（不许变成块围栏）');
      const kids = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        const mid = surface.children[1];
        return {块: mid.nodeName + '[' + (mid.dataset.block || '') + ']',
          子节点: [...mid.childNodes].map((child, index) => index + ':' + child.nodeName
            + (child.nodeType === 3 ? ':' + JSON.stringify(child.data) : '')
            + (child.nodeType === 1 ? ':' + (child.dataset.type || '') + ':' + JSON.stringify(String(child.textContent).slice(0, 12)) : '')
            + (child.nodeType === 1 && child.matches('.vditor-ir__marker') ? ' (marker)' : '')),
          innerHTML: String(mid.innerHTML).slice(0, 200)}; })()`);
      console.log('  独占段的子节点：' + JSON.stringify(kids));
      const dbg = await session.js(`(() => { const w = ${IF}; return w.__dbg || null; })()`);
      console.log('  调试计数器：' + JSON.stringify(dbg));
    }

    if (want('F8')) {
      console.log('\n════ F8 块公式源码里 Shift+← 连按 ════');
      await setValue('前段甲\n\n$$\na+b=1\n$$\n\n后段乙\n');
      await clickBlock(1, 0.5);
      await show('点块公式（展开）');
      for (let step = 1; step <= 4; step++) {
        await press('ArrowLeft', harness.MOD.shift);
        const now = await session.js(READ);
        console.log(`  Shift+← #${step}: 选中=${JSON.stringify(now.caret.text)} anchor=${now.caret.anchor} focus=${now.caret.focus}`);
      }
    }

    if (want('F9')) {
      console.log('\n════ F9 文档末尾是块公式：Ctrl+End + 删除 ════');
      await setValue('前段甲\n\n$$\na+b\n$$\n');
      await session.key({key: 'End', code: 'End', vk: 35, modifiers: harness.MOD.ctrl});
      await sleep(400);
      await show('Ctrl+End 之后');
      await press('Delete');
      await show('删除一次后');
      await press('Delete');
      await show('再删除一次');
    }

    if (want('F10')) {
      console.log('\n════ F10 紧贴块公式的段首退格（块级合并保护）════');
      await setValue('前段甲\n\n$$\na+b\n$$\n\n后段乙\n');
      await place('F10', `(() => { const t = surface.children[2].firstChild; const r = d.createRange(); r.setStart(t, 0); r.collapse(true);
        return {range: r, why: '后段乙开头'}; })()`);
      await press('Backspace');
      await show('段首退格后（应展开+选中，文档不改）');
    }

    if (want('F11')) {
      console.log('\n════ F11 拖拽选中压着行内公式再退格 ════');
      await setValue('前段甲 $ab$ 后段乙\n');
      const drag = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const p = surface.children[0].getBoundingClientRect(), o = owner.getBoundingClientRect(), fr = frame.getBoundingClientRect();
        return {from: {x: Math.round(fr.x + p.left + 2), y: Math.round(fr.y + p.top + p.height / 2)},
          to: {x: Math.round(fr.x + o.right + 6), y: Math.round(fr.y + o.top + o.height / 2)},
          text: JSON.stringify(surface.children[0].innerText)}; })()`);
      await session.click(drag.from.x, drag.from.y);
      await sleep(200);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', buttons: 1, clickCount: 1});
      for (let step = 1; step <= 6; step++) {
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', buttons: 1,
          x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 6), y: drag.from.y});
        await sleep(40);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', buttons: 0, clickCount: 1});
      await sleep(450);
      await show('拖过行内公式（应翻成源码）');
      await press('Backspace');
      await show('拖选后退格');
    }

    const errors = await session.jsSoft(`(() => { const w = ${IF}; return (w.__acc && w.__acc.errors) || []; })()`);
    console.log('\nconsole 错误：' + JSON.stringify(errors.value));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
