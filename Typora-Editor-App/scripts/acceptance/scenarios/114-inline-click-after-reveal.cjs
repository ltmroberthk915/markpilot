/** 回归钉（用户 2026-09-23 报告）：**拖选跨过行内公式之后，再点它的源码，光标跳回公式开头**。
 *
 *  现场（桌面版，`C:\Users\ltmroberthk\Desktop\新建 Markdown 文档.md` 第 30 行）：
 *  `### 调拨比例问题：$S=\left[\frac{m}{n+m}甲-x\right]+\frac{n}{n+m}乙$`，
 *  公式展开、浮框悬在下方，用户拖选跨过渲染结果后再点 `\left[` 与 `\frac` 之间，光标跳到源码第 0 位。
 *
 *  机制（probe-repro-inline-click-jump.cjs 的 E1 取证，调用栈）：
 *    `collapse(TEXT@46,0) ← placeCaret(math-source-map.js:23) ← click(math-source-map.js:272)`
 *  拖选会让节点带上 `typora-ir-selected`（REVEAL），那条"必须一起接管"的分支把一个**源码点击**
 *  也接了进来；REVEAL 态下浮框被 CSS 摊成 0×0，映射必然算不出来，贴边兜底里
 *  `box.width > 0 && …` 恒假 → 一律贴**开头**。
 *
 *  本场景把这条钉死：同一个手势、同一处落点，光标必须落在点的那一格（±1）。
 *  突变验证：把 `math-source-map.js` 里 `if (起于源码) return;` 注掉，本场景立刻变红。
 */
'use strict';
const fixtures = require('../fixtures.cjs');
const lab = require('../caret-lab.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const 夹具 = [
  '# 回归钉：拖选过公式之后再点源码',
  '',
  '### 调拨比例问题：$S=\\left[\\frac{m}{n+m}甲-x\\right]+\\frac{n}{n+m}乙$',
  '',
  '甲、乙两个小分队的人数之和在90到110之间，如果从甲队调一定人数给乙队，则乙队的人数就是甲队的2倍。',
].join('\n') + '\n';

module.exports = {
  id: '114-inline-click-after-reveal',
  title: '回归钉：拖选跨过行内公式之后点源码，光标落在点的那一格',
  async run(ctx) {
    const file = fixtures.write('reveal-click.md', 夹具);
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset .vditor-ir__node[data-type="inline-node"]')); })()`,
        {timeout: 60000, interval: 100});
      await harness.sleep(2000);
      await edge.settle(session);
      await harness.sleep(400);

      const 读 = () => session.js(lab.STATE);
      const 拖 = async (起, 到) => {
        await session.move(起.x, 起.y); await harness.sleep(40);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起.x, y: 起.y, button: 'left', buttons: 1, clickCount: 1});
        for (let i = 1; i <= 6; i++) {
          await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
            x: Math.round(起.x + (到.x - 起.x) * i / 6), y: Math.round(起.y + (到.y - 起.y) * i / 6), buttons: 1});
          await harness.sleep(25);
        }
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 到.x, y: 到.y, button: 'left', buttons: 0, clickCount: 1});
        await harness.sleep(320);
      };

      const S0 = await 读();
      ctx.assert('打开就能读到这条公式的版面', !!S0.源码, JSON.stringify({展开: S0.展开, 框: S0.节点框}));
      const 归位 = async () => {
        const S = await 读();
        await session.click(S.行框[0] + 18, S.行框[1] + Math.round(S.行框[3] / 2));
        await harness.sleep(320);
      };
      await 归位();
      const S1 = await 读();
      if (!S1.展开) {
        const 框 = (S1.预览框 && S1.预览框[2] > 0) ? S1.预览框 : S1.节点框;
        await session.click(框[0] + Math.round(框[2] / 2), 框[1] + Math.round(框[3] / 2));
        await harness.sleep(700);
      }

      // ① 拖选跨过渲染结果（制造 REVEAL）
      await 归位(); await harness.sleep(200);
      const S2 = await 读();
      if (S2.展开) { await 归位(); await harness.sleep(200); }
      const S3 = await 读();
      const 框 = S3.预览框 || S3.节点框;
      await 拖({x: 框[0] - 60, y: 框[1] + Math.round(框[3] / 2)},
        {x: 框[0] + Math.round(框[2] * 0.7), y: 框[1] + Math.round(框[3] / 2)});
      const S4 = await 读();
      ctx.log('拖选之后：展开=' + S4.展开 + ' 类=' + S4.标记 + ' 预览框=' + JSON.stringify(S4.预览框));
      // 【R8 口径更新】"翻开"的判据从 vendor 的 --expand 类改为「源码真实可见可点」：
      // R1-2 起 REVEAL 态由产品自己的 typora-ir-selected + 源码几何承载（--expand 类不再
      // 总是随选区落下；probe-r1-reveal / probe-r2-reveal 全绿是同一语义的旁证）。本场景
      // 真正依赖的出事前置态是"源码逐字符几何可读"（下一步的字 符盒 断言），不是类名。
      const 源码可见 = !!(S4.字符盒 && S4.字符盒.length);
      ctx.assert('拖选之后公式被翻开（源码逐字符可读）、节点带上 REVEAL 类（这就是出事的前置状态）',
        (S4.展开 || 源码可见) && /typora-ir-selected/.test(S4.标记 || ''), JSON.stringify({展开: S4.展开, 源码可见, 字符盒数: (S4.字符盒 || []).length, 类: S4.标记}));

      // ② 点 `\left[` 与第一个 `\frac` 之间（源码第 8 个字符的左缘）
      const 索引 = S4.源码.indexOf('\\frac');
      const 目标 = 索引 >= 0 ? 索引 : 8;
      const 盒 = (S4.字符盒 || [])[目标];
      const 指纹前 = lab.hash(await session.js(lab.SNAP));
      ctx.assert('读得到目标字符的盒子（源码逐字符几何）', !!盒, JSON.stringify({目标, 源码: (S4.源码 || '').slice(0, 20)}));
      if (盒) {
        await session.click(盒[0] + 1, 盒[1] + Math.round(盒[3] / 2));
        await harness.sleep(700);
      }
      const S5 = await 读();
      const C = S5.光标 || {};
      ctx.witness('点击之后的光标（目标偏移 ' + 目标 + '）', {光标: C, 源码: S5.源码, 展开: S5.展开, 类: S5.标记}, 'geometry');
      ctx.log('点 offset ' + 目标 + ' 之后：' + JSON.stringify(C));
      ctx.assert('光标落在点击的那一格（±1）而不是被扔回公式开头',
        C.在源码文本 === true && Number.isInteger(C.偏移) && Math.abs(C.偏移 - 目标) <= 1,
        JSON.stringify({目标, 实际: C.偏移, 在源码: C.在源码文本, 全量: C}));
      ctx.assert('这次点击没有掉进公式之外的任何地方', !!(C.盒 && C.盒.length === 4), JSON.stringify(C));
      ctx.assert('点击没有把光标送进别的公式节点', C.在别处 !== true, JSON.stringify(C));
      ctx.assert('点击不改动文档（DOM 指纹逐字节相同）',
        lab.hash(await session.js(lab.SNAP)) === 指纹前, '指纹变了');

      const 存 = await edge.saveAndWait(session, file);
      ctx.witness('磁盘：点击之后的文件字节', {相同: 存.after === 夹具}, 'disk');
      ctx.assert('点击之后磁盘文件逐字节不变', 存.after === 夹具, JSON.stringify(存.after.slice(0, 120)));
      const 图 = await session.shot('114-回归钉');
      ctx.witness('截图：点击之后', {file: 图}, 'geometry');
    } finally {
      await ctx.release(session);
    }
  },
};
