/** 137 ·【用户报 2026-10-01】行内公式右缘两件事：
 *   ① 公式之后**只许有一根光标**（原生那根大而细的）——合成竖线一根都不许再补；
 *   ② 点在公式盒子**外面**（含右围栏之后 2px 那一带），光标必须落在公式外面，
 *      不许被解进源码；点在盒子**里面**仍旧是"进源码编辑"（Typora 语义，护栏反例）。
 *
 *  真实输入：点击一律走 CDP `Input.dispatchMouseEvent`（按下→抬起），进源码态用真实 ← 键。
 *  判据配到的证据：`probe-caret-native-truth.cjs` 的真屏连拍证明"矩形 0×0 的元素级落点
 *  原生其实画着"（摘掉合成线后真屏仍有竖线，亮灭交替）；`probe-inline-math-click-band.cjs`
 *  证明展开态下右围栏之后 +0.5…+12px 都会被 Blink 解进源码（渲染层 contenteditable=false，
 *  命中测试跳过它）。
 */
'use strict';
const hi = require('../hi.cjs');

const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

/** 光标读数：层 / 是否在公式节点内 / 公式节点是否展开 / 合成竖线根数。 */
const 读 = `(() => { const w = ${hi.IF}, d = w.document;
  const sel = w.getSelection();
  const 条 = [...d.querySelectorAll('[data-typora-caret-proxy]')].filter(b => b.style.display !== 'none' && b.getBoundingClientRect().height > 0);
  if (!sel || !sel.rangeCount) return { 合成: 条.length, 选区: null };
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  const owner = at && at.closest ? at.closest('.vditor-ir__node[data-type="inline-node"]') : null;
  const 框 = (() => { const r = d.createRange(); r.setStart(n, o); r.collapse(true); const b = r.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })();
  return { 合成: 条.length, 选区: { 层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级',
    容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' : n.nodeName, 偏移: o, 折叠: sel.isCollapsed,
    在公式内: !!owner, 原生框: 框 },
    展开: !!d.querySelector('.vditor-ir__node[data-type="inline-node"].vditor-ir__node--expand') }; })()`;

/** 行内公式的几何（页面坐标）+ 几个关键点击点。
 *  围栏（`$` 标记）中线是**里外翻界**（用户 2026-10-01 第二轮口径）：右 `$` 的右半算公式外面，
 *  左 `$` 的左半算公式外面。展开态才有围栏像素；折叠态两个围栏宽 0，边界退回节点盒。 */
const 几何 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
  if (!owner) return { ok: false };
  const b = owner.getBoundingClientRect();
  const 标 = [...owner.children].filter(子 => 子.nodeName === 'SPAN' && 子.classList.contains('vditor-ir__marker'));
  const 中 = el => { const r = el.getBoundingClientRect(); return Math.round(frame.x + r.left + r.width / 2); };
  const 左报 = 标.length > 0 ? 标[0].getBoundingClientRect() : null;
  const 右报 = 标.length > 1 ? 标[标.length - 1].getBoundingClientRect() : null;
  const y = Math.round(frame.y + b.top + b.height / 2);
  return { ok: true, 右缘: Math.round(frame.x + b.right), 左缘: Math.round(frame.x + b.left), y,
    中心: Math.round(frame.x + b.left + b.width / 2), 宽: Math.round(b.width),
    右围栏中: 右报 && 右报.width > 0 ? 中(标[标.length - 1]) : null,
    左围栏中: 左报 && 左报.width > 0 ? 中(标[0]) : null,
    展开: owner.classList.contains('vditor-ir__node--expand') }; })()`;

module.exports = {
  id: '137-hi-inline-math-right-edge',
  title: '行内公式右缘：公式后只许一根光标（合成不补）；点围栏之后 2px 光标落公式外；点盒子内仍进源码',
  run: async ctx => {
    const file = hi.writeDoc('inline-math-right-edge.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4 });
    try {
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① 段末公式之后点空白：合成竖线必须为 0，光标落在公式外，且原生画得出（版面） ══
      let g = await session.js(几何);
      ctx.assert('拿到行内公式几何', g.ok, JSON.stringify(g));
      await session.click(g.右缘 + 24, g.y);
      await hi.sleep(350);
      const s1 = await session.js(读);
      ctx.assert('① 公式之后：合成光标不许再补第二根（=0）', s1.合成 === 0, JSON.stringify(s1));
      ctx.assert('① 公式之后：光标落在公式外（不是源码层）', !!s1.选区 && s1.选区.层 === '正文' && !s1.选区.在公式内, JSON.stringify(s1));
      ctx.assert('① 公式之后：原生画得出（矩形有高度，或落点在一行有内容的版面上）',
        !!s1.选区 && (s1.选区.原生框[3] > 0 || !s1.选区.在公式内), JSON.stringify(s1));
      ctx.witness('几何：公式之后点击的光标状态', { 几何: g, 状态: s1 }, 'geometry');
      await session.shot('137-公式之后');

      // ══ ② 展开态：点右围栏之后 2px → 光标必须在公式外，节点收起 ══
      g = await session.js(几何);
      await session.click(g.右缘 + 24, g.y);                 // 先落到公式外
      await hi.sleep(200);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });   // 真实 ← 进源码
      await hi.sleep(350);
      const 展开态 = await session.js(读);
      ctx.assert('② 前置：← 进源码且节点展开（护栏）', 展开态.展开 && !!展开态.选区 && 展开态.选区.在公式内, JSON.stringify(展开态));
      const g2 = await session.js(几何);
      await session.click(g2.右缘 + 2, g2.y);                // 右围栏之后 2px（用户报的那一带）
      await hi.sleep(350);
      const s2 = await session.js(读);
      ctx.assert('② 右围栏之后 +2px：光标不许再插进源码', !!s2.选区 && s2.选区.层 !== '源码' && !s2.选区.在公式内, JSON.stringify(s2));
      ctx.assert('② 右围栏之后 +2px：行内公式节点收起（退回渲染态）', s2.展开 === false, JSON.stringify(s2));
      ctx.witness('几何：展开态点右围栏之后的落点', { 几何: g2, 状态: s2 }, 'geometry');
      await session.shot('137-围栏之后2px');

      // ══ ③ 反向护栏：点公式盒子**里面**（渲染字形正中）仍旧"展开源码 + 光标进源码" ══
      const g3 = await session.js(几何);
      await session.click(g3.中心, g3.y);
      await hi.sleep(350);
      const s3 = await session.js(读);
      ctx.assert('③ 护栏：点渲染字形正中仍进源码（Typora 语义没被改坏）',
        !!s3.选区 && s3.选区.层 === '源码' && s3.选区.在公式内 === true, JSON.stringify(s3));
      ctx.witness('几何：点盒子内部（护栏反例）', { 几何: g3, 状态: s3 }, 'geometry');

      // ══ ④ 围栏中线两侧翻转（用户第二轮口径）：右 `$` 右半 → 公式外；左半 → 仍进源码 ══
      await session.click(g.右缘 + 24, g.y);
      await hi.sleep(200);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
      await hi.sleep(350);
      const g4 = await session.js(几何);
      ctx.assert('④ 前置：展开态量得到右围栏中线', g4.展开 && Number.isFinite(g4.右围栏中), JSON.stringify(g4));
      await session.click(g4.右围栏中 - 2, g4.y);             // 右围栏左半 → 源码
      await hi.sleep(350);
      const s4 = await session.js(读);
      ctx.assert('④a 右围栏**左半**（中线 −2px）仍进源码',
        !!s4.选区 && s4.选区.层 === '源码' && s4.选区.在公式内 === true, JSON.stringify({ 几何: g4, 状态: s4 }));

      await session.click(g4.右缘 + 24, g4.y);
      await hi.sleep(200);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
      await hi.sleep(350);
      const g4b = await session.js(几何);
      await session.click(g4b.右围栏中 + 2, g4b.y);           // 右围栏右半 → 公式外
      await hi.sleep(350);
      const s4c = await session.js(读);
      ctx.assert('④b 右围栏**右半**（中线 +2px）光标落公式外、节点收起',
        !!s4c.选区 && s4c.选区.层 !== '源码' && s4c.选区.在公式内 === false && s4c.展开 === false,
        JSON.stringify({ 几何: g4b, 状态: s4c }));
      ctx.witness('几何：右围栏中线两侧', { 左半: s4, 右半: s4c, 几何: g4b }, 'geometry');

      // ══ ⑤ 左侧对称：左 `$` 左半 → 公式前；右半 → 源码 ══
      await session.click(g4b.右缘 + 24, g4b.y);
      await hi.sleep(200);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
      await hi.sleep(350);
      const g5 = await session.js(几何);
      await session.click(g5.左围栏中 - 2, g5.y);             // 左围栏左半 → 公式前
      await hi.sleep(350);
      const s5 = await session.js(读);
      ctx.assert('⑤a 左围栏**左半**（中线 −2px）光标落公式前、节点收起',
        !!s5.选区 && s5.选区.层 !== '源码' && s5.选区.在公式内 === false && s5.展开 === false,
        JSON.stringify({ 几何: g5, 状态: s5 }));

      await session.click(g5.右缘 + 24, g5.y);
      await hi.sleep(200);
      await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
      await hi.sleep(350);
      const g5b = await session.js(几何);
      await session.click(g5b.左围栏中 + 2, g5b.y);           // 左围栏右半 → 源码
      await hi.sleep(350);
      const s5b = await session.js(读);
      ctx.assert('⑤b 左围栏**右半**（中线 +2px）仍进源码',
        !!s5b.选区 && s5b.选区.层 === '源码' && s5b.选区.在公式内 === true, JSON.stringify({ 几何: g5b, 状态: s5b }));
      ctx.witness('几何：左围栏中线两侧', { 左半: s5, 右半: s5b, 几何: g5b }, 'geometry');

      // ══ ⑥ 源码末尾按 → 之后键入（含输入法上屏）：字必须落在公式**外面** ══
      //  （用户 2026-10-01 报的"重大 bug"：光标停在闭 `$` 之后的**外侧一半**，视觉上已经在公式外，
      //   但输入法上屏的字被写进公式源码——compositionstart 漏了 outside 分支。）
      const g6 = await session.js(几何);
      await session.click(g6.中心, g6.y);
      await hi.sleep(350);
      await hi.press(session, 'End');
      await hi.sleep(300);
      const 源码末 = await session.js(读);
      ctx.assert('⑥ 前置：光标在源码末尾（源码层）',
        !!源码末.选区 && 源码末.选区.层 === '源码' && 源码末.选区.在公式内 === true, JSON.stringify(源码末));
      await hi.press(session, 'ArrowRight');
      await hi.sleep(300);
      const 围栏外侧 = await session.js(读);
      ctx.assert('⑥ 按 → 之后：光标离开源码（落在闭 `$` 之后，视觉上已在公式外）',
        !!围栏外侧.选区 && 围栏外侧.选区.层 !== '源码', JSON.stringify(围栏外侧));
      const 上屏前源码 = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const s = d.querySelector('${hi.SURFACE}');
        const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
        const owner = 全部[全部.length - 1];
        return owner && owner.querySelector('code[data-type]') ? owner.querySelector('code[data-type]').textContent : null; })()`);
      await session.send('Input.imeSetComposition', { text: 'q', selectionStart: 1, selectionEnd: 1 });
      await hi.sleep(150);
      await session.send('Input.insertText', { text: 'Q' });
      await hi.sleep(400);
      const 上屏后 = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const s = d.querySelector('${hi.SURFACE}');
        const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
        const owner = 全部[全部.length - 1];
        const 源码 = owner && owner.querySelector('code[data-type]') ? owner.querySelector('code[data-type]').textContent : null;
        const 段 = owner && owner.closest('p');
        const 段外 = 段 && owner ? [...段.childNodes].filter(n => n !== owner).map(n => n.textContent || '').join('') : null;
        const sel = w.getSelection(); const n = sel && sel.focusNode;
        const at = n ? (n.nodeType === 3 ? n.parentElement : n) : null;
        return { 源码, 段外, 光标在公式内: !!(at && at.closest && at.closest('.vditor-ir__node[data-type="inline-node"]')) }; })()`);
      ctx.assert('⑥ 输入法上屏的字符落在公式外面（源码没变长、公式后的正文多了它）',
        上屏后.源码 === 上屏前源码 && 上屏后.光标在公式内 === false && String(上屏后.段外).includes('Q'),
        JSON.stringify({ 上屏前源码, 上屏后 }));
      ctx.witness('几何：源码末尾出格与上屏落点', { 围栏外侧, 上屏后 }, 'geometry');
      await session.shot('137-源码末尾出块');
    } finally {
      await ctx.release(session);
    }
  },
};
