/** 探针1 第三轮补丁：启动6 用进程外窗口读数（等新窗口出现）+ 异常时也把报告落盘 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'startup-and-menus-probe-1.cjs');
let s = fs.readFileSync(F, 'utf8');
const patch = (a, b, tag) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('X ' + tag + '：锚点命中 ' + n + ' 次'); process.exit(1); }
  s = s.split(a).join(b);
  console.log('OK ' + tag);
};

patch(
  `    const c2 = spawn(EXE, [DOC_A, \`--user-data-dir=\${app.profile}\`], { env, stdio: 'ignore' });
    await sleep(6000);
    const winsAfter = L.winList(firstPid);
    const l2 = L.logSince(app, size2).lines;`,
  `    const c2 = spawn(EXE, [DOC_A, \`--user-data-dir=\${app.profile}\`], { env, stdio: 'ignore' });
    /* 【判据口径】"第二个文件在新窗口打开"要用**进程外窗口读数**（我自己的窗口集合里多出一个标题含 A-启动.md 的），
       不用固定 sleep：文件打开是异步的，上一轮实测 6s 时窗口还没被枚举到（那次 winList 读到 0 个）。 */
    const winWait = await L.waitMyWindow(app.profile, /A-启动\\.md/, { timeoutMs: 12000 });
    const winsAfter = winWait.wins.map((w) => \`\${w.pid}:\${w.cls}|\${w.title}\`);
    const l2 = L.logSince(app, size2).lines;`);

patch(
  `      ok: l2.some((l) => l.includes('second-instance') || l.includes('newwin:created') || l.includes('openPath:loaded')),
      got: { 首实例窗口数前: winsBefore.length, 后: winsAfter.length, 第二个进程还活着: L.alive(c2.pid), 新日志: tail(l2, /second|newwin|openPath|ready/, 8) },`,
  `      ok: winWait.ok === true && l2.some((l) => /newwin:created/.test(l)),
      got: {
        新窗口出现: winWait.ok, 出现耗时ms: winWait.waitedMs, 命中的窗口: winWait.hit && winWait.hit.title,
        我的窗口清单_后: winsAfter, 我的窗口数_前: winsBefore.length, 第二个进程启动器还活着: L.alive(c2.pid),
        新日志: tail(l2, /second|newwin|openPath|doc:push|ready/, 8),
        注: '口径 = 首实例日志出现 newwin:created（新窗口/新会话）+ 进程外枚举到标题含 A-启动.md 的窗口',
      },`);

/* 异常时也落一份报告（不然中途失败就什么证据都不剩） */
patch(
  `})().catch(async (e) => {
  console.error('探针异常：', e && e.stack || e);
  try { if (app) app.kill(); } catch { }        // 只杀自己起的进程，绝不 /IM 全杀（会误伤别人的实例）
  process.exit(2);
});`,
  `})().catch(async (e) => {
  console.error('探针异常：', e && e.stack || e);
  try {
    fs.writeFileSync(path.join(BASE, 'report-partial.json'), JSON.stringify({
      probe: 'startup-and-menus-probe-1.cjs', exe: EXE, exeSha16: EXE_SHA, at: new Date().toISOString(),
      crashed: String((e && e.stack) || e), cases: res, evidence: ev,
    }, null, 1), 'utf8');
    console.error('已落盘部分报告：' + path.join(BASE, 'report-partial.json'));
  } catch { }
  try { if (app) app.kill(); } catch { }        // 只杀自己起的进程，绝不 /IM 全杀（会误伤别人的实例）
  process.exit(2);
});`);

fs.writeFileSync(F, s, 'utf8');
console.log('done');
