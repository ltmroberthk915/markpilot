'use strict';
// Verify the shipped bytes and final-host results, without making API calls.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const plugin = path.resolve(root, '../Typora-Editor');
const extension = path.join(plugin, 'extension-src');
const experiment = path.join(plugin, 'test/.runs/lowcost-v3-2026-09-07');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file).replace(/^\uFEFF/, ''));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const fileHash = file => digest(fs.readFileSync(file));
const files = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? files(file) : [file];
});
const equalFile = (a, b) => assert.equal(fileHash(a), fileHash(b), `Copy differs: ${a}`);
const compare = (source, destination) => {
  const sourceFiles = files(source);
  for (const file of sourceFiles) equalFile(file, path.join(destination, path.relative(source, file)));
  assert.equal(sourceFiles.length, files(destination).length, destination);
  return sourceFiles.length;
};

const version = json(path.join(root, 'package.json')).version;
const extensionVersion = json(path.join(extension, 'package.json')).version;
assert.equal(version, '1.0.14');
assert.equal(extensionVersion, '0.1.24-local');
const release = path.join(root, `dist/release-${version}-final`);
const archive = path.join(release, 'win-unpacked/resources/app.asar');
const unpackedVsix = path.join(plugin, 'test/.runs/vsix-0.1.24-final/extension');
const vsix = path.join(plugin, `dist/markpilot-${extensionVersion}.vsix`);

const appFiles = files(path.join(root, 'app'));
const appNames = new Set(appFiles.map(file => path.relative(root, file).replaceAll('\\', '/')));
for (const file of appFiles) {
  assert.equal(fileHash(file), digest(asar.extractFile(archive, path.relative(root, file))), `ASAR differs: ${file}`);
}
for (const entry of asar.listPackage(archive)) {
  const key = entry.replaceAll('\\', '/').replace(/^\//, '');
  if (key.startsWith('app/') && !asar.statFile(archive, path.normalize(key)).files) {
    assert.ok(appNames.has(key), `Unexpected packaged file: ${key}`);
  }
}
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const sharedRendererFiles = compare(path.join(extension, 'render'), path.join(root, 'app/renderer'));
const sharedCompletionFiles = compare(path.join(extension, 'out/completion'), path.join(root, 'app/shared/out/completion')) + 1;
equalFile(path.join(extension, 'render/js/completion-policy.mjs'), path.join(root, 'app/shared/render/js/completion-policy.mjs'));
const extensionFiles = compare(extension, unpackedVsix);
for (const name of ['extension.vsixmanifest', '[Content_Types].xml']) {
  equalFile(path.join(plugin, 'vsix-meta', name), path.join(unpackedVsix, '..', name));
}
// Also verify the ZIP itself, rather than relying only on a prior extraction.
const zippedFiles = Number(execFileSync('python', ['-c', `
import pathlib, sys, zipfile
archive, source, metadata = map(pathlib.Path, sys.argv[1:])
expected = {'extension/' + p.relative_to(source).as_posix(): p for p in source.rglob('*') if p.is_file()}
expected.update({name: metadata / name for name in ('extension.vsixmanifest', '[Content_Types].xml')})
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert len(z.namelist()) == len(expected) and set(z.namelist()) == set(expected)
    for name, p in expected.items():
        assert z.read(name) == p.read_bytes(), name
print(len(expected))
`, vsix, extension, path.join(plugin, 'vsix-meta')], {encoding: 'utf8', windowsHide: true}).trim());
assert.equal(zippedFiles, extensionFiles + 2);

const checks = [];
for (const [label, file, count] of [
  ['Shared completion and boundary units', path.join(experiment, 'units.log'), 37],
  ['Desktop platform units', path.join(root, '.perf/lowcost-app-units.log'), 4]
]) {
  const output = read(file);
  assert.match(output, new RegExp(`tests ${count}\\s`));
  assert.match(output, new RegExp(`pass ${count}\\s`));
  assert.match(output, /fail 0\s/);
  checks.push({label, count, path: file, sha256: fileHash(file)});
}
for (const [label, name] of [['VS Code final VSIX', 'vscode-final.log'], ['Trae final VSIX', 'trae-final.log']]) {
  const log = path.join(experiment, name);
  const outputPath = read(log).match(/Isolated VSCode test output: ([^\r\n]+)/)?.[1].trim();
  assert.ok(outputPath, `Host run did not finish: ${log}`);
  const file = path.join(outputPath, 'results.json');
  const result = json(file);
  assert.equal(result.version, extensionVersion);
  assert.equal(path.resolve(result.extensionPath), unpackedVsix);
  assert.equal(result.results.length, 101);
  assert.ok(result.results.every(item => item.startsWith('PASS ')), file);
  checks.push({label, count: result.results.length, path: file, sha256: fileHash(file), engineVersion: result.vscode, extensionVersion: result.version, log});
}
const desktopLog = path.join(root, '.perf/lowcost-completion-packaged.log');
const desktopOutput = read(desktopLog);
assert.ok(!/^(?:FAIL|AssertionError|Error:)/m.test(desktopOutput));
const desktopChecks = desktopOutput.match(/^PASS [^\r\n]+/gm) || [];
assert.equal(desktopChecks.length, 23);
const desktopJson = path.join(root, '.perf/desktop-completion.json');
assert.deepEqual(json(desktopJson), desktopChecks);
checks.push({label: 'Desktop final ASAR completion and API failure regression', count: desktopChecks.length, path: desktopJson, sha256: fileHash(desktopJson), log: desktopLog, archive});

const audit = json(path.join(experiment, 'audit.json'));
assert.equal(audit.accepted, true);
assert.equal(audit.attempts, 200);
assert.equal(audit.successful, 200);
assert.equal(audit.finalCleanupPreservesAllCandidateOutputs, true);
assert.equal(fileHash(path.join(extension, 'render/js/completion-policy.mjs')), audit.finalPolicySha256);
for (const name of ['core.cjs', 'structure.cjs']) {
  equalFile(path.join(extension, 'out/completion', name), path.join(experiment, 'candidate/out/completion', name));
}
const design = json(path.join(experiment, 'design.json'));
assert.equal(fileHash(design.source.path), design.source.sha256, 'Original note changed');

const artifacts = [
  path.join(root, `dist/markpilot-Setup-${version}.exe`),
  path.join(root, `dist/markpilot-v${version}-portable.exe`),
  vsix
].map(file => {
  if (file.endsWith('.exe')) equalFile(file, path.join(release, path.basename(file)));
  return {path: file, bytes: fs.statSync(file).size, sha256: fileHash(file)};
});
const report = {
  desktopVersion: version, extensionVersion, checkedAt: new Date().toISOString(),
  packagedFiles: appFiles.length, sharedRendererFiles, sharedCompletionFiles, extensionFiles, zippedFiles,
  archive: {path: archive, sha256: fileHash(archive)}, checks,
  totalAutomatedChecks: checks.reduce((sum, check) => sum + check.count, 0),
  experiment: {path: experiment, report: path.join(plugin, 'docs/autocomplete-lowcost-100.md'), calls: audit.attempts, model: design.model, accepted: audit.accepted},
  limitations: [
    'Fresh A/B uses 100 sites from one previously evaluated note, one draw per arm and one assistant grader; no statistically significant cross-document gain is established.',
    'Math latency P95 increased from 1667 ms to 2206 ms; aggregate latency is not evidence of a math tail improvement.',
    'Input cache rates differ substantially between arms; observed fees and latency do not establish steady-state differences.',
    'Host and API failure regressions use local mock servers; paid quality calls are recorded separately in the A/B experiment.'
  ],
  artifacts,
  installation: 'Packages built and verified. Production installations, configuration and file associations were not modified.'
};
assert.equal(report.totalAutomatedChecks, 266);
fs.writeFileSync(path.join(root, `docs/release-${version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({version, extensionVersion, checks: report.totalAutomatedChecks, packagedFiles: appFiles.length, sharedRendererFiles, sharedCompletionFiles, zippedFiles, artifacts}, null, 2));
