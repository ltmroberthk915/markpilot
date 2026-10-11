/** 探针 · 第 3 轮"存疑/观察项"统一取证（2026-10-02，只取证不改产品）。
 *
 *  判决来源：
 *   · E:/MarkPilot/.zcode-tmp/round2-verdicts.md「存疑」节：W3 / W存疑 / D存疑1 / D存疑2 /
 *     S6 / S存疑（6 条）；
 *   · E:/MarkPilot/.zcode-tmp/round-state.md R3 计划里的 F2 / F5 / F7（第 1 轮观察项，
 *     probe-r1-history 里已有 EVIDENCE-F2/F5 读数，此处按"可简化"口径复用）。
 *
 *  本探针全部用例都是 EVIDENCE（不判红绿）：每用例一行
 *     R3EV <名> EVIDENCE <关键读数 JSON>
 *  外加整页 + 关键处 2x 放大截图（.perf/probe-r3-evidence/）。截图标记口径沿用
 *  r1/r2 探针：红实线＝光标落点、琥珀虚线＝目标列/期望位、青虚线＝点击/拖放落点。
 *  CDP 抓帧拍不到原生光标（Blink caret 画在合成层），图上按浏览器自报的光标矩形画标记。
 *
 *  输入一律走真实通道（CDP Input.dispatchKeyEvent / dispatchMouseEvent / insertText /
 *  imeSetComposition / dispatchDragEvent）；拖拽一律"按下 → 多次移动 → 抬起"（hi.drag）。
 *  【通道限制如实记】CDP 合成鼠标不驱动 Blink 原生拖放控制器（r2 D2c 已实证：真手势
 *  无 drop 事件）。凡拖放类用例（D1图岛/D2块公式入表）都先走真鼠标手势、记 drop 记录器，
 *  再走 Input.dispatchDragEvent（dragOver+dragDrop，Blink 拖放控制器的真实 drop 通道，
 *  载荷自备）补第二条证据；两条通道分开报，谁没触发就写明谁没触发。
 *
 *  用例（9 条 + S6 重开复检 1 条）：
 *   W3双击ab       ab$x$cd 双击 ab（a 侧/b 侧两形态）→ 端点是否切进 katex、
 *                  选中是否卷入整条公式（round2-findings W3：settle 吸整条 host）。
 *   W存疑围栏打字  展开 $x$ 双击开围栏 $ → 打 Q → 存盘 md 的 $ 配对 → 一次 Ctrl+Z 还原性。
 *   S存疑CtrlC     选"文甲 $x+y$ 文乙"原生 Ctrl+C → 独立进程读系统剪贴板 text/plain
 *                  字节：单份带围栏还是双份（双份 → 与 S5 同根）。
 *   D1图岛拖放     双击选"拖词"→ 拖到裸 HTML 图渲染岛上松手 → 字是否丢失。
 *   D2块公式入表   选区盖"段+$$块$$+段"（整条块公式被包住）→ 拖入表格格 →
 *                  存盘 md 的 $$ 压行 / | 转义 / <br>。
 *   S6引用块公式   选"段+块公式" Ctrl+Shift+Q → 存盘重开后 $$ 是否仍渲染
 *                  （仍渲染 → 非缺陷）。S6重开渲染 = 同一文件关掉重开后的复检。
 *   F2纯图撤销     纯图片块删除 → Ctrl+Z → 焦点/活动元素/光标矩形（简化版取证）。
 *   F5组合中撤销   IME 组合中 Ctrl+Z×2 再上屏 → 内容与撤销栈一致性（简化版取证）。
 *   F7大文档撤销   169KB 真实素材副本（受保护素材只复制副本）→ 打 6 字 → 连按
 *                  Ctrl+Z×10 → CDP Profiler + 页内长任务计数：VditorIRDOM2Md 的
 *                  自耗时/样本数/连续段数（≈调用次数）与长任务条数——量级判定。
 *
 *  素材纪律：F7 用受保护真实素材的副本（fs.copyFileSync + chmod 0o666，中文路径只在
 *  node 进程内出现、从不跨进程传参——沿用 probe-material-open.cjs 的既有模式；原件只读
 *  绝不改）。其余用例全部现场生成文档与小图，不碰素材房。
 *  剪贴板纪律：探针开头 harness.saveClipboard、结束（含异常）restoreClipboard。
 *
 *  用法：node scripts/acceptance/probe-r3-evidence.cjs [--only=w3,w存疑,d1,d2,s6,s存疑,f2,f5,f7]
 *        （--only 大小写不敏感；跑前先 `npm run sync`，本探针按 harness dev 模式拉开发树；
 *          --installed 则拉安装版 EXE。不与其它 GUI 探针并行——铁律 3：单 GUI 串行。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r3-evidence');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;                 // 编辑器 iframe window 表达式（与 validate-probe-expr 的 SCOPE 同名）
const S = hi.SURFACE;             // 编辑面选择器（同上）

/** 受保护真实素材（169KB）：只复制副本，原件只读（round1 F7 判决指定的量级素材）。 */
const MATERIAL_169K = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/富文本测试-重识概率论.md';

// ─── 文档（全部现场生成；图片资产随组写入 OUT） ────────────────────────────────
const DOC_W3 = ['# R3 存疑取证 · 双击/围栏/剪贴板', '',
  'W3甲：ab$x$cd 甲侧收尾。', '',
  'W3乙：ab$x$cd 乙侧收尾。', '',
  '文甲 $x+y$ 文乙', '',
  'W存疑行：前缀 $x$ 后缀。', ''].join('\n');

const DOC_DRAG = ['# R3 存疑取证 · 拖放', '',
  'D1源段：这里有 拖词 两字用来拖。', '',
  '<img src="d1.png" alt="html图" width="160">', '',
  'D1后段：承接文字。', '',
  'D2起点段文字若干。', '',
  '$$',
  'E=mc^2',
  '$$',
  'D2终点段文字若干。', '',
  '| D2头甲 | D2头乙 |',
  '| --- | --- |',
  '| 待收 | 乙格 |', ''].join('\n');

const DOC_S6 = ['# R3 存疑取证 · 引用', '',
  'S6段落：引用起手正文若干。', '',
  '$$',
  'E=mc^2',
  '$$',
  'S6尾段：收尾。', ''].join('\n');

const DOC_F2 = ['# R3 存疑取证 · 纯图', '',
  '图片前段落。', '',
  '![纯图](f2img.png)', '',
  '图片后段落。', ''].join('\n');

const DOC_F5 = ['# R3 存疑取证 · 组合中撤销', '',
  'F5段落：在这里造 IME 组合态并撤销。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe，eval 注入；标记画法沿用 __r1/__r2d 口径） ──────
//  注意：本模板串内不出现 "${" 与反引号；正则反斜杠双写（模板层吃一层）。
const HELPERS = `window.__r3ev = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  const 层 = at => !at ? '?' :
    at.closest && at.closest('code[data-type="math-block"]') ? '块源码'
    : at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('[data-type$="-marker"]') ? '围栏'
    : at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th') ? '正文' : '元素级';
  const inKatex = node => { const at = node && node.nodeType === 3 ? node.parentElement : node;
    return !!(at && at.closest && at.closest('.katex')); };
  const box = el => { if (!el) return null; const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const mark = list => {
    const old = document.getElementById('__r3ev_marks');
    if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div');
    layer.id = '__r3ev_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) {
      if (!item) continue;
      const line = document.createElement('div');
      const height = Math.max(2, item.h || 18);
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + height + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layer.appendChild(line);
      drawn += 1;
      if (item.label) {
        const tag = document.createElement('div');
        tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layer.appendChild(tag);
      }
    }
    document.body.appendChild(layer);
    return drawn;
  };
  const unmark = () => { const old = document.getElementById('__r3ev_marks'); if (old) old.remove(); return 1; };
  const caret = () => {
    const s = getSelection();
    if (!s || !s.rangeCount) return { 无选区: true };
    const n = s.focusNode, o = s.focusOffset;
    const at = n.nodeType === 3 ? n.parentElement : n;
    let b = null;
    try { const probe = document.createRange(); probe.setStart(n, o); probe.collapse(true); b = probe.getBoundingClientRect(); } catch (e) {}
    return { 层: 层(at),
      容器: n.nodeType === 3 ? ('TEXT「' + String(n.data).slice(0, 12) + '」') : n.nodeName,
      偏移: o, 前缀: n.nodeType === 3 ? String(n.data).slice(Math.max(0, o - 20), o) : '',
      选区: s.toString().slice(0, 40), 选区长: s.toString().length,
      x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height), 可见: !!(b && b.height) };
  };
  /** 段落标记 → 段落里源码为 src 的行内公式 owner（src 省略则取该段第一个）。 */
  const ownerIn = (markText, src) => {
    for (const o of surface().querySelectorAll('.vditor-ir__node[data-type="inline-node"]')) {
      const p = o.closest('p');
      if (!p || !String(p.textContent || '').includes(markText)) continue;
      if (src !== undefined && src !== null) {
        const code = o.querySelector('code[data-type="math-inline"]');
        if (!code || String(code.textContent).replace(/\\s/g, '') !== src) continue;
      }
      return o;
    }
    return null;
  };
  /** 指定段里 'ab' 中第 idx 个字符（0=a，1=b）的中心点与全词盒。 */
  const 字符点 = (markText, idx) => {
    for (const block of surface().children) {
      if (!String(block.textContent || '').includes(markText)) continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        const at = node.data.indexOf('ab');
        if (at < 0) continue;
        const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + 2);
        const w = r.getBoundingClientRect();
        const c = document.createRange(); c.setStart(node, at + idx); c.setEnd(node, at + idx + 1);
        const b = c.getBoundingClientRect();
        if (!b.width) return null;
        return { 字: idx === 0 ? 'a' : 'b', x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
          词左: Math.round(w.left), 词右: Math.round(w.right) };
      }
    }
    return null;
  };
  /** 选区端点事实：双端层/inKatex/容器；对段内 owner 的包住/相交（W3 判读）。 */
  const 选区事实 = markText => {
    const s = getSelection();
    if (!s || !s.rangeCount) return { 无选区: true };
    const r = s.getRangeAt(0);
    const owner = ownerIn(markText);
    const ep = (node, off) => { const at = node.nodeType === 3 ? node.parentElement : node;
      return { 层: 层(at), inKatex: inKatex(node),
        容器: node.nodeType === 3 ? ('TEXT「' + String(node.data).slice(0, 10) + '」') : node.nodeName, 偏移: off }; };
    let 包住 = null, 相交 = null;
    if (owner) {
      const ownerRange = document.createRange(); ownerRange.selectNode(owner);
      包住 = r.compareBoundaryPoints(Range.START_TO_START, ownerRange) <= 0
        && r.compareBoundaryPoints(Range.END_TO_END, ownerRange) >= 0;
      相交 = r.intersectsNode(owner);
    }
    const text = s.toString();
    return { 非折叠: !s.isCollapsed, 长: text.length, 文本: text.slice(0, 40),
      anchor: ep(s.anchorNode, s.anchorOffset), focus: ep(s.focusNode, s.focusOffset),
      owner: owner ? { 有: true, 被包住: 包住, 相交: 相交,
        reveal: owner.classList.contains('typora-ir-selected') } : { 有: false },
      reveal们: [...surface().querySelectorAll('.vditor-ir__node.typora-ir-selected')].map(o => o.dataset.type) };
  };
  const 行内公式 = (markText, src) => {
    const o = ownerIn(markText, src);
    if (!o) return { 有: false };
    o.scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = o.getBoundingClientRect();
    const markers = [...(o.children || [])].filter(c => c.nodeName === 'SPAN'
      && c.classList && c.classList.contains('vditor-ir__marker'));
    const 开 = markers.length ? markers[0].getBoundingClientRect() : null;
    return { 有: true, 展开: o.classList.contains('vditor-ir__node--expand'), 盒: box(o),
      渲染中心: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 14)) },
      开围栏: 开 && 开.width ? { x: Math.round(开.left + 开.width / 2), y: Math.round(开.top + 开.height / 2),
        w: Math.round(开.width), h: Math.round(开.height) } : null };
  };
  const 块公式 = () => {
    const o = surface().querySelector('.vditor-ir__node[data-type="math-block"]');
    if (!o) return { 有: false };
    o.scrollIntoView({ block: 'center', behavior: 'instant' });
    const pv = o.querySelector(':scope > .vditor-ir__preview');
    return { 有: true, 盒: box(o), katex数: pv ? pv.querySelectorAll('.katex').length : 0,
      预览盒: box(pv), 展示文本: pv ? String(pv.textContent).slice(0, 24) : null };
  };
  const 选区包住块公式 = () => {
    const s = getSelection();
    const o = surface().querySelector('.vditor-ir__node[data-type="math-block"]');
    if (!s || !s.rangeCount || !o) return { ok: false };
    const boxRange = document.createRange(); boxRange.selectNode(o);
    const r = s.getRangeAt(0);
    return { ok: true, 包住: r.compareBoundaryPoints(Range.START_TO_START, boxRange) <= 0
      && r.compareBoundaryPoints(Range.END_TO_END, boxRange) >= 0,
      相交: r.intersectsNode(o), 选区长: s.toString().length };
  };
  const html岛 = () => {
    const island = surface().querySelector('.vditor-ir__node[data-type="html-block"] pre.vditor-ir__preview')
      || surface().querySelector('.vditor-ir__node[data-type="html-block"]');
    if (!island) return { 有: false };
    island.scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = island.getBoundingClientRect();
    return { 有: true, 盒: box(island),
      中心: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 40)) },
      岛文本: String(island.textContent || '').slice(0, 30) };
  };
  const 表格格 = (markText, row, col) => {
    const t = [...surface().querySelectorAll('table')]
      .find(x => (x.rows[0] && x.rows[0].cells[0] && x.rows[0].cells[0].textContent || '').includes(markText));
    if (!t) return { 有: false };
    t.scrollIntoView({ block: 'center', behavior: 'instant' });
    const cell = t.rows[row] && t.rows[row].cells[col];
    if (!cell) return { 有: true, 行数: t.rows.length, 格: false };
    const b = cell.getBoundingClientRect();
    return { 有: true, 行数: t.rows.length, 格: true, 格文本: String(cell.textContent).trim().slice(0, 20),
      盒: box(cell), 中心: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) },
      各行: [...t.rows].map(r => [...r.cells].map(c => String(c.textContent).trim().slice(0, 16))) };
  };
  /** 指定词的文本盒中心（真实双击/拖拽的落点）。 */
  const 词盒 = word => {
    for (const block of surface().children) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        const at = node.data.indexOf(word);
        if (at < 0) continue;
        const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + word.length);
        const b = r.getBoundingClientRect();
        if (b.width > 0) return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
          左: Math.round(b.left), 右: Math.round(b.right) };
      }
    }
    return null;
  };
  /** 跨块选区：a 的开头 → b 的结尾（b 可落在公式源码文本里）。前置设置，动作仍走真实输入。 */
  const 跨块选区 = (a, b) => {
    const find = word => { for (const block of surface().children) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) { const at = node.data.indexOf(word);
        if (at >= 0) return { node, start: at, end: at + word.length }; } }
      return null; };
    const A = find(a), B = find(b);
    if (!A || !B) return { ok: false, 找到甲: !!A, 找到乙: !!B };
    surface().focus();
    const r = document.createRange(); r.setStart(A.node, A.start); r.setEnd(B.node, B.end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return { ok: true, 长: s.toString().length, 选区: s.toString().slice(0, 60) };
  };
  /** 整段选中（含公式 owner 完整落在选区内；S存疑/S6 前置）。 */
  const 选段 = (a, b) => {
    for (const block of surface().children) {
      const t = String(block.textContent || '');
      if (!t.includes(a) || !t.includes(b) || !t.includes('$')) continue;
      block.scrollIntoView({ block: 'center', behavior: 'instant' });
      surface().focus();
      const r = document.createRange(); r.selectNodeContents(block);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return { ok: true, 段文本: t.replace(/\\s+/g, ' ').slice(0, 60), 选区: s.toString().slice(0, 60) };
    }
    return { ok: false };
  };
  const 图片点 = () => {
    const img = surface().querySelector('img');
    if (!img) return { 有: false };
    (img.closest('p') || img.parentElement).scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = img.getBoundingClientRect();
    return { 有: true, 加载: img.naturalWidth > 0, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  };
  /** F2/F5 焦点与光标矩形证据（沿用 probe-r1-history FOCUS_EVIDENCE 口径）。 */
  const 焦点证据 = () => {
    const active = document.activeElement;
    const s = getSelection();
    let 光标 = null;
    if (s && s.rangeCount) {
      const r = s.getRangeAt(0);
      const rects = [...r.getClientRects()];
      光标 = { 折叠: r.collapsed, rects: rects.length,
        rect: rects.length ? [Math.round(rects[0].x), Math.round(rects[0].y), Math.round(rects[0].width), Math.round(rects[0].height)] : null,
        容器: r.startContainer.nodeType === 3 ? ('text:' + String(r.startContainer.data).slice(0, 12)) : r.startContainer.nodeName };
    }
    return { hasFocus: document.hasFocus(),
      活动元素: active ? active.tagName + '.' + String(active.className).slice(0, 30) : null, 光标 };
  };
  const 撤销栈 = () => {
    const v = window.vditor;
    const u = (v && v.vditor && v.vditor.undo) || (v && v.undo);
    if (!u || !u.ir) return { ok: false };
    return { ok: true, undo: (u.ir.undoStack || []).length, redo: (u.ir.redoStack || []).length };
  };
  /** F5 组合计数器（capture，在 Vditor 处理之前数 compositionstart/end）。 */
  const 组合计数 = () => {
    if (!window.__r3f5) {
      window.__r3f5 = { start: 0, end: 0 };
      surface().addEventListener('compositionstart', () => window.__r3f5.start += 1, true);
      surface().addEventListener('compositionend', () => window.__r3f5.end += 1, true);
    }
    return { start: window.__r3f5.start, end: window.__r3f5.end };
  };
  /** F7 长任务计数（iframe 自己的 PerformanceObserver）。 */
  const arm长任务 = () => {
    window.__r3lt = [];
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries())
        window.__r3lt.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }); })
        .observe({ entryTypes: ['longtask'] });
      return { ok: true };
    } catch (e) { return { ok: false, err: String(e) }; }
  };
  const 读长任务 = () => (window.__r3lt || []).slice(0, 40);
  /** F7：把折叠光标放进第一段"长正文文字"的末尾（避开公式/围栏/预览文本）。 */
  const 放到正文段 = () => {
    for (const block of surface().children) {
      if (block.tagName !== 'P') continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
      while (node = walker.nextNode()) {
        if (node.parentElement.closest('.vditor-ir__preview,[data-type$="-marker"],code[data-type]')) continue;
        if (node.data.replace(/\\s/g, '').length <= 10) continue;
        const r = document.createRange(); r.setStart(node, node.data.length); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        surface().focus();
        block.scrollIntoView({ block: 'center', behavior: 'instant' });
        return { ok: true, 文本: String(node.data).slice(-24) };
      }
    }
    return { ok: false };
  };
  /** drop 记录器（capture 读 prevented、bubble 读最终态）＋ dragover 计数。 */
  const rec = [];
  document.addEventListener('drop', e => {
    rec.push({ t: Math.round(performance.now()), x: Math.round(e.clientX), y: Math.round(e.clientY),
      通道: 'capture', preventedAtCapture: e.defaultPrevented,
      types: e.dataTransfer ? [...e.dataTransfer.types] : [] });
  }, true);
  document.addEventListener('drop', e => {
    const last = rec[rec.length - 1];
    if (last) last.preventedAfter = e.defaultPrevented;
  }, false);
  document.addEventListener('dragover', () => { window.__r3dragover = (window.__r3dragover || 0) + 1; }, true);
  return {
    mark, unmark, caret, 选区事实, 字符点, 行内公式, 块公式, 选区包住块公式, html岛, 表格格,
    词盒, 跨块选区, 选段, 图片点, 焦点证据, 撤销栈, 组合计数, arm长任务, 读长任务, 放到正文段,
    drops: () => rec.slice(), 清drops: () => { rec.length = 0; window.__r3dragover = 0; return rec.length; },
    dragover数: () => window.__r3dragover || 0,
  };
})();`;

// 注入与求值（字符串拼接而非反引号插值：HELPERS/expression 不进 validate-probe-expr 的
// 模板审计域也能完整构造；frameOf 保持可审计的纯 IIFE 模板）。
const INSTALL = "(() => { const w = " + IF + ";"
  + " if (!w || !w.document.querySelector(" + JSON.stringify(S) + ")) return { ok: false };"
  + " if (!w.__r3ev) w.eval(" + JSON.stringify(HELPERS) + ");"
  + " return { ok: !!w.__r3ev }; })()";
const IN = expression => "(() => { const w = " + IF + "; return w.eval(" + JSON.stringify(expression) + "); })()";
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const focusOK = async session => (await hi.ensureFocus(session)).ok;
const mdOf = async session => String((await hi.mdNow(session)) || '');
const md行 = (md, key, span) => { const s = String(md || ''); const at = s.indexOf(key);
  return at >= 0 ? s.slice(Math.max(0, at - 8), at + (span || 48)) : s.slice(0, 60); };
const countOf = (text, needle) => String(text || '').split(needle).length - 1;

/** 连击序列中的一击（clickCount 即 DOM event.detail）。坐标为顶层页坐标。 */
async function clickN(session, x, y, count, modifiers = 0) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count, modifiers });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count, modifiers });
}

/** 整页 + 关键处 2x 放大截图（anchor/marks 为 iframe 内坐标，clip 才加 iframe 偏移）。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await ev(session, 'window.__r3ev.mark(' + JSON.stringify(marks) + ')');
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await ev(session, 'window.__r3ev.unmark()');
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}
const caretMark = r => (r && r.可见) ? [{ x: r.x, y: r.y, h: r.h, color: '#ff2d2d', label: '光标' }] : [];

/** CDP 拖放通道（Blink 拖放控制器：dragOver → dragDrop，载荷自备；只发 drop 不动选区）。 */
async function cdpDrop(session, point, plain, html) {
  const items = [{ mimeType: 'text/plain', data: plain, title: '' }];
  if (html) items.push({ mimeType: 'text/html', data: html, title: '' });
  const dragData = { items, files: [], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, modifiers: 0, dragData });
  await harness.sleep(80);
  await session.send('Input.dispatchDragEvent', { type: 'dragDrop', x: point.x, y: point.y, modifiers: 0, dragData });
  await harness.sleep(650);
}

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** W3：ab$x$cd 双击 ab（a 侧/b 侧两形态）→ 端点是否切进 katex、选中是否卷入整条公式。 */
async function caseW3(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const md0 = await mdOf(session);
  const forms = [];
  for (const form of [{ 名: 'a侧', mark: 'W3甲', idx: 0 }, { 名: 'b侧', mark: 'W3乙', idx: 1 }]) {
    const 点 = await ev(session, 'window.__r3ev.字符点("' + form.mark + '",' + form.idx + ')');
    if (!点 || !点.x) { forms.push({ 形态: form.名, 阶段: '没取到击点', 点 }); continue; }
    await clickN(session, frame.x + 点.x, frame.y + 点.y, 1);
    await harness.sleep(70);
    await clickN(session, frame.x + 点.x, frame.y + 点.y, 2);   // 双击（detail=2）
    await harness.sleep(280);
    const 即时 = await ev(session, 'window.__r3ev.选区事实("' + form.mark + '")');
    await harness.sleep(1050);                                    // settle/REVEAL 计时窗口之后
    const 一秒后 = await ev(session, 'window.__r3ev.选区事实("' + form.mark + '")');
    await shots(session, frame, 'W3-' + form.名, 点,
      [{ x: 点.词左, y: 点.y, h: 22, dash: true, color: '#f0a020', label: '词ab' },
       { x: 点.x, y: 点.y, h: 22, dash: true, color: '#25d0ff', label: form.名 + '击点' }]);
    const 任一读数 = [即时, 一秒后].filter(r => r && !r.无选区);
    forms.push({
      形态: form.名, 击点: [点.x, 点.y], 双击后: 即时, 一秒后,
      端点切进katex: 任一读数.some(r => (r.anchor && r.anchor.inKatex) || (r.focus && r.focus.inKatex)),
      端点入预览或源码: 任一读数.some(r => ['预览', '源码', '块源码'].includes(r.anchor && r.anchor.层) || ['预览', '源码', '块源码'].includes(r.focus && r.focus.层)),
      卷入整条公式: 任一读数.some(r => r.owner && r.owner.有 && (r.owner.被包住 || (r.owner.相交 && r.长 > 2))),
      选区长序列: 任一读数.map(r => r.长),
      文本序列: 任一读数.map(r => r.文本),
    });
  }
  return { verdict: 'EVIDENCE', detail: {
    两形态: forms,
    md未被动过: md0.includes('ab$x$cd 甲侧') && md0.includes('ab$x$cd 乙侧'),
    判读口径: { 端点切进katex: 'anchor/focus 的 inKatex', 卷入整条公式: 'owner 被包住 或 相交且选区长>2' },
    判决依据: 'round2-findings W3：settle 把原生端点吸成整条 host → 选词变"词+整条公式"' } };
}

/** S存疑：原生 Ctrl+C 选"文甲 $x+y$ 文乙" → 独立进程读系统剪贴板 text/plain 字节。 */
async function caseSClip(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const sel = await ev(session, 'window.__r3ev.选段("文甲","文乙")');
  if (!sel || !sel.ok) return { verdict: 'EVIDENCE', detail: { 阶段: '选段失败', sel } };
  const anchor = await ev(session, 'window.__r3ev.词盒("文甲")');
  await shots(session, frame, 'S存疑-选段后', anchor || { x: 300, y: 300 }, []);
  await hi.combo(session, 'Ctrl+C');
  await harness.sleep(500);
  const clip = await harness.readClipboard(OUT);   // 独立进程证人：系统剪贴板 text/plain
  const text = String(clip.text || '');
  const 份数 = countOf(text, 'x+y');
  await shots(session, frame, 'S存疑-复制后', anchor || { x: 300, y: 300 }, []);
  return { verdict: 'EVIDENCE', detail: {
    选段: { 段文本: sel.段文本, 选区: sel.选区 },
    剪贴板: { hasText: !!clip.hasText, 文本JSON: JSON.stringify(text),
      utf8字节: Buffer.byteLength(text, 'utf8'), x加y份数: 份数,
      dollar数: countOf(text, '$'), 单份带围栏: text.includes('$x+y$') && 份数 === 1,
      期望: '文甲 $x+y$ 文乙（单份带围栏）' },
    判决依据: '双份（x+y ≥2 次）→ 与 S5 同根；单份带围栏 → S存疑关单' } };
}

/** W存疑：展开 $x$ 双击开围栏 $ → 打 Q → 存盘 $ 配对 → 一次 Ctrl+Z 还原性。 */
async function caseWFence(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  let g = await ev(session, 'window.__r3ev.行内公式("W存疑行","x")');
  if (!g || !g.有) return { verdict: 'EVIDENCE', detail: { 阶段: '没找到 $x$', g } };
  await session.click(frame.x + g.渲染中心.x, frame.y + g.渲染中心.y);   // 真实点击展开
  await harness.sleep(700);
  g = await ev(session, 'window.__r3ev.行内公式("W存疑行","x")');
  if ((!g || !g.展开 || !g.开围栏) && g && g.有 && g.渲染中心) {
    await session.click(frame.x + g.渲染中心.x, frame.y + g.渲染中心.y);
    await harness.sleep(700);
    g = await ev(session, 'window.__r3ev.行内公式("W存疑行","x")');
  }
  if (!g || !g.有 || !g.展开 || !g.开围栏) return { verdict: 'EVIDENCE', detail: { 阶段: '展开失败（围栏无像素）', g } };
  const md0 = await mdOf(session);
  const stack0 = await ev(session, 'window.__r3ev.撤销栈()');
  const 栏 = g.开围栏;
  await clickN(session, frame.x + 栏.x, frame.y + 栏.y, 1);
  await harness.sleep(70);
  await clickN(session, frame.x + 栏.x, frame.y + 栏.y, 2);   // 双击开围栏 $
  await harness.sleep(380);
  const sel = await ev(session, 'window.__r3ev.选区事实("W存疑行")');
  const caretAfter = await ev(session, 'window.__r3ev.caret()');
  await shots(session, frame, 'W存疑-双击围栏后', 栏,
    [...caretMark(caretAfter), { x: 栏.x, y: 栏.y, h: 栏.h || 22, dash: true, color: '#25d0ff', label: '开$双击点' }]);
  await session.type('Q');                                     // IME 上屏的真实通道
  await harness.sleep(650);
  const md1 = await mdOf(session);
  const 行1 = md行(md1, 'W存疑行');
  await shots(session, frame, 'W存疑-打Q后', 栏, []);
  await hi.combo(session, 'Ctrl+S');                           // 存盘后读磁盘
  await harness.sleep(1000);
  let disk = '';
  try { disk = fs.readFileSync(env.file, 'utf8'); } catch (error) { disk = ''; }
  await hi.combo(session, 'Ctrl+Z');                           // 一次撤销
  await harness.sleep(750);
  const md2 = await mdOf(session);
  const stackZ = await ev(session, 'window.__r3ev.撤销栈()');
  await shots(session, frame, 'W存疑-撤销后', 栏, []);
  return { verdict: 'EVIDENCE', detail: {
    展开: { ok: true, 开围栏宽: 栏.w },
    双击后: { 选区: sel, 光标: caretAfter },
    打Q后: { 行: 行1, 行dollar数: countOf(行1, '$'), 仍含配对x公式: md1.includes('$x$') },
    存盘行: md行(disk, 'W存疑行'), 存盘dollar数: countOf(md行(disk, 'W存疑行'), '$'),
    一次CtrlZ: { 行: md行(md2, 'W存疑行'), 一步还原: md2 === md0, 栈前: stack0, 栈后: stackZ },
    打字前行: md行(md0, 'W存疑行'),
    判决依据: 'round2-findings W存疑：破配对且 Ctrl+Z 不可救才升格' } };
}

/** D存疑1：双击选"拖词" → 拖到裸 HTML 图渲染岛上松手 → 字是否丢失（双通道，如实记）。 */
async function caseDIsland(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const 岛 = await ev(session, 'window.__r3ev.html岛()');
  if (!岛 || !岛.有) return { verdict: 'EVIDENCE', detail: { 阶段: 'HTML 图渲染岛没渲染出来', 岛 } };
  const 词 = await ev(session, 'window.__r3ev.词盒("拖词")');
  if (!词 || !词.x) return { verdict: 'EVIDENCE', detail: { 阶段: '没找到源词 拖词', 词 } };
  await clickN(session, frame.x + 词.x, frame.y + 词.y, 1);
  await harness.sleep(70);
  await clickN(session, frame.x + 词.x, frame.y + 词.y, 2);   // 双击选词
  await harness.sleep(320);
  const 词选态 = await ev(session, 'window.__r3ev.caret()');
  const md0 = await mdOf(session);
  await shots(session, frame, 'D1岛-双击选词后', 词, []);
  // 通道一：真鼠标手势（按下→多步移动→抬起）。已知限制：CDP 合成鼠标可能不驱动原生拖放。
  await ev(session, 'window.__r3ev.清drops()');
  await hi.drag(session, { x: frame.x + 词.x, y: frame.y + 词.y },
    { x: frame.x + 岛.中心.x, y: frame.y + 岛.中心.y }, { steps: 10, after: 800 });
  const drops1 = await ev(session, 'window.__r3ev.drops()');
  const over1 = await ev(session, 'window.__r3ev.dragover数()');
  const md1 = await mdOf(session);
  const 岛1 = await ev(session, 'window.__r3ev.html岛()');
  await shots(session, frame, 'D1岛-真手势后', 岛.中心,
    [{ x: 岛.中心.x, y: 岛.中心.y, h: 22, dash: true, color: '#25d0ff', label: '岛松手点' }]);
  // 通道二：Input.dispatchDragEvent（dragOver+dragDrop；载荷自备 text/plain）。
  let 通道2 = 'Input.dispatchDragEvent（dragOver+dragDrop，text/plain=拖词）';
  let drops2 = null, md2 = '', err2 = null;
  await ev(session, 'window.__r3ev.清drops()');
  try { await cdpDrop(session, { x: frame.x + 岛.中心.x, y: frame.y + 岛.中心.y }, '拖词'); }
  catch (error) { err2 = String(error && error.message || error).slice(0, 160); }
  drops2 = await ev(session, 'window.__r3ev.drops()');
  md2 = await mdOf(session);
  const 岛2 = await ev(session, 'window.__r3ev.html岛()');
  await shots(session, frame, 'D1岛-合成drop后', 岛.中心, []);
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1000);
  let disk = '';
  try { disk = fs.readFileSync(env.file, 'utf8'); } catch (error) { disk = ''; }
  return { verdict: 'EVIDENCE', detail: {
    岛: { 盒: 岛.盒, 岛文本初始: 岛.岛文本 }, 词选态,
    通道1真鼠标: { drops: drops1, dragover数: over1, md行: md行(md1, 'D1源段'), 词仍在源段: md1.includes('这里有 拖词'),
      岛文本: 岛1 && 岛1.岛文本,
      说明: drops1 && drops1.length ? '真手势发出了 drop' : '真手势未发出 drop（CDP 合成鼠标不驱动原生拖放的既知限制，如实记录）' },
    通道2合成drop: { 通道: 通道2, 错误: err2, drops: drops2, md行: md行(md2, 'D1源段'),
      词仍在源段: md2.includes('这里有 拖词'), 岛文本: 岛2 && 岛2.岛文本 },
    存盘md行: md行(disk, 'D1源段'), 存盘仍含拖词: disk.includes('拖词'),
    判读: { 字丢失判定: '源段与岛文本都没有 拖词 且存盘也没有 → 字丢失（以真正触发 drop 的通道为准）' },
    判决依据: 'round2-findings D存疑1：拖字松手在 HTML 图渲染岛上，插入缝隙文本疑似丢失' } };
}

/** D存疑2：选区盖"段+$$块$$+段"拖入表格格 → 存盘 $$ 压行 / | 转义 / <br>（双通道）。 */
async function caseDTable(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const sel = await ev(session, 'window.__r3ev.跨块选区("D2起点段","D2终点段")');
  if (!sel || !sel.ok) return { verdict: 'EVIDENCE', detail: { 阶段: '跨块选区失败', sel } };
  const 包 = await ev(session, 'window.__r3ev.选区包住块公式()');
  const cell = await ev(session, 'window.__r3ev.表格格("D2头甲",1,0)');
  if (!cell || !cell.有 || !cell.格) return { verdict: 'EVIDENCE', detail: { 阶段: '没找到目标格', cell } };
  const 起 = await ev(session, 'window.__r3ev.词盒("D2起点段")');
  const md0 = await mdOf(session);
  await shots(session, frame, 'D2表-选区后', 起 || cell.中心,
    [{ x: cell.中心.x, y: cell.中心.y, h: 22, dash: true, color: '#25d0ff', label: '目标格' }]);
  // 通道一：真鼠标从选区内按下 → 拖到目标格中心松手。
  await ev(session, 'window.__r3ev.清drops()');
  if (起 && 起.x) {
    await hi.drag(session, { x: frame.x + 起.x, y: frame.y + 起.y },
      { x: frame.x + cell.中心.x, y: frame.y + cell.中心.y }, { steps: 10, after: 800 });
  }
  const drops1 = await ev(session, 'window.__r3ev.drops()');
  const md1 = await mdOf(session);
  await shots(session, frame, 'D2表-真手势后', cell.中心,
    [{ x: cell.中心.x, y: cell.中心.y, h: 22, dash: true, color: '#25d0ff', label: '格松手点' }]);
  // 通道二：合成 dragDrop，载荷带 text/plain（含 $$ 多行）+ text/html（模拟 D4 dragstart 双载荷）。
  const plain = 'D2起点段文字若干。\n$$\nE=mc^2\n$$\nD2终点段文字若干。';
  const html = '<p>D2起点段文字若干。</p><pre>$$' + String.fromCharCode(10) + 'E=mc^2' + String.fromCharCode(10) + '$$</pre><p>D2终点段文字若干。</p>';
  let err2 = null;
  await ev(session, 'window.__r3ev.清drops()');
  try { await cdpDrop(session, { x: frame.x + cell.中心.x, y: frame.y + cell.中心.y }, plain, html); }
  catch (error) { err2 = String(error && error.message || error).slice(0, 160); }
  const drops2 = await ev(session, 'window.__r3ev.drops()');
  const md2 = await mdOf(session);
  const cellAfter = await ev(session, 'window.__r3ev.表格格("D2头甲",1,0)');
  await shots(session, frame, 'D2表-合成drop后', cell.中心, []);
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1000);
  let disk = '';
  try { disk = fs.readFileSync(env.file, 'utf8'); } catch (error) { disk = ''; }
  const 行分析 = text => { const 行 = md行(text, '待收', 160);
    return { 行: 行.slice(0, 160), dollar压进行: countOf(行, '$$'), 竖线转义: 行.includes('\\|'),
      br标签: 行.includes('<br>'), 该行竖线数: countOf(行, '|') }; };
  return { verdict: 'EVIDENCE', detail: {
    选区: { 长: sel.长, 头: sel.选区, 包住块公式: 包 && 包.包住, 相交: 包 && 包.相交 },
    目标格: { 文本: cell.格文本, 中心: cell.中心 },
    通道1真鼠标: { drops: drops1, md待收行: 行分析(md1),
      说明: drops1 && drops1.length ? '真手势发出了 drop' : '真手势未发出 drop（CDP 合成鼠标不驱动原生拖放的既知限制，如实记录）' },
    通道2合成drop: { 载荷: { plain, html }, 错误: err2, drops: drops2, md待收行: 行分析(md2),
      格文本: cellAfter && cellAfter.格文本, 各行: cellAfter && cellAfter.各行 },
    存盘待收行: 行分析(disk),
    判决依据: 'round2-findings D存疑2：含块公式选区拖入表格格的序列化保真（$$ 压行/| 转义/<br>）' } };
}

/** S6：选"段+块公式" Ctrl+Shift+Q → 存盘；重开渲染证据由 S6重开渲染 补。 */
async function caseS6(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const sel = await ev(session, 'window.__r3ev.跨块选区("S6段落","mc^2")');
  if (!sel || !sel.ok) return { verdict: 'EVIDENCE', detail: { 阶段: '跨块选区失败', sel } };
  const 包 = await ev(session, 'window.__r3ev.选区包住块公式()');
  const md0 = await mdOf(session);
  const anchor = await ev(session, 'window.__r3ev.词盒("S6段落")');
  await shots(session, frame, 'S6-选区后', anchor || { x: 300, y: 300 }, []);
  await hi.combo(session, 'Ctrl+Shift+Q');
  await harness.sleep(750);
  const md1 = await mdOf(session);
  const live块 = await ev(session, 'window.__r3ev.块公式()');
  await shots(session, frame, 'S6-引用后', anchor || { x: 300, y: 300 },
    [...caretMark(await ev(session, 'window.__r3ev.caret()'))]);
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1000);
  let disk = '';
  try { disk = fs.readFileSync(env.file, 'utf8'); } catch (error) { disk = ''; }
  const 引用行数 = text => String(text || '').split(/\r?\n/).filter(l => l.trim().startsWith('>')).length;
  return { verdict: 'EVIDENCE', detail: {
    选区: { 长: sel.长, 头: sel.选区, 包住块公式: 包 && 包.包住 },
    引用前md: md行(md0, 'S6段落', 120),
    引用后md: md行(md1, 'S6段落', 160), 引用后md引用行数: 引用行数(md1),
    引用后md含$$: md1.includes('$$'),
    引用后live渲染: { 有: live块 && live块.有, katex数: live块 && live块.katex数 },
    存盘md: md行(disk, 'S6段落', 160), 存盘引用行数: 引用行数(disk), 存盘含$$: disk.includes('$$'),
    重开复检: '见下一条 R3EV S6重开渲染',
    判决依据: 'round2-verdicts S6：Ctrl+Shift+Q 后 $$ 仍渲染 → 非缺陷' } };
}

/** S6重开渲染：关掉重开同一文件（铁律 3：先关再开），看 $$ 是否仍渲染。 */
async function caseS6Reopen(session, env) {
  const frame = await frameOf(session);
  const 块 = await ev(session, 'window.__r3ev.块公式()');
  const md = await mdOf(session);
  let disk = '';
  try { disk = fs.readFileSync(env.file, 'utf8'); } catch (error) { disk = ''; }
  await shots(session, frame, 'S6重开-块公式', (块 && 块.盒) ? { x: 块.盒[0], y: 块.盒[1] } : { x: 300, y: 300 }, []);
  return { verdict: 'EVIDENCE', detail: {
    块公式: { 有: 块 && 块.有, katex数: 块 && 块.katex数, 预览盒: 块 && 块.预览盒, 展示文本: 块 && 块.展示文本 },
    仍渲染: !!(块 && 块.有 && 块.katex数 > 0 && 块.预览盒 && 块.预览盒[3] > 0),
    md含$$: md.includes('$$'), 存盘含$$: disk.includes('$$'),
    存盘片段: md行(disk, 'S6段落', 160) } };
}

/** F2：纯图片块删除 → Ctrl+Z → 焦点/活动元素/光标矩形（r1-history EVIDENCE-F2 的简化版）。 */
async function caseF2(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const img = await ev(session, 'window.__r3ev.图片点()');
  if (!img || !img.有) return { verdict: 'EVIDENCE', detail: { 阶段: '图片没就绪', img } };
  await session.click(frame.x + img.x, frame.y + img.y);
  await harness.sleep(550);
  const md0 = await mdOf(session);
  await hi.press(session, 'Delete');
  await harness.sleep(950);
  const 删后 = await ev(session, 'window.__r3ev.焦点证据()');
  const md1 = await mdOf(session);
  await shots(session, frame, 'F2-删除后', img, []);
  await hi.combo(session, 'Ctrl+Z');
  await harness.sleep(1100);
  const 撤后 = await ev(session, 'window.__r3ev.焦点证据()');
  const md2 = await mdOf(session);
  const imgBack = await ev(session, 'window.__r3ev.图片点()');
  await shots(session, frame, 'F2-撤销后', img, []);
  return { verdict: 'EVIDENCE', detail: {
    图片: { 加载: img.加载 }, 删除后: 删后, 撤销后: 撤后,
    删除生效: !md1.includes('f2img'), 内容恢复: md2 === md0, 图片回DOM: !!(imgBack && imgBack.有),
    光标矩形撤销后: 撤后 && 撤后.光标 && 撤后.光标.rect,
    判决依据: 'round-state F2 观察：撤销后光标 0 矩形；此处只取焦点+矩形证据' } };
}

/** F5：IME 组合中 Ctrl+Z×2 再上屏 → 内容与撤销栈一致性（r1-history EVIDENCE-F5 简化版）。 */
async function caseF5(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器' } };
  const placed = await session.js(hi.placeAfterPrefix('F5段落'));
  if (!placed || !placed.ok) return { verdict: 'EVIDENCE', detail: { 阶段: '定位失败', placed } };
  await harness.sleep(150);
  await ev(session, 'window.__r3ev.组合计数()');
  const md0 = await mdOf(session);
  const stack0 = await ev(session, 'window.__r3ev.撤销栈()');
  const 组合中点 = await ev(session, 'window.__r3ev.caret()');
  const composed = await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
    .catch(error => ({ error: String(error && error.message || error) }));
  await harness.sleep(450);
  const c1 = await ev(session, 'window.__r3ev.组合计数()');
  const mdMid = await mdOf(session);
  await shots(session, frame, 'F5-组合中', 组合中点, [...caretMark(await ev(session, 'window.__r3ev.caret()'))]);
  await hi.combo(session, 'Ctrl+Z');
  await harness.sleep(850);
  const mdU1 = await mdOf(session);
  const stack1 = await ev(session, 'window.__r3ev.撤销栈()');
  await hi.combo(session, 'Ctrl+Z');
  await harness.sleep(850);
  const mdU2 = await mdOf(session);
  const stack2 = await ev(session, 'window.__r3ev.撤销栈()');
  await session.send('Input.insertText', { text: '你好' });   // IME 提交的真实通道
  await harness.sleep(850);
  const c2 = await ev(session, 'window.__r3ev.组合计数()');
  const mdEnd = await mdOf(session);
  const stack3 = await ev(session, 'window.__r3ev.撤销栈()');
  await shots(session, frame, 'F5-上屏后', await ev(session, 'window.__r3ev.caret()'), []);
  return { verdict: 'EVIDENCE', detail: {
    imeSetComposition可用: !composed || !composed.error,
    组合计数: { 造组合后: c1, 上屏后: c2 },
    内容: { 初始: md0, 组合中: mdMid, 撤销一: mdU1, 撤销二: mdU2, 上屏后: mdEnd },
    栈: { 初始: stack0, 撤销一: stack1, 撤销二: stack2, 上屏后: stack3 },
    一致性: {
      组合串进文档: mdMid !== md0,
      撤销一后组合串消失: mdU1 !== mdMid,
      撤销一回到初始: mdU1 === md0,
      撤销二仍等于初始: mdU2 === md0,
      上屏含新文本: mdEnd.includes('你好') },
    判决依据: 'round-state F5 观察：组合中撤销的内容/栈一致性' } };
}

/** F7：169KB 真实素材副本 → 打 6 字 → Ctrl+Z×10 → Profiler+长任务：VditorIRDOM2Md 次数与耗时（量级）。 */
async function caseF7(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'EVIDENCE', detail: { 阶段: '焦点不在编辑器（大文档冷启动后仍没拿到焦点？）' } };
  const placed = await ev(session, 'window.__r3ev.放到正文段()');
  if (!placed || !placed.ok) return { verdict: 'EVIDENCE', detail: { 阶段: '没找到可打字的正文段', placed } };
  const md0 = await mdOf(session);
  const 字 = '甲乙丙丁戊己';
  for (const ch of 字) { await session.type(ch); await harness.sleep(330); }   // 6 个独立撤销事务
  await harness.sleep(1200);
  const mdTyped = await mdOf(session);
  await ev(session, 'window.__r3ev.arm长任务()');
  let prof = { 可用: true, err: null };
  try {
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: 100 });
    await session.send('Profiler.start');
  } catch (error) { prof = { 可用: false, err: String(error && error.message || error).slice(0, 160) }; }
  const pings = [];
  for (let i = 0; i < 10; i++) {
    await hi.combo(session, 'Ctrl+Z');
    const t0 = Date.now();
    await session.js('true').catch(() => {});
    pings.push(Date.now() - t0);            // 撤销后主线程忙 → 紧跟的求值被排队，ping 变大
    await harness.sleep(850);
  }
  let profile = null;
  try { profile = (await session.send('Profiler.stop')).profile; await session.send('Profiler.disable'); }
  catch (error) { prof = { 可用: false, err: String(error && error.message || error).slice(0, 160) }; }
  const 长任务 = await ev(session, 'window.__r3ev.读长任务()');
  const mdEnd = await mdOf(session);
  await session.shot('F7-撤销后-full');
  const 块 = await ev(session, 'window.__r3ev.caret()');
  if (块 && 块.可见) {
    const clip = { x: frame.x + Math.max(0, 块.x - 240), y: frame.y + Math.max(0, 块.y - 55), width: 560, height: 165, scale: 2 };
    try { const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
      fs.writeFileSync(path.join(OUT, 'F7-撤销后-2x.png'), Buffer.from(shot.data, 'base64')); } catch (error) {}
  }
  // Profiler 归因：自耗时按 (文件, 函数名) 汇总；VditorIRDOM2Md 单列 + 连续段数（≈调用次数）。
  let agg = { 可用: false, 总采样ms: 0, VditorIRDOM2Md: null, top8: [] };
  if (profile && profile.nodes) {
    const nodes = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const match = /VditorIRDOM2Md/i;
    let vmSelf = 0, vmSamples = 0, vmRuns = 0, inRun = false, total = 0;
    for (let i = 0; i < (profile.samples || []).length; i++) {
      const node = nodes.get(profile.samples[i]);
      const ms = ((profile.timeDeltas || [])[i] || 0) / 1000;
      if (!node) continue;
      total += ms;
      const cf = node.callFrame;
      const key = String(cf.url || '').split('/').slice(-1)[0] + ' :: ' + (cf.functionName || '(anonymous)');
      self.set(key, (self.get(key) || 0) + ms);
      if (match.test(cf.functionName || '')) { vmSelf += ms; vmSamples += 1; if (!inRun) { vmRuns += 1; inRun = true; } }
      else inRun = false;
    }
    agg = { 可用: true, 总采样ms: Math.round(total),
      VditorIRDOM2Md: { 自耗时ms: Math.round(vmSelf), 样本数: vmSamples, 连续段数近似次数: vmRuns },
      top8: [...self.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
        .map(([key, ms]) => ({ 项: key, ms: Math.round(ms) })) };
  }
  const 长任务总 = 长任务.reduce((s, t) => s + t.ms, 0);
  const 长任务最大 = 长任务.reduce((m, t) => Math.max(m, t.ms), 0);
  return { verdict: 'EVIDENCE', detail: {
    素材字节: env.materialBytes || null, 打字段: placed, 打字增量字符: mdTyped.length - md0.length,
    CtrlZ次数: 10, ping序列ms: pings, ping最大: Math.max(...pings, 0),
    长任务: { 条数: 长任务.length, 总ms: 长任务总, 最大ms: 长任务最大, 前12: 长任务.slice(0, 12) },
    profiler: { ...prof, ...agg },
    撤销后md回到打字前: mdEnd === md0,
    量级判定: {
      长任务均条数每撤销: 长任务.length / 10,
      VditorIRDOM2Md近似次数每撤销: agg.VditorIRDOM2Md ? (agg.VditorIRDOM2Md.连续段数近似次数 / 10) : null,
      单条长任务上限ms: 长任务最大,
      口径: '连续段数＝采样序列里连续命中该函数的段数（≈调用次数下限）；ping＝每次 Ctrl+Z 后紧跟一条求值的排队耗时（主线程忙的旁证）' },
    判决依据: 'round1-findings F7：一次 Ctrl+Z 最多 5 次整篇 VditorIRDOM2Md（839ms/次）→ 卡 1.7-3.4s' } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r3-w3.md', content: DOC_W3,
    cases: [['W3双击ab', caseW3], ['S存疑CtrlC', caseSClip], ['W存疑围栏打字', caseWFence]] },
  { doc: 'r3-drag.md', content: DOC_DRAG,
    assets: [{ name: 'd1.png', data: () => hi.fixtures.png(160, 100, [70, 110, 230]) }],
    cases: [['D1图岛拖放', caseDIsland], ['D2块公式入表', caseDTable]] },
  { doc: 'r3-s6.md', content: DOC_S6,
    cases: [['S6引用块公式', caseS6]], recheck: [['S6重开渲染', caseS6Reopen]] },
  { doc: 'r3-f2.md', content: DOC_F2,
    assets: [{ name: 'f2img.png', data: () => hi.fixtures.png(120, 80, [80, 170, 90]) }],
    cases: [['F2纯图撤销', caseF2]] },
  { doc: 'r3-f5.md', content: DOC_F5,
    cases: [['F5组合中撤销', caseF5]] },
  { doc: 'r3-f7-169k.md', material: MATERIAL_169K, open: { minBlocks: 12, settleMs: 3000, timeout: 300000 },
    cases: [['F7大文档撤销', caseF7]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase()) || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R3EV ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const saved = harness.saveClipboard(OUT);   // 剪贴板纪律：结束（含异常）必须还原
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r3-evidence', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let evidenced = 0, failed = 0;
  try {
    for (const group of GROUPS) {
      const todo = group.cases.filter(([name]) => want(name));
      const reTodo = (group.recheck || []).filter(([name]) => want(name));
      if (!todo.length && !reTodo.length) continue;
      const file = path.join(OUT, group.doc);
      const env = { file };
      if (group.material) {
        // 受保护素材只复制副本（中文路径只在 node 进程内出现，从不跨进程传参；
        // copyFileSync 会把只读属性带过来，副本 chmod 回可写——probe-material-open 同款）。
        try {
          fs.copyFileSync(group.material, file);
          fs.chmodSync(file, 0o666);
          env.materialBytes = fs.statSync(file).size;
          console.log('\n=== ' + group.doc + '：素材副本 ' + env.materialBytes + ' 字节 ← ' + group.material + ' ===');
        } catch (error) {
          console.log('！素材复制失败：' + String(error && error.message || error).slice(0, 200));
          for (const [name] of todo) { report(name, 'FAIL', { 素材复制失败: String(error && error.message || error).slice(0, 160) }); failed += 1; }
          continue;
        }
      } else {
        fs.writeFileSync(file, group.content, 'utf8');
        console.log('\n=== ' + group.doc + '：' + todo.concat(reTodo).map(([n]) => n).join(', ') + ' ===');
      }
      for (const asset of group.assets || []) fs.writeFileSync(path.join(OUT, asset.name), asset.data());
      const openOpts = group.open || { minBlocks: 3, settleMs: 1600, timeout: 200000 };
      for (const round of [todo, reTodo]) {
        if (!round.length) continue;
        let session = null;
        try {
          session = await hi.openDoc(ctx, file, openOpts);
          const installed = await session.js(INSTALL);
          if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
          for (const [name, run] of round) {
            try {
              const outcome = await run(session, env) || {};
              report(name, outcome.verdict || 'FAIL', outcome.detail || {});
              if (outcome.verdict === 'EVIDENCE') evidenced += 1; else failed += 1;
            } catch (error) {
              report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
              failed += 1;
            }
          }
        } catch (error) {
          console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
          for (const [name] of round) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
        } finally {
          if (session) await ctx.release(session);   // 每轮结束释放会话（单 GUI 串行，端口让出来再开下一组）
        }
      }
    }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：EVIDENCE ' + evidenced + ' / FAIL ' + failed + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r3-evidence 失败：', error); process.exit(1); });
