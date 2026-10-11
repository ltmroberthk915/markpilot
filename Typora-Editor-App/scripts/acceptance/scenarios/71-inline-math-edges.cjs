/** 行内公式的边缘编辑（用户点名的"数学公式...复制粘贴删减增"里的公式侧）。
 *
 *  三条判据各有分工：
 *    A 往返保真：只打了"一个字符 + 退格"（内容等于原文）再存盘，**磁盘字节必须与原始
 *      完全一致**。这是最有杀伤力的一条——任何脚手架字符（零宽空格）、`$$` 重排、
 *      `|` 被写成 `\vert{}` 之类的意外都会在这里现形。
 *    B 行尾公式后追加：磁盘上必须出现"公式紧跟新字符"，证明光标真的落在那条公式之后。
 *    C 表格内公式（同一份素材里那张小表）：改一处 → 磁盘对应单元格变更。
 *  所有存盘都由真实 Ctrl+S 触发，磁盘由独立通道读回。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const TAIL_LINE = '出现在行尾的公式是';
const TAIL_BLOCK = '$y=2$';

/** 段落里那段纯文本 + 公式预览的几何（用于自证"光标落在公式右边"）。
 *  两种判据并用：几何（光标框在预览右侧）与**位置**（Range 比较，光标在"预览之后"
 *  这个位置上或之后）。光标落在元素边界时几何框是 0×0（Chromium 不给出线框），
 *  只有位置判据能说明问题，所以两条都记进证人。 */
const TAIL_FACTS = `(() => {
  const doc = document.getElementById('editor').contentWindow.document;
  const w = document.getElementById('editor').contentWindow;
  const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
  const block = [...surface.children].find(node => node.textContent.includes(${JSON.stringify(TAIL_LINE)}));
  if (!block) return {found: false};
  const preview = block.querySelector('.vditor-ir__preview');
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const caret = range ? range.getBoundingClientRect() : null;
  const blockRect = block.getBoundingClientRect();
  const previewRect = preview ? preview.getBoundingClientRect() : null;
  let afterPosition = null;
  if (range && preview) {
    const marker = doc.createRange();
    marker.setStartAfter(preview);
    marker.collapse(true);
    afterPosition = range.compareBoundaryPoints(Range.START_TO_START, marker) >= 0;
  }
  return {found: true, blockText: block.textContent.replace(/\\s+/g, ' ').trim(),
    caret: caret ? {left: Math.round(caret.left), top: Math.round(caret.top), width: Math.round(caret.width)} : null,
    preview: previewRect ? {left: Math.round(previewRect.left), right: Math.round(previewRect.right)} : null,
    blockRect: {left: Math.round(blockRect.left), right: Math.round(blockRect.right), top: Math.round(blockRect.top)},
    caretAfterFormula: !!(caret && previewRect && caret.width > 0 && caret.left >= previewRect.right - 2 && Math.abs(caret.top - previewRect.top) < 24),
    afterFormulaByPosition: afterPosition,
    inFormula: !!(range && preview && preview.contains(range.startContainer)),
    caretContainer: range ? range.startContainer.nodeName : null,
    caretOffset: range ? range.startOffset : null};
})()`;

module.exports = {
  id: '71-inline-math-edges',
  title: '行内公式边缘：往返保真（字节级）、行尾公式后追加、单元格公式改写',
  async run(ctx) {
    // 保真这一条用"只有公式、没有表格"的素材：含表格的文档保存时 Lute 会按列宽重排表格
    // （本轮量到：`| --- | --- |` → `| -- | -------------- |`，列宽补空格）。那是表格对齐
    // 行为而不是保真问题，但它会让"字节不变"这条判据永远为假，所以分开量：
    //   mathOnly  → 严格字节保真；denseMath → 公式 + 表格语义（行/列/内容不变）
    const file = fixtures.mathOnly();
    const tableFile = fixtures.denseMath();
    const original = fs.readFileSync(file, 'utf8');
    const tableOriginal = fs.readFileSync(tableFile, 'utf8');
    const originalBytes = Buffer.from(original, 'utf8');
    ctx.witness('素材（磁盘原始字节）', { file: path.basename(file), bytes: originalBytes.length,
      hasTailFormula: original.includes(TAIL_BLOCK), hasDisplayMath: original.includes('\\int_0^1'),
      tableFile: path.basename(tableFile), tableBytes: tableOriginal.length, hasCellFormula: tableOriginal.includes('$\\alpha+\\beta$') });
    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        return !!(surface && surface.querySelectorAll('.katex').length >= 4);
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('公式（含块级）都上屏（KaTeX 渲染出来了）', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(edge.WATCH_TOASTS);
      await edge.settle(session);

      // --- A) 往返保真：打一个字符再退格，内容回到原文，存盘必须字节不变 ----------
      const clickTarget = await session.js(edge.pointOf(`(() => {
        const doc = document.getElementById('editor').contentWindow.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const block = [...surface.children].find(node => node.textContent.includes('行首公式'));
        return block || null;
      })()`));
      ctx.assert('能找到测试段落并点进去', clickTarget.ok && clickTarget.visible, JSON.stringify(clickTarget));
      if (!clickTarget.ok) return;
      await session.click(clickTarget.x, clickTarget.y);
      await harness.sleep(300);
      await session.type('测');
      await harness.sleep(250);
      await session.key({ key: 'Backspace', code: 'Backspace', vk: 8 });
      await harness.sleep(350);
      const domAfterRoundTrip = await session.js(`(() => {
        const doc = document.getElementById('editor').contentWindow.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        return surface ? surface.textContent.includes('测') : null;
      })()`);
      ctx.assert('打的这个字符已经退掉（DOM 里不再有它）', domAfterRoundTrip === false, `DOM 含"测"=${domAfterRoundTrip}`);
      const roundTrip = await edge.saveAndWait(session, file);
      const sameBytes = Buffer.from(roundTrip.after, 'utf8').equals(originalBytes);
      ctx.witness('磁盘：往返之后的字节（应与原始完全相同）', { sameBytes, before: originalBytes.length, after: Buffer.byteLength(roundTrip.after, 'utf8'),
        diff: sameBytes ? null : firstDiff(original, roundTrip.after) });
      ctx.assert('【往返保真】打字+退格后存盘，磁盘字节与原始完全一致（没有脚手架/重排泄漏）',
        sameBytes, sameBytes ? '字节相同' : JSON.stringify(firstDiff(original, roundTrip.after)));

      // --- B) 行尾公式之后追加：光标必须落在公式右边 -----------------------------
      // 真正用户在行尾的做法是"点在公式右侧"，所以这里点的是预览框右边一点点
      // （点预览正中会把光标放进公式里）。点完自证光标在公式右侧；不在就按 End / →
      // 走真实键盘再试，最多三次，仍然不在就如实判失败。
      const tailPoint = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame.contentWindow;
        const doc = w.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const block = [...surface.children].find(node => node.textContent.includes(${JSON.stringify(TAIL_LINE)}));
        if (!block) return {ok: false, error: '找不到行尾公式段落'};
        const preview = block.querySelector('.vditor-ir__preview');
        const target = preview || block;
        const rect = target.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const x = Math.round(frameRect.x + (preview ? rect.right + 6 : rect.right - 6));
        const y = Math.round(frameRect.y + rect.top + rect.height / 2);
        return {ok: true, x, y, previewRight: preview ? Math.round(rect.right) : null};
      })()`);
      ctx.assert('能找到行尾公式段落并算出"公式右侧"的点', tailPoint.ok, JSON.stringify(tailPoint));
      if (tailPoint.ok) {
        await session.click(tailPoint.x, tailPoint.y);
        await harness.sleep(300);
        let caret = await session.js(TAIL_FACTS);
        let attempt = 0;
        const placed = value => value.caretAfterFormula || value.afterFormulaByPosition === true;
        while (attempt < 3 && !placed(caret)) {
          attempt++;
          // 真实键盘：先用 End（行尾），再用 →（右移一格）
          if (attempt === 1) await session.key({ key: 'End', code: 'End', vk: 35 });
          else await session.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 });
          await harness.sleep(280);
          caret = await session.js(TAIL_FACTS);
        }
        // 鼠标点在"公式右侧一点点"这件事本身受坐标精度影响（点偏一个像素就落到下一段），
        // 所以再给一条确定性的落点：把光标放到该块内容的末尾（= 公式之后），并**自证**
        // 光标确实在公式右侧再打字。落点方式会如实记进笔记，不假装是鼠标点的。
        let placement = `鼠标点击（+${attempt} 次键盘校正）`;
        if (!placed(caret)) {
          await session.js(`(() => {
            const w = document.getElementById('editor').contentWindow;
            const doc = w.document;
            const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
            const block = [...surface.children].find(node => node.textContent.includes(${JSON.stringify(TAIL_LINE)}));
            const range = doc.createRange();
            range.selectNodeContents(block);
            range.collapse(false);
            const selection = w.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            surface.focus({preventScroll: true});
            return true;
          })()`);
          await harness.sleep(300);
          caret = await session.js(TAIL_FACTS);
          placement = '光标置于块末（Range，确定性落点）';
        }
        ctx.log(`行尾公式块（${placement}）：` + JSON.stringify(caret));
        ctx.witness('DOM：光标相对行尾公式的位置', {...caret, placement});
        ctx.assert('光标落在行尾公式的右侧（几何或位置任一成立，且不在公式内部）',
          caret.found && placed(caret) && !caret.inFormula, JSON.stringify(caret));
        if (placed(caret)) {
          await session.type('！');
          await harness.sleep(400);
          const afterType = await session.js(TAIL_FACTS);
          const typedSave = await edge.saveAndWait(session, file);
          ctx.witness('磁盘：行尾公式之后追加的字符', { line: (typedSave.after.match(/出现在行尾的公式[^\n]*/) || [''])[0] });
          ctx.assert('新字符进了这一段（DOM）', /！/.test(afterType.blockText), JSON.stringify(afterType.blockText));
          ctx.assert('磁盘上"公式紧跟新字符"，公式本身没被写坏',
            /\$y=2\$！/.test(typedSave.after) && !/\\vert/.test(typedSave.after),
            JSON.stringify((typedSave.after.match(/出现在行尾的公式[^\n]*/) || [''])[0]));
          ctx.assert('行尾公式仍然只有一处（没有复制出第二个）',
            (typedSave.after.match(/\$y=2\$/g) || []).length === 1, `出现 ${(typedSave.after.match(/\$y=2\$/g) || []).length} 次`);
        }
      } else {
        ctx.assert('能找到行尾公式块', false, JSON.stringify(tailPoint));
      }

      // --- C) 切到含表格的素材：单元格里的公式改写 + 表格语义往返 -----------------
      await session.jsSoft(`hostApi.invoke('open-in-window', {path: ${JSON.stringify(tableFile)}})`);
      const onTable = await session.until(`(() => {
        const w = document.getElementById('editor').contentWindow;
        const D = w.document;
        const h = D.querySelector('.vditor-reset h1');
        const surface = D.querySelector(${JSON.stringify(edge.SURFACE)});
        return !!(h && h.textContent.includes('公式边缘验收') && surface && surface.querySelector('table'));
      })()`, { timeout: 60000, interval: 25 });
      ctx.assert('切到含表格的素材并等它就绪', onTable, `onTable=${onTable}`);
      await edge.settle(session);
      const tableBefore = await session.js(edge.TABLE_FACTS);
      const cellPoint = await session.js(edge.pointOf(`(() => {
        const doc = document.getElementById('editor').contentWindow.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const cell = [...surface.querySelectorAll('td,th')].find(node => node.querySelector('code[data-type="math-inline"]'));
        return cell ? (cell.querySelector('.vditor-ir__preview') || cell) : null;
      })()`));
      if (cellPoint.ok) {
        await session.click(cellPoint.x, cellPoint.y);
        await harness.sleep(400);
        const expanded = await session.js(`(() => {
          const doc = document.getElementById('editor').contentWindow.document;
          const owner = doc.querySelector('.vditor-ir__node--expand');
          const code = owner ? owner.querySelector('code[data-type="math-inline"]') : null;
          return {expanded: !!owner, code: code ? code.textContent : null};
        })()`);
        ctx.assert('表格单元格里的公式可以点开编辑', expanded.expanded, JSON.stringify(expanded));
        if (expanded.expanded) {
          await session.type('2');
          await harness.sleep(500);
          const cellSave = await edge.saveAndWait(session, tableFile);
          const tableAfter = edge.tableBlock(cellSave.after, '项');
          ctx.witness('磁盘：单元格公式改写 + 表格重排', { tableBefore: edge.tableBlock(tableOriginal, '项'), tableAfter, unchangedBytes: cellSave.after === tableOriginal });
          ctx.assert('单元格公式里出现了新字符（编辑落在这一格）',
            tableAfter.some(line => /\|\s*一\s*\|[^\n]*\\alpha/.test(line) && /2/.test(line)),
            JSON.stringify(tableAfter));
          ctx.assert('表格语义不变：仍是 4 行、每行 2 格、另一行公式没被碰到',
            tableAfter.filter(line => line.trim().startsWith('|')).length === 4 &&
            tableAfter.every(line => edge.separatorSegments(line) === 2) &&
            tableAfter.some(line => /\|\s*二\s*\|[^\n]*\\gamma/.test(line)),
            JSON.stringify(tableAfter.map(line => edge.separatorSegments(line))));
          ctx.log('表格重排前后的磁盘行：' + JSON.stringify({before: edge.tableBlock(tableOriginal, '项'), after: tableAfter}));
        }
      } else {
        ctx.assert('能找到表格里的公式', false, JSON.stringify(cellPoint));
      }

      // --- D) 错误面 ------------------------------------------------------------
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.assert('全程没有错误提示（乱码 / -File / app.asar / 失败）', problems.length === 0, JSON.stringify({problems, toasts}));
      ctx.metric('math.katexNodes', await session.js(`(() => document.getElementById('editor').contentWindow.document.querySelectorAll('.katex').length)()`), { unit: '个', direction: 'equal', tolerance: 0.2 });
      await session.shot('71-inline-math-edges');
    } finally {
      await ctx.release(session);
      try { fs.writeFileSync(file, original); fs.writeFileSync(tableFile, tableOriginal); } catch { /* 忽略 */ }
    }
  },
};

/** 第一处字节差异（用于把"不一致"变成可读的证据，而不是只报 false）。 */
function firstDiff(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) {
      return { at: index, expected: JSON.stringify(a.slice(Math.max(0, index - 30), index + 30)), actual: JSON.stringify(b.slice(Math.max(0, index - 30), index + 30)) };
    }
  }
  return { at: -1 };
}
