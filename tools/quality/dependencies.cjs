'use strict';
function playwright() {
  if (process.env.MP_PLAYWRIGHT) return require(process.env.MP_PLAYWRIGHT);
  try { return require('playwright-core'); }
  catch { throw new Error('Install test dependencies: npm ci --prefix tools/quality (or set MP_PLAYWRIGHT)'); }
}
module.exports = { playwright };
