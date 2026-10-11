/** 第 1 轮判决「通过」项的验收探针：F1 / F4 修复验证 + 存疑 F2 / F5 取证。
 *
 *  F1（incremental-ir.js）：文档含空 $$ 块（光标不在公式里），在别处正文真打 3 个字 →
 *      真实 Ctrl+Z → 断言光标回到打字前位置。
 *      红（现状）：空公式 code 常驻的 <wbr> 被克隆进缓存，snapshot() 的"全文档
 *      some(<wbr>)"守卫误判"已有瞬态 wbr 未清"，此后所有快照都不插光标锚 →
 *      撤销后光标丢失/落到弱兜底（块/层/块内前缀与打字前不一致）。
 *  F4（history-selection.js）：真拖选「正文+$$块$$+正文」→ 真实 Delete → 真实 Ctrl+Z →
 *      断言内容恢复且光标回到删除前选区起点。
 *      红（现状）：选区端点落在 .vditor-ir__preview 内时 point() 整体 return null，
 *      captureHistorySelection 弃用整条捕获 → 撤销后光标不回起点。
 *      （beforeinput 时刻的端点是否在 preview 内由探针记录，作为机制证据。）
 *  EVIDENCE-F2（存疑，只取证不改产品）：纯图片块（无文本节点）删除 → Ctrl+Z，记录
 *      document.hasFocus()、活动元素、光标矩形。
 *  EVIDENCE-F5（存疑，只取证）：CDP Input.imeSetComposition 造组合态，组合中发两次
 *      真实 Ctrl+Z，再结束组合上屏，记录文档内容与撤销栈一致性。
 *
 *  用法：node scripts/acceptance/probe-r1-history.cjs [--app]
 *      默认 --dev（开发树 electron + app/main/main.js）。改了 extension-src 之后要先
 *      `npm run sync` 让 app/renderer/js 吃到改动再跑本探针；--app 则跑已安装产物。
 *  每用例打印「R1HIST <名> PASS/FAIL/EVIDENCE <JSON>」；整页 + 光标附近 2x 截图存
 *  .perf/probe-r1-history/shots/。结束释放会话（session.close，铁律 3：单 GUI 任务）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const fixtures = require('./fixtures.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--app');
const INSTALLED = 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const DEV_EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const DEV_MAIN = path.join(harness.project, 'app/main/main.js');
const OUT = path.join(harness.project, '.perf/probe-r1-history');
const SHOTS = path.join(OUT, 'shots');
const SURFACE = '.vditor-ir .vditor-reset';
const IF = hi.IF;
const sleep = harness.sleep;
const LOG = [];
const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); LOG.push(line); console.log(line); };
const verdict = (name, status, payload) => say('R1HIST ' + name + ' ' + status + ' ' + JSON.stringify(payload));
const setValue = (session, doc) => session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(doc)}); return true; })()`);

// ─── 读数 ─────────────────────────────────────────────────────────────────────
/** 光标全量：块下标 / 层（正文·源码·预览·围栏·外）/ 块内前缀（Range 文本，跨文字节点）/ 矩形。 */
const CARET_FULL = `(() => { const w = ${IF}; if (!w) return {none: true};
  const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {none: true, surface: false};
  const s = w.getSelection();
  if (!s || !s.rangeCount) return {none: true, surface: true, ranges: s ? s.rangeCount : 0};
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inSurface = !!(at && surface.contains(at));
  let 块 = -1, 块文本 = '', 前缀 = null;
  if (inSurface) {
    let top = r.startContainer;
    while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
    if (top && top.parentElement === surface) {
      块 = [...surface.children].indexOf(top);
      块文本 = String(top.textContent || '').replace(/\\s+/g, ' ').slice(0, 26);
      const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(r.startContainer, r.startOffset);
      前缀 = pre.toString();
    }
  }
  const rects = [...r.getClientRects()];
  const layer = !inSurface ? '外' : at.closest('code[data-type]') ? '源码'
    : at.closest('.vditor-ir__preview,.vditor-wysiwyg__preview') ? '预览' : '正文';
  return { ok: inSurface, 块, 块文本, 层: layer, 前缀, 折叠: r.collapsed, 偏移: r.startOffset,
    容器: r.startContainer.nodeType === 3 ? 'text' : r.startContainer.nodeName,
    选区长: s.toString().length, rects: rects.length,
    rect: rects.length ? [Math.round(rects[0].x), Math.round(rects[0].y), Math.round(rects[0].width), Math.round(rects[0].height)] : null }; })()`;

/** 选区两端读数：文档序起点/终点的块内前缀 + anchor/focus 是否在预览内（F4 机制证据）。 */
const SEL_START = `(() => { const w = ${IF}; const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const s = w.getSelection(); if (!surface || !s || !s.rangeCount) return {ok: false};
  const r = s.getRangeAt(0);
  let top = r.startContainer; while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
  if (!top || top.parentElement !== surface) return {ok: false};
  const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(r.startContainer, r.startOffset);
  const end = d.createRange(); end.selectNodeContents(top); end.setEnd(r.endContainer, r.endOffset);
  const at = n => { const e = n.nodeType === 3 ? n.parentElement : n;
    return { 容器: n.nodeType === 3 ? 'text:' + String(n.data).slice(0, 10) : n.nodeName,
      inPreview: !!(e && e.closest && e.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')) }; };
  return { ok: true, 块: [...surface.children].indexOf(top), 起点: pre.toString(), 终点: end.toString(),
    选区: s.toString(), anchor: at(s.anchorNode), focus: at(s.focusNode), collapsed: r.collapsed }; })()`;

/** F1 机制读数：各公式源码 code 是否为空、是否常驻 wbr（证明守卫被毒化的前提成立）。 */
const EMPTY_SHAPE = `(() => { const w = ${IF}; const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return [];
  return [...surface.querySelectorAll('code[data-type="math-block"],code[data-type="math-inline"]')].map(code => ({
    type: code.dataset.type || '', blank: !/\\S/.test(code.textContent), hasWbr: !!code.querySelector('wbr'),
    html: code.innerHTML.slice(0, 50) })); })()`;

/** F2 取证读数：焦点 / 活动元素 / 光标矩形（纯图片块没有文本节点，矩形多半画不出来）。 */
const FOCUS_EVIDENCE = `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document) return {ok: false};
  const d = w.document; const active = d.activeElement; const s = w.getSelection();
  let 光标 = null;
  if (s && s.rangeCount) { const r = s.getRangeAt(0); const rects = [...r.getClientRects()];
    光标 = { collapsed: r.collapsed, ranges: s.rangeCount, rects: rects.length,
      rect: rects.length ? [Math.round(rects[0].x), Math.round(rects[0].y), Math.round(rects[0].width), Math.round(rects[0].height)] : null,
      容器: r.startContainer.nodeType === 3 ? 'text:' + String(r.startContainer.data).slice(0, 12) : r.startContainer.nodeName }; }
  return { ok: true, hasFocus: d.hasFocus(),
    活动元素: active ? active.tagName + '.' + String(active.className).slice(0, 40) : null, 光标 }; })()`;

/** 撤销栈读数（F5 一致性证据；拿不到就如实报 ok:false，不猜）。 */
const undoStacks = session => session.js(`(() => { const w = ${IF}; if (!w) return {ok: false};
  const v = w.vditor; const u = (v && v.vditor && v.vditor.undo) || (v && v.undo);
  if (!u || !u.ir) return {ok: false};
  return { ok: true, undo: (u.ir.undoStack || []).length, redo: (u.ir.redoStack || []).length }; })()`);

/** 顶层页坐标下的光标中心（供 2x 截图取景）。 */
const CARET_CENTER = `(() => { const w = ${IF}; if (!w) return null;
  const s = w.getSelection(); if (!s || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  let rect = [...r.getClientRects()].find(item => item.height) || null;
  if (!rect) { const t = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    if (t && t.getBoundingClientRect) rect = t.getBoundingClientRect(); }
  if (!rect || !rect.height) return null;
  const fr = document.getElementById('editor').getBoundingClientRect();
  return { cx: fr.x + rect.left + rect.width / 2, cy: fr.y + rect.top + rect.height / 2 }; })()`;

// ─── 动作原语（全部真实输入通道） ─────────────────────────────────────────────
/** 定位"某前缀后第 offset 个字符"的插入点坐标（不点击，只算位置）。 */
const locateAtText = (session, prefix, offset) => session.js(`(() => { const w = ${IF}; const d = w.document;
  const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return {ok: false, why: '没有编辑面'};
  for (const block of surface.children) {
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')) continue;
      const at = node.data.indexOf(${JSON.stringify(prefix)});
      if (at < 0) continue;
      const box = d.createRange(); box.setStart(node, Math.min(at + ${offset}, node.data.length)); box.collapse(true);
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const rects = [...box.getClientRects()].filter(item => item.height);
      if (!rects.length) continue;
      const rect = rects[0];
      return {ok: true, x: Math.round(fr.x + rect.left + 1), y: Math.round(fr.y + rect.top + rect.height / 2)};
    }
  }
  return {ok: false, why: '找不到前缀'}; })()`);

/** 真鼠标点击到"某前缀后第 offset 个字符"的插入点。 */
async function clickAtText(session, prefix, offset) {
  const point = await locateAtText(session, prefix, offset);
  if (point.ok) { await session.click(point.x, point.y); await sleep(420); }
  return point;
}

/** 整页 + 光标附近 2x 局部截图（验收规则：局部 2 倍放大、截在光标所在行附近）。 */
async function shotCare(session, name) {
  const full = await session.shot(name);
  say('截图 ' + path.basename(full));
  const center = await session.js(CARET_CENTER);
  if (!center) { say('（' + name + '：没有可放大的光标矩形，只留整页）'); return {full, zoom: null}; }
  const clip = { x: Math.max(0, Math.round(center.cx - 300)), y: Math.max(0, Math.round(center.cy - 100)),
    width: 600, height: 200, scale: 2 };
  const shot = await session.send('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true}).catch(() => null);
  if (!shot) { say('（' + name + '：2x 局部截图失败）'); return {full, zoom: null}; }
  const zoom = path.join(SHOTS, name + '-2x.png');
  fs.writeFileSync(zoom, Buffer.from(shot.data, 'base64'));
  say('截图 ' + path.basename(zoom));
  return {full, zoom};
}

/** 撤销到目标内容为止（最多 maxDown 次，逐次真实 Ctrl+Z；打字/删除可能是复合事务）。 */
async function undoUntil(session, target, maxDown) {
  let 次数 = 0;
  for (let i = 0; i < maxDown; i++) {
    if (await hi.mdNow(session) === target) break;
    await hi.combo(session, 'Ctrl+Z'); 次数++; await sleep(850);
  }
  return {次数, 恢复: await hi.mdNow(session) === target};
}

// ─── 用例 1：F1 空公式常驻 wbr 毒化快照守卫 ───────────────────────────────────
async function caseF1(session) {
  const name = 'F1-空公式后打字撤销';
  const DOC = [
    '甲空公式之前的引导文字，只用来垫高文档。',
    '',
    '$$',
    '',
    '$$',
    '',
    '落点段落：在这里打字，撤销之后光标必须回到打字前的位置。',
    '',
  ].join('\n');
  await setValue(session, DOC);
  await sleep(1200);
  const shape = await session.js(EMPTY_SHAPE);
  say('空公式形状：' + JSON.stringify(shape));
  await hi.ensureFocus(session);
  const click = await clickAtText(session, '落点段落', 5);
  if (!click.ok) return verdict(name, 'FAIL', {why: '没点到落点段落', click});
  const before = await session.js(CARET_FULL);
  const valueBefore = await hi.mdNow(session);
  await shotCare(session, 'F1-01打字前');
  await hi.press(session, 'x', {text: 'x'}); await sleep(170);
  await hi.press(session, 'y', {text: 'y'}); await sleep(170);
  await hi.press(session, 'z', {text: 'z'}); await sleep(750);
  await shotCare(session, 'F1-02打字后');
  const undo = await undoUntil(session, valueBefore, 3);
  const after = await session.js(CARET_FULL);
  await shotCare(session, 'F1-03撤销后');
  const contentBack = undo.恢复;
  const caretBack = !!(after && before && after.ok && before.ok &&
    after.块 === before.块 && after.层 === before.层 && after.前缀 === before.前缀);
  verdict(name, contentBack && caretBack ? 'PASS' : 'FAIL', {
    空公式形状: (shape || []).filter(item => item.blank).map(item => ({type: item.type, hasWbr: item.hasWbr, html: item.html})),
    打字前: {块: before.块, 层: before.层, 前缀尾: String(before.前缀 || '').slice(-16), 折叠: before.折叠},
    撤销后: {块: after.块, 层: after.层, 前缀尾: String(after.前缀 || '').slice(-16), 折叠: after.折叠,
      容器: after.容器, rects: after.rects, rect: after.rect},
    内容恢复: contentBack, 光标回位: caretBack, 撤销次数: undo.次数,
    红条件: '现状：空公式 code 常驻 wbr 进缓存 → some(<wbr>) 守卫误判 → 快照不插光标锚 → 撤销后块/层/前缀与打字前不一致（丢光标或落弱兜底）',
  });
}

// ─── 用例 2：F4 拖选跨公式后撤销回起点 ────────────────────────────────────────
async function caseF4(session) {
  const name = 'F4-拖选跨公式撤销';
  const DOC = [
    '拖选起点甲文字一二三四五。',
    '',
    '$$',
    'a+b=c',
    '$$',
    '',
    '拖选终点乙文字六七八九十。',
    '',
  ].join('\n');
  await setValue(session, DOC);
  await sleep(1200);
  // beforeinput 时刻的端点记录（F4 机制证据：端点是否真的落在 preview 内）
  await session.js(`(() => { const w = ${IF}; const d = w.document; const surface = d.querySelector(${JSON.stringify(SURFACE)});
    w.__r1f4 = [];
    surface.addEventListener('beforeinput', () => { const s = w.getSelection(); if (!s || !s.rangeCount) return;
      const at = n => { const e = n.nodeType === 3 ? n.parentElement : n;
        return { 容器: n.nodeType === 3 ? 'text:' + String(n.data).slice(0, 10) : n.nodeName,
          inPreview: !!(e && e.closest && e.closest('.vditor-ir__preview,.vditor-wysiwyg__preview')) }; };
      w.__r1f4.push({anchor: at(s.anchorNode), focus: at(s.focusNode), 长度: s.toString().length}); }, true);
    return true; })()`);
  await hi.ensureFocus(session);
  const from = await locateAtText(session, '拖选起点甲文字', 4);
  const to = await locateAtText(session, '拖选终点乙文字', 4);
  if (!from.ok || !to.ok) return verdict(name, 'FAIL', {why: '取不到拖拽端点', from, to});
  await shotCare(session, 'F4-01拖选前');
  await hi.drag(session, {x: from.x, y: from.y}, {x: to.x, y: to.y}, {steps: 14, interval: 45, after: 450});
  const selected = await session.js(SEL_START);
  await shotCare(session, 'F4-02拖选后');
  const valueBefore = await hi.mdNow(session);
  say('拖选结果：' + JSON.stringify({ok: selected.ok, 起点: String(selected.起点 || '').slice(-14),
    终点: String(selected.终点 || '').slice(0, 12), 长度: (selected.选区 || '').length,
    anchor: selected.anchor, focus: selected.focus}));
  await hi.press(session, 'Delete'); await sleep(950);
  await shotCare(session, 'F4-03删除后');
  const undo = await undoUntil(session, valueBefore, 3);
  const after = await session.js(CARET_FULL);
  const endpoints = await session.js(`(() => { const w = ${IF}; return (w.__r1f4 || []).slice(0, 4); })()`);
  await shotCare(session, 'F4-04撤销后');
  const contentBack = undo.恢复;
  const startBack = !!(after && selected && selected.ok && after.ok &&
    after.块 === selected.块 && after.前缀 === selected.起点);
  verdict(name, contentBack && startBack ? 'PASS' : 'FAIL', {
    删除前选区: {ok: selected.ok, 块: selected.块, 起点前缀尾: String(selected.起点 || '').slice(-14),
      选区长: (selected.选区 || '').length, anchor: selected.anchor, focus: selected.focus},
    beforeinput端点: endpoints,
    撤销后光标: {块: after.块, 前缀尾: String(after.前缀 || '').slice(-14), 层: after.层, 折叠: after.折叠, rects: after.rects},
    内容恢复: contentBack, 光标回起点: startBack, 撤销次数: undo.次数,
    红条件: '现状：端点落在 .vditor-ir__preview 内 → point() 返回 null → captureHistorySelection 弃用整条捕获 → 撤销后光标不回选区起点（块/块内前缀与起点不一致）',
  });
}

// ─── 用例 3：EVIDENCE-F2 纯图片块删除撤销的焦点/光标取证 ──────────────────────
async function caseF2(session) {
  const name = 'EVIDENCE-F2-纯图片块删除撤销';
  const img = path.join(OUT, 'r1-img.png');
  fs.writeFileSync(img, fixtures.png(120, 80, [70, 110, 230]));
  const DOC = [
    '图片块之前的一段普通文字。',
    '',
    '![纯图](r1-img.png)',
    '',
    '图片块之后的一段普通文字。',
    '',
  ].join('\n');
  await setValue(session, DOC);
  await sleep(1500);   // 等图片解码出尺寸
  const imgBox = await session.js(`(() => { const w = ${IF}; const d = w.document;
    const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
    const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return {ok: false, why: '没有编辑面'};
    const img = [...surface.querySelectorAll('img')][0]; if (!img) return {ok: false, why: '没有 img'};
    const p = img.closest('p') || img.parentElement;
    p.scrollIntoView({block: 'center', behavior: 'instant'});
    const rect = img.getBoundingClientRect();
    const paraText = [...p.childNodes].filter(n => n.nodeType === 3).map(n => n.data.trim()).join('');
    return {ok: true, x: Math.round(fr.x + rect.x + rect.width / 2), y: Math.round(fr.y + rect.y + rect.height / 2),
      loaded: img.naturalWidth > 0, 所在块仅图: !paraText}; })()`);
  if (!imgBox.ok) return verdict(name, 'EVIDENCE', {note: '图片块没就绪，取证未完成', imgBox});
  await hi.ensureFocus(session);
  await session.click(imgBox.x, imgBox.y); await sleep(550);
  await shotCare(session, 'F2-01点选图片后');
  const valueBefore = await hi.mdNow(session);
  await hi.press(session, 'Delete'); await sleep(950);
  const afterDelete = await session.js(FOCUS_EVIDENCE);
  await shotCare(session, 'F2-02删除后');
  await hi.combo(session, 'Ctrl+Z'); await sleep(1100);
  const afterUndo = await session.js(FOCUS_EVIDENCE);
  const valueAfter = await hi.mdNow(session);
  await shotCare(session, 'F2-03撤销后');
  verdict(name, 'EVIDENCE', {
    图片块: {loaded: imgBox.loaded, 所在块仅图: imgBox.所在块仅图},
    删除后: afterDelete, 撤销后: afterUndo,
    内容恢复: valueAfter === valueBefore,
    console错误: session.errors.slice(0, 4),
    note: '只取证：纯图片块没有文本节点，撤销后焦点/活动元素/光标矩形的状态留给判决下一轮',
  });
}

// ─── 用例 4：EVIDENCE-F5 IME 组合中撤销的栈一致性取证 ─────────────────────────
async function caseF5(session) {
  const name = 'EVIDENCE-F5-组合中撤销';
  const DOC = ['组合输入的目标段落：在这一段里造 IME 组合态。', ''].join('\n');
  await setValue(session, DOC);
  await sleep(1100);
  await hi.ensureFocus(session);
  const click = await clickAtText(session, '组合输入的目标段落', 8);
  if (!click.ok) return verdict(name, 'EVIDENCE', {note: '没点到目标段落，取证未完成', click});
  // 组合态计数器：证明 imeSetComposition 真的进了组合（start/end 各发几次）
  await session.js(`(() => { const w = ${IF}; const s = w.document.querySelector(${JSON.stringify(SURFACE)});
    w.__r1f5 = {start: 0, end: 0};
    s.addEventListener('compositionstart', () => w.__r1f5.start++, true);
    s.addEventListener('compositionend', () => w.__r1f5.end++, true); return true; })()`);
  const valueBefore = await hi.mdNow(session);
  const stack0 = await undoStacks(session);
  const composed = await session.send('Input.imeSetComposition', {text: 'nihao', selectionStart: 5, selectionEnd: 5}).catch(error => ({error: String(error && error.message || error)}));
  await sleep(450);
  const counters1 = await session.js(`(() => { const w = ${IF}; return w.__r1f5; })()`);
  const valueComposing = await hi.mdNow(session);
  const stack1 = await undoStacks(session);
  await shotCare(session, 'F5-01组合中');
  // 组合未结束：连发两次真实 Ctrl+Z
  await hi.combo(session, 'Ctrl+Z'); await sleep(850);
  const valueUndo1 = await hi.mdNow(session);
  const stack2 = await undoStacks(session);
  await hi.combo(session, 'Ctrl+Z'); await sleep(850);
  const valueUndo2 = await hi.mdNow(session);
  const stack3 = await undoStacks(session);
  await shotCare(session, 'F5-02组合中撤销两次');
  // 结束组合：上屏（Input.insertText 是 Chromium 里 IME 提交的通道）
  const commit = await session.send('Input.insertText', {text: '你好'}).catch(error => ({error: String(error && error.message || error)}));
  await sleep(800);
  const counters2 = await session.js(`(() => { const w = ${IF}; return w.__r1f5; })()`);
  const valueCommitted = await hi.mdNow(session);
  const stack4 = await undoStacks(session);
  const caretEnd = await session.js(CARET_FULL);
  await shotCare(session, 'F5-03上屏后');
  verdict(name, 'EVIDENCE', {
    imeSetComposition可用: !composed || !composed.error, imeSetComposition: composed && composed.error ? composed.error : 'ok',
    组合计数: {造组合后: counters1, 上屏后: counters2},
    栈: {初始: stack0, 组合中: stack1, 撤销一: stack2, 撤销二: stack3, 上屏后: stack4},
    内容: {初始: valueBefore, 组合中: valueComposing, 撤销一: valueUndo1, 撤销二: valueUndo2, 上屏后: valueCommitted},
    上屏后光标: {块: caretEnd.块, 层: caretEnd.层, 前缀尾: String(caretEnd.前缀 || '').slice(-14), 折叠: caretEnd.折叠},
    一致性观察: {
      组合串在撤销一后消失: valueUndo1 !== valueComposing,
      撤销一回到初始: valueUndo1 === valueBefore,
      撤销二仍等于初始: valueUndo2 === valueBefore,
      上屏含新文本: valueCommitted !== valueUndo2,
    },
    console错误: session.errors.slice(0, 4),
    note: '只取证：组合中 Ctrl+Z×2 之后内容与撤销栈的一致性留给判决下一轮',
  });
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  // Windows 上刚看过的 PNG 句柄可能还在别的进程手里，删目录带重试（同 probe-empty-math-and-marker）
  try { fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}); }
  catch (error) { say('旧目录删不掉（' + String(error && error.code) + '），继续用该目录'); }
  fs.mkdirSync(SHOTS, {recursive: true});
  const fixture = path.join(OUT, 'r1-f1.md');
  fs.writeFileSync(fixture, 'R1 探针载体文档\n\n', 'utf8');
  const exe = DEV ? DEV_EXE : INSTALLED;
  say((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + exe);
  const session = await harness.launch({exe, appArgs: DEV ? [DEV_MAIN] : [],
    label: DEV ? 'probe-r1-history-dev' : 'probe-r1-history', outDir: SHOTS, args: [fixture], timeout: 180000});
  try {
    const ready = await session.until(`(() => { const w = ${IF};
      return !!(w && w.document && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 180000, interval: 60});
    say('就绪：' + ready);
    await sleep(1500);
    await caseF1(session);
    await caseF4(session);
    await caseF2(session);
    await caseF5(session);
    say('console 错误面：' + JSON.stringify(session.errors.slice(0, 8)));
    fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n'));
    say('日志：' + path.join(OUT, 'run.log'));
  } finally {
    await session.close();   // 释放会话（铁律 3：一次只能有一个 GUI 任务）
    say('会话已释放');
  }
}

main().catch(error => {
  console.error('探针失败：', error && error.stack || error);
  try {
    fs.mkdirSync(OUT, {recursive: true});
    fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n探针失败：' + String(error && error.stack || error));
  } catch {}
  process.exit(1);
});
