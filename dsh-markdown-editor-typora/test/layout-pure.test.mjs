// test/layout-pure.test.mjs — 布局子系统升级 v3 / P0 纯函数验收
//
// 覆盖方案 §1.1（模型与不变量 I1/I2/I6）、§1.3（宿主 inline 解析文法）、§1.5（colW 推导）。
// 这一层没有 DOM、没有副作用，所以这里做穷举式断言：任何一条挂了都说明模型层错。
// 不覆盖：真实宿主 DOM、观察器时序、视觉（属后续阶段的六步验收）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');

let cached = null;

async function getPure() {
  if (cached) return cached;
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { captured = def; } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, '未捕获到 ModuleLoader 定义');
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod && mod.__test && mod.__test.layout && mod.__test.layout.pure, '__test.layout.pure 未暴露');
  cached = mod.__test.layout.pure;
  return cached;
}

const HOST_WITH_RIGHTBAR = '264px minmax(400px, 1fr) minmax(0px, 330px)';
const HOST_NO_RIGHTBAR = '264px minmax(0px, 1fr) minmax(0px, 0px)';
const HOST_COLLAPSED = '56px minmax(400px, 1fr) minmax(0px, 300px)';

/* ── 1. clamp ─────────────────────────────────────────────────────────── */
test('pure.clamp：边界与非法输入', async () => {
  const { clamp } = await getPure();
  assert.equal(clamp(180, 180, 420), 180, '下界取等');
  assert.equal(clamp(420, 180, 420), 420, '上界取等');
  assert.equal(clamp(100, 180, 420), 180, '低于下界抬到 min');
  assert.equal(clamp(999, 180, 420), 420, '高于上界压到 max');
  assert.equal(clamp(NaN, 180, 420), 180, 'NaN 退 min');
  assert.equal(clamp(undefined, 160, 460), 160, 'undefined 退 min');
  assert.equal(clamp('200', 180, 420), 200, '数字字符串可用');
  assert.equal(clamp(-5, 0, 100), 0, '负数被抬到 0');
});

/* ── 2. parseCollapseValue ────────────────────────────────────────────── */
test('pure.parseCollapseValue：值语义（存在≠折叠）', async () => {
  const { parseCollapseValue } = await getPure();
  assert.equal(parseCollapseValue(null), false, '缺失 = 未折叠');
  assert.equal(parseCollapseValue(undefined), false, 'undefined = 未折叠');
  assert.equal(parseCollapseValue('false'), false, '"false" = 未折叠');
  assert.equal(parseCollapseValue('FALSE'), false, '大小写不敏感');
  assert.equal(parseCollapseValue(''), false, '空串 = 未折叠');
  assert.equal(parseCollapseValue('0'), false, '"0" = 未折叠');
  assert.equal(parseCollapseValue('off'), false, '"off" = 未折叠');
  assert.equal(parseCollapseValue('null'), false, '"null" = 未折叠');
  assert.equal(parseCollapseValue('true'), true, '"true" = 折叠');
  assert.equal(parseCollapseValue('1'), true, '"1" = 折叠');
  assert.equal(parseCollapseValue('true '), true, '带空格 = 折叠');
});

/* ── 3. parseHostGrid ─────────────────────────────────────────────────── */
test('pure.parseHostGrid：右栏开着（中轨 min 400、第三轨 max 是右栏宽）', async () => {
  const { parseHostGrid } = await getPure();
  const g = parseHostGrid(HOST_WITH_RIGHTBAR);
  assert.equal(g.ok, true);
  assert.equal(g.sbTrack, 264, 'sbTrack 取第一轨');
  assert.equal(g.rbTrack, 330, 'rbTrack 取第三轨 max（不是 min）');
  assert.equal(g.centerMin, 400);
  assert.equal(g.rightbarOpen, true, '中轨 min>0 表示右栏开着');
  assert.equal(g.collapsedSidebar, false);
});

test('pure.parseHostGrid：右栏关着（中轨 min 0、rbTrack 0）', async () => {
  const { parseHostGrid } = await getPure();
  const g = parseHostGrid(HOST_NO_RIGHTBAR);
  assert.equal(g.ok, true);
  assert.equal(g.rbTrack, 0);
  assert.equal(g.rightbarOpen, false);
});

test('pure.parseHostGrid：侧栏折叠窄轨（56）与 0 轨', async () => {
  const { parseHostGrid } = await getPure();
  const g = parseHostGrid(HOST_COLLAPSED);
  assert.equal(g.ok, true);
  assert.equal(g.sbTrack, 56);
  assert.equal(g.collapsedSidebar, true, '窄轨判定 < 120');
  const g0 = parseHostGrid('0px minmax(400px, 1fr) minmax(0px, 300px)');
  assert.equal(g0.ok, true, 'Windows 桌面构建的 0px 也要能解析');
  assert.equal(g0.sbTrack, 0);
});

test('pure.parseHostGrid：无空格写法与失败分支', async () => {
  const { parseHostGrid } = await getPure();
  const g = parseHostGrid('264px minmax(0px,1fr) minmax(0px,300px)');
  assert.equal(g.ok, true, '紧凑写法要能解析');
  assert.equal(g.rbTrack, 300);
  assert.equal(parseHostGrid('').ok, false, '空串失败');
  assert.equal(parseHostGrid(null).ok, false, 'null 失败');
  assert.equal(parseHostGrid('264px').ok, false, '轨道数不足失败');
  assert.equal(parseHostGrid('264px minmax(0px,1fr)').ok, false, '两轨失败');
  assert.equal(parseHostGrid('264px minmax(0px,1fr) minmax(0px,300px) 120px').ok, false, '四轨失败');
  assert.equal(parseHostGrid('auto minmax(0px,1fr) minmax(0px,300px)').ok, false, '非 px 首轨失败');
  assert.equal(parseHostGrid('264px minmax(0px,1fr) minmax(0px,-300px)').ok, false, '负值失败');
});

/* ── 4. deriveColW ────────────────────────────────────────────────────── */
test('pure.deriveColW：中列推导（不采样）', async () => {
  const { deriveColW } = await getPure();
  assert.equal(deriveColW(1463, 264, 300), 899);
  assert.equal(deriveColW(1463, 56, 300), 1107, '折叠窄轨');
  assert.equal(deriveColW(1463, 264, 0), 1199, '右栏关闭');
  assert.equal(deriveColW(1024, 264, 300), 460);
  assert.equal(deriveColW(400, 264, 300), 0, '放不下时归 0，不产负数');
  assert.equal(deriveColW(0, 264, 300), 0, '视口 0');
  assert.equal(deriveColW(NaN, 264, 300), 0);
});

/* ── 5. computeChatMargins ────────────────────────────────────────────── */
test('pure.computeChatMargins：对话贴右（margin-left）', async () => {
  const { computeChatMargins } = await getPure();
  const r = computeChatMargins({ colW: 899, chatW: 420, side: 'left', editorMin: 240 });
  assert.equal(r.ok, true);
  assert.equal(r.chatW, 420);
  assert.equal(r.gap, 479);
  assert.equal(r.marginLeft, '479px', 'side=left → 只给 margin-left');
  assert.equal(r.marginRight, '');
});

test('pure.computeChatMargins：对话贴左（margin-right）', async () => {
  const { computeChatMargins } = await getPure();
  const r = computeChatMargins({ colW: 899, chatW: 420, side: 'right', editorMin: 240 });
  assert.equal(r.ok, true);
  assert.equal(r.marginLeft, '');
  assert.equal(r.marginRight, '479px');
});

test('pure.computeChatMargins：钳制与放弃分支', async () => {
  const { computeChatMargins } = await getPure();
  const tooWide = computeChatMargins({ colW: 899, chatW: 5000, side: 'left', editorMin: 240 });
  assert.equal(tooWide.ok, true);
  assert.equal(tooWide.chatW, 659, '最多到 colW - editorMin');
  assert.equal(tooWide.gap, 240, '编辑区保底');
  const tooNarrow = computeChatMargins({ colW: 899, chatW: 100, side: 'left' });
  assert.equal(tooNarrow.chatW, 220, '最少 220（窄列 CSS 已停用，220 下宿主排版正常）');
  const giveUp = computeChatMargins({ colW: 400, chatW: 220, side: 'left', editorMin: 240 });
  assert.equal(giveUp.ok, false, 'colW-editorMin < 220 → 放弃挤压');
  assert.equal(giveUp.reason, 'too-narrow');
  assert.equal(giveUp.marginLeft, '', '放弃时不得写 margin');
  const noCol = computeChatMargins({ colW: 0, chatW: 220 });
  assert.equal(noCol.ok, false);
  assert.equal(noCol.reason, 'no-col');
});

/* ── 6. clampModel（I1 / I2 / I6） ────────────────────────────────────── */
function mkModel(over) {
  return Object.assign({
    viewport: { w: 1463, h: 800 },
    sidebar: { w: 280, min: 180, max: 420, collapsed: false, userW: null },
    rightbar: { w: 300, min: 160, max: 900, collapsed: false, userW: null },
    chat: { w: 420, min: 220, max: 900, side: 'left' },
    docs: { open: true, listW: 268 },
    phase: 'idle',
  }, over || {});
}

test('pure.clampModel：I1 上限取宿主常量，不取几何', async () => {
  const { clampModel, constants } = await getPure();
  const hi = clampModel(mkModel({ sidebar: { w: 999, min: 180, max: 999, collapsed: false } }), { viewportW: 1463 });
  assert.equal(hi.model.sidebar.w, constants.SIDEBAR_MAX, '侧栏压到 420');
  assert.ok(hi.reasons.includes('sidebar-clamped'));
  const lo = clampModel(mkModel({ sidebar: { w: 10, min: 180, max: 420, collapsed: false } }), { viewportW: 1463 });
  assert.equal(lo.model.sidebar.w, 180, '侧栏抬到 180');
  const rb = clampModel(mkModel({ rightbar: { w: 5000, min: 160, max: 900, collapsed: false } }), { viewportW: 2000 });
  assert.equal(rb.model.rightbar.w, 900, '右栏压到 900 上限（0.7×2000=1400 不构成约束）');
  const rbRatio = clampModel(mkModel({
    viewport: { w: 1200, h: 800 },
    sidebar: { w: 180, min: 160, max: 420, collapsed: false },
    rightbar: { w: 5000, min: 160, max: 900, collapsed: false },
  }), { viewportW: 1200 });
  assert.equal(rbRatio.model.rightbar.w, 560, '0.7×视口上限 + I6 削切全链：840 → 560');
});

test('pure.clampModel：I2 折叠列取窄轨宽（不摘 pin、不写 0）', async () => {
  const { clampModel, constants } = await getPure();
  const sb = clampModel(mkModel({ sidebar: { w: 280, min: 180, max: 420, collapsed: true } }), { viewportW: 1463, collapsedSidebarW: 56 });
  assert.equal(sb.model.sidebar.w, 56, '折叠侧栏 → 宿主窄轨宽');
  assert.ok(sb.reasons.includes('sidebar-collapsed'));
  assert.equal(sb.model.sidebar.collapsed, true);
  const sbFallback = clampModel(mkModel({ sidebar: { w: 280, min: 180, max: 420, collapsed: true } }), { viewportW: 1463 });
  assert.equal(sbFallback.model.sidebar.w, constants.COLLAPSED_FALLBACK, '解析不到窄轨时用兜底');
  const rb = clampModel(mkModel({ rightbar: { w: 300, min: 160, max: 900, collapsed: true } }), { viewportW: 1463 });
  assert.equal(rb.model.rightbar.w, 0, '右栏折叠 → 0 轨');
});

test('pure.clampModel：I6 视口不足按 右栏→侧栏 回缩', async () => {
  const { clampModel } = await getPure();
  const tight = clampModel(mkModel({
    viewport: { w: 900, h: 700 },
    sidebar: { w: 280, min: 180, max: 420, collapsed: false },
    rightbar: { w: 300, min: 160, max: 900, collapsed: false },
  }), { viewportW: 900 });
  assert.ok(tight.reasons.includes('viewport-tight'), '触发 I6');
  const sum = tight.model.sidebar.w + tight.model.rightbar.w + 220 + 240;
  assert.ok(sum <= 900, '回缩后满足 sb+rb+chat.min+editor.min ≤ 视口，实际 ' + sum);
  assert.ok(tight.model.rightbar.w < 300, '先削右栏');
});

test('pure.clampModel：不修改入参（纯函数）', async () => {
  const { clampModel } = await getPure();
  const src = mkModel();
  const snapshot = JSON.stringify(src);
  clampModel(src, { viewportW: 1463 });
  assert.equal(JSON.stringify(src), snapshot, '入参必须原样不动');
});

/* ── 7. 第三轮审查补测（M4/M5/D1） ───────────────────────────────────── */

test('pure.parseHostGrid：序列化变体（1FR / 小数 / 括号内空白）', async () => {
  const { parseHostGrid } = await getPure();
  const gFr = parseHostGrid('264px minmax(400px, 1FR) minmax(0px, 330px)');
  assert.equal(gFr.ok, true, '1FR 大写可解析');
  assert.equal(gFr.centerMin, 400);
  const gDec = parseHostGrid('263.5px minmax(400px, 1fr) minmax(0px, 300.25px)');
  assert.equal(gDec.ok, true, '小数 px 可解析');
  assert.equal(gDec.sbTrack, 263.5);
  assert.equal(gDec.rbTrack, 300.25);
  const gSp = parseHostGrid('264px  minmax( 0px , 1fr )  minmax( 0px , 300px )');
  assert.equal(gSp.ok, true, '括号内侧空白/多空格可解析');
  assert.equal(parseHostGrid('264px minmax(1.2.3px, 1fr) minmax(0px, 300px)').ok, false, '病态数字必须 grammar 失败，不得 parseFloat 截断');
});

test('pure.parseHostGrid：0px 窄轨也是折叠 / 右栏开合看第三轨', async () => {
  const { parseHostGrid } = await getPure();
  const g0 = parseHostGrid('0px minmax(0px, 1fr) minmax(0px, 330px)');
  assert.equal(g0.ok, true);
  assert.equal(g0.collapsedSidebar, true, '桌面构建 0px 窄轨也是折叠');
  assert.equal(g0.rightbarOpen, true, '右栏开合不依赖 centerMin（S=0 时 M 也为 0）');
  const gNoRb = parseHostGrid('56px minmax(400px, 1fr) minmax(0px, 0px)');
  assert.equal(gNoRb.rightbarOpen, false, '右栏关 = 第三轨 0px');
  assert.equal(gNoRb.collapsedSidebar, true, '56px 窄轨是折叠');
});

test('pure.deriveColW：负轨宽按 0，不放大中列', async () => {
  const { deriveColW } = await getPure();
  assert.equal(deriveColW(1463, -10, 300), 1163, '负轨宽按 0 处理');
});

test('pure.clampModel：chat.w 必须过 clamp（I5）', async () => {
  const { clampModel } = await getPure();
  const big = clampModel(mkModel({ chat: { w: 5000, min: 220, max: 900, side: 'left' } }), { viewportW: 1463 });
  assert.equal(big.model.chat.w, 900, 'chat.w 不允许 5000 穿透');
  assert.ok(big.reasons.includes('chat-clamped'));
  const small = clampModel(mkModel({ chat: { w: 10, min: 220, max: 900, side: 'left' } }), { viewportW: 1463 });
  assert.equal(small.model.chat.w, 220, 'chat.w 抬到 min');
});

test('pure.clampModel：I6 顺序钉死（先右栏到 min，再侧栏）', async () => {
  const { clampModel } = await getPure();
  const r = clampModel(mkModel({
    viewport: { w: 900, h: 700 },
    sidebar: { w: 280, min: 180, max: 420, collapsed: false },
    rightbar: { w: 300, min: 160, max: 900, collapsed: false },
  }), { viewportW: 900 });
  // midFloor = max(220+240, 400) = 460 → need = 280+300+460 = 1040 > 900，需削 140
  assert.equal(r.model.rightbar.w, 160, '右栏先削到 min=160');
  assert.equal(r.model.sidebar.w, 280, '右栏削足后侧栏不动');
  assert.ok(r.reasons.includes('viewport-tight'));
  assert.equal(r.pinnable, true, '削得动 → 仍可 pin');
});

test('pure.clampModel：still-tight 必须给 pinnable=false（D1 硬门）', async () => {
  const { clampModel } = await getPure();
  const st = clampModel(mkModel({
    viewport: { w: 700, h: 600 },
    sidebar: { w: 280, min: 180, max: 420, collapsed: false },
    rightbar: { w: 300, min: 160, max: 900, collapsed: false },
  }), { viewportW: 700 });
  // need = 280+300+460 = 1040 > 700，削到底（180+160=340）+460 = 800 > 700
  assert.ok(st.reasons.includes('still-tight'), 'mins 之和已超视口');
  assert.equal(st.model.sidebar.w, 180, '削到侧栏 min');
  assert.equal(st.model.rightbar.w, 160, '削到右栏 min');
  assert.equal(st.pinnable, false, 'still-tight ⇒ 不得直接 apply');
});

test('pure.clampModel：折叠窄轨 0 如实写入（桌面构建）', async () => {
  const { clampModel } = await getPure();
  const desk = clampModel(mkModel({ sidebar: { w: 280, min: 180, max: 420, collapsed: true } }), { viewportW: 1463, collapsedSidebarW: 0 });
  assert.equal(desk.model.sidebar.w, 0, '宿主窄轨 0 不得被兜底成 56');
});

test('pure.clampModel：userW 归一（字符串/NaN → null，数字取整）', async () => {
  const { clampModel } = await getPure();
  const uw = clampModel(mkModel({ sidebar: { w: 280, min: 180, max: 420, collapsed: false, userW: '310' } }), { viewportW: 1463 });
  assert.equal(uw.model.sidebar.userW, 310, '字符串数字要归一成数字');
  const nan = clampModel(mkModel({ sidebar: { w: 280, min: 180, max: 420, collapsed: false, userW: NaN } }), { viewportW: 1463 });
  assert.equal(nan.model.sidebar.userW, null, 'NaN → null');
  const none = clampModel(mkModel(), { viewportW: 1463 });
  assert.strictEqual(none.model.sidebar.userW, null, '没拖过 = null');
});

test('pure.clampModel：返回模型与入参无共享引用（docs 深拷）', async () => {
  const { clampModel } = await getPure();
  const src = mkModel();
  const out = clampModel(src, { viewportW: 1463 });
  src.docs.open = false;
  src.docs.listW = 1;
  assert.equal(out.model.docs.open, true, '改入参不得穿透到返回模型');
  assert.equal(out.model.docs.listW, 268);
});