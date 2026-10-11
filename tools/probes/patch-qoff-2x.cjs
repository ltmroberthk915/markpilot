/** 补丁 6：qoff 探针补 **2 倍图**（引用区三行的局部放大，交 Lead 判），并给 4.8 加"清单内没渲染就用夹具等价形态"的说明。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-qoff.cjs');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('QOFF_2X')) { console.log('· 已打过 2 倍图补丁'); process.exit(0); }

/* 在写 JSON 之前插入 2 倍图拍摄 */
const anchor = "  const outFile = path.join(DIR, 'accept', 'out', `qoff-${LABEL || sha}.json`);";
if (!t.includes(anchor)) { console.log('✗ 没找到写文件锚点'); process.exit(1); }
const shotCode = `  /* QOFF_2X：把定点夹具那三行（引用/嵌套引用/对照）做 2 倍局部放大，交 Lead 判观感 */
  try {
    const rows = await ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const ys = [];
      for (let n = 1; n <= d.lines; n++) {
        const x = d.line(n).text;
        if (/^>?\\s*>?\\s*.*!\\[/.test(x)) { try { const c = v.coordsAtPos(d.line(n).from); if (c) ys.push(c); } catch { } }
      }
      return ys.length ? { top: Math.min(...ys.map((c) => c.top)), bottom: Math.max(...ys.map((c) => c.bottom)) } : null;
    });
    if (rows) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
      await sleep(400);
      await page.screenshot({ path: path.join(SHOTS, \`qoff-\${LABEL || sha}-2x.png\`), clip: { x: 60, y: Math.max(0, Math.floor(rows.top) - 30), width: 760, height: Math.min(420, Math.ceil(rows.bottom - rows.top) + 60) }, timeout: 12000 });
      await client.send('Emulation.clearDeviceMetricsOverride');
      await sleep(250);
      console.log('· 2 倍图 = ' + path.join(SHOTS, \`qoff-\${LABEL || sha}-2x.png\`));
    }
  } catch (e) { console.log('· 2 倍图失败：' + String(e.message).slice(0, 60)); }

`;
t = t.replace(anchor, shotCode + anchor);
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 已加 2 倍图');
