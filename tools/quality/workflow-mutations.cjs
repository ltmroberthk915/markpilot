'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
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
// Imports support both tools/quality and the private review directory.
const { outputDir } = require(path.join(ROOT, 'tools/quality/harness.cjs'));
const { sha256 } = require(path.join(ROOT, 'tools/quality/lifecycle.cjs'));
const artifactFiles = require(path.join(ROOT, 'tools/quality/artifact-files.cjs'));
const mutator = path.join(__dirname, 'workflow-mutate.cjs');
const argv = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--runtime', '--out', '--kinds'].includes(argv[i]) || !argv[i + 1]) throw new Error('Use --runtime <Electron directory> --out <empty directory> [--kinds <comma-separated roots>]');
  opts[argv[i].slice(2)] = argv[i + 1];
}
if (!opts.runtime || !opts.out) throw new Error('--runtime and --out are required');
const core = artifactFiles.map(f => 'MarkPilot-CM6/' + f), codec = 'dsh-markpilot/src-cm6/cell-source-map.js';
assert.equal(new Set(core).size, core.length, 'packaged identity files must be unique');
assert(core.length > 0, 'packaged identity must not be empty');
for (const file of core) assert(fs.statSync(path.join(ROOT, file)).isFile(), 'packaged identity file exists: ' + file);
assert(core.includes('MarkPilot-CM6/renderer/cm6/app.js'));
assert(core.includes('MarkPilot-CM6/renderer/cm6/markdown-worker.js'));
const sourceFiles = [...fs.readdirSync(path.join(ROOT, 'dsh-markpilot/src-cm6')).filter(f => f.endsWith('.js')).map(f => 'dsh-markpilot/src-cm6/' + f)];
assert(sourceFiles.includes(codec), 'the cell codec must participate in source identity');
const identities = [...new Set([...sourceFiles, ...core])];
// Existing authorized changes are the baseline. Never checkout, clean or stash.
const hashes = Object.fromEntries(identities.map(f => [f, sha256(path.join(ROOT, f))]));
const dir = outputDir(opts.out, 'workflow-mutations'), copy = path.join(dir, 'source');
fs.mkdirSync(copy);
fs.writeFileSync(path.join(copy, 'quality-run.json'), JSON.stringify({ owner: 'markpilot-quality', schema: 1 }));
for (const part of ['src-cm6', 'renderer', 'package.json'])
  fs.cpSync(path.join(ROOT, 'dsh-markpilot', part), path.join(copy, 'dsh-markpilot', part), { recursive: true });
const theme = 'Typora-Editor-App/app/renderer/js/user-theme.mjs';
fs.mkdirSync(path.dirname(path.join(copy, theme)), { recursive: true });
fs.copyFileSync(path.join(ROOT, theme), path.join(copy, theme));
for (const part of ['package.json', 'main.js', 'preload.js', 'export-folder.js', 'export-pdf.js', 'shell', 'renderer', 'build'])
  fs.cpSync(path.join(ROOT, 'MarkPilot-CM6', part), path.join(copy, 'MarkPilot-CM6', part), { recursive: true });
const checkCheckout = () => {
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha256(path.join(ROOT, file)), hash, 'untouched checkout: ' + file);
};
const checkRestored = () => {
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha256(path.join(copy, file)), hash, 'restored copy: ' + file);
  checkCheckout();
};
const packagedIdentity = root => Object.fromEntries(core.map(f => [f, sha256(path.join(root, f))]));
const esbuild = require(path.join(ROOT, 'dsh-markpilot/node_modules/esbuild'));
const build = () => {
  esbuild.buildSync({
    absWorkingDir: path.join(copy, 'dsh-markpilot'), entryPoints: ['src-cm6/main.js'],
    bundle: true, format: 'iife', minify: true, outfile: path.join(copy, 'MarkPilot-CM6/renderer/cm6/app.js'),
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    nodePaths: [path.join(ROOT, 'dsh-markpilot/node_modules')], logLevel: 'error',
    alias: { '@codemirror/view': path.join(copy, 'dsh-markpilot/renderer/vendor/codemirror/view.js') },
  });
  return sha256(path.join(copy, 'MarkPilot-CM6/renderer/cm6/app.js'));
};
const baseline = build();
assert.equal(baseline, hashes['MarkPilot-CM6/renderer/cm6/app.js'], 'source must rebuild the frozen application bundle');
checkRestored();
const invoke = args => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 180000 });
const result = {
  schema: 2, startedAt: new Date().toISOString(), baselineEngine: baseline,
  coreArtifactIdentity: packagedIdentity(ROOT), sourceIdentity: hashes,
  cellCodecIdentity: { file: codec, sha256: hashes[codec] }, mutations: [],
};
// Selected controls pass in the mutant; all selected cases pass after restoration.
const definitions = [
  { kind: 'split-source-cell-owner', suite: 'split-source-workflows',
    fails: ['active-cell-source-pane-click-immediate-edit-history-continue'],
    error: /immediate R full source \/ neighbors/,
    controls: ['active-cell-source-pane-plain-click-immediate-edit-history-continue'] },
  { kind: 'history', suite: 'document-workflows', fails: ['same-text-other-file-starts-empty-history'], error: /undo in newly opened B/, controls: [] },
  { kind: 'rich', suite: 'rich-workflows', fails: ['mixed-html-preserve-all-content-in-order'], error: /every table and surrounding paragraph/, controls: [] },
  { kind: 'math', suite: 'math-workflows', fails: ['multiline-quoted-block-glyph-click-edit-undo-redo'], error: /clicking last glyph maps/, controls: [] },
  { kind: 'shift', suite: 'selection-workflows', fails: [
    'shift-forward-glyph-keeps-selection-copy-delete-undo-redo',
    'shift-reverse-glyph-keeps-selection-copy-delete-undo-redo',
    'shift-float-glyph-keeps-selection-copy-delete-undo-redo',
  ], error: /Shift glyph click preserves original anchor/, controls: [] },
  { kind: 'nav', suite: 'selection-workflows', fails: ['math-vertical-horizontal-reposition-resets-goal'],
    error: /new horizontal position starts a new vertical goal/, controls: ['math-vertical-reversal-keeps-goal'] },
  { kind: 'cell-text', suite: 'selection-workflows', fails: ['cell-typed-pipe-keeps-character-on-following-input'],
    error: /following character retains the escaped literal pipe/, controls: ['active-cell-undo-redo-keeps-source-and-overlay-in-sync'] },
  { kind: 'cell-history', suite: 'selection-workflows', fails: ['active-cell-undo-redo-keeps-source-and-overlay-in-sync'],
    error: /Expected values to be strictly equal:[\s\S]*aXb[\s\S]*ab/, controls: ['cell-typed-pipe-keeps-character-on-following-input'] },
  { kind: 'cell-owner', suite: 'selection-workflows', fails: ['cell-history-across-tab-keeps-restored-source-and-dom-in-same-cell'],
    error: /overlay must match the cell restored by source history/, controls: ['active-cell-undo-redo-keeps-source-and-overlay-in-sync'] },
  { kind: 'boot', suite: 'selection-workflows', fails: ['early-cell-focus-survives-boot-fallback'],
    error: /boot retry must preserve the user-selected cell editor/, controls: ['boot-open-document-direct-typing-needs-no-click'] },
  { kind: 'clipboard', suite: 'selection-workflows', fails: [
    'selection-copy-after-line-copy-pastes-at-caret',
    'selection-cut-after-line-copy-pastes-at-caret',
  ], error: /selected clipboard content is inserted at the caret/, controls: [] },
  { kind: 'document-focus', suite: 'document-workflows', fails: ['open-from-active-cell-immediately-types-in-new-document'],
    error: /new document receives editor focus without test refocusing it/,
    controls: ['same-file-reload-preserves-undo-identical-bytes','open-keeps-focused-persistent-settings-control'] },
  { kind: 'cell-activation', suite: 'selection-workflows', fails: ['cell-tab-home-keeps-caret-before-next-input'],
    error: /a late cell activation must not overwrite the user Home caret/,
    controls: ['early-cell-focus-survives-boot-fallback','active-cell-undo-redo-keeps-source-and-overlay-in-sync','cell-mouse-click-immediate-input-keeps-ratio-caret'] },
  { kind:'math-entry',suite:'math-entry-workflows',fails:['quoted-down-immediate-type-undo-redo','nested-quoted-down-immediate-type-undo-redo'],
    error:/vertical entry lands at the mapped formula token/,
    controls:['plain-down-immediate-type-undo-redo','plain-up-immediate-type-undo-redo'] },
  { kind:'math-paste',suite:'math-paste-workflows',fails:['html-ordinary-replace-inline-y-history-continue'],
    error:/paste preserves the complete intended literal source/,controls:['html-plain-shortcut-replace-inline-y-history-continue','text-only-replace-inline-y-history-continue'] },
  { kind:'html-fragment',suite:'math-paste-workflows',fails:['html-only-replace-inline-y-history-continue','html-only-literal-whitespace-replace-inline-y-history-continue'],
    error:/paste preserves the complete intended literal source/,controls:['html-ordinary-replace-inline-y-history-continue'] },
  { kind:'cell-search',suite:'search-workflows',fails:['active-cell-ctrl-f-opens-search-without-document-edit'],
    error:/CtrlF or toolbar must open and focus the actual search input before any query/,
    controls:['body-ctrl-f-search-focus-positive-control','toolbar-find-replace-search-focus-positive-control'] },
  { kind:'search-return',suite:'search-workflows',fails:['body-ctrl-f-search-focus-positive-control','toolbar-find-replace-search-focus-positive-control'],
    error:/return-to-edit changes only the matched cell token/,controls:['search-ordinary-body-return-history-positive-control'] },
  { kind:'native-menu',suite:'native-menu-workflows',fails:['native-menu-body-undo-history-continue','native-menu-body-redo-history-continue','native-menu-cell-undo-history-continue','native-menu-cell-redo-history-continue','native-menu-search-undo-history-continue','native-menu-search-redo-history-continue'],
    error:/actual menu (?:undo|redo) preserves expected document history|search native fallback emits trusted history input/,controls:['native-menu-body-empty-undo-history-continue','native-menu-body-empty-redo-history-continue','native-menu-cell-empty-undo-history-continue','native-menu-cell-empty-redo-history-continue'] },
  { kind:'math-gesture',suite:'cross-page-drag-workflows',fails:['formula-held-wheel-loop'],
    error:/mouseup.*(?:preserve|selection)|selection.*(?:preserve|mouseup)/i,controls:['plain-held-wheel-loop'] },
  { kind:'menu-pending',suite:'native-pending-image-workflows',fails:['native-menu-undo-pending-bitmap-empty-history'],
    error:/late image response never inserts Markdown after native Undo/,controls:['native-menu-undo-pending-bitmap-nonempty-history'] },
];
const selectedKinds=opts.kinds?opts.kinds.split(','):definitions.map(d=>d.kind);
assert(selectedKinds.length && new Set(selectedKinds).size===selectedKinds.length,'mutation roots must be unique');
for(const kind of selectedKinds)assert(definitions.some(d=>d.kind===kind),'unknown mutation root: '+kind);
const cases=definitions.filter(d=>selectedKinds.includes(d.kind));
result.selectedKinds=selectedKinds;
function clean(stage) {
  const resolved = fs.realpathSync(stage);
  assert(resolved.startsWith(fs.realpathSync(dir) + path.sep), 'stage cleanup stays within the output directory');
  assert.equal(JSON.parse(fs.readFileSync(path.join(resolved, 'quality-run.json'))).owner, 'markpilot-quality');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function stage(tag) {
  const out = path.join(dir, tag);
  invoke(['tools/quality/stage-app.cjs', '--runtime', opts.runtime, '--app', path.join(copy, 'MarkPilot-CM6'), '--out', out]);
  const artifact = JSON.parse(fs.readFileSync(path.join(out, 'artifact.json')));
  fs.writeFileSync(path.join(dir, tag + '-artifact.json'), JSON.stringify(artifact, null, 2));
  return { out, artifact };
}
const regexEscape = value => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
function readSuite(out, definition, negative, artifact) {
  const report = JSON.parse(fs.readFileSync(path.join(out, 'result.json')));
  const actual = report.metadata || report.artifact;
  assert(actual, 'actual running artifact metadata');
  assert.equal(actual.asarSha256, artifact.asarSha256, 'actual full ASAR matches this mutation stage');
  assert.equal(actual.runtimeExecutableSha256, artifact.exeSha256, 'actual runtime executable matches this stage');
  for (const file of artifact.files) assert.equal(actual.artifactFiles.find(f => f.file === file.file)?.sha256, file.sha256,
    'actual packaged identity: ' + file.file);
  const ids = [...definition.fails, ...definition.controls];
  assert.equal(report.cases.length, ids.length, 'exact selected-case count');
  assert.deepEqual(report.cases.map(c => c.id).sort(), [...ids].sort(), 'exact selected-case identities');
  for (const item of report.cases) {
    const mustFail = negative && definition.fails.includes(item.id);
    assert.equal(item.status, mustFail ? 'fail' : 'pass', 'case outcome: ' + item.id);
    if (mustFail) assert.match(item.error, definition.error, 'original failure oracle: ' + item.id);
  }
  assert.deepEqual(report.cleanup.residual, []);
  if (['search-workflows','native-menu-workflows','math-gesture-workflows','split-source-workflows'].includes(definition.suite)) assert.equal(report.clipboard.touched,false,'suite keeps clipboard untouched');
  else if (definition.suite === 'native-pending-image-workflows') assert.equal(report.clipboardCleanup.restored,true,'pending bitmap clipboard restored');
  else if (definition.suite !== 'document-workflows') assert(report.clipboard.restored, 'clipboard restored');
  if (!negative) assert(report.passed, 'recovered suite passed');
  return report;
}
try {
  for (const definition of cases) {
    const { kind, suite } = definition;
    let redStage, greenStage;
    const on = [mutator, 'on', '--root', copy, '--kind', kind], off = [mutator, 'off', '--root', copy, '--kind', kind];
    try {
      invoke(on); invoke(on);
      const mutantEngine = build(), mutantIdentity = packagedIdentity(copy);
      checkCheckout();
      redStage = stage('stage-' + kind);
      const filter = '^(' + [...definition.fails, ...definition.controls].map(regexEscape).join('|') + ')$';
      const run = (artifact, out) => spawnSync(process.execPath, [
        'tools/quality/' + suite + '.cjs', '--exe', artifact.executable,
        '--expected-sha256', artifact.exeSha256, '--out', out,
      ], { cwd: ROOT, env: { ...process.env, MP_QUALITY_CASES: filter }, stdio: 'inherit', windowsHide: true, timeout: 180000 });
      const redOut = path.join(dir, 'negative-' + kind), negative = run(redStage.artifact, redOut);
      assert.equal(negative.status, 1, 'real mutant must fail');
      const red = readSuite(redOut, definition, true, redStage.artifact);
      invoke(off); invoke(off);
      assert.equal(build(), baseline); checkRestored();
      greenStage = stage('restored-' + kind);
      const greenOut = path.join(dir, 'positive-' + kind), positive = run(greenStage.artifact, greenOut);
      assert.equal(positive.status, 0, 'byte-restored product must pass');
      readSuite(greenOut, definition, false, greenStage.artifact);
      assert.notEqual(redStage.artifact.asarSha256, greenStage.artifact.asarSha256, 'mutation reached the staged product');
      result.mutations.push({
        kind, suite, ids: definition.fails, controls: definition.controls,
        negativeErrors: red.cases.filter(c => c.status === 'fail').map(c => ({ id: c.id, error: c.error })),
        expectedError: definition.error.source, mutantEngine, restoredEngine: baseline,
        mutantCoreArtifactIdentity: mutantIdentity, restoredCoreArtifactIdentity: packagedIdentity(copy),
        redAsar: redStage.artifact.asarSha256, greenAsar: greenStage.artifact.asarSha256,
        sourceRestored: true, idempotentOnOff: true, positive: true,
      });
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    } finally {
      try {
        invoke(off); assert.equal(build(), baseline); checkRestored();
      } finally {
        try { if (redStage) clean(redStage.out); }
        finally { if (greenStage) clean(greenStage.out); }
      }
    }
  }
  checkRestored(); result.passed = result.mutations.length === cases.length;
} catch (e) {
  result.passed = false; result.fatal = e.message; process.exitCode = 1;
} finally {
  try { checkCheckout(); result.checkoutUnchanged = true; }
  catch (e) { result.checkoutUnchanged = false; result.passed = false; result.checkoutError = e.message; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ passed: result.passed, total: result.mutations.length, fatal: result.fatal }));
