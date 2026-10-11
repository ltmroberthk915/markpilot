/** 补丁 12：7.1 的"导出片段"改成与容器 dump **同一次快照**读取（第二次读曾读到不一致内容，
 *  疑似中途被重载/缓存 ⇒ 两次读同快照才能自洽）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('block1Text')) { console.log('· 已打过补丁'); process.exit(0); }
/* ① 在快照里加 block1Text */
const oldRet = "        dump: { block1: dumpBlock(b1, b1e), quoted: dumpBlock(q, qe), longBlock: dumpBlock(lb, lbe) },";
const newRet = "        dump: { block1: dumpBlock(b1, b1e), quoted: dumpBlock(q, qe), longBlock: dumpBlock(lb, lbe) },\n        block1Text: d.sliceString(d.line(b1).from, d.line(b1e).to),";
if (!t.includes(oldRet)) { console.log('✗ 没找到快照返回行'); process.exit(1); }
t = t.replace(oldRet, newRet);
/* ② 导出判据用快照里的文本 */
const oldMd4 = `      const md4 = (res7.block1[0] > 0 && res7.block1[1] > 0)
        ? await ev(([a, b]) => { const v = window.mpEngine._view(); const d = v.state.doc; return d.sliceString(d.line(a).from, d.line(b).to); }, [res7.block1[0], res7.block1[1]])
        : null;`;
const newMd4 = `      /* 用**同一次快照**里的块文本（早先第二次读曾读到与 dump 不一致的内容） */
      const md4 = (typeof r.block1Text === 'string' && r.block1Text) ? r.block1Text : null;`;
if (!t.includes(oldMd4)) { console.log('· 没找到 md4 行（可能已是新版）'); } else { t = t.replace(oldMd4, newMd4); }
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 7.1 导出片段改为同快照读取');
