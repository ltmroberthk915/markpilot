'use strict';
/*
 * Reading-position store shared by the desktop host and the DSH plugin host.
 *
 * The store keeps only a viewport anchor per canonical document path:
 *   1-based source line, 0-based UTF-16 offset in that line, and the fraction
 *   of the line's visual box crossed by the viewport top edge.  It never stores
 *   document text, drafts, revisions or content hashes.
 *
 * Two independent rows per file (writer = desktop | plugin) plus short-lived
 * plugin sessions give the required precedence:
 *   - while a plugin page heartbeat is fresh for that exact file, a desktop
 *     write is refused and desktop reads see the plugin row;
 *   - when the plugin page exits (explicit release) or crashes (TTL expiry),
 *     the freshest row wins again, so the desktop's next real scroll takes over.
 *
 * The database is deliberately independent from live-v1/rooms.sqlite: saving,
 * the cross-process write reservation and draft recovery are not touched.
 *
 * All public calls are fail-soft for the editor.  A missing/corrupt store must
 * never prevent a document from opening or saving.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCHEMA_VERSION = '1';
const DEFAULT_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_POSITION_ROWS = 5000;
const MAX_SESSION_ROWS = 1024;
const MAX_PATH_CHARS = 32768;

const defaultDirectory = () => process.env.MP_READING_POSITION_DIR
  || path.join((process.platform === 'win32' && process.env.LOCALAPPDATA) || os.homedir(), '.markpilot', 'reading-v1');

const clampInt = (value, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) return null;
  return integer;
};

/** Anchor accepted from a host.  Values outside the safe ranges are rejected, never clamped silently. */
function normalizeAnchor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const line = clampInt(value.line, 1, 100000000);
  const ch = clampInt(value.ch, 0, 10000000);
  const fraction = Number(value.fraction);
  if (line === null || ch === null) return null;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  return { line, ch, fraction: Math.round(fraction * 1e6) / 1e6 };
}

/**
 * Canonical, case-stable key for a document path.
 * Windows keys are folded to lower case; existing files go through realpath so
 * junctions/symlinks and drive-letter case cannot create two identities.
 */
function canonicalPathKey(file) {
  const source = String(file == null ? '' : file);
  if (!source || source.length > MAX_PATH_CHARS) return null;
  let absolute;
  try { absolute = path.resolve(source); } catch { return null; }
  try { absolute = fs.realpathSync.native(absolute); }
  catch {
    try { absolute = fs.realpathSync(absolute); }
    catch { /* missing file after a rename: keep the lexical path */ }
  }
  try {
    const parsed = path.parse(absolute);
    if (absolute !== parsed.root) absolute = absolute.replace(/[\\/]+$/, '');
  } catch { /* keep as-is */ }
  if (process.platform === 'win32') absolute = absolute.toLowerCase();
  return absolute || null;
}

const validRole = role => role === 'desktop' || role === 'plugin';
const sessionIdOf = value => (typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null);
const finiteNow = value => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : Date.now());

class ReadingPositionStore {
  constructor({ directory = defaultDirectory(), busyTimeoutMs = 2000, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.directory = path.resolve(String(directory || defaultDirectory()));
    this.busyTimeoutMs = Math.max(50, Math.min(10000, Number(busyTimeoutMs) || 2000));
    this.ttlMs = Math.max(1000, Math.min(MAX_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
    this.db = null;
    this.lastError = null;
    this._saveCount = 0;
  }

  _open() {
    if (this.db) return this.db;
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'positions.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK(role IN ('desktop','plugin')),
          pid INTEGER NOT NULL,
          path_key TEXT,
          started_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          released_at INTEGER,
          ttl_ms INTEGER NOT NULL DEFAULT 60000
        );
        CREATE INDEX IF NOT EXISTS reading_sessions_path
          ON sessions(path_key, role, expires_at);
        CREATE TABLE IF NOT EXISTS positions (
          path_key TEXT NOT NULL,
          writer TEXT NOT NULL CHECK(writer IN ('desktop','plugin')),
          line INTEGER NOT NULL CHECK(line >= 1),
          ch INTEGER NOT NULL CHECK(ch >= 0),
          fraction REAL NOT NULL CHECK(fraction >= 0 AND fraction <= 1),
          seq INTEGER NOT NULL,
          sample_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          session_id TEXT,
          PRIMARY KEY(path_key, writer)
        );
        CREATE TABLE IF NOT EXISTS position_sessions (
          path_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          writer TEXT NOT NULL CHECK(writer IN ('desktop','plugin')),
          line INTEGER NOT NULL CHECK(line >= 1),
          ch INTEGER NOT NULL CHECK(ch >= 0),
          fraction REAL NOT NULL CHECK(fraction >= 0 AND fraction <= 1),
          seq INTEGER NOT NULL,
          sample_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(path_key, session_id)
        );
        CREATE INDEX IF NOT EXISTS reading_positions_session_updated
          ON position_sessions(path_key, updated_at DESC);
        CREATE INDEX IF NOT EXISTS reading_positions_updated
          ON positions(updated_at DESC);`);
      const row = db.prepare("SELECT value FROM meta WHERE key='schema'").get();
      if (!row) db.prepare("INSERT INTO meta(key,value) VALUES('schema',?)").run(SCHEMA_VERSION);
      else if (String(row.value) !== SCHEMA_VERSION)
        throw Object.assign(new Error('reading-position schema mismatch: ' + String(row.value)), { code: 'MP_READING_SCHEMA' });
      if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'released_at'))
        db.exec('ALTER TABLE sessions ADD COLUMN released_at INTEGER');
      if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'ttl_ms'))
        db.exec('ALTER TABLE sessions ADD COLUMN ttl_ms INTEGER NOT NULL DEFAULT 60000');
      if (!db.prepare('PRAGMA table_info(positions)').all().some(column => column.name === 'sample_at'))
        db.exec('ALTER TABLE positions ADD COLUMN sample_at INTEGER NOT NULL DEFAULT 0');
      // Upgrade legacy one-row-per-writer data into per-session rows.  Each
      // browser page/window then owns an independent position row.
      try {
        const legacy = db.prepare('SELECT path_key,writer,line,ch,fraction,seq,updated_at,sample_at,session_id FROM positions').all();
        const insert = db.prepare(`INSERT OR IGNORE INTO position_sessions
          (path_key,session_id,writer,line,ch,fraction,seq,sample_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const row of legacy)
          insert.run(row.path_key, row.session_id || ('legacy:' + row.writer), row.writer,
            row.line, row.ch, row.fraction, row.seq, row.sample_at || 0, row.updated_at);
      } catch { /* legacy table absent/corrupt: new writes still work */ }
      if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
      this.db = db;
      this.lastError = null;
      return db;
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  _fail(error) {
    this.lastError = String((error && error.message) || error);
    return this.lastError;
  }

  /** Register or refresh a host session.  A plugin session is what gives the plugin priority for one file. */
  begin({ id, role, path: filePath, pid = process.pid, ttlMs = this.ttlMs, now } = {}) {
    const sessionId = sessionIdOf(id);
    if (!sessionId || !validRole(role)) return { ok: false, reason: 'invalid-session' };
    const pathKey = canonicalPathKey(filePath);
    if (!pathKey) return { ok: false, reason: 'invalid-path' };
    const time = finiteNow(now);
    const ttl = Math.max(1000, Math.min(MAX_TTL_MS, Number(ttlMs) || this.ttlMs));
    const expiresAt = time + ttl;
    try {
      const db = this._open();
      // A plugin session is one browser page incarnation.  Once released or
      // expired it must never be resurrected by a late request; a reopen gets a
      // new session id from the client.  Desktop window sessions may refresh.
      const previous = db.prepare('SELECT role,released_at,expires_at FROM sessions WHERE id=?').get(sessionId);
      if (role === 'plugin' && previous &&
          (previous.released_at != null || previous.expires_at < time))
        return { ok: false, reason: 'stale-session' };
      db.prepare(`INSERT INTO sessions(id,role,pid,path_key,started_at,heartbeat_at,expires_at,released_at,ttl_ms)
        VALUES(?,?,?,?,?,?,?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET role=excluded.role,pid=excluded.pid,path_key=excluded.path_key,
          heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at,released_at=NULL,ttl_ms=excluded.ttl_ms`)
        .run(sessionId, role, Number.isSafeInteger(pid) ? pid : process.pid, pathKey, time, time, expiresAt, ttl);
      this._pruneSessions(db, time);
      return { ok: true, sessionId, role, pathKey, expiresAt };
    } catch (error) {
      return { ok: false, reason: 'unavailable', error: this._fail(error) };
    }
  }

  touch({ id, path: filePath = undefined, ttlMs = this.ttlMs, now } = {}) {
    const sessionId = sessionIdOf(id);
    if (!sessionId) return { ok: false, reason: 'invalid-session' };
    const time = finiteNow(now);
    const ttl = Math.max(1000, Math.min(MAX_TTL_MS, Number(ttlMs) || this.ttlMs));
    const expiresAt = time + ttl;
    const pathKey = filePath === undefined ? undefined : canonicalPathKey(filePath);
    if (filePath !== undefined && !pathKey) return { ok: false, reason: 'invalid-path' };
    try {
      const db = this._open();
      const row = db.prepare('SELECT role,path_key,released_at,expires_at FROM sessions WHERE id=?').get(sessionId);
      if (!row || row.role !== 'plugin' || row.released_at != null || row.expires_at < time)
        return { ok: false, reason: 'stale-session' };
      if (pathKey !== undefined && row.path_key && row.path_key !== pathKey)
        return { ok: false, reason: 'stale-session' };
      const changes = pathKey === undefined
        ? db.prepare('UPDATE sessions SET heartbeat_at=?, expires_at=? WHERE id=?').run(time, expiresAt, sessionId).changes
        : db.prepare('UPDATE sessions SET path_key=?, heartbeat_at=?, expires_at=? WHERE id=?').run(pathKey, time, expiresAt, sessionId).changes;
      if (!changes) return { ok: false, reason: 'stale-session' };
      this._pruneSessions(db, time);
      return { ok: true, sessionId, pathKey: pathKey ?? null, expiresAt };
    } catch (error) {
      return { ok: false, reason: 'unavailable', error: this._fail(error) };
    }
  }

  /** True only for a live, unreleased plugin session bound to this exact file. */
  activeSession(id, filePath, { now } = {}) {
    const sessionId = sessionIdOf(id);
    const pathKey = canonicalPathKey(filePath);
    if (!sessionId || !pathKey) return false;
    try {
      const db = this._open();
      const row = db.prepare(`SELECT 1 AS hit FROM sessions
        WHERE id=? AND role='plugin' AND path_key=? AND released_at IS NULL AND expires_at>=?`)
        .get(sessionId, pathKey, finiteNow(now));
      return !!row;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  end(id, { now } = {}) {
    const sessionId = sessionIdOf(id);
    if (!sessionId) return { ok: false, reason: 'invalid-session' };
    try {
      const db = this._open();
      const time = finiteNow(now);
      const row = db.prepare('SELECT role FROM sessions WHERE id=?').get(sessionId);
      if (!row) {
        // A release may beat the first register on a fast close.  Leave a
        // tombstone so the late register cannot create a fresh plugin lease.
        db.prepare(`INSERT INTO sessions(id,role,pid,path_key,started_at,heartbeat_at,expires_at,released_at,ttl_ms)
          VALUES(?,'plugin',?,NULL,?,?,?,?,?)`)
          .run(sessionId, process.pid, time, time, time, time, Math.max(1000, Number(this.ttlMs) || 60000));
        return { ok: true, removed: false, released: true, gate: time };
      }
      if (row.role === 'plugin') {
        // Keep the released row as the gate: a desktop sample captured before
        // this release must not become the new owner afterwards.
        db.prepare('UPDATE sessions SET released_at=?, heartbeat_at=? WHERE id=?').run(time, time, sessionId);
        this._pruneSessions(db, time);
        return { ok: true, removed: true, released: true, gate: time };
      }
      const changes = db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId).changes;
      return { ok: true, removed: changes > 0 };
    } catch (error) {
      return { ok: false, reason: 'unavailable', error: this._fail(error) };
    }
  }

  activePlugin(filePath, { now } = {}) {
    const pathKey = canonicalPathKey(filePath);
    if (!pathKey) return false;
    try {
      const db = this._open();
      const time = finiteNow(now);
      const row = db.prepare("SELECT 1 AS hit FROM sessions WHERE path_key=? AND role='plugin' AND released_at IS NULL AND expires_at>=? LIMIT 1").get(pathKey, time);
      return !!row;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  /**
   * Persist one anchor.  A desktop write is refused while a fresh plugin page
   * owns the same file; the refusal is an expected result, not an error.
   */
  save({ path: filePath, role, sessionId, anchor, seq = 0, sampleAt: requestedSampleAt, now } = {}) {
    if (!validRole(role)) return { stored: false, reason: 'invalid-role' };
    const pathKey = canonicalPathKey(filePath);
    if (!pathKey) return { stored: false, reason: 'invalid-path' };
    const normalized = normalizeAnchor(anchor);
    if (!normalized) return { stored: false, reason: 'invalid-anchor' };
    const time = finiteNow(now);
    const sequence = clampInt(seq, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const session = sessionIdOf(sessionId);
    const rawSample = Number(requestedSampleAt);
    const sampleAt = Number.isFinite(rawSample) && rawSample > 0
      ? Math.max(time - 10 * 60 * 1000, Math.min(time + 5000, Math.trunc(rawSample)))
      : time;
    try {
      const db = this._open();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (role === 'plugin') {
          const row = session ? db.prepare("SELECT path_key,released_at,expires_at FROM sessions WHERE id=? AND role='plugin'")
            .get(session) : null;
          if (!row || row.released_at != null || row.expires_at < time || row.path_key !== pathKey) {
            db.exec('ROLLBACK');
            return { stored: false, reason: 'session-stale', writer: 'plugin' };
          }
        }
        if (role === 'desktop') {
          const plugin = db.prepare("SELECT 1 AS hit FROM sessions WHERE path_key=? AND role='plugin' AND released_at IS NULL AND expires_at>=? LIMIT 1")
            .get(pathKey, time);
          if (plugin) {
            db.exec('ROLLBACK');
            return { stored: false, reason: 'plugin-active', writer: 'desktop' };
          }
          const plate = db.prepare(`SELECT MAX(CASE WHEN released_at IS NULL THEN expires_at ELSE released_at END) AS gate
            FROM sessions WHERE path_key=? AND role='plugin'`).get(pathKey);
          const gate = Number(plate && plate.gate) || 0;
          if (sampleAt <= gate) {
            db.exec('ROLLBACK');
            return { stored: false, reason: 'gate', gate, writer: 'desktop' };
          }
        }
        const paused = role === 'plugin' && session
          ? db.prepare("UPDATE sessions SET heartbeat_at=?, expires_at=MAX(expires_at, ? + ttl_ms) WHERE id=? AND role='plugin'")
            .run(time, time, session).changes
          : 0;
        const rowSession = session || ('anonymous:' + role);
        const existingSession = db.prepare('SELECT 1 AS hit FROM position_sessions WHERE path_key=? AND session_id=?')
          .get(pathKey, rowSession);
        if (!existingSession) {
          const newest = db.prepare('SELECT MAX(sample_at) AS sample FROM position_sessions WHERE path_key=?').get(pathKey);
          if (newest && Number(newest.sample) > sampleAt) {
            db.exec('ROLLBACK');
            return { stored: false, reason: 'stale', writer: role, sampleAt };
          }
        }
        // One row per page/window incarnation: a fresh session may legitimately
        // start again at seq 1.  Within one incarnation seq stays monotonic and
        // the event sample must not go backwards, regardless of commit time.
        const result = db.prepare(`INSERT INTO position_sessions
          (path_key,session_id,writer,line,ch,fraction,seq,sample_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(path_key,session_id) DO UPDATE SET
            writer=excluded.writer, line=excluded.line, ch=excluded.ch, fraction=excluded.fraction,
            seq=excluded.seq, sample_at=excluded.sample_at, updated_at=excluded.updated_at
          WHERE excluded.seq >= position_sessions.seq AND excluded.sample_at >= position_sessions.sample_at`)
          .run(pathKey, rowSession, role, normalized.line, normalized.ch, normalized.fraction,
            sequence, sampleAt, time);
        db.exec('COMMIT');
        this._saveCount += 1;
        if (this._saveCount % 64 === 0) this._trimPositions(db);
        return { stored: result.changes > 0, reason: result.changes > 0 ? null : 'stale', writer: role,
          updatedAt: time, sampleAt, seq: sequence, sessionId: rowSession, refreshedSession: paused > 0 };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
    } catch (error) {
      return { stored: false, reason: 'unavailable', error: this._fail(error) };
    }
  }

  /** Read the anchor that both hosts should restore for this file. */
  load({ path: filePath, sessionId: requestSession = null, now } = {}) {
    const pathKey = canonicalPathKey(filePath);
    if (!pathKey) return { anchor: null, writer: null, updatedAt: 0, pluginActive: false, reason: 'invalid-path' };
    const time = finiteNow(now);
    try {
      const db = this._open();
      this._pruneSessions(db, time);
      const active = db.prepare("SELECT id FROM sessions WHERE path_key=? AND role='plugin' AND released_at IS NULL AND expires_at>=?")
        .all(pathKey, time);
      const activeIds = new Set(active.map(row => row.id));
      const gateRow = db.prepare(`SELECT MAX(CASE WHEN released_at IS NULL THEN expires_at ELSE released_at END) AS gate
        FROM sessions WHERE path_key=? AND role='plugin'`).get(pathKey);
      const gate = Number(gateRow && gateRow.gate) || 0;
      const columns = 'line,ch,fraction,writer,updated_at,sample_at,session_id';
      // Loading is a pure freshness read over every sample the store actually
      // accepted.  A live plugin lease gates *writes* (desktop is still
      // rejected), but an older row from that active session must not outrank a
      // newer accepted plugin/desktop sample.  Equal event times prefer plugin,
      // then seq, then commit time.
      const row = db.prepare(`SELECT ${columns} FROM position_sessions WHERE path_key=?
        ORDER BY sample_at DESC,
          CASE writer WHEN 'plugin' THEN 0 ELSE 1 END,
          seq DESC, updated_at DESC, rowid DESC LIMIT 1`).get(pathKey) || null;
      return {
        anchor: row ? { line: row.line, ch: row.ch, fraction: row.fraction } : null,
        writer: row ? row.writer : null,
        updatedAt: row ? row.updated_at : 0,
        sampleAt: row ? row.sample_at : 0,
        sessionId: row ? row.session_id : null,
        pluginActive: activeIds.size > 0,
        gate,
        ok: true,
      };
    } catch (error) {
      return { anchor: null, writer: null, updatedAt: 0, pluginActive: false, reason: 'unavailable', error: this._fail(error) };
    }
  }

  _pruneSessions(db, now) {
    // Released/expired plugin rows are kept for a day: their gate prevents a
    // pre-release desktop sample from owning the file after the plugin exits.
    db.prepare('DELETE FROM sessions WHERE (released_at IS NOT NULL AND released_at < ?) OR expires_at < ?')
      .run(now - 24 * 60 * 60 * 1000, now - 24 * 60 * 60 * 1000);
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    if (count > MAX_SESSION_ROWS)
      db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY heartbeat_at ASC LIMIT ?)')
        .run(count - MAX_SESSION_ROWS);
  }

  _trimPositions(db) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM position_sessions').get().n;
    if (count <= MAX_POSITION_ROWS) return;
    db.prepare('DELETE FROM position_sessions WHERE rowid IN (SELECT rowid FROM position_sessions ORDER BY updated_at ASC LIMIT ?)')
      .run(count - MAX_POSITION_ROWS);
  }

  /** Test/diagnostic snapshot; never used on the editor hot path. */
  inspect({ path: filePath } = {}) {
    if (!this.db) return { open: false, directory: this.directory };
    const pathKey = filePath === undefined ? null : canonicalPathKey(filePath);
    const sessions = pathKey
      ? this.db.prepare('SELECT id,role,pid,path_key,heartbeat_at,expires_at FROM sessions WHERE path_key=?').all(pathKey)
      : this.db.prepare('SELECT id,role,pid,path_key,heartbeat_at,expires_at FROM sessions').all();
    const positions = pathKey
      ? this.db.prepare('SELECT * FROM position_sessions WHERE path_key=?').all(pathKey)
      : this.db.prepare('SELECT * FROM position_sessions').all();
    return { open: true, directory: this.directory, sessions, positions, lastError: this.lastError };
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch { /* ignore */ }
    this.db = null;
  }
}

module.exports = {
  ReadingPositionStore,
  canonicalPathKey,
  normalizeAnchor,
  defaultDirectory,
  DEFAULT_TTL_MS,
  SCHEMA_VERSION,
};
