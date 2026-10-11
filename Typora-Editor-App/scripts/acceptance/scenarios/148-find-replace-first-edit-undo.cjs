/** 148 · 查找替换：载入后**第一次编辑**就是替换 → Ctrl+Z，光标/选区不许落壳层（A-006）
 *
 *  守的是什么：台账 A-006——`find-replace` 的替换不走 `beginDocumentEdit`
 *  （find-replace.js 的 replaceInPlace(:94) / apply(:102) / 全量管线(:135) 三处自己
 *  `flushIR + addToUndoStack`），因此**没有补喂 `recordFirstPosition`**。同族的 A-005
 *  （§5.5「撤销后选区落壳层」，已修 9b4a598）给 `beginDocumentEdit` 补喂的正是这一步：
 *  载入态首快照本来没有 `<wbr>` 光标标记，撤销回到它时 vendored renderDiff 会走明文
 *  兜底，把选区设到 `(div.vditor-ir, 0)`——**编辑面之外的壳层**，rect 0×0、用户看不见
 *  光标，观感就是"撤销之后光标没了"。
 *
 *  A-006 指的正是那条修复**唯一没被守门的路径**：载入文档后，用户第一次编辑就是用
 *  查找替换面板把一处文字换掉（此前没打过字、没按过回车），然后 Ctrl+Z。本条把它
 *  做成门。
 *
 *  判据（全部是用户看得见的效果）：
 *    ① 替换真的发生（正文里出现替换后的文字，面板回报"已替换 1 处"）；
 *    ② Ctrl+Z 之后**光标/选区必须还在正文里**——从 `range.startContainer` 沿祖先链
 *       必须穿过编辑面 `.vditor-ir .vditor-reset`（SHELL_READ 口径，与 A-005 的 -8a
 *       硬红线同款）。落壳层时 startContainer 是 `DIV`（.vditor-ir 自身）或面板里的
 *       节点，链上没有编辑面；
 *    ③ 内容逐字节回到替换前（getValue 与打开时逐字相同）；
 *    ④ 撤销 → 重做 → 再撤销不串台（每一步内容都看得见地对得上，且两次撤销都不落壳层）；
 *    ⑤ 替换写盘后撤销再存盘：磁盘逐字节回到原件（磁盘证人，不是空转）；
 *    ⑥ 回到正文的手势两条都测：一条用**真实鼠标点正文**（面板是 `position:fixed;
 *       top:45px` 的大浮层，点它下方的段落才算点到正文），一条用**真实键盘 Esc**
 *       关面板（find-replace 的 close() 会把选区还给编辑面）。两条都走 Ctrl+Z。
 *
 *  A-020 回归钉（同族）：面板里打完字 700ms 后焦点仍必须在面板内，在查找框里按
 *  Enter 只做"下一处"导航——绝不许插进正文、更不许把命中的文字删掉。
 *
 *  通道纪律：Ctrl+F / Ctrl+H / Enter / Ctrl+Z / Ctrl+Y / Esc 全走真实键盘
 *  （CDP dispatchKeyEvent）；切替换模式、点「替换」按钮、拖选播种、点正文全走真实鼠标
 *  （mousePressed → mouseMoved → mouseReleased）。每段按键类读数前先 `hi.ensureFocus`
 *  并断言 ok；点正文之后另有一条"焦点真的回到编辑面"的前置断言——它红了说明是**探针**
 *  点在了面板上（Ctrl+Z 会变成输入框自己的撤销），不能算产品结论。
 *
 *  突变点（修复已落码：find-replace.js open() 在 query.focus() 前补喂 recordFirstPosition
 *  ＋ 冷入口硬化"无面内选区先落折叠选区进第一个顶层块"；把修复注掉必须变红）：
 *    M1 注掉整个补喂块 → 三条会话的 ② 全红（突变副本实测 nofix=43/48 同款壳层红）；
 *    M2 补喂挪到 query.focus() 之后 → 全红（突变副本实测 after=43/48）；
 *    M3 只注掉硬化的"落折叠选区"三行（补喂保留）→ **只有会话三（工具栏冷入口）红**，
 *       另两条会话保持绿；
 *    M4 保绿：注掉面板 keydown 的 `event.stopPropagation()` → A-020 钉变红（焦点翻到
 *      编辑面，Enter 落进正文）。
 *    （原案 `{key:'Backspace'}` 突变腿本机不可验：vendored 卫兵是 isFirefox()/isSafari()，
 *     Electron/Chromium 恒 false，改 key 不改变任何行为。）
 *
 *  证人：磁盘（⑤ 保存后逐字节读回）+ 几何（② 选区容器层级 / rect / 面板底边）。
 *  素材：hi.writeDoc 现场生成到 .perf/human-input/fixtures/，不碰受保护素材房。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# 标题甲', '', '正文甲', '', '正文乙', '', '后文一。', '', '后文二。', '', '后文三。', ''].join('\n');
const 查词 = '正文乙';
const 换词 = '正文乙改';
const 查词2 = '正文甲';
const 换词2 = '正文甲改';

/** 选区落点读数：inSurface = 从 startContainer 沿祖先链是否穿过编辑面（壳层判据硬红线）。 */
const 读选区 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s) return { 有选区: false, inSurface: false, why: 'no-surface' };
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 有选区: false, inSurface: false, why: 'nosel' };
  const r = sel.getRangeAt(0);
  let inSurface = false; for (let n = r.startContainer; n; n = n.parentNode) { if (n === s) { inSurface = true; break; } }
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const b = r.getBoundingClientRect();
  const 链 = []; let k = r.startContainer;
  while (k && 链.length < 5) { 链.push(k.nodeType === 3 ? 'TEXT:' + String(k.data).slice(0, 10) : 'EL:' + k.nodeName); k = k.parentNode; }
  return { 有选区: true, inSurface, 在编辑面: !!(at && s.contains(at)),
    node: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName,
    容器: at ? (at.tagName + (at.className ? '.' + String(at.className).split(' ')[0] : '')) : null,
    层: !at ? '?' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段' : at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : '其他',
    折叠: r.collapsed, 偏移: r.startOffset, 选中: sel.toString().slice(0, 40),
    rect: { w: Math.round(b.width), h: Math.round(b.height) }, 链, hasFocus: !!d.hasFocus }; })()`;

/** 面板事实：开没开、两个输入框的值、命中计数、状态、焦点在不在面板里。 */
const 读面板 = `(() => { const w = ${hi.IF}, d = w.document; const p = d.querySelector('#typora-find');
  if (!p) return { open: false };
  const q = p.querySelector('[data-field="query"]'), r = p.querySelector('[data-field="replace"]');
  const a = d.activeElement;
  return { open: true, 查找: q ? q.value : null, 替换: r ? r.value : null,
    计数: String((p.querySelector('output') || {}).textContent || ''),
    状态: String((p.querySelector('[role="status"]') || {}).textContent || ''),
    替换行可见: !!(r && !r.closest('.find-replace-row').hidden),
    焦点在面板: !!(a && p.contains(a)),
    活动元素: a ? a.tagName + '[' + String(a.getAttribute('data-field') || a.className || '').slice(0, 24) + ']' : null }; })()`;

/** 焦点到底在哪（点正文之后的必过闸门：不在编辑面里，Ctrl+Z 就不是文档的撤销）。 */
const 读焦点 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  const a = d.activeElement;
  return { 标签: a ? a.tagName : null, 类: a ? String(a.className || '').slice(0, 30) : null,
    在编辑面: !!(a && s && (a === s || s.contains(a))),
    在面板: !!(a && a.closest && a.closest('#typora-find')), hasFocus: !!d.hasFocus }; })()`;

/** 命中计数非零（面板一开就是 0 / 0，必须等"出现"）。 */
const 命中非零 = `(() => { const w = ${hi.IF}, d = w.document; const p = d.querySelector('#typora-find'); if (!p) return false;
  const m = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(String((p.querySelector('output') || {}).textContent || ''));
  return !!m && Number(m[2]) > 0; })()`;

/** 片段在顶层页里的左右缘（拖拽取点用）；块右 = 所在顶层块的右缘，拖拽终点用它保证选满整段。 */
const 文字盒 = 片段 => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s) return { ok: false };
  const walker = d.createTreeWalker(s, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode())) { const at = n.data.indexOf(${JSON.stringify(片段)}); if (at >= 0) {
    const r = d.createRange(); r.setStart(n, at); r.setEnd(n, at + ${片段.length});
    const b = r.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
    let top = n.parentElement; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
    const br = top ? top.getBoundingClientRect() : b;
    return { ok: b.width > 0, left: Math.round(fr.x + b.left), right: Math.round(fr.x + b.right), y: Math.round(fr.y + b.top + b.height / 2),
      块右: Math.round(fr.x + br.right) }; } }
  return { ok: false, why: 'no-text' }; })()`;

/** 最后一个顶层块的文字盒（滚到视口中线）——查找面板是 fixed 大浮层，点它下方的段落才叫"点正文"。 */
const 末块文字盒 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  if (!s || !s.children.length) return { ok: false, why: 'no-block' };
  const b = s.children[s.children.length - 1];
  b.scrollIntoView({ block: 'center', behavior: 'instant' });
  const p = d.querySelector('#typora-find'); const pb = p ? p.getBoundingClientRect() : null;
  const fr = document.getElementById('editor').getBoundingClientRect();
  const walker = d.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode())) { const at = n.data.search(/\\S/); if (at < 0) continue;
    const r = d.createRange(); r.setStart(n, at); r.setEnd(n, Math.min(n.data.length, at + 2));
    const bb = r.getBoundingClientRect(); if (!bb.width) continue;
    return { ok: true, x: Math.round(fr.x + bb.left + 2), y: Math.round(fr.y + bb.top + bb.height / 2),
      块: String(b.textContent).replace(/\\u200b/g, '').slice(0, 12), 面板底: pb ? Math.round(pb.bottom) : null,
      点y: Math.round(bb.top + bb.height / 2) }; }
  return { ok: false, why: 'no-text' }; })()`;

/** 编辑面里某个节点的中心 → 顶层页坐标（CDP 鼠标事件打在外壳页上）。 */
const 面里点 = 表达式 => `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow; const d = w && w.document;
  if (!d) return { ok: false, why: 'no-frame' };
  const s = d.querySelector(${JSON.stringify(hi.SURFACE)});
  const 节点 = (${表达式});
  if (!节点) return { ok: false, why: 'no-node' };
  const fr = f.getBoundingClientRect(), r = 节点.getBoundingClientRect();
  return { ok: r.width > 0 && r.height > 0, x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.y + r.height / 2),
    w: Math.round(r.width), h: Math.round(r.height) }; })()`;

const 面板点 = 选择器 => 面里点(`d.querySelector('#typora-find ${选择器}')`);

const 非空行 = text => String(text).replace(/\r/g, '').split('\n').filter(line => line.trim());
const 显 = text => String(text).replace(/\n/g, '\\n');

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(420); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(800); }
async function 重做(session) { await hi.combo(session, 'Ctrl+y'); await hi.sleep(800); }

/** 真实鼠标点正文（面板下方的段落）＋"焦点真的回到编辑面"的前置闸门。 */
async function 点正文(ctx, session, 标签) {
  const 盒 = await session.js(末块文字盒);
  ctx.assert(标签 + ' 前置：找得到面板下方的正文段（查找面板是 fixed 浮层，点它下方才算点到正文）',
    盒.ok && (盒.面板底 === null || 盒.点y > 盒.面板底), JSON.stringify(盒));
  if (!盒.ok) return false;
  await session.click(盒.x, 盒.y);
  await hi.sleep(400);
  const 焦点 = await session.js(读焦点);
  ctx.assert(标签 + ' 前置：点正文后焦点真的回到编辑面（否则 Ctrl+Z 只是输入框自己的撤销）',
    焦点.在编辑面 === true && 焦点.在面板 === false, JSON.stringify(焦点));
  return 焦点.在编辑面 === true;
}

module.exports = {
  id: '148-find-replace-first-edit-undo',
  title: '查找替换作首次编辑后 Ctrl+Z：光标/选区必须仍在正文里（不许落壳层），内容逐字节回到替换前',
  run: async ctx => {
    // ══ 会话一：拖选播种 → 真键盘 Enter 替换 → 点正文 → Ctrl+Z / Ctrl+Y / Ctrl+Z ══
    const file = hi.writeDoc('find-replace-first-edit.md', BODY);
    const 原件 = fs.readFileSync(file, 'utf8');
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    try {
      ctx.assert('会话一 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');
      const md0 = await hi.mdNow(session);
      ctx.assert('会话一 前置：打开后的文档内容就是夹具本身', md0 === 原件, JSON.stringify({ md0: 显(md0), 原件: 显(原件) }));

      // ── ① 拖选「正文乙」→ Ctrl+F 播种 → 面板命中 ──────────────────────────────
      const 盒 = await session.js(文字盒(查词));
      ctx.assert('① 前置：正文里找得到「' + 查词 + '」的可点文字盒', 盒.ok, JSON.stringify(盒));
      // 拖拽终点取"所在块的右缘"（段落到此处只剩空白），保证整段被选中——只看文字盒右缘 +6px
      // 会随排版抖动少选一个字（实测两次跑出 3 字/2 字两种结果）。
      // 播种偶发（复核轮实测 1/5 拖成折叠光标，r17 §6.1 同款）：按对抗轮 §7 纪律化重试——
      // 同一手势换落点（-8→-12→-30），每轮重新断言 选中===查词；产品真把选区弄塌时重试救不了
      // （断言仍红），门不掩盖；禁止"面板空就键盘补打查词"兜底（那会把 FR5 选区播种从门里拿掉）。
      let 拖后 = null, 播种成 = false;
      for (const 偏 of [-8, -12, -30]) {
        await hi.drag(session, { x: 盒.left + 1, y: 盒.y }, { x: 盒.块右 + 偏, y: 盒.y }, { steps: 10 });
        拖后 = await session.js(读选区);
        播种成 = 拖后.有选区 && String(拖后.选中) === 查词;
        if (播种成) break;
      }
      ctx.assert('① 真实拖拽选中了「' + 查词 + '」（三轮换落点重试后仍必须选中；选不上就是真缺陷）',
        播种成, JSON.stringify({ 盒, 拖后 }));

      await hi.combo(session, 'Ctrl+f');
      await hi.sleep(700);
      let 面板 = await session.js(读面板);
      ctx.assert('① Ctrl+F 真的打开了查找面板（真实键盘）', 面板.open === true, JSON.stringify(面板));
      ctx.assert('① 查找框播种到拖选的文字（不用再打一遍词）', 面板.查找 === 查词, JSON.stringify(面板));

      const 有命中 = await session.until(命中非零, { timeout: 20000, interval: 120 });
      面板 = await session.js(读面板);
      ctx.assert('① 面板回报恰好命中一处（1 / 1）', 有命中 && /1\s*\/\s*1/.test(面板.计数), JSON.stringify({ 有命中, 计数: 面板.计数 }));

      // ── A-020 回归钉：面板焦点不许被抢走，Enter 不许落进正文 ────────────────────
      await hi.sleep(700);
      面板 = await session.js(读面板);
      ctx.assert('① A-020 钉：面板里打完字 700ms 后焦点仍在面板内（不被编辑面抢走）',
        面板.焦点在面板 === true, JSON.stringify({ 焦点在面板: 面板.焦点在面板, 活动元素: 面板.活动元素 }));
      await 回车(session);
      const mdEnter = await hi.mdNow(session);
      ctx.assert('① A-020 钉：在查找框里按 Enter 只做导航，一个字符都不许动文档',
        mdEnter === md0, JSON.stringify({ '按 Enter 后': 显(mdEnter) }));

      // ── ① 切替换模式（真实鼠标点面板按钮）→ 输入替换词 → 真实键盘 Enter ──────────
      const 替换模式点 = await session.js(面板点('[data-mode="replace"]'));
      ctx.assert('① 面板里的「替换」模式按钮可点', 替换模式点.ok, JSON.stringify(替换模式点));
      await session.click(替换模式点.x, 替换模式点.y);
      await hi.sleep(300);
      面板 = await session.js(读面板);
      ctx.assert('① 切到替换模式后替换输入行可见', 面板.替换行可见 === true, JSON.stringify(面板));

      const 替换框点 = await session.js(面板点('[data-field="replace"]'));
      await session.click(替换框点.x, 替换框点.y);
      await hi.sleep(200);
      await session.type(换词);
      await hi.sleep(300);
      面板 = await session.js(读面板);
      ctx.assert('① 替换框里是用户输入的替换词', 面板.替换 === 换词, JSON.stringify(面板));

      await 回车(session);            // 替换框里按 Enter = 替换这一处（find-replace.js FR6）
      await hi.sleep(800);
      面板 = await session.js(读面板);
      const md1 = await hi.mdNow(session);
      ctx.assert('① 真实键盘 Enter 触发了替换：文档里出现替换后的文字、原来那处没了',
        String(md1).includes(换词) && !String(md1).includes(查词 + '\n'), 显(md1));
      ctx.assert('① 面板回报「已替换 1 处」', /已替换\s*1\s*处/.test(面板.状态), JSON.stringify(面板));
      ctx.assert('① 替换确实改了文档本身（不是只改了面板显示）', md1 !== md0, 显(md1));
      ctx.assert('① 替换后焦点仍在替换框（连按 Enter 能连续替换下一处）',
        面板.焦点在面板 === true, JSON.stringify({ 焦点在面板: 面板.焦点在面板, 活动元素: 面板.活动元素 }));

      // ── ② 键鼠配合：真实鼠标点正文夺回焦点 → Ctrl+Z【本场景的核心窗口】 ──────────
      await 点正文(ctx, session, '②');
      ctx.assert('② 点正文后 hi.ensureFocus 仍报 ok', (await hi.ensureFocus(session)).ok, '');

      await 撤销(session);
      const 撤销后 = await session.js(读选区);
      const md2 = await hi.mdNow(session);
      ctx.witness('几何：Ctrl+Z 之后的选区落点', 撤销后, 'geometry');
      ctx.assert('②【硬红线】Ctrl+Z 之后光标/选区仍在**编辑面内**（不许落壳层 div.vditor-ir、也不许留在面板里）',
        撤销后.有选区 && 撤销后.inSurface === true, JSON.stringify(撤销后));
      ctx.assert('② 撤销后的容器不是壳层节点（startContainer 不许是编辑面之外的 DIV）',
        撤销后.有选区 && 撤销后.在编辑面 === true && 撤销后.node !== 'DIV', JSON.stringify({ node: 撤销后.node, 容器: 撤销后.容器, 链: 撤销后.链 }));
      ctx.assert('② 撤销后光标矩形不得 0×0（壳层兜底 rect 恒 0×0，正文行盒 16px 一眼可辨）',
        !(撤销后.rect.w === 0 && 撤销后.rect.h === 0), JSON.stringify({ rect: 撤销后.rect, 容器: 撤销后.容器 }));
      ctx.metric('148 撤销后光标矩形高度', 撤销后.rect.h, { direction: 'higher', unit: 'px' });
      ctx.assert('② 撤销后内容逐字节回到替换前（与打开时逐字相同）',
        md2 === md0, JSON.stringify({ 撤销后: 显(md2) }));
      ctx.assert('② 撤销后文档里再也看不到替换词', !String(md2).includes(换词), 显(md2));

      // ── ③ 重做 → 再撤销：不串台，两次撤销都不落壳层 ───────────────────────────
      await 重做(session);
      const md3 = await hi.mdNow(session);
      ctx.assert('③ Ctrl+Y 重做：内容回到替换后（撤销/重做不串台）',
        md3 === md1, JSON.stringify({ 重做后: 显(md3) }));
      const 存1 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.witness('磁盘：重做后保存（替换结果真的写盘）', { 行: 非空行(存1.after).map(显) }, 'disk');
      ctx.assert('③ 替换结果真的写进了磁盘（这一步让后面的"撤销回原件"不是空转）',
        String(存1.after).includes(换词), 显(存1.after));

      await 点正文(ctx, session, '③');
      ctx.assert('③ 再点正文后 hi.ensureFocus 仍报 ok', (await hi.ensureFocus(session)).ok, '');
      await 撤销(session);
      const 撤销后2 = await session.js(读选区);
      const md4 = await hi.mdNow(session);
      ctx.witness('几何：第二次 Ctrl+Z 之后的选区落点', 撤销后2, 'geometry');
      ctx.assert('③ 第二次 Ctrl+Z 后光标/选区仍在编辑面内（同一条链的第二次）',
        撤销后2.有选区 && 撤销后2.inSurface === true, JSON.stringify(撤销后2));
      ctx.assert('③ 第二次撤销后内容再次回到替换前', md4 === md0, 显(md4));

      const 存2 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      ctx.witness('磁盘：撤销后保存（盘面回到替换前）', { 行: 非空行(存2.after).map(显) }, 'disk');
      ctx.assert('③ 撤销后存盘：磁盘逐字节回到替换前（用户不会被撤销结果骗到盘上）',
        存2.after === 原件, JSON.stringify({ 盘: 显(存2.after), 原件: 显(原件) }));

      ctx.metric('148 撤销后文档字符数', String(md2).replace(/\s/g, '').length, { direction: 'equal', unit: '字符' });
      ctx.metric('148 面板命中处数', Number(/\/\s*(\d+)/.exec(String((await session.js(读面板)).计数 || ''))?.[1] || -1), { direction: 'equal', unit: '处' });
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：Ctrl+H + 真实鼠标点「替换」按钮 → Esc 关面板 → Ctrl+Z ════════════
    const file2 = hi.writeDoc('find-replace-first-edit-mouse.md', BODY);
    const 原件2 = fs.readFileSync(file2, 'utf8');
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 5 });
    try {
      ctx.assert('会话二 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session2)).ok, '');
      const md0b = await hi.mdNow(session2);

      // 面板还没开，先点一下正文（这条链路里"点正文夺焦点"在替换之后由 Esc 承担）
      const 盒3 = await session2.js(文字盒(查词2));
      ctx.assert('① 前置：找得到「' + 查词2 + '」的可点文字盒', 盒3.ok, JSON.stringify(盒3));
      await session2.click(盒3.left + 2, 盒3.y);
      await hi.sleep(300);

      await hi.combo(session2, 'Ctrl+h');            // 真实键盘的另一条入口：直接进替换模式
      await hi.sleep(700);
      let 面板2 = await session2.js(读面板);
      ctx.assert('① Ctrl+H 真的打开了面板且直接是替换模式', 面板2.open === true && 面板2.替换行可见 === true, JSON.stringify(面板2));

      await session2.type(查词2);
      const 有命中2 = await session2.until(命中非零, { timeout: 20000, interval: 120 });
      面板2 = await session2.js(读面板);
      ctx.assert('① 命中计数非零（面板里看得见 1 / 1）', 有命中2 && /1\s*\/\s*1/.test(面板2.计数), JSON.stringify(面板2));

      const 替换框点2 = await session2.js(面板点('[data-field="replace"]'));
      await session2.click(替换框点2.x, 替换框点2.y);
      await hi.sleep(200);
      await session2.type(换词2);
      await hi.sleep(300);
      const 按钮点 = await session2.js(面板点('[data-action="replace"]'));
      ctx.assert('① 面板里的「替换」按钮可点（鼠标入口）', 按钮点.ok, JSON.stringify(按钮点));
      await session2.click(按钮点.x, 按钮点.y);
      await hi.sleep(900);

      面板2 = await session2.js(读面板);
      const md1b = await hi.mdNow(session2);
      ctx.assert('① 鼠标点「替换」按钮后文档里出现替换后的文字、原来那处没了',
        String(md1b).includes(换词2) && !String(md1b).includes(查词2 + '\n'), 显(md1b));
      ctx.assert('① 面板回报「已替换 1 处」', /已替换\s*1\s*处/.test(面板2.状态), JSON.stringify(面板2));

      const 存3 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      ctx.witness('磁盘：替换后保存', { 行: 非空行(存3.after).map(显) }, 'disk');
      ctx.assert('①「替换」按钮的结果真的写进了磁盘', String(存3.after).includes(换词2) && !String(存3.after).includes(查词2 + '\n'), 显(存3.after));

      // ── ② 真实键盘 Esc 关面板（close() 把选区还给编辑面）→ Ctrl+Z ──────────────
      await session2.key({ key: 'Escape', code: 'Escape', vk: 27 });
      await hi.sleep(500);
      ctx.assert('② 真实键盘 Esc 关掉了查找面板', (await session2.js(读面板)).open === false, JSON.stringify(await session2.js(读面板)));
      const 焦点2 = await session2.js(读焦点);
      ctx.assert('② 关面板后焦点回到编辑面（Ctrl+Z 才会是文档的撤销）', 焦点2.在编辑面 === true, JSON.stringify(焦点2));
      ctx.assert('② 关面板后 hi.ensureFocus 仍报 ok', (await hi.ensureFocus(session2)).ok, '');

      await 撤销(session2);
      const 撤销后3 = await session2.js(读选区);
      const md5 = await hi.mdNow(session2);
      ctx.witness('几何：Esc 关面板之后 Ctrl+Z 的选区落点', 撤销后3, 'geometry');
      ctx.assert('②【硬红线】Ctrl+Z 之后光标/选区仍在编辑面内（Esc 入口同判据）',
        撤销后3.有选区 && 撤销后3.inSurface === true, JSON.stringify(撤销后3));
      ctx.assert('② 撤销后容器不是壳层 DIV、层级仍在正文里',
        撤销后3.有选区 && 撤销后3.在编辑面 === true && 撤销后3.node !== 'DIV', JSON.stringify({ node: 撤销后3.node, 容器: 撤销后3.容器, 链: 撤销后3.链 }));
      ctx.assert('② 撤销后光标矩形不得 0×0（Esc 入口同判据）',
        !(撤销后3.rect.w === 0 && 撤销后3.rect.h === 0), JSON.stringify({ rect: 撤销后3.rect, 容器: 撤销后3.容器 }));
      ctx.metric('148 Esc 入口撤销后光标矩形高度', 撤销后3.rect.h, { direction: 'higher', unit: 'px' });
      ctx.assert('② 撤销后内容逐字节回到替换前', md5 === md0b, JSON.stringify({ 撤销后: 显(md5) }));

      const 存4 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      ctx.witness('磁盘：撤销后保存（逐字节对比原件）', { 行: 非空行(存4.after).map(显), 与原件相同: 存4.after === 原件2 }, 'disk');
      ctx.assert('② 撤销后存盘：磁盘逐字节回到打开时', 存4.after === 原件2, JSON.stringify({ 盘: 显(存4.after), 原件: 显(原件2) }));
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：工具栏冷入口（载入后不点正文、rangeCount=0）→ 替换 → Esc → Ctrl+Z ════
    // D′ 腿：toolbar.js 的 click 与 render/index.js 的菜单令不要求编辑面有焦点；冷启动
    // getSelection().rangeCount===0 时原生守卫直接返回、补喂静默空转——硬化支（无面内选区
    // 先把折叠选区落进首块首个非空文本节点）守的正是这条入口。突变 M3（只注硬化）只有本会话红。
    const file3 = hi.writeDoc('find-replace-first-edit-cold.md', BODY);
    const 原件3 = fs.readFileSync(file3, 'utf8');
    const session3 = await hi.openDoc(ctx, file3, { minBlocks: 5 });   // 注意：不 ensureFocus，保持冷态
    try {
      const md0c = await hi.mdNow(session3);
      const 冷选 = await session3.js(读选区);
      ctx.assert('会话三 前置：冷启动没有文档选区（rangeCount=0，这才是冷入口）',
        冷选.有选区 === false, JSON.stringify(冷选));
      const 冷焦点 = await session3.js(读焦点);
      ctx.assert('会话三 前置：焦点不在编辑面（activeElement 不是编辑面节点）',
        冷焦点.在编辑面 === false, JSON.stringify(冷焦点));

      const 工具栏点 = await session3.js(面里点(`d.querySelector('.vditor-toolbar [data-type="find-replace"]')`));
      ctx.assert('会话三 工具栏「查找和替换」按钮可点（真实鼠标入口）', 工具栏点.ok, JSON.stringify(工具栏点));
      await session3.click(工具栏点.x, 工具栏点.y);
      await hi.sleep(700);
      let 面板3 = await session3.js(读面板);
      ctx.assert('会话三 点工具栏按钮打开了面板且直接是替换模式',
        面板3.open === true && 面板3.替换行可见 === true, JSON.stringify(面板3));

      await session3.type(查词2);
      const 有命中3 = await session3.until(命中非零, { timeout: 20000, interval: 120 });
      面板3 = await session3.js(读面板);
      ctx.assert('会话三 命中计数非零（面板里看得见 1 / 1）',
        有命中3 && /1\s*\/\s*1/.test(面板3.计数), JSON.stringify(面板3));

      const 替换框点3 = await session3.js(面板点('[data-field="replace"]'));
      await session3.click(替换框点3.x, 替换框点3.y);
      await hi.sleep(200);
      await session3.type(换词2);
      await hi.sleep(300);
      const 按钮点3 = await session3.js(面板点('[data-action="replace"]'));
      ctx.assert('会话三 面板里的「替换」按钮可点', 按钮点3.ok, JSON.stringify(按钮点3));
      await session3.click(按钮点3.x, 按钮点3.y);
      await hi.sleep(900);
      const md1c = await hi.mdNow(session3);
      ctx.assert('会话三 冷入口替换真的发生（文档里出现替换后的文字、原来那处没了）',
        String(md1c).includes(换词2) && !String(md1c).includes(查词2 + '\n'), 显(md1c));

      await session3.key({ key: 'Escape', code: 'Escape', vk: 27 });
      await hi.sleep(500);
      const 焦点3 = await session3.js(读焦点);
      ctx.assert('会话三 Esc 关面板后焦点回到编辑面（Ctrl+Z 才是文档的撤销）',
        焦点3.在编辑面 === true, JSON.stringify(焦点3));

      await 撤销(session3);
      const 撤销后4 = await session3.js(读选区);
      const md2c = await hi.mdNow(session3);
      ctx.witness('几何：工具栏冷入口 Ctrl+Z 之后的选区落点', 撤销后4, 'geometry');
      ctx.assert('会话三【硬红线】Ctrl+Z 之后光标/选区仍在编辑面内（工具栏冷入口同判据）',
        撤销后4.有选区 && 撤销后4.inSurface === true, JSON.stringify(撤销后4));
      ctx.assert('会话三 撤销后容器不是壳层 DIV、且是文本层落点',
        撤销后4.有选区 && 撤销后4.在编辑面 === true && 撤销后4.node !== 'DIV', JSON.stringify({ node: 撤销后4.node, 容器: 撤销后4.容器, 链: 撤销后4.链 }));
      ctx.assert('会话三 撤销后光标矩形不得 0×0（硬化落点=首块首个非空文本节点，行盒可见）',
        !(撤销后4.rect.w === 0 && 撤销后4.rect.h === 0), JSON.stringify({ rect: 撤销后4.rect, 容器: 撤销后4.容器 }));
      ctx.metric('148 工具栏冷入口撤销后光标矩形高度', 撤销后4.rect.h, { direction: 'higher', unit: 'px' });
      ctx.assert('会话三 撤销后内容逐字节回到替换前', md2c === md0c, JSON.stringify({ 撤销后: 显(md2c) }));
    } finally {
      await ctx.release(session3);
    }
  },
};
