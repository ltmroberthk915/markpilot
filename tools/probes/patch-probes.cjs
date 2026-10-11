/** 一次性补丁：按 AGENTS.md 铁律 4 去掉探针里的 app-slot 包装（子代理不占锁）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIR = __dirname;
const REPL = `/* AGENTS.md 铁律 4：子代理**不占 app-slot 锁** ⇒ 直接起进程
   （全新 --user-data-dir + 起前清自己的残留 + 跑完 taskkill 自己的进程树）。 */
`;
for (const f of ['probe-qoff.cjs', 'probe-lineno-counter.cjs', 'probe-cursor-state.cjs']) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) { console.log('缺文件', f); continue; }
  let t = fs.readFileSync(p, 'utf8');
  const re = /if \(process\.env\.MP_ACCEPT_SLOT !== '1'\) \{[\s\S]*?\r?\n\}\r?\n/;
  if (re.test(t)) { t = t.replace(re, REPL); fs.writeFileSync(p, t, 'utf8'); console.log('✓ 去掉 app-slot 包装：', f); }
  else console.log('· 没找到 app-slot 包装：', f);
}
