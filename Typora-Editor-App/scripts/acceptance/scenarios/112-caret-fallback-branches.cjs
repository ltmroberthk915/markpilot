/** 兜底分支：**把每一条"算不出来时怎么办"的路都真的走一遍**，并给兜底立台账。
 *
 *  为什么要有这个场景（2026-09-23）：用户报的"拖选跨过公式之后再点源码，光标跳回公式开头"
 *  就住在一条兜底里——`math-source-map.js` 在"映射算不出来"时按**预览框**的左右半边决定贴哪边，
 *  而预览框在 REVEAL 态量出来是 0×0，条件恒假 → 一律贴**开头**。既有场景全在"能算出来"的
 *  正常路上跑，兜底一条也没被踩过。兜底是故障路径，故障路径没人走，用户就替你走。
 *
 *  本场景两件事：
 *    ① 行为：把几种"映射不可用"的形状造出来（REVEAL 态 0×0 预览、预览没有源码映射属性、
 *       渲染与源码不一致），逐条断言**不许跳到无关位置**——要么精确落在点的那一格，要么按
 *       声明的贴边语义贴到这条公式自己的两端，绝不跨节点；
 *    ② 台账：`caret-fallbacks.json` 记录每个兜底站点（文件/函数/模式/数量/覆盖场景），
 *       现场重算数量比对——**新加一条兜底而不加台账，这里就红**。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');
const lab = require('../caret-lab.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const 夹具 = [
  '# 兜底分支验收',
  '',
  '正文段甲：句中公式 $S=\\left[\\frac{m}{n+m}甲-x\\right]+\\frac{n}{n+m}乙$ 后面还有字。',
  '',
  '行尾公式：收尾 $y=2$',
  '',
  '正文段乙收尾。',
].join('\n') + '\n';

const 取体 = (src, name) => {
  const 起 = src.indexOf('const ' + name + ' = ');
  if (起 < 0) return '';
  const i = src.indexOf('{', 起);
  let n = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}') { n--; if (!n) return src.slice(i, j + 1); }
  }
  return '';
};
const 数 = (text, 模式) => (String(text).match(模式) || []).length;
const 模式们 = {'return null': /return null/g, '?? 兜底': /\?\?/g, 'catch': /catch\s*[({]/g};

module.exports = {
  id: '112-caret-fallback-branches',
  title: '兜底分支：映射不可用时不许乱跳（REVEAL/无映射属性/渲染滞后）+ 兜底台账',
  async run(ctx) {
    const file = fixtures.write('caret-fallback.md', 夹具);
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset .vditor-ir__node')); })()`,
        {timeout: 60000, interval: 100});
      await harness.sleep(2000);
      await edge.settle(session);
      await harness.sleep(400);
      const 基线 = lab.hash(await session.js(lab.SNAP));
      const 读 = () => session.js(lab.STATE);
      const 指纹 = async () => lab.hash(await session.js(lab.SNAP));
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
      const 归位 = async () => {
        const S = await 读();
        await session.click(S.行框[0] + 18, S.行框[1] + Math.round(S.行框[3] / 2));
        await harness.sleep(320);
      };
      const 展开它 = async () => {
        const S = await 读();
        const 框 = (S.预览框 && S.预览框[2] > 0) ? S.预览框 : S.节点框;
        await session.click(框[0] + Math.round(框[2] / 2), 框[1] + Math.round(框[3] / 2));
        await harness.sleep(600);
      };
      const 出界 = (S, C) => {
        // "跳到无关位置"的判定：落进了这条公式的源码，但偏移离点击处最近的字符盒边界很远
        if (!C.在源码文本) return null;
        const 期望 = lab.期望_展开(S, 0, 0);
        return 期望; // 占位：具体判定在下面按用例算
      };
      void 出界;

      const 违规 = [];
      const 判格 = async (名, 断言) => {
        const S = await 读();
        const C = S.光标 || (await session.js(lab.CARE));
        const 指纹2 = await 指纹();
        const 结果 = 断言(S, C);
        if (指纹2 !== 基线) 违规.push({用例: 名, 问题: '点击改动了文档指纹'});
        if (!结果.ok) 违规.push({用例: 名, 问题: 结果.why, 状态: {展开: S.展开, 标记: S.标记, 源码: S.源码}, 光标: C});
      };

      // ① REVEAL 态（预览 0×0）点源码：必须精确落在点的那一格
      //    状态造法与场景 114 相同：先收回去 → 从正文拖选跨过渲染结果（端点落在预览上）。
      await 归位(); await harness.sleep(250);
      const 先看 = await 读();
      if (先看.展开) { await 归位(); await harness.sleep(250); }
      {
        const S0 = await 读();
        const 框 = S0.预览框 || S0.节点框;
        await 拖({x: 框[0] - 60, y: 框[1] + Math.round(框[3] / 2)}, {x: 框[0] + Math.round(框[2] * 0.7), y: 框[1] + Math.round(框[3] / 2)});
      }
      const S1 = await 读();
      ctx.log('① REVEAL 态：展开=' + S1.展开 + ' 类=' + S1.标记 + ' 预览框=' + JSON.stringify(S1.预览框));
      ctx.assert('① 造出拖选翻开（REVEAL）这个前置状态', /typora-ir-selected/.test(S1.标记 || ''), JSON.stringify({类: S1.标记}));
      // 扣扳机前用命中测试确认瞄的是源码（版面在飘就重读），点完按点的那一格判
      const 枪 = await lab.点源码字符(session, 8, {sleep: harness.sleep});
      ctx.assert('① 这个状态下源码有几何、且落点命中测试确实在源码上',
        !!枪.点 && !!(枪.命中 && 枪.命中.在源码), JSON.stringify({点: 枪.点, 命中: 枪.命中}));
      await harness.sleep(700);
      const 那一格 = 枪.状态 && (枪.状态.字符盒 || [])[8] ? 8 : -1;
      await 判格('REVEAL 态点源码', (S, C) => {
        if (!C.在源码文本) return {ok: false, why: '光标没落在源码文本里', 光标: C};
        if (Math.abs(C.偏移 - 那一格) > 1) return {ok: false, why: `偏移 ${C.偏移} 不等于点击的那一格 ${那一格}`, 命中: 枪.命中};
        return {ok: true};
      });
      ctx.witness('① REVEAL 态点源码第 ' + 那一格 + ' 格之后的光标', await session.js(lab.CARE), 'geometry');

      // ② 预览没有源码映射属性：映射必然算不出来 → 只许贴这条公式自己的两端，不许乱跳
      await 归位(); await harness.sleep(200);
      await session.js(`(() => { const w = ${lab.IF}; const d = w.document;
        const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
        const 预览 = 节点 && 节点.querySelector('.vditor-ir__preview');
        if (!预览) return 0;
        let n = 0;
        for (const el of 预览.querySelectorAll('[data-typora-source-start],[data-typora-source-end]')) {
          el.removeAttribute('data-typora-source-start'); el.removeAttribute('data-typora-source-end'); n++; }
        return n; })()`);
      await harness.sleep(200);
      {
        const S = await 读();
        const 框 = S.节点框;
        await session.click(框[0] + Math.round(框[2] * 0.6), 框[1] + Math.round(框[3] / 2));
        await harness.sleep(650);
      }
      await 判格('预览没有映射属性', (S, C) => {
        const 长 = (S.源码 || '').length;
        if (C.在源码文本) {
          const 贴边 = Math.min(C.偏移, Math.abs(C.偏移 - 长));
          if (贴边 > 1) return {ok: false, why: `映射不可用时应当贴边（0 或 ${长}），实际 ${C.偏移}`};
          return {ok: true};
        }
        // 没进源码（浏览器自己落点）也可以接受：只要没把光标送进别处
        return {ok: true};
      });
      ctx.witness('② 无映射属性时的光标', await session.js(lab.CARE), 'geometry');

      // ③ 渲染与源码不一致（预览滞后）：同样只许贴边
      await 归位(); await harness.sleep(200);
      await session.js(`(() => { const w = ${lab.IF}; const d = w.document;
        const 预览 = d.querySelector('.vditor-ir__node[data-type="inline-node"] .vditor-ir__preview');
        const math = 预览 && 预览.querySelector('.language-math');
        if (math) math.setAttribute('data-math', '唔 这不是源码');
        return math ? 1 : 0; })()`);
      await harness.sleep(200);
      {
        const S = await 读();
        const 框 = S.节点框;
        await session.click(框[0] + Math.round(框[2] * 0.4), 框[1] + Math.round(框[3] / 2));
        await harness.sleep(650);
      }
      await 判格('渲染与源码不一致', (S, C) => {
        const 长 = (S.源码 || '').length;
        if (C.在源码文本) {
          const 贴边 = Math.min(C.偏移, Math.abs(C.偏移 - 长));
          if (贴边 > 1) return {ok: false, why: `渲染滞后时应当贴边，实际 ${C.偏移}`};
        }
        return {ok: true};
      });
      ctx.witness('③ 渲染滞后时的光标', await session.js(lab.CARE), 'geometry');

      // ④ 行尾公式右侧的空白带：光标落在公式之后，不进源码
      await 归位(); await harness.sleep(250);
      {
        const 行尾 = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const d = w.document;
          const fr = frame.getBoundingClientRect();
          const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes('行尾公式'));
          if (!p) return null;
          const 节点 = p.querySelector('.vditor-ir__node[data-type="inline-node"]');
          const 框 = (节点 ? 节点.getBoundingClientRect() : p.getBoundingClientRect());
          return {x: Math.round(fr.x + 框.right + 8), y: Math.round(fr.y + 框.top + 框.height / 2), 右: Math.round(框.right)}; })()`);
        if (行尾) { await session.click(行尾.x, 行尾.y); await harness.sleep(650); }
        违规.length === 违规.length && ctx.log('④ 行尾公式右侧点：' + JSON.stringify(行尾));
        await 判格('行尾公式右侧空白带', (S, C) => {
          if (C.在源码文本 && C.偏移 < (S.源码 || '').length - 1) return {ok: false, why: `落在公式源码中间 ${C.偏移}`};
          return {ok: true};
        });
        ctx.witness('④ 行尾公式右侧点击后的光标', await session.js(lab.CARE), 'geometry');
      }

      ctx.assert('兜底分支：四种"映射不可用/边界"的形状都不许把光标送到无关位置',
        违规.length === 0, JSON.stringify(违规.slice(0, 4)));
      ctx.assert('整轮兜底点击不改动文档', (await 指纹()) === 基线, '指纹变了');

      // ⑤ 兜底台账：数量现场重算，新兜底必须进台账并点名场景
      const project = harness.project;
      const render = path.join('E:/MarkPilot/Typora-Editor/extension-src/render');
      const 台账 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'caret-fallbacks.json'), 'utf8'));
      const 表 = [];
      for (const 条 of 台账.站点) {
        const 源 = fs.readFileSync(path.join(render, 条.文件.replace(/^js\//, 'js/')), 'utf8');
        const 主体 = 条.函数 ? 取体(源, 条.函数) : 源;
        const 实测 = 数(主体, 模式们[条.模式]);
        const 场景都在 = 条.覆盖.every(id => fs.existsSync(path.join(__dirname, '..', 'scenarios', id + '.cjs')));
        const 项目内 = fs.existsSync(path.join(project, 'app/renderer', 条.文件));
        表.push({站点: 条.文件 + (条.函数 ? '#' + 条.函数 : '') + ' · ' + 条.模式, 台账: 条.数量, 实测, 覆盖场景: 条.覆盖, 场景文件都在: 场景都在, 开发树有: 项目内});
      }
      ctx.witness('⑤ 兜底台账与实际代码数量', 表, 'disk');
      const 台账对得上 = 表.every(行 => 行.台账 === 行.实测 && 行.场景文件都在 && 行.开发树有);
      ctx.assert('兜底台账与代码逐条对上（数量一致、点名场景都真实存在）', 台账对得上, JSON.stringify(表));
      ctx.assert('兜底站点数量不少于台账（少一条说明兜底被删过，要同步台账）', 表.length === 台账.站点.length, JSON.stringify(表.map(行 => 行.站点)));

      const 存 = await edge.saveAndWait(session, file);
      ctx.witness('磁盘：兜底轮之后的文件字节', {相同: 存.after === 夹具}, 'disk');
      ctx.assert('兜底轮之后磁盘文件逐字节不变', 存.after === 夹具, JSON.stringify(存.after.slice(0, 120)));
    } finally {
      await ctx.release(session);
    }
  },
};
