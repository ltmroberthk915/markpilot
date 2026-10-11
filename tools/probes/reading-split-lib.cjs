/** reading-split 族共用夹具（AGENTS 错-4：同一件事只许一份实现）
 *
 *  复用 startup-and-menus-lib.cjs 的启动/连接/进程外读数（spawn + 随机端口 + 独立 user-data-dir
 *  + MP_DEBUG=1 + delete ELECTRON_RUN_AS_NODE + connectOverCDP），本文件只加"阅读模式 / 双开"这一族
 *  专用的一次性读数与真实输入通道。
 *
 *  口径（纪律 3、7）：
 *   · STATE 一次 evaluate 拿全（属性 / 尺寸 / 滚动 / 光标 / 视口行，禁止跨调用拼装）；
 *   · 每条判据读**最终状态**，不读"我调用了什么"；附带 rawDefault 断言，防止拿到默认回退值。
 */
'use strict';
const path = require('node:path');
const L = require(path.join(__dirname, 'startup-and-menus-lib.cjs'));
const { sleep } = L;

/** 渲染侧一次拿全的读数。返回对象第一层字段就是"最终状态"。 */
const STATE = () => {
  const q = (s) => document.querySelector(s);
  const out = { ok: false, t: Date.now() };
  try {
    const v = window.mpEngine && window.mpEngine._view && window.mpEngine._view();
    const de = document.documentElement;
    const cs = de.dataset.mpReading || '';
    out.rawDefault = { hasView: !!v, hasHost: !!(window.mpHost && typeof window.mpHost.openPath === 'function'), mpSplit: !!window.mpSplit, datasetKeyPresent: 'mpReading' in de.dataset, dividable: !!(v && v.contentDOM && v.contentDOM.querySelectorAll('.cm-line').length > 0), viewIsFallback: v ? (v.state.doc.length === 0 || !v.dom.isConnected) : true };
    out.reading = cs === '1';
    out.datasetReading = cs === '' ? '(缺省/空)' : cs;
    out.storageReading = (() => { try { return localStorage.getItem('mp-reading'); } catch { return 'ERR'; } })();
    out.sel = null; out.docLen = -1; out.cursor = null; out.scrollTop = -1; out.scrollH = -1; out.clientH = -1;
    out.cursorCss = null; out.lineW = -1; out.lineLeft = -1; out.scrollerW = -1; out.contentPadTop = -1;
    out.rulerStart = null; out.textAlign = null;
    const sc = q('.cm-scroller');
    let cv = null;
    try { cv = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null; } catch { }
    if (v) {
      const s = v.state, m = s.selection.main;
      const ln = s.doc.lineAt(m.head);
      out.docLen = s.doc.length;
      out.sel = { anchor: m.anchor, head: m.head, from: m.from, to: m.to, ranges: s.selection.ranges.length };
      out.cursor = { line: ln.number, col: m.head - ln.from, lineFrom: ln.from, text: ln.text.slice(0, 90) };
      out.scrollTop = v.scrollDOM ? v.scrollDOM.scrollTop : -1;
      out.scrollH = v.scrollDOM ? v.scrollDOM.scrollHeight : -1;
      out.clientH = v.scrollDOM ? v.scrollDOM.clientHeight : -1;
      out.hasFocus = v.hasFocus;
      out.viewLines = v.state.doc.lines;
      /* 光标几何：CDP 拍不到原生光标，这里用官方 coordsAtPos + 主编辑面内的 .cm-cursor 双证 */
      out.cursorCoords = (() => { try { const r = v.coordsAtPos(m.head); return { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.bottom - r.top) }; } catch { return null; } })();
      out.cursorInView = (() => { try { const r = v.coordsAtPos(m.head); const sr = v.scrollDOM.getBoundingClientRect(); return r.bottom > sr.top && r.top < sr.bottom; } catch { return null; } })();
      out.cursorCss = (() => {
        try {
          const all = [...v.dom.querySelectorAll('.cm-cursor')];
          const info = all.map((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { display: c.display, visibility: c.visibility, borderLeftWidth: c.borderLeftWidth, w: Math.round(r.width), h: Math.round(r.height), matchedReading: e.matches('[data-mp-reading="1"] .cm-editor:not(.mp-split-source) .cm-cursor') }; });
          /* 【口径】CM6 的 .cm-cursor 常在 DOM 里；隐藏靠的是 display:none（元素级），
             所以"可见"的判据 = display 非 none × width>0；h 单独记账（文末空行的行盒可能很高，h 不足以判可见性）。 */
          return { count: all.length, info, anyVisible: info.some((x) => x.display !== 'none' && x.visibility !== 'hidden' && x.w > 0), anyDisplayNone: info.some((x) => x.display === 'none') };
        } catch (e) { return { err: String(e.message || e) }; }
      })();
      out.contentCss = (() => { const c = q('.cm-editor:not(.mp-split-source) .cm-content') || q('.cm-content'); if (!c) return null; const g = getComputedStyle(c); return { fontSize: g.fontSize, lineHeight: g.lineHeight, maxWidth: g.maxWidth, marginLeft: g.marginLeft, marginRight: g.marginRight, padding: g.paddingTop + ' ' + g.paddingRight + ' ' + g.paddingBottom + ' ' + g.paddingLeft }; })();
      out.lineCount = v.contentDOM.querySelectorAll('.cm-line').length;
    }
    out.rulerStart = v ? { x: (() => { try { return v.coordsAtPos(0).left; } catch { return null; } })(), y: (() => { try { return v.coordsAtPos(0).top; } catch { return null; } })() } : null;
    const ln0 = [...document.querySelectorAll('.cm-editor:not(.mp-split-source) .cm-line')].find((e) => { const r = e.getBoundingClientRect(); return r.height > 0; }) || q('.cm-line');
    if (ln0) { const r = ln0.getBoundingClientRect(); out.lineW = Math.round(r.width); out.lineLeft = Math.round(r.left); out.textAlign = getComputedStyle(ln0).textAlign; }
    if (sc) { out.scrollerW = sc.clientWidth; out.contentPadTop = (() => { const c = q('.cm-editor:not(.mp-split-source) .cm-content') || q('.cm-content'); return c ? getComputedStyle(c).paddingTop : null; })(); }
    const body = getComputedStyle(document.body);
    out.body = { fontSize: body.fontSize, lineHeight: body.lineHeight, textAlign: body.textAlign, justify: body.textJustify };
    const tb = q('.mp-toolbar'), ex = q('.mp-reading-exit'), cl = q('.mp-read-cluster'), typo = q('.mp-typography-btn');
    out.toolbar = { present: !!tb, display: tb ? getComputedStyle(tb).display : null, visible: !!(tb && tb.getBoundingClientRect().width > 0) };
    out.exit = { present: !!ex, display: ex ? getComputedStyle(ex).display : null, visible: !!(ex && ex.getBoundingClientRect().width > 0), text: ex ? String(ex.textContent || '').trim() : null, title: ex ? String(ex.title || '').slice(0, 60) : null };
    out.cluster = { present: !!cl, display: cl ? getComputedStyle(cl).display : null, visible: !!(cl && cl.getBoundingClientRect().width > 0) };
    out.typo = { present: !!typo, display: typo ? getComputedStyle(typo).display : null, visible: !!(typo && typo.getBoundingClientRect().width > 0) };
    out.editor = { present: !!v, isSplitSourceCls: !!(v && v.dom.classList.contains('mp-split-source')) };
    const pane = q('.mp-split-pane'), src = q('.mp-split-source');
    out.split = {
      on: !!pane, panePresent: !!pane, srcPresent: !!src,
      pane: pane ? (() => { const r = pane.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      main: v && v.dom ? (() => { const r = v.dom.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      resizer: !!q('.mp-split-handle, .mp-split-resizer, [data-mp-split-handle]'),
      paneChildren: pane ? pane.children.length : -1,
      hostCls: (v && v.dom && v.dom.parentElement) ? v.dom.parentElement.className : null,
    };
    /* 从视图对象自证型判定：先看 mpSplit._slave()，退回 window.__mpSplitSlaveView */
    const wv = (() => { try { const s = window.mpSplit && window.mpSplit._slave && window.mpSplit._slave(); return s || window.__mpSplitSlaveView || null; } catch { return null; } })();
    out.slave = wv ? (() => {
      const r = wv.dom.getBoundingClientRect();
      return {
        scrollTop: wv.scrollDOM.scrollTop, scrollH: wv.scrollDOM.scrollHeight, clientH: wv.scrollDOM.clientHeight,
        docLen: wv.state.doc.length, readOnly: !!wv.state.readOnly,
        firstLine: (() => { try { return wv.state.doc.line(1).text.slice(0, 40); } catch { return null; } })(),
        domH: Math.round(r.height), domW: Math.round(r.width), cls: wv.dom.className,
      };
    })() : null;
    out.slaveHl = [...document.querySelectorAll('.mp-split-source .cm-line[data-mp-hl]')].map((e) => String(e.textContent || '').slice(0, 60));
    out.find = { panel: !!q('.cm-panel'), panelText: (() => { const p = q('.cm-panel'); return p ? String(p.textContent || '').slice(0, 80) : null; })(), inputVal: (() => { const i = q('.cm-panel input'); return i ? String(i.value || '').slice(0, 40) : null; })(), inputFocus: !!(q('.cm-panel input') && document.activeElement === q('.cm-panel input')), searchMatchSel: (() => { try { const mm = window.mpEngine._view().state.selection.main; return { from: mm.from, to: mm.to, empty: mm.empty }; } catch { return null; } })() };
    out.active = (() => { const a = document.activeElement; return a ? (a.className || a.tagName) : null; })();
    out.hasFocusDoc = document.hasFocus();
    out.banner = (() => { const b = q('#mp-banner'); return b && b.style.display !== 'none' ? String(b.textContent || '').slice(0, 120) : null; })();
    out.toast = (() => { const t2 = [...document.querySelectorAll('div')].find((e) => e.className === 'mp-toast' && e.style.display !== 'none'); return t2 ? String(t2.textContent || '').slice(0, 80) : null; })();
    out.ok = true;
  } catch (e) { out.err = String((e && e.message) || e); }
  return out;
};
const state = (page) => page.evaluate(STATE);

/** CDP 真实鼠标滚轮（不用 JS 造事件） */
async function wheel(page, x, y, dy, { times = 1, gap = 90 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let i = 0; i < times; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });
      await sleep(gap);
    }
  } finally { try { await cdp.detach(); } catch { } }
}

/** 真实鼠标拖拽：按下 → 多次移动 → 抬起 */
async function drag(page, x1, y1, x2, y2, { steps = 12, stepMs = 22 } = {}) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
    await sleep(stepMs);
  }
  await page.mouse.up();
  await sleep(180);
}

/** 等某个渲染侧条件成立（final-state 轮询；超时如实报 waitedMs=null） */
async function waitFor(page, pred, { timeoutMs = 4000, pollMs = 120, arg = null } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await state(page).catch((e) => ({ err: String(e.message || e) }));
    if (!last.err && pred(last, arg)) return { ok: true, waitedMs: Date.now() - t0, st: last };
    await sleep(pollMs);
  }
  return { ok: false, waitedMs: null, st: last };
}

/** 真实鼠标点某个选择器（先报框，点中心） */
async function clickSel(page, sel, { settle = 420 } = {}) {
  const box = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 }; }, sel);
  if (!box || !box.vis) return { clicked: false, box, why: box ? '尺寸为 0（不可点）' : '元素不存在' };
  await page.mouse.click(box.x, box.y);
  await sleep(settle);
  return { clicked: true, box };
}

/** 键盘按键记录器（一次性安装；keydown 只看编辑面内的） */
async function installKeyLog(page) {
  await page.evaluate(() => {
    if (window.__rsKeyLog) return;
    window.__rsKeyLog = [];
    document.addEventListener('keydown', (e) => {
      try {
        const inEditor = !!(e.target && e.target.closest && e.target.closest('.cm-editor'));
        window.__rsKeyLog.push({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, defaultPrevented: e.defaultPrevented, inEditor, at: Date.now() });
        if (window.__rsKeyLog.length > 200) window.__rsKeyLog.shift();
      } catch { }
    }, true);
  });
}
const takeKeyLog = (page) => page.evaluate(() => { const a = window.__rsKeyLog || []; window.__rsKeyLog = []; return a; });

/** 剪贴板取证（纪律 6）：**不拦事件**，只在 copy 之后读 DataTransfer 里到底有什么。
 *  同时挂钩 window.mpHost.writeClipboard，记录渲染侧**请求写**的 text/html 长度与开头。
 *  本机锁屏 ⇒ 系统剪贴板不可用，本函数只能证明"渲染侧提供了什么"，不能证明"剪贴板里有什么"。 */
async function installClipSpy(page) {
  return page.evaluate(() => {
    if (window.__rsClipSpy) return { already: true };
    const spy = { events: [], calls: [] };
    window.__rsClipSpy = spy;
    const origHook = () => {
      const h = window.mpHost;
      if (!h) return false;
      if (!h.__rsWrapped && typeof h.writeClipboard === 'function') {
        const orig = h.writeClipboard.bind(h);
        h.writeClipboard = (payload) => { try { spy.calls.push({ text: String((payload && payload.text) || '').slice(0, 400), textLen: String((payload && payload.text) || '').length, htmlLen: String((payload && payload.html) || '').length }); } catch { } return orig(payload); };
        h.__rsWrapped = true;
      }
      return true;
    };
    origHook();
    const t = setInterval(() => { if (origHook()) clearInterval(t); }, 200);
    setTimeout(() => clearInterval(t), 20000);
    document.addEventListener('copy', (e) => {
      const rec = { kind: 'copy', preventedBySomeone: null, text: null, textLen: null, htmlLen: null, selText: null };
      try { rec.selText = String(window.getSelection() ? window.getSelection().toString() : '').slice(0, 200); } catch { }
      spy.events.push(rec);
      setTimeout(() => {
        try {
          rec.preventedBySomeone = e.defaultPrevented;
          const dt = e.clipboardData;
          if (dt) { rec.textLen = (dt.getData('text/plain') || '').length; rec.text = (dt.getData('text/plain') || '').slice(0, 400); rec.htmlLen = (dt.getData('text/html') || '').length; }
        } catch (err) { rec.err = String(err && err.message || err); }
      }, 0);
    }, true);
    return { installed: true };
  });
}
const takeClipSpy = (page) => page.evaluate(() => { const s = window.__rsClipSpy || { events: [], calls: [] }; window.__rsClipSpy = { events: [], calls: [] }; return s; });

/** beforeinput / 输入记录（用于"阅读态打字到底进不进文档"） */
async function installInputLog(page) {
  return page.evaluate(() => {
    if (window.__rsInputLog) return { already: true };
    window.__rsInputLog = [];
    const push = (kind, e) => { try { window.__rsInputLog.push({ kind, data: e && e.data != null ? String(e.data).slice(0, 20) : null, inputType: e && e.inputType, prevented: e ? e.defaultPrevented : null, at: Date.now() }); if (window.__rsInputLog.length > 100) window.__rsInputLog.shift(); } catch { } };
    document.addEventListener('beforeinput', (e) => push('beforeinput', e), true);
    document.addEventListener('input', (e) => push('input', e), true);
    return { installed: true };
  });
}
const takeInputLog = (page) => page.evaluate(() => { const a = window.__rsInputLog || []; window.__rsInputLog = []; return a; });

/** 在编辑面内找某一行的客户端坐标（用于滚到"第 N 行"再点击/拖拽） */
async function lineBox(page, needle, { which = 'first' } = {}) {
  return page.evaluate((n, w) => {
    const v = window.mpEngine._view();
    const lines = [...v.contentDOM.querySelectorAll('.cm-line')];
    const hits = lines.filter((e) => String(e.textContent || '').includes(n) && e.getBoundingClientRect().height > 0);
    const el = w === 'last' ? hits[hits.length - 1] : hits[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let pos = null;
    try { pos = v.posAtDOM(el); } catch { }
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: Math.round(r.height), text: String(el.textContent || '').slice(0, 80), pos, hits: hits.length };
  }, needle, which);
}

/** 只读窗口内部事实（进程外，不靠渲染侧超时反推） */
function winFacts(app, pid) {
  return { alive: pid ? L.alive(pid) : null, wins: L.myWindows(app.profile).map((w) => `${w.cls}|${w.vis}|${w.title}`), anyMarkPilot: L.anyMarkPilot() };
}

/** 汇总一行（避免散文） */
function row(name, ok, got, want, extra) {
  return { name, ok, got, want, ...(extra ? { extra } : {}) };
}

const sha16 = (p) => require(path.join(__dirname, '_probe-common.cjs')).sha16(p);

module.exports = {
  ...L, sleep, STATE, state, wheel, drag, waitFor, clickSel, installKeyLog, takeKeyLog,
  installClipSpy, takeClipSpy, installInputLog, takeInputLog, lineBox, winFacts, row, sha16,
};
