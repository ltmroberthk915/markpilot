'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { importOrderIssues, inspect } = require('../preflight.cjs');
const { acquireSlot, args } = require('../lifecycle.cjs');
const { outputDir } = require('../harness.cjs');
const common = path.resolve(__dirname, '../../probes/_probe-common.cjs');
test('shared ruler module loads in a clean process and hashes known bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-quality-unit-'));
  try {
    const file = path.join(dir, 'fixture.txt'); fs.writeFileSync(file, 'abc');
    const script = 'const r=require(process.argv[1]);process.stdout.write(r.sha16(process.argv[2]));';
    const out = execFileSync(process.execPath, ['-e', script, common, file], { env: { ...process.env, MP_WORK: dir }, encoding: 'utf8' });
    assert.equal(out, 'ba7816bf8f01cfea');
    const bad = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).assertExe(process.argv[2], "0000000000000000")', common, file], { env: { ...process.env, MP_WORK: dir }, encoding: 'utf8' });
    assert.equal(bad.status, 9); assert.match(bad.stderr, /sha16|尺子/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('preflight catches the real eager-import failure; lazy closures stay valid', () => {
  assert.equal(importOrderIssues('const p=path.resolve(".");const path=require("node:path");').issues.length, 1);
  assert.equal(importOrderIssues('const f=()=>path.resolve(".");const path=require("node:path");').issues.length, 0);
});
test('all supplied probe sources parse and use initialized portable imports', () => {
  const result = inspect();
  assert.deepEqual(result.syntaxFailures, []);
  assert.deepEqual(result.eagerImportFailures, []);
  assert.deepEqual(result.legacyDependencyPaths, []);
});
test('reverting import-order repair makes the actual shared module fail again', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-mutation-'));
  try {
    const original=fs.readFileSync(common,'utf8');
    const statement="const path = require('node:path');";
    assert(original.includes(statement));
    const mutant=original.replace(statement,'')+'\n'+statement;
    const file=path.join(dir,'mutant.cjs');fs.writeFileSync(file,mutant);
    const run=spawnSync(process.execPath,['-e','require(process.argv[1])',file],{env:{...process.env,MP_WORK:dir},encoding:'utf8'});
    assert.notEqual(run.status,0);assert.match(run.stderr,/Cannot access 'path' before initialization/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('app-slot excludes a second owner and rejects ownership changes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-lock-'));
  try {
    const release=acquireSlot(dir);assert.throws(()=>acquireSlot(dir),/owns the app slot/);
    const file=path.join(dir,'.mp-verify/quality-app-slot.json'),original=fs.readFileSync(file,'utf8');
    fs.writeFileSync(file,JSON.stringify({pid:process.pid,token:'different-owner'}));assert.throws(release,/ownership changed/);assert(fs.existsSync(file));
    fs.writeFileSync(file,original);release();assert(!fs.existsSync(file));
    const next=acquireSlot(dir);next();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('an empty preflight and invalid CLI cannot appear green',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mp-quality-empty-'));
  try {
    fs.mkdirSync(path.join(dir,'tools/probes'),{recursive:true});assert.equal(inspect(dir).ok,false);
    assert.throws(()=>args([]),/launch|Use --exe/);assert.throws(()=>args(['--exe','--out','x']),/Unknown/);
    assert.throws(()=>args(['--exe','a','--electron','b','--app','c']),/one launch mode/);
    fs.writeFileSync(path.join(dir,'protected.txt'),'keep');assert.throws(()=>outputDir(dir),/must be empty/);assert.equal(fs.readFileSync(path.join(dir,'protected.txt'),'utf8'),'keep');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
