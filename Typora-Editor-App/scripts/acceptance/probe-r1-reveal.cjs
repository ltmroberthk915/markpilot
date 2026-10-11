/** 探针 · 第 1 轮判决 B2/B3/B5 的实机取证 + EVIDENCE-B1（2026-10-02）。
 *
 *  被测对象：本仓开发树（app/renderer/js/，= extension-src 的同步副本）。探针跑在
 *  未 sync 的副本上时应当全红——这正是"修复前病象取证"；extension-src 改动 npm run sync
 *  之后复跑同一探针，四条全绿才允许落盘（验收规则二的两道视觉闸）。
 *
 *  用例（全部真实输入：CDP key/mouse/insertText；拖拽一律按下→多步移动→抬起）：
 *    B2  正文起选 → Shift+左键点块公式渲染区 → 整块并入选区 + 源码摊开 → Backspace 删除生效
 *        （红：端点停预览中间、退格无反应）
 *    B3  从正文拖到行内公式渲染结果上松手 → insertText 直接替换 → 无孤立 $ 残留
 *        （红：残留半个 $）
 *    B3B 从正文拖到块公式渲染结果中部松手 → 读端点/源码/闭$$ → insertText 替换
 *        → 无孤立 $$、无破损公式节点（红：残留半个 $$ 围栏）
 *    B5  拖选松手出现端点闪烁标记 → 滚动 200px → 标记已隐藏/不漂移
 *        （红：标记钉在视口老坐标上漂移）
 *    B1  拖选跨块公式松手 → Shift+← 一次 → 只记录 selection.toString() 长度与 REVEAL
 *        类前后（取证塌缩与否，不判 PASS/FAIL）
 *
 *  用法：node scripts/acceptance/probe-r1-reveal.cjs
 *        node scripts/acceptance/probe-r1-reveal.cjs --only=B2,B5
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r1-reveal');
const IF = hi.IF, SURFACE = hi.SURFACE;
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

/** 素材：一个标题 + 两段块公式 + 一条行内公式 + 各用例的正文锚点（自建文档，不碰素材房）。
 *  末尾垫几行：B5 要滚 200px，编辑器视口必须装不下整篇才有得滚。 */
const DOC = [
  '# R1 探针素材', '',
  'B2 行：设甲乙相向而行，速度恒定不变。', '',
  '$$', 'S = L(2n - 1)', '$$', '',
  'B3 行：相遇时间记为 $t$ 小时左右完成。', '',
  'B5 行：滚动检查用的一段普通文字，拖几个字就够。', '',
  'B4 起点行：从这行末尾开始向下拖。', '',
  '$$', 'E = mc^{2}', '$$', '',
  'B4 终点行：松手落在这行开头附近。', '',
  ...Array.from({length: 16}, (_, i) => '垫行' + (i + 1) + '：把文档垫高，让滚动有足够行程。'),
  '',
].join('\n');

/** 页面几何（全部换算成顶层页坐标，可直接喂给 CDP 输入）。 */
const GEO = `(() => { const w = ${IF}, d = w.document;
  const frame = document.getElementById('editor').getBoundingClientRect();
  const surface = d.querySelector('${SURFACE}');
  if (!surface) return {ok: false};
  const charBox = needle => { for (const b of surface.children) {
      const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
      while (n = walker.nextNode()) { const i = n.data.indexOf(needle);
        if (i >= 0) { const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
          const q = r.getBoundingClientRect();
          return {x: Math.round(frame.x + q.left + q.width / 2), y: Math.round(frame.y + q.top + q.height / 2),
            l: Math.round(frame.x + q.left), t: Math.round(frame.y + q.top), w: Math.round(q.width), h: Math.round(q.height)}; } } }
    return null; };
  const nodeBox = host => { const p = host.querySelector(':scope > .vditor-ir__preview') || host;
    const q = p.getBoundingClientRect();
    return {x: Math.round(frame.x + q.left + q.width / 2), y: Math.round(frame.y + q.top + q.height / 2),
      l: Math.round(frame.x + q.left), t: Math.round(frame.y + q.top), w: Math.round(q.width), h: Math.round(q.height)}; };
  const inline = [...surface.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const blocks = [...surface.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
  return { ok: true,
    设: charBox('设甲乙'), 恒: charBox('速度恒定'), 相: charBox('相遇时间'),
    左: charBox('小时左右'), 滚: charBox('滚动检查'), 普: charBox('普通文字'),
    尾: charBox('末尾开始'), 松: charBox('松手落在这行'),
    inline: inline.length ? nodeBox(inline[0]) : null,
    block1: blocks.length ? nodeBox(blocks[0]) : null,
    block2: blocks.length > 1 ? nodeBox(blocks[1]) : null }; })()`;

/** 选区事实：文本、长度、两端所在层、挂了 REVEAL 的公式、recover 诊断。 */
const READ_SEL = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('${SURFACE}');
  const s = w.getSelection(); if (!s || !s.rangeCount) return {none: true};
  const layer = node => { const at = node.nodeType === 3 ? node.parentElement : node;
    if (!at || !at.closest) return '外';
    return at.closest('.vditor-ir__preview') ? '预览' : at.closest('code[data-type]') ? '源码' : '正文'; };
  const r = s.getRangeAt(0);
  const reveal = [...surface.querySelectorAll('.vditor-ir__node.typora-ir-selected')].map(h => h.dataset.type);
  const note = w.__typoraMathRecover || null;
  return { len: s.toString().length, text: s.toString().slice(0, 120), collapsed: r.collapsed,
    start层: layer(r.startContainer), end层: layer(r.endContainer), reveal,
    recover: note ? {why: note.why, blocks: note.blocks || 0} : null }; })()`;

/** B3B 专用选区事实：端点容器链（ nodeName[data-type].preview 链到 surface ）、选区是否罩住
 *  块公式源码 code、是否罩住闭 $$ marker（span[data-type="math-block-close-marker"]）。 */
const READ_SEL_B3B = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('${SURFACE}');
  const s = w.getSelection(); if (!s || !s.rangeCount) return {none: true};
  const chain = (node, off) => { const at = node.nodeType === 3 ? node.parentElement : node; const out = [];
    let n = at; while (n && n !== surface) {
      out.push(n.nodeName.toLowerCase() + ((n.dataset && n.dataset.type) ? '[' + n.dataset.type + ']' : '')
        + ((typeof n.className === 'string' && n.className.includes('vditor-ir__preview')) ? '.preview' : ''));
      n = n.parentElement; }
    return (out.join('<-') || 'surface') + '#' + off; };
  const r = s.getRangeAt(0);
  const 源码 = [...surface.querySelectorAll('pre > code[data-type="math-block"]')];
  const 闭 = [...surface.querySelectorAll('span[data-type="math-block-close-marker"]')];
  return { len: s.toString().length, text: s.toString().slice(0, 120), collapsed: r.collapsed,
    起点链: chain(r.startContainer, r.startOffset), 终点链: chain(r.endContainer, r.endOffset),
    含源码: 源码.some(c => r.intersectsNode(c)), 含闭marker: 闭.some(m => r.intersectsNode(m)) }; })()`;

/** B3B 替换后 DOM 事实：math-block 节点数与各自源码、顶层块里游离的 $$ 文本（破损形态）。 */
const READ_B3B_DOM = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('${SURFACE}'); if (!surface) return {none: true};
  const blocks = [...surface.querySelectorAll('.vditor-ir__node[data-type="math-block"]')];
  const 源码们 = blocks.map(h => ((h.querySelector(':scope > pre > code[data-type="math-block"]') || {}).textContent || '').trim().slice(0, 32));
  const 游离 = [...surface.children]
    .filter(b => !(b.closest && b.closest('.vditor-ir__node')) && b.textContent.includes('$$'))
    .map(b => b.textContent.trim().slice(0, 40));
  return { math块数: blocks.length, 源码们, 游离围栏: 游离}; })()`;

/** 端点闪烁标记（iframe body 上的 .typora-selection-endpoint，fixed 视口坐标）。 */
const READ_ENDPOINT = `(() => { const w = ${IF}, d = w.document;
  const e = d.querySelector('.typora-selection-endpoint');
  if (!e) return {found: false};
  return { found: true, hidden: e.hidden, left: e.style.left, top: e.style.top, height: e.style.height }; })()`;

/** 滚动位置 + 选区锚/焦两端的内容盒（iframe 视口坐标）——判"标记跟没跟内容走"。 */
const READ_SCROLL = `(() => { const w = ${IF}, d = w.document;
  const s = w.getSelection(); let anchor = null, focus = null;
  if (s && s.rangeCount) for (const [name, node, off] of [['anchor', s.anchorNode, s.anchorOffset], ['focus', s.focusNode, s.focusOffset]]) {
    const r = d.createRange(); r.setStart(node, Math.min(off, (node.data || '').length || node.childNodes.length)); r.collapse(true);
    const q = r.getBoundingClientRect();
    const box = {top: Math.round(q.top), left: Math.round(q.left)};
    if (name === 'anchor') anchor = box; else focus = box; }
  const scroller = (() => { let n = d.querySelector('${SURFACE}');
    while (n && n !== d.body) { const st = w.getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY + ' ' + st.overflow)) return (n.className || n.nodeName) + ':' + Math.round(n.scrollTop); n = n.parentElement; }
    return 'none:0'; })();
  return { scrollY: Math.round(w.scrollY), scroller, anchor, focus }; })()`;

/** 从整页 PNG 里裁出局部再 2x 最近邻放大（ASCII 参数；复用 win-png-zoom 的放大口径；
 *  路径放进 PS 单引号字符串，反斜杠在单引号里是字面量、不用转义）。 */
const psCropZoom = (src, dst, x, y, w, h) => new Promise((resolve, reject) => {
  const cmd = [
    'Add-Type -AssemblyName System.Drawing',
    `$s=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$d=New-Object System.Drawing.Bitmap([int](${w}*2),[int](${h}*2))`,
    `$g=[System.Drawing.Graphics]::FromImage($d)`,
    `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor`,
    `$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half`,
    `$g.DrawImage($s,(New-Object System.Drawing.Rectangle(0,0,$d.Width,$d.Height)),(New-Object System.Drawing.Rectangle(${x},${y},${w},${h})),[System.Drawing.GraphicsUnit]::Pixel)`,
    `$g.Dispose(); $d.Save('${dst}'); $d.Dispose(); $s.Dispose()`,
  ].join('; ');
  const child = spawn(POWERSHELL, ['-NoProfile', '-Command', cmd], {stdio: 'ignore'});
  child.on('exit', code => (code === 0 ? resolve() : reject(new Error('cropZoom exit ' + code))));
  child.on('error', reject);
});

/** 整页截图（交代上下文）+ 选区/端点附近局部 2x（CSS 坐标 → 图像像素按实际 PNG 宽换算）。 */
async function shot2x(session, name, rect) {
  const page = await session.shot(name + '-page');
  if (!rect) return page;
  const vp = await session.js('({w: innerWidth, h: innerHeight})');
  const head = fs.readFileSync(page);
  const imgW = head.readUInt32BE(16), imgH = head.readUInt32BE(20);
  const scale = imgW / vp.w;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const X = clamp(Math.round(rect.x * scale), 0, imgW - 10), Y = clamp(Math.round(rect.y * scale), 0, imgH - 10);
  const W = clamp(Math.round(rect.w * scale), 10, imgW - X), H = clamp(Math.round(rect.h * scale), 10, imgH - Y);
  const dst = path.join(OUT, name + '-2x.png');
  await psCropZoom(page, dst, X, Y, W, H);
  return dst;
}
const rectOf = (box, pad = 70) => box ? {x: box.l - pad, y: box.t - pad, w: box.w + pad * 2, h: box.h + pad * 2} : null;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  // 自报家门：被测副本里有没有本轮三处修复的指纹（没有 = 取红轮）。
  const copy = fs.readFileSync(path.join(harness.project, 'app/renderer/js/math-select-reveal.js'), 'utf8');
  const hasFix = {B2: copy.includes('endpointsInPreview'), B3: copy.includes('setEndAfter(host)'), B5: copy.includes("addEventListener('scroll', hideEndpoint")};
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-r1-reveal', outDir: OUT, timeout: 300000, ...options, args: options.args || []}),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const only = (process.argv.find(v => v.startsWith('--only=')) || '--only=B2,B3,B3B,B5,B1').slice(7).split(',');
  const want = name => only.includes(name);

  const run = async (name, fn) => {
    if (!want(name)) return;
    const file = path.join(OUT, name + '.md');
    fs.writeFileSync(file, DOC, 'utf8');
    const session = await hi.openDoc(ctx, file, {minBlocks: 8, settleMs: 1600});
    try {
      await hi.ensureFocus(session);
      let geo = await session.js(GEO);
      if (!geo.ok || !geo.inline || !geo.block1 || !geo.block2 || geo.inline.w < 4 || geo.block1.w < 4) {
        await hi.sleep(1200);                    // KaTeX 偶尔晚一拍：预览没宽度就再等一轮重读
        geo = await session.js(GEO);
      }
      if (!geo.ok || !geo.inline || !geo.block1 || !geo.block2) { say(`R1REVEAL ${name} FAIL ` + JSON.stringify({why: '素材未就绪', geo: {ok: geo.ok, inline: !!geo.inline, block1: !!geo.block1, block2: !!geo.block2}})); return; }
      await fn(session, geo, name);
    } finally { await ctx.release(session); }   // 铁律 3：一个用例一个实例，结束立刻释放
  };

  say('被测渲染层副本 app/renderer/js/math-select-reveal.js 含本轮修复指纹：' + JSON.stringify(hasFix)
    + (hasFix.B2 && hasFix.B3 && hasFix.B5 ? '（复验轮：四条应转绿）' : '（取证轮：B2/B3/B5 预期红）'));

  // ── B2：正文起选 → Shift+左键点块公式渲染区 → 整块并入 + 源码摊开 → Backspace 删除生效 ──
  /** B2 调试插桩：mousedown 记录器 + Selection 写入记录器（带栈）+ selectionchange 时间线。
   *  用来回答：onDown 收到 shiftKey/target 吗？接管分支哪条没过？扩选之后又被谁塌掉？ */
  const 装桩 = `(() => { const w = ${IF}, d = w.document;
    const log = w.__r1probe = {downs: [], writes: [], changes: []};
    d.addEventListener('mousedown', e => {
      const t = e.target, sel = w.getSelection();
      const node = t.closest && t.closest('.vditor-ir__node');
      log.downs.push({t: Math.round(performance.now()), shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        detail: e.detail, prevented: e.defaultPrevented,
        target: (t.className || t.nodeName || '').toString().slice(0, 46),
        inPreview: !!(t.closest && t.closest('.vditor-ir__preview')),
        nodeType: node ? node.dataset.type : null,
        ownCode: node ? !!node.querySelector(':scope > code[data-type="math-inline"], :scope > pre > code[data-type="math-block"]') : null,
        selLen: sel && sel.rangeCount ? sel.toString().length : -1,
        anchorInSurface: !!(sel && sel.anchorNode && d.querySelector('${SURFACE}') && d.querySelector('${SURFACE}').contains(sel.anchorNode))});
    }, true);
    const sel = w.getSelection(), proto = Object.getPrototypeOf(sel);
    for (const name of ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse', 'collapseToStart', 'collapseToEnd', 'extend', 'setPosition', 'empty']) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      try { proto[name] = function(...args) {
        log.writes.push({name, t: Math.round(performance.now()),
          stack: String(new Error().stack || '').split('\\n').slice(2, 6).map(s => s.trim().slice(0, 110)).join(' <= ')});
        return orig.apply(this, args);
      }; } catch {}
    }
    d.addEventListener('selectionchange', () => { const s = w.getSelection();
      log.changes.push({t: Math.round(performance.now()), len: s && s.rangeCount ? s.toString().length : -1}); });
    return true; })()`;
  const 读桩 = `(() => { const w = ${IF}; return w.__r1probe ? JSON.parse(JSON.stringify(w.__r1probe)) : null; })()`;

  await run('B2', async (session, g, name) => {
    await hi.drag(session, {x: g.设.x, y: g.设.y}, {x: g.恒.x, y: g.恒.y}, {steps: 6});
    const 起 = await session.js(READ_SEL);
    await session.js(装桩);
    await session.click(g.block1.x, g.block1.y, {modifiers: 8});   // Shift+左键（真实鼠标事件）
    await hi.sleep(600);
    const 桩 = await session.js(读桩);
    if (桩) { say('桩·mousedown：' + JSON.stringify(桩.downs));
      say('桩·selection 写入：' + JSON.stringify(桩.writes.slice(0, 14)));
      say('桩·selectionchange 时间线（尾 16）：' + JSON.stringify(桩.changes.slice(-16))); }
    const 后 = await session.js(READ_SEL);
    await shot2x(session, name + '-shift-clicked', rectOf(g.block1, 90));
    await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
    await hi.sleep(600);
    const md = await hi.mdNow(session);
    await shot2x(session, name + '-after-backspace', rectOf(g.block1, 90));
    const 并入 = /2n\s*-\s*1|S\s*=\s*L/.test(后.text);
    const 摊开 = 后.reveal.includes('math-block');
    const 端点不在预览 = 后.end层 !== '预览';
    const 删除生效 = !md.includes('2n') && !md.includes('S = L');
    const pass = 起选正常(起) && 并入 && 摊开 && 端点不在预览 && 删除生效;
    say(`R1REVEAL B2-shift-click-block ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      起选: {len: 起.len, text: 起.text.slice(0, 24)},
      Shift点后: {len: 后.len, text: 后.text.slice(0, 60), end层: 后.end层, reveal: 后.reveal},
      Backspace后md: {公式已删: 删除生效, 残留2n: md.includes('2n'), md片段: (md.match(/\$\$[\s\S]{0,40}?\$\$/g) || []).join(' | ')},
      判据: {并入, 摊开, 端点不在预览, 删除生效}}));
  });

  // ── B3：正文拖到行内公式渲染结果上松手 → insertText 替换 → 无孤立 $ 残留 ──
  await run('B3', async (session, g, name) => {
    await hi.drag(session, {x: g.相.x, y: g.相.y}, {x: g.inline.x, y: g.inline.y}, {steps: 6});
    await hi.sleep(600);
    const 后 = await session.js(READ_SEL);
    await shot2x(session, name + '-dragged', rectOf(g.inline, 90));
    await session.type('改');                                       // insertText：IME 上屏通道
    await hi.sleep(800);
    const md = await hi.mdNow(session);
    await shot2x(session, name + '-after-insert', rectOf(g.inline, 90));
    const line = (md || '').split('\n').find(l => l.includes('小时左右')) || '';
    const dollars = ((md || '').match(/\$/g) || []).length;
    const 行内无残 = !line.includes('$');
    const 配对完整 = dollars % 2 === 0;
    const 原式已走 = !md.includes('$t$');
    const pass = 后.len > 0 && 行内无残 && 配对完整 && 原式已走;
    say(`R1REVEAL B3-drag-into-inline ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      拖后: {len: 后.len, text: 后.text.slice(0, 48), end层: 后.end层, reveal: 后.reveal},
      替换后md: {B3行: line, 全文dollar数: dollars},
      判据: {行内无残, 配对完整, 原式已走}}));
  });

  // ── B3B：正文拖到块公式渲染结果中部松手 → 读端点/源码/闭$$ → insertText 替换 → 无孤立 $$ ──
  await run('B3B', async (session, g, name) => {
    await hi.drag(session, {x: g.设.x, y: g.设.y}, {x: g.block1.x, y: g.block1.y}, {steps: 6});
    await hi.sleep(800);                        // includeBlocks 的 setTimeout(0) 收尾要过掉
    const 后 = await session.js(READ_SEL_B3B);
    await shot2x(session, name + '-dragged', rectOf(g.block1, 90));
    await session.type('X');                    // insertText：IME 上屏通道
    await hi.sleep(800);
    const md = await hi.mdNow(session);
    const dom = await session.js(READ_B3B_DOM);
    await shot2x(session, name + '-after-insert', rectOf(g.block1, 90));
    const lines = (md || '').split('\n');
    const fenceLines = lines.filter(l => /^\s*\$\$\s*$/.test(l));                 // 纯 $$ 行
    const 残段 = lines.filter(l => l.includes('$$') && !/^\s*\$\$\s*$/.test(l))   // $$ 混进正文行
      .map(l => l.slice(0, 40));
    const dollar数 = (md.match(/\$\$/g) || []).length;
    const 孤立围栏 = fenceLines.length % 2 === 1;                                  // 半个围栏 → 奇数条 $$ 行
    const 配对完整 = dollar数 % 2 === 0 && dollar数 === dom.math块数 * 2;          // md 的 $$ 与 DOM 节点一一配对
    const 无游离围栏 = !dom.游离围栏 || dom.游离围栏.length === 0;                 // 顶层块里没有散落 $$
    const 原式已走 = !md.includes('2n') && !md.includes('S = L');                 // 块公式整块被替换走
    const 它式无损 = md.includes('E = mc');                                       // 未牵连的 block2 原样
    const pass = !!后 && 后.len > 0 && !孤立围栏 && 残段.length === 0 && 配对完整 && 无游离围栏 && 原式已走 && 它式无损;
    say(`R1REVEAL B3B-drag-into-block ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      拖后: {len: 后 && 后.len, text: (后 && 后.text || '').slice(0, 48),
        起点链: 后 && 后.起点链, 终点链: 后 && 后.终点链, 含源码: 后 && 后.含源码, 含闭marker: 后 && 后.含闭marker},
      替换后md: {dollar行数: fenceLines.length, 全文dollar数: dollar数, 残段, md首8行: lines.slice(0, 8)},
      替换后dom: dom,
      判据: {孤立围栏, 配对完整, 无游离围栏, 原式已走, 它式无损},
      ...(pass ? {} : {md全文: md})}));           // FAIL 才 dump 全值
  });

  // ── B5：拖选松手出端点标记 → 滚动 200px → 标记隐藏/不漂移 ──
  await run('B5', async (session, g, name) => {
    await hi.drag(session, {x: g.滚.x, y: g.滚.y}, {x: g.普.x, y: g.普.y}, {steps: 5});
    await hi.sleep(500);
    const 前 = await session.js(READ_ENDPOINT);
    const 滚前 = await session.js(READ_SCROLL);
    await shot2x(session, name + '-before-scroll', rectOf(g.普, 90));
    await session.wheel(g.普.x, g.普.y, 200);
    await hi.sleep(600);
    const 后 = await session.js(READ_ENDPOINT);
    const 滚后 = await session.js(READ_SCROLL);
    await shot2x(session, name + '-after-scroll', rectOf(g.普, 90));
    const 标记曾显示 = 前.found && 前.hidden === false;
    const [容器前, 位前] = String(滚前.scroller || ':0').split(':');
    const [容器后, 位后] = String(滚后.scroller || ':0').split(':');
    const 滚动了 = (Number(位后) - Number(位前) >= 50) || 滚后.scrollY > 滚前.scrollY;
    const 已隐藏 = 后.found && 后.hidden === true;
    const 漂移 = 后.found && 后.hidden === false && 前.top === 后.top && 滚后.focus && 滚前.focus && 滚后.focus.top < 滚前.focus.top - 100;
    const pass = 标记曾显示 && 滚动了 && 已隐藏;
    say(`R1REVEAL B5-endpoint-scroll ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
      滚前: {endpoint: 前, scroller: 滚前.scroller, scrollY: 滚前.scrollY, focusTop: 滚前.focus && 滚前.focus.top},
      滚后: {endpoint: 后, scroller: 滚后.scroller, scrollY: 滚后.scrollY, focusTop: 滚后.focus && 滚后.focus.top},
      判据: {标记曾显示, 滚动了, 已隐藏, 漂移钉视口: 漂移}}));
  });

  // ── B1（EVIDENCE）：拖选跨块公式（终点落在渲染结果上，源码摊开、端点在 code 边界）
  //    → Shift+← 一次 → 记录选区长度与 REVEAL 前后 ──
  await run('B1', async (session, g, name) => {
    await hi.drag(session, {x: g.尾.x, y: g.尾.y}, {x: g.block2.x, y: g.block2.y}, {steps: 8});
    await hi.sleep(800);                        // includeBlocks 的 setTimeout(0) 收尾要过掉
    const before = await session.js(READ_SEL);
    await shot2x(session, name + '-dragged', rectOf(g.block2, 120));
    await hi.combo(session, 'Shift+ArrowLeft'); // 修饰键真实按下再抬起
    await hi.sleep(400);
    const after = await session.js(READ_SEL);
    await shot2x(session, name + '-after-shiftleft', rectOf(g.block2, 120));
    say(`R1REVEAL B1-collapse-evidence EVIDENCE ` + JSON.stringify({
      before: {len: before.len, collapsed: before.collapsed, start层: before.start层, end层: before.end层, reveal: before.reveal, recover: before.recover, text: before.text.slice(0, 60)},
      after: {len: after.len, collapsed: after.collapsed, start层: after.start层, end层: after.end层, reveal: after.reveal, text: after.text.slice(0, 60)},
      塌缩: after.collapsed || after.len === 0,
      备注: '只取证不判决'}));
  });

  fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });

/** B2 的前置：正文拖选真的做出来了（否则 Shift+点无从"扩展"）。 */
function 起选正常(起) { return !!起 && 起.len > 0 && !起.collapsed; }
