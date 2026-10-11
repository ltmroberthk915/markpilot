/** 153 · 图片锚行懒升格：裸 HTML 图块下方那条"临时新行"打字必须独立成段，不许把紧跟的标题吞成普通段落（U-088）
 *
 *  守的是什么：台账 U-088——点图片右侧空白会立一条"图片下方临时新行"（ZWSP 零宽锚）。当图片
 *  节点**即顶级块**（`<img …>` 裸 HTML 图块；鼠标拖拽缩放/粘贴 HTML 都会落成这一形态）时，锚落在
 *  编辑面 root 的裸文本位，首个字输入被 vendored 的**全篇重放**处理，Lute 把裸文本与紧跟的块并成
 *  一行：下一块是标题 ⇒ `插入甲### 标题甲`、H3 结构性消失、`###` 成字面量（r18-u088 A-确认 §一）；
 *  下一块是列表/引用 ⇒ 同样被拆成 P。修复＝ media-tools.js `锚输入摘除` 的**懒升格**支：只在**首个
 *  真实文本输入**那一刻把它升格成图片块之后的独立空段（点一下仍不改文档）。
 *
 *  判据（全部用户可见；主腿夹具＝`<img src="ufi-a.png" alt="html图">` + 空行 + `### 标题甲` + 空行 + `尾文。`）：
 *    ① 主腿：点图右空白 → 锚行（选区落 z@0、原生光标可见）→ **点一下（不打字）getValue 逐字节
 *       不变**（懒升格护栏，内存面）→ 逐字真实 insertText 打「插入甲」→ md = `<img …>\n\n插入甲\n\n
 *       ### 标题甲\n\n尾文。\n`（逐字节）；块序 `[DIV(html-block), P{插入甲}, H3{### 标题甲}, P{尾文。}]`；
 *       第 1 字后块数 3→4、第 2/3 字只改同一块；**标题三面**（tag=H3、heading-marker='### '、
 *       data-marker='#'）；打字后光标可见（h>0、层=正文）。
 *    ② 磁盘口径【A-040】：Ctrl+S 后断言 **盘 = getValue**（getValue 缓存/存盘时序工单未修，
 *       **不得用"盘=夹具"口径**——同会话前一条腿的旧内容会污染夹具对比）；盘上无 U+200B，
 *       `插入甲` 与 `### 标题甲` 各自独立成行。
 *    ③ 撤销链：打字后 Enter 造空段（【A-041】此时光标 0×0 属挂账、不判红、只记读数）→ 连续
 *       Ctrl+Z，**任一撤销步**都必须保住标题三面（判据按对抗轮修订 3：不求一步回原文）。
 *    ④ 退格不改级别：打字 → Enter 造空段 → 退格只删那条空段，md 回打字态，**H3/`### ` 完好、
 *       级别未被改**（坏态形态=`###`→`##`）。
 *    ⑤ md 四形态**不升格**（与装机基线逐字节同，行内语义不丢）：md 独占段图 / md 段中图 /
 *       图后同段文字 / 文末 md 图——打字并入图片行（`![靶图](ufi-a.png)插入甲…`），标题三面保真。
 *
 *  通道纪律：点右空白/点按钮走真实鼠标（press→release）；「插入甲」逐字走真实 `Input.insertText`
 *  （IME 上屏通道）；Enter/退格/Ctrl+Z/Ctrl+S 走真实键盘；每段读数前 hi.ensureFocus 前置。
 *  立锚偶发（147 台账：点右空白 1/3 偶发不立锚，两棵树共有 flake）→ 纪律化重试：同一手势换
 *  偏移（+30/+22/+38）各来一发、每发重断言"有锚+落锚+原生高>0"；真缺陷重试救不了。
 *
 *  突变点（r18-u088 §3.5 / r18-rev2 §D4 实测口径）：
 *    M1u 把升格支条件注成 `if(false)` → ① md 回坏态 `<img …>\n\n插入甲### 标题甲…`、标题=null、
 *       盘同坏 → ①/② 红（升格支是主腿唯一支点）；
 *    M3u 升格搬到 mousedown（点一下就造段）→ ①"点一下不改文档"红（反证懒升格必要）；
 *    M2u 注掉"块外无文字"检查 → ⑤ 段中图/图后同段文字两腿红（行内语义被劈段）。
 *
 *  已知边界（不判红、如实记账）：A-040 getValue 缓存/存盘时序（故②用 盘=getValue 口径）；
 *  A-041 打字后 Enter 光标 0×0（挂账，③只记读数）；A-042 真实 IME 组字上屏未测（insertText 通道
 *  除外）；HTML 行内图（`前文丙 <img …>`）形态编辑面里没有 `<img>` 元素、锚路进不去，空腿不测；
 *  ④b「图后同段文字」的 +30px 落点本来就在文字上、产品不立 ZWSP 锚（锚只在真右空白立，147
 *  契约）——该形态不判锚、只判"点一下不改文档 + md 逐字节同"（g153-1 实测收口：④b 无锚但
 *  md 与基线逐字节同）。
 *
 *  证人：geometry（锚位原生光标矩形 / 块序 / caret）+ disk（Ctrl+S 后逐字节读回）。
 *  素材：hi.writeDoc 现场生成，图片 hi.fixtures.png 现场画，不碰受保护素材房。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY1 = ['<img src="ufi-a.png" alt="html图">', '', '### 标题甲', '', '尾文。', ''].join('\n');
const EXPECT1 = ['<img src="ufi-a.png" alt="html图">', '', '插入甲', '', '### 标题甲', '', '尾文。', ''].join('\n');

/** md 四形态（不升格）夹具与装机基线逐字节期望（r18-rev2 §D2 矩阵）。 */
const 四形态 = [
  { 名: '①md独占段图', 夹具: ['![靶图](ufi-a.png)', '', '### 标题甲', '', '尾文。', ''].join('\n'),
    期望: ['![靶图](ufi-a.png)插入甲', '', '### 标题甲', '', '尾文。', ''].join('\n'), 有标题: true },
  { 名: '②md段中图', 夹具: ['前文丙 ![靶图](ufi-a.png)', '', '### 标题甲', '', '尾文。', ''].join('\n'),
    期望: ['前文丙 ![靶图](ufi-a.png)插入甲', '', '### 标题甲', '', '尾文。', ''].join('\n'), 有标题: true },
  { 名: '④b图后同段文字', 夹具: ['![靶图](ufi-a.png)后文丁', '', '### 标题甲', '', '尾文。', ''].join('\n'),
    期望: ['![靶图](ufi-a.png)插入甲后文丁', '', '### 标题甲', '', '尾文。', ''].join('\n'), 有标题: true },
  { 名: '⑤文末md图', 夹具: ['前文戊。', '', '![靶图](ufi-a.png)', ''].join('\n'),
    期望: ['前文戊。', '', '![靶图](ufi-a.png)插入甲', ''].join('\n'), 有标题: false },
];

/** 图片几何（顶层页坐标）：右外 N px 的点击点、加载态、节点类型。 */
const 图几何 = 偏 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const blk = owner && owner.parentElement ? owner.parentElement.getBoundingClientRect() : null;
  return { ok: true, 已加载: !!(img.complete && img.naturalWidth > 0),
    右外: { x: Math.round(frame.x + r.right + ${Number(偏) || 30}), y: Math.round(frame.y + r.top + r.height / 2) },
    在块内: !!blk && (r.right + ${Number(偏) || 30}) < blk.right,
    类型: owner ? owner.getAttribute('data-type') : null }; })()`;

const 等图 = `(() => { const w = ${hi.IF}, d = w.document;
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
  return !!(img && img.complete && img.naturalWidth > 0); })()`;

/** 锚读数：锚节点在不在、选区落不落 z@0、原生光标矩形（147 同款判据）。 */
const 读锚 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const img = [...s.querySelectorAll('img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const nx = owner && owner.nextSibling;
  const z = nx && nx.nodeType === 3 && nx.data.length === 1 && nx.data.charCodeAt(0) === 0x200b ? nx : null;
  const sel = w.getSelection(), r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let 落锚 = false;
  if (z && r) { try { const a = d.createRange(); a.setStart(z, 0); a.collapse(true);
    落锚 = r.collapsed && r.compareBoundaryPoints(Range.START_TO_START, a) === 0; } catch (e) { 落锚 = 'ERR'; } }
  const box = r ? r.getBoundingClientRect() : null;
  return { 有锚: !!z, 落锚, 原生高: box ? Math.round(box.height) : null,
    在面内: r ? s.contains(r.startContainer) : false }; })()`;

/** 块序：tag / data-type / 空段 / 文本（ZWSP 显示为 <z>）。 */
const 版面 = `(() => { const w = ${hi.IF}; if (!w || !w.document) return { ok: false };
  const d = w.document, s = d.querySelector('${hi.SURFACE}'); if (!s) return { ok: false };
  const 块 = [...s.children].map((b, i) => ({ i, tag: b.tagName, dt: b.getAttribute('data-type'),
    空: !String(b.textContent || '').replace(/[\\s\\u200b]/g, ''),
    文本: String(b.textContent || '').replace(/\\u200b/g, '<z>').replace(/\\s+/g, ' ').slice(0, 24) }));
  return { ok: true, 块 }; })()`;

/** 标题三面：tagName / heading-marker 文本 / data-marker / 文本。 */
const 读标题 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const h = s && s.querySelector('h1,h2,h3,h4,h5,h6');
  if (!h) return { 有: false };
  const mk = h.querySelector('[data-type="heading-marker"], .vditor-ir__marker--heading');
  return { 有: true, tag: h.tagName, marker: mk ? mk.textContent : null,
    dataMarker: h.getAttribute('data-marker'), 文本: String(h.textContent || ''),
    块序: [...s.children].indexOf(h) }; })()`;

const 显 = v => String(v).replace(/\n/g, '\\n');

/** 立锚：真实点图片右空白，纪律化重试（同一手势换偏移 +30/+22/+38；147 台账的偶发 flake）。 */
async function 立锚(ctx, session, 标签) {
  let 末读 = null;
  for (const [试, 偏] of [[1, 30], [2, 22], [3, 38]].entries()) {
    const ready = await session.until(等图, { timeout: 20000, interval: 120 });
    const g = await session.js(图几何(偏[1]));
    if (!ready || !g.ok || !g.已加载 || !g.在块内) { 末读 = { 有锚: false, 落锚: false, 原生高: null, 几何: g }; continue; }
    await session.click(g.右外.x, g.右外.y);
    await hi.sleep(520);
    末读 = await session.js(读锚);
    if (末读.有锚 && 末读.落锚 && 末读.原生高 > 0) return 末读;
    ctx.log(标签 + ' 立锚第' + 试 + '发未成（' + JSON.stringify(末读) + '）→ 换偏移重试（147 台账：点右空白偶发不立锚为既有 flake）');
    await hi.sleep(250);
  }
  return 末读;
}

async function 打字(session, 词, 拍间隔 = 400) {
  const 拍 = [];
  for (const 字 of 词) { await session.type(字); await hi.sleep(拍间隔); 拍.push(await session.js(版面)); }
  return 拍;
}

module.exports = {
  id: '153-image-anchor-promote',
  title: '图片锚行懒升格（U-088）：裸 HTML 图块下打字独立成段、标题三面保真、md 四形态不升格；退格不改级别、任一撤销步保标题',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/ufi-a.png`, hi.fixtures.png(200, 120, [90, 140, 90]));

    // ══ 会话一：主腿（裸 HTML 图 + 标题）+ 盘=getValue + 撤销链 ══════════════════════
    const file = hi.writeDoc('g153-html-anchor-h3.md', BODY1);
    const 原件 = fs.readFileSync(file, 'utf8');
    const session = await hi.openDoc(ctx, file, { minBlocks: 3 });
    try {
      ctx.assert('会话一 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');
      await session.until(等图, { timeout: 25000, interval: 120 });
      const 锚 = await 立锚(ctx, session, '①');
      ctx.assert('① 点图片右空白：锚行立起来（ZWSP 锚存在、选区落 z@0、原生光标高>0）',
        锚.有锚 === true && 锚.落锚 === true && 锚.原生高 > 0, JSON.stringify(锚));
      ctx.witness('几何：锚位原生光标', 锚, 'geometry');

      const md0 = await hi.mdNow(session);
      ctx.assert('① 懒升格护栏：点一下（不打字）文档一字不动（getValue 与夹具逐字节同；M3u 突变形态=点时就造空段）',
        String(md0).replace(/\r/g, '') === 原件.replace(/\r/g, ''), JSON.stringify({ md0: 显(md0) }));

      const 拍 = await 打字(session, '插入甲');
      ctx.assert('① 第 1 字「插」落下：块数 3→4、新块是独立段落 P{插}（升格在首个真实输入那一刻发生）',
        拍[0].ok && 拍[0].块.length === 4 && 拍[0].块[1].tag === 'P' && 拍[0].块[1].文本 === '插' && 拍[0].块[0].dt === 'html-block',
        JSON.stringify(拍[0].块));
      ctx.assert('① 第 2/3 字只改同一条新段（P{插入}→P{插入甲}），图片块/标题块不动',
        拍[1].块[1].文本 === '插入' && 拍[2].块[1].文本 === '插入甲' && 拍[2].块.length === 4, JSON.stringify(拍.map(p => p.块.map(b => b.tag + ':' + b.文本))));

      const md1 = await hi.mdNow(session);
      ctx.witness('磁盘前读数：打字后的 getValue 与块序', { md1: 显(md1), 块: 拍[2].块 }, 'geometry');
      ctx.assert('①【硬红线】打字后的 md：打的字独立成段、`### 标题甲` 仍独占一行（逐字节；坏态形态=`插入甲### 标题甲` 同行）',
        String(md1).replace(/\r/g, '') === EXPECT1, JSON.stringify({ md1: 显(md1), 期望: 显(EXPECT1) }));

      const 标1 = await session.js(读标题);
      ctx.assert('① 标题三面保真：tag=H3、heading-marker=`### `、data-marker=`#`、文本=`### 标题甲`',
        标1.有 === true && 标1.tag === 'H3' && 标1.marker === '### ' && 标1.dataMarker === '#' && 标1.文本 === '### 标题甲' && 标1.块序 === 2,
        JSON.stringify(标1));

      const 光 = await hi.caret(session);
      ctx.assert('① 打字后光标可见：在编辑面内、层=正文、落在第 1 块（新段）里、矩形高>0',
        光.ok === true && 光.层 === '正文' && 光.块 === 1 && 光.h > 0, JSON.stringify(光));

      const 存 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const 值后 = await hi.mdNow(session);
      ctx.witness('磁盘：打字后 Ctrl+S 读回', { 盘: 显(存.after), getValue: 显(值后), 含零宽: /\u200b/.test(String(存.after)) }, 'disk');
      ctx.assert('① 盘 = getValue（A-040 口径：getValue 缓存/存盘时序未修，不用"盘=夹具"）；盘上无 U+200B',
        String(存.after).replace(/\r/g, '') === String(值后).replace(/\r/g, '') && !/\u200b/.test(String(存.after)),
        JSON.stringify({ 盘: 显(存.after), getValue: 显(值后) }));
      ctx.assert('① 盘上 `插入甲` 与 `### 标题甲` 各自独立成行（磁盘证人）',
        /^插入甲$/m.test(String(存.after)) && /^### 标题甲$/m.test(String(存.after)), 显(存.after));
      ctx.metric('153 打字后块数', 拍[2].块.length, { direction: 'equal', unit: '块' });

      // ── ③ 撤销链：Enter 造空段 → 逐把 Ctrl+Z，任一步都要保住标题三面 ────────────────
      await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
      await hi.sleep(500);
      const 造段 = await session.js(版面);
      const 光E = await hi.caret(session);
      ctx.assert('③ 前置：打字后 Enter 在新段之后又起一条空段（块数 5、空段在标题之前）',
        造段.ok && 造段.块.length === 5 && 造段.块[2].空 === true, JSON.stringify(造段.块.map(b => b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));
      ctx.log('登记（A-041 挂账、不判红）：打字后 Enter 的光标读数=' + JSON.stringify({ 层: 光E.层, 块: 光E.块, h: 光E.h, x: 光E.x, y: 光E.y }));

      const 链 = [];
      for (let i = 1; i <= 8; i++) {
        await hi.combo(session, 'Ctrl+z');
        await hi.sleep(750);
        const md = await hi.mdNow(session);
        const 标 = await session.js(读标题);
        链.push({ 第: i, md: 显(md), 标 });
        ctx.assert('③ 撤销第 ' + i + ' 步后标题三面完好（H3/`### `/`#`；不求一步回原文）',
          标.有 === true && 标.tag === 'H3' && 标.marker === '### ' && 标.dataMarker === '#', JSON.stringify(标));
        if (String(md).replace(/\r/g, '') === 原件.replace(/\r/g, '')) { ctx.log('③ 撤销第 ' + i + ' 步回到原文'); break; }
      }
      ctx.witness('几何：撤销链逐步读数', 链, 'geometry');
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：连锁② 退格不改级别 ═════════════════════════════════════════════════
    const file2 = hi.writeDoc('g153-backspace-level.md', BODY1);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 3 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      await session2.until(等图, { timeout: 25000, interval: 120 });
      const 锚2 = await 立锚(ctx, session2, '④');
      ctx.assert('④ 前置：锚行立起来', 锚2.有锚 === true && 锚2.落锚 === true, JSON.stringify(锚2));
      await 打字(session2, '插入甲');
      const mdA = await hi.mdNow(session2);
      ctx.assert('④ 前置：打字态 md 与主腿逐字节同', String(mdA).replace(/\r/g, '') === EXPECT1, JSON.stringify({ mdA: 显(mdA) }));

      await session2.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
      await hi.sleep(500);
      const 造2 = await session2.js(版面);
      ctx.assert('④ 前置：Enter 造出空段（块 [DIV,P{插入甲},P{},H3,P]）',
        造2.ok && 造2.块.length === 5 && 造2.块[2].空 === true, JSON.stringify(造2.块.map(b => b.tag + (b.空 ? '(空)' : '') + ':' + b.文本)));

      await session2.key({ key: 'Backspace', code: 'Backspace', vk: 8 });
      await hi.sleep(600);
      const mdB = await hi.mdNow(session2);
      const 退后 = await session2.js(版面);
      const 标2 = await session2.js(读标题);
      ctx.assert('④ 退格只删那条空段：md 逐字节回到打字态（坏态形态=退格把 `###` 改成 `##`）',
        String(mdB).replace(/\r/g, '') === EXPECT1, JSON.stringify({ mdB: 显(mdB) }));
      ctx.assert('④ 退格后块序回到 4 块、新段内容仍是 `插入甲`',
        退后.ok && 退后.块.length === 4 && 退后.块[1].文本 === '插入甲', JSON.stringify(退后.块.map(b => b.tag + ':' + b.文本)));
      ctx.assert('④ 退格后标题级别未被改：仍是 H3、`### `、`#`（坏态形态=H2/`## `）',
        标2.有 === true && 标2.tag === 'H3' && 标2.marker === '### ' && 标2.dataMarker === '#', JSON.stringify(标2));

      const 存2 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      const 值2 = await hi.mdNow(session2);
      ctx.witness('磁盘：退格链收尾存盘', { 盘: 显(存2.after), getValue: 显(值2) }, 'disk');
      ctx.assert('④ 盘 = getValue（A-040 口径）、无 U+200B',
        String(存2.after).replace(/\r/g, '') === String(值2).replace(/\r/g, '') && !/\u200b/.test(String(存2.after)),
        JSON.stringify({ 盘: 显(存2.after), getValue: 显(值2) }));
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三～六：md 四形态不升格（与装机基线逐字节同） ═════════════════════════════
    // 锚前置只对"真右空白"形态（①②⑤：图右是空白带）成立；④b 图后紧贴同段文字，+30px 落点
    // 本来就在文字上——产品不立 ZWSP 锚（锚只在真空白带立，147 契约），光标直接落在图片后。
    // 所以④b不判锚、只判"点一下不改文档 + 打字后与基线逐字节同"（g153-1 实测：④b 无锚但
    // md 逐字节同、其余三形有锚——判据按实测产品行为收口，锚不是本门的主语）。
    for (const 形 of 四形态) {
      const fileX = hi.writeDoc('g153-md-form-' + 形.名 + '.md', 形.夹具);
      const 原件X = fs.readFileSync(fileX, 'utf8');
      const sessionX = await hi.openDoc(ctx, fileX, { minBlocks: 2 });
      try {
        ctx.assert(形.名 + ' 焦点在编辑器', (await hi.ensureFocus(sessionX)).ok, '');
        await sessionX.until(等图, { timeout: 25000, interval: 120 });
        const gX = await sessionX.js(图几何(30));
        ctx.assert(形.名 + ' 前置：图片已加载、拿到右空白/图右的有效点击点', gX.ok && gX.已加载 === true, JSON.stringify(gX));
        await sessionX.click(gX.右外.x, gX.右外.y);
        await hi.sleep(520);
        const 锚X = await sessionX.js(读锚);
        const md点后 = await hi.mdNow(sessionX);
        ctx.assert(形.名 + ' 点一下不改文档（getValue 与夹具逐字节同；M3u 突变形态=点时就造空段）',
          String(md点后).replace(/\r/g, '') === 形.夹具.replace(/\r/g, ''), JSON.stringify({ md点后: 显(md点后) }));
        const 光点 = await hi.caret(sessionX);
        ctx.assert(形.名 + ' 点后光标在编辑面内（落点有效，这一腿的打字才有意义）',
          光点.ok === true, JSON.stringify(光点));
        await 打字(sessionX, '插入甲', 340);
        const mdX = await hi.mdNow(sessionX);
        ctx.assert(形.名 + '【不升格】打字并入图片行、md 与装机基线逐字节同（M2u 突变形态=被劈成独立段，行内语义丢失）',
          String(mdX).replace(/\r/g, '') === 形.期望, JSON.stringify({ mdX: 显(mdX), 期望: 显(形.期望), 夹具: 显(原件X) }));
        if (形.有标题) {
          const 标X = await sessionX.js(读标题);
          ctx.assert(形.名 + ' 标题三面保真', 标X.有 === true && 标X.tag === 'H3' && 标X.marker === '### ' && 标X.dataMarker === '#', JSON.stringify(标X));
        }
        ctx.witness('几何：' + 形.名 + ' 点后锚读数与打字后 md', { 锚: 锚X, md: 显(mdX) }, 'geometry');
      } finally {
        await ctx.release(sessionX);
      }
    }
  },
};
