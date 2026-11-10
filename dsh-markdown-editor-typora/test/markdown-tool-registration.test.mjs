// The plugin is installed outside the DSH package tree, so the bundled
// @deepseek-ai/dsh-tools is not ESM-resolvable from lib/index.js. The registry
// fallback must still produce a valid JSON-Schema tool and register it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarkdownToolDefinition, createRegistryMarkdownToolDefinition,
  authorSchemaToRegistrySchema, registerMarkdownTool,
} from '../lib/index.js';

const noopDispatch = async () => ({ ok: false, error: { code: 'PROBE', message: 'probe' } });

test('registry fallback converts author required:true into JSON-Schema required arrays', () => {
  const spec = createMarkdownToolDefinition(noopDispatch);
  const def = createRegistryMarkdownToolDefinition(spec);
  assert.equal(def.name, 'markdown');
  assert.equal(def.parameters.type, 'object');
  assert.deepEqual(def.parameters.required, ['action', 'path']);
  assert.equal(def.parameters.properties.action.type, 'string');
  assert.equal(def.parameters.properties.action.required, undefined);
  assert.deepEqual(def.parameters.properties.action.enum, ['read', 'edit', 'blocks']);
  assert.deepEqual(def.output.schema.required, ['ok', 'action']);
  assert.deepEqual(def.output.schema.properties.error.required, ['code', 'message']);
  assert.equal(typeof def.output.render, 'function');
  assert.equal(typeof def.execute, 'function');
  const rendered = def.output.render({ action: 'read' }, {
    ok: true, action: 'read', displayPath: 'D:/a.md', source: 'buffer', dirty: true,
    version: 'rev1:live:e-1:7:' + 'a'.repeat(64), text: 'hi',
  });
  assert.match(rendered[0].text, /rev1:live:e-1:7:/);
  const edited = def.output.render({ action: 'edit' }, {
    ok: true, action: 'edit', displayPath: 'D:/a.md', saved: false,
    checkpointPath: 'C:/archive/before.md', recoveryPath: 'C:/live/recovery/agent-append/after.md',
    version: 'rev1:live:e-1:8:' + 'b'.repeat(64),
  });
  assert.match(edited[0].text, /改前副本：C:\/archive\/before\.md/);
  assert.match(edited[0].text, /恢复副本：C:\/live\/recovery\/agent-append\/after\.md/);
});

test('registerMarkdownTool falls back to tools.register when defineTool is unavailable in this tree', async () => {
  const registered = [];
  const disposers = [];
  const fakeTools = { register(tool) { registered.push(tool); return () => { disposers.push(tool); }; } };
  const fakeSctx = { effect(fn) { const dispose = fn(); return dispose; }, get(name) { return name === 'tools' ? fakeTools : undefined; } };
  const fakeCtx = { inject(deps, cb) { assert.deepEqual(deps, ['tools']); cb(fakeSctx); } };
  const warnings = [];
  const log = { warn(...args) { warnings.push(args.map(String).join(' ')); }, info() {} };
  registerMarkdownTool(fakeCtx, { dispatch: noopDispatch, log });
  const until = Date.now() + 1500;
  while (!registered.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'markdown');
  assert.equal(registered[0].parameters.type, 'object');
  assert.ok(Array.isArray(registered[0].parameters.required));
  // The fallback must not be reported as "tool disabled" when it succeeds.
  assert.equal(warnings.filter((w) => /model tool disabled/.test(w)).length, 0);
});
