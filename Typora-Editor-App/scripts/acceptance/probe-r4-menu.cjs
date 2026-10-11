/** 探针 · 第 4 轮 FC/RC 节（右键菜单/焦点浮层域）修复验收（2026-10-02，probe-r4-menu）。
 *
 *  对应修复（extension-src/render/js/media-tools.js，npm run sync 后 = app/renderer）：
 *   FC1  图片设置对话框关闭还原焦点/选区（照抄同族五弹窗的 previousFocus+savedRange 模式）。
 *   FC2/RC4 菜单级关闭通道：菜单 keydown 只处理 Esc（关+还焦）；focusout/编辑面滚动(scroll
 *        捕获)关；关后焦点选区还原；持焦期间 Ctrl+F/Ctrl+H 关菜单+还焦后**原样重放**，
 *        查找面板才开得了（它的窗口级监听只认"事件目标在编辑面里"）。
 *   FC3  setImageAlign 无变化早退补 selectRange 还原；"复制表格到 Excel"完成后还焦。
 *   RC1  菜单通用动作（复制/剪切/粘贴）改为**动作时刻**重读选区：在编辑面内且非整篇形态
 *        才用；右键不可编辑岛时 Blink 的"整篇假选区"被补光标折叠点顶掉。
 *   RC2  右键(button2)不再清图片选中态；菜单复制/剪切在图片选中态非空时走
 *        mediaRequest('copy-images') 图片通道（剪切=复制确认后 deleteImages）。
 *   RC3  tableRectangle 端点任一不在表内返回 null——"文段+表"混合选区不再被劫成整表。
 *   RC5  右键补光标爬升遇 td/th 先落**格边界**（格内公式右键光标不再搬到整表之前）。
 *   RC7  链接右键菜单：打开链接（handler 'openLink' 通道，宿主侧 shell.openExternal/
 *        openPath）/复制链接地址（系统剪贴板两通道 + 页内带 dataTransfer 的合成 copy 事件）。
 *   RC8  右键落 table 本体回退 **contextmenu 坐标最近格**（不再静默钉第 0 行删表头）；
 *        最近格也无解时禁用表结构项。
 *
 *  每用例一行：R4M<N> <名> PASS/FAIL/EVIDENCE {关键读数 JSON}，附整页 + 关键处 2x 截图
 *  （.perf/probe-r4-menu/）。截图标记口径沿用 r1/r2/r3：红实线=光标落点、琥珀虚线=期望位、
 *  青虚线=击点。CDP 抓帧拍不到原生光标，按浏览器自报矩形画标记。
 *
 *  通道纪律（本轮铁律）：
 *   · **不用系统剪贴板**：复制类断言只读 window 内 copy 事件——探针包住
 *     clipboardData.setData 记录产品写入侧（copy 事件里 getData 只给空串）；未被接管的原生
 *     复制不调 setData，改记**事件时刻的 selection.toString()**（原生 text/plain 的序列化
 *     来源，窗口内可见）。media-command(copy-images/copy-table) 在 iframe 内拦截并直接
 *     回执 media-result（剪贴板隔离：不进宿主、不跑 PowerShell）；openLink 同样拦截记录
 *     （不真开系统浏览器）。
 *   · 输入一律真实通道：CDP Input.dispatchKeyEvent/dispatchMouseEvent/insertText/
 *     mouseWheel；组合键走 hi.combo（修饰键真实按下再抬起）。
 *   · 素材全部现场生成（含现场 PNG），不碰受保护素材；每用例独立实例，结束即释放。
 *   · 粘贴类动作用 execCommand('paste')/宿主读贴的真实行为，断言只看"落点不在文档头"，
 *     不读剪贴板内容。
 *
 *  红条件（突变点，逐条对应）：
 *   FC1 注掉 imageDialog finish 的还焦/还选 → R4M 红（Esc 后打字丢失）。
 *   FC2 注掉菜单 Esc 分支或 scroll 监听 → 红；注掉 Ctrl+F 重放 → 查找不开。
 *   FC3 注掉 setImageAlign 早退的 selectRange / copy-table 的 finally restoreFromMenu → 红。
 *   RC1 liveRange 退回打开时快照 saved → 红（剪切删全文/复制得全文/粘贴插文档头）。
 *   RC2 mousedown 恢复无条件 clearImageSelection → 高亮丢；菜单复制退回文本路径 → 无 copy-images。
 *   RC3 tableBoundary 恢复 {}（撑全表）→ 红（载荷被劫成整表 TSV，没有文段）。
 *   RC5 注掉 td/th 优先分支 → 红（光标在整表之前的块边界）。
 *   RC7 注掉链接菜单段 → 红。
 *   RC8 nearestTableCell 退回 Math.max(0,indexOf) 钉第 0 行 → 红（删掉的是表头）。
 *
 *  用法：node scripts/acceptance/probe-r4-menu.cjs [--only=fc1,fc2,fc3,rc1,rc2,rc3,rc5,rc7,rc8]
 *        （--only 大小写不敏感；跑前先 `npm run sync`；dev 模式默认拉开发树，--installed
 *          拉安装版。铁律 3：单 GUI 串行，不与其它探针并行。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r4-menu');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;
const S = hi.SURFACE;
const sleep = harness.sleep;
const LOG = [];
const say = value => {
  const line = typeof value === 'string' ? value : JSON.stringify(value);
  LOG.push(line);
  console.log(line);
};

// ─── 现场小图（与 probe-rightclick-targets 同一造法，纯 ASCII PNG） ─────────────
const crcTable = (() => { const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, checksum]);
};
const makePng = (width, height, rgb) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) { raw[row + 1 + x * 3] = rgb[0]; raw[row + 2 + x * 3] = rgb[1]; raw[row + 3 + x * 3] = rgb[2]; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
};

// ─── 文档（全部现场生成；文件名/参数全 ASCII，中文只出现在文件内容里） ──────────
const DOC_FC1 = ['# R4M FC1 图片设置还焦', '', 'FC1前置段落，点击下面的图片。', '', '![fc1](fc1.png)', '', 'FC1后置段落。', ''].join('\n');
const DOC_FC2 = (() => {
  const parts = ['# R4M FC2 菜单关闭通道', ''];
  for (let i = 1; i <= 90; i++) {
    parts.push(i === 45 ? 'FC2靶段：右键目标行就在这里，滚动关闭也要滚过它。' : 'FC2段落' + String(i).padStart(2, '0') + '：常态正文，把文档撑到必须滚动。');
    parts.push('');
  }
  return parts.join('\n');
})();
const DOC_FC3 = ['# R4M FC3 动作后还焦', '', 'FC3段落一。', '', '![fc3](fc3.png)', '', '| FC3头甲 | FC3头乙 |', '| --- | --- |', '| FC3行1甲 | FC3行1乙 |', '', 'FC3尾段。', ''].join('\n');
const DOC_RC1 = ['# R4M RC1 岛右键动作局部性', '', 'RC1前置文字若干，用来对照全文长度。', '', '$$', 'RC1EQ=mc^2', '$$', '', 'RC1后置文字若干。', '', 'RC1尾部段落：再加两行正文把全文拉长，让「复制得全文」在长度比对上无可辩驳。', ''].join('\n');
const DOC_RC2 = ['# R4M RC2 图片选中保持', '', 'RC2前置段落，点选下图后右键。', '', '![rc2](rc2.png)', '', 'RC2后置段落。', ''].join('\n');
const DOC_RC3 = ['# R4M RC3 混合选区复制', '', 'RC3甲文段起点，从这里开始选进表格。', '', '| RC3表头甲 | 表头乙 |', '| --- | --- |', '| RC3乙格内容 | 二格 |', '| RC3第二行 | 又一格 |', '', 'RC3尾部段落。', ''].join('\n');
const DOC_RC5 = ['# R4M RC5 格内岛右键光标', '', 'RC5前置段落。', '', '| RC5格甲 $q_1$ 续文 | RC5格乙 |', '| --- | --- |', '| RC5次行甲 | RC5次行乙 |', '', 'RC5尾部段落。', ''].join('\n');
const DOC_RC7 = ['# R4M RC7 链接菜单', '', 'RC7正文，这里是[RC7链接文字](https://r4.example.com/path)以及后续文字。', ''].join('\n');
const DOC_RC8 = ['# R4M RC8 表本体右键最近格', '', 'RC8前置段落。', '', '| RC8头 | 乙 |', '| --- | --- |', '| RC8行1 | 一 |', '| RC8行2 | 二 |', '', 'RC8尾部段落。', ''].join('\n');
const HEAD_RC1 = '# R4M RC1 岛右键动作局部性';

// ─── 页内工具（装进编辑器 iframe；本串内不出现反引号与 "${"） ─────────────────
const HELPERS = `window.__r4m = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  const layerOf = at => !at ? '外'
    : at.closest('code[data-type]') ? '源码'
    : at.closest('.vditor-ir__preview,[contenteditable="false"]') ? '预览'
    : at.closest('[data-type$="-marker"],.vditor-ir__marker') ? '围栏' : '正文';
  const blockIndexOf = at => { const root = surface(); let n = at;
    while (n && n.parentElement && n.parentElement !== root) n = n.parentElement;
    return n && n.parentElement === root ? [...root.children].indexOf(n) : -1; };
  const caret = () => {
    const root = surface(), s = getSelection();
    if (!root || !s || !s.rangeCount) return { ok: false };
    const r = s.getRangeAt(0);
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const inEditor = !!(at && root.contains(at));
    const cell = at && at.closest ? at.closest('td,th') : null;
    const box = r.getBoundingClientRect();
    return { ok: inEditor, 块: inEditor ? blockIndexOf(at) : -1, 层: layerOf(at),
      前缀: r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 16), r.startOffset) : '',
      折叠: r.collapsed, 选区长: s.toString().length, 选区: s.toString().slice(0, 50),
      格: cell ? String(cell.textContent).replace(/\\s+/g, ' ').slice(0, 24) : null,
      x: Math.round(box.left), y: Math.round(box.top), h: Math.round(box.height),
      焦点: document.hasFocus() ? String(document.activeElement.tagName) + '.' + String(document.activeElement.className).slice(0, 26) : null };
  };
  const menuInfo = () => {
    const menu = document.getElementById('typora-editor-context-menu');
    if (!menu) return { present: false };
    const buttons = [...menu.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect();
      return { action: b.dataset.action || null, label: String(b.textContent).trim(), disabled: !!b.disabled,
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; });
    return { present: true, actions: buttons.map(b => b.action), disabled: buttons.filter(b => b.disabled).map(b => b.action),
      buttons: buttons, focused: document.activeElement === menu };
  };
  const dialogInfo = () => { const d = document.getElementById('typora-image-settings');
    const r = d ? d.getBoundingClientRect() : null;
    return { present: !!d, open: !!(d && d.open), value: d && d.querySelector('input') ? d.querySelector('input').value : null,
      x: r ? Math.round(r.x + 40) : null, y: r ? Math.round(r.y + 40) : null }; };
  const findInfo = () => ({ present: !!document.getElementById('typora-find') });
  const pointOf = selector => {
    const node = document.querySelector(selector);
    if (!node) return { ok: false, reason: 'not-found:' + selector };
    try { node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
    const r = node.getBoundingClientRect();
    const x = Math.round(r.x + Math.min(r.width / 2, 400));
    const y = Math.round(r.y + Math.min(r.height / 2, 80));
    const hit = document.elementFromPoint(x, y);
    const chain = []; for (let n = hit; n && chain.length < 5; n = n.parentElement)
      chain.push(n.tagName + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''));
    return { ok: true, x, y, w: Math.round(r.width), h: Math.round(r.height), hitChain: chain,
      text: String(node.textContent || '').replace(/\\s+/g, ' ').slice(0, 24) };
  };
  const mark = list => { const old = document.getElementById('__r4m_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div'); layer.id = '__r4m_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const item of list) { const h = item.h || 18;
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;height:' + h + 'px;width:0;border-left:2px ' + (item.dash ? 'dashed' : 'solid') + ' ' + (item.color || '#ff2d2d') + ';box-shadow:0 0 0 1px rgba(255,255,255,.55)';
      layer.append(bar);
      if (item.label) { const tag = document.createElement('span');
        tag.style.cssText = 'position:fixed;left:' + (Math.round(item.x) + 4) + 'px;top:' + Math.round(item.y - 15) + 'px;font:11px sans-serif;color:' + (item.color || '#ff2d2d') + ';background:rgba(255,255,255,.82);padding:0 3px;white-space:nowrap';
        tag.textContent = item.label; layer.append(tag); } }
    document.body.append(layer); return list.length; };
  const unmark = () => { const old = document.getElementById('__r4m_marks'); if (old) old.remove(); return 1; };
  const reset = () => { window.__r4m.copies.length = 0; window.__r4m.emits.length = 0; return 1; };
  return { caret: caret, menuInfo: menuInfo, dialogInfo: dialogInfo, findInfo: findInfo,
    pointOf: pointOf, mark: mark, unmark: unmark, reset: reset, copies: [], emits: [] };
})();
// copy 记录器：包住 clipboardData.setData 记录产品写入侧（copy 事件里 getData 只给空串）；
// 未被接管的原生复制不调 setData——补记事件时刻的 selection 文本（原生 text/plain 的
// 序列化来源），两条证据都不出窗口。
document.addEventListener('copy', event => {
  const record = { prevented: event.defaultPrevented, plain: null, html: null, synthetic: !!event.__typoraLinkCopy };
  try { const s = getSelection(); record.selectionText = s && s.rangeCount ? s.toString().slice(0, 400) : ''; } catch (e) { record.selectionText = ''; }
  try { const cd = event.clipboardData;
    if (cd) { const set = cd.setData.bind(cd);
      cd.setData = (type, value) => { if (type === 'text/plain') record.plain = String(value);
        if (type === 'text/html') record.html = String(value).slice(0, 400);
        try { return set(type, value); } catch (e) { return true; } };
      // 合成事件（__typoraLinkCopy）的载荷在**构造前**就 setData 了，wrap 追不到——
      // 直接 getData 读回（同一份 DataTransfer，非系统剪贴板，窗口内可见）。
      if (event.__typoraLinkCopy) { try { const got = cd.getData('text/plain');
        if (got != null && got !== '') record.plain = got; } catch (e) {} } } } catch (e) { record.err = String(e); }
  if (window.__r4m) window.__r4m.copies.push(record);
}, true);
// handler 隔离：media-command(copy-images/copy-table) 不进宿主、直接回执 media-result
// （剪贴板隔离）；openLink 只记录不真开浏览器。其余消息原样放行。
(() => {
  if (!window.handler || window.__r4mHandlerWrapped) return;
  const original = window.handler.emit.bind(window.handler);
  window.__r4mHandlerWrapped = true;
  window.handler.emit = function (channel, payload) {
    try { window.__r4m.emits.push({ channel: String(channel),
      action: payload && payload.action ? String(payload.action) : null,
      id: payload && payload.id ? payload.id : null,
      items: payload && payload.items ? payload.items.length : null,
      url: channel === 'openLink' ? String(payload) : null }); } catch (e) {}
    if (channel === 'media-command' && payload && (payload.action === 'copy-images' || payload.action === 'copy-table')) {
      const id = payload.id;
      setTimeout(() => { try { window.dispatchEvent(new MessageEvent('message',
        { data: { type: 'media-result', content: { id: id, ok: true, cancelled: false } } })); } catch (e) {} }, 40);
      return undefined;
    }
    if (channel === 'openLink') return undefined;
    return original(channel, payload);
  };
})();`;

// 注入与求值（字符串拼接而非反引号插值：HELPERS/表达式不进 validate-probe-expr 的模板
// 审计域也能完整构造；frameOf/scrollTop 保持可审计的纯 IIFE 模板）。
const INSTALL = "(() => { const w = " + IF + ";"
  + " if (!w || !w.document.querySelector(" + JSON.stringify(S) + ")) return { ok: false };"
  + " if (!w.__r4m) w.eval(" + JSON.stringify(HELPERS) + ");"
  + " return { ok: !!w.__r4m, handlerWrapped: !!w.__r4mHandlerWrapped }; })()";
const IN = expression => "(() => { const w = " + IF + "; return w.eval(" + JSON.stringify(expression) + "); })()";
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const scrollTop = session => session.js(`(() => { const w = ${IF};
  const s = w.document.querySelector('.vditor-ir .vditor-reset');
  return s ? Math.round(s.scrollTop) : -1; })()`);
/** 滚动读数（FC2 实测定标）：IR 的滚动容器就是 .vditor-ir .vditor-reset 这一个 PRE
 *  （sh 3879 / ch 713，滚轮后 st 实增 1050）——注意必须**带 .vditor-ir 作用域**：
 *  裸 querySelector('.vditor-reset') 会命中别的模式容器里 0×0 的隐藏同名元素，读出
 *  恒 0（首轮"滚动量 0"的真因）。取 scrollTop 与 -rect.top 的最大值，哪层动都算。 */
const scrollLayer = session => session.js(`(() => { const w = ${IF};
  const s = w.document.querySelector('.vditor-ir .vditor-reset');
  if (!s) return -1; const r = s.getBoundingClientRect();
  return Math.max(Math.round(s.scrollTop), Math.round(-r.top)); })()`);
const focusRead = session => session.js(hi.FOCUS);
const clearSelection = session => ev(session, '(() => { getSelection().removeAllRanges(); return true; })()');

// 用例专属的大表达式（模块级常量：selfcheck 一并校验语法）。
const FC2_ANCHOR = '(() => { const ps = [...document.querySelectorAll("p")];'
  + ' const hit = ps.find(p => p.textContent.includes("FC2靶段")); if (!hit) return { ok: false };'
  + ' hit.scrollIntoView({ block: "center", behavior: "instant" });'
  + ' const r = hit.getBoundingClientRect();'
  + ' return { ok: true, x: Math.round(r.x + Math.min(r.width / 2, 380)), y: Math.round(r.y + r.height / 2), text: hit.textContent.slice(0, 18) }; })()';
const RC5_POINT = '(() => { const k = document.querySelector("td .katex, th .katex");'
  + ' if (!k) return { ok: false, reason: "not-found" };'
  + ' k.scrollIntoView({ block: "center", behavior: "instant" });'
  + ' const r = k.getBoundingClientRect();'
  + ' return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),'
  + '   cellText: String(k.closest("td,th").textContent).replace(/\\s+/g, " ").slice(0, 24) }; })()';
const RC5_STATE = '(() => { const k = document.querySelector("td .katex, th .katex");'
  + ' const formulaCell = k.closest("td,th"); const s = getSelection();'
  + ' const r0 = s && s.rangeCount ? s.getRangeAt(0) : null;'
  + ' const at = r0 ? (r0.startContainer.nodeType === 3 ? r0.startContainer.parentElement : r0.startContainer) : null;'
  + ' const caretCell = at && at.closest ? at.closest("td,th") : null;'
  + ' const root = document.querySelector(".vditor-ir .vditor-reset");'
  + ' return { inSameCell: caretCell === formulaCell, collapsed: !!(s && s.rangeCount && s.isCollapsed),'
  + '   inEditor: !!(at && root.contains(at)), caretCellText: caretCell ? String(caretCell.textContent).replace(/\\s+/g, " ").slice(0, 24) : null }; })()';
const RC7_CANDIDATES = '(() => { const root = document.querySelector(".vditor-ir .vditor-reset");'
  + ' const all = [...document.querySelectorAll("a[href], .vditor-ir__node[data-type=\\"a\\"], .vditor-ir__marker--link")]'
  + '   .filter(n => root.contains(n));'
  + ' return all.map(n => { const r = n.getBoundingClientRect();'
  + '   return { tag: n.tagName, cls: String(n.className).slice(0, 28), href: n.getAttribute("href"),'
  + '     text: String(n.textContent).trim().slice(0, 28), w: Math.round(r.width), h: Math.round(r.height),'
  + '     x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })'
  + '   .filter(item => item.w > 4 && item.h > 8); })()';
const RC8_SCAN = '(() => { const t = document.querySelector("table");'
  + ' if (!t) return { ok: false };'
  + ' t.scrollIntoView({ block: "center", behavior: "instant" });'
  + ' const r = t.getBoundingClientRect(); const rows = [...t.rows];'
  + ' const keyOf = row => ["RC8头", "RC8行1", "RC8行2"].find(k => row.textContent.includes(k)) || String(row.textContent).trim().slice(0, 8);'
  + ' const nearestRow = y => { let best = null, bestD = 1e9;'
  + '   for (const row of rows) { const rr = row.getBoundingClientRect();'
  + '     const d = Math.abs((rr.y + rr.height / 2) - y); if (d < bestD) { bestD = d; best = keyOf(row); } }'
  + '   return best; };'
  + ' const spots = [];'
  + ' for (const edge of ["top", "bottom", "left", "right"]) {'
  + '   for (let i = 1; i <= 24; i++) {'
  + '     const fx = r.x + (edge === "left" ? i : edge === "right" ? r.width - i : (r.width * i) / 24);'
  + '     const fy = r.y + (edge === "top" ? i : edge === "bottom" ? r.height - i : (r.height * i) / 24);'
  + '     const hit = document.elementFromPoint(Math.round(fx), Math.round(fy));'
  + '     if (hit === t) spots.push({ x: Math.round(fx), y: Math.round(fy), edge: edge, expect: nearestRow(fy) }); } }'
  + ' return { ok: true, w: Math.round(r.width), h: Math.round(r.height), rows: rows.length,'
  + '   rowKeys: rows.map(keyOf), tableOwned: spots, tableOwnedCount: spots.length }; })()';
const RC8_LAST_CELL = '(() => { const t = document.querySelector("table");'
  + ' const cell = t.rows[t.rows.length - 1].cells[0]; const r = cell.getBoundingClientRect();'
  + ' return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: String(cell.textContent).trim() }; })()';
const IMG_SELECTED = prefix => '(() => { const i = document.querySelector("' + (prefix || '') + 'img");'
  + ' return { selected: !!i && i.classList.contains("typora-img-selected") }; })()';

// ─── 通用小件 ───────────────────────────────────────────────────────────────────
const strip = text => String(text || '').replace(/\s+/g, '');
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 300),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 65), width: 640, height: 190, scale: 2 };
    if (marks && marks.length) await ev(session, 'window.__r4m.mark(' + JSON.stringify(marks) + ')');
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await ev(session, 'window.__r4m.unmark()');
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}
/** 真实右键（iframe 坐标 point → 顶层页坐标），含预移动与菜单出现等待。 */
async function rightClick(session, frame, point) {
  await session.move(frame.x + point.x, frame.y + point.y);
  await sleep(90);
  await session.click(frame.x + point.x, frame.y + point.y, { button: 'right' });
  await sleep(460);
}
/** 菜单按钮：按 data-action 真实点击。 */
async function clickMenuButton(session, frame, menu, action) {
  const button = menu && menu.buttons && menu.buttons.find(item => item.action === action);
  if (!button) return false;
  await session.click(frame.x + button.x, frame.y + button.y);
  await sleep(440);
  return true;
}

const ctx = {
  launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
    label: 'probe-r4-menu', outDir: path.join(OUT, 'shots'), timeout: 180000, ...options, args: options.args || [] }),
};
let caseCounter = 0;
async function withSession(file, fn) {
  const session = await hi.openDoc(ctx, file, { minBlocks: 2, settleMs: 1600 });
  try {
    const installed = await session.js(INSTALL);
    if (!installed || !installed.ok) throw new Error('观测器没装上：' + JSON.stringify(installed));
    await session.send('Page.bringToFront').catch(() => {});
    return await fn(session);
  } finally {
    if (session.errors && session.errors.length) say('  · console错误（' + path.basename(file) + '）：' + JSON.stringify(session.errors.slice(0, 4)));
    await session.close();
  }
}
function fixture(name, content) {
  fs.writeFileSync(path.join(OUT, name), content, 'utf8');
  return path.join(OUT, name);
}
function report(caseId, name, verdict, detail) {
  say(caseId + ' ' + name + ' ' + verdict + ' ' + JSON.stringify(detail));
}

// ─── R4M1 / FC1：图片设置 Esc 关 → 打字落原处 ───────────────────────────────────
async function caseFC1() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m1.md', DOC_FC1);
  fs.writeFileSync(path.join(OUT, 'fc1.png'), makePng(180, 100, [70, 120, 200]));
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    // R4M1 修正：openDoc 刚落座时 iframe 可能还没接过焦点（首轮实测 focus0 直接 BODY）——
    // 先走 ensureFocus（必要时真实点一下编辑面）再读，最多四轮。这不是被测行为本身。
    let focus0 = await focusRead(session);
    for (let i = 0; i < 4 && !focus0.ok; i++) { await hi.ensureFocus(session); await sleep(320); focus0 = await focusRead(session); }
    if (!focus0.ok) return { verdict: 'FAIL', detail: { 阶段: '初始焦点不在编辑器（ensureFocus×4 后仍不中）', focus0 } };
    const point = await ev(session, 'window.__r4m.pointOf("img")');
    if (!point || !point.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到图片', point } };
    await session.click(frame.x + point.x, frame.y + point.y);           // 单击选中图片
    await sleep(400);
    const selected = await ev(session, 'window.__r4m.caret()');
    await rightClick(session, frame, point);
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    if (!menu.present) return { verdict: 'FAIL', detail: { 阶段: '右键图片没出菜单', menu } };
    const clicked = await clickMenuButton(session, frame, menu, 'image-settings');
    if (!clicked) return { verdict: 'FAIL', detail: { 阶段: '菜单里没有 图片设置…', menu } };
    await sleep(440);
    const dialog = await ev(session, 'window.__r4m.dialogInfo()');
    if (!dialog.open) return { verdict: 'FAIL', detail: { 阶段: '图片设置对话框没打开', dialog } };
    await shots(session, frame, id + '-对话框', { x: dialog.x, y: dialog.y }, []);
    await hi.press(session, 'Escape');                                    // 真实 Esc 关对话框
    await sleep(500);
    const dialogAfter = await ev(session, 'window.__r4m.dialogInfo()');
    const menuAfter = await ev(session, 'window.__r4m.menuInfo()');
    const focus1 = await focusRead(session);
    const beforeType = await hi.mdNow(session);
    await session.type('Z');                                              // 打字：落点检验
    await sleep(540);
    const afterType = await hi.mdNow(session);
    const caretAfter = await ev(session, 'window.__r4m.caret()');
    await shots(session, frame, id + '-Esc后打字', caretAfter.ok ? caretAfter : point,
      [{ x: caretAfter.x, y: caretAfter.y, h: caretAfter.h || 18, color: '#ff2d2d', label: '光标' }]);
    const headIntact = strip(afterType).startsWith(strip('# R4M FC1 图片设置还焦'));
    const pass = !dialogAfter.present && !menuAfter.present && focus1.ok && afterType.includes('Z') && headIntact;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      对话框关: !dialogAfter.present, 菜单关: !menuAfter.present, 焦点回编辑面: focus1.ok,
      活动元素: focus1.active, 打字Z入文: afterType.includes('Z'), 文档头未变: headIntact,
      打字前长: strip(beforeType).length, 打字后长: strip(afterType).length, 打字后光标: caretAfter,
      红条件: '注掉 imageDialog finish 的还焦还选后：焦点掉 body、Z 不进文档（长度不变）' } };
  });
  report(id, 'FC1图片设置Esc还焦', outcome.verdict, outcome.detail);
}

// ─── R4M2 / FC2：右键 → Esc 关菜单+Ctrl+F 可开；滚动关菜单 ─────────────────────
async function caseFC2() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m2.md', DOC_FC2);
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    const anchor = await ev(session, FC2_ANCHOR);
    if (!anchor || !anchor.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到靶段', anchor } };
    await rightClick(session, frame, anchor);
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    if (!menu.present) return { verdict: 'FAIL', detail: { 阶段: '右键正文没出菜单', menu } };
    if (!(menu.actions && menu.actions.includes('copy'))) return { verdict: 'FAIL', detail: { 阶段: '菜单里没有通用动作', menu } };
    await shots(session, frame, id + '-菜单持焦', anchor, [{ x: anchor.x, y: anchor.y, h: 18, dash: true, color: '#25d0ff', label: '右键点' }]);
    // ① Esc 关菜单 + 焦点回编辑面
    await hi.press(session, 'Escape');
    await sleep(440);
    const menuAfterEsc = await ev(session, 'window.__r4m.menuInfo()');
    const focusEsc = await focusRead(session);
    // ② Ctrl+F：菜单持焦期间按下 → 菜单应关掉并把查找打开（关+还焦+原样重放）
    await rightClick(session, frame, anchor);
    const menuAgain = await ev(session, 'window.__r4m.menuInfo()');
    if (!menuAgain.present) return { verdict: 'FAIL', detail: { 阶段: '第二次右键没出菜单', menuAgain } };
    await hi.combo(session, 'Ctrl+F');
    await sleep(620);
    const find = await ev(session, 'window.__r4m.findInfo()');
    const menuAfterFind = await ev(session, 'window.__r4m.menuInfo()');
    await shots(session, frame, id + '-CtrlF后', { x: anchor.x, y: 50 }, []);
    await hi.press(session, 'Escape');                                    // 关查找面板
    await sleep(380);
    // ③ 滚动关菜单：再右键一次，然后真实滚轮
    await rightClick(session, frame, anchor);
    const menu2 = await ev(session, 'window.__r4m.menuInfo()');
    const scrollBefore = await scrollLayer(session);
    // 滚轮修正（参照 r1-caret C6 的三棘轮实测：单发大 delta 会被命中目标/平滑滚动吞掉，
    // 滚动量读成 0）：改真人形状——3 棘轮 × 350px、间隔 140ms，打在靶段文字上（不是
    // 空白/空段），坐标夹进 iframe 视口（滚出视口的点 CDP 直接丢）。
    const view = await ev(session, '(() => ({ h: window.innerHeight }))()');
    const wheelY = Math.max(20, Math.min((view && view.h ? view.h : 400) - 20, anchor.y - 40));
    for (let i = 0; i < 3; i++) { await session.wheel(frame.x + anchor.x, frame.y + wheelY, 350); await sleep(140); }
    await sleep(600);
    const menuAfterWheel = await ev(session, 'window.__r4m.menuInfo()');
    const focusWheel = await focusRead(session);
    const scrollAfter = await scrollLayer(session);
    await shots(session, frame, id + '-滚动后', anchor, []);
    const pass = !menuAfterEsc.present && focusEsc.ok && find.present && !menuAfterFind.present
      && menu2.present && !menuAfterWheel.present && scrollAfter > scrollBefore;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      菜单持焦: menu.focused, Esc后菜单关: !menuAfterEsc.present, Esc后焦点回: focusEsc.ok,
      CtrlF时菜单开着: menuAgain.present, CtrlF开后: find.present, CtrlF后菜单已关: !menuAfterFind.present,
      再右键出菜单: menu2.present, 滚动后菜单关: !menuAfterWheel.present,
      滚动量: scrollAfter - scrollBefore, 滚动后焦点: focusWheel.ok ? '编辑面' : focusWheel.active,
      红条件: '注掉菜单 Esc 分支→Esc后菜单仍在；注掉 Ctrl+F 重放→find.present=false；注掉 scroll 监听→滚动后菜单仍在' } };
  });
  report(id, 'FC2菜单关闭通道', outcome.verdict, outcome.detail);
}

// ─── R4M3 / FC3：对齐无变化早退还焦；复制表格完成后还焦 ────────────────────────
async function caseFC3() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m3.md', DOC_FC3);
  fs.writeFileSync(path.join(OUT, 'fc3.png'), makePng(150, 90, [90, 60, 160]));
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    const point = await ev(session, 'window.__r4m.pointOf("img")');
    if (!point || !point.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到图片', point } };
    // 第一次点"居中"：把图源写成完整 <img …> 形态（真实变更，走 commitImageEdit）。
    await rightClick(session, frame, point);
    const menu0 = await ev(session, 'window.__r4m.menuInfo()');
    if (!menu0.present) return { verdict: 'FAIL', detail: { 阶段: '右键图片没出菜单', menu0 } };
    await clickMenuButton(session, frame, menu0, 'image-align-center');
    await sleep(820);                                                     // 等 setValue/reconcile 落定
    // 第二次点"居中"：源码已含同样属性 → selected===replacement，走 FC3 的无变化早退分支。
    const point2 = await ev(session, 'window.__r4m.pointOf("img")');
    await rightClick(session, frame, point2);
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    const centerButton = menu.buttons && menu.buttons.find(item => item.action === 'image-align-center');
    if (!centerButton) return { verdict: 'FAIL', detail: { 阶段: '菜单里没有居中对齐项', menu } };
    await clickMenuButton(session, frame, menu, 'image-align-center');
    await sleep(480);
    const focusA = await focusRead(session);
    const beforeType = await hi.mdNow(session);
    await session.type('Q');                                              // 早退后打字必须入文
    await sleep(540);
    const afterType = await hi.mdNow(session);
    const typedLanded = afterType.includes('Q');
    await shots(session, frame, id + '-对齐无变化后打字', point2, [{ x: point2.x, y: point2.y, h: 22, dash: true, color: '#25d0ff', label: '图' }]);
    // 复制表格到 Excel：隔离回执后，焦点/选区还给正文
    await ev(session, 'window.__r4m.reset()');
    const cell = await ev(session, 'window.__r4m.pointOf("td")');
    if (!cell || !cell.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到表格', cell } };
    await rightClick(session, frame, cell);
    const menu2 = await ev(session, 'window.__r4m.menuInfo()');
    const clicked = await clickMenuButton(session, frame, menu2, 'copy-table');
    if (!clicked) return { verdict: 'FAIL', detail: { 阶段: '菜单里没有 复制表格', menu2 } };
    await sleep(780);                                                     // 等隔离回执 + finally 还焦
    const focusB = await focusRead(session);
    const emits = await ev(session, 'window.__r4m.emits');
    const mediaSeen = emits.some(item => item.channel === 'media-command' && item.action === 'copy-table');
    await shots(session, frame, id + '-复制表格后', cell, [{ x: cell.x, y: cell.y, h: 18, dash: true, color: '#f0a020', label: '期望焦点区' }]);
    const pass = focusA.ok && typedLanded && focusB.ok && mediaSeen;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      对齐无变化后焦点回: focusA.ok, 打字Q入文: typedLanded, 打字前后长: [strip(beforeType).length, strip(afterType).length],
      复制表格走了media通道: mediaSeen, 复制表格后焦点回: focusB.ok, 活动元素: focusB.active,
      红条件: '注掉 setImageAlign 早退的 selectRange / copy-table 的 finally restoreFromMenu 后：activeElement 掉到 BODY，打字丢失' } };
  });
  report(id, 'FC3动作后还焦', outcome.verdict, outcome.detail);
}

// ─── R4M4 / RC1：右键公式岛 → 菜单剪切只删局部、复制 data 非全文、粘贴不落文档头 ─
async function caseRC1() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m4.md', DOC_RC1);
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    await clearSelection(session);                                        // 「编辑区没有选区」前置
    const value0 = await hi.mdNow(session);
    const len0 = strip(value0).length;
    const point = await ev(session, 'window.__r4m.pointOf("[data-type=\\"math-block\\"] .katex")');
    if (!point || !point.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到块公式岛', point } };
    await rightClick(session, frame, point);
    await sleep(320);                                                     // 等补光标 setTimeout(0) 落地
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    if (!menu.present) return { verdict: 'FAIL', detail: { 阶段: '右键公式岛没出菜单', menu } };
    // ① 菜单剪切：绝不能删全文
    await clickMenuButton(session, frame, menu, 'cut');
    await sleep(860);
    const value1 = await hi.mdNow(session);
    const cutLocal = value1.includes('RC1EQ') && strip(value1).length >= len0 * 0.9;
    // ② 菜单复制：copy 事件载荷绝不能是全文（写入侧 plain 或原生 selectionText 双口径）
    await ev(session, 'window.__r4m.reset()');
    await rightClick(session, frame, point);
    await sleep(440);
    const menu2 = await ev(session, 'window.__r4m.menuInfo()');
    await clickMenuButton(session, frame, menu2, 'copy');
    await sleep(640);
    const copies = await ev(session, 'window.__r4m.copies');
    const fullLen = strip(await hi.mdNow(session)).length;
    const copyNotWhole = copies.every(record => Math.max((record.plain || '').length, (record.selectionText || '').length) < fullLen * 0.4);
    // ③ 菜单粘贴：落点绝不能在文档头（头部一字不变）
    await rightClick(session, frame, point);
    await sleep(440);
    const menu3 = await ev(session, 'window.__r4m.menuInfo()');
    await clickMenuButton(session, frame, menu3, 'paste');
    await sleep(960);
    const value3 = await hi.mdNow(session);
    const headIntact = strip(value3).startsWith(strip(HEAD_RC1));
    const caretAfter = await ev(session, 'window.__r4m.caret()');
    await shots(session, frame, id + '-粘贴后', caretAfter.ok ? caretAfter : point,
      [{ x: caretAfter.x, y: caretAfter.y, h: caretAfter.h || 18, color: '#ff2d2d', label: '光标' },
       { x: point.x, y: point.y, h: 20, dash: true, color: '#f0a020', label: '岛旁期望位' }]);
    const pass = cutLocal && copyNotWhole && headIntact;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      剪切前长度: len0, 剪切后长度: strip(value1).length, 剪切只局部: cutLocal, 公式仍在: value1.includes('RC1EQ'),
      复制事件数: copies.length, 复制载荷长: copies.map(record => [record.plain, record.selectionText].map(v => (v || '').length)),
      全文长: fullLen, 复制非全文: copyNotWhole,
      粘贴后文档头未变: headIntact, 粘贴后长度变化: strip(value3).length - len0, 粘贴后光标: caretAfter,
      红条件: 'liveRange 退回 saved 快照后：剪切删全文（长度骤降）、复制载荷≈全文、粘贴插文档头（头部不再以标题开头）' } };
  });
  report(id, 'RC1岛右键动作局部性', outcome.verdict, outcome.detail);
}

// ─── R4M5 / RC2：点选图 → 右键高亮保持 → 菜单复制走图片通道 ────────────────────
async function caseRC2() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m5.md', DOC_RC2);
  fs.writeFileSync(path.join(OUT, 'rc2.png'), makePng(170, 95, [200, 90, 60]));
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    await ev(session, 'window.__r4m.reset()');
    const point = await ev(session, 'window.__r4m.pointOf("img")');
    if (!point || !point.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到图片', point } };
    await session.click(frame.x + point.x, frame.y + point.y);           // 单击选中
    await sleep(420);
    const afterClick = await ev(session, IMG_SELECTED());
    if (!afterClick.selected) return { verdict: 'FAIL', detail: { 阶段: '单击没有选中图片', afterClick } };
    await rightClick(session, frame, point);                             // 右键同一张图
    await sleep(500);
    const afterRight = await ev(session, '(() => { const i = document.querySelector("img");'
      + ' const menu = document.getElementById("typora-editor-context-menu");'
      + ' return { selected: !!i && i.classList.contains("typora-img-selected"), menu: !!menu }; })()');
    if (!afterRight.menu) return { verdict: 'FAIL', detail: { 阶段: '右键图片没出菜单', afterRight } };
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    await shots(session, frame, id + '-右键后高亮', point, [{ x: point.x, y: point.y, h: 26, color: '#ff2d2d', label: '选中图' }]);
    await clickMenuButton(session, frame, menu, 'copy');                 // 菜单"复制"
    await sleep(860);
    const emits = await ev(session, 'window.__r4m.emits');
    const copies = await ev(session, 'window.__r4m.copies');
    const imageChannel = emits.find(item => item.channel === 'media-command' && item.action === 'copy-images' && item.items >= 1);
    const noTextPayload = copies.every(record => !(record.plain || '').trim());
    await shots(session, frame, id + '-菜单复制后', point, []);
    const pass = afterRight.selected && !!imageChannel && noTextPayload;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      右键后高亮保持: afterRight.selected, 菜单复制走图片通道: !!imageChannel,
      图片通道载荷: imageChannel || null, 文本copy载荷为空: noTextPayload, copies: copies,
      红条件: 'mousedown 恢复无条件 clearImageSelection 后 selected=false；菜单复制退回 execCommand 路径后没有 copy-images 事件' } };
  });
  report(id, 'RC2右键保持图片选中', outcome.verdict, outcome.detail);
}

// ─── R4M6 / RC3：文段+表混合选区复制得混合 ─────────────────────────────────────
async function caseRC3() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m6.md', DOC_RC3);
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    await ev(session, 'window.__r4m.reset()');
    const placed = await session.js(hi.selectFromTo('RC3甲文段起点', 'RC3乙格内容'));
    if (!placed || !placed.ok) return { verdict: 'FAIL', detail: { 阶段: '混合选区没建成', placed } };
    const anchor = await ev(session, 'window.__r4m.pointOf("table")');
    await shots(session, frame, id + '-选区就绪', anchor, []);
    await hi.combo(session, 'Ctrl+C');                                   // 真实 Ctrl+C
    await sleep(560);
    const copies = await ev(session, 'window.__r4m.copies');
    const last = copies[copies.length - 1] || null;
    // 双口径：被接管时读产品写入的 plain；未被接管的原生复制读事件时刻 selection 文本
    // （原生 text/plain 就是选区的字符串序列化）。
    const plain = (last && (last.plain || last.selectionText)) || '';
    const hasParagraph = plain.includes('RC3甲文段起点');
    const hasCell = plain.includes('RC3乙格内容');
    await shots(session, frame, id + '-复制后', anchor, []);
    const pass = !!(last && hasParagraph && hasCell);
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      选区: placed.选区, 被矩形接管: !!(last && last.prevented), 载荷来源: last && last.plain ? 'setData(接管)' : 'selectionText(原生)',
      copy载荷含文段: hasParagraph, copy载荷含表格: hasCell, 载荷前80字: plain.slice(0, 80),
      红条件: 'tableBoundary 恢复 {} 撑全表后：载荷被 preventDefault 成整表 TSV，含表格不含文段（hasParagraph=false）' } };
  });
  report(id, 'RC3混合选区复制', outcome.verdict, outcome.detail);
}

// ─── R4M7 / RC5：格内公式右键光标留格内 ────────────────────────────────────────
async function caseRC5() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m7.md', DOC_RC5);
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    await clearSelection(session);
    const point = await ev(session, RC5_POINT);
    if (!point || !point.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到格内公式', point } };
    await rightClick(session, frame, point);
    await sleep(660);                                                     // 等补光标落地 + 菜单
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    const state = await ev(session, RC5_STATE);
    const caret = await ev(session, 'window.__r4m.caret()');
    await shots(session, frame, id + '-右键后光标', caret.ok ? caret : point,
      [{ x: caret.x, y: caret.y, h: caret.h || 18, color: '#ff2d2d', label: '光标' },
       { x: point.x, y: point.y, h: 18, dash: true, color: '#25d0ff', label: '右键点' }]);
    await hi.press(session, 'Escape');
    await sleep(300);
    const pass = state.inSameCell && state.collapsed && state.inEditor;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      菜单出现: menu.present, 光标在同一格: state.inSameCell, 折叠: state.collapsed, 在编辑面: state.inEditor,
      公式格: point.cellText, 光标所在格: state.caretCellText, 光标: caret,
      红条件: '注掉 td/th 优先分支后：光标被爬升搬到整表之前的块边界（caretCellText=null）' } };
  });
  report(id, 'RC5格内岛右键光标', outcome.verdict, outcome.detail);
}

// ─── R4M8 / RC7：链接右键菜单（打开走 handler 通道 / 复制带 dataTransfer） ──────
async function caseRC7() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m8.md', DOC_RC7);
  const URL = 'https://r4.example.com/path';
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    await ev(session, 'window.__r4m.reset()');
    const candidates = await ev(session, RC7_CANDIDATES);
    // 最自然的手势优先：链接节点壳（罩着链接文字）> A > URL marker
    const target = (candidates || []).find(item => /vditor-ir__node/.test(item.cls))
      || (candidates || []).find(item => item.tag === 'A') || (candidates || [])[0];
    if (!target) return { verdict: 'FAIL', detail: { 阶段: '没找到可右键的链接元素', candidates } };
    const point = { x: target.x, y: target.y };
    await rightClick(session, frame, point);
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    const hasOpen = menu.actions && menu.actions.includes('open-link');
    const hasCopy = menu.actions && menu.actions.includes('copy-link');
    await shots(session, frame, id + '-链接菜单', point, [{ x: point.x, y: point.y, h: 18, dash: true, color: '#25d0ff', label: '右键点' }]);
    // ① 复制链接地址：页内合成 copy 事件的 dataTransfer 必须带上地址（不读系统剪贴板）
    let copyOk = false, copyRecord = null;
    if (hasCopy) {
      await clickMenuButton(session, frame, menu, 'copy-link');
      await sleep(720);
      const copies = await ev(session, 'window.__r4m.copies');
      copyRecord = (copies || []).filter(record => record.synthetic).pop() || null;
      copyOk = !!(copyRecord && copyRecord.plain === URL);
    }
    // ② 打开链接：handler 'openLink' 通道（已拦截，不真开浏览器）
    let openOk = false, openRecord = null;
    if (hasOpen) {
      await rightClick(session, frame, point);
      const menu2 = await ev(session, 'window.__r4m.menuInfo()');
      await clickMenuButton(session, frame, menu2, 'open-link');
      await sleep(560);
      const emits = await ev(session, 'window.__r4m.emits');
      openRecord = (emits || []).filter(item => item.channel === 'openLink').pop() || null;
      openOk = !!(openRecord && openRecord.url === URL);
    }
    await shots(session, frame, id + '-动作后', point, []);
    const pass = hasOpen && hasCopy && copyOk && openOk;
    return { verdict: pass ? 'PASS' : 'FAIL', detail: {
      命中元素: target.tag + '.' + target.cls, 命中文本: target.text, href: target.href,
      菜单含打开链接: hasOpen, 菜单含复制链接: hasCopy,
      复制载荷: copyRecord && { plain: copyRecord.plain, html: (copyRecord.html || '').slice(0, 80) }, 复制正确: copyOk,
      openLink通道: openRecord, 打开正确: openOk,
      红条件: '注掉 showContextMenu 的 link 段后：菜单没有 open-link/copy-link 两项，全红' } };
  });
  report(id, 'RC7链接右键菜单', outcome.verdict, outcome.detail);
}

// ─── R4M9 / RC8：右键落 table 本体 → 坐标最近格（删行删最近行，不再删表头） ────
async function caseRC8() {
  caseCounter += 1;
  const id = 'R4M' + caseCounter;
  const file = fixture('r4m9.md', DOC_RC8);
  const outcome = await withSession(file, async session => {
    const frame = await frameOf(session);
    // 扫 table 盒内"命中元素是 table 本体"的点，并为每个点算出**最近的行键**
    // （RC8 行键 = 每行独有标记：RC8头 / RC8行1 / RC8行2）。
    const scan = await ev(session, RC8_SCAN);
    if (!scan || !scan.ok) return { verdict: 'FAIL', detail: { 阶段: '没找到表格', scan } };
    const value0 = await hi.mdNow(session);
    const anchor = await ev(session, 'window.__r4m.pointOf("table")');
    if (scan.tableOwnedCount > 0) {
      // 真实通路：右键 table 本体 → 菜单表结构项可用 → 删除当前行必须删**离点击点最近的行**
      // （取最靠下的命中点：旧代码在此删表头，判据最强）。
      const spot = scan.tableOwned.reduce((a, b) => (b.y > a.y ? b : a));
      await rightClick(session, frame, spot);
      const menu = await ev(session, 'window.__r4m.menuInfo()');
      if (!menu.present) return { verdict: 'FAIL', detail: { 阶段: '右键表本体没出菜单', menu, scan } };
      const enabled = menu.buttons.find(item => item.action === 'table-delete-row' && !item.disabled);
      if (!enabled) return { verdict: 'FAIL', detail: { 阶段: '表结构项被禁用（不该禁）', menu, scan } };
      await shots(session, frame, id + '-表本体菜单', spot, [{ x: spot.x, y: spot.y, h: 18, dash: true, color: '#25d0ff', label: '表本体右键点' }]);
      await clickMenuButton(session, frame, menu, 'table-delete-row');
      await sleep(1000);
      const value1 = await hi.mdNow(session);
      const deleted = scan.rowKeys.filter(key => !value1.includes(key));
      const headerIntact = value1.includes('RC8头');
      const pass = headerIntact && deleted.length === 1 && deleted[0] === spot.expect;
      await shots(session, frame, id + '-删行后', anchor, []);
      return { verdict: pass ? 'PASS' : 'FAIL', detail: {
        通路: 'table本体命中（' + spot.edge + ' 边）', 命中点: spot, 表结构项可用: !!enabled,
        期望删行: spot.expect, 实际消失行: deleted, 表头仍在: headerIntact,
        红条件: 'nearestTableCell 退回 Math.max(0, indexOf) 后：rowIndex 钉 0，删掉 RC8头（表头）' } };
    }
    // 本主题下 table 本体不可命中（border-collapse 把全部命中都给了单元格）：如实降级
    // EVIDENCE，并验证可命中路径——右键末行格删行删的是末行、表头不动。
    const lastCell = await ev(session, RC8_LAST_CELL);
    await rightClick(session, frame, lastCell);
    const menu = await ev(session, 'window.__r4m.menuInfo()');
    const clicked = await clickMenuButton(session, frame, menu, 'table-delete-row');
    await sleep(1000);
    const value1 = await hi.mdNow(session);
    const lastRowGone = !value1.includes('RC8行2');
    const headerIntact = value1.includes('RC8头');
    await shots(session, frame, id + '-末行右键删行', anchor, [{ x: lastCell.x, y: lastCell.y, h: 18, dash: true, color: '#25d0ff', label: '末行右键点' }]);
    return { verdict: headerIntact && lastRowGone && clicked ? 'EVIDENCE' : 'FAIL', detail: {
      通路: '本主题 table 本体无命中点（tableOwnedCount=0），坐标最近格回退不可达——如实降级',
      可命中路径: { 末行右键删行: lastRowGone, 表头仍在: headerIntact, 表结构项可用: clicked },
      scan: { w: scan.w, h: scan.h, rows: scan.rows, rowKeys: scan.rowKeys },
      红条件: '换带 table padding 的主题后旧代码右键表底删表头；可命中路径突变点：nearestTableCell 返回 null → 恒删第 0 行' } };
  });
  report(id, 'RC8表本体右键最近格', outcome.verdict, outcome.detail);
}

// ─── 模板校验（--selfcheck：不启动产物，只证明每条页内表达式语法成立） ─────────
function selfcheck() {
  const expressions = [
    INSTALL,
    IN('window.__r4m.caret()'),
    IN('window.__r4m.menuInfo()'),
    IN('window.__r4m.dialogInfo()'),
    IN('window.__r4m.findInfo()'),
    IN('window.__r4m.pointOf("img")'),
    IN('window.__r4m.mark([])'),
    IN('window.__r4m.unmark()'),
    IN('window.__r4m.reset()'),
    IN('window.__r4m.emits'),
    IN('window.__r4m.copies'),
    IN('(() => { getSelection().removeAllRanges(); return true; })()'),
    IN('(() => { const i = document.querySelector("img"); return { selected: !!i && i.classList.contains("typora-img-selected") }; })()'),
    IN('(() => { const k = document.querySelector("td .katex"); return { ok: !!k }; })()'),
    IN('(() => { const t = document.querySelector("table"); return { ok: !!t, rows: t ? t.rows.length : 0 }; })()'),
    IN('(() => { const ps = [...document.querySelectorAll("p")]; return ps.length; })()'),
    IN('window.__r4m.pointOf("[data-type=\\"math-block\\"] .katex")'),
    IN(FC2_ANCHOR), IN(RC5_POINT), IN(RC5_STATE), IN(RC7_CANDIDATES), IN(RC8_SCAN), IN(RC8_LAST_CELL), IN(IMG_SELECTED()),
  ];
  const substituted = [
    ...expressions,
    `(() => { const w = ${IF}; const a = w.document.querySelector('.vditor-ir'), b = w.document.querySelector('.vditor-reset');
       return Math.max(a ? a.scrollTop : -1, b ? b.scrollTop : -1); })()`,
    `(() => { const w = ${IF}; const a = w.document.querySelector('.vditor-ir'), b = w.document.querySelector('.vditor-reset');
       const rb = b ? b.getBoundingClientRect() : null;
       return Math.max(a ? Math.round(a.scrollTop) : -1, b ? Math.round(b.scrollTop) : -1,
         rb ? Math.round(-rb.top) : -1, Math.round(w.scrollY || 0)); })()`,
    `(() => { const f = document.getElementById('editor'); const r = f.getBoundingClientRect(); return r.x; })()`,
    hi.FOCUS,
    hi.selectFromTo('甲', '乙'),
    `(() => { const w = ${IF}; try { return w && w.vditor ? w.vditor.getValue() : null; } catch (e) { return 'ERR:' + e.message; } })()`,
  ];
  let bad = 0;
  for (const text of substituted) {
    try { new Function('return (' + String(text).replace(/;\s*$/, '') + ');'); }
    catch (error) { bad++; console.log('模板语法红：' + String(error.message).slice(0, 160) + '\n  ← ' + String(text).slice(0, 160)); }
  }
  try { new Function(HELPERS); } catch (error) { bad++; console.log('HELPERS 语法红：' + error.message); }
  console.log('selfcheck：' + (substituted.length + 1) + ' 条模板，语法红 ' + bad + ' 条');
  return bad === 0;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--selfcheck')) { process.exitCode = selfcheck() ? 0 : 1; return; }
  const only = (() => { const hit = process.argv.find(a => a.startsWith('--only=')); return hit ? hit.slice(7).split(',').map(s => s.trim().toLowerCase()) : null; })();
  const want = name => !only || only.some(key => name.toLowerCase().includes(key));

  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const cases = [
    ['fc1', caseFC1], ['fc2', caseFC2], ['fc3', caseFC3],
    ['rc1', caseRC1], ['rc2', caseRC2], ['rc3', caseRC3],
    ['rc5', caseRC5], ['rc7', caseRC7], ['rc8', caseRC8],
  ];
  let passed = 0, failed = 0, evidenced = 0;
  for (const [key, fn] of cases) {
    if (!want(key)) continue;
    try { await fn(); }
    catch (error) {
      report('R4M*', key.toUpperCase() + '异常', 'FAIL', { 异常: String(error && error.stack || error).slice(0, 400) });
    }
    await sleep(600);
  }
  for (const line of LOG) {
    if (/ PASS /.test(line)) passed += 1;
    else if (/ FAIL /.test(line)) failed += 1;
    else if (/ EVIDENCE /.test(line)) evidenced += 1;
  }
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' / EVIDENCE ' + evidenced + ' ===');
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n'));
})().catch(error => {
  console.error('探针失败：', error && error.stack || error);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n探针失败：' + String(error && error.stack || error));
  process.exit(1);
});
