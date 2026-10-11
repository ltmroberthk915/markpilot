/** R6 第 6 轮键盘导航域 · 判决 F7/F18 修复验收 + F8 存疑取证。
 *  （harness dev：electron.exe + app/main/main.js；输入原语 human-input/hi.cjs）
 *
 *  背景（R6 判决，2026-10-02）：
 *   · F7：PageUp/PageDown 要**按页移动光标**（Typora＝按页跳、保目标列）。修法＝
 *     extension-src/render/js/typora-patches.js 的 patchVerticalMathLine keydown 链加
 *     PageUp/PageDown 分支：步长＝可视一页（面底−工具栏底），先滚一页再在滚动后的新几何里
 *     按目标文档位置解落点（scan 同款 resolve 链，解不出退回 scan 从光标行向目标方向走）；
 *     到顶/到底不吞键不丢列；浮层开着（C2 判据）/阅读模式/查找框聚焦让位。
 *   · F18：Ctrl+←/→ 词跳**同块回绕**——右跳却回块首/坐标更小。修法＝patchHorizontalMathLine
 *     加 ctrl 分支的事后校正：同块文档序倒退 / 非行端跨块 → 钳回起跳行的行尾（右向）/行首（左向）；
 *     五处 ctrl 早退点（typora-patches :744/:1416/:1722/:2134、math-edit :713/:781、
 *     marker-caret-guard :238）一概不动。
 *   · F8（存疑，不修只取证）：Ctrl+Home 疑落"标题文字尾"。读落点块/层/块内偏移/x + 截图
 *     （全景 + 2 倍局部各一张）；复现形状写进证据，供校正清单补"文档首形态"。
 *
 *  断言（每用例输出「R6K2 <名> PASS/FAIL/EVIDENCE — …」）：
 *   F7  ① 每键（落点未到文末的那些）光标**文档 y** 推进 ≥ 一面高×60%（面高＝面底−工具栏底）
 *       ② 12 键内到文末（块＝最后一块，前缀含收尾标记 Z999）
 *       ③ 回程连按 PageUp 回到起点块后，x 与起点 x 差 ≤24px（保目标列）
 *   F18 ① 公式行固定起点 Ctrl+→×8：同块相邻两键 x 不回退（后键 x ≥ 前键 −2px，无同块回绕）
 *       ② 跨块只发生在行端（离开某块的那一步，前一读数 x ≥ 该块历史最大 x −28px）
 *   F8  EVIDENCE：Ctrl+Home 落点读数 + 2 张截图，不设 PASS/FAIL。
 *
 *  探针纪律：素材探针自建于 .perf/r6-keys2/，不碰受保护素材；输入全真实通道
 *  （CDP Input：PageDown/PageUp 原键、Ctrl+→/Ctrl+Home 走 hi.combo 修饰键真实按下）；
 *  每次按键前先断言焦点真在编辑面（hasFocus 且活动元素在编辑面内），焦点丢失立即判 FAIL，
 *  绝不中途"修焦点"（点击会清目标列，读数就假了）。
 *  用法：node probe-r6-keys2.cjs [--only=f7,f18,f8]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/r6-keys2');
const SHOTS = path.join(OUT, 'shots');
const sleep = harness.sleep;

const results = [];
function verdict(name, tag, detail) {
  results.push({ name, tag });
  console.log(`R6K2 ${name} ${tag} — ${detail}`);
}
// --only=f7,f18,f8：只跑指定用例（突变验证用；默认全跑）
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);

// ---------- 素材（自建，不碰受保护目录） ----------
const BODY_LINES = 160;
const pageMd = ['# R6 翻页标题字', '']
  .concat(Array.from({ length: BODY_LINES }, (_, i) => [`L${String(i).padStart(3, '0')} 甲乙丙丁戊己庚辛壬癸`, '']))
  .concat([['Z999 收尾专用尾巴文字有长度', '']]).flat().join('\n');
const formulaMd = [
  '# R6 词跳公式行', '',
  '词跳起点甲乙丙 $a+b$ 中词一 $c+d$ 中词二 $e+f$ 中词三 $g+h$ 尾词四丁戊己', '',
  '上一行铺垫文字甲乙丙丁', '',
  '下一行承接文字甲乙丙丁', '',
].join('\n');

// ---------- 读数：光标 + 所在块 + 层 + 滚动（文档 y ＝ client y ＋ 滚动容器 scrollTop） ----------
const SCROLLER = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const ir = d.querySelector('.vditor-ir');
  for (const el of [s, ir, d.scrollingElement]) if (el && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) return el;
  return s; })()`;
const READ_POS = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}'); if (!s) return null;
  const sel = w.getSelection(); if (!sel || !sel.rangeCount) return { 无选区: true };
  const r = sel.getRangeAt(0); const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  let top = at; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  const 块 = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
  const box = r.getBoundingClientRect();
  let 块内偏移 = -1;
  try { if (top) { const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(r.startContainer, r.startOffset); 块内偏移 = pre.toString().length; } } catch {}
  const sc = ${SCROLLER};
  return { 块, 总块数: s.children.length,
    块文本: top ? String(top.textContent).replace(/\\s+/g, ' ').slice(0, 16) : '',
    块内偏移,
    层: !at || !s.contains(at) ? '外' : at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文',
    前缀: r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 12), r.startOffset) : '',
    x: Math.round(box.left), y: Math.round(box.top), h: Math.round(box.height),
    scrollTop: Math.round(sc.scrollTop), docY: Math.round(box.top + sc.scrollTop) }; })()`;
const readPos = session => session.js(READ_POS);
/** 面高（判读 F7 的"一面"）：编辑面底 − max(面顶, 工具栏底)——与补丁 可视顶() 同口径。 */
const METRICS = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}'); if (!s) return null;
  const r = s.getBoundingClientRect(); const bar = d.querySelector('.vditor-toolbar');
  const b = bar && bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
  const 顶 = b && b.height ? Math.max(r.top, b.bottom) : r.top;
  return { 面顶: Math.round(顶), 面底: Math.round(r.bottom), 一页: Math.round(r.bottom - 顶), 总块数: s.children.length }; })()`;
const readMetrics = session => session.js(METRICS);

/** 按键前的焦点断言（交互验收规则：焦点不在编辑面时一切读数都是假的）。 */
const focusOk = async session => {
  const f = await session.js(hi.FOCUS);
  return !!(f && f.ok);
};

/** setup 阶段的焦点准备（学 probe-r6-para focusEditor + probe-r1-caret ensureFocus）：
 *  冷启动后 hasFocus=false 的实测主因是 **Electron 窗口本身不在前台**——只查不抢永远
 *  红下去。三步：①主进程把窗口 focus 回前台（restore+focus）；②轮询等焦点落进编辑面
 *  （160 块大文档冷启动慢，给足 3s）；③兜底 hi.ensureFocus（surface.focus + 真实点击）。
 *  只在放光标**之前**用（setup 动作）：之后 placeCaretAt 会把光标重摆到固定起点，
 *  点击清掉的"目标列"还没建立，不违反"中途不修焦点"的纪律。 */
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

/** 2 倍局部截图：截在光标所在行附近（clip 360×96 CSS px、scale 2，红读数时能看清光标与高亮）。 */
async function shot2x(session, name, cx, cy, w = 360, h = 96) {
  const fr = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
    return { x: r.x, y: r.y, w: innerWidth, h: innerHeight }; })()`);
  if (!fr) return null;
  const x = Math.max(0, Math.min(Math.round(fr.x + cx - w / 2), Math.round(fr.w - w)));
  const y = Math.max(0, Math.min(Math.round(fr.y + cy - h / 2), Math.round(fr.h - h)));
  const shot = await session.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 2 } });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(shot.data, 'base64'));
  return name;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'page-160.md'), pageMd, 'utf8');
  fs.writeFileSync(path.join(OUT, 'formula-line.md'), formulaMd, 'utf8');

  const exe = fs.existsSync(EXE) ? EXE : path.join(harness.project, 'node_modules', 'electron', 'dist', 'electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP_ARGS, label: 'probe-r6keys2',
      outDir: SHOTS, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let session = null;
  try {
    session = await hi.openDoc(ctx, path.join(OUT, 'page-160.md'), { minBlocks: 150, inspect: true, settleMs: 1500 });

    // ============ F7：160 块 · 固定起点 · PageDown 逐页推进 / PageUp 回程保列 ============
    if (want('f7')) {
      try {
        const START = 4, OFF = 6;
        if (!(await prepareFocus(session)).ok) throw new Error('起点前焦点不在编辑面');
        await session.js(hi.placeCaretAt(START, OFF));
        await sleep(250);
        const 起点 = await readPos(session);
        const metrics = await readMetrics(session);
        if (!起点 || 起点.块 !== START) throw new Error('固定起点没放好：' + JSON.stringify(起点));
        if (!(await focusOk(session))) throw new Error('按键前焦点不在编辑面');
        const 一页 = metrics && metrics.一页 ? metrics.一页 : 0;
        if (!一页) throw new Error('面高读数为 0：' + JSON.stringify(metrics));

        const seq = [];
        let atEnd = false, 焦点丢 = false;
        for (let i = 0; i < 12 && !atEnd; i++) {
          if (!(await focusOk(session))) { 焦点丢 = true; break; }
          await hi.press(session, 'PageDown');
          await sleep(180);
          const s = await readPos(session);
          seq.push(s);
          atEnd = !!s && (s.块 >= s.总块数 - 1 || (s.块文本 || '').includes('Z999') || (s.前缀 || '').includes('收尾'));
        }
        await sleep(300);
        if (seq.length && atEnd) await session.shot('f7-文末');
        // ① 每键（落点未到文末的那些）文档 y 推进 ≥ 一面高 60%；
        //    最后一键若正好落在文末，其推进不参与及格线（钳到文末天然不足一页）
        const advances = [];
        for (let k = 1; k < seq.length; k++) advances.push({ 第k键: k,
          推进: ((seq[k] && seq[k].docY) ?? 0) - ((seq[k - 1] && seq[k - 1].docY) ?? 0) });
        const graded = atEnd ? advances.slice(0, -1) : advances;
        const 及格线 = Math.round(一页 * 0.6);
        const 推进不足 = graded.filter(a => a.推进 < 及格线);
        // ② 12 键内到文末
        const 到文末 = atEnd && seq.length <= 12;
        // ③ 回程：PageUp 按回起点块附近，x 与起点差 ≤24px
        let 回 = null, 回键数 = 0, 回程断 = false;
        if (atEnd) {
          for (let i = 0; i < 16; i++) {
            if (!(await focusOk(session))) { 回程断 = true; break; }
            const now = await readPos(session);
            if (!now || now.块 <= START) { 回 = now; break; }
            await hi.press(session, 'PageUp');
            回键数++;
            await sleep(180);
            回 = await readPos(session);
            if (!回) break;
          }
          await sleep(300);
          if (回) {
            await session.shot('f7-回程');
            await shot2x(session, 'f7-回程-2x', 回.x, 回.y + Math.max(4, (回.h || 18) / 2));
          }
        }
        const 列差 = 回 && 起点 ? Math.abs(回.x - 起点.x) : null;
        const pass = !焦点丢 && !回程断 && seq.length >= 1 && !推进不足.length && 到文末 && 回 !== null && 回.块 <= START && 列差 !== null && 列差 <= 24;
        verdict('F7翻页', pass ? 'PASS' : 'FAIL',
          `面高=${一页}px 起点=块${START}@x${起点.x}(docY${起点.docY}) `
          + `下行${seq.length}键到文末=${atEnd}(${(seq.at(-1) || {}).块}/${(seq.at(-1) || {}).总块数}) `
          + `逐键推进=${advances.map(a => a.推进).join(',')} 及格线=${及格线} 不足=${推进不足.length}键 `
          + `回程${回键数}键 落=块${回 ? 回.块 : '?'}@x${回 ? 回.x : '?'} 列差=${列差 === null ? '未测' : 列差 + 'px'}(≤24) `
          + (焦点丢 ? '焦点丢失!' : '') + (回程断 ? '回程焦点断!' : '')
          + `；截图=f7-文末.png+f7-回程.png+f7-回程-2x.png`);
      } catch (error) {
        verdict('F7翻页', 'FAIL', '用例异常：' + (error && error.message || error));
      }
    }

    // ============ F8：Ctrl+Home 存疑取证（不修，读数 + 截图） ============
    if (want('f8')) {
      try {
        if (!(await prepareFocus(session)).ok) throw new Error('取证前焦点不在编辑面');
        await session.js(hi.placeCaretAt(90, 6));
        await sleep(250);
        const 起 = await readPos(session);
        if (!(await focusOk(session))) throw new Error('按键前焦点不在编辑面');
        await hi.combo(session, 'Ctrl+Home');
        await sleep(450);
        const 落 = await readPos(session);
        await session.shot('f8-ctrlhome');
        if (落) await shot2x(session, 'f8-ctrlhome-2x', 落.x, 落.y + Math.max(4, (落.h || 18) / 2));
        // "落标题文字尾"形状：块 0（H1）、层=正文、块内偏移≈标题全长（即停在标题文字末尾而非行首/标记前）
        const 标题全长 = 落 && 落.总块数 ? await session.js(`(() => { const w = ${hi.IF}, d = w.document;
          const s = d.querySelector('${hi.SURFACE}'); const h = s && s.children[0];
          return h ? String(h.textContent).replace(/\\s+/g, '').length : -1; })()`) : -1;
        const 复现标题尾 = !!(落 && 落.块 === 0 && 落.层 === '正文' && 标题全长 > 0
          && Math.abs(落.块内偏移 - 标题全长) <= 1);
        verdict('F8取证', 'EVIDENCE',
          `起点=块${起 ? 起.块 : '?'} → Ctrl+Home 落：块=${落 ? 落.块 : '?'}/${落 ? 落.总块数 : '?'} `
          + `层=${落 ? 落.层 : '?'} 块内偏移=${落 ? 落.块内偏移 : '?'}/${标题全长}(标题去空全长) `
          + `x=${落 ? 落.x : '?'} y=${落 ? 落.y : '?'} 前缀=${JSON.stringify(落 ? 落.前缀 : '')} `
          + `块文本=${JSON.stringify(落 ? 落.块文本 : '')} `
          + `落标题文字尾复现=${复现标题尾 ? '是（校正清单需补「文档首形态」）' : '否（本次未复现该形状）'}`
          + `；截图=f8-ctrlhome.png+f8-ctrlhome-2x.png`);
      } catch (error) {
        verdict('F8取证', 'EVIDENCE', '取证异常：' + (error && error.message || error));
      }
    }

    // ============ F18：公式行固定起点 · Ctrl+→×8 无同块回绕、跨块仅在行端 ============
    if (want('f18')) {
      try {
        // 同窗口换文档（真实菜单 + 主进程 dialog 替身，链路同 probe-r6-para d34）
        await session.main.script([{ dialog: 'open', files: [path.join(OUT, 'formula-line.md')] }]);
        await session.main.clickMenu('文件 > 在此窗口打开文件…');
        await session.until(hi.readyExpr(4), { timeout: 60000, interval: 100 });
        await sleep(1200);
        if (!(await prepareFocus(session)).ok) throw new Error('起点前焦点不在编辑面');
        await session.js(hi.placeCaretAt(1, 0));                       // 公式行（块 1）行首固定起点
        await sleep(250);
        const 起点 = await readPos(session);
        if (!起点 || 起点.块 !== 1) throw new Error('固定起点没放好：' + JSON.stringify(起点));

        const seq = [起点];
        let 焦点丢 = false;
        for (let i = 0; i < 8; i++) {
          if (!(await focusOk(session))) { 焦点丢 = true; break; }
          await hi.combo(session, 'Ctrl+ArrowRight');
          await sleep(200);
          seq.push(await readPos(session));
        }
        await sleep(300);
        const 末 = seq.at(-1);
        await session.shot('f18-终点');
        if (末) await shot2x(session, 'f18-终点-2x', 末.x, 末.y + Math.max(4, (末.h || 18) / 2));
        // ① 同块相邻两键 x 不回退；② 跨块仅行端（前一读数 x ≥ 该块历史最大 x −28px）
        const 回绕 = [], 跨块非行端 = [], 跨块 = [];
        const maxX = new Map();
        for (const s of seq) if (s && s.块 >= 0) maxX.set(s.块, Math.max(maxX.get(s.块) ?? -Infinity, s.x));
        for (let k = 1; k < seq.length; k++) {
          const a = seq[k - 1], b = seq[k];
          if (!a || !b) continue;
          if (a.块 === b.块 && b.x < a.x - 2) 回绕.push(`第${k}键 块${a.块} x${a.x}→${b.x}`);
          if (a.块 !== b.块) {
            跨块.push(`第${k}键 块${a.块}→${b.块}`);
            if (a.x < (maxX.get(a.块) ?? a.x) - 28) 跨块非行端.push(`第${k}键 离块${a.块}时 x${a.x} < 块内最大${maxX.get(a.块)}`);
          }
        }
        const 序列 = seq.map((s, i) => `${i}:${s ? '块' + s.块 + '@x' + s.x + '/' + s.层 : '?'}`).join(' → ');
        const pass = !焦点丢 && !回绕.length && !跨块非行端.length;
        verdict('F18词跳', pass ? 'PASS' : 'FAIL',
          `序列=[${序列}] `
          + `同块回绕=${回绕.length ? 回绕.join('；') : '无'} `
          + `跨块=${跨块.length ? 跨块.join('；') + '（行端判定：' + (跨块非行端.length ? '有非行端跨块!' : '均在行端') + '）' : '无'} `
          + `校正动作计数=__typoraWordWrapFix=${await session.js(`(() => { const w = ${hi.IF}; return w && w.__typoraWordWrapFix ? JSON.stringify(w.__typoraWordWrapFix) : 'null'; })()`)} `
          + (焦点丢 ? '焦点丢失!' : '')
          + `；截图=f18-终点.png+f18-终点-2x.png`);
      } catch (error) {
        verdict('F18词跳', 'FAIL', '用例异常：' + (error && error.message || error));
      }
    }
  } finally {
    if (session) await session.close();
  }

  const failed = results.filter(r => r.tag === 'FAIL');
  console.log(failed.length ? `\n★ R6K2 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}）`
    : `\nR6K2 汇总：全部 ${results.length} 项通过（PASS/EVIDENCE）`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });

/** 突变验证（每条把修复改回旧形态，本探针对应用例必须变红）：
 *  · F7 翻页回归①：typora-patches.js 纵向层 keydown 里把
 *        if (event.key === "PageUp" || event.key === "PageDown") { … }
 *    整段注掉（回到"这两键交原生"的旧形态）→ IR 面原生 PageDown 不按页推光标
 *    → 逐键推进跌破 0.6×面高 → 「F7翻页」FAIL。
 *  · F7 保列回归②：pageJump 到顶/到底分支的 `return true` 改成 `reset(); return true;`
 *    （目标列被丢）→ 底部连按 PageDown 再回程，回程落点按"底行那一列"走
 *    → 列差 >24px → 「F7翻页」FAIL。
 *  · F18 回归：patchHorizontalMathLine 的 keydown 里把
 *        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) { 词跳校正(…); return; }
 *    注掉 → 公式行 Ctrl+→ 同块回绕重现（后键 x < 前键）→ 「F18词跳」FAIL。
 *  · F8 为取证用例（EVIDENCE），不参与突变。
 */
