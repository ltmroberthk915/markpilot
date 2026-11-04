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
        client TEXT NOT NULL, seq INTEGER NOT NULL, delta TEXT NOT NULL, PRIMARY KEY(epoch,version));
      CREATE TABLE IF NOT EXISTS recovery (
        source TEXT NOT NULL, recoveryPath TEXT PRIMARY KEY, epoch TEXT NOT NULL,
        version INTEGER NOT NULL, saved INTEGER NOT NULL, at INTEGER NOT NULL,
        bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS writers (file TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, since INTEGER NOT NULL);`);
    // Rooms kept by an earlier draft release held leases without timestamps.
    if (!db.prepare('PRAGMA table_info(writers)').all().some(column => column.name === 'since'))
      db.exec('DROP TABLE writers; CREATE TABLE writers (file TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, since INTEGER NOT NULL);');
    // The rooms store is per machine and account. A database carried here from
    // another device or profile (synced or copied LOCALAPPDATA) must not seat
    // stale authority over files it has never seen on this host.
    const stamp = hostStamp(), stored = db.prepare("SELECT value FROM meta WHERE key='host'").get();
    if (stored && stored.value !== stamp)
      atomic(db, () => {
        db.exec('DELETE FROM writers; DELETE FROM changes; DELETE FROM clients; DELETE FROM rooms;');
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
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

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
  return {hash:snap.baseline.sha256, text:decodeDocument(snap.bytes, file).text.replace(/\r\n?/g, '\n')};
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
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(room.epoch, version, client, seq, JSON.stringify(changes));
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
function adoptDisk(db, room, disk) {
  if (room.disk === disk.hash) return;
  const current = materialize(db, room);
  if (current !== disk.text) {
    // A draft that diverges from the new disk text is a genuine both-changed
    // conflict — unless the external writer landed this very draft, which the
    // equality check above already turned into a save.
    if (room.version !== room.saved) throw conflict('原文件和未保存的协同草稿均已改变，请另存草稿或重新载入');
    let from = 0, end = current.length, nextEnd = disk.text.length;
    while (from < end && from < nextEnd && current.charCodeAt(from) === disk.text.charCodeAt(from)) from++;
    while (end > from && nextEnd > from && current.charCodeAt(end-1) === disk.text.charCodeAt(nextEnd-1)) { end--; nextEnd--; }
    updateRoom(db, room, 'disk', 0, [{from,to:end,insert:disk.text.slice(from,nextEnd)}]);
  }
  room.saved = room.version; room.disk = disk.hash;
  db.prepare('UPDATE rooms SET saved=?,disk=? WHERE epoch=?').run(room.saved,room.disk,room.epoch);
}

// 已提交的本地编辑（非重发/空操作）后台预热一次安全写者：准备与输入重叠，保存仍等待同一已校验工作进程。
let writerWarm = false;
function warmWriterAfterEdit(accepted) {
  if (!accepted || writerWarm) return;
  writerWarm = true;
  require('./safe-file').prepareFileWorker();
}

class LiveDocuments {
  constructor({directory = defaultDirectory(), busyTimeoutMs} = {}) {
    this.directory = directory; this.busyTimeoutMs = busyTimeoutMs;
    this.clients = new Map();
  }
  get db() { return database(this.directory); }
  leaseOptions() { return {busyTimeoutMs:this.busyTimeoutMs}; }
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
        return {...head(room),client,text};
      });
      this.clients.set(client, {key,file,epoch:joined.epoch});
      hosts.add(this); // 首个成员入座才登记 host；从未加入/全部离开的实例不占强引用
      // Surface parked drafts for this file so the UI can offer restoring
      // them instead of silently discarding a crashed window's work.
      const recovered = db.prepare('SELECT source,recoveryPath,epoch AS recoveryEpoch,version,saved,at,bytes,sha256 FROM recovery WHERE source=? ORDER BY at DESC LIMIT 3').all(key);
      return recovered.length ? {...joined, recovered} : joined;
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
      const updates = db.prepare('SELECT version,client,seq,delta FROM changes WHERE epoch=? AND version>? ORDER BY version').all(epoch,version)
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
      this.member(client,epoch);
      const receipt = await writer({diskHash:room.disk});
      if (!receipt || receipt.ok === false) return receipt;
      const disk = await readDisk(file);
      if (disk.text !== text || receipt.writtenDiskHash && receipt.writtenDiskHash !== disk.hash)
        throw conflict('文件已再次改变，不能把此次保存标记为成功');
      db.prepare('UPDATE rooms SET saved=?,disk=? WHERE epoch=?').run(version,disk.hash,epoch);
      // The provider receipt stays authoritative: live metadata is added under
      // its own names, so a provider version field is never overwritten.
      const live = roomFor(db,key);
      return {...receipt, epoch, liveVersion:(live||room).version, savedVersion:version, diskHash:disk.hash};
    }, this.directory, this.leaseOptions());
  }
  // Focus-time disk probe for live members: detect non-cooperating writes.
  // The snapshot and the adoption run under the same file-write lease as
  // save/external, so a cooperating window's commit can never fall between
  // the disk read and the room update — an interleaved save would otherwise
  // be adopted as a stale disk state and overwrite the newer room contents.
  async refresh(client, epoch) {
    const {key,file} = this.member(client,epoch);
    return withFileCommit(file, async () => {
      this.member(client,epoch);
      const disk = await readDisk(file);
      return atomic(this.db, () => {
        const room = roomFor(this.db,key);
        if (!room || room.epoch !== epoch) throw fault('MP_LIVE_SESSION','文档协同会话已结束，草稿已保留');
        if (room.disk === disk.hash) return {...head(room),changed:false};
        if (room.version !== room.saved) return {...head(room),changed:true,unsavedDraft:true};
        try { adoptDisk(this.db, room, disk); }
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
  leave(client) {
    const member = this.clients.get(client);
    if (!member) return;
    const db = this.db;
    atomic(db, () => {
      db.prepare('DELETE FROM clients WHERE id=? AND epoch=?').run(client,member.epoch);
      db.prepare('DELETE FROM rooms WHERE epoch=? AND NOT EXISTS(SELECT 1 FROM clients WHERE epoch=?)').run(member.epoch,member.epoch);
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
