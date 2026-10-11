/** 探针1 第二轮补丁（幂等）：改判据口径，不改产品
 *  ① 菜单4：explorer 是**已存在**的常驻进程，「新增进程/窗口」不是有效尺子 ⇒ 改用
 *     时间窗内 explorer 进程 CPU 增量的**伴随证据 + 如实记"未定论"**，并按错误口径记账
 *  ② 菜单5：assert 实际是"点菜单保存后 1.5s 内盘上出现含第二段改动的内容"，与是否另有自动保存无关
 *  ③ 启动3：重启前**轮询确认 A 文件确实在盘上**（旧代码时序竞态：MRU 里 A 还在、文件却被别的探针删了）
 *  ④ 启动4/6/7：ready 行一律用 L.waitReady（字节数稳定口径），window 判据用 L.waitMyWindow（进程外）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'startup-and-menus-probe-1.cjs');
let s = fs.readFileSync(F, 'utf8');
const patch = (a, b, tag) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error(`✗ ${tag}：锚点命中 ${n} 次（期望 1）`); process.exit(1); }
  s = s.split(a).join(b);
  console.log('✓ ' + tag);
};

/* ① 菜单4 判据 */
patch(
  `      ok: !!rRev && rRev.ok === true && fm.items.reveal.enabled === true && (newPids.length > 0 || newWins.length > 0),`,
  `      /* 【尺子口径】explorer.exe 是常驻进程：实测点「在资源管理器中显示」**不会**新增进程或新窗口（它复用
         已打开的资源管理器窗口，前台化而已）⇒ "新增进程/窗口"不是有效尺子。这条只能记到
         "菜单项可用 + click 被真调用" 为止，', shell 是否真的把窗口前台化' **本机未验证**（需要看桌面）。 */
      ok: !!rRev && rRev.ok === true && fm.items.reveal.enabled === true,`);
patch(
  `        新增explorer进程: newPids, 新增资源管理器窗口: newWins, 主进程新日志: lRev.slice(-3),
        注: 'shell.showItemInFolder 没有渲染侧回执 ⇒ 判据是进程外的 explorer 进程/窗口增量',`,
  `        新增explorer进程: newPids, 新增资源管理器窗口: newWins, 主进程新日志: lRev.slice(-3),
        explorer进程集合不变: newPids.length === 0 && newWins.length === 0,
        注: 'shell.showItemInFolder 在主进程执行且没有渲染侧回执；explorer 复用既有窗口 ⇒ '
          + '"资源管理器真的被唤起/前台化了"这一步在本机**未验证**（要看桌面）。本项只到"菜单项可用 + click 真被调用"。',`);

/* ② 菜单5 判据：点菜单保存 ⇒ 盘上内容含最后那次改动 */
patch(
  `    const rSave = await tryEval(() => window.mpHost.recentTestMenuClick('menu-save', false));
    await sleep(1500);`,
  `    const rSave = await tryEval(() => window.mpHost.recentTestMenuClick('menu-save', false));
    /* 判据：这一次「文件→保存」之后盘上必须含最后那次改动（自动保存是否也写了一次不影响本判据） */
    await sleep(1500);`);

/* ③ 启动3：重启前确认 A 真在盘上 */
patch(
  `    await tryEval((f) => window.mpHost.openPath(f), DOC_A);   // MRU 第一条 = A
    await sleep(1200);`,
  `    await tryEval((f) => window.mpHost.openPath(f), DOC_A);   // MRU 第一条 = A
    await sleep(1500);
    /* 【时序纪律】"MRU 第一条 = A" 只有在 A **确实存在**时才成立（这台机器上有别的探针在删自己目录里的同名
       夹具，本轮实测撞过一次：MRU 里 A 还在、文件已被删 ⇒ 重启后 picked:null）。
       所以重启前先轮询确认 A 在盘上；不在就当场重建一个 MRU 条目，绝不带着竞态往下跑。 */
    for (let i = 0; i < 10 && !(fs.existsSync(DOC_A) && fs.statSync(DOC_A).isFile()); i++) { await sleep(300); }
    if (!(fs.existsSync(DOC_A) && fs.statSync(DOC_A).isFile())) {
      fs.writeFileSync(DOC_A, '# A 启动夹具\\n\\n甲甲甲。\\n', 'utf8');
      await tryEval((f) => window.mpHost.openPath(f), DOC_A);
      await sleep(1200);
    }
    const mruNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(app.profile, 'recents.json'), 'utf8'))[0] || null; } catch { return null; } })();`);

/* ③b 启动3：断言里加 MRU 实况 */
patch(
  `      ok: /A-启动\\.md/.test(st2.title) && st2.docHead.includes('A 启动夹具') && /"picked":".*A-启动\\.md"/.test(restoreLine),`,
  `      ok: /A-启动\\.md/.test(st2.title) && st2.docHead.includes('A 启动夹具') && /"picked":".*A-启动\\.md"/.test(restoreLine),`);
patch(
  `      got: { title: st2.title, docHead: st2.docHead.slice(0, 24), restoreLast行: restoreLine, ready行argv: (l2.split(/\\r?\\n/).find((l) => l.includes('"ready"')) || '').slice(0, 220) },`,
  `      got: { title: st2.title, docHead: st2.docHead.slice(0, 24), restoreLast行: restoreLine, 重启前MRU首位: mruNow, 重启前A在盘上: fs.existsSync(DOC_A) },`);

/* ④ 启动3 重启后的 ready 读取 */
patch(
  `    app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false });
    ({ browser, ctx, page } = await L.connect(app));
    await sleep(3000);
    const st2 = await L.readState(page);
    const l2 = L.logAll(app);`,
  `    app = await L.spawnApp({ exe: EXE, profile: P_MAIN, uniqueProfile: false, extraEnv: { MP_TEST_NO_DIALOG: '1' } });
    ({ browser, ctx, page } = await L.connect(app));
    MAIN_PID = L.mainPidFor(app.profile);
    await sleep(2500);
    const ready3 = await L.waitReady(app);
    const st2 = await L.readState(page);
    const l2 = L.logAll(app);`);

/* ④b 启动4 判据：读 ready 对象而不是空字符串 */
patch(
  `    app = await L.spawnApp({ exe: EXE, profile: P_CLI, uniqueProfile: false, argv: [DOC_B] });
    ({ browser, ctx, page } = await L.connect(app));
    await sleep(2500);
    const st = await L.readState(page);
    const l = L.logAll(app);
    const ready = l.split(/\\r?\\n/).find((x) => x.includes('"ready"')) || '';
    log2file('log-startup-cli-abs.txt', l);
    note('启动4 命令行带文件(绝对路径)', {
      ok: /B-最近\\.md/.test(st.title) && st.docHead.includes('B 最近夹具') && ready.includes('B-最近.md'),
      got: { title: st.title, docHead: st.docHead.slice(0, 24), ready行: ready.slice(0, 260) },`,
  `    app = await L.spawnApp({ exe: EXE, profile: P_CLI, uniqueProfile: false, argv: [DOC_B], extraEnv: { MP_TEST_NO_DIALOG: '1' } });
    ({ browser, ctx, page } = await L.connect(app));
    MAIN_PID = L.mainPidFor(app.profile);
    await sleep(2500);
    const ready4 = await L.waitReady(app);
    const st = await L.readState(page);
    const l = L.logAll(app);
    log2file('log-startup-cli-abs.txt', l);
    note('启动4 命令行带文件(绝对路径)', {
      ok: /B-最近\\.md/.test(st.title) && st.docHead.includes('B 最近夹具') && !!(ready4.json && ready4.json.argvFile === DOC_B),
      got: { title: st.title, docHead: st.docHead.slice(0, 24), ready行argvFile: ready4.json && ready4.json.argvFile, ready行argv: ready4.json && ready4.json.argv },`);

/* ④c 启动5：ready 读取改成 waitReady（判据本来就是标题+内容，保持） */
patch(
  `    const st = await L.readState(page);
    const l = L.logAll(app);
    const ready = l.split(/\\r?\\n/).find((x) => x.includes('"ready"')) || '';
    log2file('log-startup-dblclick.txt', l);
    note('启动5 双击等价(相对名+cwd)', {
      ok: /C-最近\\.md/.test(st.title) && st.docHead.includes('C 最近夹具'),
      got: { title: st.title, docHead: st.docHead.slice(0, 24), ready行: ready.slice(0, 260), cwd: FIX },`,
  `    const ready5 = await L.waitReady(app);
    const st = await L.readState(page);
    const l = L.logAll(app);
    log2file('log-startup-dblclick.txt', l);
    note('启动5 双击等价(相对名+cwd)', {
      ok: /C-最近\\.md/.test(st.title) && st.docHead.includes('C 最近夹具') && !!(ready5.json && /C-最近\\.md$/.test(ready5.json.argvFile || '')),
      got: { title: st.title, docHead: st.docHead.slice(0, 24), ready行argvFile: ready5.json && ready5.json.argvFile, cwd: FIX },`);

fs.writeFileSync(F, s, 'utf8');
console.log('done');
