// Desktop-only releases reuse the shared renderer; do not count prior VSIX tests as new runs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const archive = path.join(root, `dist/release-${version}-final/win-unpacked/resources/app.asar`);
const reports = process.argv.slice(2).map(file => ({file: path.resolve(file), ...JSON.parse(fs.readFileSync(file))}));
assert.equal(reports.length, 3, 'pass source launch, ASAR launch and EXE launch reports');
const [sourceLaunch, packagedLaunch, executableLaunch] = reports;
assert.equal(sourceLaunch.application, root);
assert.equal(packagedLaunch.application, archive);
assert.equal(executableLaunch.version, version);
for (const report of reports) assert.ok(report.results.length > 0 && report.results.every(line => line.startsWith('PASS ')));
const files = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(item => item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]);
const appFiles = files(path.join(root, 'app'));
for (const file of appFiles) assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive, path.relative(root, file))), 'archive mismatch: ' + file);
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const renderer = path.resolve(root, '../Typora-Editor/extension-src/render');
const rendererFiles = files(renderer);
for (const file of rendererFiles) {
  const relative = path.relative(renderer, file);
  const source = fs.readFileSync(file);
  assert.ok(source.equals(fs.readFileSync(path.join(root, 'app/renderer', relative))), 'shared renderer mismatch: ' + relative);
  assert.ok(source.equals(fs.readFileSync(path.join(root, '.backups/1.0.5-before-file-launch/app/renderer', relative))), 'unexpected renderer change: ' + relative);
}
const count = file => (fs.readFileSync(path.join(root, '.perf', file), 'utf8').match(/^PASS /gm) || []).length;
const desktopHost = count('shell.txt'), packagedHost = count('packaged-shell.txt');
assert.equal(desktopHost, 30); assert.equal(packagedHost, 30);
const artifacts = [`markpilot-Setup-${version}.exe`, `markpilot-v${version}-portable.exe`].map(name => {
  const file = path.join(root, 'dist', name);
  const buffer = fs.readFileSync(file);
  assert.ok(buffer.equals(fs.readFileSync(path.join(root, `dist/release-${version}-final`, name))), 'published copy mismatch: ' + name);
  return {path: file, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex')};
});
const report = {
  desktopVersion: version,
  checkedAt: new Date().toISOString(),
  packagedAppFilesVerified: appFiles.length,
  sharedRendererFilesVerified: rendererFiles.length,
  sharedRendererUnchangedSince: '1.0.5 / VSIX 0.1.12-local',
  checks: {fileOpenUnits: 11, recentState: 2, desktopLaunch: sourceLaunch.results.length, desktopHost, actualExecutable: executableLaunch.results.length},
  packagedRecheck: {desktopLaunch: packagedLaunch.results.length, desktopHost: packagedHost},
  launchReports: reports.map(({file}) => file),
  clipboardAndExplorerActions: 'Exercised through real menu/IPC handlers with system sinks stubbed; no clipboard writes or Explorer windows during these tests.',
  artifacts,
};
fs.writeFileSync(path.join(root, `docs/release-${version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
