/** 行尾右侧空白点击：光标不许跑进那条折行公式的源码里。
 *
 *  用户报告（2026-09-17）："在段落行尾及其右侧的空白处点击，光标跑进上一处行内公式的源码"——
 *  打字会直接写坏公式。原始素材上稳定复现。
 *
 *  本轮把触发条件钉清了（`probe-lineend-dom.cjs` 逐点问浏览器，两张素材对齐比较）：
 *    · **公式必须在视觉上折行**（KaTeX 的多个 `.base` 会在行间断开）。折行后公式的
 *      包围盒是一个矩形，它把"上一行尾部右侧的空白"也**盖在里面**；
 *    · 在那一小块空白上点，浏览器原生命中测试给的是**预览子树里的位置**
 *      （`caretRangeFromPoint` → `inPreview: true`）——那不是可编辑位置，于是 Vditor 的兜底
 *      把公式**展开**、光标塞进 `<code>` 的偏移 0，接着打的字就写进公式源码。
 *    · 不折行的短公式（`$x+1$`）复现不出来：同样位置的原生命中给的是段落里的正常位置。
 *      上一轮"删掉场景"就是栽在这里——素材少了"折行"这个条件。
 *
 *  所以本场景自带**几何合成**：铺 N 段"中文填充 + 会折行的公式"，逐段量出
 *  "公式首行末尾 → 段落右缘"的余量，挑出余量落在 0–40px、且原生命中真的落进预览的那一段。
 *  选不出候选点时场景**判失败并打印扫描表**——素材不再复现缺陷是必须被看见的事，
 *  绝不允许退化成"通过但空洞"。
 *
 *  判据（都是用户看得见的东西）：
 *    ① 点行尾空白 + 打字：字落在**段落里**，公式源码一字不变、公式不展开
 *    ② 磁盘证人：Ctrl+S 后文件里段落末尾有那个字、公式源码原样
 *    ③ 对照：点公式**正中**仍然展开并进源码——规则没有越界
 *    ④ 产物级：源与开发树逐字节一致 + 两处守卫在
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const PREVIEW = '.vditor-ir__preview';
const TYPE_CHAR = 'Q';

/** 会折行的行内公式：KaTeX 把它拆成多个 `.base` 在行间断开（用户素材同形）。
 *  用中性文字，结构与用户那段的"正文 + 若干行内公式 + 末尾一条长公式"一致。 */
const FORMULA = '$a\\times50+甲\\times 80=1w 甲=65/40>乙=30/50$';
const FILL = '测度变换与随机过程这一章讲的是把测度从直觉升格为定理的过程，';
/** 填充长度按字递增：每 1 个字让末尾公式整体右移约一个汉字宽，
 *  于是"公式首行还剩多少空间"被逐字扫过——总有一段把公式推到贴着右缘折行。 */
const FILLERS = Array.from({length: 26}, (_, index) => 24 + index);

const fixtureText = () => {
  const lines = ['# 行尾公式折行验收', ''];
  FILLERS.forEach((count, index) => {
    lines.push(`第 ${index} 组：` + FILL.repeat(3).slice(0, count) + FORMULA);
    lines.push('');
  });
  lines.push('末段：收尾。');
  lines.push('');
  return lines.join('\n');
};

/** 几何合成：逐段找出"某一行尾部是空白、而那块空白仍在折行公式盒内"的落点。
 *  候选的机器判据 = **浏览器原生命中测试落进预览子树**（这正是缺陷的触发条件），
 *  另外要求余量在 0–40px（我们的规则接管范围）且那一段在屏幕内。 */
const FIND = `(() => {
  const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false, error: '没有编辑面'};
  const fr = frame.getBoundingClientRect();
  const scanned = [];
  const blocks = [...surface.children];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const owner = [...block.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].pop();
    if (!owner) continue;
    const preview = owner.querySelector(${JSON.stringify(PREVIEW)});
    if (!preview) continue;
    block.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    const br = block.getBoundingClientRect();
    const pr = preview.getBoundingClientRect();
    const lineHeight = parseFloat(w.getComputedStyle(block).lineHeight) || 22;
    const range = d.createRange(); range.selectNodeContents(preview);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const top = Math.min(...rects.map(r => r.top));
    const firstLine = rects.filter(r => (r.top + r.bottom) / 2 < top + lineHeight);
    if (!firstLine.length) continue;
    const tail = Math.max(...firstLine.map(r => r.right));
    const bottom = Math.max(...firstLine.map(r => r.bottom));
    const y = Math.round((top + bottom) / 2);
    const x = Math.round(tail + 4);
    const caret = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
    const start = caret ? caret.startContainer : null;
    const at = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
    const hit = d.elementFromPoint(x, y);
    const row = {index, lead: block.textContent.slice(0, 12), 公式盒高: Math.round(pr.height),
      行高: Math.round(lineHeight), 折行: +(pr.height / lineHeight).toFixed(2),
      公式首行末尾: Math.round(tail), 段落右缘: Math.round(br.right), 余量: Math.round(br.right - tail),
      落点: {x, y}, 原生命中落进预览: !!(at && at.closest && at.closest(${JSON.stringify(PREVIEW)})),
      命中元素: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 24) : null,
      在屏幕内: br.bottom > 0 && br.top < w.innerHeight};
    scanned.push(row);
    if (row.原生命中落进预览 && row.余量 >= 0 && row.余量 <= 40 && row.折行 >= 1.6 && row.在屏幕内) {
      return {ok: true, pick: row, scanned, frame: {x: Math.round(fr.x), y: Math.round(fr.y)}};
    }
  }
  return {ok: false, error: '没有找到"行尾空白仍落在折行公式盒内"的落点', scanned};
})()`;

/** 每段的事实：段落源码（去掉预览子树）、最后一条公式的源码、整篇里哪些段含有那个字。 */
const FACTS = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false};
  const strip = block => { const clone = block.cloneNode(true);
    clone.querySelectorAll(${JSON.stringify(PREVIEW)}).forEach(node => node.remove());
    return clone.textContent; };
  const texts = [...surface.children].map(strip);
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const start = range ? range.startContainer : null;
  const at = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
  const code = at && at.closest ? at.closest('code[data-type="math-inline"]') : null;
  const box = range ? range.getBoundingClientRect() : null;
  const value = (() => { try { return w.vditor.getValue(); } catch (error) { return 'ERR:' + error.message; } })();
  return {ok: true, texts, markdown: value,
    含字的段: texts.map((text, index) => (text.includes(${JSON.stringify(TYPE_CHAR)}) ? index : -1)).filter(index => index >= 0),
    光标: {在公式源码里: !!code, 在预览里: !!(at && at.closest && at.closest(${JSON.stringify(PREVIEW)})),
      在标记上: !!(at && at.closest && at.closest('.vditor-ir__marker')),
      容器: start ? (start.nodeType === 3 ? 'TEXT' : start.nodeName) : null, 偏移: range ? range.startOffset : null,
      有矩形: !!(box && (box.width > 0 || box.height > 0))}}; })()`;

/** 一段的公式状态：最后一条公式的源码 + 是否展开。 */
const MATH_STATE = index => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const block = [...surface.children][${index}];
  if (!block) return {ok: false};
  const maths = [...block.querySelectorAll('code[data-type="math-inline"]')];
  const last = maths[maths.length - 1];
  const owner = last ? last.closest('.vditor-ir__node') : null;
  return {ok: true, 公式数: maths.length, 末条公式源码: last ? last.textContent : null,
    展开: !!(owner && owner.classList.contains('vditor-ir__node--expand')),
    全部源码: maths.map(node => node.textContent)}; })()`;

const wait = (session, ms) => session.js(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return 1; })()`);

module.exports = {
  id: '107-line-end-caret',
  title: '行尾右侧空白点击：光标不许跑进折行公式的源码（自带几何合成）',
  async run(ctx) {
    const file = fixtures.write('line-end-caret.md', fixtureText());
    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 90000, interval: 30});
      ctx.assert('编辑器就绪', ready, `ready=${ready}`);
      if (!ready) return;
      await edge.settle(session);
      await wait(session, 400);

      // ══ ① 几何合成：找出一处"行尾空白仍在折行公式盒内"的落点 ═══════════════
      const found = await session.js(FIND);
      ctx.witness('① 几何合成扫描：每段的折行度、公式首行末尾、与段落右缘的余量、原生命中测试去向',
        {找到: found.ok, 目标: found.pick || null, 扫描: (found.scanned || []).slice(-8)}, 'geometry');
      ctx.assert('① 几何合成成功：铺出的段落里存在"折行公式首行末尾贴着段落右缘"的一段（缺陷的触发条件）',
        found.ok, JSON.stringify({error: found.error, 扫描尾: (found.scanned || []).slice(-6)}));
      if (!found.ok) return;
      const pick = found.pick;
      ctx.assert('① 落点在浏览器原生命中测试里确实落进公式预览（这就是缺陷本身，不是我们的判定）',
        pick.原生命中落进预览 === true, JSON.stringify(pick));

      // ══ ② 点行尾空白 + 打字：字必须落在段落里 ══════════════════════════════
      const before = await session.js(MATH_STATE(pick.index));
      const clickX = found.frame.x + pick.落点.x;
      const clickY = found.frame.y + pick.落点.y;
      await session.click(clickX, clickY);
      await wait(session, 400);
      const afterClick = await session.js(FACTS);
      await session.send('Input.insertText', {text: TYPE_CHAR});
      await wait(session, 400);
      const afterType = await session.js(FACTS);
      const afterMath = await session.js(MATH_STATE(pick.index));
      const paragraph = (afterType.texts || [])[pick.index] || '';
      ctx.witness('② 点行尾空白后打字：光标状态、段落源码、公式状态（磁盘之外的第一手证据）', {
        落点: {x: clickX, y: clickY}, 余量: pick.余量, 折行: pick.折行,
        点击后光标: afterClick.光标, 打字后光标: afterType.光标,
        段落源码尾: paragraph.slice(-24), 含字的段: afterType.含字的段,
        公式: {修前: before.全部源码, 修后: afterMath.全部源码, 展开: afterMath.展开}}, 'geometry');
      const where = afterType.含字的段;
      ctx.assert('② 打的那个字落在**本段**（而不是跑进公式源码、也没有掉到别的段落）',
        where.includes(pick.index), JSON.stringify({含字的段: where, 本段: pick.index, 段落源码尾: paragraph.slice(-24)}));
      ctx.assert('② 公式源码一字未变（没有把字写进公式里）',
        JSON.stringify(afterMath.全部源码) === JSON.stringify(before.全部源码),
        JSON.stringify({修前: before.全部源码, 修后: afterMath.全部源码}));
      ctx.assert('② 公式没有被展开（点行尾空白不该把公式的源码翻出来）',
        afterMath.展开 === false, JSON.stringify({展开: afterMath.展开}));
      ctx.assert('② 字落在这一段正文的**末尾**（段落源码 = 原文 + 那个字）',
        paragraph.endsWith(TYPE_CHAR), JSON.stringify({段落源码尾: paragraph.slice(-24)}));
      ctx.assert('② 光标不在公式源码里、也不在标记上',
        afterType.光标.在公式源码里 === false && afterType.光标.在标记上 === false,
        JSON.stringify(afterType.光标));
      // 指标按**用户损失**记：字写进了公式源码、或字没落在这一段，都算一次"落点错了"。
      // （只按"字在不在本段"记是量不出来的：公式源码也属于本段的文本。）
      const intoFormula = JSON.stringify(afterMath.全部源码) !== JSON.stringify(before.全部源码);
      ctx.metric('lineEnd.wrongTarget', intoFormula || !where.includes(pick.index) ? 1 : 0,
        {unit: '次', direction: 'lower', tolerance: 0.001});

      // ══ ③ 磁盘证人：存盘后文件里段落末尾有那个字、公式原样 ════════════════
      const saved = await edge.saveAndWait(session, file, {timeout: 8000});
      const text = fs.readFileSync(file, 'utf8');
      const markdownFormula = String(before.全部源码[before.全部源码.length - 1] || '');
      ctx.witness('③ 存盘后的磁盘内容（文件系统证人）', {
        落盘方式: saved.chordTook ? 'Ctrl+S' : '菜单兜底', 字节: text.length,
        段落片段: text.split('\n').filter(line => line.includes(TYPE_CHAR)).slice(0, 3)}, 'disk');
      ctx.assert('③ 磁盘证人：文件里出现"公式 + 那个字"（字在公式外面）',
        text.includes(markdownFormula + TYPE_CHAR) || text.split('\n').some(line => line.includes(TYPE_CHAR) && line.endsWith(TYPE_CHAR)),
        JSON.stringify({期望公式: markdownFormula, 含字行: text.split('\n').filter(line => line.includes(TYPE_CHAR)).slice(0, 3)}));
      ctx.assert('③ 磁盘证人：公式源码在文件里原样保留',
        text.includes(markdownFormula), JSON.stringify({期望: markdownFormula, 命中: text.includes(markdownFormula)}));

      // 打字结果撤销回去，别把控制组的前提改掉
      await session.chord('z', 'KeyZ', 90);
      await wait(session, 400);

      // ══ ④ 对照：点公式**正中**仍然展开、字仍然进源码（规则没有越界） ══════
      // 落点必须**压在公式的字形上**：公式折行后它的盒子是个大矩形，
      // 盒子中心可能落在"上一行尾部右侧的空白"里（那正是本场景要打的空白）。
      // 所以取第一个**有映射的字形**（KaTeX 叶子上的 data-typora-source-start），点它的正中。
      const centre = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const block = [...surface.children][${pick.index}];
        const owner = [...block.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].pop();
        const preview = owner.querySelector(${JSON.stringify(PREVIEW)});
        preview.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
        const glyph = [...preview.querySelectorAll('[data-typora-source-start]')]
          .map(node => ({node, rect: node.getBoundingClientRect()}))
          .find(item => item.rect.width > 4 && item.rect.height > 4);
        if (!glyph) return {ok: false, error: '没有可点的字形'};
        const frame = document.getElementById('editor').getBoundingClientRect();
        return {ok: true, x: Math.round(frame.x + glyph.rect.left + glyph.rect.width / 2),
          y: Math.round(frame.y + glyph.rect.top + glyph.rect.height / 2),
          字形: glyph.node.textContent, 字形盒: {l: Math.round(glyph.rect.left), r: Math.round(glyph.rect.right)}}; })()`);
      ctx.assert('④ 对照落点找到了（压在公式某个字形上）', centre.ok, JSON.stringify(centre));
      if (!centre.ok) return;
      await session.click(centre.x, centre.y);
      await wait(session, 500);
      const inside = await session.js(MATH_STATE(pick.index));
      const insideCaret = await session.js(FACTS);
      ctx.witness('④ 对照：点在公式内部（用户想编辑公式时的那一下）', {
        落点: centre, 展开: inside.展开, 光标: insideCaret.光标}, 'geometry');
      ctx.assert('④ 对照：点公式内部光标仍在公式里（预览或源码），规则只对"行尾之外"生效',
        insideCaret.光标.在公式源码里 === true || insideCaret.光标.在预览里 === true,
        JSON.stringify({展开: inside.展开, 光标: insideCaret.光标}));

      // ══ ⑤ 产物级：源与开发树一致 + 守卫代码在 ════════════════════════════
      const project = harness.project;
      const checks = ['js/typora-patches.js'].map(relative => {
        const source = path.join('E:/MarkPilot/Typora-Editor/extension-src/render', relative);
        const shared = path.join(project, 'app/renderer', relative);
        const same = fs.existsSync(source) && fs.existsSync(shared) &&
          fs.readFileSync(source).equals(fs.readFileSync(shared));
        return {relative, same};
      });
      ctx.witness('⑤ 源与开发树是否逐字节一致', checks, 'disk');
      ctx.assert('⑤ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）', checks.every(row => row.same), JSON.stringify(checks));
      const patches = fs.readFileSync(path.join(project, 'app/renderer/js/typora-patches.js'), 'utf8');
      const guards = {
        行尾权威判定: /const lineEndAtom = \(root, \{ x, y \}\)/.test(patches),
        已接线: /const removeLineEndCaret = installLineEndCaret\(root\)/.test(patches),
        随销毁摘除: /removeLineEndCaret\(\);/.test(patches),
      };
      ctx.assert('⑤ 行尾判定与接线都在（离线改回源码即会变红）', Object.values(guards).every(Boolean), JSON.stringify(guards));
    } finally {
      await ctx.release(session);
    }
  },
};
