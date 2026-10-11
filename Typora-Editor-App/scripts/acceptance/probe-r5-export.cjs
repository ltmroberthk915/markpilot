/** R5 第 5 轮 · 导出/互操作域验收与取证（harness dev：electron.exe + app/main/main.js）。
 *
 *  覆盖（round5-findings.md D 节，辩论结论：D1/D2 通过修复，D6/D7 否决，D3/D4 存疑先取证）：
 *    D1  Typora 缩放图 style="zoom:50%" 导出 HTML：属性白名单放行 style，且只保留
 *        zoom/width/height 三个子声明（正则白名单，position/display/url() 等注入面剥掉）。
 *        走**真实导出链**：hostApi.invoke('export')（与工具栏/菜单同一条 IPC）→ 隐藏 worker
 *        载入 /shell/export.html → prepareExport/finishExport → 落盘 HTML；产物按
 *        「代码之外」通道核验（磁盘文件 + 独立隐藏窗口里的几何量测 + 截图）。
 *    D2  另存为副本默认把相对路径图片全部内嵌 base64（Typora 打开变代码墙）——现在
 *        保存前弹**三选确认框**（内嵌/保留引用/取消），detail 写明告知。替身只顶替
 *        「用户在系统对话框里选了什么」，其后全是真产品代码；断言磁盘副本形态。
 *    D3  EVIDENCE：YAML front matter 文档打开 → 打一个字 → 存盘，diff 磁盘原文，
 *        实测缩进剥离/空行插入（不判 PASS/FAIL，产出实测数据供裁决）。
 *    D4  EVIDENCE：段中（段内）markdown 图经产品自己的缩放 UI（右键 → 图片设置… →
 *        50% → 应用）→ 存盘，实测是否被拆成三段、图源码形态漂移。
 *
 *  探针纪律：**全程不碰剪贴板**；输入一律真实通道（CDP Input 点击/右键/insertText，
 *  菜单走 clickMenu）；系统对话框走主进程 dialog 替身；素材全部探针自建目录，
 *  不触碰受保护素材。每用例输出「R5EX <名> PASS/FAIL/EVIDENCE — …」+ 截图
 *  （.perf/r5-export/shots- 各目录）。红条件（旧代码必须 FAIL）见文件末尾「突变验证」。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/r5-export');
const sleep = harness.sleep;
const say = v => console.log(typeof v === 'string' ? v : JSON.stringify(v));

const results = [];
function verdict(name, pass, detail) {
  const tag = pass === null ? 'EVIDENCE' : pass ? 'PASS' : 'FAIL';
  results.push({ name, tag });
  console.log(`R5EX ${name} ${tag} — ${detail}`);
  return pass;
}
// --only=d1,d2a,d2b,d34：只跑指定用例（突变验证用；默认全跑）
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = key => !ONLY.length || ONLY.includes(key);

// ---------- 素材：探针自建 PNG（纯 Node 编码，不依赖外部图片） ----------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = ~0; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
/** 宽 w 高 h 的纯色 RGB PNG（8bit/colortype 2）。 */
const makePng = (w, h, [r, g, b]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const writeMedia = dir => {
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', 'zoom-a.png'), makePng(240, 120, [204, 32, 32]));    // 红 240×120
  fs.writeFileSync(path.join(dir, 'media', 'zoom-b.png'), makePng(240, 120, [32, 32, 204]));    // 蓝 240×120
  fs.writeFileSync(path.join(dir, 'media', 'd2-a.png'), makePng(120, 80, [16, 128, 16]));
  fs.writeFileSync(path.join(dir, 'media', 'd2-b.png'), makePng(120, 80, [128, 96, 16]));
  fs.writeFileSync(path.join(dir, 'media', 'inline-c.png'), makePng(240, 120, [200, 200, 200])); // 灰 240×120
};

// ---------- 会话小助手 ----------
const editorReady = title => `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  const root = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
  return !!(root && root.textContent.includes(${JSON.stringify(title)})); })()`;
/** 在编辑器 iframe 里求值（返回值须可 JSON 序列化）。内层的 document/window 通过
 *  参数遮蔽绑定到 iframe 自己的文档——首轮踩坑：裸写 document 解析到**外壳**文档，
 *  段落/图片/vditor 全查成空，D3/D4 的输入全部落空。 */
const frameEval = (s, code) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document || !w.document.body) return null;
  return (function (document, window) { ${code} })(w.document, w); })()`);
/** iframe 内元素中心 → 顶层页视口坐标（CDP Input 用的就是这套坐标；同样绑定 iframe 文档）。 */
const framePoint = (s, expr) => s.js(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w) return null; const p = (function (document, window) { ${expr} })(w.document, w);
  if (!p || p.x === undefined) return null;
  const fr = f.getBoundingClientRect(); return { x: Math.round(fr.x + p.x), y: Math.round(fr.y + p.y) }; })()`);
const waitFile = async (file, minBytes, timeout) => {
  for (let i = 0; i < (timeout || 20000) / 200; i++) {
    if (fs.existsSync(file) && fs.statSync(file).size >= (minBytes || 1)) return true;
    await sleep(200);
  }
  return false;
};
const waitDiskChange = async (file, before, timeout) => {
  for (let i = 0; i < (timeout || 20000) / 200; i++) {
    try { if (fs.readFileSync(file, 'utf8') !== before) return fs.readFileSync(file, 'utf8'); } catch { /* 还没写 */ }
    await sleep(200);
  }
  return null;
};
const boot = (label, docFile) => harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
  outDir: path.join(OUT, 'shots-' + label), args: [docFile], timeout: 120000 });
const lineDiff = (a, b) => {
  const A = a.split('\n'), B = b.split('\n'), out = [];
  for (let i = 0; i < Math.max(A.length, B.length) && out.length < 24; i++) {
    if (A[i] !== B[i]) out.push(`L${i + 1}: ${JSON.stringify(A[i] ?? '(无)')} → ${JSON.stringify(B[i] ?? '(无)')}`);
  }
  return out;
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });

  // ================= D1：Typora 缩放图导出 HTML 保真（真实导出链） =================
  if (want('d1')) {
    const dir = path.join(OUT, 's1'); writeMedia(dir);
    const doc = path.join(dir, 'D1缩放导出.md');
    const md = [
      '# D1 缩放导出', '',
      '<img src="media/zoom-a.png" style="zoom:0.5" alt="甲缩放图">', '',
      '两图之间的一段正文。', '',
      '<img src="media/zoom-b.png" style="zoom:50%;position:fixed;display:block;background:url(x.png);color:red" alt="乙注入面">', '',
      '结尾段。', '',
    ].join('\n');
    fs.writeFileSync(doc, md, 'utf8');
    const target = path.join(dir, 'D1缩放导出.html');
    const session = await boot('d1', doc);
    try {
      const ready = await session.until(editorReady('D1 缩放导出'), { timeout: 60000 });
      await sleep(1500);
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'save', file: target }]);   // 替身：用户在导出保存框里选了目标路径
      const invoked = await session.js(`hostApi.invoke('export', {format:'html'})`);
      const produced = await waitFile(target, 500, 60000);
      const html = produced ? fs.readFileSync(target, 'utf8') : '';
      const tags = html.match(/<img[^>]*>/g) || [];
      const imgA = tags.find(t => t.includes('甲缩放图')) || '';
      const imgB = tags.find(t => t.includes('乙注入面')) || '';
      const styleOf = tag => (/style="([^"]*)"/.exec(tag) || [])[1] || null;
      const styleA = styleOf(imgA), styleB = styleOf(imgB);
      const embeddedCount = (html.match(/data:image\/png;base64/g) || []).length;
      // 独立隐藏窗口载入**产物文件**量测渲染宽度（代码之外的证人）+ 截图
      let measured = null, png = null;
      if (produced) {
        const raw = await session.main.js(`(async () => { try {
          const { BrowserWindow } = require('electron');
          const w = new BrowserWindow({ show:false, width:1000, height:1400, webPreferences:{ sandbox:true, contextIsolation:true, paintWhenInitiallyHidden:true, backgroundThrottling:false } });
          try { await w.loadFile(${JSON.stringify(target)}); await new Promise(r => setTimeout(r, 1000));
            const info = await w.webContents.executeJavaScript("(() => { const imgs = [...document.querySelectorAll('#content img')]; return imgs.map(i => ({ alt:i.alt, style:i.getAttribute('style'), w:Math.round(i.getBoundingClientRect().width), h:Math.round(i.getBoundingClientRect().height), nw:i.naturalWidth })); })()");
            const shot = await w.webContents.capturePage();
            return JSON.stringify({ info, png: shot && !shot.isEmpty() ? shot.toPNG().toString('base64') : null });
          } finally { w.destroy(); }
        } catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); } })()`);
        try { measured = JSON.parse(raw || 'null'); } catch { measured = { error: 'parse:' + String(raw).slice(0, 120) }; }
        if (measured && measured.png) { png = path.join(OUT, 'shots-d1', 'd1-exported-product.png'); fs.writeFileSync(png, Buffer.from(measured.png, 'base64')); }
      }
      const mA = measured && measured.info ? measured.info.find(i => i.alt === '甲缩放图') : null;
      const mB = measured && measured.info ? measured.info.find(i => i.alt === '乙注入面') : null;
      const zoomKept = styleA === 'zoom:0.5';
      const injectionStripped = styleB === 'zoom:50%'
        && !/position|display|background|url\(|color/i.test(imgB);
      const halfSize = mA && mB && Math.abs(mA.w - 120) <= 8 && Math.abs(mB.w - 120) <= 8 && mA.nw === 240;
      await session.shot('d1-editor');
      verdict('D1', ready && produced && !!(invoked && invoked.phase === 'done') && zoomKept && injectionStripped
        && embeddedCount >= 2 && !html.includes('media/zoom-a.png') && halfSize,
        `导出链=${ready ? 'hostApi.invoke(export,html) 真实 IPC' : '编辑器未就绪'}，invoke phase=${invoked && invoked.phase}，产物=${produced ? path.basename(target) : '未产出'}`
        + `；甲图 style=${JSON.stringify(styleA)}（期望 "zoom:0.5"），乙图 style=${JSON.stringify(styleB)}（期望仅 "zoom:50%"，position/display/background 全剥=${injectionStripped}）`
        + `；内嵌 data: 图=${embeddedCount} 张、相对路径残留=${html.includes('media/zoom-a.png')}`
        + `；产物实测渲染宽=${mA ? mA.w + '×' + mA.h : '量测失败'} / ${mB ? mB.w + '×' + mB.h : '量测失败'}（原图 240×120，zoom 50% 期望 ≈120×60）${measured && measured.error ? '；量测错误：' + measured.error : ''}`
        + `；截图=d1-editor.png${png ? '+d1-exported-product.png（产物独立窗口渲染）' : '（产物截图未取得，仅属性断言）'}`);
      if (!halfSize && mA) say('R5EX D1 EVIDENCE — 产物量测明细：' + JSON.stringify(measured.info));
    } finally { await session.close(); }
  }

  // ================= D2a：另存为 →「内嵌（单文件便携）」 =================
  if (want('d2a')) {
    const dir = path.join(OUT, 's2'); writeMedia(dir);
    const doc = path.join(dir, 'D2另存为.md');
    fs.writeFileSync(doc, ['# D2 另存为', '', '![甲图](media/d2-a.png)', '', '中间正文。', '', '![乙图](media/d2-b.png)', ''].join('\n'), 'utf8');
    const target = path.join(dir, 'D2另存为-内嵌副本.md');
    const session = await boot('d2embed', doc);
    try {
      const ready = await session.until(editorReady('D2 另存为'), { timeout: 60000 });
      await sleep(1200);
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'save', file: target }, { dialog: 'message', response: 0 }]);
      const clicked = await session.main.clickMenu('文件 > 另存为…');
      const produced = await waitFile(target, 200, 30000);
      const text = produced ? fs.readFileSync(target, 'utf8') : '';
      const msgs = (await session.main.calls()).filter(c => c.kind === 'message');
      const confirm = msgs.find(c => ((c.options || {}).buttons || [])[0] === '内嵌（单文件便携）') || null;
      const opts = confirm ? confirm.options || {} : {};
      const buttonsOk = confirm && JSON.stringify(opts.buttons) === JSON.stringify(['内嵌（单文件便携）', '保留相对路径引用', '取消']);
      const noticeOk = confirm && String(opts.detail || '').includes('2 张相对路径图片内嵌为 base64')
        && String(opts.detail || '').includes('Typora') && String(opts.message || '').includes('2 张');
      const base64Count = (text.match(/data:image\/png;base64/g) || []).length;
      await session.shot('d2-embed-editor');
      verdict('D2-内嵌', ready && String(clicked).startsWith('CLICKED') && produced && !!confirm && buttonsOk && noticeOk
        && base64Count >= 2 && !text.includes('](media/'),
        `入口=菜单「文件 > 另存为…」（${String(clicked).slice(0, 14)}），替身选「内嵌」；确认框=${confirm ? '已弹' : '未弹'}，按钮=${buttonsOk ? '内嵌/保留引用/取消 三选齐' : JSON.stringify(opts.buttons)}`
        + `，文案含告知（N=2 + base64 + Typora 兼容性提示）=${noticeOk}；`
        + `磁盘副本 ${produced ? path.basename(target) : '未产出'}：内嵌 base64 图=${base64Count} 张、相对引用残留=${text.includes('](media/')}`);
    } finally { await session.close(); }
  }

  // ================= D2b：另存为 →「保留相对路径引用」+「取消」 =================
  if (want('d2b')) {
    const dir = path.join(OUT, 's3'); writeMedia(dir);
    const doc = path.join(dir, 'D2另存为.md');
    fs.writeFileSync(doc, ['# D2 另存为', '', '![甲图](media/d2-a.png)', '', '中间正文。', '', '![乙图](media/d2-b.png)', ''].join('\n'), 'utf8');
    const targetKeep = path.join(dir, 'D2另存为-引用副本.md');
    const targetNever = path.join(dir, '取消不应出现.md');
    const session = await boot('d2keep', doc);
    try {
      const ready = await session.until(editorReady('D2 另存为'), { timeout: 60000 });
      await sleep(1200);
      // --- 保留引用 ---
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'save', file: targetKeep }, { dialog: 'message', response: 1 }]);
      const clicked1 = await session.main.clickMenu('文件 > 另存为…');
      const produced = await waitFile(targetKeep, 20, 30000);
      let migrated = false;
      for (let i = 0; i < 50 && !migrated; i++) {
        const recs = (await session.recs()) || [];
        migrated = recs.length === 1 && recs[0].file && recs[0].file.toLowerCase() === targetKeep.toLowerCase();
        if (!migrated) await sleep(200);
      }
      const text = produced ? fs.readFileSync(targetKeep, 'utf8') : '';
      const keepOk = produced && text.includes('![甲图](media/d2-a.png)') && text.includes('![乙图](media/d2-b.png)')
        && !text.includes('base64');
      await session.shot('d2-keep-editor');
      // --- 取消：不该写出任何文件，文档也不迁移 ---
      await session.main.clearCalls();
      await session.main.script([{ dialog: 'save', file: targetNever }, { dialog: 'message', response: 2 }]);
      const clicked2 = await session.main.clickMenu('文件 > 另存为…');
      await sleep(2500);
      const never = fs.existsSync(targetNever);
      const recs2 = (await session.recs()) || [];
      const stillKeep = recs2.length === 1 && recs2[0].file && recs2[0].file.toLowerCase() === targetKeep.toLowerCase();
      verdict('D2-保留引用+取消', ready && String(clicked1).startsWith('CLICKED') && keepOk && migrated
        && String(clicked2).startsWith('CLICKED') && !never && stillKeep,
        `「保留引用」：副本 ${produced ? path.basename(targetKeep) : '未产出'} 相对引用保留=${keepOk}（甲/乙两张图原样、无 base64）、窗口文档迁移=${migrated}；`
        + `「取消」：第二次另存为选取消后 未写出文件=${!never}、文档原地=${stillKeep}`);
    } finally { await session.close(); }
  }

  // ================= D3（EVIDENCE）+ D4（EVIDENCE）：同一会话两份文档 =================
  if (want('d34')) {
    const dir = path.join(OUT, 's4'); writeMedia(dir);
    const d3doc = path.join(dir, 'D3前置.md');
    const d3md = [
      '---',
      'title: 互操作实测',
      'author:',
      '  name: 张三',
      '  org: 某某公司',
      'prefs:',
      '  theme: dark',
      'tags: [甲, 乙]',
      '---',
      '',
      '# 正文标题',
      '',
      '正文第一段。',
      '',
    ].join('\n');
    fs.writeFileSync(d3doc, d3md, 'utf8');
    const session = await boot('d34', d3doc);
    try {
      // ---------- D3：front matter 打一字 → 存盘 diff ----------
      const ready3 = await session.until(editorReady('正文标题'), { timeout: 60000 });
      await sleep(1500);
      let d3detail = '编辑器未就绪';
      if (ready3) {
        // 真实输入：先把窗口带到前台（insertText 需要窗口级焦点，实测缺这步时
        // 点击能落点但输入全部被丢），再点进正文段落、insertText 一个字。
        await session.main.js(`(() => { const r = global.windows[0]; if (r && r.win && !r.win.isDestroyed()) { if (r.win.isMinimized()) r.win.restore(); r.win.focus(); } return true; })()`);
        for (let i = 0; i < 10; i++) { const f = !!(await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); return !!w && w.webContents.id === global.windows[0].win.webContents.id; })()`)); if (f) break; await sleep(150); }
        const p = await framePoint(session, `const p = [...document.querySelectorAll('.vditor-reset p')]
          .find(el => el.textContent.includes('正文第一段')); if (!p) return null;
          const r = p.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
        if (p) { await session.click(p.x, p.y); await sleep(400); }
        const focus = await frameEval(session, `return { hasFocus: document.hasFocus(),
          active: (document.activeElement && (document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 24))) || 'none' };`);
        await session.type('杪');
        let dirtySeen = false;
        for (let i = 0; i < 40 && !dirtySeen; i++) {
          dirtySeen = !!(await session.main.js(`global.windows.some(r => r.doc && r.doc.current && r.doc.current.text.includes('杪'))`));
          if (!dirtySeen) await sleep(150);
        }
        const clicked = await session.main.clickMenu('文件 > 保存');
        const disk = await waitDiskChange(d3doc, d3md, 20000);
        const focusInEditor = !!(focus && focus.hasFocus && /vditor|edit/i.test(String(focus.active)));
        const diff = disk === null ? [] : lineDiff(d3md, disk);
        const indentKept = disk !== null && disk.includes('  name: 张三') && disk.includes('  theme: dark');
        // front matter 块 = 从第 1 行 `---` 到下一个 `---` 行（含）；空行只数这两条围栏之间的
        const blankInside = text => { const lines = text.split('\n'); let close = -1;
          for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { close = i; break; }
          return close > 0 ? lines.slice(1, close).filter(l => !l.trim()).length : null; };
        const blankBefore = disk !== null ? /^---\s*\n\s*\n#/.test(disk) : null;   // 围栏后是否仍留空行
        const dupLines = disk === null ? [] : disk.split('\n').filter((l, i, a) => l.trim() && a.indexOf(l) === i && a.lastIndexOf(l) !== i);
        await session.shot('d3-editor-after-save');
        d3detail = `输入=点进正文段+insertText('杪')+菜单保存（保存菜单=${String(clicked).slice(0, 8)}，change 到达主进程=${dirtySeen}，焦点=${focusInEditor ? '在编辑面' : JSON.stringify(focus)}）`
          + `；磁盘${disk === null ? ' 20s 未变化' : '已重写'}；缩进保留=${indentKept}（'  name: 张三'/'  theme: dark' 逐字在盘）`
          + `；front matter 围栏内空行=${blankInside(disk === null ? '' : disk)}（原文 ${blankInside(d3md)}）`
          + `；围栏后空行保留=${blankBefore}（原文有；被吃掉=front matter 与正文粘连，Typora 重新打开解析会变）`
          + `；重复行=${dupLines.length ? JSON.stringify(dupLines) : '无'}`
          + `；diff（前 ${diff.length} 行）：${diff.length ? diff.join(' ｜ ') : '无差异'}`;
      }
      verdict('D3', null, d3detail);

      // ---------- D4：段中 markdown 图 → 产品缩放 UI → 存盘三段结构 ----------
      const d4doc = path.join(dir, 'D4段中图.md');
      const d4md = ['# D4 段中图', '', '段落文字甲 ![段中图](media/inline-c.png) 段落文字乙', '', '第二段收尾。', ''].join('\n');
      fs.writeFileSync(d4doc, d4md, 'utf8');
      await session.main.script([{ dialog: 'open', files: [d4doc] }]);   // 替身：用户选了 D4 文档
      await session.main.clickMenu('文件 > 在此窗口打开文件…');
      const ready4 = await session.until(editorReady('段中图'), { timeout: 60000 });
      let d4detail = 'D4 文档未打开';
      if (ready4) {
        let loaded = false;
        for (let i = 0; i < 50 && !loaded; i++) {
          loaded = !!(await frameEval(session, `const img = document.querySelector('.vditor-reset img');
            return img ? { nw: img.naturalWidth, ok: img.naturalWidth > 0 } : null;`));
          if (!loaded) await sleep(200);
        }
        await sleep(600);
        // GUI 主路径：右键图 → 菜单「图片设置…」→ 对话框 50% 预设 → 应用
        let how = 'gui';
        const imgPos = await framePoint(session, `const img = document.querySelector('.vditor-reset img');
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
              await session.shot('d4-dialog');
              await session.click(apply.x, apply.y);
            }
          }
        }
        if (how !== 'gui') {
          // 兜底：退到产品同一函数（图片设置框「应用」按钮调用的 setImageScale）
          await frameEval(session, `const img = document.querySelector('.vditor-reset img');
            if (img && window.vditor && window.vditor.__media) { window.vditor.__media.setScale(img, '50'); return 'applied'; } return 'no-channel';`);
        }
        let applied = false;
        for (let i = 0; i < 50 && !applied; i++) {
          applied = !!(await frameEval(session, `const v = window.vditor ? window.vditor.getValue() : '';
            return v.includes('data-typora-scale');`));
          if (!applied) await sleep(200);
        }
        await sleep(800);
        await session.shot('d4-after-scale');
        const clicked = await session.main.clickMenu('文件 > 保存');
        const disk = await waitDiskChange(d4doc, d4md, 20000);
        let structure = '磁盘 20s 未变化';
        let threeWay = null, mdImgKept = null, styleForm = null, duplicated = null;
        if (disk !== null) {
          const lines = disk.split('\n');
          const lineA = lines.findIndex(l => l.trim() === '段落文字甲' || l.trim().startsWith('段落文字甲'));
          const lineImg = lines.findIndex(l => /^\s*(<img|!\[)/.test(l) && l.includes('inline-c.png'));
          const lineB = lines.findIndex(l => l.trim() === '段落文字乙' || l.trim().endsWith('段落文字乙'));
          threeWay = lineA >= 0 && lineImg >= 0 && lineB >= 0 && lineA !== lineImg && lineImg !== lineB;
          mdImgKept = disk.includes('![段中图](media/inline-c.png)');
          styleForm = /<img[^>]*data-typora-scale/.test(disk) ? 'html-img+data-typora-scale' : (mdImgKept ? 'md-image' : '其它');
          duplicated = /(段落文字甲)[^\n]*\1|(段落文字乙)[^\n]*\2/.test(disk);
          structure = `存盘行结构：段A=L${lineA + 1}、图=L${lineImg + 1}、段B=L${lineB + 1}，三段分离=${threeWay}`
            + `；两侧文字被复制=${duplicated}（同短语在同一段出现两次——正文数据被改写，不只是结构漂移）`
            + `；图形态=${styleForm}（原为 md 图 ![段中图](media/inline-c.png)）`;
        }
        d4detail = `输入=${how === 'gui' ? '右键→图片设置…→50%→应用（全 GUI）' : 'GUI 未走通(' + how + ')，退到 vditor.__media.setScale 同一函数'}`
          + `；缩放已进编辑器值=${applied}；保存菜单=${String(clicked).slice(0, 8)}；${structure}；截图=d4-dialog.png+d4-after-scale.png`;
      }
      verdict('D4', null, d4detail);
    } finally { await session.close(); }
  }

  const failed = results.filter(r => r.tag === 'FAIL');
  console.log(failed.length ? `\n★ R5-EX 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}）`
    : `\nR5-EX 汇总：全部 ${results.length} 项 PASS/EVIDENCE`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error && error.stack || error); process.exitCode = 1; });

/** 突变验证（每条改回旧代码，本探针对应用例必须变红）：
 *  · D1  export-render.js 的 attrs 集合去掉 'style'（或 cleanStyle 直接返回 null）→
 *         imgA style=null（zoom 丢失）、产物渲染宽回到 240 → FAIL。
 *         只放行 style 不过滤子声明（cleanStyle 原样返回 value）→ 乙图 style 含
 *         position/display/background → injectionStripped=false → FAIL。
 *  · D2-内嵌  doc.js saveAs 的确认框整段注掉（回到无条件 embedRelativeImages）→
 *         main.calls() 里找不到 buttons[0]==='内嵌（单文件便携）' 的 message → FAIL。
 *  · D2-保留引用+取消  choice===1 时也走 embedRelativeImages（embed 恒真）→
 *         副本含 base64、相对引用不在 → keepOk=false → FAIL；
 *         choice===2 不 return false → targetNever 被写出 → FAIL。
 *  · D3/D4  EVIDENCE 用例不设红条件；突变验证只看 D1/D2。
 */
