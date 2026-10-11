/** 第 3 轮 P 系性能修复的验收探针（R3-B：大文档性能）。
 *
 *  覆盖：
 *    P1 含 front matter/脚注/link-ref 的文档：普通段落打 10 键 →
 *       stats.calibrations 增量 ≤2（或单键 getValue P95 <150ms）＋ getValue 与
 *       整篇换算逐字节一致的保真断言。
 *    P2 169KB 类大文档（自造填充）首行 Enter×5 计时（量级 <500ms/次）＋
 *       unitReuse/calibrations 记账。
 *    P3 打字后立刻 Ctrl+Z vs 稳态 Ctrl+Z，计时比值 <3。
 *    P5 单处替换计时 <300ms（量级）＋ 增量记账（blockParses 增量小）。
 *    P7 开 40 图文档（超 LRU 上限 32）：主进程常驻 data ≤32、expand 与原文
 *       逐字节一致、前后 RSS 差量级。
 *    P8 1700 块公式文档：删一块区域并撤销后数学窗口 parked 计数不增。
 *
 *  用法：node scripts/acceptance/probe-r3-perf.cjs [--app]
 *      默认 --dev（开发树 electron + app/main/main.js）。改了 extension-src 之后要先
 *      `npm run sync` 让 app/renderer/js 吃到改动再跑本探针；--app 则跑已安装产物。
 *  不使用剪贴板（本轮全部为性能/记账断言，素材自建于 .perf/probe-r3-perf/）。
 *  每用例打印「R3PF <名> PASS/FAIL/EVIDENCE <JSON>」；P1/P2 各留一张打字后的
 *  2x 局部截图（证不花屏）。每个会话用完即关（铁律 3：单 GUI 任务）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--app');
const INSTALLED = 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const DEV_EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const DEV_MAIN = path.join(harness.project, 'app/main/main.js');
const OUT = path.join(harness.project, '.perf/probe-r3-perf');
const SHOTS = path.join(OUT, 'shots');
const SURFACE = '.vditor-ir .vditor-reset';
const IF = hi.IF;
const sleep = harness.sleep;
const LOG = [];
const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); LOG.push(line); console.log(line); };
const verdict = (name, status, payload) => say('R3PF ' + name + ' ' + status + ' ' + JSON.stringify(payload));
const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const p95 = list => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

// ─── 素材（全部自建，不碰受保护素材）────────────────────────────────────────
function buildFixtures() {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(SHOTS, {recursive: true});
  // P1/P3/P5：~50KB，含 front matter + 脚注 + link-ref + 普通正文 + 500+ 字符长公式
  const paras = [];
  paras.push('---', 'title: R3 性能载体', 'tags: [probe, r3]', '---', '');
  paras.push('# R3 性能载体文档', '');
  for (let i = 0; i < 150; i++) {
    if (i === 37) { paras.push(`打字落点段甲：这一段是 P1/P3 的打字目标，不携带任何脚注或引用标记，仅普通正文文字第 ${i} 段。`, ''); continue; }
    if (i === 90) { paras.push(`替换目标段：这里埋一个唯一锚点甲乙丙丁标记，供 P5 单处替换使用，其余文字为填充。`, ''); continue; }
    const withFootnote = i % 17 === 3, withRef = i % 23 === 5;
    let text = `第 ${i} 段正文填充。性能探针自造文字，用来把文档垫到五十千字节量级；`;
    text += '重复的语句只是填充，不承担语义。'.repeat(4);
    if (withFootnote) text += `此处带一个脚注引用[^${(i % 12) + 1}]。`;
    if (withRef) text += '此处带一个链接引用[示例甲][ref1]。';
    paras.push(text, '');
  }
  const longFormula = Array.from({length: 40}, (_, k) => `x_{${k}}+y_{${k}}=z_{${k}}+\\frac{a_{${k}}}{b_{${k}}+c_{${k}}}`).join('+');
  paras.push('$$', longFormula, '$$', '');
  paras.push('[ref1]: https://example.com/one "示例引用一"', '[ref2]: https://example.com/two "示例引用二"', '');
  for (let k = 1; k <= 12; k++) paras.push(`[^${k}]: 脚注 ${k} 的定义文字，用来制造 dependent 块。`, '');
  const depDoc = paras.join('\n');
  fs.writeFileSync(path.join(OUT, 'r3-dep.md'), depDoc, 'utf8');

  // P2：~169KB 自造填充（每段带序号，块内容互不相同——锚定分组的最恶劣场合）
  const big = [];
  for (let i = 0; i < 1150; i++) {
    if (i % 97 === 0 && i) { big.push(`## 小节标题 ${i}`, ''); continue; }
    if (i % 211 === 5) { big.push('```text', `围栏块 ${i}：填充`, '```', ''); continue; }
    big.push(`段${String(i).padStart(4, '0')} 性能填充文字：这一段属于自造大文档，用于文首插块的分组锚定测量。${'重复句只是垫高篇幅。'.repeat(5)}`, '');
  }
  const bigDoc = big.join('\n');
  fs.writeFileSync(path.join(OUT, 'r3-big.md'), bigDoc, 'utf8');

  // P7：40 张互不相同的内嵌 PNG（data URL）
  const pngHead = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const images = Array.from({length: 40}, (_, n) =>
    'data:image/png;base64,' + Buffer.concat([pngHead, crypto.randomBytes(48 * 1024).fill(n & 0xff)]).toString('base64'));
  fs.writeFileSync(path.join(OUT, 'r3-img.md'), images.map((d, i) => `![图${i}](${d})`).join('\n\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, 'r3-blank.md'), '空白载体\n\n', 'utf8');

  // P8：1700 段，每段一个行内公式（超过数学窗口门槛 1500 块）
  const math = [];
  for (let i = 0; i < 1700; i++) math.push(`第 ${i} 行：$a_{${i}}^2+b_{${i}}^2=c_{${i}}^2$ 行内公式填充文字。`, '');
  fs.writeFileSync(path.join(OUT, 'r3-math.md'), math.join('\n'), 'utf8');

  return {depBytes: Buffer.byteLength(depDoc), bigBytes: Buffer.byteLength(bigDoc)};
}

// ─── 读数/原语 ────────────────────────────────────────────────────────────────
const statsOf = session => session.js(`(() => { const w = ${IF}; const v = w.vditor && w.vditor.vditor; const s = v && v.__typoraPerformance && v.__typoraPerformance.stats;
  return s ? {calibrations: s.calibrations, blockParses: s.blockParses, unitReuse: s.unitReuse, version: s.version, why: s.why || null} : null; })()`);
const blocksOf = session => session.js(`(() => { const s = ${IF}.document.querySelector(${JSON.stringify(SURFACE)}); return s ? s.children.length : -1; })()`);
const mdNow = hi.mdNow;
/** 强制一次 getValue 并计时（页内时钟，无 CDP 往返）：单键增量转换成本。 */
const timedGetValue = session => session.js(`(() => { const w = ${IF}; const t0 = w.performance.now(); w.vditor.getValue(); return +(w.performance.now() - t0).toFixed(1); })()`);
/** 保真：getValue() 与"整篇换算"（vditor 自己的回退通道）逐字节比对。 */
const fidelityOf = session => session.js(`(() => { const w = ${IF}; const v = w.vditor; const st = v.vditor;
  const a = v.getValue(); const b = st.lute.VditorIRDOM2Md(st.ir.element.innerHTML);
  let at = -1; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { at = i; break; }
  return {equal: a === b, lenA: a.length, lenB: b.length, diffAt: at,
    headA: a.slice(0, 30), headB: b.slice(0, 30), tailA: a.slice(-30), tailB: b.slice(-30)}; })()`);
/** 指定顶层块内首个文字的点坐标（顶层页坐标系；先滚到可视区）。 */
const textPointOf = (index, frac) => `(() => { const w = ${IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); const block = surface && surface.children[${index}];
  if (!block) return null; block.scrollIntoView({block: 'center', behavior: 'instant'});
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node = null;
  while (walker.nextNode()) if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '').length) { node = walker.currentNode; break; }
  if (!node) return null;
  const r = d.createRange(); r.selectNodeContents(node); const rect = r.getClientRects()[0] || node.parentElement.getBoundingClientRect();
  return {x: Math.round(fr.x + rect.x + rect.width * ${frac}), y: Math.round(fr.y + rect.y + rect.height / 2), text: node.data.slice(0, 12)}; })()`;
/** Ctrl+Z 页内计时：keydown 时刻打点，配合 waitForMd 变化读出首变延迟。 */
const armUndoClock = session => session.js(`(() => { const w = ${IF};
  if (!w.__r3z) { w.__r3z = {t0: null}; w.document.addEventListener('keydown', e => {
    if (!w.__r3z.armed) return; if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) { w.__r3z.t0 = w.performance.now(); w.__r3z.armed = false; } }, true); }
  w.__r3z.t0 = null; w.__r3z.armed = true; return true; })()`);
const undoLatency = session => session.js(`(() => { const w = ${IF}; return w.__r3z && w.__r3z.t0 !== null ? +(w.performance.now() - w.__r3z.t0).toFixed(1) : null; })()`);
/** 轮询直到表达式为真（页内表达式，返回真值即停）。 */
async function waitExpr(session, expression, {timeout = 8000, interval = 30} = {}) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await session.js(expression)) return true;
    await sleep(interval);
  }
  return false;
}
/** 整页 + 指定中心 2x 局部截图。 */
async function shot2x(session, name, center) {
  const full = await session.shot(name);
  say('截图 ' + path.basename(full));
  if (!center) return;
  const clip = {x: Math.max(0, Math.round(center.x - 300)), y: Math.max(0, Math.round(center.y - 90)), width: 600, height: 180, scale: 2};
  const shot = await session.send('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true}).catch(() => null);
  if (!shot) { say('（' + name + '：2x 局部截图失败）'); return; }
  const zoom = path.join(SHOTS, name + '-2x.png');
  fs.writeFileSync(zoom, Buffer.from(shot.data, 'base64'));
  say('截图 ' + path.basename(zoom));
}
const caretPoint = session => session.js(`(() => { const w = ${IF}; const s = w.getSelection();
  if (!s || !s.rangeCount) return null; const r = s.getRangeAt(0); const rect = r.getBoundingClientRect();
  const fr = document.getElementById('editor').getBoundingClientRect();
  return rect.width || rect.height ? {x: fr.x + rect.x, y: fr.y + rect.y} : null; })()`);

async function openDocSession(file, {inspect = false, minBlocks = 1, settle = 1500, timeout = 180000} = {}) {
  const exe = DEV ? DEV_EXE : INSTALLED;
  const session = await harness.launch({exe, appArgs: DEV ? [DEV_MAIN] : [], inspect,
    label: DEV ? 'probe-r3-perf-dev' : 'probe-r3-perf', outDir: SHOTS, args: [file], timeout: 240000});
  const ready = await session.until(`(() => { const w = ${IF}; const s = w && w.document.querySelector(${JSON.stringify(SURFACE)});
    return !!(s && s.children.length >= ${minBlocks} && s.textContent.trim()); })()`, {timeout, interval: 100});
  if (!ready) throw new Error('编辑面未就绪：' + file);
  await sleep(settle);
  return session;
}

// ─── P1：三类块文档普通打字不再整篇换算 ───────────────────────────────────────
async function caseP1(session) {
  const name = 'P1-三类块文档打字增量';
  await hi.ensureFocus(session);
  const placed = await session.js(hi.placeAfterPrefix ? hi.placeAfterPrefix('打字落点段甲') : 'null');
  if (!placed || !placed.ok) return verdict(name, 'FAIL', {why: '没找到打字落点段', placed});
  const focus = await hi.ensureFocus(session);
  const before = await statsOf(session);
  const keys = 'abcdefghijk'.split('');
  const perKey = [];
  for (const key of keys) {
    await hi.press(session, key, {text: key});
    await sleep(45);
    perKey.push(await timedGetValue(session));
  }
  await sleep(1200);   // 让 undoDelay 之后的历史记录也发生
  const after = await statsOf(session);
  const calDelta = after.calibrations - before.calibrations;
  const fidelity = await fidelityOf(session);
  // 保真红线：与整篇换算逐字节一致（或仅末尾换行差异——vditor getValue 的既有口径）
  const trailingOnly = !fidelity.equal && fidelity.diffAt >= Math.min(fidelity.lenA, fidelity.lenB) - 2;
  const caret = await caretPoint(session);
  await shot2x(session, 'P1-打字后', caret);
  const pass = calDelta <= 2 && p95(perKey) < 150 && (fidelity.equal || trailingOnly);
  verdict(name, pass ? 'PASS' : 'FAIL', {
    calibrations: {before: before.calibrations, after: after.calibrations, calDelta},
    每键getValueMs: perKey.map(v => Math.round(v)), p95ms: Math.round(p95(perKey)), maxMs: Math.round(Math.max(...perKey)),
    blockParsesDelta: after.blockParses - before.blockParses, unitReuseDelta: after.unitReuse - before.unitReuse,
    保真: {equal: fidelity.equal, trailingOnly, diffAt: fidelity.diffAt, lenA: fidelity.lenA, lenB: fidelity.lenB},
    焦点: {hasFocus: focus.hasFocus},
    判据: 'calibrations 增量≤2 且 P95<150ms，且 getValue 与整篇换算一致（两项都要求：小文档上时机判不红，量级判据也保留）',
  });
}

// ─── P3：打字后立刻 Ctrl+Z 不再付整篇换算 ────────────────────────────────────
async function caseP3(session) {
  const name = 'P3-打字后立刻撤销';
  await hi.ensureFocus(session);
  const placed = await session.js(hi.placeAfterPrefix('第 61 段正文填充'));
  if (!placed || !placed.ok) return verdict(name, 'FAIL', {why: '没找到 P3 打字段', placed});
  await hi.ensureFocus(session);
  const steadies = [], immediates = [];
  for (let round = 0; round < 3; round++) {
    // 稳态：打一个字，等去抖（undoDelay 200ms）完全落定后再撤销（md 应回到 base）
    const baseS = await mdNow(session);
    await hi.press(session, 's', {text: 's'}); await sleep(1500);
    const typedS = await mdNow(session);
    await armUndoClock(session); await hi.combo(session, 'Ctrl+Z');
    let tSteady = 1500;
    const stopS = Date.now() + 1500;
    while (Date.now() < stopS) {
      const md = await mdNow(session); const lat = await undoLatency(session);
      if (md === baseS && lat !== null) { tSteady = lat; break; }
      await sleep(15);
    }
    steadies.push(typedS !== baseS ? tSteady : 0);
    await sleep(300);
    // 立即：打一个字，70ms 后就撤销（去抖窗口内 → flush 必须补记）
    const baseI = await mdNow(session);
    await hi.press(session, 'm', {text: 'm'}); await sleep(70);
    await armUndoClock(session); await hi.combo(session, 'Ctrl+Z');
    let tImm = 2000;
    const stopI = Date.now() + 2000;
    while (Date.now() < stopI) {
      const md = await mdNow(session); const lat = await undoLatency(session);
      if (md === baseI && lat !== null) { tImm = lat; break; }
      await sleep(15);
    }
    immediates.push(tImm);
    await sleep(400);
  }
  const steady = median(steadies), immediate = median(immediates);
  const ratio = immediate / Math.max(steady, 8);   // 下限 8ms：测量粒度保护
  // 立即撤销还给绝对上限：比值在小文档上分不出整篇换算（两端都快），绝对值
  // 能——修复注掉后 flush 必付一次整篇 convert（本素材量级 ~30ms+）。
  verdict(name, ratio < 3 && immediate < 20 ? 'PASS' : 'FAIL', {
    稳态撤销Ms: steadies.map(Math.round), 立即撤销Ms: immediates.map(Math.round),
    稳态中位: Math.round(steady), 立即中位: Math.round(immediate), 比值: +ratio.toFixed(2),
    判据: '立即/稳态 <3（下限 8ms 保护）且立即中位 <20ms',
  });
}

// ─── P5：单处替换走增量 ───────────────────────────────────────────────────────
async function caseP5(session) {
  const name = 'P5-单处替换增量';
  await hi.ensureFocus(session);
  await hi.combo(session, 'Ctrl+H');
  const opened = await waitExpr(session, `(() => !!${IF}.document.getElementById('typora-find'))()`, {timeout: 3000});
  if (!opened) return verdict(name, 'FAIL', {why: '查找面板没打开'});
  await sleep(250);
  await session.type('锚点甲乙丙丁');
  await waitExpr(session, `(() => { const w = ${IF}; const f = w.vditor && w.vditor.__typoraFind; const st = f && f.state; return !!(st && !st.pending && st.count >= 1); })()`, {timeout: 5000});
  const state0 = await session.js(`(() => { const st = ${IF}.vditor.__typoraFind.state; return {count: st.count, active: st.active}; })()`);
  // 点击"替换为"输入框并输入替换文本（真实点击 + 真实输入通道）
  const replaceRect = await session.js(`(() => { const w = ${IF}; const el = w.document.querySelector('[data-field="replace"]'); if (!el) return null;
    const r = el.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
    return {x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2)}; })()`);
  if (!replaceRect) return verdict(name, 'FAIL', {why: '找不到替换输入框'});
  await session.click(replaceRect.x, replaceRect.y); await sleep(120);
  await session.type('换好乙丁');
  const statsBefore = await statsOf(session);
  const mdBefore = await mdNow(session);
  const button = await session.js(`(() => { const w = ${IF}; const el = w.document.querySelector('[data-action="replace"]'); if (!el) return null;
    const r = el.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
    return {x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2)}; })()`);
  if (!button) return verdict(name, 'FAIL', {why: '找不到替换按钮'});
  const t0 = await session.js(`${IF}.performance.now()`);
  await session.click(button.x, button.y);
  let done = false, t1 = null;
  const stop = Date.now() + 2500;
  while (Date.now() < stop) {
    const md = await mdNow(session);
    if (md && md !== mdBefore) { t1 = await session.js(`${IF}.performance.now()`); done = true; break; }
    await sleep(15);
  }
  const dt = t1 !== null ? +(t1 - t0).toFixed(1) : null;
  await sleep(400);
  const mdAfter = await mdNow(session);
  const statsAfter = await statsOf(session);
  const ok = done && dt !== null && dt < 300 && dt <= 25
    && mdAfter.includes('换好乙丁') && !mdAfter.includes('锚点甲乙丙丁')
    && mdAfter.length === mdBefore.length + ('换好乙丁'.length - '锚点甲乙丙丁'.length)
    && (statsAfter.blockParses - statsBefore.blockParses) <= 5;
  // 撤销一路：把面板关掉再 Ctrl+Z，确认替换可撤销（增量入栈成立的证人）
  await hi.press(session, 'Escape'); await sleep(250);
  await hi.ensureFocus(session);
  await hi.combo(session, 'Ctrl+Z'); await sleep(900);
  const mdUndo = await mdNow(session);
  verdict(name, ok ? 'PASS' : 'FAIL', {
    命中: state0, 替换耗时Ms: dt, 完成检测: done,
    替换后含新词: mdAfter.includes('换好乙丁'), 替换后无旧词: !mdAfter.includes('锚点甲乙丙丁'),
    长度守恒: mdAfter.length - mdBefore.length,
    blockParsesDelta: statsAfter.blockParses - statsBefore.blockParses,
    calibrationsDelta: statsAfter.calibrations - statsBefore.calibrations,
    unitReuseDelta: statsAfter.unitReuse - statsBefore.unitReuse,
    撤销还原: mdUndo === mdBefore,
    判据: '耗时<300ms（量级）且 ≤25ms（本素材上增量≈9ms、全量≈39ms，25 取中）；文本精确替换＋可撤销',
  });
}

// ─── P2：大文档文首插块 ───────────────────────────────────────────────────────
async function caseP2() {
  const session = await openDocSession(path.join(OUT, 'r3-big.md'), {minBlocks: 1000, settle: 2500, timeout: 240000});
  try {
    const name = 'P2-大文档文首Enter×5';
    // 等分片预热收尾（不等也不影响正确性，只是计时更干净）
    await waitExpr(session, `(() => { const w = ${IF}; const v = w.vditor && w.vditor.vditor; const s = v && v.__typoraPerformance && v.__typoraPerformance.stats; return !!s && s.primes >= 1; })()`, {timeout: 6000});
    await hi.ensureFocus(session);
    const point = await session.js(textPointOf(0, 0.25));
    if (!point) return verdict(name, 'FAIL', {why: '取不到首行坐标'});
    await session.click(point.x, point.y); await sleep(250);
    const stats0 = await statsOf(session);
    const enterTimes = [];
    const convertTimes = [];
    const statsEach = [];
    let count = await blocksOf(session);
    for (let i = 0; i < 5; i++) {
      const t0 = await session.js(`${IF}.performance.now()`);
      await hi.press(session, 'Enter', {text: '\r'});
      const grew = await waitExpr(session, `(() => ${IF}.document.querySelector(${JSON.stringify(SURFACE)}).children.length > ${count})()`, {timeout: 4000});
      // 强制一次 getValue：把去抖（undoDelay 200ms）之后的增量换算成本算进这一键
      // （连发 Enter 时 vditor 的 processAfterRender 会被去抖合并，不主动读值
      // 就测不到转换成本——那会得到虚假的 0ms）。
      convertTimes.push(await timedGetValue(session));
      const t1 = await session.js(`${IF}.performance.now()`);
      enterTimes.push(+(t1 - t0).toFixed(1));
      if (!grew) break;
      count = await blocksOf(session);
      statsEach.push(await statsOf(session));
      await sleep(150);
    }
    const statsEnd = statsEach.at(-1) || stats0;
    const caret = await caretPoint(session);
    await shot2x(session, 'P2-Enter后', caret || point);
    const worst = Math.max(...enterTimes);
    const parsesDelta = statsEnd.blockParses - stats0.blockParses;
    // blockParses 阈值：5 次结构性插块在锚定复用下只重转受影响的少数分组
    //（实测 51/1150 块）；修复注掉后回到按位置切片，每键整篇重转（>300）。
    verdict(name, worst < 500 && parsesDelta <= 150 ? 'PASS' : 'FAIL', {
      enterMs: enterTimes, 其中强制getValueMs: convertTimes.map(Math.round), worstMs: worst, 块数: count,
      calibrations: {before: stats0.calibrations, after: statsEnd.calibrations, delta: statsEnd.calibrations - stats0.calibrations},
      blockParsesDelta: parsesDelta,
      unitReuseDelta: statsEnd.unitReuse - stats0.unitReuse,
      判据: '每键（含强制 getValue 的增量换算）<500ms（量级）且 blockParses≤150；unitReuse 增量证明旧分组按锚复用',
    });
  } finally { await session.close(); say('会话已释放（P2）'); }
}

// ─── P7：图片 base64 常驻 LRU + 磁盘回读 ─────────────────────────────────────
async function caseP7() {
  const session = await openDocSession(path.join(OUT, 'r3-blank.md'), {inspect: true, settle: 1800, timeout: 180000});
  try {
    const name = 'P7-图片entries-LRU';
    const rss0 = await session.main.js('process.memoryUsage().rss');
    await session.main.script([{dialog: 'open', files: [path.join(OUT, 'r3-img.md')]}]);
    const clicked = await session.main.clickMenu('文件 > 打开文件…');
    const loaded = await (async () => {
      const stop = Date.now() + 60000;
      while (Date.now() < stop) {
        const recs = await session.recs().catch(() => null);
        if (recs && recs.some(r => String(r.file || '').includes('r3-img.md'))) return true;
        await sleep(200);
      }
      return false;
    })();
    if (!loaded) return verdict(name, 'FAIL', {why: '图片文档没打开', menuClick: clicked});
    await sleep(2500);
    const probe = JSON.parse(await session.main.js(`(async () => {
      const rec = global.windows.find(r => String(r.doc && r.doc.file || '').includes('r3-img.md'));
      if (!rec || !rec.doc.current) return JSON.stringify({ok: false});
      const images = rec.doc.current.images;
      await images.flush();
      return JSON.stringify({ok: true, entries: images.entries.size, resident: images.residentData, cap: images.cap,
        urls: images.urls.size, expanded: images.expand(rec.doc.current.text),
        warnings: images.consumeWarnings(), rss: process.memoryUsage().rss});
    })()`));
    const original = fs.readFileSync(path.join(OUT, 'r3-img.md'), 'utf8');
    probe.expandIdentical = probe.ok && probe.expanded === original;
    const rssDeltaMB = +(((probe.rss || 0) - rss0) / 1048576).toFixed(1);
    const pass = probe.ok && probe.expandIdentical && probe.resident <= probe.cap && probe.entries >= 40;
    verdict(name, pass ? 'PASS' : 'FAIL', {
      menuClick: clicked, entries: probe.entries, 常驻data: probe.resident, 上限: probe.cap,
      expand逐字节还原: probe.expandIdentical, warnings: probe.warnings,
      rss: {beforeMB: +(rss0 / 1048576).toFixed(1), afterMB: +(probe.rss / 1048576).toFixed(1), deltaMB: rssDeltaMB},
      判据: '常驻≤32 且 expand 与原文逐字节一致（保真红线）；RSS 记量级',
    });
  } finally { await session.close(); say('会话已释放（P7）'); }
}

// ─── P8：数学窗口 parked 集合不随编辑泄漏 ─────────────────────────────────────
async function caseP8() {
  const session = await openDocSession(path.join(OUT, 'r3-math.md'), {minBlocks: 1600, settle: 4000, timeout: 300000});
  try {
    const name = 'P8-parked失联清扫';
    const window0 = await session.js(`(() => { const w = ${IF}; return w.__typoraMathWindow ? {mode: w.__typoraMathWindow.mode, parked: w.__typoraMathWindow.parked} : null; })()`);
    if (!window0 || window0.mode !== 'on') return verdict(name, 'FAIL', {why: '数学窗口未开启', window0});
    let parked0 = window0.parked, stableSince = Date.now();
    const stop = Date.now() + 45000;
    while (Date.now() < stop) {
      await sleep(1000);
      const p = await session.js(`${IF}.__typoraMathWindow.parked`);
      if (p === parked0) { if (Date.now() - stableSince > 4000) break; }
      else { parked0 = p; stableSince = Date.now(); }
    }
    const blockCount0 = await blocksOf(session);
    const pending0 = await session.js(`(() => { const w = ${IF}; const s = w.__typoraMathStats; return s ? s.pending : -1; })()`);
    if (parked0 < 100) return verdict(name, 'FAIL', {why: 'parked 基线过低（门槛没生效？）', parked0, blockCount0, pending0});
    // 滚到文档中部（真实滚轮），让删除目标落在已停靠区域
    const frameRect = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
    for (let i = 0; i < 12; i++) { await session.wheel(frameRect.x, frameRect.y, 900); await sleep(60); }
    await sleep(1200);
    // 真实手势选一片区域后删除：点下起点 → 按住 Shift 连发 ArrowDown 扩选
    // （滚动跟随把沿途块带进选区；之前用 Shift+点终点，textPointOf 各自
    // scrollIntoView 会把第一次的坐标滚出屏，实际什么也没选上——实删 0）。
    const anchor = await session.js(textPointOf(Math.floor(blockCount0 * 0.55), 0.5));
    if (!anchor) return verdict(name, 'FAIL', {why: '取不到删除起点', anchor});
    await session.click(anchor.x, anchor.y); await sleep(200);
    await hi.hold(session, 'ArrowDown', {times: 130, modifiers: harness.MOD.shift, interval: 22});
    const selectedLen = await session.js(`(() => { const w = ${IF}; const s = w.getSelection(); return s && s.rangeCount ? s.toString().length : 0; })()`);
    await hi.press(session, 'Delete');
    const deleted = await (async () => {
      const stop = Date.now() + 20000;
      while (Date.now() < stop) {
        const now = await blocksOf(session);
        if (blockCount0 - now >= 50) return blockCount0 - now;
        await sleep(250);
      }
      return blockCount0 - (await blocksOf(session));
    })();
    await sleep(2500);
    const blocksAfterDelete = await blocksOf(session);
    // 滚动触发 refreshWindow（失联清扫在这里发生）
    for (let i = 0; i < 4; i++) { await session.wheel(frameRect.x, frameRect.y, 500); await sleep(80); }
    await sleep(1500);
    const parked1 = await session.js(`${IF}.__typoraMathWindow.parked`);
    // 撤销还原，再滚一次
    await hi.ensureFocus(session);
    await hi.combo(session, 'Ctrl+Z'); await sleep(2500);
    for (let i = 0; i < 4; i++) { await session.wheel(frameRect.x, frameRect.y, 400); await sleep(80); }
    await sleep(1500);
    const parked2 = await session.js(`${IF}.__typoraMathWindow.parked`);
    const liveUnrendered2 = await session.js(`(() => { const w = ${IF}; const s = w.document.querySelector(${JSON.stringify(SURFACE)});
      return s ? s.querySelectorAll('.language-math:not([data-math])').length : -1; })()`);
    const blocksFinal = await blocksOf(session);
    // 失联孤儿 ≈ parked − 仍挂在文档里的未渲染公式（静止时未渲染≈已停靠）。
    // 修复注掉后撤销重建会累积游离节点，这个差值只增不减。
    const orphan2 = Math.max(0, parked2 - Math.max(0, liveUnrendered2));
    const pass = deleted >= 50 && parked1 < parked0 && parked2 <= parked0 + 50 && orphan2 <= 40;
    verdict(name, pass ? 'PASS' : 'FAIL', {
      parked: {初始: parked0, 删除后: parked1, 撤销后: parked2},
      选区长: selectedLen, 实删: blockCount0 - blocksAfterDelete,
      块数: {初始: blockCount0, 删除后: blocksAfterDelete, 撤销后: blocksFinal},
      撤销后未渲染公式: liveUnrendered2, 失联孤儿: orphan2,
      pending0, 判据: '实删≥50、删除后 parked 下降、撤销后 parked ≤ 初始+50 且失联孤儿≤40（修复前撤销重建叠加游离键，只增不减）',
    });
  } finally { await session.close(); say('会话已释放（P8）'); }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const only = (process.argv.find(arg => arg.startsWith('--only=')) || '').slice(7);
  const want = tag => !only || only.split(',').includes(tag);
  const sizes = buildFixtures();
  say('素材：' + JSON.stringify({depKB: Math.round(sizes.depBytes / 1024), bigKB: Math.round(sizes.bigBytes / 1024)}));
  say((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式'));
  // 会话 A：r3-dep.md 上跑 P1 → P3 → P5
  if (want('p1') || want('p3') || want('p5')) {
    const sessionA = await openDocSession(path.join(OUT, 'r3-dep.md'), {minBlocks: 20, settle: 3000});
    try {
      say('console 错误面（会话A开头）：' + JSON.stringify(sessionA.errors.slice(0, 4)));
      if (want('p1')) await caseP1(sessionA);
      if (want('p3')) await caseP3(sessionA);
      if (want('p5')) await caseP5(sessionA);
      say('console 错误面（会话A结尾）：' + JSON.stringify(sessionA.errors.slice(0, 8)));
    } finally { await sessionA.close(); say('会话已释放（A）'); }
  }
  if (want('p2')) await caseP2();
  if (want('p7')) await caseP7();
  if (want('p8')) await caseP8();
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n'));
  say('日志：' + path.join(OUT, 'run.log'));
}

main().catch(error => {
  console.error('探针失败：', error && error.stack || error);
  try {
    fs.mkdirSync(OUT, {recursive: true});
    fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n探针失败：' + String(error && error.stack || error));
  } catch {}
  process.exit(1);
});
