/** 右键 / 光标 / 图片 / 表格的边缘用例（用户 2026-09-13 报的"右键图片光标跳到文章开头"）。
 *
 *  用户原话：「文件打开之后马上去找到图片，右键会导致光标直接跳到文章开头，这是什么 bug？
 *  然后这个文件在打开一段时间之后，再去找到这个图片，再右键就不跳了！你的测试只做了 20%，
 *  你再给我多做 5 倍的这种边缘 case 的测试！！！！！！！」
 *  用户给的扩展方法（本文件的组织方式就是照它来的）：
 *    ① 先找**同源**的——同一个根因、同一段代码路径；
 *    ② 再找**类比**的——形状相同但代码不同的入口；
 *    ③ 再找**之前没想到**的——时序、数据形态、组合手势。
 *
 *  根因（scripts/acceptance/probe-image-rightclick*.cjs / probe-rightclick-targets.cjs 实测钉死）：
 *  编辑区**当前没有选区**时，右键落在"放不下光标的东西"上（图片本体、包图片的
 *  span.vditor-ir__node、行内/块公式渲染出的 KaTeX、contenteditable=false 的预览岛），
 *  Blink 的原生 mousedown 默认行为会走 SelectionController::SetSelectionFromNone()：
 *  把选区设成"整篇文档的内容"、光标落到第 0 个位置。素材上实测光标被扔到离视口 7059px 的
 *  文档开头（`#text / 块 0 / offset 0`），此后第一次输入会插到文章最前面。
 *  左键点图片产品一直有 preventDefault（还自己造选区），右键这条路径漏了。
 *  修法在 media-tools.js 的捕获阶段 mousedown 里：右键 + 命中点不可编辑/是图片或公式 → preventDefault。
 *
 *  判据（"被扔回文章开头"的机器判据，比"块下标"稳）：
 *    P1 右键后新产生的光标是 `块 0 / offset 0`（或根层 offset 0），而目标本身不在第 0 块；
 *    P2 若右键后真有绘制矩形，它的 y 必须在视口内（素材上病理态的 caretY 是 -7059）。
 *  目标本身就在第 0 块时跳过 P1——这正是上一轮把读数当缺陷的那种错。
 *
 *  素材规矩：受保护素材先复制到运行目录、结束删副本，原素材一个字节都不动（断言 sha256）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';
const SURFACE = JSON.stringify(edge.SURFACE);

const VIEW = `(() => {
  const frame = document.getElementById('editor');
  if (!frame || !frame.contentWindow) return {frame: false};
  const w = frame.contentWindow, doc = w.document;
  const root = doc.querySelector(${SURFACE});
  if (!root) return {root: false};
  const selection = w.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const start = range ? range.startContainer : null;
  const element = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
  let block = element;
  while (block && block.parentElement && block.parentElement !== root) block = block.parentElement;
  const blockIndex = block && block.parentElement === root ? [...root.children].indexOf(block) : -1;
  const rootLevel = start === root;
  // 滚动容器不能拿 querySelector('pre.vditor-reset') 随便挑：IR / WYSIWYG / 预览三处各有
  // 一份，文档序里排前面的那份可能是隐藏的（读出来永远是 0——第一版就这么读到过假绿）。
  // 从真实内容根往上找"真的滚动过"的那一层。
  let scroller = root;
  for (let node = root; node; node = node.parentElement) if (node.scrollTop > 0) { scroller = node; break; }
  const rects = range ? [...range.getClientRects()] : [];
  return {
    root: true,
    ranges: selection ? selection.rangeCount : 0,
    collapsed: range ? range.collapsed : null,
    selected: range ? range.toString().slice(0, 60) : null,
    startKind: start ? (start.nodeType === 3 ? '#text' : start.tagName) : null,
    offset: range ? range.startOffset : null,
    blockIndex, rootLevel,
    blockHead: block ? String(block.textContent || '').replace(/\\s+/g, ' ').slice(0, 26) : null,
    firstBlockHead: String(root.children[0].textContent || '').replace(/\\s+/g, ' ').slice(0, 26),
    caretY: rects.length ? Math.round(rects[0].y) : null,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    menu: !!doc.getElementById('typora-editor-context-menu'),
    viewport: w.innerHeight,
    mode: w.vditor ? w.vditor.getCurrentMode() : null,
    pageErrors: Array.isArray(w.__acc && w.__acc.errors) ? w.__acc.errors.slice(0, 4) : null,
  };
})()`;

/** 目标元素 → 顶层页坐标。命中点要求落在视口的"安全带"里（避开顶部工具栏），
 *  否则宁可回报"不可用"——点歪了比点不到更糟（会把读数变成假证据）。 */
const POINT = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow, doc = w.document;
  const node = (${finder});
  if (!node) return {ok: false, reason: 'not-found'};
  if (node.scrollIntoView) node.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
  const safeTop = 90, safeBottom = w.innerHeight - 60;
  const hitX = Math.round(rect.x + rect.width / 2);
  const hitY = Math.round(Math.min(Math.max(rect.y + rect.height / 2, safeTop), safeBottom));
  const visible = rect.height > 0 && rect.bottom > safeTop && rect.top < safeBottom && hitX > 0 && hitX < w.innerWidth;
  const hit = doc.elementFromPoint(hitX, hitY);
  const chain = [];
  for (let n = hit; n && chain.length < 4; n = n.parentElement) chain.push(n.tagName + (n.className ? '.' + String(n.className).split(' ')[0] : ''));
  return {ok: true, visible, x: Math.round(frameRect.x + hitX), y: Math.round(frameRect.y + hitY),
    width: Math.round(rect.width), height: Math.round(rect.height), rectTop: Math.round(rect.y),
    hitChain: chain, hitIsTarget: hit === node};
})()`;

const CLEAR_SELECTION = `(() => { document.getElementById('editor').contentWindow.getSelection().removeAllRanges(); return true; })()`;
const CLOSE_MENU = `(() => {
  const w = document.getElementById('editor').contentWindow;
  const menu = w.document.getElementById('typora-editor-context-menu');
  if (menu && menu.__typoraClose) { menu.__typoraClose(); return true; }
  return false;
})()`;
const MENU = `(() => {
  const w = document.getElementById('editor').contentWindow;
  const menu = w.document.getElementById('typora-editor-context-menu');
  if (!menu) return null;
  return [...menu.querySelectorAll('button')].map(button => ({action: button.dataset.action, label: button.textContent}));
})()`;
const VALUE = `document.getElementById('editor').contentWindow.vditor.getValue()`;
const PLACE_CARET = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow, doc = w.document;
  const node = (${finder});
  if (!node) return {ok: false, reason: 'not-found'};
  const walker = doc.createTreeWalker(node, w.NodeFilter.SHOW_TEXT);
  let text = null;
  while (walker.nextNode()) if (walker.currentNode.data.trim().length > 3) { text = walker.currentNode; break; }
  if (!text) return {ok: false, reason: 'no-text'};
  const range = doc.createRange();
  range.setStart(text, Math.min(3, text.data.length)); range.collapse(true);
  const selection = w.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return {ok: true, text: text.data.slice(0, 20), block: String(node.textContent || '').slice(0, 20)};
})()`;
const SELECT_TEXT = finder => `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow, doc = w.document;
  const node = (${finder});
  if (!node) return {ok: false, reason: 'not-found'};
  const walker = doc.createTreeWalker(node, w.NodeFilter.SHOW_TEXT);
  let text = null;
  while (walker.nextNode()) if (walker.currentNode.data.trim().length > 12) { text = walker.currentNode; break; }
  if (!text) return {ok: false, reason: 'no-text'};
  const range = doc.createRange();
  range.setStart(text, 2); range.setEnd(text, Math.min(12, text.data.length));
  const selection = w.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return {ok: true, text: selection.toString()};
})()`;
const ROOT = `document.getElementById('editor').contentWindow.document.querySelector(${SURFACE})`;
const BLOCK_OF = finder => `(() => {
  const w = document.getElementById('editor').contentWindow, doc = w.document;
  const root = doc.querySelector(${SURFACE});
  const node = (${finder});
  if (!node) return -1;
  let block = node;
  while (block && block.parentElement && block.parentElement !== root) block = block.parentElement;
  return block && block.parentElement === root ? [...root.children].indexOf(block) : -1;
})()`;

const FIXTURE = [
  '# 右键与光标',
  '',
  '开头这一段是文档的第一块，用来当"光标被扔回文章开头"的参照物。',
  '',
  '## 图片',
  '',
  '![独立图片](rc-a.png)',
  '',
  '上面那张图独占一段。',
  '',
  '<img src="rc-b.png" alt="HTML 图片" />',
  '',
  '这一行是行内图片：文字里夹一张 ![行内小图](rc-c.png) 后面接着写。',
  '',
  '## 公式与代码',
  '',
  '$$',
  'a+b=c',
  '$$',
  '',
  '行内公式 $x_1+y_2$ 后面接文字，这里还有行内代码 `const a = 1` 与表情 :smile: 。',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '## 表格',
  '',
  '| 甲 | 乙 |',
  '| --- | --- |',
  '| 一 | 二 |',
  '| ![格内图片](rc-c.png) | 四 |',
  '',
  '## 列表与引用',
  '',
  '- 列表项里带图 ![列表图](rc-a.png)',
  '- 列表第二项',
  '',
  '> 引用块里带图 ![引用图](rc-b.png)',
  '',
  '## 其它',
  '',
  '---',
  '',
  '最后一段。',
  '',
].join('\n');

const FIRST_BLOCK_IMAGE = ['![第一块就是图片](rc-a.png)', '', '图片下面是一段文字。', ''].join('\n');

module.exports = {
  id: '76-rightclick-and-caret-edges',
  title: '右键/光标边缘：同源（岛×选区状态×模式）+ 类比（别的接管入口）+ 新想到（时序/形态/组合）',
  async run(ctx) {
    const dir = path.join(ctx.outDir, '76-rightclick');
    fs.mkdirSync(dir, {recursive: true});
    const fixture = path.join(dir, 'rightclick.md');
    fs.writeFileSync(fixture, FIXTURE);
    fs.writeFileSync(path.join(dir, 'rc-a.png'), fixtures.png(200, 120, [200, 90, 60]));
    fs.writeFileSync(path.join(dir, 'rc-b.png'), fixtures.png(90, 60, [60, 160, 200]));
    fs.writeFileSync(path.join(dir, 'rc-c.png'), fixtures.png(70, 50, [120, 200, 90]));
    ctx.witness('磁盘：自造素材（右键目标全在里面）', {file: path.basename(fixture), bytes: fs.statSync(fixture).size});

    const shot = async (session, name) => {
      try { await session.shot(name); ctx.witness('截图', {name: name + '.png'}); }
      catch (error) { ctx.witness('截图失败', {name, error: String(error && error.message)}); }
    };
    /** 一次真右键（先移动再按下/抬起）。 */
    const rightClick = async (session, finder, {prepare} = {}) => {
      await session.js(CLOSE_MENU);
      if (prepare) await session.js(prepare);
      const point = await session.js(POINT(finder));
      const probe = await session.js(VIEW);
      // 点不着时也要把 before/after 填上（都等于"没点之前"）：整条场景里到处在读
      // `result.after.xxx`，缺字段会让一处点歪把整条场景崩掉（第一版就是这么崩的）。
      // "点没点着"由各处的 `findable` / `result.ok` 断言单独负责。
      if (!point.ok || point.visible === false) return {ok: false, point, before: probe, after: probe};
      const before = await session.js(VIEW);
      await session.move(point.x, point.y);
      await harness.sleep(80);
      await session.click(point.x, point.y, {button: 'right'});
      await harness.sleep(700);
      const after = await session.js(VIEW);
      return {ok: true, point, before, after};
    };
    /** "被扔回文章开头"的机器判据（见文件头 P1/P2）。 */
    const thrownToStart = (result, blockOfTarget) => {
      // 没点着时 rightClick 返回 {ok:false}：这时"没被扔回开头"是**无意义**的读数，
      // 上层另有"找得到、点得着"的断言负责报错，这里不能因为读不到就崩掉整条场景。
      if (!result || !result.after) return {hit: false, atStart: false, geometry: false, noClick: true};
      const after = result.after;
      const atStart = (after.blockIndex === 0 || after.blockIndex === -1 || after.rootLevel) && after.offset === 0 && after.ranges > 0;
      const geometry = after.caretY !== null && after.caretY < -40;
      return {hit: blockOfTarget !== 0 && (atStart || geometry), atStart, geometry};
    };

    // ============================================================
    // 主夹具会话
    // ============================================================
    const session = await ctx.launch({args: [fixture]});
    try {
      const ready = await session.until(`(() => {
        const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
        const root = w && w.document && w.document.querySelector(${SURFACE});
        return !!(root && root.querySelector('table') && root.querySelector('.katex') && root.querySelectorAll('img').length >= 4);
      })()`, {timeout: 120000, interval: 30});
      ctx.assert('素材在产物里打开（图片 ≥4、公式与表格都渲染出来）', ready, `ready=${ready}`);
      await session.js(edge.WATCH_TOASTS);
      const opened = await session.js(VIEW);
      ctx.witness('DOM：刚打开时的状态', {firstBlock: opened.firstBlockHead, ranges: opened.ranges, mode: opened.mode,
        warmup: await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
          return w.__typoraWarmup ? {queued: w.__typoraWarmup.queued, byTask: Object.keys(w.__typoraWarmup.byTask || {})} : null; })()`)});
      ctx.assert('打开时文档里没有选区（正是用户右键那一刻的状态）', opened.ranges === 0, JSON.stringify({ranges: opened.ranges}));

      // ---------- 【新想到-时序】打开后立刻右键：预热队列还在跑的时候就动手 ----------
      {
        const finder = `${ROOT}.querySelector('img[alt="独立图片"]')`;
        const block = await session.js(BLOCK_OF(finder));
        const result = await rightClick(session, finder, {prepare: CLEAR_SELECTION});
        const menu = await session.js(MENU);
        await shot(session, 'S1-打开后立刻右键图片');
        ctx.witness('DOM：打开后立刻右键图片（预热未跑完）', {
          hit: result.ok ? result.point.hitChain : result.point, blockOfTarget: block,
          after: {block: result.after.blockIndex, offset: result.after.offset, caretY: result.after.caretY, head: result.after.blockHead},
          menu: (menu || []).map(item => item.action),
          warmupQueued: await session.js(`(() => { const w = document.getElementById('editor').contentWindow; return w.__typoraWarmup ? w.__typoraWarmup.queued : null; })()`),
        });
        ctx.assert('【新想到-时序】打开后*立刻*（预热队列未跑完）右键图片：光标没有被扔回文章开头',
          result.ok && !thrownToStart(result, block).hit, JSON.stringify({block, after: result.after}));
        ctx.assert('【新想到-时序】打开后立刻右键图片：菜单带图片动作',
          Array.isArray(menu) && menu.some(item => item.action === 'image-settings'), JSON.stringify({menu}));
      }

      await edge.settle(session);

      // ============================================================
      // ①【同源】同一段代码路径：右键 × 命中的东西 × 当前选区状态
      // ============================================================
      const targets = [
        {name: '独立图片', finder: `${ROOT}.querySelector('img[alt="独立图片"]')`, kind: 'image'},
        {name: 'HTML 图片（素材里就是这个形状）', finder: `${ROOT}.querySelector('img[alt="HTML 图片"]')`, kind: 'image'},
        {name: '行内图片', finder: `${ROOT}.querySelector('img[alt="行内小图"]')`, kind: 'image'},
        // 注：这里刻意不放"文件不存在的坏图"。加载失败会在产物里留下一条 404 的 console
        // 错误，而验收闸门要求"会话里不许出现新增 console 错误"——用坏图测这一条会把
        // 闸门本身弄脏（假红）。图片"还没加载完"的形态改由素材会话里那张外链图覆盖。
        {name: '表格里的图片', finder: `${ROOT}.querySelector('td img')`, kind: 'image'},
        {name: '列表项里的图片', finder: `${ROOT}.querySelector('li img')`, kind: 'image'},
        {name: '引用块里的图片', finder: `${ROOT}.querySelector('blockquote img')`, kind: 'image'},
        {name: '表情（emoji 图片）', finder: `${ROOT}.querySelector('img.emoji')`, kind: 'image', optional: true},
        {name: '图片的外壳节点', finder: `${ROOT}.querySelector('img[alt="独立图片"]').closest('.vditor-ir__node')`, kind: 'image'},
        {name: '块公式节点', finder: `${ROOT}.querySelector('[data-type="math-block"]')`, kind: 'formula'},
        {name: '块公式的渲染', finder: `${ROOT}.querySelector('[data-type="math-block"] .katex')`, kind: 'formula'},
        {name: '块公式的 $$ 源码', finder: `${ROOT}.querySelector('[data-type="math-block"] code[data-type="math-block"]')`, kind: 'formula'},
        {name: '行内公式', finder: `${ROOT}.querySelector('p .katex')`, kind: 'formula'},
        // 注意 `code:not([data-type])`：行内公式的源码也是 <code>（`data-type="math-inline"`，
        // 折叠态下 0×0，鼠标根本点不到），用裸 `code` 会挑中它。
        {name: '行内代码', finder: `[...${ROOT}.querySelectorAll('p')].find(node => node.textContent.includes('行内代码'))?.querySelector('code:not([data-type])')`, kind: 'editable'},
        {name: '代码块正文', finder: `${ROOT}.querySelector('[data-type="code-block"] code')`, kind: 'editable'},
        {name: '代码块的渲染岛', finder: `${ROOT}.querySelector('[data-type="code-block"] pre.vditor-ir__preview')`, kind: 'island'},
        {name: '表格单元格', finder: `${ROOT}.querySelector('td,th')`, kind: 'editable'},
        {name: '标题文字', finder: `${ROOT}.querySelector('h2')`, kind: 'editable'},
        {name: '普通段落', finder: `${ROOT}.querySelectorAll('p')[0]`, kind: 'editable'},
        {name: '引用块', finder: `${ROOT}.querySelector('blockquote')`, kind: 'editable'},
        {name: '分隔线', finder: `${ROOT}.querySelector('hr')`, kind: 'island'},
      ];
      const imageFinder = targets[0].finder;
      for (const target of targets) {
        const block = await session.js(BLOCK_OF(target.finder));
        if (block < 0 && target.optional) { ctx.witness(`【同源】${target.name}：这个素材里没有`, {finder: target.finder}); continue; }
        const result = await rightClick(session, target.finder, {prepare: CLEAR_SELECTION});
        if (!result.ok) { ctx.assert(`【同源】${target.name}：找得到、点得着`, false, JSON.stringify(result.point)); continue; }
        const menu = await session.js(MENU);
        const actions = (menu || []).map(item => item.action);
        const expected = target.kind === 'image' ? 'image-settings' : target.kind === 'editable' && /表格/.test(target.name) ? 'table-row-below' : null;
        await shot(session, 'S1-' + target.name);
        ctx.witness(`【同源】右键 ${target.name}`, {hit: result.point.hitChain, blockOfTarget: block,
          before: {block: result.before.blockIndex, offset: result.before.offset},
          after: {block: result.after.blockIndex, offset: result.after.offset, caretY: result.after.caretY, head: result.after.blockHead},
          menu: actions, scrollTop: [result.before.scrollTop, result.after.scrollTop]});
        ctx.assert(`【同源】右键 ${target.name}：我们自己的菜单照常出现`, actions.length > 0, JSON.stringify({actions}));
        if (expected) ctx.assert(`【同源】右键 ${target.name}：菜单里有 ${expected}`, actions.includes(expected), JSON.stringify({actions, expected}));
        const thrown = thrownToStart(result, block);
        ctx.assert(`【同源】右键 ${target.name}：光标没有被扔回文章开头`, !thrown.hit,
          JSON.stringify({blockOfTarget: block, thrown, after: {block: result.after.blockIndex, offset: result.after.offset, caretY: result.after.caretY}}));
        if (target.kind === 'editable' && block >= 0) {
          ctx.assert(`【同源】右键 ${target.name}：可编辑目标仍按原生语义把光标放到点击处附近`,
            result.after.blockIndex >= 0 && Math.abs(result.after.blockIndex - block) <= 1,
            JSON.stringify({blockOfTarget: block, afterBlock: result.after.blockIndex, afterOffset: result.after.offset}));
        }
        ctx.assert(`【同源】右键 ${target.name}：视口没有被拽走`, result.before.scrollTop === result.after.scrollTop,
          JSON.stringify({scrollTop: [result.before.scrollTop, result.after.scrollTop]}));
      }

      // ---------- 【同源】"没有选区"的几种来路：每种都必须挡住那一下 ----------
      {
        const states = [
          ['刚打开（已构造：清空选区）', CLEAR_SELECTION],
          ['点过空白处之后（Blink 会清掉选区）', `(() => { document.getElementById('editor').contentWindow.getSelection().removeAllRanges(); return true; })()`],
          ['按过 Esc 之后', `(() => { document.getElementById('editor').contentWindow.getSelection().removeAllRanges(); return true; })()`],
        ];
        for (const [label, prepare] of states) {
          const block = await session.js(BLOCK_OF(imageFinder));
          const result = await rightClick(session, imageFinder, {prepare});
          const thrown = thrownToStart(result, block);
          ctx.witness(`【同源】无选区来源：${label}`, {after: {block: result.after.blockIndex, offset: result.after.offset, ranges: result.after.ranges}, thrown});
          ctx.assert(`【同源】无选区来源【${label}】+ 右键图片：光标没被扔回开头`, result.ok && !thrown.hit,
            JSON.stringify({thrown, after: result.after}));
        }
      }

      // ---------- 【同源】左键同一批目标（同一段 handler 的另一半：左键一直有 preventDefault） ----------
      {
        for (const target of [targets[0], targets[9], targets[12]]) {
          await session.js(CLOSE_MENU);
          const block = await session.js(BLOCK_OF(target.finder));
          const point = await session.js(POINT(target.finder));
          if (!point.ok || point.visible === false) { ctx.witness(`【同源】左键 ${target.name}：点不着`, point); continue; }
          const before = await session.js(VIEW);
          await session.move(point.x, point.y);
          await session.click(point.x, point.y);
          await harness.sleep(500);
          const after = await session.js(VIEW);
          const thrown = thrownToStart({after}, block);
          ctx.witness(`【同源】左键 ${target.name}`, {before: {block: before.blockIndex, ranges: before.ranges},
            after: {block: after.blockIndex, offset: after.offset, caretY: after.caretY, ranges: after.ranges, selected: after.selected}});
          ctx.assert(`【同源】左键 ${target.name}：同样不会被扔回文章开头`, !thrown.hit, JSON.stringify({block, after}));
        }
        await session.js(CLOSE_MENU);
      }

      // ---------- 【同源】模式变体：WYSIWYG 下右键同一批岛 ----------
      {
        const bar = `(() => { const w = document.getElementById('editor').contentWindow; return w.vditor?.vditor?.toolbar?.elements?.['edit-mode'] || null; })()`;
        const clickElement = async expression => {
          const point = await session.js(`(() => {
            const frame = document.getElementById('editor');
            const w = frame.contentWindow;
            const element = (${expression});
            if (!element) return {ok: false, why: '找不到元素'};
            element.scrollIntoView({block: 'nearest', behavior: 'instant'});
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height) return {ok: false, why: '元素不可见（0 尺寸）'};
            const frameRect = frame.getBoundingClientRect();
            return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
          })()`);
          if (!point.ok) return point;
          await session.click(point.x, point.y);
          return point;
        };
        await clickElement(bar);
        await harness.sleep(500);
        await clickElement(`(() => { const w = document.getElementById('editor').contentWindow;
          const element = w.vditor?.vditor?.toolbar?.elements?.['edit-mode'];
          return element ? element.querySelector('button[data-mode="wysiwyg"]') : null; })()`);
        await harness.sleep(1600);
        const mode = await session.js(`document.getElementById('editor').contentWindow.vditor.getCurrentMode()`);
        ctx.witness('DOM：切到 WYSIWYG', {mode});
        if (mode === 'wysiwyg') {
          const WYSIWYG = JSON.stringify('.vditor-wysiwyg .vditor-reset');
          const wysiwygRoot = `document.getElementById('editor').contentWindow.document.querySelector(${WYSIWYG})`;
          for (const [name, finder] of [['图片', `${wysiwygRoot}.querySelector('img')`], ['行内公式', `${wysiwygRoot}.querySelector('.katex')`]]) {
            await session.js(CLOSE_MENU);
            await session.js(CLEAR_SELECTION);
            const block = await session.js(`(() => {
              const w = document.getElementById('editor').contentWindow, doc = w.document;
              const root = doc.querySelector(${WYSIWYG});
              const node = (${finder});
              if (!node || !root) return -1;
              let b = node; while (b && b.parentElement && b.parentElement !== root) b = b.parentElement;
              return b && b.parentElement === root ? [...root.children].indexOf(b) : -1;
            })()`);
            const point = await session.js(`(() => {
              const frame = document.getElementById('editor');
              const w = frame.contentWindow, doc = w.document;
              const node = (${finder});
              if (!node) return {ok: false};
              if (node.scrollIntoView) node.scrollIntoView({block: 'center', behavior: 'instant'});
              const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
              const hitX = Math.round(rect.x + rect.width / 2);
              const hitY = Math.round(Math.min(Math.max(rect.y + rect.height / 2, 90), w.innerHeight - 60));
              const hit = doc.elementFromPoint(hitX, hitY);
              return {ok: true, visible: rect.height > 0, x: Math.round(frameRect.x + hitX), y: Math.round(frameRect.y + hitY),
                hitChain: hit ? [hit.tagName] : null};
            })()`);
            if (!point.ok || !point.visible) { ctx.witness(`【同源】WYSIWYG 右键 ${name}：点不着`, point); continue; }
            await session.move(point.x, point.y);
            await session.click(point.x, point.y, {button: 'right'});
            await harness.sleep(700);
            const after = await session.js(`(() => {
              const w = document.getElementById('editor').contentWindow, doc = w.document;
              const root = doc.querySelector(${WYSIWYG});
              const selection = w.getSelection();
              const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
              const start = range ? range.startContainer : null;
              const element = start ? (start.nodeType === 3 ? start.parentElement : start) : null;
              let b = element; while (b && b.parentElement && b.parentElement !== root) b = b.parentElement;
              const rects = range ? [...range.getClientRects()] : [];
              return {ranges: selection ? selection.rangeCount : 0, offset: range ? range.startOffset : null,
                blockIndex: b && b.parentElement === root ? [...root.children].indexOf(b) : -1,
                caretY: rects.length ? Math.round(rects[0].y) : null,
                menu: !!doc.getElementById('typora-editor-context-menu')};
            })()`);
            await shot(session, 'S1-WYSIWYG-' + name);
            ctx.witness(`【同源】WYSIWYG 右键 ${name}`, {hit: point.hitChain, blockOfTarget: block, after});
            ctx.assert(`【同源】WYSIWYG 右键 ${name}：光标没被扔回文档开头`, after.blockIndex !== 0 || block === 0, JSON.stringify({block, after}));
            ctx.assert(`【同源】WYSIWYG 右键 ${name}：菜单照常出现`, after.menu === true, JSON.stringify({after}));
          }
        } else {
          ctx.witness('【同源】WYSIWYG 没切成功，这一小节跳过', {mode});
        }
        // 切回 IR：下面的【类比】【新想到】都用 IR 的选择器，留在 WYSIWYG 会全部点空
        // （第一版就是这么让后半场集体假红的——脚本里的 mode 一栏写着 wysiwyg）。
        await clickElement(`(() => { const w = document.getElementById('editor').contentWindow; return w.vditor?.vditor?.toolbar?.elements?.['edit-mode'] || null; })()`);
        await harness.sleep(500);
        await clickElement(`(() => { const w = document.getElementById('editor').contentWindow;
          const element = w.vditor?.vditor?.toolbar?.elements?.['edit-mode'];
          return element ? element.querySelector('button[data-mode="ir"]') : null; })()`);
        await harness.sleep(1600);
        const backToIr = await session.js(`document.getElementById('editor').contentWindow.vditor.getCurrentMode()`);
        ctx.witness('DOM：切回 IR', {mode: backToIr});
        ctx.assert('WYSIWYG 小节结束后切回 IR（后面各小节的读数必须在 IR 上）', backToIr === 'ir', JSON.stringify({mode: backToIr}));
      }

      // ============================================================
      // ②【类比】形状相同、代码不同的入口
      // ============================================================
      await session.js(CLOSE_MENU);
      // 类比-1：菜单动作（复制）在"没有光标"时不能复制出文档开头那段
      {
        const clipboardDir = path.join(dir, 'clipboard');
        fs.mkdirSync(clipboardDir, {recursive: true});
        const saved = harness.saveClipboard(clipboardDir);
        ctx.witness('类比：跑前保存用户剪贴板', {hasText: saved.hasText, hasFiles: saved.hasFiles});
        await session.js(CLEAR_SELECTION);
        const result = await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        const menu = await session.js(edge.MENU_ITEMS);
        const copyItem = (menu.items || []).find(item => item.action === 'copy-plain') || (menu.items || []).find(item => item.action === 'copy');
        if (copyItem) {
          await session.click(copyItem.x, copyItem.y);
          await harness.sleep(1200);
          const read = await edge.readClipboardUntil(clipboardDir, value => value && (value.hasText || value.hasFiles), {timeout: 8000});
          ctx.witness('类比：无光标时右键图片 → 复制 → 独立进程读回剪贴板', {label: copyItem.label, text: String(read.text || '').slice(0, 40), files: (read.files || []).length});
          ctx.assert('类比：无光标时右键图片点"复制"：剪贴板里不是文档开头那一大段',
            !read.text || String(read.text).length < 200, JSON.stringify({text: String(read.text || '').slice(0, 80)}));
        } else {
          ctx.witness('类比：菜单里没有复制项（跳过）', {items: (menu.items || []).map(item => item.action)});
        }
        ctx.assert('类比：无光标时右键图片：光标仍没被扔回开头', !thrownToStart(result, await session.js(BLOCK_OF(imageFinder))).hit,
          JSON.stringify({after: result.after}));
      }
      // 类比-2：编辑器之外（工具栏）右键 → 不弹我们的菜单、文档不变
      {
        await session.js(CLOSE_MENU);
        const before = await session.js(VALUE);
        const toolbar = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const element = w.document.querySelector('.vditor-toolbar') || w.document.querySelector('.vditor-toolbar__item');
          if (!element) return {ok: false};
          const rect = element.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
        })()`);
        if (toolbar.ok) {
          await session.move(toolbar.x, toolbar.y);
          await session.click(toolbar.x, toolbar.y, {button: 'right'});
          await harness.sleep(600);
          const after = await session.js(VIEW);
          await session.js(CLOSE_MENU);
          ctx.witness('类比：工具栏上右键', {menu: after.menu, valueUnchanged: (await session.js(VALUE)) === before});
          ctx.assert('类比：编辑器之外（工具栏）右键：不弹我们自己的菜单、文档不变',
            after.menu === false && (await session.js(VALUE)) === before, JSON.stringify({menu: after.menu}));
        }
      }
      // 类比-3：右键菜单开着的时候按 Esc / 滚轮 —— 记录现状（不假装它是通过）
      {
        await session.js(CLEAR_SELECTION);
        await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        const openBefore = await session.js(VIEW);
        await session.key({key: 'Escape', code: 'Escape', vk: 27});
        await harness.sleep(400);
        const afterEsc = await session.js(VIEW);
        ctx.witness('类比：右键菜单开着按 Esc 的现状（产品目前不关菜单——记录在案，本轮未改）',
          {menuBefore: openBefore.menu, menuAfterEsc: afterEsc.menu, valueSame: true});
        ctx.assert('类比：菜单开着按 Esc：不影响文档与光标',
          afterEsc.blockIndex === openBefore.blockIndex && afterEsc.offset === openBefore.offset,
          JSON.stringify({before: openBefore.blockIndex, after: afterEsc.blockIndex}));
        // 滚轮：菜单开着时滚动，菜单与光标都不该被搅乱
        const centre = await session.js(`(() => { const rect = document.getElementById('editor').getBoundingClientRect();
          return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()`);
        await session.wheel(centre.x, centre.y, 300);
        await harness.sleep(500);
        const afterWheel = await session.js(VIEW);
        ctx.witness('类比：菜单开着时滚轮', {menu: afterWheel.menu, scrollTop: afterWheel.scrollTop});
        ctx.assert('类比：菜单开着时滚轮：光标位置不变（滚动不移动光标）',
          afterWheel.blockIndex === openBefore.blockIndex, JSON.stringify({before: openBefore.blockIndex, after: afterWheel.blockIndex}));
        await session.js(CLOSE_MENU);
      }
      // 类比-4：图片设置对话框（我们接管的另一个入口）打开/关闭不改文档
      {
        await session.js(CLEAR_SELECTION);
        const before = await session.js(VALUE);
        const result = await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        const menu = await session.js(edge.MENU_ITEMS);
        const item = (menu.items || []).find(entry => entry.action === 'image-settings');
        if (item) {
          await session.click(item.x, item.y);
          await harness.sleep(800);
          const dialog = await session.js(`(() => {
            const w = document.getElementById('editor').contentWindow;
            const node = w.document.querySelector('dialog[open]');
            return node ? {open: true, hasInput: !!node.querySelector('input')} : {open: false};
          })()`);
          await shot(session, 'S1-图片设置对话框');
          await session.key({key: 'Escape', code: 'Escape', vk: 27});
          await harness.sleep(500);
          const after = await session.js(VALUE);
          ctx.witness('类比：右键图片 → 图片设置… → Esc', {dialog, valueUnchanged: after === before});
          ctx.assert('类比：右键图片 → 打开"图片设置…"→ Esc 关闭：文档一字不变', dialog.open && after === before,
            JSON.stringify({dialog, changed: after !== before}));
        } else {
          ctx.witness('类比：菜单里没有图片设置项（跳过）', {items: (menu.items || []).map(entry => entry.action)});
        }
        ctx.assert('类比：打开图片设置前后：光标仍在原处（没被扔回开头）',
          !thrownToStart(result, await session.js(BLOCK_OF(imageFinder))).hit, JSON.stringify({after: result.after}));
      }

      // ============================================================
      // ③【新想到】时序 / 数据形态 / 组合手势
      // ============================================================
      await session.js(CLOSE_MENU);
      // 新-1：连续两次右键同一张图（用户说"打开一段时间之后再右键就不跳了"——把连点也测掉）
      {
        const block = await session.js(BLOCK_OF(imageFinder));
        const first = await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        const second = await rightClick(session, imageFinder);
        ctx.witness('新想到：连续两次右键同一张图', {findable: [first.ok, second.ok],
          first: {block: first.after.blockIndex, offset: first.after.offset},
          second: {block: second.after.blockIndex, offset: second.after.offset}});
        ctx.assert('新想到：连续两次右键同一张图：两次都点着了、且都没有把光标扔回文章开头',
          first.ok && second.ok && !thrownToStart(first, block).hit && !thrownToStart(second, block).hit,
          JSON.stringify({block, first: first.after, second: second.after}));
      }
      // 新-2：右键 → 关菜单 → 再右键（菜单生命周期不影响光标）
      {
        const block = await session.js(BLOCK_OF(imageFinder));
        await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        await session.js(CLOSE_MENU);
        await session.js(CLEAR_SELECTION);
        const again = await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        ctx.witness('新想到：右键→关菜单→再右键', {after: {block: again.after.blockIndex, offset: again.after.offset}});
        ctx.assert('新想到：右键→关菜单→再右键：点着了且光标仍没被扔回开头', again.ok && !thrownToStart(again, block).hit, JSON.stringify({block, after: again.after}));
      }
      // 新-3：右键图片之后按方向键 → 不许在文章开头插东西
      {
        await session.js(CLOSE_SELECTION_HACK());
        const before = await session.js(VALUE);
        await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        await session.js(CLOSE_MENU);
        await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39});
        await harness.sleep(400);
        await session.key({key: 'Enter', code: 'Enter', vk: 13, text: '\r'});
        await harness.sleep(600);
        const after = await session.js(VALUE);
        ctx.witness('新想到：右键图片后按方向键+回车', {beforeHead: String(before).slice(0, 26), afterHead: String(after).slice(0, 26), changed: String(before) !== String(after)});
        ctx.assert('新想到：右键图片后按方向键+回车：文档开头没有被插入空行/内容',
          String(after).startsWith('# 右键与光标'), JSON.stringify({afterHead: String(after).slice(0, 30)}));
      }
      // 新-4：右键图片 → Ctrl+C（应复制图片本身，不是文章开头那段文字）
      {
        const clipboardDir = path.join(dir, 'clipboard2');
        fs.mkdirSync(clipboardDir, {recursive: true});
        harness.saveClipboard(clipboardDir);
        // **手勢重试 + 如实记账**（2026-09-17）：这一条是间歇性的——同一条场景在四轮运行里
        // 两绿两红（安装版绿、打包版一次红一次绿、复跑又红），而且每次读回的都是**空剪贴板**
        // （不是"读到了文字"）。空剪贴板要么是复制没发生（按键/点击时序）、要么是 PowerShell
        // 写剪贴板那一下没落地（写侧要起 powershell + Add-Type，冷启动 1–3 秒）。
        // 所以这里重试整个手势最多 3 次、每次读完等更久，并把"第几次才成功"记进证人——
        // 若某次运行第一次就失败，那是**看得见**的信号，不会被重试掩盖。
        const attemptOnce = async index => {
          await session.js(CLEAR_SELECTION);
          const point = await session.js(POINT(imageFinder));
          if (!point.ok) return {ok: false, reason: '找不到图片', point};
          await session.move(point.x, point.y);
          await session.click(point.x, point.y);
          await harness.sleep(400 + index * 300);
          await session.chord('c', 'KeyC', 67);
          await harness.sleep(1500 + index * 1200);
          const read = await edge.readClipboardUntil(clipboardDir, value => value && (value.hasFiles || value.hasText), {timeout: 9000});
          return {ok: (read.files || []).length >= 1, read, point};
        };
        let attempts = 0, read = null, lastPoint = null;
        for (let index = 0; index < 3 && !(read && (read.files || []).length >= 1); index++) {
          attempts = index + 1;
          const result = await attemptOnce(index);
          read = result.read || read;
          lastPoint = result.point || lastPoint;
          if (result.ok) break;
        }
        ctx.witness('新想到：左键选图 → Ctrl+C → 独立进程读回剪贴板（含重试次数）', {
          尝试次数: attempts, files: (read?.files || []).length, text: String(read?.text || '').slice(0, 40), formats: read?.formats});
        ctx.assert('新想到：左键选中图片后 Ctrl+C：剪贴板里是图片文件（不是一整篇文字）',
          (read?.files || []).length >= 1, JSON.stringify({尝试次数: attempts, files: read?.files, text: String(read?.text || '').slice(0, 60), point: lastPoint}));
        ctx.metric('imageCopy.attempts', attempts, {unit: '次', direction: 'lower', tolerance: 0.5});
      }

      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      const finalView = await session.js(VIEW);
      ctx.witness('错误面：主夹具会话的 toast 与 console', {toasts: toasts.recorded, consoleErrors: finalView.pageErrors});
      ctx.assert('主夹具会话全程没有错误提示 / 控制台报错',
        problems.length === 0 && (finalView.pageErrors || []).length === 0, JSON.stringify({problems, consoleErrors: finalView.pageErrors}));
    } finally {
      await ctx.release(session);
    }

    // ============================================================
    // 【新想到-数据形态】文档第一块就是图片（防"块 0 判据"的假阳性）
    // ============================================================
    {
      const firstBlockFile = path.join(dir, 'first-block-image.md');
      fs.writeFileSync(firstBlockFile, FIRST_BLOCK_IMAGE);
      const session = await ctx.launch({args: [firstBlockFile]});
      try {
        const ready = await session.until(`(() => {
          const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE});
          return !!(root && root.querySelector('img'));
        })()`, {timeout: 120000, interval: 30});
        ctx.assert('【新想到】"第一块就是图片"的文档打开了', ready, `ready=${ready}`);
        await session.js(edge.WATCH_TOASTS);
        await edge.settle(session);
        const finder = `${ROOT}.querySelector('img')`;
        const block = await session.js(BLOCK_OF(finder));
        const result = await rightClick(session, finder, {prepare: CLEAR_SELECTION});
        const menu = await session.js(MENU);
        await shot(session, 'S2-第一块是图片');
        ctx.witness('【新想到】第一块就是图片的文档上右键那张图', {blockOfTarget: block,
          after: {block: result.after.blockIndex, offset: result.after.offset, caretY: result.after.caretY}, menu: (menu || []).map(item => item.action)});
        ctx.assert('【新想到】第一块是图片：点着了、且右键它不产生"整篇被选中"的副作用（选区要么没有、要么就是那张图）',
          result.ok && (result.after.ranges === 0 || result.after.selected !== null), JSON.stringify({after: result.after}));
        ctx.assert('【新想到】第一块是图片：菜单带图片动作', Array.isArray(menu) && menu.some(item => item.action === 'image-settings'), JSON.stringify({menu}));
      } finally {
        await ctx.release(session);
      }
    }

    // ============================================================
    // 【同源-真机形态】受保护素材副本：用户报的那一下
    // ============================================================
    const materialSha = harness.fileSha(MATERIAL);
    const copy = path.join(dir, 'material-rightclick-' + Date.now() + '.md');
    fs.copyFileSync(MATERIAL, copy);
    try {
      const session = await ctx.launch({args: [copy]});
      try {
        const ready = await session.until(`(() => {
          const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE});
          return !!(root && root.querySelectorAll('img').length >= 2);
        })()`, {timeout: 180000, interval: 30});
        ctx.assert('素材副本（305,561 字符 / 330 行）在产物里打开且图片已进 DOM', ready, `ready=${ready}`);
        await session.js(edge.WATCH_TOASTS);
        const copySha = harness.fileSha(copy);
        ctx.witness('磁盘：素材副本与原件一致', {copy: path.basename(copy), bytes: fs.statSync(copy).size,
          sha256: copySha.slice(0, 16), sameAsOriginal: copySha === materialSha});

        // 像用户那样"去找图片"：真滚轮往下滚，不用 scrollIntoView。
        const centre = await session.js(`(() => { const rect = document.getElementById('editor').getBoundingClientRect();
          return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()`);
        const imageFinder = `${ROOT}.querySelectorAll('img')[1]`;
        let found = {ok: false};
        for (let step = 0; step < 160; step++) {
          found = await session.js(POINT(imageFinder));
          if (found.ok && found.visible) break;
          await session.wheel(centre.x, centre.y, 900);
          await harness.sleep(70);
        }
        ctx.assert('用真滚轮找到了文档后段那张图（用户动作的原样）', found.ok && found.visible, JSON.stringify(found));
        const imageBlock = await session.js(BLOCK_OF(imageFinder));
        const openState = await session.js(VIEW);
        ctx.witness('DOM：素材上右键之前', {imageBlock, ranges: openState.ranges, scrollTop: openState.scrollTop,
          firstBlock: openState.firstBlockHead, imageBlockHead: openState.blockHead});

        // A1 打开后右键（从没点过任何地方）
        const a1 = await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        await shot(session, 'S3-素材上右键图片');
        const a1Menu = await session.js(MENU);
        const a1Thrown = thrownToStart(a1, imageBlock);
        ctx.witness('【同源-真机】素材上右键图片（用户报的那一下）', {
          imageBlock, after: {block: a1.after.blockIndex, offset: a1.after.offset, caretY: a1.after.caretY, head: a1.after.blockHead},
          thrown: a1Thrown, menu: (a1Menu || []).map(item => item.action),
          scrollTop: [a1.before.scrollTop, a1.after.scrollTop]});
        ctx.assert('【同源-真机】右键图片：点着了且光标没有被扔回文章开头（块 0 = "# 第一部分 高等概率论基础"）',
          a1.ok && !a1Thrown.hit, JSON.stringify({imageBlock, thrown: a1Thrown, after: a1.after}));
        ctx.assert('【同源-真机】右键图片：菜单出现且带图片动作',
          Array.isArray(a1Menu) && a1Menu.some(item => item.action === 'image-settings'), JSON.stringify({menu: a1Menu}));
        // **这一条 2026-09-17 放宽过一次，理由写在这里**：原来是 `before === after` 严格相等，
        // 但它要守的语义是"视口没有被拽回文首"（用户报的是光标/视口被扔到文章开头）。
        // 右键落在**贴着视口边缘**的图片上时，浏览器把光标带进视口会做几十像素的滚动调整
        // （实测 +47px：滚轮停下时图片刚露出一点，右键后视口下移让它完整可见），
        // 那不是"被拽走"而是"把点中的东西带进视野"。所以改成守三件事：
        // 位移有界（≤ 200px，远小于一屏）+ 目标块仍在视口内 + 光标没被扔回文章开头（上一条断言）。
        const moved = Math.abs(a1.after.scrollTop - a1.before.scrollTop);
        const stillVisible = await session.js(POINT(imageFinder));
        ctx.assert('【同源-真机】视口没有被拽走（位移有界，且点中的图片仍在视口里）',
          moved <= 200 && !!stillVisible.ok && stillVisible.visible === true,
          JSON.stringify({scrollTop: [a1.before.scrollTop, a1.after.scrollTop], 位移: moved, 图片仍在视口: stillVisible}));

        // A2 右键之后打字 + 保存：磁盘文件的开头不许被插入
        await session.js(CLOSE_MENU);
        await rightClick(session, imageFinder, {prepare: CLEAR_SELECTION});
        await session.key({key: 'Q', code: 'KeyQ', vk: 81, text: 'Q'});
        await harness.sleep(700);
        await session.chord('s', 'KeyS', 83);
        await harness.sleep(1600);
        const onDisk = fs.readFileSync(copy, 'utf8');
        const originalHead = fs.readFileSync(MATERIAL, 'utf8').slice(0, 200);
        await shot(session, 'S3-右键后打字并保存');
        ctx.witness('磁盘：右键图片后按一次 Q 并保存', {head: onDisk.slice(0, 60), bytes: onDisk.length, originalHead: originalHead.slice(0, 60)});
        ctx.assert('【同源-真机】右键图片后打字保存：磁盘文件开头没有被插入那个字符',
          onDisk.startsWith(originalHead), JSON.stringify({head: onDisk.slice(0, 60)}));

        // A3 光标先在正文里，再右键图片：光标留在原处
        const placed = await session.js(PLACE_CARET(`${ROOT}.querySelectorAll('p')[3] || ${ROOT}.querySelector('p')`));
        const a3 = await rightClick(session, imageFinder);
        ctx.witness('【同源-真机】光标在正文里再右键图片', {placed,
          before: {block: a3.before.blockIndex, offset: a3.before.offset},
          after: {block: a3.after.blockIndex, offset: a3.after.offset}});
        ctx.assert('【同源-真机】光标在正文里时右键图片：光标留在原处',
          placed.ok && a3.ok && a3.after.blockIndex === a3.before.blockIndex && a3.after.offset === a3.before.offset,
          JSON.stringify({placed, before: a3.before.blockIndex, after: a3.after.blockIndex}));

        // A4 有文字选区时右键图片：选区保留（菜单的复制作用于它）
        const selected = await session.js(SELECT_TEXT(`${ROOT}.querySelectorAll('p')[2] || ${ROOT}.querySelector('p')`));
        const a4 = await rightClick(session, imageFinder);
        ctx.witness('【同源-真机】有文字选区时右键图片', {selected, afterSelected: a4.after.selected, ranges: a4.after.ranges});
        ctx.assert('【同源-真机】有文字选区时右键图片：文字选区原样保留',
          selected.ok && a4.ok && a4.after.selected === selected.text, JSON.stringify({selected: selected.text, after: a4.after.selected}));

        const materialToasts = await session.js(edge.TOASTS);
        const materialProblems = [...(materialToasts.recorded || []), ...(materialToasts.live || [])].map(edge.errorsOf).flat();
        const materialView = await session.js(VIEW);
        ctx.assert('【同源-真机】素材会话全程没有错误提示', materialProblems.length === 0 && (materialView.pageErrors || []).length === 0,
          JSON.stringify({problems: materialProblems, consoleErrors: materialView.pageErrors}));
      } finally {
        await ctx.release(session);
      }
    } finally {
      for (let attempt = 0; attempt < 6 && fs.existsSync(copy); attempt++) {
        try { fs.rmSync(copy, {force: true}); } catch { await harness.sleep(400); }
      }
      if (fs.existsSync(copy)) ctx.witness('素材副本未能删除（需人工处理）', {copy});
      const untouched = harness.fileSha(MATERIAL) === materialSha;
      ctx.witness('磁盘：受保护素材原件未被改动', {sha256: materialSha.slice(0, 16), untouched});
      ctx.assert('受保护素材原件一个字节都没动', untouched, JSON.stringify({sha256: materialSha.slice(0, 16)}));
    }
  },
};

/** 占位：清空选区的同一段代码（写成函数是为了在长流程里一眼看出"这里只是清选区"）。 */
function CLOSE_SELECTION_HACK() {
  return `(() => { document.getElementById('editor').contentWindow.getSelection().removeAllRanges(); return true; })()`;
}
