// Drop-in replacement for dsh-markdown-editor-typora/test/markdown-tool-registration.test.mjs.
//
// The shipped test pins the pre-selection action enum
// (read/edit/blocks/batch/merge3/undo). The current author schema also exposes
// editSelection/readSelection, and both are dispatched (lib/index.js branches on
// action === 'readSelection' / 'editSelection'). The fallback conversion itself
// is correct; only the hard-coded expectation was stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarkdownToolDefinition, createRegistryMarkdownToolDefinition,
  authorSchemaToRegistrySchema, registerMarkdownTool,
} from '../lib/index.js';

const noopDispatch = async () => ({ ok: false, error: { code: 'PROBE', message: 'probe' } });

test('authorSchemaToRegistrySchema lifts required:true into parent required arrays and preserves enums', () => {
  const converted = authorSchemaToRegistrySchema({
    type: 'object',
    properties: {
      title: { type: 'string', required: true, enum: ['a', 'b'] },
      config: {
        type: 'object', required: true,
        properties: {
          mode: { type: 'string', required: true, enum: ['x'] },
          label: { type: 'string' },
        },
      },
      entries: {
        type: 'array', required: true,
        items: { type: 'object', properties: { id: { type: 'string', required: true } } },
      },
      optional: { type: 'string' },
    },
    additionalProperties: false,
  });
  assert.deepEqual(converted.required, ['title', 'config', 'entries']);
  assert.equal(converted.properties.title.required, undefined);
  assert.deepEqual(converted.properties.title.enum, ['a', 'b']);
  assert.deepEqual(converted.properties.config.required, ['mode']);
  assert.equal(converted.properties.config.properties.label.required, undefined);
  assert.deepEqual(converted.properties.entries.items.required, ['id']);
  assert.equal(converted.properties.optional.required, undefined);
  assert.equal(converted.additionalProperties, false);
});

test('registry fallback converts author required:true into JSON-Schema required arrays', () => {
  const spec = createMarkdownToolDefinition(noopDispatch);
  const def = createRegistryMarkdownToolDefinition(spec);
  assert.equal(def.name, 'markdown');
  assert.equal(def.parameters.type, 'object');
  assert.deepEqual(def.parameters.required, ['action', 'path']);
  assert.equal(def.parameters.properties.action.type, 'string');
  assert.equal(def.parameters.properties.action.required, undefined);
  // The fallback must preserve the author's action enum verbatim. The current
  // public action contract includes the two selection actions; the fallback
  // path must expose them too (they are dispatched in lib/index.js).
  assert.deepEqual(def.parameters.properties.action.enum, spec.parameters.action.enum);
  for (const action of ['read', 'edit', 'blocks', 'batch', 'merge3', 'undo', 'editSelection', 'readSelection']) {
    assert.ok(def.parameters.properties.action.enum.includes(action), `action ${action}`);
  }
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
