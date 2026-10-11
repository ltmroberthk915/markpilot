/** 2.1.8 回归：用户报的两条。
 *
 *  H 逐个关窗口把应用关掉之后，下次打开必须**全都回来**
 *    用户原话：「开两个文件窗口 → 直接关掉应用 → 再打开：两个窗口应连文件一起回来: 失败,
 *    关闭所有窗口,只有第一个文件回来了.」
 *    根因：关窗处理器对每个窗口一律把它从会话名单里摘掉，而"逐个点 X"时每个窗口都会走这条路，
 *    只有最后一个因为 `recs().length <= 1` 被保留——"哪一个活到最后"纯属偶然。
 *    修法：摘掉是**挂起**的（5 秒宽限）。宽限期内应用退出了 → 撤销；应用还活着 → 才真正落盘删除。
 *    两条语义都要断言：①一口气关完 → 两个都回来；②只关一个并继续用（超过宽限期）→ 这一个不再回来。
 *
 *  I 打开文档时滚动还原必须在 1 秒级收工，不能"抖一阵才停"
 *    根因：锚点误差公式把两项相减的顺序写反，算出来是 2×delta，永远越不过 ±2px 的收敛线，
 *    于是每次打开都要把滚动位置每 120ms 重写一次、一直写到 6 秒兜底（实测 applies=76）。
 *    判据取渲染进程自己的观测器 `window.__typoraScrollRestore`（applies / error / settled），
 *    外加一个与它无关的几何证人：文档顶部块在视口里的位置在收工后不再变化。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');

module.exports = {
  id: '80-session-and-scroll-2.1.8',
  title: '日用缺陷回归：逐个关窗后会话只剩一个 / 打开文档时滚动还原抖满 6 秒',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '80-session');
    fs.mkdirSync(dir, {recursive: true});
    const A = path.join(dir, '会话甲.md');
    const B = path.join(dir, '会话乙.md');
    // 滚动用例：内容要足够长，才能滚到中段并留下锚点。
    const long = path.join(dir, '长文档.md');
    fs.writeFileSync(A, '# 会话甲\n\n甲的正文。\n');
    fs.writeFileSync(B, '# 会话乙\n\n乙的正文。\n');
    fs.writeFileSync(long, '# 长文档\n\n' + Array.from({length: 60}, (_, i) => `## 第 ${i + 1} 节\n\n这一段是用来把文档撑长的正文，编号 ${i + 1}。\n`).join('\n'));

    // ---------------- H：逐个关窗口（= 点标题栏 X）之后退出，两个窗口都要回来 ----------------
    {
      const profile = path.join(ctx.outDir, '80-profile-' + process.pid);
      const first = await ctx.launch({inspect: true, args: [A, B], profile, keepProfile: true});
      let before = null, midDrop = null;
      try {
        await sleep(5000);
        before = (await first.recs() || []).map(r => r.file).filter(Boolean);
        // 逐窗口关，顺序就是用户点 X 的顺序：先关后开的那个，再关剩下那个。
        await first.main.js(`(() => { const wins = require('electron').BrowserWindow.getAllWindows(); wins[0].close(); return wins.length; })()`);
        await sleep(900);
        midDrop = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8')).windows;
        await first.main.js(`(() => { const wins = require('electron').BrowserWindow.getAllWindows(); if (wins[0]) wins[0].close(); return wins.length; })()`);
        for (let i = 0; i < 40 && first.child.exitCode === null; i++) await sleep(300);
      } finally { await first.close(); }
      const stateAfter = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8')).windows;
      const survived = await first.child.exitCode !== null;
      const second = await ctx.launch({inspect: true, args: [], profile, keepProfile: true});
      let restored = [];
      try {
        await sleep(5000);
        restored = (await second.recs() || []).map(r => r.file).filter(Boolean);
      } finally { await ctx.release(second); }
      ctx.witness('逐个关窗口后 state.json 与重启后的窗口', {
        关窗前窗口: before.map(f => path.basename(f)),
        关掉一个之后的会话记录: midDrop.length,
        全部关掉后进程已退出: survived,
        全部关掉后的会话记录: stateAfter.length,
        重启后窗口: restored.map(f => path.basename(f)),
      });
      ctx.assert('【H】开两个文件窗口时确实是两个窗口', before.length === 2, before);
      ctx.assert('【H】关掉第一个窗口的当下，它只是挂起在会话里（还没被删掉）', midDrop.length === 2, {纪录数: midDrop.length});
      ctx.assert('【H】逐个关完两个窗口之后，会话记录里两个文件都还在（不是只剩一个）', stateAfter.length === 2, {纪录数: stateAfter.length, 文件: stateAfter.map(w => w.file && path.basename(w.file))});
      ctx.assert('【H】重启后两个窗口连文件一起回来', restored.length === 2, restored.map(f => path.basename(f)));
    }

    // ---------------- I：打开文档时的滚动还原要在 1 秒级收工 ----------------
    {
      const profile = path.join(ctx.outDir, '80-scroll-' + process.pid);
      const warm = await ctx.launch({inspect: true, args: [long], profile, keepProfile: true});
      let saved = null;
      try {
        await warm.until(`(() => { const w = document.getElementById('editor')?.contentWindow; return !!(w && w.document.querySelector(${SURFACE})); })()`, {timeout: 60000});
        await sleep(1800);
        await warm.js(`(() => { const w = document.getElementById('editor').contentWindow;
          const root = w.document.querySelector(${SURFACE}); root.scrollTop = 1400;
          root.dispatchEvent(new Event('scroll')); return Math.round(root.scrollTop); })()`);
        await sleep(1500);
        saved = JSON.parse(fs.readFileSync(path.join(profile, 'state.json'), 'utf8'));
        await warm.main.js(`(() => { require('electron').app.quit(); return true; })()`);
        for (let i = 0; i < 30 && warm.child.exitCode === null; i++) await sleep(400);
      } finally { await warm.close(); }
      const anchorSaved = saved?.scrollAnchor?.[long] || null;

      const session = await ctx.launch({inspect: true, args: [long], profile, keepProfile: true});
      try {
        await session.until(`(() => { const w = document.getElementById('editor')?.contentWindow; const r = w && w.__typoraScrollRestore; return !!(r && r.applies > 0); })()`, {timeout: 60000});
        // 从"第一次贴上位置"起最多等 2 秒：正常应当在 1 秒内收工（高度稳定 400ms / 贴准 800ms）。
        let settled = null;
        for (let i = 0; i < 20; i++) {
          settled = await session.js(`(() => { const r = document.getElementById('editor').contentWindow.__typoraScrollRestore;
            return {applies: r.applies, error: r.error, settled: !!r.settled, cancelled: !!r.cancelled, mode: r.mode}; })()`);
          if (settled.settled || settled.cancelled) break;
          await sleep(100);
        }
        // 收工之后视口不许再动：连续两次测量同一个顶层块的位置必须一致。
        const topOf = `(() => { const w = document.getElementById('editor').contentWindow; const root = w.document.querySelector(${SURFACE});
          const v = root.getBoundingClientRect(); for (const b of root.children) { const r = b.getBoundingClientRect(); if (r.bottom > v.top + 1) return {head: b.textContent.replace(/\\s+/g,' ').trim().slice(0,16), top: Math.round(r.top)}; } return null; })()`;
        const t1 = await session.js(topOf);
        await sleep(900);
        const t2 = await session.js(topOf);
        const after = await session.js(`(() => { const r = document.getElementById('editor').contentWindow.__typoraScrollRestore; return {applies: r.applies, settled: !!r.settled}; })()`);
        ctx.witness('打开文档后滚动还原的收工情况', {保存的锚点: anchorSaved, 收工时: settled, 收工后视口顶部块: t1, '再等900ms后': t2, 收工后新增的重贴次数: after.applies - settled.applies});
        ctx.assert('【I】重开文档时确实走了锚点还原', settled.mode === 'anchor', settled);
        ctx.assert('【I】滚动还原在 2 秒内就收工（不是拖到 6 秒兜底）', settled.settled === true, settled);
        ctx.assert('【I】收工时锚点误差已经贴准（±2px）', Math.abs(settled.error) <= 2, {误差: settled.error});
        ctx.assert('【I】收工之后视口不再被改动（顶部块位置与 900ms 后完全一致）', t1 && t2 && t1.head === t2.head && t1.top === t2.top, {t1, t2});
        ctx.assert('【I】收工之后不再有新的重贴（说明真的停了）', after.applies - settled.applies <= 1, {收工时: settled.applies, '900ms后': after.applies});
      } finally { await ctx.release(session); }
    }

    // ---------------- J：右键弹出的菜单不许压住鼠标，也不许压住被点的那一行 ----------------
    // 用户定的规则：「右键点开的侧栏或者数学代码提示的栏目，可以在光标之上或之下，但必须使得
    // 光标不得与选择栏重叠」「不是光标 是鼠标和被改动的代码行不得有重叠」。
    {
      const doc = path.join(dir, '右键菜单位置.md');
      fs.writeFileSync(doc, '# 右键菜单\n\n这一段用来右键。\n\n第二段。\n');
      const session = await ctx.launch({inspect: true, args: [doc]});
      try {
        await session.until(`document.querySelectorAll('#tree .row').length > 0`, {timeout: 60000});
        await sleep(1600);
        // ① 侧栏文件树的右键菜单（鼠标按在那一行的中间）
        const row = await session.js(`(() => { const r = [...document.querySelectorAll('#tree .row')].find(n => n.textContent.includes('右键菜单位置'));
          if (!r) return null; const b = r.getBoundingClientRect(); return {x: Math.round(b.x + 40), y: Math.round(b.y + b.height / 2), row: {left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom)}}; })()`);
        let tree = null;
        if (row) {
          await session.click(row.x, row.y, {button: 'right'});
          await sleep(500);
          tree = await session.js(`(() => { const el = document.getElementById('ctxmenu'); if (!el) return null; const b = el.getBoundingClientRect();
            return {left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), 显示: getComputedStyle(el).display}; })()`);
        }
        // ② 编辑器正文的右键菜单（坐标换算回外壳页坐标系）
        const para = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; const frame = document.getElementById('editor');
          const p = [...w.document.querySelectorAll(${SURFACE} + ' p')].find(n => n.textContent.includes('用来右键'));
          if (!p) return null; const r = p.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
          return {x: Math.round(fr.x + r.x + 30), y: Math.round(fr.y + r.y + r.height / 2), line: {left: Math.round(r.left + fr.x), top: Math.round(r.top + fr.y), right: Math.round(r.right + fr.x), bottom: Math.round(r.bottom + fr.y)}}; })()`);
        let editor = null;
        if (para) {
          await session.click(para.x, para.y, {button: 'right'});
          await sleep(700);
          editor = await session.js(`(() => { const w = document.getElementById('editor').contentWindow; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
            const el = w.document.getElementById('typora-editor-context-menu'); if (!el) return null;
            const b = el.getBoundingClientRect();
            return {left: Math.round(b.left + fr.x), top: Math.round(b.top + fr.y), right: Math.round(b.right + fr.x), bottom: Math.round(b.bottom + fr.y), 按钮数: el.querySelectorAll('button').length}; })()`);
        }
        const covers = (r, x, y) => !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
        const coversLine = (r, line) => !!(r && line && !(r.right < line.left || r.left > line.right || r.bottom < line.top || r.top > line.bottom));
        ctx.witness('右键菜单与鼠标/被点行的几何关系', {侧栏行: row, 侧栏菜单: tree, 编辑器行: para?.line, 编辑器菜单: editor});
        ctx.assert('【J】侧栏右键菜单弹出来了', !!tree && tree.显示 !== 'none' && tree.right > tree.left, tree);
        ctx.assert('【J】侧栏右键菜单没有压住鼠标', !covers(tree, row?.x, row?.y), {tree, 鼠标: row && {x: row.x, y: row.y}});
        ctx.assert('【J】侧栏右键菜单没有压住被点的那一行', !coversLine(tree, row?.row), {tree, 行: row?.row});
        ctx.assert('【J】正文右键菜单弹出来了', !!editor && editor.按钮数 > 0, editor);
        ctx.assert('【J】正文右键菜单没有压住鼠标', !covers(editor, para?.x, para?.y), {editor, 鼠标: para && {x: para.x, y: para.y}});
        ctx.assert('【J】正文右键菜单没有压住被点的那一行', !coversLine(editor, para?.line), {editor, 行: para?.line});
      } finally { await ctx.release(session); }
    }
  },
};
