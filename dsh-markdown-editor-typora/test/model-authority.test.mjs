import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHost, createMarkdownToolDefinition } from '../lib/index.js';

test('the markdown model tool respects provider read and edit authority on real local files', async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'markpilot-model-access-'));
  const file = path.join(dir, 'note.md');
  const denied = () => Object.assign(new Error('Access denied by provider'), { code: 'FS_SANDBOX_DENIED' });
  let readable = false, writable = false, visible = 'provider projection';
  const provider = {
    resolve: async () => ({ targetKey: file, displayPath: file }),
    async stat() {
      const s = await fs.stat(file, { bigint: true });
      return { type: 'file', size: Number(s.size), version: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` };
    },
    async readText() { if (!readable) throw denied(); return visible; },
    async writeText() { throw denied(); },
    async editText(target, edit, expected) {
      if (!writable) throw denied();
      assert.equal(expected.version, (await this.stat(target)).version);
      const before = visible;
      visible = visible.replace(edit.oldString, () => edit.newString);
      await fs.writeFile(file, visible);
      return { before, after: visible, version: (await this.stat(target)).version };
    },
  };
  const host = createHost({ fs: provider, log: { warn() {} } });
  const tool = createMarkdownToolDefinition(host.dispatch);
  try {
    await fs.writeFile(file, 'private native bytes');
    await t.test('read denial cannot reveal native bytes', async () => {
      const r = await tool.execute({ action: 'read', path: file });
      assert.equal(r.error?.code, 'FS_SANDBOX_DENIED'); assert.equal(r.text, undefined);
    });
    readable = true;
    await t.test('read returns the provider projection', async () => {
      assert.equal((await tool.execute({ action: 'read', path: file })).text, visible);
    });
    visible = 'private native bytes';
    const edit = { action: 'edit', path: file, oldString: 'native', newString: 'edited' };
    await t.test('edit denial preserves disk and propagates the provider error', async () => {
      const r = await tool.execute(edit);
      assert.equal(r.error?.code, 'FS_SANDBOX_DENIED'); assert.equal(await fs.readFile(file, 'utf8'), visible);
    });
    writable = true;
    await t.test('a subsequent permitted edit uses the provider version guard', async () => {
      const v = (await provider.stat()).version;
      assert((await tool.execute({ ...edit, baseVersion: v })).ok);
      assert.equal(await fs.readFile(file, 'utf8'), 'private edited bytes');
      assert.equal((await tool.execute({ ...edit, baseVersion: v })).error?.code, 'FS_STALE_VERSION');
    });
  } finally { host.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('session policy, working directory and cancellation come from the tool invocation', async () => {
  const session = {header:{cwd:'D:/session'}};
  const policy = {mode:'read-only', workspaceRoot:session.header.cwd};
  const controller = new AbortController();
  const execution = {agent:{session}, signal:controller.signal};
  let edits = 0;
  const provider = {
    sandboxMode:'danger-full-access',
    async resolve(file, opts) {
      assert.equal(opts.cwd, session.header.cwd); assert.equal(opts.signal, controller.signal);
      return {targetKey:path.join(opts.cwd,file),displayPath:path.join(opts.cwd,file)};
    },
    async stat() {return {type:'file',size:6,version:'v1'};},
    async readText() {return 'source';},
    async writeText() {assert.fail('unconditional write');},
    async editText(_target,_edit,expected,signal,actualPolicy) {
      edits++; assert.equal(signal, controller.signal); assert.equal(actualPolicy, policy); assert.equal(expected.version,'v1');
      throw Object.assign(Error('Read-only session'),{code:'FS_SANDBOX_DENIED'});
    },
  };
  const request = {action:'edit',path:'note.md',cwd:'D:/other',oldString:'source',newString:'changed'};
  const host = createHost({fs:provider,log:{warn(){}},sandboxPolicy:()=>({resolve({session:owner}){assert.equal(owner,session);return policy;}})});
  const noPolicy = createHost({fs:provider,log:{warn(){}}});
  try {
    assert.equal((await createMarkdownToolDefinition(host.dispatch).execute(request,execution)).error?.code,'FS_SANDBOX_DENIED');
    assert.equal(edits,0);   // the documents service denies before delegating to the provider
    assert.equal((await createMarkdownToolDefinition(noPolicy.dispatch).execute(request,execution)).error?.code,'FS_SANDBOX_DENIED');
    controller.abort();
    assert.equal((await createMarkdownToolDefinition(host.dispatch).execute(request,execution)).ok,false);
    assert.equal(edits,0);
  } finally {host.close();noPolicy.close();}
});
