'use strict';
// Acceptance-only shared store. Product code is unchanged: the launcher
// redirects LOCALAPPDATA (Windows) / HOME (POSIX) for one child process.
//   <runDir>/.mp-store-<random>/.markpilot/live-v1                  (desktop run)
//   <repo>/.mp-verify/quality-store-<random>/base/.markpilot/...   (app-slot)
// One runDir -> one base, reused by restarts in this process. app-slot passes
// MP_QUALITY_STORE_BASE (strict shape + physical identity); descendants reuse
// it instead of guessing where LOCALAPPDATA came from. Nothing is deleted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const IS_WIN = process.platform === 'win32';
const KEY = IS_WIN ? 'LOCALAPPDATA' : 'HOME';
const HINT = 'MP_QUALITY_STORE_BASE';
const cache = new Map();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function ci(env, name) {
  const found = Object.entries(env || {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!found.length) return undefined;
  if (new Set(found.map(([, value]) => value)).size > 1) fail('MP_STORE_ENV_CONFLICT', 'conflicting case variants for ' + name + ': ' + found.map(([key]) => key).join(', '));
  return { key: found[0][0], value: found[0][1] };
}
function del(env, key) { for (const name of Object.keys(env)) if (name.toLowerCase() === key.toLowerCase()) delete env[name]; }
function same(a, b) { return (IS_WIN ? a.toLowerCase() : a) === (IS_WIN ? b.toLowerCase() : b); }
function under(a, b) { const r = path.relative(a, b); return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); }
function real(dir, label) {
  const p = path.resolve(String(dir || ''));
  let stat;
  try { stat = fs.lstatSync(p); } catch (error) {
    if (error && error.code === 'ENOENT') fail('MP_STORE_UNSAFE', label + ' does not exist: ' + p);
    throw error;
  }
  if (stat.isSymbolicLink()) fail('MP_STORE_UNSAFE', label + ' is a link/junction: ' + p);
  if (!stat.isDirectory()) fail('MP_STORE_UNSAFE', label + ' is not a directory: ' + p);
  const resolved = fs.realpathSync.native(p);
  if (resolved !== p) fail('MP_STORE_UNSAFE', label + ' is not canonical: ' + p + ' -> ' + resolved);
  return resolved;
}
function noLinks(base, target, label) {
  const b = fs.realpathSync.native(base);
  if (!same(b, target) && !under(b, target)) fail('MP_STORE_UNSAFE', label + ' escapes ' + b + ': ' + target);
  let cur = b;
  for (const part of (path.relative(b, target) ? path.relative(b, target).split(path.sep) : [])) {
    cur = path.join(cur, part);
    let stat;
    try { stat = fs.lstatSync(cur); } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('MP_STORE_UNSAFE', label + ' contains a link/junction: ' + cur);
    const resolved = fs.realpathSync.native(cur);
    if (resolved !== cur) fail('MP_STORE_UNSAFE', label + ' is not canonical: ' + cur + ' -> ' + resolved);
  }
}
const A = (() => {
  try { const home = os.userInfo().homedir || os.homedir(); return { home: home ? path.resolve(home) : '' }; }
  catch { return { home: '' }; }
})();
function notStore(target, label) {
  const p = path.resolve(target), roots = [];
  if (A.home) roots.push([A.home, 'home', false], [path.join(A.home, '.markpilot'), 'home .markpilot', true], [path.join(A.home, 'AppData', 'Local', '.markpilot'), 'default .markpilot', true]);
  for (const [root, name, inside] of roots) {
    if (same(p, root)) fail('MP_STORE_UNSAFE', label + ' is the real ' + name + ': ' + p);
    if (under(p, root)) fail('MP_STORE_UNSAFE', label + ' contains the real ' + name + ': ' + p);
    if (inside && under(root, p)) fail('MP_STORE_UNSAFE', label + ' is inside the real ' + name + ': ' + p);
  }
}
function child(base, dir, label) {
  noLinks(base, dir, label);
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) fail('MP_STORE_UNSAFE', label + ' is a link/junction: ' + dir);
    if (!stat.isDirectory()) fail('MP_STORE_UNSAFE', label + ' is not a directory: ' + dir);
  } else fs.mkdirSync(dir);
  noLinks(base, dir, label);
}
function live(root, base) {
  noLinks(root, base, 'store base');
  const meta = path.join(base, '.markpilot');
  child(base, meta, 'live parent');
  const dir = path.join(meta, 'live-v1');
  child(base, dir, 'live directory');
  for (const name of ['rooms.sqlite', 'rooms.sqlite-wal', 'rooms.sqlite-shm', 'rooms.sqlite-journal']) {
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('MP_STORE_UNSAFE', name + ' is not a regular file: ' + file);
    if (stat.nlink !== 1) fail('MP_STORE_UNSAFE', name + ' is hard-linked (nlink=' + stat.nlink + '): ' + file);
    if (!same(fs.realpathSync.native(file), file)) fail('MP_STORE_UNSAFE', name + ' escapes its live directory: ' + file);
  }
  return dir;
}
function explicitBase(run, extraEnv) {
  const found = ci(extraEnv, KEY);
  if (found === undefined) return undefined;
  const value = found.value;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('MP_STORE_UNSAFE', KEY + ' override must be an absolute path');
  const base = path.resolve(value);
  if (path.dirname(base) !== run) fail('MP_STORE_UNSAFE', KEY + ' override must be an independent child of the run directory: ' + base);
  notStore(base, 'explicit store base');
  noLinks(run, base, 'explicit store base');   // reject junction/escape before mkdir
  return { root: base, base };
}
function hintBase() {
  const found = ci(process.env, HINT);
  if (found === undefined) return undefined;
  const value = found.value;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('MP_STORE_UNSAFE', HINT + ' must be absolute');
  const base = path.resolve(value), root = path.dirname(base), parent = path.dirname(root);
  if (path.basename(base) !== 'base' || !/^quality-store-/.test(path.basename(root))) fail('MP_STORE_UNSAFE', HINT + ' has an unexpected shape: ' + base);
  const verify = path.join(ROOT, '.mp-verify');
  if (!same(real(parent, 'hint parent'), real(verify, '.mp-verify'))) fail('MP_STORE_UNSAFE', HINT + ' is outside this repo .mp-verify: ' + base);
  noLinks(verify, base, 'inherited store base');
  return { root: real(root, 'inherited store root'), base: real(base, 'inherited store base') };
}
function prepareStoreEnv(runDir, extraEnv = {}) {
  const run = real(runDir, 'run directory');
  notStore(run, 'run directory');
  const prior = cache.get(run), hint = hintBase(), explicit = explicitBase(run, extraEnv);
  if (hint && explicit && !same(hint.base, explicit.base)) fail('MP_STORE_UNSAFE', 'explicit base conflicts with app-slot hint');
  let chosen = hint || explicit || prior;
  if (prior && chosen && (!same(prior.root, chosen.root) || !same(prior.base, chosen.base))) fail('MP_STORE_UNSAFE', 'run already uses another store base: ' + prior.base);
  if (!chosen) {
    const root = fs.mkdtempSync(path.join(run, '.mp-store-'));
    chosen = { root: real(root, 'store root'), base: real(root, 'store root') };
  }
  if (!fs.existsSync(chosen.base)) { noLinks(run, chosen.base, 'explicit store base'); fs.mkdirSync(chosen.base); }
  const base = real(chosen.base, 'store base');
  noLinks(chosen.root, base, 'store base');
  const dir = live(chosen.root, base);
  cache.set(run, chosen);
  return { env: { [KEY]: base, [HINT]: base }, metadata: { root: chosen.root, base, liveDir: dir, runDir: run } };
}
function createSlotEnv(repo) {
  const realRepo = real(repo, 'repository');
  notStore(realRepo, 'repository');
  const verify = path.join(realRepo, '.mp-verify');
  if (!fs.existsSync(verify)) { noLinks(realRepo, verify, '.mp-verify'); fs.mkdirSync(verify); }
  real(verify, '.mp-verify');
  const root = fs.mkdtempSync(path.join(verify, 'quality-store-'));
  const base = path.join(root, 'base');
  fs.mkdirSync(base);
  const dir = live(root, base);
  return { env: { [KEY]: base, [HINT]: base }, metadata: { root, base, liveDir: dir } };
}
function mergeEnv(...sources) {
  const env = {};
  for (const source of sources) for (const [key, value] of Object.entries(source || {})) { del(env, key); env[key] = value; }
  return env;
}
module.exports = { prepareStoreEnv, createSlotEnv, mergeEnv };
