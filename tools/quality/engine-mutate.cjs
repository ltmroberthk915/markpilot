'use strict';
// Reversible source rollback in an explicitly owned disposable repository copy.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');
const ROOT = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const [mode, ...argv] = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--root', '--kind', '--baseline-ref'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid engine mutation option');
  opts[argv[i].slice(2)] = argv[i + 1];
}
if (!['on', 'off'].includes(mode) || !opts.root || !['context', 'completion-order', 'underline', 'export', 'quoted-enter', 'code-line-number'].includes(opts.kind))
  throw new Error('Use on|off --root <owned disposable repository copy> --kind context|completion-order|underline|export|quoted-enter|code-line-number [--baseline-ref <commit>]');
const target = fs.realpathSync(path.resolve(opts.root));
if (target === fs.realpathSync(ROOT) || JSON.parse(fs.readFileSync(path.join(target, 'quality-run.json'), 'utf8')).owner !== 'markpilot-quality')
  throw new Error('Use an owned disposable copy, never the product checkout');
const rel = name => 'dsh-markpilot/src-cm6/' + name;
if (fs.realpathSync(path.join(target, rel('main.js'))) === fs.realpathSync(path.join(ROOT, rel('main.js')))) throw new Error('Source resolves to product checkout');
const stateDir = path.join(ROOT, '.mp-verify/quality-engine-mutants'); fs.mkdirSync(stateDir, { recursive: true });
const manifest = path.join(stateDir, opts.kind + '-' + hash(target).slice(0, 12) + '.json');
let saved = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
if (saved && (saved.root !== target || saved.kind !== opts.kind)) throw new Error('Mutation ownership changed');
const verifyActive = () => {
  for (const f of saved.files) if (hash(fs.readFileSync(path.join(target, f.file))) !== f.mutantSha256) throw new Error('Mutant changed: ' + f.file);
};
if (mode === 'off') {
  if (!saved?.active) { console.log(JSON.stringify({ kind: opts.kind, active: false, alreadyRestored: true })); process.exit(0); }
  verifyActive();
  for (const f of saved.files) {
    const bytes = Buffer.from(f.before, 'base64');
    if (hash(bytes) !== f.beforeSha256) throw new Error('Backup integrity failed');
    fs.writeFileSync(path.join(target, f.file), bytes);
  }
  saved.active = false; fs.writeFileSync(manifest, JSON.stringify(saved));
  console.log(JSON.stringify({ kind: opts.kind, active: false, restored: true, files: saved.files.map(f => ({ file: f.file, sha256: f.beforeSha256 })) }));
  process.exit(0);
}
if (saved?.active) { verifyActive(); console.log(JSON.stringify({ kind: opts.kind, active: true, alreadyApplied: true })); process.exit(0); }
const baseline = file => {
  if (!opts['baseline-ref']) throw new Error('--baseline-ref is required for a genuine rollback');
  return execFileSync('git', ['show', opts['baseline-ref'] + ':' + file], { cwd: ROOT, maxBuffer: 2000000, encoding: 'utf8' });
};
function functionNode(source, name) {
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  };
  walk(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  if (found.length !== 1) throw new Error('Function anchor must occur once: ' + name);
  return found[0];
}
const revert = (current, old, name) => {
  const a = functionNode(current, name), b = functionNode(old, name);
  return current.slice(0, a.start) + old.slice(b.start, b.end) + current.slice(a.end);
};
const once = (s, anchor, value) => { if (s.split(anchor).length !== 2) throw new Error('Exact mutation anchor missing/duplicated'); return s.replace(anchor, value); };
let files;
if (opts.kind === 'context') files = ['main.js', 'lists.js', 'tables.js', 'completion.js'].map(name => ({ file: rel(name), mutant: baseline(rel(name)) }));
else {
  const file = rel(opts.kind === 'underline' ? 'toolbar.js' : ['export','quoted-enter'].includes(opts.kind) ? 'extras.js' : 'main.js');
  let mutant = fs.readFileSync(path.join(target, file), 'utf8');
  if (opts.kind === 'completion-order') {
    mutant = once(mutant, '        mathCompletion(), // Open candidates have priority over structural Enter/Tab.\n', '');
    mutant = once(mutant, '        listSemantics,\n', '        listSemantics,\n        mathCompletion(),\n');
  } else if (opts.kind === 'quoted-enter') {
    mutant = once(mutant, "    { key: 'Enter', run: fenceNewline, shift: fenceNewline },\n", '');
  } else if (opts.kind === 'code-line-number') {
    const old=baseline(file),nodes=acorn.parse(old,{ecmaVersion:'latest',sourceType:'module'}).body.filter(n=>n.type==='VariableDeclaration'&&n.declarations.length===1&&n.declarations[0].id?.name==='codeLineNoPlugin');
    if(nodes.length!==1)throw new Error('Original imperative line-number owner must occur once');
    mutant=once(mutant,'function boot(content) {',old.slice(nodes[0].start,nodes[0].end)+'\n\nfunction boot(content) {');
    mutant=once(mutant,"...(n ? { attributes: { 'data-mp-n': n } } : {})",'');
    mutant=once(mutant,'        sbField,','        codeLineNoPlugin,\n        sbField,');
  } else {
    const old = baseline(file);
    for (const name of opts.kind === 'underline' ? ['enclosingSpan', 'wrap'] : ['mdBodyChunks']) mutant = revert(mutant, old, name);
  }
  files = [{ file, mutant }];
}
saved = { schema: 1, root: target, kind: opts.kind, baselineRef: opts['baseline-ref'] || null, active: true, files: files.map(f => {
  const before = fs.readFileSync(path.join(target, f.file)), mutant = Buffer.from(f.mutant);
  if (hash(before) === hash(mutant)) throw new Error('Rollback has no effect: ' + f.file);
  return { file: f.file, before: before.toString('base64'), beforeSha256: hash(before), mutantSha256: hash(mutant) };
}) };
fs.writeFileSync(manifest, JSON.stringify(saved));
for (const f of files) fs.writeFileSync(path.join(target, f.file), f.mutant);
console.log(JSON.stringify({ kind: opts.kind, active: true, files: saved.files.map(({ file, beforeSha256, mutantSha256 }) => ({ file, beforeSha256, mutantSha256 })) }));
