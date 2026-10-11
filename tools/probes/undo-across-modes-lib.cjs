/** 族 undo-across-modes · 共用尺子（错-4：同一件事只留一份实现）
 *
 *  VERSION 供探针打印自证（"这次跑的确实是这一版尺子"）。
 *  提供：snap（一次 evaluate 拿全相关读数）/ clickSel（真实鼠标）/ focusEditor（真实点进正文）/
 *        installKeyLog（事件层自证）/ resetModes（用例间模式复位）。
 */
'use strict';
const net = require('node:net');
const VERSION = 'undo-across-modes-lib v2 (2026-10-10)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort(lo = 9700, hi = 9980) {
  for (let i = 0; i < 60; i++) {
    const p = lo + Math.floor(Math.random() * (hi - lo));
    if (await portFree(p)) return p;
  }
  throw new Error('找不到空闲调试端口');
}

const TB = '.mp-toolbar button[data-mp-id="';
const BTN = {
  theme: TB + 'theme-toggle"]',
  reading: TB + 'reading-mode"]',
  split: TB + 'split"]',
  themeSettings: TB + 'theme-settings"]',
};

/** 事件层自证：capture 记"键送达了谁"，bubble 记"有没有人 preventDefault" */
const installKeyLog = (page) => page.evaluate(() => {
  window.__ks = [];
  const desc = (t) => (t ? (t.tagName + (t.id ? '#' + t.id : '') + (typeof t.className === 'string' && t.className ? '.' + t.className.trim().split(/\s+/)[0] : '')) : 'null');
  document.addEventListener('keydown', (e) => {
    window.__ks.push({ ph: 'cap', k: e.key, ctrl: !!e.ctrlKey, target: desc(e.target) });
    if (window.__ks.length > 400) window.__ks.shift();
  }, true);
  document.addEventListener('keydown', (e) => {
    window.__ks.push({ ph: 'bub', k: e.key, ctrl: !!e.ctrlKey, prevented: e.defaultPrevented });
    if (window.__ks.length > 400) window.__ks.shift();
  }, false);
  return true;
});

/** 一组相关读数：一次 evaluate 拿全（错-7 第 1 条） */
const snap = (page, tag) => page.evaluate((t) => {
  const out = { tag: t, t: Date.now() };
  try {
    const v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null;
    out.engine = !!v;
    if (v) {
      out.doc = v.state.doc.toString();
      out.len = v.state.doc.length;
      const m = v.state.selection.main;
      out.head = m.head; out.anchor = m.anchor;
      out.lineNo = v.state.doc.lineAt(m.head).number;
      out.col = m.head - v.state.doc.lineAt(m.head).from;
      out.viewHasFocus = v.hasFocus;
      const c = v.dom.querySelector('.cm-cursor');
      out.cursorEl = c ? { display: getComputedStyle(c).display, w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) } : null;
      try {
        const r = v.coordsAtPos(m.head);
        const sc = v.scrollDOM.getBoundingClientRect();
        out.cursorInViewport = r ? (r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1) : null;
      } catch { out.cursorInViewport = 'throw'; }
    }
    const ae = document.activeElement;
    out.active = ae ? (ae.tagName + (ae.id ? '#' + ae.id : '') + (typeof ae.className === 'string' && ae.className ? '.' + ae.className.trim().split(/\s+/)[0] : '')) : null;
    out.activeInEditor = !!(ae && ae.closest && ae.closest('.cm-content'));
    out.docHasFocus = document.hasFocus();
    /* DOM 选区停在哪（机制取证：焦点在 BODY 时，帧选区是否仍留在 .cm-content 里） */
    try {
      const s = document.getSelection();
      const an = s && s.anchorNode;
      out.domSelInContent = !!(an && (an.nodeType === 1 ? an : an.parentElement) && (an.nodeType === 1 ? an : an.parentElement).closest && (an.nodeType === 1 ? an : an.parentElement).closest('.cm-content'));
      out.domSelType = s ? s.type : null;
    } catch { out.domSelInContent = 'throw'; }
    const root = document.documentElement;
    out.theme = { mode: root.dataset.mode || null, editorTheme: root.dataset.editorTheme || null };
    out.reading = root.dataset.mpReading === '1';
    const tb = document.querySelector('.mp-toolbar');
    out.toolbarDisplay = tb ? getComputedStyle(tb).display : 'NO-TOOLBAR';
    const pill = document.querySelector('.mp-reading-exit');
    out.pill = pill ? (() => { const b = pill.getBoundingClientRect(); return { display: getComputedStyle(pill).display, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })() : null;
    out.zoom = (window.mpZoom && window.mpZoom.get) ? window.mpZoom.get() : 'NO-mpZoom';
    const zi = document.getElementById('mp-status-zoom');
    out.zoomInputValue = zi ? zi.value : null;
    const ed = document.querySelector('.cm-editor');
    out.cssZoom = ed ? getComputedStyle(ed).zoom : null;
    out.splitOpen = !!(window.mpSplit && window.mpSplit.isOpen && window.mpSplit.isOpen());
    out.splitPane = !!document.querySelector('.mp-split-pane');
    out.slaveLen = null;
    if (out.splitOpen) {
      try { const s = window.mpSplit._slave(); out.slaveLen = s ? s.state.doc.length : 'null-slave'; } catch (e) { out.slaveLen = 'throw:' + (e && e.message); }
    }
    out.keys = window.__ks ? window.__ks.length : null;
    out.keyTail = window.__ks ? window.__ks.slice(-6) : null;
    out.prodKeyLog = (window.__keyLog || []).slice(-6);
    const bn = document.getElementById('mp-banner');
    out.banner = bn ? { display: getComputedStyle(bn).display, text: (bn.textContent || '').slice(0, 60) } : null;
    out.popCount = document.querySelectorAll('.mp-pop').length;
    out.dlgCount = document.querySelectorAll('.mp-dlg').length;
    out.toast = (() => { const t = document.querySelector('.mp-toast'); return t && getComputedStyle(t).display !== 'none' ? t.textContent.slice(0, 40) : null; })();
  } catch (e) { out.err = String((e && e.message) || e); }
  return out;
}, tag);

/** 真实鼠标点击（先移动、再按下、再抬起；命中自证 hitInside） */
async function clickSel(page, sel, idx = 0) {
  const r = await page.evaluate(({ s, i }) => {
    const list = document.querySelectorAll(s);
    const el = list[i];
    if (!el) return { sel: s, idx: i, found: false, count: list.length };
    const b = el.getBoundingClientRect();
    const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      sel: s, idx: i, found: true, count: list.length, x, y,
      w: Math.round(b.width), h: Math.round(b.height),
      vis: getComputedStyle(el).display !== 'none' && b.width > 0 && b.height > 0,
      hitInside: !!hit && (hit === el || el.contains(hit)),
      hitDesc: hit ? (hit.tagName + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/)[0] : '')) : 'null',
      disabled: !!el.disabled,
    };
  }, { s: sel, i: idx });
  if (!r.found || !r.vis) return { ...r, clicked: false };
  await page.mouse.move(r.x, r.y);
  await sleep(70);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(230);
  return { ...r, clicked: true };
}

/** 真实点进正文并断言焦点到了编辑面（错-10 第 1 条：读最终 activeElement） */
async function focusEditor(page, dy = 130) {
  const r = await page.evaluate((d) => {
    const c = document.querySelector('.cm-content');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    const x = Math.round(b.left + Math.min(180, Math.max(20, b.width / 2)));
    const y = Math.round(b.top + d);
    const hit = document.elementFromPoint(x, y);
    return { x, y, inContent: !!(hit && hit.closest && hit.closest('.cm-content')), hitDesc: hit ? hit.tagName : 'null' };
  }, dy);
  if (!r) return { ok: false, why: 'no .cm-content' };
  await page.mouse.move(r.x, r.y);
  await sleep(50);
  await page.mouse.down();
  await sleep(50);
  await page.mouse.up();
  await sleep(200);
  const ae = await page.evaluate(() => {
    const a = document.activeElement;
    return { inEditor: !!(a && a.closest && a.closest('.cm-content')), desc: a ? a.tagName + (typeof a.className === 'string' && a.className ? '.' + a.className.trim().split(/\s+/)[0] : '') : null, hasFocus: document.hasFocus() };
  });
  return { point: r, ...ae };
}

/** 用例之间把模式复位（真实输入：Esc / 再点一次工具栏按钮） */
async function resetModes(page) {
  const st = await page.evaluate(() => ({
    reading: document.documentElement.dataset.mpReading === '1',
    split: !!(window.mpSplit && window.mpSplit.isOpen && window.mpSplit.isOpen()),
    pop: document.querySelectorAll('.mp-pop').length,
    zoom: window.mpZoom ? window.mpZoom.get() : null,
  }));
  if (st.reading) { await page.keyboard.press('Escape'); await sleep(350); }
  if (st.split) { await clickSel(page, BTN.split); await sleep(350); }
  if (st.pop) { await page.keyboard.press('Escape'); await sleep(250); }
  const after = await page.evaluate(() => ({
    reading: document.documentElement.dataset.mpReading === '1',
    split: !!(window.mpSplit && window.mpSplit.isOpen && window.mpSplit.isOpen()),
    pop: document.querySelectorAll('.mp-pop').length,
  }));
  return { 复位前: st, 复位后: after };
}

module.exports = { VERSION, sleep, pickPort, snap, clickSel, focusEditor, resetModes, installKeyLog, BTN };
