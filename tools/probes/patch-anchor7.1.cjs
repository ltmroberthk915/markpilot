/** 补丁 5（Lead 2026-10-09 指示）：§7.1 的锚点**在文档里搜围栏拿**，不再靠清单行号算（`-1` 会一路污染到 page.evaluate）；
 *  拿不到就早退成"未验证"，不让 RangeError 冒到外层。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');

if (t.includes('RES7_ANCHORS')) { console.log('· 已打过锚点补丁'); process.exit(0); }

/* 1) 在 7.1 段开头插入"页内解析锚点" */
const anchorMarker = "  /* ══════════ 7.1 代码块行号 ══════════ */\n  if (want('7.1')) {";
if (!t.includes(anchorMarker)) { console.log('✗ 没找到 7.1 段开头'); process.exit(1); }
const resolver = `${anchorMarker}
    /* RES7_ANCHORS：在**文档里**搜围栏行解析锚点（不再靠清单行号算；算错成 -1 会一路污染到 page.evaluate）。
       解析不到 ⇒ res7.ok=false ⇒ 与锚点相关的检查点判"未验证"，绝不抛 RangeError。 */
    const res7 = await ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const lines = [];
      for (let n = 1; n <= d.lines; n++) lines.push(d.line(n).text);
      const hIdx = lines.findIndex((x) => x.startsWith('### 7.1 '));
      const endIdx = (() => { for (let i = hIdx + 1; i < lines.length; i++) if (/^### /.test(lines[i])) return i; return lines.length; })();
      const inSec = (i) => hIdx >= 0 && i > hIdx && i < endIdx;
      const plain = [], quoted = [], inline = [];
      for (let i = 0; i < lines.length; i++) {
        if (!inSec(i)) continue;
        const x = lines[i];
        if (/^\\s*\`\`\`/.test(x) || /^\\s*~~~/.test(x)) { if (/^\\s*>/.test(x)) quoted.push(i + 1); else plain.push(i + 1); }
        if (x.includes('行内代码对照：')) inline.push(i + 1);
      }
      const pick = (arr, k) => (arr.length > k ? arr[k] : -1);
      return {
        ok: hIdx >= 0 && plain.length >= 5 && quoted.length >= 2,
        heading: hIdx + 1, plain, quoted, inline,
        block1: [pick(plain, 0), pick(plain, 1)],
        longBlock: [pick(plain, 2), pick(plain, 3)],
        quotedPair: [pick(quoted, 0), pick(quoted, 1)],
        inlineCodeLine: pick(inline, 0),
        plainCount: plain.length, quotedCount: quoted.length,
      };
    });
    const res7Msg = \`页内解析：7.1 段在第 \${res7.heading} 行；普通围栏 \${res7.plainCount} 条、引用区围栏 \${res7.quotedCount} 条；普通块=\${JSON.stringify(res7.block1)}、引用块=\${JSON.stringify(res7.quotedPair)}、长行块=\${JSON.stringify(res7.longBlock)}、行内代码行=\${res7.inlineCodeLine}\`;
    console.log('  · ' + res7Msg);
    if (!res7.ok) {
      judge('7.1', 'codeLineNumbers', null, '未验证：' + res7Msg + ' ⇒ 锚点解析不到（清单夹具行没在文档里定位到）', '');
      judge('7.1', 'codeLineNumbers:style', null, '未验证：同上（锚点解析不到）', '');
    } else {`;
t = t.replace(anchorMarker, resolver);

/* 2) 锚点引用改成 res7（并给 7.1 段收尾补一个 else 的右括号由后续补丁处理） */
t = t.replace(/anchor\['7\.1'\]\.block1\[0\]/g, 'res7.block1[0]');
t = t.replace(/anchor\['7\.1'\]\.block1\[1\]/g, 'res7.block1[1]');
t = t.replace(/anchor\['7\.1'\]\.quoted\[0\]/g, 'res7.quotedPair[0]');
t = t.replace(/anchor\['7\.1'\]\.quoted\[1\]/g, 'res7.quotedPair[1]');
t = t.replace(/anchor\['7\.1'\]\.longBlock\[0\]/g, 'res7.longBlock[0]');
t = t.replace(/anchor\['7\.1'\]\.longBlock\[1\]/g, 'res7.longBlock[1]');
t = t.replace(/anchor\['7\.1'\]\.inlineCodeLine/g, 'res7.inlineCodeLine');

fs.writeFileSync(p, t, 'utf8');
console.log('✓ 已插入页内锚点解析与 res7 替换（还需手工补 else 收尾，见下一步）');
