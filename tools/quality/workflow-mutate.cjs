'use strict';
// Regressions are applied only to one marked disposable source copy.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function repositoryRoot(start) {
  let current = fs.realpathSync(start);
  for (;;) {
    if (fs.existsSync(path.join(current, 'tools/quality/lifecycle.cjs')) &&
        fs.existsSync(path.join(current, 'MarkPilot-CM6/main.js')) &&
        fs.existsSync(path.join(current, 'dsh-markpilot/src-cm6/main.js'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate the source checkout');
    current = parent;
  }
}
const ROOT = repositoryRoot(__dirname);
const [mode, ...argv] = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--root', '--kind'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid workflow mutation argument');
  opts[argv[i].slice(2)] = argv[i + 1];
}
const files = {
  history: 'MarkPilot-CM6/renderer/host.js', rich: 'dsh-markpilot/src-cm6/extras.js',
  math: 'dsh-markpilot/src-cm6/main.js', shift: 'dsh-markpilot/src-cm6/main.js',
  nav: 'dsh-markpilot/src-cm6/main.js', 'cell-text': 'dsh-markpilot/src-cm6/cell-source-map.js',
  'cell-history': 'dsh-markpilot/src-cm6/main.js', boot: 'MarkPilot-CM6/renderer/host.js',
  'cell-owner': 'dsh-markpilot/src-cm6/main.js',
  clipboard: 'dsh-markpilot/src-cm6/main.js',
  'document-focus': 'dsh-markpilot/src-cm6/main.js',
  'cell-activation': 'dsh-markpilot/src-cm6/main.js',
  'math-entry': 'dsh-markpilot/src-cm6/main.js',
  'math-paste': 'dsh-markpilot/src-cm6/extras.js',
  'html-fragment': 'dsh-markpilot/src-cm6/extras.js',
  'cell-search': 'dsh-markpilot/src-cm6/main.js',
  'search-return': 'dsh-markpilot/src-cm6/main.js',
  'native-menu': 'MarkPilot-CM6/renderer/host.js',
  'math-gesture': 'dsh-markpilot/src-cm6/main.js',
  'menu-pending': 'dsh-markpilot/src-cm6/main.js',
  'split-source-cell-owner': 'dsh-markpilot/src-cm6/splitview.js',
};
if (!['on', 'off'].includes(mode) || !opts.root || !files[opts.kind])
  throw new Error('Use on|off --root <marked disposable copy> --kind ' + Object.keys(files).join('|'));
const target = fs.realpathSync(path.resolve(opts.root));
if (target === ROOT || fs.existsSync(path.join(target, '.git')) ||
    JSON.parse(fs.readFileSync(path.join(target, 'quality-run.json'))).owner !== 'markpilot-quality')
  throw new Error('A disposable owned source copy is required');
const rel = files[opts.kind], file = fs.realpathSync(path.join(target, rel));
if (!file.startsWith(target + path.sep) || file === fs.realpathSync(path.join(ROOT, rel)))
  throw new Error('Mutation source escaped its owned copy');
const receipt = path.join(target, '.quality-workflow-mutation-' + opts.kind + '.json');
let saved = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : null;
if (saved && (saved.root !== target || saved.kind !== opts.kind || saved.file !== rel))
  throw new Error('Mutation ownership changed');
const verify = expected => {
  if (hash(fs.readFileSync(file)) !== expected) throw new Error('Source changed outside the mutation');
};
if (mode === 'off') {
  if (saved?.active) {
    verify(saved.mutantSha256);
    const bytes = Buffer.from(saved.before, 'base64');
    if (hash(bytes) !== saved.beforeSha256) throw new Error('Backup integrity failed');
    fs.writeFileSync(file, bytes); verify(saved.beforeSha256);
    saved.active = false; fs.writeFileSync(receipt, JSON.stringify(saved));
  } else if (saved) verify(saved.beforeSha256);
  console.log(JSON.stringify({ kind: opts.kind, active: false, restored: !!saved, sha256: saved?.beforeSha256 }));
  process.exit(0);
}
if (saved?.active) {
  verify(saved.mutantSha256);
  console.log(JSON.stringify({ kind: opts.kind, active: true, alreadyApplied: true }));
  process.exit(0);
}
for (const name of fs.readdirSync(target).filter(n => n.startsWith('.quality-workflow-mutation-'))) {
  if (JSON.parse(fs.readFileSync(path.join(target, name))).active) throw new Error('Restore the previous mutation first');
}
const before = fs.readFileSync(file);
let code = before.toString('utf8').replaceAll('\r\n', '\n');
const once = (anchor, replacement) => {
  if (code.split(anchor).length !== 2) throw new Error('Mutation anchor missing or duplicated: ' + opts.kind);
  code = code.replace(anchor, replacement);
};
if (opts.kind === 'history') once("else down('replaceDocument', text);", "else down('setValue', text);");
if (opts.kind === 'split-source-cell-owner')
  once('      if (!focusSelection?.(a)) a.focus();', '      a.focus();');
if (opts.kind === 'native-menu') once("    case 'undo':\n    case 'redo': {\n      if (!window.mpEngine?.menuHistory?.(cmd)) await window.mpHost.history(cmd);\n      break;\n    }\n", '');
if (opts.kind === 'math-gesture') {
  once('  mousemove(event, view) {\n    const p = view.__mpMathClick;\n    if (p && (event.buttons & 1) && Math.abs(event.clientX - p.x) + Math.abs(event.clientY - p.y) > 4) p.moved = true;\n    return false;\n  },\n', '');
  once('    if (p.moved || view.scrollDOM.scrollTop !== p.scrollTop) return false;\n', '');
}
if (opts.kind === 'menu-pending') once('      cancelPendingImageInsertions(view);\n      const command = cmd === "undo" ? undo : redo;', '      const command = cmd === "undo" ? undo : redo;');
if (opts.kind === 'rich') once('function htmlRichToMd(body) {',
  "function htmlRichToMd(body) {\n    const first = body.querySelector('table'); if (first) return rowsToMdTable(tableRowsFromElement(first));");
if (opts.kind === 'math') {
  once('const offset = mathGlyphOffset(box, event, tex);\n    if (offset != null) pos = mathSourcePosition(span, offset);',
    'const offset = mathGlyphOffset(box, event, tex);\n    if (offset != null) pos = base + Math.max(0, Math.min(offset, tex.length));');
  once('const offset = mathGlyphOffset(holder, event, span.tex);\n      if (offset != null) pos = mathSourcePosition(span, offset);',
    'const offset = mathGlyphOffset(holder, event, span.tex);\n      if (offset != null) pos = span.texFrom + Math.max(0, Math.min(offset, span.tex.length));');
}
if (opts.kind === 'shift')
  once('  const anchor = gesture?.shift ? gesture.anchor : pos;', '  const anchor = pos;');
if (opts.kind === 'math-entry')
  once('  const pos = mathSourcePosition(best, dir < 0 ? best.tex.length : 0);', [
    '  const openLine = st.doc.lineAt(best.from), closeLine = st.doc.lineAt(best.to);',
    '  const pos = openLine.number === closeLine.number',
    '    ? (dir < 0 ? best.to - 2 : best.from + 2)',
    '    : (dir < 0 ? st.doc.line(closeLine.number - 1).to : st.doc.line(openLine.number + 1).from);',
  ].join('\n'));
if (opts.kind === 'math-paste') once('    if (inMathBody) {', '    if (false && inMathBody) { // Regression: allow rich conversion inside literal TeX.');
if (opts.kind === 'html-fragment')
  once('      const literal = clipboardFragmentText(htmlDoc);', '      const literal = htmlDoc.body.textContent || \'\'; // Regression: include clipboard context whitespace.');
if (opts.kind === 'cell-search')
  once("    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^f$/i.test(e.key) && view && cellEdit) {",
    "    if (false && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^f$/i.test(e.key) && view && cellEdit) {");
if (opts.kind === 'search-return')
  once('      if (view !== inputView || !document.hasFocus() || document.activeElement !== inputView.contentDOM || !inputView.hasFocus) return;',
    '      return; // Regression: omit the search source-range to cell-owner transfer.');
if (opts.kind === 'document-focus')
  once('          view.contentDOM.contains(active) || cellOverlay?.contains(active)) view.focus();',
    '          view.contentDOM.contains(active) || cellOverlay?.contains(active)) { /* Regression: omit new document focus transfer. */ }');
if (opts.kind === 'cell-activation')
  once('  focusIt();\n}\nfunction deactivateCellOverlay()',
    '  requestAnimationFrame(focusIt); setTimeout(focusIt, 30);\n}\nfunction deactivateCellOverlay()');
if (opts.kind === 'nav') {
  once([
    '          if (u.transactions.some(tr => tr.docChanged || (tr.selection &&',
    "            !tr.isUserEvent('select.vertical') && !tr.annotation(verticalSelection)))) {",
    '            mathPass = null; blockPassDir = 0;',
    '            verticalIntentDiag.resets++;',
    '          }',
  ].join('\n'), [
    '          if (u.transactions.some(tr => tr.docChanged)) {',
    '            mathPass = null; blockPassDir = 0;',
    '            verticalIntentDiag.resets++;',
    '          }',
  ].join('\n'));
}
if (opts.kind === 'cell-text') {
  once([
    'export function cellTextChange(source, text) {',
    '  const next = encodeCellText(text);',
    '  if (next === source) return null;',
    '  let from = 0, suffix = 0;',
    '  while (from < source.length && from < next.length && source[from] === next[from]) from++;',
    '  while (suffix < source.length - from && suffix < next.length - from &&',
    '    source[source.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;',
    '  return { from, to: source.length - suffix, insert: next.slice(from, next.length - suffix), source: next };',
    '}',
  ].join('\n'), [
    'export function cellTextChange(source, text) {',
    '  const previous = mappedCellSource(source).text;',
    '  if (text === previous) return null;',
    '  let from = 0, suffix = 0;',
    '  while (from < previous.length && from < text.length && previous[from] === text[from]) from++;',
    '  while (suffix < previous.length - from && suffix < text.length - from &&',
    '    previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;',
    '  const to = source.length - suffix;',
    '  const insert = encodeCellText(text.slice(from, text.length - suffix));',
    '  return { from, to, insert, source: source.slice(0, from) + insert + source.slice(to) };',
    '}',
  ].join('\n'));
}
if (opts.kind === 'cell-history') {
  once([
    'function cellHistory(edit, command) {',
    '  if (!view || !cellEdit) return;',
    '  syncCellSelection(edit);',
    '  command(view);',
    '  resyncCellEdit(edit);',
    '}',
  ].join('\n'), [
    'function cellHistory(edit, command) {',
    '  if (!view || !cellEdit) return;',
    '  syncCellSelection(edit);',
    '  view.focus();',
    '  command(view);',
    '  resyncCellEdit(edit);',
    '}',
  ].join('\n'));
}
if (opts.kind === 'cell-owner') {
  once('  if (!containsSelection(range) || (line && isSeparatorBody(line.text.slice(tableLead(line.text).off)))) {',
    '  if (false) { // Regression: keep the previous cell owner after native history restores another cell.');
}
if (opts.kind === 'boot') {
  once('  const onUserInput = event => { if (event.isTrusted) retire(); };', '  const onUserInput = () => {};');
  once('    if (active && active !== document.body && active !== document.documentElement) return;',
    '    void active; // Regression: delayed focus ignores the active control owner.');
}
if (opts.kind === 'clipboard') {
  once('    // Native copy reads state.sliceDoc and resets its linewise-copy metadata.\n    return false;', [
    '    const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join(st.lineBreak);',
    '    event.clipboardData?.setData("text/plain", text);',
    '    event.preventDefault();',
    '    return true;',
  ].join('\n'));
  once([
    '      try { window.mpExtras?.tableOp?.("row-delete"); } catch (e) { console.error("[mp] 行剪切失败：", e); }',
    '      return true;', '    }', '    return false;', '  },', '});',
  ].join('\n'), [
    '      try { window.mpExtras?.tableOp?.("row-delete"); } catch (e) { console.error("[mp] 行剪切失败：", e); }',
    '      return true;', '    }',
    '    const text = ranges.map((r) => st.sliceDoc(r.from, r.to)).join(st.lineBreak);',
    '    event.clipboardData?.setData("text/plain", text);',
    '    event.preventDefault();',
    '    view.dispatch({ changes: ranges.map(r => ({ from: r.from, to: r.to, insert: "" })), userEvent: "delete.cut", scrollIntoView: true });',
    '    return true;', '  },', '});',
  ].join('\n'));
}
const mutant = Buffer.from(code);
if (hash(mutant) === hash(before)) throw new Error('Mutation did not change source');
saved = {
  schema: 1, root: target, kind: opts.kind, file: rel, active: true,
  before: before.toString('base64'), beforeSha256: hash(before), mutantSha256: hash(mutant),
};
fs.writeFileSync(receipt, JSON.stringify(saved)); fs.writeFileSync(file, mutant); verify(saved.mutantSha256);
console.log(JSON.stringify({ kind: opts.kind, active: true, beforeSha256: saved.beforeSha256, mutantSha256: saved.mutantSha256 }));
