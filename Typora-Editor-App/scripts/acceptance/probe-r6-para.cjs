/** R6 第 6 轮头号（数据损坏级）· 段中图缩放"两侧正文被整段复制两份"回归验收。
 *  （harness dev：electron.exe + app/main/main.js；操作链学 probe-r5-export.cjs d34）
 *
 *  背景（.perf/r5-export d4 取证，2026-10-02）：段落中间的 markdown 图经
 *  「右键 → 图片设置… → 50% → 应用 → 保存」后，存盘 md 变成
 *      段落文字甲 段落文字甲
 *      <img … data-typora-scale="50" />
 *      段落文字乙 段落文字乙
 *  两侧正文被整段复制——源数据被改写，不只是结构漂移。
 *  机理（media-tools.js）：commitImageEdit 的替换区间只覆盖图片源码本身（只删
 *  selection.start..end），邻文仍留在原文里；而 paragraphSplitReplacement 把
 *  before/after 又拼进替换串 → 每侧两份。
 *  修复（R6 最小修复，判决已定）：替换串只含图片源码本身，拆段由**在图片源码两侧
 *  各补一个空行**实现（哪侧真有正文才在哪侧补 \n\n）；"图独占段"的既有行为目标
 *  保留，行内保持（不拆段）另立项。
 *
 *  每用例断言（存盘 md 为准 + 编辑器值）：
 *    1) 无重复段：邻文标记短语各出现且仅出现 1 次；全文无非空行整行重复；
 *    2) 图片源码带 data-typora-scale="50"（<img 形态，alt 保留）；
 *    3) 段落结构：拆段允许且为本修复保留目标——段中图三段分离、段首/段尾图
 *       图片整行独占、独占段图原样独占；
 *    4) 撤销一步还原：焦点断言在编辑面后发**一次** Ctrl+Z，编辑器值不再含
 *       data-typora-scale、原始 ![图](media/r6-a.png) 回来、标记短语仍各 1 次。
 *  用例：段中图（d4 回归主案）+ 对照组 段首图 / 段尾图 / 独占段图（同一操作链）。
 *
 *  探针纪律：不碰剪贴板；输入全真实通道（CDP Input 右键/点击/chord Ctrl+Z）；
 *  素材探针自建于 .perf/r6-para/，不触碰受保护素材；每用例输出
 *  「R6PA <名> PASS/FAIL — …」+ 2 张截图（<用例>-dialog / <用例>-after）。
 *  用法：node probe-r6-para.cjs [--only=mid,lead,tail,solo]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/r6-para');
const sleep = harness.sleep;

const results = [];
function verdict(name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  results.push({ name, tag });
  console.log(`R6PA ${name} ${tag} — ${detail}`);
  return pass;
}
// --only=mid,lead,tail,solo：只跑指定用例（突变验证用；默认全跑）
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);
const count = (hay, needle) => String(hay || '').split(needle).length - 1;

// ---------- 素材：探针自建 PNG（纯 Node 编码，同 probe-r5-export） ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = ~0; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
const makePng = (w, h, [r, g, b]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const writeMedia = dir => {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', 'r6-a.png'), makePng(240, 120, [200, 200, 200]));   // 灰 240×120
};

// ---------- 会话小助手（同 probe-r5-export：内层 document/window 绑定到编辑器 iframe） ----------
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
const waitDiskChange = async (file, before, timeout) => {
  for (let i = 0; i < (timeout || 20000) / 200; i++) {
    try { if (fs.readFileSync(file, 'utf8') !== before) return fs.readFileSync(file, 'utf8'); } catch { /* 还没写 */ }
    await sleep(200);
  }
  return null;
};
/** 把窗口带到前台并确认焦点真在编辑面（交互验收规则：按键读数前先断言焦点，
 *  否则 Ctrl+Z 可能落空而读数是假的）。返回焦点快照或 null。 */
const focusEditor = async session => {
  await session.main.js(`(() => { const r = global.windows[0]; if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.focus(); } return true; })()`);
  const probe = () => frameEval(session, `return { hasFocus: document.hasFocus(),
    active: (document.activeElement && (document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 24))) || 'none',
    inEditor: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.vditor-ir, .vditor-wysiwyg')) };`);
  for (let i = 0; i < 10; i++) { const f = await probe(); if (f && f.hasFocus && f.inEditor) return f; await sleep(150); }
  // 兜底：真实点击文末段落把焦点接回编辑面，再验一次
  const p = await framePoint(session, `const ps = [...document.querySelectorAll('.vditor-reset p')];
    const el = ps[ps.length - 1]; if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (p) { await session.click(p.x, p.y); await sleep(400); }
  for (let i = 0; i < 5; i++) { const f = await probe(); if (f && f.hasFocus && f.inEditor) return f; await sleep(150); }
  return await probe();
};

// ---------- 用例定义：段中图（d4 回归主案）+ 三个对照组 ----------
const CASES = [
  { key: 'mid', name: '段中图', heading: 'R6 段中图', alt: '段中图', order: 'three-way',
    markers: ['段落文字甲', '段落文字乙'],
    md: ['# R6 段中图', '', '段落文字甲 ![段中图](media/r6-a.png) 段落文字乙', '', '第二段收尾。', ''].join('\n') },
  { key: 'lead', name: '段首图', heading: 'R6 段首图', alt: '段首图', order: 'img-then-text',
    markers: ['段首后文'],
    md: ['# R6 段首图', '', '![段首图](media/r6-a.png) 段首后文', '', '第二段收尾。', ''].join('\n') },
  { key: 'tail', name: '段尾图', heading: 'R6 段尾图', alt: '段尾图', order: 'text-then-img',
    markers: ['段尾前文'],
    md: ['# R6 段尾图', '', '段尾前文 ![段尾图](media/r6-a.png)', '', '第二段收尾。', ''].join('\n') },
  { key: 'solo', name: '独占段图', heading: 'R6 独占段图', alt: '独占图', order: 'solo',
    markers: [],
    md: ['# R6 独占段图', '', '![独占图](media/r6-a.png)', '', '第二段收尾。', ''].join('\n') },
];
/** 存盘 md 的图片行（<img 形态、指向本用例媒体、带 alt）。 */
const imgLineOf = (lines, alt) => lines.findIndex(l => l.trim().startsWith('<img') && l.includes('r6-a.png') && l.includes(`alt="${alt}"`));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  writeMedia(OUT);
  const docOf = c => path.join(OUT, `r6-${c.key}.md`);

  let session = null;
  try {
    for (let ci = 0; ci < CASES.length; ci++) {
      const c = CASES[ci];
      if (!want(c.key)) continue;
      const doc = docOf(c);
      fs.writeFileSync(doc, c.md, 'utf8');
      if (!session) {
        session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
          outDir: path.join(OUT, 'shots-r6para'), args: [doc], timeout: 120000 });
      } else {
        // 同窗口换文档（与 d34 同一条真实链路：菜单 + 主进程 dialog 替身）
        await session.main.script([{ dialog: 'open', files: [doc] }]);
        await session.main.clickMenu('文件 > 在此窗口打开文件…');
      }
      const ready = await session.until(editorReady(c.heading), { timeout: 60000 });
      let detail = '编辑器未就绪';
      if (ready) {
        let loaded = false;
        for (let i = 0; i < 50 && !loaded; i++) {
          loaded = !!(await frameEval(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src') || '').includes('r6-a.png'));
            return img ? { nw: img.naturalWidth, ok: img.naturalWidth > 0 } : null;`));
          if (!loaded) await sleep(200);
        }
        await sleep(600);
        // ---- GUI 主路径：右键图 → 「图片设置…」→ 50% 预设 → 截图 → 应用 ----
        let how = 'gui';
        const imgPos = await framePoint(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src') || '').includes('r6-a.png'));
          if (!img) return null; const r = img.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 24) };`);
        if (!loaded || !imgPos) how = 'api:未找到图';
        else {
          await session.click(imgPos.x, imgPos.y, { button: 'right' });
          const menuUp = await session.until(`(() => { const f = document.getElementById('editor'); const d = f && f.contentWindow && f.contentWindow.document;
            const m = d && d.getElementById('typora-editor-context-menu');
            return !!(m && d.body.contains(m) && [...m.querySelectorAll('button')].some(b => b.textContent.includes('图片设置'))); })()`, { timeout: 5000 });
          if (!menuUp) how = 'api:右键菜单未出现';
          else {
            const itemPos = await framePoint(session, `const m = document.getElementById('typora-editor-context-menu');
              const b = [...m.querySelectorAll('button')].find(x => x.textContent.includes('图片设置')); if (!b) return null;
              const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
            await session.click(itemPos.x, itemPos.y);
            const dialogUp = await session.until(`(() => { const f = document.getElementById('editor'); const d = f && f.contentWindow && f.contentWindow.document;
              const g = d && d.getElementById('typora-image-settings'); return !!(g && g.open); })()`, { timeout: 5000 });
            if (!dialogUp) how = 'api:设置框未打开';
            else {
              const preset = await framePoint(session, `const g = document.getElementById('typora-image-settings');
                const b = [...g.querySelectorAll('.media-presets button')].find(x => x.textContent.trim() === '50%'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
              const apply = await framePoint(session, `const g = document.getElementById('typora-image-settings');
                const b = g.querySelector('button[type=submit]'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
              await session.click(preset.x, preset.y); await sleep(250);
              await session.shot(`${c.key}-dialog`);                        // 截图 1/2：设置框已选 50%
              await session.click(apply.x, apply.y);
            }
          }
        }
        if (how !== 'gui') {
          // 兜底：退到产品同一函数（设置框「应用」调用的 setImageScale）
          await frameEval(session, `const img = [...document.querySelectorAll('.vditor-reset img')].find(i => (i.getAttribute('src') || '').includes('r6-a.png'));
            if (img && window.vditor && window.vditor.__media) { window.vditor.__media.setScale(img, '50'); return 'applied'; } return 'no-channel';`);
        }
        let applied = false;
        for (let i = 0; i < 50 && !applied; i++) {
          applied = !!(await frameEval(session, `const v = window.vditor ? window.vditor.getValue() : '';
            return v.includes('data-typora-scale');`));
          if (!applied) await sleep(200);
        }
        await sleep(800);
        await session.shot(`${c.key}-after`);                               // 截图 2/2：应用后（拆段 + 缩放可见）
        // ---- 保存（真实菜单）→ 以存盘 md 为准断言 ----
        const clicked = await session.main.clickMenu('文件 > 保存');
        const disk = await waitDiskChange(doc, c.md, 20000);
        let markersOk = false, markerInfo = '磁盘 20s 未变化';
        let noDupLines = false, dupInfo = '';
        let scaleOk = false, structureOk = false, structureInfo = '';
        if (disk !== null) {
          const lines = disk.split('\n');
          const counts = c.markers.map(m => ({ m, n: count(disk, m) }));
          const tailN = count(disk, '第二段收尾。');
          markersOk = counts.every(x => x.n === 1) && tailN === 1;
          markerInfo = counts.map(x => `${x.m}×${x.n}`).concat([`第二段收尾。×${tailN}`]).join('、');
          const dupLines = lines.filter((l, i, a) => l.trim() && a.indexOf(l) === i && a.lastIndexOf(l) !== i);
          noDupLines = !dupLines.length;
          dupInfo = dupLines.length ? `整行重复=${JSON.stringify(dupLines)}` : '整行重复=无';
          const lineImg = imgLineOf(lines, c.alt);
          scaleOk = lineImg >= 0 && lines[lineImg].includes('data-typora-scale="50"');
          const lineOf = phrase => lines.findIndex(l => l.includes(phrase));
          const imgAlone = lineImg >= 0 && /^\s*<img[^>]*>\s*$/.test(lines[lineImg]);
          if (lineImg < 0) structureInfo = '图行未找到';
          else if (c.order === 'three-way') {
            const a = lineOf('段落文字甲'), b = lineOf('段落文字乙');
            structureOk = a >= 0 && b >= 0 && a < lineImg && lineImg < b && !lines[a].includes('<img') && !lines[b].includes('<img');
            structureInfo = `段A=L${a + 1} 图=L${lineImg + 1} 段B=L${b + 1} 三段分离=${structureOk}`;
          } else if (c.order === 'img-then-text') {
            const t = lineOf('段首后文');
            structureOk = t >= 0 && lineImg < t && imgAlone;
            structureInfo = `图=L${lineImg + 1} 文=L${t + 1} 图先行且整行独占=${structureOk}`;
          } else if (c.order === 'text-then-img') {
            const t = lineOf('段尾前文');
            structureOk = t >= 0 && t < lineImg && !lines[t].includes('<img') && imgAlone;
            structureInfo = `文=L${t + 1} 图=L${lineImg + 1} 文先行、图整行独占=${structureOk}`;
          } else {   // solo
            structureOk = imgAlone;
            structureInfo = `图=L${lineImg + 1} 整行独占=${structureOk}`;
          }
        }
        // ---- 撤销一步还原：焦点断言 → 一次 Ctrl+Z → 编辑器值复核 ----
        let focusOk = false, focusInfo = '未测', undone = false, undoInfo = '未测';
        if (disk !== null) {
          const f = await focusEditor(session);
          focusOk = !!(f && f.hasFocus && f.inEditor);
          focusInfo = f ? `hasFocus=${f.hasFocus} active=${JSON.stringify(f.active)} inEditor=${f.inEditor}` : 'null';
          if (focusOk) {
            await session.chord('z', 'KeyZ', 90);                          // 恰好一次 Ctrl+Z（真实按键通道）
            let valueAfter = '';
            for (let i = 0; i < 25 && !undone; i++) {
              valueAfter = (await frameEval(session, `return window.vditor ? window.vditor.getValue() : '';`)) || '';
              undone = !valueAfter.includes('data-typora-scale');
              if (!undone) await sleep(200);
            }
            const imgBack = valueAfter.includes(`![${c.alt}](media/r6-a.png)`);
            const markersBack = c.markers.every(m => count(valueAfter, m) === 1);
            undoInfo = undone ? `一步还原=${undone && imgBack && markersBack}（原始 md 图回来=${imgBack}，标记各1次=${markersBack}）` : '一次 Ctrl+Z 后仍含 data-typora-scale';
            undone = undone && imgBack && markersBack;
          } else {
            undoInfo = '焦点未落在编辑面，按键读数不可信';
          }
        }
        const pass = !!ready && how === 'gui' && applied && disk !== null
          && markersOk && noDupLines && scaleOk && structureOk && focusOk && undone;
        detail = `输入=${how === 'gui' ? '右键→图片设置…→50%→应用（全 GUI）' : 'GUI 未走通(' + how + ')，退到 vditor.__media.setScale 同一函数'}`
          + `；缩放已进编辑器值=${applied}；保存菜单=${String(clicked).slice(0, 8)}；存盘=${disk !== null ? '已重写' : '20s 未变化'}`
          + `；无重复段=${markersOk && noDupLines}（${markerInfo}；${dupInfo}）`
          + `；图源码带 data-typora-scale="50"=${scaleOk}；结构（拆段允许）=${structureOk}（${structureInfo}）`
          + `；撤销一步还原=${undone}（${undoInfo}；焦点=${focusInfo}）`
          + `；截图=${c.key}-dialog.png+${c.key}-after.png`;
        verdict(c.name, pass, detail);
      } else {
        verdict(c.name, false, detail);
      }
    }
  } finally {
    if (session) await session.close();
  }

  const failed = results.filter(r => r.tag === 'FAIL');
  console.log(failed.length ? `\n★ R6-PA 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}）`
    : `\nR6-PA 汇总：全部 ${results.length} 项 PASS`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });

/** 突变验证（每条把修复改回旧形态，本探针对应用例必须变红）：
 *  · 拼接回归（数据损坏本体）：paragraphSplitReplacement 的 R6 行改回
 *        return (before?before+'\n\n':'')+html+(after?'\n\n'+after:'');
 *    → 段中图/段首图/段尾图存盘 md 邻文各两份（"段落文字甲"×2 等，且整行重复命中）
 *      → 无重复段=false → FAIL。（独占段图 before/after 皆空，两形态等价，
 *      它不是本突变的红样本，只守"原样独占"。）
 *  · 拆段丢失：R6 行改成 return html;（不补 \n\n）→ 图与邻文同行：
 *    段中图"三段分离"=false、段首/段尾图"图整行独占"=false → FAIL。
 *  · 缩放属性丢失（同一路径回归）：imageHtml 去掉 data-typora-scale →
 *    图源码带 data-typora-scale="50"=false → FAIL。
 */
