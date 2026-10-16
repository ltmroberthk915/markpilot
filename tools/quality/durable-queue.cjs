'use strict';
// A local, serial test supervisor. No model calls and no automatic failed-job retry.
// A separate job process owns execution and its receipt, so supervisor interruption
// does not discard a running test or cause duplicate execution after resume.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
function write(file, value) {
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  try {
    for (let attempt = 0;; attempt++) {
      try { fs.renameSync(temp, file); return; }
      catch (error) {
        // Readers/indexers can briefly hold a Windows destination without
        // delete sharing. Keep the old complete state until publication wins.
        if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 25) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}
function event(dir, data) {
  const file = path.join(dir, 'events.jsonl');
  fs.appendFileSync(file, JSON.stringify({ at: stamp(), ...data }) + '\n');
}
function inspectInputs(plan) {
  for (const item of plan.inputs || []) assert.equal(hash(item.path), item.sha256, 'Input changed: ' + item.path);
}
function validate(plan) {
  assert.equal(plan.schema, 1); assert(path.isAbsolute(plan.cwd));
  assert(Array.isArray(plan.jobs) && plan.jobs.length);
  const names = new Set();
  for (const job of plan.jobs) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(job.id) && !names.has(job.id)); names.add(job.id);
    assert(path.isAbsolute(job.script) && fs.statSync(job.script).isFile());
    assert(Array.isArray(job.args));
    // Tests must supply their own cleanup. A timeout is attention, never success.
    assert(!job.timeoutMs || (Number.isFinite(job.timeoutMs) && job.timeoutMs >= 100));
  }
}
function initialize(planFile, dir) {
  if (fs.existsSync(path.join(dir, 'plan.json'))) {
    assert.equal(hash(planFile), read(path.join(dir, 'owner.json')).planSha256, 'Resume requires the identical plan');
    return;
  }
  assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'Queue directory must be new');
  fs.mkdirSync(dir, { recursive: true });
  const plan = read(planFile); validate(plan); inspectInputs(plan);
  fs.copyFileSync(planFile, path.join(dir, 'plan.json'));
  write(path.join(dir, 'owner.json'), { owner: 'markpilot-durable-queue/v1', planSha256: hash(planFile), createdAt: stamp() });
  write(path.join(dir, 'state.json'), { status: 'pending', jobs: plan.jobs.map(job => ({ id: job.id, status: 'pending' })) });
}
function spawnDetached(args, dir, logName) {
  const log = fs.openSync(path.join(dir, logName), 'a');
  try {
    const child = cp.spawn(process.execPath, [__filename, ...args], { cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.unref(); return child.pid;
  } finally { fs.closeSync(log); }
}
async function run(dir) {
  const lock = path.join(dir, 'runner.json'), token = crypto.randomUUID();
  if (fs.existsSync(lock)) { const previous = read(lock); if (alive(previous.pid)) return; }
  // Exclusive claim also prevents two simultaneous resume commands.
  const claim = path.join(dir, 'runner.claim');
  try { fs.mkdirSync(claim); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = path.join(claim, 'owner.json');
    assert(fs.existsSync(holder) && !alive(read(holder).pid), 'Another runner is claiming this queue');
    fs.unlinkSync(holder); fs.rmdirSync(claim); fs.mkdirSync(claim);
  }
  write(path.join(claim, 'owner.json'), { pid: process.pid, token });
  try {
    if (fs.existsSync(lock) && alive(read(lock).pid)) return;
    write(lock, { pid: process.pid, token, startedAt: stamp() });
  } finally { fs.unlinkSync(path.join(claim, 'owner.json')); fs.rmdirSync(claim); }
  const plan = read(path.join(dir, 'plan.json')), stateFile = path.join(dir, 'state.json');
  let state = read(stateFile), heartbeat;
  const save = () => write(stateFile, state);
  try {
    validate(plan); inspectInputs(plan);
    state.status = 'running'; state.runnerPid = process.pid; state.updatedAt = stamp(); save();
    heartbeat = setInterval(() => write(path.join(dir, 'heartbeat.json'), { pid: process.pid, token, at: stamp() }), 1000);
    for (const job of plan.jobs) {
      const item = state.jobs.find(item => item.id === job.id);
      if (['passed', 'failed', 'interrupted', 'attention'].includes(item.status)) continue;
      inspectInputs(plan); // Changing a candidate/probe requires a new plan, not silent reuse.
      const jobDir = path.join(dir, 'jobs', job.id); fs.mkdirSync(jobDir, { recursive: true });
      const receipt = path.join(jobDir, 'receipt.json'), jobLock = path.join(jobDir, 'job.json');
      if (!fs.existsSync(receipt) && !fs.existsSync(jobLock) && item.status === 'pending') {
        item.status = 'starting'; item.startedAt = stamp(); save();
        const pid = spawnDetached(['job', dir, job.id], jobDir, 'wrapper.log');
        item.wrapperPid = pid; event(dir, { type: 'job-start', id: job.id, pid }); save();
        // The PID is durable before waiting. A restart adopts it; it never re-spawns.
      }
      while (!fs.existsSync(receipt)) {
        const pid = fs.existsSync(jobLock) ? read(jobLock).pid : item.wrapperPid;
        if (pid && !alive(pid)) {
          item.status = 'interrupted'; item.error = 'Job exited without a receipt; inspect owned logs before an explicit new attempt'; break;
        }
        if (!pid) { item.status = 'attention'; item.error = 'Uncertain launch outcome; refusing duplicate execution'; break; }
        item.status = 'running'; item.wrapperPid = pid; state.updatedAt = stamp(); save(); await pause(500);
      }
      if (fs.existsSync(receipt)) Object.assign(item, read(receipt));
      event(dir, { type: 'job-result', id: job.id, status: item.status, error: item.error }); save();
      // Ordinary test failures are recorded and the next independent test runs.
      // Uncertain cleanup stops the queue; another GUI must not overlap an orphan.
      if (['interrupted', 'attention'].includes(item.status)) { state.status = 'attention'; break; }
    }
    if (state.status !== 'attention') state.status = state.jobs.every(item => item.status === 'passed') ? 'passed' : 'completed-with-failures';
  } catch (error) { state.status = 'attention'; state.error = error.message; }
  finally {
    clearInterval(heartbeat); state.updatedAt = stamp(); save();
    if (fs.existsSync(lock) && read(lock).token === token) fs.unlinkSync(lock);
  }
}
async function job(dir, id) {
  const plan = read(path.join(dir, 'plan.json')), spec = plan.jobs.find(item => item.id === id); assert(spec);
  inspectInputs(plan);
  const jobDir = path.join(dir, 'jobs', id), lock = path.join(jobDir, 'job.json');
  const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: stamp() })); fs.closeSync(fd);
  const output = path.join(jobDir, 'output'), args = spec.args.map(arg => String(arg).replaceAll('$OUT', output));
  fs.copyFileSync(spec.script, path.join(jobDir, 'probe-executed.cjs'), fs.constants.COPYFILE_EXCL);
  const log = fs.openSync(path.join(jobDir, 'test.log'), 'wx');
  const startedAt = stamp(), scriptSha256 = hash(spec.script); let timer, timedOut = false;
  const child = cp.spawn(process.execPath, [spec.script, ...args], { cwd: plan.cwd, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ...(spec.env || {}) } });
  write(lock, { pid: process.pid, childPid: child.pid, at: startedAt });
  if (spec.timeoutMs) timer = setTimeout(() => {
    timedOut = true;
    // Only this job's known child tree. Never terminate any application by name.
    if (Number.isInteger(child.pid)) {
      if (process.platform === 'win32') cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      else child.kill('SIGTERM');
    }
  }, spec.timeoutMs);
  let spawnError;
  const code = await new Promise(resolve => { child.on('error', e => { spawnError = e.message; resolve(null); }); child.on('exit', resolve); });
  clearTimeout(timer); fs.closeSync(log);
  let result, error = spawnError, cleanupUncertain = false;
  try {
    if (spec.resultFile) {
      result = read(spec.resultFile.replaceAll('$OUT', output));
      if (result.passed !== true) error = result.fatal || result.failure || 'Probe reported a failure';
      if (spec.asarSha256) assert.equal((result.artifact || result.metadata)?.asarSha256, spec.asarSha256, 'Executed ASAR differs');
      if (result.cleanup?.residual?.length || result.cleanupError || result.cleanupErrors?.length) { cleanupUncertain = true; throw Error('Probe cleanup needs attention'); }
    }
  } catch (e) { error = e.message; }
  if (spec.resource === 'gui' && !Array.isArray(result?.cleanup?.residual)) { cleanupUncertain = true; error ||= 'GUI probe has no confirmed cleanup receipt'; }
  const status = timedOut || cleanupUncertain ? 'attention' : code === 0 && !error ? 'passed' : 'failed';
  write(path.join(jobDir, 'receipt.json'), { id, status, startedAt, finishedAt: stamp(), exitCode: code, timedOut, scriptSha256, ...(error ? { error: String(error).slice(0, 1200) } : {}), ...(result?.cases ? { cases: result.cases.length, failures: result.cases.filter(c => c.status !== 'pass').map(c => ({ id: c.id, status: c.status, error: c.error })) } : {}), log: path.join(jobDir, 'test.log'), resultFile: spec.resultFile?.replaceAll('$OUT', output) });
}
function status(dir) {
  const state = read(path.join(dir, 'state.json'));
  const lock = path.join(dir, 'runner.json'), runner = fs.existsSync(lock) ? read(lock) : null;
  return { status: state.status, runnerAlive: !!runner && alive(runner.pid), updatedAt: state.updatedAt, error: state.error, jobs: state.jobs.map(({ id, status, cases, error }) => ({ id, status, cases, error })) };
}
async function main(argv) {
  const [mode, first, second] = argv;
  if (mode === 'start') {
    const dir = path.resolve(second); initialize(path.resolve(first), dir);
    const lock = path.join(dir, 'runner.json');
    if (fs.existsSync(lock) && alive(read(lock).pid)) console.log(JSON.stringify(status(dir)));
    else console.log(JSON.stringify({ started: true, runnerPid: spawnDetached(['run', dir], dir, 'runner.log'), dir }));
  } else if (mode === 'run') await run(path.resolve(first));
  else if (mode === 'job') await job(path.resolve(first), second);
  else if (mode === 'status') console.log(JSON.stringify(status(path.resolve(first))));
  else throw Error('Use start <plan.json> <new-or-existing-queue-dir> | status <queue-dir> | run <queue-dir>');
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main, hash, read, status, write };
