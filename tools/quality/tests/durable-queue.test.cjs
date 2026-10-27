'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..'), queue = path.join(ROOT, 'tools/quality/durable-queue.cjs');
const { hash, read, status, write } = require(queue);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 20000; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(100); } throw Error('Owned queue test timed out'); }
function fixture() {
  const prefix = path.join(ROOT, '.mp-verify/v340/queue-selftest-');
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const dir = fs.mkdtempSync(prefix);
  const script = path.join(dir, 'fixture.cjs'), counter = path.join(dir, 'starts.jsonl');
  fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');const[out,counter,id,delay,fail]=process.argv.slice(2);fs.mkdirSync(out);fs.appendFileSync(counter,JSON.stringify({id,pid:process.pid})+'\\n');setTimeout(()=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:fail!=='1',cleanup:{residual:[]}}));process.exitCode=fail==='1'?17:0;},Number(delay));`);
  return { dir, script, counter, jobs: specs => specs.map(([id, delay, fail]) => ({ id, script, args: ['$OUT', counter, id, String(delay), fail ? '1' : '0'], resultFile: '$OUT/result.json', timeoutMs: 15000 })) };
}
function planFile(f, jobs) {
  const plan = path.join(f.dir, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ schema: 1, cwd: ROOT, inputs: [{ path: f.script, sha256: hash(f.script) }], jobs })); return plan;
}
function start(plan, dir) { return JSON.parse(cp.execFileSync(process.execPath, [queue, 'start', plan, dir], { windowsHide: true, encoding: 'utf8' })); }
test('failed test retains its receipt and the next independent test still runs', async () => {
  const f = fixture(), dir = path.join(f.dir, 'queue'); start(planFile(f, f.jobs([['failure', 25, true], ['next', 25, false]])), dir);
  await until(() => status(dir).status === 'completed-with-failures');
  assert.deepEqual(status(dir).jobs.map(j => j.status), ['failed', 'passed']);
  assert.equal(read(path.join(dir, 'jobs/failure/receipt.json')).exitCode, 17);
});
test('supervisor interruption does not stop the test; resume adopts it exactly once', async () => {
  const f = fixture(), dir = path.join(f.dir, 'queue'), plan = planFile(f, f.jobs([['slow', 4000, false], ['after', 25, false]]));
  const launched = start(plan, dir);
  await until(() => fs.existsSync(f.counter));
  // Only the supervisor created above is stopped. Its independent test wrapper remains.
  process.kill(launched.runnerPid);
  await until(() => !status(dir).runnerAlive);
  start(plan, dir); await until(() => status(dir).status === 'passed');
  const starts = fs.readFileSync(f.counter, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(starts.map(s => s.id), ['slow', 'after']);
  assert.equal(status(dir).jobs.length, 2);
});
test('changed input stops resume without re-running a completed job', async () => {
  const f = fixture(), dir = path.join(f.dir, 'queue'), plan = planFile(f, f.jobs([['once', 25, false]]));
  start(plan, dir); await until(() => status(dir).status === 'passed');
  fs.appendFileSync(f.script, '\n// changed input\n'); start(plan, dir);
  await until(() => status(dir).status === 'attention');
  assert.equal(fs.readFileSync(f.counter, 'utf8').trim().split('\n').length, 1);
  assert.match(status(dir).error, /Input changed/);
});
test('a transient Windows sharing failure preserves and then publishes complete state', {skip:process.platform!=='win32'},()=>{
  const f=fixture(),file=path.join(f.dir,'state.json');fs.writeFileSync(file,JSON.stringify({version:'old'}));
  const original=fs.renameSync;let attempts=0;
  fs.renameSync=function(from,to){if(to===file&&attempts++===0){assert.equal(read(file).version,'old');throw Object.assign(Error('owned sharing collision'),{code:'EPERM'});}return original.apply(this,arguments);};
  try { write(file,{version:'new'}); } finally { fs.renameSync=original; }
  assert.equal(attempts,2);assert.deepEqual(read(file),{version:'new'});assert(!fs.readdirSync(f.dir).some(n=>n.endsWith('.tmp')));
});
test('a permanent publication error retains the previous complete state and reports failure',()=>{
  const f=fixture(),file=path.join(f.dir,'state.json');fs.writeFileSync(file,JSON.stringify({version:'old'}));
  const original=fs.renameSync;
  fs.renameSync=function(from,to){if(to===file)throw Object.assign(Error('owned permanent failure'),{code:'ENOSPC'});return original.apply(this,arguments);};
  try { assert.throws(()=>write(file,{version:'new'}),{code:'ENOSPC'}); } finally { fs.renameSync=original; }
  assert.deepEqual(read(file),{version:'old'});assert(!fs.readdirSync(f.dir).some(n=>n.endsWith('.tmp')));
});
