/** 长会话种子扫描：**连续几十个随机真实手势**，每一步都查"光标还在、文档没被误改"。
 *
 *  为什么要有这个场景（2026-09-23）：既有场景每个都从干净状态起步、跑两三个手势就断言收工，
 *  而用户是**在同一份文档上连着点、拖着、按着**几十分钟——上一步留下的选区、展开态、REVEAL、
 *  滚动位置就是下一步的起点。用户报的"双击光标/点了公式再点源码光标跳走"这类问题，本质都是
 *  "第 N 步的状态"和"第 N+1 个手势"的组合。这里用**固定种子**把这种长会话变成可复现的一条：
 *    · 手势表里全是真实通道（CDP 鼠标按下→多次移动→抬起、真键盘 keydown/keyup）；
 *    · 每一步都查：光标存在、可见或在源码里（"光标不许消失"是产品口径）、文档指纹不变；
 *    · 跑完存盘，磁盘字节必须与开头逐字节相同。
 *
 *  种子固定 → 失败可以直接复跑；把种子打进报告，下一轮换种子再扫一遍。
 */
'use strict';
const fixtures = require('../fixtures.cjs');
const lab = require('../caret-lab.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const 种子 = 20260923;
const 步数 = 40;

const 夹具 = [
  '# 长会话验收',
  '',
  '正文段甲：句中公式 $S=\\left[\\frac{m}{n+m}甲-x\\right]+\\frac{n}{n+m}乙$ 后面还有字，收尾标点。',
  '',
  '正文段乙：另一条公式 $a^2+b^2=c^2$ 与它的尾巴。',
  '',
  '### 标题里的公式：$\\frac{a}{b}$',
  '',
  '行尾公式：收尾 $y=2$',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 一 | $\\alpha+\\beta$ |',
  '',
  '$$E=mc^2$$',
  '',
  '正文段丙收尾。',
].join('\n') + '\n';

const 随机 = seed => () => {
  seed |= 0; seed = seed + 0x6d2b79f5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

module.exports = {
  id: '113-session-soak-seeded',
  title: '长会话种子扫描：连续真实手势下光标不消失、文档不被误改',
  async run(ctx) {
    const file = fixtures.write('caret-soak.md', 夹具);
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset .vditor-ir__node')); })()`,
        {timeout: 60000, interval: 100});
      await harness.sleep(2200);
      await edge.settle(session);
      await harness.sleep(400);

      const 基线 = lab.hash(await session.js(lab.SNAP));
      const 读 = () => session.js(lab.STATE);
      const 光标 = () => session.js(lab.CARE);
      const rnd = 随机(种子);
      const 按键 = async (key, vk, code) => {
        await session.key({key, code: code || key, vk});
        await harness.sleep(90);
      };
      const 拖 = async (起, 到) => {
        await session.move(起.x, 起.y); await harness.sleep(30);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起.x, y: 起.y, button: 'left', buttons: 1, clickCount: 1});
        for (let i = 1; i <= 5; i++) {
          await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
            x: Math.round(起.x + (到.x - 起.x) * i / 5), y: Math.round(起.y + (到.y - 起.y) * i / 5), buttons: 1});
          await harness.sleep(20);
        }
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 到.x, y: 到.y, button: 'left', buttons: 0, clickCount: 1});
        await harness.sleep(200);
      };

      const 违规 = [];
      const 轨迹 = [];
      let 错误数 = 0;
      for (let 步 = 1; 步 <= 步数; 步++) {
        const S = await 读();
        if (!S.行框) { 违规.push({步, 问题: '读不到版面'}); break; }
        const 手法 = Math.floor(rnd() * 6);
        const 行 = S.行框;
        const 节点框 = S.节点框 || 行;
        const x = Math.round(节点框[0] - 80 + rnd() * (节点框[2] + 160));
        const y = Math.round(节点框[1] - 30 + rnd() * (节点框[3] + 60));
        let 说明 = '';
        if (手法 === 0) { await session.click(x, y); 说明 = '单击'; }
        else if (手法 === 1) { await session.click(x, y, {clickCount: 2}); 说明 = '双击'; }
        else if (手法 === 2) {   // 从正文往公式里拖
          await 拖({x: Math.round(行[0] - 40 + rnd() * 40), y: Math.round(行[1] + 行[3] / 2)},
            {x: Math.round(节点框[0] + 节点框[2] * rnd()), y: Math.round(节点框[1] + 节点框[3] / 2)});
          说明 = '拖拽跨公式';
        } else if (手法 === 3) {   // 展开态里在源码上拖
          const 盒 = (S.字符盒 || []).filter(Boolean);
          if (S.展开 && 盒.length > 4) {
            const a = 盒[Math.floor(rnd() * 盒.length)], b = 盒[Math.floor(rnd() * 盒.length)];
            await 拖({x: a[0] + 2, y: a[1] + Math.round(a[3] / 2)}, {x: b[0] + 2, y: b[1] + Math.round(b[3] / 2)});
            说明 = '源码内拖选';
          } else { await session.click(x, y); 说明 = '单击（没展开，退化成单击）'; }
        } else if (手法 === 4) {
          const 键 = [['ArrowLeft', 37], ['ArrowRight', 39], ['ArrowUp', 38], ['ArrowDown', 40], ['Home', 36], ['End', 35]][Math.floor(rnd() * 6)];
          await 按键(键[0], 键[1]); 说明 = 键[0];
        } else {
          const 点 = {x: Math.round(行[0] + rnd() * Math.max(40, 行[2] - 20)), y: Math.round(行[1] + 行[3] / 2)};
          await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 8});
          await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 8});
          await harness.sleep(200); 说明 = 'Shift+单击';
        }
        await harness.sleep(320);
        const C = await 光标();
        const 指纹 = lab.hash(await session.js(lab.SNAP));
        const 新增错误 = session.errors.length - 错误数;
        错误数 = session.errors.length;
        轨迹.push({步, 手法: 说明, x, y, 展开: S.展开, 光标: C.盒 ? '可见' : (C.在源码 ? '在源码' : (C.选区盒 ? '选区' : '不可见')), 层: C.层 || null, 在源码: !!C.在源码, 错误: 新增错误});
        if (!C.有选区) 违规.push({步, 手法: 说明, 问题: '光标没了（连选区都没有）'});
        // 塌选区：光标要看得见，或在源码/展开态里（产品的既有口径）
        else if (C.塌 && !C.可见 && !C.在源码) 违规.push({步, 手法: 说明, 问题: '光标既不可见又不在源码里', 光标: C});
        // 非塌选区（Shift 扩选、双击选词）：可见反馈是高亮，选区必须真有几何
        else if (!C.塌 && !C.选区盒) 违规.push({步, 手法: 说明, 问题: '选区没有任何可见几何', 光标: C});
        if (指纹 !== 基线) 违规.push({步, 手法: 说明, 问题: '非编辑手势改动了文档指纹'});
        if (新增错误) 违规.push({步, 手法: 说明, 问题: '出现 console 错误', 错误: session.errors.slice(-1)[0]});
      }

      ctx.witness('扫描轨迹（种子 ' + 种子 + '，' + 步数 + ' 步）', 轨迹, 'geometry');
      ctx.log('种子=' + 种子 + ' 步数=' + 步数 + ' 可见率=' + 轨迹.filter(条 => 条.光标 === '可见').length + '/' + 轨迹.length
        + ' 违规=' + 违规.length);
      for (const 条 of 违规.slice(0, 8)) ctx.log('违规：' + JSON.stringify(条));
      ctx.assert('长会话里每一步都有光标（可见，或在源码/展开态里）', 违规.filter(条 => /光标/.test(条.问题)).length === 0,
        JSON.stringify(违规.filter(条 => /光标/.test(条.问题)).slice(0, 4)));
      ctx.assert('非编辑手势不改动文档（全程 DOM 指纹不变）', 违规.filter(条 => /指纹/.test(条.问题)).length === 0,
        JSON.stringify(违规.filter(条 => /指纹/.test(条.问题)).slice(0, 2)));
      ctx.assert('长会话没有 console 错误', 违规.filter(条 => /console/.test(条.问题)).length === 0,
        JSON.stringify(违规.filter(条 => /console/.test(条.问题)).slice(0, 2)));
      ctx.assert('扫描步数足够（少跑说明中途被打断）', 轨迹.length === 步数, JSON.stringify({跑了: 轨迹.length, 计划: 步数}));

      const 存 = await edge.saveAndWait(session, file);
      ctx.witness('磁盘：扫描之后的文件字节', {相同: 存.after === 夹具}, 'disk');
      ctx.assert('扫描之后磁盘文件逐字节不变', 存.after === 夹具, JSON.stringify(存.after.slice(0, 120)));
    } finally {
      await ctx.release(session);
    }
  },
};
