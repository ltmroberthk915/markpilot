/** Shift+Enter 软换行验收（真实按键，跑在打包产物上）。
 *
 *  用户实测：把光标放在以全角右括号收尾的段落行尾（"…直接后裔。）"），按一次
 *  Shift+Enter 没有任何可见变化，要按两次才换到下一行。
 *
 *  验收判据（都是用户看得见的东西，不是"处理器有没有被调用"）：
 *    A1 按键真的送到页面（页面内自证：捕获阶段记到一次带 shift 的 Enter keydown）
 *    A2 光标所在行号 +1（块高增加约一个行高）——"换行发生了"的可视判据
 *    A3 光标有真实的框（宽高非 0）且落在新行最左侧（用户明确要求"光标停在新行最左侧"）
 *    A4 段落 DOM 里出现软换行符
 *    A5 磁盘证人：没输入内容时存盘**不改变文件**（Markdown 里块尾软换行等于没写），
 *       输入内容后存盘出现软换行且**不含**零宽空格等脚手架字符
 */
'use strict';
const fs = require('node:fs');
const fixtures = require('../fixtures.cjs');

const TARGET = '直接后裔。）';
const MARKER = '从直觉升格为定理';

// 编辑面是 `.vditor-ir .vditor-reset`：文档里还有一个空的 `.vditor-reset` 容器，
// 先匹配到它就会误判成"内容没上屏"（本轮踩过）。
const SURFACE = ".vditor-ir .vditor-reset";
const lookup = `
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc ? doc.querySelector(${JSON.stringify(SURFACE)}) : null;
  const blocks = surface ? [...surface.children] : [];
  const target = blocks.find(block => block.textContent.includes(${JSON.stringify(TARGET)})) || null;
`;

const placeCaret = (matchText, offsetExpr) => `(() => {
  ${lookup}
  if (!target) return {ok: false, error: '找不到目标段落'};
  let node = null;
  const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    // 跳过公式预览/标记等装饰节点：只认块内正文文本节点
    if (walker.currentNode.parentElement && walker.currentNode.parentElement.closest('.vditor-ir__preview, .vditor-ir__marker')) continue;
    if (walker.currentNode.data && walker.currentNode.data.includes(${JSON.stringify(matchText)})) node = walker.currentNode;
  }
  if (!node) return {ok: false, error: '找不到定位文本节点'};
  const offset = ${offsetExpr};
  const range = doc.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = w.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  frame.focus();
  surface.focus();
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const blockRect = target.getBoundingClientRect();
  const style = w.getComputedStyle(target);
  return {ok: true, focused: doc.activeElement === surface || doc.activeElement === target,
    anchorOffset: offset, nodeLength: node.data.length, textTail: target.textContent.slice(-12),
    caretTop: rect.top, caretLeft: rect.left, caretWidth: rect.width, caretHeight: rect.height,
    blockTop: blockRect.top, blockLeft: blockRect.left, blockHeight: blockRect.height,
    lineHeight: parseFloat(style.lineHeight) || null, whiteSpace: style.whiteSpace};
})()`;

const GEOM = `(() => {
  ${lookup}
  if (!target) return {error: '找不到目标段落'};
  const selection = w.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const caret = range ? range.getBoundingClientRect() : null;
  const blockRect = target.getBoundingClientRect();
  const style = w.getComputedStyle(target);
  const lineHeight = parseFloat(style.lineHeight) || null;
  const surfaceRect = surface ? surface.getBoundingClientRect() : null;
  const contentLeft = surfaceRect ? surfaceRect.left + (parseFloat(w.getComputedStyle(surface).paddingLeft) || 0) : null;
  let value = null;
  try { value = w.vditor && typeof w.vditor.getValue === 'function' ? w.vditor.getValue() : null; } catch (error) { value = 'ERR:' + error.message; }
  return {
    caretTop: caret ? caret.top : null, caretLeft: caret ? caret.left : null, caretWidth: caret ? caret.width : null, caretHeight: caret ? caret.height : null,
    blockTop: blockRect.top, blockHeight: blockRect.height, lineHeight, contentLeft,
    lineIndex: caret && lineHeight ? Math.round((caret.top - blockRect.top) / lineHeight) : null,
    lines: lineHeight ? Math.round((blockRect.height / lineHeight) * 100) / 100 : null,
    whiteSpace: style.whiteSpace,
    text: target.textContent.slice(-24),
    hasSoftBreak: target.textContent.includes('\\n'),
    zeroWidth: target.textContent.includes('\\u200b'),
    html: target.innerHTML.slice(-120),
    anchorTail: range && range.startContainer.nodeType === 3 ? range.startContainer.data.slice(-16) : null,
    markdownHasZeroWidth: typeof value === 'string' ? value.includes('\\u200b') : null,
  };
})()`;

const KEYLOG_ON = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  if (!w) return false;
  if (w.__keylogHandler) w.document.removeEventListener('keydown', w.__keylogHandler, true);
  w.__keylog = [];
  w.__keylogHandler = event => w.__keylog.push({key: event.key, shift: event.shiftKey, composing: event.isComposing});
  w.document.addEventListener('keydown', w.__keylogHandler, true);
  return true;
})()`;
const KEYLOG = `(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow; return w && w.__keylog ? w.__keylog.slice(0, 6) : null; })()`;
const wait = (session, ms) => session.js(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return 1; })()`);
const save = async session => { await session.chord('s', 'KeyS', 83); await wait(session, 700); };

module.exports = {
  id: '30-shift-enter',
  title: 'Shift+Enter 软换行（段落行尾 / 段落中间 + 存盘往返）',
  async run(ctx) {
    const file = fixtures.softBreak();
    const original = fs.readFileSync(file, 'utf8');
    ctx.witness('磁盘素材（跑前）', { file: file.split(/[\\/]/).pop(), bytes: original.length, tail: original.split('\n').filter(line => line.includes('后裔'))[0]?.slice(-14) });
    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${JSON.stringify(SURFACE)});
        return !!(surface && surface.textContent.includes(${JSON.stringify(TARGET)}));
      })()`, { timeout: 90000, interval: 15 });
      ctx.assert('素材已上屏且含目标段落', ready, `ready=${ready}`);
      if (!ready) return;

      // --- 用例 1：光标放行尾，按一次 Shift+Enter -------------------------------
      await session.js(KEYLOG_ON);
      const placed = await session.js(placeCaret(TARGET, 'node.data.length'));
      ctx.log('行尾放光标：' + JSON.stringify(placed));
      ctx.assert('光标落在目标段落行尾且编辑面获得焦点', placed.ok && placed.focused && placed.anchorOffset === placed.nodeLength,
        JSON.stringify({ok: placed.ok, focused: placed.focused, anchorOffset: placed.anchorOffset, nodeLength: placed.nodeLength}));
      const before = await session.js(GEOM);
      await session.enter(true);
      await wait(session, 450);
      const after = await session.js(GEOM);
      const keys = await session.js(KEYLOG);
      const shot = await session.shot('shift-enter-end-of-paragraph');
      ctx.log('行尾按一次后：' + JSON.stringify({keys, lineIndex: [before.lineIndex, after.lineIndex], lines: [before.lines, after.lines],
        caret: [before.caretTop, after.caretTop], caretBox: [after.caretWidth, after.caretHeight], caretLeft: after.caretLeft, contentLeft: after.contentLeft,
        lineHeight: before.lineHeight, whiteSpace: before.whiteSpace, hasSoftBreak: after.hasSoftBreak, zeroWidth: after.zeroWidth,
        text: after.text, anchorTail: after.anchorTail, html: after.html, markdownHasZeroWidth: after.markdownHasZeroWidth}));
      ctx.witness('行尾一次 Shift+Enter 的屏幕证据（截图 + 几何）', { screenshot: shot, lineIndex: [before.lineIndex, after.lineIndex],
        caretTop: [before.caretTop, after.caretTop], caretBox: [after.caretWidth, after.caretHeight], caretLeft: after.caretLeft, contentLeft: after.contentLeft });
      ctx.assert('行尾：按键送达页面（页面内自证）', Array.isArray(keys) && keys.filter(entry => entry.key === 'Enter' && entry.shift).length === 1, JSON.stringify(keys));
      ctx.assert('行尾：一次 Shift+Enter 光标就到下一行（行号 +1）', after.lineIndex === before.lineIndex + 1,
        `行号 ${before.lineIndex} → ${after.lineIndex}（块高 ${before.blockHeight} → ${after.blockHeight}，行高 ${before.lineHeight}）`);
      ctx.assert('行尾：光标有真实的框且落在新行最左侧', after.caretHeight > 4 && Math.abs(after.caretLeft - after.contentLeft) <= 6,
        `光标框高 ${after.caretHeight}（宽 ${after.caretWidth} 为 0 属正常），left ${after.caretLeft}，正文左边界 ${after.contentLeft}`);
      ctx.assert('行尾：段落里出现软换行', !!after.hasSoftBreak, `text=${JSON.stringify(after.text)}`);
      ctx.metric('shiftEnter.endOfParagraph.lineAdvance', (after.lineIndex ?? 0) - (before.lineIndex ?? 0), { unit: '行', direction: 'higher', tolerance: 0.001 });

      // 没输入内容就存盘：Markdown 必须没有变化（块尾软换行在 Markdown 里等于没写，
      // 零宽脚手架也不允许落到文件里）。
      const beforeSave = fs.readFileSync(file, 'utf8');
      await save(session);
      const savedNoTyping = fs.readFileSync(file, 'utf8');
      ctx.witness('没输入内容时存盘（文件系统证人）', { unchanged: savedNoTyping === beforeSave, bytes: savedNoTyping.length });
      ctx.assert('行尾：没输入内容时存盘不改变文件（零宽脚手架没有落盘）',
        savedNoTyping === beforeSave && !savedNoTyping.includes('\u200b'), `变化 ${savedNoTyping === beforeSave ? '无' : '有'}，含零宽空格 ${savedNoTyping.includes('\u200b')}`);

      // --- 用例 2：段落中间，一次 Shift+Enter -----------------------------------
      const placedMiddle = await session.js(placeCaret(MARKER, `node.data.indexOf(${JSON.stringify(MARKER)}) + ${MARKER.length}`));
      const middleBefore = await session.js(GEOM);
      await session.js(KEYLOG_ON);
      await session.enter(true);
      await wait(session, 450);
      const middleAfter = await session.js(GEOM);
      const middleKeys = await session.js(KEYLOG);
      ctx.log('段落中间按一次后：' + JSON.stringify({placed: placedMiddle, keys: middleKeys, lineIndex: [middleBefore.lineIndex, middleAfter.lineIndex],
        caretLeft: middleAfter.caretLeft, contentLeft: middleAfter.contentLeft, text: middleAfter.text, zeroWidth: middleAfter.zeroWidth}));
      ctx.assert('段落中间：按键送达页面', Array.isArray(middleKeys) && middleKeys.filter(entry => entry.key === 'Enter' && entry.shift).length === 1, JSON.stringify(middleKeys));
      ctx.assert('段落中间：一次 Shift+Enter 光标就换行', middleBefore.lineIndex === 0 && middleAfter.lineIndex === 1, `行号 ${middleBefore.lineIndex} → ${middleAfter.lineIndex}`);
      ctx.assert('段落中间：光标在新行最左侧', Math.abs(middleAfter.caretLeft - middleAfter.contentLeft) <= 6, `left ${middleAfter.caretLeft}，正文左边界 ${middleAfter.contentLeft}`);
      const countPlaceholders = text => (String(text).match(/\u200b/g) || []).length;
      ctx.assert('段落中间：没有多出零宽脚手架（块中间的换行本来就看得见）',
        countPlaceholders(middleAfter.text) === countPlaceholders(middleBefore.text) && !middleAfter.html.includes('\u200b\u200b'),
        `段落内零宽数 ${countPlaceholders(middleBefore.text)} → ${countPlaceholders(middleAfter.text)}`);

      // --- 用例 3：接着输入内容，存盘往返（独立证人：磁盘文件） -------------------
      await session.type('甲乙');
      await wait(session, 400);
      const typed = await session.js(GEOM);
      await save(session);
      const saved = fs.readFileSync(file, 'utf8');
      const lines = saved.split('\n');
      const index = lines.findIndex(line => line.includes('甲乙'));
      const context = lines.slice(Math.max(0, index - 2), index + 2);
      ctx.witness('输入内容后存盘（文件系统证人）', { changed: saved !== original, context, hasZeroWidth: saved.includes('\u200b') });
      ctx.log('输入甲乙后：' + JSON.stringify({text: typed.text, zeroWidth: typed.zeroWidth, context}));
      ctx.assert('输入后：新行的文字落在磁盘上（软换行成立）', /\n\s*甲乙/.test(saved), `磁盘片段：${JSON.stringify(context)}`);
      ctx.assert('输入后：文件里没有零宽脚手架', !saved.includes('\u200b'), `含零宽空格 ${saved.includes('\u200b')}`);
    } finally {
      await ctx.release(session);
    }
  },
};
