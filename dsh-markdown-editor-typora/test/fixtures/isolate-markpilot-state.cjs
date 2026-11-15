'use strict';
// Test-process bootstrap for the two suite entries proven to reach the
// machine-global store: redirect every MarkPilot store path to a fresh
// random temp directory BEFORE any test code runs. Must be the first import
// of the test file (node:test runs each file in its own process).
//
// Covers, without touching product code:
//  - LiveDocuments default directory (%LOCALAPPDATA%\.markpilot\live-v1)
//    used by createHost()/apply() when no liveDocuments option is passed;
//  - the withFileCommit writer-lease store (internal call sites omit the
//    directory argument, so leases land in the default store even for
//    instances built on a temp directory);
//  - the draft-archive root (%LOCALAPPDATA%\.markpilot\draft-archive).
// All of these read process.env lazily at call time, so pinning the env at
// module-eval time is sufficient. Deliberately no env override knob: nothing
// may redirect a test back to the real per-user store.
//
// Cleanup: best-effort rmSync on process exit. A hard kill can leave the dir
// behind; leftovers are confined to %TEMP%\mp-test-state-* and never contain
// or point at user data.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const root = path.join(
  os.tmpdir(),
  'mp-test-state-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'),
);
fs.mkdirSync(root, { recursive: true });
process.env.LOCALAPPDATA = root;
process.on('exit', () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* leave for the OS temp sweeper */ }
});

module.exports = { stateRoot: root };
