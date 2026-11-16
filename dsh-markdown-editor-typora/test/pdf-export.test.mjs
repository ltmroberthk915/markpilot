/* PDF host layer unit tests (no Edge, no desktop app, no user files).
 *
 * Run: node --test dsh-markdown-editor-typora/test/pdf-export.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pdf = require('../lib/pdf-export.cjs');

const HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试</title></head><body><h1>中文</h1><table><tr><td>1</td></tr></table><svg></svg></body></html>';
const PDF = Buffer.from(
  '%PDF-1.7\n'
  + '1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n'
  + '2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n'
  + 'trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
  'latin1',
);

function fakeSpawn({ body = PDF, never = false, onArgs } = {}) {
  return (command, args) => {
    if (onArgs) onArgs(command, args);
    const child = new EventEmitter();
    child.pid = 424242;
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (!never) {
      setTimeout(() => {
        const flag = args.find((arg) => arg.startsWith('--print-to-pdf='));
        const out = flag.slice('--print-to-pdf='.length);
        fs.writeFileSync(out, body);
        child.emit('close', 0, null);
      }, 5);
    }
    return child;
  };
}

test('buildArgs pins headless Edge/Chrome flags, private profile, A4 print and file URL', () => {
  const args = pdf.buildArgs({
    userDataDir: 'C:\\Users\\Ming\\AppData\\Local\\Temp\\markpilot-dsh-pdf-x\\profile',
    htmlFile: 'C:\\Users\\Ming\\AppData\\Local\\Temp\\markpilot-dsh-pdf-x\\document.html',
    pdfFile: 'C:\\Users\\Ming\\AppData\\Local\\Temp\\markpilot-dsh-pdf-x\\document.pdf',
    virtualTimeMs: 5000,
  });
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--disable-gpu'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--no-pdf-header-footer'));
  assert.ok(args.includes('--print-to-pdf-no-header'));
  assert.ok(args.includes('--user-data-dir=C:\\Users\\Ming\\AppData\\Local\\Temp\\markpilot-dsh-pdf-x\\profile'));
  assert.ok(args.includes('--print-to-pdf=C:\\Users\\Ming\\AppData\\Local\\Temp\\markpilot-dsh-pdf-x\\document.pdf'));
  assert.ok(args.includes('--virtual-time-budget=5000'));
  const url = args.at(-1);
  assert.match(url, /^file:\/\/\//);
  assert.ok(url.includes('document.html'));
});

test('prepareHtml appends EXE print CSS, A4 page rule and no-script CSP without touching content', () => {
  const out = pdf.prepareHtml(HTML);
  assert.ok(out.includes('Content-Security-Policy'));
  assert.ok(out.includes("default-src 'none'"));
  assert.ok(out.includes("img-src data:;"));
  assert.ok(out.includes('mp-pdf-print'));
  assert.ok(out.includes('@page { size: A4; margin: 0.59in; }'));
  assert.ok(out.includes('@media print'));
  assert.ok(out.includes('<h1>中文</h1>'));
  assert.ok(out.includes('<table>'));
  assert.ok(!out.includes('mp-print-hint'));
  const engineLike = '<html><head><style>@page { size: A4; margin: 15mm; }</style></head><body>x</body></html>';
  const ordered = pdf.prepareHtml(engineLike);
  assert.ok(ordered.lastIndexOf('margin: 0.59in') > ordered.lastIndexOf('margin: 15mm'));
  assert.ok(!ordered.includes("img-src data: file:"));
  assert.ok(!ordered.includes("img-src data: https:"));
});

test('prepareHtml rejects empty, non-document and oversized input', () => {
  assert.throws(() => pdf.prepareHtml(''), /导出内容为空/);
  assert.throws(() => pdf.prepareHtml('<div>x</div>'), /完整 HTML/);
  assert.throws(() => pdf.prepareHtml('<html><body>' + 'x'.repeat(pdf.GATE.HTML_MAX_BYTES) + '</body></html>'), /上限/);
});

test('validatePdf accepts a complete PDF and rejects HTML/truncated output', () => {
  assert.deepEqual(pdf.validatePdf(PDF), { ok: true });
  assert.equal(pdf.validatePdf(Buffer.from('<html>not pdf</html>')).ok, false);
  const truncated = Buffer.from(PDF.toString('latin1').replace('%%EOF\n', ''));
  assert.equal(pdf.validatePdf(truncated).ok, false);
});

test('pdfPageCount reads the page tree count', () => {
  assert.equal(pdf.pdfPageCount(PDF), 1);
});

test('safePdfName strips path/reserved characters and always ends in .pdf', () => {
  assert.equal(pdf.safePdfName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j.pdf');
  assert.equal(pdf.safePdfName('report.PDF'), 'report.pdf');
  assert.equal(pdf.safePdfName('CON'), '_CON.pdf');
  assert.equal(pdf.safePdfName(''), 'MarkPilot.pdf');
});

test('client image-route helper keeps absolute path segments and never emits file:', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function imageRouteForPath');
  const end = source.indexOf('function bytesToBase64', start);
  assert.ok(start > 0 && end > start);
  const routeOf = new Function('return (' + source.slice(start, end).trim() + ')')();
  assert.equal(routeOf('C:\\文档 目录\\chart.png'), '/dsh-markdown-editor-typora/img/C%3A/%E6%96%87%E6%A1%A3%20%E7%9B%AE%E5%BD%95/chart.png');
  assert.equal(routeOf('\\\\server\\share\\chart.png'), '/dsh-markdown-editor-typora/img///server/share/chart.png');
  assert.ok(!routeOf('C:\\文档 目录\\chart.png').includes('file:'));
});

test('PDF image policy follows EXE: remote images are reported, not fatal', () => {
  const source = fs.readFileSync(new URL('../../dsh-markpilot/src-cm6/extras.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('导出 PDF 已取消：'), 'remote/unavailable images must not cancel the whole PDF');
  assert.ok(source.includes('srcMap: images.map'), 'local images still inline through the shared export path');
  assert.ok(source.includes('images: images.summary'), 'image summary reaches the caller');
  assert.ok(source.includes('r.images.remote'), 'remote images are reported in the result/toast');
});

test('renderPdf writes a private temp HTML, prints, verifies, and cleans up', async () => {
  let seenArgs = null;
  const result = await pdf.renderPdf({
    html: HTML,
    name: '测试文档',
    browserPath: 'C:\\fake\\msedge.exe',
    spawnImpl: fakeSpawn({ onArgs: (_cmd, args) => { seenArgs = args; } }),
    killTree: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.pages, 1);
  assert.equal(result.name, '测试文档.pdf');
  assert.equal(result.bytes, PDF.length);
  assert.equal(result.containsTempPath, false);
  assert.ok(seenArgs);
  const userDataArg = seenArgs.find((arg) => arg.startsWith('--user-data-dir='));
  const tempRoot = path.dirname(userDataArg.slice('--user-data-dir='.length));
  assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
  assert.equal(fs.existsSync(tempRoot), false);
});

test('renderPdf cancels an in-flight job and cleans up', async () => {
  const pending = pdf.renderPdf({
    html: HTML,
    jobId: 'job-cancel-test',
    timeoutMs: 5000,
    browserPath: 'C:\\fake\\msedge.exe',
    spawnImpl: fakeSpawn({ never: true }),
    killTree: () => {},
  });
  setTimeout(() => { assert.equal(pdf.cancelPdf('job-cancel-test'), true); }, 30);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(result.code, 'MP_PDF_CANCELED');
});

test('renderPdf times out without leaving a running job', async () => {
  const result = await pdf.renderPdf({
    html: HTML,
    timeoutMs: 40,
    browserPath: 'C:\\fake\\msedge.exe',
    spawnImpl: fakeSpawn({ never: true }),
    killTree: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MP_PDF_TIMEOUT');
});

test('renderPdf refuses to fake success when no browser is available', async () => {
  const result = await pdf.renderPdf({
    html: HTML,
    findBrowser: () => null,
    spawnImpl: fakeSpawn(),
    killTree: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MP_PDF_NO_BROWSER');
});

test('renderPdf rejects a browser that exits 0 without a PDF', async () => {
  const result = await pdf.renderPdf({
    html: HTML,
    browserPath: 'C:\\fake\\msedge.exe',
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 1;
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit('close', 0, null), 5);
      return child;
    },
    killTree: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MP_PDF_OUTPUT');
});

test('temporary PDFs are not returned when keepStaging is off', async () => {
  const result = await pdf.renderPdf({
    html: HTML,
    browserPath: 'C:\\fake\\msedge.exe',
    spawnImpl: fakeSpawn(),
    killTree: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'tempDir'), false);
  await fsp.rm(path.join(os.tmpdir(), 'markpilot-dsh-pdf-'), { recursive: true, force: true }).catch(() => {});
});

test('host dispatch export/pdf returns the verified PDF bytes through the existing API fence', async () => {
  const { createHost } = await import('../lib/index.js');
  const host = createHost({
    fs: {
      resolve: async (target) => ({ targetKey: target, displayPath: target }),
      writeText: async () => ({ version: 'v1' }),
    },
    log: { warn() {}, info() {} },
  });
  const original = pdf.renderPdf;
  pdf.renderPdf = async () => ({
    ok: true, pdf: PDF, bytes: PDF.length, pages: 1,
    engine: 'msedge.exe', name: '测试.pdf', ms: 1,
  });
  try {
    const result = await host.dispatch('export/pdf', { html: HTML, name: '测试' });
    assert.equal(result.ok, true);
    assert.equal(result.pages, 1);
    assert.equal(result.bytes, PDF.length);
    assert.equal(Buffer.from(result.pdfBase64, 'base64').subarray(0, 5).toString('latin1'), '%PDF-');
  } finally {
    pdf.renderPdf = original;
    host.close();
  }
});
