/** family=file-ops-real · P2：**另存为到新目录**（含不支持"点原生框"的替代通道）
 *
 *  为什么单开一支：`MP_TEST_SAVE_AS` 是**进程启动时读的环境变量**，一个进程只能测一个另存为目标
 *  ⇒ 另存为的靶子必须在启动命令里给定。P1 里那个原生框只证明"框会弹"（CDP 点不到框内控件）。
 *
 *  本支链路（全部落在用户能看见的最终状态上）：
 *   ① 源文件是 **+R 只读** ⇒ 打字后自动保存失败 ⇒ 提示条（这条同时给"打开只读文件"补一个恢复路径读数）
 *   ② 真实鼠标点提示条的「另存为…」 ⇒ 壳层用 MP_TEST_SAVE_AS 给的路径（**不弹原生框**）
 *   ③ 目标 = 一个**尚不存在**的目录 + 中文/空格文件名 ⇒ 读：目录有没有被建、字节是否逐字符相等、
 *      旧文件是否被动过、标题/原生标题/文档目录/MRU 是否跟着换
 *   ④ 再打一个字 ⇒ 自动保存必须落到**新路径**（证明换路径是一次性的还是真的换过去了）
 *
 *  用法：node file-ops-real-p2.cjs [exe]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'file-ops-real-lib.cjs'));

const EXE = process.argv[2] || L.EXE_DEFAULT;
const DIR = path.join(L.ROOT, 'p2');
const FIX = path.join(DIR, 'fix');
const PROFILE = path.join(DIR, 'profile');
const SHOTS = path.join(DIR, 'shots');
const WINPS = path.join(__dirname, 'win-file-ops-win.ps1');
const PORT = 9800 + (process.pid % 150);
const { sleep, T } = L;

const SRC = path.join(FIX, 'source.md');
const NEWDIR = path.join(FIX, '新 目录 目标');
const TARGET = path.join(NEWDIR, '另存为 产物 01.md');

const R = { probe: 'file-ops-real-p2.cjs', at: new Date().toISOString(), exe: EXE, target: TARGET, cases: [], readings: {}, errs: [] };
const rec = (name, verdict, detail, channel) => {
  R.cases.push({ name, verdict, channel, detail });
  console.log('\n[' + name + '] ⇒ ' + verdict);
  console.log('    通道：' + channel);
  console.log('    ' + JSON.stringify(detail));
};
const jot = (k, v) => { R.readings[k] = v; console.log('  · ' + k + ' = ' + JSON.stringify(v)); };
let APP = null;
const cleanup = () => L.kill(APP);
process.on('exit', cleanup);

const nativeTitle = () => (L.winList(WINPS, 0).filter((w) => w.pid === (APP && APP.pid) && /Chrome_WidgetWin_1/.test(w.cls || ''))[0] || {}).title || null;

(async () => {
  L.ruler('file-ops-real-p2.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(SRC, '# 源文档\n\n源 段落 正文。\n', 'utf8');
  fs.chmodSync(SRC, 0o444);                       // 只读：让第一次保存必定失败，从而逼出提示条
  jot('targetDir存在吗(启动前)', fs.existsSync(NEWDIR));
  const srcBuf0 = L.readBuf(SRC);

  APP = await L.launch({ exe: EXE, args: [SRC], port: PORT, profile: PROFILE, env: { MP_TEST_SAVE_AS: TARGET } });
  console.log('[启动] pid=' + APP.pid + ' port=' + PORT + ' MP_TEST_SAVE_AS=' + TARGET);
  const page = await L.findPage(APP.browser, { expectFile: 'source.md' });
  page.on('pageerror', (e) => R.errs.push(String((e && e.message) || e).slice(0, 200)));
  page.on('crash', () => R.errs.push('PAGE_CRASH'));
  await sleep(2000);
  const boot = await L.snap(page);
  jot('boot', { host: boot.host, title: boot.title, nativeTitle: nativeTitle() });
  if (boot.host && boot.host.filePath !== SRC) throw new Error('夹具断言失败：' + JSON.stringify(boot.host));

  /* ① 只读源 → 打字 → 保存失败提示条 */
  let bannerText = null;
  try {
    await L.clickBody(page, '源 段落');
    await page.keyboard.type('Q');
    await sleep(2000);
    const s1 = await L.snap(page);
    bannerText = s1.banner && s1.banner.text;
    await page.screenshot({ path: path.join(SHOTS, 'P2-1-readonly-banner.png') });
    rec('P2-1 只读源文件打字（为「另存为…」按钮造出提示条）',
      (s1.banner && s1.banner.shown) ? '有反应（保存失败提示条在场）' : '**无反应**（没有提示条，后续点击无从谈起）',
      { 文档长度: s1.docLen, 标题: s1.title, 提示条文案: bannerText, 提示条按钮: s1.banner && s1.banner.buttons, 磁盘未变: !!(srcBuf0 && L.readBuf(SRC) && srcBuf0.equals(L.readBuf(SRC))), saveTrace: s1.dbg && s1.dbg.saveTrace },
      '真实鼠标点正文 + page.keyboard.type；保存是去抖自动保存');
    jot('P2-1.banner', { text: bannerText, buttons: s1.banner && s1.banner.buttons });
  } catch (e) { rec('P2-1 只读源', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ② 真实鼠标点提示条「另存为…」→ 落到新目录/中文空格名 */
  try {
    const t0 = Date.now();
    const click = await L.clickBannerButton(page, '另存为');
    let exists = false;
    for (let i = 0; i < 40 && !exists; i++) { await sleep(200); exists = fs.existsSync(TARGET); }
    await sleep(600);
    const s2 = await L.snap(page);
    const disk = L.readDisk(TARGET);
    const nt = nativeTitle();
    const mru = await T(page.evaluate(() => window.mpHost.recentList()), 6000, 'recentList');
    await page.screenshot({ path: path.join(SHOTS, 'P2-2-after-saveas.png') });
    const detail = {
      点击结果: click, 目标文件出现: exists, 耗时ms: Date.now() - t0,
      目标目录被自动创建: fs.existsSync(NEWDIR),
      磁盘与文档逐字符相等: disk === String(s2.docText),
      磁盘内容: String(disk || '').slice(0, 40),
      源文件被动过吗: !(srcBuf0 && L.readBuf(SRC) && srcBuf0.equals(L.readBuf(SRC))),
      源文件仍只读吗: (fs.statSync(SRC).mode & 0o200) === 0,
      docInfo: s2.host, 期望docInfo: TARGET,
      标题: s2.title, 原生标题: nt,
      docDir: s2.docDir, docDir期望: NEWDIR,
      提示条还在: s2.banner && s2.banner.shown,
      MRU首条: mru && mru.files && mru.files[0] && mru.files[0].path,
      saveTrace: s2.dbg && s2.dbg.saveTrace,
      壳层pickSaveAs: L.shellLog(PROFILE, 'pickSaveAs', 4).matched,
    };
    jot('P2-2', detail);
    rec('P2-2 点提示条「另存为…」→ 落到新目录 + 中文空格文件名',
      (exists && disk === String(s2.docText) && s2.host && s2.host.filePath === TARGET) ? '有反应（新路径落盘、路径/标题/目录跟着换）' : '**不符预期**',
      detail,
      '真实鼠标点提示条上的「另存为…」；路径来自壳层 MP_TEST_SAVE_AS（不弹原生框 ⇒ 只覆盖"路径从哪来"之后的一切）');

    /* ③ 再打一个字：自动保存必须落到新路径；旧文件仍不动 */
    const before3 = L.snap(page);
    await page.keyboard.type('W');
    await sleep(2000);
    const s3 = await L.snap(page);
    const disk3 = L.readDisk(TARGET);
    const s3detail = {
      文档含W: /W/.test(String(s3.docText)), 新路径含W: /W/.test(String(disk3 || '')),
      源文件仍未被写: !!(srcBuf0 && L.readBuf(SRC) && srcBuf0.equals(L.readBuf(SRC))),
      标题: s3.title, 原生标题: nativeTitle(), docInfo: s3.host,
      saveTrace: s3.dbg && s3.dbg.saveTrace,
      目录: (L.listDir(NEWDIR) || []).map((f) => f.name),
    };
    jot('P2-3', { before: await before3, ...s3detail });
    rec('P2-3 另存为之后继续打字（自动保存落在哪）',
      (/W/.test(String(disk3 || '')) && !(srcBuf0 && L.readBuf(SRC) && !srcBuf0.equals(L.readBuf(SRC)))) ? '有反应（后续自动保存走新路径，源文件一字未动）' : '**不符预期**',
      s3detail, '真实键盘 page.keyboard.type；保存是去抖自动保存');

    /* ④ 显式「保存」菜单项（挂点）在另存为之后仍应写新路径 */
    const r4 = await T(page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save')), 8000, 'menu-save');
    await sleep(900);
    const s4 = await L.snap(page);
    const detail4 = { 挂点返回: r4, 新路径大小: L.statOf(TARGET), 源文件仍未被写: !!(srcBuf0 && L.readBuf(SRC) && srcBuf0.equals(L.readBuf(SRC))), 标题: s4.title, saveTrace: s4.dbg && s4.dbg.saveTrace };
    jot('P2-4', detail4);
    rec('P2-4 另存为之后走「文件→保存」',
      (L.statOf(TARGET) && !(srcBuf0 && L.readBuf(SRC) && !srcBuf0.equals(L.readBuf(SRC)))) ? '有反应（写的是新路径）' : '**不符预期**',
      detail4, '挂点触发菜单项自身 click（recent:test-menu-click menu-save）');
  } catch (e) { rec('P2-2/3/4 另存为链路', '探针异常：' + String((e && e.message) || e).slice(0, 200), {}, '-'); }

  R.aliveAtEnd = L.alive(APP.pid);
  console.log('\n════ 汇总（file-ops-real-p2）════');
  for (const c of R.cases) console.log(' · ' + c.name + ' ⇒ ' + c.verdict);
  console.log('页面错误：' + JSON.stringify(R.errs.slice(0, 6)));
  console.log('进程仍在：' + R.aliveAtEnd);
  fs.writeFileSync(path.join(DIR, 'file-ops-real-p2.json'), JSON.stringify(R, null, 1), 'utf8');
  L.kill(APP); APP = null;
  process.exit(0);
})().catch((e) => {
  console.error('探针异常：', (e && e.stack) || e);
  try { fs.writeFileSync(path.join(DIR, 'file-ops-real-p2.json'), JSON.stringify({ ...R, fatal: String((e && e.stack) || e) }, null, 1), 'utf8'); } catch { /* 忽略 */ }
  cleanup();
  process.exit(3);
});
