/** 探针 · 第 4 轮焦点/浮层/分栏域三缺陷修复验收（2026-10-02，probe-r4-focus）。
 *
 *  对应修复（extension-src/render/js/，dev 探针经 app/renderer 生效）：
 *   FC5 typora-patches.js patchSyntheticCaret 补 view focus 触发器 —— alt-tab 回焦后
 *      合成线重画。blur 把线收了，而回焦不动选区不动 DOM，旧实现的触发器清单
 *      （selectionchange/keyup/mouseup/MutationObserver/input/scroll/composition）
 *      一个都不会再触发，空段落里的光标回焦后就是消失。
 *   FC6 typora-patches.js patchToolbarMenus 补编辑器 window 捕获 Esc 关 HOVER+PANELS
 *      —— 表情这类点开的面板此前只有"再点一次/点外面"两条收路（GitHub issue #1
 *      残留键盘缺口）。注册顺序天然在 find-replace 之后：查找框开着时 Esc 先关
 *      查找框（stopImmediatePropagation），面板留着；面板独立在场才由这里收。
 *   MW4 split-navigation.js divider end() 的 rAF 后 releaseEntry —— 拖完分隔条
 *      heldEntry 常驻，预览面异步变更（延迟重渲染/resize/字体就绪）再来一次
 *      schedule 仍走 maintainEntry，把两面拽回拖动开始时的锚点（视口回跳）。
 *
 *  每用例一行：R4FX <名> PASS/FAIL {关键读数 JSON}，附整页 + 关键处 2x 截图
 *  （.perf/probe-r4-focus/）。截图标记口径沿用 r1/r3：红实线＝当前落点、琥珀虚线＝
 *  期望位（失焦前/拖后位）、青虚线＝击点。CDP 抓帧拍不到原生光标，按浏览器自报
 *  矩形画标记。
 *
 *  通道纪律：
 *   · FC5 的 alt-tab 用**窗口级**失焦/回焦（主进程 webContents.blur()/focus()，
 *     --inspect 调试器）：这是 OS 级焦点事件的真实 Chromium 路径，且不产生任何
 *     DOM 输入事件——不污染"只有 focus 触发器"的判定。main 不可用时降级为顶层页
 *     程序 DOM focus 把焦点移出/移回 iframe（同样无点击无按键）。
 *   · FC6 的 Esc/Ctrl+F 全部真实键盘（CDP Input），面板开关真实点击工具栏按钮。
 *   · MW4 的分隔条拖动是真实拖拽（mousePressed → 10 步移动 → mouseReleased）；
 *     "预览面异步变更"按任务口径程序触发（vditor.preview.render —— 预览面变更的
 *     正式产品通道）；"视口先被移走"用程序 scrollTop（对应真人通道：Ctrl+F 定位
 *     的 scrollIntoViewSafe、焦点在预览侧的跨 frame 翻页——都不经过 wheel/
 *     pointerdown 的锚点释放路径，正是 MW4 的受害场景）。
 *   · 全程无剪贴板；素材现场生成到 .perf/probe-r4-focus/，不碰受保护素材。
 *
 *  突变验证（把修复注掉必须变红）：
 *   · FC5：删掉 view focus 行 → 回焦后 display 仍 'none'、shown 不增 → FAIL。
 *   · FC6：删掉 keydown 注册 → closed 计数不增、面板仍开 → FAIL；
 *     反向突变（把注册挪到 installFindReplace 之前）→ Esc#1 同时关查找框和面板，
 *     "不抢"断言（面板仍开 + closed 不变）变红 → FAIL。
 *   · MW4：end() 里去掉 releaseEntry() → 预览变更后 source.scrollTop 被拉回
 *     拖前锚点（|after-target| 数百 px）→ FAIL。
 *
 *  用法：node scripts/acceptance/probe-r4-focus.cjs [--only=fc5,fc6,mw4] [--installed]
 *        （跑前先 `npm run sync`；dev 默认拉开发树。铁律 3：单 GUI 串行。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r4-focus');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;
const S = hi.SURFACE;

// ─── 文档（现场生成；不碰受保护素材） ─────────────────────────────────────────
// FC5：标题 / 正文 / **空段 ×2** / 收尾——空段是合成线的主场景（版面级空白，
// 原生画不出）。两行空行在 IR 里各落一个空块，点击候选多一点。
const DOC_FC5 = ['# R4FX FC5 合成光标回焦', '',
  'FC5正文一段：普通文字，原生光标位置，不依赖合成线。', '', '', '',
  'FC5收尾段。', ''].join('\n');
// FC6：短文即可，主角是工具栏。
const DOC_FC6 = ['# R4FX FC6 工具栏面板', '',
  'FC6正文一段：Esc 应当收起点开的表情面板。', ''].join('\n');
// MW4：撑滚动 + 结构丰富（预览重渲染有活干）。
const DOC_MW4 = (() => {
  const parts = ['# R4FX MW4 分栏拖后不回跳', ''];
  for (let i = 1; i <= 14; i++) {
    parts.push('## 第' + i + '节');
    parts.push('');
    parts.push('第' + i + '节内容 mw4sec' + i + '：这里有一段会换行的长文本。'
      + '长段内容用于把源码面与预览面都撑出滚动。'.repeat(6));
    parts.push('');
  }
  parts.push('| 名称 | 内容 |', '| --- | --- |', '| 甲 | 乙 |', '| 丙 | 丁 |', '');
  parts.push('公式段落 $u^2+v^2$ 以及 $\\frac{m}{n}$ 收尾。', '');
  return parts.join('\n');
})();

// ─── 页内工具（装进编辑器 iframe）。模板串内不出现 "${" 与反引号，正则反斜杠双写 ──
const HELPERS = `window.__r4fx = (() => {
  const box = r => r ? {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)} : null;
  // FC5 读数：合成线（显示态 + 几何 + 画线计数）+ 选区 + 日记尾部。
  const caret = () => { const b = document.querySelector('[data-typora-caret-proxy]'); const s = getSelection();
    return { bar: b ? {display: b.style.display, rect: box(b.getBoundingClientRect())} : null,
      shown: window.__caretProxyShown || 0, hasFocus: document.hasFocus(),
      sel: s && s.focusNode ? {node: s.focusNode.nodeName + (s.focusNode.nodeType === 3 ? '(' + s.focusNode.data.length + ')' : ''), off: s.focusOffset} : null,
      logTail: (window.__caretProxyLog || []).slice(-3) }; };
  // FC5 候选：编辑面里"版面空白"的块（无文本、可点击；零宽字符不算文本）。
  const blanks = () => { const s = document.querySelector('.vditor-ir .vditor-reset'); if (!s) return [];
    return [...s.children].map((n, i) => { const r = n.getBoundingClientRect();
      return {i, tag: n.nodeName, text: String(n.textContent || '').replace(/[\\s\\u200b\\ufeff]/g, '').slice(0, 16),
        x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + Math.max(6, r.height / 2)),
        w: Math.round(r.width), h: Math.round(r.height)}; })
      .filter(b => !b.text && b.w > 120 && b.h >= 8); };
  // FC5 造空段的落点：正文段末尾附近（点击后回车 → 新空段，光标落进空段）。
  const tailSpot = () => { const s = document.querySelector('.vditor-ir .vditor-reset'); if (!s) return null;
    const p = [...s.children].find(n => n.textContent.includes('FC5正文'));
    if (!p) return null; const r = p.getBoundingClientRect();
    return { x: Math.round(r.right - 12), y: Math.round(r.top + Math.max(8, r.height / 2)) }; };
  // FC6 读数：工具栏浮层清单 + 收起计数 + 查找框在否。
  const floats = () => { const list = [];
    for (const sel of ['.vditor-hint', '.vditor-panel', '.vditor-emojis'])
      for (const n of document.querySelectorAll(sel)) {
        const r = n.getBoundingClientRect();
        list.push({sel, display: n.style.display, computed: getComputedStyle(n).display,
          text: String(n.textContent).trim().slice(0, 14), rect: box(r)}); }
    return {list, closed: window.__typoraToolbarMenusClosed || 0, findOpen: !!document.querySelector('#typora-find')}; };
  const openPanels = () => floats().list.filter(f => (f.display === 'block') || (f.computed !== 'none' && f.rect && f.rect.h >= 10 && f.rect.w >= 40));
  // 工具栏按钮在顶层页里的点击坐标（emoji / source-toggle）。
  const button = type => { const bar = document.querySelector('.vditor-toolbar');
    if (!bar) return null;
    const all = [...bar.querySelectorAll('.vditor-toolbar__item button')];
    const b = all.find(x => x.dataset.type === type);
    const types = all.map(x => x.dataset.type).filter(Boolean).slice(0, 24);
    if (!b) return { missing: true, types };
    const r = b.getBoundingClientRect();
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), types}; };
  // sv 切换按钮（split-navigation-suite 同款定位）。
  const sourceToggle = () => { const api = window.vditor; const b = api && api.vditor && api.vditor.toolbar
    && api.vditor.toolbar.elements['source-toggle'] && api.vditor.toolbar.elements['source-toggle'].querySelector('button');
    if (!b) return null; const r = b.getBoundingClientRect();
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; };
  // MW4 读数：分栏态 + 分隔条 + 两面滚动 + 导航锚。
  const split = () => { const api = window.vditor; if (!api || !api.vditor) return {none: true};
    const e = api.vditor, bar = document.querySelector('.typora-split-divider'), nav = api.__splitNavigation;
    const src = e.sv && e.sv.element, prv = e.preview && e.preview.element;
    const pane = p => p ? {scrollTop: Math.round(p.scrollTop), scrollHeight: Math.round(p.scrollHeight),
      clientHeight: p.clientHeight, rect: box(p.getBoundingClientRect())} : null;
    return {mode: e.currentMode, active: nav ? nav.active : null, quality: nav ? nav.quality : null,
      anchor: nav ? nav.anchor : null,
      divider: bar ? {hidden: bar.hidden, rect: box(bar.getBoundingClientRect()), now: bar.getAttribute('aria-valuenow')} : null,
      source: pane(src), preview: pane(prv)}; };
  const toolbarRect = () => { const bar = document.querySelector('.vditor-toolbar'); return bar ? box(bar.getBoundingClientRect()) : null; };
  // 截图标记（口径同 r1/r3：红实线＝落点、琥珀虚线＝期望位、青虚线＝击点）。
  const mark = list => { const old = document.getElementById('__r4fx_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div'); layer.id = '__r4fx_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) { if (!item) continue;
      const line = document.createElement('div');
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + Math.max(2, item.h || 18) + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layer.appendChild(line); drawn += 1;
      if (item.label) { const tag = document.createElement('div'); tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layer.appendChild(tag); } }
    document.body.appendChild(layer); return drawn; };
  const unmark = () => { const old = document.getElementById('__r4fx_marks'); if (old) old.remove(); return 1; };
  return {caret, blanks, tailSpot, floats, openPanels, button, sourceToggle, split, toolbarRect, mark, unmark};
})();`;

// 注入与求值（字符串拼接构造，HELPERS 不进模板审计域；frameOf 保持纯 IIFE 模板）。
const INSTALL = "(() => { const w = " + IF + ";"
  + " if (!w || !w.document.querySelector(" + JSON.stringify(S) + ")) return { ok: false };"
  + " if (!w.__r4fx) w.eval(" + JSON.stringify(HELPERS) + ");"
  + " return { ok: !!w.__r4fx }; })()";
const IN = expression => "(() => { const w = " + IF + "; return w.eval(" + JSON.stringify(expression) + "); })()";
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const focusOK = async session => (await hi.ensureFocus(session)).ok;

// ─── 窗口级失焦/回焦（主进程 --inspect：OS 级焦点路径，不产生 DOM 输入） ────────
const winBlur = session => session.main.js('(() => { const {BrowserWindow} = require("electron");'
  + ' const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed());'
  + ' if (!w) return false; w.webContents.blur(); return true; })()');
const winFocus = session => session.main.js('(() => { const {BrowserWindow} = require("electron");'
  + ' const w = BrowserWindow.getAllWindows().find(x => !x.isDestroyed());'
  + ' if (!w) return false; if (w.isMinimized()) w.restore(); w.show(); w.focus(); w.webContents.focus(); return true; })()');
// 降级通道（main 不可用）：顶层页程序 DOM focus 把焦点移出 iframe / 移回编辑面。
const domBlur = session => session.js(`(() => { const i = document.createElement('input');
  i.setAttribute('data-r4fx', ''); i.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(i); i.focus(); return document.activeElement === i; })()`);
const domFocus = session => session.js(`(() => { const w = ${IF}; if (!w) return false;
  const s = w.document.querySelector(${JSON.stringify(S)}); if (s) s.focus(); return w.document.hasFocus(); })()`);

// ─── 通用小件 ───────────────────────────────────────────────────────────────────
async function poll(fn, { timeout = 6000, interval = 150 } = {}) {
  const stop = Date.now() + timeout;
  let last = null;
  while (Date.now() < stop) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await harness.sleep(interval);
  }
  return null;
}
/** 整页 + 关键处 2x 放大截图（anchor/marks 为 iframe 内坐标，clip 加 iframe 偏移）。 */
async function shots(session, frame, name, anchor, marks, clipBox) {
  try {
    const clip = clipBox ? { x: frame.x + Math.max(0, clipBox.x), y: frame.y + Math.max(0, clipBox.y),
      width: Math.min(1200, clipBox.w), height: Math.min(900, clipBox.h), scale: 2 }
      : { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
          y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await ev(session, 'window.__r4fx.mark(' + JSON.stringify(marks) + ')');
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await ev(session, 'window.__r4fx.unmark()');
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** FC5：空段合成光标 → 窗口失焦（线收）→ 回焦（无点击无按键）→ 线必须重画回原位。 */
async function caseFC5(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  // 1) 造真正的空段块（合成线主场景 = 版面级空白，原生画不出）。首轮实测：Markdown 源
  //    里的连续空行**不落块**（Lute 归一化掉，blanks 扫描为空，FC5 前置搭不出来）——空段
  //    必须靠编辑动作造：真实点击正文段末尾 → 真实回车 → 新空 P，光标天然落进空段。
  const spot = await ev(session, 'window.__r4fx.tailSpot()');
  if (!spot) return { verdict: 'FAIL', detail: { 阶段: '没找到正文段', spot } };
  await session.click(frame.x + spot.x, frame.y + spot.y);
  await harness.sleep(380);
  await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
  await harness.sleep(520);
  const barUp = c => !!(c && c.bar && c.bar.display === 'block' && c.bar.rect && c.bar.rect.h >= 2 && c.hasFocus);
  let base = await ev(session, 'window.__r4fx.caret()');
  let hit = null;
  if (!barUp(base)) {
    // 兜底：回车后光标没留在空段（罕见）——真实点击空段块中心。
    const blanks = await ev(session, 'window.__r4fx.blanks()');
    for (const b of (blanks || []).slice(0, 4)) {
      await session.click(frame.x + b.x, frame.y + b.y);
      await harness.sleep(450);
      const c = await ev(session, 'window.__r4fx.caret()');
      if (barUp(c)) { base = c; hit = b; break; }
    }
  }
  if (!barUp(base)) {
    const c = await ev(session, 'window.__r4fx.caret()');
    const blanks = await ev(session, 'window.__r4fx.blanks()');
    return { verdict: 'FAIL', detail: { 阶段: '空段里合成线没有画出来（前置不成立，FC5 无法验收）',
      blanks, caret: c, 红条件: '前置失败本身与 FC5 无关；若空段点击后原生也不画、合成线也不画，请先查 patchSyntheticCaret 的画线路径' } };
  }
  await shots(session, frame, 'FC5-失焦前', base.bar.rect,
    [{ x: base.bar.rect.x, y: base.bar.rect.y, h: base.bar.rect.h, color: '#ff2d2d', label: '合成线(前)' }]);
  // 2) 失焦（alt-tab 走了）：主通道窗口级 webContents.blur，降级顶层页 DOM focus。
  let channel = 'webContents.blur';
  let blurred = null;
  if (session.main) { try { await winBlur(session); } catch { channel = 'dom-focus'; } }
  else channel = 'dom-focus';
  if (channel === 'dom-focus') await domBlur(session);
  await harness.sleep(450);
  blurred = await ev(session, 'window.__r4fx.caret()');
  if (!blurred || blurred.hasFocus !== false || !blurred.bar || blurred.bar.display !== 'none') {
    return { verdict: 'FAIL', detail: { 阶段: '失焦通道没生效（需 hasFocus=false 且线已收才能继续验回焦）', channel, blurred } };
  }
  // 3) 回焦：无点击、无按键——只有窗口焦点回来。旧实现没有任何触发器，线不会回来。
  let refocused = false;
  if (channel === 'webContents.blur') { try { refocused = !!(await winFocus(session)); } catch { refocused = false; } }
  if (!refocused) { await domFocus(session); channel += '+dom-focus回焦'; }
  await harness.sleep(600);                                  // rAF(更新) + 闪烁周期
  const after = await ev(session, 'window.__r4fx.caret()');
  const rectNear = after && after.bar && after.bar.rect && base.bar.rect
    && near(after.bar.rect.x, base.bar.rect.x, 2) && near(after.bar.rect.y, base.bar.rect.y, 2);
  const pass = !!(after && after.hasFocus && after.bar && after.bar.display === 'block'
    && after.shown > base.shown && rectNear);
  await shots(session, frame, 'FC5-回焦后', after && after.bar && after.bar.rect ? after.bar.rect : (hit || spot),
    [{ x: after && after.bar && after.bar.rect ? after.bar.rect.x : (hit || spot).x, y: after && after.bar && after.bar.rect ? after.bar.rect.y : (hit || spot).y,
       h: after && after.bar && after.bar.rect ? after.bar.rect.h : 18, color: '#ff2d2d', label: '合成线(后)' },
     { x: base.bar.rect.x, y: base.bar.rect.y, h: base.bar.rect.h, dash: true, color: '#f0a020', label: '期望位(失焦前)' }]);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    失焦前: base, 回焦后: after, 通道: channel, 命中空段: hit, 造段落点: spot,
    判据: '回焦后 hasFocus 且 display=block 且 shown 增加 且 线位与失焦前差≤2px（全程无点击无按键）',
    红条件: '注掉 view focus 触发器后回焦 display 仍 none、shown 不增 → FAIL（alt-tab 回来空段光标消失）' } };
}

/** FC6：①面板独立在场 → Esc 收面板（closed+1）；②再开面板+Ctrl+F 开查找 → Esc 只关
 *  查找框（closed 不增；查找框拿走焦点时 Vditor 自己收不收面板如实记录，不冒充判据）。 */
async function caseFC6(session) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const frame = await frameOf(session);
  // 焦点放进正文（find-replace 的 Ctrl+F 只在编辑面/面板内应答）。
  const anchor = await session.js(`(() => { const w = ${IF}, d = w.document;
    const s = d.querySelector(${JSON.stringify(S)}); if (!s) return null;
    const block = [...s.children].find(n => n.textContent.includes('FC6正文'));
    if (!block) return null; const r = block.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + Math.max(6, r.height / 2)) }; })()`);
  if (!anchor) return { verdict: 'FAIL', detail: { 阶段: '没找到正文段' } };
  await session.click(frame.x + anchor.x, frame.y + anchor.y);
  await harness.sleep(350);
  const base = await ev(session, 'window.__r4fx.floats()');
  const button = await ev(session, 'window.__r4fx.button("emoji")');
  if (!button || button.missing) {
    return { verdict: 'FAIL', detail: { 阶段: '工具栏上没有表情按钮', types: button && button.types, base } };
  }
  const openEmoji = async () => {
    await session.click(frame.x + button.x, frame.y + button.y);
    const opened = await poll(async () => {
      const open = await ev(session, 'window.__r4fx.openPanels()');
      return open && open.length ? open : null;
    }, { timeout: 4000, interval: 120 });
    return opened;
  };
  const panelCount = async () => (await ev(session, 'window.__r4fx.openPanels()')).length;
  // ① FC6 本体：面板独立在场（无查找框）→ Esc 必须收（closed 计数 +1）。
  const opened1 = await openEmoji();
  if (!opened1) {
    const f = await ev(session, 'window.__r4fx.floats()');
    return { verdict: 'FAIL', detail: { 阶段: '点击表情按钮后面板没有打开（前置不成立）', floats: f } };
  }
  const openState = await ev(session, 'window.__r4fx.floats()');
  const panelBox = opened1[0].rect;
  const toolbar = await ev(session, 'window.__r4fx.toolbarRect()');
  await shots(session, frame, 'FC6-面板开', null,
    [{ x: panelBox.x + 8, y: panelBox.y + 8, h: Math.max(8, panelBox.h - 16), color: '#25d0ff', label: '面板开' }],
    { x: toolbar.x, y: toolbar.y, w: Math.max(560, panelBox.w + 80), h: (panelBox.y + panelBox.h - toolbar.y + 24) });
  await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
  await harness.sleep(440);
  const afterSoloEsc = await ev(session, 'window.__r4fx.floats()');
  const soloGone = afterSoloEsc.closed > openState.closed && (await panelCount()) === 0;
  // ② 顺序：再开面板 → Ctrl+F 开查找框 → Esc#1 只关查找框（closed 不增）。
  const opened2 = await openEmoji();
  if (!opened2) return { verdict: 'FAIL', detail: { 阶段: '第二次点击表情按钮面板没有重新打开', afterSoloEsc } };
  const beforeFind = await ev(session, 'window.__r4fx.floats()');
  await hi.combo(session, 'Ctrl+F');
  await harness.sleep(520);
  const atFind = await ev(session, 'window.__r4fx.floats()');
  const panelsAtFind = await panelCount();
  if (!atFind.findOpen) return { verdict: 'FAIL', detail: { 阶段: 'Ctrl+F 没有打开查找框（顺序断言无法进行）', atFind, panelsAtFind } };
  await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
  await harness.sleep(440);
  const afterEsc1 = await ev(session, 'window.__r4fx.floats()');
  const panelsAfterEsc1 = await panelCount();
  // "不抢"：Esc#1 必须只关查找框，我们的键盘路径不许把面板计数器 +1（注册序在
  // find-replace 之后）。面板本身的去留两支都不判：Ctrl+F 拿焦点、查找框 close() 的
  // 还焦（root().focus/selectRange）都会让 Vditor 自己收掉点开的面板——那是它的固有
  // 行为，不在 FC6 修复域内；反向突变（注册挪到 find-replace 之前）会让 closed 在
  // Esc#1 就 +1，仍被"closed 不增"抓住。
  const orderOK = !afterEsc1.findOpen && afterEsc1.closed === atFind.closed;
  await shots(session, frame, 'FC6-Esc后', null, [],
    { x: toolbar.x, y: toolbar.y, w: Math.max(560, panelBox.w + 80), h: Math.max(120, panelBox.y + panelBox.h - toolbar.y + 24) });
  const pass = soloGone && orderOK;
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    面板开: opened1.map(o => o.sel + '@' + JSON.stringify(o.rect)),
    独立场Esc: { closed: [openState.closed, afterSoloEsc.closed], 收起: soloGone },
    顺序场: { 再开: beforeFind.closed, CtrlF后: { findOpen: atFind.findOpen, closed: atFind.closed, 面板数: panelsAtFind },
      Esc1后: { findOpen: afterEsc1.findOpen, closed: afterEsc1.closed, 面板数: panelsAfterEsc1 } },
    判据: '① 面板独立在场 Esc 必收（closed+1、openPanels 清零）；② 查找框开着时 Esc 只关查找框（closed 不增；Ctrl+F 焦点转移已收面板时只记录不判）',
    红条件: '注掉 window keydown 注册 → ① closed 不增、面板仍开 → FAIL；把注册挪到 find-replace 之前 → ② Esc1 closed +1（抢了查找框的 Esc）→ FAIL' } };
}

/** MW4：sv 分栏 → 真实拖分隔条 → 程序把源码面滚到别处（对应 Ctrl+F 定位/预览侧
 *  翻页这类不经 wheel/pointerdown 的滚动）→ 程序触发预览面异步重渲染 → 源码面
 *  视口不许回跳到拖动前的锚点。 */
async function caseMW4(session) {
  const frame = await frameOf(session);
  // 1) 切 sv：真实点击 source-toggle（split-navigation-suite 同款按钮）。
  const toggle = await ev(session, 'window.__r4fx.sourceToggle()');
  if (!toggle) return { verdict: 'FAIL', detail: { 阶段: '工具栏上没有源码切换按钮' } };
  await session.click(frame.x + toggle.x, frame.y + toggle.y);
  const active = await poll(async () => {
    const st = await ev(session, 'window.__r4fx.split()');
    return st && st.mode === 'sv' && st.active && st.divider && !st.divider.hidden && st.divider.rect && st.divider.rect.w > 0 ? st : null;
  }, { timeout: 8000, interval: 150 });
  if (!active) {
    const st = await ev(session, 'window.__r4fx.split()');
    return { verdict: 'FAIL', detail: { 阶段: 'sv 分栏没有激活（前置不成立）', split: st } };
  }
  await harness.sleep(900);                                  // 首帧渲染 + 字体就绪排完
  // 2) 真实拖分隔条（按下 → 10 步移动 → 抬起）。
  const bar = (await ev(session, 'window.__r4fx.split()')).divider.rect;
  const from = { x: bar.x + Math.round(bar.w / 2), y: bar.y + Math.round(bar.h / 2) };
  const to = { x: from.x - 110, y: from.y };
  await hi.drag(session, from, to, { steps: 10, interval: 35, after: 350 });
  const postDrag = await ev(session, 'window.__r4fx.split()');
  if (!postDrag.source || postDrag.source.scrollHeight - postDrag.source.clientHeight < 300) {
    return { verdict: 'FAIL', detail: { 阶段: '源码面滚动余量不足（MW4 断言无意义）', postDrag } };
  }
  // 3) 程序把源码面滚走（真人通道：查找定位 scrollIntoViewSafe / 预览侧跨 frame 翻页）。
  const max = postDrag.source.scrollHeight - postDrag.source.clientHeight;
  const target = Math.min(postDrag.source.scrollTop + 600, max - 10);
  await ev(session, 'window.vditor.vditor.sv.element.scrollTop=' + target + ';true');
  await harness.sleep(350);
  const moved = await ev(session, 'window.__r4fx.split()');
  // 4) 程序触发预览面异步变更（预览重渲染的正式产品通道）。
  await ev(session, 'window.vditor.vditor.preview.render(window.vditor.vditor);true');
  await harness.sleep(900);                                  // Md2HTML + schedule 的 rAF/节流
  const after = await ev(session, 'window.__r4fx.split()');
  const drift = after.source ? after.source.scrollTop - target : 9999;
  const pass = !!(moved && moved.source && near(moved.source.scrollTop, target, 2)
    && after.source && near(after.source.scrollTop, target, 2));
  const src = after.source && after.source.rect;
  await shots(session, frame, 'MW4-预览变更后', src ? { x: src.x + 60, y: src.y + 40 } : { x: 200, y: 200 },
    [{ x: src ? src.x + 60 : 200, y: src ? src.y + 30 : 200, h: 18, color: '#ff2d2d', label: '视口顶(现在)' },
     { x: src ? src.x + 60 : 260, y: src ? src.y + 30 : 260, h: 18, dash: true, color: '#f0a020', label: '拖前锚点(不许跳回)' }],
    src ? { x: src.x, y: src.y, w: Math.min(620, src.w), h: 260 } : { x: 0, y: 0, w: 620, h: 260 });
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    拖后: postDrag.source.scrollTop, 目标: target, 滚动后: moved && moved.source ? moved.source.scrollTop : null,
    预览变更后: after.source ? after.source.scrollTop : null, 回跳量: drift,
    anchor: after.anchor, quality: after.quality,
    判据: '预览异步变更前后 source.scrollTop 始终 = 目标值（±2px 内，视口不回跳拖前锚点）',
    红条件: 'end() 里去掉 releaseEntry() 后 maintainEntry 把 source 拉回拖动开始时的锚点，|回跳量| 达数百 px → FAIL' } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r4fx-fc5.md', content: DOC_FC5, open: { minBlocks: 3, settleMs: 1600 }, cases: [['FC5回焦重画合成光标', caseFC5]] },
  { doc: 'r4fx-fc6.md', content: DOC_FC6, open: { minBlocks: 2, settleMs: 1400 }, cases: [['FC6表情面板Esc收起', caseFC6]] },
  { doc: 'r4fx-mw4.md', content: DOC_MW4, open: { minBlocks: 8, settleMs: 1800 }, cases: [['MW4拖分隔条后预览变更不回跳', caseMW4]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => { const key = name.toLowerCase().slice(0, 3); return !only.length || only.includes(key) || only.includes(name.toLowerCase()); };
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R4FX ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r4-focus', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let passed = 0, failed = 0;
  try {
    for (const group of GROUPS) {
      const todo = group.cases.filter(([name]) => want(name));
      if (!todo.length) continue;
      const file = path.join(OUT, group.doc);
      fs.writeFileSync(file, group.content, 'utf8');
      console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { ...group.open, inspect: true });   // 每用例独立实例
        const installed = await session.js(INSTALL);
        if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session) || {};
            report(name, outcome.verdict || 'FAIL', outcome.detail || {});
            if (outcome.verdict === 'PASS') passed += 1; else failed += 1;
          } catch (error) {
            report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
            failed += 1;
          }
        }
      } catch (error) {
        console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
        for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
      } finally {
        if (session) await ctx.release(session);     // 释放实例（单 GUI 串行，端口让出来再开下一组）
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r4-focus 失败：', error); process.exit(1); });
