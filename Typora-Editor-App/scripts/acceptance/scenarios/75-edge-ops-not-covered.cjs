/** 最后一轮：**只测此前没测过**的奇怪/边缘操作（产物级）。
 *
 *  为什么要单列一条：前面 70–74 覆盖的是"用户报过的那几类"（行尾浮框、$$ 围栏落点、
 *  贴边退格、单元格公式、往返保真、大文档滚动、查找替换/粘贴/剪切）。这一条换一批
 *  **从没跑过**的手势，专挑"结构上最容易把公式拆散"的形状：
 *    A 文档最开头/最末尾就是块公式（前面没有可吞的东西、后面也没有）
 *    B 两条块公式只隔一个空行 / 两条行内公式相邻
 *    C 块公式后面紧跟标题、紧跟列表；列表项里带行内公式
 *    D Ctrl+A 全选 + 一次删除 + 撤销（整篇过一遍）
 *    E Ctrl+Backspace / Ctrl+Delete（按词删）、展开后连按方向键穿越围栏
 *    F 双击公式、三击段落（选词手势落在公式上）
 *    G 查找替换**命中公式源码内部**
 *  判据一律落在"磁盘字节 / 真实 DOM 几何 / 逐字节往返"上；每个检查都留截图
 *  （截图名带编号与动作，落在 .perf/acceptance/<label>/75-edge-ops-not-covered/）。
 *  素材规矩：受保护素材先复制、结束删副本，原素材不动。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const MATERIAL_FORMULA = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/排版测试-数理逻辑1(1).md';
const MATERIAL_RICH = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';
const SURFACE = JSON.stringify(edge.SURFACE);

/** iframe 内的读数：光标、展开态、围栏、提示、值。 */
const READ = `(() => {
  const w = document.getElementById('editor').contentWindow;
  const doc = w.document;
  const root = doc.querySelector(${SURFACE});
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const at = range ? range.startContainer : null;
  const element = at && at.nodeType === 3 ? at.parentElement : at;
  const rects = range ? range.getClientRects() : null;
  const value = w.vditor.getValue();
  return {
    caretTag: element ? element.tagName : null,
    // 光标的容器**本身**是什么：'text' 表示位置落在文本节点里（字符偏移），
    // 别的（如 'H2'）表示位置落在**元素**的子节点边界上（偏移是"第几个子节点"）。
    // 这两种形状不能混为一谈：Blink 对后者的折叠 Range 一律不给绘制矩形（实测），
    // 于是"0 绘制矩形"在那里是读数假阳性，不代表光标真的看不见。
    caretStartKind: at ? (at.nodeType === 3 ? 'text' : at.tagName) : null,
    caretType: element && element.dataset ? (element.dataset.type || '') : '',
    caretText: at && at.nodeType === 3 ? at.data.slice(0, 24) : null,
    offset: range ? range.startOffset : -1,
    inMathCode: !!(element && element.closest && element.closest('code[data-type="math-inline"],code[data-type="math-block"]')),
    expanded: doc.querySelectorAll('.vditor-ir__node--expand').length,
    hint: (doc.querySelector('.typora-context-toast') || {}).textContent || null,
    value,
    chars: value.length,
    fences: (value.match(/\\$\\$/g) || []).length,
    blocks: doc.querySelectorAll('code[data-type="math-block"]').length,
    caretRects: rects ? rects.length : 0,
  };
})()`;

/** 一次点击 → 一个键 → 再读一次。返回 {before, placed, after, unchanged...}。 */
const press = (session, key, vk, modifiers = 0) => session.key({ key, code: key, vk, modifiers });

/** 逐字符的真按键（keydown + char + keyup）。`session.type` 走的是 Input.insertText，
 *  对"清空之后接着打字会不会打进公式源码"这条判据，用真按键更贴近人手。 */
const typeReal = async (session, text) => {
  for (const char of text) {
    await session.key({ key: char, code: 'Key' + char.toUpperCase(), vk: char.toUpperCase().charCodeAt(0), text: char });
    await harness.sleep(60);
  }
};

/** 逐处不同的行（只用于证人输出）。 */
const firstDiff = (before, after) => {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return { atLine: index + 1, before: a[index] === undefined ? null : a[index].slice(0, 60), after: b[index] === undefined ? null : b[index].slice(0, 60) };
};

/** 光标归属的完整转储：容器链、所属公式节点、它的类（是否展开）、当前展开节点清单。 */
const CARET_STATE = `(() => {
  const w = document.getElementById('editor').contentWindow;
  const doc = w.document;
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) return {range: false};
  const path = [];
  let node = range.startContainer;
  while (node && node.nodeType === 1 && path.length < 7) {
    path.push(node.tagName + (node.dataset && node.dataset.type ? '[' + node.dataset.type + ']' : '') + '.' + String(node.className).split(/\\s+/).filter(Boolean).join('.'));
    node = node.parentElement;
  }
  const start = range.startContainer;
  const element = start && start.nodeType === 3 ? start.parentElement : start;
  const owner = element && element.closest ? element.closest('.vditor-ir__node,.vditor-wysiwyg__block') : null;
  return {
    range: true,
    startKind: start ? (start.nodeType === 3 ? 'text' : start.tagName) : null,
    offset: range.startOffset,
    textLength: start && start.nodeType === 3 ? start.data.length : null,
    textTail: start && start.nodeType === 3 ? start.data.slice(-12) : null,
    path: path.join(' < '),
    ownerClass: owner ? String(owner.className).split(/\\s+/).filter(Boolean).join(' ') : null,
    ownerType: owner && owner.dataset ? owner.dataset.type : null,
    ownerExpanded: owner ? owner.classList.contains('vditor-ir__node--expand') : null,
    inMathCode: !!(element && element.closest && element.closest('code[data-type="math-inline"],code[data-type="math-block"]')),
    expandedOwners: [...doc.querySelectorAll('.vditor-ir__node--expand')].map(item => (item.dataset.type || item.tagName) + (item.textContent ? ':' + item.textContent.replace(/\\s+/g, '').slice(0, 12) : '')),
    visibleSource: !!(element && element.closest && element.closest('code') && element.closest('code').getClientRects().length),
  };
})()`;

const blockOwner = needle => `(() => {
  const doc = document.getElementById('editor').contentWindow.document;
  return [...doc.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(owner => owner.textContent.includes(${JSON.stringify(needle)})) || null;
})()`;

const pointOf = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow;
  const node = (${finder});
  if (!node) return {ok: false, error: '找不到目标'};
  if (node.scrollIntoView) node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
  return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2),
    left: Math.round(frameRect.x + rect.x), top: Math.round(frameRect.y + rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height)};
})()`;

module.exports = {
  id: '75-edge-ops-not-covered',
  title: '只测此前没测过的手势：文档首尾公式、相邻公式、公式贴标题/列表、Ctrl+A、按词删、方向键穿越围栏、双击选词、公式源码里的查找替换（产物级）',
  async run(ctx) {
    // 截图计数器：每个检查都有前后两张，名字唯一（session.shot 同名会覆盖）。
    let shotIndex = 0;
    const shot = async (session, label) => {
      shotIndex += 1;
      const name = '75-' + String(shotIndex).padStart(2, '0') + '-' + label;
      try { await session.shot(name); ctx.witness('截图', {name: name + '.png'}); } catch (error) { ctx.witness('截图失败', {name, error: String(error && error.message)}); }
      return name;
    };

    const fixture = fixtures.write('edge-ops.md', [
      '$$',
      'a0+b0=1',
      '$$',
      '',
      '文档第一段普通文字，用来确认首块公式没有被牵连。',
      '',
      '$$',
      'a1+b1=1',
      '$$',
      '',
      '$$',
      'a2+b2=2',
      '$$',
      '',
      '两条块公式之间上面那一行是空行。',
      '',
      '紧邻的行内公式：$i1+1$ $i2+2$ 以及 $i3+3$',
      '',
      '## 紧跟块公式的标题',
      '',
      '$$',
      'a4+b4=4',
      '$$',
      '',
      '- 列表首项 $li1+1$ 后',
      '- 列表次项 $li2+2$ 后',
      '',
      '列表之后的普通段落。',
      '',
      '$$',
      'a5+b5=5',
      '$$',
      '',
    ].join('\n'));
    const original = fs.readFileSync(fixture, 'utf8');
    const session = await ctx.launch({ args: [fixture] });
    const reset = async () => {
      await session.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(original)}); return true;})()`);
      await harness.sleep(800);
      await session.js('(() => {const root = document.getElementById("editor").contentWindow.document.querySelector(' + SURFACE + '); root.focus(); return true;})()');
      await harness.sleep(150);
    };
    try {
      const ready = await session.until(`(() => {
        const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
        const surface = w && w.document && w.document.querySelector(${SURFACE});
        return !!(surface && surface.querySelectorAll('code[data-type="math-block"]').length >= 5);
      })()`, { timeout: 120000, interval: 25 });
      ctx.assert('五条块公式都上屏', ready, `ready=${ready}`);
      if (!ready) return;
      await edge.settle(session);
      const base = await session.js(READ);
      ctx.witness('磁盘：素材原始结构', {bytes: Buffer.byteLength(original, 'utf8'), fences: base.fences, blocks: base.blocks, lines: original.split('\n').length});
      ctx.assert('素材本身合法：围栏成对、块公式 5 条', base.fences === 10 && base.blocks === 5, JSON.stringify({fences: base.fences, blocks: base.blocks}));
      await shot(session, '初始文档');

      // ================= A 文档首尾就是块公式 =================
      // A1：点"文档第一行上方"的留白（真实用户手势：把光标丢到文首）
      const above = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame.contentWindow;
        const root = w.document.querySelector(${SURFACE});
        const first = root.firstElementChild;
        if (!first) return {ok: false};
        const rect = first.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
        return {ok: true, x: Math.round(frameRect.x + rect.x + 6), y: Math.round(frameRect.y + Math.max(0, rect.y - 4)), top: Math.round(rect.y)};
      })()`);
      ctx.assert('能找到"文档最上面那条块公式上方的留白"', above.ok && above.top > 3, JSON.stringify(above));
      if (above.ok) {
        const before = await session.js(READ);
        await shot(session, 'A1-点前');
        await session.click(above.x, above.y);
        await harness.sleep(350);
        const placed = await session.js(READ);
        // 这一下按退格之前，光标的**完整归属**必须留证：是"光标真的在公式源码里（用户正在
        // 编辑）"还是"被 Chromium 映射进了看不见的隐藏源码"。两者处理天差地别。
        const state = await session.js(CARET_STATE);
        await shot(session, 'A1-点了文首留白');
        await press(session, 'Backspace', 8);
        await harness.sleep(450);
        const after = await session.js(READ);
        await shot(session, 'A1-退格后');
        ctx.witness('DOM：文档最上方留白点一下 + 退格', {caret: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode},
          beforePress: state, returnKey: after.caretTag, hint: after.hint, changed: after.value !== before.value});
        ctx.assert('文档首块公式上方点一下 + 退格：文档逐字节不变（首块公式与两条 $$ 都在）',
          after.value === before.value && after.fences === before.fences && /a0\+b0=1/.test(after.value),
          JSON.stringify({diff: firstDiff(before.value, after.value), fences: [before.fences, after.fences]}));
      }
      await reset();
      // A2：Ctrl+Home 到文首再退格
      {
        const before = await session.js(READ);
        await session.chord('Home', 'Home', 36);
        await harness.sleep(300);
        const placed = await session.js(READ);
        await shot(session, 'A2-CtrlHome之后');
        await press(session, 'Backspace', 8);
        await harness.sleep(450);
        const after = await session.js(READ);
        await shot(session, 'A2-退格后');
        ctx.witness('DOM：Ctrl+Home 后按退格', {caret: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode},
          hint: after.hint, changed: after.value !== before.value});
        // 【2026-09-17 口径变更】旧判据是"文档逐字节不变"（围栏/边界上按退格只弹说明）。新口径：
        // 这一下删的是**源码里靠自己这一端的一个字符**（此处=首块公式源码的开头），块公式本体
        // 与 `$$` 围栏原样保留。证据：probe-fence-text.cjs 的 F6/F9。
        ctx.assert('Ctrl+Home 到文档头再按退格：源码少一个字符、块公式与围栏完好（不再"什么都没发生"）',
          after.value !== before.value && (after.fences === before.fences) && (after.blocks === before.blocks) &&
            /(^|\n)0\+b0=1(\n|$)/.test(after.value.replace(/\r/g, '')),
          JSON.stringify({diff: firstDiff(before.value, after.value), fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]}));
      }
      await reset();
      // A3：文档最末尾的块公式之后按 Delete
      {
        const before = await session.js(READ);
        await session.chord('End', 'End', 35);
        await harness.sleep(300);
        const placed = await session.js(READ);
        await shot(session, 'A3-CtrlEnd之后');
        await press(session, 'Delete', 46);
        await harness.sleep(450);
        const after = await session.js(READ);
        await shot(session, 'A3-删除后');
        ctx.witness('DOM：Ctrl+End 到文档尾再按 Delete', {caret: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode},
          hint: after.hint, changed: after.value !== before.value});
        // 【口径变更同上】删除键在源码末尾删的是尾巴那个字符：源码少一个字符、块公式与围栏完好。
        ctx.assert('Ctrl+End 到文档尾（末尾就是块公式）再按 Delete：源码少一个字符、公式与围栏完好',
          /a5\+b5=/.test(after.value) && after.fences === before.fences && after.blocks === before.blocks &&
            after.value !== before.value,
          JSON.stringify({diff: firstDiff(before.value, after.value), fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]}));
      }
      await reset();
      // A4：在文档最开头打字 → 只能新增，不能吃掉首块公式
      {
        const before = await session.js(READ);
        await session.chord('Home', 'Home', 36);
        await harness.sleep(250);
        await session.type('文');
        await harness.sleep(500);
        const after = await session.js(READ);
        await shot(session, 'A4-文首打字后');
        ctx.witness('DOM：文档最开头打一个"文"', {value: after.value.slice(0, 40), fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]});
        ctx.assert('在文档最开头打字：首块公式与围栏一条不少，字符只是新增',
          after.fences === before.fences && after.blocks === before.blocks && /a0\+b0=1/.test(after.value),
          JSON.stringify({fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]}));
      }
      await reset();

      // ================= B 相邻公式 =================
      // B1：两条块公式之间那条空行的像素带，点一下再退格
      {
        const gap = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const doc = frame.contentWindow.document;
          const owners = [...doc.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
          const first = owners.find(owner => owner.textContent.includes('a1+b1=1'));
          const second = owners.find(owner => owner.textContent.includes('a2+b2=2'));
          if (!first || !second) return {ok: false};
          second.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
          const a = first.getBoundingClientRect(), b = second.getBoundingClientRect(), f = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(f.x + b.x + b.width / 2), yFirstBottom: Math.round(f.y + a.bottom + 3), ySecondTop: Math.round(f.y + b.top - 3)};
        })()`);
        ctx.assert('能找到"两条块公式之间那条空行"的两个像素点', gap.ok, JSON.stringify(gap));
        if (gap.ok) {
          for (const [label, y] of [['上一条公式底部 +3px', gap.yFirstBottom], ['下一条公式顶部 -3px', gap.ySecondTop]]) {
            await reset();
            const before = await session.js(READ);
            await session.click(gap.x, y);
            await harness.sleep(350);
            const placed = await session.js(READ);
            await shot(session, 'B1-' + (y === gap.yFirstBottom ? '上侧' : '下侧') + '-点击后');
            await press(session, 'Backspace', 8);
            await harness.sleep(450);
            const after = await session.js(READ);
            await shot(session, 'B1-' + (y === gap.yFirstBottom ? '上侧' : '下侧') + '-退格后');
            ctx.witness('DOM：两条块公式之间的空行【' + label + '】点一下 + 退格', {caret: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode},
              hint: after.hint, clickChanged: placed.value !== before.value, keyChanged: after.value !== placed.value, fences: [before.fences, placed.fences, after.fences]});
            ctx.assert('两条块公式之间【' + label + '】：点一下 + 一次退格后两条公式源码都还在、$$ 仍成对',
              after.value.includes('a1+b1=1') && after.value.includes('a2+b2=2') && after.fences % 2 === 0 && after.fences >= 8,
              JSON.stringify({diff: firstDiff(before.value, after.value), fences: [before.fences, after.fences]}));
          }
        }
      }
      await reset();
      // B2：两条块公式之间的空行上打字（新增内容，不能把公式吞进新公式）
      {
        const before = await session.js(READ);
        const gap = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const doc = frame.contentWindow.document;
          const owners = [...doc.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
          const second = owners.find(owner => owner.textContent.includes('a2+b2=2'));
          if (!second) return {ok: false};
          second.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
          const b = second.getBoundingClientRect(), f = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(f.x + b.x + b.width / 2), y: Math.round(f.y + b.top - 3)};
        })()`);
        if (gap.ok) {
          await session.click(gap.x, gap.y);
          await harness.sleep(300);
          await session.type('隔');
          await harness.sleep(500);
          const after = await session.js(READ);
          await shot(session, 'B2-两条公式之间打字后');
          ctx.witness('DOM：两条块公式之间打字', {value: after.value.split('\n').slice(2, 10), fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]});
          ctx.assert('在两条块公式之间打字：两条公式源码都在、围栏依旧成对、块公式数量不变',
            after.value.includes('a1+b1=1') && after.value.includes('a2+b2=2') && after.fences === before.fences && after.blocks === before.blocks,
            JSON.stringify({diff: firstDiff(before.value, after.value), fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]}));
        }
      }
      await reset();
      // B3：相邻行内公式之间退格（只删分隔的空格）
      {
        // "两条相邻行内公式之间的缝隙"= 第二条公式节点之前的那个位置。$ 是渲染器生成的
        // 围栏标记、不在文本节点里，所以不能靠文本节点里 indexOf('$i2+2$') 去找（第一版
        // 就是这么写、永远找不到）。
        const spot = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const root = doc.querySelector(${SURFACE});
          const code = [...root.querySelectorAll('code[data-type="math-inline"]')].find(node => node.textContent === 'i2+2');
          if (!code) return {ok: false, error: '没有 i2+2 这条行内公式'};
          const owner = code.closest('.vditor-ir__node');
          if (!owner) return {ok: false, error: '找不到公式节点'};
          const r = doc.createRange(); r.setStartBefore(owner); r.collapse(true);
          const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
          const rect = r.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(frameRect.x + rect.x + 1), y: Math.round(frameRect.y + rect.y + Math.max(1, rect.height / 2)),
            beforeText: (owner.previousSibling && owner.previousSibling.textContent) || null};
        })()`);
        ctx.assert('能找到两条相邻行内公式之间的缝隙', spot.ok, JSON.stringify(spot));
        if (spot.ok) {
          const before = await session.js(READ);
          await session.click(spot.x, spot.y);
          await harness.sleep(300);
          const placed = await session.js(READ);
          await shot(session, 'B3-相邻行内公式之间点击后');
          const at = placed.offset;
          const node = placed.caretText;
          await press(session, 'Backspace', 8);
          await harness.sleep(450);
          const after = await session.js(READ);
          await shot(session, 'B3-退格后');
          ctx.witness('DOM：两条相邻行内公式之间退格', {caret: {text: node, offset: at, inCode: placed.inMathCode}, hint: after.hint,
            line: (after.value.match(/紧邻的行内公式[^\n]*/) || [''])[0], fences: [before.fences, after.fences]});
          ctx.assert('两条相邻行内公式之间退格：两条公式都还在、围栏成对（删掉的只是它们之间的普通文字）',
            after.value.includes('$i1+1$') && after.value.includes('$i2+2$') && after.fences === before.fences,
            JSON.stringify({diff: firstDiff(before.value, after.value), line: (after.value.match(/紧邻的行内公式[^\n]*/) || [''])[0]}));
        }
      }
      await reset();

      // ================= C 公式贴标题 / 贴列表 / 列表里的公式 =================
      // C1：紧跟块公式的标题，行首退格
      {
        const placed = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const root = doc.querySelector(${SURFACE});
          const heading = [...root.children].find(node => /紧跟块公式的标题/.test(node.textContent || '') && /^H[1-6]$/.test(node.tagName));
          if (!heading) return {ok: false};
          const text = [...heading.childNodes].find(node => node.nodeType === 3 && node.data.trim());
          if (!text) return {ok: false};
          const r = doc.createRange(); r.setStart(text, 0); r.collapse(true);
          const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
          return {ok: true, tag: heading.tagName};
        })()`);
        ctx.assert('能找到"紧跟块公式的标题"并把光标放到它的行首', placed.ok, JSON.stringify(placed));
        if (placed.ok) {
          const before = await session.js(READ);
          await shot(session, 'C1-标题行首退格前');
          await press(session, 'Backspace', 8);
          await harness.sleep(500);
          const after = await session.js(READ);
          await shot(session, 'C1-标题行首退格后');
          ctx.witness('DOM：块公式之后的标题行首退格', {hint: after.hint, fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks],
            headingLine: (after.value.match(/[^\n]*紧跟块公式的标题[^\n]*/) || ['（标题没了）'])[0]});
          ctx.assert('块公式后面的标题行首退格：块公式源码与围栏一条不少（标题没有被并进公式）',
            after.value.includes('a4+b4=4') && after.fences === before.fences && after.blocks === before.blocks,
            JSON.stringify({diff: firstDiff(before.value, after.value)}));
        }
      }
      await reset();
      // C2：列表首项行首退格
      {
        const placed = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const root = doc.querySelector(${SURFACE});
          const item = [...root.querySelectorAll('li')].find(node => (node.textContent || '').includes('列表首项'));
          if (!item) return {ok: false};
          const text = [...item.childNodes].find(node => node.nodeType === 3 && node.data.trim());
          if (!text) return {ok: false};
          const r = doc.createRange(); r.setStart(text, 0); r.collapse(true);
          const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
          return {ok: true};
        })()`);
        ctx.assert('能找到"列表首项"并把光标放到它的行首', placed.ok, JSON.stringify(placed));
        if (placed.ok) {
          const before = await session.js(READ);
          await shot(session, 'C2-列表首项退格前');
          await press(session, 'Backspace', 8);
          await harness.sleep(500);
          const after = await session.js(READ);
          await shot(session, 'C2-列表首项退格后');
          ctx.witness('DOM：列表首项行首退格', {hint: after.hint, line: (after.value.match(/[^\n]*列表首项[^\n]*/) || ['（没了）'])[0]});
          ctx.assert('列表首项行首退格：这一项里的行内公式完好（$li1+1$ 还在、围栏成对）',
            after.value.includes('$li1+1$') && after.fences === before.fences,
            JSON.stringify({diff: firstDiff(before.value, after.value)}));
        }
      }
      await reset();
      // C3：列表项里，光标贴在行内公式之前退格
      {
        const placed = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const root = doc.querySelector(${SURFACE});
          const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node = null;
          while (walker.nextNode()) { if (walker.currentNode.data.includes('列表次项')) { node = walker.currentNode; break; } }
          if (!node) return {ok: false};
          const r = doc.createRange(); r.setStart(node, node.data.length); r.collapse(true);
          const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
          return {ok: true, text: node.data};
        })()`);
        ctx.assert('能把光标放到"列表次项"这一行的行尾（紧贴行内公式之后）', placed.ok, JSON.stringify(placed));
        if (placed.ok) {
          const before = await session.js(READ);
          await shot(session, 'C3-列表项行尾退格前');
          await press(session, 'Backspace', 8);
          await harness.sleep(450);
          const after = await session.js(READ);
          await shot(session, 'C3-列表项行尾退格后');
          ctx.witness('DOM：列表项里贴着行内公式退格', {hint: after.hint, line: (after.value.match(/[^\n]*列表次项[^\n]*/) || ['（没了）'])[0]});
          ctx.assert('列表项里贴着行内公式退格：公式完好（$li2+2$ 还在）、围栏成对、列表项没被拉平',
            after.value.includes('$li2+2$') && after.fences === before.fences && /- 列表次项/.test(after.value),
            JSON.stringify({diff: firstDiff(before.value, after.value)}));
        }
      }
      await reset();

      // ================= D Ctrl+A 全选 =================
      {
        const before = await session.js(READ);
        // 只需要按**一次**。实测第二次 Ctrl+A 会在 Chromium 里继续往外升级、选到外壳页的
        // 界面文字上（选区从 118 个字符掉到 7 个），第一版连按两次反而把选区弄丢了。
        await session.chord('a', 'KeyA', 65);
        await harness.sleep(400);
        // 判据要拿"看得见的文本"比"看得见的文本"：surface.textContent 含 $$ 围栏与
        // display:none 的 TeX 源码，而 getSelection().toString() 不给隐藏子树，
        // 直接比就是拿苹果比橘子（第一版就是这么把"其实全选了"误判成"只选了 56%"）。
        // 这里现场算一遍"可见文本长度"，并且额外要求选区**跨了首尾两块**。
        const selected = await session.js(`(() => {
          const w = document.getElementById('editor').contentWindow;
          const doc = w.document;
          const s = w.getSelection();
          const surface = doc.querySelector(${SURFACE});
          const range = s.rangeCount ? s.getRangeAt(0) : null;
          let visible = 0;
          if (surface) {
            const walker = doc.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (node.parentElement && node.parentElement.getClientRects().length) visible += node.length;
            }
          }
          const blockOf = container => {
            if (!container || !surface) return null;
            const element = container.nodeType === 3 ? container.parentElement : container;
            const block = element && element.closest ? element.closest('[data-block]') : null;
            return block ? [...surface.children].indexOf(block) : null;
          };
          return {ranges: s.rangeCount, text: range ? s.toString().length : 0, visible,
            collapsed: range ? range.collapsed : null, visibleChars: visible,
            firstBlock: range ? blockOf(range.startContainer) : null, lastBlock: range ? blockOf(range.endContainer) : null,
            blockCount: surface ? surface.children.length : 0};
        })()`);
        await shot(session, 'D1-CtrlA全选');
        ctx.witness('DOM：Ctrl+A 之后的选区', {selected, markdownChars: before.chars});
        // 判据用**结构**：选区从第 0 块跨到最后一块（长度比不能用——surface.textContent 与
        // 我现场算的"可见文本"都含 0×0 的隐藏源码，而 getSelection().toString() 不给它，
        // 实测 118 对 184，长度比必然误判）。长度数字照样进证人栏。
        ctx.assert('Ctrl+A 真的选中了整篇（选区从第一块跨到最后一块，且不是折叠选区）',
          selected.ranges >= 1 && selected.collapsed === false && selected.text > 0
            && selected.firstBlock === 0 && selected.lastBlock === selected.blockCount - 1,
          JSON.stringify({selected, markdownChars: before.chars}));
        await press(session, 'Backspace', 8);
        await harness.sleep(700);
        const cleared = await session.js(READ);
        const clearedCaret = await session.js(CARET_STATE);
        await shot(session, 'D1-全选后退格');
        // 2.1.5 之前这里只记账、不判据：实测残留一个空 `$$` 壳（`"$$\n\n\n$$\n"`）**且光标在
        // 源码里**，接着打字会直接进公式源码（打 abc 得到 `$$\nabc\n$$`）。2.1.5 修掉之后
        // 残留必须是空段落、光标不许在公式源码里——所以这条判据从"只允许一个空 $$ 壳"改成
        // "光标不在公式源码里"，并把残留原样记进证人栏。
        ctx.witness('DOM：全选 + 一次退格', {chars: [before.chars, cleared.chars], fences: [before.fences, cleared.fences],
          blocks: [before.blocks, cleared.blocks], leftover: cleared.value,
          caret: {inMathCode: clearedCaret.inMathCode, ownerType: clearedCaret.ownerType, offset: clearedCaret.offset,
            ownerExpanded: clearedCaret.ownerExpanded, path: clearedCaret.path}});
        ctx.assert('Ctrl+A 全选 + 一次退格：正文与每一条公式的源码都被删净（残留只允许一个空 $$ 壳）',
          cleared.chars < 20 && cleared.fences <= 2 && cleared.blocks <= 1
            && !/a0\+b0|a1\+b1|a2\+b2|a4\+b4|a5\+b5|i1\+1|i2\+2|i3\+3|li1\+1|li2\+2/.test(cleared.value),
          JSON.stringify({chars: [before.chars, cleared.chars], fences: [before.fences, cleared.fences],
            blocks: [before.blocks, cleared.blocks], leftover: cleared.value}));
        // 清空之后光标不许停在公式源码里：停在源码里 = 用户接着打字会打进 TeX（2.1.4 实测
        // `$$\nabc\n$$`）。判据落在"光标归属"上，不看残留形状（空段落/空壳都算过，只看光标）。
        ctx.assert('Ctrl+A 全选 + 一次退格之后：光标不在公式源码里（接着打字进的是正文）',
          clearedCaret.inMathCode === false,
          JSON.stringify({inMathCode: clearedCaret.inMathCode, path: clearedCaret.path, leftover: cleared.value}));
        await typeReal(session, 'abc');
        await harness.sleep(700);
        const typed = await session.js(READ);
        await shot(session, 'D1-清空后打字');
        ctx.witness('DOM：清空之后接着打字', {value: typed.value.slice(0, 40), chars: typed.chars});
        ctx.assert('Ctrl+A 全选 + 一次退格之后接着打字：字进的是正文，不会变成公式源码',
          typed.value.trim() === 'abc' && typed.fences === 0,
          JSON.stringify({value: typed.value, fences: typed.fences, blocks: typed.blocks}));
        // 撤销：先撤掉这一下打字，再撤掉那次清空
        await session.chord('z', 'KeyZ', 90);
        await harness.sleep(500);
        await session.chord('z', 'KeyZ', 90);
        await harness.sleep(900);
        const undone = await session.js(READ);
        await shot(session, 'D1-撤销之后');
        ctx.witness('DOM：清空之后 Ctrl+Z', {chars: undone.chars, fences: undone.fences, blocks: undone.blocks, sameAsOriginal: undone.value === original});
        ctx.assert('清空后 Ctrl+Z 撤销：文档逐字节回到原文（围栏与五条块公式都回来了）',
          undone.value === original,
          JSON.stringify({diff: firstDiff(original, undone.value), fences: undone.fences, blocks: undone.blocks}));
      }
      await reset();

      // ================= E 按词删 + 方向键穿越围栏 =================
      {
        // E1 Ctrl+Backspace：光标贴在第一条块公式源码开头之前
        const placed = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const root = doc.querySelector(${SURFACE});
          const owner = [...root.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(node => node.textContent.includes('a1+b1=1'));
          if (!owner) return {ok: false};
          const r = doc.createRange(); r.setStartBefore(owner); r.collapse(true);
          const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
          return {ok: true};
        })()`);
        if (placed.ok) {
          const before = await session.js(READ);
          await shot(session, 'E1-CtrlBackspace前');
          await session.key({ key: 'Backspace', code: 'Backspace', vk: 8, modifiers: 2 });
          await harness.sleep(500);
          const after = await session.js(READ);
          await shot(session, 'E1-CtrlBackspace后');
          ctx.witness('DOM：贴块公式按 Ctrl+Backspace（按词删）', {hint: after.hint, fences: [before.fences, after.fences], blocks: [before.blocks, after.blocks]});
          ctx.assert('贴块公式按 Ctrl+Backspace：公式源码与围栏一条不少',
            after.value.includes('a1+b1=1') && after.fences === before.fences && after.blocks === before.blocks,
            JSON.stringify({diff: firstDiff(before.value, after.value)}));
        } else {
          ctx.assert('能定位第一条块公式（Ctrl+Backspace 用例）', false, JSON.stringify(placed));
        }
      }
      await reset();
      {
        // E2 展开块公式后连按方向键穿越围栏
        const block = await session.js(pointOf(blockOwner('a4+b4=4')));
        if (block.ok) {
          await session.click(block.x, block.y);
          await harness.sleep(500);
          const before = await session.js(READ);
          await shot(session, 'E2-展开后');
          const trail = [];
          // 先把"读数假阳性"这件事钉成证据：把 Range 放在标题 `<h2>` 的**每个子节点边界**上，
          // 看各自报几个绘制矩形。若全是 0，就说明这种形状下这条读数不适用（与光标可不可见无关）。
          const boundaryScan = await session.js(`(() => {
            const frame = document.getElementById('editor');
            const w = frame.contentWindow;
            const doc = w.document;
            const root = doc.querySelector(${SURFACE});
            const h2 = root.querySelector('h2');
            if (!h2) return {ok: false};
            const probe = k => {
              const range = doc.createRange();
              range.setStart(h2, k); range.collapse(true);
              return range.getClientRects().length;
            };
            return {ok: true, childCount: h2.childNodes.length,
              rectsAtBoundary: Array.from({length: h2.childNodes.length + 1}, (_, k) => ({k, rects: probe(k)})),
              childNodes: [...h2.childNodes].map(node => (node.nodeType === 3 ? 'text(' + node.data.length + ')' : node.nodeName + '.' + String(node.className).slice(0, 40)))};
          })()`);
          ctx.witness('DOM：折叠 Range 放在标题元素各子节点边界上的绘制矩形读数（判"假阳性"用）', boundaryScan);
          for (let index = 0; index < 8; index++) {
            await press(session, 'ArrowLeft', 37);
            await harness.sleep(160);
            const at = await session.js(READ);
            // 立刻读到 0 个绘制矩形时再读一次（等一帧）：Vditor 把 `##` 标记展开/收起是
            // 异步的，单次采样会把"正在重排的那一帧"记成"光标画不出来"。瞬态与持续状态
            // 都要记账，不能只记对自己有利的那个。
            let settled = null;
            if (at.caretRects === 0) { await harness.sleep(260); settled = await session.js(READ); }
            trail.push({tag: at.caretTag, startKind: at.caretStartKind, type: at.caretType, offset: at.offset,
              rects: at.caretRects, boundary: at.caretStartKind !== 'text',
              settledRects: settled ? settled.caretRects : null, settledTag: settled ? settled.caretTag : null,
              inMathCode: at.inMathCode, chars: at.chars});
          }
          await shot(session, 'E2-连按左方向键后');
          const after = await session.js(READ);
          ctx.witness('DOM：展开块公式后连按 8 次左方向键的光标轨迹', trail);
          // 2.1.4 这一条曾经把第 1 步记成"落在标题的 ## 标记里、画不出光标"，那是**读数本身
          // 的假阳性**：那一步 range.startContainer 是 `<h2>` **元素**本身（offset=2 是子节点
          // 边界，不是字符偏移），而 Blink 对"容器是元素、位置在子节点边界"的折叠 Range
          // 一律返回 0 个绘制矩形——实测把 Range 放在 (h2, 0/1/2) 三个子边界上，读数全是 0。
          // 放大截图证实那一帧光标**是画出来的**（`## 紧跟块公式的标题` 后面那根竖线）。
          // 所以判据只钉在"公式源码"这条不变量上：光标不许停在**不可见的公式源码**里；
          // 落点是元素边界时单独归类，不当成"看不见的光标"。
          const inCode=trail.filter(step => step.inMathCode);
          const boundary=trail.filter(step => step.boundary && !step.inMathCode);
          ctx.log('E2：8 步里 ' + inCode.length + ' 步在公式源码里、' + boundary.length + ' 步落在元素边界（读数不适用：'
            + JSON.stringify(boundary.map(step => step.tag + '@' + step.offset)) + '），其余 ' + (8 - inCode.length - boundary.length) + ' 步是正文文本位');
          ctx.assert('展开块公式后连按左方向键：光标不会停在看不见的**公式源码**里（隐藏源码 = 0 绘制矩形）',
            !trail.some(step => step.inMathCode && step.rects === 0), JSON.stringify(trail));
          ctx.assert('连按左方向键穿越围栏：文档一个字节都没改', after.chars === before.chars, JSON.stringify({chars: [before.chars, after.chars], diff: firstDiff(before.value, after.value)}));
        } else {
          ctx.assert('能定位 a4+b4=4 这条块公式（方向键用例）', false, JSON.stringify(block));
        }
      }
      await reset();

      // ================= F 双击公式 / 三击段落 =================
      {
        const target = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const doc = frame.contentWindow.document;
          const root = doc.querySelector(${SURFACE});
          const preview = [...root.querySelectorAll('.vditor-ir__preview')].find(node => (node.textContent || '').includes('i1+1'));
          if (!preview) return {ok: false};
          preview.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
          const rect = preview.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
        })()`);
        ctx.assert('能找到行内公式的渲染块（双击用例）', target.ok, JSON.stringify(target));
        if (target.ok) {
          const before = await session.js(READ);
          await session.click(target.x, target.y, { clickCount: 2 });
          await harness.sleep(450);
          const after = await session.js(READ);
          const selection = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; const s = w.getSelection(); return s.rangeCount ? s.toString().slice(0, 40) : null;})()`);
          await shot(session, 'F1-双击行内公式');
          ctx.witness('DOM：双击行内公式', {selection, changed: after.value !== before.value, caret: {type: after.caretType, offset: after.offset, inCode: after.inMathCode}});
          ctx.assert('双击行内公式：文档一个字节都不改（只是选词/展开，不会把公式弄坏）', after.value === before.value,
            JSON.stringify({diff: firstDiff(before.value, after.value), selection}));
        }
      }
      await reset();
      {
        const para = await session.js(pointOf(`(() => {
          const root = document.getElementById('editor').contentWindow.document.querySelector(${SURFACE});
          return [...root.children].find(node => (node.textContent || '').includes('两条块公式之间上面那一行是空行')) || null;
        })()`));
        if (para.ok) {
          const before = await session.js(READ);
          await session.click(para.x, para.y, { clickCount: 3 });
          await harness.sleep(450);
          const after = await session.js(READ);
          await shot(session, 'F2-三击段落');
          ctx.witness('DOM：三击普通段落', {changed: after.value !== before.value});
          ctx.assert('三击普通段落：文档一个字节都不改', after.value === before.value, JSON.stringify({diff: firstDiff(before.value, after.value)}));
        } else {
          ctx.assert('能找到用于三击的普通段落', false, JSON.stringify(para));
        }
      }
      await reset();

      // ================= G 查找替换命中公式源码内部 =================
      {
        // 先把焦点交给编辑器：快捷键是编辑器自己处理的，焦点在外壳页上时 Ctrl+F 根本到不了
        // （第一版没点这一下，面板自然不开）。
        const focus = await session.js(pointOf(`(() => {
          const root = document.getElementById('editor').contentWindow.document.querySelector(${SURFACE});
          return [...root.children].find(node => (node.textContent || '').includes('两条块公式之间上面那一行是空行')) || null;
        })()`));
        ctx.assert('能把焦点交给编辑器（查找用例的前置）', focus.ok, JSON.stringify(focus));
        if (focus.ok) {
          await session.click(focus.x, focus.y);
          await harness.sleep(300);
          const before = await session.js(READ);
          await session.chord('f', 'KeyF', 70);
          await harness.sleep(600);
          const panel = await session.js(`(() => {
            const doc = document.getElementById('editor').contentWindow.document;
            return {open: !!doc.querySelector('#typora-find')};
          })()`);
          await shot(session, 'G1-查找面板');
          ctx.assert('Ctrl+F 打开了查找面板', panel.open, JSON.stringify(panel));
          if (panel.open) {
            const input = await session.js(pointOf(`(() => {
              const doc = document.getElementById('editor').contentWindow.document;
              return doc.querySelector('#typora-find [data-field="query"]');
            })()`));
            if (input.ok) { await session.click(input.x, input.y); await harness.sleep(150); }
            await session.type('a1+b1=1');
            const counted = await session.until(`(() => {
              const panel = document.getElementById('editor').contentWindow.document.querySelector('#typora-find');
              if (!panel) return false;
              const hit = /(\\d+)\\s*\\/\\s*(\\d+)/.exec((panel.querySelector('output') || {}).textContent || '');
              return !!hit && Number(hit[2]) > 0;
            })()`, {timeout: 20000, interval: 120});
            await shot(session, 'G1-输入查询词');
            const hits = await session.js(`(() => {
              const panel = document.getElementById('editor').contentWindow.document.querySelector('#typora-find');
              return {count: panel ? (panel.querySelector('output') || {}).textContent : null,
                status: panel ? (panel.querySelector('[role="status"]') || {}).textContent : null};
            })()`);
            ctx.witness('DOM：查找公式源码的命中回报', {counted, hits});
            ctx.assert('查找能命中公式源码里的文字（面板回报非零命中）', counted === true && /\d+\s*\/\s*[1-9]/.test(String(hits.count)),
              JSON.stringify({counted, hits}));
            await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
            await harness.sleep(400);
            const closed = await session.js(`(() => !!document.getElementById('editor').contentWindow.document.querySelector('#typora-find'))()`);
            await shot(session, 'G1-关闭查找');
            ctx.assert('Esc 关掉了查找面板', closed === false, JSON.stringify({closed}));
            ctx.assert('查找没有改文档一个字', (await session.js(READ)).value === before.value, '');
          }
        }
      }
      await reset();
      {
        // G2：源码视图里改公式源码的围栏字符（未测过：直接编辑 $$）
        const before = await session.js(READ);
        // 源码视图的入口是工具栏上那个真按钮（产品自己注册的 source-toggle），不是
        // hostApi 上的命令名——第一版瞎猜命令名，模式一动没动。
        const button = await session.js(pointOf(`(() => {
          const w = document.getElementById('editor').contentWindow;
          const element = w.vditor && w.vditor.vditor && w.vditor.vditor.toolbar && w.vditor.vditor.toolbar.elements['source-toggle'];
          return element ? (element.querySelector('button') || element) : null;
        })()`));
        ctx.witness('源码视图按钮', button);
        if (button.ok) { await session.click(button.x, button.y); }
        await harness.sleep(1200);
        const mode = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.vditor.currentMode;})()`);
        await shot(session, 'G2-切到源码视图');
        ctx.witness('视图切换', {mode});
        if (mode === 'sv') {
          const svValue = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.getValue ? w.vditor.getValue() : null;})()`);
          // 判据算到"正文内容"为止：实测切一次源码视图会在**文末**多出一个空行（Lute 归一化），
          // 那是视图切换的既有行为、与公式无关；逐字节的差异照样进证人栏，不藏。
          const bodyOf = text => String(text).replace(/[\s\u200b]+$/, '');
          ctx.witness('DOM：源码视图里的文档', {same: String(svValue) === before.value, bodySame: bodyOf(svValue) === bodyOf(before.value),
            head: String(svValue).slice(0, 40), tailDiff: {before: JSON.stringify(before.value.slice(-12)), sv: JSON.stringify(String(svValue).slice(-12))}});
          ctx.assert('切到源码视图之后正文内容不变（公式围栏原样）', bodyOf(svValue) === bodyOf(before.value),
            JSON.stringify({same: String(svValue) === before.value, head: String(svValue).slice(0, 40)}));
          if (button.ok) { await session.click(button.x, button.y); }
          await harness.sleep(1400);
          const back = await session.js(READ);
          await shot(session, 'G2-切回编辑视图');
          ctx.witness('DOM：切回编辑视图之后', {same: back.value === before.value, bodySame: bodyOf(back.value) === bodyOf(before.value),
            fences: [before.fences, back.fences], blocks: [before.blocks, back.blocks]});
          ctx.assert('源码视图切回编辑视图：正文逐字节还原、围栏成对、块公式还是 5 条（差异只允许在文末空行）',
            bodyOf(back.value) === bodyOf(before.value) && back.fences === before.fences && back.blocks === before.blocks,
            JSON.stringify({diff: firstDiff(before.value, back.value), fences: [before.fences, back.fences], blocks: [before.blocks, back.blocks]}));
        } else {
          ctx.assert('能切到源码视图（这一条是"切过去再切回来"用例的前置）', false, JSON.stringify({mode}));
        }
      }

      // ================= 收尾：错误面 =================
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.assert('全程没有错误提示（乱码 / 失败 / app.asar 之类）', problems.length === 0, JSON.stringify({problems, toasts}));
      await shot(session, '收尾-最终文档');
      await ctx.release(session);
    } finally {
      await ctx.release(session);
      try { fs.writeFileSync(fixture, original); } catch { /* 忽略 */ }
    }

    // ================= 真实文档：只跑"从没在上面跑过"的手势 =================
    for (const [label, materialPath, ops] of [
      ['排版测试', MATERIAL_FORMULA, ['select-all-undo', 'double-click', 'ctrl-backspace']],
      ['富文本测试', MATERIAL_RICH, ['select-all-undo', 'ctrl-end-delete']],
    ]) {
      if (!fs.existsSync(materialPath)) { ctx.assert('受保护素材存在：' + label, false, materialPath); continue; }
      const copy = path.join(fixtures.room, 'material-' + label + '-' + Date.now() + '.md');
      fs.copyFileSync(materialPath, copy);
      try {
        const real = await ctx.launch({ args: [copy] });
        const onReal = await real.until(`(() => {
          const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE});
          return !!(root && root.querySelectorAll('.katex').length >= 4);
        })()`, {timeout: 150000, interval: 30});
        ctx.assert('真实素材【' + label + '】在产物里打开并渲染出公式', onReal, `onReal=${onReal}`);
        if (onReal) {
          await edge.settle(real);
          // 焦点必须先交给编辑器：快捷键由编辑器自己处理，焦点还在外壳页上时按键根本到不了
          // （实测第一版直接发 Ctrl+A，文档一个字符都没变，被误读成"全选+退格没效果"）。
          const into = await real.js(pointOf(`(() => {
            const root = document.getElementById('editor').contentWindow.document.querySelector(${SURFACE});
            return [...root.children].find(node => node.getClientRects().length && node.textContent.trim()) || null;
          })()`));
          if (into.ok) { await real.click(into.x, into.y); await harness.sleep(300); }
          ctx.witness('真实素材【' + label + '】：把焦点交给编辑器的落点', into);
          const start = await real.js(READ);
          ctx.witness('真实素材【' + label + '】：打开时的规模', {chars: start.chars, blocks: start.blocks, fences: start.fences});
          await shot(real, label + '-打开时');

          if (ops.includes('select-all-undo')) {
            await real.chord('a', 'KeyA', 65);
            await harness.sleep(350);
            await shot(real, label + '-CtrlA');
            await press(real, 'Backspace', 8);
            await harness.sleep(900);
            const cleared = await real.js(READ);
            await shot(real, label + '-全选退格后');
            await real.chord('z', 'KeyZ', 90);
            await harness.sleep(1400);
            const undone = await real.js(READ);
            await shot(real, label + '-撤销后');
            ctx.witness('真实素材【' + label + '】全选 → 退格 → 撤销', {chars: [start.chars, cleared.chars, undone.chars],
              blocks: [start.blocks, cleared.blocks, undone.blocks], backToOriginal: undone.value === start.value});
            ctx.assert('真实素材【' + label + '】：全选 + 一次退格清空，撤销后逐字节回到打开时的样子',
              cleared.chars < start.chars * 0.1 && undone.value === start.value,
              JSON.stringify({chars: [start.chars, cleared.chars, undone.chars], diff: firstDiff(start.value, undone.value)}));
          }

          if (ops.includes('double-click')) {
            const spot = await real.js(`(() => {
              const frame = document.getElementById('editor');
              const doc = frame.contentWindow.document;
              const preview = [...doc.querySelectorAll('.vditor-ir__preview')].find(node => node.getClientRects().length && node.getBoundingClientRect().width > 4);
              if (!preview) return {ok: false};
              preview.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
              const rect = preview.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
              return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2), text: preview.textContent.slice(0, 20)};
            })()`);
            if (spot.ok) {
              const before = await real.js(READ);
              await real.click(spot.x, spot.y, {clickCount: 2});
              await harness.sleep(500);
              const after = await real.js(READ);
              await shot(real, label + '-双击公式');
              ctx.witness('真实素材【' + label + '】双击公式', {formula: spot.text, changed: after.value !== before.value, caret: {type: after.caretType, offset: after.offset, inCode: after.inMathCode}});
              ctx.assert('真实素材【' + label + '】：双击一处公式，文档一个字节都不改', after.value === before.value,
                JSON.stringify({diff: firstDiff(before.value, after.value)}));
            } else {
              ctx.assert('真实素材【' + label + '】能找到可视的行内公式（双击用例）', false, JSON.stringify(spot));
            }
          }

          if (ops.includes('ctrl-backspace')) {
            const placed = await real.js(`(() => {
              const frame = document.getElementById('editor');
              const w = frame.contentWindow;
              const doc = w.document;
              const root = doc.querySelector(${SURFACE});
              const owner = [...root.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].find(node => node.getClientRects().length);
              if (!owner) return {ok: false};
              owner.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
              const r = doc.createRange(); r.setStartBefore(owner); r.collapse(true);
              const selection = w.getSelection(); root.focus(); selection.removeAllRanges(); selection.addRange(r);
              // 判据要拿**源码**去 markdown 里找：owner.textContent 含渲染器生成的 $$ 围栏，
              // 那些字符在 markdown 里是另写的（第一版拿它去 includes，永远找不到）。
              const code = owner.querySelector('code[data-type="math-block"]');
              return {ok: true, formula: (code ? code.textContent : owner.textContent).slice(0, 16).replace(/\\s+/g, '')};
            })()`);
            if (placed.ok) {
              const before = await real.js(READ);
              await shot(real, label + '-CtrlBackspace前');
              await real.key({key: 'Backspace', code: 'Backspace', vk: 8, modifiers: 2});
              await harness.sleep(600);
              const after = await real.js(READ);
              await shot(real, label + '-CtrlBackspace后');
              ctx.witness('真实素材【' + label + '】贴块公式按 Ctrl+Backspace', {formula: placed.formula, hint: after.hint,
                blocks: [before.blocks, after.blocks], fences: [before.fences, after.fences]});
              const needle = placed.formula.replace(/\s+/g, '');
              ctx.assert('真实素材【' + label + '】：贴块公式按 Ctrl+Backspace，块公式一条不少、围栏成对、这条公式的源码原样',
                after.blocks === before.blocks && after.fences === before.fences && after.value.replace(/\s+/g, '').includes(needle),
                JSON.stringify({blocks: [before.blocks, after.blocks], fences: [before.fences, after.fences], diff: firstDiff(before.value, after.value)}));
            } else {
              ctx.assert('真实素材【' + label + '】能找到可视的块公式（Ctrl+Backspace 用例）', false, JSON.stringify(placed));
            }
          }

          if (ops.includes('ctrl-end-delete')) {
            const before = await real.js(READ);
            await real.chord('End', 'End', 35);
            await harness.sleep(400);
            await press(real, 'Delete', 46);
            await harness.sleep(600);
            const after = await real.js(READ);
            await shot(real, label + '-文末Delete后');
            ctx.witness('真实素材【' + label + '】Ctrl+End 后按 Delete', {chars: [before.chars, after.chars], blocks: [before.blocks, after.blocks], hint: after.hint});
            ctx.assert('真实素材【' + label + '】：Ctrl+End 到文末再按 Delete，文档结构不变（没有吞掉块公式）',
              after.blocks === before.blocks && after.fences === before.fences,
              JSON.stringify({blocks: [before.blocks, after.blocks], fences: [before.fences, after.fences], diff: firstDiff(before.value, after.value)}));
          }

          const realToasts = await real.js(edge.TOASTS);
          const realProblems = [...(realToasts.recorded || []), ...(realToasts.live || [])].map(edge.errorsOf).flat();
          ctx.assert('真实素材【' + label + '】：全程没有错误提示', realProblems.length === 0, JSON.stringify({realProblems}));
        }
        await ctx.release(real);
      } finally {
        for (let attempt = 0; attempt < 6 && fs.existsSync(copy); attempt++) { try { fs.rmSync(copy, {force: true}); } catch { await harness.sleep(400); } }
        if (fs.existsSync(copy)) ctx.witness('素材副本未能删除（需人工处理）', {copy});
      }
    }
  },
};
