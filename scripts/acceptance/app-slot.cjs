'use strict';
// Repository-level serial launch gate. Also used by tools/quality/acceptance.cjs.
const { spawn } = require('node:child_process');
const { acquireSlot } = require('../../tools/quality/lifecycle.cjs');
const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift();
if (!argv.length) { console.error('Usage: node scripts/acceptance/app-slot.cjs -- <program> [arguments]'); process.exit(2); }
let release;
try { release = acquireSlot(); } catch (e) { console.error(e.message); process.exit(2); }
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', windowsHide: true });
let released=false;
function finish(code) { if(!released){release();released=true;}process.exitCode=code; }
child.on('error', e => { console.error(e.message); finish(2); });
child.on('exit', code => { finish(code ?? 2); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
