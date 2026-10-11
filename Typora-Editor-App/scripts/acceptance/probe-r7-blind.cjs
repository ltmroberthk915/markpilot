/** 第 7 轮盲区审查 · 定点复现探针（HEAD 621db0e 上 r7-blind 电池的新红）。
 *
 *  六个病例，每个可单独跑：
 *    --case=find      125④⑤：Ctrl+F 打开查找面板后真实通道打字，词被打进文档（FR2/FR3
 *                     reveal 抢焦点嫌疑）+ 磁盘内容变化；逐 100ms 读 输入框值/焦点/计数，
 *                     Enter/Shift+Enter/F3/Esc 全链，末尾 md 与磁盘 diff（公共前后缀夹逼）。
 *                     【R7 修复后判据】打字后 200ms 焦点仍是 INPUT[query]（reveal 面板分支
 *                     不落选区、不夺焦）；Enter/Shift+Enter/F3 全程焦点在面板、md 与磁盘
 *                     逐字节不变、计数 1/2→2/2→1/2→2/2 逐键推进（Enter 永远是"下一处"）。
 *    --case=getvalue  131 素材完整打开"读不到"：160KB 真素材副本上逐秒采样 getValue，
 *                     区分 vditor 未挂 / getValue()==null / 正常值三个阶段的时间线。
 *    --case=pagedown  125②：164 块文档固定起点连按 PageDown，逐键读块号+滚动，
 *                     判 pageJump（第 6 轮 F7 修复）在此路径是否生效。
 *    --case=vertcol   probe-real-ops V4 病例2（scan 丢 goalX，306→231 轨迹）：重识概率论
 *                     副本上**连点两下不同列**建立 goalX——单击 306 会被上一行自己的空档
 *                     左钳（goalX 没建立在 306、红被掩掉），钳走时再用 ←/→ 真实横向移动
 *                     走到 306±12 的真边界；再 ↓ 进标题行，读 实际列 vs 最近可用列
 *                     （V4 口径：|实际-306| ≤ |最近-306|+8）+ 决策轨迹。
 *    --case=bandedge  probe-real-ops V2 病例3（视口底缘 ↓ 死区 26-31px）：构造底缘带文档，
 *                     滚动到"目标行盒底离可视底 26~31px、下一行顶压在折线之下"的定点连按 ↓；
 *                     带内（可滚）与顶格（scrollTop 顶死）两段，逐键读 文档坐标行进/滚动/轨迹
 *                     ——带内 ↓ 必须至少滚动一行再落点；顶格时也要能落（滚进视口 clamp 语义）。
 *
 *  用法：node scripts/acceptance/probe-r7-blind.cjs --case=find
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/r7-blind-repro');
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const CASE = ARG('case', 'find');
const PS = (script, args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(harness.project, 'scripts/acceptance', script), ...args], { stdio: 'pipe', windowsHide: true }).toString().trim();

const FIND_OPEN = `(() => { const w = ${hi.IF}; if (!w || !w.document) return false;
  return !!w.document.querySelector('#typora-find input[data-field="query"]'); })()`;
const SCROLL = `(() => { const w = ${hi.IF}; if (!w) return -1;
  const el = w.scrollingElement || w.document.documentElement; return Math.round(el.scrollTop); })()`;

/** 公共前后缀夹逼：a→b 的差异区间（复现读数用）。 */
function squeeze(a, b) {
  a = String(a); b = String(b);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { 位置: head, 删: a.slice(head, a.length - tail), 增: b.slice(head, b.length - tail) };
}

const para = n => `第 ${n} 段：撑高度用的普通中文句子，带一点公式 $a_{${n}}$ 与英文 word${n}。`;
const BODY_NAV = ['# 页面导航练习', '', ...Array.from({ length: 120 }, (_, i) => para(i + 1)), '',
  '锚点甲：这一段的开头就是查找目标。', '', ...Array.from({ length: 40 }, (_, i) => para(200 + i)), '',
  '长行段落：' + '甲乙丙丁戊己庚辛壬癸'.repeat(24) + '长行到此为止。', '', '尾段：文档收尾。', ''].join('\n');
const BODY_FIND = ['# 查找焦点复现', '', '甲段落：普通文字一行。', '',
  '锚点甲：这一段的开头就是查找目标。', '', '锚点甲 二号：第二处命中，给 Enter 验证计数推进。', '',
  '乙段落：收尾文字。', ''].join('\n');
/** 病例3 素材：段落 + 二级标题 + 块公式混排——块间距不同（段-段 / 段-标题 / 段-公式-段），
 *  运行时挑"行盒底到下一行顶"间隙最大的块对，把下一行顶精准压到折线之下。 */
const band段 = n => `第 ${n} 段：底缘带文档的普通中文句子，带词 word${n} 与公式 $b_{${n}}$。`;
const BODY_BAND = ['# 底缘带定点', '', ...Array.from({ length: 18 }, (_, i) => band段(i + 1)), '',
  '## 二级标题甲', '', ...Array.from({ length: 4 }, (_, i) => band段(100 + i)), '',
  ...Array.from({ length: 12 }, (_, i) => band段(200 + i)), '',
  '$$\\int_0^1 f(x)\\,dx = \\frac{1}{2}$$', '',
  ...Array.from({ length: 12 }, (_, i) => band段(300 + i)), '',
  '## 二级标题乙', '', ...Array.from({ length: 12 }, (_, i) => band段(400 + i)), '',
  '尾段：文档收尾。', ''].join('\n');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = { launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
    label: 'probe-r7-' + CASE, outDir: OUT, timeout: 600000, ...options, args: options.args || [], inspect: true }),
    release: async session => { await session.close(); } };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  let failed = false;

  if (CASE === 'find') {
    const file = hi.writeDoc('r7-find.md', BODY_FIND);
    const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1600 });
    try {
      await hi.ensureFocus(session);
      await session.js(hi.placeCaretAt(1, 2));
      await hi.sleep(200);
      const md0 = String(await hi.mdNow(session));
      const read = () => session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const input = d.querySelector('#typora-find input[data-field="query"]');
        const out = d.querySelector('#typora-find output');
        const active = d.activeElement;
        const s = w.getSelection();
        return { 面板: !!input, 输入框值: input ? input.value : null,
          焦点: active ? (active.tagName + (active.dataset && active.dataset.field ? '[' + active.dataset.field + ']' : '') + (active.className ? '.' + String(active.className).slice(0, 24) : '')) : null,
          焦点在面板: !!(input && input.closest('#typora-find') === active.closest('#typora-find')),
          计数: out ? out.textContent.trim() : null,
          选区在编辑面: !!(s && s.rangeCount && d.querySelector(${JSON.stringify(hi.SURFACE)}).contains(s.getRangeAt(0).startContainer)),
          选区文本: s && s.rangeCount ? s.toString().slice(0, 30) : null }; })()`);
      say('[find] 基线 md0 长 ' + md0.length);
      await hi.combo(session, 'Ctrl+F');
      const opened = await session.until(FIND_OPEN, { timeout: 6000, interval: 120 });
      say('[find] 面板打开=' + opened);
      say('[find] 打开后 ' + JSON.stringify(await read()));
      await hi.sleep(300);
      say('[find] +300ms ' + JSON.stringify(await read()));
      // 与场景 125 完全同通道：单次 insertText 整串上屏
      await session.type('锚点甲');
      const snaps = [];
      for (let i = 1; i <= 10; i++) {
        await hi.sleep(100);
        const s = await read();
        snaps.push(s);
        say(`[find] 打字后+${i * 100}ms ` + JSON.stringify(s));
      }
      // 2x 真屏：此刻面板仍开、焦点留在面板输入框（R7 修复口径：reveal 不落选区、
      // 不夺焦），当前命中由查找层自己的 CSS Highlight（typora-find-current）指示
      const shot2x = async (name, rect) => {
        if (!rect) return;
        const bounds = await session.main.js(`(() => { const {BrowserWindow, screen} = require('electron');
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
          return {content: win.getContentBounds(), scale: screen.getDisplayMatching(win.getBounds()).scaleFactor}; })()`);
        await session.main.js(`(() => { const {BrowserWindow} = require('electron');
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
          win.setAlwaysOnTop(true); win.show(); win.focus(); if (win.moveTop) win.moveTop(); return 1; })()`);
        await harness.sleep(400);
        PS('win-screen-crop-xy.ps1', ['-Out', path.join(OUT, name),
          '-X', String(Math.round((bounds.content.x + Math.max(0, rect.x - 30)) * bounds.scale)),
          '-Y', String(Math.round((bounds.content.y + Math.max(0, rect.y - 30)) * bounds.scale)),
          '-W', String(Math.round(Math.min(940, rect.w + 260) * bounds.scale)),
          '-H', String(Math.round(Math.min(320, rect.h + 140) * bounds.scale))]);
      };
      const panelRect = await session.js(`(() => { const d = document.getElementById('editor').contentWindow.document;
        const p = d.querySelector('#typora-find'); if (!p) return null;
        const f = document.getElementById('editor').getBoundingClientRect();
        const r = p.getBoundingClientRect();
        return {x: Math.round(f.x + r.x), y: Math.round(f.y + r.y), w: Math.round(r.width), h: Math.round(r.height + 60)}; })()`);
      const hitRect = await session.js(`(() => { const d = document.getElementById('editor').contentWindow.document;
        const f = document.getElementById('editor').getBoundingClientRect();
        for (const block of d.querySelectorAll(${JSON.stringify(hi.SURFACE + ' > *')})) {
          if (block.textContent.includes('锚点甲')) { const r = block.getBoundingClientRect();
            return {x: Math.round(f.x + r.x), y: Math.round(f.y + r.y), w: Math.round(r.width), h: Math.round(Math.min(r.height, 120))}; } }
        return null; })()`);
      // 面板带（连带下方的当前命中行：查找层高亮，非原生选区）
      const combined = panelRect && hitRect ? {x: Math.min(panelRect.x, hitRect.x), y: panelRect.y, w: Math.max(panelRect.w, hitRect.w + 60), h: 340} : (panelRect || hitRect);
      await shot2x('find-after-type-2x', combined);
      await session.shot('find-after-type');
      await session.enter();
      await hi.sleep(700);
      const sEnter = await read();
      say('[find] Enter后 ' + JSON.stringify(sEnter) + ' 滚动=' + await session.js(SCROLL));
      await session.enter(true);
      await hi.sleep(400);
      const sShift = await read();
      say('[find] Shift+Enter后 ' + JSON.stringify(sShift));
      await hi.press(session, 'F3');
      await hi.sleep(400);
      const sF3 = await read();
      say('[find] F3后 ' + JSON.stringify(sF3));
      await session.shot('find-after-f3');
      await hi.press(session, 'Escape');
      await hi.sleep(400);
      say('[find] Esc后面板在=' + (await session.js(FIND_OPEN)));
      const md1 = String(await hi.mdNow(session));
      say('[find] md diff ' + JSON.stringify(squeeze(md0, md1)));
      const hitRect2 = await session.js(`(() => { const d = document.getElementById('editor').contentWindow.document;
        const f = document.getElementById('editor').getBoundingClientRect();
        const blocks = [...d.querySelectorAll(${JSON.stringify(hi.SURFACE + ' > *')})];
        const at = blocks.findIndex(b => b.textContent.includes('查找目标'));
        const r = blocks[at] && blocks[at].getBoundingClientRect();
        return r ? {x: Math.round(f.x + r.x), y: Math.round(f.y + r.y), w: Math.round(r.width), h: Math.round(Math.min(r.height, 120))} : null; })()`);
      await shot2x('find-after-enter-2x', hitRect2);
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      say('[find] 磁盘长 ' + disk.length + ' 原文长 ' + BODY_FIND.length + ' 相等=' + (disk === BODY_FIND));
      say('[find] 磁盘 diff ' + JSON.stringify(squeeze(BODY_FIND, disk)));
      // 【R7 修复判据】焦点链全程留面板 + md/磁盘逐字节不变 + 计数逐键推进。
      const s200 = snaps[1];                                     // 打字后 +200ms（缺陷翻转点）
      const verdict = {
        打字后200ms焦点仍INPUT: !!(s200 && s200.焦点在面板 === true && s200.焦点 === 'INPUT[query]'),
        打字后计数到达: s200 ? s200.计数 : null,
        Enter后焦点在面板: !!(sEnter && sEnter.焦点在面板 === true && sEnter.焦点 === 'INPUT[query]'),
        Enter后计数推进到2of2: sEnter ? sEnter.计数 : null,
        ShiftEnter后计数回退到1of2: sShift ? sShift.计数 : null,
        ShiftEnter后焦点在面板: !!(sShift && sShift.焦点在面板 === true),
        F3后计数推进到2of2: sF3 ? sF3.计数 : null,
        F3后焦点在面板: !!(sF3 && sF3.焦点在面板 === true),
        全程选区不落编辑面: [sEnter, sShift, sF3].every(s => !s || s.选区在编辑面 === false),
        md不变: md1 === md0,
        磁盘不变: disk === BODY_FIND };
      const pass = verdict.打字后200ms焦点仍INPUT && verdict.Enter后焦点在面板
        && verdict.Enter后计数推进到2of2 === '2 / 2' && verdict.ShiftEnter后计数回退到1of2 === '1 / 2'
        && verdict.ShiftEnter后焦点在面板 && verdict.F3后计数推进到2of2 === '2 / 2'
        && verdict.F3后焦点在面板 && verdict.全程选区不落编辑面 && verdict.md不变 && verdict.磁盘不变;
      say('[find] 判定 ' + (pass ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(verdict));
      say('[find] 突变点 extension-src/render/js/find-replace.js reveal 内 '
        + 'if(root().contains(document.activeElement)){…addRange…} 分支守卫：还原成无条件 addRange 即红'
        + '（打字后 200ms 焦点翻转到 PRE、Enter 后 md/磁盘 删"锚点甲"增"\\n\\n\\n"、计数 0/0）');
      if (!pass) failed = true;
    } finally { await ctx.release(session); }
  }

  if (CASE === 'getvalue') {
    const file = hi.copyProtected('富文本测试-重识概率论.md');
    const session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 2600 });
    try {
      const t0 = Date.now();
      let last = null;
      for (let i = 0; i < 70; i++) {
        const probe = await session.js(`(() => { const w = ${hi.IF}; if (!w) return {窗:false};
          if (!w.vditor) return {窗:true, vditor:false};
          try { const v = w.vditor.getValue(); return {窗:true, vditor:true, 值: v == null ? null : String(v).length}; }
          catch (e) { return {窗:true, vditor:true, 抛:String(e.message).slice(0, 80)}; } })()`);
        const line = `[getvalue] +${Math.round((Date.now() - t0) / 1000)}s ` + JSON.stringify(probe);
        if (JSON.stringify(probe) !== JSON.stringify(last)) { say(line); last = probe; }
        if (probe && probe.值 && probe.值 > 1000) { say(line); say('[getvalue] 已进稳态，停'); break; }
        await hi.sleep(1000);
      }
      say('[getvalue] 顶层块 ' + await session.js(`(() => { const w = ${hi.IF}; return w.document.querySelector(${JSON.stringify(hi.SURFACE)}).children.length; })()`));
    } finally { await ctx.release(session); try { fs.unlinkSync(file); } catch {} }
  }

  if (CASE === 'pagedown') {
    const file = hi.writeDoc('r7-pagedown.md', BODY_NAV);
    const session = await hi.openDoc(ctx, file, { minBlocks: 30, settleMs: 1800 });
    try {
      await hi.ensureFocus(session);
      await session.js(hi.placeCaretAt(3, 2));
      await hi.sleep(300);
      const where = () => session.js(`(() => { const w = ${hi.IF};
        const s = w.getSelection(); if (!s || !s.rangeCount) return {无:true};
        const r = s.getRangeAt(0); const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
        const surface = w.document.querySelector(${JSON.stringify(hi.SURFACE)});
        let top = at, i = -1; if (surface.contains(at)) { while (top && top.parentElement !== surface) top = top.parentElement;
          if (top && top.parentElement === surface) i = [...surface.children].indexOf(top); }
        const box = r.getBoundingClientRect();
        return { 块: i, y: Math.round(box.top), x: Math.round(box.left) }; })()`);
      say('[pagedown] 起点 ' + JSON.stringify(await where()) + ' 滚动=' + await session.js(SCROLL));
      for (let i = 1; i <= 8; i++) {
        await hi.press(session, 'PageDown');
        await hi.sleep(450);
        say(`[pagedown] 第${i}键 ` + JSON.stringify(await where()) + ' 滚动=' + await session.js(SCROLL));
      }
      for (let i = 1; i <= 4; i++) {
        await hi.press(session, 'PageUp');
        await hi.sleep(450);
        say(`[pagedown] 回程第${i}键 ` + JSON.stringify(await where()) + ' 滚动=' + await session.js(SCROLL));
      }
    } finally { await ctx.release(session); }
  }

  if (CASE === 'vertcol') {
    const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
    const src = path.join(DIR, '1-重识概率论.md');
    const file = path.join(OUT, 'b-重识概率论.md');
    fs.copyFileSync(src, file);
    const session = await hi.openDoc(ctx, file, { minBlocks: 100, settleMs: 2600 });
    try {
      await hi.ensureFocus(session);
      // 打开补丁的决策轨迹（real-ops 的 INSTALL 同款开关；产品默认零开销）
      await session.js(`(() => { const w = ${hi.IF}; if (w) w.__vertTraceOn = true; return 1; })()`);
      // 固定起点：§1.3 标题行的上一行（V4 样例：目标列 306，最近可用 344，实际 231）
      const start = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(hi.SURFACE)});
        const blocks = [...surface.children];
        for (let i = 0; i < blocks.length; i++) if (blocks[i].textContent.includes('勒贝格积分')) return {ok:true, 块:i};
        return {ok:false}; })()`);
      say('[vertcol] §1.3 所在块 ' + JSON.stringify(start));
      const clickAt = async (x, y) => { const f = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y)}; })()`);
        await session.click(f.x + x, f.y + y); await hi.sleep(350); };
      // §1.3 块的上一块行中点起手，目标列 306
      const anchor = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(hi.SURFACE)});
        const blocks = [...surface.children];
        for (let i = 0; i < blocks.length; i++) if (blocks[i].textContent.includes('勒贝格积分')) {
          const prev = blocks[i - 1]; if (!prev) return null;
          prev.scrollIntoView({block:'center'});
          const r = prev.getBoundingClientRect();
          const f = document.getElementById('editor').getBoundingClientRect();
          return {x: Math.round(306), y: Math.round(r.top + r.height / 2), 前块: prev.textContent.slice(0, 24)}; } })()`);
      say('[vertcol] 锚点 ' + JSON.stringify(anchor));
      await hi.sleep(300);
      if (anchor) {
        // 【R7 改真·病例2 复现要点】只点一下 306 未必把 goalX 建立在 306：上一行自己的
        // 不可落空档会把点击**左钳**（光标落在 231 一侧，↓ 的 goalX 随之变成 231，红被掩掉）。
        // 改为连点两下**不同列**：先点 420 建立焦点与行位，再点 306；读回光标列，仍被钳走
        // （差 > 20px）就用 ←/→ 真实横向移动走到 306±12 的真边界上——goalX 这才算建立。
        await clickAt(420, anchor.y);
        const c1 = await hi.caret(session);
        say('[vertcol] 第一击(列420) ' + JSON.stringify(c1));
        await clickAt(anchor.x, anchor.y);
        let cur = await hi.caret(session);
        say('[vertcol] 第二击(列306) ' + JSON.stringify(cur));
        for (let i = 0; cur && cur.ok && Math.abs(cur.x - 306) > 12 && i < 16; i++) {
          await hi.press(session, cur.x > 306 ? 'ArrowLeft' : 'ArrowRight');
          await hi.sleep(160);
          cur = await hi.caret(session);
          say(`[vertcol] 横移第${i + 1}键 ` + JSON.stringify(cur));
        }
        const goal = cur && cur.ok ? cur.x : null;
        say('[vertcol] goalX 建立在 ' + goal + '（要求 306±12：' + (goal !== null && Math.abs(goal - 306) <= 12) + '）');
        const before = cur;
        await hi.press(session, 'ArrowDown');
        await hi.sleep(450);
        const after = await hi.caret(session);
        say('[vertcol] ↓后光标 ' + JSON.stringify(after));
        // 该标题行的可落范围 + 离 306 最近的真边界（几何独立口径，nearestOnLine 同款量法）
        const span = await session.js(`(() => { const w = ${hi.IF}, d = w.document;
          const surface = d.querySelector(${JSON.stringify(hi.SURFACE)});
          for (const b of surface.children) if (b.textContent.includes('勒贝格积分')) {
            const r = b.getBoundingClientRect();
            const 中线 = r.top + r.height / 2;
            let 左=null, 右=null, 最近=null;
            for (let x = 0; x <= Math.round(r.width); x += 3) {
              const hit = w.document.caretRangeFromPoint(r.left + x, 中线);
              if (!hit || !hit.startContainer) continue;
              const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
              if (at.closest('.vditor-ir__preview,[data-type$="-marker"],button')) continue;
              const hr = hit.getBoundingClientRect(); if (!hr.height) continue;
              if (!(中线 >= hr.top - 2 && 中线 <= hr.bottom + 2)) continue;   // 必须真的盖住中线
              const L = Math.round(hr.left);
              if (左 === null) 左 = L; 右 = L;
              if (最近 === null || Math.abs(L - 306) < Math.abs(最近 - 306)) 最近 = L; }
            return {标题行y: Math.round(r.top), 左, 右, 最近可用列: 最近}; } })()`);
        say('[vertcol] 标题行可落范围 ' + JSON.stringify(span));
        // 判定（V4 口径：|实际列-306| ≤ |最近可用列-306| + 8），goalX 没建立成则只报数不判
        let pass = null;
        if (goal !== null && after && after.ok && span && span.最近可用列 !== null) {
          const 差 = Math.abs(after.x - 306) - Math.abs(span.最近可用列 - 306);
          pass = 差 <= 8 && after.y !== (before ? before.y : null);
          say('[vertcol] 判定 ' + (pass ? 'PASS' : 'FAIL')
            + ' 实际列 ' + after.x + ' / 最近可用列 ' + span.最近可用列 + '（差 ' + 差 + 'px，容差 +8）'
            + ' 行 ' + (before ? before.y : '?') + '→' + after.y);
          say('[vertcol] 突变点 extension-src/render/js/typora-patches.js 按目标列钳：'
            + '把 keydown 里 target = 按目标列钳(target) 一行注掉即红（实际列回到 231 一侧）');
          if (!pass) failed = true;
        } else {
          say('[vertcol] 判定 SKIP（goalX=' + goal + '，读数不全 ' + JSON.stringify({after: !!after, span}) + '）');
        }
        const trace = await session.js(`(() => { const w = ${hi.IF}; return (w.__vtrace || []).slice(-14); })()`);
        say('[vertcol] 决策轨迹 ' + JSON.stringify(trace));
        await session.shot('vertcol-after-down');
      }
    } finally { await ctx.release(session); try { fs.unlinkSync(file); } catch {} }
  }

  if (CASE === 'bandedge') {
    // 病例3 定点（real-ops run-2026-10-03 V2：视口底缘 ↓ 死区 26-31px——光标行底离可视底
    // 26~31px、下一行顶压在折线之下时，旧版 贴边(1.6×行高=25.6px) 不触发、scan 又把折线下
    // 的下一行整行拒收，↓ 既不滚也不落）。两段：带内（可滚，滚一整行再落）与顶格
    // （scrollTop 顶死，也要能落——滚进视口 clamp 语义）。
    const file = hi.writeDoc('r7-bandedge.md', BODY_BAND);
    const session = await hi.openDoc(ctx, file, { minBlocks: 30, settleMs: 1800 });
    try {
      await hi.ensureFocus(session);
      await session.js(`(() => { const w = ${hi.IF}; if (w) w.__vertTraceOn = true; return 1; })()`);
      const clickAt = async (x, y) => { const f = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y)}; })()`);
        await session.click(f.x + x, f.y + y); await hi.sleep(350); };
      /** 滚动布置 + 几何读数：模式='带内' 把选中块对的下一行顶压到折线+2；'顶格' 先滚到最大。
       *  选块：带内取"行盒底→下一块首行顶"间隙最大的一对；顶格取带宽最接近 28.5 的一对。 */
      const 布置 = 模式 => session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(hi.SURFACE)});
        if (!surface) return {ok:false, 因:'无编辑面'};
        let sc = null;
        for (const el of [surface, surface.parentElement, d.scrollingElement]) {
          if (el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) { sc = el; break; } }
        if (!sc) return {ok:false, 因:'内容不满一屏（无滚动容器）'};
        if (${模式} === '顶格') sc.scrollTop = sc.scrollHeight - sc.clientHeight;
        const 面 = surface.getBoundingClientRect();
        const 折线 = Math.min(面.bottom, w.innerHeight);
        const 块们 = [...surface.children].filter(b => {
          if (!String(b.textContent || '').trim()) return false;
          const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 折线 * 0.6; });
        const 盒 = b => { const r = b.getBoundingClientRect();
          return {顶: Math.round(r.top), 底: Math.round(r.bottom), 左: Math.round(r.left)}; };
        let 选 = null;
        for (let i = 0; i < 块们.length - 1; i++) {
          const a = 盒(块们[i]), b = 盒(块们[i + 1]);
          if (b.顶 <= a.底) continue;                       // 下一块首行必须在当前块末行之下
          const gap = b.顶 - a.底, 带宽 = 折线 - a.底;
          const 分 = ${模式} === '顶格' ? Math.abs(带宽 - 28.5) : -gap;   // 带内挑大间隙，顶格贴带宽
          if (!选 || 分 < 选.分) 选 = {i, 分, gap};
        }
        if (!选) return {ok:false, 因:'没有可用块对'};
        if (${模式} === '带内') {
          const 下一 = 盒(块们[选.i + 1]);
          sc.scrollTop = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight,
            sc.scrollTop + (下一.顶 - (折线 + 2))));        // 下一行顶压到折线之下 2px
        }
        const a2 = 盒(块们[选.i]), b2 = 盒(块们[选.i + 1]);
        return {ok:true, 折线: Math.round(折线), 行: a2, 下一行: b2,
          带宽: Math.round(折线 - a2.底), 下一行顶离折线: Math.round(b2.顶 - 折线), gap: 选.gap,
          顶格: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1,
          滚动: {顶: Math.round(sc.scrollTop), 最大: Math.round(sc.scrollHeight - sc.clientHeight)}}; })()`);
      const readPos = () => session.js(`(() => { const w = ${hi.IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(hi.SURFACE)});
        let sc = null; for (const el of [surface, surface.parentElement, d.scrollingElement]) {
          if (el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) { sc = el; break; } }
        const s = w.getSelection(); if (!s || !s.rangeCount) return {无:true};
        const r = s.getRangeAt(0).getBoundingClientRect();
        return {y: Math.round(r.top), x: Math.round(r.left), 滚: sc ? Math.round(sc.scrollTop) : 0}; })()`);
      const 走一段 = async (模式, 标签, shot名) => {
        const geo = await 布置(模式);
        say(`[bandedge] ${标签}布置 ` + JSON.stringify(geo));
        if (!geo || !geo.ok) { say(`[bandedge] ${标签}SKIP（` + (geo && geo.因) + '）'); return null; }
        // 点在**行盒底附近**（末视觉行的中带），下一行就是下一块的首行
        await clickAt(geo.行.左 + 120, geo.行.底 - 8);
        const p0 = await readPos();
        say(`[bandedge] ${标签}起点 ` + JSON.stringify(p0) + ' 文档y=' + (p0.无 ? '?' : p0.y + p0.滚));
        await hi.press(session, 'ArrowDown');
        await hi.sleep(450);
        const p1 = await readPos();
        say(`[bandedge] ${标签}第1键 ` + JSON.stringify(p1) + ' 文档y=' + (p1.无 ? '?' : p1.y + p1.滚));
        await session.shot('bandedge-' + shot名 + '-key1');
        const trace = await session.js(`(() => { const w = ${hi.IF}; return (w.__vtrace || []).slice(-10); })()`);
        say(`[bandedge] ${标签}轨迹 ` + JSON.stringify(trace));
        return {geo, p0, p1};
      };
      { // 一、带内：下一行压折线、滚动还有余地——↓ 必须至少滚一行再落点（V2 按了要动）
        const r = await 走一段('带内', '带内', 'band');
        if (r && r.p0 && r.p1 && !r.p0.无 && !r.p1.无) {
          const 前进 = (r.p1.y + r.p1.滚) - (r.p0.y + r.p0.滚);
          const 滚动量 = r.p1.滚 - r.p0.滚;
          const 形状 = r.geo.带宽 >= 26 && r.geo.带宽 <= 31 && r.geo.下一行顶离折线 >= 1;
          say('[bandedge] 带内判定 ' + (前进 > 2 ? 'PASS' : 'FAIL') + '：文档坐标前进 ' + 前进
            + 'px，滚动 ' + 滚动量 + 'px，带宽 ' + r.geo.带宽 + 'px（26-31 带），下一行顶离折线 '
            + r.geo.下一行顶离折线 + 'px，死区形状成立=' + 形状);
          say('[bandedge] 突变点 extension-src/render/js/typora-patches.js：scan 的 底缘带宽（探测上界与'
            + '行接受上限两处 +(forward?底缘带宽:0)）还原成 -1 一刀切、边缘滚动 的 lineH*2 还原成 1.6，'
            + '带内即回到吞键（文档坐标前进 0）');
          if (前进 <= 2) failed = true;
        }
      }
      { // 二、顶格：scrollTop 顶死也要能落（滚进视口 clamp 语义——光标行盒仍是完整矩形，不隐形）
        const r = await 走一段('顶格', '顶格', 'max');
        if (r && r.p0 && r.p1 && !r.p0.无 && !r.p1.无) {
          const 前进 = (r.p1.y + r.p1.滚) - (r.p0.y + r.p0.滚);
          const 形状 = r.geo.顶格 && r.geo.下一行顶离折线 >= 0;   // 顶死 + 下一行在折线（含之下）
          say('[bandedge] 顶格判定 ' + (前进 > 2 ? 'PASS' : 'FAIL') + '：文档坐标前进 ' + 前进
            + 'px，顶格=' + r.geo.顶格 + '，下一行顶离折线 ' + r.geo.下一行顶离折线 + 'px，形状成立=' + 形状);
          if (前进 <= 2 && 形状) failed = true;
        }
      }
    } finally { await ctx.release(session); }
  }

  fs.writeFileSync(path.join(OUT, CASE + '-log.txt'), log.join('\n'), 'utf8');
  if (failed) process.exitCode = 1;
  console.log('\n日志：' + path.join(OUT, CASE + '-log.txt'));
})().catch(error => { console.error(error); process.exitCode = 1; });
