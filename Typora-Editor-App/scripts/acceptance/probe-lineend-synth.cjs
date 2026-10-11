/** 把"行末余量"（本行最后一个字形右缘 → 容器右缘的距离）当成**可扫的参数**，
 *  并用**用户判据**（点完之后打一个字符，落在哪里）读出每种几何的真实后果。
 *
 *  为什么这么做：用户文档上"点行尾空白、光标跑进公式源码"稳定复现，但那份几何
 *  （公式右缘 883 / 段落右缘 894，11px 余量）取决于具体文字与版心，用固定素材造不出来
 *  （上一轮两版素材都失败：`$a+b$` 单独成段余量太大、长公式溢出而不折行）。
 *  既然缺陷与"余量"有关，就把它扫一遍：一屏铺满 `A…A $x+1$` 候选段，k 逐段递增，
 *  余量逐段变小；每段在「公式右缘 +4px / 段落右缘 -3px / 段落右缘 +40px」各点一次，
 *  然后**真的打一个字符**再读回段落源码与公式源码——"字落进公式里"才是用户看到的事。
 *
 *  落点纵向必须取**公式自己那一行**的中线（用整段盒子取中线在折行段落里会落到两行之间，
 *  读数会被"点在行缝里"污染——上一版就踩了这个坑）。
 *
 *  用法：node scripts/acceptance/probe-lineend-synth.cjs
 *        node scripts/acceptance/probe-lineend-synth.cjs --spots=formula-edge,far-right
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-lineend-synth');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';
const OWNER = '.vditor-ir__node[data-type="inline-node"]';
const PREVIEW = '.vditor-ir__preview';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  // +3 是 '--' 与 '=' 两个字符（写 +1 会切出 "only=18,25"，Number 出来是 NaN，
  // 循环一次都不跑、静默输出空表——本轮就踩了这个坑）
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 候选段：`第 n 段：` + `A`×k + ` $x+1$`。k 递增 → 公式整体右移 → 余量递减；
 *  跨过折行处余量会跳回"整整一行"。末尾补两段"像用户文档"的：中文长段（折行）+ 公式收尾、
 *  以及行末是**文本**的对照（规则必须放过它）。 */
const FILLERS = Array.from({ length: 24 }, (_, index) => index * 4);
const fixture = () => {
  const lines = ['# 行末余量扫描', ''];
  FILLERS.forEach((k, index) => {
    lines.push(`第 ${index} 段：` + 'A'.repeat(k) + ' $x+1$');
    lines.push('');
  });
  lines.push('中文长段落：' + '这一段用来撑满整行并折行，公式落在其中某一行的末尾，'.repeat(3) + '收尾 $y+2$');
  lines.push('');
  lines.push('对照（行末是文本）：' + 'A'.repeat(60) + ' 收尾是文字。');
  lines.push('');
  return lines.join('\n');
};

const SPOTS = {
  'formula-edge': {at: 'formula', dx: 4, why: '公式右缘 +4px（用户点的那一下）'},
  'far-right': {at: 'block', dx: -3, why: '段落右缘 -3px（行末余量里，靠容器边）'},
  'outside': {at: 'block', dx: 40, why: '段落右缘 +40px（行外空白）'},
  inside: {at: 'formula', dx: -30, why: '公式内部（对照：本来就该进公式）'},
};

/** 落点：滚到可见 → 量公式/段落盒 → 纵向取**公式那一行**的中线 → 给顶层页坐标。 */
const SPOT = (index, which) => `(() => {
  const w = ${IF}, d = w.document, frame = document.getElementById('editor');
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false, error: '没有编辑面'};
  const block = [...surface.children][${index}];
  if (!block) return {ok: false, error: '没有这一段'};
  block.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
  const fr = frame.getBoundingClientRect();
  const br = block.getBoundingClientRect();
  const owner = [...block.querySelectorAll(${JSON.stringify(OWNER)})].pop();
  if (!owner) return {ok: false, error: '这一段没有行内公式'};
  const preview = owner.querySelector(${JSON.stringify(PREVIEW)}) || owner;
  const pr = preview.getBoundingClientRect();
  if (!pr.width || !pr.height) return {ok: false, error: '公式没有几何（折叠态？）'};
  const viewport = {width: w.innerWidth, height: w.innerHeight};
  const spec = ${JSON.stringify(SPOTS)}[${JSON.stringify(String(which))}];
  const base = spec.at === 'formula' ? pr : br;
  const spot = Math.round((spec.at === 'formula' ? pr.right : br.right) + spec.dx);
  return {ok: true, text: block.textContent.slice(0, 22),
    slack: Math.round(br.right - pr.right),
    formulaRight: Math.round(pr.right), blockRight: Math.round(br.right), blockLeft: Math.round(br.left),
    onScreen: br.bottom > 0 && br.top < viewport.height && br.right > 0,
    spotX: spot, spotY: Math.round((pr.top + pr.bottom) / 2),
    frame: {x: Math.round(fr.x), y: Math.round(fr.y)}, viewport};
})()`;

/** 光标终态。 */
const CARET = `(() => { const w = ${IF}, d = w.document;
  const selection = w.getSelection();
  if (!selection || !selection.rangeCount) return {none: true};
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const at = start.nodeType === 3 ? start.parentElement : start;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = surface ? [...surface.children] : [];
  const code = at.closest && at.closest('code[data-type="math-inline"]');
  const owner = at.closest && at.closest('.vditor-ir__node');
  const box = range.getBoundingClientRect();
  let inCode = null;
  if (code && code.contains(start)) {
    const prefix = d.createRange(); prefix.selectNodeContents(code); prefix.setEnd(start, range.startOffset);
    inCode = prefix.cloneContents().textContent.length;
  }
  const block = at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,div');
  return {blockIndex: blocks.indexOf(block),
    inMathCode: !!code, inCode, inPreview: !!(at.closest && at.closest(${JSON.stringify(PREVIEW)})),
    container: start.nodeType === 3 ? 'TEXT' : start.nodeName, offset: range.startOffset,
    expanded: !!(owner && owner.classList.contains('vditor-ir__node--expand')),
    box: {w: Math.round(box.width), h: Math.round(box.height), x: Math.round(box.x), y: Math.round(box.y)}}; })()`;

/** 段落源码（去掉预览子树）+ 公式源码 + **整篇里哪几段出现了这个字符**。
 *  最后一项是判据的核心：用户报的正是"字跑到别的段落去了"，只看本段读不出来。 */
const SOURCE = (index, mark = 'Q') => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false};
  const strip = block => { const clone = block.cloneNode(true);
    clone.querySelectorAll(${JSON.stringify(PREVIEW)}).forEach(node => node.remove());
    return clone.textContent; };
  const texts = [...surface.children].map(strip);
  const block = surface.children[${index}];
  if (!block) return {ok: false};
  const code = block.querySelector('code[data-type="math-inline"]');
  return {ok: true, text: texts[${index}] || '', code: code ? code.textContent : null,
    withMark: texts.map((text, at) => (text.includes(${JSON.stringify(mark)}) ? at : -1)).filter(at => at >= 0),
    expanded: !!(block.querySelector('.vditor-ir__node--expand'))}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'synth.md');
  fs.writeFileSync(doc, fixture());

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-lineend-synth', outDir: OUT, args: [doc], timeout: 300000, inspect: true,
  });
  const spots = (argOf('spots', 'formula-edge,far-right,outside')).split(',').filter(Boolean);
  const only = argOf('only', '');
  try {
    const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
    if (!ready) throw new Error('编辑器没有就绪');
    await sleep(1500);
    await session.js(`(() => { const w = ${IF}; w.document.querySelector(${JSON.stringify(SURFACE)}).focus(); return 1; })()`);
    await sleep(200);
    const total = FILLERS.length + 2;
    const table = [];
    const [from, to] = (only || '0,' + (total - 1)).split(',').map(Number);
    for (let index = from; index <= Math.min(to, total - 1) && index < total; index++) {
      for (const which of spots) {
        const spot = await session.js(SPOT(index, which));
        if (!spot.ok || !spot.onScreen) { table.push({index, which, error: spot.error || '不在屏内'}); continue; }
        const clickX = spot.frame.x + spot.spotX;
        const clickY = spot.frame.y + spot.spotY;
        await session.click(clickX, clickY);
        await sleep(320);
        const caret = await session.js(CARET);
        await session.send('Input.insertText', {text: 'Q'});
        await sleep(320);
        const typed = await session.js(SOURCE(index));
        const caretAfter = await session.js(CARET);
        await session.chord('z', 'KeyZ', 90);   // 撤销回去，别让后一个候选段带着前一个的字
        await sleep(260);
        const restored = await session.js(SOURCE(index));
        table.push({index, which, why: SPOTS[which].why, text: spot.text,
          slack: spot.slack, formulaRight: spot.formulaRight, blockRight: spot.blockRight,
          click: {x: clickX, y: clickY}, spotX: spot.spotX,
          caret: {块: caret.blockIndex, 进公式: caret.inMathCode, 公式内偏移: caret.inCode,
            展开: caret.expanded, 容器: caret.container, 偏移: caret.offset,
            可见矩形: caret.box && (caret.box.w > 0 || caret.box.h > 0)},
          打字后: {段落源码: typed.text, 公式源码: typed.code, 含Q的段: typed.withMark,
            光标: {容器: caretAfter.container, 偏移: caretAfter.offset, 可见: caretAfter.box && (caretAfter.box.w > 0 || caretAfter.box.h > 0)}},
          撤销后: {段落源码: restored.text, 公式源码: restored.code, 含Q的段: restored.withMark},
          Q落点: (typed.code || '').includes('Q') ? '★进公式源码'
            : (typed.text || '').includes('Q') ? '本段'
            : (typed.withMark || []).length ? '别的段(' + typed.withMark.join(',') + ')' : '没落上'});
      }
    }
    console.log('\n=== 扫描结果（余量 = 段落右缘 - 公式右缘）===');
    for (const row of table) {
      if (row.error) { console.log(`#${row.index} ${row.which}  ✗ ${row.error}`); continue; }
      console.log(`#${String(row.index).padStart(2)} ${String(row.which).padEnd(12)} k=${String(FILLERS[row.index] === undefined ? '-' : FILLERS[row.index]).padStart(3)} ` +
        `余量=${String(row.slack).padStart(4)}px 点x=${row.spotX} → 光标[${row.caret.进公式 ? '★进公式' : ''}${row.caret.展开 ? ' 已展开' : ''} 容器=${row.caret.容器} 偏移=${row.caret.偏移} 可见=${row.caret.可见矩形}] ` +
        `打Q→${row.Q落点}` +
        `${row.Q落点 === '★进公式源码' ? '（公式=' + row.打字后.公式源码 + '）' : ''}` +
        ` 打字后光标[容器=${row.打字后.光标.容器} 偏移=${row.打字后.光标.偏移} 可见=${row.打字后.光标.可见}]` +
        ` 末尾=${JSON.stringify(String(row.打字后.段落源码).slice(-16))} 「${row.text}」`);
    }
    fs.writeFileSync(path.join(OUT, 'sweep.json'), JSON.stringify(table, null, 2));
    console.log('\n明细：' + path.join(OUT, 'sweep.json'));
    await session.shot('synth').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
