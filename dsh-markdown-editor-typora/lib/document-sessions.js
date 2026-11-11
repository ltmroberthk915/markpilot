// P1 shadow: the only purpose of this module is to give the editor ONE
// read-only coordinate system over the existing authorities. It never writes,
// never creates a live room and never persists; documents-service remains the
// source of truth until P5 explicitly switches writes.
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_LIMIT = 256;

export function allowedActions(snapshot) {
  const state = String(snapshot?.state || "");
  if (state === "missing") return ["retry", "saveAs", "locate"];
  if (state === "conflict") return ["openConflict", "resolveConflict", "cancelConflict", "copy", "saveAs"];
  if (state === "orphan") return ["recover", "discardRecovery", "copy", "saveAs"];
  if (state === "owned-elsewhere" || state === "unsaved-elsewhere") return ["resolve", "copy", "saveAs"];
  if (state === "external") return ["reload", "copy", "saveAs"];
  if (state === "dirty") return ["save", "saveAs", "copy"];
  if (state === "clean" || state === "disk") return ["saveAs"];
  return [];
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
