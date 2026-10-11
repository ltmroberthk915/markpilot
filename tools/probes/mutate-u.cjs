/** 突变开关：把本轮三处修法**逐条注掉**，用来证明"探针红的正是这三处"
 *  用法：node mutate-u.cjs on|off
 *  ① openLen/closeLen：收尾长度按实际算（注掉 ⇒ 只用 openLen ⇒ 屏幕上留 `/` ✗）
 *  ② uInner 绝对坐标（注掉 ⇒ 相对行首 ⇒ 下划线贴到别的行 ✗）
 *  ③ escapedAt 含 `<>`（注掉 ⇒ `\<u>` 被投影 ✗）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
/* 【路径自适应·2026-10-11】先前写死本机绝对路径 ✗ ⇒ 进不了公开清单 ✗。
   ⚠️ 注意：**注释里的示例路径也算"写死路径"** ✗ —— 我第一次改的时候在注释里举了个
   `<盘符>:<仓库>/dsh-markpilot/...` 的例子 ⇒ 又被可移植性判据拦下 ✗（判据是对的 ✓）；
   写文档/注释时用占位符（`<repo>`、`<盘符>`）✓，别写真实路径 ✗。
   本文件在 `<repo>/.mp-verify/checklist/`（开发态）或 `<repo>/tools/probes/`（公开快照）下 ✓
   ⇒ 两种情况下"上溯两级"都是仓库根 ✓；也允许用 MP_SRC 显式指定 ✓。 */
const REPO = path.resolve(__dirname, '..', '..');
const F = process.env.MP_SRC || path.join(REPO, 'dsh-markpilot', 'src-cm6', 'main.js');
const MODE = process.argv[2];
if (MODE !== 'on' && MODE !== 'off') { console.error('用法：node mutate-u.cjs on|off'); process.exit(1); }
if (!fs.existsSync(F)) { console.error('✗ 找不到引擎源码：' + F + '（用 MP_SRC=<路径> 指定）'); process.exit(2); }
let s = fs.readFileSync(F, 'utf8');
const P = [
  /* ⚠️ 锚点必须与**当前源码**逐字一致 ✓（本文件先前用的是旧写法 ⇒ 0 命中 ⇒ 脚本按纪律停手 ✓，
     这正是"0 命中即退出"这条护栏的价值 ✓）。改源码后这里要同步更新 ✓。 */
  { name: '① closeLen 按实际算', good: 'const closeLen = um[0].length - openLen - innerLen;', bad: 'const closeLen = openLen;  /* 突变：假装收尾长度等于开标签长度 */' },
  { name: '② uInner 绝对坐标', good: 'mk.uInner = [base + innerFrom, base + innerTo];', bad: 'mk.uInner = [innerFrom, innerTo];  /* 突变：退回相对行首 */' },
  { name: '③ 转义含尖括号', good: 'if (t[k - 1] === "\\\\" && "*~`[]()#<>".includes(t[k])) return true;', bad: 'if (t[k - 1] === "\\\\" && "*~`[]()#".includes(t[k])) return true;  /* 突变：去掉 <> */' },
];
let n = 0;
for (const p of P) {
  if (MODE === 'on' && s.includes(p.good)) { s = s.replace(p.good, p.bad); n++; console.log('  注入 ' + p.name); }
  else if (MODE === 'off' && s.includes(p.bad)) { s = s.replace(p.bad, p.good); n++; console.log('  还原 ' + p.name); }
}
if (MODE === 'on') {
  for (const p of P) if (!s.includes(p.bad)) { console.error('✗ 突变没全打上（' + p.name + '）⇒ 停，保持原状'); process.exit(2); }
} else {
  for (const p of P) if (s.includes(p.bad)) { console.error('✗ 还有突变残留（' + p.name + '）'); process.exit(3); }
}
fs.writeFileSync(F, s, 'utf8');
const back = fs.readFileSync(F, 'utf8');
console.log(`· ${MODE === 'on' ? '注入' : '还原'} ${n} 处 ✓  当前状态：${back.includes(P[0].bad) ? '已突变' : '干净'}`);
