/** 2.1.9 回归：含公式的段落必须能用鼠标"按住 + 拖拽"整体选中，复制不能是空白。
 *
 *  用户原话（2026-09-13）：「含数学公式的段落整体通过鼠标点按不松手的同时拖拽选中」做不到；
 *  「现在的拖拽选中只有文字会被加蓝色提示底纹, 公式区无效果」；「caret插入最后, 向前选中整段,
 *  复制出来是空白」。要求照 Typora：拖过公式时渲染结果照常高亮像普通文本，落手后把边界的
 *  那几条翻成源码，复制拿到的是源码。
 *
 *  三个坏点（probe-math-drag / probe-drag-pick / probe-tail-click 实测钉死）：
 *    ① 折叠公式的 mousedown 被 preventDefault，Chromium 不把这次按下当成"可以起选区"；
 *    ② 渲染结果带 contenteditable="false"，原生拖拽被关在这条公式内部；
 *    ③ 折叠态源码被 Vditor 收成 0×0，选中它时既不进选区文本也没有底纹。
 *
 *  判据一律取"用户看得见 / 磁盘上有"的东西：
 *    · 真实鼠标事件（CDP 鼠标通道）做出的**真选区**：range 非塌、文本长度；
 *    · 底纹：选区矩形盖住每条公式盒子的面积比（covers）；
 *    · 剪贴板：**独立进程**（PowerShell）读回的真实文本，必须含源码（$…$）。
 *  素材用现场生成的 md，不碰用户的任何文件。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '81-math-drag-select-2.1.9',
  title: '拖拽选中跨过公式：选区要盖住公式、复制要拿到源码',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '81-math-drag');
    fs.mkdirSync(dir, {recursive: true});
    const clip = path.join(dir, 'clip');
    fs.mkdirSync(clip, {recursive: true});
    const fixture = path.join(dir, '公式段.md');
    fs.writeFileSync(fixture, [
      '# 公式段落',
      '',
      '> 原命题：$\\forall x P(x)$',
      '> 逆命题：$\\exists x Q(x)$',
      '> 否命题：$\\forall x \\neg P(x)$',
      '> 原命题的否定: $\\exists x \\neg P(x)$',
      '',
      '普通段落，用来验证点别处之后公式会收回渲染态。',
      '',
    ].join('\n'));
    // 用户报告里最关键的一条线索：「只有现在这行下面加一个空行，才能从当前位置拉起复制整段」。
    // 也就是"这段公式是文档最后一个块"时行为不同（他的文件末尾只有一个换行、没有空段落）。
    // 所以同一套手势要在**两种**收尾都跑：后面还有正文的、以及公式段就是文档末尾的。
    const tailFixture = path.join(dir, '公式段-文末.md');
    fs.writeFileSync(tailFixture, [
      '# 公式段落',
      '',
      '> 原命题：$\\forall x P(x)$',
      '> 逆命题：$\\exists x Q(x)$',
      '> 否命题：$\\forall x \\neg P(x)$',
      '> 原命题的否定: $\\exists x \\neg P(x)$',
      '',
    ].join('\n'));

    const IF = `document.getElementById('editor').contentWindow`;
    const SEL = `(() => {
      const w = ${IF}, s = w.getSelection();
      if (!s || !s.rangeCount) return {ranges: 0};
      const r = s.getRangeAt(0);
      return {ranges: s.rangeCount, collapsed: r.collapsed, len: r.toString().length, text: r.toString().slice(0, 120),
        revealed: [...w.document.querySelectorAll('.typora-ir-selected')].length}; })()`;
    const COVER = `(() => {
      const w = ${IF}, s = w.getSelection();
      const rects = s && s.rangeCount ? [...s.getRangeAt(0).getClientRects()] : [];
      const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const nodes = [...w.document.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
      return nodes.map(node => { const box = node.querySelector('.language-math').getBoundingClientRect();
        const hit = rects.reduce((sum, x) => sum + area(x, box), 0);
        return box.width * box.height ? +(hit / (box.width * box.height)).toFixed(2) : 0; }); })()`;
    const POINTS = `(() => {
      const frame = document.getElementById('editor'), w = ${IF}, doc = w.document;
      const bq = [...doc.querySelectorAll('.vditor-ir .vditor-reset blockquote')].at(-1);
      bq.scrollIntoView({block: 'center', behavior: 'instant'});
      const walker = doc.createTreeWalker(bq, w.NodeFilter.SHOW_TEXT);
      const texts = [], measure = n => { const r = doc.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect(); };
      while (walker.nextNode()) { const n = walker.currentNode;
        if (!n.data.trim()) continue;
        if (n.parentElement && (n.parentElement.closest('.vditor-ir__preview') || n.parentElement.closest('.vditor-ir__marker'))) continue;
        const rect = measure(n); if (rect.width <= 0 || rect.height <= 0) continue; texts.push(n); }
      const first = texts[0], last = texts[texts.length - 1];
      const rf = doc.createRange(); rf.setStart(first, 0); rf.setEnd(first, 1);
      const rl = doc.createRange(); rl.setStart(last, last.data.length - 1); rl.setEnd(last, last.data.length);
      const a = rf.getBoundingClientRect(), b = rl.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      const maths = [...bq.querySelectorAll('.language-math')];
      const math = maths[0].getBoundingClientRect();
      const mathLast = maths[maths.length - 1].getBoundingClientRect();
      const bqr = bq.getBoundingClientRect();
      return {ok: true, textNodes: texts.length,
        start: {x: Math.round(fr.x + a.left + 2), y: Math.round(fr.y + a.y + a.height / 2)},
        end: {x: Math.round(fr.x + b.right - 2), y: Math.round(fr.y + b.y + b.height / 2)},
        endFar: {x: Math.round(fr.x + bqr.right - 8), y: Math.round(fr.y + b.y + b.height / 2)},
        math: {x: Math.round(fr.x + math.left + math.width / 2), y: Math.round(fr.y + math.top + math.height / 2)},
        mathLast: {x: Math.round(fr.x + mathLast.left + mathLast.width / 2), y: Math.round(fr.y + mathLast.top + mathLast.height / 2)}}; })()`;

    // 真实鼠标拖拽：mouseMoved 必须带 button:'left'（否则 Chromium 不把移动当成"拖拽中"）。
    const drag = async (session, from, to, steps = 12) => {
      await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x, y: from.y, buttons: 0});
      await sleep(70);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1});
      await sleep(90);
      for (let i = 1; i <= steps; i++) {
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1,
          x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps)});
        await sleep(45);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1});
      await sleep(300);
    };
    const readClipboard = async (session, tag) => {
      await session.chord('c', 'KeyC', 67);
      await sleep(600);
      let read = null;
      try { read = harness.readClipboard(clip); } catch (error) { return {error: String(error.message).slice(0, 120)}; }
      const text = String(read.text || '');
      ctx.witness('剪贴板（独立进程读回）：' + tag, {len: text.length, head: text.slice(0, 120)});
      return {text, len: text.length};
    };

    const saved = harness.saveClipboard(clip);
    const session = await ctx.launch({args: [fixture]});
    try {
      await session.until(`(() => { const w = ${IF};
        return !!(w && w.document.querySelectorAll('.vditor-ir .vditor-reset blockquote .language-math').length >= 4); })()`, {timeout: 60000, interval: 50});
      await sleep(1200);
      await session.send('Page.bringToFront');
      const p = await session.js(POINTS);
      ctx.witness('段落几何', p);
      ctx.assert('段落里有 4 条行内公式、起讫点都拿到了', p.ok && p.textNodes >= 4, p);
      if (!p.ok) return;

      // ---------- A：从文字上按下、拖过整段（用户"光标插最后往前选整段"的等价手势）----------
      await session.js(`(() => { ${IF}.getSelection().removeAllRanges(); return true; })()`);
      await session.click(p.end.x, p.end.y);
      await sleep(250);
      await drag(session, p.end, p.start);
      const A = await session.js(SEL);
      const coverA = await session.js(COVER);
      ctx.witness('A 从段尾拖到段首：选区与底纹覆盖', {sel: A, covers: coverA});
      ctx.assert('A 真实鼠标拖拽做出了非塌选区', !A.collapsed && A.len > 20, A);
      const coveredA = coverA.filter(v => v >= 0.9).length;
      ctx.assert('A 跨过的公式底纹全覆盖（用户报的"公式区无效果"）', coveredA >= 3, {covered: coveredA, covers: coverA});
      const clipA = await readClipboard(session, 'A');
      ctx.assert('A 复制拿到了含公式源码的文本（不是空白）',
        clipA.len > 20 && /\$/.test(clipA.text) && /forall|\\forall|∀/.test(clipA.text), clipA);

      // ---------- B：从**公式上**按下不松手、斜着往上拖到段首（用户"点按不松手拖拽选中"）----------
      await session.js(`(() => { ${IF}.getSelection().removeAllRanges(); return true; })()`);
      await drag(session, p.mathLast, p.start);
      const B = await session.js(SEL);
      const coverB = await session.js(COVER);
      const recB = await session.js('(' + IF + ').__typoraMathRecover || null');
      ctx.witness('B 从公式上按下拖到段首：选区与底纹覆盖', {sel: B, covers: coverB, from: p.mathLast, to: p.start, recover: recB});
      ctx.assert('B 按住公式拖拽能起选区（原来一点反应都没有）', !B.collapsed && B.len > 20, B);
      const coveredB = coverB.filter(v => v >= 0.9).length;
      ctx.assert('B 拖过的公式底纹都要有效果（锚点那条翻成源码、其余渲染态上盖底纹）', coveredB >= 3 && B.revealed >= 1, {covered: coveredB, covers: coverB, revealed: B.revealed});
      const clipB = await readClipboard(session, 'B');
      ctx.assert('B 复制拿到源码（不是空白）', clipB.len > 20 && /\$/.test(clipB.text), clipB);

      // ---------- C：点公式本体仍然展开源码并把光标放进源码（原有编辑路径不回退）----------
      await session.js(`(() => { ${IF}.getSelection().removeAllRanges(); return true; })()`);
      await session.click(p.math.x, p.math.y);
      await sleep(450);
      const C = await session.js(`(() => { const w = ${IF}, s = w.getSelection();
        const el = s && s.rangeCount ? (s.getRangeAt(0).startContainer.nodeType === 1 ? s.getRangeAt(0).startContainer : s.getRangeAt(0).startContainer.parentElement) : null;
        const host = el && el.closest ? el.closest('.vditor-ir__node') : null;
        return {expanded: [...w.document.querySelectorAll('.vditor-ir__node--expand')].length,
          inCode: !!(el && el.closest && el.closest('code[data-type="math-inline"]')),
          caretTag: el ? String(el.tagName) : null}; })()`);
      ctx.witness('C 单击公式后的状态', C);
      ctx.assert('C 单击公式仍然展开源码', C.expanded >= 1 && C.inCode, C);

      // ---------- D：点别处之后公式收回渲染态，不留翻开的痕迹 ----------
      await session.click(p.start.x, p.start.y);
      await sleep(500);
      const D = await session.js(`(() => { const w = ${IF};
        const previews = [...w.document.querySelectorAll('.vditor-ir__node[data-type="inline-node"] > .vditor-ir__preview')];
        return {revealed: w.document.querySelectorAll('.typora-ir-selected').length,
          hidden: previews.filter(n => w.getComputedStyle(n).display === 'none').length,
          ce: previews.filter(n => n.getAttribute('contenteditable') === 'false').length,
          total: previews.length}; })()`);
      ctx.witness('D 点回正文之后的收尾状态', D);
      ctx.assert('D 选中态一结束就收回：不再有翻开的公式、预览都回到渲染态',
        D.revealed === 0 && D.hidden === 0, D);
      ctx.assert('D 按下期间临时摘掉的 contenteditable 已还原（DOM 契约不变）', D.ce === D.total, D);
      await session.shot('math-drag-final');
    } finally {
      await session.close();
    }

    // ---------- E：公式段就是**文档末尾**时，同一套"从段尾往回拉"的手势 ----------
    //  用户报告的原始现象就在这里：「目标, 从末尾拉到本段首个词"原命题",复制再粘贴, 只能贴出来
    //  最后一行」，而且「只有现在这行下面加一个空行，才能从当前位置拉起复制整段」。
    {
      const tailSession = await ctx.launch({args: [tailFixture]});
      try {
        await tailSession.until(`(() => { const w = ${IF};
          return !!(w && w.document.querySelectorAll('.vditor-ir .vditor-reset blockquote .language-math').length >= 4); })()`, {timeout: 60000, interval: 50});
        await sleep(1200);
        await tailSession.send('Page.bringToFront');
        const q = await tailSession.js(POINTS);
        ctx.witness('E 文末段落的几何', q);
        await tailSession.js(`(() => { ${IF}.getSelection().removeAllRanges(); return true; })()`);
        await tailSession.click(q.end.x, q.end.y);
        await sleep(250);
        await drag(tailSession, q.end, q.start);
        const E = await tailSession.js(SEL);
        const coverE = await tailSession.js(COVER);
        ctx.witness('E 文末段落从段尾拖到段首：选区与底纹', {sel: E, covers: coverE});
        ctx.assert('E 公式段是文档末尾时，"从末尾往回拉"同样能起选区', !E.collapsed && E.len > 20, E);
        const clipE = await readClipboard(tailSession, 'E');
        ctx.assert('E 文末段落复制拿到整段（不是只有最后一行）',
          clipE.len > 20 && /forall|\\forall|∀/.test(clipE.text) && /\$/.test(clipE.text), clipE);
        await tailSession.shot('math-drag-tail');
      } finally {
        await tailSession.close();
        try { harness.restoreClipboard(clip, saved.__file || saved.file); } catch { /* 恢复失败不影响判定 */ }
      }
    }
  },
};
