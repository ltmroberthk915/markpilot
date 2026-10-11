/** 探针 · R10 W1 confirmDiscard 四早退族（规格=主会话重建版，E9 追加节未落盘）。
 *
 *  四门（全部裸读 dirty，而 dirty 落后键入 ≤200ms 去抖）：
 *   门1 main.js close 处理器  门2 main.js before-quit 过滤
 *   门3 doc.js openFile        门4 doc.js confirmDiscard 本体
 *
 *  场景（--phase=red 在未修树上跑期望「无框+丢字」；--phase=green 期望弹框且三选择语义正确）：
 *   cd1 关窗：双窗口 [甲,乙]，在甲窗真键入 3 字 → <200ms 真键 Ctrl+W。
 *        对照臂：等 1s（dirty 已落）再关 → 必有框（证明时序窗存在，红绿两轮都跑）；
 *        对照后真键 Ctrl+S 洗净文档，主臂才能吃到「干净→键入未达」的红态。
 *        绿轮三选择：取消=窗口留住；保存=关窗且磁盘含新字（两会话）；放弃=关窗不落盘。
 *   cd2 退出：单窗甲，真键入 → <200ms 主进程 app.quit()（菜单 role 退出的同一入口）。
 *   cd3 切档：单窗甲，真键入 → <200ms clickMenu 文件>在此窗口打开文件…（open 桩回乙）。
 *   cd5/6/7 负门（防 flush 假阳性置脏）：不键入 → 真键 Ctrl+S（触发 flushEditorText）→
 *        关窗 / 退出 / 切档：一律不得弹「未保存」框，磁盘字节+mtime 纹丝不动。
 *
 *  通道纪律：键入=CDP Input.insertText；关窗=Ctrl+W 真组合键（菜单加速键 role close）；
 *  切档=菜单 clickMenu+对话框桩（系统对话框 CDP 送不进去，桩只顶「用户选了什么」）。
 *  主判据=磁盘字节 + 对话框桩调用记录 + 窗口/进程存活；截图作可见性质佐证——
 *  红轮关键帧=去抖窗内抢拍（字已上屏、st-save 仍「已保存」），绿轮关键帧=取消后脏标 2x。
 *
 *  用法：node scripts/acceptance/probe-r10-cd.cjs [--phase=red|green] [--only=cd1,cd2,cd3,cd5,cd6,cd7] [--fresh]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=green').slice(8) === 'red' ? 'red' : 'green';
const OUT = path.join(harness.project, '.perf/probe-r10-cd');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const MOD = hi.MOD;
const RED = PHASE === 'red';

const readDisk = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const shaOf = f => { try { return harness.fileSha(f); } catch { return null; } };
const statOf = f => { try { const s = fs.statSync(f); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };
const appAlive = session => session.child.exitCode === null;
const sleep = harness.sleep;

// ─── 素材 ─────────────────────────────────────────────────────────────────────
function mat(name, content) { const f = path.join(OUT, name); fs.writeFileSync(f, content, 'utf8'); return f; }
const RESET = {
  cd1A: '# cd1 甲\n\n关窗靶点段：四早退门一，字尾在此。\n\n第二段：承接。\n',
  cd2A: '# cd2 退出\n\n退出靶点段：门二，字尾在此。\n',
  cd3A: '# cd3 甲\n\n切档靶点段：门三，字尾在此。\n',
};
const DOC = {
  cd1A: () => mat('r10-cd1-甲.md', RESET.cd1A),
  cd1B: () => mat('r10-cd1-乙.md', '# cd1 乙\n\n乙的内容段。\n'),
  cd2A: () => mat('r10-cd2-甲.md', RESET.cd2A),
  cd3A: () => mat('r10-cd3-甲.md', RESET.cd3A),
  cd3B: () => mat('r10-cd3-乙.md', '# cd3 乙\n\n乙的内容段。\n'),
  cd5A: () => mat('r10-cd5-甲.md', '# cd5 负门\n\n干净文档：负门靶点段。\n'),
  cd6A: () => mat('r10-cd6-甲.md', '# cd6 负门\n\n干净文档：负门靶点段。\n'),
  cd7A: () => mat('r10-cd7-甲.md', '# cd7 负门甲\n\n干净文档：负门靶点段。\n'),
  cd7B: () => mat('r10-cd7-乙.md', '# cd7 乙\n\n乙的内容段。\n'),
};

// ─── 通用 ─────────────────────────────────────────────────────────────────────
async function launchCase(label, args) {
  return harness.launch({
    exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}), label: 'probe-r10-cd/' + label,
    outDir: OUT, timeout: 200000, args, inspect: true,
  });
}
async function waitDocs(session, { count = 1, timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const recs = await session.recs();
      if (recs && recs.length >= count && recs.every(r => r.file)) return recs;
    } catch { /* 主进程未就绪 */ }
    await sleep(150);
  }
  throw new Error('窗口/文档没就绪：' + JSON.stringify(await session.recs().catch(() => null)));
}
async function autoSaveOff(session) {
  await session.main.js(`(() => { for (const r of global.windows) r.doc.setSetting('autoSave', false); return global.windows.length; })()`);
}
const msgCalls = async session => {
  try { return (await session.main.calls()).filter(c => c.kind === 'message' && /未保存/.test(String(c.options && c.options.message || ''))); }
  catch { return null; }
};
/** 主进程读取带超时：--inspect 下退出中的进程会停在「Waiting for the debugger to
 *  disconnect」，此时 evaluate 可能永久挂起——挂起不是失败，按读不到处理。 */
const withTimeout = (promise, ms) => Promise.race([
  Promise.resolve(promise).then(v => v, () => null),
  sleep(ms).then(() => null),
]);
const msgCallsSafe = session => withTimeout(msgCalls(session), 2500);
const recsSafe = async session => await withTimeout(session.recs(), 3000);
/** 退出类判定的收尾。存活判据用 pages()（DevTools HTTP 端点=浏览器进程的真相）：
 *  debugger-wait 态里主进程 evaluate 不可信（实测 1+1 解析成 null 而不是挂起，级联中途
 *  又会正常应答），只有「还有没有页面目标」能区分「取消留窗」与「退出中/已停等调试器」。
 *  停等调试器（Waiting for the debugger to disconnect）必须由我们断开 inspector socket
 *  进程才会退。取消臂（窗口还在）不关调试器——后续臂还要用。 */
async function finishExitProbe(session) {
  const calls = await msgCallsSafe(session);   // 有框的话此刻桩已记录
  await sleep(1500);                            // 等退出级联走完 / 取消后回稳
  let pages = null;
  try { pages = (await session.pages()).length; } catch { /* 端点随进程消失 */ }
  if (pages !== null && pages > 0) return { calls, exit: { exited: false, atMs: 0 }, mode: 'alive' };
  try { session.main.close(); } catch { /* 已断 */ }
  const exit = await waitExit(session, 12000);
  return { calls, exit, mode: exit.exited ? 'exited' : (pages === null ? 'no-page-info' : 'stuck') };
}
async function waitExit(session, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (!appAlive(session)) return { exited: true, atMs: Date.now() - t0 }; await sleep(200); }
  return { exited: false, atMs: Date.now() - t0 };
}
const dirtyOf = async session => { try { return await session.main.js(`JSON.stringify(global.windows.map(r => ({ file: r.doc.file, dirty: r.doc.dirty })))`); } catch { return null; } };
/** 把装着 file 的窗口抬到前台（双窗口下另一窗装载完成会抢走 OS 焦点，菜单加速键
 *  Ctrl+W/Ctrl+S 只对 OS 焦点窗生效——CDP 键事件走渲染层管线，触发不了后台窗的加速键）。 */
async function focusWin(session, file) {
  await session.main.js(`(() => { const rec = global.windows.find(r => String(r.doc.file || '').toLowerCase() === ${JSON.stringify(file.toLowerCase())});
    if (rec && rec.win && !rec.win.isDestroyed()) { if (rec.win.isMinimized()) rec.win.restore(); rec.win.focus(); } return true; })()`);
  await sleep(250);
}

/** 把会话对准装着 file 的那个窗口，并把该窗口抬到前台（CDP 合成点击不会抬 OS 窗口，
 *  后台窗 document.hasFocus()=false，键入与 Ctrl+W 加速键都会送错对象）。 */
async function pageFor(session, file) {
  const recs = await session.recs();
  const target = recs.find(r => String(r.file || '').toLowerCase() === file.toLowerCase());
  if (!target) throw new Error('没找到装 ' + file + ' 的窗口：' + JSON.stringify(recs));
  await session.main.js(`(() => { const rec = global.windows.find(r => r.id === ${Number(target.id)});
    if (rec && rec.win && !rec.win.isDestroyed()) { if (rec.win.isMinimized()) rec.win.restore(); rec.win.focus(); } return true; })()`);
  await sleep(400);
  const pages = await session.pages();
  const bound = pages.find(p => String(p.url).includes('acc-win-' + target.id));
  if (bound) return session;
  return session.attachWindow(target.id);
}

/** 点击靶点段并把光标放行尾（真点击 + End 真键），随后断言焦点在编辑面。 */
async function focusTailOf(page, marker) {
  await hi.ensureFocus(page);
  const point = await page.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
    const root = w.document.querySelector(${JSON.stringify(hi.SURFACE)});
    const block = [...root.children].find(b => b.textContent.includes(${JSON.stringify(marker)}));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!point) throw new Error('找不到靶点段：' + marker);
  await page.click(point.x, point.y);
  await sleep(240);
  await page.key({ key: 'End', code: 'End', vk: 35 });
  await sleep(160);
  const focusOK = await page.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) throw new Error('焦点不在编辑器：' + JSON.stringify(focusOK));
  return point;
}

/** Ctrl+W 组合键流水线（fire-and-forget）：红轮窗口会在 W↓ 的处理里当场销毁，
 *  任何回包都可能永不到（等回包=60s 假超时）；派发顺序即生效顺序。 */
function typeThenCloseSendKeys(page) {
  const fire = p => Promise.resolve(p).catch(() => {});
  fire(hi.keyDown(page, 'Control', { modifiers: MOD.ctrl }));
  fire(hi.keyDown(page, 'W', { modifiers: MOD.ctrl }));
  fire(hi.keyUp(page, 'W', { modifiers: MOD.ctrl }));
  fire(hi.keyUp(page, 'Control', { modifiers: MOD.ctrl }));
}
/** 键入后 <200ms 真组合键 Ctrl+W（同刻流水线派发）。 */
function typeThenClose(page, text) {
  const t0 = Date.now();
  const fire = p => Promise.resolve(p).catch(() => {});
  fire(page.send('Input.insertText', { text }));
  fire(hi.keyDown(page, 'Control', { modifiers: MOD.ctrl }));
  fire(hi.keyDown(page, 'W', { modifiers: MOD.ctrl }));
  const dispatched = Date.now();
  fire(hi.keyUp(page, 'W', { modifiers: MOD.ctrl }));
  fire(hi.keyUp(page, 'Control', { modifiers: MOD.ctrl }));
  return { gapMs: dispatched - t0 };
}
/** 键入（等回包=渲染层已处理）后 <200ms 主进程 app.quit()。 */
async function typeThenQuit(session, text) {
  const t0 = Date.now();
  await session.send('Input.insertText', { text });
  const ack = Date.now();
  try { await session.main.js(`(() => { require('electron').app.quit(); return 'quit'; })()`); }
  catch { /* 应用随即退出时回包可能丢——触发本身已送达 */ }
  return { ackMs: ack - t0, gapMs: Date.now() - ack };
}
/** 键入（等回包）后 <200ms 点「文件>在此窗口打开文件…」。steps=完整对话框步骤表
 *  （含 message/open）——必须由本函数统一下发：先前版本调用方先 script(message)、本函数
 *  再 script(open)，后者把前者整个覆盖掉，保存臂的弹框吃到 fallback=取消（探针 bug）。 */
async function typeThenMenuOpenHere(session, text, steps) {
  const t0 = Date.now();
  await session.send('Input.insertText', { text });
  const ack = Date.now();
  await session.main.script(steps);
  const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
  return { ackMs: ack - t0, gapMs: Date.now() - ack, clicked };
}

/** st-save 区域矩形（2x 抢拍用，提前取好坐标，抢拍时不再查询）。 */
const saveRect = page => page.js(`(() => { const el = document.querySelector('#st-save'); if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
/** 去抖窗内抢拍：与键入同刻发出截屏请求（CDP 按序处理，帧≈键入后 100-300ms——
 *  字已上屏、而 st-save 的 ● 要等 200ms 去抖+推送+400ms 统计去抖才亮，窗内必是净态）。 */
async function shotSoon(page, rect, name) {
  const full = page.send('Page.captureScreenshot', { format: 'png' });
  const clip = rect ? page.send('Page.captureScreenshot', { format: 'png',
    clip: { x: Math.max(0, rect.x - 150), y: Math.max(0, rect.y - 12), width: 540, height: 40, scale: 2 } }) : null;
  const done = [];
  try { fs.writeFileSync(path.join(OUT, name + '-full.png'), Buffer.from((await full).data, 'base64')); done.push('full'); } catch {}
  try { if (clip) { fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from((await clip).data, 'base64')); done.push('2x'); } } catch {}
  return done;
}
/** 稳态截图：整幅 + st-save 2x（绿轮「取消后脏标」等关键帧）。 */
async function shotState(page, name) {
  try {
    await page.shot(name + '-full');
    const rect = await saveRect(page);
    if (rect) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png',
        clip: { x: Math.max(0, rect.x - 150), y: Math.max(0, rect.y - 12), width: 540, height: 40, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    }
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 80) + '）'); }
}

const log = [];
const report = (name, verdict, detail) => {
  const line = 'R10CD ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
  console.log(line); log.push(line);
};

// ─── cd1 关窗 ──────────────────────────────────────────────────────────────────
async function cd1() {
  const A = DOC.cd1A(), B = DOC.cd1B();
  const results = {};
  // —— 会话一：对照臂（等 1s → 有框）→ 洗净 → 主臂（<200ms 立即关）——
  {
    const session = await launchCase('cd1-main', [A, B]);
    try {
      await waitDocs(session, { count: 2 });
      const page = await pageFor(session, A);
      await autoSaveOff(session);
      await focusTailOf(page, '关窗靶点段');
      // 对照臂：dirty 已落账 → 关窗必须有确认框（脚本「取消」→ 窗口留住）
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 2 }]);
      await page.type('对照拍');
      await sleep(1100);
      await focusWin(session, A);
      await hi.combo(page, 'Ctrl+W');
      await sleep(2200);
      const contrastCalls = await msgCalls(session);
      const contrastRecs = await recsSafe(session);
      results.对照臂 = { 有框: !!(contrastCalls && contrastCalls.length), 窗口数: contrastRecs ? contrastRecs.length : 0 };
      // 洗净：真键 Ctrl+S（把对照拍落盘、dirty 归零），主臂才能吃到「干净→键入未达」红态
      await focusWin(session, A);
      await hi.combo(page, 'Ctrl+S');
      await sleep(1000);
      const clean = JSON.parse(await dirtyOf(session) || '[]');
      results.洗净后 = { 甲脏: !!(clean[0] && clean[0].dirty) };
      // 主臂：<200ms 立即关（键入回包后抢拍、再流水线派发 Ctrl+W）
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 2 }]); // 有框就必须「取消」停住
      const rect = await saveRect(page);
      await focusWin(session, A);
      await hi.ensureFocus(page);
      const t0 = Date.now();
      await page.send('Input.insertText', { text: '甲乙丙' });
      const ack = Date.now();
      const shotP = shotSoon(page, rect, 'cd1-' + (RED ? '红' : '绿') + '-键入后净态');
      const dispatched = Date.now();
      typeThenCloseSendKeys(page);
      results.抢拍 = await shotP;
      const typed = { gapMs: dispatched - ack, ackMs: ack - t0 };
      await sleep(2400);
      const calls = await msgCalls(session);
      const recs = await recsSafe(session);
      const disk = readDisk(A) || '';
      results.主臂 = { gapMs: typed.gapMs, 有框: !!(calls && calls.length), 窗口数: recs ? recs.length : 0,
        磁盘含新字: disk.includes('甲乙丙'), 磁盘含对照拍: disk.includes('对照拍'),
        无框丢字: (!calls || !calls.length) && !disk.includes('甲乙丙') && (!recs || recs.length < 2) };
      if (RED && recs && recs.length === 1) {
        // 红轮取证：甲窗已无声消失、只剩乙窗、无任何弹框帧
        try { const pageB = await session.attachWindow(recs[0].id); await pageB.shot('cd1-红-关后-仅乙窗-full'); } catch {}
      }
      if (!RED && calls && calls.length && recs && recs.length === 2) {
        // 绿·取消臂成立：视觉证据（脏标已亮）→ 第二拍选「保存」
        await shotState(page, 'cd1-绿-取消后脏标');
        await session.main.clearCalls();
        await session.main.script([{ dialog: 'message', response: 0 }]);
        await focusWin(session, A);
        await typeThenClose(page, '丁戊');
        await sleep(2800);
        const recs2 = await recsSafe(session);
        results.保存臂 = { 窗口数: recs2 ? recs2.length : 0, 磁盘含全部新字: (readDisk(A) || '').includes('甲乙丙丁戊') };
      }
    } catch (error) { results.异常 = String(error && error.message || error).slice(0, 300); }
    finally { await session.close().catch(() => {}); }
  }
  // —— 会话二（仅绿轮）：放弃臂 ——
  if (!RED) {
    const session = await launchCase('cd1-discard', [A, B]);
    try {
      fs.writeFileSync(A, RESET.cd1A, 'utf8');
      await waitDocs(session, { count: 2 });
      const page = await pageFor(session, A);
      await autoSaveOff(session);
      await focusTailOf(page, '关窗靶点段');
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 1 }]);
      await focusWin(session, A);
      await typeThenClose(page, '甲乙丙');
      await sleep(2800);
      const recs = await recsSafe(session);
      const calls = await msgCalls(session);
      results.放弃臂 = { 有框: !!(calls && calls.length), 窗口数: recs ? recs.length : 0,
        磁盘不含新字: !(readDisk(A) || '').includes('甲乙丙'), 应用存活: appAlive(session) };
    } catch (error) { results.放弃臂异常 = String(error && error.message || error).slice(0, 300); }
    finally { await session.close().catch(() => {}); }
  }
  const main = results.主臂 || {};
  const contrastOK = results.对照臂 && results.对照臂.有框 && results.对照臂.窗口数 === 2;
  const cleanOK = results.洗净后 && !results.洗净后.甲脏;
  let verdict = 'FAIL';
  if (RED) verdict = (main.无框丢字 && contrastOK && cleanOK) ? 'PASS' : 'FAIL';
  else {
    const cancelOK = main.有框 && main.窗口数 === 2;
    const saveOK = results.保存臂 && results.保存臂.窗口数 === 1 && results.保存臂.磁盘含全部新字;
    const discardOK = results.放弃臂 && results.放弃臂.窗口数 === 1 && results.放弃臂.磁盘不含新字;
    verdict = (cancelOK && saveOK && discardOK) ? 'PASS' : 'FAIL';
  }
  report('cd1', verdict, results);
}

// ─── cd2 退出 ──────────────────────────────────────────────────────────────────
async function cd2() {
  const A = DOC.cd2A();
  const results = {};
  {
    const session = await launchCase('cd2-main', [A]);
    try {
      await waitDocs(session);
      await autoSaveOff(session);
      await focusTailOf(session, '退出靶点段');
      // 对照臂：等 1s → quit 必有框（脚本取消 → 进程留住，且此刻能读到桩记录）
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 2 }]);
      await session.type('对照拍');
      await sleep(1100);
      try { await session.main.js(`(() => { require('electron').app.quit(); return 'quit'; })()`); } catch {}
      await sleep(2400);
      const contrastCalls = await msgCalls(session);
      results.对照臂 = { 有框: !!(contrastCalls && contrastCalls.length), 进程留存: appAlive(session) };
      // 洗净
      await hi.combo(session, 'Ctrl+S');
      await sleep(1000);
      const clean = JSON.parse(await dirtyOf(session) || '[]');
      results.洗净后 = { 甲脏: !!(clean[0] && clean[0].dirty) };
      // 主臂：立即 quit（抢拍请求在 quit 派发前发出，帧仍落在活页上）
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 2 }]);
      const rect = await saveRect(session);
      const t0 = Date.now();
      await session.send('Input.insertText', { text: '甲乙丙' });
      const ack = Date.now();
      const shotP = shotSoon(session, rect, 'cd2-' + (RED ? '红' : '绿') + '-键入后净态');
      const quitAt = Date.now();
      try { await session.main.js(`(() => { require('electron').app.quit(); return 'quit'; })()`); } catch { /* 随即退出时回包可能丢 */ }
      results.抢拍 = await shotP;
      const probe = await finishExitProbe(session);
      const disk = readDisk(A) || '';
      results.主臂 = { ackMs: ack - t0, gapMs: quitAt - ack, 退出: probe.exit.exited, 退出耗时ms: probe.exit.atMs,
        收尾模式: probe.mode, 桩记录可读: !!probe.calls, 有框: !!(probe.calls && probe.calls.length),
        磁盘含新字: disk.includes('甲乙丙'), 磁盘含对照拍: disk.includes('对照拍'),
        无框退出丢字: probe.exit.exited && !disk.includes('甲乙丙') };
      if (!RED && !probe.exit.exited && probe.calls && probe.calls.length) {
        // 绿·取消臂成立 → 第二拍选「保存」再 quit
        await shotState(session, 'cd2-绿-取消后脏标');
        await session.main.clearCalls();
        await session.main.script([{ dialog: 'message', response: 0 }]);
        await typeThenQuit(session, '丁戊');
        const probe2 = await finishExitProbe(session);
        results.保存臂 = { 退出: probe2.exit.exited, 磁盘含全部新字: (readDisk(A) || '').includes('甲乙丙丁戊') };
      }
    } catch (error) { results.异常 = String(error && error.message || error).slice(0, 300); }
    finally { await session.close().catch(() => {}); }
  }
  if (!RED) {
    const session = await launchCase('cd2-discard', [A]);
    try {
      fs.writeFileSync(A, RESET.cd2A, 'utf8');
      await waitDocs(session);
      await autoSaveOff(session);
      await focusTailOf(session, '退出靶点段');
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 1 }]);
      await typeThenQuit(session, '甲乙丙');
      const probe = await finishExitProbe(session);
      results.放弃臂 = { 退出: probe.exit.exited, 磁盘不含新字: !(readDisk(A) || '').includes('甲乙丙') };
    } catch (error) { results.放弃臂异常 = String(error && error.message || error).slice(0, 300); }
    finally { await session.close().catch(() => {}); }
  }
  const main = results.主臂 || {};
  const contrastOK = results.对照臂 && results.对照臂.有框 && results.对照臂.进程留存;
  const cleanOK = results.洗净后 && !results.洗净后.甲脏;
  let verdict = 'FAIL';
  if (RED) verdict = (main.无框退出丢字 && contrastOK && cleanOK) ? 'PASS' : 'FAIL';
  else {
    const cancelOK = !main.退出 && main.有框;
    const saveOK = results.保存臂 && results.保存臂.退出 && results.保存臂.磁盘含全部新字;
    const discardOK = results.放弃臂 && results.放弃臂.退出 && results.放弃臂.磁盘不含新字;
    verdict = (cancelOK && saveOK && discardOK && contrastOK) ? 'PASS' : 'FAIL';
  }
  report('cd2', verdict, results);
}

// ─── cd3 切档 ──────────────────────────────────────────────────────────────────
async function cd3() {
  const A = DOC.cd3A(), B = DOC.cd3B();
  const results = {};
  const session = await launchCase('cd3', [A]);
  try {
    await waitDocs(session);
    await autoSaveOff(session);
    await focusTailOf(session, '切档靶点段');
    // 对照臂：等 1s → 切档必有框（脚本取消 → 留在甲）
    await session.main.clearCalls();
    await session.main.script([{ dialog: 'message', response: 2 }, { dialog: 'open', files: [B] }]);
    await session.type('对照拍');
    await sleep(1100);
    const clicked0 = await session.main.clickMenu('文件 > 在此窗口打开文件…');
    await sleep(2000);
    const contrastCalls = await msgCalls(session);
    const recs0 = await recsSafe(session);
    results.对照臂 = { clicked: clicked0, 有框: !!(contrastCalls && contrastCalls.length),
      仍甲: recs0 && recs0[0] && String(recs0[0].file).includes('r10-cd3-甲') };
    // 洗净
    await hi.combo(session, 'Ctrl+S');
    await sleep(1000);
    const clean = JSON.parse(await dirtyOf(session) || '[]');
    results.洗净后 = { 甲脏: !!(clean[0] && clean[0].dirty) };
    // 主臂：<200ms 立即切档（open 桩回乙；message 无脚本 → 默认「取消」= 有框就必须留下）
    await session.main.clearCalls();
    const rect = await saveRect(session);
    const shotP = shotSoon(session, rect, 'cd3-' + (RED ? '红' : '绿') + '-键入后净态');
    const typed = await typeThenMenuOpenHere(session, '甲乙丙', [{ dialog: 'open', files: [B] }]);
    results.抢拍 = await shotP;
    await sleep(2600);
    const calls = await msgCalls(session);
    const recs = await recsSafe(session);
    const disk = readDisk(A) || '';
    const nowB = recs && recs[0] && String(recs[0].file).includes('r10-cd3-乙');
    results.主臂 = { ackMs: typed.ackMs, gapMs: typed.gapMs, clicked: typed.clicked, 有框: !!(calls && calls.length),
      切到乙: nowB, 磁盘含新字: disk.includes('甲乙丙'), 磁盘含对照拍: disk.includes('对照拍'),
      无框切档丢字: (!calls || !calls.length) && !!nowB && !disk.includes('甲乙丙') };
    if (!RED && !nowB && calls && calls.length) {
      // 绿·取消臂成立：留甲 + 视觉证据
      await shotState(session, 'cd3-绿-取消后脏标');
      // 绿·保存臂：再键入 → 弹框选「保存」→ 甲落盘 + 切乙
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'message', response: 0 }, { dialog: 'open', files: [B] }]);
      const typed2 = await typeThenMenuOpenHere(session, '丁戊', [{ dialog: 'message', response: 0 }, { dialog: 'open', files: [B] }]);
      await sleep(2800);
      const recs2 = await recsSafe(session);
      const saveCalls = await msgCallsSafe(session);
      results.保存臂 = { clicked: typed2.clicked, 桩消息数: saveCalls ? saveCalls.length : null,
        切到乙: recs2 && recs2[0] && String(recs2[0].file).includes('r10-cd3-乙'),
        磁盘含全部新字: (readDisk(A) || '').includes('甲乙丙丁戊'), gapMs: typed2.gapMs };
      // 绿·放弃臂：现在文档是乙 → 键入 → 切回甲 → 弹框选「放弃」→ 乙不落盘
      if (results.保存臂.切到乙) {
        await focusTailOf(session, '乙的内容段');
        await session.main.clearCalls();
        await session.main.script([{ dialog: 'message', response: 1 }, { dialog: 'open', files: [A] }]);
        const typed3 = await typeThenMenuOpenHere(session, '己', [{ dialog: 'message', response: 1 }, { dialog: 'open', files: [A] }]);
        await sleep(2800);
        const recs3 = await recsSafe(session);
        results.放弃臂 = { 切回甲: recs3 && recs3[0] && String(recs3[0].file).includes('r10-cd3-甲'),
          乙盘不含新字: !(readDisk(B) || '').includes('己'), gapMs: typed3.gapMs };
      }
    }
  } catch (error) { results.异常 = String(error && error.message || error).slice(0, 300); }
  finally { await session.close().catch(() => {}); }
  const main = results.主臂 || {};
  const contrastOK = results.对照臂 && results.对照臂.有框 && results.对照臂.仍甲;
  const cleanOK = results.洗净后 && !results.洗净后.甲脏;
  let verdict = 'FAIL';
  if (RED) verdict = (main.无框切档丢字 && contrastOK && cleanOK) ? 'PASS' : 'FAIL';
  else {
    const cancelOK = main.有框 && !main.切到乙;
    const saveOK = results.保存臂 && results.保存臂.切到乙 && results.保存臂.磁盘含全部新字;
    const discardOK = results.放弃臂 && results.放弃臂.切回甲 && results.放弃臂.乙盘不含新字;
    verdict = (cancelOK && saveOK && discardOK && contrastOK) ? 'PASS' : 'FAIL';
  }
  report('cd3', verdict, results);
}

// ─── 负门 cd5/cd6/cd7 ──────────────────────────────────────────────────────────
async function negative(kind) {
  const A = kind === 'cd7' ? DOC.cd7A() : kind === 'cd6' ? DOC.cd6A() : DOC.cd5A();
  const B = kind === 'cd7' ? DOC.cd7B() : null;
  const results = {};
  const session = await launchCase(kind + '-neg', [A]);
  try {
    await waitDocs(session);
    await autoSaveOff(session);
    await focusTailOf(session, '负门靶点段');
    // 不键入：只做一次真键 Ctrl+S（手动保存会走 flushEditorText）
    await hi.combo(session, 'Ctrl+S');
    await sleep(900);
    const before = { sha: shaOf(A), stat: statOf(A) };
    await session.main.clearCalls();
    await shotState(session, kind + '-负门-保存后');
    if (kind === 'cd5') {
      typeThenCloseSendKeys(session); // 关窗键 fire-and-forget：窗口会在处理中当场销毁
      await sleep(2400);
      const calls = await msgCallsSafe(session);
      const recs = await recsSafe(session);
      const probe = await finishExitProbe(session);
      const after = { sha: shaOf(A), stat: statOf(A) };
      results.关窗 = { 有框: !!(calls && calls.length), 窗口数: recs ? recs.length : 0,
        应用退出: probe.exit.exited,
        磁盘纹丝不动: before.sha === after.sha && before.stat.mtimeMs === after.stat.mtimeMs };
      results.关窗.判定 = (!results.关窗.有框 && (results.关窗.窗口数 === 0 || results.关窗.应用退出) && results.关窗.磁盘纹丝不动) ? 'PASS' : 'FAIL';
    } else if (kind === 'cd6') {
      try { await session.main.js(`(() => { require('electron').app.quit(); return 'quit'; })()`); } catch {}
      const probe = await finishExitProbe(session);
      const after = { sha: shaOf(A), stat: statOf(A) };
      results.退出 = { 进程退出: probe.exit.exited, 有框: !!(probe.calls && probe.calls.length),
        磁盘纹丝不动: before.sha === after.sha && before.stat.mtimeMs === after.stat.mtimeMs };
      results.退出.判定 = (results.退出.进程退出 && !results.退出.有框 && results.退出.磁盘纹丝不动) ? 'PASS' : 'FAIL';
    } else {
      await session.main.script([{ dialog: 'open', files: [B] }]);
      const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(2600);
      const calls = await msgCallsSafe(session);
      const recs = await recsSafe(session);
      const after = { sha: shaOf(A), stat: statOf(A) };
      results.切档 = { clicked, 有框: !!(calls && calls.length),
        切到乙: recs && recs[0] && String(recs[0].file).includes('r10-cd7-乙'),
        甲盘纹丝不动: before.sha === after.sha && before.stat.mtimeMs === after.stat.mtimeMs };
    }
  } catch (error) { results.异常 = String(error && error.message || error).slice(0, 300); }
  finally { await session.close().catch(() => {}); }
  let verdict = 'FAIL';
  if (kind === 'cd5') verdict = results.关窗 ? results.关窗.判定 : 'FAIL:' + String(results.异常 || '未知');
  if (kind === 'cd6') verdict = results.退出 ? results.退出.判定 : 'FAIL:' + String(results.异常 || '未知');
  if (kind === 'cd7') verdict = results.切档 ? ((!results.切档.有框 && results.切档.切到乙 && results.切档.甲盘纹丝不动) ? 'PASS' : 'FAIL') : 'FAIL:' + String(results.异常 || '未知');
  report(kind, verdict, results);
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name);
  console.log((RED ? '【红基线：期望无框+丢字】' : '【绿轮：期望弹框+三选择语义】') + ' ' + (DEV ? '开发树' : '安装版') + '：' + EXE);
  let pass = 0, fail = 0;
  const run = async (name, fn) => {
    if (!want(name)) return;
    console.log('\n=== ' + name + ' ===');
    try { await fn(); } catch (error) { report(name, 'FAIL', { 探针异常: String(error && error.message || error).slice(0, 300) }); }
  };
  try {
    await run('cd1', cd1);
    await run('cd2', cd2);
    await run('cd3', cd3);
    if (!RED) {
      await run('cd5', () => negative('cd5'));
      await run('cd6', () => negative('cd6'));
      await run('cd7', () => negative('cd7'));
    }
  } finally {
    for (const line of log) if (/ (PASS|FAIL) /.test(line)) { if (line.includes(' PASS ')) pass += 1; else fail += 1; }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + pass + ' / FAIL ' + fail + '（' + (RED ? '红基线' : '绿轮') + '）===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r10-cd 失败：', error); process.exit(1); });
