/** 软换行（Shift+Enter）之后用中文输入法打字，光标被复位到段落开头——用户报的"重大 bug"。
 *
 *  用户原文："文件开头为这个的md, 使用软换行: shift+enter后, 键入中文(拉起中文输入法)
 *  会导致光标跑到上面一行 路 字前面"（素材是一道植树问题：首段标题、第二段以"路边等间隔种树…"起头）。
 *
 *  根因（本轮实测定位）：块尾软换行要插一个零宽空格当渲染脚手架，否则 pre-wrap 下块尾换行不建
 *  行盒、光标没有框，用户得按两次（2.1.11 修的就是那个）。脚手架由 input 监听摘掉，而输入法上屏
 *  的 input（inputType=insertCompositionText）也在其中：**在组合还活着的时候改组合所在的文本
 *  节点**，Blink 会把这次组合判失效、在节点开头重新起一次（实测 compositionstart 的选区从行尾
 *  39 跳到 0），于是候选串与上屏的字都插进了段落开头。实测两次：组合期间的 input 里改会跳；
 *  compositionend 处理器里改**也会**跳（Blink 要等这条事件派发返回后才落定），要推到下一个
 *  宏任务才安全。
 *
 *  验收判据（都是用户看得见的东西）：
 *    ① 行尾 Shift+Enter → 输入法候选串 → 上屏：光标全程停在新行，字落在段落末尾
 *    ② 像素证人：段落第一行的墨迹逐行逐点与改前一致（段首没被插进东西），第二行从无墨变有墨
 *    ③ 磁盘证人：存盘后是"…多少棵？\n路边"，且不含零宽空格
 *    ④ 事件流证人：全程只出现一次 compositionstart（组合没被打断重启）——根因的直接指纹
 *    ⑤ 段落中间（无脚手架）的 IME 回归；⑥ 非组合通道回归；⑦ 取消组合不会把新行的空行塌掉
 *    ⑧ 源/开发树逐字节一致 + 守卫代码在
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const PLAIN = '植树问题-加密共隔';
const PARA = '路边等间隔种树。起初 33 棵树，需加 8 棵。则不需移动的树最多有多少棵？';
const ANCHOR = '路边等间隔种树';

const IF = `document.getElementById('editor').contentWindow`;

/** 段落的状态：文本、光标（块内偏移 + 第几行）、像素区域（两行高）。 */
const S = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false, error: '没有编辑面'};
  const block = [...surface.children].find(b => b.textContent.includes(${JSON.stringify(ANCHOR)}));
  if (!block) return {ok: false, error: '没有目标段落'};
  const texts = [];
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) texts.push(walker.currentNode);
  const whole = texts.map(n => n.data).join('');
  const selection = w.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  let offset = null, inBlock = false;
  if (range) {
    const container = range.startContainer;
    inBlock = block.contains(container);
    let upto = 0;
    for (const node of texts) { if (node === container) { offset = upto + range.startOffset; break; } upto += node.data.length; }
  }
  const rect = range ? range.getBoundingClientRect() : null;
  const blockRect = block.getBoundingClientRect();
  const frameRect = document.getElementById('editor').getBoundingClientRect();
  const lineHeight = parseFloat(w.getComputedStyle(block).lineHeight) || 22;
  let value = null;
  try { value = w.vditor.getValue(); } catch (error) { value = 'ERR:' + error.message; }
  return {ok: true, text: whole, chars: whole.length,
    zeroWidth: whole.split('\\u200b').length - 1,
    newlines: whole.split('\\n').length - 1,
    caretOffset: offset, caretInBlock: inBlock,
    caretLine: rect && inBlock ? Math.round((rect.top - blockRect.top) / lineHeight) : null,
    caretHeight: rect ? Math.round(rect.height) : null,
    valueZeroWidth: value ? value.split('\\u200b').length - 1 : null,
    lineHeight,
    // 两行高的观察窗（左上加 4px 边距），改前改后用同一个窗口才可比
    region: {x: Math.round(frameRect.left + blockRect.left) - 6, y: Math.round(frameRect.top + blockRect.top) - 6,
      w: Math.round(blockRect.width) + 12, h: Math.round(lineHeight * 2) + 14},
    blockTop: Math.round(blockRect.top)}; })()`;

const RECORDER = `(() => { const w = ${IF};
  if (!w || w.__imeRec) return 'already';
  const rec = [];
  for (const type of ['compositionstart', 'compositionend', 'input', 'beforeinput']) w.document.addEventListener(type, event => {
    rec.push({type, inputType: event.inputType || null, composing: event.isComposing === undefined ? null : event.isComposing,
      trusted: event.isTrusted, data: event.data === undefined ? null : String(event.data).slice(0, 12)});
  }, true);
  w.__imeRec = rec;
  return 'ok'; })()`;
const REC_MARK = `(() => { const w = ${IF}; w.__imeRec.length = 0; return 1; })()`;
const REC_READ = `(() => { const w = ${IF}; return w.__imeRec.slice(); })()`;

/** 拍照前把光标**藏干净**：光 removeAllRanges 不够——实测参考帧里还留着一道 1–2px 的竖线
 *  （编辑面右端，正是插入光标），会让"第一行像素逐行一致"这条判据误报。所以连焦点一起摘掉。 */
const DROP_SELECTION = `(() => { const w = ${IF}, d = w.document;
  w.getSelection().removeAllRanges();
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (surface && d.activeElement === surface) surface.blur();
  if (d.activeElement && d.activeElement.blur) d.activeElement.blur();
  return {rangeCount: w.getSelection().rangeCount, active: d.activeElement ? d.activeElement.tagName : null}; })()`;

const place = (expr, match = ANCHOR) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const block = [...surface.children].find(b => b.textContent.includes(${JSON.stringify(match)}));
  if (!block) return {ok: false, error: '没有目标段落'};
  let node = null;
  const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    if (walker.currentNode.parentElement?.closest('.vditor-ir__preview, .vditor-ir__marker')) continue;
    if (walker.currentNode.data) node = walker.currentNode;
  }
  if (!node) return {ok: false, error: '没有文本节点'};
  const offset = Math.max(0, Math.min(${expr}, node.data.length));
  const range = d.createRange(); range.setStart(node, offset); range.collapse(true);
  const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  document.getElementById('editor').focus(); surface.focus();
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  // 块内偏移（把前面所有文本节点的长度加进来），断言里用它才不受 Vditor 拆节点的干扰
  let blockOffset = offset;
  const all = [];
  const allWalker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  while (allWalker.nextNode()) all.push(allWalker.currentNode);
  {
    let upto = 0;
    for (const candidate of all) { if (candidate === node) { blockOffset = upto + offset; break; } upto += candidate.data.length; }
  }
  return {ok: true, offset, blockOffset, len: node.data.length, nodes: all.length,
    blockChars: all.reduce((sum, candidate) => sum + candidate.data.length, 0),
    active: d.activeElement === surface || d.activeElement === block,
    caretHeight: Math.round(rect.height)}; })()`;

/** 窗口真实像素：把观察窗逐行量墨（一行 = 一个 y），行与行可比。 */
const PROFILE = region => `(async () => {
  const {BrowserWindow} = require('electron');
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  const image = await win.webContents.capturePage();
  const size = image.getSize(), bitmap = image.toBitmap();
  const scale = size.width / (win.getContentBounds().width || size.width);
  const r = ${JSON.stringify(region)};
  const x0 = Math.max(0, Math.round(r.x * scale)), y0 = Math.max(0, Math.round(r.y * scale));
  const x1 = Math.min(size.width, Math.round((r.x + r.w) * scale)), y1 = Math.min(size.height, Math.round((r.y + r.h) * scale));
  const lum = i => (bitmap[i] * 0.11 + bitmap[i + 1] * 0.59 + bitmap[i + 2] * 0.3) / 255;
  let bg = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < Math.min(x1, x0 + 2); x++) { bg += lum((y * size.width + x) * 4); n++; }
  bg /= Math.max(1, n);
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let ink = 0, left = -1, right = -1;
    for (let x = x0; x < x1; x++) if (Math.abs(lum((y * size.width + x) * 4) - bg) > 0.08) { ink++; if (left < 0) left = x; right = x; }
    rows.push({ink, left: left < 0 ? -1 : left - x0, right: right < 0 ? -1 : right - x0});
  }
  return JSON.stringify({bg: +bg.toFixed(3), scale: +scale.toFixed(3), rows}); })()`;

const wait = (session, ms) => session.js(`(async () => { await new Promise(r => setTimeout(r, ${ms})); return 1; })()`);
const countZW = text => (String(text).match(/\u200b/g) || []).length;
const parse = value => (typeof value === 'string' ? JSON.parse(value) : value);
/** 观察窗里"有墨的行"的区间（第一段连续有墨的行就是第一行文字）。 */
const inkSpan = profile => {
  const rows = parse(profile).rows;
  let from = -1, to = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].ink > 0) { if (from < 0) from = i; to = i; }
  }
  return {from, to, rows};
};

module.exports = {
  id: '100-ime-softbreak-caret-2.1.29',
  title: '软换行 + 中文输入法：光标不再被复位到段落开头',
  async run(ctx) {
    const file = fixtures.write('ime-soft-break.md', [PLAIN, '', PARA, ''].join('\n'));
    const original = fs.readFileSync(file, 'utf8');
    ctx.witness('磁盘素材（跑前）', {file: path.basename(file), bytes: original.length, paragraphs: [PLAIN, PARA]});

    const session = await ctx.launch({args: [file], inspect: true});
    try {
      const ready = await session.until(`(() => { const w = ${IF};
        const surface = w && w.document.querySelector(${JSON.stringify(SURFACE)});
        return !!(surface && surface.textContent.includes(${JSON.stringify(ANCHOR)})); })()`, {timeout: 90000, interval: 15});
      ctx.assert('素材上屏', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(RECORDER);
      await wait(session, 400);

      // ══ ① 用户报的那一条：段落行尾 Shift+Enter → 中文输入法打字 ═══════════════
      const placed = await session.js(place('node.data.length'));
      ctx.assert('① 光标放在段落行尾且编辑面获得焦点', placed.ok && placed.active && placed.offset === placed.len,
        JSON.stringify(placed));
      const before = await session.js(S);
      const region = before.region;
      // 像素基线：先把光标藏起来再拍，免得闪烁的竖条混进"第 1 行的墨迹"里
      await session.js(DROP_SELECTION);
      const refProfile = await session.main.js(PROFILE(region));
      const ref = inkSpan(refProfile);
      await session.js(place('node.data.length'));
      ctx.witness('① 改动前：观察窗里第一行文字的墨迹（光标已藏起）',
        {region, 有墨行: [ref.from, ref.to], 行高: before.lineHeight, 文本: before.text});

      await session.js(REC_MARK);
      await session.enter(true);
      await wait(session, 400);
      const newline = await session.js(S);
      ctx.assert('① 行尾一次 Shift+Enter：光标到新行、段落里出现软换行、块尾脚手架就位',
        newline.caretLine === 1 && newline.newlines === 1 && newline.zeroWidth === 1,
        JSON.stringify({caretLine: newline.caretLine, caretOffset: newline.caretOffset, newlines: newline.newlines, zeroWidth: newline.zeroWidth}));

      // 真输入法通道：候选串 l → lu → 上屏"路" → 再上屏"边"
      await session.send('Input.imeSetComposition', {text: 'l', selectionStart: 1, selectionEnd: 1});
      await wait(session, 160);
      const composing1 = await session.js(S);
      await session.send('Input.imeSetComposition', {text: 'lu', selectionStart: 2, selectionEnd: 2});
      await wait(session, 160);
      const composing2 = await session.js(S);
      await session.send('Input.insertText', {text: '路'});
      await wait(session, 280);
      const committed = await session.js(S);
      await session.send('Input.insertText', {text: '边'});
      await wait(session, 280);
      const typed = await session.js(S);
      const events = await session.js(REC_READ);
      const starts = (events || []).filter(event => event.type === 'compositionstart');
      const restarts = Math.max(0, starts.length - 1);
      const shot = await session.shot('①-输入法上屏后');
      ctx.witness('① 输入法上屏：事件流（组合次数 = 打断指纹）、段落文本、光标',
        {compositionStarts: starts.length, restarts, events: events.slice(0, 24),
          text: typed.text, caret: {offset: typed.caretOffset, line: typed.caretLine},
          zeroWidth: typed.zeroWidth, valueZeroWidth: typed.valueZeroWidth, screenshot: shot});

      ctx.assert('① 候选串进来时光标没被复位（仍在第 2 行、仍在换行之后）',
        composing1.caretLine === 1 && composing1.caretOffset > newline.caretOffset && composing2.caretLine === 1
          && composing2.caretOffset > composing1.caretOffset,
        JSON.stringify({换行后: newline.caretOffset, 候选串l: {line: composing1.caretLine, offset: composing1.caretOffset},
          候选串lu: {line: composing2.caretLine, offset: composing2.caretOffset}}));
      ctx.assert('① 组合全程没被打断重启（只出现一次 compositionstart —— 根因的直接指纹）',
        restarts === 0 && starts.length === 1, {compositionStarts: starts.length, restarts});
      ctx.assert('① 上屏的字落在段落末尾（段落 = 原文 + "\\n路边"）',
        typed.text === PARA + '\n路边', JSON.stringify({want: PARA + '\\n路边', got: typed.text}));
      ctx.assert('① 光标停在新行（第 2 行）且有真实的框',
        typed.caretLine === 1 && typed.caretHeight > 4,
        JSON.stringify({line: typed.caretLine, height: typed.caretHeight}));
      ctx.assert('① 零宽脚手架已摘掉（DOM 与 vditor.getValue 都不含零宽空格）',
        typed.zeroWidth === 0 && typed.valueZeroWidth === 0,
        JSON.stringify({dom: typed.zeroWidth, value: typed.valueZeroWidth}));
      ctx.metric('imeSoftBreak.compositionRestarts', restarts, {unit: '次', direction: 'lower', tolerance: 0.001});

      // 像素证人：第一行逐行逐点一致（段首没被插进任何东西），第二行从"没有墨"变成"有墨"
      await session.js(DROP_SELECTION);
      const nowProfile = await session.main.js(PROFILE(region));
      const now = inkSpan(nowProfile);
      await session.js(place('node.data.length'));
      // 两帧之间整条带可能因为亚像素取整**整体**上下一格（实测出现过 1 行差），
      // 所以按"从各自第一行有墨的那一行开始"对齐后逐行比对墨量/最左/最右——
      // 判据仍是"第一行的墨迹一模一样"，只是不吃整体平移。
      const refLine = ref.to >= 0 ? ref.rows.slice(ref.from, ref.to + 1) : [];
      const nowLine = now.from >= 0 ? now.rows.slice(now.from, now.from + refLine.length) : [];
      const samePattern = refLine.length > 0 && nowLine.length === refLine.length
        && refLine.every((row, index) => row.ink === nowLine[index].ink && row.left === nowLine[index].left && row.right === nowLine[index].right);
      // 第二行：改前那一段（第一行之下）没有墨，改后在同样位置之下出现了墨
      const beforeTailInk = ref.rows.slice(Math.max(0, ref.from + refLine.length)).reduce((sum, row) => sum + row.ink, 0);
      const newLineInk = now.rows.slice(Math.max(0, now.from + refLine.length)).reduce((sum, row) => sum + row.ink, 0);
      ctx.witness('① 观察窗里第一行文字的墨迹（改前 / 改后）',
        {改前有墨行: [ref.from, ref.to], 改后有墨行: [now.from, now.to], 第一行逐行像素: {改前: refLine, 改后: nowLine},
          第一行逐行一致: samePattern, 第二行墨量: {改前: beforeTailInk, 改后: newLineInk}, 截图: shot});
      ctx.assert('① 像素证人：段落第一行与改前一模一样（从第一行有墨处逐行对齐后，墨量/最左/最右都相等 —— 段首没被插入字）',
        samePattern, JSON.stringify({第一行逐行一致: samePattern, 改前有墨行: [ref.from, ref.to], 改后有墨行: [now.from, now.to],
          改前第一行: refLine, 改后第一行: nowLine}));
      ctx.assert('① 像素证人：软换行那一行改前没有墨、改后有了（"路边"真的落在新行上）',
        beforeTailInk === 0 && newLineInk > 0, JSON.stringify({改前: beforeTailInk, 改后: newLineInk}));

      // 磁盘证人。Ctrl+S 偶发不落盘（全量回归里出现过一次），所以重试几次，最后一次改走
      // 「文件 > 保存」菜单——两条路是同一个保存实现，能区分"快捷键没送到"与"保存坏了"。
      const trySave = async () => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          if (attempt === 4) { try { await session.main.clickMenu('文件 > 保存'); } catch (error) { /* 菜单不可用就靠下面的读取判定 */ } }
          else await session.chord('s', 'KeyS', 83);
          await wait(session, 700);
          const text = fs.readFileSync(file, 'utf8');
          if (text.includes('多少棵？\n路边')) return {text, attempts: attempt, via: attempt === 4 ? '菜单' : 'Ctrl+S'};
        }
        return {text: fs.readFileSync(file, 'utf8'), attempts: 4, via: '都没落盘'};
      };
      const savedInfo = await trySave();
      const saved = savedInfo.text;
      ctx.witness('① 存盘后的磁盘内容（文件系统证人）',
        {bytes: saved.length, zeroWidth: countZW(saved), hasSoftBreak: saved.includes('多少棵？\n路边'),
          tail: saved.slice(-24), 落盘方式: savedInfo.via, 尝试次数: savedInfo.attempts});
      ctx.assert('① 磁盘证人：新行的字落盘了（…多少棵？\\n路边），且不含零宽脚手架',
        saved.includes('多少棵？\n路边') && countZW(saved) === 0 && saved.includes(PARA),
        JSON.stringify({hasSoftBreak: saved.includes('多少棵？\n路边'), zeroWidth: countZW(saved),
          tail: saved.slice(-16), 落盘方式: savedInfo.via, 尝试次数: savedInfo.attempts}));

      // ══ ② 段落中间（无脚手架）的 IME 回归 ══════════════════════════════════
      // 落点选在标点后面（不是"空格 + 数字"前面）：Markdown 会把行尾空格归一化掉，
      // 那不是本轮的缺陷，别让它混进断言。
      const middlePlace = await session.js(place(`node.data.indexOf('需加')`));
      ctx.assert('② 段落中间放光标成功（块内偏移 = "需加"的位置）',
        middlePlace.ok && middlePlace.blockOffset === PARA.indexOf('需加'),
        JSON.stringify({planned: middlePlace, want: PARA.indexOf('需加')}));
      const middleBefore = await session.js(S);
      await session.enter(true);
      await wait(session, 350);
      await session.send('Input.imeSetComposition', {text: 'lu', selectionStart: 2, selectionEnd: 2});
      await wait(session, 180);
      await session.send('Input.insertText', {text: '路'});
      await wait(session, 300);
      const middleAfter = await session.js(S);
      const wantMiddle = middleBefore.text.slice(0, middleBefore.caretOffset) + '\n路' + middleBefore.text.slice(middleBefore.caretOffset);
      ctx.witness('② 段落中间：放光标 / 换行后 / 上屏后的段落与光标',
        {放光标: middlePlace, 上屏后: middleAfter.text, caretLine: middleAfter.caretLine, zeroWidth: middleAfter.zeroWidth});
      ctx.assert('② 段落中间上屏：字落在光标处（= 前半 + "\\n路" + 后半），零宽没有多出来',
        middleAfter.text === wantMiddle && middleAfter.zeroWidth === 0,
        JSON.stringify({want: wantMiddle, got: middleAfter.text, zeroWidth: middleAfter.zeroWidth}));

      // ══ ③ 非组合通道（直接上屏）回归 ═══════════════════════════════════════
      const plainPlace = await session.js(place('node.data.length'));
      ctx.assert('③ 段落行尾放光标成功（块内偏移 = 段落末尾）',
        plainPlace.ok && plainPlace.blockOffset === plainPlace.blockChars,
        JSON.stringify({planned: plainPlace}));
      const plainBefore = await session.js(S);
      await session.enter(true);
      await wait(session, 350);
      await session.type('甲乙');
      await wait(session, 350);
      const plainAfter = await session.js(S);
      ctx.assert('③ 不走输入法的直接上屏（insertText）仍然落在新行、并摘掉脚手架',
        plainAfter.text === plainBefore.text + '\n甲乙' && plainAfter.zeroWidth === 0,
        JSON.stringify({want: plainBefore.text + '\\n甲乙', got: plainAfter.text, zeroWidth: plainAfter.zeroWidth}));

      // ══ ④ 取消组合（Esc）：新行不能被塌掉、正文不能多字 ══════════════════════
      const cancelPlace = await session.js(place('node.data.length'));
      ctx.assert('④ 段落行尾放光标成功', cancelPlace.ok && cancelPlace.blockOffset === cancelPlace.blockChars,
        JSON.stringify({planned: cancelPlace}));
      const cancelBefore = await session.js(S);
      await session.enter(true);
      await wait(session, 350);
      const cancelLine = await session.js(S);
      await session.send('Input.imeSetComposition', {text: 'lu', selectionStart: 2, selectionEnd: 2});
      await wait(session, 200);
      await session.send('Input.imeSetComposition', {text: '', selectionStart: 0, selectionEnd: 0}).catch(() => {});
      await wait(session, 400);
      const cancelled = await session.js(S);
      ctx.witness('④ 取消组合：换行后 / 取消后的段落与光标',
        {取消前: cancelBefore.text, 换行后: {text: cancelLine.text, line: cancelLine.caretLine},
          取消后: {text: cancelled.text, line: cancelled.caretLine, zeroWidth: cancelled.zeroWidth, caretHeight: cancelled.caretHeight}});
      ctx.assert('④ 取消组合后正文一个字都没多（候选串/拼音没有留在段落里）',
        cancelled.text === cancelBefore.text + '\n\u200b',
        JSON.stringify({want: cancelBefore.text + '\\n[zwsp]', got: cancelled.text}));
      ctx.assert('④ 取消组合后光标仍停在同一新行（空行没被塌掉：脚手架还在、光标有框）',
        cancelled.caretLine === cancelLine.caretLine && cancelLine.caretLine === cancelBefore.caretLine + 1
          && cancelled.zeroWidth === 1 && cancelled.caretHeight > 4,
        JSON.stringify({取消前行: cancelBefore.caretLine, 换行后行: cancelLine.caretLine, 取消后行: cancelled.caretLine,
          zeroWidth: cancelled.zeroWidth, caretHeight: cancelled.caretHeight}));
    } finally {
      await ctx.release(session);
    }

    // ══ ⑤ 产物级：源与开发树一致 + 守卫代码在 ═══════════════════════════════
    const rel = 'js/typora-patches.js';
    const project = require('../harness.cjs').project;
    const sourcePath = path.join('E:/MarkPilot/Typora-Editor/extension-src/render', rel);
    const sharedPath = path.join(project, 'app/renderer', rel);
    const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
    const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : '';
    const guards = {
      compositionstart: /compositionstart/.test(shared),
      composingFlag: /composing = true/.test(shared),
      isComposing: /event\.isComposing/.test(shared),
      deferred: /compositionend[^\n]*setTimeout\(removePlaceholder, 0\)/.test(shared),
    };
    ctx.witness('⑤ typora-patches.js 在源与开发树之间是否逐字节一致', {same: !!source && source === shared, source: source.length, shared: shared.length});
    ctx.assert('⑤ 源与开发树逐字节一致（EXE 与 VSIX 吃的是同一份代码）', !!source && source === shared,
      JSON.stringify({source: source.length, shared: shared.length, sourcePath, sharedPath}));
    ctx.assert('⑤ 守卫代码在：组合期间不动节点（composing 标志 + isComposing），组合结束后推到下一个宏任务再摘',
      guards.compositionstart && guards.composingFlag && guards.isComposing && guards.deferred,
      JSON.stringify({...guards, bytes: shared.length}));
  },
};
