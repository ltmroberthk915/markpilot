/** R7 定点收尾 · F8（125① Ctrl+Home 未生效）与 F18b（123③ 公式边界停顿）打点定位。
 *  （harness dev：electron.exe + app/main/main.js；输入原语 human-input/hi.cjs）
 *
 *  与 runner 场景的差别只在"读数密度"：按键路径、素材、等待时长与场景**逐字一致**
 *  （125① = page-nav 164 段文档 → Ctrl+End → sleep400 → Ctrl+Home → sleep400；
 *   123③ = word-motion → placeAfterPrefix('标点。') → Ctrl+←×10 → Ctrl+→×10，每键 sleep220），
 *  额外把 typora-patches.js 里的 window.__r7dbg 打点倾倒出来 + Ctrl+Home 后 25ms 一档的光标时间线。
 *
 *  用法：node probe-r7fix2.cjs [--only=f8,f18b]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/r7fix2');
const sleep = harness.sleep;
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);

// ---------- 素材（与场景逐字一致） ----------
const para = n => `第 ${n} 段：撑高度用的普通中文句子，带一点公式 $a_{${n}}$ 与英文 word${n}。`;
const PAGE_NAV = [
  '# 页面导航练习', '',
  ...Array.from({ length: 120 }, (_, i) => para(i + 1)), '',
  '锚点甲：这一段的开头就是查找目标。', '',
  ...Array.from({ length: 40 }, (_, i) => para(200 + i)), '',
  '长行段落：' + '甲乙丙丁戊己庚辛壬癸'.repeat(24) + '长行到此为止。', '',
  '尾段：文档收尾。', '',
].join('\n');
const LINE = '中文english混排word2与$x^2+1$以及标点。';
const WORD_MOTION = LINE + '\n\n第二段落备用。\n';

// ---------- 读数 ----------
const CARET = hi.caret;
const DOC_PREFIX = `(() => { const w = ${hi.IF}, d = w.document;
  const surface = d.querySelector('${hi.SURFACE}'); const s = w.getSelection();
  if (!surface || !s || !s.rangeCount) return null; const r = s.getRangeAt(0);
  if (!r.startContainer || !surface.contains(r.startContainer)) return null;
  const pre = d.createRange(); pre.selectNodeContents(surface);
  try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return null; }
  // 与场景 123③ 同口径：上一块块尾与下一块块首是同一个 DOM 点，块首（窗口里挂着前一块）+0.5
  let bump = 0;
  try {
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const blk = at && at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th') : null;
    if (blk && blk.parentElement === surface && blk.previousElementSibling) {
      const head = d.createRange(); head.selectNodeContents(blk);
      head.setEnd(r.startContainer, r.startOffset);
      if (!String(head.toString()).replace(/[\\s\\u200b\\u200c]/g, '')) bump = 0.5;
    }
  } catch (e) {}
  return pre.toString().length + bump; })()`;
const dumpDbg = session => session.js(`(() => { const w = ${hi.IF};
  return w && w.__r7dbg ? w.__r7dbg : null; })()`);
const clearDbg = session => session.js(`(() => { const w = ${hi.IF}; if (w) w.__r7dbg = []; return true; })()`);

const prepareFocus = async session => {
  try {
    await session.main.js(`(() => { const r = global.windows[0]; if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.focus(); } return true; })()`);
  } catch { /* 主进程通道不在：跳到轮询 */ }
  for (let i = 0; i < 20; i++) {
    const f = await session.js(hi.FOCUS);
    if (f && f.ok) return f;
    await sleep(150);
  }
  return hi.ensureFocus(session);
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: APP_ARGS, label: 'probe-r7fix2', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let session = null;
  try {
    // ============ F8：125① 原路径复现 + 光标时间线 + 打点倾倒 ============
    if (want('f8')) {
      fs.writeFileSync(path.join(OUT, 'page-nav.md'), PAGE_NAV, 'utf8');
      session = await hi.openDoc(ctx, path.join(OUT, 'page-nav.md'), { minBlocks: 30, settleMs: 1800 });
      const focus = await hi.ensureFocus(session);
      console.log('[F8] 焦点在编辑器：', focus.ok);
      await clearDbg(session);
      await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
      await sleep(400);
      let info = await CARET(session);
      console.log('[F8] Ctrl+End 后：', JSON.stringify({ 块: info.块, 块文本: info.块文本, 层: info.层, 偏移: info.偏移, 前缀: info.前缀 }));
      await clearDbg(session);
      const t0 = Date.now();
      await hi.press(session, 'Home', { modifiers: hi.MOD.ctrl });
      // 25ms 一档的时间线：光标什么时候进的第一块、进了哪个位置；第一块什么时候挂载
      const timeline = [];
      while (Date.now() - t0 < 800) {
        const t = Date.now() - t0;
        const c = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
          const sel = w.getSelection(); if (!s || !sel || !sel.rangeCount) return { 无: true };
          const r = sel.getRangeAt(0); const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
          let top = at; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
          const 块 = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
          return { 块, 首块: s.firstElementChild ? String(s.firstElementChild.textContent).slice(0, 8) : null,
            层: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文',
            node: r.startContainer.nodeType === 3 ? 'T:' + String(r.startContainer.data).slice(0, 8) : r.startContainer.nodeName, off: r.startOffset }; })()`);
        timeline.push({ t, ...c });
        await sleep(25);
      }
      // 压缩时间线：只保留状态变化点
      const changes = [];
      let prevKey = null;
      for (const c of timeline) {
        const key = c.无 ? '无' : `${c.块}/${c.node}@${c.off}/${c.层}`;
        if (key !== prevKey) { changes.push({ t: c.t, ...c }); prevKey = key; }
      }
      console.log('[F8] Ctrl+Home 后光标状态变化（t=ms，按键为 0）：');
      for (const c of changes) console.log('   ', JSON.stringify(c));
      const final = await CARET(session);
      console.log('[F8] +800ms 终态：', JSON.stringify({ 块: final.块, 块文本: final.块文本, 层: final.层, 偏移: final.偏移, 前缀: final.前缀 }),
        final.块 === 0 && final.偏移 === 0 ? '→ 形态判定：绿' : '→ 形态判定：红（未到最前可用位）');
      const dbgLog = await dumpDbg(session);
      console.log('[F8] __r7dbg 打点（', (dbgLog || []).length, '条）：');
      for (const e of dbgLog || []) console.log('   ', JSON.stringify(e));
      await session.close();
      session = null;
    }

    // ============ F18b：123③ 原路径复现 + 每键打点倾倒 ============
    if (want('f18b')) {
      fs.writeFileSync(path.join(OUT, 'word-motion.md'), WORD_MOTION, 'utf8');
      session = await hi.openDoc(ctx, path.join(OUT, 'word-motion.md'), { minBlocks: 2 });
      const focus = await hi.ensureFocus(session);
      console.log('[F18b] 焦点在编辑器：', focus.ok);
      await session.js(hi.placeAfterPrefix('标点。'));
      await sleep(150);
      const docPrefix = async () => { const v = await session.js(DOC_PREFIX); return v === null ? -1 : v; };
      await clearDbg(session);
      const lefts = [];
      for (let i = 0; i < 10; i++) {
        await hi.press(session, 'ArrowLeft', { modifiers: hi.MOD.ctrl });
        await sleep(220);
        lefts.push(await docPrefix());
        if (lefts.at(-1) === 0) break;
      }
      console.log('[F18b] Ctrl+← 序列：', JSON.stringify(lefts));
      await clearDbg(session);
      const rights = [];
      const rightCarets = [];
      for (let i = 0; i < 10; i++) {
        await hi.press(session, 'ArrowRight', { modifiers: hi.MOD.ctrl });
        await sleep(220);
        rights.push(await docPrefix());
        rightCarets.push(await CARET(session));
      }
      const rightEnd = await CARET(session);
      console.log('[F18b] Ctrl+→ 序列：', JSON.stringify(rights),
        rights.every((v, i) => i === 0 || v > rights[i - 1]) ? '→ 单调：绿' : '→ 单调：红（存在不增步；块界跨步另见下方口径判）');
      console.log('[F18b] 末点：', JSON.stringify({ 块文本: rightEnd.块文本, 层: rightEnd.层, 偏移: rightEnd.偏移, 前缀: rightEnd.前缀 }));
      // 【F18c 见证】第 6 键（从"与"前起跳、跨公式那一步）必须落在公式后的**下一个词位**
      // （'以'开头：文本偏移 0、前缀空），而不是被行端兜底一步钳到整行行尾（'。'尾：偏移 5、
      // 前缀"以及标点。"）。公式=一个词：跨距 12（与+公式），行端粗钳的跨距是 17。
      // （块文本在 READ_CARET 里截 24 字，验不到"以及标点"，判据只用偏移+前缀。）
      const step6 = rightCarets[5];
      const f18cOk = !!step6 && step6.ok && step6.偏移 === 0 && String(step6.前缀) === '' && rights[5] - rights[4] <= 13;
      console.log('[F18b] F18c 公式边界钳见证（第6键落点=公式后下一词位）:', f18cOk ? '绿' : '红',
        JSON.stringify(step6 && { 偏移: step6.偏移, 前缀: step6.前缀, 跨距: rights[5] - rights[4] }));
      const dbgLog = await dumpDbg(session);
      console.log('[F18b] __r7dbg 打点（', (dbgLog || []).length, '条）：');
      for (const e of dbgLog || []) console.log('   ', JSON.stringify(e));
    }
    // ============ F18d：123① 原路径复现（Ctrl+Backspace 词删 vs 公式整体） ============
    if (want('f18d')) {
      fs.writeFileSync(path.join(OUT, 'word-motion.md'), WORD_MOTION, 'utf8');
      session = await hi.openDoc(ctx, path.join(OUT, 'word-motion.md'), { minBlocks: 2 });
      const focus = await hi.ensureFocus(session);
      console.log('[F18d] 焦点在编辑器：', focus.ok);
      const parityOfDollar = text => (String(text).match(/\$/g) || []).length % 2 === 0;
      const contiguousCut = (a, b) => {
        a = String(a); b = String(b);
        let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
        let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
        return { removed: a.slice(head, a.length - tail), inserted: b.slice(head, b.length - tail) };
      };
      await session.js(hi.placeAfterPrefix('标点。'));
      await sleep(150);
      await clearDbg(session);
      let prev = String(await hi.mdNow(session));
      const steps = [];
      for (let i = 0; i < 6; i++) {
        await hi.press(session, 'Backspace', { modifiers: hi.MOD.ctrl });
        await sleep(300);
        const now = String(await hi.mdNow(session));
        const cut = contiguousCut(prev, now);
        steps.push({ step: i + 1, 删掉: cut.removed, 成对: parityOfDollar(now) });
        prev = now;
      }
      console.log('[F18d] Ctrl+Backspace 六连：', JSON.stringify(steps));
      console.log('[F18d] 判定：', steps.every(s => s.成对 || String(s.删掉).includes('$')) && steps.every(s => s.删掉.length >= 1 && s.删掉.length <= 12) ? '绿（单一连续删除且 $ 不拆坏）' : '红');
      console.log('[F18d] md 尾 40：', JSON.stringify(prev.slice(-40)));
    }
  } finally {
    if (session) await session.close();
  }
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });
