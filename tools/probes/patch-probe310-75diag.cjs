/** 补丁 16：让 §7.5 的读数**自带诊断**（弹层个数 / more 按钮个数与可见性 / mpHost.reload 类型 / 弹层 HTML 头），
 *  以便与独立 diag 的测量对齐，定位"同一产物两个读数"的差异来源。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('popDiag')) { console.log('· 已打过补丁'); process.exit(0); }
/* 在 openMore 的返回里加诊断字段 */
const anchor = "        return {\n          exists: true,\n          items: all.slice(0, 160),                       // 含嵌套叶子（旧口径）";
if (!t.includes(anchor)) { console.log('✗ 没找到 openMore 返回块'); process.exit(1); }
t = t.replace(anchor, `        const moreBtns = [...document.querySelectorAll('.mp-toolbar .mp-tb-item[data-mp-id="more"]')].map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), hidden: !(r.width && r.height) }; });
        const popDiag = {
          popCount: document.querySelectorAll('.mp-pop').length,
          moreBtnCount: moreBtns.length, moreBtns,
          mpHostReload: typeof (window.mpHost && window.mpHost.reload),
          mpHostPick: typeof (window.mpHost && window.mpHost.pickImages),
          popHtmlHead: (document.querySelector('.mp-pop') || {}).outerHTML ? document.querySelector('.mp-pop').outerHTML.slice(0, 240) : null,
        };
        return {
          exists: true, popDiag,
          items: all.slice(0, 160),                       // 含嵌套叶子（旧口径）`);
/* 判定文本里带上诊断 */
t = t.replace("选择器口径=${menu.sel || '(未记录)'}", "选择器口径=${menu.sel || '(未记录)'}；诊断=${JSON.stringify(menu.popDiag || {})}");
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 7.5 读数已自带诊断');
