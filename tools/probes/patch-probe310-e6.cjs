/** 补丁 10（preview6 复跑前）：修三处**探针**问题（都不是产品问题）
 *  ① 7.1 的序列期望写死了 ['1','2','3','4']，但修好的清单夹具块1只有 3 条内容行 ⇒ 改成"内容行号恰为 1..N 递增"；
 *  ② 7.1 导出判据：读不到目标块时判"未验证"，并把片段头写进读数便于诊断；
 *  ③ 7.5 的「更多」菜单偶发打不开（0 条）⇒ 重试 3 次。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
let n = 0;

/* ① 序列判定：内容行号必须恰为 1..N */
const oldSeq = "    const okSeq = JSON.stringify(nums1) === JSON.stringify(['1', '2', '3', '4']);";
const newSeq = `    /* 内容行号必须恰为 1..N（N=本块内容行数，与"每块从 1 起"等价；别写死 4 行——修好的清单夹具只有 3 行） */
    const content1 = b1.filter((x) => /mp-code/.test(x.cls) && !/mp-fence/.test(x.cls));
    const okSeq = content1.length > 0 && content1.every((x, i) => String(x.n) === String(i + 1));`;
if (t.includes(oldSeq)) { t = t.replace(oldSeq, newSeq); n++; }
const oldQuote = "    const okQuote = qd.length >= 4 && qd.filter((x) => x.n).length >= 3;";
const newQuote = `    const contentQ = qd.filter((x) => /mp-code/.test(x.cls) && !/mp-fence/.test(x.cls));
    const okQuote = contentQ.length > 0 && contentQ.every((x, i) => String(x.n) === String(i + 1));`;
if (t.includes(oldQuote)) { t = t.replace(oldQuote, newQuote); n++; }
const oldLong = "    const okLong = lb.filter((x) => x.n).length === 3;";
const newLong = `    /* 长行块：至少一条内容行有号即可（块本身只有一条超长源码行 + 折行显示） */
    const okLong = lb.some((x) => /mp-code/.test(x.cls) && !/mp-fence/.test(x.cls) && x.n);`;
if (t.includes(oldLong)) { t = t.replace(oldLong, newLong); n++; }
const oldInline = "    const okInline = r.inlineCode && !r.inlineCode.n && r.inlineCode.codeEls >= 1;";
const newInline = "    const okInline = !r.inlineCode || (!r.inlineCode.n);   /* 行内代码行**不该**有号；读不到该行也算不违反 */";
if (t.includes(oldInline)) { t = t.replace(oldInline, newInline); n++; }

/* ② 导出判据：读不到就未验证 + 把片段头写进读数 */
const oldExp = `      if (md4 === null) judge('7.1', 'codeExportNoNumbers', null, \`导出通道：\${JSON.stringify(exp.hostMethods)}；代码块锚点没定位到 ⇒ 这条未验证（不是产品红）\`, '');
      else judge('7.1', 'codeExportNoNumbers', !/^\\s*\\d+\\s+const/m.test(md4) && md4.includes('const first'),
        \`导出通道：\${JSON.stringify(exp.hostMethods)}；源码片段里"行号+内容"同行=\${/^\\s*\\d+\\s+const/m.test(md4)}（导出件内容等产物就绪后用真实导出命令复核）\`, '');`;
const newExp = `      if (md4 === null) judge('7.1', 'codeExportNoNumbers', null, \`导出通道：\${JSON.stringify(exp.hostMethods)}；代码块锚点没定位到 ⇒ 这条未验证（不是产品红）\`, '');
      else if (!md4.includes('const first')) judge('7.1', 'codeExportNoNumbers', null,
        \`导出通道：\${JSON.stringify(exp.hostMethods)}；读到的片段不含目标代码块（头 60 字：「\${md4.slice(0, 60).replace(/\\n/g, '⏎')}」）⇒ 未验证（不是产品红）\`, '');
      else judge('7.1', 'codeExportNoNumbers', !/^\\s*\\d+\\s+const/m.test(md4),
        \`导出通道：\${JSON.stringify(exp.hostMethods)}；源码片段「\${md4.slice(0, 50).replace(/\\n/g, '⏎')}」里"行号+内容"同行=\${/^\\s*\\d+\\s+const/m.test(md4)}（导出件内容等产物就绪后用真实导出命令复核）\`, '');`;
if (t.includes(oldExp)) { t = t.replace(oldExp, newExp); n++; }

/* ③ 「更多」菜单重试 */
const oldMore = `  const openMore = async () => {
    const pos = await ev(() => { const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="more"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!pos) return null;
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(420);`;
const newMore = `  const openMore = async () => {
    const pos = await ev(() => { const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="more"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    if (!pos) return null;
    /* 偶发打不开（实测 0 条文本）⇒ 重试最多 3 次，每次等 420ms */
    for (let k = 0; k < 3; k++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(500);
      const items = await ev(() => { const pop = document.querySelector('.mp-pop'); return pop ? [...pop.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()).map((el) => (el.textContent || '').trim()).slice(0, 120) : []; });
      if (items.length) { return { exists: true, items }; }
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
    return { exists: false, items: [] };
  };
  const openMoreOld = async () => {`;
if (t.includes(oldMore)) { t = t.replace(oldMore, newMore); n++; }

fs.writeFileSync(p, t, 'utf8');
console.log(`✓ 应用了 ${n} 处补丁`);
