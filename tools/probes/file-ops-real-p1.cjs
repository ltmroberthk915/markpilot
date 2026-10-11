/** family=file-ops-real · P1：磁盘侧文件操作的"难case"（另存为另起一支 P2）
 *
 *  被测产物：MarkPilot-CM6/dist/win-unpacked/MarkPilot.exe（sha16 由尺子卡断言并打印）
 *  范围：打开只读文件 / 磁盘上重命名后再保存 / 文件被外部程序占用 / 中文+空格文件名 / 深层目录 / （附）超长路径边界 / （附）另存为的原生框
 *
 *  通道声明（判据按这个口径记账）：
 *   · 打开文件：`mpHost.openPath(p)`（壳层 IPC，与"文件→打开…"选中后的落点同一条路；弹框本身见 C6）
 *   · 编辑：真实鼠标点进正文 + `page.keyboard.type/insertText`（CDP Input.*）
 *   · 保存：**不做任何显式保存动作**，让 500ms 去抖自动保存发生（这是用户打字后最真实的那条路）；
 *           需要"强制保存"时用 `recent:test-menu-click menu-save`（= 菜单项自身 click 回调，非鼠标）
 *   · 提示条按钮：真实鼠标点击（读按钮矩形 → page.mouse.click）
 *   · 只读属性：`fs.chmodSync(0o444|0o666)`（Windows 上就是 FILE_ATTRIBUTE_READONLY）
 *   · 外部占用：独立 pwsh 进程以 `FileShare.Read` 持有文件句柄（file-ops-real-lock.ps1），并在探针侧断言"确实写不进去"
 *
 *  用法：node file-ops-real-p1.cjs [exe]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require(path.join(__dirname, 'file-ops-real-lib.cjs'));

const EXE = process.argv[2] || L.EXE_DEFAULT;
const DIR = path.join(L.ROOT, 'p1');
const FIX = path.join(DIR, 'fix');
const PROFILE = path.join(DIR, 'profile');
const SHOTS = path.join(DIR, 'shots');
const LOCKPS = path.join(__dirname, 'file-ops-real-lock.ps1');
const WINPS = path.join(__dirname, 'win-file-ops-win.ps1');
const PORT = 9500 + (process.pid % 300);
const { sleep, T } = L;

const R = { probe: 'file-ops-real-p1.cjs', at: new Date().toISOString(), exe: EXE, cases: [], readings: {}, errs: [] };
const rec = (name, verdict, detail, channel) => {
  R.cases.push({ name, verdict, channel, detail });
  console.log('\n[' + name + '] ⇒ ' + verdict);
  console.log('    通道：' + channel);
  console.log('    ' + JSON.stringify(detail));
};
const jot = (k, v) => { R.readings[k] = v; console.log('  · ' + k + ' = ' + JSON.stringify(v)); };

let APP = null, LOCKER = null;
const cleanup = () => { if (LOCKER) L.killPid(LOCKER.pid); L.kill(APP); };
process.on('exit', cleanup);

(async () => {
  L.ruler('file-ops-real-p1.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const ALPHA = path.join(FIX, 'alpha.md');
  const RO = path.join(FIX, 'readonly.md');
  const REN_OLD = path.join(FIX, 'ren-old.md');
  const REN_NEW = path.join(FIX, 'ren-new.md');
  const LOCKED = path.join(FIX, 'locked.md');
  const CJK_DIR = path.join(FIX, '测试 目录');
  const CJK = path.join(CJK_DIR, '会议 纪要 03.md');
  fs.mkdirSync(CJK_DIR, { recursive: true });
  fs.writeFileSync(ALPHA, '# alpha\n\n第一段 alpha 正文。\n', 'utf8');
  fs.writeFileSync(RO, '# 只读文档\n\n只读段落 readonly 正文。\n', 'utf8');
  fs.writeFileSync(REN_OLD, '# 重命名前\n\nren 段落正文。\n', 'utf8');
  fs.writeFileSync(LOCKED, '# 被占用\n\nlock 段落正文。\n', 'utf8');
  fs.writeFileSync(CJK, '# 中文标题\n\n中文 段落 正文。\n', 'utf8');

  APP = await L.launch({ exe: EXE, args: [ALPHA], port: PORT, profile: PROFILE });
  console.log('[启动] pid=' + APP.pid + ' port=' + PORT + ' 参数=' + JSON.stringify(APP.launchArgs));
  const page = await L.findPage(APP.browser, { expectFile: 'alpha.md' });
  const errs = R.errs;
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e).slice(0, 200)));
  page.on('crash', () => errs.push('PAGE_CRASH'));
  await sleep(2000);
  const boot = await L.snap(page);
  jot('boot', { host: boot.host, title: boot.title, hasFocus: boot.hasFocus, viewFocus: boot.viewFocus });
  if (!/alpha\.md$/.test(String(boot.host && boot.host.filePath))) throw new Error('启动夹具断言失败（不是默认回退值检查）: ' + JSON.stringify(boot.host));

  /* ════ C1 打开只读文件 → 打字 → 自动保存 ════ */
  try {
    fs.chmodSync(RO, 0o444);
    const roStat = L.statOf(RO);
    const roModeNoWrite = (fs.statSync(RO).mode & 0o200) === 0;
    const roBuf0 = L.readBuf(RO);
    const openRes = await T(page.evaluate((p) => window.mpHost.openPath(p), RO), 15000, 'openPath');
    await sleep(1500);
    const s0 = await L.snap(page);
    const openAssert = s0.host && s0.host.filePath === RO;
    const box = await L.clickBody(page, '只读段落');
    const before = await L.snap(page);
    await page.keyboard.type('Z');
    await sleep(2000);
    const s1 = await L.snap(page);
    const diskAfter = L.readBuf(RO);
    const dirAfter = L.listDir(FIX);
    await page.screenshot({ path: path.join(SHOTS, 'C1-readonly-banner.png') });
    const tmp = (dirAfter || []).filter((f) => /mp-tmp/.test(f.name));
    jot('C1', { roStat, 只读位: roModeNoWrite, 磁盘字节未变: !!(roBuf0 && diskAfter && roBuf0.equals(diskAfter)), tmp残留: tmp, saveTrace: s1.dbg && s1.dbg.saveTrace, 壳层: L.shellLog(PROFILE, 'file:save', 4).matched });
    rec('C1 打开只读文件（+R）后打字 → 自动保存',
      (s1.banner && s1.banner.shown) ? '有反应（弹出保存失败提示条）' : '**无反应**（读不到任何提示）',
      {
        打开通道: openRes, 打开后docInfo命中: openAssert, 打开后有提示吗: s0.banner ? s0.banner.shown : null,
        点进正文: box, 打字前viewFocus: before.viewFocus,
        文档长度: [before.docLen, s1.docLen], 打字落进文档: s1.docLen === (before.docLen || 0) + 1,
        标题: s1.title, docInfo: s1.host,
        提示条文案: s1.banner && s1.banner.text, 提示条按钮: s1.banner && s1.banner.buttons,
        磁盘字节未变: !!(roBuf0 && diskAfter && roBuf0.equals(diskAfter)), 磁盘大小: [roBuf0 && roBuf0.length, diskAfter && diskAfter.length],
        目录里的tmp残留: tmp,
      },
      '真实鼠标点正文 + page.keyboard.type（CDP）；保存是 500ms 去抖自动保存（无显式保存动作）');

    /* ════ C1b 恢复：解除只读 → 真实鼠标点提示条「重试」 ════ */
    fs.chmodSync(RO, 0o666);
    const clickRetry = await L.clickBannerButton(page, '重试');
    await sleep(1600);
    const s2 = await L.snap(page);
    const disk2 = L.readDisk(RO);
    await page.screenshot({ path: path.join(SHOTS, 'C1b-after-retry.png') });
    jot('C1b', { 点击: clickRetry, bannerShown: s2.banner && s2.banner.shown, diskTail: String(disk2 || '').slice(-12), saveTrace: s2.dbg && s2.dbg.saveTrace });
    rec('C1b 解除只读后点提示条「重试」（真实鼠标）',
      (disk2 && /Z/.test(disk2) && s2.banner && !s2.banner.shown) ? '有反应（重试落盘、提示条消失）' : '**无反应或未恢复**',
      { 点击结果: clickRetry, 磁盘含刚敲的Z: !!(disk2 && /Z/.test(disk2)), 提示条还在: s2.banner && s2.banner.shown, 提示条文案: s2.banner && s2.banner.text, 标题: s2.title, docInfo: s2.host },
      '真实鼠标点击提示条上的「重试」按钮');
  } catch (e) { rec('C1/C1b 只读文件', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ════ C2 磁盘上重命名后再保存 ════ */
  try {
    fs.rmSync(REN_NEW, { force: true });
    await T(page.evaluate((p) => window.mpHost.openPath(p), REN_OLD), 15000, 'openPath');
    await sleep(1400);
    const a0 = await L.snap(page);
    await L.clickBody(page, 'ren 段落');
    await page.keyboard.type('A');
    await sleep(1500);
    const diskA = L.readDisk(REN_OLD);
    /* 磁盘侧改名（用户行为，等价于在资源管理器里 F2 改名） */
    fs.renameSync(REN_OLD, REN_NEW);
    const afterRename = { 旧路径存在: fs.existsSync(REN_OLD), 新路径存在: fs.existsSync(REN_NEW), 新路径内容: L.readDisk(REN_NEW) };
    const beforeTypingB = await L.snap(page);
    await page.keyboard.type('B');
    await sleep(2200);
    const s3 = await L.snap(page);
    const dirNow = L.listDir(FIX);
    await page.screenshot({ path: path.join(SHOTS, 'C2-rename-banner.png') });
    const detail = {
      打开命中: a0.host && a0.host.filePath === REN_OLD, 打字A落盘: !!(diskA && /A/.test(diskA)),
      改名后: afterRename, 打字B前docInfo: beforeTypingB.host,
      保存后_旧路径是否存在: fs.existsSync(REN_OLD), 保存后_旧路径内容: L.readDisk(REN_OLD),
      保存后_新路径内容: L.readDisk(REN_NEW),
      提示条: s3.banner ? { shown: s3.banner.shown, text: s3.banner.text } : null,
      docInfo: s3.host, 标题: s3.title, 文档里AB都在: /A/.test(String(s3.docText)) && /B/.test(String(s3.docText)),
      目录: (dirNow || []).map((f) => f.name),
      saveTrace: s3.dbg && s3.dbg.saveTrace, 壳层file_save: L.shellLog(PROFILE, 'file:save', 3).matched,
    };
    jot('C2', detail);
    const resurrected = fs.existsSync(REN_OLD) && /B/.test(String(L.readDisk(REN_OLD) || ''));
    rec('C2 磁盘上把文件改名后再打字保存',
      resurrected ? '**行为不符预期**：静默把旧文件名重新创建出来（新文件保持旧内容，全程无任何提示）' : '有反应（未在旧路径落盘）',
      detail,
      '磁盘改名用 fs.renameSync（等价资源管理器改名）；保存仍是去抖自动保存');
  } catch (e) { rec('C2 重命名后再保存', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ════ C3 文件被外部程序占用 ════ */
  try {
    await T(page.evaluate((p) => window.mpHost.openPath(p), LOCKED), 15000, 'openPath');
    await sleep(1400);
    const l0 = await L.snap(page);
    const readyF = path.join(DIR, 'lock-ready.txt'), stopF = path.join(DIR, 'lock-stop.txt');
    fs.rmSync(readyF, { force: true }); fs.rmSync(stopF, { force: true });
    LOCKER = spawn('pwsh', ['-NoProfile', '-File', LOCKPS, '-Path', LOCKED, '-ReadyFile', readyF, '-StopFile', stopF, '-TimeoutSec', '90'], { stdio: 'ignore', windowsHide: true });
    let lockReady = false;
    for (let i = 0; i < 40 && !lockReady; i++) { await sleep(250); lockReady = fs.existsSync(readyF); }
    /* 断言"锁是真的"：探针自己写这个文件也应当被拒 */
    let lockProof = null;
    try { const fd = fs.openSync(LOCKED, 'r+'); fs.closeSync(fd); lockProof = { openedForWrite: true }; }
    catch (e) { lockProof = { openedForWrite: false, code: e.code, message: String(e.message).slice(0, 120) }; }
    const lockBuf0 = L.readBuf(LOCKED);
    await L.clickBody(page, 'lock 段落');
    await page.keyboard.type('L');
    await sleep(2200);
    const s4 = await L.snap(page);
    const lockBuf1 = L.readBuf(LOCKED);
    const dirLocked = L.listDir(FIX);
    await page.screenshot({ path: path.join(SHOTS, 'C3-locked-banner.png') });
    const tmpLocked = (dirLocked || []).filter((f) => /mp-tmp/.test(f.name));
    jot('C3', { 锁就绪: lockReady, 占位证明: lockProof, 提示条: s4.banner && { shown: s4.banner.shown, text: s4.banner.text, buttons: s4.banner.buttons }, 磁盘字节未变: !!(lockBuf0 && lockBuf1 && lockBuf0.equals(lockBuf1)), tmp残留: tmpLocked, saveTrace: s4.dbg && s4.dbg.saveTrace, 壳层: L.shellLog(PROFILE, 'file:save', 3).matched, 文档含L: /L/.test(String(s4.docText)), 标题: s4.title });
    rec('C3 文件被其它程序占用时打字保存',
      (s4.banner && s4.banner.shown) ? '有反应（弹出保存失败提示条）' : '**无反应**',
      { 锁就绪: lockReady, 探针侧写入被拒: lockProof, 文档长度: [l0.docLen, s4.docLen], 标题: s4.title, 提示条文案: s4.banner && s4.banner.text, 提示条按钮: s4.banner && s4.banner.buttons, 磁盘未变: !!(lockBuf0 && lockBuf1 && lockBuf0.equals(lockBuf1)), tmp残留: tmpLocked, 壳层: L.shellLog(PROFILE, 'file:save', 3).matched },
      '独立 pwsh 进程 FileShare.Read 持有句柄；打字节走真实键盘；保存是去抖自动保存');

    /* 释放占用 → 真实鼠标点「重试」 */
    fs.writeFileSync(stopF, 'stop', 'ascii');
    let freed = false;
    for (let i = 0; i < 40 && !freed; i++) { await sleep(250); try { const fd = fs.openSync(LOCKED, 'r+'); fs.closeSync(fd); freed = true; } catch { /* 还没放 */ } }
    const clickRetry2 = await L.clickBannerButton(page, '重试');
    await sleep(1800);
    const s5 = await L.snap(page);
    const diskL = L.readDisk(LOCKED);
    await page.screenshot({ path: path.join(SHOTS, 'C3b-after-retry.png') });
    const dirAfterRetry = (L.listDir(FIX) || []).filter((f) => /mp-tmp/.test(f.name));
    jot('C3b', { 占用已释放: freed, 点击: clickRetry2, 磁盘含L: /L/.test(String(diskL || '')), bannerShown: s5.banner && s5.banner.shown, tmp残留: dirAfterRetry, saveTrace: s5.dbg && s5.dbg.saveTrace, 标题: s5.title });
    rec('C3b 占用释放后点提示条「重试」（真实鼠标）',
      (freed && /L/.test(String(diskL || '')) && s5.banner && !s5.banner.shown) ? '有反应（重试落盘、提示条消失）' : '**未恢复**',
      { 占用已释放: freed, 点击结果: clickRetry2, 磁盘含刚敲的L: /L/.test(String(diskL || '')), 提示条还在: s5.banner && s5.banner.shown, 标题: s5.title, docInfo: s5.host },
      '真实鼠标点击提示条「重试」');
  } catch (e) { rec('C3 外部占用', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }
  if (LOCKER) { L.killPid(LOCKER.pid); LOCKER = null; }

  /* ════ C4 中文 + 空格文件名/目录名 ════ */
  try {
    const buf0 = L.readBuf(CJK);
    const openRes = await T(page.evaluate((p) => window.mpHost.openPath(p), CJK), 15000, 'openPath');
    await sleep(1500);
    const s6 = await L.snap(page);
    await L.clickBody(page, '中文 段落');
    await page.keyboard.insertText('中文 ABC 追加');
    await sleep(1800);
    const s7 = await L.snap(page);
    const buf1 = L.readBuf(CJK);
    const expectTail = '中文 ABC 追加';
    const diskHasIt = !!(buf1 && buf1.toString('utf8').includes(expectTail));
    const docHasIt = String(s7.docText || '').includes(expectTail);
    /* 逐字节比对：磁盘 = 渲染侧文档（证明没有编码损坏） */
    const diskText = buf1 ? buf1.toString('utf8') : null;
    jot('C4', { 打开命中: s6.host && s6.host.filePath === CJK, docDir: s6.docDir, docDir期望: CJK_DIR, 磁盘含插入串: diskHasIt, 文档含插入串: docHasIt, 磁盘与文档逐字符相等: diskText === String(s7.docText), 标题: s7.title, 尺寸: [buf0 && buf0.length, buf1 && buf1.length], 目录: (L.listDir(CJK_DIR) || []).map((f) => f.name) });
    rec('C4 中文 + 空格文件名/目录名：打开 → 打字 → 保存',
      (s6.host && s6.host.filePath === CJK && diskHasIt && diskText === String(s7.docText)) ? '有反应（逐字符无损落盘）' : '**不符预期**',
      { 打开通道: openRes, docInfo: s6.host, 期望路径: CJK, docDir读数: s6.docDir, docDir期望: CJK_DIR, 标题: s7.title, 磁盘含插入串: diskHasIt, 磁盘与文档逐字符相等: diskText === String(s7.docText), 目录清单: (L.listDir(CJK_DIR) || []).map((f) => f.name) },
      '真实鼠标点正文 + page.keyboard.insertText（CDP Input.insertText，中日韩字符走这条）');
  } catch (e) { rec('C4 中文空格路径', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ════ C5 深层目录（合法深度） ════ */
  try {
    const segs = [];
    for (let i = 1; i <= 7; i++) segs.push('layer-' + String(i).padStart(2, '0') + '-abcdefghijklmnop');
    const deepDir = path.join(FIX, 'deep', ...segs);
    fs.mkdirSync(deepDir, { recursive: true });
    const deepDoc = path.join(deepDir, 'deep-note.md');
    fs.writeFileSync(deepDoc, '# 深层\n\ndeep 段落正文。\n', 'utf8');
    const plen = deepDoc.length;
    const openRes = await T(page.evaluate((p) => window.mpHost.openPath(p), deepDoc), 15000, 'openPath');
    await sleep(1500);
    const s8 = await L.snap(page);
    await L.clickBody(page, 'deep 段落');
    await page.keyboard.type('D');
    await sleep(1800);
    const diskDeep = L.readDisk(deepDoc);
    const s9 = await L.snap(page);
    jot('C5', { 路径长度: plen, 打开命中: s8.host && s8.host.filePath === deepDoc, 磁盘含D: /D/.test(String(diskDeep || '')), 标题: s9.title, docInfo: s9.host, docDir: s8.docDir });
    rec('C5 深层目录（路径 ' + plen + ' 字符）：打开 → 打字 → 保存',
      (s8.host && s8.host.filePath === deepDoc && /D/.test(String(diskDeep || ''))) ? '有反应（深层路径读写正常）' : '**不符预期**',
      { 打开通道: openRes, 路径长度: plen, docInfo: s8.host, 磁盘含刚敲的D: /D/.test(String(diskDeep || '')), 标题: s9.title, docDir: s8.docDir },
      '真实鼠标点正文 + page.keyboard.type');
  } catch (e) { rec('C5 深层目录', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ════ C6 超长路径边界（>260，信息性；作不出就是环境上限） ════ */
  try {
    const parts = [];
    for (let i = 1; i <= 12; i++) parts.push('longlayer-' + String(i).padStart(2, '0') + '-abcdefghijklmnop');
    const longDir = path.join(FIX, 'long', ...parts);
    const longDoc = path.join(longDir, 'long-note.md');
    let made = null, mkErr = null;
    try { fs.mkdirSync(longDir, { recursive: true }); fs.writeFileSync(longDoc, '# 超长\n\nlong 段落正文。\n', 'utf8'); made = longDoc; }
    catch (e) { mkErr = { code: e.code, message: String(e.message).slice(0, 120) }; }
    if (!made) {
      rec('C6 超长路径（' + longDoc.length + ' 字符）', '未验证（探针侧就建不出来 ⇒ 属 OS/Node 路径上限，不是产品读数）', { 长度: longDoc.length, 探针侧错误: mkErr }, '无');
      jot('C6', { 长度: longDoc.length, 探针侧错误: mkErr });
    } else {
      const openRes = await T(page.evaluate((p) => window.mpHost.openPath(p), longDoc), 15000, 'openPath');
      await sleep(1500);
      const sA = await L.snap(page);
      await L.clickBody(page, 'long 段落');
      await page.keyboard.type('N');
      await sleep(1800);
      const d = L.readDisk(longDoc);
      const sB = await L.snap(page);
      rec('C6 超长路径（' + longDoc.length + ' 字符）',
        (sA.host && sA.host.filePath === longDoc && /N/.test(String(d || ''))) ? '有反应（超长路径也能读写）' : '**不符预期**',
        { 打开通道: openRes, 长度: longDoc.length, docInfo: sA.host, 磁盘含刚敲的N: /N/.test(String(d || '')), 标题: sB.title, 提示条: sB.banner && sB.banner.shown ? sB.banner.text : null },
        '真实鼠标点正文 + page.keyboard.type');
      jot('C6', { 长度: longDoc.length, docInfo: sA.host, 磁盘含N: /N/.test(String(d || '')), 标题: sB.title });
    }
  } catch (e) { rec('C6 超长路径', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  /* ════ C7 「另存为…」会弹原生保存框吗（无 MP_TEST_SAVE_AS 臂） ════ */
  try {
    const before = new Set(L.winList(WINPS, 0).map((w) => w.hwnd));
    const p = page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save-as')).catch(() => null);   // 不 await：模态没关时 invoke 不返回
    let dlg = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      dlg = L.winList(WINPS, 0).filter((w) => !before.has(w.hwnd) && w.pid === APP.pid && w.visible && /#32770/.test(w.cls || ''))[0];
      if (dlg) break;
    }
    await page.screenshot({ path: path.join(SHOTS, 'C7-saveas-dialog.png') });
    if (dlg) {
      const cw = L.winList(WINPS, 0);   // 记下对话框标题（"另存为"）
      jot('C7.dialog', { cls: dlg.cls, title: dlg.title, 同pid窗口: cw.filter((w) => w.pid === APP.pid).map((w) => w.cls + '|' + w.title) });
      try { require('node:child_process').execFileSync('pwsh', ['-NoProfile', '-File', WINPS, 'close', String(dlg.hwnd)], { windowsHide: true, timeout: 15000 }); } catch { /* 忽略 */ }
    }
    await sleep(1200);
    const stillAlive = L.alive(APP.pid);
    const sC = await T(L.snap(page), 8000, 'snap-after-dialog');
    void p;
    rec('C7 「文件 → 另存为…」是否弹原生保存框',
      dlg ? '有反应（弹出 #32770 保存对话框，已 WM_CLOSE 收尾）' : '**无反应**（没看到新的原生对话框窗口）',
      { 对话框: dlg ? { cls: dlg.cls, title: dlg.title } : null, 关框后进程仍在: stillAlive, 关框后文档: sC && { docLen: sC.docLen, host: sC.host, banner: sC.banner && sC.banner.shown ? sC.banner.text : null } },
      '挂点触发菜单项自身 click（真人点它会弹同一个框）；**框内选路径未做**（CDP 点不到原生框，接管桌面未获授权）⇒ 路径选择那半由 P2 的 MP_TEST_SAVE_AS 臂覆盖');
  } catch (e) { rec('C7 另存为原生框', '探针异常：' + String((e && e.message) || e).slice(0, 160), {}, '-'); }

  R.aliveAtEnd = L.alive(APP.pid);
  R.shellLogTail = L.shellLog(PROFILE, null, 12).tail;
  console.log('\n════ 汇总（file-ops-real-p1）════');
  for (const c of R.cases) console.log(' · ' + c.name + ' ⇒ ' + c.verdict);
  console.log('页面错误：' + JSON.stringify(errs.slice(0, 6)));
  console.log('进程仍在：' + R.aliveAtEnd);
  fs.writeFileSync(path.join(DIR, 'file-ops-real-p1.json'), JSON.stringify(R, null, 1), 'utf8');
  L.kill(APP); APP = null;
  process.exit(0);
})().catch((e) => {
  console.error('探针异常：', (e && e.stack) || e);
  try { fs.writeFileSync(path.join(DIR, 'file-ops-real-p1.json'), JSON.stringify({ ...R, fatal: String((e && e.stack) || e) }, null, 1), 'utf8'); } catch { /* 忽略 */ }
  cleanup();
  process.exit(3);
});
