/** R6 第 6 轮（图片拖拽域）· F15 判决验收：图上起手拖选圈死图 + F11 取证 + 三条契约对照。
 *  （harness dev：electron.exe + app/main/main.js；拖拽配方学 probe-drag-baseline.cjs current 变体）
 *
 *  背景与判决（2026-10-02 第 6 轮）：
 *    · F15变：图上 mousedown（media-tools.js 原第 1567-1574 行）preventDefault +
 *      selectNode(img) + return，**不立旗**；D4 的 mousemove 拖选扩展只认「空白带接管」
 *      旗 → 图上按住拖出去，选区纹丝不动（一直停在整图选中）。
 *      修复＝与 R1-D4 同构：图上 mousedown 分支立同一面接管旗（owner=图自己的节点，
 *      锚=selectNode(img) 的起点），mousemove 补丁接力扩展（焦点落图自身节点内不更新，
 *      沿用既有防倒挂），≤4px 死区维持「单击整选」，Ctrl/Shift/Alt 组合与连点(detail≥2)
 *      不立旗（W4/138 契约）。
 *    · F11取证（126① 形态）：双击选词后按住拖 6 步，逐步读 selection 长度与锚/焦层——
 *      纯取证（探针逐帧读数，不改产品），观察原生拖选扩展期间锚/焦是否落到奇怪层
 *      （隐藏 marker/源码层）。
 *
 *  用例（每用例输出「R6ID <名> PASS/FAIL/EVIDENCE — …」+ 2 张截图：局部 2x + 整幅）：
 *    f15    图中心按下→拖到下段文字松手→断言：选区非折叠、含图（intersectsNode）、
 *           len>图（扫过文字，含第二段标记短语）、拖起后点选高亮已撤；
 *    single 对照①：单击图中心仍「整选」——选区恰罩图（len==selectNode(img).len）、
 *           不含下段文字、typora-img-selected 高亮在；
 *    ctrl   对照②：Ctrl 点甲图+乙图仍多选——两图 typora-img-multi-selected、无单选高亮；
 *    dbl    对照③：连点(detail=2)仍展开源码（138 契约）——owner 带 --expand；
 *    f11    取证：双击选词 SamplePath → 原地按住 → 右拖 6 步逐步读数（EVIDENCE 行）。
 *
 *  探针纪律：素材自建于 .perf/r6-imgdrag/（不碰受保护素材）；输入全真实通道
 *  （CDP Input.dispatchMouseEvent：move→press→N×move(buttons=1)→release）；
 *  不碰剪贴板；不保存文档。
 *  用法：node scripts/acceptance/probe-r6-imgdrag.cjs [--only=f15,single,ctrl,dbl,f11]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/r6-imgdrag');
const sleep = harness.sleep;
const IF = `document.getElementById('editor').contentWindow`;

const results = [];
function verdict(name, tag, detail) {
  if (tag !== 'PASS' && tag !== 'FAIL' && tag !== 'EVIDENCE') throw new Error('未知判词：' + tag);
  results.push({ name, tag });
  console.log(`R6ID ${name} ${tag} — ${detail}`);
  return tag !== 'FAIL';
}
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);

// ---------- 素材：探针自建 PNG（纯 Node 编码，同 probe-r6-para） ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = ~0; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
const makePng = (w, h, [r, g, b]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

const HEADING = 'R6 图片拖拽域';
const MARK2 = '第二段扫过标记';      // F15 拖选应扫过的段落开头短语
const WORD11 = 'SamplePath';          // F11 双击选词的目标（拉丁词，选词边界确定）
const MD = ['# ' + HEADING, '',
  '![甲图](media/r6-imgdrag-a.png)', '',
  MARK2 + ' 鞅停时与样本轨道生成的 sigma 域刻画了可测性的边界，这一行足够长，拖选有落脚点。', '',
  '![乙图](media/r6-imgdrag-b.png)', '',
  '第四段对照锚点 ' + WORD11 + ' 可选停时定理收尾。', ''].join('\n');

// ---------- 会话小助手（同 probe-r6-para：内层 document/window 绑到编辑器 iframe） ----------
const editorReady = title => `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  const root = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
  return !!(root && root.textContent.includes(${JSON.stringify(title)})); })()`;
const frameEval = (s, code) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document || !w.document.body) return null;
  return (function (document, window) { ${code} })(w.document, w); })()`);
const framePoint = (s, expr) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w) return null; const p = (function (document, window) { ${expr} })(w.document, w);
  if (!p || p.x === undefined) return null;
  const fr = f.getBoundingClientRect(); return { x: Math.round(fr.x + p.x), y: Math.round(fr.y + p.y) }; })()`);
/** 同 framePoint，但一次带回多个点（形如 {x,y,drop:{x,y}}，子点一并加帧偏移）。 */
const framePoints = (s, expr) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w) return null; const p = (function (document, window) { ${expr} })(w.document, w);
  if (!p || p.x === undefined) return null;
  const fr = f.getBoundingClientRect();
  const t = q => ({ x: Math.round(fr.x + q.x), y: Math.round(fr.y + q.y) });
  const out = t(p);
  for (const k of Object.keys(p)) if (p[k] && p[k].x !== undefined) out[k] = t(p[k]);
  return out; })()`);
const frameBox = (s, expr) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w) return null; const r = (function (document, window) { ${expr} })(w.document, w);
  if (!r || r.x === undefined) return null;
  const fr = f.getBoundingClientRect();
  return { x: Math.round(fr.x + r.x), y: Math.round(fr.y + r.y), w: Math.round(r.w), h: Math.round(r.h) }; })()`);
/** 局部 2 倍放大截图（probe-caret-shot 的通道：captureScreenshot clip.scale=2）。 */
const shot2x = async (s, name, clip) => {
  const result = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 } });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
};
const shotFull = async (s, name, box) => {
  const result = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: Math.max(0, box.y - 20), width: box.w, height: box.h + 60, scale: 1 } });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
};
/** 真实拖拽：move → press → N×move(buttons=1) → release（probe-drag-baseline current 配方）。 */
const drag = async (s, from, to, steps, onStep) => {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
  await sleep(80);
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  for (let i = 1; i <= (steps || 12); i++) {
    const p = { x: Math.round(from.x + (to.x - from.x) * i / (steps || 12)), y: Math.round(from.y + (to.y - from.y) * i / (steps || 12)) };
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
    if (onStep) await onStep(i, p);
    else await sleep(40);
  }
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(260);
};
/** 选区读数：长度/折叠/是否罩图/锚焦层/包围盒/焦点（数值读数只作辅助，结论看截图）。
 *  ⚠ getSelection 必须走 **iframe 自己的** document.getSelection()：frameEval 的闭包只
 *  影子化了 document/window 两个名字，裸 getSelection() 是顶层页的全局——选区明明在
 *  iframe 里，顶层 selection.rangeCount=0，于是 len/intersects 全 undefined（首轮红块
 *  的系统性根源）。 */
const readSel = (s, srcMark) => frameEval(s, `
  const sel = document.getSelection();
  const out = { ranges: sel ? sel.rangeCount : 0, hasFocus: document.hasFocus() };
  const layerOf = n => { if (!n) return 'null';
    if (n.nodeType === 3) { const el = n.parentElement;
      const tag = el ? el.tagName.toLowerCase() : 'orphan';
      const cls = el && typeof el.className === 'string' ? el.className : '';
      return 'text@' + tag + (/marker|preview/.test(cls) ? '.' + cls.split(/\\s+/).filter(c => /marker|preview/.test(c))[0] : ''); }
    const cls = typeof n.className === 'string' ? n.className : '';
    return n.nodeName + (cls ? '.' + cls.split(/\\s+/).slice(0, 2).join('.') : ''); };
  if (!sel || !sel.rangeCount) return out;
  const r = sel.getRangeAt(0);
  const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src') || '').includes(${JSON.stringify(srcMark)}));
  let imgOnlyLen = null;
  if (img) { const rr = document.createRange(); rr.selectNode(img); imgOnlyLen = rr.toString().length; }
  const box = r.getBoundingClientRect();
  out.collapsed = sel.isCollapsed; out.text = r.toString(); out.len = out.text.length; out.imgOnlyLen = imgOnlyLen;
  out.coversImg = img ? (function () { try { return r.intersectsNode(img); } catch (e) { return false; } })() : null;
  out.direction = sel.direction || null;
  out.anchor = { layer: layerOf(sel.anchorNode), off: sel.anchorOffset };
  out.focus = { layer: layerOf(sel.focusNode), off: sel.focusOffset };
  out.box = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
  return out;`);
/** 两张图的高亮类读数。 */
const readClasses = s => frameEval(s, `
  const pick = mark => { const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src') || '').includes(mark));
    if (!img) return null; const owner = img.closest('.vditor-ir__node[data-type]');
    return { selected: img.classList.contains('typora-img-selected'), multi: img.classList.contains('typora-img-multi-selected'),
      expand: !!(owner && owner.classList.contains('vditor-ir__node--expand')),
      ownerType: owner ? owner.getAttribute('data-type') : null }; };
  return { a: pick('r6-imgdrag-a.png'), b: pick('r6-imgdrag-b.png') };`);
/** 用例间清场（真实 Esc 键，产品自己的清选路径）：单会话连跑五个用例，前一用例留下的
 *  单选/多选高亮会把下一用例的语义带歪——实测对照2 的"甲.multi=false"正是上一用例
 *  （对照1 单击整选）把甲留成 selectedImage，Ctrl 点甲走的是产品正确的"取消单选"分支。
 *  每个用例起手 Esc 一次、复核高亮已清，再进手势。 */
const clearSel = async s => {
  await s.key({ key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(160);
  const cls = await readClasses(s);
  const dirty = !!(cls && ((cls.a && (cls.a.selected || cls.a.multi || cls.a.expand)) || (cls.b && (cls.b.selected || cls.b.multi || cls.b.expand))));
  return { cls, dirty };
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(path.join(OUT, 'media'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'media', 'r6-imgdrag-a.png'), makePng(240, 120, [198, 198, 198]));
  fs.writeFileSync(path.join(OUT, 'media', 'r6-imgdrag-b.png'), makePng(240, 120, [176, 196, 222]));
  const doc = path.join(OUT, 'r6-imgdrag.md');
  fs.writeFileSync(doc, MD, 'utf8');

  let session = null;
  try {
    session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
      outDir: path.join(OUT, 'shots-r6imgdrag'), args: [doc], timeout: 120000 });
    const ready = await session.until(editorReady(HEADING), { timeout: 90000 });
    if (!ready) throw new Error('编辑器未就绪');
    let loaded = false;
    for (let i = 0; i < 60 && !loaded; i++) {
      loaded = !!(await frameEval(session, `const imgs = [...document.querySelectorAll('.vditor-reset img')];
        return imgs.length >= 2 && imgs.every(i => i.naturalWidth > 0);`));
      if (!loaded) await sleep(200);
    }
    if (!loaded) throw new Error('图片未加载完成');
    await sleep(700);
    const frame = await session.js(`(() => { const r = document.getElementById('editor').getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);

    // 落点都「用前现量」：scrollIntoView 会挪布局，先量后滚会把旧坐标用歪。
    // f15 一次量两点（滚到图与落点的中点，保证两点同屏）：
    const locateF15 = () => framePoints(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
      const p = [...document.querySelectorAll('.vditor-reset > p')].find(el => el.textContent.includes(${JSON.stringify(MARK2)}));
      const a = img.getBoundingClientRect(), b = p.getBoundingClientRect();
      (a.top < b.top ? p : img).scrollIntoView({block:'center', behavior:'instant'});
      const a2 = img.getBoundingClientRect(), b2 = p.getBoundingClientRect();
      return { x: a2.x + a2.width / 2, y: a2.y + a2.height / 2,
        drop: { x: b2.x + Math.min(b2.width * 0.62, 420), y: b2.y + b2.height / 2 } };`);
    // 其余用例各自定位（滚到目标中心）：
    const locateA = () => framePoint(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
      img.scrollIntoView({block:'center', behavior:'instant'});
      const r = img.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    const locateB = () => framePoint(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-b.png'));
      img.scrollIntoView({block:'center', behavior:'instant'});
      const r = img.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    const locateWord11 = () => framePoint(session, `const p = [...document.querySelectorAll('.vditor-reset > p')].find(el => el.textContent.includes(${JSON.stringify(WORD11)}));
      if (!p) return null;
      p.scrollIntoView({block:'center', behavior:'instant'});
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);   // 词可能裹在 span 里，深层找
      let text = null; let n; while ((n = walker.nextNode())) if (n.data.includes(${JSON.stringify(WORD11)})) { text = n; break; }
      if (!text) return null;
      const r = document.createRange(); r.setStart(text, text.data.indexOf(${JSON.stringify(WORD11)}));
      r.setEnd(text, text.data.indexOf(${JSON.stringify(WORD11)}) + ${WORD11.length});
      const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);

    // ── f15：图中心按下 → 拖到第二段文字 → 松手（中途第 6 步读一次活选区） ──
    if (want('f15')) {
      await clearSel(session);
      const located = await locateF15();
      const anchorA = { x: located.x, y: located.y };
      const drop2 = located.drop;
      let midDrag = null;
      await drag(session, anchorA, drop2, 12, async (i) => { if (i === 6) midDrag = await readSel(session, 'r6-imgdrag-a.png'); else await sleep(40); });
      const sel = await readSel(session, 'r6-imgdrag-a.png');
      const cls = await readClasses(session);
      const nonCollapsed = !!(sel && sel.ranges && !sel.collapsed);
      const swept = !!(sel && sel.text && sel.text.includes(MARK2));
      const lenBeyond = !!(sel && typeof sel.len === 'number' && typeof sel.imgOnlyLen === 'number' && sel.len > sel.imgOnlyLen);
      const highlightDropped = !!(cls && cls.a && !cls.a.selected && !cls.a.multi);
      const pass = nonCollapsed && swept && sel.coversImg && lenBeyond && highlightDropped;
      // 截图 ×2：局部 2x（图→落点整条选区带）+ 整幅交代上下文
      const imgBox = await frameBox(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
        const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const clip = { x: Math.max(0, frame.x + 20), y: Math.max(0, imgBox.y - 24), width: Math.min(frame.w - 40, 900), height: (drop2.y - imgBox.y) + 96 };
      const s1 = await shot2x(session, 'f15-drag-end-2x', clip);
      const s2 = await shotFull(session, 'f15-drag-end-full', frame);
      verdict('F15变', pass ? 'PASS' : 'FAIL',
        `图中心(${anchorA.x},${anchorA.y})按下拖到第二段(${drop2.x},${drop2.y})松手：`
        + `非折叠=${nonCollapsed}；含图(intersects)=${sel && sel.coversImg}；len=${sel && sel.len}>图len=${sel && sel.imgOnlyLen}（扫过文字「${MARK2}」=${swept}）；`
        + `拖起后单选高亮撤=${highlightDropped}；中途第6步活选区=${midDrag ? `非折叠=${!midDrag.collapsed},len=${midDrag.len}` : '未读到'}；`
        + `焦点=${sel && sel.hasFocus}；选区盒=${sel && JSON.stringify(sel.box)}；截图=${path.basename(s1)}+${path.basename(s2)}`);
    }

    // ── single：对照① 单击图中心仍「整选」（≤4px 死区契约） ──
    if (want('single')) {
      await clearSel(session);
      const anchorA = await locateA();
      await session.click(anchorA.x, anchorA.y);
      await sleep(300);
      const sel = await readSel(session, 'r6-imgdrag-a.png');
      const cls = await readClasses(session);
      const whole = !!(sel && sel.ranges && !sel.collapsed && sel.coversImg
        && typeof sel.len === 'number' && typeof sel.imgOnlyLen === 'number' && sel.len === sel.imgOnlyLen
        && !(sel.text || '').includes(MARK2));
      const highlighted = !!(cls && cls.a && cls.a.selected);
      const pass = whole && highlighted;
      const imgBox = await frameBox(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
        const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const clip = { x: Math.max(0, imgBox.x - 60), y: Math.max(0, imgBox.y - 40), width: Math.min(frame.w - 40, imgBox.w + 160), height: imgBox.h + 120 };
      const s1 = await shot2x(session, 'single-wholeselect-2x', clip);
      const s2 = await shotFull(session, 'single-wholeselect-full', frame);
      verdict('对照1单击整选', pass ? 'PASS' : 'FAIL',
        `单击图中心：非折叠=${!!(sel && !sel.collapsed)}；选区恰罩图(len=${sel && sel.len}==图len=${sel && sel.imgOnlyLen}，intersects=${sel && sel.coversImg})=${whole}；`
        + `不含下段文字=${!(sel && (sel.text || '').includes(MARK2))}；typora-img-selected=${highlighted}；焦点=${sel && sel.hasFocus}；`
        + `截图=${path.basename(s1)}+${path.basename(s2)}`);
    }

    // ── ctrl：对照② Ctrl 点甲图+乙图仍多选 ──
    if (want('ctrl')) {
      await clearSel(session);
      const a = await locateA();
      await session.click(a.x, a.y, { modifiers: harness.MOD.ctrl });
      await sleep(260);
      const b = await locateB();
      await session.click(b.x, b.y, { modifiers: harness.MOD.ctrl });
      await sleep(320);
      const cls = await readClasses(session);
      const multi = !!(cls && cls.a && cls.b && cls.a.multi && cls.b.multi && !cls.a.selected && !cls.b.selected);
      const clipA = await frameBox(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
        const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const clipB = await frameBox(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-b.png'));
        const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const clip = { x: Math.max(0, Math.min(clipA.x, clipB.x) - 40), y: Math.max(0, clipA.y - 30),
        width: Math.min(frame.w - 40, Math.max(clipA.w, clipB.w) + 120), height: (clipB.y + clipB.h) - clipA.y + 90 };
      const s1 = await shot2x(session, 'ctrl-multi-2x', clip);
      const s2 = await shotFull(session, 'ctrl-multi-full', frame);
      verdict('对照2Ctrl点多选', multi ? 'PASS' : 'FAIL',
        `Ctrl点甲图再Ctrl点乙图：甲.multi=${cls && cls.a && cls.a.multi}、乙.multi=${cls && cls.b && cls.b.multi}、单选高亮残留=${!!(cls && ((cls.a && cls.a.selected) || (cls.b && cls.b.selected)))}；`
        + `状态=${JSON.stringify(cls)}；截图=${path.basename(s1)}+${path.basename(s2)}`);
    }

    // ── dbl：对照③ 连点(detail=2)仍展开源码（138 契约） ──
    if (want('dbl')) {
      await clearSel(session);
      const anchorA = await locateA();
      await session.click(anchorA.x, anchorA.y, { clickCount: 2 });
      await sleep(500);
      const cls = await readClasses(session);
      const expanded = !!(cls && cls.a && cls.a.expand);
      const imgBox = await frameBox(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src')||'').includes('r6-imgdrag-a.png'));
        const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const clip = { x: Math.max(0, imgBox.x - 80), y: Math.max(0, imgBox.y - 90), width: Math.min(frame.w - 40, imgBox.w + 240), height: imgBox.h + 200 };
      const s1 = await shot2x(session, 'dbl-expand-2x', clip);
      const s2 = await shotFull(session, 'dbl-expand-full', frame);
      verdict('对照3连点展开', expanded ? 'PASS' : 'FAIL',
        `连点(detail=2)图中心：owner --expand=${expanded}；ownerType=${cls && cls.a && cls.a.ownerType}；焦点=${(await frameEval(session, 'return document.hasFocus();'))}；`
        + `截图=${path.basename(s1)}+${path.basename(s2)}（2x 图上应看到源码行与图片同现）`);
    }

    // ── f11：取证（126① 形态）双击选词 → 原地按住 → 右拖 6 步逐步读数 ──
    if (want('f11')) {
      await clearSel(session);
      const steps = [];
      const word11 = await locateWord11();
      await session.click(word11.x, word11.y, { clickCount: 2 });     // 双击选词
      await sleep(300);
      const word = await readSel(session, 'r6-imgdrag-a.png');
      const wordClip = await frameBox(session, `const p = [...document.querySelectorAll('.vditor-reset > p')].find(el => el.textContent.includes(${JSON.stringify(WORD11)}));
        const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };`);
      const s1 = await shot2x(session, 'f11-word-2x', { x: Math.max(0, wordClip.x + 40), y: Math.max(0, wordClip.y - 24), width: Math.min(560, wordClip.w), height: wordClip.h + 48 });
      // 原地按住（clickCount=1 → detail=1）→ 6 步右移逐步读锚/焦层
      const step = { x: word11.x, y: word11.y };
      const dx = 26;
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.x, y: step.y, buttons: 0 });
      await sleep(80);
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: step.x, y: step.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(120);
      const readStep = () => frameEval(session, `
        const sel = document.getSelection(); if (!sel || !sel.rangeCount) return { ranges: 0 };
        const layerOf = n => { if (!n) return 'null';
          if (n.nodeType === 3) { const el = n.parentElement;
            const cls = el && typeof el.className === 'string' ? el.className : '';
            return 'text@' + (el ? el.tagName.toLowerCase() : 'orphan') + (/marker|preview/.test(cls) ? '.' + cls.split(/\\s+/).filter(c => /marker|preview/.test(c))[0] : ''); }
          const cls = typeof n.className === 'string' ? n.className : '';
          return n.nodeName + (cls ? '.' + cls.split(/\\s+/).slice(0, 2).join('.') : ''); };
        return { collapsed: sel.isCollapsed, len: sel.getRangeAt(0).toString().length,
          text: sel.getRangeAt(0).toString().slice(0, 18),
          anchor: { layer: layerOf(sel.anchorNode), off: sel.anchorOffset },
          focus: { layer: layerOf(sel.focusNode), off: sel.focusOffset },
          dir: sel.direction || null };`);
      for (let i = 1; i <= 6; i++) {
        step.x += dx;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: step.x, y: step.y, button: 'left', buttons: 1 });
        await sleep(140);
        steps.push({ step: i, x: step.x, y: step.y, ...(await readStep()) });
      }
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: step.x, y: step.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(260);
      const end = await readSel(session, 'r6-imgdrag-a.png');
      const s2 = await shot2x(session, 'f11-drag6-2x', { x: Math.max(0, wordClip.x + 40), y: Math.max(0, wordClip.y - 24), width: Math.min(560, wordClip.w), height: wordClip.h + 48 });
      const collected = steps.length === 6 && steps.every(st => st && st.anchor && st.focus);
      const lenSeries = steps.map(st => st && st.len).join('→');
      const anchorLayers = [...new Set(steps.map(st => st && st.anchor ? st.anchor.layer : 'null'))].join('|');
      const focusLayers = [...new Set(steps.map(st => st && st.focus ? st.focus.layer : 'null'))].join('|');
      verdict('F11取证', collected ? 'EVIDENCE' : 'FAIL',
        `双击选词=${word && word.text && JSON.stringify(word.text.slice(0, 12))}（非折叠=${word && !word.collapsed}）→ 按住拖6步：`
        + `len序列=${lenSeries}；锚层=${anchorLayers}；焦层=${focusLayers}；逐步读数=${JSON.stringify(steps)}；`
        + `松手终态：非折叠=${end && !end.collapsed}，len=${end && end.len}，anchor=${end && JSON.stringify(end.anchor)}，focus=${end && JSON.stringify(end.focus)}；`
        + `截图=${path.basename(s1)}（选词态）+${path.basename(s2)}（拖6步后）`);
    }
  } finally {
    if (session) await session.close();
  }

  const failed = results.filter(r => r.tag === 'FAIL');
  const evidence = results.filter(r => r.tag === 'EVIDENCE');
  console.log(failed.length ? `\n★ R6-ID 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}；取证 ${evidence.length} 条）`
    : `\nR6-ID 汇总：全部 ${results.filter(r => r.tag === 'PASS').length} 项 PASS，取证 ${evidence.length} 条`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });

/** 突变验证（每条把修复改回旧形态，本探针对应用例必须变红）：
 *  · 不立旗回归（F15 本体）：把 mousedown 图上分支的
 *        空白带接管={owner:…,img:true,anchor:{…}};
 *    两行注掉 → mousemove 补丁无旗可认 → f15 用例：选区停在整图选中
 *    （len==imgOnlyLen、不含「第二段扫过标记」）→ FAIL。
 *  · 锚接错位：mousemove 里注掉 if(带.img)anchor.setStart(带.anchor.node,带.anchor.offset)
 *    （恒走 setStartAfter(owner)）→ 拖出的选区不再含图（intersects=false）→ f15 FAIL。
 *  · 死区分流串线：注掉 mouseup 的 if(带.img){空白带接管=null;return;} → 单击图中心
 *    落进空白带 ≤4px 路径「落到图片之后」→ 选区不再恰罩图 → 对照1 FAIL。
 *  · 门卫回退：把图上门卫的 event.detail<2 去掉（detail≥2 也立旗）→ 连点第 2 击被拖选
 *    旗劫走 → 对照3 连点不再展开源码 → FAIL（W4/138 契约护栏）。
 */
