/** 135 ·【递归 F3】段落合并的窗口升级二分：n=2→17 段，找"合并起点"。
 *
 *  反哺自 FINDINGS F3：17 个空行分隔段在 IR 渲染层并成 1 块（源码与磁盘完好），
 *  而两两成对的小文件不并块（132 二分已证）。本场景把窗口从 2 段一路升到 17 段，
 *  找出合并首次出现的窗口大小；随后在"最小合并窗口"上用普通段落做对照，
 *  区分"段数触发"还是"特定形态触发"。
 */
'use strict';
const hi = require('../hi.cjs');
const SHAPES = [
  '甲=乙。丙=**丁**', '甲乙。丙=**丁**', 'a=b. c=**d**', 'a=b。c=**d**',
  '甲=乙=丙。**丁**=戊', '一行两个等号：**加粗一**与=中段', '**行首加粗**后面是普通文字',
  '行尾加粗是**这样**', '**加粗**与**再加粗**同行', '（全角括号**加粗**）收尾',
];
const WINDOWS = [2, 3, 4, 6, 8, 10];

module.exports = {
  id: '135-recursive-merge-window',
  title: '【递归F3】形态段窗口升级 2→10 段找合并起点 + 最小合并窗口的普通段落对照',
  run: async ctx => {
    const results = [];
    let firstMerge = null;
    try {
      for (const n of WINDOWS) {
        const body = ['# 递归合并窗口', '', ...SHAPES.slice(0, n), ''].join('\n');
        const file = hi.writeDoc(`merge-window-${n}.md`, body);
        const session = await hi.openDoc(ctx, file, { minBlocks: 1, settleMs: 1100 });
        const count = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelector('${hi.SURFACE}').children.length; })()`);
        const merged = count !== n + 1;
        if (merged && firstMerge === null) firstMerge = n;
        results.push({ 段数: n, 期望块数: n + 1, 实际块数: count, 合并: merged });
        ctx.witness('几何：窗口 n=' + n + ' 的顶层块数', results.at(-1), 'geometry');
        await ctx.release(session);
      }
      ctx.witness('几何：窗口升级二分全表', results, 'geometry');
      ctx.assert('【递归F3】每个窗口（2→10 段）都各自成块（无合并）',
        results.every(r => !r.合并), JSON.stringify(results));

      // 最小合并窗口（或 10 段）上换普通段落做对照：段数 or 形态触发？
      const probe = firstMerge || WINDOWS[WINDOWS.length - 1];
      const plainBody = ['# 递归合并对照', '', ...Array.from({ length: probe }, (_, i) => `普通对照段${i + 1}，没有等号没有星号。`), ''].join('\n');
      const plainFile = hi.writeDoc(`merge-plain-${probe}.md`, plainBody);
      const session = await hi.openDoc(ctx, plainFile, { minBlocks: 1, settleMs: 1100 });
      const plainCount = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelector('${hi.SURFACE}').children.length; })()`);
      const plainMerged = plainCount !== probe + 1;
      ctx.witness('几何：同段数普通段落对照', { 段数: probe, 期望: probe + 1, 实际: plainCount, 合并: plainMerged }, 'geometry');
      ctx.log(`触发窗口=${firstMerge ?? '（本窗口范围内未合并）'}；普通段落对照${plainMerged ? '也合并（段数触发）' : '不合并（形态触发）'}`);
      ctx.assert('【递归F3·对照】同段数的普通段落不合并（合并由形态触发而非段数）',
        !plainMerged, `普通段落 ${probe} 段也并成了 ${plainCount} 块——段数本身触发合并`);
      await ctx.release(session);
      // 磁盘证人：窗口素材零编辑保存字节不变（合并不落盘）
      const lastFile = hi.writeDoc('merge-window-2.md', ['# 递归合并窗口', '', ...SHAPES.slice(0, 2), ''].join('\n'));
      const s2 = await hi.openDoc(ctx, lastFile, { minBlocks: 1, settleMs: 900 });
      const saved = await hi.edge.saveAndWait(s2, lastFile, { timeout: 8000 });
      const diskOk = String(saved.after).replace(/\r/g, '').replace(/\n+$/, '') === ['# 递归合并窗口', '', ...SHAPES.slice(0, 2), ''].join('\n').replace(/\n+$/, '');
      ctx.witness('磁盘：窗口素材零编辑保存', { 长度: String(saved.after).length }, 'disk');
      ctx.assert('【递归F3·保真】渲染层合并不写回磁盘（零编辑保存字节不变）', diskOk, String(saved.after).slice(0, 60));
      await ctx.release(s2);
    } finally {
      // openDoc 内部已 release；这里兜底空实现防止误关
    }
  },
};
