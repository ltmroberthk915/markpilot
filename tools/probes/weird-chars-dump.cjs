/** 读数下钻：node weird-chars-dump.cjs <result.json> <caseId...>
 *  把指定用例的**完整原始读数**打出来（排查"到底是哪一步不对"时用，不替代判据）。 */
'use strict';
const fs = require('node:fs');
const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ids = process.argv.slice(3);
for (const r of (R.log || [])) {
  if (!ids.length || ids.includes(r.case) || ids.includes(r.id)) console.log(JSON.stringify(r, null, 1));
}
