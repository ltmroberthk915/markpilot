import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, MODEL_TOOL } from '../lib/index.js';

const fsStub = {
  async resolve(path) { return { targetKey: String(path), displayPath: String(path) }; },
  async writeText() { throw new Error('unused by docs/archive'); },
};

const SILENT_LOG = { info() {}, warn() {} };
const provider = () => ({ requestRejection: () => undefined });

test('docs/archive writes a durable copy under app data and never touches the source', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mp-archive-test-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    const host = createHost({ fs: fsStub, log: SILENT_LOG, connectionProvider: provider });
    const source = join(base, '秋招笔试', '北交所面试材料.md');
    const text = 'OLD DRAFT\n第二行\n';
    const result = await host.dispatch('docs/archive', {
      path: source, text, tag: 'stale-draft', baseVersion: 'v1', docToken: 'dshdoc-test',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.value.archivePath, 'string');
    assert.ok(result.value.archivePath.startsWith(join(base, '.markpilot', 'draft-archive')));
    assert.equal(await readFile(result.value.archivePath, 'utf8'), text);
    const meta = JSON.parse(await readFile(result.value.metaPath, 'utf8'));
    assert.equal(meta.sourcePath, source);
    assert.equal(meta.tag, 'stale-draft');
    assert.equal(meta.docToken, 'dshdoc-test');
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    // Archiving must never create or modify the source document.
    await assert.rejects(stat(source), (error) => error.code === 'ENOENT');
    await host.close();
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await rm(base, { recursive: true, force: true });
  }
});

test('docs/archive is idempotent for identical bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mp-archive-idem-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    const host = createHost({ fs: fsStub, log: SILENT_LOG, connectionProvider: provider });
    const payload = { path: join(base, 'a.md'), text: 'SAME', tag: 'stale-draft' };
    const first = await host.dispatch('docs/archive', payload);
    const second = await host.dispatch('docs/archive', payload);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.value.archivePath, first.value.archivePath);
    assert.equal(second.value.idempotent, true);
    await host.close();
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await rm(base, { recursive: true, force: true });
  }
});

test('docs/archive keeps only the newest 20 agent-before copies and leaves other tags alone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mp-archive-retain-'));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    const host = createHost({ fs: fsStub, log: SILENT_LOG, connectionProvider: provider });
    const source = join(base, '秋招笔试', '北交所面试材料.md');
    const dir = join(base, '.markpilot', 'draft-archive');
    const overHttp = await host.dispatch('docs/archive', { path: source, text: 'HTTP', tag: 'agent-before' });
    assert.equal(overHttp.ok, false);
    assert.equal(overHttp.error.code, 'bad-request');
    for (let i = 0; i < 25; i++) {
      const result = await host.dispatch('docs/archive', { path: source, text: 'VERSION-' + i, tag: 'agent-before' }, MODEL_TOOL);
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    const userCopy = await host.dispatch('docs/archive', { path: source, text: 'USER-COPY', tag: 'draft' });
    assert.equal(userCopy.ok, true);
    const names = await readdir(dir);
    const automatic = names.filter((name) => /\.agent-before\.[0-9a-f]{16}\.md$/.test(name));
    assert.equal(automatic.length, 20);
    const textOf = async (name) => readFile(join(dir, name), 'utf8');
    const texts = await Promise.all(automatic.map(textOf));
    assert.equal(texts.includes('VERSION-24'), true);
    assert.equal(texts.includes('VERSION-0'), false);
    assert.equal(names.includes(userCopy.value.archivePath.slice(userCopy.value.archivePath.lastIndexOf('\\') + 1)), true);
    assert.equal(await readFile(userCopy.value.archivePath, 'utf8'), 'USER-COPY');
    await host.close();
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    await rm(base, { recursive: true, force: true });
  }
});

test('docs/archive rejects relative paths and non-string text', async () => {
  const host = createHost({ fs: fsStub, log: SILENT_LOG, connectionProvider: provider });
  const relative = await host.dispatch('docs/archive', { path: 'relative.md', text: 'x' });
  assert.equal(relative.ok, false);
  const notText = await host.dispatch('docs/archive', { path: 'D:/probe/a.md', text: 42 });
  assert.equal(notText.ok, false);
  await host.close();
});
