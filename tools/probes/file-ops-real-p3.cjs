/** family=file-ops-real · P3：把 P2 里"顺手看到"的两件事各钉一颗钉子
 *
 *  A. 提示条按钮点完之后**焦点去哪了**：用户「保存失败 → 点重试/另存为 → 接着打字」时，
 *     字到底落不落进文档？（判据读最终状态：docLen / 磁盘 / activeElement / view.hasFocus）
 *  B. 「另存为到**另一个目录**」之后，文档的相对资源基准（window.__mpDocDir + <base> + 图片实际解析到哪）
 *     有没有跟着换？（判据：同一相对路径 assets/pic.bmp 在甲目录是 1×1、乙目录是 3×3 ⇒ 读 naturalWidth 就知道指向谁）
 *
 *  用法：node file-ops-real-p3.cjs [exe]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'file-ops-real-lib.cjs'));

const EXE = process.argv[2] || L.EXE_DEFAULT;
const DIR = path.join(L.ROOT, 'p3');
const FIX = path.join(DIR, 'fix');
const PROFILE = path.join(DIR, 'profile');
const SHOTS = path.join(DIR, 'shots');
const PORT = 9250 + (process.pid % 120);
const { sleep, T } = L;

const A_DIR = path.join(FIX, '甲 目录');
const B_DIR = path.join(FIX, '乙 目录');
const SRC = path.join(A_DIR, '源 文档.md');
const TARGET = path.join(B_DIR, '目标 文档.md');

const R = { probe: 'file-ops-real-p3.cjs', at: new Date().toISOString(), exe: EXE, cases: [], readings: {}, errs: [] };
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

/** 24 位 BMP（不压缩、无 CRC ⇒ 尺寸可控且构造确定；用来区分"图片到底从哪个目录解析出来的"） */
function bmp(w, h, rgb) {
  const rowSize = ((w * 3 + 3) >> 2) << 2, dataSize = rowSize * h, out = Buffer.alloc(54 + dataSize);
  out.write('BM', 0, 'ascii'); out.writeUInt32LE(54 + dataSize, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * rowSize + x * 3; out[o] = rgb[2]; out[o + 1] = rgb[1]; out[o + 2] = rgb[0]; }
  return out;
}
/** 一次拿全：文档 + 焦点 + 相对资源基准 + 图片实际解析结果 */
async function snap3(page) {
  return await T(page.evaluate(async () => {
    const v = (() => { try { return window.mpEngine._view(); } catch { return null; } })();
    const base = document.querySelector('base');
    const img = document.querySelector('.cm-content img');
    return {
      docLen: v ? v.state.doc.length : null,
      docText: v ? v.state.doc.toString() : null,
      viewFocus: v ? !!v.hasFocus : null,
      activeEl: document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).slice(0, 30) : '')) : null,
      winFocus: document.hasFocus(),
      host: await window.mpHost.docInfo().catch(() => null),
      docDir: typeof window.__mpDocDir === 'undefined' ? null : window.__mpDocDir,
      baseHref: base ? base.getAttribute('href') : null,
      baseURI: document.baseURI,
      img: img ? { src: img.getAttribute('src'), currentSrc: img.currentSrc, nw: img.naturalWidth, nh: img.naturalHeight, complete: img.complete } : null,
      imgCount: document.querySelectorAll('.cm-content img').length,
      banner: (() => { const b = document.getElementById('mp-banner'); if (!b) return null; const btn = [...b.querySelectorAll('button')]; return { shown: b.style.display !== 'none', text: (b.firstChild && b.firstChild.nodeType === 3) ? b.firstChild.data : b.textContent, buttons: btn.map((x) => x.textContent), rects: btn.map((x) => { const r = x.getBoundingClientRect(); return { label: x.textContent, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }) }; })(),
      saveTrace: ((window.__mpDbg && window.__mpDbg.saveTrace) || []).slice(-6),
    };
  }), 8000, 'snap3');
}
async function clickBtn(page, label) {
  const s = await snap3(page);
  const b = s.banner && s.banner.rects.find((r) => (r.label || '').includes(label));
  if (!b) return { ok: false, reason: '无此按钮', banner: s.banner };
  await page.mouse.click(b.x, b.y);
  return { ok: true, clicked: b };
}

(async () => {
  L.ruler('file-ops-real-p3.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(A_DIR, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(B_DIR, 'assets'), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  /* 甲目录的图 1×1，乙目录的图 3×3 ⇒ naturalWidth 直接说明"相对路径解析到了哪个目录" */
  fs.writeFileSync(path.join(A_DIR, 'assets', 'pic.bmp'), bmp(1, 1, [220, 40, 40]));
  fs.writeFileSync(path.join(B_DIR, 'assets', 'pic.bmp'), bmp(3, 3, [40, 120, 220]));
  fs.writeFileSync(SRC, '# 甲文档\n\n![图](assets/pic.bmp)\n\n甲 段落 正文。\n', 'utf8');
  fs.chmodSync(SRC, 0o444);        // 只读 ⇒ 第一笔自动保存必定失败 ⇒ 逼出提示条

  APP = await L.launch({ exe: EXE, args: [SRC], port: PORT, profile: PROFILE, env: { MP_TEST_SAVE_AS: TARGET } });
  console.log('[启动] pid=' + APP.pid + ' port=' + PORT + ' MP_TEST_SAVE_AS=' + TARGET);
  const page = await L.findPage(APP.browser, { expectFile: '源 文档.md' });
  page.on('pageerror', (e) => R.errs.push(String((e && e.message) || e).slice(0, 200)));
  page.on('crash', () => R.errs.push('PAGE_CRASH'));
  await sleep(2500);

  const g0 = await snap3(page);
  jot('G0.baseline', { host: g0.host, docDir: g0.docDir, baseURI: g0.baseURI, baseHref: g0.baseHref, img: g0.img, imgCount: g0.imgCount });
  if (g0.host && g0.host.filePath !== SRC) throw new Error('夹具断言失败：' + JSON.stringify(g0.host));
  await page.screenshot({ path: path.join(SHOTS, 'P3-0-baseline.png') });

  /* G1 打字 → 自动保存失败 → 提示条出现（顺便读：提示条有没有把正文焦点抢走） */
  try {
    await L.clickBody(page, '甲 段落');
    const pre = await snap3(page);
    await page.keyboard.type('Q');
    await sleep(2000);
    const s1 = await snap3(page);
    await page.screenshot({ path: path.join(SHOTS, 'P3-1-banner.png') });
    const detail = { 打字前viewFocus: pre.viewFocus, 提示条: s1.banner && { shown: s1.banner.shown, text: s1.banner.text, buttons: s1.banner.buttons }, 提示条出现后viewFocus: s1.viewFocus, activeEl: s1.activeEl, 文档长度: [pre.docLen, s1.docLen], 文档含Q: /Q/.test(String(s1.docText)) };
    jot('G1', detail);
    rec('G1 只读文档打字 → 保存失败提示条',
      (s1.banner && s1.banner.shown && s1.viewFocus === true) ? '有反应（提示条出现，正文焦点仍在）' : (s1.banner && s1.banner.shown ? '**行为不符预期**（提示条出现，但正文焦点被抢走）' : '**无反应**'),
      detail, '真实鼠标点正文 + page.keyboard.type；保存是去抖自动保存');

    /* G2 提示条在场时**不点正文**直接接着打字：字落不落？ */
    const s2 = await snap3(page);
    await page.keyboard.type('W');
    await sleep(1400);
    const s3 = await snap3(page);
    const d2 = { 打字前viewFocus: s2.viewFocus, activeEl: s2.activeEl, 文档长度: [s2.docLen, s3.docLen], 文档含W: /W/.test(String(s3.docText)), 磁盘读: null };
    jot('G2', d2);
    rec('G2 提示条在场时直接接着打字（不点正文）',
      /W/.test(String(s3.docText)) ? '有反应（字落进文档）' : '**行为不符预期**：字不落进文档（提示条把焦点留在了自己/body 上）',
      d2, '真实键盘 page.keyboard.type（未先点正文）');

    /* G3 真实鼠标点「另存为…」→ 换到乙目录 */
    const click = await clickBtn(page, '另存为');
    let exists = false;
    for (let i = 0; i < 40 && !exists; i++) { await sleep(200); exists = fs.existsSync(TARGET); }
    await sleep(1000);
    const s4 = await snap3(page);
    await page.screenshot({ path: path.join(SHOTS, 'P3-3-after-saveas.png') });
    const d3 = {
      点击结果: click, 目标存在: exists, 磁盘与文档逐字符相等: L.readDisk(TARGET) === String(s4.docText),
      docInfo: s4.host, 期望: TARGET, 提示条还在: s4.banner && s4.banner.shown,
      点完之后viewFocus: s4.viewFocus, activeEl: s4.activeEl,
    };
    jot('G3', d3);
    rec('G3 点提示条「另存为…」→ 落到乙目录',
      (exists && s4.host && s4.host.filePath === TARGET) ? '有反应（落盘 + 路径切换）' : '**不符预期**', d3,
      '真实鼠标点提示条按钮；路径来自壳层 MP_TEST_SAVE_AS（不弹原生框）');

    /* G4 点完之后不点正文，直接打字 */
    const s5 = await snap3(page);
    await page.keyboard.type('E');
    await sleep(1500);
    const s6 = await snap3(page);
    const d4 = { 打字前viewFocus: s5.viewFocus, activeEl: s5.activeEl, 文档长度: [s5.docLen, s6.docLen], 文档含E: /E/.test(String(s6.docText)), 新路径含E: /E/.test(String(L.readDisk(TARGET) || '')) };
    jot('G4', d4);
    rec('G4 「另存为…」点完之后直接接着打字（不点正文）',
      /E/.test(String(s6.docText)) ? '有反应（字落进文档并保存）' : '**行为不符预期**：字不落进文档（点完提示条按钮后正文失去焦点）',
      d4, '真实键盘 page.keyboard.type（未先点正文）');

    /* G5 控制臂：先真实鼠标点回正文，同样的打字必须落字（证明"不落字"不是探针不会打字） */
    await L.clickBody(page, '甲 段落');
    const s7 = await snap3(page);
    await page.keyboard.type('R');
    await sleep(1500);
    const s8 = await snap3(page);
    const d5 = { 点正文后viewFocus: s7.viewFocus, activeEl: s7.activeEl, 文档长度: [s7.docLen, s8.docLen], 文档含R: /R/.test(String(s8.docText)), 新路径含R: /R/.test(String(L.readDisk(TARGET) || '')) };
    jot('G5', d5);
    rec('G5 对照臂：先点回正文再打同样的字',
      /R/.test(String(s8.docText)) ? '有反应（字落进文档 ⇒ G2/G4 的"不落字"是焦点问题，不是探针问题）' : '**对照臂也失败**（说明探针通道有问题，G2/G4 结论作废）',
      d5, '真实鼠标点正文 + page.keyboard.type');

    /* G6 相对资源基准：另存为到**另一个目录**之后，assets/pic.bmp 解析到谁 */
    const g6 = await snap3(page);
    const d6 = {
      docDir: g6.docDir, docDir期望: B_DIR, baseHref: g6.baseHref, baseURI: g6.baseURI,
      img: g6.img, imgCount: g6.imgCount,
      指向: g6.img ? (String(g6.img.currentSrc || '').includes('乙 目录') ? '乙目录(新)' : (String(g6.img.currentSrc || '').includes('甲 目录') ? '甲目录(旧)' : '未知')) : '无图',
      尺寸判读: g6.img ? ('naturalWidth=' + g6.img.naturalWidth + ' ⇒ ' + (g6.img.naturalWidth === 3 ? '新目录的 3×3 图' : (g6.img.naturalWidth === 1 ? '旧目录的 1×1 图' : '未知'))) : null,
    };
    jot('G6', d6);
    rec('G6 另存为到另一个目录后，文档里相对路径图片解析到哪个目录',
      (g6.docDir === B_DIR) ? '有反应（基准跟着换到新目录）' : '**行为不符预期**：相对资源基准仍是旧目录（window.__mpDocDir 未随另存为更新）',
      d6, '读最终状态：window.__mpDocDir + <base href> + <img> 实际加载的 currentSrc/naturalWidth');
  } catch (e) { rec('G1..G6', '探针异常：' + String((e && e.message) || e).slice(0, 200), {}, '-'); }

  R.aliveAtEnd = L.alive(APP.pid);
  console.log('\n════ 汇总（file-ops-real-p3）════');
  for (const c of R.cases) console.log(' · ' + c.name + ' ⇒ ' + c.verdict);
  console.log('页面错误：' + JSON.stringify(R.errs.slice(0, 6)));
  fs.writeFileSync(path.join(DIR, 'file-ops-real-p3.json'), JSON.stringify(R, null, 1), 'utf8');
  L.kill(APP); APP = null;
  process.exit(0);
})().catch((e) => {
  console.error('探针异常：', (e && e.stack) || e);
  try { fs.writeFileSync(path.join(DIR, 'file-ops-real-p3.json'), JSON.stringify({ ...R, fatal: String((e && e.stack) || e) }, null, 1), 'utf8'); } catch { /* 忽略 */ }
  cleanup();
  process.exit(3);
});
