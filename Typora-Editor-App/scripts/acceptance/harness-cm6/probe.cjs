/** 中立探针层 mkProbe(engine) —— r20 移植设计 §2/§3 的读数/落位半边。
 *
 *  输入半边（press/hold/combo/drag——只用 session.send('Input.*')）在
 *  scripts/human-input/hi.cjs，引擎无关，**零改动复用**；本文件只抽象读数。
 *  场景文件只调 P.xxx(session)，不许出现任何引擎选择器字面量（设计 §3.4）。
 *
 *  接口（设计 §2.3，双实现同形）：
 *    id / surface / scroller
 *    getValue(session)                                  → 文档全文
 *    getCursor(session)                                 → {ok, pos, line, col, lineText, prefix20, collapsed, visibleRect}
 *    getSelection(session)                              → {ok, anchor, head, text, rects, collapsed}
 *    focusGate(session)                                 → {ok, docHasFocus, activeInSurface, activeTag}
 *    ensureFocus(session)                               → 焦点闸门；抢不回时兜底真实点击编辑面
 *    blocks(session)                                    → {ok, blocks:[{index,type,lineFrom,lineTo,firstLine,lastLine,text,marker}]}
 *    placeAt(session, {block,offset}|{pos})             → 程序化前置（动作仍走真实输入）
 *    selectText(session, fromText, toText)              → 前缀定位选区播种
 *    charBoxes(session, blockIndex)                     → 逐字符盒（投影 widget 单独 kind:'widget'）
 *    lineRect(session, lineNo) / caretRect(session)     → 页级坐标几何证人
 *    nearestTo(session, {block, col})                   → 「离目标列最近的可用位置」钳制口径（AGENTS 四.2）
 *    scrollerState(session)                             → 滚动容器 scrollTop 证人
 *    projectionState(session, pos)                      → cm6 专属：投影让位态（N1/71/74/90 用）
 *    readyExpr(minLength)                               → until() 用的就绪表达式
 *
 *  cm6 实现要点（设计 §3.3）：
 *    · 状态读数走产品探针面 mpEngine.getValue/getCursor/getSelection（真身）；
 *      程序化落位走 mpEngine._view().dispatch({selection})——_view 是产品明示的调试/取证
 *      通道，零产品改动（设计 §7.4 已裁决）。
 *    · 块模型＝探针内置 md 行聚合（标题/列表/表格/围栏/公式围栏/段落/引用/空行），
 *      **不用产品解析器**（独立口径纪律）。行文本判型，同一套规则同时服务断言与落位。
 *    · 光标可见性＝.cm-cursor 矩形（CM6 自绘光标层就是产品光标的正式 DOM）；
 *      滚动证人＝.cm-scroller scrollTop。
 *    · 几何全部换算成**页级坐标**（iframe frameElement 矩形 + 帧内 rect），与 2.x
 *      hi.cjs CHARS_OF 同构——CDP Input 的点击坐标口径。
 *
 *  vditor 实现＝hi.cjs 现有读数表达式的同形整理（2.x Electron 世界，frame =
 *  document.getElementById('editor').contentWindow）；块模型从 vditor IR DOM 映射。
 *  过渡期做"契约对照"用（设计 §3.1）。
 */
'use strict';

/** 各引擎默认的「引擎帧 window」求值表达式（在宿主页顶层执行）。 */
const FRAME_DEFAULT = {
  cm6: `document.getElementById('mp-frame').contentWindow`,
  vditor: `document.getElementById('editor').contentWindow`,
};

function mkProbe(engine, opts = {}) {
  const frame = opts.frame || FRAME_DEFAULT[engine];
  if (!frame) throw new Error('mkProbe: 未知引擎 ' + engine);
  return engine === 'cm6' ? cm6Probe(frame) : vditorProbe(frame);
}

/* ══════════════════════════════════ cm6 实现 ══════════════════════════════════ */

/** 探针自有的 md 行聚合器（字符串形式，嵌进帧内表达式；不依赖产品解析器）。
 *  输入 doc（CM6 Text），输出中立块数组。类型：
 *  heading|para|list|table|fence|mathblock|blank|quote。 */
const SCAN_CM6 = String(function scanBlocks(doc) {
  const blocks = [];
  const L = [];
  for (let n = 1; n <= doc.lines; n++) L.push(doc.line(n));
  const isBlank = t => /^\s*$/.test(t);
  const headingOf = t => /^ {0,3}(#{1,6})(\s|$)/.exec(t);
  const fenceOf = t => /^ {0,3}(`{3,}|~{3,})/.exec(t);
  const listAt = t => /^(\s*)([-*+]|\d{1,9}[.)])(\s|$)/.exec(t);
  const isQuote = t => /^ {0,3}>/.test(t);
  const isTableRow = t => /^\s*\|/.test(t);
  const isTableSep = t => /^\s*\|?(\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/.test(t) && t.includes('-');
  const isBlockMath = t => t.trim() === '$$';
  let i = 0;
  while (i < L.length) {
    const from = L[i];
    const t = from.text;
    let type = 'para', marker = null, j = i;
    const h = headingOf(t);
    if (isBlank(t)) type = 'blank';
    else if (h) { type = 'heading'; marker = h[1]; }
    else if (isBlockMath(t)) {
      type = 'mathblock'; j = i + 1;
      while (j < L.length && !isBlockMath(L[j].text)) j++;
      if (j >= L.length) j = L.length - 1; // 未闭合 $$：整段到文末（与"不崩不写坏"族断言兼容）
    } else if (fenceOf(t)) {
      type = 'fence'; marker = t.trim().slice(0, 3);
      const ch = marker[0];
      j = i + 1;
      while (j < L.length) {
        const close = fenceOf(L[j].text);
        if (close && close[1][0] === ch && L[j].text.trim().replace(/^[`~]+/, '').trim() === '') break;
        j++;
      }
      if (j >= L.length) j = L.length - 1; // 未闭合围栏到文末
    } else if (isTableRow(t) && i + 1 < L.length && isTableSep(L[i + 1].text)) {
      type = 'table'; j = i;
      while (j + 1 < L.length && isTableRow(L[j + 1].text)) j++;
    } else if (listAt(t)) {
      type = 'list'; marker = listAt(t)[2];
      const isListContinuation = x => listAt(x) != null || (/^\s+\S/.test(x) && !isBlank(x) && !isBlockMath(x));
      while (j + 1 < L.length && isListContinuation(L[j + 1].text)) j++;
    } else if (isQuote(t)) {
      type = 'quote'; marker = '>';
      while (j + 1 < L.length && isQuote(L[j + 1].text)) j++;
    } else {
      type = 'para'; j = i;
      while (j + 1 < L.length) {
        const nt = L[j + 1].text;
        if (isBlank(nt) || headingOf(nt) || fenceOf(nt) || listAt(nt) || isQuote(nt) || isTableRow(nt) || isBlockMath(nt)) break;
        j++;
      }
    }
    const to = L[j];
    blocks.push({
      index: blocks.length, type, marker,
      lineFrom: from.from, lineTo: to.to,
      firstLine: from.number, lastLine: to.number,
      text: L.slice(i, j + 1).map(l => l.text).join('\n'),
    });
    i = j + 1;
  }
  return blocks;
});

function cm6Probe(frame) {
  const wrap = body => `(() => { const w = ${frame}; if (!w) return { ok: false, error: '引擎帧不存在' };
    const e = w.mpEngine; if (!e) return { ok: false, error: 'mpEngine 未 boot（open 还没到？）' };
    try { ${body} } catch (err) { return { ok: false, error: String(err && err.message || err) }; } })()`;
  // 帧内 rect → 页级坐标的偏移（与 hi.cjs CHARS_OF 同构）。
  const FE = `const fe = (() => { try { const r = w.frameElement.getBoundingClientRect(); return { x: r.x, y: r.y }; } catch (err) { return { x: 0, y: 0 }; } })();`;
  const SCAN = `const scan = ${SCAN_CM6};`;

  const P = {
    id: 'cm6',
    surface: '.cm-content',
    scroller: '.cm-scroller',
    frameExpr: frame,

    readyExpr(minLength = 1) {
      return `(() => { try { const w = ${frame}; return !!(w && w.mpEngine && w.mpEngine.getValue().length >= ${Number(minLength) || 0}); } catch (e) { return false; } })()`;
    },

    getValue: session => session.js(wrap(`return e.getValue();`)),

    getCursor: session => session.js(wrap(`
      ${FE}
      const view = e._view(); const c = e.getCursor(); const sel = view.state.selection.main;
      let rect = null; const cur = view.dom.querySelector('.cm-cursor');
      if (cur) { const r = cur.getBoundingClientRect();
        rect = { x: Math.round(fe.x + r.x), y: Math.round(fe.y + r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
      const col = c.col;
      return { ok: true, engine: 'cm6', pos: c.head, line: c.lineNumber, col,
        lineText: c.lineText, prefix20: String(c.lineText || '').slice(Math.max(0, col - 20), col),
        collapsed: sel.empty, visibleRect: rect,
        hasFocus: (() => { const hf = view.hasFocus; return typeof hf === 'function' ? !!hf.call(view) : !!hf; })() };`)),

    getSelection: session => session.js(wrap(`
      ${FE}
      // 选区层（drawSelection 的 .cm-selectionBackground）走 requestMeasure/rAF 更新——
      // dispatch 后立即查询会抢在 DOM 更新前（实测竞态：偶发 rects=[]）。等一帧再读。
      return (async () => {
        await new Promise(resolve => { requestAnimationFrame(() => setTimeout(resolve, 0)); });
        const s = e.getSelection(); const view = e._view();
        const rects = Array.from(view.dom.querySelectorAll('.cm-selectionBackground')).map(el => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(fe.x + r.x), y: Math.round(fe.y + r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
        return { ok: true, engine: 'cm6', anchor: s.anchor, head: s.head, text: s.selected,
          collapsed: s.anchor === s.head, rects };
      })();`)),

    focusGate: session => session.js(wrap(`
      const view = e._view(); const d = w.document; const active = d.activeElement;
      const inSurface = !!(active && view.contentDOM.contains(active));
      const docHasFocus = d.hasFocus();
      // CM6 新版 hasFocus 是 getter 属性（旧版是方法）——两种形态都兼容。
      const hf = view.hasFocus; const viewHasFocus = typeof hf === 'function' ? !!hf.call(view) : !!hf;
      return { ok: docHasFocus && viewHasFocus && inSurface, docHasFocus, viewHasFocus,
        activeInSurface: inSurface, activeTag: active ? active.tagName : null };`)),

    async ensureFocus(session) {
      const gate = () => P.focusGate(session);
      let g = await gate();
      if (g.ok) return g;
      await session.js(wrap(`e.focus(); return true;`));
      g = await gate();
      if (g.ok) return g;
      // 兜底：真实点击编辑面（同 hi.cjs ensureFocus 的策略）
      const spot = await session.js(wrap(`
        ${FE}
        const view = e._view(); const r = view.contentDOM.getBoundingClientRect();
        return { x: Math.round(fe.x + r.x + Math.min(r.width / 2, 200)), y: Math.round(fe.y + r.y + 40) };`));
      if (spot && spot.x) {
        await session.click(spot.x, spot.y);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      g = await gate();
      if (!g.ok) throw new Error('ensureFocus 失败：' + JSON.stringify(g));
      return g;
    },

    blocks: session => session.js(wrap(`
      const view = e._view(); const doc = view.state.doc;
      ${SCAN}
      return { ok: true, engine: 'cm6', totalLines: doc.lines, docLength: doc.length, blocks: scan(doc) };`)),

    placeAt: (session, where) => {
      if (Number.isFinite(where && where.pos)) {
        return session.js(wrap(`
          const view = e._view(); const pos = Math.max(0, Math.min(${Number(where.pos)}, view.state.doc.length));
          view.dispatch({ selection: { anchor: pos } }); e.focus();
          const line = view.state.doc.lineAt(pos);
          return { ok: true, pos, line: line.number, col: pos - line.from, lineText: line.text };`));
      }
      const block = Number(where && where.block);
      const offset = Number(where && where.offset) || 0;
      return session.js(wrap(`
        const view = e._view(); const doc = view.state.doc;
        ${SCAN}
        const blocks = scan(doc); const b = blocks[${block}];
        if (!b) return { ok: false, error: '没有第 ${block} 块', total: blocks.length };
        const line = doc.line(b.firstLine);
        const pos = line.from + Math.max(0, Math.min(${offset}, line.text.length));
        view.dispatch({ selection: { anchor: pos } }); e.focus();
        return { ok: true, pos, line: line.number, col: pos - line.from, lineText: line.text, blockType: b.type };`));
    },

    selectText: (session, fromText, toText) => session.js(wrap(`
      const view = e._view(); const doc = view.state.doc; const text = doc.toString();
      const a = text.indexOf(${JSON.stringify(String(fromText))});
      if (a < 0) return { ok: false, error: '找不到起点 ' + ${JSON.stringify(String(fromText))} };
      const b = text.indexOf(${JSON.stringify(String(toText))}, a + ${String(fromText).length});
      if (b < 0) return { ok: false, error: '找不到终点 ' + ${JSON.stringify(String(toText))} };
      const from = a, to = b + ${String(toText).length};
      view.dispatch({ selection: { anchor: from, head: to } }); e.focus();
      return { ok: true, from, to, text: text.slice(from, to) };`)),

    charBoxes: (session, blockIndex) => session.js(wrap(`
      ${FE}
      const view = e._view(); const doc = view.state.doc;
      ${SCAN}
      const blocks = scan(doc); const b = blocks[${Number(blockIndex)}];
      if (!b) return { ok: false, error: '没有第 ${Number(blockIndex)} 块', total: blocks.length };
      const els = Array.from(view.dom.querySelectorAll('.cm-line'));
      const chars = []; const widgets = [];
      for (let n = b.firstLine; n <= b.lastLine; n++) {
        const el = els[n - 1]; if (!el) continue;
        if (n === b.firstLine) el.scrollIntoView({ block: 'center' });
        const walker = w.document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
          for (let i = 0; i < node.data.length; i++) {
            const r = w.document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
            const rect = r.getBoundingClientRect();
            if (rect.width > 0) chars.push({ ch: node.data[i], line: n,
              left: Math.round(fe.x + rect.left), right: Math.round(fe.x + rect.right),
              y: Math.round(fe.y + rect.top + rect.height / 2), w: Math.round(rect.width), kind: 'text' });
          }
        }
        for (const wg of el.querySelectorAll('.mp-cm6-math')) {
          const r = wg.getBoundingClientRect();
          widgets.push({ ch: null, tex: (wg.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), line: n,
            left: Math.round(fe.x + r.left), right: Math.round(fe.x + r.right),
            y: Math.round(fe.y + r.y + r.height / 2), w: Math.round(r.width), kind: 'widget' });
        }
      }
      return { ok: true, blockType: b.type, text: b.text, chars, widgets };`)),

    lineRect: (session, lineNo) => session.js(wrap(`
      ${FE}
      const view = e._view(); const doc = view.state.doc;
      const n = Math.max(1, Math.min(${Number(lineNo)}, doc.lines));
      const els = Array.from(view.dom.querySelectorAll('.cm-line')); const el = els[n - 1];
      if (!el) return { ok: false, error: '没有第 ' + n + ' 行的 DOM' };
      const r = el.getBoundingClientRect();
      return { ok: true, line: n, x: Math.round(fe.x + r.x), y: Math.round(fe.y + r.y),
        w: Math.round(r.width), h: Math.round(r.height) };`)),

    caretRect: session => session.js(wrap(`
      ${FE}
      const view = e._view(); const cur = view.dom.querySelector('.cm-cursor');
      if (!cur) return { ok: true, visible: false, rect: null };
      const r = cur.getBoundingClientRect();
      return { ok: true, visible: r.width > 0 || r.height > 0,
        rect: { x: Math.round(fe.x + r.x), y: Math.round(fe.y + r.y), w: Math.round(r.width), h: Math.round(r.height) } };`)),

    nearestTo: (session, where) => session.js(wrap(`
      const view = e._view(); const doc = view.state.doc;
      ${SCAN}
      const blocks = scan(doc); const b = blocks[${Number(where && where.block)}];
      if (!b) return { ok: false, error: '没有第 ${Number(where && where.block)} 块' };
      const line = doc.line(b.firstLine);
      const col = Math.max(0, Math.min(${Number(where && where.col) || 0}, line.text.length));
      const pos = line.from + col;
      return { ok: true, pos, line: line.number, col, lineText: line.text,
        clamped: col !== ${Number(where && where.col) || 0} };`)),

    scrollerState: session => session.js(wrap(`
      const sc = w.document.querySelector('.cm-scroller');
      if (!sc) return { ok: false, error: '没有 .cm-scroller' };
      return { ok: true, scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight };`)),

    projectionState: (session, pos) => session.js(wrap(`
      const view = e._view(); const doc = view.state.doc;
      // 探针自扫公式 span（规则＝文档规则：$...$ 行内 / $$ 围栏对），不用产品 StateField。
      const spans = []; const fences = [];
      for (let i = 1; i <= doc.lines; i++) { const line = doc.line(i); const t = line.text;
        if (t.trim() === '$$') { fences.push({ from: line.from, to: line.to, n: i }); continue; }
        if (!t.includes('$')) continue;
        const re = /(^|[^\\\\$])\\$([^$\\n]+)\\$/g; let m;
        while ((m = re.exec(t))) { const start = line.from + m.index + m[1].length;
          spans.push({ from: start, to: start + m[2].length + 2, tex: m[2], display: false }); } }
      for (let i = 0; i + 1 < fences.length; i += 2) { const a = fences[i], b = fences[i + 1];
        if (b.n - a.n < 1) continue;
        spans.push({ from: a.from, to: b.to, tex: doc.sliceString(doc.line(a.n).to + 1, doc.line(b.n).from).trim(), display: true }); }
      spans.sort((x, y) => x.from - y.from);
      const POS = ${Number(pos)};
      const hit = spans.find(s => POS >= s.from && POS <= s.to) || spans.find(s => s.from > POS) || spans[spans.length - 1] || null;
      const sel = view.state.selection.ranges;
      const intersects = hit ? sel.some(r => r.from <= hit.to && r.to >= hit.from) : false;
      return { ok: true, span: hit ? { from: hit.from, to: hit.to, tex: hit.tex, display: hit.display } : null,
        hasWidget: hit ? !intersects : false, revealed: hit ? intersects : false,
        selectionIntersects: intersects,
        widgetCount: view.dom.querySelectorAll('.mp-cm6-math').length };`)),
  };
  return P;
}

/* ══════════════════════════════════ vditor 实现（hi.cjs 同形整理） ══════════════════════════════════ */

function vditorProbe(frame) {
  const SURFACE = '.vditor-ir .vditor-reset';
  const wrap = body => `(() => { const w = ${frame}; if (!w || !w.document) return { ok: false, error: '编辑器帧不存在' };
    const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
    if (!surface) return { ok: false, error: '没有编辑面（vditor 未就绪？）' };
    try { ${body} } catch (err) { return { ok: false, error: String(err && err.message || err) }; } })()`;
  const FE = `const fe = (() => { try { const r = w.frameElement.getBoundingClientRect(); return { x: r.x, y: r.y }; } catch (err) { return { x: 0, y: 0 }; } })();`;
  // hi.cjs READ_CARET 的核心半边（去掉 cm6 世界不存在的层概念时保留原判层逻辑）。
  const CARET_CORE = `
    const s = w.getSelection(); if (!s || !s.rangeCount) return { ok: false, surface: true };
    const r = s.getRangeAt(0);
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const inEditor = !!(at && surface.contains(at));
    let top = at, index = -1, text = '';
    if (inEditor) { while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
      if (top && top.parentElement === surface) { index = Array.from(surface.children).indexOf(top); text = String(top.textContent || '').replace(/\\s+/g, ' ').slice(0, 24); } }
    const box = r.getBoundingClientRect();
    const prefix = r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 20), r.startOffset) : '';
    const layer = !inEditor ? '外' : at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
    const rect = { x: Math.round(fe.x + box.left), y: Math.round(fe.y + box.top), w: Math.round(box.width), h: Math.round(box.height) };`;

  const P = {
    id: 'vditor',
    surface: SURFACE,
    scroller: '.vditor',
    frameExpr: frame,

    readyExpr(minBlocks = 1) {
      return `(() => { try { const w = ${frame}; if (!w) return false;
        const s = w.document.querySelector(${JSON.stringify(SURFACE)});
        return !!(s && s.children.length >= ${Number(minBlocks) || 0} && s.textContent.trim()); } catch (e) { return false; } })()`;
    },

    getValue: session => session.js(`(() => { const w = ${frame}; try { return w && w.vditor ? w.vditor.getValue() : null; } catch (e) { return 'ERR:' + e.message; } })()`),

    getCursor: session => session.js(wrap(`${FE} ${CARET_CORE}
      return { ok: inEditor, engine: 'vditor', pos: null, line: null, col: null,
        block: index, blockText: text, layer, prefix20: prefix, offset: r.startOffset,
        collapsed: r.collapsed, selectedLen: s.toString().length, visibleRect: rect };`)),

    getSelection: session => session.js(wrap(`${FE} ${CARET_CORE}
      const selText = s.toString();
      let rects = [];
      try { for (let i = 0; i < s.rangeCount; i++) { const b = s.getRangeAt(i).getBoundingClientRect();
        rects.push({ x: Math.round(fe.x + b.x), y: Math.round(fe.y + b.y), w: Math.round(b.width), h: Math.round(b.height) }); } } catch (e2) {}
      return { ok: inEditor && selText.length > 0, engine: 'vditor', anchor: null, head: null,
        text: selText, collapsed: r.collapsed, rects: rects.filter(x => x.w > 0 && x.h > 0) };`)),

    focusGate: session => session.js(wrap(`
      const active = d.activeElement;
      return { ok: !!surface && d.hasFocus() && !!(active && surface.contains(active)),
        docHasFocus: d.hasFocus(), activeInSurface: !!(active && surface.contains(active)),
        activeTag: active ? active.tagName : null };`)),

    async ensureFocus(session) {
      let g = await P.focusGate(session);
      if (g.ok) return g;
      await session.js(wrap(`surface.focus(); return true;`));
      g = await P.focusGate(session);
      if (!g.ok) {
        const spot = await session.js(wrap(`${FE}
          const r2 = surface.getBoundingClientRect();
          return { x: Math.round(fe.x + r2.x + Math.min(r2.width / 2, 200)), y: Math.round(fe.y + r2.y + 40) };`));
        if (spot && spot.x) { await session.click(spot.x, spot.y); await new Promise(resolve => setTimeout(resolve, 250)); }
        g = await P.focusGate(session);
      }
      if (!g.ok) throw new Error('ensureFocus 失败：' + JSON.stringify(g));
      return g;
    },

    // 块模型：vditor IR DOM 标签映射（设计 §2.3 第二行）。
    blocks: session => session.js(wrap(`
      const out = [];
      for (const el of surface.children) {
        const tag = el.tagName;
        const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
        let type = 'para', marker = null;
        if (/^H[1-6]$/.test(tag)) { type = 'heading'; marker = (/^#+/.exec(text) || [''])[0]; }
        else if (tag === 'UL' || tag === 'OL') { type = 'list'; marker = text.slice(0, 2); }
        else if (tag === 'TABLE') type = 'table';
        else if (tag === 'PRE') type = 'fence';
        else if (tag === 'BLOCKQUOTE') { type = 'quote'; marker = '>'; }
        else if (text.indexOf('$$') === 0 && el.querySelector('.vditor-ir__preview')) type = 'mathblock';
        else if (!text) type = 'blank';
        out.push({ index: out.length, type, marker, text: text.slice(0, 120), tag,
          lineFrom: null, lineTo: null, firstLine: null, lastLine: null });
      }
      return { ok: true, engine: 'vditor', blocks: out };`)),

    placeAt: (session, where) => {
      if (Number.isFinite(where && where.pos)) throw new Error('vditor 无文档位置模型：用 {block, offset}');
      const index = Number(where && where.block);
      const offset = Number(where && where.offset) || 0;
      return session.js(wrap(`
        const block = surface.children[${index}];
        if (!block) return { ok: false, error: '没有第 ${index} 块' };
        const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node = null;
        while (walker.nextNode()) if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) { node = walker.currentNode; break; }
        if (!node) return { ok: false, error: '这一块没有文字' };
        surface.focus();
        const r2 = d.createRange(); r2.setStart(node, Math.min(${offset}, node.data.length)); r2.collapse(true);
        const s2 = w.getSelection(); s2.removeAllRanges(); s2.addRange(r2);
        return { ok: true, block: ${index}, text: node.data.slice(0, 20), length: node.data.length };`));
    },

    selectText: (session, fromText, toText) => session.js(wrap(`
      const find = prefix => { for (const block of surface.children) {
        const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) { const at = node.data.indexOf(prefix); if (at >= 0) return { node, start: at, end: at + prefix.length }; } }
        return null; };
      const A = find(${JSON.stringify(String(fromText))}), B = find(${JSON.stringify(String(toText))});
      if (!A || !B) return { ok: false, foundFrom: !!A, foundTo: !!B };
      surface.focus();
      const r2 = d.createRange(); r2.setStart(A.node, A.start); r2.setEnd(B.node, B.end);
      const s2 = w.getSelection(); s2.removeAllRanges(); s2.addRange(r2);
      return { ok: true, text: s2.toString() };`)),

    charBoxes: (session, blockIndex) => session.js(wrap(`
      ${FE}
      const frameEl = w.frameElement; const fr = frameEl.getBoundingClientRect();
      const block = surface.children[${Number(blockIndex)}];
      if (!block) return { ok: false, error: '没有第 ${Number(blockIndex)} 块' };
      block.scrollIntoView({ block: 'center', behavior: 'instant' });
      const chars = []; const parts = [];
      const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node; let abs = 0;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        const plain = parent && !(parent.closest('.vditor-ir__preview') || parent.closest('[data-type$="-marker"]'));
        for (let i = 0; i < node.data.length; i++) {
          const r2 = d.createRange(); r2.setStart(node, i); r2.setEnd(node, i + 1);
          const rect = r2.getBoundingClientRect();
          if (rect.width > 0 && plain) chars.push({ ch: node.data[i], abs,
            left: Math.round(fe.x + rect.left), right: Math.round(fe.x + rect.right),
            y: Math.round(fe.y + rect.top + rect.height / 2), w: Math.round(rect.width), kind: 'text' });
          abs += 1;
        }
        parts.push(node.data);
      }
      return { ok: true, text: parts.join(''), chars, widgets: [] };`)),

    lineRect: () => { throw new Error('vditor 无行号模型：用 charBoxes(blockIndex)'); },
    caretRect: session => session.js(wrap(`${FE} ${CARET_CORE}
      return { ok: inEditor, visible: !!(rect.w || rect.h), rect };`)),

    // 钳制口径：vditor 侧以块内文本长度近似（头注必须注明这是近似口径）。
    nearestTo: (session, where) => session.js(wrap(`
      const block = surface.children[${Number(where && where.block)}];
      if (!block) return { ok: false, error: '没有第 ${Number(where && where.block)} 块' };
      const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node = null; let len = 0;
      while ((node = walker.nextNode())) len += node.data.length;
      const col = Math.max(0, Math.min(${Number(where && where.col) || 0}, len));
      return { ok: true, block: ${Number(where && where.block)}, col, clamped: col !== ${Number(where && where.col) || 0} };`)),

    scrollerState: session => session.js(wrap(`
      const sc = d.querySelector('.vditor-scroller') || d.querySelector('.vditor');
      if (!sc) return { ok: false, error: '没有滚动容器' };
      return { ok: true, scrollTop: Math.round(sc.scrollTop), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight };`)),

    projectionState: session => session.js(wrap(`${FE} ${CARET_CORE}
      return { ok: inEditor, revealed: layer === '源码', hasWidget: layer === '预览', layer, widgetCount: surface.querySelectorAll('.vditor-ir__preview').length };`)),
  };
  return P;
}

module.exports = { mkProbe, FRAME_DEFAULT };
