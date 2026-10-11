/** R6 第 6 轮格式化域 · 判决 ③F5变 + ⑥F17 的验收探针（加粗跨 html-inline 岛 / 无选区裹词）。
 *  （harness dev：electron.exe + app/main/main.js；操作链学 probe-r2-keys.cjs）
 *
 *  ③F5变「块内跨 <u> 岛加粗产嵌套坏标记」——修法（edit-shortcuts.js boldAcrossBlocks，
 *  标记【R6·F5】）：
 *      part 含 html-inline 岛时按岛边界切分作用域：岛标记（<u>/</u>）原样保留，
 *      岛内文本与岛外文本各自成段各自包裹 → `<u>**岛**</u>**外**`（Lute 实测双
 *      strong、round-trip 保真）；单块含岛不再回落 vendor（vendor 的 deleteContents
 *      会拆散岛标记再塞 **）。纯文本单块（含标题/li 单块）照旧回落 vendor，原生手感不动。
 *  断言口径（判词原文）：getValue 无跨岛 `**`（** 配对区间内不得吞任何 html 标签）、
 *      渲染 strong 存在（目标块 strong 计数）、round-trip 保真（setValue 同文 →
 *      getValue 逐字相等 + strong/岛计数不丢）+ 磁盘存盘复跑同口径。
 *
 *  ⑥F17「无选区 Ctrl+Shift+K 不裹词」——修法（edit-shortcuts.js，标记【R6·F17】）：
 *      仿 bold 的 collapsed 分支（:186-194 那套 whole/前缀/后缀 + inlineMarkdown +
 *      execCommand('insertText')）先取词：连续 ASCII 英文数字为一词；CJK 按字/词界
 *      只取紧邻一字（先左后右）；空格/标点/边界取不到词则保持 vendor 原行为。
 *      光标本就在行内代码里 → 整块取消（与 bold collapsed 在 strong 里整块取消同构）。
 *  断言口径：词被反引号包裹，取词口径与 bold 一致——探针用独立复算的 wordAtSpec
 *      （判词口径逐字实现）给出期望词，不接受产品自报。
 *
 *  用例：
 *    F5岛尾主案   `<u>这一句</u>。` 光标置于"这"（岛内首字）→ 程序置选区到块尾
 *                 （SELECT_TO_END，两端落文本节点——标题/岛段上原生 Shift+End 会把
 *                 选区塌进标记层，见 SELECT_TO_END 注释）→ Ctrl+B →
 *                 期望 `<u>**这一句**</u>**。**`；岛标记成对、无跨岛 **、
 *                 strong×2、round-trip、存盘链推送、磁盘。
 *    F5跨块岛     标题 `# 标 <u>岛一</u>尾一` + 列表 `- 项 <u>岛二</u>尾二`，
 *                 锚=岛一岛内首字、Shift+点 尾二末字右缘（键鼠配合通道）→ Ctrl+B →
 *                 两块各自岛界切分加粗、标题 #/列表 - 保留、无跨岛 **、strong 在两块。
 *    F5标题vendor 对照组：`# 纯标题词加粗试` 单块纯文本选区（程序置选区）→ 仍回落 vendor
 *                 （形态锁定）：`# **纯标题词加粗试**`、strong 在 h1、round-trip、磁盘。
 *    F5列表vendor 对照组：`- 列表词加粗试` 同上 → `- **列表词加粗试**`。
 *    F17英文词首/词中/词尾  `alpha123 beta456 gamma789` 三位置各按一次
 *                 Ctrl+Shift+K → 各词被反引号包裹、他词不动（取词=wordAtSpec 期望）。
 *    F17中文词首/词中/词尾  `中文词这里试完`（三份独立文档，互不污染前缀）→
 *                 词首裹"中"、词中裹"词"（先左）、词尾裹"完"。
 *    F17公式邻域  `公式 $a+b$ 邻词 beta99 收尾` 光标在 beta99 词中 → 裹 beta99；
 *                 公式源码/计数不变、反引号不渗入公式（无 \`$ / $\`）。
 *    F17代码取消  `代码词 omega77 收尾` 词中按一次 → \`omega77\`；再按一次（光标
 *                 仍在词内）→ 取消行内代码、md 无反引号。
 *
 *  探针纪律：素材全部探针自建于 .perf/probe-r6-bold/（不碰受保护素材）；输入全真实通道
 *  （CDP Input：hi.combo 组合键逐修饰键真实按下、Shift+点击走 dispatchMouseEvent+shift）；
 *  每次按键前断言焦点真在编辑面（hi.ensureFocus + hi.caret 折叠/层读数）；每用例
 *  「R6BD <名> PASS/FAIL — <JSON>」+ 按键前/后各一张截图（整页 + 2x 局部）。
 *  用法：node scripts/acceptance/probe-r6-bold.cjs [--only=f5main,f5x,f5h,f5l,e1,e2,e3,c1,c2,c3,fm,tg]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r6-bold');
const IF = hi.IF, SURFACE = hi.SURFACE;
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const TRUE_SRC = 'E:/MarkPilot/Typora-Editor/extension-src/render/js/edit-shortcuts.js';
const MOD = hi.MOD;

// 源-副本一致性哨兵（sync 之后才允许跑；r2-keys 同款）。
(function checkSync() {
  const copy = path.join(harness.project, 'app/renderer/js/edit-shortcuts.js');
  try {
    if (fs.readFileSync(TRUE_SRC, 'utf8') !== fs.readFileSync(copy, 'utf8'))
      console.log('⚠ 源(edit-shortcuts.js)与 app 副本不一致：先 cd Typora-Editor-App && npm run sync');
  } catch (error) { console.log('⚠ 一致性哨兵读文件失败：' + error.message); }
})();

// ─── 页面读数/定位模板（参数名限定 validate-probe-expr.cjs 的 SCOPE 白名单） ────
/** 把光标放到「含 prefix 的文本节点」内 prefix+offset 处（前置设置；动作仍真实输入）。 */
const CARET_AT = (prefix, offset) => `(() => { const w = ${IF}, d = w.document;
  const s = d.querySelector('${SURFACE}'); if (!s) return { ok: false, 原因: '无编辑面' };
  for (const block of s.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      if (node.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker')) continue;
      const at = node.data.indexOf(${JSON.stringify(prefix)});
      if (at < 0) continue;
      const i = Math.min(at + ${Number(offset)}, node.data.length);
      s.focus();
      const r = d.createRange(); r.setStart(node, i); r.collapse(true);
      const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return { ok: true, 文本: node.data.slice(0, 24), 位置: i };
    }
  }
  return { ok: false, 原因: '未找到前缀' }; })()`;

/** 选「prefix+offset 处 → 所在块尾」：两端都落在**文本节点**上（hi.selectFromTo 的同款口径）。
 *  setup 为什么不用 Shift+End（2026-10-02 实测取证，tmp-r6dbg）：标题（# 标记）与
 *  html-inline 岛段上，程序摆好的文本位光标纹丝不动（+400ms 稳定），一按 Shift+End
 *  原生却把它整成「标记文本节点末尾的折叠选区」（锚层=标记、长=0、矩形 0×0/行首），
 *  选区根本立不起来；纯文本段（如列表行）Shift+End 又是好的。被测手势（Ctrl+B）
 *  仍走真实按键通道，setup 属前置设置，改程序置选区、目标只取文本节点。 */
const SELECT_TO_END = (prefix, offset) => `(() => { const w = ${IF}, d = w.document;
  const s = d.querySelector('${SURFACE}'); if (!s) return { ok: false, 原因: '无编辑面' };
  for (const block of s.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node, anchor = null, last = null;
    while (node = walker.nextNode()) {
      if (node.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker')) continue;
      if (!node.data.length) continue;
      const at = node.data.indexOf(${JSON.stringify(prefix)});
      if (at >= 0 && !anchor) anchor = { node, i: Math.min(at + ${Number(offset)}, node.data.length) };
      last = node;
    }
    if (!anchor || !last) continue;
    s.focus();
    const sel = w.getSelection();
    sel.setBaseAndExtent(anchor.node, anchor.i, last, last.data.length);
    return { ok: true, 选区: sel.toString(), 块: block.tagName };
  }
  return { ok: false, 原因: '未找到前缀' }; })()`;

/** mark+offset 处那个字的盒子（顶层页坐标）——Shift+点击目标与 2x 截图中心。 */
const CHAR_BOX = (mark, offset) => `(() => { const w = ${IF}, d = w.document;
  const fr = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${SURFACE}'); if (!s) return null;
  for (const block of s.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      if (node.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker')) continue;
      const at = node.data.indexOf(${JSON.stringify(mark)});
      if (at < 0) continue;
      const i = Math.min(at + ${Number(offset)}, node.data.length - 1);
      const r = d.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect(); if (!rect.width) continue;
      return { x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2),
        right: Math.round(fr.x + rect.right), bottom: Math.round(fr.y + rect.bottom) };
    }
  }
  return null; })()`;

/** 选区形状 + 几何框（顶层页坐标）。 */
const SELECTION = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { ok: false };
  const r = sel.getRangeAt(0); const box = r.getBoundingClientRect();
  const fr = document.getElementById('editor').getBoundingClientRect();
  const 层 = n => { const el = n && n.nodeType === 3 ? n.parentElement : n;
    return el ? (el.closest('.vditor-ir__preview') ? '预览' : el.closest('.vditor-ir__marker') ? '标记' : '正文') : '无'; };
  return { ok: true, 折叠: sel.isCollapsed, 选区: sel.toString(), 长: sel.toString().length,
    锚层: 层(sel.anchorNode), 焦层: 层(sel.focusNode),
    框: { x: Math.round(fr.x + box.left), y: Math.round(fr.y + box.top), w: Math.round(box.width), h: Math.round(box.height) } }; })()`;

/** 含 mark 的块：标签、strong 计数、html-inline 岛计数、行内代码计数、纯文本。 */
const BLOCK_STATE = mark => `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  if (!s) return null;
  const blocks = [...s.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')];
  const block = blocks.find(b => b.textContent.includes(${JSON.stringify(mark)}));
  if (!block) return { ok: false, 原因: '未找到含标记的块' };
  return { ok: true, 块: block.tagName, 强: block.querySelectorAll('strong').length,
    岛: block.querySelectorAll('[data-type="html-inline"]').length,
    码: block.querySelectorAll('[data-type="code"]').length,
    文本: block.textContent.replace(/\\s+/g, ' ').slice(0, 50) }; })()`;

/** 公式（行内节点）计数与源码——公式邻域用例的独立读数。 */
const FORMULAS = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  if (!s) return null;
  const nodes = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const src = [];
  for (const n of nodes) { const c = n.querySelector('code[data-type]'); if (c) src.push(c.textContent); }
  return { 数: nodes.length, 源码: src }; })()`;

/** round-trip：setValue 同文重渲染（clearStack=true，undo 不在本探针范围）。 */
const ROUNDTRIP = doc => `(() => { const w = ${IF}; const api = w && w.vditor;
  if (!api || !api.setValue) return { ok: false, 原因: '无编辑器' };
  api.setValue(${JSON.stringify(doc)}, true);
  return { ok: true }; })()`;

// ── 存盘链证人：Vditor 的 options.input（→ 主进程 change → cur.text → 磁盘）有 200ms
//    去抖；而 round-trip 的 setValue 以 enableInput:false 重挂 processAfterRender，会把
//    还在去抖里的那次推送**吞掉**（实测 F5标题/列表vendor：md 与 roundtrip 全对、磁盘行
//    却没有 **）。存盘类断言前先等「期望内容真的推送过」，不再按固定毫秒猜。
const WATCH_PUSH = `(() => { const w = ${IF}; const inst = w.vditor && w.vditor.vditor;
  if (!inst || !inst.options || typeof inst.options.input !== 'function') return { ok: false };
  if (!w.__bdPush) { w.__bdPush = [];
    const orig = inst.options.input;
    inst.options.input = function (c) { try { w.__bdPush.push(String(c).slice(0, 8000)); } catch {}
      return orig.apply(this, arguments); }; }
  return { ok: true }; })()`;
async function waitPushed(session, want) {
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const log = await session.js(`(() => { const w = ${IF}; return w.__bdPush || []; })()`);
    if (Array.isArray(log) && log.some(x => want(x))) return true;
    await hi.sleep(120);
  }
  return false;
}

// ─── Node 侧独立口径（不吃产品自报） ──────────────────────────────────────────
/** ** 配对扫描（栈式交替配对）：任一配对区间内吞了 html 标签即"跨岛"；残星=配不上的 **。 */
function boldAudit(md) {
  const stars = [];
  for (let i = 0; i < md.length - 1; i++) if (md[i] === '*' && md[i + 1] === '*') { stars.push(i); i++; }
  const stack = []; const crossing = [];
  for (const p of stars) {
    if (stack.length) { const open = stack.pop(); const seg = md.slice(open, p + 2);
      if (/<\/?[a-zA-Z][^>]*>/.test(seg)) crossing.push(seg.slice(0, 40)); }
    else stack.push(p);
  }
  const uOpen = (String(md).match(/<u>/g) || []).length, uClose = (String(md).match(/<\/u>/g) || []).length;
  return { 跨岛: crossing.length, 残星: stack.length, 岛成对: uOpen === uClose, crossing };
}
/** 判词取词口径的独立复算：连续 ASCII 英文数字一词；CJK 按字/词界取紧邻一字（先左后右）。 */
function wordAtSpec(line, i) {
  const word = c => /[A-Za-z0-9]/.test(c);
  const cjk = c => /[\u3041-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
  let a = i; while (a > 0 && word(line[a - 1])) a--;
  let b = i; while (b < line.length && word(line[b])) b++;
  if (b > a) return [a, b];
  if (i > 0 && cjk(line[i - 1])) return [i - 1, i];
  if (i < line.length && cjk(line[i])) return [i, i + 1];
  return null;
}
/** line 中 prefix+offset 处按口径取词后的期望片段（\`词\`）。 */
function expectedWrap(line, prefix, offset) {
  const at = line.indexOf(prefix);
  if (at < 0) return null;
  const span = wordAtSpec(line, at + offset);
  if (!span) return null;
  return '`' + line.slice(span[0], span[1]) + '`';
}

// ─── 基座 ────────────────────────────────────────────────────────────────────
const results = [];
const verdict = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`R6BD ${name} ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(detail)}`);
  return !!pass;
};
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);

const ctx = {
  launch: options => harness.launch({ exe: EXE, appArgs: [path.join(harness.project, 'app/main/main.js')],
    label: 'probe-r6-bold', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
  release: async session => { await session.close(); },
};

/** 整页 + 2x 局部各一张（学 r2-keys 拍()）。box 为顶层页坐标（可空）。 */
async function 拍(session, stem, box) {
  await session.shot(stem + '-整页');
  if (!box) return;
  const frame = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const padY = 46, halfW = 300;
  const clip = { x: Math.max(0, box.x - halfW), y: Math.max(frame.y, box.y - padY),
    width: halfW * 2, height: Math.min(frame.h, (box.h || 20) + padY * 2), scale: 2 };
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, stem + '-2x.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { console.log('  （2x 截图失败：' + String(error.message).slice(0, 80) + '）'); }
}

const 开文档 = (名, body, minBlocks) => {
  const file = path.join(OUT, 名 + '.md');
  fs.writeFileSync(file, body, 'utf8');
  return hi.openDoc(ctx, file, { minBlocks, settleMs: 1500 }).then(session => ({ session, file }));
};

/** 等 md 满足 want（直到超时），返回 {ok, md}。 */
async function untilMd(session, want2, timeout) {
  const end = Date.now() + (timeout || 6000); let md = '';
  while (Date.now() < end) {
    md = (await hi.mdNow(session)) || '';
    if (want2(md)) return { ok: true, md };
    await hi.sleep(120);
  }
  return { ok: false, md };
}

/** round-trip：setValue 同文 → getValue 逐字相等 + 目标块 strong 计数仍在。 */
async function roundtrip(session, v1, mark, minStrong) {
  await session.js(ROUNDTRIP(v1));
  let md2 = '', st = null;
  for (let i = 0; i < 45; i++) {
    md2 = (await hi.mdNow(session)) || '';
    st = await session.js(BLOCK_STATE(mark));
    if (md2 === v1 && st && st.ok && st.强 >= minStrong) break;
    await hi.sleep(130);
  }
  return { ok: md2 === v1 && !!st && st.ok && st.强 >= minStrong, md2, st };
}

/** 存盘证人：真实 Ctrl+S → 磁盘变化 → 同口径复跑。 */
async function 存盘(session, file) {
  const saved = await hi.edge.saveAndWait(session, file, { timeout: 9000 });
  const disk = String(saved.after || '').replace(/\r/g, '');
  return disk;
}

/** F5 公共断言：无跨岛 **、岛成对、无空加粗 ****、期望片段齐全。 */
function f5Audit(md, expects) {
  const a = boldAudit(md);
  const 片段 = expects.map(e => ({ e, 在: md.includes(e) }));
  return { 无跨岛: a.跨岛 === 0, 岛成对: a.岛成对, 无残星: a.残星 === 0, 无空粗: !md.includes('****'),
    片段齐: 片段.every(x => x.在), 明细: a, 片段 };
}

/** 按键前防线：焦点 + 折叠光标落在预期文本上（读数可信的前提）。 */
async function 防线(session, prefix, offset) {
  const focus = await hi.ensureFocus(session);
  if (!focus || !focus.ok) return { ok: false, 原因: '焦点不在编辑面', focus };
  const place = await session.js(CARET_AT(prefix, offset));
  if (!place || !place.ok) return { ok: false, 原因: '光标放置失败', place };
  const caret = await hi.caret(session);
  if (!caret || !caret.ok || !caret.折叠) return { ok: false, 原因: '光标未折叠或不在编辑面', caret };
  return { ok: true, place, caret };
}

// ─── 用例：F5 岛尾主案 ────────────────────────────────────────────────────────
async function 用例f5main() {
  const body = ['# R6 加粗岛主案', '', '<u>这一句</u>。', ''].join('\n');
  const { session, file } = await 开文档('r6bd-f5-main', body, 2);
  try {
    const guard = await 防线(session, '这一句', 0);
    if (!guard.ok) return verdict('F5岛尾主案', false, { 原因: guard.原因, guard });
    const placed = await session.js(SELECT_TO_END('这一句', 0));        // setup：程序置选区（文本节点两端）
    await hi.sleep(300);
    const sel = await session.js(SELECTION);
    const 形 = !!(sel && sel.ok && !sel.折叠 && sel.选区.startsWith('这') && sel.选区.includes('这一句') && /。$/.test(sel.选区));
    if (!形) return verdict('F5岛尾主案', false, { 原因: '前置失败：选区不是「岛内首字→块尾」', placed, sel });
    await 拍(session, 'f5main-按键前', sel.框);
    await session.js(WATCH_PUSH);                                          // 按键前装好存盘链证人（晚了会漏掉显式推送）
    await hi.combo(session, 'Ctrl+B');
    const got = await untilMd(session, md => md.includes('<u>**这一句**</u>') && md.includes('**。**'));
    const 推送齐 = await waitPushed(session, md => md.includes('<u>**这一句**</u>'));   // 存盘链先落，再 round-trip
    const sel2 = await session.js(SELECTION);
    await 拍(session, 'f5main-按键后', sel2 && sel2.ok ? sel2.框 : null);
    const audit = f5Audit(got.md, ['<u>**这一句**</u>', '**。**']);
    const st = await session.js(BLOCK_STATE('这一句'));
    const 结构 = !!(st && st.ok && st.强 >= 2 && st.岛 === 2);
    const rt = await roundtrip(session, got.md, '这一句', 2);
    const disk = await 存盘(session, file);
    const diskAudit = f5Audit(disk, ['<u>**这一句**</u>', '**。**']);
    const pass = got.ok && 推送齐 && audit.无跨岛 && audit.岛成对 && audit.无残星 && audit.无空粗 && audit.片段齐 && 结构 && rt.ok && diskAudit.片段齐 && diskAudit.无跨岛 && diskAudit.岛成对;
    verdict('F5岛尾主案', pass, { md: got.md && got.md.split('\n')[2], 期望片段齐: audit.片段齐,
      无跨岛: audit.无跨岛, 岛成对: audit.岛成对, 空粗: !audit.无空粗, 块: st, roundtrip: rt.ok,
      rtMd: rt.md2 && rt.md2.split('\n')[2], 存盘链推送: 推送齐, 磁盘行: disk.split('\n')[2], 磁盘ok: diskAudit.片段齐 && diskAudit.无跨岛 });
  } finally { await ctx.release(session); }
}

// ─── 用例：F5 跨标题/列表 岛加粗（对照组·双块含岛，键鼠配合选区） ────────────────
async function 用例f5x() {
  const body = ['# R6 跨块岛', '', '# 标 <u>岛一</u>尾一', '', '- 项 <u>岛二</u>尾二', ''].join('\n');
  const { session, file } = await 开文档('r6bd-f5-xblock', body, 3);
  try {
    const focus = await hi.ensureFocus(session);
    if (!focus || !focus.ok) return verdict('F5跨块岛', false, { 原因: '焦点不在编辑面', focus });
    const place = await session.js(CARET_AT('岛一', 0));
    if (!place || !place.ok) return verdict('F5跨块岛', false, { 原因: '锚点放置失败', place });
    const box = await session.js(CHAR_BOX('尾二', 1));
    if (!box) return verdict('F5跨块岛', false, { 原因: '未取到尾二字盒' });
    await session.click(box.right + 8, box.y, { modifiers: MOD.shift });   // 键鼠配合：Shift+点
    await hi.sleep(320);
    const sel = await session.js(SELECTION);
    const 形 = !!(sel && sel.ok && !sel.折叠 && sel.选区.includes('岛一') && sel.选区.includes('尾二'));
    if (!形) return verdict('F5跨块岛', false, { 原因: '前置失败：跨块选区未形成', sel });
    await 拍(session, 'f5x-按键前', sel.框);
    await session.js(WATCH_PUSH);                                          // 按键前装好存盘链证人（晚了会漏掉显式推送）
    await hi.combo(session, 'Ctrl+B');
    const expects = ['<u>**岛一**</u>', '**尾一**', '<u>**岛二**</u>', '**尾二**'];
    const got = await untilMd(session, md => expects.every(e => md.includes(e)));
    const 推送齐 = await waitPushed(session, md => md.includes('<u>**岛二**</u>'));   // 存盘链先落，再 round-trip
    const sel2 = await session.js(SELECTION);
    await 拍(session, 'f5x-按键后', sel2 && sel2.ok ? sel2.框 : null);
    const audit = f5Audit(got.md, expects);
    const stH = await session.js(BLOCK_STATE('岛一'));
    const stL = await session.js(BLOCK_STATE('岛二'));
    const 结构 = !!(stH && stH.ok && stH.块 === 'H1' && stH.强 >= 1 && stL && stL.ok && stL.块 === 'LI' && stL.强 >= 1);
    const rt = await roundtrip(session, got.md, '岛二', 1);
    const disk = await 存盘(session, file);
    const diskAudit = f5Audit(disk, expects);
    const pass = got.ok && 推送齐 && audit.无跨岛 && audit.岛成对 && audit.无残星 && audit.无空粗 && audit.片段齐 && 结构 && rt.ok && diskAudit.片段齐 && diskAudit.无跨岛;
    verdict('F5跨块岛', pass, { md: got.md && got.md.replace(/\n+/g, ' | ').slice(0, 140), 期望片段齐: audit.片段齐,
      无跨岛: audit.无跨岛, 岛成对: audit.岛成对, 标题块: stH, 列表块: stL, roundtrip: rt.ok, 存盘链推送: 推送齐, 磁盘ok: diskAudit.片段齐 && diskAudit.无跨岛 });
  } finally { await ctx.release(session); }
}

// ─── 用例：F5 标题/列表 单块纯文本回落 vendor（对照组·形态锁定） ────────────────
async function 用例vendor(key, name, fileStem, body, lineMark, expectLine) {
  const { session, file } = await 开文档(fileStem, body, 2);
  try {
    const focus = await hi.ensureFocus(session);
    if (!focus || !focus.ok) return verdict(name, false, { 原因: '焦点不在编辑面', focus });
    const place = await session.js(CARET_AT(lineMark, 0));
    if (!place || !place.ok) return verdict(name, false, { 原因: '光标放置失败', place });
    const placed = await session.js(SELECT_TO_END(lineMark, 0));        // setup：程序置选区（文本节点两端）
    await hi.sleep(300);
    const sel = await session.js(SELECTION);
    if (!sel || !sel.ok || sel.折叠 || !sel.选区.includes(lineMark))
      return verdict(name, false, { 原因: '前置失败：单块选区未形成', placed, sel });
    await 拍(session, fileStem + '-按键前', sel.框);
    await session.js(WATCH_PUSH);                                          // 按键前装好存盘链证人（晚了会漏掉显式推送）
    await hi.combo(session, 'Ctrl+B');
    const got = await untilMd(session, md => md.includes(expectLine));
    const 推送齐 = await waitPushed(session, md => md.includes(expectLine));   // 存盘链先落，再 round-trip
    const sel2 = await session.js(SELECTION);
    await 拍(session, fileStem + '-按键后', sel2 && sel2.ok ? sel2.框 : null);
    const audit = f5Audit(got.md, [expectLine]);
    const st = await session.js(BLOCK_STATE(lineMark.replace(/\*/g, '')));
    const 结构 = !!(st && st.ok && st.强 >= 1 && st.岛 === 0);
    const rt = await roundtrip(session, got.md, lineMark.replace(/\*/g, ''), 1);
    const disk = await 存盘(session, file);
    const pass = got.ok && 推送齐 && audit.无跨岛 && audit.无残星 && audit.无空粗 && audit.片段齐 && 结构 && rt.ok && disk.includes(expectLine);
    verdict(name, pass, { md: got.md && got.md.split('\n')[2], 期望: expectLine, 块: st, roundtrip: rt.ok, 存盘链推送: 推送齐, 磁盘行: disk.split('\n')[2] });
  } finally { await ctx.release(session); }
}

// ─── 用例：F17 英文三位置（一文档三按，互不污染） ─────────────────────────────
async function 用例f17eng() {
  const line = 'alpha123 beta456 gamma789';
  const body = ['# R6 F17 英文取词', '', line, ''].join('\n');
  const positions = [
    { key: 'e1', name: 'F17英文词首', prefix: 'alpha123', offset: 0, untouch: ['`beta456`', '`gamma789`'] },
    { key: 'e2', name: 'F17英文词中', prefix: 'beta456', offset: 2, untouch: ['`gamma789`'] },
    { key: 'e3', name: 'F17英文词尾', prefix: 'gamma789', offset: 7, untouch: [] },
  ];
  const { session, file } = await 开文档('r6bd-f17-eng', body, 2);
  try {
    for (const p of positions) {
      const guard = await 防线(session, p.prefix, p.offset);
      if (!guard.ok) { verdict(p.name, false, { 原因: guard.原因, guard }); continue; }
      const expect = expectedWrap(line, p.prefix, p.offset);
      if (!expect) { verdict(p.name, false, { 原因: '取词口径复算失败', p }); continue; }
      const box = await session.js(CHAR_BOX(p.prefix, p.offset));
      await 拍(session, 'f17-' + p.key + '-按键前', box);
      if (p.key === 'e2') await session.js(WATCH_PUSH);                   // e2 存盘证人：按键前装好推送证人
      await hi.combo(session, 'Ctrl+Shift+K');
      const got = await untilMd(session, md => md.includes(expect) && p.untouch.every(u => !md.includes(u)));
      const caret = await hi.caret(session);
      await 拍(session, 'f17-' + p.key + '-按键后', await session.js(CHAR_BOX(p.prefix, 0)));
      const 未动 = p.untouch.every(u => !got.md.includes(u));
      const pass = got.ok && !!expect && 未动 && caret && caret.ok;
      verdict(p.name, pass, { 期望词: expect, md行: got.md.split('\n')[2], 词在: got.md.includes(expect),
        他词未动: 未动, 口径: 'wordAtSpec(连续英文数字一词)', 光标层: caret && caret.层 });
      if (p.key === 'e2') {   // 存盘证人：同样等存盘链推送落了再 Ctrl+S（200ms 去抖，见 WATCH_PUSH 注释）
        const pushed = await waitPushed(session, md => md.includes('`beta456`'));
        const disk = await 存盘(session, file);
        if (!disk.includes('`beta456`')) console.log(`  （e2 磁盘证人：反引号未上盘；推送齐=${pushed}）`);
      }
    }
  } finally { await ctx.release(session); }
}

// ─── 用例：F17 中文三位置（三份独立文档，前缀互不污染） ────────────────────────
async function 用例f17cjk() {
  const line = '中文词这里试完';
  const body = ['# R6 F17 中文取词', '', line, ''].join('\n');
  const positions = [
    { key: 'c1', name: 'F17中文词首', offset: 0, expect: '`中`' },
    { key: 'c2', name: 'F17中文词中', offset: 3, expect: '`词`' },
    { key: 'c3', name: 'F17中文词尾', offset: 7, expect: '`完`' },
  ];
  for (const p of positions) {
    const { session } = await 开文档('r6bd-f17-cjk-' + p.key, body, 2);
    try {
      const guard = await 防线(session, line, p.offset);
      if (!guard.ok) { verdict(p.name, false, { 原因: guard.原因, guard }); continue; }
      const expect = expectedWrap(line, line, p.offset);
      if (!expect || expect !== p.expect) { verdict(p.name, false, { 原因: '取词口径复算与期望不符', 复算: expect, 期望: p.expect }); continue; }
      const box = await session.js(CHAR_BOX(line, p.offset));
      await 拍(session, 'f17-' + p.key + '-按键前', box);
      await hi.combo(session, 'Ctrl+Shift+K');
      const got = await untilMd(session, md => md.includes(expect));
      const caret = await hi.caret(session);
      await 拍(session, 'f17-' + p.key + '-按键后', box);
      // round-trip 的块标记用"这里试"（只在正文段；标题"中文取词"不含它，避免找错块）
      const rt = got.ok ? await roundtrip(session, got.md, '这里试', 0) : { ok: false };
      verdict(p.name, got.ok && expect === p.expect && caret && caret.ok && !!rt.ok,
        { 期望词: p.expect, md行: got.md.split('\n')[2], 词在: got.md.includes(p.expect),
          口径: 'wordAtSpec(CJK 按字/词界·先左后右)', roundtrip: rt.ok, 光标层: caret && caret.层 });
    } finally { await ctx.release(session); }
  }
}

// ─── 用例：F17 公式邻域 ───────────────────────────────────────────────────────
async function 用例f17formula() {
  const line = '公式 $a+b$ 邻词 beta99 收尾';
  const body = ['# R6 F17 公式邻域', '', line, ''].join('\n');
  const { session } = await 开文档('r6bd-f17-formula', body, 2);
  try {
    const guard = await 防线(session, 'beta99', 2);
    if (!guard.ok) return verdict('F17公式邻域', false, { 原因: guard.原因, guard });
    const expect = expectedWrap(line, 'beta99', 2);
    const 公式前 = await session.js(FORMULAS);
    const box = await session.js(CHAR_BOX('beta99', 2));
    await 拍(session, 'f17-fm-按键前', box);
    await hi.combo(session, 'Ctrl+Shift+K');
    const got = await untilMd(session, md => md.includes('`beta99`'));
    const 公式后 = await session.js(FORMULAS);
    await 拍(session, 'f17-fm-按键后', await session.js(CHAR_BOX('beta99', 0)));
    const 公式在 = got.md.includes('$a+b$') && 公式后 && 公式后.数 >= 1 && 公式后.源码 && 公式后.源码.includes('a+b');
    const 不渗 = !got.md.includes('`$') && !got.md.includes('$`');
    const rt = got.ok ? await roundtrip(session, got.md, 'beta99', 0) : { ok: false };
    const rt公式 = await session.js(FORMULAS);
    const pass = got.ok && 公式在 && 不渗 && rt.ok && rt公式 && rt公式.数 >= 1;
    verdict('F17公式邻域', pass, { 期望词: expect, md行: got.md.split('\n')[2], 词在: got.md.includes('`beta99`'),
      公式前, 公式后, rt公式, 反引号不渗入公式: 不渗, roundtrip: rt.ok });
  } finally { await ctx.release(session); }
}

// ─── 用例：F17 行内代码内再按 = 取消 ──────────────────────────────────────────
async function 用例f17toggle() {
  const line = '代码词 omega77 收尾';
  const body = ['# R6 F17 代码取消', '', line, ''].join('\n');
  const { session } = await 开文档('r6bd-f17-toggle', body, 2);
  try {
    const guard = await 防线(session, 'omega77', 3);
    if (!guard.ok) return verdict('F17代码取消', false, { 原因: guard.原因, guard });
    const box = await session.js(CHAR_BOX('omega77', 3));
    await 拍(session, 'f17-tg-一次前', box);
    await hi.combo(session, 'Ctrl+Shift+K');
    const got1 = await untilMd(session, md => md.includes('`omega77`'));
    const st1 = await session.js(BLOCK_STATE('omega77'));
    await 拍(session, 'f17-tg-一次后', await session.js(CHAR_BOX('omega77', 0)));
    // 第二按：光标仍放回 omega77 词中（此时已在行内代码的文本节点里）
    const guard2 = await 防线(session, 'omega77', 3);
    if (!guard2.ok) return verdict('F17代码取消', false, { 原因: '第二次放置失败', 第一次: got1.ok, guard2 });
    await 拍(session, 'f17-tg-二次前', await session.js(CHAR_BOX('omega77', 3)));
    await hi.combo(session, 'Ctrl+Shift+K');
    const got2 = await untilMd(session, md => md.includes('omega77') && !md.includes('\u0060'));
    await 拍(session, 'f17-tg-二次后', await session.js(CHAR_BOX('omega77', 3)));
    const st2 = await session.js(BLOCK_STATE('omega77'));
    const rt = got2.ok ? await roundtrip(session, got2.md, 'omega77', 0) : { ok: false };
    const pass = got1.ok && st1 && st1.码 >= 1 && got2.ok && st2 && st2.码 === 0 && rt.ok;
    verdict('F17代码取消', pass, { 一次: got1.md.split('\n')[2], 一次码数: st1 && st1.码,
      二次: got2.md.split('\n')[2], 二次码数: st2 && st2.码, 无反引号: !got2.md.includes('\u0060'), roundtrip: rt.ok });
  } finally { await ctx.release(session); }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const safe = (name, fn) => fn().catch(error =>
    verdict(name, false, { 原因: '探针异常: ' + String(error && error.message).slice(0, 140) }));
  if (want('f5main')) await safe('F5岛尾主案', 用例f5main);
  if (want('f5x')) await safe('F5跨块岛', 用例f5x);
  if (want('f5h')) await safe('F5标题vendor', () => 用例vendor('f5h', 'F5标题vendor', 'r6bd-f5-vendor-h',
    ['# R6 标题单块', '', '# 纯标题词加粗试', ''].join('\n'), '纯标题词加粗试', '# **纯标题词加粗试**'));
  if (want('f5l')) await safe('F5列表vendor', () => 用例vendor('f5l', 'F5列表vendor', 'r6bd-f5-vendor-l',
    ['# R6 列表单块', '', '- 列表词加粗试', ''].join('\n'), '列表词加粗试', '- **列表词加粗试**'));
  if (want('e1') || want('e2') || want('e3')) await safe('F17英文', 用例f17eng);
  if (want('c1') || want('c2') || want('c3')) await safe('F17中文', 用例f17cjk);
  if (want('fm')) await safe('F17公式邻域', 用例f17formula);
  if (want('tg')) await safe('F17代码取消', 用例f17toggle);

  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? `\n★ R6BD 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}）`
    : `\nR6BD 汇总：全部 ${results.length} 项 PASS`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });

/** 突变验证（每条把修复改回旧形态，本探针对应用例必须变红；改后 npm run sync 再跑）：
 *  · F5 突变A（单块吞岛回落 vendor）：boldAcrossBlocks 单块闸门 selector 去掉
 *        [data-type="html-inline"] → F5岛尾主案走 vendor Nt（deleteContents 拆散岛标记）
 *        → md 残留悬空 <u>（岛成对=false）或跨岛 **（无跨岛=false）→ FAIL。
 *  · F5 突变B（整段一刀切）：replacements 里含岛分支改回
 *        remove?md:wrap(inlineMarkdown(e,inner))（不调 islandScopedMarkdown）
 *        → `**这一句</u>。**` 形（跨岛/悬空标记）→ F5岛尾主案、F5跨块岛 FAIL。
 *  · F17 突变C（不取词）：注掉 wordAroundCaret 调用支（wordDone 恒 false）
 *        → Ctrl+Shift+K 落 vendor 插空反引号对 → 词未包裹 → F17 英/中/公式邻域全 FAIL。
 *  · F17 突变D（行内代码内不取消）：注掉 wrapper 分支 → F17代码取消 第二按仍再包一层
 *        → 无反引号=false → FAIL。
 */
