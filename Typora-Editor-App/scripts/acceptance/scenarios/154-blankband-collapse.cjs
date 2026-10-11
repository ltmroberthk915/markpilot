/** 154 · 块外空白收起：点空标题行下方那道谁也分不清的空白带，已展开的图片源码必须收起、光标必须画得出来（U-086）
 *
 *  守的是什么：台账 U-086——空标题折叠态记号 `width:0;height:0`，那一行没有任何墨水，用户点
 *  "标题那一行"时落点很容易越过块盒下沿，落进**标题盒与图片块之间那道 20px 空白带**（事件目标
 *  是编辑面壳）。点击分类器对它一次都没接管，vendored `B()` 又按 Blink 的原生落点（解进图片
 *  源码行）把 `--expand` 加回图片节点——用户看到"点了标题行，源码刚摘掉又被加回来"。
 *  修复＝ media-tools.js 的「块外空白确定性收起臂」（捕获相位钉位+收起、放行给 B() 收尾）＋
 *  R-1 拖拽闸（按下→抬起位移 ≤4px 才算单击，拖选不丢）。
 *
 *  夹具：`# `（空 h1）+ 空行 + `![靶图](shot-u086.png)` + 空行 + `正文甲。` + …（r18-u086 A-方案同款）。
 *  起手＝真双击图片（clickCount 1→2，间隔 240ms）把源码展开，再真鼠标单击各落点。
 *
 *  判据（全部用户可见）：
 *    ① 带内三落点：点 标题盒底 +4 / +8 / +14 → 图片源码**折叠**、终态 展开集=["H1"]（空标题
 *       自己被 --expand，`#` 与光标一起画出来）、光标矩形高>0 且在编辑面内。
 *    ② 盒内三点仍折（2.3.2 既绿，不许回退）：`#` 位 / 行中 / 行右缘 → 同①的收起/展开集判据，
 *       光标仍在编辑面内的标题里；**盒内光标矩形 0×0 是空标题的既有现象**（A-方案 §5 记账、
 *       本门不判红——"rect>0"判据属带内落点①那条腿，g154-1 实测收口：三点都折、行中/行右缘
 *       光标 0×0、#位光标可见）。
 *    ③ +20 不动（反例4 域）：点 图片块盒内那一格 → 源码**保持展开**（只钉不折＝既有契约，
 *       用户眼里的"点图片"在那一格语义成立，R-4 记账维持）。
 *    ④ R-1 拖拽闸：源码展开时从正文拖到那道带 → 选区**不折**（非折叠、非空、含起点文字；
 *       无闸形态=选区当场被折成光标）。
 *    ⑤ 全程零编辑：收尾存盘磁盘逐字节＝原文（点击/拖拽/收起都不改文档）。
 *
 *  通道纪律：展开走真实双击（系统双击计数 1→2）；落点全走真实单击（press→release）；拖拽＝
 *  按下 → 多次移动 → 抬起（hi.drag）；每条腿前重新展开、重新量盒（先 scrollIntoView 后量盒，
 *  B-对抗评审 §6 的滚动污染教训）；坐标=顶层页坐标（帧内 rect + frame offset）；可见性=DOM
 *  矩形口径。展开偶发不成就换发重试（产品真把连点弄坏时重试救不了）。
 *
 *  突变点（r18-u086 §6 / B-对抗评审 §7 实测口径）：
 *    M-1 注掉整个"块外空白"臂 → ① 全红（带内落点全部"源码仍在"，即 2.3.2 红基线）；
 *    M-2 只注掉"钉位"（保留显式收起）→ ① 仍红（B() 按 Blink 落点把 --expand 加回图片）；
 *    M-3 只注掉"显式收起+出册"、M-6 注掉"落点下方还有块"闸 → **不翻红**（兜底防御，不是
 *       唯一支点——如实记账，不写成"必红"，2.3.2 §3.3 的教训）。
 *
 *  已知边界（不判红、如实记账）：③那一格是反例4 钉住支的既有契约（144②/140⑬ 护栏，R-4）；
 *  S3 形态（点空白把**已折叠**的源码顶出来）＝闸①漏面，R-2 未采纳、登记 F1 族挂账；空列表项/
 *  空引用盒内点击"源码折了、光标 0×0"的既有现象不碰（未-4）；文末空白追加新段语义归 150⑨
 *  （两道闸就是为它设的）；容器内图（列表/引用/表格里）点容器内空白不折（未-1）。
 *
 *  证人：geometry（带点/展开集/光标矩形/选区）+ disk（收尾逐字节）。
 *  素材：hi.writeDoc 现场生成，图片 hi.fixtures.png 现场画。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# ', '', '![靶图](shot-u086.png)', '', '正文甲。', '', '## 有内容标题', '', '正文乙。', ''].join('\n');

/** 带几何（顶层页坐标）：先 scrollIntoView 再量盒（B-评审 §6：滚动前量盒会被长文档污染）。 */
const 带几何 = `(() => { const f = document.getElementById('editor'); const fr = f.getBoundingClientRect();
  const w = f.contentWindow, d = w.document, s = d.querySelector('${hi.SURFACE}');
  if (!s || s.children.length < 3) return { ok: false, why: '块数不足' };
  const h1 = s.children[0];
  h1.scrollIntoView({ block: 'center', behavior: 'instant' });
  const img = [...s.querySelectorAll('img')].pop();
  if (!img) return { ok: false, why: '没有图片' };
  const owner = img.closest('.vditor-ir__node[data-type]');
  let blk = owner; while (blk && blk.parentElement && blk.parentElement !== s) blk = blk.parentElement;
  const hb = h1.getBoundingClientRect(), bb = blk.getBoundingClientRect(), ib = img.getBoundingClientRect();
  const T = r => ({ l: Math.round(fr.x + r.left), t: Math.round(fr.y + r.top), r: Math.round(fr.x + r.right), b: Math.round(fr.y + r.bottom) });
  return { ok: true, 标题: { tag: h1.tagName, 盒: T(hb) },
    图块: { 盒: T(bb), 类型: owner ? owner.getAttribute('data-type') : null },
    图: { 盒: T(ib), 加载: !!(img.complete && img.naturalWidth > 0),
      中心: { x: Math.round(fr.x + ib.left + ib.width / 2), y: Math.round(fr.y + ib.top + ib.height / 2) } } }; })()`;

const 图展开布尔 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const img = [...s.querySelectorAll('img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  return !!(owner && owner.classList.contains('vditor-ir__node--expand')); })()`;

/** 终态读数：图展开？展开集（tag[文本]@块序）？光标矩形/层级。 */
const 读展开 = `(() => { const w = ${hi.IF}, d = w.document, s = d.querySelector('${hi.SURFACE}');
  const img = [...s.querySelectorAll('img')].pop();
  const owner = img && img.closest('.vditor-ir__node[data-type]');
  const 集 = [...s.querySelectorAll('.vditor-ir__node--expand')].map(n => {
    let top = n; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
    const 文 = String(n.textContent || '').replace(/\\s+/g, '');
    return n.tagName + '[' + (文 ? 文.slice(0, 6) : 'null') + ']@' + [].indexOf.call(s.children, top); });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const box = r ? r.getBoundingClientRect() : null;
  const el = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  return { 图展开: !!(owner && owner.classList.contains('vditor-ir__node--expand')), 展开集: 集,
    光标: r ? { 在面内: s.contains(r.startContainer), 折叠: r.collapsed,
      在标题: !!(el && el.closest && el.closest('h1,h2,h3,h4,h5,h6')),
      h: box ? Math.round(box.height) : null, w: box ? Math.round(box.width) : null } : null }; })()`;

/** 正文文字点（顶层页坐标）。 */
const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const fr = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => String(p.textContent || '').includes(${JSON.stringify(词)}));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect();
  return { ok: true, x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.top + r.height / 2) }; })()`;

/** 真双击图片展开源码（clickCount 1→2、间隔 240ms；不成就换发重试）。 */
async function 展开图(ctx, session) {
  for (let 试 = 1; 试 <= 3; 试++) {
    const g = await session.js(带几何);
    if (!g.ok || !g.图.加载) { await hi.sleep(400); continue; }
    for (const count of [1, 2]) {
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.图.中心.x, y: g.图.中心.y, button: 'left', buttons: 1, clickCount: count });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.图.中心.x, y: g.图.中心.y, button: 'left', buttons: 0, clickCount: count });
      if (count === 1) await hi.sleep(240);
    }
    const 展 = await session.until(图展开布尔, { timeout: 6000, interval: 120 });
    if (展) return await session.js(带几何);
    ctx.log('展开图第 ' + 试 + ' 发未展开（138 契约：连点必展开）→ 重试');
    await hi.sleep(300);
  }
  return await session.js(带几何);
}

/** 一条点击腿：重新展开 → 真实单击 → 终态读数。 */
async function 点击腿(ctx, session, 点, 标签) {
  const g = await 展开图(ctx, session);
  const 起展开 = await session.js(图展开布尔);
  await session.click(点.x, 点.y);
  await hi.sleep(460);
  const 后 = await session.js(读展开);
  return { 标签, 点, 起展开, 后, 带几何: { 标题盒: g.标题.盒, 图块盒: g.图块.盒 } };
}

module.exports = {
  id: '154-blankband-collapse',
  title: '块外空白收起（U-086）：点空标题行下那道空白带 → 图片源码收起+光标可见+展开集=[H1]；盒内仍折；图片块盒内不动；拖拽不折选区',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-u086.png'), hi.fixtures.png(160, 100, [230, 120, 60]));
    const file = hi.writeDoc('g154-blankband.md', BODY);
    const 原件 = fs.readFileSync(file, 'utf8');
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    try {
      ctx.assert('前置：焦点在编辑器', (await hi.ensureFocus(session)).ok, '');
      const 图就绪 = await session.until(`(() => { const w = ${hi.IF}, d = w.document;
        const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop();
        return !!(img && img.complete && img.naturalWidth > 0); })()`, { timeout: 25000, interval: 120 });
      const g0 = await session.js(带几何);
      const 带宽 = g0.ok ? g0.图块.盒.t - g0.标题.盒.b : -1;
      ctx.assert('前置：图片已加载、空标题块在最上（H1）、标题盒与图片块之间那道带 ≥15px（+14 的落点才落得进带内）',
        图就绪 && g0.ok && g0.标题.tag === 'H1' && 带宽 >= 15, JSON.stringify({ 图就绪, g0, 带宽 }));
      ctx.witness('几何：带几何（标题盒/图块盒/带宽）', { 标题盒: g0.标题.盒, 图块盒: g0.图块.盒, 带宽, 类型: g0.图块.类型 }, 'geometry');

      // ── ① 带内三落点：+4 / +8 / +14 → 折叠 + 光标 rect>0 + 展开集=["H1"] ────────────
      const 带读数 = [];
      for (const dy of [4, 8, 14]) {
        const g = await 展开图(ctx, session);
        const 点 = { x: g.标题.盒.l + 80, y: g.标题.盒.b + dy };
        const r = await 点击腿(ctx, session, 点, '带内+' + dy);
        带读数.push(r);
        ctx.assert('① 带内 +' + dy + ' 前置：点击前源码确实已展开', r.起展开 === true, JSON.stringify(r));
        ctx.assert('① 带内 +' + dy + '：点下去图片源码**收起**（M-1 突变形态=源码仍在；2.3.2 红基线即此）',
          r.后.图展开 === false, JSON.stringify(r.后));
        ctx.assert('① 带内 +' + dy + '：终态展开集=["H1"]——空标题自己被 --expand（`#` 与光标一起画出来）、别无其它展开块',
          r.后.展开集.length === 1 && /^H1\[/.test(r.后.展开集[0]), JSON.stringify(r.后.展开集));
        ctx.assert('① 带内 +' + dy + '：光标画得出来（DOM 矩形高>0、在编辑面内、在标题里）',
          !!r.后.光标 && r.后.光标.h > 0 && r.后.光标.在面内 === true && r.后.光标.在标题 === true, JSON.stringify(r.后.光标));
      }
      ctx.witness('几何：带内三落点终态', 带读数, 'geometry');
      ctx.metric('154 带内收起成功落点数', 带读数.filter(r => r.后.图展开 === false).length, { direction: 'equal', unit: '点' });

      // ── ② 盒内三点仍折（2.3.2 既绿，不许回退） ────────────────────────────────────
      const 盒读数 = [];
      const g盒 = await 展开图(ctx, session);
      const hb = g盒.标题.盒;
      const 盒内点 = [
        { 名: '#位', x: hb.l + 8, y: Math.round((hb.t + hb.b) / 2) },
        { 名: '行中', x: Math.round((hb.l + hb.r) / 2), y: Math.round((hb.t + hb.b) / 2) },
        { 名: '行右缘', x: hb.r - 8, y: Math.round((hb.t + hb.b) / 2) },
      ];
      for (const p of 盒内点) {
        const r = await 点击腿(ctx, session, { x: p.x, y: p.y }, '盒内·' + p.名);
        盒读数.push(r);
        ctx.assert('② 盒内·' + p.名 + ' 前置：点击前源码已展开', r.起展开 === true, JSON.stringify(r));
        ctx.assert('② 盒内·' + p.名 + ' 仍折：源码收起、终态展开集=["H1"]（光标仍在编辑面内的标题里；'
          + '光标矩形 0×0 是空标题盒内的既有现象，A-方案 §5 记账不判红——「rect>0」判据属带内落点那条腿）',
          r.后.图展开 === false && r.后.展开集.length === 1 && /^H1\[/.test(r.后.展开集[0])
            && !!r.后.光标 && r.后.光标.在面内 === true && r.后.光标.在标题 === true,
          JSON.stringify(r.后));
      }
      ctx.witness('几何：盒内三点终态', 盒读数, 'geometry');

      // ── ③ +20 不动（反例4 域）：图片块盒内那一格 → 只钉不折（既有契约） ──────────────
      const g20 = await 展开图(ctx, session);
      const 点20 = { x: g20.标题.盒.l + 80, y: g20.图块.盒.t + 2 };
      const r20 = await 点击腿(ctx, session, 点20, '图块盒内一格');
      ctx.assert('③ 前置：点击前源码已展开', r20.起展开 === true, JSON.stringify(r20));
      ctx.assert('③ 图片块盒内那一格（用户眼里的"点图片"）：源码**保持展开**（反例4 只钉不折＝既有契约，不许把 144②/140⑬ 护栏弄红）',
        r20.后.图展开 === true, JSON.stringify(r20.后));
      ctx.witness('几何：图块盒内一格终态（反例4 域）', r20, 'geometry');

      // ── ④ R-1 拖拽闸：源码展开时从正文拖到那道带 → 选区不折 ─────────────────────────
      const g拖 = await 展开图(ctx, session);
      const 正文 = await session.js(文本点('正文甲'));
      ctx.assert('④ 前置：拿到正文甲的拖拽起点', 正文.ok === true, JSON.stringify(正文));
      const 带点 = { x: g拖.标题.盒.l + 80, y: g拖.标题.盒.b + 8 };
      await hi.drag(session, { x: 正文.x, y: 正文.y }, 带点, { steps: 10, after: 520 });
      const 选 = await hi.caret(session);
      ctx.assert('④ R-1 拖拽闸：从正文拖到那道带，选区**不折**（非折叠、非空、含起点文字；无闸形态=选区当场被折成光标）',
        选.折叠 === false && 选.选区长 > 0 && /正/.test(String(选.选区)), JSON.stringify(选));
      ctx.witness('几何：R-1 拖拽后的选区', { 起点: { x: 正文.x, y: 正文.y }, 终点: 带点, 选区: 选.选区, 长: 选.选区长, 折叠: 选.折叠 }, 'geometry');

      // ── ⑤ 全程零编辑：收尾存盘磁盘逐字节＝原文 ────────────────────────────────────
      const md尾 = await hi.mdNow(session);
      ctx.assert('⑤ 点击/拖拽/收起全程零编辑（getValue 逐字节＝原文）',
        String(md尾).replace(/\r/g, '') === 原件.replace(/\r/g, ''), JSON.stringify({ md尾: String(md尾).replace(/\n/g, '\\n') }));
      const 存尾 = await hi.edge.saveAndWait(session, file, { timeout: 3000 });
      ctx.witness('磁盘：收尾存盘', { 盘: String(存尾.after).replace(/\n/g, '\\n'), 与原文同: String(存尾.after).replace(/\r/g, '') === 原件.replace(/\r/g, '') }, 'disk');
      ctx.assert('⑤ 磁盘逐字节＝原文（收起臂不许弄脏文档）',
        String(存尾.after).replace(/\r/g, '') === 原件.replace(/\r/g, ''), JSON.stringify({ 盘: String(存尾.after).replace(/\n/g, '\\n'), 原: 原件.replace(/\n/g, '\\n') }));
    } finally {
      await ctx.release(session);
    }
  },
};
