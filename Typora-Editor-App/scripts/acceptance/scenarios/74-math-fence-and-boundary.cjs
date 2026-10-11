/** 公式围栏与贴边（用户第 3 轮手验点名的三条，对着**打包产物**跑）。
 *
 *  为什么必须单列一条产物级场景：2.1.1 的三条修复只在开发树里被断言过，用户装上安装版
 *  一周内报"一个都没修复成功"。开发树全绿而装机版全红——这正是验收基座开头写的那个教训
 *  （假通过的第一大来源是"被测对象不是交付产物"）。所以这一条只用真产物 + 真鼠标/键盘，
 *  并且判据全部落在**磁盘字节**与真实 DOM 几何上。
 *
 *  三条对应关系：
 *   1) 行尾以公式结尾：光标停在行尾不该浮出预渲染框（浮框判据 = 展开节点的预览框 position:absolute）；
 *   2) $$ 围栏：展开后点前/后两个 $$ 必须把光标插到**源码首/尾**这个真实可编辑位置，
 *      而且随后打字的字符要落在那一侧（原来字符会跑到源码末尾——所见非所得）；
 *   3) 贴边退格：连按两次退格，公式一行都不能少、围栏与源码都必须在（原来一次就把
 *      $$…$$ 散进上一段、或第二次吃掉围栏）。素材里 (1)/(2) 之间那条"看起来是空行"的
 *      像素带也一起扫，因为 IR 里根本没有那个空行节点。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/排版测试-数理逻辑1(1).md';
const SURFACE = JSON.stringify(edge.SURFACE);

/** 编辑器 iframe 内的读数：光标位置 + 展开/浮框状态。 */
const READ = `(() => {
  const w = document.getElementById('editor').contentWindow;
  const doc = w.document;
  const root = doc.querySelector(${SURFACE});
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const at = range ? range.startContainer : null;
  const element = at && at.nodeType === 3 ? at.parentElement : at;
  const floating = [...doc.querySelectorAll('.vditor-ir__node--expand[data-type="inline-node"] > .vditor-ir__preview')]
    .filter(node => w.getComputedStyle(node).position === 'absolute' && node.getBoundingClientRect().width > 1).length;
  return {
    caretText: at && at.nodeType === 3 ? at.data.slice(0, 20) : null,
    caretTag: element ? element.tagName : null,
    caretType: element && element.dataset ? (element.dataset.type || '') : '',
    offset: range ? range.startOffset : -1,
    inMathCode: !!(element && element.closest && element.closest('code[data-type="math-inline"],code[data-type="math-block"]')),
    expanded: doc.querySelectorAll('.vditor-ir__node--expand').length,
    floating,
    hint: (doc.querySelector('.typora-context-toast') || {}).textContent || null,
    value: w.vditor.getValue(),
    blocks: doc.querySelectorAll('code[data-type="math-block"]').length,
  };
})()`;

const pointOf = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow;
  const doc = w.document;
  const node = (${finder});
  if (!node) return {ok: false, error: '找不到目标'};
  if (node.scrollIntoView) node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
  return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2),
    left: Math.round(rect.x), top: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)};
})()`;

const blockOwner = needle => `(() => {
  const doc = document.getElementById('editor').contentWindow.document;
  const owners = [...doc.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
  return owners.find(owner => owner.textContent.includes(${JSON.stringify(needle)})) || null;
})()`;

module.exports = {
  id: '74-math-fence-and-boundary',
  title: '公式：行尾不浮预渲染框、$$ 围栏可落光标、贴边连按退格不毁公式（产物级）',
  async run(ctx) {
    const fixture = fixtures.write('math-fence.md', [
      '# 公式围栏与贴边',
      '',
      '行尾以公式结尾 $b+2$',
      '',
      '$$',
      'x+y=1',
      '$$',
      '',
      '末段。',
      '',
    ].join('\n'));
    const original = fs.readFileSync(fixture, 'utf8');
    const session = await ctx.launch({args: [fixture]});
    try {
      const ready = await session.until(`(() => {
        const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
        const surface = w && w.document && w.document.querySelector(${SURFACE});
        return !!(surface && surface.querySelectorAll('.katex').length >= 2);
      })()`, {timeout: 120000, interval: 25});
      ctx.assert('公式都上屏（KaTeX 渲染出来）', ready, `ready=${ready}`);
      if (!ready) return;
      await edge.settle(session);
      ctx.witness('磁盘：素材原始字节', {file: path.basename(fixture), bytes: Buffer.byteLength(original, 'utf8'), fences: (original.match(/\$\$/g) || []).length});

      // ---------- 1) 行尾以公式结尾：点行尾不弹预渲染框 ----------
      const tail = await session.js(`(() => {
        const frame = document.getElementById('editor');
        const w = frame.contentWindow;
        const doc = w.document;
        const block = [...doc.querySelector(${SURFACE}).children].find(node => node.textContent.includes('行尾以公式结尾'));
        if (!block) return {ok: false};
        const preview = block.querySelector('.vditor-ir__preview');
        const rect = (preview || block).getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
        return {ok: true, x: Math.round(frameRect.x + rect.right + 2), y: Math.round(frameRect.y + rect.top + rect.height / 2),
          previewRight: Math.round(rect.right)};
      })()`);
      ctx.assert('能找到行尾公式段落并算出"行尾右侧"的点', tail.ok, JSON.stringify(tail));
      if (tail.ok) {
        await session.click(tail.x, tail.y);
        // 时间线取证：预渲染框的浮动是异步出现的，单点采样会漏（2.1.1 就是这么假通过的）
        const timeline = [];
        for (let index = 0; index < 10; index++) {
          timeline.push(await session.js(READ));
          await harness.sleep(60);
        }
        const worst = timeline.reduce((acc, item) => ({expanded: Math.max(acc.expanded, item.expanded), floating: Math.max(acc.floating, item.floating)}), {expanded: 0, floating: 0});
        ctx.witness('DOM：行尾点一下之后 600ms 内的展开/浮框最大值', worst);
        ctx.assert('光标停在行尾之后，公式全程不展开、不浮出预渲染框', worst.expanded === 0 && worst.floating === 0, JSON.stringify(worst));
        await session.type('！');
        await harness.sleep(300);
        const afterType = await session.js(READ);
        ctx.assert('行尾输入的字符落在公式之后（DOM 里紧跟公式）', /\$b\+2\$！/.test(afterType.value), JSON.stringify(afterType.value.split('\n')[2]));
        const saved = await edge.saveAndWait(session, fixture);
        ctx.witness('磁盘：行尾追加之后的这一行', {line: (saved.after.match(/行尾以公式结尾[^\n]*/) || [''])[0]});
        ctx.assert('磁盘上"公式紧跟新字符"，公式本身没被写坏', /\$b\+2\$！/.test(saved.after) && !/\\vert/.test(saved.after) && (saved.after.match(/\$b\+2\$/g) || []).length === 1,
          JSON.stringify((saved.after.match(/行尾以公式结尾[^\n]*/) || [''])[0]));
      }

      // ---------- 2) $$ 围栏：点前/后两个 $$ 能把光标插到源码首/尾 ----------
      await session.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(original)}); return true;})()`);
      const backOnDoc = await session.until(`(() => {
        const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
        const root = w && w.document && w.document.querySelector(${SURFACE});
        return !!(root && root.querySelector('code[data-type="math-block"]'));
      })()`, {timeout: 60000, interval: 30});
      if (!backOnDoc) {
        ctx.assert('回到含块公式的文档', false, `backOnDoc=${backOnDoc}`);
      } else {
        await edge.settle(session);
        const block = await session.js(pointOf(blockOwner('x+y=1')));
        ctx.assert('能找到块公式', block.ok, JSON.stringify(block));
        if (block.ok) {
          await session.click(block.x, block.y);
          await harness.sleep(500);
          const expanded = await session.js(READ);
          ctx.assert('点击块公式展开源码以便编辑', expanded.expanded >= 1 && expanded.inMathCode, JSON.stringify({expanded: expanded.expanded, caret: expanded.caretTag, offset: expanded.offset}));
          const markerPoint = which => session.js(`(() => {
            const frame = document.getElementById('editor');
            const w = frame.contentWindow;
            const doc = w.document;
            const owner = (${blockOwner('x+y=1')});
            const node = owner && owner.querySelector(':scope > span[data-type="math-block-${which}-marker"]');
            if (!node) return {ok: false, error: '没有围栏元素'};
            const rect = node.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return {ok: false, error: '围栏没有面积（点不到）', width: rect.width, height: rect.height};
            const frameRect = frame.getBoundingClientRect();
            return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2),
              width: Math.round(rect.width), height: Math.round(rect.height), text: node.textContent};
          })()`);
          const openMark = await markerPoint('open');
          const closeMark = await markerPoint('close');
          ctx.witness('DOM：展开态下前后 $$ 的几何', {open: openMark, close: closeMark});
          ctx.assert('展开态下前后两个 $$ 都是有面积、可点的真实元素', openMark.ok && closeMark.ok, JSON.stringify({open: openMark, close: closeMark}));
          if (openMark.ok && closeMark.ok) {
            await session.click(openMark.x, openMark.y);
            await harness.sleep(350);
            const openCaret = await session.js(READ);
            ctx.witness('DOM：点前 $$ 之后的光标', {tag: openCaret.caretTag, type: openCaret.caretType, offset: openCaret.offset, inMathCode: openCaret.inMathCode});
            ctx.assert('点前 $$：光标就停在围栏自己身上（所见即所得），不再把人塞进源码',
              openCaret.caretType === 'math-block-open-marker' && !openCaret.inMathCode,
              JSON.stringify({inMathCode: openCaret.inMathCode, offset: openCaret.offset, type: openCaret.caretType}));
            ctx.assert('光标站在围栏上时公式保持展开（围栏必须看得见）', openCaret.expanded >= 1, JSON.stringify({expanded: openCaret.expanded}));
            await session.type('Z');
            await harness.sleep(400);
            const typed = await session.js(READ);
            const savedOpen = await edge.saveAndWait(session, fixture);
            ctx.witness('磁盘：点前 $$ 打字之后的公式块', {line: (savedOpen.after.match(/^Zx\+y=1$/m) || ['(没有 Zx+y=1 这一行)'])[0], value: typed.value.split('\n').slice(3, 7)});
            ctx.assert('在前 $$ 处打字的字符落在源码开头（磁盘上出现 Zx+y=1，围栏 $$ 仍成对）',
              /(^|\n)\$\$\nZx\+y=1\n\$\$(\n|$)/.test(savedOpen.after.replace(/\r/g, '')) && (savedOpen.after.match(/\$\$/g) || []).length === 2,
              JSON.stringify(savedOpen.after.split('\n').slice(3, 8)));
            // 围栏上按退格：围栏是渲染生成的，一个字节都不许改，而且要弹一句说明
            await session.js(`(() => {
              const w = document.getElementById('editor').contentWindow;
              w.vditor.setValue(${JSON.stringify(original)});
              return true;
            })()`);
            await harness.sleep(700);
            const blockForFence = await session.js(pointOf(blockOwner('x+y=1')));
            await session.click(blockForFence.x, blockForFence.y);
            await harness.sleep(500);
            const closeForFence = await markerPoint('close');
            if (closeForFence.ok) {
              await session.click(closeForFence.x, closeForFence.y);
              await harness.sleep(350);
              const beforeFence = await session.js(READ);
              await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
              await harness.sleep(450);
              const afterFence = await session.js(READ);
              ctx.witness('DOM：在尾 $$ 上按退格', {caret: {type: beforeFence.caretType, offset: beforeFence.offset}, hint: afterFence.hint,
                before: beforeFence.value.split('\n').slice(3, 7), after: afterFence.value.split('\n').slice(3, 7)});
              // 【2026-09-17 口径变更】过去这里是"一个字节都不改 + 弹一句说明"；用户看过后要求照
              // Typora 的围栏手感来（"最好能直接把这些 fence 当普通字符处理……太卡手"）。
              // 新契约：块公式的**围栏文本不做成可删字符**——实测直接改围栏文本 getValue() 一字
              // 不变（改了像没改），真去 markdown 里把 `$$` 写成单个 `$` 又会被 Lute 重新配对、
              // 被我们的"未闭合围栏收尾"补回来，等于一次退格跟两条自动化规则打架。所以这一下
              // 改成删源码里靠自己这一端的一个字符（退格删尾巴、删除键删开头）。行内公式的 `$`
              // 是真字符，删的就是那一个 `$`——那条在场景 109 里钉。
              // 证据：scripts/acceptance/probe-fence-text.cjs 的 F3/F6/F9。
              ctx.assert('在尾 $$ 上按退格：源码里少一个字符（退格删尾巴），围栏仍成对、块公式还在',
                afterFence.value !== beforeFence.value &&
                  afterFence.value.replace(/\r/g, '').includes('$$\nx+y=\n$$') &&
                  (afterFence.value.match(/\$\$/g) || []).length === 2 &&
                  afterFence.blocks === beforeFence.blocks,
                JSON.stringify({before: beforeFence.value.split('\n').slice(3, 7), after: afterFence.value.split('\n').slice(3, 7),
                  fences: (afterFence.value.match(/\$\$/g) || []).length, blocks: [beforeFence.blocks, afterFence.blocks]}));
              ctx.assert('这一下不是"什么都没发生"：围栏上按退格同样有可见结果（不再弹说明）',
                afterFence.value !== beforeFence.value, JSON.stringify({hint: afterFence.hint, changed: afterFence.value !== beforeFence.value}));
            } else {
              ctx.assert('尾 $$ 可点（用于退格用例）', false, JSON.stringify(closeForFence));
            }
            // 尾 $$：光标必须落在围栏上，而不是像 2.1.1 那样跑到下一段
            await session.js(`(() => {
              const w = document.getElementById('editor').contentWindow;
              w.vditor.setValue(${JSON.stringify(original)});
              return true;
            })()`);
            await harness.sleep(700);
            const blockAgain = await session.js(pointOf(blockOwner('x+y=1')));
            await session.click(blockAgain.x, blockAgain.y);
            await harness.sleep(500);
            const closeAgain = await markerPoint('close');
            if (closeAgain.ok) {
              await session.click(closeAgain.x, closeAgain.y);
              await harness.sleep(350);
              const closeCaret = await session.js(READ);
              ctx.witness('DOM：点尾 $$ 之后的光标', {tag: closeCaret.caretTag, type: closeCaret.caretType, offset: closeCaret.offset, inMathCode: closeCaret.inMathCode});
              ctx.assert('点尾 $$：光标停在尾部围栏上（不是掉进下一段、也不是被塞进源码）',
                closeCaret.caretType === 'math-block-close-marker' && !closeCaret.inMathCode,
                JSON.stringify({inMathCode: closeCaret.inMathCode, offset: closeCaret.offset, type: closeCaret.caretType}));
            } else {
              ctx.assert('尾 $$ 可点', false, JSON.stringify(closeAgain));
            }
          }
        }
      }

      // ---------- 3) 贴边连按两次退格：公式一个字节都不能少 ----------
      await session.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(original)}); return true;})()`);
      await harness.sleep(800);
      const spots = [['渲染结果正中', false], ['公式底部留白', true], ['末段行内', true]];
      for (const [name, strict] of spots) {
        const spot = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const doc = w.document;
          const owner = (${blockOwner('x+y=1')});
          if (!owner) return {ok: false, error: '没有块公式'};
          owner.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
          const ownerRect = owner.getBoundingClientRect();
          const rendered = [...owner.querySelectorAll('pre')].find(node => node.getBoundingClientRect().height > 4);
          const frameRect = frame.getBoundingClientRect();
          let y;
          if (${JSON.stringify(name)} === '渲染结果正中') { const r = rendered.getBoundingClientRect(); y = r.top + r.height / 2; }
          else if (${JSON.stringify(name)} === '公式底部留白') { y = ownerRect.bottom - 4; }
          else {
            const paragraph = [...doc.querySelector(${SURFACE}).children].find(node => node.textContent.trim().startsWith('末段'));
            const r = paragraph.getBoundingClientRect(); y = r.top + r.height / 2;
          }
          return {ok: true, x: Math.round(frameRect.x + ownerRect.x + ownerRect.width / 2), y: Math.round(frameRect.y + y)};
        })()`);
        if (!spot.ok) { ctx.assert('找到【' + name + '】的点', false, JSON.stringify(spot)); continue; }
        const before = await session.js(READ);
        await session.click(spot.x, spot.y);
        await harness.sleep(350);
        const placed = await session.js(READ);
        const after1 = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.getValue();})()`);
        await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
        await harness.sleep(450);
        const afterFirst = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.getValue();})()`);
        await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
        await harness.sleep(450);
        const afterSecond = await session.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.getValue();})()`);
        const classify = (from, to) => {
          const a = String(from).split('\n'), b = String(to).split('\n');
          if (a.length !== b.length) return 'structure';
          const changed = a.map((line, index) => (line === b[index] ? null : {line, next: b[index]})).filter(Boolean);
          if (!changed.length) return 'none';
          // 只允许"变短"（删字符）：把新行当子序列在旧行里找一遍，能匹配上就说明没有插入/改写。
          const subsequence = (short, long) => {
            let index = 0;
            for (const char of long) if (index < short.length && short[index] === char) index++;
            return index === short.length;
          };
          const deletions = changed.every(item => item.next.length < item.line.length && subsequence(item.next, item.line));
          return deletions ? 'shortened' : 'other';
        };
        const shape = classify(after1, afterSecond);
        const fences = text => (String(text).match(/^\$\$/gm) || []).length;
        const shortened = (from, to) => String(from).split('\n').reduce((sum, line, index) => {
          const next = String(to).split('\n')[index];
          return sum + Math.max(0, line.length - (next === undefined ? line.length : next.length));
        }, 0);
        ctx.witness('DOM/文档：' + name + ' 处连按两次退格', {placed: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset}, shape,
          first: afterFirst === after1, fencesBefore: fences(after1), fencesAfter: fences(afterSecond), deleted: shortened(after1, afterSecond),
          lines: [String(after1).split('\n').length, String(afterSecond).split('\n').length]});
        // 【2026-09-17 口径变更】这两条判据原来钉的是"文档一个字节都不改"（旧口径）。新口径下：
        // 第一次退格把这条块公式**展开成源码形态并整条选中**（用户原话："直接帮用户选中, 展开
        // 编辑公式代码形态"），第二次退格按常规选区语义把选中的源码删掉——块公式本体与两条
        // `$$` 围栏必须原样留着（这才是"公式没被删掉"）。块级边界那一下仍然不放行给浏览器：
        // 实测放行时一次退格会把**后面整段**删掉（probe-fence-text.cjs F5）。
        const fencesAfter = fences(afterSecond);
        ctx.assert('【' + name + '】两次退格后 $$ 围栏成对、块公式仍是块公式（结构没被拆散）',
          fencesAfter % 2 === 0 && fencesAfter >= 2 && placed.blocks >= 1,
          JSON.stringify({fencesBefore: fences(after1), fencesAfter, blocks: placed.blocks, shape}));
        // 三次退格各自落在不同位置，新口径下动作也分三类：渲染结果正中/围栏上 → 删源码一个字符；
        // 块级边界（用户说的"空行"）→ 第一次展开+整条选中、第二次按常规选区语义把源码删空；
        // 段尾文字里 → 就是普通的正文退格。共同不变量只有一条：**块公式与围栏不能被拆散**，
        // 且删掉的要么是源码里的至多两个字符、要么是整条源码被清空（不留第三种残渣）。
        // "整条源码被清空"= 第一对围栏之间的源码空了（文末那段 `末段。` 不参与判断）
        const sourceOf = text => {
          const lines = String(text).replace(/\r/g, '').split('\n');
          const open = lines.indexOf('$$'), close = lines.indexOf('$$', open + 1);
          return open >= 0 && close > open ? lines.slice(open + 1, close).join('\n').trim() : null;
        };
        const emptied = sourceOf(afterSecond) === '' && sourceOf(after1) !== '';
        ctx.assert('【' + name + '】两次退格：公式与围栏完好，删掉的最多两个字符或整条源码被清空',
          fencesAfter % 2 === 0 && fencesAfter >= 2 && placed.blocks >= 1 &&
            (shortened(after1, afterSecond) <= 2 || emptied),
          JSON.stringify({first: String(afterFirst).split('\n').slice(3, 9), second: String(afterSecond).split('\n').slice(3, 9),
            deleted: shortened(after1, afterSecond), shape, emptied, firstUnchanged: afterFirst === after1}));
        if (strict) {
          ctx.assert('【' + name + '】这条位置（用户说的"空行"）两次退格后公式源码要么一字不差、要么整体被删空（不留残渣）',
            String(afterSecond).includes('x+y=1') || !/[^\s$]/.test(String(afterSecond).split('\n').slice(3, 9).join('')),
            JSON.stringify({value: String(afterSecond).split('\n').slice(3, 9), diff: [String(after1).split('\n')[4], String(afterSecond).split('\n')[4]]}));
        }
        await session.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(original)}); return true;})()`);
        await harness.sleep(700);
      }

      // ---------- 4) 素材：用户点名的"（2) 前一行空行"那条像素带 ----------
      // 2.1.0 起"有文档的窗口再开第二个文件"= 新开一个窗口，所以素材用**第二次启动**来测，
      // 而不是往同一个窗口里塞（那样只会得到第二个窗口，第一个页面的 iframe 永远等不到素材）。
      await ctx.release(session);
      const copy = path.join(path.dirname(fixture), 'material-' + Date.now() + '.md');
      fs.copyFileSync(MATERIAL, copy);
      try {
        const materialSession = await ctx.launch({args: [copy]});
        const onMaterial = await materialSession.until(`(() => {
          const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE});
          return !!(root && root.textContent.includes('受限量词的否定') && root.querySelectorAll('.katex').length >= 6);
        })()`, {timeout: 120000, interval: 30});
        ctx.assert('素材副本在产物里打开并渲染出公式', onMaterial, `onMaterial=${onMaterial}`);
        if (onMaterial) {
          await edge.settle(materialSession);
          const material = await materialSession.js(`(() => {const w = document.getElementById('editor').contentWindow; return w.vditor.getValue();})()`);
          const fences = text => (String(text).match(/^\s*>\s*\$\$\s*$/gm) || []).length;
          ctx.witness('磁盘素材（副本）的原始结构', {fences: fences(material), hasFirst: material.includes('\\exists x\\in A'), hasSecond: material.includes('\\forall x\\in A')});
          const band = await materialSession.js(`(() => {
            const frame = document.getElementById('editor');
            const w = frame.contentWindow;
            const doc = w.document;
            const quote = [...doc.querySelectorAll('blockquote')].find(node => node.textContent.includes('受限量词的否定'));
            if (!quote) return {ok: false, error: '没有引用块'};
            const kids = [...quote.children];
            const owner = kids.find(node => node.matches('div[data-type="math-block"]') && node.textContent.includes('\\\\exists x\\\\in A')) || kids[1];
            owner.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
            const rect = owner.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
            return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), yBottom: Math.round(frameRect.y + rect.bottom - 4), yMid: Math.round(frameRect.y + rect.top + rect.height / 2)};
          })()`);
          ctx.assert('能找到 (1) 的公式块并算出"它下方那条看起来是空行"的点', band.ok, JSON.stringify(band));
          if (band.ok) {
            for (const [label, y] of [['公式底部留白（用户说的空行）', band.yBottom], ['公式渲染结果正中', band.yMid]]) {
              await materialSession.click(band.x, y);
              await harness.sleep(400);
              const placed = await materialSession.js(READ);
              await materialSession.key({key: 'Backspace', code: 'Backspace', vk: 8});
              await harness.sleep(450);
              await materialSession.key({key: 'Backspace', code: 'Backspace', vk: 8});
              await harness.sleep(450);
              const now = await materialSession.js(READ);
              ctx.witness('DOM：素材【' + label + '】连按两次退格', {placed: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset},
                fencesBefore: fences(material), fencesAfter: fences(now.value), blocks: now.blocks,
                firstPreserved: now.value.includes('\\exists x\\in A'), secondPreserved: now.value.includes('\\forall x\\in A')});
              ctx.assert('素材【' + label + '】：连按两次退格后两条公式源码都还在，$$ 围栏成对不变',
                now.value.includes('\\exists x\\in A') && now.value.includes('\\forall x\\in A') && fences(now.value) === fences(material),
                JSON.stringify({fences: [fences(material), fences(now.value)], tail: now.value.split('\n').slice(120, 136)}));
              await materialSession.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(material)}); return true;})()`);
              await harness.sleep(800);
            }
          }
          // ---------- 4b) 用户第 4 份报告的原手势：光标插在 (2) 之前按退格 ----------
          // 素材里 `> $$ … $$` 之后是一行**不带 > 的空行**，再跟 `> (2)`，所以 (2) 与上面那条
          // 公式分处两个 blockquote。2.1.2 实测：这一下会把整段引用块的 > 前缀削掉（用户读作
          // "直接删除 $$…$$ 内部的公式"），或者把光标落进隐藏的公式源码里、退格吃掉一个字符。
          // 判据：文档**逐字节不变**，且光标不许停在源码里。
          // 只取"紧跟在块公式后面"的那几处 (n)：素材里 `> (1)`（上一行是 `> 证:`）之类的
          // 标签后面没有公式，段首退格只是普通的并段，不属于这一条要护的范围。
          const labels = await materialSession.js(`(() => {
            const doc = document.getElementById('editor').contentWindow.document;
            const isMath = node => !!(node && node.nodeType === 1 && node.matches && node.matches('[data-type="math-block"]'));
            const list = [...doc.querySelectorAll('p')].filter(node => /^\\(\\d\\)$/.test((node.textContent || '').trim()));
            return list.map((node, index) => {
              let walker = node, after = false;
              while (walker && !after) {
                const near = walker.previousElementSibling;
                if (near) after = isMath(near) || isMath(near.lastElementChild);
                walker = walker.parentElement;
              }
              return {index, text: node.textContent, afterFormula: after};
            });
          })()`);
          ctx.witness('DOM：素材里单独成行的 (n) 标签', labels);
          const targets = labels.filter(item => item.afterFormula).map(item => item.index);
          ctx.assert('素材里能定位到"紧跟块公式的 (n) 标签"若干处', targets.length >= 2, JSON.stringify({labels, targets}));
          for (const index of targets) {
            const spot = await materialSession.js(`(() => {
              const frame = document.getElementById('editor');
              const doc = frame.contentWindow.document;
              const node = [...doc.querySelectorAll('p')].filter(item => /^\\(\\d\\)$/.test((item.textContent || '').trim()))[${index}];
              if (!node) return {ok: false, error: '没有第 ' + ${index} + ' 个标签'};
              // 上面那条公式块（跨 blockquote 也往上找）
              let walker = node, owner = null;
              while (walker && !owner) {
                let near = walker.previousElementSibling;
                while (near) {
                  const found = near.matches && near.matches('[data-type="math-block"]') ? near : near.querySelector && near.querySelector('[data-type="math-block"]');
                  if (found) { owner = found; break; }
                  near = near.previousElementSibling;
                }
                walker = walker.parentElement;
              }
              if (!owner) return {ok: false, error: '这个标签上面没有公式块'};
              node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
              const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
              const ownerRect = owner.getBoundingClientRect();
              return {ok: true, x: Math.round(frameRect.x + rect.x + 2), y: Math.round(frameRect.y + rect.y + rect.height / 2),
                band: Math.round(frameRect.y + ownerRect.bottom - 4), text: node.textContent};
            })()`);
            if (!spot.ok) { ctx.assert('能找到素材里的第 ' + (index + 1) + ' 个 (n) 标签', false, JSON.stringify(spot)); continue; }
            for (const [label, x, y] of [['标签左侧 2px', spot.x, spot.y], ['公式块底部留白', spot.x + 3, spot.band]]) {
              const before = await materialSession.js(READ);
              await materialSession.click(x, y);
              await harness.sleep(400);
              const placed = await materialSession.js(READ);
              await materialSession.key({key: 'Backspace', code: 'Backspace', vk: 8});
              await harness.sleep(500);
              const now = await materialSession.js(READ);
              ctx.witness('DOM：素材第 ' + (index + 1) + ' 处 (n)【' + label + '】按一次退格',
                {placed: {tag: placed.caretTag, type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode},
                  hint: now.hint, clickChanged: placed.value !== before.value, keyChanged: now.value !== placed.value,
                  fences: [fences(before.value), fences(placed.value), fences(now.value)]});
              ctx.assert('素材第 ' + (index + 1) + ' 处 (n)【' + label + '】：点一下光标不许落进隐藏的公式源码',
                !placed.inMathCode, JSON.stringify({type: placed.caretType, offset: placed.offset, inCode: placed.inMathCode}));
              // 判据分两半：点击本身不该改文档；这一下退格更不该改（2.1.2 实测会把整段 > 前缀削掉）。
              ctx.assert('素材第 ' + (index + 1) + ' 处 (n)【' + label + '】：点一下不改文档，随后一次退格后文档仍逐字节不变（公式与 > 前缀都在）',
                placed.value === before.value && now.value === placed.value && fences(now.value) === fences(before.value),
                JSON.stringify({clickChanged: placed.value !== before.value, keyChanged: now.value !== placed.value,
                  lines: [before.value.split('\n').length, now.value.split('\n').length],
                  diff: firstDiff(before.value, now.value)}));
              await materialSession.js(`(() => {const w = document.getElementById('editor').contentWindow; w.vditor.setValue(${JSON.stringify(material)}); return true;})()`);
              await harness.sleep(800);
            }
          }
        }
        const toasts = await materialSession.js(edge.TOASTS);
        const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
        ctx.assert('全程没有错误提示（乱码 / 失败 / app.asar 之类）', problems.length === 0, JSON.stringify({problems, toasts}));
        ctx.metric('math.blocks', await materialSession.js(`(() => document.getElementById('editor').contentWindow.document.querySelectorAll('code[data-type="math-block"]').length)()`), {unit: '个', direction: 'equal', tolerance: 0.5});
        await materialSession.shot('74-math-fence-and-boundary');
        await ctx.release(materialSession);
      } finally {
        try { fs.rmSync(copy, {force: true}); } catch { /* 已删 */ }
      }
    } finally {
      await ctx.release(session);
      try { fs.writeFileSync(fixture, original); } catch { /* 忽略 */ }
    }
  },
};

/** 第一处不同的行（只用于证人输出，不参与断言）。 */
function firstDiff(before, after) {
  const a = String(before).split('\n'), b = String(after).split('\n');
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return {atLine: index + 1, before: a[index] === undefined ? null : a[index], after: b[index] === undefined ? null : b[index]};
}
