// P1 shadow: the only purpose of this module is to give the editor ONE
// read-only coordinate system over the existing authorities. It never writes,
// never creates a live room and never persists; documents-service remains the
// source of truth until P5 explicitly switches writes.
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_LIMIT = 256;

export function allowedActions(snapshot) {
  const state = String(snapshot?.state || "");
  const actions = [];
  if (state === "missing") actions.push("retry", "saveAs", "locate");
  else if (state === "conflict") actions.push("openConflict", "resolveConflict", "cancelConflict", "copy", "saveAs");
  else if (state === "orphan") actions.push("open", "resolve", "copy", "saveAs");
  else if (state === "owned-elsewhere" || state === "unsaved-elsewhere") actions.push("openConflict", "resolve", "copy", "saveAs");
  else if (state === "external") actions.push("reload", "copy", "saveAs");
  else if (state === "dirty") actions.push("save", "saveAs", "copy");
  else if (state === "readonly") actions.push("retry", "saveAs", "copy");
  else if (state === "clean" || state === "disk") actions.push("saveAs");
  if (Array.isArray(snapshot?.recovery) && snapshot.recovery.length && !actions.includes("recover")) actions.push("recover", "discardRecovery");
  if (Array.isArray(snapshot?.groups) && snapshot.groups.length && !actions.includes("reviewUndo")) actions.push("reviewUndo", "reviewKeep", "reviewDiff");
  return actions;
}

export function createSessionManager({ ttlMs = SESSION_TTL_MS, now = Date.now, limit = SESSION_LIMIT } = {}) {
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : SESSION_LIMIT;
  const cache = new Map();
  const fresh = (entry) => entry && now() - entry.at < ttlMs;
  return {
    get(key) {
      const entry = cache.get(key);
      if (!fresh(entry)) { if (entry) cache.delete(key); return null; }
      return entry.value;
    },
    async resolve(key, load) {
      const hit = this.get(key);
      if (hit) return hit;
      const value = await load();
      if (value === undefined) return undefined;
      cache.delete(key);
      cache.set(key, { at: now(), value });
      while (cache.size > max) cache.delete(cache.keys().next().value);
      return value;
    },
    clear(key) { if (key === undefined) cache.clear(); else cache.delete(key); },
    get size() { return cache.size; },
  };
}
