/** 统计汇总（报告用）：判据条数 / 通过数 / pageerror / console.error / 崩溃 / 关窗方式 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, 'corrupt-config-out');
const files = [
  ['probe-1 (10 臂, run2)', 'corrupt-config-1-result-run2-full10arms.json'],
  ['probe-1 (A7 补跑, run3)', 'corrupt-config-1-result-run3-A7fixed.json'],
  ['probe-2 (5 臂)', 'corrupt-config-2-result-run2-full5arms.json'],
];
let T = { arms: 0, checks: 0, ok: 0, bad: 0, pageErrors: 0, consoleErrors: 0, crashes: 0, unresponsive: 0, goneReal: 0, goneKilled: 0, graceful: 0, launched: 0 };
for (const [label, f] of files) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
  const s = { arms: j.results.length, checks: 0, ok: 0, bad: 0, pageErrors: 0, consoleErrors: 0, crashes: 0, unresponsive: 0, goneReal: 0, goneKilled: 0, graceful: 0 };
  for (const r of j.results) {
    const c = r.checks || [];
    s.checks += c.length; s.ok += c.filter((x) => x.ok).length; s.bad += c.filter((x) => !x.ok).length;
    const st = r.steps || {};
    s.pageErrors += (st.pageErrors || []).length;
    s.consoleErrors += (st.consoleErrors || []).length;
    s.crashes += (st.crashes || []).length;
    if (st.log) { s.unresponsive += st.log.unresponsive || 0; s.goneReal += st.log.renderGoneReal || 0; s.goneKilled += st.log.renderGoneKilled || 0; }
    if (st.close && st.close.exitedGracefully) s.graceful++;
    if (st.launch && st.launch.ok) T.launched++;
  }
  console.log(label + ' → ' + JSON.stringify(s));
  for (const k of Object.keys(s)) if (k !== 'arms') T[k] += s[k];
  T.arms += s.arms;
}
console.log('\n合计 → ' + JSON.stringify(T, null, 1));
/* 逐臂裁定 */
console.log('\n逐臂裁定：');
for (const [label, f] of files) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
  for (const r of j.results) console.log(`  ${(r.verdict || 'N/A').padEnd(6)} ${r.id}  (判据 ${(r.checks || []).length} 条，红 ${(r.checks || []).filter((c) => !c.ok).length})`);
}
