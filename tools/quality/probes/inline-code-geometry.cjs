#!/usr/bin/env node
'use strict';
/* tests-inline-code-geometry.cjs — standalone dual-host regression for the
 * inline-code (backtick capsule) same-word-selectionMatch geometry family
 * (inline-drag audit follow-up).
 *
 * SINGLE FILE, self-contained: the dual-host loader (Chromium discovery,
 * offline gate, desktop mpHost stub, plugin dsh-bridge document channel) is
 * embedded, adapted from
 *   tools/quality/probes/footnotes-dual-host.cjs   (host open / CLI shape)
 *   .mp-verify/inline-drag-audit/check/run.cjs     (capsule scan / pixel rulers)
 * Nothing defaults into .mp-verify: host pages and the playwright install are
 * parameters, so the file can be copied anywhere and run with plain `node`.
 *
 * Hosts (both load REAL shipped renderer pages; no service, no app-slot lock,
 * no product file is ever written):
 *   desktop : --desktop-page <renderer/index.html>     (mpHost injected stub,
 *             document via the shell's own onDoc channel, dark theme)
 *   plugin  : --plugin-page <renderer-cm6/index.html>  (real dsh-bridge,
 *             document via __dshmd 'down' open postMessage)
 *
 * Real input only (CDP keyboard / mouse / insertText channels). The fixture is
 * a tiny desensitized document: the code word as the whole capsule on the
 * selected line, the SAME word mid-capsule (plain text before/after it inside
 * the backticks — original-repro shape, so a same-word match decorates a
 * sub-range and splits the capsule piece) on the untouched line, plus once as
 * plain text. No personal data.
 *
 * Arms per host (every check is hard; none is informational):
 *   boot            document loaded byte-exact, focus taken by a real click,
 *                   no page errors
 *   baseline        capsule / plain-line geometry snapshot, no decorations
 *   match-kb        caret + Shift+Arrow selection of the word -> same-word
 *                   matches (cm-selectionMatch) VISIBLE BY PIXELS on the
 *                   untouched capsule line and the plain line, while the
 *                   untouched line width, tail glyphs and per-line layout
 *                   bands stay <= 1px (no rewrap)
 *   match-dblclick  same invariants via native double-click word selection
 *   match-drag      same invariants via real press -> move* -> release drag
 *                   (dblclick/drag must land the word on their own channel —
 *                   a miss FAILS the arm, no keyboard rescue to green)
 *   selection-color selection over the code capsule keeps the NATIVE selection
 *                   color with alpha >= 0.1, measurably distinct from the
 *                   capsule background, and >= 35% of the word-box device
 *                   pixels match the measured color (real pixel evidence)
 *   input-undo      real typing lands inside the capsule (exact doc string,
 *                   capsule width grows, no rewrap elsewhere); Ctrl+Z restores
 *                   the exact document and the baseline geometry
 *   final           doc fidelity, no page errors, no external requests
 *
 * Usage:
 *   node tests-inline-code-geometry.cjs --host both \
 *        --desktop-page <.../renderer/index.html> \
 *        --plugin-page  <.../renderer-cm6/index.html> \
 *        --playwright <playwright-core dir | node_modules dir> \
 *        [--chrome <chrome.exe>] [--out <dir>] [--headed] [--keep]
 *        [--no-screenshots] [--cdp] [--self-check]
 * Env fallbacks: MP_DESKTOP_PAGE / MP_PLUGIN_PAGE / MP_PLAYWRIGHT / MP_CHROME.
 *
 * Chromium launch: playwright chromium.launch() first; if the spawn is blocked
 * (DSH Windows sandbox rejects piped child stdio => EPERM) it falls back to a
 * self-spawned Chromium with stdio 'ignore' + CDP attach. --cdp forces that
 * path. Same real browser, same real input in both paths.
 *
 * Exit codes: 0 all checks green on every selected host; 1 check failure;
 * 2 environment/argument error.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

/* ── Fixture (desensitized, no personal data) ────────────────────────────── */
const WORD = 'alpha_code_2024'; // letters + underscore + digits: one CM6 word
const LINE_A_TEXT = '段落甲 `' + WORD + '` 收尾一。';
const LINE_B_TEXT = '段落乙 `词前 ' + WORD + ' 词后` 收尾二。';
const LINE_P_TEXT = '普通句 ' + WORD + ' 无代码。';
const FIXTURE_LINES = [
  '# 同词几何回归',
  '',
  LINE_A_TEXT,
  '',
  LINE_B_TEXT,
  '',
  LINE_P_TEXT,
  '',
];
const FIXTURE = FIXTURE_LINES.join('\n');
const TYPED = 'Zq7';

/* ── small utils ─────────────────────────────────────────────────────────── */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileUrl = file => pathToFileURL(file).href;
const sha16 = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

/* ── CLI ─────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const args = {
    host: 'both',
    desktopPage: process.env.MP_DESKTOP_PAGE || '',
    pluginPage: process.env.MP_PLUGIN_PAGE || '',
    playwright: process.env.MP_PLAYWRIGHT || '',
    chrome: process.env.MP_CHROME || '',
    out: '',
    headed: false,
    keep: false,
    screenshots: true,
    cdp: false,
    selfCheck: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    const take = () => {
      if (!next || next.startsWith('--')) throw new Error('missing value for ' + key);
      i++; return next;
    };
    if (key === '--host') args.host = take();
    else if (key === '--desktop-page') args.desktopPage = path.resolve(take());
    else if (key === '--plugin-page') args.pluginPage = path.resolve(take());
    else if (key === '--playwright') args.playwright = path.resolve(take());
    else if (key === '--chrome') args.chrome = path.resolve(take());
    else if (key === '--out') args.out = path.resolve(take());
    else if (key === '--headed') args.headed = true;
    else if (key === '--keep') args.keep = true;
    else if (key === '--no-screenshots') args.screenshots = false;
    else if (key === '--cdp') args.cdp = true;
    else if (key === '--self-check') args.selfCheck = true;
    else if (key === '--help' || key === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error('unknown argument: ' + key);
  }
  if (!['both', 'desktop', 'plugin'].includes(args.host)) throw new Error('--host must be both|desktop|plugin');
  if (!args.out) args.out = ensureDir(path.join(path.dirname(process.argv[1] || __filename), 'out', 'regression-' + stamp()));
  return args;
}
function validateEnv(args) {
  const hosts = args.host === 'both' ? ['desktop', 'plugin'] : [args.host];
  for (const host of hosts) {
    const flag = host === 'desktop' ? '--desktop-page' : '--plugin-page';
    const value = host === 'desktop' ? args.desktopPage : args.pluginPage;
    if (!value) throw new Error(flag + ' is required for host ' + host + ' (or set MP_' + host.toUpperCase() + '_PAGE)');
    if (!fs.existsSync(value)) throw new Error('host page not found: ' + value);
  }
  return hosts;
}

/* ── playwright / chromium resolution ────────────────────────────────────── */
function loadPlaywright(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit, path.join(explicit, 'playwright-core'), path.join(explicit, 'playwright'));
  if (process.env.MP_PLAYWRIGHT) candidates.push(process.env.MP_PLAYWRIGHT);
  candidates.push('playwright-core', 'playwright');
  const errors = [];
  for (const candidate of candidates) {
    try { return require(candidate); }
    catch (error) { errors.push(candidate + ': ' + String((error && (error.code || error.message)) || error).slice(0, 100)); }
  }
  throw new Error('playwright-core not found; pass --playwright <dir> or set MP_PLAYWRIGHT\n  ' + errors.join('\n  '));
}
function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [path.join(local, 'ms-playwright')];
  const found = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (/^chromium-\d+$/.test(name)) found.push(path.join(root, name, 'chrome-win64', 'chrome.exe'), path.join(root, name, 'chrome-win', 'chrome.exe'));
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
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* Minimal preload.js contract the shipping desktop renderer expects on the
 * open path (subset; all async results resolved). Same shape the inline-drag
 * audit loader uses. */
function desktopStub() {
  return `(() => {
    const noop = () => {};
    const resolved = value => () => Promise.resolve(value);
    window.__probeDocCb = null;
    window.mpHost = {
      themeGet: resolved({ dark: true }),
      themeSet: resolved({ dark: true }),
      settingGet: resolved(null),
      onSetting: noop,
      docDirty: resolved({ ok: true }),
      onDoc: cb => { window.__probeDocCb = cb; },
      onTheme: noop,
      onMenu: noop,
      onExportProgress: noop,
      onExportMakeHtml: noop,
      onExportProgressCancel: noop,
      docReady: resolved(null),
      info: resolved({ name: 'inline-code-geometry-regression', version: '0' }),
      pathForFile: () => null,
      outsideChange: resolved({ changed: false }),
      history: resolved({ ok: true }),
      selectAll: resolved({ ok: true }),
      save: resolved({ ok: true }),
      saveAs: resolved({ ok: false, canceled: true }),
      docSaved: resolved({ ok: true }),
      reload: resolved({ ok: false }),
      reloadView: resolved({ ok: true }),
      commitOpen: resolved(true),
      prepareOverwrite: resolved(null),
      readFileBase64: resolved({ ok: false, error: 'offline-probe' }),
      openExternal: noop,
    };
    window.__probeOpen = (text, id) => {
      if (typeof window.__probeDocCb === 'function') {
        window.__probeDocCb({ text, filePath: null, documentId: id || 'probe-doc', revision: 0, loadKind: 'replace' });
      }
    };
  })();`;
}

/* Launch: try chromium.launch(); on spawn denial (DSH Windows sandbox blocks
 * piped child stdio with EPERM) fall back to stdio:'ignore' spawn + CDP. */
async function launchBrowserSession(args) {
  const { chromium } = loadPlaywright(args.playwright);
  const executablePath = findChrome(args.chrome);
  const launchArgs = [
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
  ];
  if (!args.cdp) {
    try {
      const browser = await chromium.launch({
        headless: !args.headed,
        executablePath: executablePath || undefined,
        args: launchArgs,
      });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      return {
        via: 'launch', browser, context, page,
        close: async () => { try { await browser.close(); } catch { /* ignore */ } },
      };
    } catch (error) {
      console.log('[launcher] chromium.launch failed (' + String((error && error.message) || error).split('\n')[0] + '); falling back to CDP spawn');
    }
  }
  if (!executablePath) throw new Error('no Chromium/Chrome executable found; pass --chrome <chrome.exe>');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-code-geometry-'));
  const cdpArgs = [
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile,
    ...launchArgs,
    '--force-device-scale-factor=2',
    '--window-size=1280,900',
  ];
  if (!args.headed) cdpArgs.unshift('--headless=new');
  const child = spawn(executablePath, cdpArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let browser = null;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 3000 }); break; }
    catch { /* retry until the endpoint is up */ }
  }
  if (!browser) {
    try { process.kill(child.pid); } catch { /* ignore */ }
    throw new Error('Chromium CDP endpoint did not come up on port ' + port);
  }
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  try { await page.setViewportSize({ width: 1280, height: 900 }); } catch { /* keep window size */ }
  const close = async () => {
    try { await browser.close(); } catch { /* ignore */ }
    try { process.kill(child.pid); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { via: 'cdp', browser, context, page, close };
}

/* ── in-page rulers (self-contained evaluate payloads) ───────────────────── */
async function posCoords(page, positions) {
  return page.evaluate(list => {
    const view = window.mpEngine._view();
    const out = {};
    for (const p of list) {
      const c = view.coordsAtPos(p);
      out[p] = c ? { left: +c.left.toFixed(3), top: +c.top.toFixed(3), bottom: +c.bottom.toFixed(3) } : null;
    }
    return out;
  }, positions);
}
async function selState(page) {
  return page.evaluate(() => {
    const view = window.mpEngine._view();
    const s = view.state.selection.main;
    const doc = view.state.doc;
    return {
      anchor: s.anchor, head: s.head, empty: s.empty,
      text: doc.sliceString(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head)),
      docLen: doc.length, doc: doc.toString(),
      focus: view.hasFocus, docFocus: document.hasFocus(),
      active: document.activeElement ? (document.activeElement.tagName + '.' + (document.activeElement.className || '')) : '',
    };
  });
}
async function focusInEditor(page) {
  return page.evaluate(() => {
    const view = window.mpEngine._view();
    return !!(document.hasFocus() && view.hasFocus && view.contentDOM.contains(document.activeElement));
  });
}
async function selectionMatchCount(page) {
  return page.evaluate(() => ({
    selectionMatch: document.querySelectorAll('.cm-selectionMatch').length,
    searchMatch: document.querySelectorAll('.cm-searchMatch').length,
  }));
}
/* Capsule scan of one document line: monospace text pieces (geometry + bg
 * color). Pieces are found by computed monospace font — no generated-class
 * assumptions. */
async function scanCapsule(page, lineNo) {
  return page.evaluate(lineNo => {
    const view = window.mpEngine._view();
    const line = view.state.doc.line(lineNo);
    const domLine = [...document.querySelectorAll('.cm-line')]
      .find(el => { try { return view.posAtDOM(el, 0) === line.from; } catch { return false; } }) || null;
    if (!domLine) return { found: false };
    const round = r => ({ left: +r.left.toFixed(3), right: +r.right.toFixed(3), top: +r.top.toFixed(3), bottom: +r.bottom.toFixed(3), width: +r.width.toFixed(3), height: +r.height.toFixed(3) });
    const pieces = [];
    const walker = document.createTreeWalker(domLine, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const parent = t.parentElement;
      const cs = getComputedStyle(parent);
      if (!/mono|consol/i.test(cs.fontFamily)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      const tr = [...range.getClientRects()];
      if (!tr.length) continue;
      pieces.push({
        textLen: t.nodeValue.length,
        parentRect: round(parent.getBoundingClientRect()),
        bg: cs.backgroundColor,
        textLeft: +Math.min(...tr.map(x => x.left)).toFixed(3),
        textRight: +Math.max(...tr.map(x => x.right)).toFixed(3),
      });
    }
    pieces.sort((a, b) => a.textLeft - b.textLeft);
    const box = pieces.length ? {
      left: Math.min(...pieces.map(p => p.parentRect.left)),
      right: Math.max(...pieces.map(p => p.parentRect.right)),
      top: Math.min(...pieces.map(p => p.parentRect.top)),
      bottom: Math.max(...pieces.map(p => p.parentRect.bottom)),
      width: Math.max(...pieces.map(p => p.parentRect.right)) - Math.min(...pieces.map(p => p.parentRect.left)),
    } : null;
    return {
      found: true, pieceCount: pieces.length, box,
      bg: pieces[0] ? pieces[0].bg : null,
      selectionMatchEls: domLine.querySelectorAll('.cm-selectionMatch').length,
      lineRect: round(domLine.getBoundingClientRect()),
    };
  }, lineNo);
}
/* Text extent of a plain (non-code) line: min left / max right over all text
 * client rects. Same-word decorations must not move either edge. */
async function plainExtent(page, lineNo) {
  return page.evaluate(lineNo => {
    const view = window.mpEngine._view();
    const line = view.state.doc.line(lineNo);
    const domLine = [...document.querySelectorAll('.cm-line')]
      .find(el => { try { return view.posAtDOM(el, 0) === line.from; } catch { return false; } }) || null;
    if (!domLine) return { found: false };
    let left = Infinity, right = -Infinity;
    const walker = document.createTreeWalker(domLine, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) { left = Math.min(left, r.left); right = Math.max(right, r.right); }
    }
    return {
      found: true,
      textLeft: +left.toFixed(3), textRight: +right.toFixed(3),
      selectionMatchEls: domLine.querySelectorAll('.cm-selectionMatch').length,
    };
  }, lineNo);
}
/* Whole-layout wrap detector: per visual line record block top/height and the
 * number of distinct text bands (rounded tops). Decoration-induced DOM splits
 * do not change band counts; a rewrap does. */
async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')];
    const snap = lines.map(el => {
      const r = el.getBoundingClientRect();
      const tops = new Set();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
      }
      return { top: +r.top.toFixed(2), height: +r.height.toFixed(2), bands: tops.size };
    });
    const scroller = document.querySelector('.cm-scroller');
    return {
      lineCount: snap.length, lines: snap,
      scroller: scroller ? { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth } : null,
    };
  });
}
function layoutStable(a, b) {
  if (!a || !b) return { ok: false, diffs: ['missing snapshot'] };
  if (a.lines.length !== b.lines.length) return { ok: false, diffs: ['line-count ' + a.lines.length + ' -> ' + b.lines.length] };
  const diffs = [];
  for (let i = 0; i < a.lines.length; i++) {
    const A = a.lines[i], B = b.lines[i];
    if (Math.abs(A.top - B.top) > 1) diffs.push('line' + (i + 1) + ' top ' + A.top + ' -> ' + B.top);
    if (Math.abs(A.height - B.height) > 1) diffs.push('line' + (i + 1) + ' height ' + A.height + ' -> ' + B.height);
    if (A.bands !== B.bands) diffs.push('line' + (i + 1) + ' bands ' + A.bands + ' -> ' + B.bands);
  }
  if (b.scroller && b.scroller.scrollWidth > b.scroller.clientWidth + 1) {
    diffs.push('h-overflow ' + b.scroller.scrollWidth + ' > ' + b.scroller.clientWidth);
  }
  return { ok: diffs.length === 0, diffs };
}
/* Native selection color as the renderer itself computes it: the CM6
 * selection layer element when present, otherwise ::selection on the content. */
async function selectionColor(page) {
  return page.evaluate(() => {
    const out = { via: null, backgroundColor: null, mixBlendMode: null, layerCount: 0, scrollerBg: null };
    const el = document.querySelector('.cm-layer.cm-selectionLayer .cm-selectionBackground') ||
      document.querySelector('.cm-selectionBackground');
    if (el) {
      const cs = getComputedStyle(el);
      out.via = 'layer';
      out.backgroundColor = cs.backgroundColor;
      out.mixBlendMode = cs.mixBlendMode;
      out.layerCount = document.querySelectorAll('.cm-selectionBackground').length;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        out.rect = { left: +r.left.toFixed(2), top: +r.top.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
      }
    } else {
      const content = document.querySelector('.cm-content');
      if (content) {
        const cs = getComputedStyle(content, '::selection');
        if (cs.backgroundColor && cs.backgroundColor !== 'transparent') {
          out.via = 'pseudo';
          out.backgroundColor = cs.backgroundColor;
        }
      }
    }
    const scroller = document.querySelector('.cm-scroller');
    out.scrollerBg = scroller ? getComputedStyle(scroller).backgroundColor : null;
    return out;
  });
}

/* ── color math ──────────────────────────────────────────────────────────── */
function parseCssColor(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)/i);
  if (!m) return null;
  let a = 1;
  if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (!Number.isFinite(a)) a = 1;
  return { r: +m[1], g: +m[2], b: +m[3], a };
}
function compositeOver(fg, bg) {
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}
function dist2(c1, c2) {
  const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
  return dr * dr + dg * dg + db * db;
}

/* ── trusted pixel ruler ───────────────────────────────────────────────────
 * The screenshot is decoded by Chromium itself (in-page canvas), never by a
 * self-written decoder. Families:
 *   green — selectionMatch highlight (#99ff77-family, proven on both hosts)
 *   near  — within a Euclidean RGB tolerance of a measured color
 * Returns device-pixel stats plus the page devicePixelRatio. */
async function pixelScan(page, clip, mode, payload) {
  if (!clip) return { unavailable: true };
  const buf = await page.screenshot({ clip });
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  return page.evaluate(async ({ dataUrl, mode, payload }) => {
    const img = new Image();
    img.src = dataUrl;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode failed')); });
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const rgb = (payload && payload.rgb) || [0, 0, 0];
    const tol2 = (payload && payload.tol2 != null) ? payload.tol2 : 0;
    let count = 0, minX = Infinity, maxX = -Infinity, sR = 0, sG = 0, sB = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let hit;
        if (mode === 'green') hit = g >= 100 && g - r >= 25 && g - b >= 25;
        else {
          const dr = r - rgb[0], dg = g - rgb[1], db = b - rgb[2];
          hit = dr * dr + dg * dg + db * db <= tol2;
        }
        if (hit) {
          count++; sR += r; sG += g; sB += b;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
    }
    return {
      w: cv.width, h: cv.height, count,
      spanX: maxX >= minX ? maxX - minX + 1 : 0,
      minX: minX === Infinity ? null : minX, maxX: maxX === -Infinity ? null : maxX,
      mean: count ? [Math.round(sR / count), Math.round(sG / count), Math.round(sB / count)] : null,
      dpr: window.devicePixelRatio || 1,
    };
  }, { dataUrl, mode, payload: payload || null });
}

/* ── real-input helpers ──────────────────────────────────────────────────── */
async function frames(page) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(90);
}
async function pressTimes(page, key, n) {
  for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(35); }
}
async function extendSelection(page, key, n) {
  await page.keyboard.down('Shift');
  try { for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(45); } }
  finally { await page.keyboard.up('Shift'); }
}
/* Click a caret to an exact doc position with bounded real-key correction. */
async function clickCaret(page, pos, tries = 3) {
  let last = null;
  for (let t = 0; t < tries; t++) {
    const c = (await posCoords(page, [pos]))[pos];
    if (!c) return { ok: false, reason: 'no coords for pos ' + pos };
    await page.mouse.click(c.left + 1, (c.top + c.bottom) / 2);
    await sleep(70);
    const s = await selState(page);
    last = s;
    if (s.empty && s.head === pos) return { ok: true, tries: t + 1 };
    if (s.empty && s.head !== pos) {
      const key = s.head < pos ? 'ArrowRight' : 'ArrowLeft';
      await pressTimes(page, key, Math.abs(pos - s.head));
      await sleep(60);
      const s2 = await selState(page);
      last = s2;
      if (s2.empty && s2.head === pos) return { ok: true, tries: t + 1, corrected: true };
    }
  }
  return { ok: false, reason: 'caret not at ' + pos, state: { head: last && last.head, anchor: last && last.anchor, empty: last && last.empty } };
}
async function charAdvance(page, pos) {
  return page.evaluate(pos => {
    const view = window.mpEngine._view();
    const a = view.coordsAtPos(pos), b = view.coordsAtPos(pos + 1);
    return a && b ? Math.max(2, b.left - a.left) : 8;
  }, pos);
}
function clipAround(box, viewport, padX, padY, h) {
  if (!box) return null;
  const px = padX == null ? 12 : padX, py = padY == null ? 6 : padY;
  const x = Math.max(0, box.left - px);
  const y = Math.max(0, box.top - py);
  return {
    x, y,
    width: Math.min((box.right - box.left) + 2 * px, viewport.width - x - 8),
    height: h || Math.max(60, (box.bottom - box.top) + 2 * py),
  };
}
async function shot(page, outDir, host, name, clip, args) {
  if (!args.screenshots) return null;
  try {
    const file = path.join(outDir, host + '-' + name + '.png');
    await page.screenshot({ path: file, clip: clip || undefined });
    return path.basename(file);
  } catch { return null; }
}

/* ── check bookkeeping ───────────────────────────────────────────────────── */
function makeArm(report, id, channel) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  const arm = { id, channel, checks, shots: [], error: null };
  report.arms.push(arm);
  return { arm, add };
}
function armLine(arm) {
  const fail = arm.checks.filter(c => !c.ok);
  const status = arm.error ? 'ERROR' : (fail.length ? 'FAIL' : 'PASS');
  const bits = fail.length ? fail.map(c => c.name).join(', ') : 'all ' + arm.checks.length;
  return '[' + status + '] ' + arm.id + ' (' + arm.channel + ') — ' +
    (fail.length ? 'failed: ' + bits : arm.checks.length + ' checks ok');
}

/* ── host runner ─────────────────────────────────────────────────────────── */
async function waitForDoc(page, text, timeout) {
  await page.waitForFunction(expected => {
    const engine = window.mpEngine;
    const view = engine && engine._view && engine._view();
    return !!view && view.state.doc.toString() === expected;
  }, text, { timeout });
}

async function runHost(host, args, outDir) {
  const report = {
    host,
    pagePath: host === 'desktop' ? args.desktopPage : args.pluginPage,
    arms: [], pageErrors: [], consoleTail: [], externalRequests: [],
    summary: null,
  };
  const session = await launchBrowserSession(args);
  report.launchVia = session.via;
  const { context, page } = session;
  try {
    /* Offline isolation: only local file/data/blob/about URLs may load. */
    await context.route('**/*', route => {
      const url = route.request().url();
      if (/^(file|data|blob):/i.test(url) || url.startsWith('about:')) return route.continue();
      return route.abort('blockedbyclient');
    });
    if (host === 'desktop') await context.addInitScript({ content: desktopStub() });
    page.on('console', m => report.consoleTail.push('[' + m.type() + '] ' + m.text()));
    page.on('pageerror', e => report.pageErrors.push(String((e && e.stack) || e)));
    page.on('request', r => {
      const url = r.url();
      if (!/^(file|data|blob):/i.test(url) && !url.startsWith('about:')) report.externalRequests.push(url);
    });

    if (!fs.existsSync(report.pagePath)) throw new Error('host page not found: ' + report.pagePath);
    await page.goto(fileUrl(report.pagePath), { waitUntil: 'load', timeout: 30000 });
    if (host === 'plugin') {
      await page.waitForFunction(() => window.__dshBridgeInstalled === true, null, { timeout: 15000 });
    }

    /* open the fixture through the host's own document channel */
    if (host === 'desktop') {
      await page.evaluate(({ text, id }) => window.__probeOpen(text, id), { text: FIXTURE, id: 'inline-code-geometry-regression' });
    } else {
      await page.evaluate(text => window.postMessage(
        { __dshmd: true, dir: 'down', type: 'open', content: { content: text, rootPath: '' } }, '*'), FIXTURE);
    }
    await waitForDoc(page, FIXTURE, 20000);
    await page.waitForFunction(() => !!document.querySelector('.cm-content'), null, { timeout: 10000 });
    await sleep(150);

    /* locate fixture lines by exact text (no hardcoded line numbers) */
    const lineIndex = await page.evaluate(() => {
      const doc = window.mpEngine._view().state.doc;
      const out = [];
      for (let n = 1; n <= doc.lines; n++) { const l = doc.line(n); out.push({ n, from: l.from, to: l.to, text: l.text }); }
      return out;
    });
    const lineA = lineIndex.find(l => l.text === LINE_A_TEXT);
    const lineB = lineIndex.find(l => l.text === LINE_B_TEXT);
    const lineP = lineIndex.find(l => l.text === LINE_P_TEXT);
    if (!lineA || !lineB || !lineP) {
      throw new Error('fixture lines not found (A=' + !!lineA + ' B=' + !!lineB + ' P=' + !!lineP + ')');
    }
    const wordStartA = lineA.from + lineA.text.indexOf('`') + 1;
    const wordEndA = wordStartA + WORD.length;
    const wordStartB = lineB.from + lineB.text.indexOf(WORD);
    const wordEndB = wordStartB + WORD.length;
    const wordStartP = lineP.from + lineP.text.indexOf(WORD);
    const wordEndP = wordStartP + WORD.length;
    const tailProbes = [lineB.to - 3, lineB.to - 2, lineB.to - 1, lineP.to - 2, lineP.to - 1];
    const vp = () => page.viewportSize() || { width: 1280, height: 900 };
    report.lines = { A: lineA.n, B: lineB.n, P: lineP.n, wordStartA, wordEndA, wordStartB, wordEndB, wordStartP, wordEndP };

    /* ── boot ── */
    {
      const { arm, add } = makeArm(report, 'boot', 'none');
      const c = (await posCoords(page, [wordStartA]))[wordStartA];
      await page.mouse.click(c.left + 4, (c.top + c.bottom) / 2);  // real click takes focus, like a user
      await sleep(120);
      const s = await selState(page);
      add('doc-loaded-exact', s.doc === FIXTURE, { docLen: s.docLen, expectedLen: FIXTURE.length });
      add('line-count', lineIndex.length === FIXTURE_LINES.length, { lines: lineIndex.length, expected: FIXTURE_LINES.length });
      add('focus-in-editor', await focusInEditor(page), { focus: s.focus, docFocus: s.docFocus, active: s.active });
      add('no-page-error', report.pageErrors.length === 0, { count: report.pageErrors.length });
    }

    /* ── baseline ── */
    let layout0 = null, Wa0 = null, Wb0 = null, plainExt0 = null, tailBase = null;
    {
      const { arm, add } = makeArm(report, 'baseline', 'none');
      layout0 = await layoutSnapshot(page);
      const scanA = await scanCapsule(page, lineA.n);
      const scanB = await scanCapsule(page, lineB.n);
      plainExt0 = await plainExtent(page, lineP.n);
      tailBase = await posCoords(page, tailProbes);
      Wa0 = scanA.box ? scanA.box.width : null;
      Wb0 = scanB.box ? scanB.box.width : null;
      const deco = await selectionMatchCount(page);
      add('capsule-A-single-piece', scanA.found && scanA.pieceCount === 1, { pieceCount: scanA.pieceCount });
      add('capsule-B-single-piece', scanB.found && scanB.pieceCount === 1, { pieceCount: scanB.pieceCount });
      add('plain-line-found', !!plainExt0.found, plainExt0);
      add('no-selection-match', deco.selectionMatch === 0, deco);
      add('no-search-match', deco.searchMatch === 0, deco);
      add('no-horizontal-overflow', !layout0.scroller || layout0.scroller.scrollWidth <= layout0.scroller.clientWidth + 1, layout0.scroller);
      arm.shots.push(await shot(page, outDir, host, 'baseline', clipAround(scanB.box, vp(), 20, 10), args));
    }

    /* arm reset: real click into the heading + ArrowRight collapse; must end
     * with an empty selection and zero decorations (clean fixture for the next
     * arm — doc AND cursor reset together). */
    const reset = async () => {
      const caret = await clickCaret(page, 2);
      await page.keyboard.press('ArrowRight');
      await frames(page);
      const deco = await selectionMatchCount(page);
      const s = await selState(page);
      return { ok: caret.ok && s.empty && deco.selectionMatch === 0, caretOk: caret.ok, selEmpty: s.empty, selectionMatch: deco.selectionMatch };
    };
    /* landing check only — dblclick/drag arms must land the word on their own
     * channel; a keyboard rescue would wash a real input failure into green. */
    const wordLanded = s => s.text === WORD && Math.min(s.anchor, s.head) === wordStartA && Math.abs(s.head - s.anchor) === WORD.length;

    /* shared with-match assertions: the SAME-WORD match must be visible by
     * pixels on the untouched capsule line and the plain line, while untouched
     * geometry (width, tail glyphs, layout bands) stays <= 1px. */
    const withMatchChecks = async (arm, add, tag) => {
      let matchCount = null;
      try {
        await page.waitForFunction(() => document.querySelectorAll('.cm-selectionMatch').length >= 2, null, { timeout: 4000 });
      } catch { /* recorded below either way */ }
      const deco = await selectionMatchCount(page);
      matchCount = deco.selectionMatch;
      add(tag + ': same-word matches present (>=2)', matchCount >= 2, { matchCount });

      /* untouched capsule line: visible + stable */
      const scanB = await scanCapsule(page, lineB.n);
      const Wb1 = scanB.box ? scanB.box.width : null;
      add(tag + ': untouched capsule width stable <=1px',
        Wb0 != null && Wb1 != null && Math.abs(Wb1 - Wb0) <= 1,
        { before: Wb0, now: Wb1, delta: Wb1 != null && Wb0 != null ? +(Wb1 - Wb0).toFixed(3) : null });
      const cb = await posCoords(page, [wordStartB, wordEndB]);
      const expectedCssB = cb[wordStartB] && cb[wordEndB] ? cb[wordEndB].left - cb[wordStartB].left : null;
      const clipB = clipAround(scanB.box, vp(), 6, 4);
      const greenB = await pixelScan(page, clipB, 'green');
      arm.shots.push(await shot(page, outDir, host, tag + '-capsuleB', clipB, args));
      add(tag + ': match visible on untouched capsule (pixels)',
        !greenB.unavailable && greenB.count >= 300 && expectedCssB != null && greenB.spanX / greenB.dpr >= expectedCssB * 0.7,
        {
          greenPx: greenB.count || 0,
          spanCss: greenB.spanX ? +(greenB.spanX / greenB.dpr).toFixed(1) : null,
          expectedCss: +(expectedCssB || 0).toFixed(1),
          meanRgb: greenB.mean || null,
          clip: greenB.w ? greenB.w + 'x' + greenB.h : 'unavailable',
        });
      const tails = await posCoords(page, tailProbes);
      let maxShift = 0, probed = 0;
      for (const p of tailProbes) {
        if (tailBase[p] && tails[p]) { probed++; maxShift = Math.max(maxShift, Math.abs(tails[p].left - tailBase[p].left)); }
      }
      add(tag + ': tail glyphs stable <=1px', probed === tailProbes.length && maxShift <= 1,
        { maxShiftPx: +maxShift.toFixed(3), probed, expected: tailProbes.length });

      /* untouched plain line: visible + stable */
      const ext1 = await plainExtent(page, lineP.n);
      add(tag + ': untouched plain line text extent stable <=1px',
        ext1.found && Math.abs(ext1.textRight - plainExt0.textRight) <= 1 && Math.abs(ext1.textLeft - plainExt0.textLeft) <= 1,
        { beforeRight: plainExt0.textRight, nowRight: ext1.textRight, beforeLeft: plainExt0.textLeft, nowLeft: ext1.textLeft });

      const cp = await posCoords(page, [wordStartP, wordEndP]);
      const wordPBox = cp[wordStartP] && cp[wordEndP]
        ? { left: cp[wordStartP].left, right: cp[wordEndP].left, top: cp[wordStartP].top, bottom: cp[wordStartP].bottom }
        : null;
      const expectedCssP = wordPBox ? wordPBox.right - wordPBox.left : null;
      const clipP = wordPBox ? {
        x: Math.max(0, wordPBox.left - 8), y: Math.max(0, wordPBox.top - 4),
        width: wordPBox.right - wordPBox.left + 16, height: wordPBox.bottom - wordPBox.top + 8,
      } : null;
      const greenP = await pixelScan(page, clipP, 'green');
      arm.shots.push(await shot(page, outDir, host, tag + '-plain', clipP, args));
      add(tag + ': match visible on plain line (pixels)',
        !greenP.unavailable && greenP.count >= 300 && expectedCssP != null && greenP.spanX / greenP.dpr >= expectedCssP * 0.7,
        {
          greenPx: greenP.count || 0,
          spanCss: greenP.spanX ? +(greenP.spanX / greenP.dpr).toFixed(1) : null,
          expectedCss: +(expectedCssP || 0).toFixed(1),
          meanRgb: greenP.mean || null,
        });

      /* no extra wrapping anywhere in the document */
      const lay1 = await layoutSnapshot(page);
      const stable = layoutStable(layout0, lay1);
      add(tag + ': no rewrap (tops/heights/bands stable)', stable.ok, stable.diffs.slice(0, 6));

      const s = await selState(page);
      add(tag + ': doc unchanged by selection', s.doc === FIXTURE, { docLen: s.docLen });
    };

    const runMatchArm = async (id, channel, establish) => {
      const { arm, add } = makeArm(report, id, channel);
      try {
        const r = await reset();
        add(id + ': arm-reset-clean', r.ok, r);
        const sel = await establish();   // real-input landing, no rescue
        if (sel && sel.caret) add(id + ': caret-placed', sel.caret.ok, sel.caret);
        const s = await selState(page);
        add(id + ': selection-is-the-word', wordLanded(s),
          { anchor: s.anchor, head: s.head, gotText: s.text, expectedText: WORD });
        if (wordLanded(s)) {
          await withMatchChecks(arm, add, id);
        } else {
          add(id + ': with-match checks skipped (' + channel + ' did not land the word)', false, { channel });
        }
      } catch (e) { arm.error = String((e && e.stack) || e); }
    };

    /* keyboard: caret at word start + Shift+ArrowRight x len */
    await runMatchArm('match-kb', 'keyboard', async () => {
      const caret = await clickCaret(page, wordStartA);
      await extendSelection(page, 'ArrowRight', WORD.length);
      await frames(page);
      return { caret };
    });

    /* native double-click word selection — must land on its own, no rescue */
    await runMatchArm('match-dblclick', 'mouse', async () => {
      const c = (await posCoords(page, [wordStartA + 2]))[wordStartA + 2];
      await page.mouse.dblclick(c.left + 2, (c.top + c.bottom) / 2);
      await frames(page);
      return {};
    });

    /* real drag: press inside first char, move, release before last char —
     * must land on its own, no rescue.
     * The real press REVEALS the backticks and reflows the segment (~7px), so
     * coordinates read before any press are stale: click into the capsule
     * first (reveal settles), then drag, and re-read the target position once
     * more before the final approach moves + release. */
    await runMatchArm('match-drag', 'drag', async () => {
      const caret = await clickCaret(page, wordStartA);
      await frames(page);
      let cA = (await posCoords(page, [wordStartA]))[wordStartA];
      let cB = (await posCoords(page, [wordEndA]))[wordEndA];
      if (!cA || !cB) return { caret };
      const y = (cA.top + cA.bottom) / 2;
      const x0 = cA.left + Math.max(1, (await charAdvance(page, wordStartA)) * 0.3);
      await page.mouse.move(x0, y);
      await page.mouse.down();
      const n = 12;
      const mid = Math.floor(n / 2);
      for (let i = 1; i <= n; i++) {
        if (i === mid) {
          const fresh = (await posCoords(page, [wordEndA]))[wordEndA];
          if (fresh) cB = fresh;
        }
        const x1 = cB.left - 1.5;
        await page.mouse.move(x0 + (x1 - x0) * i / n, y);
        await sleep(8);
      }
      await page.mouse.up();
      await frames(page);
      return { caret };
    });

    /* ── selection color over code (native, non-transparent, pixel proof) ── */
    {
      const { arm, add } = makeArm(report, 'selection-color', 'keyboard');
      try {
        const r = await reset();
        add('selection-color: arm-reset-clean', r.ok, r);
        const caret = await clickCaret(page, wordStartA);
        await extendSelection(page, 'ArrowRight', WORD.length);
        await frames(page);
        const s = await selState(page);
        add('selection-color: selection-is-the-word',
          s.text === WORD && Math.min(s.anchor, s.head) === wordStartA, { anchor: s.anchor, head: s.head });
        add('selection-color: caret-placed', caret.ok, caret);

        const scanA = await scanCapsule(page, lineA.n);
        const col = await selectionColor(page);
        const capsuleBg = parseCssColor(scanA.bg);
        const scrollerBg = parseCssColor(col.scrollerBg);
        const baseBg = (capsuleBg && capsuleBg.a > 0 ? capsuleBg : null) || scrollerBg || { r: 255, g: 255, b: 255, a: 1 };
        const sc = parseCssColor(col.backgroundColor);
        add('selection-color: native color readable',
          !!sc, { via: col.via, backgroundColor: col.backgroundColor, mixBlendMode: col.mixBlendMode, layerCount: col.layerCount, capsuleBg: scanA.bg, scrollerBg: col.scrollerBg });
        if (sc) {
          add('selection-color: alpha non-transparent (>=0.1)', sc.a >= 0.1, { alpha: sc.a });
          const composite = compositeOver(sc, baseBg);
          const d = Math.sqrt(dist2(composite, baseBg));
          add('selection-color: distinct from code background (>=30 rgb units)',
            d >= 30,
            {
              distance: +d.toFixed(1),
              compositeRgb: [Math.round(composite.r), Math.round(composite.g), Math.round(composite.b)],
              baseRgb: [Math.round(baseBg.r), Math.round(baseBg.g), Math.round(baseBg.b)],
            });
          const cw = await posCoords(page, [wordStartA, wordEndA]);
          if (cw[wordStartA] && cw[wordEndA]) {
            const wordBox = {
              left: cw[wordStartA].left, right: cw[wordEndA].left,
              top: cw[wordStartA].top, bottom: cw[wordStartA].bottom,
            };
            const clip = {
              x: Math.max(0, wordBox.left - 4), y: Math.max(0, wordBox.top - 3),
              width: wordBox.right - wordBox.left + 8, height: wordBox.bottom - wordBox.top + 6,
            };
            const px = await pixelScan(page, clip, 'near', { rgb: [composite.r, composite.g, composite.b], tol2: 12 * 12 });
            arm.shots.push(await shot(page, outDir, host, 'selection-color', clip, args));
            const areaDev = (wordBox.right - wordBox.left) * (wordBox.bottom - wordBox.top) * px.dpr * px.dpr;
            add('selection-color: painted over code (>=35% of word box device px)',
              !px.unavailable && px.count >= 0.35 * areaDev,
              {
                matchedPx: px.count || 0,
                wordBoxAreaDev: Math.round(areaDev),
                ratio: px.count ? +(px.count / areaDev).toFixed(3) : 0,
                meanRgb: px.mean,
                tolerance: 'euclid<=12',
              });
          } else {
            add('selection-color: word box measurable', false, { coords: cw });
          }
        }
        /* clear and confirm restoration */
        await page.keyboard.press('ArrowRight');
        await frames(page);
        const deco = await selectionMatchCount(page);
        add('selection-color: cleared no selectionMatch left', deco.selectionMatch === 0, deco);
        const scanB = await scanCapsule(page, lineB.n);
        add('selection-color: cleared capsule width restored <=1px',
          scanB.box && Wb0 != null && Math.abs(scanB.box.width - Wb0) <= 1,
          { before: Wb0, now: scanB.box ? scanB.box.width : null });
      } catch (e) { arm.error = String((e && e.stack) || e); }
    }

    /* ── input + undo inside the capsule ── */
    {
      const { arm, add } = makeArm(report, 'input-undo', 'keyboard');
      try {
        const r = await reset();
        add('input-undo: arm-reset-clean', r.ok, r);
        const caret = await clickCaret(page, wordEndA);
        add('input-undo: caret-placed-at-capsule-end', caret.ok, caret);
        add('input-undo: focus-in-editor', await focusInEditor(page));
        await page.keyboard.type(TYPED, { delay: 14 });
        await frames(page);
        const expectedDoc = FIXTURE.slice(0, wordEndA) + TYPED + FIXTURE.slice(wordEndA);
        const s1 = await selState(page);
        add('input-undo: typed-chars-landed-exact', s1.doc === expectedDoc,
          { docLen: s1.docLen, expectedLen: expectedDoc.length, tail: s1.doc.slice(-24) });
        const scanA1 = await scanCapsule(page, lineA.n);
        const grew = scanA1.box ? scanA1.box.width - Wa0 : null;
        add('input-undo: capsule width grew with input', grew != null && grew >= 6,
          { before: Wa0, now: scanA1.box ? scanA1.box.width : null, grew: grew == null ? null : +grew.toFixed(3) });
        const lay1 = await layoutSnapshot(page);
        const st1 = layoutStable(layout0, lay1);
        add('input-undo: no rewrap while typing', st1.ok, st1.diffs.slice(0, 6));
        arm.shots.push(await shot(page, outDir, host, 'input-typed', clipAround(scanA1.box, vp(), 20, 10), args));

        let undone = false, presses = 0;
        for (let i = 0; i < 8 && !undone; i++) {
          await page.keyboard.press('Control+z');
          presses++;
          await sleep(90);
          undone = (await selState(page)).doc === FIXTURE;
        }
        const s2 = await selState(page);
        add('input-undo: undo restores exact document', undone && s2.doc === FIXTURE,
          { presses, docLen: s2.docLen, expectedLen: FIXTURE.length });
        await frames(page);
        const scanA2 = await scanCapsule(page, lineA.n);
        add('input-undo: undo restores capsule width <=1px',
          scanA2.box && Wa0 != null && Math.abs(scanA2.box.width - Wa0) <= 1,
          { before: Wa0, now: scanA2.box ? scanA2.box.width : null });
        const lay2 = await layoutSnapshot(page);
        const st2 = layoutStable(layout0, lay2);
        add('input-undo: undo restores layout', st2.ok, st2.diffs.slice(0, 6));
        arm.shots.push(await shot(page, outDir, host, 'input-undone', clipAround(scanA2.box, vp(), 20, 10), args));
      } catch (e) { arm.error = String((e && e.stack) || e); }
    }

    /* ── final ── */
    {
      const { arm, add } = makeArm(report, 'final', 'none');
      const s = await selState(page);
      add('doc-fidelity', s.doc === FIXTURE, { docLen: s.docLen, expectedLen: FIXTURE.length });
      add('no-page-errors', report.pageErrors.length === 0, { count: report.pageErrors.length, sample: report.pageErrors.slice(0, 2) });
      add('no-external-requests', report.externalRequests.length === 0, { count: report.externalRequests.length, sample: report.externalRequests.slice(0, 3) });
    }

    report.consoleTail = report.consoleTail.slice(-30);
    const failed = report.arms.reduce((n, arm) => n + arm.checks.filter(c => !c.ok).length + (arm.error ? 1 : 0), 0);
    report.summary = {
      arms: report.arms.length,
      checks: report.arms.reduce((n, arm) => n + arm.checks.length, 0),
      failed,
      hostOk: failed === 0,
    };
    return report;
  } finally {
    if (!args.keep) await session.close();
    else console.log('[keep] browser left open for ' + host);
  }
}

/* ── main ────────────────────────────────────────────────────────────────── */
async function main() {
  const args = parseArgs(process.argv);
  const fixtureInfo = {
    bytes: Buffer.byteLength(FIXTURE, 'utf8'),
    sha16: sha16(FIXTURE),
    lines: FIXTURE_LINES.length,
    word: WORD,
    wordLen: WORD.length,
  };
  if (args.selfCheck) {
    let playwright = null, playwrightError = null;
    try { playwright = loadPlaywright(args.playwright).chromium ? true : true; } catch (e) { playwrightError = String(e && e.message || e).split('\n')[0]; }
    const chrome = findChrome(args.chrome);
    let hostsOk = true;
    const pages = {};
    for (const host of (args.host === 'both' ? ['desktop', 'plugin'] : [args.host])) {
      const value = host === 'desktop' ? args.desktopPage : args.pluginPage;
      pages[host] = value || null;
      if (!value || !fs.existsSync(value)) hostsOk = false;
    }
    const ok = !!playwright && !!chrome && hostsOk;
    console.log(JSON.stringify({ ok, playwright: !!playwright, playwrightError, chrome, pages, fixture: fixtureInfo }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  let hosts;
  try { hosts = validateEnv(args); } catch (e) {
    console.error('env: ' + e.message);
    process.exit(2);
  }
  ensureDir(args.out);
  console.log('[inline-code-geometry] host=' + args.host + ' out=' + args.out);
  console.log('[inline-code-geometry] fixture ' + fixtureInfo.sha16 + '  ' + fixtureInfo.bytes + ' B  word=' + WORD + ' (' + WORD.length + ' chars)');

  const result = {
    probe: path.basename(__filename),
    stamp: stamp(),
    fixture: fixtureInfo,
    args: { host: args.host, desktopPage: args.desktopPage, pluginPage: args.pluginPage, headed: args.headed, screenshots: args.screenshots },
    hosts: {},
    summary: null,
  };
  for (const host of hosts) {
    console.log('\n=== host: ' + host + ' ===');
    try {
      const hostDir = ensureDir(path.join(args.out, host));
      result.hosts[host] = await runHost(host, args, hostDir);
      for (const arm of result.hosts[host].arms) {
        console.log(armLine(arm));
        for (const c of arm.checks) {
          if (!c.ok) console.log('    FAIL ' + c.name + '  ' + JSON.stringify(c.detail));
        }
      }
    } catch (e) {
      result.hosts[host] = { host, fatal: String((e && e.stack) || e), arms: [], summary: { hostOk: false, fatal: true } };
      console.error('[' + host + '] FATAL: ' + (e && e.message));
      process.exitCode = 2;
    }
  }

  let failedChecks = 0, fatal = 0;
  for (const r of Object.values(result.hosts)) {
    if (r.fatal) { fatal++; continue; }
    failedChecks += r.summary.failed;
  }
  result.summary = {
    hosts: hosts.length, fatal, failedChecks,
    exitCode: process.exitCode === 2 ? 2 : (fatal || failedChecks ? 1 : 0),
  };
  fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(result, null, 2));
  console.log('\n=== summary ===');
  for (const [host, r] of Object.entries(result.hosts)) {
    if (r.fatal) { console.log(host + ': FATAL ' + String(r.fatal).split('\n')[0]); continue; }
    console.log(host + ': ' + (r.summary.hostOk ? 'PASS' : 'FAIL') +
      ' — arms ' + r.summary.arms + ', checks ' + r.summary.checks + ', failed ' + r.summary.failed + ' (via ' + r.launchVia + ')');
  }
  console.log('exitCode=' + result.summary.exitCode + '  result=' + path.join(args.out, 'result.json'));
  process.exitCode = result.summary.exitCode;
}

main().catch(e => {
  console.error('fatal: ' + ((e && e.stack) || e));
  process.exit(2);
});
