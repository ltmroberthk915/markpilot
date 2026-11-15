'use strict';
// Repository-level serial launch gate. Also used by tools/quality/acceptance.cjs.
// It creates one private store root for this slot and passes only that env to
// its child, so legacy probes that spawn an app directly (without lifecycle)
// still get an isolated LOCALAPPDATA/HOME. The root is an acceptance artifact:
// it is not deleted here, and no other run's directory is touched.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireSlot } = require('../../tools/quality/lifecycle.cjs');
const storeIsolation = require('../../tools/quality/store-isolation.cjs');
const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift();
if (!argv.length) { console.error('Usage: node scripts/acceptance/app-slot.cjs -- <program> [arguments]'); process.exit(2); }
let release, isolated;
try {
  release = acquireSlot(ROOT);
  isolated = storeIsolation.createSlotEnv(ROOT);
} catch (e) {
  if (release) { try { release(); } catch { /* the lock is already gone */ } }
  console.error(e.message);
  process.exit(2);
}
const child = spawn(argv[0], argv.slice(1), {
  stdio: 'inherit',
  windowsHide: true,
  env: storeIsolation.mergeEnv(process.env, isolated.env),
});
let released=false;
function finish(code) {
  if(!released){release();released=true;}
  process.exitCode=code;
}
child.on('error', e => { console.error(e.message); finish(2); });
child.on('exit', code => { finish(code ?? 2); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
