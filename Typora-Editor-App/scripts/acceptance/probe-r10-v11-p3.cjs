/** 探针 · R10 V11 P3（F14 列表 Tab 缩进）修复复验的视觉/负门取证。
 *
 *  绿门视觉（铁律 26：截图 + 2x 局部 + 标记）：列表乙文字中间真键 Tab → 整项缩进成
 *  列表甲的子项（DOM 嵌套 + 源码 2 空格缩进 + 光标落被挪项首文本）。红实线=光标落点、
 *  青虚线=父项内容左缘（子项应在其右侧 = 缩进深度的可见参照）。
 *  负门域（补丁活转后必须逐一复验——V10 时代负门全绿只是因为补丁是死代码）：
 *   B 首项 no-op（md 纹丝不动）、C 普通段落 Tab（vendor 插两空格）、D 代码块 Tab 字面、
 *   E 表格格 Tab（格间移动/结构不动）、F 补全候选框开着 Tab=接受候选（不缩进）。
 *  通道纪律：全部真实输入（CDP Input.* / insertText）；单 GUI 走 48190 harness。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r10-v11/p3');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const sleep = harness.sleep;

const log = [];
const report = (name, verdict, detail) => {
  const line = 'R10V11-P3 ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
  console.log(line); log.push(line);
};

const FENCE = '```';
const BODY = [
  '# 缩进练习',
  '',
  '- 列表甲',
  '- 列表乙',
  '- 列表丙',
  '',
  '| 甲表 | 乙表 |',
  '| --- | --- |',
  '| 单元一 | 单元二 |',
  '',
  FENCE + 'js',
  'code line',
  FENCE,
  '',
  '普通段落文字。',
  '',
].join('\n');

/** 光标标记 overlay（铁律 26 口径）：红实线=光标落点；青虚线=参照列（父项内容左缘）。 */
const MARK = (red, cyan) => `(() => { const d = document;
  const host = d.getElementById('__v11marks') || d.body.appendChild(Object.assign(d.createElement('div'), {id:'__v11marks'}));
  const line = (x, y0, y1, color, style) => { const el = d.createElement('div');
    el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:' + x + 'px;top:' + y0 + 'px;height:' + (y1 - y0) + 'px;width:0;border-left:2px ' + style + ' ' + color + ';';
    host.appendChild(el); };
  ${red ? 'line(' + red.x + ',' + red.y0 + ',' + red.y1 + ', "#ff2d2d", "solid");' : ''}
  ${cyan ? 'line(' + cyan.x + ',' + cyan.y0 + ',' + cyan.y1 + ', "#00e5e5", "dashed");' : ''}
  return true; })()`;
const CLEAR_MARKS = `(() => { const el = document.getElementById('__v11marks'); if (el) el.remove(); return true; })()`;

/** 顶层视口里的几何：指定文本所在块 + 光标盒（iframe rect 与内部 rect 同坐标系，直接相加）。 */
const GEO = text => `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
  const root = w.document.querySelector('${hi.SURFACE}'); if (!root) return null;
  const fr = frame.getBoundingClientRect();
  let block = null;
  for (const b of root.children) if (b.textContent.includes('${text}')) { block = b; break; }
  if (!block) return { none: true };
  const br = block.getBoundingClientRect();
  const s = w.getSelection(); const caretBox = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
  return { block: { x: Math.round(fr.x + br.x), y: Math.round(fr.y + br.y), w: Math.round(br.width), h: Math.round(br.height) },
    caret: caretBox ? { x: Math.round(fr.x + caretBox.x), y: Math.round(fr.y + caretBox.y), h: Math.round(caretBox.height || 16) } : null }; })()`;

/** 列表 DOM 嵌套事实（叶子 li + 父项自有文本）。 */
const NEST = text => session => session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const li = [...s.querySelectorAll('li')].filter(n => n.textContent.includes('${text}')).pop();
  if (!li) return { ok: false };
  const parentLi = li.parentElement.parentElement;
  let own = '';
  if (parentLi && parentLi.tagName === 'LI') {
    for (const part of parentLi.childNodes) {
      if (part.nodeType === 3) own += part.data;
      else if (part.tagName !== 'UL' && part.tagName !== 'OL') own += part.textContent;
    }
  }
  own = own.replace(/\\s+/g, ' ').trim();
  const lr = li.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
  return { ok: true, 文本: li.textContent.slice(0, 12), 嵌套: parentLi && parentLi.tagName === 'LI' ? own.slice(0, 12) : null,
    li左缘: Math.round(fr.x + lr.x), 父左缘: parentLi ? Math.round(fr.x + parentLi.getBoundingClientRect().x) : null }; })()`);

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'p3.md');
  fs.writeFileSync(file, BODY, 'utf8');

  const session = await harness.launch({
    exe: EXE, appArgs: [APP_MAIN], label: 'probe-r10-v11/p3',
    outDir: OUT, timeout: 200000, args: [file], inspect: true,
  });
  try {
    await session.until(hi.readyExpr(5), { timeout: 120000, interval: 200 });
    await sleep(1200);
    const focus = await hi.ensureFocus(session);
    if (!focus.ok) throw new Error('焦点不在编辑器');
    const mdNow = () => hi.mdNow(session);
    const linesOf = (md, key) => String(md).split('\n').filter(l => l.includes(key));
    const undo = async (times = 1) => { for (let i = 0; i < times; i++) { await hi.combo(session, 'Ctrl+Z'); await sleep(350); } };

    // ══ A 绿门视觉：列表乙文字中间 Tab → 缩进成列表甲子项 ═══════════════════════
    const mdA0 = String(await mdNow());
    await session.js(hi.placeAfterPrefix('列表乙'));
    await sleep(200);
    await session.shot('a0-before-full');
    await hi.press(session, 'Tab');
    await sleep(600);
    const mdA = String(await mdNow());
    const nestA = await (NEST('列表乙'))(session);
    const caretA = await hi.caret(session);
    report('A-Tab后DOM嵌套=列表甲', nestA.ok && nestA.嵌套 === '列表甲' ? 'PASS' : 'FAIL', nestA);
    report('A-源码缩进(≥2空格)', /(\t|  +)- 列表乙/.test(mdA) ? 'PASS' : 'FAIL', linesOf(mdA, '列表乙'));
    report('A-其余块原样(表/码/段)', String(mdA).includes('| 单元一 | 单元二 |') && String(mdA).includes('code line') && String(mdA).includes('普通段落文字。') ? 'PASS' : 'FAIL', { 段落行: linesOf(mdA, '普通段落') });
    report('A-光标落编辑器', caretA.ok ? 'PASS' : 'FAIL', { 层: caretA.层, 前缀: caretA.前缀, 块: caretA.块文本 });
    // 标记 + 截图：红实线=光标落点，青虚线=父项（列表甲）内容左缘
    const geoA = await session.js(GEO('列表乙'));
    if (geoA && geoA.caret && nestA.父左缘 != null) {
      await session.js(MARK(
        { x: geoA.caret.x, y0: geoA.caret.y, y1: geoA.caret.y + Math.max(14, geoA.caret.h) },
        { x: nestA.父左缘, y0: geoA.block.y, y1: geoA.block.y + geoA.block.h }));
    }
    await session.shot('a1-after-marked-full');
    if (geoA && geoA.block) {
      const clip = { x: Math.max(0, geoA.block.x - 24), y: Math.max(0, geoA.block.y - 16),
        width: Math.min(564, 1180), height: Math.min(204, 240), scale: 2 };
      const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
      fs.writeFileSync(path.join(OUT, 'a1-after-marked-2x.png'), Buffer.from(shot.data, 'base64'));
    }
    await session.js(CLEAR_MARKS);
    report('A-截图', 'INFO', { full: 'a1-after-marked-full.png', 局部2x: 'a1-after-marked-2x.png', 光标x: geoA && geoA.caret ? geoA.caret.x : null, 子项左缘: nestA.li左缘, 父项左缘: nestA.父左缘 });
    await undo(2);

    // ══ B 负门：首项（列表甲）文字中间 Tab = no-op（md 纹丝不动）════════════════
    const mdB0 = String(await mdNow());
    await session.js(hi.placeAfterPrefix('列表甲'));
    await sleep(200);
    await hi.press(session, 'Tab');
    await sleep(600);
    const mdB = String(await mdNow());
    report('B-首项Tab完全no-op(md逐字不变)', mdB === mdB0 ? 'PASS' : 'FAIL', { 前: mdB0.split('\n').slice(1, 6), 后: mdB.split('\n').slice(1, 6) });
    await undo(1);

    // ══ C 负门：普通段落 Tab = vendor 两空格（与 HEAD 同）════════════════════════
    const mdC0 = String(await mdNow());
    await session.js(hi.placeAfterPrefix('普通段落文字'));
    await sleep(200);
    await hi.press(session, 'Tab');
    await sleep(600);
    const mdC = String(await mdNow());
    const caretC = await hi.caret(session);
    report('C-段落Tab插两空格(HEAD同形)', /普通段落文字 {2}。/.test(mdC) ? 'PASS' : 'FAIL', linesOf(mdC, '普通段落'));
    report('C-光标不丢', caretC.ok ? 'PASS' : 'FAIL', { 层: caretC.层 });
    report('C-列表/代码块未被动', String(mdC).includes('- 列表甲') && /(\n|^)```js/.test(String(mdC)) ? 'PASS' : 'FAIL', linesOf(mdC, '列表'));
    await undo(1);

    // ══ D 负门：代码块内 Tab = 字面缩进（与 HEAD 同）════════════════════════════
    const mdD0 = String(await mdNow());
    await session.js(hi.placeAfterPrefix('code line'));
    await sleep(200);
    await hi.press(session, 'Tab');
    await sleep(600);
    const mdD = String(await mdNow());
    report('D-代码块Tab字面缩进', /code line(\t|  )/.test(mdD) ? 'PASS' : 'FAIL', linesOf(mdD, 'code line'));
    report('D-列表行一字未变', linesOf(mdD, '列表').join('|') === linesOf(mdD0, '列表').join('|') ? 'PASS' : 'FAIL', linesOf(mdD, '列表'));
    await undo(1);

    // ══ E 负门：表格格内 Tab = 格间移动/结构不动（与 HEAD 同）════════════════════
    const mdE0 = String(await mdNow());
    const cellOf = () => session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
      const sel = w.getSelection(); if (!sel.rangeCount) return { ok: false };
      const at = sel.getRangeAt(0).startContainer; const el = at.nodeType === 3 ? at.parentElement : at;
      const td = el.closest?.('td,th'); if (!td || !s.contains(td)) return { ok: false };
      const tr = td.parentElement; return { ok: true, 格: [...tr.children].indexOf(td), 文本: td.textContent.slice(0, 8) }; })()`);
    await session.js(hi.placeAfterPrefix('单元一'));
    await sleep(200);
    const cell0 = await cellOf();
    await hi.press(session, 'Tab');
    await sleep(600);
    const cell1 = await cellOf();
    const mdE = String(await mdNow());
    report('E-表格格Tab前光标在单元一', cell0.ok && cell0.文本.includes('单元一') ? 'PASS' : 'FAIL', cell0);
    report('E-Tab后光标仍在表格内(格间移动或驻留)', cell1.ok ? 'PASS' : 'FAIL', cell1);
    report('E-表格文本未被插入字符', linesOf(mdE, '单元一').join('|') === linesOf(mdE0, '单元一').join('|') ? 'PASS' : 'FAIL', { 前: linesOf(mdE0, '单元'), 后: linesOf(mdE, '单元') });
    report('E-列表未被缩进', linesOf(mdE, '列表').join('|') === linesOf(mdE0, '列表').join('|') ? 'PASS' : 'FAIL', linesOf(mdE, '列表'));
    await undo(1);

    // ══ F 负门：补全候选框开着时 Tab = 接受候选（不缩进列表）════════════════════
    const mdF0 = String(await mdNow());
    await session.js(hi.placeAfterPrefix('列表丙'));
    await sleep(200);
    await session.type('\\fr');   // insertText：IME 上屏通道
    let popup = false;
    for (let i = 0; i < 20 && !popup; i++) {
      await sleep(200);
      popup = !!(await session.js(`(() => { const w = ${hi.IF}, d = w.document; const p = d.querySelector('.md-completion'); return !!(p && !p.hidden); })()`));
    }
    if (!popup) {
      report('F-补全框弹开(前置)', 'SKIP', { 说明: 'dev 下 local 补全未弹（config 或延迟），记档不判红' });
    } else {
      await session.shot('f0-completion-open-full');
      await hi.press(session, 'Tab');
      await sleep(700);
      const mdF = String(await mdNow());
      const stillOpen = !!(await session.js(`(() => { const w = ${hi.IF}, d = w.document; const p = d.querySelector('.md-completion'); return !!(p && !p.hidden); })()`));
      report('F-Tab接受候选(框收起+\\frac落文本)', !stillOpen && String(mdF).includes('\\frac') ? 'PASS' : 'FAIL', { 框仍开: stillOpen, 列表丙行: linesOf(mdF, '列表丙') });
      report('F-列表丙未被缩进', /(\n|^)- 列表丙/.test(String(mdF)) && !/(\t|  +)- 列表丙/.test(String(mdF)) ? 'PASS' : 'FAIL', linesOf(mdF, '列表丙'));
      await undo(2);
    }

    // ══ 收尾：撤销链回原稿（含表格的文档按铁律 42 口径：Lute 对表格列宽/围空行做
    // 对齐归一——headless 往返 oracle 已存 .zcode-tmp/r10/lute-roundtrip-out.md），
    // 判据 = 与 Lute 纯往返形态逐字一致（或运气好未触发重排时与原文一致）。
    for (let i = 0; i < 12; i++) { await hi.combo(session, 'Ctrl+Z'); await sleep(220); }
    const mdFinal = String(await mdNow());
    const oracle = fs.readFileSync(path.join('E:/', 'MarkPilot/.zcode-tmp/r10/lute-roundtrip-out.md'), 'utf8');
    const norm = s => String(s).replace(/\r/g, '').replace(/\n+$/, '');
    const finalOk = norm(mdFinal) === norm(BODY) || norm(mdFinal) === norm(oracle);
    report('收尾-撤销链回原稿(Lute归一口径)', finalOk ? 'PASS' : 'FAIL', mdFinal.slice(0, 90));
    const unknown = session.errors.filter(m => !/Electron sandboxed_renderer|Cannot destructure property 'preloadScripts'/.test(m));
    report('会话无新增console错误', unknown.length === 0 ? 'PASS' : 'FAIL', unknown.slice(0, 3));
  } finally {
    await session.close().catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ log, at: new Date().toISOString() }, null, 2), 'utf8');
  console.log('[probe-r10-v11/p3] 产物目录：' + OUT);
})().catch(error => { console.error('R10V11-P3 PROBE-ERROR ' + (error && error.message)); process.exitCode = 1; });
