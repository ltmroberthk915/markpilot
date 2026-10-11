/** 探针1 第四轮补丁：启动3 的恢复上次判据要先把 restoreLast=true 落到 profile 上
 *  【为什么】产品的 settings.json **只在窗口正常关闭时**（close 事件里 !dirty 分支）才写；
 *  探针上一轮用 taskkill 收进程 ⇒ 我写进 profile 的 restoreLast 从未生效（日志实证：
 *  重启时 settings:load-failed ENOENT）。所以口径改成：杀进程**之后**、重启**之前**把
 *  settings.json + recents.json 两件都写好，让"MRU 里有一条存在的文件 + restoreLast=true"成为确定性前提。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'startup-and-menus-probe-1.cjs');
let s = fs.readFileSync(F, 'utf8');
const patch = (a, b, tag) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('X ' + tag + ' 命中 ' + n + ' 次'); process.exit(1); }
  s = s.split(a).join(b);
  console.log('OK ' + tag);
};

patch(
  `    await browser.close().catch(() => { });
    app.kill(); await sleep(2500);
    // 关掉 restoreLast 关的旧设置 ⇒ 改成 true 再启动（同一个 profile，这才是"重启"）
    fs.writeFileSync(path.join(app.profile, 'settings.json'), JSON.stringify(SETTINGS_ON, null, 2), 'utf8');
    app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false, extraEnv: { MP_TEST_NO_DIALOG: '1' } });
    ({ browser, ctx, page } = await L.connect(app));
    MAIN_PID = L.mainPidFor(app.profile);
    await sleep(2500);
    const ready3 = await L.waitReady(app);`,
  `    await browser.close().catch(() => { });
    app.kill(); await sleep(2500);
    /* 杀进程之后、重启之前，把"重启前提"落成确定状态：
       ① settings.json：restoreLast=true（产品只在窗口正常关闭时写它 ⇒ 被 taskkill 收掉的进程不会写）
       ② recents.json：MRU 首位 = A（本步前面 openPath(A) 已经把它写进去了；这里再断言一次，不猜时序）
       两件都写在同一处，避免"以为设了其实没设"（上一轮就是这么假红的）。 */
    const aOnDisk = fs.existsSync(DOC_A) && fs.statSync(DOC_A).isFile();
    const recentsNow = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(app.profile, 'recents.json'), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } })();
    const mru = [DOC_A, ...recentsNow.filter((p) => p !== DOC_A)].slice(0, 10);
    fs.writeFileSync(path.join(app.profile, 'settings.json'), JSON.stringify(SETTINGS_ON, null, 2), 'utf8');
    fs.writeFileSync(path.join(app.profile, 'recents.json'), JSON.stringify(mru, null, 1), 'utf8');
    log2file('log-restart-preconditions.json', { A在盘上: aOnDisk, 写入的MRU: mru, settings: SETTINGS_ON });
    app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false, extraEnv: { MP_TEST_NO_DIALOG: '1' } });
    ({ browser, ctx, page } = await L.connect(app));
    MAIN_PID = L.mainPidFor(app.profile);
    await sleep(2500);
    const ready3 = await L.waitReady(app);`);

patch(
  `      got: { title: st2.title, docHead: st2.docHead.slice(0, 24), restoreLast行: restoreLine, 重启前MRU首位: mruNow, 重启前A在盘上: fs.existsSync(DOC_A) },`,
  `      got: {
        title: st2.title, docHead: st2.docHead.slice(0, 24), restoreLast行: restoreLine,
        重启前的MRU首位: mruNow, 重启前A在盘上: fs.existsSync(DOC_A),
        重启后ready里的recents: ready3 && ready3.json && ready3.json.recents,
        重启后日志开头: (l2.split(/\\r?\\n/).slice(0, 4)),
      },`);

/* 菜单5 判据写清楚：这一次「文件→保存」之后盘上必须含最后那次改动 */
patch(
  `      ok: !!rSave && rSave.ok === true && disk.includes('MANUAL-SAVE-2') && lSave.some((l) => l.includes('"file:save"')),`,
  `      /* 判据 = "点完菜单保存之后，盘上确实有最后那次改动"，且这段窗口里主进程写过 file:save。
         （自动保存是否同时也写了一次与本判据无关：本判据问的是"菜单保存这条路能不能把改动落盘"。） */
      ok: !!rSave && rSave.ok === true && disk.includes('MANUAL-SAVE-2') && lSave.some((l) => /file:save \\{"filePath"/.test(l)),`);

fs.writeFileSync(F, s, 'utf8');
console.log('done');
