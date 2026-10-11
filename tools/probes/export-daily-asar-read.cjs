/** export-daily 族：从**被测产物**（win-unpacked/resources/app.asar）里读渲染侧真实代码片段。
 *  目的：确认"源码读到的行为"与"产物里跑的行为"一致（AGENTS 错-1 的对偶：不许拿另一份代码当读数）。
 *  只读，不写产品目录。
 *  用法：node export-daily-asar-read.cjs <asar路径> <needle...>
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ASAR = process.argv[2];
const NEEDLES = process.argv.slice(3);
if (!ASAR || !NEEDLES.length) { console.error('用法：node export-daily-asar-read.cjs <asar> <needle...>'); process.exit(2); }

const buf = fs.readFileSync(ASAR);
/* asar 头：pickle 格式。前 4 字节 uint32=4，接着 uint32 = header pickle size，再 uint32 = header json 长度… */
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const baseOffset = 8 + buf.readUInt32LE(4);   // 数据区起点

/** 按 header.files 递归找文件在 asar 里的 [offset,size) */
function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (v.files) walk(v, p, out);
    else out.push({ p, offset: Number(v.offset), size: v.size });
  }
  return out;
}
const files = walk(header, '', []);
console.log('[asar] 条目数=' + files.length);

const targets = files.filter((f) => /\.(js|html|json|css)$/i.test(f.p) && f.size > 200);
for (const needle of NEEDLES) {
  let hits = 0;
  for (const f of targets) {
    const text = buf.slice(baseOffset + f.offset, baseOffset + f.offset + f.size).toString('utf8');
    let idx = -1;
    while ((idx = text.indexOf(needle, idx + 1)) !== -1) {
      hits++;
      const a = Math.max(0, idx - 260), b = Math.min(text.length, idx + 260);
      console.log(`\n===== ${needle} @ ${f.p} #${hits} (off ${idx}) =====`);
      console.log(text.slice(a, b).replace(/\s+/g, ' '));
      if (hits >= 6) break;
    }
    if (hits >= 6) break;
  }
  console.log(`\n[${needle}] 命中 ${hits} 处（上限 6）`);
}
