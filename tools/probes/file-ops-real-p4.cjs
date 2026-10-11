/** family=file-ops-real · P4：把「文件被外部程序占用」这条日常链走完整
 *   H1 占用中打字 → 保存失败提示条（读：文案、焦点、tmp 残留）
 *   H2 关掉占用程序 → 真实鼠标点「重试」 → 落盘（读：磁盘/提示条/焦点最终状态）
 *   H3 点完「重试」不点正文直接接着打字：字落不落？（P3 已证「另存为…」按钮会丢焦点，这里验「重试」按钮）
 *   H4 对照臂：点回正文再打同样的字
 *   H5 提示条与工具栏的几何关系（截图里看着叠在一起 ⇒ 用 DOM 矩形量，不靠肉眼）
 *
 *  用法：node file-ops-real-p4.cjs [exe]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require(path.join(__dirname, 'file-ops-real-lib.cjs'));

const EXE = process.argv[2] || L.EXE_DEFAULT;
const DIR = path.join(L.ROOT, 'p4');
const FIX = path.join(DIR, 'fix');
const PROFILE = path.join(DIR, 'profile');
const SHOTS = path.join(DIR, 'shots');
const LOCKPS = path.join(__dirname, 'file-ops-real-lock.ps1');
const PORT = 9100 + (process.pid % 90);
const { sleep, T } = L;
const DOC = path.join(FIX, 'locked.md');

const R = { probe: 'file-ops-real-p4.cjs', at: new Date().toISOString(), exe: EXE, cases: [], readings: {}, errs: [] };
const rec = (name, verdict, detail, channel) => { R.cases.push({ name, verdict, channel, detail }); console.log('\n[' + name + '] ⇒ ' + verdict); console.log('    通道：' + channel); console.log('    ' + JSON.stringify(detail)); };
const jot = (k, v) => { R.readings[k] = v; console.log('  · ' + k + ' = ' + JSON.stringify(v)); };
let APP = null, LOCKER = null;
const cleanup = () => { if (LOCKER) L.killPid(LOCKER.pid); L.kill(APP); };
process.on('exit', cleanup);

async function snap4(page) {
  return await T(page.evaluate(async () => {
    const v = (() => { try { return window.mpEngine._view(); } catch { return null; } })();
    const b = document.getElementById('mp-banner');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    const cands = [...document.querySelectorAll('[class*=toolbar],[class*=island],[class*=tb-],[id*=toolbar]')].map((e) => ({ cls: String(e.className).slice(0, 50), r: rect(e) }));
    return {
      docLen: v ? v.state.doc.length : null, docText: v ? v.state.doc.toString() : null,
      viewFocus: v ? !!v.hasFocus : null, activeEl: document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).slice(0, 30) : '')) : null,
      host: await window.mpHost.docInfo().catch(() => null),
      banner: b ? { shown: b.style.display !== 'none', text: (b.firstChild && b.firstChild.nodeType === 3) ? b.firstChild.data : b.textContent, buttons: [...b.querySelectorAll('button')].map((x) => { const r = x.getBoundingClientRect(); return { label: x.textContent, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }), rect: rect(b) } : null,
      toolbarCands: cands.slice(0, 8),
      saveTrace: ((window.__mpDbg && window.__mpDbg.saveTrace) || []).slice(-5),
    };
  }), 8000, 'snap4');
}
async function clickBtn(page, label) {
  const s = await snap4(page);
  const b = s.banner && s.banner.buttons.find((r) => (r.label || '').includes(label));
  if (!b) return { ok: false, reason: '无此按钮', banner: s.banner && s.banner.text };
  await page.mouse.click(b.x, b.y);
  return { ok: true, clicked: b };
}

(async () => {
  L.ruler('file-ops-real-p4.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(DOC, '# 被占用\n\nlock 段落正文。\n', 'utf8');
  APP = await L.launch({ exe: EXE, args: [DOC], port: PORT, profile: PROFILE });
  console.log('[启动] pid=' + APP.pid + ' port=' + PORT);
  const page = await L.findPage(APP.browser, { expectFile: 'locked.md' });
  page.on('pageerror', (e) => R.errs.push(String((e && e.message) || e).slice(0, 200)));
  page.on('crash', () => R.errs.push('PAGE_CRASH'));
  await sleep(2200);
  const boot = await snap4(page);
  if (boot.host && boot.host.filePath !== DOC) throw new Error('夹具断言失败：' + JSON.stringify(boot.host));

  try {
    /* H1 占用中打字 */
    const readyF = path.join(DIR, 'ready.txt'), stopF = path.join(DIR, 'stop.txt');
    fs.rmSync(readyF, { force: true }); fs.rmSync(stopF, { force: true });
    LOCKER = spawn('pwsh', ['-NoProfile', '-File', LOCKPS, '-Path', DOC, '-ReadyFile', readyF, '-StopFile', stopF, '-TimeoutSec', '120'], { stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await sleep(250); ready = fs.existsSync(readyF); }
    let lockProof = null;
    try { const fd = fs.openSync(DOC, 'r+'); fs.closeSync(fd); lockProof = { openedForWrite: true }; } catch (e) { lockProof = { openedForWrite: false, code: e.code }; }
    await L.clickBody(page, 'lock 段落');
    const pre = await snap4(page);
    await page.keyboard.type('L');
    await sleep(2000);
    const h1 = await snap4(page);
    jot('H1', { ready, lockProof, 打字前viewFocus: pre.viewFocus, banner: h1.banner && { shown: h1.banner.shown, text: h1.banner.text, buttons: h1.banner.buttons.map((b) => b.label) }, 文档长度: [pre.docLen, h1.docLen], 提示条出现后viewFocus: h1.viewFocus, activeEl: h1.activeEl, tmp残留: (L.listDir(FIX) || []).filter((f) => /mp-tmp/.test(f.name)) });
    rec('H1 文件被占用时打字', (h1.banner && h1.banner.shown) ? '有反应（提示条出现，正文焦点未被抢走）' : '**无反应**',
      { 锁就绪: ready, 探针侧写入被拒: lockProof, 文档长度: [pre.docLen, h1.docLen], 提示条文案: h1.banner && h1.banner.text, 提示条按钮: h1.banner && h1.banner.buttons.map((b) => b.label), 提示条出现后viewFocus: h1.viewFocus, activeEl: h1.activeEl, tmp残留: (L.listDir(FIX) || []).filter((f) => /mp-tmp/.test(f.name)) },
      '独立 pwsh FileShare.Read 持有句柄；真实键盘打字；保存是去抖自动保存');

    /* H2 释放占用 → 点「重试」 */
    fs.writeFileSync(stopF, 'stop', 'ascii');
    let freed = false;
    for (let i = 0; i < 40 && !freed; i++) { await sleep(250); try { const fd = fs.openSync(DOC, 'r+'); fs.closeSync(fd); freed = true; } catch { } }
    const click = await clickBtn(page, '重试');
    await sleep(1800);
    const h2 = await snap4(page);
    const disk = L.readDisk(DOC);
    await page.screenshot({ path: path.join(SHOTS, 'H2-after-retry.png') });
    jot('H2', { freed, click, 磁盘含L: /L/.test(String(disk || '')), bannerShown: h2.banner && h2.banner.shown, viewFocus: h2.viewFocus, activeEl: h2.activeEl, tmp残留: (L.listDir(FIX) || []).filter((f) => /mp-tmp/.test(f.name)), 标题: h2.host });
    rec('H2 占用释放后点「重试」（真实鼠标）', (freed && /L/.test(String(disk || '')) && h2.banner && !h2.banner.shown) ? '有反应（落盘、提示条消失）' : '**未恢复**',
      { 占用已释放: freed, 点击: click, 磁盘含刚敲的L: /L/.test(String(disk || '')), 提示条还在: h2.banner && h2.banner.shown, 点完后viewFocus: h2.viewFocus, activeEl: h2.activeEl, tmp残留: (L.listDir(FIX) || []).filter((f) => /mp-tmp/.test(f.name)) },
      '真实鼠标点提示条「重试」');

    /* H3 点完重试不点正文直接打字 */
    const s3 = await snap4(page);
    await page.keyboard.type('K');
    await sleep(1500);
    const h3 = await snap4(page);
    jot('H3', { 打字前viewFocus: s3.viewFocus, activeEl: s3.activeEl, 文档长度: [s3.docLen, h3.docLen], 文档含K: /K/.test(String(h3.docText)), 磁盘含K: /K/.test(String(L.readDisk(DOC) || '')) });
    rec('H3 点完「重试」不点正文直接接着打字', /K/.test(String(h3.docText)) ? '有反应（字落进文档）' : '**行为不符预期**：字不落进文档',
      R.readings.H3, '真实键盘 page.keyboard.type（未先点正文）');

    /* H4 对照臂 */
    await L.clickBody(page, 'lock 段落');
    const s4 = await snap4(page);
    await page.keyboard.type('M');
    await sleep(1500);
    const h4 = await snap4(page);
    jot('H4', { 点正文后viewFocus: s4.viewFocus, 文档长度: [s4.docLen, h4.docLen], 文档含M: /M/.test(String(h4.docText)), 磁盘含M: /M/.test(String(L.readDisk(DOC) || '')) });
    rec('H4 对照臂：先点回正文再打同样的字', /M/.test(String(h4.docText)) ? '有反应（字落进文档）' : '**对照臂也失败**', R.readings.H4, '真实鼠标点正文 + page.keyboard.type');

    /* H5 提示条 vs 工具栏：几何（截图里看着叠着） */
    fs.chmodSync(DOC, 0o444);
    await page.keyboard.type('X');
    await sleep(2000);
    const h5 = await snap4(page);
    await page.screenshot({ path: path.join(SHOTS, 'H5-banner-geometry.png') });
    fs.chmodSync(DOC, 0o666);
    const b = h5.banner && h5.banner.rect;
    const overlaps = (h5.toolbarCands || []).filter((t) => t.r && b && t.r.y < b.bottom && b.y < t.r.bottom).map((t) => t.cls);
    jot('H5', { bannerRect: b, toolbarCands: h5.toolbarCands, 与之纵向重叠的候选: overlaps, bannerShown: h5.banner && h5.banner.shown });
    rec('H5 提示条与工具栏的几何关系', b ? (overlaps.length ? '**叠在一起**（提示条与工具栏矩形纵向重叠）' : '不重叠（各占各的）') : '未取到提示条矩形',
      R.readings.H5, '读 DOM 矩形（不靠肉眼）；截图存 H5-banner-geometry.png');
  } catch (e) { rec('H1..H5', '探针异常：' + String((e && e.message) || e).slice(0, 200), {}, '-'); }

  R.aliveAtEnd = L.alive(APP.pid);
  console.log('\n════ 汇总（file-ops-real-p4）════');
  for (const c of R.cases) console.log(' · ' + c.name + ' ⇒ ' + c.verdict);
  console.log('页面错误：' + JSON.stringify(R.errs.slice(0, 6)));
  fs.writeFileSync(path.join(DIR, 'file-ops-real-p4.json'), JSON.stringify(R, null, 1), 'utf8');
  cleanup(); APP = null; LOCKER = null;
  process.exit(0);
})().catch((e) => {
  console.error('探针异常：', (e && e.stack) || e);
  try { fs.writeFileSync(path.join(DIR, 'file-ops-real-p4.json'), JSON.stringify({ ...R, fatal: String((e && e.stack) || e) }, null, 1), 'utf8'); } catch { }
  cleanup();
  process.exit(3);
});
