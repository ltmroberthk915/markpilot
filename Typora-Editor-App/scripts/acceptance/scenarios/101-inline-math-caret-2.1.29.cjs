/** 行内公式（Ctrl+Shift+E）周围的光标：走出公式后打字不再跳回公式；方向键碰到公式是"进去"。
 *
 *  用户报告（2026-09-16 原文）："使用数学 inline 快捷键，Ctrl shift E，键入内容之后，使用右方向键
 *  到右 dollar 符之外再键入任何内容，光标也会跳回数学区。问题非常多，你按实际书写笔记流程按实际
 *  键盘输入一个一个测！"；随后追加："不喜欢当前方向键移动时碰到 inline 数学区的方式，当前是直接
 *  跳过，而 Typora 是打开编辑代码区。block math 是否有类似问题也要查"。
 *
 *  根因（本轮实测定位，两条都要修）：
 *   1. `selectOutside` 优先落在公式节点旁的**空文本节点**上；Chromium 会把空文本节点上的位置归一化
 *      回前一个文本节点，而公式里的前一个文本节点正是零宽的 `$` 标记——于是"右方向键走出公式"把光标
 *      停在右 `$` 上（而且再也走不出去：每按一次都回到那里）。
 *   2. 打字时 `fenceCaret` 把"站在围栏上"一律当成"字符只能进源码"。行内公式的 `$` 有**内外两半**：
 *      右 `$` 之后是正文，字不该进公式。
 *  另外方向键在公式外侧是整块跳过去（用户要 Typora 那样进去：展开源码 + 光标落到源码里）。
 *
 *  验收判据（都是看得见的东西）：
 *    ① 右方向键走到右 `$` 之外再打字（真键盘 + 真输入法通道）：字落在公式**外面**，公式源码不变
 *    ② 磁盘证人：存盘后 markdown 是 `前$q$甲后`
 *    ③ 像素证人：进入公式时源码被展开，公式节点的盒子真的变宽
 *    ④ 方向键从外侧朝公式走 → 光标进源码（容器就是公式的 code、节点处于展开态）
 *    ⑤ 公式后的软换行 + 输入法：字落在新行，不落回公式
 *    ⑥ 块公式：$$ 独立成段、打字落在源码里、围栏换行是 Lute 自己收放的形式
 *    ⑦ 源与开发树逐字节一致 + 两处守卫代码在
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;

/** 块的源码文本（去掉预览子树）+ 光标解剖：在公式源码里/标记上/预览里，节点是否展开。 */
const S = `(() => { const w = ${IF}, d = w.document;
  const PREVIEW = '.vditor-ir__preview,.vditor-wysiwyg__preview';
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false, error: '没有编辑面'};
  const selection = w.getSelection();
  if (!selection.rangeCount) return {ok: false, error: '没有选区'};
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const at = start.nodeType === 3 ? start.parentElement : start;
  const block = at.closest('p,li,h1,h2,h3,h4,h5,h6') || at.closest('.vditor-ir__node') || surface;
  const nodes = [];
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT, {acceptNode: node =>
    node.parentElement && node.parentElement.closest(PREVIEW) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const text = nodes.map(node => node.data).join('');
  let offset = null;
  { let upto = 0; for (const node of nodes) { if (node === start) { offset = upto + range.startOffset; break; } upto += node.data.length; } }
  if (offset === null && block.contains(start)) {
    try { const prefix = d.createRange(); prefix.selectNodeContents(block); prefix.setEnd(start, range.startOffset);
      const fragment = prefix.cloneContents(); fragment.querySelectorAll(PREVIEW).forEach(node => node.remove());
      offset = fragment.textContent.length; } catch (error) { offset = null; }
  }
  const owner = at.closest('.vditor-ir__node[data-type="inline-node"]')
    || at.closest('.vditor-ir__node[data-type="math-block"]')
    // 光标在公式**外面**时也要能报到这条公式本身（"源码有没有被改"必须与光标在哪无关）
    || block.querySelector('.vditor-ir__node[data-type="inline-node"],.vditor-ir__node[data-type="math-block"]');
  const code = owner && owner.querySelector('code[data-type="math-inline"],code[data-type="math-block"]');
  // 在公式源码里的第几个字符
  let inCode = null;
  if (code && code.contains(start)) {
    const prefix = d.createRange(); prefix.selectNodeContents(code); prefix.setEnd(start, range.startOffset);
    inCode = prefix.cloneContents().textContent.length;
  }
  const rect = range.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const ownerRect = owner ? owner.getBoundingClientRect() : null;
  const inlineNode = block.querySelector('.vditor-ir__node[data-type="inline-node"]');
  const inlineRect = inlineNode ? inlineNode.getBoundingClientRect() : null;
  let value = null;
  try { value = w.vditor.getValue(); } catch (error) { value = 'ERR:' + error.message; }
  return {ok: true, tag: block.tagName, text, chars: text.length, offset, offsetKnown: offset !== null,
    inPreview: !!(at.closest && at.closest(PREVIEW)),
    inMarker: !!(at.closest && at.closest('.vditor-ir__marker')),
    inCode: inCode, codeText: code ? code.textContent : null,
    expanded: inlineNode ? inlineNode.classList.contains('vditor-ir__node--expand') : null,
    isBlockMath: !!(owner && owner.matches('[data-type="math-block"]')),
    ownerBox: ownerRect ? {w: Math.round(ownerRect.width), h: Math.round(ownerRect.height)} : null,
    inlineBox: inlineRect ? {w: Math.round(inlineRect.width), h: Math.round(inlineRect.height)} : null,
    caretBox: Math.round(rect.width) + 'x' + Math.round(rect.height),
    line: Math.round((rect.top - blockRect.top) / (parseFloat(w.getComputedStyle(block).lineHeight) || 22)),
    formulaCount: surface.querySelectorAll('code[data-type="math-inline"],code[data-type="math-block"]').length,
    value, valueFormulas: value ? (value.match(/\\$/g) || []).length : null}; })()`;

const RECORDER = `(() => { const w = ${IF};
  if (!w || w.__imeRec) return 'already';
  const rec = [];
  for (const type of ['compositionstart', 'compositionend', 'input']) w.document.addEventListener(type, event => {
    rec.push({type, inputType: event.inputType || null, composing: event.isComposing === undefined ? null : event.isComposing, data: event.data === undefined ? null : String(event.data).slice(0, 8)});
  }, true);
  w.__imeRec = rec; return 'ok'; })()`;
const REC_MARK = `(() => { const w = ${IF}; w.__imeRec.length = 0; return 1; })()`;
const REC_READ = `(() => { const w = ${IF}; return w.__imeRec.slice(); })()`;

/** 把光标放到文档最后一个块的末尾（后面再按回车就是干净的新段）。 */
const TO_END = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const last = blocks[blocks.length - 1];
  if (!last) return {ok: false};
  const range = d.createRange(); range.selectNodeContents(last); range.collapse(false);
  const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  surface.focus();
  return {ok: true, text: last.textContent.slice(0, 20)}; })()`;

const wait = (session, ms) => session.js(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return 1; })()`);
const FOCUS = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false};
  surface.focus();
  const blocks = [...surface.querySelectorAll(':scope > p,:scope > li')];
  const block = blocks[blocks.length - 1] || surface;
  const range = d.createRange(); range.selectNodeContents(block); range.collapse(false);
  const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  return {ok: true, blocks: blocks.length, text: block.textContent.slice(0, 20)}; })()`;

/** 只往编辑面里打键，不碰外层页。 */
const makeKeys = session => {
  const key = (name, code, vk, modifiers = 0) => session.key({key: name, code, vk, modifiers});
  const enter = () => session.enter(false);
  const shiftEnter = () => session.enter(true);
  const math = () => key('E', 'KeyE', 69, harnessMod().ctrl | harnessMod().shift);
  return {key, enter, shiftEnter, math};
};
const harnessMod = () => require('../harness.cjs').MOD;

module.exports = {
  id: '101-inline-math-caret-2.1.29',
  title: '行内公式周围的光标：走出公式后打字不跳回、方向键碰到公式是"进去"',
  async run(ctx) {
    // 素材不能是空文件：空文件打开后 Ctrl+S 走的是"另存为"，磁盘证人会失效（本轮踩过）
    const file = fixtures.write('math-caret.md', '# 数学笔记\n\n起始段\n');
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 90000, interval: 30});
      ctx.assert('编辑器就绪', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(RECORDER);
      await wait(session, 800);
      const keys = makeKeys(session);
      const {key, enter, shiftEnter, math} = keys;

      // ══ ① 用真键盘搭出 `前$q$后` ══════════════════════════════════════════
      await session.js(FOCUS);
      await wait(session, 300);
      await enter();
      await wait(session, 350);
      await session.type('前');
      await wait(session, 200);
      await math();
      await wait(session, 400);
      await session.type('q');
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      await session.type('后');
      await wait(session, 300);
      const built = await session.js(S);
      const markdownBuilt = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
      ctx.witness('① 真键盘搭出的素材（块源码 / markdown）', {text: built.text, markdown: markdownBuilt, caret: built.offset});
      ctx.assert('① 真键盘搭出 `前$q$后`（行内公式 + 两侧正文）',
        built.text === '前$q$后' && markdownBuilt.trimEnd().endsWith('前$q$后'),
        JSON.stringify({text: built.text, markdown: markdownBuilt}));

      // ══ ② 用户报的那一条：右方向键走到右 $ 之外，再用输入法打字 ═══════════
      // 光标放回公式源码末尾
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const code = d.querySelector('code[data-type="math-inline"]');
        const text = code.firstChild;
        const range = d.createRange(); range.setStart(text, text.data.length); range.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(range);
        d.querySelector(${JSON.stringify(SURFACE)}).focus(); return 1; })()`);
      await wait(session, 250);
      const inFormula = await session.js(S);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      const outside = await session.js(S);
      ctx.witness('② 右方向键两次之后的落点（公式里 → 外侧）',
        {公式里: {inCode: inFormula.inCode, offset: inFormula.offset}, 走出来: {inCode: outside.inCode, inMarker: outside.inMarker,
          offset: outside.offset, caretBox: outside.caretBox, text: outside.text}});
      ctx.assert('② 右方向键确实走出了公式（光标不在公式源码、也不在围栏标记上）',
        outside.inCode === null && outside.inMarker === false && outside.offset === 4,
        JSON.stringify({inCode: outside.inCode, inMarker: outside.inMarker, offset: outside.offset}));

      await session.js(REC_MARK);
      // 真输入法通道：候选串 + 上屏
      await session.send('Input.imeSetComposition', {text: 'jia', selectionStart: 3, selectionEnd: 3});
      await wait(session, 180);
      const composing = await session.js(S);
      await session.send('Input.insertText', {text: '甲'});
      await wait(session, 350);
      const typed = await session.js(S);
      const events = await session.js(REC_READ);
      ctx.witness('② 走出公式后用输入法打字：事件流 / 块源码 / 公式源码',
        {事件: events, 候选串时: {inCode: composing.inCode, offset: composing.offset},
          上屏后: {text: typed.text, offset: typed.offset, codeText: typed.codeText, inCode: typed.inCode},
          markdown: typed.value});

      ctx.assert('② 上屏的字落在公式**外面**（块源码 = 前$q$甲后）',
        typed.text === '前$q$甲后', JSON.stringify({want: '前$q$甲后', got: typed.text}));
      ctx.assert('② 公式源码没被改动（还是 q，甲不在公式里）',
        typed.codeText === 'q' && typed.inCode === null,
        JSON.stringify({codeText: typed.codeText, inCode: typed.inCode}));
      ctx.assert('② 光标陪着字一起留在公式外（块内偏移 = 5）',
        typed.offset === 5, JSON.stringify({offset: typed.offset}));
      ctx.assert('② markdown 同步正确（前$q$甲后，公式数不变）',
        typed.value.trimEnd().endsWith('前$q$甲后') && typed.valueFormulas === 2,
        JSON.stringify({value: typed.value, 美元符数: typed.valueFormulas}));
      ctx.metric('mathCaret.strayIntoFormula', [typed.codeText, composing.inCode].some(value => String(value).includes('甲')) ? 1 : 0,
        {unit: '次', direction: 'lower', tolerance: 0.001});

      // 磁盘证人。Ctrl+S 偶发不落盘（全量回归里出现过一次），所以这里重试几次，
      // 最后一次改走「文件 > 保存」菜单——两条路走的是同一个保存实现，能区分
      // "快捷键没送到"和"保存本身坏了"。
      const beforeSave = fs.statSync(file);
      const trySave = async () => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (attempt === 4) { try { await session.main.clickMenu('文件 > 保存'); } catch (error) { /* 菜单不可用时仍靠下面一次读取判定 */ } }
          else await session.chord('s', 'KeyS', 83);
          await wait(session, 700);
          const text = fs.readFileSync(file, 'utf8');
          if (text.includes('前$q$甲后')) return {text, attempts: attempt, via: attempt === 4 ? '菜单' : 'Ctrl+S'};
        }
        return {text: fs.readFileSync(file, 'utf8'), attempts: 4, via: '都没落盘'};
      };
      const savedInfo = await trySave();
      const saved = savedInfo.text;
      const afterSave = fs.statSync(file);
      ctx.witness('② 存盘后的磁盘内容（文件系统证人）',
        {bytes: saved.length, content: JSON.stringify(saved), 落盘方式: savedInfo.via, 尝试次数: savedInfo.attempts,
          mtime变化: afterSave.mtimeMs !== beforeSave.mtimeMs, size变化: afterSave.size !== beforeSave.size});
      ctx.assert('② 磁盘证人：文件里出现 `前$q$甲后`（甲在公式外，且原正文还在）',
        saved.includes('前$q$甲后') && saved.includes('# 数学笔记') && !saved.includes('\u200b'),
        JSON.stringify({saved, 零宽: saved.includes('\u200b'), 落盘方式: savedInfo.via, 尝试次数: savedInfo.attempts}));

      // ══ ③ 方向键从外侧朝公式走 → 进源码（Typora 行为）+ 像素证人 ═════════
      // 光标放到公式前的正文末尾（"前"之后）
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const block = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(b => b.textContent.includes('$')) || d.querySelector('.vditor-ir .vditor-reset > p');
        const owner = block.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const text = owner.previousSibling;
        const range = d.createRange(); range.setStart(text, text.data.length); range.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(range);
        d.querySelector(${JSON.stringify(SURFACE)}).focus(); return 1; })()`);
      await wait(session, 300);
      const beforeEnter = await session.js(S);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 350);
      const entered = await session.js(S);
      const shot = await session.shot('③-方向键进公式');
      ctx.witness('③ 公式外侧按右方向键：光标进入源码、节点展开、盒子变宽（截图）',
        {按键前: {inCode: beforeEnter.inCode, expanded: beforeEnter.expanded, inlineBox: beforeEnter.inlineBox},
          按键后: {inCode: entered.inCode, expanded: entered.expanded, inlineBox: entered.inlineBox, codeText: entered.codeText},
          截图: shot});
      ctx.assert('③ 方向键朝公式走时把光标放进源码（容器就是公式的 code，偏移 0）',
        entered.inCode === 0, JSON.stringify({inCode: entered.inCode, inMarker: entered.inMarker}));
      ctx.assert('③ 公式节点随之展开（源码可见）', entered.expanded === true, JSON.stringify({expanded: entered.expanded}));
      ctx.assert('③ 像素证人：展开后行内公式节点的盒子真的变宽了（源码画出来了）',
        beforeEnter.inlineBox && entered.inlineBox && entered.inlineBox.w > beforeEnter.inlineBox.w,
        JSON.stringify({按键前: beforeEnter.inlineBox, 按键后: entered.inlineBox, 展开: [beforeEnter.expanded, entered.expanded]}));

      // 从右侧进来落到源码末尾
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const block = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(b => b.textContent.includes('$')) || d.querySelector('.vditor-ir .vditor-reset > p');
        const owner = block.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const text = owner.nextSibling;
        const range = d.createRange(); range.setStart(text, 0); range.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(range);
        d.querySelector(${JSON.stringify(SURFACE)}).focus(); return 1; })()`);
      await wait(session, 250);
      await key('ArrowLeft', 'ArrowLeft', 37);
      await wait(session, 350);
      const enteredBack = await session.js(S);
      ctx.assert('③ 从右侧按左方向键进源码，光标落到源码**末尾**',
        enteredBack.inCode === 1 && enteredBack.codeText === 'q',
        JSON.stringify({inCode: enteredBack.inCode, codeText: enteredBack.codeText}));

      // ══ ④ 公式之后的软换行 + 打字（字不能落回公式） ═══════════════════════
      // 光标放在右 `$` 之后（公式与"甲"之间）——这正是用户描述的"右 dollar 符之外"
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const code = d.querySelector('code[data-type="math-inline"]');
        const text = code.firstChild;
        const range = d.createRange(); range.setStart(text, text.data.length); range.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(range);
        d.querySelector(${JSON.stringify(SURFACE)}).focus(); return 1; })()`);
      await wait(session, 200);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 200);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 200);
      const beforeSoft = await session.js(S);
      await shiftEnter();
      await wait(session, 350);
      const softLine = await session.js(S);
      await session.send('Input.insertText', {text: '乙'});
      await wait(session, 300);
      const softTyped = await session.js(S);
      ctx.witness('④ 公式后软换行再打字：换行前后与上屏后的块源码',
        {换行前: {text: beforeSoft.text, offset: beforeSoft.offset, inCode: beforeSoft.inCode},
          换行后: {text: softLine.text, offset: softLine.offset, line: softLine.line},
          上屏后: {text: softTyped.text, offset: softTyped.offset, codeText: softTyped.codeText}});
      ctx.assert('④ 公式后按 Shift+Enter：换行落在公式**外面**（紧贴右 $ 之后）',
        softLine.text === '前$q$\n甲后', JSON.stringify({want: '前$q$\\n甲后', got: softLine.text}));
      ctx.assert('④ 紧接着打的字落在新行上、没被公式收走',
        softTyped.text.replace(/\u200b/g, '') === '前$q$\n乙甲后' && softTyped.codeText === 'q',
        JSON.stringify({got: softTyped.text, codeText: softTyped.codeText}));

      // ══ ⑤ 公式在段落末尾：光标正停在右 `$` 上（最紧的边界） ══════════════
      // 这一组专打"光标站在围栏上"的三种动作：打字、再按右方向键、按 Shift+Enter。
      const placeCode = (blockText, offsetFromEnd) => `(() => { const w = ${IF}, d = w.document;
        const block = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(b => b.textContent.includes(${JSON.stringify(blockText)}));
        if (!block) return {ok: false, error: '没有目标段落'};
        const code = block.querySelector('code[data-type="math-inline"]');
        if (!code || !code.firstChild) return {ok: false, error: '没有公式源码'};
        const range = d.createRange();
        range.setStart(code.firstChild, Math.max(0, code.firstChild.data.length - ${offsetFromEnd}));
        range.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(range);
        d.querySelector(${JSON.stringify(SURFACE)}).focus();
        return {ok: true, codeLength: code.firstChild.data.length}; })()`;

      await session.js(TO_END);
      await wait(session, 250);
      await enter();
      await wait(session, 400);
      await session.type('末');
      await wait(session, 200);
      await math();
      await wait(session, 400);
      await session.type('w');
      await wait(session, 300);
      const tailBuilt = await session.js(S);
      ctx.assert('⑤ 素材：公式在段落末尾（末$w$）', tailBuilt.text === '末$w$', JSON.stringify({text: tailBuilt.text}));

      // (a) 光标停在右 $ 上再打字 → 字必须落在公式外
      await session.js(placeCode('末', 0));
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 300);
      const onMarker = await session.js(S);
      await session.send('Input.insertText', {text: '子'});
      await wait(session, 300);
      const markerTyped = await session.js(S);
      ctx.witness('⑤(a) 光标停在右 $ 上打字：位置与结果',
        {按方向键后: {inMarker: onMarker.inMarker, inCode: onMarker.inCode, offset: onMarker.offset, text: onMarker.text},
          打字后: {text: markerTyped.text, codeText: markerTyped.codeText, offset: markerTyped.offset}});
      ctx.assert('⑤(a) 光标停在右 $ 上时打字：字落在公式**外面**（源码还是 w）',
        markerTyped.text === '末$w$子' && markerTyped.codeText === 'w',
        JSON.stringify({want: '末$w$子', got: markerTyped.text, codeText: markerTyped.codeText}));

      // (b) 再按一次右方向键：光标要真的走出去（不能永远卡在 $ 上）
      await session.js(placeCode('末', 0));
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 300);
      const walkedOut = await session.js(S);
      await session.send('Input.insertText', {text: '丑'});
      await wait(session, 300);
      const walkedTyped = await session.js(S);
      ctx.witness('⑤(b) 右方向键两次之后：光标位置与打字结果',
        {走出去: {inMarker: walkedOut.inMarker, inCode: walkedOut.inCode, expanded: walkedOut.expanded,
          offset: walkedOut.offset, caretBox: walkedOut.caretBox, text: walkedOut.text},
          打字后: {text: walkedTyped.text, codeText: walkedTyped.codeText}});
      ctx.assert('⑤(b) 第二次右方向键把光标真的带出了公式（不在标记上、节点也收起了展开态）',
        walkedOut.inMarker === false && walkedOut.inCode === null && walkedOut.expanded === false,
        JSON.stringify({inMarker: walkedOut.inMarker, inCode: walkedOut.inCode, expanded: walkedOut.expanded}));
      ctx.assert('⑤(b) 走出去之后打字仍然落在公式外',
        walkedTyped.text === '末$w$丑子' && walkedTyped.codeText === 'w',
        JSON.stringify({want: '末$w$丑子', got: walkedTyped.text, codeText: walkedTyped.codeText}));

      // (c) 光标停在右 $ 上按 Shift+Enter：换行也要落在公式外
      await session.js(placeCode('末', 0));
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 300);
      const beforeTailBreak = await session.js(S);
      await shiftEnter();
      await wait(session, 400);
      const afterTailBreak = await session.js(S);
      await session.send('Input.insertText', {text: '寅'});
      await wait(session, 300);
      const tailTyped = await session.js(S);
      ctx.witness('⑤(c) 光标停在右 $ 上按 Shift+Enter：换行前后与打字后',
        {换行前: {text: beforeTailBreak.text, inMarker: beforeTailBreak.inMarker},
          换行后: {text: afterTailBreak.text, offset: afterTailBreak.offset, line: afterTailBreak.line},
          打字后: {text: tailTyped.text, codeText: tailTyped.codeText}});
      ctx.assert('⑤(c) 停在右 $ 上按 Shift+Enter：换行落在公式**外面**（紧贴右 $ 之后）',
        afterTailBreak.text.replace(/\u200b/g, '') === '末$w$\n丑子' && afterTailBreak.codeText === 'w',
        JSON.stringify({want: '末$w$[换行]丑子', got: afterTailBreak.text, codeText: afterTailBreak.codeText}));
      ctx.assert('⑤(c) 换行之后打的字落在新行上、没被公式收走',
        tailTyped.text.replace(/\u200b/g, '') === '末$w$\n寅丑子' && tailTyped.codeText === 'w',
        JSON.stringify({got: tailTyped.text, codeText: tailTyped.codeText}));

      // (d) 公式在段落**最末尾**（右边没有任何文本节点）：两次右方向键必须真的走出去
      //     ——这一条专打"光标被归一化回右 $ 标记上"（公式后面没有文本节点时才会出现）
      await session.js(TO_END);
      await wait(session, 250);
      await enter();
      await wait(session, 400);
      await session.type('尾');
      await wait(session, 200);
      await math();
      await wait(session, 400);
      await session.type('v');
      await wait(session, 300);
      const tailEnd = await session.js(S);
      ctx.assert('⑤(d) 素材：公式就在段落最末尾（尾$v$，公式右边没有文字）',
        tailEnd.text === '尾$v$' && tailEnd.inCode === 1,
        JSON.stringify({text: tailEnd.text, offset: tailEnd.offset, inCode: tailEnd.inCode}));
      await session.js(placeCode('尾', 0));
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 250);
      await key('ArrowRight', 'ArrowRight', 39);
      await wait(session, 300);
      const endWalk = await session.js(S);
      await session.send('Input.insertText', {text: '卯'});
      await wait(session, 300);
      const endTyped = await session.js(S);
      ctx.witness('⑤(d) 公式在段尾时两次右方向键：光标位置与打字结果',
        {走出去: {inMarker: endWalk.inMarker, inCode: endWalk.inCode, expanded: endWalk.expanded,
          offset: endWalk.offset, caretBox: endWalk.caretBox, text: endWalk.text},
          打字后: {text: endTyped.text, codeText: endTyped.codeText}});
      ctx.assert('⑤(d) 公式在段尾时，两次右方向键把光标带出公式（不在标记上、展开态也收起）',
        endWalk.inMarker === false && endWalk.inCode === null && endWalk.expanded === false && endWalk.offset === 4,
        JSON.stringify({inMarker: endWalk.inMarker, inCode: endWalk.inCode, expanded: endWalk.expanded, offset: endWalk.offset}));
      ctx.assert('⑤(d) 走出去之后打字落在公式外（源码还是 v）',
        endTyped.text === '尾$v$卯' && endTyped.codeText === 'v',
        JSON.stringify({want: '尾$v$卯', got: endTyped.text, codeText: endTyped.codeText}));

      // ══ ⑥ 块公式（$$ 独立成段） ═══════════════════════════════════════════
      await session.js(TO_END);
      await wait(session, 250);
      await enter();
      await wait(session, 400);
      const freshParagraph = await session.js(S);
      ctx.assert('⑥ 光标站在新段（另一个段落）的行首，从这里开始打 $',
        freshParagraph.tag === 'P' && freshParagraph.offset === 0,
        JSON.stringify({tag: freshParagraph.tag, offset: freshParagraph.offset, text: freshParagraph.text}));
      await session.type('$$');
      await wait(session, 400);
      const blockMath = await session.js(S);
      ctx.witness('⑥ 段落开头的 $$ 变成块公式',
        {tag: blockMath.tag, isBlockMath: blockMath.isBlockMath, text: blockMath.text, codeText: blockMath.codeText,
          formulaCount: blockMath.formulaCount, markdown: blockMath.value});
      ctx.assert('⑥ 段落开头的 $$ 立刻变成块公式（tag=DIV，节点是 math-block，源码有围栏）',
        blockMath.tag === 'DIV' && blockMath.isBlockMath === true && /^\$\$\n?/.test(blockMath.text),
        JSON.stringify({tag: blockMath.tag, isBlockMath: blockMath.isBlockMath, text: blockMath.text}));

      // 光标放到源码开头（围栏之后）再打字
      const blockCaret = await session.js(S);
      await session.type('a+b');
      await wait(session, 350);
      const blockTyped = await session.js(S);
      ctx.witness('⑥ 块公式里打字：打字前后的源码与光标',
        {打字前: {codeText: blockCaret.codeText, inCode: blockCaret.inCode, offset: blockCaret.offset},
          打字后: {codeText: blockTyped.codeText, inCode: blockTyped.inCode, offset: blockTyped.offset, text: blockTyped.text}});
      ctx.assert('⑥ 块公式里打字落在光标处（源码 = 光标前 + a+b + 光标后；空源码的首尾换行是 Lute 的围栏排版，比对时归一化掉）',
        blockTyped.codeText === ((blockCaret.codeText || '').slice(0, blockCaret.inCode ?? 0) + 'a+b' + (blockCaret.codeText || '').slice(blockCaret.inCode ?? 0)).replace(/^\n+|\n+$/g, ''),
        JSON.stringify({want: ((blockCaret.codeText || '').slice(0, blockCaret.inCode ?? 0) + 'a+b' + (blockCaret.codeText || '').slice(blockCaret.inCode ?? 0)),
          got: blockTyped.codeText}));
      ctx.assert('⑥ 块公式的围栏没被拆散（源码里还是两个 $$）',
        (blockTyped.text.match(/\$\$/g) || []).length === 2,
        JSON.stringify({text: blockTyped.text, 围栏: (blockTyped.text.match(/\$\$/g) || []).length}));

      // 块公式里回车 = 源码换行（既有设计）：只断言它不炸、公式还在
      await enter();
      await wait(session, 350);
      const blockEnter = await session.js(S);
      ctx.witness('⑥ 块公式里按回车：源码换行（既有设计），公式仍在',
        {text: blockEnter.text, codeText: blockEnter.codeText, isBlockMath: blockEnter.isBlockMath});
      ctx.assert('⑥ 块公式里按回车：仍是同一个块公式（没有被拆成两段、围栏也没丢）',
        blockEnter.isBlockMath === true && (blockEnter.text.match(/\$\$/g) || []).length === 2,
        JSON.stringify({isBlockMath: blockEnter.isBlockMath, text: blockEnter.text}));

      const value = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
      ctx.witness('⑥ 全流程结束时的 markdown', {value});
      ctx.assert('⑥ 全流程 markdown：三个行内公式 + 一个块公式都在，正文没有零宽脚手架',
        (value.match(/\$/g) || []).length === 10 && !value.includes('\u200b') && value.includes('a+b'),
        JSON.stringify({value, 美元符: (value.match(/\$/g) || []).length, 零宽: value.includes('\u200b')}));
    } finally {
      await ctx.release(session);
    }

    // ══ ⑦ 产物级：源与开发树一致 + 两处守卫在 ═══════════════════════════════
    const project = require('../harness.cjs').project;
    const checks = ['js/typora-patches.js', 'js/math-edit.js'].map(rel => {
      const source = fs.existsSync(path.join('E:/MarkPilot/Typora-Editor/extension-src/render', rel))
        ? fs.readFileSync(path.join('E:/MarkPilot/Typora-Editor/extension-src/render', rel), 'utf8') : '';
      const shared = fs.existsSync(path.join(project, 'app/renderer', rel))
        ? fs.readFileSync(path.join(project, 'app/renderer', rel), 'utf8') : '';
      return {rel, same: !!source && source === shared, source: source.length, shared: shared.length};
    });
    ctx.witness('⑦ 两个文件在源与开发树之间是否逐字节一致', checks);
    ctx.assert('⑦ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）',
      checks.every(row => row.same), JSON.stringify(checks));
    const patches = fs.readFileSync(path.join(project, 'app/renderer/js/typora-patches.js'), 'utf8');
    const math = fs.readFileSync(path.join(project, 'app/renderer/js/math-edit.js'), 'utf8');
    const guards = {
      空文本不算落点: /adjacent\.nodeType === Node\.TEXT_NODE && !adjacent\.length/.test(patches),
      方向键进公式: /adjacentMath/.test(patches),
      围栏内外半: /outside:open\?'start':'end'/.test(math),
      外侧插字: /const insertBeside=/.test(math),
      外侧起手: /const standOutside=/.test(math),
    };
    ctx.assert('⑦ 两处守卫都在（空文本节点不算落点 + 方向键进公式；围栏分内外半 + 外侧插字/起手）',
      Object.values(guards).every(Boolean), JSON.stringify(guards));
  },
};
