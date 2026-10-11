/** 144 · 图片出源码的**相邻形态**矩阵（问题2 收边：把「一个点」扩成「一整面」）
 *
 *  对应台账：U-065 / U-070 / U-071 / U-073 / U-077 / U-078 / U-079 / A-010 / A-013 / A-019（F08 图片族）；
 *  覆盖率缺口清单 §3.1 Z7 与 §3.2 D1 的「图片族形态面」那一行。
 *
 *  140 只锁了**单张图 + 两种形态**（md 图 / 裸 HTML 图块）的「第二下必出源码」；本条不重复验证
 *  那条契约本身，只测它在**同族相邻形态**里不被改写：
 *    · 双图相邻（甲在上、乙在下）：点甲只选中，点乙两下 → 乙出源码且甲的选中态清除；
 *    · md 图的第二下**用第一下之前测的原坐标**（鼠标不动）：仍然出源码；
 *    · 展开后图片被自己的源码**顶走**（几何上量得到的位移）→ 原坐标上的后续点击不许把展开态折回，
 *      也不许把光标扔回文档开头（这就是产品注释里「第 3 下常常打在这儿」的那个落点）；
 *    · 图文同段（行内图）：展开后正文逐字不变、结构块数不变；
 *    · 列表项内图 / 引用块内图：展开不破坏所属块结构（li / blockquote 计数与文本不变）；
 *    · 文首图 / 文末图：文末图展开后方向键能把光标带走（不困在源码里）、Esc 能收起。
 *
 *  五通道（AGENTS.md 交互验收总规则）：鼠标（真实 click / 拟真连点，clickCount 按 OS 双击规则给）、
 *  键盘（Esc、方向键）、组合键（Ctrl+单击多选）、键鼠配合（点甲后 Shift+点乙）、拖拽（图上起手拖出去）。
 *  CDP 的 dispatchMouseEvent **不会**自己推断双击，clickCount 必须由调用方按「相邻两次间隔 ≤480ms
 *  且位移 ≤4px 才递增，否则归 1」给——给成恒 1 就是"真人慢慢点"，给成递增就是"真人快速连点"。
 *
 *  突变点（把修复注掉必须变红）：
 *    · `app/renderer/js/media-tools.js` 里问题2 的第二下判据（提案记作 L1772–1776「mousedown 记
 *      这一下之前这张图是否已带可见选中框」的快照 + L2011–2020「带蓝框的这一击确定性展开」的
 *      分支；本轮在途改动后行号已漂移，认**语义**不认行号）注掉 → ①② 全红：第二下读不到快照，
 *      永远停在"只选中"；
 *    · 另有「用户展开过的图，点它那一段空白不许折回」的补丁（反例4 分支）——注掉它 → ② 的
 *      「原坐标上的第 3、4 下不折回」变红。
 *
 *  证人：geometry（展开态 / 选中态 / 光标层 / 被顶走的位移）+ disk（全程逐字节零改动：源码与磁盘）。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

// ── 夹具（全部现场生成到 hi.ROOM，不碰受保护素材房）────────────────────────────
const 双图 = ['# 图双', '', '前文甲。', '', '![甲图](shot-blue.png)', '', '![乙图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const 同段 = ['# 图同段', '', '前文甲。', '', '文字前 ![段中图](shot-blue.png) 文字后', '', '后文乙。', ''].join('\n');
const 引用图 = ['# 图引用', '', '前文甲。', '', '> 引用第一行', '>', '> ![引图](shot-blue.png)', '>', '> 引用末行', '', '后文乙。', ''].join('\n');
const 列表图 = ['# 图列表', '', '前文甲。', '', '- 项目甲', '- ![列表图](shot-blue.png)', '- 项目乙', '', '后文乙。', ''].join('\n');
const 首尾图 = ['![首图](shot-blue.png)', '', '# 图首尾', '', '正文甲。', '', '![尾图](shot-blue.png)', ''].join('\n');

/** 一条读数答四件事：每张图的展开/选中/多选/类型 + 光标层与块号 + 结构计数 + 可见正文。 */
const 读 = `(() => { const w = ${hi.IF}; const d = w && w.document; if (!d) return { ok: false };
  const s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const frame = document.getElementById('editor').getBoundingClientRect();
  const sel = w.getSelection(); const rr = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = rr ? (rr.startContainer.nodeType === 3 ? rr.startContainer.parentElement : rr.startContainer) : null;
  const 图 = [...d.querySelectorAll('${hi.SURFACE} img')].map(img => {
    const owner = img.closest('.vditor-ir__node[data-type]');
    const r = img.getBoundingClientRect();
    return { 类型: owner ? owner.getAttribute('data-type') : null,
      展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
      选中: img.classList.contains('typora-img-selected'),
      多选: img.classList.contains('typora-img-multi-selected'),
      中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
      盒: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      在源码: !!(rr && at && owner && owner.contains(at) && at.closest && at.closest('code[data-type],.vditor-ir__marker')) };
  });
  let 层 = '外', 块 = -1;
  if (at && s.contains(at)) {
    层 = at.closest('code[data-type],.vditor-ir__marker') ? '源码' : (at.closest('.vditor-ir__preview') ? '岛' : '正文');
    let top = at; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    块 = [...s.children].indexOf(top);
  }
  return { ok: true, 图数: 图.length, 图, 层, 块, 折叠: rr ? rr.collapsed : null,
    选区: sel ? String(sel).slice(0, 60) : '',
    选区盒: rr ? (() => { const b = rr.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() : null,
    选区容器: rr ? ((rr.startContainer.nodeType === 3 ? 'TEXT' : rr.startContainer.nodeName) + '→' + (rr.endContainer.nodeType === 3 ? 'TEXT' : rr.endContainer.nodeName)) : null,
    结构: { li: s.querySelectorAll('li').length, 引用: s.querySelectorAll('blockquote').length,
      p: s.querySelectorAll('p').length, 标题: s.querySelectorAll('h1,h2,h3,h4').length },
    正文: String(s.textContent).replace(/\\s+/g, ' ').trim() }; })()`;

/** 把第 i 张图滚进视口中央后取它的中心（顶层页坐标，CDP 派发用）。 */
const 取点 = i => `(() => { const w = ${hi.IF}, d = w.document; const imgs = [...d.querySelectorAll('${hi.SURFACE} img')];
  const img = imgs[${i}]; if (!img) return { ok: false, 图数: imgs.length };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const frame = document.getElementById('editor').getBoundingClientRect(); const r = img.getBoundingClientRect();
  return { ok: true, x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2),
    盒: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 拟真连点：按 OS 双击计数规则发 clickCount（相邻两次 ≤480ms 且位移 ≤4px 才递增，否则归 1）。
 *  返回每次实际发出的 clickCount，作为「这一轮到底是快点还是慢点」的独立记账。 */
async function 拟真连点(session, 点, 次数, 间隔) {
  const 计数 = [];
  let count = 0, last = -1e9, lx = 0, ly = 0;
  for (let i = 0; i < 次数; i++) {
    if (i) await hi.sleep(间隔);
    const now = Date.now();
    count = (now - last <= 480 && Math.abs(点.x - lx) <= 4 && Math.abs(点.y - ly) <= 4) ? count + 1 : 1;
    last = now; lx = 点.x; ly = 点.y;
    计数.push(count);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: count });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: count });
    await hi.sleep(120);
  }
  await hi.sleep(420);
  return 计数;
}

const 位移 = (a, b) => Math.round(Math.hypot(b.x - a.x, b.y - a.y));
/** 文等价：只忽略行尾空白差异（产品 getValue 可能重排结尾换行），正文逐字仍要比。 */
const 文等价 = (a, b) => String(a).replace(/\r/g, '').replace(/\s+$/, '') === String(b).replace(/\r/g, '').replace(/\s+$/, '');

/** 一条"展开并出源码"的完整手势：单击选中 → 第二下（原坐标）出源码。返回过程读数。 */
async function 两下出源码(session, 点, 间隔, 单次间隔) {
  const 一 = await 拟真连点(session, 点, 1, 单次间隔);
  const 选中态 = await session.js(读);
  const 二 = await 拟真连点(session, 点, 1, 间隔);
  const 展开态 = await session.js(读);
  return { 计数: [...一, ...二], 选中态, 展开态 };
}

module.exports = {
  id: '144-image-reveal-adjacent-forms',
  title: '图片出源码·相邻形态：双图相邻/图文同段/引用内/列表内/文首文末——第 2 下必出、被顶走后原坐标不折回',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));
    let 出源码命中 = 0;   // 全部"第二下"手势的命中数（进台账的有限数指标）

    // ══ 会话一：双图相邻（甲在上、乙在下）════════════════════════════════════════
    const file1 = hi.writeDoc('image-reveal-adjacent.md', 双图);
    const s1 = await hi.openDoc(ctx, file1, { minBlocks: 5 });
    try {
      ctx.assert('会话一 焦点在编辑器（鼠标类读数前置）', (await hi.ensureFocus(s1)).ok, '');
      const 复位 = await s1.js(文本点('后文乙'));
      ctx.assert('会话一 拿到正文复位点', 复位.ok, JSON.stringify(复位));
      await s1.click(复位.x, 复位.y); await hi.sleep(320);
      const 起 = await s1.js(读);
      ctx.assert('会话一 前置：两张图都在、都是折叠态、owner 都是 img 节点',
        起.图数 === 2 && 起.图.every(g => g.展开 === false) && 起.图.every(g => g.类型 === 'img'),
        JSON.stringify({ 图数: 起.图数, 图: 起.图 }));

      // ── ① 点甲只选中；点乙两下 → 乙出源码、甲的选中态清除 ────────────────────────
      const 甲点 = await s1.js(取点(0));
      ctx.assert('① 前置：拿到甲图几何', 甲点.ok, JSON.stringify(甲点));
      await s1.click(甲点.x, 甲点.y); await hi.sleep(360);
      const 甲选 = await s1.js(读);
      ctx.assert('① 点甲 1 下：甲只选中、不展开（第 1 下契约在相邻双图里不变）',
        甲选.图[0].选中 === true && 甲选.图[0].展开 === false && 甲选.图[1].展开 === false,
        JSON.stringify({ 甲: 甲选.图[0], 乙: 甲选.图[1] }));

      const 乙点 = await s1.js(取点(1));
      const 乙慢 = await 两下出源码(s1, 乙点, 700, 500);
      ctx.assert('① 慢点乙两下（700ms、clickCount 恒 1）：源码必须出来、光标进源码',
        乙慢.展开态.图[1].展开 === true && 乙慢.展开态.图[1].在源码 === true,
        JSON.stringify({ 计数: 乙慢.计数, 乙: 乙慢.展开态.图[1], 层: 乙慢.展开态.层 }));
      ctx.assert('① 乙展开后：甲的选中态被清除（不许两张图同时亮）',
        乙慢.展开态.图[0].选中 === false, JSON.stringify(乙慢.展开态.图[0]));
      if (乙慢.展开态.图[1].展开 === true) 出源码命中 += 1;
      await s1.shot('144-①相邻双图-乙出源码');
      ctx.witness('几何：相邻双图点乙两下后的展开态与光标层',
        { 甲: 乙慢.展开态.图[0], 乙: 乙慢.展开态.图[1], 层: 乙慢.展开态.层, clickCount: 乙慢.计数 }, 'geometry');

      // ── ② 原坐标第二下 → 出源码；图片被源码顶走后，原坐标上的后续点击不许折回 ─────
      await s1.click(复位.x, 复位.y); await hi.sleep(340);
      const 原 = await s1.js(取点(1));                    // 折叠态下的乙图中心 = 原坐标
      ctx.assert('② 前置：复位后乙是折叠态、拿到原坐标',
        原.ok && (await s1.js(读)).图[1].展开 === false, JSON.stringify(原));
      const 慢2 = await 两下出源码(s1, 原, 700, 700);      // 两下都打在**同一个原坐标**上
      ctx.assert('② 第二下打在第一下之前测的原坐标上（鼠标没动）：仍然出源码、光标进源码',
        慢2.展开态.图[1].展开 === true && 慢2.展开态.图[1].在源码 === true,
        JSON.stringify({ 计数: 慢2.计数, 乙: 慢2.展开态.图[1], 层: 慢2.展开态.层 }));
      if (慢2.展开态.图[1].展开 === true) 出源码命中 += 1;

      const 新 = await s1.js(取点(1));                    // 展开后乙图的新中心
      const 推走 = 位移(原, 新);
      ctx.assert('② 展开后图片被自己的源码顶走（位移 > 4px，几何上量得到）',
        推走 > 4, `原坐标 ${JSON.stringify(原)} → 新中心 ${JSON.stringify(新)}，位移 ${推走}px`);
      const 折回 = await 拟真连点(s1, 原, 2, 700);        // 第 3、4 下打在**原坐标**（图已不在那儿）
      const 后 = await s1.js(读);
      ctx.assert('② 原坐标上的第 3、4 下（慢点）：展开态恒定为展开，不许被次数奇偶折回',
        后.图[1].展开 === true, JSON.stringify({ 计数: 折回, 乙: 后.图[1], 层: 后.层, 块: 后.块 }));
      ctx.assert('② 原坐标上的后续点击不许把光标扔回文档开头（块号不回到标题/首段）',
        后.层 !== '外' && 后.块 >= 2, JSON.stringify({ 层: 后.层, 块: 后.块, 选区: 后.选区 }));
      await s1.shot('144-②原坐标第二下与被顶走');
      ctx.witness('几何：原坐标第二下 + 被源码顶走的位移',
        { 原坐标: 原, 新中心: 新, 位移: 推走, 终态: 后.图[1], 层: 后.层, 块: 后.块 }, 'geometry');

      // ── ③ 护栏：Esc 收起；Ctrl+单击=多选不展开；Shift+单击=原生扩选不展开 ─────────
      await s1.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(420);
      ctx.assert('③ 护栏：Esc 收起源码（相邻双图里同样生效）', (await s1.js(读)).图[1].展开 === false, '');

      await s1.click(复位.x, 复位.y); await hi.sleep(300);
      const 甲乙 = await s1.js(取点(0));
      await s1.click(甲乙.x, 甲乙.y, { modifiers: hi.MOD.ctrl }); await hi.sleep(380);
      const 乙点2 = await s1.js(取点(1));
      await s1.click(乙点2.x, 乙点2.y, { modifiers: hi.MOD.ctrl }); await hi.sleep(460);
      const 多 = await s1.js(读);
      ctx.assert('③ 组合键：Ctrl+点两张图 = 多选两张、都不展开',
        多.图[0].多选 === true && 多.图[1].多选 === true && 多.图.every(g => g.展开 === false),
        JSON.stringify(多.图));
      const 甲点2 = await s1.js(取点(0));
      const 甲两下 = await 两下出源码(s1, 甲点2, 700, 700);
      ctx.assert('③ 多选之后普通点甲两下：甲仍能出源码，多选高亮被清掉',
        甲两下.展开态.图[0].展开 === true && 甲两下.展开态.图[0].多选 === false && 甲两下.展开态.图[1].多选 === false,
        JSON.stringify({ 甲: 甲两下.展开态.图[0], 乙: 甲两下.展开态.图[1] }));
      if (甲两下.展开态.图[0].展开 === true) 出源码命中 += 1;

      // ③a Shift+点**第二张图**：Shift 是修饰键，不是"第二下"——两张图都不许展开。
      // 实测登记：Blink 在图片本体（不可编辑的原子节点）上不扩选，选区停在原来那张图上
      // （选区盒 = 一张图的 160×100），所以这里只断言"不展开 + 选区还在（非折叠）"。
      await s1.click(复位.x, 复位.y); await hi.sleep(300);
      const 甲点3 = await s1.js(取点(0));
      await s1.click(甲点3.x, 甲点3.y); await hi.sleep(360);            // 先选中甲（键鼠配合的前置）
      const 乙点3 = await s1.js(取点(1));
      await s1.click(乙点3.x, 乙点3.y, { modifiers: hi.MOD.shift }); await hi.sleep(420);
      const 扩A = await s1.js(读);
      ctx.assert('③ 键鼠配合：点甲后 Shift+点乙（图上）——两张图都不展开，选区仍非折叠',
        扩A.折叠 === false && 扩A.图.every(g => g.展开 === false),
        JSON.stringify({ 折叠: 扩A.折叠, 选区盒: 扩A.选区盒, 容器: 扩A.选区容器, 图: 扩A.图 }));

      // ③b Shift+点**正文**：原生扩选从图片一路盖到正文——选区盒高度必须超过一张图（100px）。
      // 选中内容全是图片/空白时 `Selection.toString()` 会返回空串，所以用包围盒判"扩选到没到"。
      await s1.click(复位.x, 复位.y); await hi.sleep(300);
      const 甲点3b = await s1.js(取点(0));
      await s1.click(甲点3b.x, 甲点3b.y); await hi.sleep(360);
      await s1.click(复位.x, 复位.y, { modifiers: hi.MOD.shift }); await hi.sleep(460);
      const 扩 = await s1.js(读);
      ctx.assert('③ 键鼠配合：点甲后 Shift+点正文 = 原生扩选跨过两张图（选区盒高 > 一张图）',
        扩.折叠 === false && 扩.选区盒 !== null && 扩.选区盒.h > 100 && 扩.图.every(g => g.展开 === false),
        JSON.stringify({ 折叠: 扩.折叠, 选区盒: 扩.选区盒, 容器: 扩.选区容器, 选区: 扩.选区, 图: 扩.图 }));
      ctx.witness('几何：Shift 扩选的选区盒（图上 / 正文两条腿）',
        { 图上: { 折叠: 扩A.折叠, 盒: 扩A.选区盒 }, 正文: { 折叠: 扩.折叠, 盒: 扩.选区盒, 容器: 扩.选区容器 } }, 'geometry');

      // ── ④ 拖拽：图上起手拖出去仍是原生拖选、文档零改动；回来点两下仍出源码 ───────
      await s1.click(复位.x, 复位.y); await hi.sleep(320);
      const 甲点4 = await s1.js(取点(0));
      const 前盘 = fs.readFileSync(file1, 'utf8');
      await hi.drag(s1, { x: 甲点4.x, y: 甲点4.y }, { x: 复位.x, y: 复位.y }, { steps: 10, after: 460 });
      const 拖 = await s1.js(读);
      ctx.assert('④ 拖拽：图上起手拖出去 = 原生拖选（选区非空或跨过一张图），两张图都没被展开',
        !拖.折叠 && (拖.选区.length > 0 || (拖.选区盒 && 拖.选区盒.h > 100)) && 拖.图.every(g => g.展开 === false),
        JSON.stringify({ 选区: 拖.选区, 选区盒: 拖.选区盒, 折叠: 拖.折叠, 图: 拖.图 }));
      const 后盘 = fs.readFileSync(file1, 'utf8');
      ctx.assert('④ 拖拽不改文档（磁盘逐字节相同）', 前盘 === 后盘, `前 ${前盘.length}B 后 ${后盘.length}B`);
      ctx.witness('磁盘：图上拖选前后逐字节', { 相同: 前盘 === 后盘, 字节: 后盘.length }, 'disk');

      const 乙点4 = await s1.js(取点(1));
      const 回 = await 两下出源码(s1, 乙点4, 700, 700);
      ctx.assert('④ 拖出去再回来点两下：乙仍然出源码、光标进源码',
        回.展开态.图[1].展开 === true && 回.展开态.图[1].在源码 === true,
        JSON.stringify({ 乙: 回.展开态.图[1], 层: 回.展开态.层 }));
      if (回.展开态.图[1].展开 === true) 出源码命中 += 1;

      const 内md = await hi.mdNow(s1);
      const 盘末 = fs.readFileSync(file1, 'utf8');
      ctx.assert('④ 全会话零编辑：内存源码与磁盘都等于打开时的原文（无 ZWSP 残留）',
        文等价(内md, 双图) && 盘末 === 双图,
        JSON.stringify({ 内存同: 文等价(内md, 双图), 磁盘同: 盘末 === 双图, 尾: 盘末.slice(-40) }));
      ctx.witness('磁盘：会话一收尾的文档字节', { 磁盘同原文: 盘末 === 双图, 字节: 盘末.length, 尾: 盘末.slice(-40) }, 'disk');
    } finally {
      await ctx.release(s1);
    }

    // ══ 会话二：图文同段（行内图）════════════════════════════════════════════════
    const file2 = hi.writeDoc('image-reveal-inline.md', 同段);
    const s2 = await hi.openDoc(ctx, file2, { minBlocks: 3 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(s2)).ok, '');
      const 复位2 = await s2.js(文本点('后文乙'));
      await s2.click(复位2.x, 复位2.y); await hi.sleep(320);
      const 起2 = await s2.js(读);
      ctx.assert('⑤ 前置：行内图与正文文字在**同一段**里（文字前/文字后同时可见）',
        起2.图数 === 1 && 起2.正文.includes('文字前') && 起2.正文.includes('文字后'),
        JSON.stringify({ 图数: 起2.图数, 正文: 起2.正文 }));
      const 点2 = await s2.js(取点(0));
      const 行 = await 两下出源码(s2, 点2, 700, 700);
      ctx.assert('⑤ 图文同段：点两下出源码、光标进源码',
        行.展开态.图[0].展开 === true && 行.展开态.图[0].在源码 === true,
        JSON.stringify({ 图: 行.展开态.图[0], 层: 行.展开态.层 }));
      if (行.展开态.图[0].展开 === true) 出源码命中 += 1;
      ctx.assert('⑤ 展开后正文逐字不变（文字前/文字后都在、前后顺序不变）、段落数不变',
        行.展开态.正文.includes('文字前') && 行.展开态.正文.includes('文字后')
        && 行.展开态.正文.indexOf('文字前') < 行.展开态.正文.indexOf('文字后')
        && 行.展开态.正文.includes('shot-blue.png')
        && 行.展开态.结构.p === 起2.结构.p && 行.展开态.图数 === 1,
        JSON.stringify({ 正文: 行.展开态.正文, p: [起2.结构.p, 行.展开态.结构.p] }));
      await s2.shot('144-⑤图文同段-出源码');
      const 内2 = await hi.mdNow(s2);
      const 盘2 = fs.readFileSync(file2, 'utf8');
      ctx.assert('⑤ 图文同段展开不改文档（内存源码与磁盘逐字节等于原文）',
        文等价(内2, 同段) && 盘2 === 同段, JSON.stringify({ 内存同: 文等价(内2, 同段), 磁盘同: 盘2 === 同段 }));
      ctx.witness('磁盘：图文同段展开前后逐字节', { 相同: 盘2 === 同段, 字节: 盘2.length, 正文: 行.展开态.正文 }, 'disk');
      await s2.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(400);
      const 收 = await s2.js(读);
      ctx.assert('⑤ 护栏：Esc 收起后正文仍逐字在、图数不变',
        收.图[0].展开 === false && 收.正文.includes('文字前') && 收.正文.includes('文字后'),
        JSON.stringify({ 正文: 收.正文 }));

      // 快速两下（150ms、clickCount 1→2，系统双击通道）在行内图上同样必须出源码
      const 快点2 = await s2.js(取点(0));
      const 快 = await 拟真连点(s2, 快点2, 2, 150);
      const 快态 = await s2.js(读);
      ctx.assert('⑤ 图文同段：快速两下（150ms、clickCount 递增）同样出源码、光标进源码',
        快态.图[0].展开 === true && 快态.图[0].在源码 === true,
        JSON.stringify({ clickCount: 快, 图: 快态.图[0], 层: 快态.层 }));
      if (快态.图[0].展开 === true) 出源码命中 += 1;
    } finally {
      await ctx.release(s2);
    }

    // ══ 会话三：引用块内图 ═══════════════════════════════════════════════════════
    const file3 = hi.writeDoc('image-reveal-quote.md', 引用图);
    const s3 = await hi.openDoc(ctx, file3, { minBlocks: 3 });
    try {
      ctx.assert('会话三 焦点在编辑器', (await hi.ensureFocus(s3)).ok, '');
      const 复位3 = await s3.js(文本点('后文乙'));
      await s3.click(复位3.x, 复位3.y); await hi.sleep(340);
      const 起3 = await s3.js(读);
      ctx.assert('⑥ 前置：引用块内图已渲染、引用块数 = 1、引用文字都在',
        起3.图数 === 1 && 起3.结构.引用 === 1 && 起3.正文.includes('引用第一行') && 起3.正文.includes('引用末行'),
        JSON.stringify({ 图数: 起3.图数, 结构: 起3.结构, 正文: 起3.正文 }));
      const 点3 = await s3.js(取点(0));
      const 引 = await 两下出源码(s3, 点3, 700, 700);
      ctx.assert('⑥ 引用块内图：点两下出源码、光标进源码',
        引.展开态.图[0].展开 === true && 引.展开态.图[0].在源码 === true,
        JSON.stringify({ 图: 引.展开态.图[0], 层: 引.展开态.层 }));
      if (引.展开态.图[0].展开 === true) 出源码命中 += 1;
      ctx.assert('⑥ 展开不破坏所属块结构：引用块数、正文文字、图数都不变',
        引.展开态.结构.引用 === 1 && 引.展开态.图数 === 1
        && 引.展开态.正文.includes('引用第一行') && 引.展开态.正文.includes('引用末行'),
        JSON.stringify({ 结构: 引.展开态.结构, 正文: 引.展开态.正文 }));
      await s3.shot('144-⑥引用内图-出源码');
      const 盘3 = fs.readFileSync(file3, 'utf8');
      const 内3 = await hi.mdNow(s3);
      ctx.assert('⑥ 引用块内图展开不改文档（磁盘与内存源码逐字节等于原文）',
        盘3 === 引用图 && 文等价(内3, 引用图), JSON.stringify({ 磁盘同: 盘3 === 引用图, 内存同: 文等价(内3, 引用图) }));
      ctx.witness('磁盘：引用块内图展开前后逐字节', { 相同: 盘3 === 引用图, 字节: 盘3.length }, 'disk');
    } finally {
      await ctx.release(s3);
    }

    // ══ 会话四：列表项内图 ═══════════════════════════════════════════════════════
    const file4 = hi.writeDoc('image-reveal-list.md', 列表图);
    const s4 = await hi.openDoc(ctx, file4, { minBlocks: 3 });
    try {
      ctx.assert('会话四 焦点在编辑器', (await hi.ensureFocus(s4)).ok, '');
      const 复位4 = await s4.js(文本点('后文乙'));
      await s4.click(复位4.x, 复位4.y); await hi.sleep(340);
      const 起4 = await s4.js(读);
      ctx.assert('⑦ 前置：列表里 3 个 li、列表项文字都在、图在列表项内',
        起4.图数 === 1 && 起4.结构.li === 3 && 起4.正文.includes('项目甲') && 起4.正文.includes('项目乙'),
        JSON.stringify({ 图数: 起4.图数, 结构: 起4.结构, 正文: 起4.正文 }));
      const 点4 = await s4.js(取点(0));
      const 列 = await 两下出源码(s4, 点4, 700, 700);
      ctx.assert('⑦ 列表项内图：点两下出源码、光标进源码',
        列.展开态.图[0].展开 === true && 列.展开态.图[0].在源码 === true,
        JSON.stringify({ 图: 列.展开态.图[0], 层: 列.展开态.层 }));
      if (列.展开态.图[0].展开 === true) 出源码命中 += 1;
      ctx.assert('⑦ 展开不把列表拉平：li 数仍为 3、三个项目文字都在、图数不变',
        列.展开态.结构.li === 3 && 列.展开态.图数 === 1
        && ['项目甲', '项目乙', '列表图'].every(词 => 列.展开态.正文.includes(词)),
        JSON.stringify({ 结构: 列.展开态.结构, 正文: 列.展开态.正文 }));
      await s4.shot('144-⑦列表内图-出源码');
      const 盘4 = fs.readFileSync(file4, 'utf8');
      const 内4 = await hi.mdNow(s4);
      ctx.assert('⑦ 列表项内图展开不改文档（磁盘与内存源码逐字节等于原文）',
        盘4 === 列表图 && 文等价(内4, 列表图), JSON.stringify({ 磁盘同: 盘4 === 列表图, 内存同: 文等价(内4, 列表图) }));
      ctx.witness('磁盘：列表项内图展开前后逐字节', { 相同: 盘4 === 列表图, 字节: 盘4.length }, 'disk');
    } finally {
      await ctx.release(s4);
    }

    // ══ 会话五：文首图 / 文末图 ══════════════════════════════════════════════════
    const file5 = hi.writeDoc('image-reveal-first-last.md', 首尾图);
    const s5 = await hi.openDoc(ctx, file5, { minBlocks: 3 });
    try {
      ctx.assert('会话五 焦点在编辑器', (await hi.ensureFocus(s5)).ok, '');
      const 复位5 = await s5.js(文本点('正文甲'));
      await s5.click(复位5.x, 复位5.y); await hi.sleep(340);
      const 起5 = await s5.js(读);
      ctx.assert('⑧ 前置：文首图与文末图各一张、都是折叠态',
        起5.图数 === 2 && 起5.图[0].展开 === false && 起5.图[1].展开 === false,
        JSON.stringify(起5.图));

      const 首 = await s5.js(取点(0));
      const 首两下 = await 两下出源码(s5, 首, 700, 700);
      ctx.assert('⑧ 文首图（文档第一块就是图）：点两下出源码、光标进源码',
        首两下.展开态.图[0].展开 === true && 首两下.展开态.图[0].在源码 === true,
        JSON.stringify({ 图: 首两下.展开态.图[0], 层: 首两下.展开态.层, 块: 首两下.展开态.块 }));
      if (首两下.展开态.图[0].展开 === true) 出源码命中 += 1;

      await s5.click(复位5.x, 复位5.y); await hi.sleep(340);
      const 尾 = await s5.js(取点(1));
      const 尾两下 = await 两下出源码(s5, 尾, 700, 700);
      ctx.assert('⑧ 文末图（文档最后一块就是图）：点两下出源码、光标进源码',
        尾两下.展开态.图[1].展开 === true && 尾两下.展开态.图[1].在源码 === true,
        JSON.stringify({ 图: 尾两下.展开态.图[1], 层: 尾两下.展开态.层, 块: 尾两下.展开态.块 }));
      if (尾两下.展开态.图[1].展开 === true) 出源码命中 += 1;
      await s5.shot('144-⑧文末图-出源码');

      // ── ⑨ 文末图展开后：方向键能把光标带走（不困在源码里）、Esc 能收起 ────────────
      for (const [key, code, vk] of [['ArrowDown', 'ArrowDown', 40], ['ArrowRight', 'ArrowRight', 39], ['ArrowUp', 'ArrowUp', 38]]) {
        await s5.key({ key, code, vk }); await hi.sleep(180);
      }
      const 走 = await s5.js(读);
      const 光标 = await hi.caret(s5);
      // 口径：方向键是"离开源码"的正常出口，源码随光标离开而收起不算坏（Typora 直觉）。
      // 要守住的是——光标要么落在**可见文本位**（h>0），要么仍在展开着的源码里；不许出现
      // 0×0 隐形位，也不许被扔回文档开头（块号 <1 就是"光标跳回标题/首段"那个老毛病）。
      const 光标可见 = 光标.h > 0 || (走.层 === '源码' && 走.图[1].展开 === true);
      ctx.assert('⑨ 文末图展开后按方向键：光标落在可见文本位（或仍在展开的源码里），不困在 0×0、不被扔回文档开头',
        走.层 !== '外' && 光标.ok === true && 光标可见 && 走.块 >= 1,
        JSON.stringify({ 层: 走.层, 块: 走.块, 展开: 走.图[1].展开, 光标: { ok: 光标.ok, 层: 光标.层, 容器: 光标.容器, h: 光标.h } }));
      ctx.witness('几何：文末图展开后方向键的落点', { 层: 走.层, 块: 走.块, 光标层: 光标.层, 光标高: 光标.h }, 'geometry');

      await s5.click(复位5.x, 复位5.y); await hi.sleep(340);
      const 尾2 = await s5.js(取点(1));
      const 尾3 = await 两下出源码(s5, 尾2, 700, 700);
      ctx.assert('⑨ 前置：文末图重新展开、光标在源码', 尾3.展开态.图[1].展开 === true && 尾3.展开态.图[1].在源码 === true, '');
      await s5.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(420);
      const 收5 = await s5.js(读);
      ctx.assert('⑨ 护栏：Esc 收起文末图的源码后，光标仍在编辑面内、文档零改动',
        收5.图[1].展开 === false && 收5.层 !== '外' && fs.readFileSync(file5, 'utf8') === 首尾图,
        JSON.stringify({ 展开: 收5.图[1].展开, 层: 收5.层, 块: 收5.块 }));
      ctx.witness('磁盘：文首文末图会话收尾的文档字节',
        { 磁盘同原文: fs.readFileSync(file5, 'utf8') === 首尾图, 字节: fs.readFileSync(file5, 'utf8').length }, 'disk');
    } finally {
      await ctx.release(s5);
    }

    ctx.metric('图片两下出源码命中数（相邻形态）', 出源码命中, { unit: '次', direction: 'higher', values: [出源码命中] });
    ctx.log(`相邻形态第二下命中 ${出源码命中} 次（含双图/同段/引用/列表/首尾与多选后、拖拽后两下）`);
  },
};
