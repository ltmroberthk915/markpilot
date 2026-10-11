/** 152 · 标题行 Shift+左键拖选：收起态按下不许凭空出现反向选区、扫回起点必须收干净（U-087）
 *
 *  守的是什么：台账 U-087——光标进标题会让 Vditor 给标题块加 `--expand` ⇒ `### ` 记号画出
 *  ⇒ 整行右移并重排换行点；原生 Blink 的"按下点 → 文本偏移"按**按下前**那版版面算，于是在
 *  **记号收起**的标题行"最后一个字符之后"按 Shift+左键，按下瞬间凭空出现 4 字反向选区，
 *  拖回按下点收不掉、抬起后仍残留（r18-u087 A-现象与方案 §2 R1–R4）。修复＝
 *  `patchHeadingShiftDrag`（typora-patches.js）：mousedown 钉固定端 + `preventDefault` 挡
 *  原生错位映射，mousemove 用 `setBaseAndExtent` 增量扩选，mouseup 退出并吞掉本次手势的 click。
 *
 *  【起手前提（复核轮 A1 钉死，违背它量到的是另一条腿）】"收起态起手"必须用**程序化落光标**
 *  造（JS 把折叠选区落到标题末文本节点末尾，本场景 CARET_END）——先真点一下行末会把标题
 *  **当场展开**，补丁按②判据（已展开态无位移、交回原生）**正确地**不接管；那量到的是
 *  已展开态，不是被抱怨的那一发。
 *
 *  判据（全部用户可见）：
 *    ① S1 收起态主腿：Shift+按下帧选区长度=0 且折叠（不许凭空反向选区；原生缺陷形态=4 字）；
 *       首次 mousemove（同点）不塌不跳；沿末行左扫 14 步**单调不减且每步增长 ≤1 字**（按按下后
 *       版面映射）；扫到左端选出实打实一段（≥4 字）；扫回按下点塌空回 0（不残留；原生缺陷
 *       形态=拖回起点仍剩 4 字）；在按下点抬起后选区仍空。
 *    ② 原生不回归：段落 / 列表项 / 引用行 Shift+单击的原地扩选 9/9/8（字位边界允许 8..9；
 *       M6 突变形态=被压成 0）；抬起后不丢、选区文本=该行可见尾部。
 *    ③ R7 已展开态：真点行末（标题已展开）后同手势全程 0 字（补丁按判据不接管、交回原生、
 *       无副作用）。
 *    ④ 帧外焦点腿（f6）：焦点被顶层面板拿走后 Shift+点标题，手势把焦点交回编辑面（iframe
 *       hasFocus 真、活动元素在编辑面内、顶层活动元素=IFRAME），抬起/收键后保持；帧外点击
 *       不许把标题展开（收起态前提仍在）。
 *
 *  通道纪律（E1/E2/E3/E1'，r18-u087 §0.1）：每条手势腿前用主进程通道把窗口拉前台+置顶，
 *  rAF 往返 >120ms 判环境不合格；拖拽的 mouseMoved 全带 `button:'left'`+`buttons:1`；帧内装
 *  记录器记手势期间的 buttons=0 混入移动（真指针掠过窗口，E2）与 blur/visibility 打断（E1'）
 *  ——检出污染且断言未过时**同一手势重跑一发**（产品真缺陷重跑救不了，门不掩盖；本场景
 *  不用 SetCursorPos 钉光标，改用"检出即重跑"达到同等纪律）。Shift 键走真实
 *  dispatchKeyEvent（rawKeyDown/keyUp），坐标全部换算**顶层页坐标**（帧内 rect + frame
 *  offset；CDP 事件打在顶层页上），可见性=DOM 矩形口径。
 *
 *  突变点（复核轮 r18-rev2 §C 的实测口径）：
 *    M1 注掉安装行 `const removeHeadingShiftDrag = patchHeadingShiftDrag(api);` → ① 左扫整段
 *       冻结 `[0×14]`、左端 0 字（"≥4 字"断言红）——接管后的跟手整段消失；
 *    M6 注掉"仅标题宿主"闸（三处一起注）→ ② 段落/列表/引用按下帧被压成 0 字（8..9 断言红）；
 *    M3 注掉 mousedown 的 `preventDefault()` → 在本腿集上**不翻红**（原生错位映射要到第一次
 *       mousemove 才反映到 getSelection，补丁的 setBaseAndExtent 会覆盖回来）——它是必要性的
 *       保险、不是被本门验证过的支点，不写成"必红"。
 *
 *  已知边界（不判红、如实记账）：已展开态交回原生（③只读 0 字无副作用）；IME 组字期
 *  Shift+按下（composingLock 分支）未覆盖；块公式/图片上拖过（f4/IMG/MATHPV）留挂账
 *  （r18-rev2 §B/§H）；边缘自动滚动（f7）不在本门。
 *
 *  证人：geometry（逐帧选区长度序列 / 焦点态 / 记号宽 / 补丁自带桩仅作旁证）。
 *  素材：hi.writeDoc 现场生成到 .perf/human-input/fixtures/，不碰受保护素材房。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../../human-input/hi.cjs');

const H1 = '# 短标题甲';
const H2 = '## 二级标题 $N^2$ 带行内公式的一行';
const H3LONG = '### 三级标题：这是一条很长很长的标题行，长度超过半个屏幕，用来做 Shift 加左键的连续拖选实验，行尾在右边很远的地方';
const PARA = '对照段落：这一段是普通正文，长度与上面那条标题行基本相当，用来做同一手势的对照读数，确认拖选本身在普通段落上是好的。';
const H3MATH = '### 三级标题 含行内公式 $a+b=c$ 与后续正文，长度也足够长，用来观察公式源码会不会被吞进选区';
const LI = '- 列表项：这是一条足够长的列表项文本，用来验证 Shift 加左键的扩选在同一族宿主上的表现，行尾在右边比较远的地方';
const QUOTE = '> 引用行：这是一条足够长的引用块文本，用来验证 Shift 加左键的扩选在同一族宿主上的表现，行尾在右边比较远的地方';
const IMGP = '段落带图片：前面正文一句足够长的话 ![图](adv-img.png) 图片后面的正文也要足够长，用来做跨图片的 Shift 拖选实验。';
const BODY = [H1, '', H2, '', H3LONG, '', PARA, '', H3MATH, '', LI, '', QUOTE, '', IMGP, '', '结尾正文一行。', ''].join('\n');
const IDX = { h1: 0, h2: 1, h3long: 2, para: 3, h3math: 4, li: 5, quote: 6, imgp: 7, tail: 8 };

/** 块几何（全部换算成**顶层页坐标**：CDP Input 用顶层坐标，帧内 rect 要加 frame offset）。
 *  afterLast=末行末字右缘+3px；lineLeft=末行首字左缘+4px；chars=可见正文逐字盒（记号不算）。 */
const GEOM = index => `(() => { const f = document.getElementById('editor'); const fr = f.getBoundingClientRect();
  const w = f.contentWindow, d = w.document, surface = d.querySelector('${hi.SURFACE}');
  const block = surface && surface.children[${index}];
  if (!block) return { ok: false, error: '没有第 ${index} 块' };
  block.scrollIntoView({ block: 'center', behavior: 'instant' });
  const ox = fr.x, oy = fr.y;
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const chars = []; let node, ai = 0;
  while (node = walker.nextNode()) {
    const pe = node.parentElement;
    const marker = !!(pe && pe.closest && pe.closest('[data-type$="-marker"], .vditor-ir__marker'));
    for (let i = 0; i < node.data.length; i++) {
      const r = d.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      const b = r.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      chars.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom, ch: node.data[i], marker, abs: ai + i });
    }
    ai += node.data.length;
  }
  const view = chars.filter(c => !c.marker);
  if (!view.length) return { ok: false, error: '没有可见正文' };
  const last = view[view.length - 1];
  const sameLine = view.filter(c => Math.abs(c.top - last.top) < 4);
  const firstOfLine = sameLine[0];
  const mk = block.querySelector('.vditor-ir__marker--heading');
  let mkBox = null;
  if (mk && mk.firstChild && mk.firstChild.nodeType === 3 && mk.firstChild.length) {
    const r = d.createRange(); r.setStart(mk.firstChild, 0); r.setEnd(mk.firstChild, mk.firstChild.length);
    mkBox = { w: Math.round(r.getBoundingClientRect().width) };
  }
  const y = Math.round(oy + (last.top + last.bottom) / 2);
  return { ok: true, tag: block.tagName, expand: block.classList.contains('vditor-ir__node--expand'),
    lineCount: sameLine.length, mkBox,
    afterLast: { x: Math.round(ox + last.right + 3), y },
    lineLeft: { x: Math.round(ox + firstOfLine.left + 4), y },
    chars: view.map(c => ({ ch: c.ch, x: Math.round(ox + (c.left + c.right) / 2), y: Math.round(oy + (c.top + c.bottom) / 2) })) }; })()`;

/** 程序化落光标：折叠选区落到某块**末文本节点末尾**（不点击 ⇒ 标题不展开，保住"收起态按下"前提）。 */
const CARET_END = index => `(() => { const w = ${hi.IF}, d = w.document, surface = d.querySelector('${hi.SURFACE}');
  const block = surface && surface.children[${index}];
  if (!block) return { ok: false, error: '没有第 ${index} 块' };
  block.scrollIntoView({ block: 'center', behavior: 'instant' });
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const texts = []; let t;
  while (t = walker.nextNode()) {
    const pe = t.parentElement;
    if (pe && pe.closest && pe.closest('[data-type$="-marker"], .vditor-ir__marker')) continue;
    if (t.data.length) texts.push(t);
  }
  const last = texts[texts.length - 1];
  if (!last) return { ok: false, error: '没有正文文本节点' };
  const r = d.createRange(); r.setStart(last, last.data.length); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, 节点长: last.data.length, 折叠: sel.isCollapsed, 展开: block.classList.contains('vditor-ir__node--expand') }; })()`;

/** 前置断言：这个**顶层页坐标**在帧内映射到什么（防坐标错位假读数；坐标先减 frame offset 再进
 *  elementFromPoint/caretRangeFromPoint——这两位吃的是帧内坐标）。 */
const PROBE_POINT = (x, y) => `(() => { const f = document.getElementById('editor'); const fr = f.getBoundingClientRect();
  const w = f.contentWindow, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const fx = ${Math.round(x)} - Math.round(fr.x), fy = ${Math.round(y)} - Math.round(fr.y);
  const el = d.elementFromPoint(fx, fy);
  const r = d.caretRangeFromPoint ? d.caretRangeFromPoint(fx, fy) : null;
  const hd = r && (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer);
  const h = hd && hd.closest ? hd.closest('h1,h2,h3,h4,h5,h6') : null;
  let 末文本长 = null, 落末节点端 = null;
  if (h) { const walker = d.createTreeWalker(h, NodeFilter.SHOW_TEXT); let t, lastT = null;
    while (t = walker.nextNode()) { const pe = t.parentElement;
      if (pe && pe.closest && pe.closest('.vditor-ir__marker,[data-type$="-marker"]')) continue; if (t.data.length) lastT = t; }
    末文本长 = lastT ? lastT.data.length : null;
    落末节点端 = !!(lastT && r && r.startContainer === lastT && r.startOffset === lastT.data.length); }
  return { 元素: el ? el.nodeName + '.' + String(el.className || '').slice(0, 24) : null,
    在编辑面内: !!(el && s && s.contains(el)), 命中标题: !!h,
    标题: h ? h.tagName + '[' + [].indexOf.call(s.children, h) + ']' : null,
    偏移: r ? r.startOffset : null, 末文本长, 落末节点端 }; })()`;

/** 选区快照：长度/折叠/锚焦偏移/所在块/标题记号宽（记号显隐的几何旁证）。 */
const SNAP = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const out = { 帧焦点: d.hasFocus() };
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return Object.assign(out, { 无选区: true, col: true, len: 0 });
  const r = sel.getRangeAt(0);
  let text = ''; try { text = r.toString(); } catch (e) { text = 'ERR'; }
  let top = r.startContainer; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const head = el && el.closest ? el.closest('h1,h2,h3,h4,h5,h6') : null;
  let 记号宽 = null;
  if (head) { const mk = head.querySelector('.vditor-ir__marker--heading'); const t = mk && mk.firstChild;
    if (t && t.nodeType === 3 && t.length) { const rr = d.createRange(); rr.setStart(t, 0); rr.setEnd(t, t.length);
      记号宽 = Math.round(rr.getBoundingClientRect().width); } else 记号宽 = 0; }
  return Object.assign(out, { col: r.collapsed, len: text.length, sel: text.slice(0, 30),
    ao: r.startOffset, fo: r.endOffset,
    块: (top && top.parentElement === s) ? top.tagName + '[' + [].indexOf.call(s.children, top) + ']' : 'other',
    记号宽, 展开块数: d.querySelectorAll('.vditor-ir__node--expand').length }); })()`;

/** 焦点在哪（帧内外双面）。 */
const FOCUS_STATE = `(() => { const w = ${hi.IF}, d = w.document;
  const ae = d.activeElement;
  const surf = d.querySelector('${hi.SURFACE}');
  return { iframe焦点: d.hasFocus(), 活动元素: ae ? (ae.tagName + (ae.className ? '.' + String(ae.className).split(' ')[0] : '')) : null,
    在编辑面内: !!(ae && surf && surf.contains(ae)),
    顶层活动元素: document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).split(' ')[0] : '')) : null }; })()`;

const RAF_MS = `new Promise(res => { const w = ${hi.IF}; const t0 = performance.now(); w.requestAnimationFrame(() => res(Math.round(performance.now() - t0))); })`;

// ── 帧内记录器：手势期间的 buttons=0 混入移动（E2 真指针掠过）与 blur/可见性打断（E1'） ──
const REC_INSTALL = `(() => { const w = ${hi.IF}, d = w.document;
  if (!w) return 'no-frame';
  if (w.__g152rec) return 'already';
  const R = w.__g152rec = { ev: [], focus: [] };
  const t0 = () => Math.round(performance.now());
  w.addEventListener('mousemove', e => { if (R.ev.length < 700) R.ev.push({ t: t0(), type: 'mm', b: e.buttons }); }, true);
  w.addEventListener('mousedown', e => { R.ev.push({ t: t0(), type: 'md', b: e.buttons }); }, true);
  w.addEventListener('mouseup', e => { R.ev.push({ t: t0(), type: 'mu', b: e.buttons }); }, true);
  for (const tp of ['blur', 'focus', 'focusout', 'focusin']) w.addEventListener(tp, () => { if (R.focus.length < 80) R.focus.push(tp); }, true);
  d.addEventListener('visibilitychange', () => { if (R.focus.length < 80) R.focus.push('visibility:' + d.visibilityState); }, true);
  return 'installed'; })()`;
const REC_RESET = `(() => { const w = ${hi.IF}; const R = w && w.__g152rec; if (R) { R.ev.length = 0; R.focus.length = 0; } return !!R; })()`;
const REC_DUMP = `(() => { const w = ${hi.IF}; const R = w && w.__g152rec; if (!R) return null;
  const md = [...R.ev].reverse().find(e => e.type === 'md'); const mu = R.ev.find(e => e.type === 'mu');
  const hover = (md && mu) ? R.ev.filter(e => e.type === 'mm' && e.t >= md.t && e.t <= mu.t && e.b === 0).length : null;
  return { hover, moves: R.ev.filter(e => e.type === 'mm').length, 失焦: R.focus }; })()`;

// ── 真实输入原语：mouseMoved 一律带 button:'left'（E3）；Shift 走真实 dispatchKeyEvent ──
const 鼠标 = (session, type, x, y, opts = {}) => {
  const params = { type, x: Math.round(x), y: Math.round(y), button: opts.button || 'left', buttons: opts.buttons === undefined ? 0 : opts.buttons };
  if (type !== 'mouseMoved') params.clickCount = opts.clickCount || 1;
  if (opts.modifiers) params.modifiers = opts.modifiers;
  return session.send('Input.dispatchMouseEvent', params);
};
const shiftDown = session => session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: hi.MOD.shift });
const shiftUp = session => session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: hi.MOD.shift });

/** 主进程通道把窗口拉前台+置顶（E1：被盖住时 rAF 单帧往返 57s、抓帧陈旧，读数整批不可信）。 */
async function 前景(session) {
  try {
    if (!session.main) return { ok: false, why: 'no-main' };
    const r = await session.main.js(`(() => { const wins = require('electron').BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
      if (!wins.length) return 'no-window'; const w = wins[0]; if (w.isMinimized()) w.restore(); w.show(); w.setAlwaysOnTop(true); w.moveTop(); w.focus();
      return { onTop: w.isAlwaysOnTop(), focused: w.isFocused() }; })()`);
    await hi.sleep(180);
    return r;
  } catch (error) { return { ok: false, why: String((error && error.message) || error) }; }
}

/** 真实单击（move→press→release），把光标放进段落末部做复位（顺带把任何 --expand 摘干净）。 */
async function 复位点(session) {
  const g = await session.js(GEOM(IDX.para));
  const c = g.chars[Math.max(0, g.chars.length - 20)];
  await 鼠标(session, 'mouseMoved', c.x, c.y);
  await hi.sleep(60);
  await 鼠标(session, 'mousePressed', c.x, c.y, { buttons: 1 });
  await hi.sleep(40);
  await 鼠标(session, 'mouseReleased', c.x, c.y, { buttons: 0 });
  await hi.sleep(240);
  return c;
}
async function 真点(session, x, y) {
  await 鼠标(session, 'mouseMoved', x, y);
  await hi.sleep(60);
  await 鼠标(session, 'mousePressed', x, y, { buttons: 1 });
  await hi.sleep(40);
  await 鼠标(session, 'mouseReleased', x, y, { buttons: 0 });
  await hi.sleep(240);
}

/** ① S1 收起态主腿（整条手势一次跑完；检出环境污染且未过时由调用方重跑一发）。 */
async function 跑S1(session) {
  const 记录 = { 步: {} };
  await 前景(session);
  await 复位点(session);
  const 落 = await session.js(CARET_END(IDX.h3long));
  await hi.sleep(400);                       // 等收起态版面落定
  const g = await session.js(GEOM(IDX.h3long));
  const 探 = await session.js(PROBE_POINT(g.afterLast.x, g.afterLast.y));
  const 焦 = await session.js(FOCUS_STATE);
  const raf = await session.js(RAF_MS).catch(() => null);
  记录.前置 = { 落光标: 落, 收起态: !g.expand, 末行字数: g.lineCount, 探, 焦, raf };
  记录.前置过 = !!(落.ok && !g.expand && g.lineCount >= 6 && 焦.iframe焦点 === true
    && 探.命中标题 === true && 探.标题 === 'H3[' + IDX.h3long + ']' && 探.落末节点端 === true
    && typeof raf === 'number');
  await session.js(REC_RESET);
  const S = hi.MOD.shift;
  await shiftDown(session);
  await 鼠标(session, 'mouseMoved', g.afterLast.x, g.afterLast.y, { modifiers: S });
  await hi.sleep(120);
  await 鼠标(session, 'mousePressed', g.afterLast.x, g.afterLast.y, { buttons: 1, modifiers: S });
  await hi.sleep(320);
  记录.步.按下 = await session.js(SNAP);
  await 鼠标(session, 'mouseMoved', g.afterLast.x, g.afterLast.y, { buttons: 1, modifiers: S });
  await hi.sleep(320);
  记录.步.首移 = await session.js(SNAP);
  const from = g.afterLast.x, to = g.lineLeft.x;
  const 扫 = [];
  let prev = 记录.步.首移.len;
  let 单调 = true, 跳变 = false;
  for (let i = 1; i <= 14; i++) {
    await 鼠标(session, 'mouseMoved', from + (to - from) * i / 14, g.afterLast.y, { buttons: 1, modifiers: S });
    await hi.sleep(28);
    const s = await session.js(SNAP);
    扫.push(s.len);
    if (s.len < prev) 单调 = false;
    if (s.len - prev > 1) 跳变 = true;
    prev = s.len;
  }
  await hi.sleep(200);
  记录.步.左端 = await session.js(SNAP);
  for (let i = 13; i >= 0; i -= 2) {
    await 鼠标(session, 'mouseMoved', from + (to - from) * i / 14, g.afterLast.y, { buttons: 1, modifiers: S });
    await hi.sleep(28);
  }
  await hi.sleep(420);
  记录.步.扫回 = await session.js(SNAP);
  await 鼠标(session, 'mouseReleased', g.afterLast.x, g.afterLast.y, { buttons: 0, modifiers: S });
  await hi.sleep(320);
  记录.步.抬起 = await session.js(SNAP);
  await shiftUp(session);
  await hi.sleep(150);
  记录.环境 = await session.js(REC_DUMP);
  记录.桩 = await session.js(`(() => { const w = ${hi.IF}; return w.__typoraHeadingShiftDrag || null; })()`);
  记录.扫 = 扫; 记录.单调 = 单调; 记录.跳变 = 跳变;
  记录.污染 = !!((记录.环境 && (记录.环境.hover > 0 || (记录.环境.失焦 || []).length > 0)) || !(typeof raf === 'number') || raf > 120);
  记录.通过 = 记录.前置过
    && 记录.步.按下.len === 0 && 记录.步.按下.col === true
    && 记录.步.首移.len === 0
    && 单调 && !跳变 && 记录.步.左端.len >= 4
    && 记录.步.扫回.len === 0 && 记录.步.扫回.col === true
    && 记录.步.抬起.len === 0;
  return 记录;
}

/** ② 段落/列表/引用的 Shift+单击原生扩选（真点行末放光标 → Shift+点第 9 字）。 */
async function 跑原生单击(session, index) {
  await 前景(session);
  await 复位点(session);
  const g1 = await session.js(GEOM(index));
  await 真点(session, g1.afterLast.x, g1.afterLast.y);
  const 置 = await session.js(SNAP);
  const g2 = await session.js(GEOM(index));
  const 目标 = g2.chars[Math.max(0, g2.chars.length - 9)];
  const S = hi.MOD.shift;
  await shiftDown(session);
  await 鼠标(session, 'mouseMoved', 目标.x, 目标.y, { modifiers: S });
  await hi.sleep(150);
  const 前 = await session.js(SNAP);
  await 鼠标(session, 'mousePressed', 目标.x, 目标.y, { buttons: 1, modifiers: S });
  await hi.sleep(220);
  const 按下 = await session.js(SNAP);
  await 鼠标(session, 'mouseReleased', 目标.x, 目标.y, { buttons: 0, modifiers: S });
  await hi.sleep(300);
  const 抬起 = await session.js(SNAP);
  await shiftUp(session);
  await hi.sleep(150);
  const 可见串 = g2.chars.map(c => c.ch).join('');
  return { 置, 目标字: 目标.ch, 目标点: { x: 目标.x, y: 目标.y }, 前, 按下, 抬起, 可见尾: 可见串.slice(-Math.max(按下.len, 0)) };
}

/** ③ R7：真点行末（标题已展开）后同手势（补丁按判据不接管、交回原生）。 */
async function 跑已展开(session) {
  await 前景(session);
  await 复位点(session);
  const g1 = await session.js(GEOM(IDX.h3long));
  await 真点(session, g1.afterLast.x, g1.afterLast.y);
  const g2 = await session.js(GEOM(IDX.h3long));
  const 置 = await session.js(SNAP);
  const S = hi.MOD.shift;
  await shiftDown(session);
  await 鼠标(session, 'mouseMoved', g2.afterLast.x, g2.afterLast.y, { modifiers: S });
  await hi.sleep(120);
  await 鼠标(session, 'mousePressed', g2.afterLast.x, g2.afterLast.y, { buttons: 1, modifiers: S });
  await hi.sleep(320);
  const 按下 = await session.js(SNAP);
  await 鼠标(session, 'mouseMoved', g2.afterLast.x - 1, g2.afterLast.y, { buttons: 1, modifiers: S });
  await hi.sleep(300);
  const 挪 = await session.js(SNAP);
  await 鼠标(session, 'mouseReleased', g2.afterLast.x - 1, g2.afterLast.y, { buttons: 0, modifiers: S });
  await hi.sleep(260);
  const 抬起 = await session.js(SNAP);
  await shiftUp(session);
  await hi.sleep(150);
  return { 展开前: g2.expand, 记号宽: g2.mkBox ? g2.mkBox.w : null, 置, 按下, 挪, 抬起 };
}

/** ④ f6：焦点推到顶层面板后 Shift+点标题（收起态）——手势必须把焦点交回编辑面。 */
async function 跑帧外焦点(session) {
  await 前景(session);
  await 复位点(session);
  await session.js(`(() => { if (document.getElementById('__g152panel')) return 'exists';
    const p = document.createElement('div'); p.id = '__g152panel';
    p.setAttribute('style', 'position:fixed;left:8px;bottom:8px;width:320px;height:64px;background:#ccd;z-index:99999;');
    const i = document.createElement('input'); i.setAttribute('style', 'width:300px;height:30px;');
    p.appendChild(i); document.body.appendChild(p); return 'made'; })()`);
  const p = await session.js(`(() => { const b = document.getElementById('__g152panel').getBoundingClientRect(); return { x: Math.round(b.x + 40), y: Math.round(b.y + 20) }; })()`);
  await 真点(session, p.x, p.y);
  let 点外 = await session.js(FOCUS_STATE);
  if (点外.iframe焦点) {
    await session.js(`(() => { document.getElementById('editor').blur(); return true; })()`);
    await hi.sleep(140);
    点外 = await session.js(FOCUS_STATE);
  }
  const 落 = await session.js(CARET_END(IDX.h3long));
  await hi.sleep(300);
  const g = await session.js(GEOM(IDX.h3long));
  const S = hi.MOD.shift;
  await shiftDown(session);
  await 鼠标(session, 'mouseMoved', g.afterLast.x, g.afterLast.y, { modifiers: S });
  await hi.sleep(110);
  await 鼠标(session, 'mousePressed', g.afterLast.x, g.afterLast.y, { buttons: 1, modifiers: S });
  await hi.sleep(240);
  const 按下后 = await session.js(FOCUS_STATE);
  const 按下帧 = await session.js(SNAP);
  await 鼠标(session, 'mouseReleased', g.afterLast.x, g.afterLast.y, { buttons: 0, modifiers: S });
  await hi.sleep(240);
  const 抬起后 = await session.js(FOCUS_STATE);
  await shiftUp(session);
  await hi.sleep(150);
  const 收键后 = await session.js(FOCUS_STATE);
  await session.js(`(() => { const p = document.getElementById('__g152panel'); if (p) p.remove(); return true; })()`);
  return { 点外, 落光标: 落, 收起态: !g.expand, 按下后, 按下帧, 抬起后, 收键后 };
}

const 显 = v => JSON.stringify(v);

module.exports = {
  id: '152-heading-shift-drag',
  title: '标题行 Shift+左键拖选（U-087）：收起态按下无反向选区、左扫跟手、扫回收干净；段落/列表/引用原生扩选不回归；帧外焦点交回编辑面',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'adv-img.png'), hi.fixtures.png(120, 80, [120, 120, 120]));
    const file = hi.writeDoc('g152-heading-shift-drag.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 9, inspect: true });
    try {
      ctx.assert('前置：焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');
      ctx.log('帧内记录器：' + await session.js(REC_INSTALL));

      // ── ① S1 收起态主腿（环境污染时同一手势重跑一发；产品缺陷重跑救不了） ──────────
      let s1 = await 跑S1(session);
      if (!s1.通过 && s1.污染) {
        ctx.log('① 检出环境污染（hover/失焦/rAF=' + JSON.stringify({ 环境: s1.环境, raf: s1.前置.raf }) + '）→ 同一手势重跑一发');
        s1 = await 跑S1(session);
      }
      ctx.assert('① 前置：程序化落光标后标题仍是收起态、焦点在编辑器、按下点映射进该标题末文本节点端'
        + '（收起态起手必须程序化落光标——先真点行末会把标题展开，那量到的是已展开态）',
        s1.前置过, 显(s1.前置));
      ctx.assert('①【硬红线】Shift+按下帧：选区长度=0 且折叠（不许凭空出现反向选区；原生缺陷形态=按下即 4 字）',
        s1.步.按下.len === 0 && s1.步.按下.col === true, 显(s1.步.按下));
      ctx.assert('① 首次 mousemove（同点）后选区仍为 0（不塌不跳）',
        s1.步.首移.len === 0, 显(s1.步.首移));
      ctx.assert('① 沿末行左扫 14 步：单调不减、每步增长 ≤1 字（按按下后版面映射跟手）',
        s1.单调 && !s1.跳变, 显(s1.扫));
      ctx.assert('① 扫到末行左端：选出实打实的一段（≥4 字；M1 突变形态=整段冻结在 0）',
        s1.步.左端.len >= 4, 显(s1.步.左端));
      ctx.assert('① 扫回按下点：选区塌空回 0、光标折叠（不残留；原生缺陷形态=拖回起点仍剩 4 字收不掉）',
        s1.步.扫回.len === 0 && s1.步.扫回.col === true, 显(s1.步.扫回));
      ctx.assert('① 在按下点抬起：抬起后选区仍为空（R4 残留=0）',
        s1.步.抬起.len === 0, 显(s1.步.抬起));
      ctx.witness('几何：收起态标题 Shift 拖拽全程序读数（含环境证人：hover=0/失焦=[]）',
        { 前置: s1.前置, 步: s1.步, 扫: s1.扫, 环境: s1.环境, 补丁桩: s1.桩 }, 'geometry');
      ctx.metric('152 收起态左扫末选区字数', s1.步.左端.len, { direction: 'equal', unit: '字' });
      ctx.metric('152 扫回按下点后残留字数', s1.步.扫回.len, { direction: 'equal', unit: '字' });

      // ── ② 段落 / 列表项 / 引用行：Shift+单击原生扩选不回归（复核基线 9/9/8） ─────────
      const 腿组 = [
        { index: IDX.para, 名: '对照段落' },
        { index: IDX.li, 名: '列表项' },
        { index: IDX.quote, 名: '引用行' },
      ];
      const 原生读数 = {};
      for (const 腿 of 腿组) {
        const r = await 跑原生单击(session, 腿.index);
        原生读数[腿名(腿)] = r;
        ctx.assert('② ' + 腿名(腿) + ' Shift+单击原生扩选不回归：按下帧原地扩到点击字（8..9 字；M6 突变形态=被压成 0）、抬起不丢、选区=该行可见尾部',
          r.按下.len >= 8 && r.按下.len <= 9 && r.抬起.len === r.按下.len && r.按下.sel === r.可见尾,
          显({ 目标字: r.目标字, 前: r.前, 按下: r.按下, 抬起: r.抬起, 可见尾: r.可见尾 }));
      }
      ctx.witness('几何：段落/列表/引用 Shift+单击原生扩选读数（复核基线 9/9/8，字位边界允许 8..9）', 原生读数, 'geometry');
      ctx.metric('152 段落 Shift+单击扩选字数', 原生读数['对照段落'].按下.len, { direction: 'equal', unit: '字' });

      // ── ③ R7 已展开态：真点行末后同手势交回原生、无副作用 ──────────────────────────
      const r7 = await 跑已展开(session);
      ctx.assert('③ 前置：真点行末后标题确实已展开（这一腿补丁按判据不接管）', r7.展开前 === true, 显({ 展开前: r7.展开前, 记号宽: r7.记号宽 }));
      ctx.assert('③ 已展开态 Shift+按下/挪 1px/抬起：全程 0 字（交回原生、无副作用）',
        r7.按下.len === 0 && r7.挪.len === 0 && r7.抬起.len === 0, 显(r7));
      ctx.witness('几何：已展开态同手势读数', r7, 'geometry');

      // ── ④ f6 帧外焦点：面板拿走焦点后 Shift+点标题，焦点必须交回编辑面 ────────────────
      const f6 = await 跑帧外焦点(session);
      ctx.assert('④ 前置：点顶层面板后 iframe 确实失焦（这一腿的起手才成立）',
        f6.点外.iframe焦点 === false, 显(f6.点外));
      ctx.assert('④ 前置：帧外点击没有把标题展开（收起态前提仍在）', f6.收起态 === true, 显({ 收起态: f6.收起态, 落光标: f6.落光标 }));
      ctx.assert('④ Shift+按下后焦点交回编辑面：iframe hasFocus 真、活动元素在编辑面内、顶层活动元素=IFRAME',
        f6.按下后.iframe焦点 === true && f6.按下后.在编辑面内 === true && String(f6.按下后.顶层活动元素).startsWith('IFRAME'),
        显({ 按下后: f6.按下后, 按下帧: f6.按下帧 }));
      ctx.assert('④ 帧外焦点腿的按下帧选区长度=0（接管语义与 S1 同判）', f6.按下帧.len === 0, 显(f6.按下帧));
      ctx.assert('④ 抬起/收键后焦点保持在编辑面（不被弹回面板/壳层）',
        f6.抬起后.iframe焦点 === true && f6.抬起后.在编辑面内 === true && f6.收键后.iframe焦点 === true && f6.收键后.在编辑面内 === true,
        显({ 抬起后: f6.抬起后, 收键后: f6.收键后 }));
      ctx.witness('几何：帧外焦点腿的焦点四面读数', { 点外: f6.点外, 按下后: f6.按下后, 抬起后: f6.抬起后, 收键后: f6.收键后, 按下帧: f6.按下帧 }, 'geometry');
    } finally {
      await ctx.release(session);
    }
  },
};

function 腿名(腿) { return 腿.名; }
