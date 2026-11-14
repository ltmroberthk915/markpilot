// Save failure classification shared by the plugin host and documents service.
// Keep this module free of I/O and host-module imports so it can be tested
// before a DSH host exists.
//
// Provenance is deliberately WeakMap-based: an error object may be frozen, and
// a numeric SQLite result code alone is not proof that the failure came from
// this machine's collaboration store. Only apiSave() marks errors it knows came
// from the local live.save/live.external boundary and not from the writer.
'use strict';

export const SQLITE_CORRUPT_PRIMARY = 11;
export const SQLITE_NOTADB_PRIMARY = 26;
export const MP_STORE_CORRUPT = 'MP_STORE_CORRUPT';
export const LOCAL_LIVE_FAMILY = 'local-live';

const localLiveFailures = new WeakMap();
const providerWriterFailures = new WeakSet();

/** Primary SQLite result code, never the broad `ERR_SQLITE_ERROR` text. */
export function sqlitePrimaryCode(error) {
  const raw = Number(error?.sqliteCode ?? error?.errcode ?? error?.cause?.errcode);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.trunc(raw) & 0xff;
}

function validPhase(phase) {
  return phase === 'prewrite' || phase === 'writing' || phase === 'written' ? phase : null;
}

/** Mark an error thrown inside a writer callback: provider/file writer origin. */
export function markProviderWriterError(error) {
  if (error && typeof error === 'object') providerWriterFailures.add(error);
  return error;
}

export function isProviderWriterError(error) {
  if (!error || typeof error !== 'object') return false;
  if (providerWriterFailures.has(error)) return true;
  return !!(error.cause && typeof error.cause === 'object' && providerWriterFailures.has(error.cause));
}

/**
 * Mark an error thrown by a known local live.save/live.external call, outside
 * the provider writer callback. Never mutates the error; returns the same
 * object so the caller can rethrow it. A missing primary SQLite code means
 * there is no collaboration-store family to report.
 */
export function markLocalLiveSaveFailure(error, phase) {
  if (!error || typeof error !== 'object') return error;
  const primary = sqlitePrimaryCode(error);
  if (primary === null) return error;
  localLiveFailures.set(error, {
    family: LOCAL_LIVE_FAMILY,
    primary,
    phase: validPhase(phase),
  });
  return error;
}

export function localLiveSaveFailure(error) {
  if (!error || typeof error !== 'object') return null;
  const own = localLiveFailures.get(error);
  if (own) return own;
  return error.cause && typeof error.cause === 'object' ? localLiveFailures.get(error.cause) || null : null;
}

export function isLocalLiveCorruption(error) {
  const local = localLiveSaveFailure(error);
  return !!local && (local.primary === SQLITE_CORRUPT_PRIMARY || local.primary === SQLITE_NOTADB_PRIMARY);
}

/** Boundary helper: provider-writer errors never get the local-live marker. */
export function markLiveBoundaryFailure(error, phase) {
  if (isProviderWriterError(error)) return error;
  return markLocalLiveSaveFailure(error, phase);
}

/**
 * documents-service mapping. It only promotes the new family when the trusted
 * local-live marker is present; otherwise it preserves the existing mapping
 * (including the historical ERR_SQLITE -> MP_LIVE_BUSY fallback). It does not
 * translate a bare remote provider errcode into the local family.
 */
export function classifyStorageFailure(error) {
  const rawCode = error?.code || 'FS_IO_ERROR';
  const message = String(error?.message || error);
  const local = localLiveSaveFailure(error);
  const corruption = local && (local.primary === SQLITE_CORRUPT_PRIMARY || local.primary === SQLITE_NOTADB_PRIMARY);
  const code = corruption ? MP_STORE_CORRUPT
    : ((/SQLITE_BUSY|ERR_SQLITE/i.test(String(rawCode)) || /database is locked/i.test(message))
      ? 'MP_LIVE_BUSY' : rawCode);
  const result = { code };
  if (local && local.primary !== null) result.sqliteCode = local.primary;
  if (local && local.phase === 'prewrite') result.prewrite = true;
  else if (local && local.phase) result.writePhase = local.phase;
  if (local) result.storageFamily = LOCAL_LIVE_FAMILY;
  return result;
}
