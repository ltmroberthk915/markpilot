/** 探针 · 第 2 轮判决落实（2026-10-02）的实机验收：表格域两条——
 *   T1  目标列命中空 td 时给伪落点直落该格，不跳邻列（typora-patches.js resolveAt 候选钳本格
 *       ＋空格 (td,0) 伪落点）；
 *   T5  行端扫描钳进光标所在 td/th 盒（表格里 Home 只在本格找行端）。
 *
 *  判据全部是**用户能看见的性质**（光标落在哪个格、在哪一视觉行、列对不对），绝不断言
 *  "处理器被调用了"。每用例一行：
 *     R2TP <用例名> PASS/FAIL/EVIDENCE <关键读数 JSON>
 *  每用例存整页 + 光标附近 2x 放大截图到 .perf/probe-r2-tables/。CDP 抓帧拍不到原生光标，
 *  图上按浏览器自报的光标矩形画标记：红实线＝光标落点、琥珀虚线＝目标列/期望行首、青虚线＝
 *  点击处；光标真的隐形（0×0）时标记画不出来——那本身就是"光标没了"的视觉证据。
 *
 *  各用例的红条件（未修复版上必红）：
 *   T1  3×3 表第 2 列第 2 行置空，其上（第 2 列第 1 行）按 ↓：旧版 resolveAt 的 best/近端桶被
 *       邻列同一视觉行的候选占走——光标落进第 1/第 3 列的格（所在格 ≠ 空格）。
 *   T5  第 2 列长文本折行、次行中部按 Home：旧版 行端 从整面左缘扫起，"本行行首"被解到
 *       第 1 列里——光标跳到前一格（所在格 ≠ 第 2 列那格，或行顶跑到别的视觉行）。
 *
 *  用法：node scripts/acceptance/probe-r2-tables.cjs [--only=t1,t5]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r2-tables');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');

// 表一（T1）：3 数据行 × 3 列，第 2 列第 2 行置空——"其上按 ↓"的落点判据就在这一格。
const TABLE1 = [
  '| 列一 | 列二 | 列三 |',
  '| --- | --- | --- |',
  '| 甲一 | 甲二 | 甲三 |',
  '| 乙一 |  | 乙三 |',
  '| 丙一 | 丙二 | 丙三 |',
].join('\n');
// 表二（T5）：第 2 列超长文本保证在格内折成 ≥2 视觉行；第 1/3 列短文本。
//   1364px 宽窗口实测旧文本（九十来个全角字）一行就放完——表格自动布局会把长列撑宽、
//   整表横向溢出也不折行。这一版加长到 220+ 个全角字符（≥120 的硬性要求再翻倍余量），
//   无论列宽怎么分、窗口多宽，这一格都必然折出两行以上，Home 的行端判据才有"次行"可落。
const 长格文 = '第二列的这一格放了很长的一段文字，用来在单元格内部折出多出来的视觉行；'
  + '按 Home 的判据是"次行行首留本格"，所以这段必须稳定折出至少两行。'
  + '上一版只有九十来个字，表格把列一路撑宽到一行放完，行数读成一，用例连判据都进不去。'
  + '这一版把正文加长到两百字以上：再补两三句无关痛痒的话把长度余量拉满，'
  + '让任何窗口宽度、任何列宽分配下这一格都折成好几行，'
  + '避免边界效应影响行判读。';
const TABLE2 = [
  '| 短一 | 长文列 | 短三 |',
  '| --- | --- | --- |',
  '| 甲字 | ' + 长格文 + ' | 乙字 |',
].join('\n');

const DOC1 = ['# 表格纵向判侧', '',
  '前导段落：隔开标题与表格的一行普通文字。', '',
  TABLE1, '',
  '中隔段落：两张表之间的过渡文字。', '',
  TABLE2, '',
  '尾段落：收尾文字。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe；标记画法沿用 probe-r1-caret 的 __pr/__r1 口径） ─────────
const HELPERS = `window.__r2t = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  const layerOf = at => !at ? '?' :
    at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('[data-type$="-marker"]') ? '围栏'
    : at.closest && at.closest('td,th') ? '表格'
    : at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote') ? '正文' : '元素级';
  const mark = list => {
    const old = document.getElementById('__r2t_marks');
    if (old) old.remove();
    if (!list || !list.length) return 0;
    const layerNode = document.createElement('div');
    layerNode.id = '__r2t_marks';
    layerNode.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) {
      if (!item) continue;
      const line = document.createElement('div');
      const height = Math.max(2, item.h || 18);
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + height + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layerNode.appendChild(line);
      drawn += 1;
      if (item.label) {
        const tag = document.createElement('div');
        tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layerNode.appendChild(tag);
      }
    }
    document.body.appendChild(layerNode);
    return drawn;
  };
  const unmark = () => { const old = document.getElementById('__r2t_marks'); if (old) old.remove(); return 1; };
  const caret = () => {
    const s = getSelection();
    if (!s || !s.rangeCount) return { 无选区: true };
    const n = s.focusNode, o = s.focusOffset;
    const at = n.nodeType === 3 ? n.parentElement : n;
    let b = null;
    try { const probe = document.createRange(); probe.setStart(n, o); probe.collapse(true); b = probe.getBoundingClientRect(); } catch (e) {}
    const cell = at && at.closest ? at.closest('td,th') : null;
    return { 层: layerOf(at),
      容器: n.nodeType === 3 ? ('TEXT「' + String(n.data).slice(0, 12) + '」') : n.nodeName,
      偏移: o, 前缀: n.nodeType === 3 ? String(n.data).slice(Math.max(0, o - 20), o) : '',
      x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height),
      可见: !!(b && b.height), 折叠: s.isCollapsed,
      所在格: cell ? { 行: cell.parentElement.rowIndex, 列: cell.cellIndex, 文本: String(cell.textContent || '').trim().slice(0, 16) } : null };
  };
  /** 两张表的几何：格清单（行/列/文本/盒）＋指定格的盒。 */
  const tables = () => [...surface().querySelectorAll('table')].map((t, ti) => ({
    序: ti,
    格: [...t.querySelectorAll('td,th')].map(c => {
      const b = c.getBoundingClientRect();
      return { 行: c.parentElement.rowIndex, 列: c.cellIndex,
        文本: String(c.textContent || '').trim(), 空: !String(c.textContent || '').trim(),
        盒: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] };
    }) }));
  /** 指定格的点击点（fraction 沿宽，0.5 为中线）——顶层页坐标（含 iframe 偏移）。
   *  本工具装在编辑器 iframe 里，而 #editor 是**顶层页**的元素、iframe 文档里没有——
   *  旧版对 null 调 getBoundingClientRect 直接抛。改用 window.frameElement（同源 iframe
   *  从里面看自己，矩形与顶层 #editor 一致）优先；frame/编辑面/表/格任一找不到都返回
   *  null，由用例转成 EVIDENCE，不许抛。 */
  const cellPoint = (ti, row, col, fraction) => {
    const frame = window.frameElement || document.getElementById('editor');
    if (!frame) return null;
    const fr = frame.getBoundingClientRect();
    const s = surface();
    if (!s) return null;
    const t = s.querySelectorAll('table')[ti];
    if (!t) return null;
    const cell = [...t.querySelectorAll('td,th')].find(c => c.parentElement.rowIndex === row && c.cellIndex === col);
    if (!cell) return null;
    cell.scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = cell.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return { x: Math.round(fr.x + b.left + b.width * fraction), y: Math.round(fr.y + b.top + b.height / 2),
      格盒: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
      iframe内: { x: Math.round(b.left + b.width * fraction), y: Math.round(b.top + b.height / 2) } };
  };
  /** 指定格内**正文文本**的逐字盒（预览/围栏/公式源码不计），按视觉行分组返回行清单。 */
  const cellLines = (ti, row, col) => {
    const t = surface().querySelectorAll('table')[ti];
    if (!t) return null;
    const cell = [...t.querySelectorAll('td,th')].find(c => c.parentElement.rowIndex === row && c.cellIndex === col);
    if (!cell) return null;
    cell.scrollIntoView({ block: 'center', behavior: 'instant' });
    const chars = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {acceptNode: text =>
      text.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker,[data-type$="-marker"]')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    let node;
    while (node = walker.nextNode()) {
      for (let i = 0; i < node.data.length; i++) {
        if (/[\s\u200b]/.test(node.data[i])) continue;
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
        const b = r.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) chars.push({ ch: node.data[i], left: b.left, right: b.right, top: b.top, bottom: b.bottom });
      }
    }
    if (!chars.length) return { 行数: 0 };
    chars.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const c of chars) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(c.top - last.顶) <= 3) { last.末 = c; }
      else lines.push({ 顶: c.top, 首: c, 末: c });
    }
    return { 行数: lines.length,
      行: lines.map((l, i) => ({ 序: i, 顶: Math.round(l.顶), 左: Math.round(l.首.left), 右: Math.round(l.末.right),
        首字: l.首.ch, 文本: chars.filter(c => Math.abs(c.top - l.顶) <= 3).map(c => c.ch).join('').slice(0, 40) })) };
  };
  return { caret, mark, unmark, tables, cellPoint, cellLines };
})();`;

const INSTALL = `(() => { const w = ${hi.IF};
  if (!w || !w.document.querySelector('${hi.SURFACE}')) return { ok: false };
  if (!w.__r2t) w.eval(${JSON.stringify(HELPERS)});
  return { ok: !!w.__r2t }; })()`;
const IN = expression => `(() => { const w = ${hi.IF}; return w.eval(${JSON.stringify(expression)}); })()`;
const readCaret = session => session.js(IN('window.__r2t.caret()'));
const caretMark = r => (r && r.可见) ? [{ x: r.x, y: r.y, h: r.h, color: '#ff2d2d', label: '光标' }] : [];
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const key = async (session, name, vk, wait = 350) => {
  await session.key({ key: name, code: name, vk });
  await harness.sleep(wait);
};
const focusOK = async session => (await hi.ensureFocus(session)).ok;

/** 整页 + 光标附近 2x 放大截图（放大帧上带标记：红实线＝光标、琥珀虚线＝期望列、青虚线＝点击处）。
 *  anchor 与 marks 都是 **iframe 内坐标**（光标矩形/格盒在 iframe 文档里量出来就是它）；
 *  截图 clip 才要加上 iframe 在顶层页里的偏移。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await session.js(IN('window.__r2t.mark(' + JSON.stringify(marks) + ')'));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await session.js(IN('window.__r2t.unmark()'));
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** T1：3×3 表第 2 列第 2 行置空，其上（第 2 列第 1 数据行）按 ↓ 落进空格内、不跳邻列。
 *  点位取格宽 65% 处（目标列稳稳落在第 2 列的 x 带里），真实点击落下光标后真实按 ↓。 */
async function caseT1(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const info = await session.js(IN('window.__r2t.tables()'));
  const 表 = info && info[0];
  if (!表) return { verdict: 'FAIL', detail: { 阶段: '没找到表一', info } };
  const 空格 = 表.格.find(c => c.空);
  if (!空格) return { verdict: 'FAIL', detail: { 阶段: '表一没有空格', 格: 表.格 } };
  // rowIndex 含表头（0）、cellIndex 从 0 数：第 2 列第 2 数据行＝(2,1)，其上一格＝(1,1)
  if (!(空格.行 === 2 && 空格.列 === 1)) {
    return { verdict: 'FAIL', detail: { 阶段: '空格不在第2列第2数据行', 空格, 红: '素材形状不对，无法判 T1' } };
  }
  let 上格点 = null, 定位异常 = null;
  try { 上格点 = await session.js(IN('window.__r2t.cellPoint(0, 1, 1, 0.65)')); }
  catch (error) { 定位异常 = String(error && error.message || error).slice(0, 200); }
  if (!上格点 || !上格点.x) {
    return { verdict: 'EVIDENCE', detail: { 阶段: '定位上格（表/行/格或 iframe 盒没找到）', 定位异常,
      表格几何: 表, 红: '几何读不到判不了 T1，EVIDENCE 附全表几何供核对' } };
  }
  await session.click(上格点.x, 上格点.y);
  await harness.sleep(400);
  const start = await readCaret(session);
  await shots(session, frame, 'T1-起点', { x: 上格点.iframe内.x, y: 上格点.iframe内.y },
    [...caretMark(start), { x: 上格点.iframe内.x, y: 上格点.iframe内.y, h: 22, dash: true, color: '#25d0ff', label: '点击处(上格)' }]);
  await key(session, 'ArrowDown', 40, 500);
  const now = await readCaret(session);
  await shots(session, frame, 'T1-下键后', now.可见 ? now : { x: 上格点.iframe内.x, y: 上格点.iframe内.y + 40 },
    [...caretMark(now), { x: 上格点.iframe内.x, y: 上格点.iframe内.y, h: 22, dash: true, color: '#f0a020', label: '目标列' }]);
  const 落进空格 = !!(now.所在格 && now.所在格.行 === 空格.行 && now.所在格.列 === 空格.列);
  return { verdict: 落进空格 ? 'PASS' : 'FAIL', detail: {
    空格: { 行: 空格.行, 列: 空格.列, 盒: 空格.盒 },
    上格: { 行: 1, 列: 1, 点: [上格点.x, 上格点.y], 目标列: Math.round(上格点.iframe内.x) },
    起点: start, 下键后: now,
    红: '旧版 resolveAt 的候选被邻列同视觉行的文本占走：所在格变成第1/3列（行=3、列=0或2），光标不在空格里' } };
}

/** T5：第 2 列长文本折行、次行中部按 Home——光标留本格、落本次行行首。
 *  判据三条：① 所在格仍是本格；② 行顶与按下前同一视觉行；③ x 钳到本次行行首附近
 *  （≤ 行首左缘 + 24px，约一个半字宽）。 */
async function caseT5(session) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点' } };
  const lines = await session.js(IN('window.__r2t.cellLines(1, 1, 1)'));
  if (!lines || lines.行数 < 2) return { verdict: 'FAIL', detail: { 阶段: '第二列没折行（行数<2）', lines } };
  const 次行 = lines.行[1];
  // 次行中部：行首/行末中点（iframe 内坐标），换算成顶层页坐标点击
  const 中点 = { x: Math.round((次行.左 + 次行.右) / 2), y: Math.round(次行.顶 + 8) };
  const frame2 = await frameOf(session);
  await session.click(frame2.x + 中点.x, frame2.y + 中点.y);
  await harness.sleep(400);
  const start = await readCaret(session);
  await shots(session, frame2, 'T5-起点', 中点,
    [...caretMark(start), { x: 中点.x, y: 中点.y, h: 22, dash: true, color: '#25d0ff', label: '点击处(次行中部)' }]);
  await key(session, 'Home', 36, 500);
  const now = await readCaret(session);
  await shots(session, frame2, 'T5-Home后', now.可见 ? now : 中点,
    [...caretMark(now), { x: 次行.左, y: 次行.顶, h: 22, dash: true, color: '#f0a020', label: '次行行首' }]);
  const 同格 = !!(start.所在格 && now.所在格
    && now.所在格.行 === start.所在格.行 && now.所在格.列 === start.所在格.列);
  const 同行 = Math.abs(now.y - 次行.顶) <= 6;     // 光标框顶与字形顶允许几像素基线差
  const 到行首 = now.x <= 次行.左 + 24;
  return { verdict: 同格 && 同行 && 到行首 ? 'PASS' : 'FAIL', detail: {
    视觉行数: lines.行数, 次行: { 顶: 次行.顶, 左: 次行.左, 右: 次行.右, 首字: 次行.首字, 文本: 次行.文本 },
    点击: [中点.x, 中点.y], 起点: start, Home后: now,
    判: { 同格, 同行, 到行首 },
    红: '旧版 行端 从整面左缘扫起：Home后所在格变第1列（列=0），或行顶跑到上一视觉行/邻格行' } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r2-doc-tables.md', content: DOC1, cases: [['T1', caseT1], ['T5', caseT5]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase()) || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R2TP ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r2-tables',
      outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let failed = 0, passed = 0, evidenced = 0;
  for (const group of GROUPS) {
    const todo = group.cases.filter(([name]) => want(name));
    if (!todo.length) continue;
    const file = path.join(OUT, group.doc);
    fs.writeFileSync(file, group.content, 'utf8');
    console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
    let session = null;
    try {
      session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500, timeout: 180000 });
      const installed = await session.js(INSTALL);
      if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
      for (const [name, run] of todo) {
        try {
          const outcome = await run(session) || {};
          report(name, outcome.verdict || 'FAIL', outcome.detail || {});
          if (outcome.verdict === 'PASS') passed += 1;
          else if (outcome.verdict === 'EVIDENCE') evidenced += 1;
          else failed += 1;
        } catch (error) {
          report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
          failed += 1;
        }
      }
    } catch (error) {
      console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
      for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
    } finally {
      if (session) await ctx.release(session);      // 每组结束释放会话（等内部端口让出来再开下一组）
    }
  }
  fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' / EVIDENCE ' + evidenced + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r2-tables 失败：', error); process.exit(1); });
