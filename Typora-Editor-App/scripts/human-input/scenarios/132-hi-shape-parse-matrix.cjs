/** 132 · 解析形态矩阵：加粗、斜体、删除线、公式、全角标点的"整族形态"打开即渲染
 *  正确 + 零编辑保存字节不变。
 *
 *  举一反三自 2.2.12 用户报告「甲=乙。丙=**丁** 粗体不渲染（甲乙。丙=**丁** 正常）」：
 *  根因在 Lute 解析层对特定**文本形态**敏感。钉一个形态等于等它换个面孔再来；这里把
 *  「等号/标点/全角/位置/混排」几个维度做笛卡尔积，以后同类形态碎掉当场红。
 *  本场景不需要任何输入动作——打开就是判据，是纯解析/渲染预言机 + 磁盘保真证人。
 */
'use strict';
const hi = require('../hi.cjs');

/** [说明, 期望元素 tag, 期望文本]；plain 表示期望没有任何 strong/em/del。 */
const SHAPES = [
  ['甲=乙。丙=**丁**', 'strong', '丁'],
  ['甲乙。丙=**丁**', 'strong', '丁'],
  ['a=b. c=**d**', 'strong', 'd'],
  ['a=b。c=**d**', 'strong', 'd'],
  ['甲=乙=丙。**丁**=戊', 'strong', '丁'],
  ['一行两个等号：**加粗一**与=中段', 'strong', '加粗一'],
  ['**行首加粗**后面是普通文字', 'strong', '行首加粗'],
  ['行尾加粗是**这样**', 'strong', '这样'],
  ['**加粗**与**再加粗**同行', 'strong', '加粗'],
  ['（全角括号**加粗**）收尾', 'strong', '加粗'],
  ['甲、**顿号后加粗**、乙', 'strong', '顿号后加粗'],
  ['$a=b$ 前后**加粗**公式', 'strong', '加粗'],
  ['**含=等号的加粗=形态**', 'strong', '含=等号的加粗=形态'],
  // `__中文字__与`：**收尾的 `__` 紧贴 CJK 字符＝词内定界符**，按 CommonMark 的 `_` 规则不出强调
  //（`x__y__z` 同理；`**` 不受这条限制）。所以这里只钉**同一行里 `**星号加粗**` 该渲染**。
  ['__双下划线加粗__与**星号加粗**', 'strong', '星号加粗'],
  ['*单星斜体*普通*再来一个*', 'em', '单星斜体'],
  ['~~删除线~~与**加粗**并存', 'del', '删除线'],
  ['**加粗里=等号=继续**正常', 'strong', '加粗里=等号=继续'],
];
// 每种形态**各自成段**：用空行分隔。单个 `\n` 在 Markdown 里只是同一段里的软换行——17 行会渲染成
// 1 个段落（首跑报的"17 段被并成 1 块"就是这条夹具缺陷，不是产品的分块问题；已在 FINDINGS 回写）。
const BODY = ['# 形态矩阵', '', ...SHAPES.map(([text]) => text + '\n'), ''].join('\n');

module.exports = {
  id: '132-hi-shape-parse-matrix',
  title: '解析形态矩阵：等号×标点×全角×位置的 17 种加粗/斜体/删除线形态打开即渲染，零编辑保存字节不变',
  run: async ctx => {
    const file = hi.writeDoc('shape-parse-matrix.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 17, settleMs: 1800 });
    try {
      await hi.edge.settle(session);
      const dom = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
        return [...s.children].map(block => ({
          文本: block.textContent.replace(/\\s+/g, '').slice(0, 40),
          strong: [...block.querySelectorAll('strong,b')].map(n => n.textContent),
          em: [...block.querySelectorAll('em,i')].map(n => n.textContent),
          del: [...block.querySelectorAll('del,s')].map(n => n.textContent),
        })); })()`);

      // ══ ⓪ 分段完整性：1 标题 + 17 段 = 18 个顶层块（首跑发现 17 段被并成 1 块） ════
      ctx.witness('几何：18 种形态的顶层块数与渲染结果', { 块数: dom.length, dom }, 'geometry');
      ctx.assert('⓪ 空行分隔的 17 段各自成块（1 标题 + 17 段 = 18 块）',
        dom.length === SHAPES.length + 1, `实际顶层块数 ${dom.length}——段落被合并/拆散了`);
      await session.shot('132-shape-matrix');

      // ══ ① 每种形态渲染出期望的语义元素 ═════════════════════════════════════════
      let bad = [];
      for (let i = 0; i < SHAPES.length; i++) {
        const [shape, tag, payload] = SHAPES[i];
        const block = dom && dom[i + 1];   // 第 0 块是标题
        if (!block) { bad.push({ shape, 问题: '块缺失' }); continue; }
        const got = tag === 'strong' ? block.strong : tag === 'em' ? block.em : block.del;
        if (!got.some(text => text.includes(payload))) bad.push({ shape, 期望: tag + ':' + payload, 实际: { strong: block.strong, em: block.em, del: block.del } });
      }
      ctx.assert('① 17 种形态全部渲染出期望的语义元素', bad.length === 0, JSON.stringify(bad.slice(0, 4)));

      // ══ ② 二分定位"段落合并"的触发边界：每对相邻形态单独开一个双段文件 ══════════
      await ctx.release(session);
      const mergeInfo = [];
      for (let i = 0; i + 1 < Math.min(SHAPES.length, 6); i++) {
        const pairFile = hi.writeDoc(`bisect-pair-${i}.md`, SHAPES[i][0] + '\n\n' + SHAPES[i + 1][0] + '\n');
        const mini = await hi.openDoc(ctx, pairFile, { minBlocks: 1, settleMs: 900 });
        const count = await mini.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelector('${hi.SURFACE}').children.length; })()`);
        mergeInfo.push({ 对: `${SHAPES[i][0].slice(0, 12)} ⇄ ${SHAPES[i + 1][0].slice(0, 12)}`, 块数: count, 正常: count === 2 });
        await ctx.release(mini);
      }
      ctx.witness('几何：相邻形态对的分块二分', mergeInfo, 'geometry');
      ctx.assert('② 相邻形态对各自成 2 块（无合并）', mergeInfo.every(item => item.正常), JSON.stringify(mergeInfo));

      // ══ ③ 零编辑保存：字节不变（用主文件再开一次） ═══════════════════════════════
      const session2 = await hi.openDoc(ctx, file, { minBlocks: 1, settleMs: 1500 });
      const saved = await hi.edge.saveAndWait(session2, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：零编辑保存', { 磁盘长: disk.length, 原长: BODY.length }, 'disk');
      ctx.assert('③ 打开不动直接保存 = 磁盘逐字节等于原文',
        disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), `磁盘长 ${disk.length} vs 原文长 ${BODY.length}`);
      await ctx.release(session2);
    } finally {
      await ctx.release(session);
    }
  },
};
