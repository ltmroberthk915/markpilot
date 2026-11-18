/*
 * Host-neutral reading-position client (desktop renderer + DSH iframe bridge).
 *
 * The engine owns capture/restore; this coordinator owns the page lifecycle:
 *   attach(path, documentId) -> arm engine -> load anchor -> apply (restore only)
 *   engine emits a user-scroll anchor -> coalesced save through the host
 *   pagehide/visibility-hidden -> synchronous flush when the host supports it
 *   document switch/teardown -> flush + release the host session
 *
 * Stale loads are rejected by a per-attach sequence; a restore is attempted
 * only once page content is applied, never after the user already scrolled.
 * The module is loadable as a classic script (window.MPReadingClient) and as
 * CommonJS for the isolated tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPReadingClient = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createReadingClient({
    getEngine,
    load,
    save,
    flush,
    release,
    touch,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    onError = () => {},
  } = {}) {
    const engineOf = () => { try { return getEngine ? getEngine() : null; } catch { return null; } };
    let state = emptyState();
    let sequence = 0;
    let unsubscribe = null;
    let saveFlight = null;
    let saveQueued = null;
    let saveSeq = 0;
    let heartbeatTimer = null;

    function emptyState() {
      return { phase: 'idle', path: null, documentId: null, anchor: null, pluginActive: false,
        lastSave: null, lastError: null, loadResult: null, heartbeat: 0 };
    }

    function report(error) {
      try { onError(error); } catch { /* host logging must not break the editor */ }
    }

    function bindEngine() {
      const engine = engineOf();
      if (!engine || typeof engine.onReadingPositionChange !== 'function') return false;
      if (unsubscribe) return true;
      try {
        unsubscribe = engine.onReadingPositionChange(payload => {
          if (state.phase !== 'armed') return;
          if (!payload || !payload.anchor) return;
          state.anchor = payload.anchor;
          queueSave(payload.anchor, payload.reason || 'scroll', payload.seq || 0, payload.at || 0);
        });
      } catch (error) { report(error); return false; }
      return true;
    }

    function unbindEngine() {
      if (!unsubscribe) return;
      try { unsubscribe(); } catch { /* engine may be gone */ }
      unsubscribe = null;
    }

    function armEngine() {
      const engine = engineOf();
      if (!engine) return false;
      try {
        if (typeof engine.armReadingPosition === 'function') return engine.armReadingPosition() !== false;
      } catch (error) { report(error); }
      return false;
    }

    function stopTimers() {
      if (heartbeatTimer !== null) { clearTimer(heartbeatTimer); heartbeatTimer = null; }
    }

    function startHeartbeat() {
      if (typeof touch !== 'function' || heartbeatTimer !== null) return;
      heartbeatTimer = setTimer(function beat() {
        heartbeatTimer = null;
        if (state.phase === 'idle' || !state.path) return;
        const at = { path: state.path, documentId: state.documentId };
        Promise.resolve().then(() => touch(at)).catch(error => report(error)).finally(() => {
          if (state.phase !== 'idle' && state.path) {
            state.heartbeat += 1;
            heartbeatTimer = setTimer(beat, 20000);
          }
        });
      }, 20000);
    }

    function queueSave(anchor, reason, engineSeq, sampleAt) {
      if (!state.path || state.phase === 'idle') return;
      const payload = {
        path: state.path, documentId: state.documentId, anchor,
        seq: Math.max(++saveSeq, Number.isSafeInteger(engineSeq) ? engineSeq : 0),
        sampleAt: Number.isFinite(sampleAt) && sampleAt > 0 ? sampleAt : now(),
        reason,
      };
      if (saveFlight) { saveQueued = payload; return; }
      sendSave(payload);
    }

    function sendSave(payload) {
      if (typeof save !== 'function') return;
      saveFlight = Promise.resolve()
        .then(() => save(payload))
        .then(result => {
          if (result && result.ok === false && result.error) report(result.error);
          if (result && result.value && result.value.stored === false && result.value.reason === 'plugin-active')
            state.pluginActive = true;
          state.lastSave = result && result.value ? result.value : result || null;
          return result;
        })
        .catch(error => { report(error); return { ok: false, error: String(error && error.message || error) }; })
        .finally(() => {
          saveFlight = null;
          const next = saveQueued;
          saveQueued = null;
          if (next) sendSave(next);
        });
    }

    function applyAnchor(anchor) {
      const engine = engineOf();
      if (!engine || typeof engine.applyReadingPosition !== 'function') return Promise.resolve({ ok: false, reason: 'engine-unavailable' });
      return Promise.resolve()
        .then(() => engine.applyReadingPosition(anchor))
        .then(result => {
          if (result && result.ok === true) {
            state.anchor = result.anchor || anchor;
            state.phase = 'armed';
            armEngine();
            return result;
          }
          state.phase = 'armed';
          armEngine();
          return result || { ok: false, reason: 'restore-rejected' };
        })
        .catch(error => { report(error); state.phase = 'armed'; armEngine(); return { ok: false, reason: 'restore-error' }; });
    }

    /**
     * Attach one document generation.  `restore:false` arms capture without
     * asking the host for a stored anchor (same-document reload).
     */
    function attach({ path, documentId, restore = true } = {}) {
      sequence += 1;
      const token = sequence;
      stopTimers();
      unbindEngine();
      state = { ...emptyState(), path: path || null, documentId: documentId || null };
      if (!path) return Promise.resolve({ ok: true, idle: true });
      bindEngine();
      armEngine();
      startHeartbeat();
      if (!restore) { state.phase = 'armed'; return Promise.resolve({ ok: true, restored: false }); }
      state.phase = 'loading';
      return Promise.resolve()
        .then(() => (typeof load === 'function' ? load({ path, documentId }) : null))
        .then(result => {
          if (token !== sequence || state.phase === 'idle') return { ok: false, reason: 'stale' };
          state.loadResult = result || null;
          state.pluginActive = !!(result && result.pluginActive);
          if (result && result.anchor) return applyAnchor(result.anchor);
          state.phase = 'armed';
          armEngine();
          return { ok: true, restored: false };
        })
        .catch(error => {
          report(error);
          if (token !== sequence) return { ok: false, reason: 'stale' };
          state.phase = 'armed';
          armEngine();
          return { ok: false, error: String(error && error.message || error) };
        });
    }

    /** Apply a host-provided anchor after an already-armed attach. */
    function restoreAnchor(anchor) {
      if (!anchor || state.phase === 'idle') return Promise.resolve({ ok: false, reason: 'idle' });
      if (state.phase !== 'armed') return Promise.resolve({ ok: false, reason: 'not-armed' });
      state.phase = 'loading';
      return applyAnchor(anchor);
    }

    /** Final capture for normal close; `sync` uses the host's sendSync path. */
    function flushNow(reason = 'flush', { sync = false } = {}) {
      const engine = engineOf();
      if (!engine) return null;
      let captured = null;
      try {
        if (typeof engine.flushReadingPosition === 'function') captured = engine.flushReadingPosition();
      } catch (error) { report(error); }
      const anchor = captured && captured.anchor ? captured.anchor : captured;
      if (!anchor || !state.path) return null;
      const payload = { path: state.path, documentId: state.documentId, anchor,
        seq: ++saveSeq, sampleAt: (captured && captured.at) || now(), reason };
      try {
        if (sync && typeof flush === 'function') return flush(payload);
        if (typeof save === 'function') { sendSave(payload); return payload; }
      } catch (error) { report(error); }
      return payload;
    }

    function releaseSession() {
      stopTimers();
      if (typeof release !== 'function' || !state.path) return;
      try { Promise.resolve(release({ path: state.path, documentId: state.documentId })).catch(error => report(error)); }
      catch (error) { report(error); }
    }

    function detach({ flush: doFlush = true, release: doRelease = true } = {}) {
      const active = state.phase !== 'idle' || !!state.path;
      if (!active) return;
      if (doFlush) flushNow('detach', { sync: true });
      stopTimers();
      unbindEngine();
      if (doRelease) releaseSession();
      sequence += 1;
      state = emptyState();
    }

    return {
      attach,
      restore: restoreAnchor,
      flush: flushNow,
      detach,
      inspect: () => ({ ...state, saveSeq, hasUnsubscribe: !!unsubscribe, hasSaveFlight: !!saveFlight }),
    };
  }

  return { createReadingClient };
});
