const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {findLaunchPath, isNewFileLaunch, FileOpenQueue} = require('../app/main/file-open');
const fixtures = fs.mkdtempSync(path.join(__dirname, '../.perf/launch-args-'));
const file = path.join(fixtures, '教材 # (中文版).md');
const dashFile = path.join(fixtures, '-notes.md');
fs.writeFileSync(file, '# notes\n');
fs.writeFileSync(dashFile, '# notes\n');
const options = {isPackaged: true, appPath: __dirname, cwd: fixtures};

test('new-file launch flag respects packaged/development argv and option boundaries',()=>{
  assert.equal(isNewFileLaunch(['app.exe','--new-md'],options),true);
  assert.equal(isNewFileLaunch(['electron.exe','.','--new-md'],{isPackaged:false}),true);
  assert.equal(isNewFileLaunch(['app.exe','--user-data-dir',fixtures,'--new-md'],options),true);
  assert.equal(isNewFileLaunch(['app.exe','--','--new-md'],options),false);
  assert.equal(isNewFileLaunch(['app.exe','--user-data-dir','--new-md'],options),false);
  assert.equal(isNewFileLaunch(['app.exe','--new-md.md'],options),false);
});

for (const [name, argv, overrides, expected] of [
  ['packaged file association keeps a Unicode absolute path', ['markpilot.exe', file], {}, file],
  ['development launch skips the Electron application argument', ['electron.exe', '.', file], {isPackaged: false}, file],
  ['relative paths use the launching process directory', ['markpilot.exe', path.basename(file)], {}, file],
  ['explicit folders are supported', ['markpilot.exe', fixtures], {}, fixtures],
  ['Chromium option values are not mistaken for folders', ['markpilot.exe', '--user-data-dir', fixtures, '--remote-debugging-port=12345', file], {}, file],
  ['end-of-options permits a hyphenated filename', ['markpilot.exe', '--', '-notes.md'], {}, dashFile],
  ['application directory is not a requested workspace', ['markpilot.exe', __dirname, file], {}, file],
  ['nonexistent paths do not become launch requests', ['markpilot.exe', 'missing.md'], {}, null],
]) {
  test(name, () => assert.equal(findLaunchPath(argv, {...options, ...overrides}), expected));
}

test('cold and early second-instance requests wait for the shell, override restore and keep order', async () => {
  const opened = [];
  let releaseFirst;
  const gate = new Promise(resolve => {releaseFirst = resolve;});
  const queue = new FileOpenQueue(async file => {
    opened.push('start ' + file);
    if (file === 'first') await gate;
    opened.push('finish ' + file);
    return true;
  });
  const first = queue.request('first'), second = queue.request('second');
  await Promise.resolve(); assert.deepEqual(opened, []);
  const started = queue.start(() => assert.fail('explicit launch must override session restore'));
  await Promise.resolve(); assert.deepEqual(opened, ['start first']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  await started;
  assert.deepEqual(opened, ['start first', 'finish first', 'start second', 'finish second']);
});

test('a new launch during session restore waits for it, and later boots never restore again', async () => {
  const opened = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const queue = new FileOpenQueue(file => {opened.push(file); return true;});
  const started = queue.start(async () => {opened.push('restore'); await gate;});
  await Promise.resolve();
  const request = queue.request('new file');
  assert.deepEqual(opened, ['restore']);
  release(); await started; await request;
  await queue.start(() => assert.fail('must not re-read saved content on shell reload'));
  assert.deepEqual(opened, ['restore', 'new file']);
});

test('failed opens and cancelled switches do not block later requests', async () => {
  const queue = new FileOpenQueue(file => {
    if (file === 'missing') throw new Error('file disappeared');
    return file !== 'cancel';
  });
  const missing = assert.rejects(queue.request('missing'), /file disappeared/);
  const cancelled = queue.request('cancel');
  const success = queue.request('valid');
  await queue.start(() => assert.fail('failed explicit requests must not silently open a different file'));
  await missing;
  assert.equal(await cancelled, false); assert.equal(await success, true);
  assert.equal(await queue.request('next'), true);
});
