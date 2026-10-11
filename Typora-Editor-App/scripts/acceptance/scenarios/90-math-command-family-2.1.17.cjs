/** 2.1.19 回归：公式命令补全的排序策略（用户第 8/9 轮）。
 *
 *  用户第 8 轮：「这个补全怎么现在最多只显示前两个……我在这个位置插入补全 \mathbb，它会自动给我
 *  提示出其他的 \mathscr \mathbf 之类的同是表示字体语法，现在完全不智能好像是固定的了」。
 *  第 9 轮（验收不合格，附截图）：「MathBB 应该优先弹出来 mathbf、mathscr，你现在给我算法不好，
 *  你仔细去查查成熟方案扩充一下策略」——截图里候选是 `\int`、`\mathbb`、`\mathbf`、`\in`、`\frac`、
 *  `\sqrt`：在一个含 `\int`/`\mathbf` 的公式里敲 `\`，`\int`/`\in` 被顶到了 `\mathbb` 前面去。
 *
 *  成因（旧实现）：`score = 完全命中 +10 / 公式里出现过 +3`，而"公式里出现过"对**所有**条目生效，
 *  于是一个已经写着 `\int` 的公式里，`\int`（+3）与 `\in`（`\\in` 是 `\\int` 的子串，也 +3）就压过了
 *  按常用度排在前面的命令；同时"前缀精确匹配"的筛法让 `\mathbb` 只剩它自己一条。
 *
 *  新策略（render/js/completion-sources.js，参照 VS Code 的补全排序模型：匹配质量决定次序，
 *  声明顺序只在"匹配得一样好"时打破平局；word-start/模糊加分见 base/common/filters.js 的 fuzzyScore）：
 *    0 完全命中 → 1 前缀命中（同档内按"键入部分占命令名的比例"）→ 2 **同族兄弟**（插在强命中之后，
 *    同族内按"与命中那条的最长公共前缀"降序）→ 3 说明命中 → 4 子序列模糊命中；
 *    上下文（本公式里已用过）**只在同档内**当次级键，不再跨档提权。
 *
 *  这个场景就按你截图里的公式取证：**在一个含 `\int`/`\mathbf` 的公式里**敲 `\` 与 `\mathbb`。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FORMULA = '\\mathbb{E}_{\\mathbb{P}}[\\mathbf{1}_{E}]=\\int_0^1 f';   // 截图里那行的形状
const FONT = ['mathbb','mathbf','mathcal','mathscr','mathfrak','mathsf','mathtt','mathrm','mathit','boldsymbol','mathnormal','operatorname'];

module.exports = {
  id: '90-math-command-family-2.1.17',
  title: '公式命令补全：\mathbb 优先带出同族字体命令；公式里的 \\int 不再被顶到前面',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '90-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const file = path.join(dir, '公式命令补全.md');
    fs.writeFileSync(file, ['# 公式命令补全', '',
      '公式前的正文。', '',
      `这是行内公式 $${FORMULA}$ 的上下文，后面还有字。`,
      '', ...Array.from({length: 14}, (_, i) => [`填充段 ${i + 1}：把文档撑起来，让面板有地方落。`, '']).flat()].join('\n'));

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        const katex = [...doc.querySelectorAll('.vditor-ir .language-math')].filter(n => n.querySelector('.katex'));
        return !!leaf && katex.length >= 1; })()`, {timeout: 60000, interval: 80});
      ctx.assert('行内公式渲染出了可点的字形（补全要在公式源码里触发）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(1000);

      const spot = await session.js(`(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
        const p = [...doc.querySelectorAll('.vditor-ir .vditor-reset p')].find(x => x.textContent.includes('这是行内公式'));
        const node = p.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const preview = node.querySelector(':scope > .vditor-ir__preview');
        const r = preview.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2)}; })()`);
      await session.click(spot.x, spot.y);
      await sleep(700);

      /** 把公式源码设成 base、光标放到 offset，然后敲 query（模拟"在公式里继续打字"）。 */
      const typeIn = async (base, offset, query) => {
        await session.js(`(() => { const w = ${IF}, doc = w.document;
          const code = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code');
          if (!code) return false;
          const text = code.firstChild;
          if (text && text.nodeType === 3) text.data = ${JSON.stringify(base)};
          else code.textContent = ${JSON.stringify(base)};
          const node = code.firstChild;
          const r = doc.createRange(); r.setStart(node, Math.min(${offset}, node.length)); r.collapse(true);
          const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          return true; })()`);
        await sleep(250);
        await session.type(query);
        await sleep(1300);
        return session.js(`(() => { const w = ${IF}, doc = w.document;
          const pop = doc.querySelector('.md-completion:not([hidden])');
          const btns = pop ? [...pop.querySelectorAll('button')] : [];
          return {候选数: btns.length,
            标签: btns.map(b => (b.querySelector('span') || b).textContent.trim()),
            说明: btns.map(b => (b.querySelector('small') || {textContent: ''}).textContent.trim())}; })()`);
      };

      // ---------- ① 截图里那一条：公式含 \int/\mathbf 时敲 \mathbb ----------
      const mathbb = await typeIn(FORMULA, FORMULA.length, '\\mathbb');
      ctx.witness('① 在含 \\int/\\mathbf 的公式里敲 \\mathbb 之后的候选', mathbb);
      ctx.assert('① 第一条是用户键入的 \\mathbb', mathbb.标签[0] === '\\mathbb', mathbb.标签.slice(0, 6));
      ctx.assert('① **第二条就是 \\mathbf**（同族里离键入那条最近的排最前）',
        mathbb.标签[1] === '\\mathbf', mathbb.标签.slice(0, 6));
      const head = mathbb.标签.slice(0, 6);
      ctx.assert('① 前六条里出现同族字体命令（\\mathscr / \\mathcal / \\mathfrak …）',
        head.some(label => ['\\mathscr', '\\mathcal', '\\mathfrak'].includes(label)), head);
      const stray = head.filter(label => !FONT.includes(label.replace(/^\\/, '')));
      ctx.assert('① 前六条**不许混进与字体无关的命令**（截图里 `\\int`/`\\in`/`\\frac`/`\\sqrt` 抢在前面就是这条要治的病）',
        stray.length === 0, {混进来的: stray, 前六条: head});
      ctx.assert('① 候选里带出同族的字体命令（\\mathscr / \\mathfrak / \\mathsf 等至少 5 条）',
        FONT.filter(key => mathbb.标签.includes('\\' + key)).length >= 5, mathbb.标签);
      ctx.assert('① 说明栏只放命令自己的中文解释（不许出现分组/工程字眼）',
        mathbb.说明.every(text => !/同一类|同一组|分类：|·/.test(text)), {说明: mathbb.说明});

      // ---------- ② 同一个公式里敲一个 `\`：常用命令的次序不许被上下文顶乱 ----------
      const bare = await typeIn(FORMULA, FORMULA.length, '\\');
      ctx.witness('② 同一个公式里只敲一个 `\\` 之后的候选', bare);
      ctx.assert('② 只敲 `\\`：前四条仍是常用顺序（\\frac → \\sqrt → \\sum → \\int），公式里已有 \\int 也不许把它顶到前面',
        bare.标签.slice(0, 4).join(',') === '\\frac,\\sqrt,\\sum,\\int', {前四条: bare.标签.slice(0, 4)});

      // ---------- ③ 分式族：同族补在强命中之后、模糊命中之前 ----------
      const frac = await typeIn('a=\\int_0^1 f', 1, '\\frac');
      ctx.witness('③ 敲 \\frac 之后的候选', frac);
      ctx.assert('③ 敲 \\frac：\\sqrt 排在前三（同族插在强命中之后、模糊命中之前；旧实现会因为"模糊命中已够 4 条"把同族整个跳过）',
        frac.标签.slice(0, 3).includes('\\sqrt'), frac.标签);
      ctx.assert('③ \\dfrac / \\tfrac / \\cfrac 也都在候选里',
        ['\\dfrac', '\\tfrac', '\\cfrac'].every(label => frac.标签.includes(label)), frac.标签);

      // ---------- ④ 前缀命中很多时不做同族填充（个数自适应） ----------
      const many = await typeIn('a=\\int_0^1 f', 1, '\\m');
      ctx.witness('④ 敲 \\m 之后的候选', many);
      ctx.assert('④ 敲 \\m：候选全是前缀命中的命令（\\m 开头的），不做同族填充',
        many.标签.length >= 5 && many.标签.every(label => label.replace(/^\\/, '').toLowerCase().startsWith('m')),
        many.标签);

      // ---------- ⑤ 功能自证：从候选里选一条按 Tab，源码真的插进去 ----------
      // ④ 之后补全面板还开着：先按 Esc 收起面板、确认公式仍处于展开态，再动源码文本——
      // 面板开着时直接改写源码，随后的输入落不进公式（实测：候选 0 条、展开态也没了，
      // 断言只剩一句 [object Object]；A/B 对照证明这条在 2.2.11 上同样红，是场景自身的前置缺口）。
      await session.key({key: 'Escape', code: 'Escape', vk: 27});
      await sleep(220);
      let 就绪 = await session.js(`(() => { const doc = ${IF}.document;
        return !!doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code')
          && !doc.querySelector('.md-completion:not([hidden])'); })()`);
      if (!就绪) {
        const 位置 = await session.js(`(() => { const frame = document.getElementById('editor');
          const doc = frame.contentWindow.document; const fr = frame.getBoundingClientRect();
          const n = doc.querySelector('.vditor-ir__node[data-type="inline-node"]');
          const 目标 = n ? (n.querySelector('.vditor-ir__preview') || n) : null;
          if (!目标) return {ok: false};
          const b = 目标.getBoundingClientRect();
          return {ok: true, x: Math.round(fr.x + b.left + b.width / 2), y: Math.round(fr.y + b.top + b.height / 2)}; })()`);
        if (位置.ok) { await session.click(位置.x, 位置.y); await sleep(600); }
        就绪 = await session.js(`(() => { const doc = ${IF}.document;
          return !!doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code'); })()`);
      }
      ctx.assert('⑤ 前置：公式处于展开态、补全面板已收起', 就绪, JSON.stringify({就绪}));
      await session.js(`(() => { const w = ${IF}, doc = w.document;
        const code = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code');
        const text = code.firstChild;
        if (text && text.nodeType === 3) text.data = 'a=1';
        const r = doc.createRange(); r.setStart(code.firstChild, 1); r.collapse(true);
        const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        return true; })()`);
      await sleep(250);
      await session.type('\\mathbb');
      await sleep(1200);
      await session.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40});
      await sleep(200);
      const second = (await session.js(`(() => { const w = ${IF}, doc = w.document;
        const pop = doc.querySelector('.md-completion:not([hidden])');
        const btns = pop ? [...pop.querySelectorAll('button')] : [];
        return btns[1] ? (btns[1].querySelector('span') || btns[1]).textContent.trim() : null; })()`));
      await session.key({key: 'Tab', code: 'Tab', vk: 9});
      await sleep(600);
      const after = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const code = doc.querySelector('.vditor-ir__node--expand[data-type="inline-node"] > code');
        return {源码: code ? code.textContent : null}; })()`);
      ctx.witness('⑤ 选第二条候选按 Tab 之后的公式源码', {第二条: second, 源码: after.源码});
      ctx.assert('⑤ 选中的同族候选能真的插进公式源码（补全是能用的，不只是列出来）',
        typeof after.源码 === 'string' && second && after.源码.includes(second), {第二条: second, 源码: after.源码});

      await session.shot('after-family');
    } finally {
      await session.close();
    }
  },
};
