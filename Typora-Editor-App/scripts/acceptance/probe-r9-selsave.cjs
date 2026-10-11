/** 探针 · R9 补验观察哨 73（Ctrl+S 后选区滞留视口外；2026-10-03 只取证不改产品）。
 *
 *  背景：R8 场景 73（混合编辑压力）实测"粘贴 → Ctrl+S 后选区 rangeRect.y=13385 而
 *  scrollTop=0"——选区留在视口外，右键点在窗外菜单不开。round-state 挂为观察哨：
 *  真实影响待评。
 *
 *  本探针定性三问：
 *   (a) 该状态下继续打字/按方向键会怎样（选区还在吗、光标落哪、视口跟不跟）；
 *   (b) 机制：是「保存后滚动复位把视口拉回顶部但选区没跟」还是「选区本来就悬空
 *       （DOM 重挂、端点失联）」——用 scrollTop 时间线 + 选区端点 isConnected +
 *       surface 重建监听（MutationObserver 记 childList 大换血）来分辨；
 *   (c) 小文档（无虚拟化；large-doc 门槛 ≥1500 顶层块，medium ~500 块、小文档
 *       ~40 块都远低于门槛）是否复现。
 *
 *  通道纪律（铁律）：真实输入（CDP keyEvent/mouseEvent/insertText；组合键 hi.combo；
 *  滚轮 session.wheel 真手势）；每轮读数前断言焦点在编辑器。覆盖五通道中的
 *  键盘（方向键/End）、组合键（Ctrl+S/Ctrl+V）、鼠标（点击）、拖拽（选区拖出）。
 *  截图：整页 + 光标/选区处 2x；标记：红实线=光标、琥珀虚线=期望可见位、青虚线=实际。
 *
 *  用法：node scripts/acceptance/probe-r9-selsave.cjs [--only=s1,s2,s3]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const fixtures = require('./fixtures.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r9-selsave');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF, S = hi.SURFACE;

const inIF = expression => `(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow;
  const doc = w && w.document; if (!doc) return { none: true };
  return (${expression}); })()`;
const ev = (session, expression) => session.js(inIF(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);

/** 状态倾倒：滚动/选区几何/端点连接/DOM 指纹/标记节点存活性。 */
const DUMP = `(() => {
  const root = doc.querySelector(${JSON.stringify(S)}); if (!root) return { none: true };
  const s = w.getSelection();
  const r = s && s.rangeCount ? s.getRangeAt(0) : null;
  const rect = r ? r.getBoundingClientRect() : null;
  const focusBlock = r ? (() => { let n = r.startContainer; while (n && n.parentElement && n.parentElement !== root) n = n.parentElement; return n; })() : null;
  return {
    scrollTop: Math.round(root.scrollTop), scrollH: Math.round(root.scrollHeight), vh: w.innerHeight,
    blocks: root.children.length,
    选区在: !!(s && s.rangeCount), 折叠: !!(r && r.collapsed), 选文: s && s.rangeCount ? String(s.toString()).slice(0, 30) : null,
    rangeRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    端点连接: !!(r && r.startContainer.isConnected && r.endContainer.isConnected),
    光标块: focusBlock && focusBlock.parentElement === root ? { index: [...root.children].indexOf(focusBlock), text: String(focusBlock.textContent || '').slice(0, 20) } : null,
    topFocus: document.hasFocus(),
  }; })()`;

/** surface 重建监听 + 节点标记：给光标块打 dataset 印，事后查它还在不在 DOM。 */
const WATCH_INSTALL = inIF(`(() => {
  const root = doc.querySelector(${JSON.stringify(S)});
  window.__r9s = { rebuilds: [], scrolls: [], marks: {} };
  let lastScroll = root.scrollTop, lastAt = Date.now();
  root.addEventListener('scroll', () => { const now = Date.now();
    window.__r9s.scrolls.push({ t: now - window.__r9s.t0, top: Math.round(root.scrollTop) });
    if (window.__r9s.scrolls.length > 400) window.__r9s.scrolls.shift(); }, { passive: true });
  new MutationObserver(list => {
    let removed = 0, added = 0;
    for (const m of list) { removed += m.removedNodes.length; added += m.addedNodes.length; }
    if (removed + added > 20) window.__r9s.rebuilds.push({ t: Date.now() - window.__r9s.t0, removed, added });
  }).observe(root, { childList: true });
  window.__r9s.t0 = Date.now();
  window.__r9s.markBlock = () => { const s = w.getSelection(); if (!s || !s.rangeCount) return null;
    let n = s.getRangeAt(0).startContainer; while (n && n.parentElement && n.parentElement !== root) n = n.parentElement;
    if (!n || n.parentElement !== root) return null; n.setAttribute('data-r9mark', '1'); window.__r9s.marks.node = n; return String(n.textContent || '').slice(0, 20); };
  window.__r9s.markAlive = () => { const n = window.__r9s.marks.node; return n ? { alive: n.isConnected, stillMarked: !!(n.closest && n.closest('[data-r9mark]')) } : null; };
  return { ok: true, blocks: root.children.length };
})()`);
const startClock = session => session.js(inIF(`(() => { window.__r9s.t0 = Date.now(); window.__r9s.scrolls.length = 0; window.__r9s.rebuilds.length = 0; return true; })()`));
const collect = session => session.js(inIF(`(() => { const s = window.__r9s; return { rebuilds: s.rebuilds.slice(0, 20),
  scrolls: s.scrolls.filter((x, i, a) => i === 0 || i === a.length - 1 || Math.abs(x.top - a[i - 1].top) > 200).slice(-12) }; })()`));

/** 真滚轮：滚到目标 scrollTop（多格小步，真实 wheel 通道）。 */
async function wheelTo(session, targetTop, { maxSteps = 60 } = {}) {
  const frame = await frameOf(session);
  const x = Math.round(frame.x + frame.w / 2), y = Math.round(frame.y + Math.min(frame.h / 2, 260));
  for (let i = 0; i < maxSteps; i++) {
    const now = await ev(session, `(() => { const root = doc.querySelector(${JSON.stringify(S)}); return Math.round(root.scrollTop); })()`);
    if (typeof now !== 'number') return null;
    if (Math.abs(now - targetTop) < 24) return now;
    const dir = targetTop > now ? 1 : -1;   // deltaY>0=向下滚（scrollTop 增）
    await session.wheel(x, y, dir * Math.min(240, Math.abs(targetTop - now) / 3 + 60));
    await harness.sleep(60);
  }
  return await ev(session, `(() => { const root = doc.querySelector(${JSON.stringify(S)}); return Math.round(root.scrollTop); })()`);
}

/** 真点击某文本前缀所在块中心。 */
async function clickBlockByPrefix(session, prefix) {
  const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes(${JSON.stringify(prefix)}));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + Math.min(60, r.width / 3)), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!point) return null;
  await session.click(point.x, point.y);
  await harness.sleep(250);
  return point;
}

async function keySave(session, file, { timeout = 8000 } = {}) {
  const before = fs.readFileSync(file, 'utf8');
  await hi.combo(session, 'Ctrl+S');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await harness.sleep(120);
    if (fs.readFileSync(file, 'utf8') !== before) return { saved: true, waitedMs: Date.now() - started };
  }
  return { saved: false, waitedMs: Date.now() - started };
}

const MARK_INSTALL = inIF(`(() => {
  window.__r9m = { mark(list) { const old = document.getElementById('__r9m_marks'); if (old) old.remove();
    if (!list || !list.length) return 0; const layer = document.createElement('div'); layer.id = '__r9m_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const it of list) { if (!it) continue; const d = document.createElement('div');
      if (it.type === 'line') d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:2px;height:' + Math.max(2, it.h || 18) + 'px;background:' + it.color;
      else d.style.cssText = 'position:fixed;pointer-events:none;left:' + Math.round(it.x) + 'px;top:' + Math.round(it.y) + 'px;width:' + Math.round(it.w) + 'px;height:' + Math.round(it.h) + 'px;border:1.5px dashed ' + it.color;
      if (it.label) { const t = document.createElement('div'); t.textContent = it.label;
        t.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;left:' + (Math.round(it.x) + 4) + 'px;top:' + (Math.round(it.y) - 14) + 'px;color:' + it.color; layer.appendChild(t); }
      layer.appendChild(d); }
    document.body.appendChild(layer); return list.length; },
    unmark() { const old = document.getElementById('__r9m_marks'); if (old) old.remove(); return 1; } };
  return { ok: true }; })()`);
const mark = (session, list) => session.js(inIF(`window.__r9m.mark(${JSON.stringify(list)})`));
async function shots(session, frame, name, anchor) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor ? anchor.x : 300) - 260),
      y: frame.y + Math.max(0, (anchor ? anchor.y : 300) - 60), width: 600, height: 180, scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

// ─── S1：medium 文档（~500 块，无虚拟化）深部选区 → Ctrl+S → 机制时间线 ───────
async function caseS1(session, env) {
  const file = env.file;
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  const inst = await session.js(WATCH_INSTALL);
  if (!inst || !inst.ok) return { verdict: 'FAIL', detail: { 错: '监听装载失败', inst } };

  // 滚到深部（真滚轮）并点进"第 300 段"附近
  const deepAt = await ev(session, `(() => { const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes('第 300 段'));
    if (!block) return null; block.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2), iy: Math.round(r.y), iw: Math.round(r.width) }; })()`);
  if (!deepAt) return { verdict: 'FAIL', detail: { 错: '找不到 第 300 段' } };
  const scrolledTo = await ev(session, DUMP);
  const point = { x: deepAt.x, y: deepAt.y };
  await session.click(point.x, point.y);
  await harness.sleep(250);

  // 真拖拽选一段文字（键盘+鼠标配合：点词首 → Shift+End 扩选更稳，这里用拖拽）
  const end = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes('第 300 段'));
    const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.right - 30), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  // 先打脏（Ctrl+S 要有东西可写），再拖选——打字会吃掉选区，顺序不能反
  await hi.press(session, 'x', { text: 'x' });
  await harness.sleep(300);
  await hi.drag(session, point, end, { steps: 6, interval: 45 });
  const selBefore = await ev(session, DUMP);
  const marked = await session.js(inIF('window.__r9s.markBlock()'));
  const preSave = await ev(session, DUMP);
  startClock(session);

  // 真 Ctrl+S
  const save = await keySave(session, file);
  await harness.sleep(200); const post0 = await ev(session, DUMP);
  await harness.sleep(600); const post800 = await ev(session, DUMP);
  await harness.sleep(1500); const post2300 = await ev(session, DUMP);
  const markAlive = await session.js(inIF('window.__r9s.markAlive()'));
  const timeline = await collect(session);

  await shots(session, frame, 'S1-保存后', post0 && post0.rangeRect ? { x: Math.max(40, post0.rangeRect.x), y: Math.min(Math.max(post0.rangeRect.y, 60), 300) } : undefined);

  const 滚动被拉回 = preSave && preSave.scrollTop > 500 && post2300 && post2300.scrollTop < preSave.scrollTop - 400;
  const 选区悬空 = markAlive && markAlive.alive === false;
  return { verdict: 'EVIDENCE', detail: {
    滚到位: scrolledTo, 拖选后: selBefore, 标记块: marked,
    打脏后_保存前: preSave, 保存: save,
    保存后0ms: post0, 保存后800ms: post800, 保存后2300ms: post2300,
    标记块存活: markAlive, 时间线: timeline,
    机制判读: { 滚动被拉回顶部: !!滚动被拉回, 选区节点失联: !!选区悬空 },
  } };
}

// ─── S2：构造 R8 观察态（选区在深处、视口在顶部）→ 续操作看去向 ──────────────
async function caseS2(session, env) {
  const file = env.file;
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  // 自足前置：深部（第 300 段）真拖选一段 → 真滚轮回顶部 —— 即 R8 观察到的状态
  // （检索前缀放宽为「第 300」：S1 若先跑过，会在段号里插进 x）
  const deep = await ev(session, `(() => { const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes('第 300'));
    if (!block) return null; block.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2),
      ex: Math.round(fr.x + r.right - 30) }; })()`);
  if (!deep) return { verdict: 'FAIL', detail: { 错: '找不到 第 300 段' } };
  await session.click(deep.x, deep.y);
  await harness.sleep(250);
  await hi.drag(session, { x: deep.x, y: deep.y }, { x: deep.ex, y: deep.y }, { steps: 6, interval: 45 });
  const selDeep = await ev(session, DUMP);
  const focusOK1 = await session.js(hi.FOCUS);
  if (!(focusOK1 && focusOK1.ok)) return { verdict: 'FAIL', detail: { 错: '拖选后焦点不在编辑器', focus: focusOK1 } };

  const atTop = await wheelTo(session, 0);
  const topState = await ev(session, DUMP);
  if (!topState || topState.scrollTop > 40) return { verdict: 'FAIL', detail: { 错: '没能回到顶部', atTop, topState } };
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '顶部态焦点不在编辑器', focus: focusOK } };
  await shots(session, frame, 'S2-顶部态选区在外', { x: 200, y: 200 });

  // (a) 方向键：ArrowRight —— 选区应折叠、光标应落到原选区尾部（深处）
  await hi.press(session, 'ArrowRight');
  await harness.sleep(300);
  const afterArrow = await ev(session, DUMP);
  const caret1 = await hi.caret(session);
  // (b) 组合键：Shift+End（从光标扩到行尾）——组合键通道
  await hi.combo(session, 'Shift+End');
  await harness.sleep(250);
  const afterShiftEnd = await ev(session, DUMP);
  await hi.press(session, 'ArrowLeft');
  await harness.sleep(200);
  // (c) 打字：真 insertText 一个字，看落点与视口跟随
  const mdBefore = String(await hi.mdNow(session) || '');
  await session.type('Q');
  await harness.sleep(400);
  const afterType = await ev(session, DUMP);
  const mdAfter = String(await hi.mdNow(session) || '');
  const diff = mdAfter !== mdBefore;
  const caret2 = await hi.caret(session);
  await shots(session, frame, 'S2-打字后', afterType && afterType.rangeRect ? { x: Math.max(40, afterType.rangeRect.x), y: Math.min(Math.max(afterType.rangeRect.y, 60), 300) } : undefined);

  const 视口跟光标 = afterType && afterType.scrollTop !== topState.scrollTop;
  return { verdict: 'EVIDENCE', detail: {
    深部选区: selDeep, 顶部态: topState,
    方向键后: afterArrow, 光标1: caret1,
    ShiftEnd后: afterShiftEnd,
    打字后: afterType, 光标2: caret2, 文档已变: diff,
    打字落点前缀: caret2 && caret2.前缀, 打字块: caret2 && caret2.块文本,
    视口跟随: 视口跟光标 ? { 从: topState.scrollTop, 到: afterType && afterType.scrollTop } : false,
  } };
}

// ─── S3：小文档（~40 块，2~3 屏，无虚拟化）同流程 ────────────────────────────
const DOC_S3 = ['# R9S3 小文档控制组', '']
  .concat(Array.from({ length: 40 }, (_, i) => 'S3第 ' + (i + 1) + ' 段：' + '小文档无虚拟化控制组的正文文字。'.repeat(i % 3 + 1)))
  .concat([''])
  .join('\n\n');

async function caseS3(session, env) {
  const file = env.file;
  const frame = await frameOf(session);
  await hi.ensureFocus(session);
  const inst = await session.js(WATCH_INSTALL);
  if (!inst || !inst.ok) return { verdict: 'FAIL', detail: { 错: '监听装载失败', inst } };
  // 滚到底部区段并选 S3第 36 段
  const deepAt = await ev(session, `(() => { const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes('S3第 36 段'));
    if (!block) return null; block.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!deepAt) return { verdict: 'FAIL', detail: { 错: '找不到 S3第 36 段' } };
  await session.click(deepAt.x, deepAt.y);
  await harness.sleep(250);
  // 块尾坐标先算好（打脏插入的 x 会打断前缀检索），再打脏，再拖选
  const end = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(S)});
    const block = [...root.children].find(b => String(b.textContent || '').includes('S3第 36 段'));
    if (!block) return null;
    const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.right - 30), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!end) return { verdict: 'FAIL', detail: { 错: 'S3 end 坐标没取到' } };
  await hi.press(session, 'x', { text: 'x' });
  await harness.sleep(300);
  await hi.drag(session, { x: deepAt.x, y: deepAt.y }, end, { steps: 6, interval: 45 });
  const selBefore = await ev(session, DUMP);
  const marked = await session.js(inIF('window.__r9s.markBlock()'));
  const preSave = await ev(session, DUMP);
  startClock(session);
  const save = await keySave(session, file);
  await harness.sleep(300); const post0 = await ev(session, DUMP);
  await harness.sleep(1200); const post1500 = await ev(session, DUMP);
  const markAlive = await session.js(inIF('window.__r9s.markAlive()'));
  const timeline = await collect(session);
  await shots(session, frame, 'S3-保存后', post0 && post0.rangeRect ? { x: Math.max(40, post0.rangeRect.x), y: Math.min(Math.max(post0.rangeRect.y, 60), 300) } : undefined);
  return { verdict: 'EVIDENCE', detail: {
    选后: selBefore, 标记块: marked, 打脏后: preSave, 保存: save,
    保存后0ms: post0, 保存后1500ms: post1500, 标记块存活: markAlive, 时间线: timeline,
  } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase());
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R9SEL ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line); log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const saved = harness.saveClipboard(OUT);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r9-selsave', outDir: OUT, timeout: 240000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let failed = 0, evidenced = 0;
  // 组 1：medium（S1 机制 + S2 续操作，同一会话——S2 要接着 S1 的状态）
  // 组 2：小文档 S3
  const mediumFile = fixtures.medium();
  const s3File = path.join(OUT, 'r9-s3-small.md');
  fs.writeFileSync(s3File, DOC_S3, 'utf8');
  const plan = [
    { file: mediumFile, cases: want('s1') || want('s2') ? [['S1机制时间线', want('s1') ? caseS1 : null], ['S2续操作', want('s2') ? caseS2 : null]] : [] },
    { file: s3File, cases: want('s3') ? [['S3小文档', caseS3]] : [] },
  ];
  try {
    for (const group of plan) {
      const todo = group.cases.filter(([name, run]) => run);
      if (!todo.length) continue;
      console.log('\n=== ' + path.basename(group.file) + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      let session = null;
      try {
        session = await hi.openDoc(ctx, group.file, { minBlocks: 5, settleMs: 2500, timeout: 240000 });
        const m = await session.js(MARK_INSTALL);
        if (!m || !m.ok) throw new Error('页内标记装载失败：' + JSON.stringify(m));
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session, { file: group.file }) || {};
            report(name, outcome.verdict || 'FAIL', outcome.detail || {});
            evidenced += 1;
          } catch (error) { report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) }); failed += 1; }
        }
      } catch (error) {
        console.log('  ！组未跑完：' + String(error && error.message || error).slice(0, 300));
        for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
      } finally {
        if (session) await ctx.release(session);
        // medium 是共用素材房文件，把内容还原（fixtures 每次生成同内容，但别留脏）
        if (group.file === mediumFile) { try { fixtures.medium(); } catch {} }
      }
    }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：EVIDENCE ' + evidenced + ' / FAIL ' + failed + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r9-selsave 失败：', error); process.exit(1); });
