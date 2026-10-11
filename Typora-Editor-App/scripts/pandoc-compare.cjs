#!/usr/bin/env node
// Reproducible same-input comparison against the App's long-notebook export.
// The comparison is intentionally evidence-first: DOCX/HTML must complete,
// while the strict PDF path records an input/engine incompatibility instead
// of silently changing the Markdown or claiming a speed result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || path.join(root, '.perf', 'export-book', '动态规划教材.md'));
const output = path.resolve(process.argv[3] || path.join(root, '.perf', 'pandoc-compare-1.0.15'));
const pandoc = process.env.PANDOC_EXE || 'C:\\Program Files\\Pandoc\\pandoc.exe';
const header = path.join(root, 'scripts', 'pandoc-compat-header.tex');
const sourceBuffer = fs.readFileSync(input);
const sourceText = sourceBuffer.toString('utf8');
const sourceHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
fs.mkdirSync(output, {recursive: true});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(executable, args, options = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(executable, args, {
    cwd: options.cwd || output,
    encoding: 'utf8',
    timeout: options.timeoutMs || 120000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: {...process.env, ...(options.env || {})},
  });
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    executable,
    args,
    durationMs: Math.round(durationMs),
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout,
    stderr,
    warnings: stderr.split(/\r?\n/).filter(line => /^\[WARNING\]/.test(line)),
  };
}

function artifact(file) {
  if (!fs.existsSync(file)) return {path: file, exists: false, bytes: 0, sha256: null};
  const stat = fs.statSync(file);
  return {path: file, exists: true, bytes: stat.size, sha256: sha256(file)};
}

function finish(name, command, file, options = {}) {
  const result = run(pandoc, command);
  const item = {
    name,
    command: [pandoc, ...command],
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    warningsCount: result.warnings.length,
    warnings: result.warnings.slice(0, 40),
    stderrTail: result.stderr.slice(-8000),
    artifact: artifact(file),
    comparisonRole: options.comparisonRole || 'comparable',
  };
  if (options.inspect) Object.assign(item, options.inspect(file, result));
  fs.writeFileSync(path.join(output, name + '.stderr.txt'), result.stderr, 'utf8');
  return item;
}

function inspectHtml(file) {
  if (!fs.existsSync(file)) return {formulaCount: 0, mathInline: 0, mathBlock: 0, annotationCount: 0, marker: false};
  const html = fs.readFileSync(file, 'utf8');
  return {
    formulaCount: (html.match(/<math\b/g) || []).length,
    mathInline: (html.match(/<math[^>]*display="inline"/g) || []).length,
    mathBlock: (html.match(/<math[^>]*display="block"/g) || []).length,
    annotationCount: (html.match(/<annotation\b/g) || []).length,
    errorCount: (html.match(/<merror\b/g) || []).length,
    marker: html.includes('性能测点'),
    localServerLeak: html.includes('127.0.0.1'),
  };
}

function inspectDocx(file) {
  if (!fs.existsSync(file)) return {formulaCount: 0, formulaParagraphCount: 0, marker: false, packageXml: false};
  const extracted = run('tar.exe', ['-xOf', file, 'word/document.xml'], {cwd: output, timeoutMs: 30000});
  const xml = extracted.stdout;
  return {
    formulaCount: (xml.match(/<m:oMath\b/g) || []).length,
    formulaParagraphCount: (xml.match(/<m:oMathPara\b/g) || []).length,
    marker: xml.includes('性能测点'),
    packageXml: extracted.exitCode === 0 && xml.length > 0,
    packageXmlError: extracted.error || (extracted.exitCode === 0 ? null : extracted.stderr.slice(-2000)),
  };
}

function findBinary(name, candidates) {
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const found = spawnSync('where.exe', [name], {encoding: 'utf8', windowsHide: true});
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null;
}

function inspectPdf(file) {
  if (!fs.existsSync(file)) return {valid: false, pages: null, pdfinfo: null};
  const pdfinfo = findBinary('pdfinfo.exe', [
    'C:\\Users\\Ming\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\poppler\\Library\\bin\\pdfinfo.exe',
  ]);
  if (!pdfinfo) return {valid: true, pages: null, pdfinfo: 'unavailable'};
  const info = run(pdfinfo, [file], {cwd: output, timeoutMs: 30000});
  const pages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1] || 0) || null;
  return {valid: info.exitCode === 0, pages, pdfinfo: info.stdout.slice(0, 4000), pdfinfoError: info.stderr.slice(-2000)};
}

const appEvidencePath = path.join(root, '.perf', 'export-book.json');
const appEvidence = JSON.parse(fs.readFileSync(appEvidencePath, 'utf8'));
const appResults = Object.fromEntries(appEvidence.results.map(item => [item.format, item]));
const appInput = path.resolve(path.join(root, '.perf', 'export-book', '动态规划教材.md'));
if (path.resolve(input) !== appInput) throw new Error('Comparison input must be the exact Markdown saved by the App export run.');
if (!fs.existsSync(header)) throw new Error('Missing scripts/pandoc-compat-header.tex');

const from = 'markdown+tex_math_dollars+raw_tex';
const docxPath = path.join(output, 'pandoc.docx');
const htmlPath = path.join(output, 'pandoc.html');
const pdfPath = path.join(output, 'pandoc-strict.pdf');
const docx = finish('docx', ['--from=' + from, '--to=docx', '--output', docxPath, input], docxPath, {
  inspect: file => inspectDocx(file),
});
const html = finish('html', ['--from=' + from, '--to=html5', '--math-method=mathml', '--standalone', '--output', htmlPath, input], htmlPath, {
  inspect: file => inspectHtml(file),
});
const pdf = finish('pdf-strict', [
  '--from=' + from,
  '--to=pdf',
  '--pdf-engine=xelatex',
  '--variable=mainfont=Microsoft YaHei',
  '--variable=CJKmainfont=Microsoft YaHei',
  '--include-in-header', header,
  '--output', pdfPath,
  input,
], pdfPath, {
  comparisonRole: 'strict-same-input',
  inspect: file => inspectPdf(file),
});

const pandocVersion = run(pandoc, ['--version'], {cwd: root, timeoutMs: 30000});
const sourceAfterHash = sha256(input);
const comparable = [docx, html].map(item => {
  const app = appResults[item.name];
  return {
    format: item.name,
    appMs: app?.ms ?? null,
    pandocMs: item.durationMs,
    elapsedRatioPandocOverApp: app?.ms ? Number((item.durationMs / app.ms).toFixed(3)) : null,
    appBytes: app?.bytes ?? null,
    pandocBytes: item.artifact.bytes,
    appFormulaCount: app?.formulas ?? null,
    pandocFormulaCount: item.formulaCount ?? null,
    pandocWarnings: item.warningsCount,
    appOutput: app?.path ?? null,
    pandocOutput: item.artifact.path,
  };
});

const evidence = {
  generatedAt: new Date().toISOString(),
  tool: {
    executable: pandoc,
    version: pandocVersion.stdout,
    versionExitCode: pandocVersion.exitCode,
  },
  input: {
    path: input,
    bytes: sourceBuffer.length,
    utf8Chars: sourceText.length,
    sha256: sourceHash,
    sha256AfterRun: sourceAfterHash,
    unchanged: sourceHash === sourceAfterHash,
    marker: sourceText.includes('性能测点'),
    appEvidencePath,
    appOriginalSource: appEvidence.source,
    appOriginalSourceSha256: appEvidence.sourceSHA256,
    appEditSaveMs: appEvidence.editSaveMs,
    appExpectedFormulaCount: appResults.html?.formulas ?? null,
  },
  conditions: {
    sourceFormat: from,
    htmlMathMethod: 'mathml',
    pdfEngine: 'xelatex',
    pdfFonts: ['Microsoft YaHei'],
    pdfCompatibilityHeader: header,
    network: 'not required by commands; local input/output only',
  },
  runs: {docx, html, pdfStrict: pdf},
  comparison: comparable,
  conclusion: {
    docxHtmlComparable: docx.exitCode === 0 && html.exitCode === 0 && docx.artifact.exists && html.artifact.exists,
    strictPdfComparable: pdf.exitCode === 0 && pdf.artifact.exists,
    strictPdfNote: pdf.exitCode === 0
      ? 'Pandoc produced a PDF with the recorded engine and compatibility header.'
      : 'Pandoc strict PDF did not complete on the unchanged input; see pdf-strict.stderr.txt. No PDF speed claim is made.',
  },
};
fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(evidence, null, 2));

if (!evidence.input.unchanged) throw new Error('Comparison input changed during Pandoc run.');
if (!evidence.conclusion.docxHtmlComparable) throw new Error('Pandoc DOCX/HTML comparison did not complete.');
for (const item of [docx, html]) console.log(`PASS Pandoc ${item.name}: ${item.durationMs} ms, ${item.artifact.bytes} bytes, ${item.formulaCount} formulas, ${item.warningsCount} warnings`);
if (pdf.exitCode === 0) console.log(`PASS Pandoc strict PDF: ${pdf.durationMs} ms, ${pdf.artifact.bytes} bytes, ${pdf.pages || '?'} pages`);
else console.log(`RECORDED Pandoc strict PDF incompatibility: exit ${pdf.exitCode}, see ${path.join(output, 'pdf-strict.stderr.txt')}`);
console.log(`PASS Pandoc input unchanged: ${sourceHash}`);
console.log(`Evidence: ${path.join(output, 'comparison.json')}`);
