'use strict';
// Local editor hosts share an ordered log, not an editing lock. The disk-write
// reservation is separate: a peer can keep typing while another window saves.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');
const {decodeDocument} = require('./text-codec');

const fault = (code, message) => Object.assign(new Error(message), {code});
const conflict = message => fault('MP_FILE_CONFLICT', message);
const uuid = () => crypto.randomUUID();
const databases = new Map();
const reservations = new AsyncLocalStorage();
const hosts = new Set();            // 本代（本模块实例）仍有协同成员的 host；join 成功登记，leave 清空即除名
let storageOperations = 0;          // 在途文件租约操作数（join/save/external/refresh），兼防在途 join 注册前窗口
const defaultDirectory = () => path.join(process.platform === 'win32' && process.env.LOCALAPPDATA || os.homedir(), '.markpilot', 'live-v1');
const fileKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function database(directory) {
  const location = path.resolve(directory);
  if (databases.has(location)) return databases.get(location);
  // Load lazily: startup and non-local providers do not need this facility.
  const {DatabaseSync} = require('node:sqlite');
  fs.mkdirSync(location, {recursive:true, mode:0o700});
  const filename = path.join(location, 'rooms.sqlite');
  const db = new DatabaseSync(filename);
  if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  try {
    db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (
        file TEXT PRIMARY KEY, epoch TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, saved INTEGER NOT NULL,
        disk TEXT NOT NULL, length INTEGER NOT NULL, floor INTEGER NOT NULL, checkpoint BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, epoch TEXT NOT NULL REFERENCES rooms(epoch) ON DELETE CASCADE,
        pid INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_clients ON clients(epoch);
      CREATE TABLE IF NOT EXISTS changes (
        epoch TEXT NOT NULL REFERENCES rooms(epoch) ON DELETE CASCADE, version INTEGER NOT NULL,
        client TEXT NOT NULL, seq INTEGER NOT NULL, delta TEXT NOT NULL, group_id TEXT, PRIMARY KEY(epoch,version));
      CREATE TABLE IF NOT EXISTS recovery (
        source TEXT NOT NULL, recoveryPath TEXT PRIMARY KEY, epoch TEXT NOT NULL,
        version INTEGER NOT NULL, saved INTEGER NOT NULL, at INTEGER NOT NULL,
        bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS append_recovery (
        source TEXT NOT NULL, recoveryPath TEXT PRIMARY KEY, epoch TEXT NOT NULL,
        version INTEGER NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS append_recovery_source ON append_recovery(source, at DESC);
      CREATE TABLE IF NOT EXISTS agent_group (
        group_id TEXT PRIMARY KEY, source TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
        base_revision TEXT, result_revision TEXT, at INTEGER NOT NULL,
        changes TEXT, undone_at INTEGER);
      CREATE INDEX IF NOT EXISTS agent_group_source ON agent_group(source, at DESC);
      CREATE TABLE IF NOT EXISTS room_resolved (
        epoch TEXT PRIMARY KEY REFERENCES rooms(epoch) ON DELETE CASCADE,
        disk TEXT NOT NULL, resolved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS draft_index (
        source TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('file','untitled')),
        text TEXT NOT NULL,
        text_sha TEXT NOT NULL CHECK (length(text_sha)=64),
        bytes INTEGER NOT NULL CHECK (bytes>=0 AND bytes<=8388608),
        base_version TEXT NOT NULL,
        base_sha256 TEXT NOT NULL CHECK (length(base_sha256)=0 OR length(base_sha256)=64),
        doc_token TEXT NOT NULL CHECK (length(doc_token) BETWEEN 1 AND 128),
        session TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (length(source) BETWEEN 1 AND 8192),
        CHECK (updated_at >= created_at),
        CHECK ((kind='file' AND base_version<>'' AND length(base_sha256)=64)
            OR (kind='untitled' AND base_version='' AND base_sha256='')));
      CREATE INDEX IF NOT EXISTS draft_index_updated ON draft_index(updated_at DESC);
      CREATE TABLE IF NOT EXISTS writers (file TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, since INTEGER NOT NULL);`);
    // Rooms kept by an earlier draft release held leases without timestamps.
    if (!db.prepare('PRAGMA table_info(writers)').all().some(column => column.name === 'since'))
      db.exec('DROP TABLE writers; CREATE TABLE writers (file TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, since INTEGER NOT NULL);');
    const groupColumns = db.prepare('PRAGMA table_info(agent_group)').all().map((column) => column.name);
    if (!groupColumns.includes('changes')) db.exec('ALTER TABLE agent_group ADD COLUMN changes TEXT');
    if (!groupColumns.includes('undone_at')) db.exec('ALTER TABLE agent_group ADD COLUMN undone_at INTEGER');
    if (!db.prepare('PRAGMA table_info(changes)').all().some((column) => column.name === 'group_id'))
      db.exec('ALTER TABLE changes ADD COLUMN group_id TEXT');
    // The rooms store is per machine and account. A database carried here from
    // another device or profile (synced or copied LOCALAPPDATA) must not seat
    // stale authority over files it has never seen on this host.
    const stamp = hostStamp(), stored = db.prepare("SELECT value FROM meta WHERE key='host'").get();
    if (stored && stored.value !== stamp)
      atomic(db, () => {
        db.exec('DELETE FROM writers; DELETE FROM changes; DELETE FROM clients; DELETE FROM rooms; DELETE FROM append_recovery; DELETE FROM draft_index;');
        db.prepare("INSERT OR REPLACE INTO meta VALUES('host',?)").run(stamp);
      });
    else if (!stored) atomic(db, () => db.prepare("INSERT OR REPLACE INTO meta VALUES('host',?)").run(stamp));
  } catch (error) { db.close(); throw error; }
  databases.set(location, db);
  return db;
}
function hostStamp() {
  let machine = '', account = '';
  try { machine = os.hostname(); } catch {}
  try { account = os.userInfo().username; } catch {}
  return machine.toLowerCase() + '\n' + account;
}
// True only for an existing store created by this host. Used by B3 before a
// write-side open: database() deliberately clears a foreign store on first
// use, and an agent's append must never be the reason that happens.
function localStoreUsable(filename) {
  if (!fs.existsSync(filename)) return false;
  let db;
  try {
    const {DatabaseSync} = require('node:sqlite');
    db = new DatabaseSync(filename, {readOnly:true});
    try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
    const stored = db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value;
    if (stored !== hostStamp()) return false;
    db.prepare('SELECT 1 FROM rooms LIMIT 1').get();
    return true;
  } catch { return false; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const DRAFT_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRows: 512,
  maxTotalBytes: 128 * 1024 * 1024,
  ttlMs: 14 * 24 * 60 * 60 * 1000,
});
function normalizedDraftText(text) { return String(text).replace(/\r\n?/g, '\n'); }
function validateDraftText(text) {
  if (text.includes('\u0000')) throw fault('MP_DRAFT_INVALID', '草稿含 NUL，不能进入镜像索引');
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw fault('MP_DRAFT_INVALID', '草稿含不完整 Unicode 字符');
    } else if (c >= 0xdc00 && c <= 0xdfff) throw fault('MP_DRAFT_INVALID', '草稿含不完整 Unicode 字符');
  }
}
function validateDraftLimits(limits) {
  for (const key of ['maxBytes', 'maxRows', 'maxTotalBytes', 'ttlMs']) {
    const value = limits[key];
    if (!Number.isFinite(value) || value <= 0) throw fault('MP_DRAFT_INVALID', '无效的草稿索引上限：' + key);
  }
  for (const key of ['maxBytes', 'maxRows', 'maxTotalBytes']) if (!Number.isSafeInteger(limits[key]))
    throw fault('MP_DRAFT_INVALID', '草稿索引上限必须是整数：' + key);
  if (limits.maxBytes > DRAFT_LIMITS.maxBytes)
    throw fault('MP_DRAFT_INVALID', '单条草稿上限不能超过 8 MiB');
  return limits;
}
function draftSessionValue(session) {
  if (session === null || session === undefined) return null;
  if (typeof session === 'string') return session;
  if (typeof session === 'object') return JSON.stringify(session);
  throw fault('MP_DRAFT_INVALID', '无效的编辑器会话');
}
function draftSessionRead(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function draftSha(text) { return digest(Buffer.from(text, 'utf8')); }
function draftBytes(text) { return Buffer.byteLength(text, 'utf8'); }
function draftStoreFile(directory) { return path.join(path.resolve(directory), 'rooms.sqlite'); }
function draftStoreReadable(directory) {
  const filename = draftStoreFile(directory);
  if (!fs.existsSync(filename) || !localStoreUsable(filename)) return null;
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(filename, {readOnly:true});
  try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
  return db;
}
function draftTableMissing(error) {
  return !!error && /no such table:\s*draft_index/i.test(String(error.message || ''));
}

// Abnormal exits (crash, kill, power loss) leave client rows behind and, with
// them, rooms whose last member never said goodbye. Clean orphans are plain
// garbage; dirty orphans may hold the only surviving copy of an unsaved draft,
// so they are parked as locatable recovery files before the room is retired.
// Each pass retires at most RECOVERY_BATCH rooms and leaves every other
// room's dead client rows in place, so unprocessed orphans stay discoverable
// by the next pass instead of hanging forever. Parked recovery files are
// never removed by housekeeping: an unacknowledged user draft must not be
// silently destroyed; only the recovery index is capped.
const sweptLocations = new Set(), RECOVERY_BATCH = 4, RECOVERY_ROWS = 500;
// Agent appends do not write disk; a 10s ceiling keeps an AI tool call from
// waiting the full 30s save lease while a slow external save is in flight.
const APPEND_BUSY_TIMEOUT_MS = 10000;
// B3.2: independent post-append copies live apart from the room log, so an
// editor close/old-EXE room deletion cannot drop the only copy of an agent
// edit that was not acknowledged yet. Bounded per source; never touches the
// parked recovery files below `recovery/`.
const APPEND_RECOVERY_KEEP = 20;
const APPEND_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;
function safeStem(file) {
  return path.basename(file).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'document';
}
function appendRecoveryStem(file) {
  return safeStem(file) + '.' + digest(fileKey(file)).slice(0, 8);
}
function appendRecoveryDirectory(directory) {
  return path.join(path.resolve(directory), 'recovery', 'agent-append');
}
function appendRecoveryPath(directory, file, epoch, version, bytes) {
  const epochPart = String(epoch).replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) || 'epoch';
  const sha = digest(bytes);
  return path.join(appendRecoveryDirectory(directory),
    appendRecoveryStem(file) + '.' + epochPart + '.agent-append.' + version + '.' + sha.slice(0, 16) + '.md');
}
function writeAtomicSync(target, bytes) {
  const temp = target + '.tmp-' + process.pid + '-' + uuid();
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      // A retry may find the deterministic copy already published. Accept only
      // byte-identical content; never overwrite a different copy.
      let existing = null;
      try { existing = fs.readFileSync(target); } catch { /* publish error is reported below */ }
      if (!existing || !existing.equals(bytes)) throw error;
    }
  } finally {
    try { fs.rmSync(temp, {force: true}); } catch { /* best effort */ }
  }
}
function writeReplaceDurableSync(target, bytes) {
  const temp = target + '.tmp-' + process.pid + '-' + uuid();
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, target); }
    catch (error) {
      try { fs.rmSync(target, {force: true}); } catch { /* best effort */ }
      fs.renameSync(temp, target);
    }
  } finally {
    try { fs.rmSync(temp, {force: true}); } catch { /* best effort */ }
  }
}
// Caller holds the SQLite write transaction (BEGIN IMMEDIATE), so exchange()
// and another append cannot advance the room while the copy is written. Kept
// synchronous deliberately: the copy must be durable before COMMIT.
function writeAppendRecoverySync(directory, file, epoch, version, text) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length > APPEND_RECOVERY_MAX_BYTES) throw fault('MP_RECOVERY_TOO_LARGE', '文档过大，无法为本次 AI 编辑创建恢复副本');
  const dir = appendRecoveryDirectory(directory);
  const target = appendRecoveryPath(directory, file, epoch, version, bytes), metaPath = target + '.json';
  const sha = digest(bytes);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  let createdTarget = false;
  try {
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (!existing.equals(bytes)) throw fault('MP_RECOVERY_FAILED', '恢复副本命名冲突，已拒绝写入');
    } else {
      writeAtomicSync(target, bytes);
      createdTarget = true;
    }
    const meta = {
      schema: 1, kind: 'agent-append', sourcePath: file, epoch: String(epoch),
      version, at: Date.now(), bytes: bytes.length, sha256: sha, textLength: String(text).length,
    };
    writeReplaceDurableSync(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    const check = fs.readFileSync(target);
    if (!check.equals(bytes)) throw fault('MP_RECOVERY_FAILED', '恢复副本复核失败，已拒绝提交');
    const back = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (back?.sha256 !== sha || back?.kind !== 'agent-append') throw fault('MP_RECOVERY_FAILED', '恢复副本元数据复核失败，已拒绝提交');
    return {path: target, created: createdTarget, bytes: bytes.length, sha256: sha, at: back.at};
  } catch (error) {
    // Never delete a pre-existing valid copy because this attempt's sidecar
    // write failed. Only the file created by this attempt is ours to remove.
    if (createdTarget) {
      try { fs.rmSync(target, {force: true}); } catch { /* best effort */ }
      try { fs.rmSync(metaPath, {force: true}); } catch { /* best effort */ }
    }
    if (error?.code === 'MP_RECOVERY_TOO_LARGE' || error?.code === 'MP_RECOVERY_FAILED') throw error;
    throw fault('MP_RECOVERY_FAILED', '恢复副本写入失败：' + String(error?.message || error));
  }
}
function appendRecoveryRows(db, key) {
  return db.prepare('SELECT recoveryPath,sha256,at,epoch,version,bytes FROM append_recovery WHERE source=? ORDER BY at DESC, version DESC LIMIT ?')
    .all(key, APPEND_RECOVERY_KEEP);
}
function listAppendRecoveryRows(db, key) {
  const out = [];
  for (const row of appendRecoveryRows(db, key)) {
    try {
      const bytes = fs.readFileSync(row.recoveryPath);
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) continue;
      out.push({ recoveryPath: row.recoveryPath, sha256: row.sha256, at: Number(row.at) || 0,
        epoch: String(row.epoch || ''), version: Number(row.version) || 0, bytes: bytes.length, kind: 'agent-append' });
    } catch { /* missing/damaged file: no path to hand to the user */ }
  }
  return out;
}
function pruneAppendRecoveryRows(db, key, currentPath) {
  const rows = db.prepare('SELECT recoveryPath,sha256,at,epoch,version,bytes FROM append_recovery WHERE source=? ORDER BY at DESC, version DESC')
    .all(key);
  for (const extra of rows.slice(APPEND_RECOVERY_KEEP)) {
    if (currentPath && extra.recoveryPath === currentPath) continue;
    try { db.prepare('DELETE FROM append_recovery WHERE recoveryPath=?').run(extra.recoveryPath); } catch { /* best effort */ }
    try { fs.rmSync(extra.recoveryPath, {force: true}); } catch { /* locked/raced: leave it */ }
    try { fs.rmSync(extra.recoveryPath + '.json', {force: true}); } catch { /* locked/raced: leave it */ }
  }
}
function recoveryFile(directory, room) {
  const name = path.basename(room.file).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'document';
  return path.join(path.resolve(directory), 'recovery',
    name + '.' + digest(fileKey(room.file)).slice(0, 8) + '.' + room.epoch.slice(0, 8) + '.md');
}
function orphanCandidates(db) {
  const out = [];
  for (const {epoch} of db.prepare('SELECT epoch FROM rooms').all()) {
    const clients = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(epoch);
    if (clients.some(({pid}) => alive(pid))) continue; // live session, untouched
    const room = db.prepare('SELECT file,epoch,version,saved FROM rooms WHERE epoch=?').get(epoch);
    if (room) out.push(room);
    if (out.length >= RECOVERY_BATCH) break;
  }
  return out;
}
function retireClean(db, room) {
  atomic(db, () => {
    const clients = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch);
    if (clients.some(({pid}) => alive(pid))) return false;
    const now = db.prepare('SELECT version,saved FROM rooms WHERE epoch=?').get(room.epoch);
    if (!now || now.version !== room.version || now.saved !== room.saved) return false;
    db.prepare('DELETE FROM clients WHERE epoch=?').run(room.epoch);
    db.prepare('DELETE FROM rooms WHERE epoch=?').run(room.epoch);
    return true;
  });
}
// Parks a dirty orphan's draft, then retires the room. Every failure path
// (write error, readback mismatch, session revival, room advanced) leaves
// the room exactly as it was — the draft is never dropped without a copy.
async function parkRecovery(db, directory, room) {
  let target, bytes;
  try {
    const live = roomFor(db, room.file);
    if (!live || live.epoch !== room.epoch || live.version !== room.version || live.saved !== room.saved) return null;
    bytes = Buffer.from(materialize(db, live), 'utf8');
    target = recoveryFile(directory, room);
    await fsp.mkdir(path.dirname(target), {recursive:true});
    await fsp.writeFile(target, bytes);
    if (Buffer.compare(Buffer.from(await fsp.readFile(target)), bytes) !== 0) return null; // 校验失败：房间保留
  } catch (error) { return null; } // 恢复文件写不进：房间保留，绝不丢唯一草稿
  let done = false;
  atomic(db, () => {
    const clients = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch);
    if (clients.some(({pid}) => alive(pid))) return; // 同路径会话复活：不动
    const now = db.prepare('SELECT version,saved FROM rooms WHERE epoch=?').get(room.epoch);
    if (!now || now.version !== room.version || now.saved !== room.saved) return;
    db.prepare('INSERT OR REPLACE INTO recovery VALUES(?,?,?,?,?,?,?,?)')
      .run(fileKey(room.file), target, room.epoch, room.version, room.saved, Date.now(), bytes.length, digest(bytes));
    db.prepare('DELETE FROM clients WHERE epoch=?').run(room.epoch);
    db.prepare('DELETE FROM rooms WHERE epoch=?').run(room.epoch);
    // Cap only the index. Parked files stay on disk until the user acts.
    const rows = db.prepare('SELECT recoveryPath FROM recovery ORDER BY at DESC').all();
    for (const row of rows.slice(RECOVERY_ROWS)) db.prepare('DELETE FROM recovery WHERE recoveryPath=?').run(row.recoveryPath);
    done = true;
  });
  return done ? target : null;
}
async function sweepOrphans(db, directory) {
  const location = path.resolve(directory);
  if (sweptLocations.has(location)) return;
  sweptLocations.add(location);
  try {
    for (const room of orphanCandidates(db)) {
      if (room.version === room.saved) retireClean(db, room);
      else await parkRecovery(db, directory, room);
    }
  } catch (error) { /* housekeeping must never break a join or a write */ }
}

function atomic(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
// Read-only consistency wrapper: checkpoint and changes must be read in one
// transaction so a cross-process writer cannot land between the two queries.
// BEGIN (deferred) never takes the write lock.
function readTx(db, action) {
  db.exec('BEGIN');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw error; }
}
function alive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Serializes only cooperating file writers, across Electron and DSH processes.
// Reentrant for the DocumentStore commit inside the same scoped save. A lease
// is only ever reclaimed from a holder whose process no longer answers pid
// probes; a living but slow or suspended holder makes callers time out with
// MP_SAVE_BUSY instead. Refusing to write is always safe — a second
// concurrent writer never is — so lease age alone never deposes a holder,
// and a recycled pid is bounded by the busy timeout, not by stealing.
async function withFileCommit(file, action, directory = defaultDirectory(), options = {}) {
  storageOperations++;
  try {
  const canonical = await canonicalFile(file);
  const key = fileKey(canonical), id = path.resolve(directory) + '\n' + key;
  const inherited = reservations.getStore();
  if (inherited?.active && inherited.id === id) return action();
  const db = database(directory), token = uuid();
  const until = Date.now() + (options.busyTimeoutMs ?? 30000);
  for (;;) {
    const got = atomic(db, () => {
      const row = db.prepare('SELECT owner,pid FROM writers WHERE file=?').get(key);
      if (row && alive(row.pid)) return false;
      if (row) db.prepare('DELETE FROM writers WHERE file=? AND owner=?').run(key, row.owner);
      db.prepare('INSERT INTO writers VALUES(?,?,?,?)').run(key, token, process.pid, Date.now());
      return true;
    });
    if (got) break;
    if (Date.now() >= until) throw fault('MP_SAVE_BUSY', '其他窗口仍在保存，修改已保留，请稍后重试');
    await pause(20);
  }
  const scope = {id, active:true};
  try { return await reservations.run(scope, action); }
  finally { scope.active = false; db.prepare('DELETE FROM writers WHERE file=? AND owner=?').run(key, token); }
  } finally { storageOperations--; }
}

async function canonicalFile(file) {
  const absolute = path.resolve(file);
  try { return await fsp.realpath(absolute); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Missing target or missing ancestors: resolve from the closest existing
  // ancestor and join the remaining tail back — a Save As into a brand-new
  // nested directory keeps one canonical identity for the lease and the room,
  // exactly like DocumentStore.canonical has always granted such targets.
  // Existing ancestors still resolve through realpath, so symlinked path
  // segments keep the alias-collapsing identity they have today.
  let parent = path.dirname(absolute), tail = [path.basename(absolute)];
  for (;;) {
    try { return path.join(await fsp.realpath(parent), ...tail); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) return absolute;
      tail.unshift(path.basename(parent));
      parent = next;
    }
  }
}
async function readDisk(file) {
  // Same stable inode/byte checks and decoder as opening a desktop document.
  // A vanished source surfaces as the store's friendly missing-file failure,
  // never as a raw ENOENT bubbling into the GUI.
  const {DocumentStore} = require('./document-store');
  let snap;
  try { snap = await new DocumentStore().snapshot(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw fault('MP_FILE_MISSING', '原文件已不在磁盘上（可能被重命名或删除），草稿已保留：' + file);
    throw error;
  }
  const decoded = decodeDocument(snap.bytes, file).text.replace(/\r\n?/g, '\n');
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* stat is advisory only */ }
  return {hash:snap.baseline.sha256, text:decoded, textSha256:digest(Buffer.from(decoded, 'utf8')), mtimeMs};
}
function checkedLength(changes, length) {
  if (!Array.isArray(changes) || !changes.length) throw fault('MP_LIVE_CHANGE', '无效的协同编辑');
  let end = 0, result = length;
  for (const part of changes) {
    if (!part || !Number.isSafeInteger(part.from) || !Number.isSafeInteger(part.to) ||
        part.from < end || part.to < part.from || part.to > length || typeof part.insert !== 'string' || part.insert.includes('\r'))
      throw fault('MP_LIVE_CHANGE', '协同编辑的位置或内容无效');
    end = part.to;
    result += part.insert.length - (part.to - part.from);
  }
  return result;
}
function apply(text, changes) {
  let end = 0;
  const parts = [];
  for (const change of changes) { parts.push(text.slice(end, change.from), change.insert); end = change.to; }
  parts.push(text.slice(end));
  return parts.join('');
}
function materialize(db, room, version = room.version) {
  let text = Buffer.from(db.prepare('SELECT checkpoint FROM rooms WHERE epoch=?').get(room.epoch).checkpoint).toString('utf16le');
  for (const row of db.prepare('SELECT delta FROM changes WHERE epoch=? AND version<=? ORDER BY version').iterate(room.epoch, version))
    text = apply(text, JSON.parse(row.delta));
  return text;
}
const roomColumns = 'file,epoch,version,saved,disk,length,floor';
function roomFor(db, file) { return db.prepare('SELECT '+roomColumns+' FROM rooms WHERE file=?').get(file); }
function head(room) { return {epoch:room.epoch,version:room.version,savedVersion:room.saved,diskHash:room.disk}; }
function updateRoom(db, room, client, seq, changes) {
  const length = checkedLength(changes, room.length), version = room.version + 1;
  db.prepare('INSERT INTO changes(epoch,version,client,seq,delta,group_id) VALUES(?,?,?,?,?,NULL)').run(room.epoch, version, client, seq, JSON.stringify(changes));
  db.prepare('UPDATE rooms SET version=?,length=? WHERE epoch=?').run(version, length, room.epoch);
  room.version = version; room.length = length;
}
function compact(db, room) {
  // Large documents pay megabytes per checkpoint rewrite; compact them less
  // eagerly so sustained typing never triggers repeated full-document churn.
  const span = room.length > 1000000 ? 512 : 128;
  if (room.version - room.floor < span) return;
  for (const lease of db.prepare('SELECT id,pid FROM clients WHERE epoch=?').all(room.epoch))
    if (!alive(lease.pid)) db.prepare('DELETE FROM clients WHERE id=?').run(lease.id);
  const floor = db.prepare('SELECT MIN(ack) AS v FROM clients WHERE epoch=?').get(room.epoch).v ?? room.version;
  if (floor - room.floor < span) return;
  const text = materialize(db, room, floor);
  db.prepare('UPDATE rooms SET floor=?,checkpoint=? WHERE epoch=?').run(floor, Buffer.from(text,'utf16le'), room.epoch);
  db.prepare('DELETE FROM changes WHERE epoch=? AND version<=?').run(room.epoch, floor);
}
function adoptDisk(db, room, disk, force = false) {
  if (room.disk === disk.hash) return;
  const current = materialize(db, room);
  if (current !== disk.text) {
    // A draft that diverges from the new disk text is a genuine both-changed
    // conflict — unless the external writer landed this very draft, which the
    // equality check above already turned into a save. `force` is only used by
    // the user-confirmed "重新加载磁盘版本" (discard) path.
    if (room.version !== room.saved && !force) throw conflict('原文件和未保存的协同草稿均已改变，请另存草稿或重新载入');
    let from = 0, end = current.length, nextEnd = disk.text.length;
    while (from < end && from < nextEnd && current.charCodeAt(from) === disk.text.charCodeAt(from)) from++;
    while (end > from && nextEnd > from && current.charCodeAt(end-1) === disk.text.charCodeAt(nextEnd-1)) { end--; nextEnd--; }
    updateRoom(db, room, 'disk', 0, [{from,to:end,insert:disk.text.slice(from,nextEnd)}]);
  }
  room.saved = room.version; room.disk = disk.hash;
  db.prepare('UPDATE rooms SET saved=?,disk=? WHERE epoch=?').run(room.saved,room.disk,room.epoch);
  db.prepare('DELETE FROM room_resolved WHERE epoch=?').run(room.epoch);
}

// 已提交的本地编辑（非重发/空操作）后台预热一次安全写者：准备与输入重叠，保存仍等待同一已校验工作进程。
let writerWarm = false;
function warmWriterAfterEdit(accepted) {
  if (!accepted || writerWarm) return;
  writerWarm = true;
  require('./safe-file').prepareFileWorker();
}

class LiveDocuments {
  constructor({directory = defaultDirectory(), busyTimeoutMs, draftLimits, untitledDraftIndex = false} = {}) {
    this.directory = directory; this.busyTimeoutMs = busyTimeoutMs;
    this.draftLimits = validateDraftLimits({...DRAFT_LIMITS, ...(draftLimits || {})});
    this.untitledDraftIndex = !!untitledDraftIndex;
    this.clients = new Map();
  }
  get db() { return database(this.directory); }
  leaseOptions() { return {busyTimeoutMs:this.busyTimeoutMs}; }
  // B3.3b read-only mirror. The draft index is never an editing authority:
  // callers may expose it to readers, but write paths must reject any dirty
  // mirror before they touch the disk.
  draftLimitsFor() { return this.draftLimits; }
  async draftSource(filePath, {untitled=false, docToken}={}) {
    if (untitled) {
      if (!this.untitledDraftIndex) throw fault('MP_DRAFT_UNTITLED_DISABLED', '未命名草稿索引未启用');
      if (typeof docToken !== 'string' || !docToken || docToken.length > 128)
        throw fault('MP_DRAFT_INVALID', '缺少有效的文档令牌');
      return {source:'untitled:' + docToken, kind:'untitled'};
    }
    if (typeof filePath !== 'string' || !filePath) throw fault('MP_DRAFT_INVALID', '缺少文档路径');
    const file = await canonicalFile(filePath);
    const source = fileKey(file);
    if (source.length > 8192) throw fault('MP_DRAFT_INVALID', '文档路径过长');
    return {source, kind:'file'};
  }
  draftWritableDb() {
    const filename = draftStoreFile(this.directory);
    if (fs.existsSync(filename) && !localStoreUsable(filename))
      throw fault('MP_DRAFT_STORE_FOREIGN', '草稿索引属于其他宿主，拒绝写入');
    return this.db;
  }
  async putDraft(...args) {
    storageOperations++;
    try { return await this._putDraft(...args); }
    finally { storageOperations--; }
  }
  async _putDraft(filePath, {text, baseVersion='', baseSha256='', docToken, session=null, untitled=false}={}) {
    if (typeof text !== 'string') throw fault('MP_DRAFT_INVALID', '缺少草稿正文');
    if (typeof docToken !== 'string' || !docToken || docToken.length > 128)
      throw fault('MP_DRAFT_INVALID', '缺少有效的文档令牌');
    validateDraftText(text);
    const sessionValue = draftSessionValue(session);
    const versionValue = typeof baseVersion === 'number' && Number.isFinite(baseVersion) ? String(baseVersion) : baseVersion;
    const {source, kind} = await this.draftSource(filePath, {untitled, docToken});
    const normalized = normalizedDraftText(text);
    const bytes = draftBytes(normalized);
    if (bytes > this.draftLimits.maxBytes) throw fault('MP_DRAFT_TOO_LARGE', '草稿超过镜像大小上限');
    if (kind === 'file') {
      if (typeof versionValue !== 'string' || !versionValue
        || typeof baseSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(baseSha256))
        throw fault('MP_DRAFT_INVALID', '文件草稿缺少磁盘基线');
    } else if (versionValue || baseSha256) {
      throw fault('MP_DRAFT_INVALID', '未命名草稿不能绑定磁盘基线');
    }
    const textSha = draftSha(normalized), now = Date.now();
    const db = this.draftWritableDb();
    let created = false;
    const row = atomic(db, () => {
      db.prepare('DELETE FROM draft_index WHERE updated_at < ?').run(now - this.draftLimits.ttlMs);
      const prior = db.prepare('SELECT created_at FROM draft_index WHERE source=?').get(source);
      const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM draft_index WHERE source<>?').get(source);
      if (!prior && totals.n >= this.draftLimits.maxRows) throw fault('MP_DRAFT_LIMIT', '草稿索引条数已达上限');
      if (totals.bytes + bytes > this.draftLimits.maxTotalBytes) throw fault('MP_DRAFT_LIMIT', '草稿索引总大小已达上限');
      created = !prior;
      if (prior) {
        db.prepare(`UPDATE draft_index SET kind=?,text=?,text_sha=?,bytes=?,base_version=?,base_sha256=?,
          doc_token=?,session=?,updated_at=? WHERE source=?`)
          .run(kind, normalized, textSha, bytes, versionValue, baseSha256.toLowerCase(), docToken,
            sessionValue, now, source);
      } else {
        db.prepare(`INSERT INTO draft_index(source,kind,text,text_sha,bytes,base_version,base_sha256,
          doc_token,session,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(source, kind, normalized, textSha, bytes, versionValue, baseSha256.toLowerCase(), docToken,
            sessionValue, now, now);
      }
      return db.prepare(`SELECT source,kind,text_sha,bytes,base_version,base_sha256,doc_token,
        created_at,updated_at FROM draft_index WHERE source=?`).get(source);
    });
    return {source:row.source, kind:row.kind, textSha256:row.text_sha, bytes:row.bytes,
      baseVersion:row.base_version, baseSha256:row.base_sha256, docToken:row.doc_token,
      createdAt:row.created_at, updatedAt:row.updated_at, created};
  }
  async getDraft(filePath, {untitled=false, docToken, now=Date.now()}={}) {
    if (untitled && !this.untitledDraftIndex) return null;
    let source;
    try { ({source} = await this.draftSource(filePath, {untitled, docToken})); }
    catch (error) { if (error.code === 'MP_DRAFT_UNTITLED_DISABLED') return null; throw error; }
    const db = draftStoreReadable(this.directory);
    if (!db) return null;
    try {
      const row = db.prepare('SELECT * FROM draft_index WHERE source=?').get(source);
      if (!row || row.updated_at < now - this.draftLimits.ttlMs) return null;
      if (row.kind !== (untitled ? 'untitled' : 'file') || row.source !== source)
        throw fault('MP_DRAFT_CORRUPT', '草稿索引行与请求不匹配');
      if ((row.kind === 'file' && (!row.base_version || !/^[0-9a-f]{64}$/i.test(row.base_sha256)))
        || (row.kind === 'untitled' && (row.base_version || row.base_sha256)))
        throw fault('MP_DRAFT_CORRUPT', '草稿索引基线不完整');
      if (typeof row.doc_token !== 'string' || !row.doc_token || row.doc_token.length > 128)
        throw fault('MP_DRAFT_CORRUPT', '草稿索引令牌无效');
      const text = String(row.text);
      if (draftSha(text) !== row.text_sha || draftBytes(text) !== row.bytes)
        throw fault('MP_DRAFT_CORRUPT', '草稿索引正文校验失败');
      return {source, kind:row.kind, text, textSha256:row.text_sha, bytes:row.bytes,
        baseVersion:row.base_version, baseSha256:row.base_sha256, docToken:row.doc_token,
        session:draftSessionRead(row.session), createdAt:row.created_at, updatedAt:row.updated_at};
    } catch (error) {
      if (draftTableMissing(error)) return null;
      throw error;
    } finally { try { db.close(); } catch { /* already closed */ } }
  }
  async clearDraft(...args) {
    storageOperations++;
    try { return await this._clearDraft(...args); }
    finally { storageOperations--; }
  }
  async _clearDraft(filePath, {docToken=null, textSha256=null, untitled=false}={}) {
    const bySha = textSha256 !== null && textSha256 !== undefined;
    if (bySha) {
      if (typeof textSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(textSha256))
        throw fault('MP_DRAFT_INVALID', '草稿 sha 无效');
    } else if (typeof docToken !== 'string' || !docToken) {
      throw fault('MP_DRAFT_INVALID', '缺少文档令牌');
    }
    if (untitled && !this.untitledDraftIndex) return {removed:0, reason:'untitled-disabled'};
    const {source, kind} = await this.draftSource(filePath, {untitled, docToken});
    if (!fs.existsSync(draftStoreFile(this.directory))) return {removed:0, reason:'no-store'};
    const db = this.draftWritableDb();
    return atomic(db, () => {
      const result = bySha
        ? db.prepare('DELETE FROM draft_index WHERE source=? AND kind=? AND text_sha=?')
          .run(source, kind, textSha256.toLowerCase())
        : db.prepare('DELETE FROM draft_index WHERE source=? AND kind=? AND doc_token=?')
          .run(source, kind, docToken);
      return {removed:Number(result.changes || 0), source, kind};
    });
  }
  async listDrafts({limit=100, offset=0, includeUntitled=false, now=Date.now()}={}) {
    const db = draftStoreReadable(this.directory);
    if (!db) return [];
    const take = Math.max(1, Math.min(500, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 100));
    const skip = Math.max(0, Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0);
    const at = Number(now);
    if (!Number.isFinite(at)) throw fault('MP_DRAFT_INVALID', '无效的当前时间');
    try {
      const rows = db.prepare(`SELECT source,kind,text_sha,bytes,base_version,base_sha256,doc_token,
        created_at,updated_at FROM draft_index WHERE updated_at>=? ${includeUntitled ? '' : "AND kind='file'"}
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(at - this.draftLimits.ttlMs, take, skip);
      return rows.map((row) => ({source:row.source, kind:row.kind, textSha256:row.text_sha,
        bytes:row.bytes, baseVersion:row.base_version, baseSha256:row.base_sha256,
        docToken:row.doc_token, createdAt:row.created_at, updatedAt:row.updated_at}));
    } catch (error) {
      if (draftTableMissing(error)) return [];
      throw error;
    } finally { try { db.close(); } catch { /* already closed */ } }
  }
  async pruneDrafts(...args) {
    storageOperations++;
    try { return await this._pruneDrafts(...args); }
    finally { storageOperations--; }
  }
  async _pruneDrafts({now=Date.now(), ttlMs=this.draftLimits.ttlMs}={}) {
    const ttl = ttlMs === undefined || ttlMs === null ? this.draftLimits.ttlMs : Number(ttlMs);
    const at = Number(now);
    if (!Number.isFinite(ttl) || ttl <= 0) throw fault('MP_DRAFT_INVALID', '无效的草稿过期时间');
    if (!Number.isFinite(at)) throw fault('MP_DRAFT_INVALID', '无效的当前时间');
    const filename = draftStoreFile(this.directory);
    if (!fs.existsSync(filename)) return {removed:0, remaining:0, bytes:0};
    const db = this.draftWritableDb();
    return atomic(db, () => {
      const result = db.prepare('DELETE FROM draft_index WHERE updated_at < ?').run(at - ttl);
      const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM draft_index').get();
      return {removed:Number(result.changes || 0), remaining:totals.n, bytes:totals.bytes};
    });
  }
  async join(filePath, initialText, expectedDiskHash) {
    if (typeof initialText !== 'string') throw fault('MP_LIVE_JOIN','缺少已打开的正文');
    const file = await canonicalFile(filePath), key = fileKey(file);
    return withFileCommit(file, async () => {
      // Opening a file is also the bounded housekeeping moment: crash orphans
      // (dead clients, their clean rooms, dirty rooms with parked recovery)
      // are retired here so un-reopened files cannot accumulate note copies.
      await sweepOrphans(this.db, this.directory);
      const disk = await readDisk(file);
      if (initialText.replace(/\r\n?/g,'\n') !== disk.text || expectedDiskHash && expectedDiskHash !== disk.hash)
        throw conflict('打开后磁盘内容已改变，请重新载入或另存草稿');
      const db = this.db, client = uuid();
      // A dead room for this very file is retired under this lease with the
      // sweeper's semantics: clean rooms go, dirty rooms park a recovery copy
      // first. A failed park keeps the room — and with it the draft.
      let existing = roomFor(db, key);
      if (existing && existing.version !== existing.saved &&
          !db.prepare('SELECT pid FROM clients WHERE epoch=?').all(existing.epoch).some(({pid}) => alive(pid)))
        await parkRecovery(db, this.directory, existing);
      const joined = atomic(db, () => {
        let room = roomFor(db, key);
        if (room) {
          for (const lease of db.prepare('SELECT id,pid FROM clients WHERE epoch=?').all(room.epoch))
            if (!alive(lease.pid)) db.prepare('DELETE FROM clients WHERE id=?').run(lease.id);
          if (!db.prepare('SELECT 1 FROM clients WHERE epoch=? LIMIT 1').get(room.epoch)) {
            if (room.version === room.saved) { db.prepare('DELETE FROM rooms WHERE epoch=?').run(room.epoch); room = null; }
            // A dirty room whose park failed stays: adoptDisk below conflicts
            // safely if the disk text changed, or resumes the draft if not.
          }
        }
        if (!room) {
          db.prepare('INSERT INTO rooms VALUES(?,?,0,0,?,?,0,?)').run(key,uuid(),disk.hash,disk.text.length,Buffer.from(disk.text,'utf16le'));
          room = roomFor(db, key);
        } else adoptDisk(db, room, disk);
        const text = room.version === room.saved ? disk.text : materialize(db,room);
        db.prepare('INSERT INTO clients(id,epoch,pid,ack) VALUES(?,?,?,?)').run(client,room.epoch,process.pid,room.version);
        let resolvedDisk = null;
        try { resolvedDisk = db.prepare('SELECT disk FROM room_resolved WHERE epoch=?').get(room.epoch)?.disk ?? null; }
        catch { /* old store: no marker table */ }
        return {...head(room),client,text,resolvedDisk};
      });
      this.clients.set(client, {key,file,epoch:joined.epoch});
      hosts.add(this); // 首个成员入座才登记 host；从未加入/全部离开的实例不占强引用
      // Surface parked drafts for this file so the UI can offer restoring
      // them instead of silently discarding a crashed window's work.
      const parked = db.prepare('SELECT source,recoveryPath,epoch AS recoveryEpoch,version,saved,at,bytes,sha256 FROM recovery WHERE source=? ORDER BY at DESC LIMIT 5').all(key);
      // A clean room can be a fresh one created from disk after an old EXE
      // deleted the previous room. Agent-append copies are then the only
      // surviving record of an edit the editor never acknowledged. A dirty
      // room remains the authority, so append copies are informational only
      // in that case (and never override room text).
      const appendCopies = [];
      if (joined.version === joined.savedVersion) {
        try {
          appendCopies.push(...listAppendRecoveryRows(db, key)
            .filter((entry) => entry.sha256 !== disk.hash && entry.sha256 !== disk.textSha256 && entry.at >= disk.mtimeMs));
        } catch { /* recovery index is auxiliary; never block opening */ }
      }
      const recovered = [];
      const seen = new Set();
      const addRecovery = (entry) => {
        const id = String(entry.recoveryPath);
        const sha = typeof entry.sha256 === 'string' ? entry.sha256 : '';
        if (seen.has(id) || (sha && seen.has('sha:' + sha))) return;
        seen.add(id);
        if (sha) seen.add('sha:' + sha);
        recovered.push(entry);
      };
      // Parked rows are the only surviving draft for a crashed editor; never
      // let newer informational append copies crowd them out of the 5-slot UI.
      for (const entry of parked.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))) addRecovery(entry);
      for (const entry of appendCopies) addRecovery(entry);
      return recovered.length ? {...joined, recovered: recovered.slice(0, 5)} : joined;
    }, this.directory, this.leaseOptions());
  }
  member(client, epoch) {
    const member = this.clients.get(client);
    if (!member || member.epoch !== epoch) throw fault('MP_LIVE_SESSION','文档协同会话已结束，草稿已保留');
    return member;
  }
  exchange(client, {epoch,version,seq,changes}) {
    const {key} = this.member(client,epoch), db = this.db;
    let accepted = false; // 仅真正接受的新 seq 才算一次“有修改的本地编辑”
    const transact = () => {
      const room = roomFor(db,key);
      if (!room || room.epoch !== epoch || !Number.isSafeInteger(version) || version < room.floor || version > room.version)
        throw fault('MP_LIVE_SESSION','无法关联这一版编辑，请保留本地草稿');
      const lease = db.prepare('SELECT ack,seq FROM clients WHERE id=? AND epoch=?').get(client,epoch);
      if (!lease) throw fault('MP_LIVE_SESSION','文档协同会话已结束');
      if (changes !== undefined) {
        if (!Number.isSafeInteger(seq) || seq < 1 || seq > lease.seq + 1) throw fault('MP_LIVE_CHANGE','协同编辑序号不连续');
        if (version === room.version && seq === lease.seq + 1) {
          updateRoom(db, room, client, seq, changes);
          db.prepare('UPDATE clients SET seq=? WHERE id=?').run(seq,client);
          // 全为空 splice 的协议合法 no-op 不做任何字符操作，不算会写盘的编辑。
          accepted = changes.some(part => part.from !== part.to || part.insert.length > 0);
        }
      }
      if (version > lease.ack) db.prepare('UPDATE clients SET ack=? WHERE id=?').run(version,client);
      const updates = db.prepare('SELECT version,client,seq,delta,group_id AS groupId FROM changes WHERE epoch=? AND version>? ORDER BY version').all(epoch,version)
        .map(({delta,...row}) => ({...row,changes:JSON.parse(delta)}));
      if (changes !== undefined) compact(db,room);
      return {...head(room),updates};
    };
    // Most polls are reads with no edits or acknowledgment to record.
    if (changes === undefined) {
      const cached = db.prepare('SELECT r.epoch,r.version,r.saved,r.disk FROM rooms r JOIN clients c ON c.epoch=r.epoch WHERE c.id=? AND c.ack=? AND r.version=?').get(client,version,version);
      if (cached?.epoch === epoch) return {...head(cached),updates:[]};
    }
    const result = atomic(db,transact);
    warmWriterAfterEdit(accepted); // 事务提交后再触发；失败自吞，不影响 exchange
    return result;
  }
  async save(client, {epoch,version,text}, writer) {
    const {key,file} = this.member(client,epoch);
    return withFileCommit(file, async () => {
      const db = this.db, room = roomFor(db,key);
      if (!room || room.epoch !== epoch || room.version !== version || materialize(db,room) !== text)
        throw fault('MP_LIVE_STALE','其他窗口刚有新编辑，请同步后保存；当前正文已保留');
      if ((await readDisk(file)).hash !== room.disk) throw conflict('磁盘已被其他程序修改，当前草稿已保留');
      // A conflict-resolve authorization is scoped to the exact disk it was
      // resolved against. Undo writes the empty sentinel above; a stale or
      // revoked marker must never authorize a save over the external version.
      let resolvedMarker = null;
      try { resolvedMarker = db.prepare('SELECT disk FROM room_resolved WHERE epoch=?').get(epoch); }
      catch { /* old store: no marker table */ }
      if (resolvedMarker && resolvedMarker.disk !== room.disk)
        throw conflict('冲突解决已撤销或磁盘版本已变化；请重新确认冲突');
      this.member(client,epoch);
      const receipt = await writer({diskHash:room.disk});
      if (!receipt || receipt.ok === false) return receipt;
      const disk = await readDisk(file);
      if (disk.text !== text || receipt.writtenDiskHash && receipt.writtenDiskHash !== disk.hash)
        throw conflict('文件已再次改变，不能把此次保存标记为成功');
      atomic(db, () => {
        db.prepare('UPDATE rooms SET saved=?,disk=? WHERE epoch=?').run(version,disk.hash,epoch);
        db.prepare('DELETE FROM room_resolved WHERE epoch=?').run(epoch);
      });
      // The provider receipt stays authoritative: live metadata is added under
      // its own names, so a provider version field is never overwritten.
      const live = roomFor(db,key);
      return {...receipt, epoch, liveVersion:(live||room).version, savedVersion:version, diskHash:disk.hash};
    }, this.directory, this.leaseOptions());
  }
  // A no-op "keep mine" resolution still has to authorize a later save over
  // the external disk. It does not change the buffer/version, but it must
  // atomically mark the exact disk baseline as user-approved.
  async markResolved(filePath, {epoch, baseVersion, baseText, expectedDiskHash} = {}) {
    if (typeof baseText !== 'string') throw fault('MP_LIVE_APPEND', '缺少权威正文');
    if (typeof epoch !== 'string' || !epoch) throw fault('MP_LIVE_APPEND', '缺少协同会话');
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw fault('MP_LIVE_APPEND', '无效的协同版本');
    if (typeof expectedDiskHash !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedDiskHash))
      throw fault('MP_DOC_STALE', '缺少磁盘基线；请重新打开冲突');
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!localStoreUsable(filename)) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
    return withFileCommit(file, async () => {
      const db = this.db;
      const disk = await readDisk(file);
      if (disk.hash !== expectedDiskHash) throw fault('MP_DOC_STALE', '磁盘在冲突解决期间又变了；请重新打开冲突');
      return atomic(db, () => {
        const room = roomFor(db, key);
        if (!room) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
        if (room.epoch !== epoch) throw fault('MP_LIVE_SESSION', '文档协同会话已改变');
        const members = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch)
          .filter(({pid}) => alive(pid)).length;
        if (!members) throw fault('MP_LIVE_NO_MEMBER', '没有在线的编辑器会话，请重新读取后再试');
        if (room.version !== baseVersion || materialize(db, room) !== baseText)
          throw fault('MP_LIVE_STALE', '文档刚有新编辑，请重新读取后再应用');
        db.prepare('UPDATE rooms SET disk=? WHERE epoch=?').run(disk.hash, room.epoch);
        db.prepare('INSERT OR REPLACE INTO room_resolved(epoch,disk,resolved_at) VALUES(?,?,?)')
          .run(room.epoch, disk.hash, Date.now());
        room.disk = disk.hash;
        return {...head(room), text: materialize(db, room), resolvedDisk: disk.hash};
      });
    }, this.directory, this.leaseOptions());
  }
  // Focus-time disk probe for live members: detect non-cooperating writes.
  // The snapshot and the adoption run under the same file-write lease as
  // save/external, so a cooperating window's commit can never fall between
  // the disk read and the room update — an interleaved save would otherwise
  // be adopted as a stale disk state and overwrite the newer room contents.
  async refresh(client, epoch, options = {}) {
    const {key,file} = this.member(client,epoch);
    return withFileCommit(file, async () => {
      this.member(client,epoch);
      const disk = await readDisk(file);
      return atomic(this.db, () => {
        const room = roomFor(this.db,key);
        if (!room || room.epoch !== epoch) throw fault('MP_LIVE_SESSION','文档协同会话已结束，草稿已保留');
        if (room.disk === disk.hash) return {...head(room),changed:false};
        // 有未保存草稿时默认只报告冲突；用户显式「重载磁盘版本」(discard) 才让磁盘内容覆盖草稿。
        if (room.version !== room.saved && !options.discard) return {...head(room),changed:true,unsavedDraft:true};
        try { adoptDisk(this.db, room, disk, options.discard === true); }
        catch (error) {
          if (error.code !== 'MP_FILE_CONFLICT') throw error;
          return {...head(roomFor(this.db,key) || room),changed:true,unsavedDraft:true};
        }
        return {...head(roomFor(this.db,key) || room),changed:true};
      });
    }, this.directory, this.leaseOptions());
  }
  // External/model writes keep their own permission checks and must not inspect
  // or supersede the unsaved shared draft. Publish only the actual disk result.
  //
  // The one exception is an explicit, user-confirmed "保留我的修改" from the very
  // window that owns this room (options.keepMineText + options.client set by the
  // host after its own one-shot overwrite grant). Even then only the room's own
  // authoritative text may reach disk: the caller's captured text must still
  // equal materialize(room), the caller must be a live member of this epoch, and
  // the host writer keeps its baseline CAS. A peer edit arriving first is a real
  // conflict and stays a conflict — never laundered into a successful save.
  async external(filePath, writer, options = {}) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const keepMineText = options && typeof options.keepMineText === 'string' ? options.keepMineText.replace(/\r\n?/g,'\n') : null;
    return withFileCommit(file, async () => {
      const db = this.db;
      await sweepOrphans(db, this.directory);
      const before = roomFor(db,key);
      let sealed = null;
      if (before && before.saved !== before.version) {
        if (keepMineText === null) throw conflict('此文件有未保存的编辑，请先保存或保留草稿');
        const member = options.client && this.clients.get(options.client);
        if (!member || member.epoch !== before.epoch || member.key !== key)
          throw fault('MP_LIVE_SESSION','协同会话不属于当前文件，修改已保留');
        if (materialize(db, before) !== keepMineText)
          throw fault('MP_LIVE_STALE','其他窗口刚有新编辑，请同步后再保留修改；当前草稿已保留');
        sealed = {...head(before), text:keepMineText};
      }
      const result = await writer();
      let sealedHead = null;
      if (before) {
        const disk = await readDisk(file);
        atomic(db, () => {
          const room = roomFor(db,key);
          if (room?.epoch !== before.epoch) return;
          if (sealed && room.version === sealed.version) {
            // The room authorized this exact draft; these bytes are its own
            // valid CAS-covered write, so the room becomes clean and keeps the
            // disk identity the writer just produced.
            if (disk.text !== sealed.text) throw conflict('文件已再次改变，不能把此次保留标记为成功');
            room.saved = room.version; room.disk = disk.hash;
            db.prepare('UPDATE rooms SET saved=?,disk=? WHERE epoch=?').run(room.saved,room.disk,room.epoch);
            // This write is the authorized keep-mine resolution. Its disk hash
            // is now in rooms.disk; a stale room_resolved marker must not keep
            // blocking later live.save calls (that would be a save dead end).
            db.prepare('DELETE FROM room_resolved WHERE epoch=?').run(room.epoch);
            sealedHead = {...head(room),clean:true};
            return;
          }
          try { adoptDisk(db,room,disk); }
          catch (error) {
            if (error.code !== 'MP_FILE_CONFLICT') throw error;
            // New input arrived while the external writer was running. Those
            // bytes did land on disk, so the writer's own result stands; the
            // unsaved draft stays protected and refresh()/exchange() report
            // the disk change instead of failing a write that succeeded.
          }
        });
      }
      return sealedHead ? {...result, ...sealedHead, liveVersion:sealedHead.version} : result;
    }, this.directory, this.leaseOptions());
  }
  // Read-only disk identity for conflict resolution. Uses the same strict
  // byte hash as save/directWriteText; never creates the rooms store and never
  // writes. A missing file surfaces as MP_FILE_MISSING like readDisk.
  async readDiskIdentity(filePath) {
    const file = await canonicalFile(filePath);
    const disk = await readDisk(file);
    return {file, diskHash: disk.hash, text: disk.text, mtimeMs: disk.mtimeMs};
  }
  // B3: authoritative read of the shared buffer. Never creates the rooms store,
  // never joins, never sweeps, never writes. A missing/foreign database means
  // "no room": the caller must fall back to the disk authority.
  async readRoom(filePath) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) return null;
    const {DatabaseSync} = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(filename, {readOnly:true}); }
    catch (error) { return null; }
    try {
      try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
      try {
        const stored = db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value;
        if (stored !== hostStamp()) return null;    // foreign/copied store: never seat it as authority
      } catch { return null; }                       // no meta/old schema: not this host's room
      return readTx(db, () => {
        const room = roomFor(db, key);
        if (!room) return null;
        const text = materialize(db, room);
        const savedTextAvailable = room.saved >= room.floor;
        const savedText = room.version === room.saved ? text
          : (savedTextAvailable ? materialize(db, room, room.saved) : null);
        const pids = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch);
        const members = pids.filter(({pid}) => alive(pid)).length;
        const localMembers = pids.filter(({pid}) => pid === process.pid).length;
        const resolved = (() => {
          try { return db.prepare('SELECT disk FROM room_resolved WHERE epoch=?').get(room.epoch); }
          catch { return null; } // old store created before room_resolved existed
        })();
        return {...head(room), length:room.length, text, savedText, savedTextAvailable,
          textSha256:digest(Buffer.from(text,'utf8')), members, localMembers,
          resolvedDisk: resolved?.disk ?? null};
      });
    } catch (error) {
      // A read-only WAL edge, a locked store or a transient SQLite failure must
      // not block a read. Fall back to the disk authority; write paths still go
      // through live.external/CAS and cannot silently overwrite a dirty room.
      return null;
    } finally { try { db.close(); } catch { /* already closed */ } }
  }
  // B3.2: read-only list of independent post-append copies. Never creates the
  // recovery directory, never touches the rooms database.
  async listAppendRecovery(filePath) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) return [];
    const {DatabaseSync} = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(filename, {readOnly:true}); } catch { return []; }
    try {
      try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
      const stored = db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value;
      if (stored !== hostStamp()) return [];
      return listAppendRecoveryRows(db, key);
    } catch { return []; }
    finally { try { db.close(); } catch { /* already closed */ } }
  }
  async recordAgentGroup(filePath, entry = {}) {
    const groupId = String(entry.groupId || '');
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) return null;
    const file = await canonicalFile(filePath), key = fileKey(file);
    const now = Number.isSafeInteger(entry.at) ? entry.at : Date.now();
    const db = this.db;
    const rawChanges = Array.isArray(entry.changes) ? JSON.stringify(entry.changes.map((c) => ({
      from: Number(c.from) || 0, to: Number(c.to) || 0,
      insert: String(c.insert ?? ''), removed: String(c.removed ?? ''),
    }))) : null;
    const changes = rawChanges && rawChanges.length <= 4 * 1024 * 1024 ? rawChanges : null;
    db.prepare('INSERT OR REPLACE INTO agent_group(group_id,source,actor,kind,base_revision,result_revision,at,changes,undone_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
      .run(groupId, key, String(entry.actor || 'agent').slice(0, 32), String(entry.kind || 'edit').slice(0, 32),
        String(entry.baseRevision || '').slice(0, 512), String(entry.resultRevision || '').slice(0, 512), now, changes);
    return { groupId, source: key, at: now };
  }
  async getAgentGroup(filePath, groupId) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) return null;
    const {DatabaseSync} = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(filename, {readOnly:true}); } catch { return null; }
    try {
      if (db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value !== hostStamp()) return null;
      const row = db.prepare('SELECT group_id AS groupId,actor,kind,base_revision AS baseRevision,result_revision AS resultRevision,at,changes,undone_at AS undoneAt FROM agent_group WHERE source=? AND group_id=?').get(key, String(groupId || ''));
      if (!row) return null;
      try { row.changes = row.changes ? JSON.parse(row.changes) : []; } catch { row.changes = []; }
      return row;
    } catch { return null; }
    finally { try { db.close(); } catch { /* already closed */ } }
  }
  async markAgentGroupUndone(filePath, groupId) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    this.db.prepare('UPDATE agent_group SET undone_at=? WHERE source=? AND group_id=?').run(Date.now(), key, String(groupId || ''));
    return true;
  }
  async listAgentGroups(filePath, limit = 20) {
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) return [];
    const {DatabaseSync} = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(filename, {readOnly:true}); } catch { return []; }
    try {
      if (db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value !== hostStamp()) return [];
      return db.prepare('SELECT group_id AS groupId,actor,kind,base_revision AS baseRevision,result_revision AS resultRevision,at,undone_at AS undoneAt FROM agent_group WHERE source=? ORDER BY at DESC LIMIT ?')
        .all(key, Math.max(1, Math.min(100, Number(limit) || 20)));
    } catch { return []; }
    finally { try { db.close(); } catch { /* already closed */ } }
  }
  // User-initiated recovery: read one committed post-append copy and verify its
  // bytes/path against the append_recovery row. Never trusts a client path.
  async readAppendRecovery(filePath, recoveryPath) {
    if (typeof recoveryPath !== 'string' || !recoveryPath) throw fault('MP_RECOVERY_NOT_FOUND', '恢复副本路径无效');
    const file = await canonicalFile(filePath), key = fileKey(file);
    const dir = appendRecoveryDirectory(this.directory);
    const resolved = path.resolve(recoveryPath);
    if (resolved !== path.resolve(dir, path.basename(resolved)) || !resolved.startsWith(path.resolve(dir) + path.sep))
      throw fault('MP_RECOVERY_INVALID', '恢复副本不在受控目录');
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) throw fault('MP_RECOVERY_NOT_FOUND', '没有可用的恢复索引');
    const {DatabaseSync} = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(filename, {readOnly:true}); } catch { throw fault('MP_RECOVERY_NOT_FOUND', '恢复索引不可读'); }
    try {
      try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
      if (db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value !== hostStamp())
        throw fault('MP_RECOVERY_INVALID', '恢复索引不属于本宿主');
      const row = db.prepare('SELECT recoveryPath,sha256,bytes,epoch,version,at FROM append_recovery WHERE source=? AND recoveryPath=?').get(key, resolved);
      if (!row) throw fault('MP_RECOVERY_NOT_FOUND', '恢复副本已不存在');
      const bytes = fs.readFileSync(resolved);
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256)
        throw fault('MP_RECOVERY_CORRUPT', '恢复副本内容校验失败');
      return {recoveryPath: resolved, text: bytes.toString('utf8'), sha256: row.sha256, bytes: bytes.length,
        epoch: String(row.epoch || ''), version: Number(row.version) || 0, at: Number(row.at) || 0};
    } finally { try { db.close(); } catch { /* already closed */ } }
  }
  async discardAppendRecovery(filePath, recoveryPath) {
    if (typeof recoveryPath !== 'string' || !recoveryPath) throw fault('MP_RECOVERY_NOT_FOUND', '恢复副本路径无效');
    const file = await canonicalFile(filePath), key = fileKey(file);
    const dir = appendRecoveryDirectory(this.directory);
    const resolved = path.resolve(recoveryPath);
    if (resolved !== path.resolve(dir, path.basename(resolved)) || !resolved.startsWith(path.resolve(dir) + path.sep))
      throw fault('MP_RECOVERY_INVALID', '恢复副本不在受控目录');
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!fs.existsSync(filename)) throw fault('MP_RECOVERY_NOT_FOUND', '没有可用的恢复索引');
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(filename);
    try {
      try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* best effort */ }
      if (db.prepare("SELECT value FROM meta WHERE key='host'").get()?.value !== hostStamp())
        throw fault('MP_RECOVERY_INVALID', '恢复索引不属于本宿主');
      const row = db.prepare('SELECT recoveryPath FROM append_recovery WHERE source=? AND recoveryPath=?').get(key, resolved);
      if (!row) throw fault('MP_RECOVERY_NOT_FOUND', '恢复副本已不存在');
      // Remove the payload first: if the file is locked, keep the index row and
      // report failure instead of claiming a discard that leaves an inert file.
      fs.rmSync(resolved, {force: true});
      try { fs.rmSync(resolved + '.json', {force: true}); } catch { /* best effort */ }
      db.prepare('DELETE FROM append_recovery WHERE source=? AND recoveryPath=?').run(key, resolved);
    } finally { db.close(); }
    return {removed: true, recoveryPath: resolved};
  }
  // B3: append one authoritative remote edit to the shared buffer. Never
  // touches disk or `saved`; the change is delivered to every member through
  // the normal exchange() update stream. The transaction re-checks epoch,
  // version and the materialized base text, so a concurrent editor save or
  // peer edit can never be appended on top of a stale base.
  async append(filePath, {epoch, baseVersion, baseText, changes, actor='agent', groupId=null, clearResolved=false} = {}) {
    if (typeof baseText !== 'string') throw fault('MP_LIVE_APPEND', '缺少权威正文');
    if (typeof epoch !== 'string' || !epoch) throw fault('MP_LIVE_APPEND', '缺少协同会话');
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw fault('MP_LIVE_APPEND', '无效的协同版本');
    if (!/^[a-z0-9-]{1,32}$/.test(String(actor))) throw fault('MP_LIVE_APPEND', '无效的追加者');
    if (groupId != null && !/^[0-9a-f-]{36}$/i.test(String(groupId))) throw fault('MP_LIVE_APPEND', '无效的编辑组');
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!localStoreUsable(filename)) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
    return withFileCommit(file, async () => {
      const db = this.db;
      let recoveryPath = null, recoveryCreated = false;
      try {
        const result = atomic(db, () => {
          const room = roomFor(db, key);
          if (!room) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
          if (room.epoch !== epoch) throw fault('MP_LIVE_SESSION', '文档协同会话已改变');
          const members = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch)
            .filter(({pid}) => alive(pid)).length;
          if (!members) throw fault('MP_LIVE_NO_MEMBER', '没有在线的编辑器会话，请重新读取后再试');
          if (room.version !== baseVersion || materialize(db, room) !== baseText)
            throw fault('MP_LIVE_STALE', '文档刚有新编辑，请重新读取后再应用');
          const length = checkedLength(changes, room.length);
          const version = room.version + 1;
          const nextText = apply(baseText, changes);
          if (nextText.length !== length) throw fault('MP_LIVE_CHANGE', '协同编辑的长度校验失败');
          // The recovery copy is post-edit and durable before COMMIT. It is the
          // independent copy used when the room is retired before the editor
          // acknowledges this change. The transaction stays open for the write,
          // so exchange() cannot advance the room underneath this snapshot.
          const written = writeAppendRecoverySync(this.directory, file, room.epoch, version, nextText);
          recoveryPath = written.path;
          recoveryCreated = written.created === true;
          // The row is committed atomically with the change. It is the
          // discovery record; the file is the payload.
          db.prepare('INSERT OR REPLACE INTO append_recovery VALUES(?,?,?,?,?,?,?)')
            .run(key, written.path, room.epoch, version, written.at || Date.now(), written.bytes, written.sha256);
          db.prepare('INSERT INTO changes(epoch,version,client,seq,delta,group_id) VALUES(?,?,?,?,?,?)')
            .run(room.epoch, version, actor, 0, JSON.stringify(changes), groupId ? String(groupId) : null);
          db.prepare('UPDATE rooms SET version=?,length=? WHERE epoch=?').run(version, length, room.epoch);
          // A revoked resolved-conflict marker must keep blocking live.save even
          // though rooms.disk still has the external hash. Use an empty sentinel
          // instead of deleting the row: save() checks it before writing, while
          // authority() already treats it as "not the current disk".
          if (clearResolved === true) db.prepare('INSERT OR REPLACE INTO room_resolved(epoch,disk,resolved_at) VALUES(?,?,?)').run(room.epoch, '', Date.now());
          room.version = version; room.length = length;
          compact(db, room);
          const text = materialize(db, room);
          return {...head(room), text, textSha256:digest(Buffer.from(text,'utf8')), recoveryPath};
        });
        try { pruneAppendRecoveryRows(db, key, recoveryPath); } catch { /* retention is best effort */ }
        return result;
      } catch (error) {
        if (recoveryCreated && recoveryPath) {
          try { fs.rmSync(recoveryPath, {force: true}); } catch { /* best effort */ }
          try { fs.rmSync(recoveryPath + '.json', {force: true}); } catch { /* best effort */ }
        }
        throw error;
      }
    }, this.directory, { ...this.leaseOptions(), busyTimeoutMs: Math.min(this.leaseOptions().busyTimeoutMs ?? APPEND_BUSY_TIMEOUT_MS, APPEND_BUSY_TIMEOUT_MS) });
  }
  async appendResolvedConflict(filePath, {epoch, baseVersion, baseText, changes, actor='agent', groupId=null, expectedDiskHash=null} = {}) {
    if (typeof baseText !== 'string') throw fault('MP_LIVE_APPEND', '缺少权威正文');
    if (typeof epoch !== 'string' || !epoch) throw fault('MP_LIVE_APPEND', '缺少协同会话');
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw fault('MP_LIVE_APPEND', '无效的协同版本');
    if (!/^[a-z0-9-]{1,32}$/.test(String(actor))) throw fault('MP_LIVE_APPEND', '无效的追加者');
    if (groupId != null && !/^[0-9a-f-]{36}$/i.test(String(groupId))) throw fault('MP_LIVE_APPEND', '无效的编辑组');
    if (typeof expectedDiskHash !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedDiskHash))
      throw fault('MP_DOC_STALE', '缺少磁盘基线；请重新打开冲突');
    const file = await canonicalFile(filePath), key = fileKey(file);
    const filename = path.join(path.resolve(this.directory), 'rooms.sqlite');
    if (!localStoreUsable(filename)) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
    return withFileCommit(file, async () => {
      const db = this.db;
      const disk = await readDisk(file);
      if (disk.hash !== expectedDiskHash) throw fault('MP_DOC_STALE', '磁盘在冲突解决期间又变了；请重新打开冲突');
      let recoveryPath = null, recoveryCreated = false;
      try {
        const result = atomic(db, () => {
          const room = roomFor(db, key);
          if (!room) throw fault('MP_LIVE_NO_ROOM', '文档没有共享会话，请重新读取后再试');
          if (room.epoch !== epoch) throw fault('MP_LIVE_SESSION', '文档协同会话已改变');
          const members = db.prepare('SELECT pid FROM clients WHERE epoch=?').all(room.epoch)
            .filter(({pid}) => alive(pid)).length;
          if (!members) throw fault('MP_LIVE_NO_MEMBER', '没有在线的编辑器会话，请重新读取后再试');
          if (room.version !== baseVersion || materialize(db, room) !== baseText)
            throw fault('MP_LIVE_STALE', '文档刚有新编辑，请重新读取后再应用');
          const length = checkedLength(changes, room.length);
          const version = room.version + 1;
          const nextText = apply(baseText, changes);
          if (nextText.length !== length) throw fault('MP_LIVE_CHANGE', '协同编辑的长度校验失败');
          const written = writeAppendRecoverySync(this.directory, file, room.epoch, version, nextText);
          recoveryPath = written.path;
          recoveryCreated = written.created === true;
          db.prepare('INSERT OR REPLACE INTO append_recovery VALUES(?,?,?,?,?,?,?)')
            .run(key, written.path, room.epoch, version, written.at || Date.now(), written.bytes, written.sha256);
          db.prepare('INSERT INTO changes(epoch,version,client,seq,delta,group_id) VALUES(?,?,?,?,?,?)')
            .run(room.epoch, version, actor, 0, JSON.stringify(changes), groupId ? String(groupId) : null);
          db.prepare('UPDATE rooms SET version=?,length=?,disk=? WHERE epoch=?').run(version, length, disk.hash, room.epoch);
          db.prepare('INSERT OR REPLACE INTO room_resolved(epoch,disk,resolved_at) VALUES(?,?,?)')
            .run(room.epoch, disk.hash, Date.now());
          room.version = version; room.length = length; room.disk = disk.hash;
          compact(db, room);
          const text = materialize(db, room);
          return {...head(room), text, textSha256:digest(Buffer.from(text,'utf8')), recoveryPath: written.path, resolvedDisk: disk.hash};
        });
        try { pruneAppendRecoveryRows(db, key, recoveryPath); } catch { /* retention is best effort */ }
        return result;
      } catch (error) {
        if (recoveryCreated && recoveryPath) {
          try { fs.rmSync(recoveryPath, {force: true}); } catch { /* best effort */ }
          try { fs.rmSync(recoveryPath + '.json', {force: true}); } catch { /* best effort */ }
        }
        throw error;
      }
    }, this.directory, { ...this.leaseOptions(), busyTimeoutMs: Math.min(this.leaseOptions().busyTimeoutMs ?? APPEND_BUSY_TIMEOUT_MS, APPEND_BUSY_TIMEOUT_MS) });
  }
  leave(client) {
    const member = this.clients.get(client);
    if (!member) return;
    const db = this.db;
    atomic(db, () => {
      // An agent edit that no editor has acknowledged yet may exist only in the
      // room log. Deleting the room here would silently drop it (the editor
      // never applied it, so its WAL has no record and the pre-edit archive is
      // not the edit). Keep that room; the next join parks it as a recovery
      // draft. A delivered agent edit (ack >= version) is safe to retire — the
      // editor's normal save/recovery path owns it by then.
      const room = db.prepare('SELECT version,saved FROM rooms WHERE epoch=?').get(member.epoch);
      const maxAck = db.prepare('SELECT MAX(ack) AS v FROM clients WHERE epoch=?').get(member.epoch)?.v;
      const unackedAgent = room
        ? db.prepare("SELECT MAX(version) AS v FROM changes WHERE epoch=? AND client='agent' AND version>?")
            .get(member.epoch, room.saved)?.v
        : null;
      db.prepare('DELETE FROM clients WHERE id=? AND epoch=?').run(client,member.epoch);
      const remaining = db.prepare('SELECT COUNT(*) AS c FROM clients WHERE epoch=?').get(member.epoch).c;
      if (remaining > 0) return;
      const keep = unackedAgent != null && (maxAck == null || unackedAgent > maxAck);
      if (!keep) db.prepare('DELETE FROM rooms WHERE epoch=?').run(member.epoch);
    });
    this.clients.delete(client);
    if (!this.clients.size) hosts.delete(this);
  }
}
// 宿主（如插件 HMR）在确认本代 LiveDocuments 全部实例已 leave、已接纳写作业
// drained 后调用：仅 close 本代打开的 SQLite 连接并清 Map——不删库、不动
// 房间/草稿/恢复数据。仍有成员在场或有在途租约操作时拒绝（MP_LIVE_ACTIVE）；
// 重复调用幂等。调用顺序约定：先 retireLiveStorage()，再旧代 safeFile 的
// shutdownFileWorker()。
function retireLiveStorage() {
  if (storageOperations > 0) throw fault('MP_LIVE_ACTIVE', '协同存储仍有在途操作，稍后再试');
  for (const host of hosts) if (host.clients.size > 0) throw fault('MP_LIVE_ACTIVE', '仍有协同会话在场，全部离开后再退休存储');
  const closed = [];
  for (const [location, db] of [...databases]) { db.close(); databases.delete(location); closed.push(location); }
  hosts.clear();
  return {ok: true, closed};
}
module.exports = {LiveDocuments,withFileCommit,defaultDirectory,retireLiveStorage};
