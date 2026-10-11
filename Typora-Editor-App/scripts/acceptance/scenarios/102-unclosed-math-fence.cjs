/** 未闭合的 $$ 围栏不许吃掉后面内容、不许把 **加粗** 变成公式源码。
 *
 *  用户报告（2026-09-17 原文）："$…$、$$…$$ 少了收尾的时候，泄漏的数学区把周围内容的
 *  渲染和复制都搞坏了（比如 **bold** 的星号不再渲染）"，并要求"彻底改用 Typora 处理
 *  fence 的方法，不要再搞固定的块、代码区域"。
 *
 *  根因（本次实测定位，两条要分开看）：
 *   1. **Lute 原生行为**：行首独立 `$$` 一旦没有闭合，Lute 会把它建成一个**吃到文件尾**的
 *      数学块，后面的 `**加粗**` 全变成 TeX 源码（KaTeX 把星号画出来），`<strong>` 消失。
 *      `normalizeMathFences` 原来在"找不到闭合"时**原样透传**，等于把这条漏洞放行
 *      （scripts/acceptance/probe-lute-dollar-forms.cjs 样本 11 复现）。
 *   2. `normalizeMathFences` 的注释断言"Lute 只认行尾的收尾 $$"，据此把 `$$公式$$` 文本化
 *      拆成独立块。实测**该前提不成立**：样本 1–8 都以非 `$` 开头、normalize 完全没动手，
 *      Lute 照样把行中的 `$$…$$` 建成块（Lute 没有行内 `$$` 表示法）。所以"变成固定的块"
 *      是 Lute 的既有行为，不是这段改写造成的。
 *
 *  本轮修的是第 1 条：未闭合的块在**第一个空行**处收尾（没有空行则收到文件尾，与 Lute 一致），
 *  于是它不再越界吃掉后面的段落与格式；已闭合的块一个字节都不动（只在 `math` 仍开启时才插入）。
 *
 *  验收判据（都是用户看得见的东西）：
 *    ① 未闭合 $$ 后面的 `**加粗甲**` 真的渲染成 `<strong>`（DOM 证据）
 *    ② 数学节点没有吃到文件尾：块序列里 math-block 之后还有独立段落
 *    ③ 磁盘证人：存盘后 `$$` 围栏成对，且 `**加粗甲**` 出现在收尾 `$$` **之后**的行上
 *    ④ 没有反作用：正经闭合的 $$ 块公式仍然是一个 math-block（回归保护）
 *    ⑤ 源与开发树逐字节一致（EXE 与 VSIX 吃同一份代码）
 *
 *  用法（排查）：node scripts/acceptance/run.cjs --app=dev --only=102-unclosed-math-fence
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');
const sleep = require('../harness.cjs').sleep;

const IF = `document.getElementById('editor').contentWindow`;

/** 结构 + 加粗 + 数学节点范围：证明"公式吃到哪里、加粗有没有活下来"。 */
const SHAPE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (!surface) return {ok: false, error: '没有编辑面'};
  const blocks = [...surface.children].map(node => {
    const math = node.querySelector('code[data-type="math-block"]');
    return node.nodeName.toLowerCase() + (math ? '<MB>' : '');
  });
  const mb = surface.querySelector('code[data-type="math-block"]');
  return {ok: true, blocks,
    strong: [...surface.querySelectorAll('strong')].map(n => n.textContent),
    mathSource: mb ? mb.textContent : null,
    text: surface.innerText.replace(/\\n+/g, ' | ').slice(0, 200)}; })()`;

const MD = `(() => { const w = ${IF}; return w.vditor.getValue(); })()`;

/** 未闭合围栏：$$ 开了头，之后没有收尾，空行后面才是加粗正文。 */
const UNCLOSED = [
  '**整数解**',
  '',
  '$$',
  '(16,4),(15,6)',
  '所有移动的树 = 原分点与新分点的公共分点：',
  '',
  '**加粗甲** 正文乙',
  '',
  '尾段丙',
  '',
].join('\n');

/** 对照：正经闭合的块公式，行为必须一字不变。 */
const CLOSED = ['前段', '', '$$', 'a+b=c', '$$', '', '**加粗乙** 正文丁', ''].join('\n');

module.exports = {
  id: '102-unclosed-math-fence',
  title: '未闭合 $$ 不吃掉后续内容（加粗不再变公式源码）',
  async run(ctx) {
    const unclosedFile = fixtures.write('unclosed-math-fence.md', UNCLOSED);
    const closedFile = fixtures.write('closed-math-fence.md', CLOSED);

    const session = await ctx.launch({args: [unclosedFile]});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 120000, interval: 80});
      await sleep(1600);

      // ══ ① ② 用户看得见：加粗渲染出来 + 数学节点没吃到尾 ═══════════════════════
      const shape = await session.js(SHAPE);
      if (!ctx.assert('① 打开未闭合围栏的文档后能读到编辑面', shape.ok, JSON.stringify(shape))) return;
      ctx.log('块序列 ' + JSON.stringify(shape.blocks) + ' 加粗 ' + JSON.stringify(shape.strong));
      ctx.witness('① DOM：块序列 / <strong> / 数学源码', {blocks: shape.blocks, strong: shape.strong, mathSource: shape.mathSource});
      ctx.assert('① 未闭合公式后面的 `**加粗甲**` 渲染成 <strong>（加粗没有变成公式源码）',
        shape.strong.includes('加粗甲'), JSON.stringify({strong: shape.strong}));
      ctx.assert('① 数学节点的源码里没有混进加粗正文（公式没越界）',
        !!shape.mathSource && !shape.mathSource.includes('加粗甲'), JSON.stringify({mathSource: shape.mathSource}));
      ctx.assert('② 数学块之后仍有独立段落（内容没被吃到文件尾）',
        shape.blocks.filter(b => b === 'p').length >= 2, JSON.stringify({blocks: shape.blocks}));

      // ══ ③ 磁盘证人：存盘后围栏成对，加粗在收尾 $$ 之后 ═══════════════════════
      // 打开时产品并不改写磁盘（实测：Ctrl+S 之前文件一字未动），所以先做一次真实编辑
      // 把文档置脏，再存盘——磁盘证人要证明的是"存盘那一刻写出去的是什么"。
      const EDITED = 'Z';
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset'); surface.focus();
        const block = [...surface.querySelectorAll(':scope > p')].pop();
        const text = block && [...block.childNodes].filter(n => n.nodeType === 3).pop();
        if (!text) return {ok: false};
        const range = d.createRange(); range.setStart(text, text.data.length); range.collapse(true);
        const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return {ok: true}; })()`);
      await sleep(400);
      await session.type(EDITED);
      await sleep(900);
      const landed = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        return surface.innerText.includes(${JSON.stringify(EDITED)}); })()`);
      ctx.assert('③ 真实按键输入落在了文档里（存盘前的置脏编辑）', landed === true, JSON.stringify({landed}));

      const trySave = async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          await session.chord('s', 'KeyS', 83);
          await sleep(900);
          const text = fs.readFileSync(unclosedFile, 'utf8');
          if (text.includes(EDITED)) return {text, attempts: attempt + 1, via: 'Ctrl+S'};
        }
        return {text: fs.readFileSync(unclosedFile, 'utf8'), attempts: 4, via: '没落盘'};
      };
      const saved = await trySave();
      const lines = saved.text.split(/\r?\n/);
      const fenceLines = lines.map((line, index) => ({index, text: line.trim()})).filter(item => item.text === '$$').map(item => item.index);
      const boldLine = lines.findIndex(line => line.includes('**加粗甲**'));
      ctx.witness('③ 磁盘：存盘后的 markdown 与围栏行号', {bytes: saved.text.length, fenceLines, boldLine, text: saved.text});
      ctx.log('存盘后：' + JSON.stringify(saved.text));
      ctx.assert('③ 存盘成功（磁盘上出现了刚才输入的字符）',
        saved.text.includes(EDITED), JSON.stringify({via: saved.via, attempts: saved.attempts, bytes: saved.text.length}));
      ctx.assert('③ 磁盘上围栏成对（未闭合的 $$ 被在空行前收尾，不是孤零零一个）',
        fenceLines.length % 2 === 0 && fenceLines.length >= 2, JSON.stringify({fenceLines, fences: fenceLines.length}));
      ctx.assert('③ 磁盘上 `**加粗甲**` 落在收尾 $$ 之后（加粗没有落进公式里）',
        boldLine >= 0 && fenceLines.length >= 2 && boldLine > fenceLines[fenceLines.length - 1],
        JSON.stringify({boldLine, lastFence: fenceLines[fenceLines.length - 1], fences: fenceLines.length}));
      ctx.assert('③ 收尾 $$ 插在空行之前（公式只收到内容块末尾，不吃掉后面段落）',
        fenceLines.length >= 2 && !String(lines[fenceLines[1] + 1]).includes('加粗'),
        JSON.stringify({afterClosing: lines[fenceLines[1] + 1]}));

      // ══ ④ 回归保护：正经闭合的块公式行为不变 ═════════════════════════════════
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(CLOSED)}); return 1; })()`);
      await sleep(1400);
      const closedShape = await session.js(SHAPE);
      ctx.witness('④ 已闭合块公式的 DOM', {blocks: closedShape.blocks, strong: closedShape.strong, mathSource: closedShape.mathSource});
      ctx.log('已闭合：' + JSON.stringify(closedShape.blocks) + ' 加粗 ' + JSON.stringify(closedShape.strong));
      ctx.assert('④ 正经闭合的 $$ 仍是一个 math-block，公式源码一字不差',
        closedShape.blocks.includes('div<MB>') && closedShape.mathSource === 'a+b=c',
        JSON.stringify({blocks: closedShape.blocks, mathSource: closedShape.mathSource}));
      ctx.assert('④ 闭合块公式后面的加粗照旧渲染',
        closedShape.strong.includes('加粗乙'), JSON.stringify({strong: closedShape.strong}));
      ctx.assert('④ 已闭合块公式的 markdown 原样透传（normalize 不插手）',
        await session.js(MD) === CLOSED, JSON.stringify(await session.js(MD)));
    } finally {
      await ctx.release(session);
      await sleep(300);
    }

    // ══ ⑤ 产物级：源与开发树逐字节一致 ═══════════════════════════════════════
    const project = require('../harness.cjs').project;
    const rel = 'js/math-markdown.js';
    const sourcePath = path.join('E:/MarkPilot/Typora-Editor/extension-src/render', rel);
    const sharedPath = path.join(project, 'app/renderer', rel);
    const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
    const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : '';
    ctx.witness('⑤ math-markdown.js 在源与开发树之间是否逐字节一致', {same: !!source && source === shared, source: source.length, shared: shared.length});
    ctx.assert('⑤ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）', !!source && source === shared,
      JSON.stringify({source: source.length, shared: shared.length, sourcePath, sharedPath}));
    ctx.assert('⑤ 未闭合收尾的守卫代码在（第一个空行处收尾，不是原样透传）',
      /boundary/.test(shared) && /splice\(boundary/.test(shared), JSON.stringify({bytes: shared.length}));
  },
};
