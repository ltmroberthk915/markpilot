/** 围栏当普通字符 + 空公式看得见 + 纯公式行不再被纵向移动跳过（2.2.1 口径变更）。
 *
 *  用户 2026-09-17 的报告：
 *    1) "客户把光标放在这个文件最后一个数学公式最后一个 fence 的后面，点退格现在是点不了的……
 *       最好能直接把这些 fence 当普通字符处理，你现在这样太别扭了，卡手"；
 *    2) "一旦把这个 inline math 的 fence 内的内容删掉之后, 会突变成 block math fence!"；
 *    3) "上下方向键遇到单行仅有 inline math 的会导致光标跳过这一行, 而非正常逻辑上跑到 inline
 *       math 行最后"。
 *
 *  本场景钉住新口径（旧口径的断言在 74/75 里同步改过，理由写在那两处）：
 *    ① 空块公式**看得见**（渲染落定处带 data-empty-math、占位文字有真实几何），
 *       退格一次整条移除，磁盘上不留 `span` 残渣（旧缺陷：markdown 里写进一行字面 `span`）；
 *    ② 行内公式外侧退格 = 删掉那一个 `$`，公式降级为字面文本（`$a$` → `$a`），内容一个不少；
 *    ③ 行内公式内容删空：**不许**留下独占一行的 `$$`（那会被 Lute 读成块公式围栏）；
 *    ④ 块公式源码里按住 Shift 连按 ←：选区单调生长（旧症状：每两下塌一次，见 probe-math-keys2）；
 *    ⑤ 整行只有一条行内公式时，上下方向键落到**那一行**（旧症状：整行被跳过）。
 *
 *  证人：磁盘（Ctrl+S 后独立进程读字节）、几何（占位与公式盒子的实际像素）、DOM。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;

const READ = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const s = w.getSelection();
  const describe = (node, offset) => {
    if (!node) return 'null';
    const at = node.nodeType === 3 ? node.parentElement : node;
    const path = [];
    for (let cur = at; cur && cur !== d.body; cur = cur.parentElement) path.push(cur.nodeName.toLowerCase() + (cur.dataset && cur.dataset.type ? '[' + cur.dataset.type + ']' : ''));
    return path.slice(0, 4).join('<') + (node.nodeType === 3 ? ':TEXT' : '') + '@' + offset;
  };
  const caret = s.rangeCount ? (() => { const r = s.getRangeAt(0);
    return {collapsed: r.collapsed, text: JSON.stringify(s.toString()).slice(0, 40), length: r.toString().length,
      anchor: describe(s.anchorNode, s.anchorOffset), focus: describe(s.focusNode, s.focusOffset)}; })() : null;
  const empties = [...surface.querySelectorAll('[data-empty-math]')].map(node => {
    const box = node.getBoundingClientRect();
    return {tag: node.tagName.toLowerCase(), dataMath: JSON.stringify(node.getAttribute('data-math')),
      rect: [Math.round(box.width), Math.round(box.height)],
      before: w.getComputedStyle(node, '::before').content};
  });
  const value = w.vditor.getValue();
  return {value, caret, empties,
    blocks: [...surface.children].map(node => node.nodeName.toLowerCase() + (node.dataset && node.dataset.type ? '[' + node.dataset.type + ']' : '')),
    bare: String(value).replace(/\\r/g, '').split('\\n').map(line => line.trim()).filter(line => line === '$$'),
    hasSpan: /\\nspan\\n/.test(String(value)),
    toast: (d.querySelector('.typora-context-toast') || {}).textContent || null}; })()`;

/** 顶层页坐标：jsBody 里给出 target 与 share/shareY。 */
const pointOf = jsBody => `(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  let target = null, share = 0.5, shareY = 0.5;
  ${jsBody}
  if (!target) return {ok: false};
  target.scrollIntoView({block: 'center', behavior: 'instant'});
  const box = target.getBoundingClientRect(), fr = frame.getBoundingClientRect();
  return {ok: true, x: Math.round(fr.x + box.left + box.width * share), y: Math.round(fr.y + box.top + box.height * shareY)}; })()`;

const place = (jsBody, why) => session => session.js(`(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  surface.focus();
  const made = (() => { ${jsBody} })();
  if (!made || !made.range) return {ok: false, error: made ? made.why : '没有结果'};
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(made.range);
  return {ok: true, why: ${JSON.stringify(why)}}; })()`);

module.exports = {
  id: '109-fence-as-text-and-empty-formula',
  title: '围栏当普通字符 / 空公式可见可删 / 纯公式行不再被跳过',
  run: async ctx => {
    const out = ctx.outDir;
    fs.mkdirSync(out, {recursive: true});
    const file = path.join(out, 'fence-text.md');
    const body = [
      '# 围栏当普通字符',
      '',
      '甲段 $a$ 乙段',
      '',
      '$$\n\n$$',
      '',
      '丙段',
      '',
      '$$\na+b=1\n$$',
      '',
      '丁段',
      '',
      '$q$',
      '',
      '戊段',
      '',
    ].join('\n');
    fs.writeFileSync(file, body, 'utf8');
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`,
        {timeout: 140000, interval: 80});
      await harness.sleep(1600);
      const start = await session.js(READ);

      // ══ ① 空块公式：看得见 ═══════════════════════════════════════════════
      ctx.witness('DOM：装载后空公式的占位与几何', {empties: start.empties, blocks: start.blocks}, 'geometry');
      ctx.assert('① 空块公式在页面上看得见（data-empty-math 占位 + 真实宽高 + ::before 写着"空公式"）',
        start.empties.length === 1 && start.empties[0].rect[0] > 20 && start.empties[0].rect[1] > 10 &&
          /空公式/.test(start.empties[0].before || ''),
        JSON.stringify({empties: start.empties, blocks: start.blocks}));
      const emptyPoint = await session.js(pointOf(`
        target = d.querySelector('[data-empty-math]');`));
      if (emptyPoint.ok) {
        await session.click(emptyPoint.x, emptyPoint.y);
        await harness.sleep(420);
        const inEmpty = await session.js(READ);
        ctx.assert('① 空公式点得进去（光标进它的源码），点一下不改文档',
          String(inEmpty.caret && inEmpty.caret.focus || '').includes('math-block') && inEmpty.value === start.value,
          JSON.stringify({caret: inEmpty.caret}));
        await session.key({key: 'Delete', code: 'Delete', vk: 46});
        await harness.sleep(600);
        const removed = await session.js(READ);
        const savedEmpty = await edge.saveAndWait(session, file, {timeout: 8000});
        const diskRemoved = String(savedEmpty.after);
        ctx.witness('磁盘：在空公式里按一次删除之后的文件', {内存: removed.value, 磁盘: diskRemoved}, 'disk');
        ctx.assert('① 空公式里按一次删除：公式整条移除、磁盘上不留 `span` 残渣（旧缺陷是写进一行字面 span）',
          !removed.hasSpan && !diskRemoved.includes('\nspan\n') &&
            (diskRemoved.match(/^\$\$$/gm) || []).length === (body.match(/^\$\$$/gm) || []).length - 2,
          JSON.stringify({hasSpan: removed.hasSpan, 磁盘裸围栏行: [(body.match(/^\$\$$/gm) || []).length, (diskRemoved.match(/^\$\$$/gm) || []).length],
            内存: removed.value.split('\\n').slice(0, 8)}));
        ctx.assert('① 移除之后光标在正文里（不在公式源码里），接着打字进的是正文',
          !String(removed.caret && removed.caret.focus || '').includes('[math'),
          JSON.stringify({caret: removed.caret, 内存: removed.value.split('\\n').slice(0, 8)}));
        await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(body)}); return 1; })()`);
        await harness.sleep(1300);
      } else {
        ctx.assert('① 点得到空公式（空块用例）', false, JSON.stringify(emptyPoint));
      }

      // ══ ② 行内公式外侧退格：围栏当普通字符 ═══════════════════════════════
      await place(`{
        const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
        if (!owner) return {why: '第一段里没有行内公式'};
        const r = d.createRange(); r.setStartAfter(owner); r.collapse(true);
        return {range: r, why: '行内公式之后'};
      }`, '行内公式之后')(session);
      await harness.sleep(320);
      const beforeInline = await session.js(READ);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await harness.sleep(450);
      const afterInline = await session.js(READ);
      const savedInline = await edge.saveAndWait(session, file, {timeout: 8000});
      ctx.witness('磁盘：行内公式外侧退格之后的文件', {内存: afterInline.value.split('\n').slice(2, 3),
        磁盘: String(savedInline.after).replace(/\r/g, '').split('\n').slice(2, 3)}, 'disk');
      ctx.assert('② 行内公式外侧退格：闭围栏那一个 `$` 没了、公式降级成字面文本（`$a$` → `$a`），内容一个字符不少',
        /甲段 \$a 乙段/.test(afterInline.value.replace(/\r/g, '')) &&
          String(savedInline.after).replace(/\r/g, '').includes('甲段 $a 乙段'),
        JSON.stringify({前: beforeInline.value.split('\n')[2], 后: afterInline.value.split('\n')[2],
          磁盘: String(savedInline.after).split('\n')[2]}));
      ctx.assert('② 这一下没有留下提示气泡（旧口径是"弹一句说明、什么都不做"）',
        afterInline.toast === null, JSON.stringify({toast: afterInline.toast}));

      // ══ ③ 行内公式内容删空：不许突变成块公式围栏 ═════════════════════════
      const beforeEmpty = await session.js(READ);
      const bareBefore = beforeEmpty.bare.length;
      await place(`{
        const codes = [...surface.querySelectorAll('code[data-type="math-inline"]')];
        const code = codes.find(node => node.textContent.replace(/\\u200b/g, '') === 'q');
        if (!code) return {why: '没有找到内容为 q 的行内公式'};
        const text = code.firstChild;
        const r = d.createRange(); r.setStart(text, text.data.length); r.collapse(true);
        return {range: r, why: 'q 公式源码末尾'};
      }`, 'q 公式源码末尾')(session);
      await harness.sleep(300);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await harness.sleep(450);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await harness.sleep(500);
      const afterEmpty = await session.js(READ);
      const savedEmpty = await edge.saveAndWait(session, file, {timeout: 8000});
      const diskEmpty = String(savedEmpty.after).replace(/\r/g, '');
      ctx.witness('磁盘：把行内公式内容删空之后的文件', {磁盘: diskEmpty.split('\n').slice(8, 14), bareLines: afterEmpty.bare.length}, 'disk');
      ctx.assert('③ 把行内公式内容删空：磁盘上**没有多出**独占一行的 `$$`（公式整条消失，不会"突变"成块公式围栏）',
        afterEmpty.bare.length === bareBefore &&
          (diskEmpty.match(/^\$\$$/gm) || []).length === (body.match(/^\$\$$/gm) || []).length,
        JSON.stringify({bare: [bareBefore, afterEmpty.bare.length],
          磁盘裸围栏行: [(body.match(/^\$\$$/gm) || []).length, (diskEmpty.match(/^\$\$$/gm) || []).length],
          磁盘行: diskEmpty.split('\n').slice(8, 16)}));
      ctx.assert('③ 删空之后公式确实不在了（那一段只剩正文）',
        !/\\$q\\$/.test(afterEmpty.value), JSON.stringify({value: afterEmpty.value.split('\n').slice(8, 14)}));

      // ══ ④ 块公式源码里 Shift+←：选区单调生长 ═════════════════════════════
      // 目标必须是**有内容**那条块公式：本文件里还有一条空块公式（`$$\n\n$$`），它源码为空，
      // "选区只增不减"在它身上没有意义（第一次就把两条围栏选完了）。
      const blockPoint = await session.js(pointOf(`
        const code = [...surface.querySelectorAll('code[data-type="math-block"]')]
          .find(node => node.textContent.replace(/\\u200b/g, '').trim() === 'a+b=1');
        target = code ? code.closest('.vditor-ir__node[data-type="math-block"]') : null;`));
      if (blockPoint.ok) {
        await session.click(blockPoint.x, blockPoint.y);
        await harness.sleep(450);
        const walk = [];
        for (let step = 1; step <= 4; step++) {
          await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, modifiers: harness.MOD.shift});
          await harness.sleep(300);
          const now = await session.js(READ);
          walk.push({step, length: now.caret ? now.caret.length : 0, text: now.caret ? now.caret.text : null});
        }
        ctx.witness('DOM：块公式源码里 Shift+← 连按四次', {walk}, 'dom');
        ctx.assert('④ 块公式源码里 Shift+←：选区只增不减（旧症状是"每两下塌一次"）',
          walk.every((item, index) => index === 0 ? item.length >= 1 : item.length > walk[index - 1].length),
          JSON.stringify(walk));
        ctx.assert('④ 四次之后选中的还是公式源码（没有跑出公式、也没有把公式改坏）',
          walk[walk.length - 1].length >= 3 && /a\+b/.test(String(walk[walk.length - 1].text || '')),
          JSON.stringify({walk, value: (await session.js(READ)).value.split('\n').slice(5, 9)}));
      } else {
        ctx.assert('④ 找得到块公式（Shift+← 用例）', false, JSON.stringify(blockPoint));
      }

      // ══ ⑤ 纯公式行：上下方向键落到那一行 ═════════════════════════════════
      // 前面的 ②③ 已经改过文档（那两条要看的就是改动本身），这里先把内容复原再量纵向移动。
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(body)}); return 1; })()`);
      await harness.sleep(1400);
      const vertical = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const blocks = [...surface.children];
        // 按"内容为 q 的行内公式"定位，再往上取它所在的那一段——比按段落的 textContent 正则稳
        // （IR 里段落文本含零宽标记，正则很容易匹配不上）。
        const code = [...surface.querySelectorAll('code[data-type="math-inline"]')]
          .find(node => node.textContent.replace(/\\u200b/g, '') === 'q');
        const line = code ? code.closest('p,li,h1,h2,h3,h4,h5,h6') : null;
        if (!line) return {ok: false, error: '没有"整行只有一条行内公式"的段落'};
        const index = blocks.indexOf(line);
        const above = blocks[index - 1];
        // 取上一段里最后一个**有内容的**文本节点（段落末尾可能挂着空白/零宽节点）。
        const walker = d.createTreeWalker(above, NodeFilter.SHOW_TEXT, null);
        let text = null, candidate = null;
        while (walker.nextNode()) { candidate = walker.currentNode; if (candidate.data.replace(/[\\s\\u200b]/g, '')) text = candidate; }
        if (!text) return {ok: false, error: '上一段没有文本'};
        surface.focus();
        const r = d.createRange(); r.setStart(text, text.data.length); r.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
        return {ok: true, 行号: index}; })()`);
      if (vertical.ok) {
        await harness.sleep(320);
        await session.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40});
        await harness.sleep(450);
        const down = await session.js(READ);
        ctx.witness('DOM：纯公式行上方的段落末尾按 ↓', {段落序号: vertical.行号, caret: down.caret}, 'dom');
        ctx.assert('⑤ 整行只有一条行内公式时，↓ 落在**那一行**（光标进它的源码；旧症状是整行被跳过）',
          /code\[math-inline\]|span\[inline-node\]/.test(String(down.caret && down.caret.focus || '')),
          JSON.stringify({caret: down.caret, value: down.value.split('\n').slice(8, 14)}));
      } else {
        ctx.assert('⑤ 找得到"整行只有一条行内公式"的段落', false, JSON.stringify(vertical));
      }

      // ══ ⑥ 产物级：源与开发树一致 + 新守卫都在 ═══════════════════════════
      const project = require('../harness.cjs').project;
      const sourceRoot = 'E:/MarkPilot/Typora-Editor/extension-src/render';
      const files = ['js/math-edit.js', 'js/typora-patches.js', 'js/math-scheduler.js', 'index.css'];
      const checks = files.map(rel => {
        const paper = fs.existsSync(path.join(sourceRoot, rel)) ? fs.readFileSync(path.join(sourceRoot, rel), 'utf8') : '';
        const shared = fs.existsSync(path.join(project, 'app/renderer', rel)) ? fs.readFileSync(path.join(project, 'app/renderer', rel), 'utf8') : '';
        return {rel, same: !!paper && paper === shared, source: paper.length, shared: shared.length};
      });
      ctx.witness('⑥ 四个文件在源与开发树之间是否逐字节一致', checks);
      ctx.assert('⑥ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）',
        checks.every(row => row.same), JSON.stringify(checks));
      const math = fs.readFileSync(path.join(project, 'app/renderer/js/math-edit.js'), 'utf8');
      const patches = fs.readFileSync(path.join(project, 'app/renderer/js/typora-patches.js'), 'utf8');
      const scheduler = fs.readFileSync(path.join(project, 'app/renderer/js/math-scheduler.js'), 'utf8');
      const css = fs.readFileSync(path.join(project, 'app/renderer/index.css'), 'utf8');
      const guards = {
        围栏降级: /const deleteFenceChar=/i.test(math) === false ? /deleteFenceChar/.test(math) : true,
        空块整条移除: /emptyMathBlock/.test(math),
        最后一字符接管: /lastCharHit/.test(math),
        块围栏删源码字符: /owner\.matches\('\[data-type="math-block"\]'\)\)return deleteSourceChar/.test(math),
        空公式占位标记: /data-empty-math/.test(scheduler),
        空公式占位样式: /data-empty-math/.test(css),
        纵向补正: /patchVerticalMathLine/.test(patches),
        扩展移动用固定端: /const extendEnd =/.test(patches),
      };
      ctx.assert('⑥ 新口径的八处守卫都在（围栏降级 / 空块移除 / 最后一字符 / 块围栏删源码 / 占位标记与样式 / 纵向补正 / Shift 固定端）',
        Object.values(guards).every(Boolean), JSON.stringify(guards));

      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.witness('⑥ 全程的提示与错误面', {toasts: toasts.recorded, problems}, 'dom');
      ctx.assert('⑥ 全程没有错误提示（乱码 / 失败 / app.asar 之类）', problems.length === 0, JSON.stringify({problems}));
    } finally {
      await ctx.release(session);
    }
  },
};
