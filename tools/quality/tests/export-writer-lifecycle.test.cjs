'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHtmlWriter, prepareAssets } = require('../../../MarkPilot-CM6/export-folder.js');

async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_, reject) => { timer=setTimeout(() => reject(new Error('timed out: '+label)),2000); })]); }
  finally { clearTimeout(timer); }
}
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'markpilot-writer-audit-'));
  t.after(async () => {
    if (!(await fs.stat(dir).catch(() => null))) return;
    const actual=await fs.realpath(dir),parent=await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
    assert(path.basename(actual).startsWith('markpilot-writer-audit-'));
    assert.equal((await fs.lstat(dir)).isSymbolicLink(),false);
    await fs.rm(actual,{recursive:true,force:true});
  });
  return dir;
}

test('finish flushes multiple chunks and permits immediate directory removal', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'multi' });
  await writer.write('<p>one</p>');
  await writer.write('<p>two</p>');
  const result = await within(writer.finish(), 'multi-chunk finish');
  assert.deepEqual({ ok: result.ok, bytes: result.bytes, chunks: result.chunks }, { ok: true, bytes: 20, chunks: 2 });
  assert.equal((await fs.realpath(dir)).toLowerCase(),path.resolve(dir).toLowerCase());
  assert(path.basename(dir).startsWith('markpilot-writer-audit-'));
  assert.equal(path.dirname(dir).toLowerCase(),(await fs.realpath(os.tmpdir())).toLowerCase());
  await within(fs.rm(dir, { recursive: true }), 'remove after finish');
});

test('abort before open settles both abort and an already-started write as canceled', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'early' });
  const writing = writer.write('payload');
  const rejected=assert.rejects(within(writing,'write canceled before open'),/结束|取消|关闭/);
  const aborting = writer.abort();
  await Promise.all([within(aborting,'abort before open'),rejected]);
  assert.equal(await fs.stat(writer.file).catch(e => e.code), 'ENOENT');
});

test('abort during a pending write call does not hang or report a successful write', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'write-race' });
  await writer.write('opened');
  const writing=writer.write('x'.repeat(4*1024*1024));
  const rejected=assert.rejects(within(writing,'pending write after open'),/结束|取消|关闭|destroy|closed|write/i);
  await Promise.resolve();
  await Promise.all([within(writer.abort(),'abort after open'),rejected]);
});

test('abort during a pending finish settles finish as canceled', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'finish-race' });
  await writer.write('opened');
  const finishing=writer.finish();
  const rejected=assert.rejects(within(finishing,'finish canceled'),/取消|结束|关闭|destroy|closed|write/i);
  await Promise.resolve();
  await Promise.all([within(writer.abort(),'abort during finish'),rejected]);
});

test('two abort calls share the same in-flight promise', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'abort-twice' });
  const first = writer.abort();
  const second = writer.abort();
  assert.strictEqual(second, first);
  await within(first, 'repeated abort');
});

test('two finish calls share the same promise and completion result', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'finish-twice' });
  const first = writer.finish();
  const second = writer.finish();
  assert.strictEqual(second, first);
  assert.deepEqual(await within(first, 'repeated finish'), await second);
});

test('abort after successful finish removes the completed file', async (t) => {
  const dir = await tempDir(t);
  const writer = createHtmlWriter({ dir, name: 'finished-abort' });
  await writer.write('complete');
  assert.equal((await within(writer.finish(), 'finish before cleanup')).ok, true);
  const cleaned = await within(writer.abort(), 'abort after finish');
  assert.equal(cleaned.removed, writer.file);
  assert.equal(await fs.stat(writer.file).catch(e => e.code), 'ENOENT');
});

test('an existing directory named as the output is preserved and export chooses another name', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(path.join(dir,'blocked.html'));
  const writer = createHtmlWriter({ dir, name: 'blocked' });
  await writer.write('new output');
  const result = await within(writer.finish(), 'unique output beside directory');
  assert.equal((await fs.stat(path.join(dir,'blocked.html'))).isDirectory(), true);
  assert.equal(await fs.readFile(result.file,'utf8'),'new output');
  assert.notEqual(result.file,path.join(dir,'blocked.html'));
  await writer.abort();
  assert.equal((await fs.stat(path.join(dir,'blocked.html'))).isDirectory(), true);
});

test('asset preparation stops taking jobs once cancellation is observed', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'source');
  const out = path.join(dir, 'out');
  await fs.mkdir(source);
  await Promise.all(['a.png', 'b.png', 'c.png'].map((name) => fs.writeFile(path.join(source, name), name)));
  let canceled = false;
  const result = await within(prepareAssets({
    dir: out, docPath: path.join(source, 'doc.md'), refs: ['a.png', 'b.png', 'c.png'], concurrency: 1,
    onProgress: () => { canceled = true; }, isCanceled: () => canceled,
  }), 'canceled asset preparation');
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(result.entries.filter(e => e.ok).length, 1);
  assert.equal(await fs.stat(path.join(out, 'assets', 'b.png')).catch(e => e.code), 'ENOENT');
});

test('asset preparation retains ordinary behavior without a cancellation callback', async (t) => {
  const dir = await tempDir(t);
  const source = path.join(dir, 'source');
  const out = path.join(dir, 'out');
  await fs.mkdir(source);
  await Promise.all(['a.png', 'b.png'].map((name) => fs.writeFile(path.join(source, name), name)));
  const result = await within(prepareAssets({ dir: out, docPath: path.join(source, 'doc.md'), refs: ['a.png', 'b.png'], concurrency: 1 }), 'ordinary assets');
  assert.equal(result.ok, true);
  assert.equal(result.copied, 2);
  assert.equal(result.entries.filter(e => e.ok).length, 2);
});
