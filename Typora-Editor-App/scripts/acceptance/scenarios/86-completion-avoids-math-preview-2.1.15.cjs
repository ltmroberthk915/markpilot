/** 2.1.15 回归：公式提示栏（补全候选面板）不得盖住**预渲染框**。
 *
 *  用户报告（2026-09-14 第 6 轮第 3 条）：
 *   「目前数学公式提示栏虽然避开了 caret 和正在编辑的行，但还应该再加一个避开预渲染框的规则，
 *     否则的话，编辑者无法看清现在编辑的效果」
 *  截图里就是：行内公式展开后，那条公式的 KaTeX 渲染结果以浮层形式贴在源码行下方
 *  （index.css：`.vditor-ir__node--expand[data-type="inline-node"] > .vditor-ir__preview`
 *   是 `position:absolute; top:100%` 的浮层），补全面板正好压在它身上。
 *
 *  修法（render/js/completion.js 的 position()）：落位候选里再加一条"不盖住预渲染框"，
 *  排在"不压鼠标"之后、"能显示更多条目"之前——面板宁可矮一点、也要让用户看得见渲染结果。
 *
 *  这个场景把光标放进一条行内公式的源码里、敲一个 `\` 把面板叫出来，然后按几何断言
 *  「面板与预渲染框不重叠」，并要求自证"两者横向本来就重着"（否则这条断言等于没测）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '86-completion-avoids-math-preview-2.1.15',
  title: '公式提示栏避开预渲染框（编辑时看得见公式渲染结果）',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '86-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const filler = Array.from({length: 26}, (_, i) => [`补全落位填充第 ${i + 1} 段。`, '']).flat();
    // 公式那段放**中间**：这样能把它滚到视口中下部，让面板的上方真的留得下地方。
    const fixture = ['# 公式提示栏与预渲染框', '',
      ...filler.slice(0, 24),
      '必须补控制函数？但 $\\int f_n\\,d\\mu=n\\cdot\\frac1n=1$ 恒为 1。于是', '',
      ...filler.slice(24)].join('\n');
    const file = path.join(dir, '公式提示栏.md');
    fs.writeFileSync(file, fixture);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; const doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        return !!leaf; })()`, {timeout: 60000, interval: 60});
      ctx.assert('行内公式渲染出了可点的字形（预渲染框就位）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(800);

      // 点公式渲染结果的左四分之一 → 展开、光标落在源码靠前处（面板也会落在预渲染框的横向带上）
      const spot = await session.js(`(() => { const w = ${IF}, doc = w.document, frame = document.getElementById('editor');
        const code = doc.querySelector('code[data-type="math-inline"]');
        const preview = code.closest('.vditor-ir__node').querySelector(':scope > .vditor-ir__preview');
        const leaves = [...preview.querySelectorAll('[data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]') && n.getBoundingClientRect().width > 1)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        if (!leaves.length) return null;
        const first = leaves[0].getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        return {x: Math.round(fr.x + first.left + 2), y: Math.round(fr.y + first.top + first.height / 2),
          src: code.textContent}; })()`);
      ctx.witness('点击位置（公式渲染结果最左侧那个字形上）', spot);
      if (!spot) { ctx.assert('量得到公式渲染结果的第一个字形', false, 'no-leaf'); return; }
      await session.click(spot.x, spot.y);
      await sleep(700);

      // 光标进源码后回到行首，然后把**这一行滚到视口中下部**——面板要落在它上方，
      // 上方必须真的有地方（工具栏高约 36px、面板自然高约 165px，所以行顶要 ≥ 220px 才谈得上
      // "面板该往上还是往下"）。这一条是必要的自证：行顶贴在工具栏下面时，两条规则会打架
      //（上方被工具栏占着、下方压着预渲染框），那种几何下断言"不盖预渲染框"是测不出东西的。
      const placed = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const root = doc.querySelector('.vditor-ir .vditor-reset');
        const code = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code');
        if (!code) return null;
        root.scrollTop += Math.round(code.getBoundingClientRect().top - 340);
        return {lineTop: Math.round(code.getBoundingClientRect().top)}; })()`);
      await sleep(500);
      const lineTop = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const code = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code');
        const tb = doc.querySelector('.vditor-toolbar');
        return {lineTop: code ? Math.round(code.getBoundingClientRect().top) : null,
          toolbarBottom: tb && tb.getBoundingClientRect().height > 1 ? Math.round(tb.getBoundingClientRect().bottom) : 0}; })()`);
      ctx.witness('把公式源码行滚到视口中下部（面板要落在它上方）', {...placed, ...lineTop});
      ctx.assert('前提成立：源码行在工具栏下方、且上方留得下面板（行顶 ≥ 220px）',
        lineTop.lineTop !== null && lineTop.lineTop >= 220, lineTop);
      await session.key({key: 'Home', code: 'Home', vk: 36});
      await sleep(200);
      await session.type('\\');
      await sleep(2200);

      const measured = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const pop = doc.querySelector('.md-completion:not([hidden])');
        const owner = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"]');
        const preview = owner ? owner.querySelector(':scope > .vditor-ir__preview') : null;
        const code = owner ? owner.querySelector(':scope > code') : null;
        const pr = pop ? pop.getBoundingClientRect() : null;
        const vr = preview ? preview.getBoundingClientRect() : null;
        const cr = code ? code.getBoundingClientRect() : null;
        const hit = (a, b) => !!a && !!b && a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
        const tb = doc.querySelector('.vditor-toolbar');
        const tr = tb && tb.getBoundingClientRect().height > 1 ? tb.getBoundingClientRect() : null;
        const round = r => r ? {top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right)} : null;
        return {候选数: doc.querySelectorAll('.md-completion:not([hidden]) button').length,
          面板: round(pr), 预渲染框: round(vr), 源码行: round(cr),
          预渲染框可见: !!vr && vr.width > 1 && vr.height > 1,
          横向本来会撞: !!(pr && vr && pr.left < vr.right - 2 && pr.right > vr.left + 2),
          压住预渲染框: pr && vr ? hit(pr, vr) : null,
          压住源码行: pr && cr ? hit(pr, cr) : null,
          工具栏: round(tr),
          压住工具栏: pr && tr ? hit(pr, tr) : null,
          面板在视口内: pr ? (pr.top >= -1 && pr.bottom <= w.innerHeight + 1) : null,
          源码: code ? code.textContent : null}; })()`);
      ctx.witness('面板 / 预渲染框 / 源码行的几何（真 DOM 量测）', measured);
      ctx.assert('补全面板确实弹出来了（否则这条断言没有意义）', measured.候选数 > 0, {候选数: measured.候选数});
      ctx.assert('自证：这条公式的**预渲染框是可见的**（有盒子才谈得上"避开"）', measured.预渲染框可见 === true, measured);
      ctx.assert('自证：面板与预渲染框在横向本来就重叠（这条断言不是白过的）', measured.横向本来会撞 === true, measured);
      ctx.assert('面板没有盖住公式的预渲染框（用户要"看得清现在编辑的效果"）',
        measured.压住预渲染框 === false, {面板: measured.面板, 预渲染框: measured.预渲染框});
      ctx.assert('面板没有盖住正在编辑的源码行（既有规则没被这条新规则挤掉）',
        measured.压住源码行 === false, {面板: measured.面板, 源码行: measured.源码行});
      ctx.assert('面板也没有顶着工具栏（工具栏下沿是天花板的规则：面板在这一侧变矮，而不是顶上去）',
        measured.压住工具栏 === false, {面板: measured.面板, 工具栏: measured.工具栏});
      ctx.assert('面板整体仍留在视口内', measured.面板在视口内 === true, {面板: measured.面板});

      await session.shot('panel-vs-preview');
    } finally {
      await session.close();
    }
  },
};
