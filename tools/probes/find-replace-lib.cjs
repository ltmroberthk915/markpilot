/** find-replace 族·共用尺子与真实输入通道（单一实现，两个探针 require 同一份——AGENTS 错-4）
 *
 *  纪律落地：
 *   · 启动范式与既有探针一致：spawn(产物, doc, --remote-debugging-port=随机, --user-data-dir=独立 profile)
 *     + MP_DEBUG=1 + delete ELECTRON_RUN_AS_NODE + playwright-core connectOverCDP
 *   · 输入一律真实通道：page.keyboard / page.mouse / CDP Input.*（含 Input.imeSetComposition）
 *   · 一组相关读数一次 evaluate 拿全；`readState` 的 arg 与页面函数签名逐项对齐，并断言"不是默认回退值"
 *   · 关页面后不靠渲染侧超时反推：进程存活看 tasklist / main-debug.log
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();
const RULER = require(path.join(__dirname, '_probe-common.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 夹具 */

function mkFixture(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  if (fs.existsSync(p)) { try { fs.chmodSync(p, 0o644); } catch { } }   // 素材带 ReadOnly：不清掉会 EPERM
  fs.writeFileSync(p, content, 'utf8');
  try { fs.chmodSync(p, 0o644); } catch { }
  return p;
}

/** 从素材拷一份夹具（原件只读；副本清掉 ReadOnly，否则下次覆盖写 EPERM） */
function mkFixtureFrom(dir, name, srcPath) {
  const text = fs.readFileSync(srcPath, 'utf8');
  return mkFixture(dir, name, text);
}

/* ------------------------------------------------------------------ 启动 */

async function launch({ exe, doc, dir, tag = 'run', waitDocChars = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  const profile = path.join(dir, `profile-${tag}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const port = 9600 + Math.floor(Math.random() * 280);
  const env = { ...process.env, MP_DEBUG: '1', MP_TEST_NO_DIALOG: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [doc, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { env, stdio: 'ignore' });
  const kill = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };
  let browser = null;
  for (let i = 0; i < 45 && !browser; i++) {
    await sleep(1000);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { }
  }
  if (!browser) { kill(); throw new Error('CDP 连不上 port=' + port); }
  const ctx = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 90 && !page; i++) {
    for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
      const ok = await p.evaluate(() => { try { return !!(window.mpEngine && window.mpHost && window.mpEngine._view && window.mpEngine._view()); } catch { return false; } }).catch(() => false);
      if (ok) { page = p; break; }
    }
    if (!page) await sleep(500);
  }
  if (!page) { try { browser.close(); } catch { } kill(); throw new Error('找不到引擎页'); }
  /* 文档真的装进去了才算就绪（不是"页面连上"就当就绪） */
  let chars = -1;
  for (let i = 0; i < 60; i++) {
    chars = await page.evaluate(() => (window.mpEngine._view().state.doc.length)).catch(() => -1);
    if (chars >= waitDocChars && chars > 0) break;
    await sleep(250);
  }
  if (chars <= 0) { try { browser.close(); } catch { } kill(); throw new Error('文档未装载 chars=' + chars); }
  await sleep(900);
  const cdp = await ctx.newCDPSession(page);
  const logFile = path.join(profile, 'main-debug.log');
  /* 渲染侧异常留痕（崩溃/pageerror 是每族必报项） */
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('crash', () => pageErrors.push('PAGE_CRASH'));
  return { child, browser, ctx, page, cdp, port, profile, logFile, kill, docChars: chars, pageErrors, consoleErrors };
}

/* ------------------------------------------------------- 页面内：采样与记录 */

/** 安装记录器：劫持 view.dispatch（每次事务后采一次全量读数）+ 输入事件留痕。
 *  页面函数自带，无闭包依赖；返回安装结果（自证：hook 真的挂上了）。 */
async function installRecorder(page) {
  return await page.evaluate(() => {
    const v = window.mpEngine._view();
    if (!v) return { ok: false, why: 'no-view' };
    const q = (sel, root) => (root || document).querySelector(sel);
    const qa = (sel, root) => [...(root || document).querySelectorAll(sel)];

    /* —— 引擎侧真相：从 state.values 里翻出 search state field（@codemirror/search 的 searchState）。
       注意 state.config.fields 在打包产物里不存在，只能扫 state.values（首轮用 config.fields 取不到）。 —— */
    function fieldValue(state, pred) {
      try {
        const vs = state.values;
        if (!vs || typeof vs.length !== 'number') return null;
        for (let i = 0; i < vs.length; i++) { const val = vs[i]; if (val && pred(val)) return { val, slot: i }; }
      } catch (e) { }
      return null;
    }
    const isSearchState = (x) => !!(x && x.query && typeof x.query.matchAll === 'function');

    function sample(why, evUser) {
      const st = v.state;
      const sel = st.selection.main;
      const panel = q('.cm-search');
      const pan = q('.cm-panels');
      const f = (sel2) => { const el = panel ? q(sel2, panel) : null; return el; };
      const sf = f('input[name=search]'), rf = f('input[name=replace]');
      const markRects = qa('.cm-content .cm-searchMatch').map((m) => { const r = m.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
      const selRects = qa('.cm-content .cm-searchMatch-selected').map((m) => { const r = m.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
      const found = fieldValue(st, isSearchState);
      let eng = null;
      if (found) {
        const qy = found.val.query, sp = qy.spec || qy;   // state.query 是 StringQuery/RegExpQuery 壳，真字段在 .spec（诊断探针实证）
        let matches = null, matchErr = null;
        if (sp.valid) { try { matches = qy.matchAll(st, 2000); } catch (e) { matchErr = String((e && e.message) || e); } }
        const rank = matches ? matches.findIndex((m) => m.from === sel.from && m.to === sel.to) : -1;
        eng = {
          search: sp.search, replace: sp.replace, valid: !!sp.valid, caseSensitive: !!sp.caseSensitive,
          regexp: !!sp.regexp, wholeWord: !!sp.wholeWord, literal: !!sp.literal,
          matchCount: matches ? matches.length : null, matchCapped: matches ? false : true, matchErr,
          currentRank: rank, panelOpen: !!(found.val.panel),
        };
      }      const act = document.activeElement;
      return {
        t: Date.now(), why: why || '', evUser: evUser || null,
        docLen: st.doc.length,
        sel: { from: sel.from, to: sel.to, empty: sel.empty, text: st.sliceDoc(sel.from, sel.to) },
        panel: {
          present: !!pan, top: !!q('.cm-panels-top'), bottom: !!q('.cm-panels-bottom'),
          searchExists: !!sf, searchValue: sf ? sf.value : null,
          replaceExists: !!rf, replaceValue: rf ? rf.value : null,
          caseChecked: f('input[name=case]') ? f('input[name=case]').checked : null,
          reChecked: f('input[name=re]') ? f('input[name=re]').checked : null,
          wordChecked: f('input[name=word]') ? f('input[name=word]').checked : null,
          buttons: panel ? qa('button', panel).map((b) => b.name) : [],
        },
        dom: { marks: markRects.length, markRects, selMarks: selRects.length, selRects, selectionMatch: qa('.cm-content .cm-selectionMatch').length },
        eng,
        focus: { tag: act ? act.tagName : null, name: act ? (act.name || '') : null, isSearchField: act === sf, viewHasFocus: !!v.hasFocus, docHasFocus: document.hasFocus() },
        scrollTop: Math.round(v.scrollDOM.scrollTop),
        keyLogTail: (window.__keyLog || []).slice(-6),
        inputLogTail: (window.__frInputLog || []).slice(-6),
      };
    }

    if (window.__frInstalled) {
      window.__frSteps = [];
      return { ok: true, reinstalled: true, steps: 0 };
    }
    window.__frInstalled = true;
    window.__frSteps = [];
    window.__frInputLog = [];
    window.__frSample = sample;
    const orig = v.dispatch.bind(v);
    window.__frOrigDispatch = orig;
    v.dispatch = function (...args) {
      const ret = orig(...args);
      try {
        const evUser = args.map((a) => (a && (a.userEvent || (a.effects ? 'effects' : a.changes ? 'changes' : 'spec')))).join(',');
        window.__frSteps.push(sample('dispatch', evUser));
        if (window.__frSteps.length > 4000) window.__frSteps.shift();
      } catch (e) { window.__frSteps.push({ err: String(e && e.message || e) }); }
      return ret;
    };
    /* 输入事件留痕：证明"真实通道到底送达了什么"（keyup 是面板 commit 的触发条件） */
    for (const type of ['keydown', 'keyup', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'paste']) {
      document.addEventListener(type, (e) => {
        const t = e.target;
        window.__frInputLog.push({ type, key: e.key || null, data: (e.data === undefined ? null : e.data), value: t && t.value !== undefined ? t.value : null, name: t && t.name ? t.name : null, prevented: e.defaultPrevented });
        if (window.__frInputLog.length > 600) window.__frInputLog.shift();
      }, true);
    }
    return { ok: true, reinstalled: false, steps: 0 };
  });
}

const readSteps = (page, limit = 200) => page.evaluate((n) => (window.__frSteps || []).slice(-n), limit);
const readInputLog = (page, limit = 200) => page.evaluate((n) => (window.__frInputLog || []).slice(-n), limit);
const clearSteps = (page) => page.evaluate(() => { window.__frSteps = []; window.__frInputLog = []; return true; });

/** 一次 evaluate 拿全的读数；arg 与页面函数签名逐项对齐，并断言不是默认回退值 */
async function readState(page, arg) {
  if (!arg || typeof arg !== 'object' || !('label' in arg)) throw new Error('readState: arg 缺失或形状不对（必须 {label, scanTerm?, scanCI?}）');
  const out = await page.evaluate((a) => {
    const v = window.mpEngine._view();
    if (!v) return { fatal: 'no-view', label: a.label };
    const q = (s, r) => (r || document).querySelector(s);
    const qa = (s, r) => [...(r || document).querySelectorAll(s)];
    const st = v.state, sel = st.selection.main, panel = q('.cm-search'), pan = q('.cm-panels');
    const sf = panel ? q('input[name=search]', panel) : null, rf = panel ? q('input[name=replace]', panel) : null;
    const rects = (s) => qa(s).map((m) => { const r = m.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    /* 自算命中数（独立尺子：直接扫文档字符串），与引擎 query 互校 */
    let ownCount = null;
    if (a.scanTerm) {
      let text = st.doc.toString(), term = a.scanTerm;
      if (a.scanCI) { text = text.toLowerCase(); term = term.toLowerCase(); }
      let n = 0, p = 0;
      while (term.length && (p = text.indexOf(term, p)) >= 0) { n++; p += term.length; }
      ownCount = n;
    }
    const act = document.activeElement;
    return {
      label: a.label,
      docLen: st.doc.length, lines: st.doc.lines,
      docHead: st.sliceDoc(0, Math.min(40, st.doc.length)), docTail: st.sliceDoc(Math.max(0, st.doc.length - 24)),
      sel: { from: sel.from, to: sel.to, empty: sel.empty, text: st.sliceDoc(sel.from, sel.to) },
      panel: {
        present: !!pan, top: !!q('.cm-panels-top'), bottom: !!q('.cm-panels-bottom'),
        searchExists: !!sf, searchValue: sf ? sf.value : null,
        replaceExists: !!rf, replaceValue: rf ? rf.value : null,
        caseChecked: panel && q('input[name=case]', panel) ? q('input[name=case]', panel).checked : null,
        reChecked: panel && q('input[name=re]', panel) ? q('input[name=re]', panel).checked : null,
        wordChecked: panel && q('input[name=word]', panel) ? q('input[name=word]', panel).checked : null,
        buttons: panel ? qa('button', panel).map((b) => b.name) : [],
        rect: pan ? (() => { const r = pan.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null,
        searchRect: sf ? (() => { const r = sf.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() : null,
      },
      dom: { marks: rects('.cm-content .cm-searchMatch').length, markRects: rects('.cm-content .cm-searchMatch'), markTexts: qa('.cm-content .cm-searchMatch').map((m) => m.textContent), selMarks: rects('.cm-content .cm-searchMatch-selected').length, selRects: rects('.cm-content .cm-searchMatch-selected'), selectionMatch: rects('.cm-content .cm-selectionMatch').length },
      panelCount: qa('.cm-search').length,
      allSearchFieldValues: qa('.cm-search input[name=search]').map((e) => e.value),
      focus: { tag: act ? act.tagName : null, name: act ? (act.name || '') : null, cls: act ? String(act.className || '').slice(0, 40) : null, isSearchField: act === sf, isReplaceField: act === rf, viewHasFocus: !!v.hasFocus, docHasFocus: document.hasFocus() },
      caretRect: (() => { try { const r = v.coordsAtPos(sel.head); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.bottom)] : null; } catch (e) { return null; } })(),
      scrollTop: Math.round(v.scrollDOM.scrollTop),
      ownScanCount: ownCount,
      ownScanTerm: a.scanTerm || null,
      docText: a.wantText ? st.doc.toString() : null,
      keyLogTail: (window.__keyLog || []).slice(-8),
    };
  }, arg);
  if (out && out.fatal) throw new Error('readState fatal: ' + out.fatal);
  return out;
}

/** 引擎侧真相（search state field）+ 自算命中数，一次拿全；用于断言"不是默认回退值" */
async function readEngine(page, arg) {
  if (!arg || !('label' in arg)) throw new Error('readEngine: arg 形状不对');
  return await page.evaluate((a) => {
    const v = window.mpEngine._view();
    const out = { label: a.label, fieldFound: false, engine: null, ownCount: null, domMarks: document.querySelectorAll('.cm-content .cm-searchMatch').length };
    const v0 = window.mpEngine._view(), st0 = v0.state, sel0 = st0.selection.main;
    out.sel = { from: sel0.from, to: sel0.to, empty: sel0.empty, text: st0.sliceDoc(sel0.from, sel0.to) };
    out.docLen = st0.doc.length;
    out.activeName = document.activeElement ? (document.activeElement.name || document.activeElement.tagName) : null;
    out.searchFieldValue = (() => { const el = document.querySelector('.cm-search input[name=search]'); return el ? el.value : null; })();
    out.markTexts = [...document.querySelectorAll('.cm-content .cm-searchMatch')].map((m) => m.textContent);
    out.panelCount = document.querySelectorAll('.cm-search').length;
    try {
      const st = v0.state, vs = st.values;
      for (let i = 0; i < (vs ? vs.length : 0); i++) {
        const val = vs[i];
        if (val && val.query && typeof val.query.matchAll === 'function') {
          const qy = val.query, sp = qy.spec || qy, sel = st.selection.main;
          out.fieldFound = true;
          let ms = null, mErr = null;
          if (sp.valid) { try { ms = qy.matchAll(st, 3000); } catch (e) { mErr = String((e && e.message) || e); } }
          out.engine = {
            search: sp.search, replace: sp.replace, valid: !!sp.valid, caseSensitive: !!sp.caseSensitive, regexp: !!sp.regexp, wholeWord: !!sp.wholeWord, literal: !!sp.literal,
            panelOpen: !!val.panel, matchCount: ms ? ms.length : null, capped: !ms, matchErr: mErr,
            matches: ms ? ms.slice(0, 40).map((m) => [m.from, m.to]) : null,
            currentRank: ms ? ms.findIndex((m) => m.from === sel.from && m.to === sel.to) : -1,
            sel: [sel.from, sel.to], selText: st.sliceDoc(sel.from, sel.to), docLen: st.doc.length,
            activeName: document.activeElement ? (document.activeElement.name || document.activeElement.tagName) : null,
          };
          break;
        }
      }
    } catch (e) { out.err = String(e && e.message || e); }
    if (a.scanTerm) {
      let text = v.state.doc.toString(), term = a.scanTerm;
      if (a.scanCI) { text = text.toLowerCase(); term = term.toLowerCase(); }
      let n = 0, p = 0; while (term.length && (p = text.indexOf(term, p)) >= 0) { n++; p += term.length; }
      out.ownCount = n;
    }
    return out;
  }, arg);
}

/* ------------------------------------------------------------ 真实输入通道 */

/** 工具栏按钮：真实鼠标点击（合成 .click() 无效——必须走过 mousedown/up 的命中测试） */
async function mouseClickSelector(page, selector, { settle = 220 } = {}) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
  }, selector);
  if (!box) throw new Error('找不到元素 ' + selector);
  if (!box.visible) throw new Error('元素不可见（zero-size）' + selector);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.up();
  await sleep(settle);
  return box;
}

/** 真实键盘逐字符（走 keydown/keypress/keyup，ASCII 与可映射字符有效） */
async function typeChars(page, text, delay = 70) {
  for (const ch of text) { await page.keyboard.type(ch, { delay: 0 }); await sleep(delay); }
  return text.length;
}

/** 真实键盘按普通键 */
const pressKey = async (page, key, opts = {}) => { await page.keyboard.press(key, opts); await sleep(opts.settle === undefined ? 260 : opts.settle); };

/** 中文：真实 IME 组字（CDP Input.imeSetComposition）+ 提交（Input.insertText）+ 组字键的真实 keyUp。
 *  返回每一步的自证读数（composition 事件到底有没有发生）。 */
async function imeType(page, cdp, text, gap = 160) {
  const witness = [];
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Process', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, text: '' }).catch(() => { });
    let compOk = true;
    try {
      await cdp.send('Input.imeSetComposition', { text: ch, selectionStart: ch.length, selectionEnd: ch.length });
    } catch (e) { compOk = false; }
    await sleep(60);
    await cdp.send('Input.insertText', { text: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' }).catch(() => { });
    witness.push({ ch, compOk });
    await sleep(gap);
  }
  return witness;
}

/** 剪贴板粘贴：真 OS 剪贴板 + 真实 Ctrl+V（中文常用路径之一）。
 *  剪贴板是**跨进程共享资源**（同族其他探针在跑时会被占用）⇒ 重试 3 次；仍失败就抛，由调用方记"未验证"。 */
async function pasteText(page, text, tries = 3) {
  const tmp = path.join(process.env.TEMP || '.', 'mp-fr-clip.txt');
  fs.writeFileSync(tmp, text, 'utf8');
  const cmd = `powershell -NoProfile -Command "Set-Clipboard -Value ([IO.File]::ReadAllText('${tmp.replace(/\\/g, '\\\\')}',[Text.Encoding]::UTF8))"`;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { execSync(cmd, { windowsHide: true, stdio: 'pipe' }); lastErr = null; break; }
    catch (e) { lastErr = e; await sleep(400 + i * 400); }
  }
  if (lastErr) throw new Error('Set-Clipboard 失败（剪贴板被其他进程占用，重试 ' + tries + ' 次）：' + String(lastErr.message).split('\n')[0]);
  await sleep(150);
  await page.keyboard.press('Control+v');
  await sleep(400);
}

/** 真实鼠标点击编辑面（把焦点交给编辑器；不是 JS focus）。
 *  必须用 elementFromPoint 校验落点真的在 .cm-content 内——顶部工具岛会盖住内容区前 ~45px，
 *  盲点 (content.left+60, content.top+8) 会点到工具栏按钮上（本族第一轮就是这么误点的）。 */
async function clickEditor(page, opts = {}) {
  const pts = opts.points || [[60, 90], [200, 130], [420, 240], [700, 320]];
  const box = await page.evaluate(() => {
    const el = document.querySelector('.cm-content');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  if (!box) throw new Error('找不到 .cm-content');
  const tried = [];
  for (const [dx, dy] of pts) {
    const x = box.left + dx, y = box.top + dy;
    if (y > box.top + box.h - 12) continue;
    const hit = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el ? { cls: String(el.className || ''), inContent: !!el.closest('.cm-content') } : null;
    }, [x, y]);
    tried.push({ x: Math.round(x), y: Math.round(y), hit });
    if (!hit || !hit.inContent) continue;
    await page.mouse.move(x, y);
    await page.mouse.down(); await sleep(30); await page.mouse.up();
    await sleep(220);
    const focused = await page.evaluate(() => !!window.mpEngine._view().hasFocus);
    if (focused) return { x: Math.round(x), y: Math.round(y), focused, hit, tried };
  }
  const focused = await page.evaluate(() => !!window.mpEngine._view().hasFocus);
  return { focused, tried, failed: true };
}

async function shot(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  return file;
}

/** 主进程侧事实（不靠渲染侧超时反推） */
function procAlive(exe) {
  try {
    const o = execSync('tasklist /FI "IMAGENAME eq MarkPilot.exe" /FO CSV', { encoding: 'utf8', windowsHide: true });
    return o.trim().split('\n').length - 1;
  } catch { return -1; }
}
function debugLogLines(file, needle) {
  try {
    const t = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !needle || l.includes(needle));
    return { count: t.length, tail: t.slice(-6) };
  } catch (e) { return { count: -1, tail: [String(e.message)] }; }
}

module.exports = { sleep, RULER, mkFixture, mkFixtureFrom, launch, installRecorder, readSteps, readInputLog, clearSteps, readState, readEngine, mouseClickSelector, clickEditor, typeChars, pressKey, imeType, pasteText, shot, procAlive, debugLogLines };
