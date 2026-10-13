'use strict';
// Disable one image invariant in an owned source copy; restore exact bytes.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const [mode, ...argv] = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--root', '--kind'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid image mutation option');
  opts[argv[i].slice(2)] = argv[i + 1];
}
const kinds = ['scan', 'boundary', 'widget-anchor', 'range', 'identity', 'scale', 'reset', 'order', 'assets', 'source', 'format', 'exclusive', 'predecode'];
if (!['on', 'off'].includes(mode) || !opts.root || !kinds.includes(opts.kind))
  throw new Error('Use on|off --root <owned disposable source copy> --kind ' + kinds.join('|'));
const target = fs.realpathSync(path.resolve(opts.root));
if (target === fs.realpathSync(ROOT) || fs.existsSync(path.join(target, '.git')) ||
    JSON.parse(fs.readFileSync(path.join(target, 'quality-run.json'), 'utf8')).owner !== 'markpilot-quality')
  throw new Error('Mutation requires a marked disposable copy, never a Git checkout');
const engine = 'dsh-markpilot/src-cm6/', shell = 'MarkPilot-CM6/main.js';
const rel = ['assets', 'source', 'format', 'exclusive'].includes(opts.kind) ? shell :
  engine + (['widget-anchor', 'range', 'scale', 'predecode'].includes(opts.kind) ? 'extras.js' :
    ['reset', 'order'].includes(opts.kind) ? 'image-insertion.js' : 'main.js');
const file = fs.realpathSync(path.join(target, rel));
if (!file.startsWith(target + path.sep) || file === fs.realpathSync(path.join(ROOT, rel)))
  throw new Error('Mutation source escaped its owned copy');
const receipt = path.join(target, '.quality-image-mutation-' + opts.kind + '.json');
let saved = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
if (saved && (saved.root !== target || saved.kind !== opts.kind || saved.file !== rel)) throw new Error('Mutation ownership changed');
const verify = expected => { if (hash(fs.readFileSync(file)) !== expected) throw new Error('Source changed outside the mutation'); };
if (mode === 'off') {
  if (!saved?.active) {
    if (saved) verify(saved.beforeSha256);
    console.log(JSON.stringify({ kind: opts.kind, active: false, alreadyRestored: true }));
  } else {
    verify(saved.mutantSha256);
    const before = Buffer.from(saved.before, 'base64');
    if (hash(before) !== saved.beforeSha256) throw new Error('Mutation backup integrity failed');
    fs.writeFileSync(file, before); verify(saved.beforeSha256);
    saved.active = false; fs.writeFileSync(receipt, JSON.stringify(saved));
    console.log(JSON.stringify({ kind: opts.kind, active: false, restored: true, sha256: saved.beforeSha256 }));
  }
  process.exit(0);
}
if (saved?.active) {
  verify(saved.mutantSha256);
  console.log(JSON.stringify({ kind: opts.kind, active: true, alreadyApplied: true }));
  process.exit(0);
}
for (const name of fs.readdirSync(target).filter(n => n.startsWith('.quality-image-mutation-'))) {
  if (JSON.parse(fs.readFileSync(path.join(target, name), 'utf8')).active) throw new Error('Restore the previous mutation first');
}
const before = fs.readFileSync(file);
let code = before.toString('utf8').replaceAll('\r\n', '\n');
const once = (anchor, replacement) => {
  if (code.split(anchor).length !== 2) throw new Error('Exact mutation anchor missing or duplicated: ' + opts.kind);
  code = code.replace(anchor, replacement);
};
switch (opts.kind) {
  case 'scan':
    once(' ||\n          hasImageCandidate(tr.startState.doc.lineAt(fromA).text) || hasImageCandidate(tr.state.doc.lineAt(fromB).text)', '');
    break;
  case 'boundary':
    once('r => r.from < mark.to && r.to > mark.from', 'r => r.from <= mark.to && r.to >= mark.from');
    break;
  case 'widget-anchor':
    once('const imagePos = v.posAtDOM(wrap, 0);', "const imagePos = v.posAtDOM(v.contentDOM.querySelector('.mp-img'), 0);");
    break;
  case 'range':
    once('return mark ? { from: mark.from, to: mark.to, attrs: mark.image } : null;',
      "if (!mark) return null;\n    const raw = getView().state.doc.sliceString(mark.from, mark.to);\n    const end = raw.indexOf(raw.startsWith('<') ? '>' : ')');\n    return { from: mark.from, to: mark.from + end + 1, attrs: mark.image };");
    break;
  case 'identity':
    once('o.src === this.src && o.resolvedSrc === this.resolvedSrc', 'o.src.length === this.src.length && o.src.slice(0, 32) === this.src.slice(0, 32) && o.src.slice(-32) === this.src.slice(-32)');
    break;
  case 'scale':
    once('base = Math.min(img.naturalWidth, available);', 'base = Math.min(img.width, available);');
    break;
  case 'reset':
    once("tr.isUserEvent('redo') ||\n        tr.effects.some(effect => effect.is(cancelImageInsertions))", "tr.isUserEvent('redo')");
    break;
  case 'order':
    once('if (owner && ticket.from === owner.from && ticket.to === owner.to) {', 'if (false && owner && ticket.from === owner.from && ticket.to === owner.to) {');
    break;
  case 'assets':
    once('imgSha1(existing) === sha && existing.equals(buf)', 'existing.length === buf.length');
    break;
  case 'source':
    once('pathToFileURL(path.dirname(path.resolve(docPath)) + path.sep)', 'pathToFileURL(process.cwd() + path.sep)');
    break;
  case 'format':
    once('const img = await imgForClipboard(e.sender, source);', 'const img = nativeImage.createFromBuffer(source.buf);');
    break;
  case 'exclusive':
    once('await fsp.copyFile(tmp, target, fs.constants.COPYFILE_EXCL);', 'await fsp.copyFile(tmp, target, 0);');
    break;
  case 'predecode':
    once(`const insert = async (md, src) => {
      let image = new Image(), timer;
      try {
        image.src = imageSource(src);
        try {
          await Promise.race([image.decode(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('图片解码超时')), 10000);
          })]);
        } catch { /* Keep the real source and let the widget show a failure. */ }
        if (!await sameOrigin()) { canceled(); return false; }
        return ticket.commit(md, userEvent);
      } finally {
        clearTimeout(timer);
        image.src = '';
        image = null;
      }
    };`, 'const insert = async (md, _src) => ticket.commit(md, userEvent);');
    break;
}
const mutant = Buffer.from(code);
if (hash(mutant) === hash(before)) throw new Error('Mutation did not change the source');
saved = { schema: 1, root: target, kind: opts.kind, file: rel, active: true, before: before.toString('base64'), beforeSha256: hash(before), mutantSha256: hash(mutant) };
fs.writeFileSync(receipt, JSON.stringify(saved));
fs.writeFileSync(file, mutant); verify(saved.mutantSha256);
console.log(JSON.stringify({ kind: opts.kind, active: true, file: rel, beforeSha256: saved.beforeSha256, mutantSha256: saved.mutantSha256 }));
