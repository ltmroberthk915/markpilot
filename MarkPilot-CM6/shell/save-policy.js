'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarkPilotSavePolicy = api;
})(globalThis, function () {
  const DEFAULT_INTERVAL_MS = 30000, MIN_INTERVAL_MS = 1000, MAX_INTERVAL_MS = 3600000;
  function normalize(enabled, interval) {
    const n = Number(interval);
    return Object.freeze({ enabled: enabled === true,
      intervalMs: Number.isFinite(n) && n > 0 ? Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(n))) : DEFAULT_INTERVAL_MS });
  }
  return Object.freeze({ normalize, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS });
});
