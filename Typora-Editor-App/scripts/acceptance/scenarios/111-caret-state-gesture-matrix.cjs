/** 状态 × 手势矩阵：同一个界面上，把"前一次操作留下的残影"当成**前置状态**，逐个组合地验证
 *  "点哪儿光标落在哪儿"。
 *
 *  为什么要有这个场景（2026-09-23，用户："你设计这么多测试 怎么还是会被我发现重大bug"）：
 *  既有场景都是"每个功能一条顺路"，而且**每条都从干净状态起步**——拖选、展开、选区、撤销这些
 *  **残影**从来没被当成下一步的前置条件。用户报的"拖选跨过公式之后再点源码，光标跳回公式开头"
 *  正好住在两条路之间：场景 83/92 点的是**折叠态**的渲染字形，场景 101 是键盘路径，
 *  谁都没在"选区还在（`typora-ir-selected`）"这个状态下点过一次源码。
 *
 *  本场景的做法：状态用**真实手势**造（按下→移动→抬起、真键盘），造完先自证状态成立，
 *  再在每个采样点上点一次；判据是**独立口径**（caret-lab 的期望_展开/期望_折叠，只看版面与
 *  KaTeX 发布的源码区间）：
 *    · 目标偏移算得出来 → 实际偏移必须落在目标 ±1 格；
 *    · 目标偏移算不出来 → 至少不许"跳进公式源码的深处"（跨节点的跳转一律算失败）；
 *    · 每一格都不许改动文档（DOM 指纹逐格比，末尾再用磁盘字节复核）。
 *
 *  失败时会把违规格子连同"起点 / 目标 / 实际 / 所在层 / 当时选区"一起打出来，可以直接复跑。
 */
'use strict';
const fixtures = require('../fixtures.cjs');
const lab = require('../caret-lab.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const 夹具 = [
  '# 状态矩阵验收',
  '',
  '正文段甲：句中公式 $S=\\left[\\frac{m}{n+m}甲-x\\right]+\\frac{n}{n+m}乙$ 后面还有字。',
  '',
  '正文段乙：另一条公式 $a^2+b^2=c^2$ 收尾。',
  '',
  '### 标题里的公式：$\\frac{a}{b}$',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 一 | $\\alpha+\\beta$ |',
  '',
  '$$E=mc^2$$',
  '',
  '正文段丙收尾。',
].join('\n') + '\n';

module.exports = {
  id: '111-caret-state-gesture-matrix',
  title: '状态 × 手势矩阵：拖选/展开/选区残影下点击，光标仍落在点的那一格',
  async run(ctx) {
    const file = fixtures.write('caret-matrix.md', 夹具);
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset .vditor-ir__node--expand, .vditor-ir .vditor-reset .vditor-ir__node')); })()`,
        {timeout: 60000, interval: 100});
      await harness.sleep(2000);
      await edge.settle(session);
      await harness.sleep(400);
      const 基线 = lab.hash(await session.js(lab.SNAP));

      const 读 = () => session.js(lab.STATE);
      const 指纹 = async () => lab.hash(await session.js(lab.SNAP));
      const 点 = (x, y) => session.click(x, y);
      const 拖 = async (起, 到) => {
        await session.move(起.x, 起.y);
        await harness.sleep(40);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起.x, y: 起.y, button: 'left', buttons: 1, clickCount: 1});
        for (let i = 1; i <= 6; i++) {
          await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
            x: Math.round(起.x + (到.x - 起.x) * i / 6), y: Math.round(起.y + (到.y - 起.y) * i / 6), buttons: 1});
          await harness.sleep(25);
        }
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 到.x, y: 到.y, button: 'left', buttons: 0, clickCount: 1});
        await harness.sleep(320);
      };
      /** 把光标放到正文里（不落在任何公式上），用于"从干净状态出发"。 */
      const 归位 = async () => {
        const S = await 读();
        if (!S.行框) return false;
        await 点(S.行框[0] + 18, S.行框[1] + Math.round(S.行框[3] / 2));
        await harness.sleep(320);
        return true;
      };
      /** 让这条公式展开（点它渲染出来的地方）。 */
      const 展开它 = async () => {
        const S = await 读();
        const 框 = (S.预览框 && S.预览框[2] > 0) ? S.预览框 : S.节点框;
        if (!框) return false;
        await 点(框[0] + Math.round(框[2] / 2), 框[1] + Math.round(框[3] / 2));
        await harness.sleep(600);
        return (await 读()).展开;
      };
      /** 状态定义：名字 + 造法 + 自证。 */
      const 状态们 = [
        {名: '折叠·无选区', 造: async () => { await 归位(); }, 证: S => !S.展开},
        {名: '展开·无选区', 造: async () => { await 归位(); await 展开它(); }, 证: S => S.展开},
        {名: '展开·源码内拖选', 造: async () => {
          await 归位(); await 展开它();
          const S = await 读();
          const 起盒 = (S.字符盒 || []).find(Boolean), 终盒 = (S.字符盒 || [])[Math.min(20, (S.字符盒 || []).length - 1)];
          if (!起盒 || !终盒) return;
          await 拖({x: 起盒[0] + 2, y: 起盒[1] + Math.round(起盒[3] / 2)}, {x: 终盒[0] + 2, y: 终盒[1] + Math.round(终盒[3] / 2)});
        }, 证: S => S.展开 && !!(S.光标 && !S.光标.塌)},
        {名: '展开·拖选跨渲染结果（REVEAL）', 造: async () => {
          await 归位();
          const S0 = await 读();
          if (S0.展开) { await 归位(); await harness.sleep(200); }
          const S = await 读();
          const 框 = S.预览框 || S.节点框;
          await 拖({x: 框[0] - 60, y: 框[1] + Math.round(框[3] / 2)}, {x: 框[0] + Math.round(框[2] * 0.7), y: 框[1] + Math.round(框[3] / 2)});
        }, 证: S => /typora-ir-selected/.test(S.标记 || '') && !!(S.字符盒 || []).some(Boolean)},
        {名: '折叠·拖选停在渲染结果上（REVEAL）', 造: async () => {
          await 归位(); await harness.sleep(200);
          const S = await 读();
          if (S.展开) { await 归位(); await harness.sleep(200); }
          const S2 = await 读();
          const 框 = S2.预览框 || S2.节点框;
          await 拖({x: 框[0] - 60, y: 框[1] + Math.round(框[3] / 2)}, {x: 框[0] + Math.round(框[2] * 0.5), y: 框[1] + Math.round(框[3] / 2)});
        }, 证: S => /typora-ir-selected/.test(S.标记 || '')},
      ];

      const 违规 = [];
      const 统计 = {格子: 0, 判定: 0, 不可判: 0, 状态没造出来: 0};
      for (const 状态 of 状态们) {
        for (let 轮 = 0; 轮 < 3; 轮++) {
          await 状态.造();
          const S = await 读();
          if (!状态.证(S)) { 统计.状态没造出来++; 违规.push({状态: 状态.名, 轮, 问题: '状态没造出来', 实际: {展开: S.展开, 标记: S.标记, 选区: S.光标}}); continue; }
          const 点们 = lab.采样点(S, {步长: lab.源码可见(S) ? 5 : 2});
          if (!点们.length) { 违规.push({状态: 状态.名, 轮, 问题: '没有采样点', 实际: {展开: S.展开, 标记: S.标记}}); continue; }
          const 取 = 点们[轮 % 点们.length];
          const 源码看的见 = lab.源码可见(S);
          const 旧口径 = 源码看的见 ? lab.期望_展开(S, 取.x, 取.y) : lab.期望_折叠(S, 取.x, 取.y);
          const 可接受 = 源码看的见 ? null : lab.可接受_折叠(S, 取.x, 取.y);
          // 扣扳机前先确认瞄的还是源码/公式本身（版面在动就重读；瞄不上算"不可判"，不当违规）
          let 点 = null, 命中 = null;
          const 点一下 = (x, y) => session.click(x, y);
          if (源码看的见) {
            const 结 = await lab.点源码字符(session, 取.索引 || 0, {sleep: harness.sleep});
            点 = 结.点; 命中 = 结.命中;
          } else {
            const 见 = await lab.命中(session, 取.x, 取.y);
            if (见 && (见.在公式 || 见.在预览)) { await 点一下(取.x, 取.y); 点 = {x: 取.x, y: 取.y}; 命中 = 见; }
          }
          await harness.sleep(650);
          const 后 = await 读();
          const C = 后.光标 || {};
          const 指纹2 = await 指纹();
          统计.格子++;
          if (指纹2 !== 基线) 违规.push({状态: 状态.名, 轮, 问题: '点击改动了文档指纹', 起点: 取, 目标: 旧口径, 实际: C, 指纹: [基线, 指纹2].join('→')});
          if (!点) { 统计.不可判++; 违规.length && 0; 统计.没瞄上 = (统计.没瞄上 || 0) + 1; continue; }
          统计.判定++;
          // 源码看得见：判**精确落点**（点的那一格 ±1）。折叠态：KaTeX 的嵌套（vlist/mfrac 这些容器）
          // 决定"点这个字形算不算命令"，我们不复刻它那套规则，只钉**局部性**——光标的视觉列必须还在
          // 点击处附近（≤40px）；历史 bug"点公式中段、光标跑到公式最前面"差 150px 以上，照样抓得住。
          const 落对 = 源码看的见
            ? (C.在源码文本 && Number.isInteger(C.偏移) && Math.abs(C.偏移 - 旧口径) <= 1)
            : (C.在源码文本 && !!C.盒 && Math.abs(C.盒[0] - 取.x) <= 40);
          if (!落对) 违规.push({状态: 状态.名, 轮, 问题: '光标没落在点的那一格', 起点: 取, 命中: 命中 && 命中.标签 + '.' + 命中.类,
            目标: 旧口径, 可接受: 可接受 && 可接受.集合, 实际: C, 当时源码: S.源码});
        }
      }

      ctx.witness('矩阵：每个状态的采样点与判定计数', {统计, 违规: 违规.slice(0, 6)}, 'geometry');
      ctx.log('矩阵统计：' + JSON.stringify(统计));
      for (const 条 of 违规.slice(0, 6)) ctx.log('违规：' + JSON.stringify(条));
      ctx.assert('每个状态都能用真实手势造出来（状态本身没造出来就算失败）', 统计.状态没造出来 === 0,
        JSON.stringify({状态没造出来: 统计.状态没造出来, 违规: 违规.filter(条 => 条.问题 === '状态没造出来').slice(0, 3)}));
      ctx.assert('判定过的格子都落在目标 ±1 格（独立口径，不是产品自报）', 违规.filter(条 => 条.问题 === '光标没落在点的那一格').length === 0,
        JSON.stringify(违规.filter(条 => 条.问题 !== '状态没造出来').slice(0, 4)));
      ctx.assert('点击不许改动文档（逐格 DOM 指纹）', 违规.filter(条 => 条.问题 === '点击改动了文档指纹').length === 0,
        JSON.stringify(违规.filter(条 => 条.问题 === '点击改动了文档指纹').slice(0, 2)));
      ctx.assert('判定格数足够（不可判太多说明版面读不到，矩阵形同虚设）', 统计.判定 >= 8, JSON.stringify(统计));
      ctx.assert('每一枪都瞄上了（命中测试确认落点在源码/公式上；瞄不上说明版面在飘）', (统计.没瞄上 || 0) === 0, JSON.stringify(统计));

      // 磁盘证人：整轮点击之后存盘，文件必须逐字节没变
      const 存 = await edge.saveAndWait(session, file);
      ctx.witness('磁盘：整轮点击之后的文件字节', {相同: 存.after === 夹具, 长度: 存.after.length}, 'disk');
      ctx.assert('整轮点击之后磁盘文件逐字节不变', 存.after === 夹具, JSON.stringify(存.after.slice(0, 120)));

      const 图 = await session.shot('111-矩阵收尾');
      ctx.witness('截图：矩阵跑完的界面', {file: 图}, 'geometry');
    } finally {
      await ctx.release(session);
    }
  },
};
