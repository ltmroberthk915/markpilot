/** family=path-edge · 用例 e4：**网络路径**
 *
 *  A 不可达 UNC（\\192.0.2.1\… = TEST-NET-1，保证路由不到）→「打开」会怎样：耗时/错误/有无提示
 *  B 不可达 UNC → 空文档「另存为…」到那里：耗时/错误/有无残留
 *  C **死路径进了 MRU** 时，菜单/MRU 读数会不会把主进程卡住（`recents.menuModel` 用同步 statSync）
 *  D 真·映射网络盘（`net use R: \\localhost\E$`，DriveType=4）→ 打开/打字落盘 → **运行中断开该盘** →
 *    再打字 / 点提示条「重试」→ 再**重新映射** → 再点「重试」（恢复臂）
 *
 *  通道：打开=mpHost.openPath；打字=真实鼠标点正文 + CDP 键盘；提示条按钮=真实鼠标点；
 *        另存为目标来自 MP_TEST_SAVE_AS；盘符映射/断开走 `net use`（探针侧，独立进程）
 *  用法：node path-edge-4-net.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e4-net';
const DIR = path.join(L.ROOT, CASE);
const DRIVE = 'R:';
const UNC_SHARE = '\\\\localhost\\E$';
const DEAD = '\\\\192.0.2.1\\share\\pe-dead.md';            // 不可路由：保证"网络不可达"
const R = { probe: 'path-edge-4-net.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), arms: {} };

const cleanup = () => { try { L.netDelete(DRIVE); } catch { /* 尽力 */ } };
process.on('exit', cleanup);

const isolatedProfile = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  return dir;
};

(async () => {
  L.rulerEdge('path-edge-4-net.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(DIR, { recursive: true });
  R.pathFacts = { dead: L.pathFacts(DEAD) };
  R.deadScope = { ip: '192.0.2.1', why: 'TEST-NET-1（RFC5737）保留段，非本机任何接口 ⇒ 保证"网络不可达"而非"路径不存在"' };

  /* ════ A 不可达 UNC 的「打开」 ════ */
  {
    const profile = isolatedProfile(path.join(DIR, 'runA', 'profile'));
    const port = await L.pickPort();
    const app = await L.launch({ exe: L.EXE, args: [], port, profile });
    try {
      const page = await L.findPage(app.browser, {});
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
      await L.sleep(2200);
      const t0 = Date.now();
      const res = await L.T(page.evaluate((p) => window.mpHost.openPath(p), DEAD), 90000, 'openPath-dead');
      const ms = Date.now() - t0;
      await L.sleep(1200);
      const s = await L.peSnap(page);
      R.arms.A = { 通道: 'mpHost.openPath(不可达 UNC)', ms, result: res, timedOut: !!(res && res.__timeout), after: { title: s.title, host: s.host, banner: s.banner && s.banner.text, mru: L.mruBrief(s) }, errs };
      console.log('\n[A 打开不可达 UNC] ' + ms + 'ms timedOut=' + !!(res && res.__timeout));
      console.log('   result=' + JSON.stringify(res));
      console.log('   标题=' + JSON.stringify(s.title) + ' host=' + JSON.stringify(s.host) + ' 提示条=' + JSON.stringify(s.banner && s.banner.text));
      await L.shot(page, CASE + '-A-dead-open.png');
    } finally { L.kill(app); }
  }

  /* ════ B 不可达 UNC 的「另存为」（空文档，绕开 diskMtime 守卫）════ */
  {
    const dirB = path.join(DIR, 'runB');
    const profile = isolatedProfile(path.join(dirB, 'profile'));
    const port = await L.pickPort();
    const app = await L.launch({ exe: L.EXE, args: [], port, profile, env: { MP_TEST_SAVE_AS: DEAD } });
    try {
      const page = await L.findPage(app.browser, {});
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
      await L.sleep(2200);
      await L.focusBodyAndType(page, null, 'D1');
      await L.sleep(800);
      const t0 = Date.now();
      const click = await L.T(page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save-as')), 20000, 'menu-save-as');
      /* 失败是**异步**冒出来的（writeDoc 里的 mkdir/writeFile 要等 SMB 超时）⇒ 轮询等提示条，别只等一次 */
      let s = null, firstBannerAt = null, poll = [];
      for (let i = 0; i < 24; i++) {
        await L.sleep(5000);
        s = await L.peSnap(page, 60000);
        poll.push({ t: Date.now() - t0, banner: s.banner && s.banner.shown, host: s.host && s.host.filePath, snapMs: s.ms });
        if (s.banner && s.banner.shown && firstBannerAt === null) { firstBannerAt = Date.now() - t0; break; }
      }
      const ms = Date.now() - t0;
      R.arms.B = { 通道: '空文档 → 菜单「另存为…」到不可达 UNC', click, ms, 首次出现提示条ms: firstBannerAt, 轮询: poll, after: { title: s.title, host: s.host, bannerShown: s.banner && s.banner.shown, banner: s.banner && s.banner.text, buttons: s.banner && s.banner.buttons, mru: L.mruBrief(s), snapMs: s.ms }, errs };
      console.log('\n[B 另存为到不可达 UNC] 点击后 ' + ms + 'ms，首次出现提示条=' + firstBannerAt + 'ms');
      console.log('   标题=' + JSON.stringify(s.title) + ' host=' + JSON.stringify(s.host));
      console.log('   提示条(shwon=' + (s.banner && s.banner.shown) + ')=' + JSON.stringify(s.banner && s.banner.text));
      console.log('   peSnap 耗时=' + s.ms + 'ms (含 3 次 IPC：docInfo/recentList/menuList)');
      await L.shot(page, CASE + '-B-dead-saveas.png');
    } finally { L.kill(app); }
  }

  /* ════ C 死路径进了 MRU：菜单/MRU 读数会不会卡主进程 ════ */
  {
    const dirC = path.join(DIR, 'runC');
    const profile = isolatedProfile(path.join(dirC, 'profile'));
    /* 预置 MRU：[死 UNC, 本地真文件] —— 模拟"用户曾打开过网络盘上的文件，之后网络断了" */
    const localDoc = path.join(DIR, 'runC', '本地 对照.md');
    fs.writeFileSync(localDoc, '# 本地对照\n\nC-MARK。\n', 'utf8');
    fs.writeFileSync(path.join(profile, 'recents.json'), JSON.stringify([DEAD, localDoc], null, 2), 'utf8');
    const port = await L.pickPort();
    /* 启动耗时也要记：buildMenu() 在启动路径上，而 recents.menuModel 对每条 MRU 做**同步** statSync */
    const tLaunch = Date.now();
    const app = await L.launch({ exe: L.EXE, args: [], port, profile });
    const launchMs = Date.now() - tLaunch;
    try {
      const page = await L.findPage(app.browser, {});
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
      await L.sleep(2200);
      /* 分开计时：两个 IPC 各自多久（recentList 与 buildMenu→menuModel 都在主进程同步 statSync）*/
      const t1 = Date.now();
      const mru = await L.T(page.evaluate(() => window.mpHost.recentList()), 120000, 'recentList');
      const msRecentList = Date.now() - t1;
      const t2 = Date.now();
      const menu = await L.T(page.evaluate(() => window.mpHost.recentTestMenuList()), 120000, 'menuList');
      const msMenuList = Date.now() - t2;
      const t3 = Date.now();
      const opened = await L.T(page.evaluate((p) => window.mpHost.openPath(p), localDoc), 120000, 'open-local');
      const msOpenLocal = Date.now() - t3;
      await L.sleep(1500);
      const s = await L.peSnap(page, 120000);
      R.arms.C = {
        预置MRU: [DEAD, localDoc], 启动耗时ms: launchMs, msRecentList, msMenuList, msOpenLocal, opened,
        mru, menuItems: menu && menu.items, localDocOpened: s.host && s.host.filePath,
        after: { title: s.title, banner: s.banner && s.banner.text, snapMs: s.ms }, errs,
      };
      console.log('\n[C 死路径在 MRU 里] 启动=' + launchMs + 'ms  recentList=' + msRecentList + 'ms  menuList=' + msMenuList + 'ms  openPath(本地)=' + msOpenLocal + 'ms  peSnap=' + s.ms + 'ms');
      console.log('   MRU 读数=' + JSON.stringify((mru && mru.files || []).map((f) => ({ n: f.name, alive: f.alive }))));
      console.log('   菜单项=' + JSON.stringify((menu && menu.items || []).map((i) => ({ l: i.label, on: i.enabled }))));
      console.log('   本地文件仍能打开=' + JSON.stringify(s.host && s.host.filePath));
    } finally { L.kill(app); }
  }

  /* ════ D 真·映射网络盘：连接 → 打开/打字落盘 → 断开 → 打字/重试 → 重连 → 重试 ════ */
  {
    const dirD = path.join(DIR, 'runD');
    const profile = isolatedProfile(path.join(dirD, 'profile'));
    L.netDelete(DRIVE);
    L.netUse(DRIVE, UNC_SHARE);
    const shareDir = 'R:\\MarkPilot\\.mp-verify\\path-edge\\e4-net\\share';
    fs.mkdirSync(shareDir, { recursive: true });
    const live = path.join(shareDir, '网络盘 文档.md');
    fs.writeFileSync(live, '# 网络盘 标题\n\n网络盘 MARK-NET。\n', 'utf8');
    const driveType = L.driveAlive(DRIVE);

    const port = await L.pickPort();
    const app = await L.launch({ exe: L.EXE, args: [], port, profile });
    const out = { 盘符: DRIVE, 共享: UNC_SHARE, 映射后可见: driveType, 文档: live };
    try {
      const page = await L.findPage(app.browser, {});
      const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
      await L.sleep(2200);

      /* D1 打开 + 打字落盘 */
      const t0 = Date.now();
      out.D1_open = await L.T(page.evaluate((p) => window.mpHost.openPath(p), live), 60000, 'open');
      out.D1_openMs = Date.now() - t0;
      await L.sleep(1800);
      const s1 = await L.peSnap(page);
      await L.focusBodyAndType(page, null, 'N1');
      await L.sleep(2600);
      out.D1 = { title: s1.title, host: s1.host && s1.host.filePath, docDir: s1.docDir, mru: L.mruBrief(s1), 盘上含N1: String(L.readDisk(live) || '').includes('N1'), 盘上尾: String(L.readDisk(live) || '').slice(-12) };
      console.log('\n[D1 映射网络盘上打开/落盘] ' + JSON.stringify(out.D1));

      /* D2 运行中断开盘符 */
      out.D2_disconnect = L.netDelete(DRIVE);
      await L.sleep(1200);
      out.D2_盘符还在 = L.driveAlive(DRIVE);
      await L.focusBodyAndType(page, null, 'N2');
      await L.sleep(3200);
      const s2 = await L.peSnap(page, 60000);
      out.D2 = { title: s2.title, host: s2.host && s2.host.filePath, bannerShown: s2.banner && s2.banner.shown, banner: s2.banner && s2.banner.text, buttons: s2.banner && s2.banner.buttons, mru: L.mruBrief(s2), snapMs: s2.ms };
      console.log('\n[D2 断开后打字] 提示条=' + JSON.stringify(out.D2.banner));
      console.log('   标题=' + JSON.stringify(out.D2.title) + ' 盘符还在=' + out.D2_盘符还在);
      await L.shot(page, CASE + '-D2-disconnected-banner.png');

      /* D3 断着点「重试」（真实鼠标） */
      out.D3_click = await L.clickBannerButton(page, '重试');
      await L.sleep(3000);
      const s3 = await L.peSnap(page, 60000);
      out.D3 = { banner: s3.banner && s3.banner.text, shown: s3.banner && s3.banner.shown, title: s3.title };
      console.log('\n[D3 断着点重试] ' + JSON.stringify(out.D3_click) + ' 提示条=' + JSON.stringify(out.D3.banner));

      /* D4 重新映射 → 再点「重试」 */
      out.D4_remap = L.netUse(DRIVE, UNC_SHARE);
      await L.sleep(1500);
      out.D4_click = await L.clickBannerButton(page, '重试');
      await L.sleep(3200);
      const s4 = await L.peSnap(page, 60000);
      const disk4 = String(L.readDisk(live) || '');
      out.D4 = { 盘上含N2: disk4.includes('N2'), 盘上尾: disk4.slice(-14), banner: s4.banner && s4.banner.text, shown: s4.banner && s4.banner.shown, title: s4.title };
      console.log('\n[D4 重连后点重试] ' + JSON.stringify(out.D4_click) + ' 盘上含N2=' + out.D4.盘上含N2 + ' 尾=' + JSON.stringify(out.D4.盘上尾));
      await L.shot(page, CASE + '-D4-reconnected.png');

      out.shell = L.shellLog(profile, 'file:save|writeDoc|openPath|doc:saved', 18);
      out.errs = errs;
    } catch (e) { out.errs = (out.errs || []).concat('THROW: ' + String((e && e.stack) || e).slice(0, 300)); }
    finally { L.kill(app); L.netDelete(DRIVE); }
    R.arms.D = out;
  }

  R.cleanup = { 盘符已删: !L.driveAlive(DRIVE) };
  console.log('\n[清理] ' + JSON.stringify(R.cleanup));
  console.log('[pageerror] ' + JSON.stringify([R.arms.A && R.arms.A.errs, R.arms.B && R.arms.B.errs, R.arms.C && R.arms.C.errs, R.arms.D && R.arms.D.errs]));
  L.writeReport('path-edge-4-net', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); cleanup(); process.exit(2); });
