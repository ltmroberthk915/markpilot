/** 140 · 图片出源码：点两下必出，且**不看快慢**（不依赖系统双击时间间隔）
 *
 *  用户 2026-10-05 报（问题2）：「现在点击图片虽然不会导致源码录出来的时候闪烁，但是有可能
 *  需要点击随机次数多次图片才会露出源码，这是没有解决的问题。你需要实现的效果，点击图片
 *  之后能立刻准确稳定展现源码。」
 *
 *  根因取证：出源码这条路原来只挂在 `event.detail>=2` 上，而 detail 由**操作系统双击计数**
 *  决定——两次点击的间隔超过系统阈值（默认 500ms）时，浏览器给出的就是两次 detail=1 的
 *  独立单击。于是"点快了出、点慢了永远只选中"，用户感受到的是"要点随机下数才出来"。
 *  本场景因此把**点击间隔**当成一等公民来测（CDP 不会自己推断双击，clickCount 必须按
 *  系统规则给：相邻两次间隔 ≤480ms 且位移 ≤4px 时递增，否则归 1）。
 *
 *  修复后的契约：
 *    ① 第 1 下单击 = 只选中（typora-img-selected），**不许**展开（既有契约，不回退）；
 *    ② 第 2 下点击（无论间隔 700ms 还是 150ms）= 确定性展开源码，并把光标放进源码；
 *    ③ 第 3 下及以后 = 展开态恒定，不许被连点次数奇偶折回去；
 *    ④ 同一手势重复 10 轮，轮轮都要出（"随机"这个词必须从这条路上消失）。
 *
 *  同族扩面：裸 HTML 图块 `<img …>`（另一种图片形态）走同一契约。
 *
 *  护栏（不许改坏的既有语义）：
 *    · Alt+单击 = 展开源码（老手势）；
 *    · Ctrl+单击 = 多选，不许展开；
 *    · 图上起手拖出去仍是原生拖选，文档零改动（磁盘逐字节）；
 *    · Esc = 收起。
 *
 *  突变验证（把修复注掉必须变红）：
 *    · 注掉 media-tools.js 的 click 里「第 2 下（已选/已展开快照）确定性展开」那一支
 *      → ② 的 700ms 腿与 ④ 的 10 轮全部变红（回到"只有双击才出"）。
 *
 *  证人：几何（展开态 + 光标层）+ 磁盘（拖选前后逐字节）。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const BODY = ['# 图P', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');
const BODY_HTML = ['# 图H', '', '前文甲。', '', '<img src="shot-blue.png" alt="html图" width="160">', '', '后文乙。', ''].join('\n');

/** 图片几何 + 展开态 + 选中态 + 光标层（一条读数把四个问题一起答了）。 */
const 读图 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const sel = w.getSelection(); const rr = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = rr ? (rr.startContainer.nodeType === 3 ? rr.startContainer.parentElement : rr.startContainer) : null;
  return { ok: true, 中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    类型: owner ? owner.getAttribute('data-type') : null,
    展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
    选中: !!img.classList.contains('typora-img-selected'),
    多选: !!img.classList.contains('typora-img-multi-selected'),
    光标在源码: !!(rr && at && owner && owner.contains(at) && at.closest('code[data-type],.vditor-ir__marker')) }; })()`;

const 文本点 = 词 => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${词}'));
  if (!t) return { ok: false };
  const r = t.getBoundingClientRect(); return { ok: true, x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

/** 拟真连点：按 OS 双击计数规则发 clickCount（间隔 ≤480ms 且位移 ≤4px 时递增，否则归 1）。
 *  CDP 的 dispatchMouseEvent 不会自己推断双击，clickCount 必须由调用方给——给成恒定 1
 *  就等于"真人慢慢点"，给成递增就等于"真人快速连点"，两种都是真实通道。 */
async function 拟真连点(session, 点, 次数, 间隔) {
  let count = 0, last = -1e9, lx = 0, ly = 0;
  for (let i = 0; i < 次数; i++) {
    if (i) await hi.sleep(间隔);
    const now = Date.now();
    count = (now - last <= 480 && Math.abs(点.x - lx) <= 4 && Math.abs(点.y - ly) <= 4) ? count + 1 : 1;
    last = now; lx = 点.x; ly = 点.y;
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: count });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: count });
    await hi.sleep(120);
  }
  await hi.sleep(420);
}

module.exports = {
  id: '140-image-reveal-gesture-matrix',
  title: '图片出源码：第 1 下选中、第 2 下必出（快慢点击都算），连点不折回、10 轮稳定',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));

    // ══ 会话一：Markdown 图 ══════════════════════════════════════════════════════
    const file = hi.writeDoc('image-reveal-family.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4 });
    try {
      ctx.assert('会话一 焦点在编辑器（鼠标类读数前置）', (await hi.ensureFocus(session)).ok, '');
      const 文 = await session.js(文本点('后文乙'));
      ctx.assert('会话一 拿到正文复位点', 文.ok, JSON.stringify(文));

      // ── ① 护栏：单击 1 次=只选中、不许展开 ────────────────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(320);
      const g0 = await session.js(读图);
      await 拟真连点(session, g0.中心, 1, 500);
      const 一 = await session.js(读图);
      ctx.assert('① 单击图片 1 次：只选中、不展开（既有契约）',
        一.选中 === true && 一.展开 === false, JSON.stringify(一));
      await session.shot('140-①单击一次-只选中');

      // ── ② 核心新契约：慢点两下（间隔 700ms，clickCount 恒 1）必出源码 ──────────
      await session.click(文.x, 文.y); await hi.sleep(320);
      const g1 = await session.js(读图);
      await 拟真连点(session, g1.中心, 2, 700);
      const 慢 = await session.js(读图);
      ctx.assert('② 慢点两下（700ms 间隔、系统不给双击计数）：源码必须出来',
        慢.展开 === true, JSON.stringify(慢));
      ctx.assert('② 慢点两下：光标落进图片源码（用户能直接改路径/宽度）',
        慢.光标在源码 === true, JSON.stringify(慢));
      await session.shot('140-②慢点两下-必出源码');
      ctx.witness('几何：慢点两下后的展开态与光标层', 慢, 'geometry');

      // ── ③ 快点两下（150ms，clickCount 递增）：同样必出 ─────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(320);
      const g2 = await session.js(读图);
      await 拟真连点(session, g2.中心, 2, 150);
      const 快 = await session.js(读图);
      ctx.assert('③ 快点两下（150ms、系统双击计数=2）：源码必须出来、光标进源码',
        快.展开 === true && 快.光标在源码 === true, JSON.stringify(快));

      // ── ④ 连点 3/4/6 下：展开态恒定，不许被奇偶折回 ──────────────────────────
      for (const [次数, 间隔] of [[3, 150], [4, 150], [3, 700], [6, 700]]) {
        await session.click(文.x, 文.y); await hi.sleep(320);
        const 前置 = await session.js(读图);
        ctx.assert(`④ 连点 ${次数} 下@${间隔}ms 前置：复位后是折叠态`, 前置.展开 === false, JSON.stringify(前置));
        await 拟真连点(session, 前置.中心, 次数, 间隔);
        const 终 = await session.js(读图);
        ctx.assert(`④ 连点 ${次数} 下@${间隔}ms：展开态不许被次数奇偶折回`, 终.展开 === true, JSON.stringify(终));
      }

      // ── ⑤ 稳定性：10 轮"复位→慢点两下"，轮轮都要出（"随机"必须消失） ────────────
      let 命中 = 0;
      const 明细 = [];
      for (let 轮 = 1; 轮 <= 10; 轮++) {
        await session.click(文.x, 文.y); await hi.sleep(300);
        const g = await session.js(读图);
        await 拟真连点(session, g.中心, 2, 700);
        const 终 = await session.js(读图);
        if (终.展开 === true) 命中 += 1;
        else 明细.push(轮);
        if (轮 === 1) await session.shot('140-⑤稳定轮-第1轮');
      }
      ctx.assert('⑤ 慢点两下重复 10 轮：10/10 都要出源码（不许出现随机失败轮）',
        命中 === 10, `命中 ${命中}/10，未出轮次 ${JSON.stringify(明细)}`);
      ctx.metric('图片慢点两下命中数', 命中, { unit: '轮', direction: 'higher', values: [命中] });

      // ── ⑥ 护栏：Esc 收起 ──────────────────────────────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(300);
      const g3 = await session.js(读图);
      await 拟真连点(session, g3.中心, 2, 700);
      ctx.assert('⑥ 前置：源码已展开', (await session.js(读图)).展开 === true, '');
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); await hi.sleep(420);
      ctx.assert('⑥ 护栏：Esc 收起源码', (await session.js(读图)).展开 === false, '');

      // ── ⑦ 护栏：Alt+单击=展开（老手势） ──────────────────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(300);
      const g4 = await session.js(读图);
      await session.click(g4.中心.x, g4.中心.y, { modifiers: hi.MOD.alt }); await hi.sleep(460);
      const 老 = await session.js(读图);
      ctx.assert('⑦ 护栏：Alt+单击仍确定性展开源码、光标在源码里',
        老.展开 === true && 老.光标在源码 === true, JSON.stringify(老));

      // ── ⑧ 护栏：Ctrl+单击=多选，不许展开 ─────────────────────────────────────
      await session.click(文.x, 文.y); await hi.sleep(300);
      const g5 = await session.js(读图);
      await session.click(g5.中心.x, g5.中心.y, { modifiers: hi.MOD.ctrl }); await hi.sleep(460);
      const 多 = await session.js(读图);
      ctx.assert('⑧ 护栏：Ctrl+单击=多选、不展开',
        多.多选 === true && 多.展开 === false, JSON.stringify(多));

      // ── ⑨ 护栏：图上起手拖出去仍是原生拖选，文档零改动（磁盘） ────────────────
      await session.click(文.x, 文.y); await hi.sleep(320);
      const g6 = await session.js(读图);
      const 前盘 = fs.readFileSync(file);
      await hi.drag(session, { x: g6.中心.x, y: g6.中心.y }, { x: 文.x, y: 文.y }, { steps: 8, after: 460 });
      const 选 = await hi.caret(session);
      ctx.assert('⑨ 护栏：图上起手拖出去仍是原生拖选（选区非空）',
        !选.折叠 && 选.选区长 > 0, JSON.stringify(选));
      const 后盘 = fs.readFileSync(file);
      ctx.assert('⑨ 护栏：拖选不改文档（磁盘逐字节相同）', 前盘.equals(后盘), `前 ${前盘.length}B 后 ${后盘.length}B`);
      ctx.witness('磁盘：图上拖选前后', { 相同: 前盘.equals(后盘), 字节: 后盘.length }, 'disk');

      // ── ⑪ 打断矩阵：凡是**清掉了蓝框却没有产生 click** 的打断（Esc / 删除失败路径），
      //    之后的第一击必须只是"重新上蓝框"，不许直接弹源码；第二击才出。──────────────
      for (const 打断 of ['Esc', '点正文']) {
        await session.click(文.x, 文.y); await hi.sleep(300);
        const gA = await session.js(读图);
        await 拟真连点(session, gA.中心, 1, 500);          // 第 1 下：只上蓝框
        const 蓝A = await session.js(读图);
        ctx.assert(`⑪ 打断(${打断}) 前置：第 1 下只上蓝框、不出源码`, 蓝A.选中 === true && 蓝A.展开 === false, JSON.stringify(蓝A));
        if (打断 === 'Esc') { await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); }
        else { await session.click(文.x, 文.y); }
        await hi.sleep(420);
        const 断 = await session.js(读图);
        ctx.assert(`⑪ 打断(${打断})：打断后画面上没有蓝框`, 断.选中 === false && 断.展开 === false, JSON.stringify(断));
        await 拟真连点(session, 断.中心, 1, 700);           // 打断后的"第一击"
        const 一A = await session.js(读图);
        ctx.assert(`⑪ 打断(${打断}) 之后的第一击：只重新上蓝框，**不许**弹源码`,
          一A.选中 === true && 一A.展开 === false, JSON.stringify(一A));
        await 拟真连点(session, 一A.中心, 1, 700);          // 第二击
        const 二A = await session.js(读图);
        ctx.assert(`⑪ 打断(${打断}) 之后的第二击：必出源码`, 二A.展开 === true, JSON.stringify(二A));
      }

    } finally {
      await ctx.release(session);
    }

    // ── ⑫ 护栏：图 A 的蓝框不许把"点图 B"变成第 2 下（跨图不串） ──────────────────
    //    （独立会话：产品内部 HTTP 服务占固定端口，同一时刻只允许一个实例。）
    const fileB = hi.writeDoc('image-reveal-two.md', ['# 双图', '', '![甲](shot-blue.png)', '',
      '![乙](shot-red.png)', '', '后文乙。', ''].join('\n'));
    fs.writeFileSync(`${hi.ROOM}/shot-red.png`, hi.fixtures.png(120, 80, [230, 90, 90]));
    const s3 = await hi.openDoc(ctx, fileB, { minBlocks: 3 });
    try {
      ctx.assert('⑫ 焦点在编辑器', (await hi.ensureFocus(s3)).ok, '');
      const 两图 = await s3.js(`(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const 图 = [...d.querySelectorAll('${hi.SURFACE} img')];
        if (图[0]) 图[0].scrollIntoView({ block: 'center', behavior: 'instant' });
        return { ok: 图.length >= 2, 点: 图.slice(0, 2).map(im => { const r = im.getBoundingClientRect();
          return { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) }; }) }; })()`);
      ctx.assert('⑫ 前置：文档里有两张图', 两图.ok === true, JSON.stringify(两图));
      // 【复核轮修正】这一族必须**按图逐张读**：场景里通用的 `读图` 取的是 `.pop()`——也就是
      // 最后一张图（乙），拿它去断言"图甲已带蓝框"必然假红（复核子 Agent 已独立复刻证明产品
      // 侧无缺陷）。这里改成同时读甲/乙两态。
      const 读甲乙 = `(() => { const w = ${hi.IF}, d = w.document; const 图 = [...d.querySelectorAll('${hi.SURFACE} img')];
        const 态 = im => { const owner = im && im.closest('.vditor-ir__node[data-type]');
          return { 选中: !!im && im.classList.contains('typora-img-selected'),
            展开: !!owner && owner.classList.contains('vditor-ir__node--expand') }; };
        return { 甲: 态(图[0]), 乙: 态(图[1]) }; })()`;
      await 拟真连点(s3, 两图.点[0], 1, 500);                       // 选图甲
      const 甲 = await s3.js(读甲乙);
      ctx.assert('⑫ 前置：图甲已带蓝框、未展开（图乙不动）',
        甲.甲.选中 === true && 甲.甲.展开 === false && 甲.乙.选中 === false, JSON.stringify(甲));
      await 拟真连点(s3, 两图.点[1], 1, 700);                       // 点图乙 —— 第 1 下
      const 乙 = await s3.js(读甲乙);
      ctx.assert('⑫ 图甲有蓝框时点图乙：只给图乙上蓝框、不展开（跨图不串）',
        乙.乙.选中 === true && 乙.乙.展开 === false && 乙.甲.选中 === false, JSON.stringify(乙));
      await 拟真连点(s3, 两图.点[1], 1, 700);                       // 再点图乙 → 必出
      const 乙2 = await s3.js(读甲乙);
      ctx.assert('⑫ 再点图乙：必出源码', 乙2.乙.展开 === true, JSON.stringify(乙2));
      await s3.shot('⑫双图-图A蓝框下点图B只选中');
    } finally {
      await ctx.release(s3);
    }

    // ══ 会话二：裸 HTML 图块（另一种图片形态）走同一契约 ═════════════════════════
    const file2 = hi.writeDoc('image-reveal-html.md', BODY_HTML);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 3 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      const 文2 = await session2.js(文本点('后文乙'));
      const g7 = await session2.js(读图);
      ctx.assert('⑩ 前置：拿到裸 HTML 图块几何', g7.ok && g7.类型 === 'html-block', JSON.stringify(g7));
      await session2.click(文2.x, 文2.y); await hi.sleep(320);
      const g8 = await session2.js(读图);
      await 拟真连点(session2, g8.中心, 1, 500);
      const 一2 = await session2.js(读图);
      ctx.assert('⑩ 裸 HTML 图块：单击 1 次只选中、不展开', 一2.选中 === true && 一2.展开 === false, JSON.stringify(一2));
      await session2.click(文2.x, 文2.y); await hi.sleep(320);
      const g9 = await session2.js(读图);
      await 拟真连点(session2, g9.中心, 2, 700);
      const 慢2 = await session2.js(读图);
      ctx.assert('⑩ 裸 HTML 图块：慢点两下同样必出源码、光标进源码',
        慢2.展开 === true && 慢2.光标在源码 === true, JSON.stringify(慢2));
      await session2.shot('140-⑩HTML图-慢点两下必出');
      const 盘2 = await hi.edge.saveAndWait(session2, file2, { timeout: 8000 });
      ctx.witness('磁盘：裸 HTML 图块展开后的文件', { 盘: String(盘2.after).replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('⑩ 展开源码不改文档（`<img …>` 标签逐字不变，磁盘）',
        String(盘2.after).includes('<img src="shot-blue.png" alt="html图" width="160">'),
        JSON.stringify(String(盘2.after)));
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：大图素材（≥编辑区宽）——展开后图片被源码行顶下去，第 3 下打在原坐标
    //    （＝图片上方的空白）时不许折回。小图会"侥幸"第 3 下落在源码行上，是素材依赖的假绿。══
    fs.writeFileSync(`${hi.ROOM}/shot-big.png`, hi.fixtures.png(1100, 240, [60, 150, 120]));
    const file3 = hi.writeDoc('image-reveal-big.md', ['# 大图', '', '前文甲。', '', '![大图](shot-big.png)', '', '后文乙。', ''].join('\n'));
    const session3 = await hi.openDoc(ctx, file3, { minBlocks: 4 });
    try {
      ctx.assert('⑬ 焦点在编辑器', (await hi.ensureFocus(session3)).ok, '');
      const 文3 = await session3.js(文本点('后文乙'));
      await session3.click(文3.x, 文3.y); await hi.sleep(320);
      const g大 = await session3.js(读图);
      ctx.assert('⑬ 前置：大图已折叠', g大.ok && g大.展开 === false, JSON.stringify(g大));
      await 拟真连点(session3, g大.中心, 2, 700);
      const 开 = await session3.js(读图);
      ctx.assert('⑬ 大图慢点两下：源码必须出来', 开.展开 === true, JSON.stringify(开));
      // 第 3 下：打在**展开前**那个坐标（图片已被源码行顶下去，那里现在是空白/源码行）
      await hi.sleep(700);
      await session3.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g大.中心.x, y: g大.中心.y, button: 'left', buttons: 1, clickCount: 1 });
      await session3.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g大.中心.x, y: g大.中心.y, button: 'left', buttons: 0, clickCount: 1 });
      await hi.sleep(520);
      const 三 = await session3.js(读图);
      ctx.assert('⑬ 大图：第 3 下打在原坐标，展开态不许被折回（连点奇偶不许决定成败）',
        三.展开 === true, JSON.stringify(三));
      await session3.shot('140-⑬大图-第3下不折回');
    } finally {
      await ctx.release(session3);
    }
  },
};
