/** 探针1 补丁：启动实例加 MP_TEST_NO_DIALOG=1（异常路径不该弹原生框） */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'startup-and-menus-probe-1.cjs');
let s = fs.readFileSync(F, 'utf8');
const patch = (a, b, tag) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error(`✗ ${tag} 锚点命中 ${n} 次（期望 1）`); process.exit(1); }
  s = s.split(a).join(b);
  console.log(`✓ ${tag}`);
};
patch(
  "app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false, settings: SETTINGS_OFF });",
  "app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false, settings: SETTINGS_OFF, extraEnv: { MP_TEST_NO_DIALOG: '1' } });",
  '主实例加 MP_TEST_NO_DIALOG=1');
patch(
  '    const rDead = gItem0 ? await tryEval(',
  `    /* 【异常路径要免打扰】点一条已被删除的最近条目会让主进程走 openPath 的失败分支；
       MP_TEST_NO_DIALOG=1 已在启动时设好，否则那个原生错误框会把渲染侧卡死（本轮实测整轮挂住）。 */
    const rDead = gItem0 ? await tryEval(`,
  '点死条目加说明');
fs.writeFileSync(F, s, 'utf8');
console.log('done');
