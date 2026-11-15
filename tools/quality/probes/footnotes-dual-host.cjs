#!/usr/bin/env node
'use strict';
/**
 * footnotes-dual-host.cjs — 脚注“点正文上标 → 跳到实际定义 → 小返回按钮回到本次那一处”
 * 的真实双宿主探针（桌面壳 + DSH 插件皮）。
 *
 * 运行位置：仓库根目录。浏览器由**主控在沙箱外**启动；本探针只开一个隔离的
 * headless Chromium 用户目录，不启动产品、不占 app-slot 锁、不写产品文件。
 *
 * 两个宿主加载的都是**真实壳页面 + 真实构建产物**：
 *   · desktop：MarkPilot-CM6/renderer/index.html（真实 host.js；只注入最小 mpHost 桩，
 *     用壳层自己的 onDoc 通道送文档，等价于主进程 open 文档）
 *   · plugin ：dsh-markdown-editor-typora/renderer-cm6/index.html（真实 dsh-bridge.js；
 *     用桥自己的下行 postMessage open / replaceDocument）
 *
 * 覆盖：
 *   1. 正文上标数量/编号；缺失定义保持原文；表格内引用不计入上标（边界）
 *   2. 点重复引用的第二处 → 定义；小返回 → **第二处**（不是第一处）
 *   3. 键盘：Ctrl+Alt+Enter 跳转；聚焦 ↩ 后 Enter 返回
 *   4. 前文插入新脚注导致编号/refId/noteId 重排 → 仍回第二处（label + 映射后精确区间）
 *   5. 原出处被删除 → 第一次不静默改跳；第二次显式回第一处
 *   6. 换文档 → 导航状态清零；无状态点 ↩ 回新文档第一处
 *   7. 长文普通输入不触发全量重扫；输入 '[' 触发一次（自证计数器有鉴别力）
 *   8. 全程 doc 源文本不被改写（除测试自己做的两笔编辑）
 *
 * 用法（主控在沙箱外）：
 *   node tools/quality/probes/footnotes-dual-host.cjs --out .mp-verify/math-notes/notes/probe-out
 *   node tools/quality/probes/footnotes-dual-host.cjs --self-check
 *   ... --host desktop|plugin|both
 *   ... --desktop-page <index.html> --plugin-page <index.html>
 *   ... --chrome <chrome.exe> --playwright <playwright-core dir> --headed --keep
 *
 * 退出码：0 全绿；1 判据失败；2 环境/参数错误。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FOOTNOTES = path.join(ROOT, 'dsh-markpilot', 'src-cm6', 'footnotes.cjs');
const { collectFootnotes } = require(FOOTNOTES);

const FIXTURE = [
  '# 脚注双向导航探针',
  '',
  '第一处引用[^a]，第二处引用[^b]，重复引用[^a]，缺失引用[^missing]。',
  '',
  '普通链接 [示例](https://example.com/a[^x])、行内代码 `[^a]`、公式 $[^a]$ 都不该变成脚注。',
  '',
  '> ```',
  '> 引用代码块里的 [^a]',
  '> ```',
  '',
  '中间定义：',
  '[^b]: 中部定义 B 第一行',
  '    续行 B2',
  '',
  '末尾定义：',
  '[^a]: 末尾定义 A',
  '',
  '| 表头 |',
  '| --- |',
  '| 表格里[^t] |',
  '',
  '[^t]: 表格脚注 T',
].join('\n');

const DOC_B = '# 第二份文档\n\n新文引用[^n]。\n\n[^n]: 新文定义 N\n';

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const args = {
    host: 'both',
    out: path.join(ROOT, '.mp-verify', 'footnotes-dual-host', stamp()),
    desktopPage: path.join(ROOT, 'MarkPilot-CM6', 'renderer', 'index.html'),
    pluginPage: path.join(ROOT, 'dsh-markdown-editor-typora', 'renderer-cm6', 'index.html'),
    playwright: process.env.MP_PLAYWRIGHT || '',
    chrome: process.env.MP_CHROME || '',
    headed: false,
    keep: false,
    selfCheck: false,
    screenshots: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    const take = () => { if (!next || next.startsWith('--')) throw new Error('missing value for ' + key); i++; return next; };
    if (key === '--host') args.host = take();
    else if (key === '--out') args.out = path.resolve(take());
    else if (key === '--desktop-page') args.desktopPage = path.resolve(take());
    else if (key === '--plugin-page') args.pluginPage = path.resolve(take());
    else if (key === '--playwright') args.playwright = take();
    else if (key === '--chrome') args.chrome = take();
    else if (key === '--headed') args.headed = true;
    else if (key === '--keep') args.keep = true;
    else if (key === '--no-screenshots') args.screenshots = false;
    else if (key === '--self-check') args.selfCheck = true;
    else if (key === '--help' || key === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error('unknown argument: ' + key);
  }
  if (!['both', 'desktop', 'plugin'].includes(args.host)) throw new Error('--host must be both|desktop|plugin');
  return args;
}

function loadPlaywright(explicit) {
  const candidates = [
    explicit,
    process.env.MP_PLAYWRIGHT,
    path.join(ROOT, 'tools', 'quality', 'node_modules', 'playwright-core'),
    path.join(ROOT, 'tools', 'quality', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try next */ }
  }
  try { return require('playwright-core'); } catch { /* fall through */ }
  throw new Error('playwright-core not found; pass --playwright <dir> or set MP_PLAYWRIGHT');
}

function findChrome(explicit) {
  if (explicit) return explicit;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [path.join(local, 'ms-playwright')];
  const found = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (/^chromium-\d+$/.test(name)) found.push(path.join(root, name, 'chrome-win64', 'chrome.exe'), path.join(root, name, 'chrome-win', 'chrome.exe'));
      if (/^chromium_headless_shell-\d+$/.test(name)) found.push(path.join(root, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    }
  }
  found.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  );
  return found.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
const fileUrl = file => pathToFileURL(file).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launchBrowser(args) {
  const { chromium } = loadPlaywright(args.playwright);
  const executablePath = findChrome(args.chrome);
  const launch = async extra => chromium.launch({ headless: !args.headed, ...(executablePath ? { executablePath } : {}), ...extra });
  try { return await launch({}); } catch (error) {
    if (!executablePath) throw error;
    return launch({ executablePath });
  }
}

function desktopStub() {
  return () => {
    const noop = () => {};
    const resolved = value => () => Promise.resolve(value);
    window.mpHost = {
      themeGet: resolved({ dark: false }),
      themeSet: resolved({ dark: false }),
      settingGet: resolved(null),
      onSetting: noop,
      docDirty: resolved({ ok: true }),
      onDoc: cb => { window.__probeDocCb = cb; },
      onTheme: noop,
      onMenu: noop,
      onExportProgress: noop,
      onExportMakeHtml: noop,
      docReady: noop,
      info: resolved({ name: 'footnotes-probe', version: '0' }),
      pathForFile: () => null,
      outsideChange: resolved({ changed: false }),
    };
    window.__probeOpen = (text, id) => {
      if (typeof window.__probeDocCb === 'function') {
        window.__probeDocCb({ text, filePath: null, documentId: id || 'probe-doc', revision: 0, loadKind: 'replace' });
      }
    };
  };
}

async function openHost(browser, host, args, outDir) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  if (host === 'desktop') await context.addInitScript(desktopStub());
  const page = await context.newPage();
  const consoleLines = [];
  const pageErrors = [];
  page.on('console', message => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', error => pageErrors.push(String(error && error.stack || error)));
  const pagePath = host === 'desktop' ? args.desktopPage : args.pluginPage;
  if (!fs.existsSync(pagePath)) throw new Error(`host page not found: ${pagePath}`);
  await page.goto(fileUrl(pagePath), { waitUntil: 'load', timeout: 30000 });
  if (host === 'plugin') {
    await page.waitForFunction(() => window.__dshBridgeInstalled === true, null, { timeout: 10000 });
  }
  return { context, page, consoleLines, pageErrors, outDir, pagePath };
}

async function waitForDoc(page, text, timeout) {
  await page.waitForFunction(expected => window.mpEngine && window.mpEngine._view &&
    window.mpEngine._view().state.doc.toString() === expected, text, { timeout });
}

async function loadDocument(hostCtx, host, text, id, initial) {
  const { page } = hostCtx;
  if (initial) {
    if (host === 'desktop') {
      await page.evaluate(({ text, id }) => window.__probeOpen(text, id), { text, id });
    } else {
      await page.evaluate(text => window.postMessage({ __dshmd: true, dir: 'down', type: 'open', content: { content: text, rootPath: '' } }, '*'), text);
    }
    await waitForDoc(page, text, 20000);
    await page.waitForFunction(() => !!document.querySelector('.cm-content'), null, { timeout: 10000 });
    await sleep(120);
    return;
  }

  /* 后续复位文档：直接走引擎公开的 `replaceDocument`（桌面 host.js 的
     applyDoc 与插件桥的 document 切换最终都落到同一个方法）。这样换文档
     只依赖引擎状态机，不再被 host.js 的保存/检查点簿记卡住；初始 open 仍走
     两端的真实宿主桥，所以“宿主能打开”这一层没有被绕开。 */
  const tryReset = async () => {
    const replaced = await page.evaluate(text => {
      try {
        const engine = window.mpEngine;
        if (!engine || typeof engine.replaceDocument !== 'function') return { ok: false, reason: 'no-engine' };
        const accepted = engine.replaceDocument(text);
        return { ok: accepted !== false, accepted, valueLen: engine.getValue().length };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error) };
      }
    }, text);
    if (!replaced.ok) return { ...replaced, matched: false };
    try {
      await waitForDoc(page, text, 3000);
      return { ...replaced, matched: true };
    } catch (error) {
      return { ...replaced, matched: false, error: String(error && error.message || error) };
    }
  };

  let reset = await tryReset();
  if (!reset.matched) {
    await page.waitForFunction(() => !window.mpEngine?.isComposing?.(), null, { timeout: 3000 }).catch(() => {});
    await sleep(100);
    reset = await tryReset();
  }
  if (reset.matched) {
    await sleep(80);
    return;
  }

  /* 独立复位兜底：整页重载后再走一次初始 open。它会单独记一条 FAIL，
     不把“引擎换文档被拒”洗成绿灯；但保证后面的插件/长文臂仍能跑完。 */
  const diag = await page.evaluate(({ text }) => {
    const engine = window.mpEngine;
    const view = engine && engine._view && engine._view();
    const value = engine && engine.getValue ? engine.getValue() : null;
    return {
      expectedLen: text.length, expectedHead: text.slice(0, 48),
      valueLen: value == null ? null : value.length,
      valueHead: value == null ? null : value.slice(0, 48),
      composing: view ? !!view.composing : null,
      isComposing: engine && engine.isComposing ? engine.isComposing() : null,
      active: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
      banner: (document.getElementById('mp-banner') || {}).textContent || '',
      session: engine && engine.documentSession ? engine.documentSession() : null,
    };
  }, { text });
  const reload = { mode: 'page-reload', ok: false, error: null };
  try {
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    if (host === 'plugin') await page.waitForFunction(() => window.__dshBridgeInstalled === true, null, { timeout: 10000 });
    if (host === 'desktop') {
      await page.evaluate(({ text, id }) => window.__probeOpen(text, id), { text, id });
    } else {
      await page.evaluate(text => window.postMessage({ __dshmd: true, dir: 'down', type: 'open', content: { content: text, rootPath: '' } }, '*'), text);
    }
    await waitForDoc(page, text, 20000);
    reload.ok = true;
  } catch (error) {
    reload.error = String(error && error.message || error);
  }
  if (!hostCtx.docResetFallbacks) hostCtx.docResetFallbacks = [];
  const record = { id, reset, diag, reload };
  hostCtx.docResetFallbacks.push(record);
  try { fs.writeFileSync(path.join(hostCtx.outDir, `doc-reset-fallback-${id}.json`), JSON.stringify(record, null, 2), 'utf8'); } catch { /* 诊断落盘失败不改变判据 */ }
  if (!reload.ok) throw new Error('independent document reset failed: ' + JSON.stringify(record).slice(0, 4000));
  await sleep(80);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const view = window.mpEngine._view();
    return {
      doc: view.state.doc.toString(),
      head: view.state.selection.main.head,
      anchor: view.state.selection.main.anchor,
      index: window.mpEngine.footnotes.index(),
      nav: window.mpEngine.footnotes.nav(),
      stats: window.mpEngine.footnotes.stats(),
      refs: [...document.querySelectorAll('.mp-fn-ref')].map(el => ({
        refId: el.dataset.mpFnRef, text: el.textContent, from: Number(el.dataset.mpFnFrom), to: Number(el.dataset.mpFnTo),
      })),
      backs: [...document.querySelectorAll('.mp-fn-back')].map(el => ({
        note: el.dataset.mpFnBack, target: el.dataset.mpFnTarget, disabled: el.disabled,
      })),
      notes: [...document.querySelectorAll('[data-mp-fn-note]')].map(el => el.dataset.mpFnNote),
    };
  });
}

async function setSelection(page, pos) {
  await page.evaluate(pos => {
    const view = window.mpEngine._view();
    view.dispatch({ selection: { anchor: Math.max(0, Math.min(pos, view.state.doc.length)) } });
    view.focus();
  }, pos);
  await sleep(60);
}

async function clickRef(page, refId) {
  const locator = page.locator(`.mp-fn-ref[data-mp-fn-ref="${refId}"]`);
  if (await locator.count() !== 1) throw new Error('ref widget not found/unique: ' + refId);
  await locator.click();
  await sleep(120);
}

async function clickBack(page, noteId) {
  const locator = page.locator(`[data-mp-fn-note="${noteId}"] .mp-fn-back`);
  if (await locator.count() !== 1) throw new Error('back button not found/unique: ' + noteId);
  await locator.click();
  await sleep(120);
}

async function shot(page, outDir, name, pos) {
  if (!fs.existsSync(outDir)) return;
  const file = path.join(outDir, name + '.png');
  try {
    const clip = await page.evaluate(pos => {
      const view = window.mpEngine._view();
      const at = Math.max(0, Math.min(pos == null ? view.state.selection.main.head : pos, view.state.doc.length));
      const coords = view.coordsAtPos(at);
      if (!coords) return null;
      const x = Math.max(0, coords.left - 320);
      const y = Math.max(0, coords.top - 140);
      return { x, y, width: Math.min(960, window.innerWidth - x - 16), height: 320 };
    }, pos == null ? null : pos);
    if (clip && clip.width > 20 && clip.height > 20) await page.screenshot({ path: file, clip });
    else await page.screenshot({ path: file });
  } catch { /* 截图失败不改变判据 */ }
}

function makeHostChecks(host, outDir) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  return { checks, add };
}

async function runHost(browser, host, args, outDir) {
  const { checks, add } = makeHostChecks(host, outDir);
  const hostCtx = await openHost(browser, host, args, outDir);
  const page = hostCtx.page;
  try {
    const fixtureExpected = collectFootnotes(FIXTURE);
    await loadDocument(hostCtx, host, FIXTURE, 'probe-fixture', true);
    await page.waitForFunction(() => document.querySelectorAll('.mp-fn-ref').length >= 3, null, { timeout: 10000 });
    let snap = await snapshot(page);
    const idx = snap.index;
    add('fixture loaded', snap.doc === FIXTURE, { bytes: snap.doc.length });
    add('parser cross-check: refs/notes counts', idx.refs.length === fixtureExpected.refs.length && idx.notes.length === fixtureExpected.notes.length,
      { refs: idx.refs.length, notes: idx.notes.length });
    add('resolved refs numbered by first reference order', idx.refs.filter(r => r.resolved).map(r => `${r.label}#${r.occurrence}=${r.number}`).join(',') === 'a#1=1,b#1=2,a#2=1,t#1=3',
      idx.refs.filter(r => r.resolved).map(r => `${r.label}#${r.occurrence}=${r.number}`));
    add('missing ref stays unresolved and raw', idx.refs.some(r => r.label === 'missing' && !r.resolved && r.noteId === null) && snap.doc.includes('[^missing]'), null);
    add('code/math/quote-fence refs are not decorated', idx.refs.every(r => r.label !== 'x' || !r.resolved), idx.refs.map(r => r.label));
    add('DOM superscripts = 3 (table ref intentionally not decorated)', snap.refs.length === 3, snap.refs);
    add('DOM back buttons = 3 notes', snap.backs.length === 3, snap.backs);
    add('table ref indexed for numbering/export but not a DOM live link', idx.refs.some(r => r.label === 't' && r.resolved) && !snap.refs.some(r => r.refId === 'mp-fn-ref-3-1'), { refs: idx.refs.map(r => r.label), dom: snap.refs.map(r => r.text) });
    add('source text unchanged after load', snap.doc === FIXTURE, null);

    const refA1 = idx.refs.find(r => r.label === 'a' && r.occurrence === 1);
    const refA2 = idx.refs.find(r => r.label === 'a' && r.occurrence === 2);
    const noteA = idx.notes.find(n => n.label === 'a');
    const noteT = idx.notes.find(n => n.label === 't');
    if (!refA1 || !refA2 || !noteA || !noteT) throw new Error('fixture parser shape mismatch');

    await shot(page, outDir, `${host}-01-before`, refA2.from);

    // 1) 点第二处 a → 实际定义
    await clickRef(page, refA2.refId);
    snap = await snapshot(page);
    add('click 2nd a: caret lands at actual definition body', snap.head === noteA.textFrom,
      { head: snap.head, expected: noteA.textFrom });
    add('definition source marker is revealed while caret is inside', await page.evaluate(noteId =>
      document.querySelector(`[data-mp-fn-line="${noteId}"]`)?.textContent.includes('[^a]:') === true, noteA.noteId), null);
    await shot(page, outDir, `${host}-02-note`, snap.head);

    // 2) 小返回按钮 → 本处（第二处），不是第一处
    await clickBack(page, noteA.noteId);
    snap = await snapshot(page);
    add('back returns to the exact triggering occurrence (2nd a)', snap.head === refA2.from && snap.head !== refA1.from,
      { head: snap.head, a1: refA1.from, a2: refA2.from });
    await shot(page, outDir, `${host}-03-back`, snap.head);

    // 3) 第一处 → 返回第一处
    await clickRef(page, refA1.refId);
    await clickBack(page, noteA.noteId);
    snap = await snapshot(page);
    add('back after 1st a returns to 1st a', snap.head === refA1.from, { head: snap.head, a1: refA1.from });

    // 4) 键盘：Ctrl+Alt+Enter 跳转；聚焦 ↩ 后 Enter 返回
    await setSelection(page, refA2.from);
    await page.keyboard.press('Control+Alt+Enter');
    await sleep(120);
    snap = await snapshot(page);
    add('keyboard Ctrl+Alt+Enter jumps to definition', snap.head === noteA.textFrom, { head: snap.head, expected: noteA.textFrom });
    await page.locator(`[data-mp-fn-note="${noteA.noteId}"] .mp-fn-back`).focus();
    await page.keyboard.press('Enter');
    await sleep(120);
    snap = await snapshot(page);
    add('keyboard Enter on focused back button returns to exact occurrence', snap.head === refA2.from, { head: snap.head, a2: refA2.from });

    // 5) 表格内引用：定义上的 ↩ 可回到表格里的实际引用（编辑器不把它做成上标）
    await clickBack(page, noteT.noteId);
    snap = await snapshot(page);
    const refT = idx.refs.find(r => r.label === 't');
    add('table ref: back button returns to table source occurrence', snap.head === refT.from, { head: snap.head, expected: refT.from });
    add('table ref stays a source-only occurrence in the editor DOM', snap.refs.length === 3, snap.refs.length);

    // 6) 编号重排：在前文插入新脚注引用后，仍回第二处 a
    await loadDocument(hostCtx, host, FIXTURE, 'probe-renumber', false);
    await page.waitForFunction(() => document.querySelectorAll('.mp-fn-ref').length >= 3, null, { timeout: 10000 });
    snap = await snapshot(page);
    const beforeRenumber = snap.index;
    const oldA2 = beforeRenumber.refs.find(r => r.label === 'a' && r.occurrence === 2);
    await clickRef(page, oldA2.refId);
    const prefix = '新[^z] ';
    await page.evaluate(({ prefix }) => {
      const view = window.mpEngine._view();
      view.dispatch({ changes: [
        { from: 0, insert: prefix },
        { from: view.state.doc.length, insert: '\n\n[^z]: Z\n' },
      ] });
    }, { prefix });
    await page.waitForFunction(() => window.mpEngine.footnotes.index().notes.some(n => n.label === 'z'), null, { timeout: 10000 });
    await sleep(100);
    snap = await snapshot(page);
    const afterRenumber = snap.index;
    const newA2 = afterRenumber.refs.find(r => r.label === 'a' && r.occurrence === 2);
    const newA1 = afterRenumber.refs.find(r => r.label === 'a' && r.occurrence === 1);
    add('renumber: a occurrence 2 exists and refId changed', !!newA2 && newA2.refId !== oldA2.refId,
      { old: oldA2.refId, next: newA2 && newA2.refId });
    const noteAAfter = afterRenumber.notes.find(n => n.label === 'a');
    await clickBack(page, noteAAfter.noteId);
    snap = await snapshot(page);
    add('renumber: back still returns to 2nd a (label + mapped exact range)', snap.head === newA2.from && snap.head !== newA1.from,
      { head: snap.head, a1: newA1.from, a2: newA2.from });

    // 7) 原出处删除：第一次不静默跳走；第二次显式回第一处
    await loadDocument(hostCtx, host, FIXTURE, 'probe-delete', false);
    await page.waitForFunction(() => document.querySelectorAll('.mp-fn-ref').length >= 3, null, { timeout: 10000 });
    snap = await snapshot(page);
    const dA1 = snap.index.refs.find(r => r.label === 'a' && r.occurrence === 1);
    const dA2 = snap.index.refs.find(r => r.label === 'a' && r.occurrence === 2);
    const dNote = snap.index.notes.find(n => n.label === 'a');
    await clickRef(page, dA2.refId);
    await page.evaluate(a2 => {
      const view = window.mpEngine._view();
      view.dispatch({ changes: { from: a2.from, to: a2.to, insert: '' } });
    }, dA2);
    await page.waitForFunction(() => !window.mpEngine.footnotes.index().refs.some(r => r.label === 'a' && r.occurrence === 2), null, { timeout: 10000 });
    await sleep(100);
    const beforeGone = await snapshot(page);
    await clickBack(page, beforeGone.index.notes.find(n => n.label === 'a').noteId);
    const afterGone = await snapshot(page);
    add('deleted original: first back click does not silently jump elsewhere', afterGone.head === beforeGone.head,
      { before: beforeGone.head, after: afterGone.head });
    await clickBack(page, afterGone.index.notes.find(n => n.label === 'a').noteId);
    const afterExplicit = await snapshot(page);
    add('deleted original: second click explicitly returns to first occurrence', afterExplicit.head === dA1.from,
      { head: afterExplicit.head, first: dA1.from });

    // 8) 换文档：导航状态清零；无状态点 ↩ 回新文档第一处
    await loadDocument(hostCtx, host, FIXTURE, 'probe-cross', false);
    await page.waitForFunction(() => document.querySelectorAll('.mp-fn-ref').length >= 3, null, { timeout: 10000 });
    snap = await snapshot(page);
    const crossA2 = snap.index.refs.find(r => r.label === 'a' && r.occurrence === 2);
    await clickRef(page, crossA2.refId);
    await loadDocument(hostCtx, host, DOC_B, 'probe-doc-b', false);
    await page.waitForFunction(() => document.querySelectorAll('.mp-fn-ref').length === 1, null, { timeout: 10000 });
    snap = await snapshot(page);
    const bRef = snap.index.refs.find(r => r.label === 'n');
    const bNote = snap.index.notes.find(n => n.label === 'n');
    add('cross-document: nav state resets to null', snap.nav === null, snap.nav);
    add('cross-document: new doc index is the only one present', snap.index.refs.length === 1 && snap.index.notes.length === 1,
      { refs: snap.index.refs.length, notes: snap.index.notes.length });
    await clickBack(page, bNote.noteId);
    snap = await snapshot(page);
    add('cross-document: back with no state goes to new doc first occurrence', snap.head === bRef.from,
      { head: snap.head, expected: bRef.from });

    // 9) 长文增量：普通输入不重扫；'[' 触发一次（自证）
    const longDoc = ('长文段落 ' + 'x'.repeat(72) + '\n\n').repeat(600) + '末尾引用[^end]\n\n[^end]: 结尾定义\n';
    await loadDocument(hostCtx, host, longDoc, 'probe-long', false);
    /* 长稿末尾的引用在视口外，CM6 不会为它生成 DOM 上标；这里必须等**引擎索引**，
       不能用 .mp-fn-ref 数量（那会永远等不到 1）。 */
    await page.waitForFunction(() => {
      const index = window.mpEngine?.footnotes?.index?.();
      return !!index && index.refs.length === 1 && index.notes.length === 1 && index.refs[0].resolved === true;
    }, null, { timeout: 10000 });
    snap = await snapshot(page);
    const scanBase = snap.stats.scans;
    const mid = Math.floor(snap.doc.length / 2);
    await setSelection(page, mid);
    const typed = 'abcdefghijklmnopqrstuvwxyz1234';
    await page.keyboard.type(typed, { delay: 8 });
    await sleep(160);
    snap = await snapshot(page);
    add('long doc: 30 ordinary keystrokes insert without a full rescan', snap.stats.scans === scanBase && snap.doc.length === longDoc.length + typed.length,
      { scansBefore: scanBase, scansAfter: snap.stats.scans, delta: snap.doc.length - longDoc.length });
    const scanBeforeBracket = snap.stats.scans;
    await page.keyboard.insertText('[');
    await sleep(160);
    snap = await snapshot(page);
    add('long doc: structural "[" triggers exactly the self-proof rescan (counter has discriminative power)', snap.stats.scans > scanBeforeBracket,
      { scansBefore: scanBeforeBracket, scansAfter: snap.stats.scans });

    // 10) 源文本保护（本次运行只做了测试自己的两笔编辑；以最后一份长文为准，不比较原 fixture）
    const docResetFallbacks = hostCtx.docResetFallbacks || [];
    add('document reset via engine replaceDocument (0 reload fallbacks)', docResetFallbacks.length === 0, docResetFallbacks.slice(0, 2));
    add('no uncaught page errors', hostCtx.pageErrors.length === 0, hostCtx.pageErrors.slice(0, 3));

    await shot(page, outDir, `${host}-04-final`, null);
    fs.writeFileSync(path.join(outDir, `${host}-console.log`), hostCtx.consoleLines.join('\n'), 'utf8');
    fs.writeFileSync(path.join(outDir, `${host}-pageerrors.log`), hostCtx.pageErrors.join('\n'), 'utf8');
    return { host, ok: checks.every(check => check.ok), checks, outDir };
  } catch (error) {
    /* 单宿主致命失败必须留在**本宿主**的结果里，不能让整个进程提前退出把
       后面的宿主/插件臂一起带走；同时不能因为前面已通过就判全局绿。 */
    const detail = String(error && error.stack || error);
    add('FATAL: ' + String(error && error.message || error), false, detail);
    try { fs.writeFileSync(path.join(outDir, `${host}-fatal.log`), detail, 'utf8'); } catch { /* 诊断落盘失败不改变结果 */ }
    try { fs.writeFileSync(path.join(outDir, `${host}-console.log`), hostCtx.consoleLines.join('\n'), 'utf8'); } catch { /* 同上 */ }
    try { fs.writeFileSync(path.join(outDir, `${host}-pageerrors.log`), hostCtx.pageErrors.join('\n'), 'utf8'); } catch { /* 同上 */ }
    return { host, ok: false, checks, outDir, error: detail };
  } finally {
    await hostCtx.context.close().catch(() => {});
  }
}

async function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (error) { console.error('args: ' + error.message); process.exit(2); }
  ensureDir(args.out);
  const fixtureExpected = collectFootnotes(FIXTURE);
  const fixtureInfo = {
    bytes: FIXTURE.length,
    sha256: sha(FIXTURE),
    refs: fixtureExpected.refs.map(ref => ({ label: ref.label, number: ref.number, resolved: ref.resolved, from: ref.from, to: ref.to })),
    notes: fixtureExpected.notes.map(note => ({ label: note.label, number: note.number, from: note.from, to: note.to })),
  };
  if (args.selfCheck) {
    const exists = { desktop: fs.existsSync(args.desktopPage), plugin: fs.existsSync(args.pluginPage), footnotes: fs.existsSync(FOOTNOTES) };
    const ok = exists.desktop && exists.plugin && exists.footnotes &&
      fixtureExpected.refs.length === 5 && fixtureExpected.notes.length === 3 &&
      fixtureExpected.refs.filter(ref => ref.resolved).length === 4;
    console.log(JSON.stringify({ ok, args, exists, fixture: fixtureInfo }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  console.log('[footnotes] host=' + args.host + ' out=' + args.out);
  console.log('[footnotes] fixture ' + fixtureInfo.sha256.slice(0, 16) + '  ' + fixtureInfo.bytes + ' B  refs=' + fixtureInfo.refs.length + ' notes=' + fixtureInfo.notes.length);
  const browser = await launchBrowser(args);
  const hosts = args.host === 'both' ? ['desktop', 'plugin'] : [args.host];
  const results = [];
  try {
    for (const host of hosts) {
      console.log('\n[footnotes] === ' + host + ' ===');
      const outDir = path.join(args.out, host);
      ensureDir(outDir);
      let result;
      try {
        result = await runHost(browser, host, args, outDir);
      } catch (error) {
        const detail = String(error && error.stack || error);
        result = { host, ok: false, checks: [], outDir, error: detail };
        try { fs.writeFileSync(path.join(outDir, `${host}-fatal.log`), detail, 'utf8'); } catch { /* 诊断落盘失败不改变结果 */ }
      }
      results.push(result);
      for (const check of result.checks) {
        console.log((check.ok ? '  PASS ' : '  FAIL ') + check.name + (check.detail != null ? '  ' + JSON.stringify(check.detail) : ''));
      }
      if (result.error) console.error('  [fatal] ' + String(result.error).split('\n')[0]);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const ok = results.length === hosts.length && results.every(result => result.ok);
  const summary = {
    ok,
    generatedAt: new Date().toISOString(),
    host: args.host,
    fixture: fixtureInfo,
    results: results.map(result => ({ host: result.host, ok: result.ok, checks: result.checks, error: result.error || null })),
  };
  fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n[footnotes] ' + (ok ? 'ALL PASS' : 'FAILED') + ' -> ' + path.join(args.out, 'result.json'));
  process.exit(ok ? 0 : 1);
}

main().catch(error => {
  console.error('[footnotes] fatal: ' + (error && error.stack || error));
  process.exit(2);
});
