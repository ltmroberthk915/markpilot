/* PDF print layer for the DSH plugin (host side; CommonJS).
 *
 * Why this exists: the DSH host is a Node process, so it cannot call Electron
 * webContents.printToPDF. The desktop shell's file-save IPC is a supported
 * surface, but it only writes bytes/URLs; it does not render print layouts.
 * The one offline renderer that matches the EXE's Chromium pipeline and is
 * present on Windows is the installed Edge/Chrome binary. This module drives
 * it in headless mode, prints the engine's already-built export HTML (KaTeX
 * fonts inlined, tables, inline Mermaid SVGs), and verifies a complete PDF.
 *
 * It never touches the user's target: the client chooses that path through
 * DSH's native Save-As dialog (window.dshDesktop.files.save). This module only
 * writes a private temp HTML/PDF pair and returns bytes.
 *
 * The A4/margins/print CSS are copied from MarkPilot-CM6/export-pdf.js
 * (PAGE_SIZE A4, MARGINS_IN 0.59in, PRINT_CSS) so the plugin's paper layout
 * follows the EXE instead of inventing a second print stylesheet.
 */
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Bounded limits. The EXE uses 512 MiB for the final PDF; the plugin keeps a
 *  smaller ceiling because the bytes travel through the host JSON response and
 *  the native save IPC. Long documents above this limit still fail explicitly. */
const GATE = Object.freeze({
  HTML_MAX_BYTES: 32 * 1024 * 1024,
  PDF_MAX_BYTES: 64 * 1024 * 1024,
  PRINT_TIMEOUT_MS: 120000,
  SCAN_CHUNK_BYTES: 64 * 1024,
  PAGE_SIZE: 'A4',
  /** ≈15 mm, the EXE's Chinese-document margin (Electron margins are inches). */
  MARGINS_IN: Object.freeze({ top: 0.59, bottom: 0.59, left: 0.59, right: 0.59 }),
  VIRTUAL_TIME_MS: 5000,
  /** One plugin can export a few documents at once, but not unbounded. */
  MAX_ACTIVE: 4,
});

/* Copied verbatim in spirit from MarkPilot-CM6/export-pdf.js PRINT_CSS.
 * The EXE injects it as user-origin CSS; here it is appended as the last
 * author stylesheet with !important, which has the same print effect.
 * Kept inside @media print so it cannot alter the on-disk HTML or any preview. */
const PRINT_CSS = `
@media print {
  html, body { background: #fff !important; }
  body { max-width: none !important; margin: 0 !important; padding: 0 !important; }

  :root, html:root {
    --mp-bg: #ffffff !important; --mp-fg: #1a1a1a !important; --mp-heading: #000000 !important;
    --mp-muted: #444444 !important; --mp-faint: #777777 !important; --mp-border: #bbbbbb !important;
    --mp-primary: #0645ad !important; --mp-codeBg: #f4f4f4 !important; --mp-capsule: #f0f0f0 !important;
    --mp-quoteBg: #f7f7f7 !important; --mp-quoteBar: #bbbbbb !important;
    --mp-sel: transparent !important; --mp-sel-tint: transparent !important;
    --mp-kw: #000342 !important; --mp-str: #004e36 !important; --mp-com: #5a5a5a !important;
    --mp-num: #844500 !important; --mp-typ: #001d4b !important;
  }
  body { color: var(--mp-fg) !important; }
  h1, h2, h3, h4, h5, h6 { color: var(--mp-heading) !important; border-bottom-color: var(--mp-border) !important; }
  code, th, thead td { background: var(--mp-capsule) !important; }
  pre { background: var(--mp-codeBg) !important; }
  blockquote { background: var(--mp-quoteBg) !important; border-left-color: var(--mp-quoteBar) !important; color: var(--mp-muted) !important; }
  td, th { border-color: var(--mp-border) !important; }
  hr { border-top-color: var(--mp-border) !important; }
  a { color: var(--mp-primary) !important; text-decoration: none; }

  pre { overflow: visible !important; white-space: pre-wrap !important;
        overflow-wrap: anywhere; word-break: break-word; }
  pre.mp-math { font-size: 12.5px !important; line-height: 1.6 !important;
                border-left: 3px solid var(--mp-border); padding: 8px 10px; border-radius: 0;
                break-inside: auto; page-break-inside: auto; }

  table { max-width: 100% !important; width: auto !important; table-layout: auto !important;
          break-inside: auto; page-break-inside: auto; }
  thead { display: table-header-group !important; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td, th { overflow-wrap: anywhere; word-break: break-word; }

  img { max-width: 100% !important; height: auto !important;
        break-inside: avoid; page-break-inside: avoid; }

  h1, h2, h3, h4, h5, h6 { break-after: avoid-page; page-break-after: avoid; }
  p { orphans: 3 !important; widows: 3 !important; }
  blockquote { break-inside: avoid; page-break-inside: avoid; }
}
@page { size: A4; margin: 0.59in; }
`;

const PRINT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

const active = new Map();

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** A private, uniquely named temp root; never a user-chosen path. */
function isPrivateTempRoot(dir) {
  try {
    const resolved = path.resolve(dir);
    const parent = path.dirname(resolved);
    return path.resolve(os.tmpdir()) === parent && path.basename(resolved).startsWith('markpilot-dsh-pdf-');
  } catch {
    return false;
  }
}

function safePdfName(value) {
  let base = String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'MarkPilot';
  base = base.replace(/\.pdf$/i, '').trim().slice(0, 120).trim();
  if (!base) base = 'MarkPilot';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = '_' + base;
  return base + '.pdf';
}

/** Append the EXE's print stylesheet, A4 page rule, and a no-script CSP.
 *  The engine's HTML is already escaped/publicized; this layer only adds
 *  print policy and never rewrites document content. */
function prepareHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw codedError('MP_PDF_HTML', '导出内容为空');
  if (Buffer.byteLength(html, 'utf8') > GATE.HTML_MAX_BYTES) {
    throw codedError('MP_PDF_HTML', `导出 HTML 超过 ${GATE.HTML_MAX_BYTES} 字节上限`);
  }
  let out = html;
  if (!/<html[\s>]/i.test(out) || !/<body[\s>]/i.test(out)) {
    throw codedError('MP_PDF_HTML', '导出内容不是完整 HTML 文档');
  }
  const csp = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
  const style = `<style id="mp-pdf-print">${PRINT_CSS}</style>`;
  if (/<\/head>/i.test(out)) {
    /* Append last: the engine already emits an @page 15mm rule; the EXE's
       0.59in A4 rule must win when both are present. */
    out = out.replace(/<\/head>/i, `${csp}${style}</head>`);
  } else if (/<head[\s>]/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${csp}${style}</head>`);
  } else {
    out = out.replace(/<html([^>]*)>/i, `<html$1><head>${csp}${style}</head>`);
  }
  return out;
}

/** Chromium CLI arguments. The caller passes argv directly (no shell), so
 *  spaces in the private profile/output paths cannot be re-split. */
function buildArgs({ userDataDir, htmlFile, pdfFile, virtualTimeMs = GATE.VIRTUAL_TIME_MS }) {
  return [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${Math.max(1000, Number(virtualTimeMs) || GATE.VIRTUAL_TIME_MS)}`,
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${pdfFile}`,
    pathToFileURL(htmlFile).href,
  ];
}

function browserCandidates(env = process.env) {
  const out = [];
  for (const key of ['DSH_MARKPILOT_PDF_BROWSER', 'MP_PDF_BROWSER', 'MP_BROWSER_PATH']) {
    if (env[key]) out.push(env[key]);
  }
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  if (process.platform === 'win32') {
    out.push(
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    );
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    out.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return out.filter(Boolean);
}

function findBrowser(env = process.env) {
  for (const candidate of browserCandidates(env)) {
    try {
      if (require('node:fs').existsSync(candidate)) return candidate;
    } catch { /* unreadable candidate: try the next */ }
  }
  return null;
}

/** Complete-PDF check: magic header, EOF trailer, bounded size. */
function validatePdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return { ok: false, error: 'PDF 为空' };
  if (buf.length > GATE.PDF_MAX_BYTES) return { ok: false, error: `PDF 超过 ${GATE.PDF_MAX_BYTES} 字节上限` };
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, error: 'PDF 头不完整' };
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  if (!/%%EOF\s*$/.test(tail)) return { ok: false, error: 'PDF 尾不完整' };
  return { ok: true };
}

/** Page count from the page tree; copied from MarkPilot-CM6/export-pdf.js. */
function pdfPageCount(buf) {
  const needle = Buffer.from('/Type', 'latin1');
  let pages = 0;
  let count = 0;
  const win = GATE.SCAN_CHUNK_BYTES;
  for (let off = 0; off < buf.length; off += win) {
    const hay = buf.subarray(off, Math.min(buf.length, off + win + 64));
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const tail = hay.subarray(i, Math.min(hay.length, i + 64)).toString('latin1');
      if (/^\/Type\s*\/Page(?![s])/.test(tail)) pages++;
      else if (/^\/Type\s*\/Pages/.test(tail)) {
        const m = /\/Count\s+(\d+)/.exec(tail)
          || /\/Count\s+(\d+)\s*\/Type\s*\/Pages/.exec(hay.subarray(Math.max(0, i - 40), Math.min(hay.length, i + 64)).toString('latin1'));
        if (m) count = Math.max(count, Number(m[1]));
      }
      i = hay.indexOf(needle, i + needle.length);
    }
  }
  return count || pages;
}

function killTreeDefault(child) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
    } catch { /* cleanup is best effort */ }
  }
}

async function removeTemp(dir) {
  if (!dir || !isPrivateTempRoot(dir)) return;
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
  } catch { /* Windows can hold the browser profile for a moment; leave it */ }
}

function runBrowser({ command, args, timeoutMs, signal, spawnImpl, killTree }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { signal?.removeEventListener('abort', onAbort); } catch { /* noop */ }
      if (result.running !== false && child) killTree(child);
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, canceled: true, code: 'MP_PDF_CANCELED', error: '已取消导出 PDF' });
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    } catch (error) {
      resolve({ ok: false, code: 'MP_PDF_SPAWN', error: String(error && error.message || error) });
      return;
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 8192) stderr += String(chunk);
      });
    } catch { /* no stderr pipe */ }
    child.on('error', (error) => finish({
      ok: false, running: false, code: 'MP_PDF_SPAWN', error: String(error && error.message || error),
    }));
    child.on('close', (code, sig) => finish({
      ok: code === 0, running: false, code: code === 0 ? undefined : 'MP_PDF_BROWSER',
      exitCode: code, signal: sig, error: code === 0 ? undefined : `PDF 打印进程退出码 ${code}`,
      stderr: stderr.trim(),
    }));
    timer = setTimeout(() => finish({
      ok: false, code: 'MP_PDF_TIMEOUT', error: `PDF 打印超过 ${timeoutMs} ms`,
    }), timeoutMs);
  });
}

/**
 * Render one export HTML to a verified PDF.
 * @param {object} options
 * @param {string} options.html full export HTML (engine output)
 * @param {string} [options.name] suggested filename, used only for the save dialog
 * @param {string} [options.jobId] client-generated id for cancellation
 * @param {number} [options.timeoutMs] hard print timeout
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.browserPath] test override
 * @param {Function} [options.spawnImpl] test override
 * @param {Function} [options.killTree] test override
 * @param {boolean} [options.keepStaging] diagnostic only; never set by the UI
 * @returns {Promise<object>} success carries `pdf` (Buffer); failures are structured
 */
async function renderPdf(options = {}) {
  const html = options.html;
  let prepared;
  try {
    prepared = prepareHtml(html);
  } catch (error) {
    return { ok: false, code: error.code || 'MP_PDF_HTML', error: String(error.message || error) };
  }
  const browser = options.browserPath || (options.findBrowser || findBrowser)();
  if (!browser) {
    return {
      ok: false, code: 'MP_PDF_NO_BROWSER',
      error: '未找到可用的 Edge/Chrome，无法生成真实 PDF（不会用浏览器打印对话框冒充成功）',
    };
  }
  const jobId = typeof options.jobId === 'string' && options.jobId ? options.jobId : 'pdf-' + crypto.randomUUID();
  if (active.size >= GATE.MAX_ACTIVE) {
    return { ok: false, code: 'MP_PDF_BUSY', error: '已有多个 PDF 导出在进行中，请稍后重试' };
  }
  const controller = new AbortController();
  const external = options.signal;
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }
  active.set(jobId, controller);

  const t0 = Date.now();
  let tempRoot = null;
  try {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'markpilot-dsh-pdf-'));
    if (!isPrivateTempRoot(tempRoot)) throw codedError('MP_PDF_STAGE', '临时目录不在允许范围');
    const htmlFile = path.join(tempRoot, 'document.html');
    const pdfFile = path.join(tempRoot, 'document.pdf');
    const userDataDir = path.join(tempRoot, 'profile');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(htmlFile, prepared, { encoding: 'utf8', flag: 'wx' });

    const args = buildArgs({
      userDataDir, htmlFile, pdfFile,
      virtualTimeMs: options.virtualTimeMs || GATE.VIRTUAL_TIME_MS,
    });
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs : GATE.PRINT_TIMEOUT_MS;
    const run = await runBrowser({
      command: browser,
      args,
      timeoutMs,
      signal: controller.signal,
      spawnImpl: options.spawnImpl || spawn,
      killTree: options.killTree || killTreeDefault,
    });
    if (!run.ok) {
      return {
        ok: false,
        canceled: run.canceled === true,
        code: run.code || 'MP_PDF_BROWSER',
        error: run.error || 'PDF 打印失败',
        stderr: run.stderr || undefined,
      };
    }

    let stat;
    try { stat = await fs.stat(pdfFile); } catch { stat = null; }
    if (!stat || !stat.isFile() || stat.size < 8) {
      return { ok: false, code: 'MP_PDF_OUTPUT', error: '打印进程没有生成 PDF 文件' };
    }
    if (stat.size > GATE.PDF_MAX_BYTES) {
      return { ok: false, code: 'MP_PDF_OUTPUT', error: `PDF 超过 ${GATE.PDF_MAX_BYTES} 字节上限` };
    }
    const pdf = await fs.readFile(pdfFile);
    const valid = validatePdf(pdf);
    if (!valid.ok) {
      return { ok: false, code: 'MP_PDF_OUTPUT', error: valid.error };
    }
    const tempNeedle = Buffer.from(tempRoot, 'utf8');
    const tempNeedleSlash = Buffer.from(tempRoot.replace(/\\/g, '/'), 'utf8');
    const tempNeedle16 = Buffer.from(tempRoot, 'utf16le');
    const containsTempPath = pdf.includes(tempNeedle) || pdf.includes(tempNeedleSlash) || pdf.includes(tempNeedle16);
    return {
      ok: true,
      pdf,
      bytes: pdf.length,
      pages: pdfPageCount(pdf),
      engine: path.basename(browser),
      name: safePdfName(options.name || options.title || 'MarkPilot'),
      ms: Date.now() - t0,
      containsTempPath,
      jobId,
      ...(options.keepStaging ? { tempDir: tempRoot } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'MP_PDF_ERROR',
      error: String(error.message || error),
    };
  } finally {
    if (active.get(jobId) === controller) active.delete(jobId);
    if (external) {
      try { external.removeEventListener('abort', forwardAbort); } catch { /* noop */ }
    }
    if (!options.keepStaging) await removeTemp(tempRoot);
  }
}

function cancelPdf(jobId) {
  const controller = active.get(String(jobId || ''));
  if (!controller) return false;
  try { controller.abort(); } catch { return false; }
  return true;
}

module.exports = {
  GATE,
  PRINT_CSS,
  PRINT_CSP,
  renderPdf,
  cancelPdf,
  findBrowser,
  browserCandidates,
  prepareHtml,
  buildArgs,
  validatePdf,
  pdfPageCount,
  safePdfName,
  isPrivateTempRoot,
};
