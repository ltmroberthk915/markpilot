/** export-daily 族：把被测产物 app.asar 里的指定条目**原样导出**到 .mp-verify 下，供逐字节阅读/比对。
 *  只读产物、只写 .mp-verify。用法：node export-daily-asar-extract.cjs <asar> <outDir> <条目前缀...>
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ASAR = process.argv[2], OUT = process.argv[3];
const WANT = process.argv.slice(4);
const buf = fs.readFileSync(ASAR);
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const baseOffset = 8 + buf.readUInt32LE(4);
function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (v.files) walk(v, p, out); else out.push({ p, offset: Number(v.offset), size: v.size });
  }
  return out;
}
for (const f of walk(header, '', [])) {
  if (!WANT.some((w) => f.p === w || f.p.endsWith(w))) continue;
  const dst = path.join(OUT, f.p.replace(/\//g, '__'));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(dst, buf.slice(baseOffset + f.offset, baseOffset + f.offset + f.size));
  console.log(`✓ ${f.p} → ${dst} (${f.size} B)`);
}
