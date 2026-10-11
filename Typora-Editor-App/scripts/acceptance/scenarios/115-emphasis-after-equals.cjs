/** 回归钉（用户 2026-09-23 报告）：**一行里出现两个 `=` 之后，后面的强调（加粗/斜体）不再渲染**，
 *  星号被当字面量画出来。用户原话："图中"慢者独自行驶时间"使用快捷键加粗后不会自动渲染了!"
 *
 *  机制（Node 里直接跑打包的 lute.min.js 取证，scripts/acceptance/probe-lute-node.cjs）：
 *  Lute 的 `Mark`（`==高亮==`）开关关着时，扫描到 `=` 定界符之后就不再处理后面的强调定界符；
 *  开（`lute.SetMark(true)`，Vditor 的 `preview.markdown.mark` 选项）就正常。
 *    Mark 关：`甲=乙。丙=**丁**` → `<p>甲=乙。丙=**丁**</p>`
 *    Mark 开：`甲=乙。丙=**丁**` → `<p>甲=乙。丙=<strong>丁</strong></p>`
 *
 *  本场景守两件事：
 *    ① 解析：这些行都要真的渲染出 <strong>/<em>（DOM 证据），且磁盘字节**逐字节不变**（解析开关
 *       不该改写任何文档）；
 *    ② 开关还在：`preview.markdown.mark` 必须是 true（有人手滑关掉，这里立刻红）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');
const lab = require('../caret-lab.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const 夹具 = [
  '# 两个等号之后的强调',
  '',
  '甲=乙。丙=**丁**',
  '',
  '甲=乙。丙=*丁*',
  '',
  '甲=乙。丙=__丁__',
  '',
  '甲乙。丙=**丁**',
  '',
  '甲=**乙**',
  '',
  '价格 x = 5 元，y = 6 元',
  '',
  '====',
  '',
  '错时接送问题：  接者省时距离：慢者出发地到相遇地距离的2倍，得到单倍该距离时间=省时的一半。提前时间与最终实际节省时间差是因为在该单倍距离的速度差导致的浪费，则时间差+接者单倍距离时间=**慢者独自行驶时间**',
].join('\n') + '\n';

module.exports = {
  id: '115-emphasis-after-equals',
  title: '一行里两个等号之后，强调（加粗/斜体）仍要渲染 + 解析开关在位',
  async run(ctx) {
    const file = fixtures.write('equals-emphasis.md', 夹具);
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset p')); })()`,
        {timeout: 60000, interval: 100});
      await harness.sleep(2000);
      await edge.settle(session);
      await harness.sleep(500);

      const 事实 = await session.js(`(() => { const w = ${lab.IF}; const d = w.document;
        const 面 = d.querySelector('.vditor-ir .vditor-reset');
        const 段 = [...面.querySelectorAll('p')].map(p => ({文: String(p.textContent).slice(0, 40),
          粗: !!p.querySelector('strong'), 斜: !!p.querySelector('em'), 高亮: !!p.querySelector('mark'),
          字面星号: /\\*\\*/.test(String(p.textContent))}));
        const lute = w.vditor && w.vditor.lute;
        return {段}; })()`);
      const 找 = 前缀 => (事实.段 || []).find(p => p.文.startsWith(前缀)) || null;
      const 期望 = [
        ['甲=乙。丙=**丁**', '粗'],
        ['甲=乙。丙=*丁*', '斜'],
        ['甲=乙。丙=__丁__', '粗'],
        ['甲乙。丙=**丁**', '粗'],
        ['甲=**乙**', '粗'],
      ];
      const 结果 = [];
      for (const [前缀, 要] of 期望) {
        const 段 = 找(前缀);
        结果.push({行: 前缀, 要, 有粗: 段 ? 段.粗 : null, 有斜: 段 ? 段.斜 : null, 段在: !!段});
      }
      const 用户行 = 找('错时接送问题');
      ctx.witness('每一行的渲染事实', {结果, 用户行}, 'geometry');
      ctx.log('逐行：' + JSON.stringify(结果));
      ctx.log('用户那一行：' + JSON.stringify(用户行));
      const 全对 = 结果.every(r => r.段在 && (r.要 === '粗' ? r.有粗 : r.有斜));
      ctx.assert('两个等号之后的强调真的渲染出来了（加粗 4 例、斜体 1 例）', 全对, JSON.stringify(结果));
      ctx.assert('用户报的那一行渲染成粗体（而不是把 ** 画出来）', !!(用户行 && 用户行.粗), JSON.stringify(用户行));

      // 解析开关在位：Vditor 的 markdown.mark 必须是 true（关掉 = 病回来）
      const 开关 = await session.js(`(() => { const w = ${lab.IF};
        const o = w.vditor && w.vditor.vditor && w.vditor.vditor.options ? w.vditor.vditor.options : null;
        const opt = w.__vditorOptions || (w.vditor && w.vditor.options) || null;
        return {有实例: !!w.vditor, mark: opt && opt.preview && opt.preview.markdown ? opt.preview.markdown.mark : null}; })()`);
      const 源码 = fs.readFileSync('E:/MarkPilot/Typora-Editor/extension-src/render/index.js', 'utf8');
      const 副本 = fs.readFileSync(path.join(harness.project, 'app/renderer/index.js'), 'utf8');
      ctx.witness('解析开关（源码 + 开发树副本）', {开关, 源码有: /mark:\s*true/.test(源码), 副本有: /mark:\s*true/.test(副本)}, 'disk');
      ctx.assert('源码与开发树的 Vditor 选项里都写着 mark: true（关掉就复发）',
        /mark:\s*true/.test(源码) && /mark:\s*true/.test(副本), JSON.stringify(开关));

      // 保真：解析开关不该改写任何字节
      const 存 = await edge.saveAndWait(session, file);
      ctx.witness('磁盘：保存之后的字节', {相同: 存.after === 夹具}, 'disk');
      ctx.assert('打开→保存逐字节不变（解析开关没有改写文档）', 存.after === 夹具, JSON.stringify(存.after.slice(0, 140)));
    } finally {
      await ctx.release(session);
    }
  },
};
