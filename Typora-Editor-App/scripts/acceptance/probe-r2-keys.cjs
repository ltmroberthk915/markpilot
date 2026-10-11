/** 探针 · 第 2 轮辩论"通过"项 S1/S2/S3/S4 的实机验收（公式快捷键守卫）。
 *
 *  前提：渲染层真源（E:/MarkPilot/Typora-Editor/extension-src/render/js/）改完后，必须先在
 *  Typora-Editor-App 里 `npm run sync` 把真源复制进 app/renderer——本探针跑的是 app 副本。
 *  启动时对比两份文件（edit-shortcuts.js + math-edit.js）并在不一致时打警示；四处修法各带
 *  注释标记（【S1·R2】【S2·R2】【S3·R2】【S4·R2】），突变验证（注掉对应分支 → 对应用例必须
 *  变红）就注这些点（详见文件末尾"突变注掉点"清单）。
 *
 *  用例（每条打印「R2KEY <名> PASS/FAIL <JSON>」；红条件写在各用例注释里）：
 *    S1  锚在正文、焦在展开公式源码中段的选区按 Ctrl+B → 文档必须一字不变
 *        （红：旧代码只查 anchorNode，此形状漏过 → vendor bold 把源码拆坏、md 变化）；
 *    S2  `文字 $x+y$ 文字` 单段全选（Home→Shift+End）按 Ctrl+B → md 为 **文字 $x+y$ 文字**，
 *        公式仍在 strong 里渲染出 katex（红：旧代码单块一律委派 toolbar 的 vendor Nt，
 *        Range.toString 抓出"源码+预览"双份文本再 deleteContents，公式被毁）；
 *    S3  展开公式光标站闭 $ 上按 Ctrl+B 再按 Ctrl+K → 公式原样、md 无 ** / []() / ~~ 混入，
 *        且不得有**真弹开**（[open]）的浮层（红：旧代码围栏不在 MATH_SOURCE 里 → B 走 vendor
 *        毁公式；K 落 Vditor 自建链接绑定把 []() 混进围栏。浮层断言只认 [open] 并与基线比对：
 *        #md-completion-settings 是常驻关闭态 <dialog>，按"存在"判会永远误报，见 浮层 读数注释）；
 *    S4  公式源码内按 Ctrl+D 再按 Ctrl+K → 公式不变、焦点仍在源码
 *        （红：旧代码 FORMATTING 只有 b/i/u → D/K 落 Vditor 删除线/链接绑定，符号进 TeX）。
 *
 *  输入一律真实通道：CDP Input.dispatchKeyEvent（hi.press / hi.combo——修饰键逐个真实按下、
 *  主键 ↓↑、修饰键逆序抬起）与 dispatchMouseEvent（点击公式中心/段落正文）。每步整页 +
 *  光标附近 2x 局部截图，存 .perf/probe-r2-keys/。视觉验收（规则一/二）以 2x 图为准。
 *
 *  用法：node scripts/acceptance/probe-r2-keys.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r2-keys');
const IF = hi.IF, SURFACE = hi.SURFACE;
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
// 源-副本一致性哨兵盯两份真源（sync 之后才允许跑）。
const TRUE_SRCS = {
  'edit-shortcuts.js': 'E:/MarkPilot/Typora-Editor/extension-src/render/js/edit-shortcuts.js',
  'math-edit.js': 'E:/MarkPilot/Typora-Editor/extension-src/render/js/math-edit.js',
};
const FIX_TAGS = ['【S1·R2', '【S2·R2', '【S3·R2', '【S4·R2'];

const S1_BODY = ['# 快捷键守卫S1', '', '锚点正文甲乙丙丁 $x+y$ 收尾文字戊己庚。', ''].join('\n');
const S2_BODY = ['# 快捷键守卫S2', '', '文字 $x+y$ 文字', ''].join('\n');
const S3_BODY = ['# 快捷键守卫S3', '', '闭栏守卫测试 $p+q$ 收尾。', ''].join('\n');
const S4_BODY = ['# 快捷键守卫S4', '', '源码吞键测试 $m+n$ 收尾。', ''].join('\n');
// S1 段落里公式之前的前缀：Home 后走「前缀长-1」步 ArrowRight 停在正文最后一字（与正文自动同步）。
const S1_PREFIX = S1_BODY.split('\n')[2].split('$')[0];

// ─── 通用读数 ────────────────────────────────────────────────────────────────
/** 选区双端分层：锚层/焦层 + 围栏类（inline 的 $ 是 span.vditor-ir__marker、无 data-type，
 *  必须与块公式的 [data-type$="-marker"] 一起认，否则会被归成"正文"）。 */
const 光标 = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 无: true };
  const 层Of = n => { const at = n.nodeType === 3 ? n.parentElement : n;
    return at.closest?.('code[data-type]') ? '源码'
      : at.closest?.('.vditor-ir__marker,[data-type$="-marker"]') ? '围栏'
      : at.closest?.('.vditor-ir__preview,.vditor-wysiwyg__preview') ? '预览'
      : at.closest?.('p,li,h1,h2,h3,h4,h5,h6,blockquote') ? '正文' : '元素级'; };
  const 容器Of = n => n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' + JSON.stringify(n.data) : n.nodeName;
  return { 锚层: 层Of(sel.anchorNode), 焦层: 层Of(sel.focusNode),
    锚容器: 容器Of(sel.anchorNode), 焦容器: 容器Of(sel.focusNode), 焦偏移: sel.focusOffset,
    折叠: sel.isCollapsed, 选区: sel.toString().slice(0, 60), 选区长: sel.toString().length }; })()`;

/** 选区/光标几何（顶层页坐标）——2x 截图的裁剪中心。 */
const 框 = `(() => { const w = ${IF}; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = w.getSelection(); if (!s || !s.rangeCount) return null;
  const r = s.getRangeAt(0).getBoundingClientRect();
  return { x: frame.x + r.left, y: frame.y + r.top, w: r.width, h: r.height }; })()`;

/** 首个正文段（有文字的 P）的点击点：点在段落最左的正文上，避开段中靠后的公式。 */
const 首段点 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const p = [...s.children].find(n => n.nodeName === 'P' && n.textContent.trim());
  if (!p) return null; const r = p.getBoundingClientRect();
  return { x: Math.round(frame.x + r.left + Math.min(24, r.width / 4)), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 首个行内公式的中心（点它 = 展开并把光标放进源码，probe-r1 A1 同款路径）。 */
const 公式中心 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]'); if (!owner) return { ok: false };
  const b = owner.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + b.left + b.width / 2), y: Math.round(frame.y + b.top + b.height / 2) }; })()`;

/** 首个行内公式的态：数量 / 展开 / 源码文本。 */
const 公式态 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const owner = 全部[0]; if (!owner) return { ok: false, 公式数: 0 };
  return { ok: true, 公式数: 全部.length, 展开: owner.classList.contains('vditor-ir__node--expand'),
    源码: owner.querySelector('code[data-type]')?.textContent ?? null }; })()`;

/** S2 加粗后的结构：strong 是否包住公式、预览/ katex 是否在、md 侧由 getValue 断。 */
const S2_态 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
  return { 公式数: s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]').length,
    strong含公式: !!(owner && owner.closest('[data-type="strong"],strong')),
    源码: owner?.querySelector('code[data-type]')?.textContent ?? null,
    预览: owner?.querySelector('.language-math')?.textContent ?? null,
    katex: owner ? owner.querySelectorAll('.katex').length : 0 }; })()`;

/** S3 专用：真弹开的浮层——只认 [open] 的 dialog，返回 id/类名列表（与基线比对算"新开"）。
 *  【尺子修正 2026-10-02】旧读数 querySelector('.vditor-dialog,dialog') 按"存在"判：
 *  补全设置菜单 #md-completion-settings 是启动时就永久挂在 body 上的**关闭态** <dialog>
 *  （completion-menu.js document.body.append；completion.css :not([open]) display:none），
 *  于是永远读到 true——把休眠节点误报成"Ctrl+K 弹出链接对话框"。旁证：全仓（vendor
 *  bundle / app js / CSS）grep 不到 .vditor-dialog 类；vendor 只有唯一一条 keydown 监听
 *  （工具栏热键分发就在里面，已被守卫吞掉），零 keypress，keyup 只管 Enter/退格/删除。
 *  只认 [open] 后"存在≠弹出"不再误报。 */
const 浮层 = `(() => { const w = ${IF}, d = w.document;
  return { 开着: [...d.querySelectorAll('dialog[open],.vditor-dialog[open]')].map(n => n.id || n.className) }; })()`;

// ─── 基座 ────────────────────────────────────────────────────────────────────
const LOG = [];
const say = line => { console.log(line); LOG.push(line); };
const 判 = (名, 态, 据) => say(`R2KEY ${名} ${态} ${JSON.stringify(据)}`);

const ctx = {
  launch: options => harness.launch({ exe: EXE, appArgs: [path.join(harness.project, 'app/main/main.js')],
    label: 'probe-r2-keys', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
  release: async session => { await session.close(); },
};

/** 整页 + 光标附近 2x 局部各一张。box 为顶层页坐标的选区框（可空）。 */
async function 拍(session, stem, box) {
  await session.shot(stem + '-整页');
  if (!box) return;
  const frame = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const padY = 46, halfW = 300;
  const clip = {
    x: Math.max(0, box.x - halfW), y: Math.max(frame.y, box.y - padY),
    width: halfW * 2, height: Math.min(frame.h, (box.h || 20) + padY * 2), scale: 2,
  };
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, stem + '-2x.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { say('  （2x 截图失败：' + String(error.message).slice(0, 80) + '）'); }
}

const 开文档 = (名, body, minBlocks) => {
  const file = path.join(OUT, 名 + '.md');
  fs.writeFileSync(file, body, 'utf8');
  return hi.openDoc(ctx, file, { minBlocks, settleMs: 1500 }).then(session => ({ session, file }));
};

// ─── 用例 ────────────────────────────────────────────────────────────────────
/** S1：锚在正文、焦在展开公式源码中段的选区按 Ctrl+B → 文档一字不变。
 *  构造（全真实键鼠）：点段落正文 → Home（段首）→ ArrowRight×(前缀长-1)（停在正文最后一字
 *  "丁"之后——从 md 推导，再多按一步就踏上开 $ 围栏：实测锚容器 TEXT(1)"$"、锚层"围栏"，
 *  锚就不在正文了）→ Shift+ArrowRight×3（第 1 步选进前缀末的空格、焦点站到正文文本末，
 *  patchMathCaret 的 adjacentMath 在第 2 步把焦点送进公式源码并展开公式，第 3 步走到中段）。
 *  红条件（注掉 edit-shortcuts.js 守卫里的 focusNode / inMathZone 整支即复现）：
 *    旧代码只查 anchorNode（在正文）→ 守卫漏过 → bold 落到 toolbar 的 vendor Nt →
 *    md 变化（** 出现或源码被拆）或公式节点丢失。 */
async function 用例S1() {
  const { session } = await 开文档('s1-focus-in-source', S1_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const 点 = await session.js(首段点);
    await session.click(点.x, 点.y);                 // 点正文：光标落段落前部
    await hi.sleep(250);
    await hi.press(session, 'Home');                 // 段首（锚将落在这里）
    await hi.sleep(220);
    for (let i = 0; i < S1_PREFIX.length - 1; i++) { // 前缀长-1：停在正文最后一字之后；多一步就站上开 $ 围栏
      await hi.press(session, 'ArrowRight');
      await hi.sleep(90);
    }
    for (let i = 0; i < 3; i++) {                    // Shift+→ ×3：焦点进源码并走到中段
      await hi.combo(session, 'Shift+ArrowRight');
      await hi.sleep(160);
    }
    const 落点 = await session.js(光标);
    const 态前 = await session.js(公式态);
    if (落点.锚层 !== '正文' || 落点.焦层 !== '源码' || !态前.ok || !态前.展开) {
      判('S1', 'FAIL', { 原因: '前置失败：选区不是「锚在正文、焦在源码」或公式未展开', 落点, 态前 });
      await 拍(session, 'S1-前置失败', await session.js(框));
      return;
    }
    const md前 = await hi.mdNow(session);
    await 拍(session, 'S1-按键前', await session.js(框));
    await hi.combo(session, 'Ctrl+B');
    await hi.sleep(600);
    const md后 = await hi.mdNow(session);
    const 态后 = await session.js(公式态);
    await 拍(session, 'S1-按键后', await session.js(框));
    const 通过 = md后 === md前 && 态后.ok && 态后.公式数 === 1 && 态后.源码 === 'x+y'
      && !md后.includes('**') && !md后.includes('x+yx+y');
    判('S1', 通过 ? 'PASS' : 'FAIL', { 落点: { 锚层: 落点.锚层, 焦层: 落点.焦层, 焦容器: 落点.焦容器, 焦偏移: 落点.焦偏移, 选区: 落点.选区 },
      展开: 态前.展开, md不变: md后 === md前, md前: md前 && md前.slice(0, 100), md后: md后 && md后.slice(0, 100), 态后 });
  } finally { await ctx.release(session); }
}

/** S2：`文字 $x+y$ 文字` 单段全选（Home → Shift+End）按 Ctrl+B →
 *  md 为 **文字 $x+y$ 文字** 且公式仍在 strong 里渲染（katex 出现）。
 *  红条件（注掉 boldAcrossBlocks 里【S2·R2】那段 parts.length===1 分流即复现）：
 *    单块 return false → 委派 toolbar vendor Nt → Range.toString 双份文本 +
 *    deleteContents → md 不是 **文字 $x+y$ 文字**（文本翻倍/公式消失）。 */
async function 用例S2() {
  const { session, file } = await 开文档('s2-single-block-bold', S2_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const 点 = await session.js(首段点);
    await session.click(点.x, 点.y);
    await hi.sleep(250);
    await hi.press(session, 'Home');                 // 段首
    await hi.sleep(220);
    await hi.combo(session, 'Shift+End');            // 选到段尾：单块整段选区
    await hi.sleep(260);
    const 落点 = await session.js(光标);
    if (落点.折叠 || 落点.锚层 !== '正文' || 落点.焦层 !== '正文') {
      判('S2', 'FAIL', { 原因: '前置失败：没有形成整段选区', 落点 });
      await 拍(session, 'S2-前置失败', await session.js(框));
      return;
    }
    const md前 = await hi.mdNow(session);
    await 拍(session, 'S2-按键前', await session.js(框));
    await hi.combo(session, 'Ctrl+B');
    await hi.sleep(650);
    // 等重挂的公式渲染出 katex（boldAcrossBlocks 尾部调 __typoraScheduleMath）。
    await session.until(`(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
      const o = s && s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      return !!(o && o.querySelectorAll('.katex').length); })()`, { timeout: 9000, interval: 120 }).catch(() => {});
    const md后 = await hi.mdNow(session);
    const 态 = await session.js(S2_态);
    await 拍(session, 'S2-按键后', await session.js(框));
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    const mdOk = !!md后 && md后.includes('**文字 $x+y$ 文字**') && !md后.includes('x+yx+y');
    const 结构Ok = 态.公式数 === 1 && 态.strong含公式 && 态.源码 === 'x+y' && !!态.预览 && 态.katex >= 1;
    const 盘ok = disk.includes('**文字 $x+y$ 文字**') && !disk.includes('x+yx+y');
    const 通过 = mdOk && 结构Ok && 盘ok;
    判('S2', 通过 ? 'PASS' : 'FAIL', { 落点: { 选区长: 落点.选区长, 选区: 落点.选区 },
      md前: md前 && md前.slice(0, 80), md后: md后 && md后.slice(0, 100), mdOk, 态, 结构Ok, katex: 态.katex,
      磁盘: disk.slice(0, 120), 盘ok });
  } finally { await ctx.release(session); }
}

/** S3：展开公式，光标站闭 $ 上（End → ArrowRight，probe-r1 A1 同款路径），先 Ctrl+B 再
 *  Ctrl+K → 公式原样、md 无 ** / []() / ~~ 混入、光标仍在围栏上、无**真弹开**的浮层
 *  （[open] 口径 + 与按键前基线比对——常驻关闭态的 #md-completion-settings 不算，见
 *  浮层 读数上方的【尺子修正】注释）。
 *  红条件（注掉 inMathZone 的 FENCE_MARKER 分支即复现）：围栏不在 MATH_SOURCE →
 *  B 走 vendor bold 毁公式；K 落 Vditor 自建链接绑定把 []() 混进围栏。浮层断言是
 *  次级金丝雀：vendor 链接命令是插文本不开框（vendor bundle 无 dialog 字串），突变
 *  时它的红主要从 md/混入 那两道来；真弹开浮层（如未来版本换对话框式链接）才单独红。 */
async function 用例S3() {
  const { session } = await 开文档('s3-fence-marker-keys', S3_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const g = await session.js(公式中心);
    await session.click(g.x, g.y);                   // 点公式中心：展开 + 光标进源码
    await hi.sleep(380);
    await hi.press(session, 'End');                  // 源码末尾
    await hi.sleep(260);
    await hi.press(session, 'ArrowRight');           // → 一步：闭 $ 上（marker 文本）
    await hi.sleep(300);
    const 落点 = await session.js(光标);
    if (落点.焦层 !== '围栏') {
      判('S3', 'FAIL', { 原因: '前置失败：光标没有站到闭 $ 围栏上', 落点 });
      await 拍(session, 'S3-前置失败', await session.js(框));
      return;
    }
    const md前 = await hi.mdNow(session);
    const 浮前 = await session.js(浮层);               // 基线：按键前就 [open] 的浮层（如补全菜单开着）
    await 拍(session, 'S3-按键前', await session.js(框));
    await hi.combo(session, 'Ctrl+B');
    await hi.sleep(550);
    const md后B = await hi.mdNow(session);
    const 态B = await session.js(公式态);
    const 层B = await session.js(光标);
    await 拍(session, 'S3-加粗后', await session.js(框));
    await hi.combo(session, 'Ctrl+K');
    await hi.sleep(550);
    const 浮K = await session.js(浮层);
    const md后K = await hi.mdNow(session);
    const 态K = await session.js(公式态);
    const 层K = await session.js(光标);
    await 拍(session, 'S3-链接键后', await session.js(框));
    await hi.press(session, 'Escape');               // 防御：若真弹了浮层，收掉再走下用例
    const 新开 = (浮K.开着 || []).filter(id => !(浮前.开着 || []).includes(id));
    const 混入 = ['**', '[](', '~~'].filter(mark => md后K.includes(mark));
    const 通过 = md后B === md前 && md后K === md前 && 态K.ok && 态K.公式数 === 1 && 态K.源码 === 'p+q'
      && 混入.length === 0 && 新开.length === 0 && 层K.焦层 === '围栏';
    判('S3', 通过 ? 'PASS' : 'FAIL', { 落点: { 焦层: 落点.焦层, 焦容器: 落点.焦容器, 焦偏移: 落点.焦偏移 },
      B后: { md不变: md后B === md前, 源码: 态B.源码, 焦层: 层B.焦层 },
      K后: { md不变: md后K === md前, 源码: 态K.源码, 焦层: 层K.焦层, 新开浮层: 新开 },
      基线开: 浮前.开着, K后开: 浮K.开着,
      md前: md前 && md前.slice(0, 90), md后K: md后K && md后K.slice(0, 90), 混入 });
  } finally { await ctx.release(session); }
}

/** S4：公式源码内（点公式中心进源码）先 Ctrl+D 再 Ctrl+K → 公式不变、焦点仍在源码。
 *  红条件（把 math-edit.js FORMATTING 的 'd','k' 注掉、同时注掉 edit-shortcuts 的
 *  FORMAT_KEYS 里 'd','k' 才单独复现——两道防线互为兜底，与 b/i/u 现状同构；
 *  两处都注掉时：D 落 Vditor 删除线 ~~、K 落链接 []()，符号进 TeX 源码）。 */
async function 用例S4() {
  const { session } = await 开文档('s4-source-d-k', S4_BODY, 2);
  try {
    await hi.ensureFocus(session);
    const g = await session.js(公式中心);
    await session.click(g.x, g.y);                   // 点公式中心：光标进源码
    await hi.sleep(380);
    const 落点 = await session.js(光标);
    if (落点.焦层 !== '源码') {
      判('S4', 'FAIL', { 原因: '前置失败：光标没有落进公式源码', 落点 });
      await 拍(session, 'S4-前置失败', await session.js(框));
      return;
    }
    const md前 = await hi.mdNow(session);
    await 拍(session, 'S4-按键前', await session.js(框));
    await hi.combo(session, 'Ctrl+D');
    await hi.sleep(550);
    const md后D = await hi.mdNow(session);
    const 态D = await session.js(公式态);
    const 层D = await session.js(光标);
    await 拍(session, 'S4-删除线键后', await session.js(框));
    await hi.combo(session, 'Ctrl+K');
    await hi.sleep(550);
    const md后K = await hi.mdNow(session);
    const 态K = await session.js(公式态);
    const 层K = await session.js(光标);
    await 拍(session, 'S4-链接键后', await session.js(框));
    const 混入 = ['~~', '[](', '**'].filter(mark => md后K.includes(mark));
    const 通过 = md后D === md前 && md后K === md前 && 态K.ok && 态K.公式数 === 1 && 态K.源码 === 'm+n'
      && 混入.length === 0 && 层D.焦层 === '源码' && 层K.焦层 === '源码';
    判('S4', 通过 ? 'PASS' : 'FAIL', { 落点: { 焦层: 落点.焦层, 焦容器: 落点.焦容器, 焦偏移: 落点.焦偏移 },
      D后: { md不变: md后D === md前, 源码: 态D.源码, 焦层: 层D.焦层 },
      K后: { md不变: md后K === md前, 源码: 态K.源码, 焦层: 层K.焦层 },
      md前: md前 && md前.slice(0, 90), md后K: md后K && md后K.slice(0, 90), 混入 });
  } finally { await ctx.release(session); }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });

  // 源-副本一致性哨兵：本探针跑 app 副本，真源改完必须先 npm run sync。
  try {
    for (const [名, 真源路径] of Object.entries(TRUE_SRCS)) {
      const 真源 = fs.existsSync(真源路径) ? fs.readFileSync(真源路径) : null;
      const 副本 = fs.existsSync(path.join(harness.project, 'app/renderer/js/' + 名))
        ? fs.readFileSync(path.join(harness.project, 'app/renderer/js/' + 名)) : null;
      const 一致 = !!真源 && !!副本 && 真源.equals(副本);
      const 标记 = Object.fromEntries(FIX_TAGS.map(tag => [tag.slice(1), !!(副本 && 副本.toString('utf8').includes(tag))]));
      say(名 + ' 源-副本一致=' + 一致 + '  修法标记=' + JSON.stringify(标记));
      if (!一致) say('  ⚠ app/renderer/js/' + 名 + ' 与真源不一致——先在 Typora-Editor-App 跑 npm run sync，否则下面测的是旧代码！');
    }
    for (const [名, 用例] of [['S1', 用例S1], ['S2', 用例S2], ['S3', 用例S3], ['S4', 用例S4]]) {
      say(`\n══ ${名} ══`);
      try { await 用例(); }
      catch (error) { say(`  ${名} 用例异常：` + String(error && error.message || error).slice(0, 300)); 判(名, 'FAIL', { 异常: String(error && error.message || error).slice(0, 200) }); }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), LOG.join('\n'), 'utf8');
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });

/* ── 突变注掉点（验证探针红敏度时逐个注、跑完记得还原）────────────────────────
 * S1：edit-shortcuts.js 守卫条件里去掉 `|| inMathZone(selection.focusNode)`
 *     （即回到只查 anchor）→ S1 必红（md 变化/公式被拆）；S2/S3/S4 不受影响。
 * S2：boldAcrossBlocks 里注掉【S2·R2】整段（`if(parts.length===1){…}` 与其后的
 *     `if(!parts.length)` 恢复成 `if(parts.length<2)return false;`）→ S2 必红
 *     （单块回到 toolbar vendor：双份文本/公式消失）；S1/S3/S4 不受影响。
 * S3：inMathZone 里注掉 FENCE_MARKER 两行（marker 分支）→ S3 必红（B 毁公式、
 *     K 混 []()——红在 md/混入 两道；浮层金丝雀不会单独红：vendor 链接命令插文本
 *     不开框）。S1/S2 不受影响（它们的端点在源码/正文，不在围栏）。
 *     ⚠ 尺子注意：S3 的浮层断言只认 [open] 并与基线比对。若改回按"存在"判
 *     （querySelector('.vditor-dialog,dialog')），常驻关闭态的 #md-completion-settings
 *     会让它**假红**（2026-10-02 实测就是这么红的），那不是产品缺陷。
 * S4：math-edit.js FORMATTING 去掉 'd','k' → 单注这一处 S4 **仍绿**——edit-shortcuts
 *     的 FORMAT_KEYS（S3 修法）在 window 捕获层先吞了，root 层接不到。要单独验
 *     S4 这道冗余防线，需同时注掉 edit-shortcuts.js FORMAT_KEYS 里的 'Ctrl+D',
 *     'Ctrl+K','Meta+D','Meta+K' 四项（此时 S3 的 Ctrl+K 分量也会红，S4 的 Ctrl+D
 *     分量红在 root 层缺 'd'）。两道防线与既有 b/i/u 双保险同构。
 * ────────────────────────────────────────────────────────────────────────── */
