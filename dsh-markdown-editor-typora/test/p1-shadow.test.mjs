import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHost, MODEL_TOOL } from '../lib/index.js';

function execution(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

function dynamicProvider() {
  let serial = 0;
  return {
    async resolve(value) { return { targetKey: value, displayPath: value }; },
    async stat(value) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      try { const info = await fs.stat(p); return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `v${info.mtimeMs}-${info.size}-${serial}` }; }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async readText(value) { return fs.readFile(typeof value === 'string' ? value : value?.targetKey, 'utf8'); },
    async writeText(value, text, expected) {
      const p = typeof value === 'string' ? value : value?.targetKey;
      const temp = p + '.tmp-' + process.pid + '-' + (++serial);
      await fs.writeFile(temp, text, 'utf8');
      await fs.rename(temp, p);
      serial += 1;
      return { version: `v${Date.now()}-${Buffer.byteLength(text)}-${serial}` };
    },
    async editText() { throw new Error('not used'); },
    async watch() { return async () => {}; },
  };
}

const CORE = ['state', 'source', 'dirty', 'conflict', 'version', 'revisionId', 'orphanDraft', 'external', 'unsavedElsewhere'];

test('P1-G1 30 shadow scenarios: documents.session core equals documents.state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-p1-shadow-'));
  const host = createHost({ fs: dynamicProvider(), log: { warn() {} } });
  try {
    let scenarios = 0;
    for (let index = 0; index < 10; index += 1) {
      const file = path.join(root, `doc-${index}.md`);
      await fs.writeFile(file, `body ${index}\n`, 'utf8');
      const compare = async () => {
        const state = await host.dispatch('documents.state', { path: file }, MODEL_TOOL, execution(root));
        const session = await host.dispatch('documents.session', { path: file });
        assert.equal(session.ok, state.ok, `scenario ${scenarios} ok`);
        if (state.ok) for (const key of CORE) assert.deepEqual(session.value[key], state.value[key], `scenario ${scenarios} ${key}`);
        scenarios += 1;
      };
      await compare();
      const opened = await host.dispatch('open', { path: file });
      const saved = await host.dispatch('save', { path: file, text: `saved ${index}\n`, baseVersion: opened.value.version });
      assert.equal(saved.ok, true);
      await compare();
      await fs.rename(file, file + '-renamed.md');
      await compare();
    }
    assert.equal(scenarios, 30);
    host.close();
  } finally {
    host.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
