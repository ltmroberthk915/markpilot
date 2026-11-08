// dsh-markdown-editor-typora/test/client-save-contention.test.mjs
// public, portable regression for the MP_LIVE_STALE save-path decision (no host, no browser).
//
// Loads the REAL adjacent package `lib/client.js` the same way the web shell does
// (window.__ModuleLoader__.load + factory(require)) and exercises the SINGLE decision
// implementation that runSave uses (`__test.liveStaleAction`), plus the unchanged
// classification of terminal codes (`__test.liveErrorAction`).
//
// Portable: discovers the package root by walking up from this file for lib/client.js;
// no personal/temp paths, no full host, no browser. True two-page browser verification
// remains a manual/real-machine step.
//
// Run: node --test test/client-save-contention.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'lib', 'client.js'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cannot locate package root (lib/client.js) from ' + start);
}

/** Load the real client module exactly like the web shell: __ModuleLoader__.load({id, factory}). */
async function loadRealClient() {
  const root = findPackageRoot(HERE);
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load(module) { captured = module; } },
  };
  await import(pathToFileURL(join(root, 'lib', 'client.js')).href);
  assert.ok(captured && typeof captured.factory === 'function', 'client.js must register via __ModuleLoader__');
  const exports_ = captured.factory((id) => {
    if (id === 'react') return null;   // components never render in this test
    throw new Error('unexpected require: ' + id);
  });
  assert.ok(exports_.__test, '__test surface present');
  return { root, exports_, t: exports_.__test };
}

const { t } = await loadRealClient();

// Mirrors runSave's loop semantics (single decision implementation is the real liveStaleAction):
// one episode = one runSave call: attempt increments within it; retry-delayed ends the episode
// and a new episode starts (scheduleSave → runSave with attempt reset); blocked at entry = 0 requests.
function driveStaleLoop(t, maxRequests, state) {
  let rounds = state.rounds || 0;
  let blocked = state.blocked || false;
  let requests = 0;
  let delayed = 0;
  let stopped = false;
  while (requests < maxRequests && !blocked) {
    let attempt = 0;
    for (;;) {
      if (blocked || requests >= maxRequests) break;
      attempt += 1;
      requests += 1;
      const decision = t.liveStaleAction({ attempt, rounds, blocked });
      rounds = decision.rounds;
      if (decision.action === 'retry-immediate') continue;
      if (decision.action === 'retry-delayed') { delayed += 1; break; }
      if (decision.action === 'stopped') { stopped = true; blocked = !!decision.blocked; break; }
    }
  }
  return { requests, delayed, stopped, blocked, rounds };
}

test('fast retries: first two attempts continue immediately, third decides', () => {
  assert.equal(t.liveStaleAction({ attempt: 1, rounds: 0, blocked: false }).action, 'retry-immediate');
  assert.equal(t.liveStaleAction({ attempt: 2, rounds: 0, blocked: false }).action, 'retry-immediate');
  const third = t.liveStaleAction({ attempt: 3, rounds: 0, blocked: false });
  assert.equal(third.action, 'retry-delayed');
  assert.equal(third.delayMs, 2000);
  assert.equal(third.rounds, 1);
});

test('bounded delayed: at most 3 backoff rounds, each +2s, then stopped', () => {
  assert.deepEqual(t.liveStaleAction({ attempt: 3, rounds: 1, blocked: false }), { action: 'retry-delayed', rounds: 2, delayMs: 2000 });
  assert.deepEqual(t.liveStaleAction({ attempt: 3, rounds: 2, blocked: false }), { action: 'retry-delayed', rounds: 3, delayMs: 2000 });
  assert.deepEqual(t.liveStaleAction({ attempt: 3, rounds: 3, blocked: false }), { action: 'stopped', rounds: 3, blocked: true });
});

test('exhaustion: no background wake — auto episodes issue 0 requests; manual retry clears budget', () => {
  const first = driveStaleLoop(t, 100, {});
  assert.equal(first.requests, 12, '4 episodes x 3 requests = 12 before stop');
  assert.equal(first.delayed, 3);
  assert.equal(first.stopped, true);
  assert.equal(first.blocked, true);
  const resumed = driveStaleLoop(t, 100, { rounds: first.rounds, blocked: first.blocked });
  assert.equal(resumed.requests, 0, 'blocked auto runs must not send save requests');
  const manual = t.liveStaleAction({ attempt: 1, rounds: first.rounds, blocked: true, manual: true });
  assert.deepEqual(manual, { action: 'retry-now', rounds: 0, blocked: false }, 'explicit save resets budget');
  const second = driveStaleLoop(t, 100, { rounds: manual.rounds, blocked: manual.blocked });
  assert.equal(second.requests, 12, 'second episode is bounded identically');
  assert.equal(second.stopped, true);
});

test('blocked decision is a second defense even if invoked directly', () => {
  assert.equal(t.liveStaleAction({ attempt: 1, rounds: 0, blocked: true }).action, 'stopped');
  assert.equal(t.liveStaleAction({ attempt: 3, rounds: 3, blocked: true }).action, 'stopped');
});

test('terminal codes stay terminal: session/conflict/disk/file conflicts keep conflict semantics', () => {
  for (const code of ['MP_LIVE_LEASE', 'MP_LIVE_SESSION', 'MP_LIVE_CLOSED', 'MP_LIVE_CONFLICT', 'MP_LIVE_CHANGE',
    'MP_LIVE_UNREACHABLE', 'MP_DOC_MISMATCH', 'MP_FILE_CONFLICT', 'MP_LIVE_STALE']) {
    assert.equal(t.liveErrorAction(code), 'conflict', code);
  }
  assert.equal(t.liveErrorAction('MP_LIVE_FACADE_MISSING'), 'unsupported');
  assert.equal(t.liveErrorAction('MP_LIVE_TRANSPORT'), 'notice');
  assert.equal(t.liveErrorAction(undefined), 'notice');
});

test('decision is pure: inputs frozen-unmodified and no ticket/epoch fields emitted', () => {
  const state = Object.freeze({ attempt: 3, rounds: 3, blocked: false });
  const before = JSON.stringify(state);
  const decision = t.liveStaleAction(state);
  assert.equal(JSON.stringify(state), before, 'input must not be mutated');
  assert.equal(decision.action, 'stopped');
  assert.equal('client' in decision, false);
  assert.equal('epoch' in decision, false);
  assert.equal('version' in decision, false);
  const src = readFileSync(join(findPackageRoot(HERE), 'lib', 'client.js'), 'utf8');
  const body = src.slice(src.indexOf('function liveStaleAction'), src.indexOf('function liveStaleAction') + 900);
  assert.doesNotMatch(body, /doc\.|\.client\s*=|\.epoch\s*=|\.version\s*=/, 'decision must not touch live ticket/draft state');
});
