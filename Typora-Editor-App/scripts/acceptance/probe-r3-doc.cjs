/** 探针 · 第 3 轮 F 节自动保存/文件监控六缺陷修复验收（2026-10-02，probe-r3-doc）。
 *
 *  对应修复（app/main/doc.js + extension-src/render/index.js 的 setValue handler）：
 *   F1' 静默重载保光标/滚动 —— 外部修改+本地未改时 checkFile 整篇 setValue，渲染层在
 *       替换前按"源码文本偏移"记下光标与 scrollTop，替换后放回（渲染层修复）。
 *   F2' 失联可见 + Ctrl+S 不静默重建 —— watcher ENOENT 后状态栏亮"文件已不在原位置…"；
 *       手动保存遇 disk=null 必须过用户确认（区分不了删除/改名就绝不擅自重建）。
 *   F3' 保存失败 10s 退避重试 —— 失败即排一次 10s 重试，dirty 存续且无人工接管就续排。
 *   F4' savedDisk 早退清闩锁 —— 磁盘被外部还原回上次保存形态时，externalConflict/
 *       deleted/saveError 必须解开并恢复自动保存排程。
 *   F5' 关快照时冲突措辞 —— 不再承诺"从版本历史恢复"（快照关着就没有这份历史）。
 *   F6' 手动保存落穿 —— 撞上"失败中的在途保存"时不再连带返回假失败，落穿把本次写掉。
 *
 *  每用例一行：R3DOC <名> PASS/FAIL/EVIDENCE {关键读数 JSON}，附整页 + 关键处 2x 截图
 *  （.perf/probe-r3-doc/）。截图标记口径沿用 r1/r2/r3 探针：红实线＝光标落点、
 *  琥珀虚线＝期望位、青虚线＝击点。CDP 抓帧拍不到原生光标，按浏览器自报矩形画标记。
 *
 *  通道纪律：
 *   · 不碰剪贴板（全程无 saveClipboard/restoreClipboard；也无复制/粘贴类动作）。
 *   · 外部修改/删除一律由**独立 node 子进程**改磁盘（spawn process.execPath -e，
 *     参数只传 ASCII 路径与 ASCII 令牌，中文正文从不跨进程传参）。
 *   · 文件删除用子进程 fs.unlinkSync；每用例独立实例（自己的窗口/会话），结束即释放。
 *   · 真实输入走 CDP Input（点击/insertText/组合键）；主进程侧读数走 --inspect 调试器
 *     （dialog.* 已被 harness 换成可脚本化替身，调用参数全量留痕）。
 *   · F3'/F6' 的"保存失败/在途失败"无法用只读目录或文件占用在 Windows 上稳定模拟
 *     （目录只读属性不拦写入、Node 打开文件不带排他锁），按 round-state 的裁决改走
 *     **主进程内注入**：F3' 替换 fs/promises.rename 对目标文件抛 EBUSY（网盘占用形态，
 *     触发的是真实 atomicWrite→writeCurrent 失败路径）；F6' 伪造一个"失败中的在途
 *     savePromise"（F6' 的前置态），真正落盘的那次保存 100% 走真实 writeCurrent。
 *     注入不可行处如实降级 EVIDENCE 并写明通道限制。
 *
 *  用法：node scripts/acceptance/probe-r3-doc.cjs [--only=f1,f2,f3,f4,f5,f6]
 *        （--only 大小写不敏感；跑前先 `npm run sync`；dev 模式默认拉开发树，
 *          --installed 拉安装版。铁律 3：单 GUI 串行，不与其它探针并行。）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r3-doc');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;
const S = hi.SURFACE;

// ─── 文档（全部现场生成；外部改动锚一律 ASCII 令牌，方便子进程替换） ──────────
const DOC_F1 = (() => {
  const parts = ['# R3DOC F1 外部静默重载保光标', '',
    'F1首段ZZONE收尾：外部进程只动这一处（等长换字），其余一字不动。', ''];
  for (let i = 1; i <= 70; i++) {
    parts.push('F1段落' + String(i).padStart(2, '0') + '：常态正文若干，把文档撑到必须滚动。'
      + (i === 35 ? 'F1锚点词就在这一段中部。' : ''));
    parts.push('');
  }
  return parts.join('\n');
})();
const DOC_F2 = ['# R3DOC F2 失联可见', '', 'F2段落：外部删除整份文件，看状态栏与 Ctrl+S。', ''].join('\n');
const DOC_F3 = ['# R3DOC F3 失败重试', '', 'F3段落：在这里打一个字弄脏文档。', ''].join('\n');
const DOC_F4 = ['# R3DOC F4 外部还原清闩锁', '', 'F4段落：打字点。', '', 'F4KEEP 外部改动锚：外部先改这里，再原样还原。', ''].join('\n');
const DOC_F5 = ['# R3DOC F5 关快照措辞', '', 'F5段落：打字点。', '', 'F5KEEP 外部改动锚。', ''].join('\n');
const DOC_F6 = ['# R3DOC F6 手动保存落穿', '', 'F6段落：打字点。', ''].join('\n');

// ─── 页内工具（装进编辑器 iframe；口径与产品 source-text.js 的"可编辑文本"一致） ──
//  注意：本模板串内不出现 "${" 与反引号；正则/换行反斜杠双写（模板层吃一层）。
const HELPERS = `window.__r3doc = (() => {
  const surface = () => document.querySelector('.vditor-ir .vditor-reset');
  // 与产品 source-text.js 同一套线性"可编辑文本"模型：跳过预览/生成节点，块尾补 \\n。
  // 修复（渲染层 setValue 还原）用的也是这一口径，探针读数与修复坐标系一致。
  const srcModel = root => {
    let text = ''; const spans = [];
    const visit = node => {
      if (node.nodeType === 3) { spans.push({ node, start: text.length, end: text.length + node.length }); text += node.data; return; }
      if (node.nodeType !== 1 || node.matches('.vditor-ir__preview,.vditor-wysiwyg__preview,script,style,wbr,[data-type="toc-block"]')) return;
      for (const child of node.childNodes) visit(child);
      if (node !== root && /^(P|H[1-6]|LI|TR|BLOCKQUOTE)$/.test(node.tagName)) text += '\\n';
    };
    visit(root);
    const offset = (node, at) => { const hit = spans.find(item => item.node === node); return hit ? hit.start + Math.min(at, node.length) : null; };
    return { text, spans, offset };
  };
  const caretInfo = () => {
    const root = surface(); const s = getSelection();
    if (!root || !s || !s.rangeCount || !root.contains(s.focusNode)) return { ok: false, 原因: '焦点不在编辑面' };
    const model = srcModel(root);
    const off = model.offset(s.focusNode, s.focusOffset);
    let top = s.focusNode;
    while (top && top.parentElement && top.parentElement !== root) top = top.parentElement;
    let rect = null;
    try { const probe = document.createRange(); probe.setStart(s.focusNode, s.focusOffset); probe.collapse(true); rect = probe.getBoundingClientRect(); } catch (e) {}
    return { ok: off != null, off,
      块: top && top.parentElement === root ? [...root.children].indexOf(top) : -1,
      前缀: s.focusNode.nodeType === 3 ? s.focusNode.data.slice(Math.max(0, s.focusOffset - 16), s.focusOffset) : '',
      折叠: s.isCollapsed, hasFocus: document.hasFocus(),
      scrollTop: Math.round(root.scrollTop), scrollHeight: Math.round(root.scrollHeight),
      x: rect ? Math.round(rect.left) : null, y: rect ? Math.round(rect.top) : null, h: rect ? Math.round(rect.height) : null };
  };
  const 词点 = word => {
    const root = surface(); if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
    while (node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest('.vditor-ir__preview')) continue;
      const at = node.data.indexOf(word);
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      if (box.width) return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    }
    return null;
  };
  const 滚到词 = word => {
    const root = surface(); if (!root) return false;
    for (const block of root.children) if (String(block.textContent || '').includes(word)) {
      block.scrollIntoView({ block: 'center', behavior: 'instant' }); return true;
    }
    return false;
  };
  const contains = text => { const root = surface(); return !!(root && root.textContent.includes(text)); };
  const mark = list => {
    const old = document.getElementById('__r3doc_marks'); if (old) old.remove();
    if (!list || !list.length) return 0;
    const layer = document.createElement('div'); layer.id = '__r3doc_marks';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    let drawn = 0;
    for (const item of list) {
      if (!item) continue;
      const line = document.createElement('div');
      line.style.cssText = 'position:fixed;pointer-events:none;'
        + 'left:' + Math.round(item.x) + 'px;top:' + Math.round(item.y) + 'px;'
        + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + Math.max(2, item.h || 18) + 'px;'
        + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
        + 'background:' + (item.dash ? 'none' : item.color) + ';';
      layer.appendChild(line); drawn += 1;
      if (item.label) {
        const tag = document.createElement('div'); tag.textContent = item.label;
        tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
          + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
        layer.appendChild(tag);
      }
    }
    document.body.appendChild(layer); return drawn;
  };
  const unmark = () => { const old = document.getElementById('__r3doc_marks'); if (old) old.remove(); return 1; };
  return { caretInfo, 词点, 滚到词, contains, mark, unmark };
})();`;

// 注入与求值（字符串拼接而非反引号插值：HELPERS/expression 不进 validate-probe-expr 的
// 模板审计域也能完整构造；frameOf 保持可审计的纯 IIFE 模板）。
const INSTALL = "(() => { const w = " + IF + ";"
  + " if (!w || !w.document.querySelector(" + JSON.stringify(S) + ")) return { ok: false };"
  + " if (!w.__r3doc) w.eval(" + JSON.stringify(HELPERS) + ");"
  + " return { ok: !!w.__r3doc }; })()";
const IN = expression => "(() => { const w = " + IF + "; return w.eval(" + JSON.stringify(expression) + "); })()";
const ev = (session, expression) => session.js(IN(expression));
const frameOf = session => session.js(`(() => { const f = document.getElementById('editor');
  const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`);
const focusOK = async session => (await hi.ensureFocus(session)).ok;

// ─── 主进程侧读数与注入（--inspect 调试器；单引号字符串，不进模板审计域） ─────────
const MAIN_DOC_STATE = '(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
  + ' const d = rec && rec.doc, c = d && d.current;'
  + ' return JSON.stringify({ has: !!c, file: (c && c.file) || null, dirty: !!(c && c.dirty), deleted: !!(c && c.deleted),'
  + ' externalConflict: !!(c && c.externalConflict), saveError: (c && c.saveError) || null,'
  + ' autoSaveTimer: !!(d && d._autoSaveTimer), retryTimer: !!(d && d._retryTimer), inFlight: !!(c && c.savePromise) }); })()';
const docState = async session => JSON.parse(await session.main.js(MAIN_DOC_STATE));
/** F3' 注入：目标文件的 rename 一律抛 EBUSY（网盘占用形态；atomicWrite 内部重试 5 次
 *  后把错误上抛，触发的是真实 writeCurrent 失败路径）。global.__r3busy=false 即解除。 */
const MAIN_BUSY_STUB = file => '(() => { const fsp = require("node:fs/promises");'
  + ' try {'
  + ' if (!global.__r3origRename) { global.__r3origRename = fsp.rename;'
  + ' global.__r3busyFile = ' + JSON.stringify(String(file).toLowerCase()) + ';'
  + ' fsp.rename = async (from, to, ...rest) => {'
  + ' if (global.__r3busy && String(to).toLowerCase() === global.__r3busyFile)'
  + ' { const e = new Error("注入：模拟网盘占用替换失败"); e.code = "EBUSY"; throw e; }'
  + ' return global.__r3origRename.call(fsp, from, to, ...rest); }; }'
  + ' global.__r3busy = true;'
  + ' return { stubbed: typeof fsp.rename === "function" };'
  + ' } catch (error) { return { stubbed: false, err: String(error && error.message || error) }; } })()';
/** F6' 注入：伪造一个"失败中的在途保存"（F6' 前置态），收尾与 save() 的 finally 同款
 *  （结算后清掉 savePromise）；随后的手动保存是 100% 真实代码路径。 */
const MAIN_F6_INJECT = '(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
  + ' const cur = rec.doc.current;'
  + ' if (!cur || !cur.dirty) return JSON.stringify({ ok: false, why: "未处于脏态" });'
  + ' const operation = (async () => { await new Promise(r => setTimeout(r, 350));'
  + ' cur.saveError = "注入：在途保存失败（模拟占用）"; return false; })();'
  + ' cur.savePromise = operation;'
  + ' (async () => { try { await operation; } finally { if (cur.savePromise === operation) cur.savePromise = null; } })();'
  + ' global.__r3manual = rec.doc.save();'
  + ' return JSON.stringify({ ok: true }); })()';

// ─── 外部进程证人（独立 node 子进程；参数全 ASCII） ─────────────────────────────
const EXT_REPLACE = 'const fs=require("fs");const f=process.argv[1],from=process.argv[2],to=process.argv[3];'
  + 'const s=fs.readFileSync(f,"utf8");if(!s.includes(from)){console.error("token missing");process.exit(2)}'
  + 'fs.writeFileSync(f,s.replace(from,to));';
const EXT_RESTORE = 'const fs=require("fs");fs.copyFileSync(process.argv[1],process.argv[2]);';
const EXT_UNLINK = 'const fs=require("fs");fs.unlinkSync(process.argv[1]);';
const spawnExt = (script, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', part => { err += part; });
  child.on('error', reject);
  child.on('exit', code => (code === 0 ? resolve(true)
    : reject(new Error('外部进程 exit ' + code + (err ? '：' + err.slice(0, 200) : '')))));
});
const extReplace = (file, from, to) => spawnExt(EXT_REPLACE, [file, from, to]);
const extRestore = (from, to) => spawnExt(EXT_RESTORE, [from, to]);
const extUnlink = file => spawnExt(EXT_UNLINK, [file]);

// ─── 通用小件 ───────────────────────────────────────────────────────────────────
const readDisk = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
async function poll(fn, { timeout = 6000, interval = 150 } = {}) {
  const stop = Date.now() + timeout;
  let last = null;
  while (Date.now() < stop) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await harness.sleep(interval);
  }
  return null;
}
/** 状态栏读数（顶层页 DOM：保存格 + 常驻提示条）。 */
const statusBar = session => session.js('(() => { const text = document.querySelector("#sb-save-text"),'
  + ' cell = document.querySelector("#st-save"), box = document.querySelector("#sb-save");'
  + ' return { 提示: text ? String(text.textContent) : null, 保存格: cell ? String(cell.textContent).trim() : null,'
  + ' 提示可见: !!(box && !box.hidden) }; })()');
/** 整页 + 关键处 2x 放大截图（anchor/marks 为 iframe 内坐标，clip 加 iframe 偏移）。 */
async function shots(session, frame, name, anchor, marks) {
  try {
    const clip = { x: frame.x + Math.max(0, (anchor && anchor.x || 300) - 240),
      y: frame.y + Math.max(0, (anchor && anchor.y || 300) - 55), width: 560, height: 165, scale: 2 };
    if (marks && marks.length) await ev(session, 'window.__r3doc.mark(' + JSON.stringify(marks) + ')');
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    await ev(session, 'window.__r3doc.unmark()');
    await session.shot(name + '-full');
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 120) + '）'); }
}
/** 状态栏区 2x 截图（F2'/F3' 的"用户看得见"证据）。 */
async function barShot(session, name) {
  try {
    const size = await session.js('({ w: innerWidth, h: innerHeight })');
    const clip = { x: 0, y: Math.max(0, size.h - 110), width: Math.min(1000, size.w), height: 110, scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '-bar-2x.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { console.log('  （状态栏截图失败 ' + name + '）'); }
}
/** 在指定前缀后用真实输入打一个字并弄脏文档。 */
async function typeAt(session, prefix, ch) {
  const placed = await session.js(hi.placeAfterPrefix(prefix));
  if (!placed || !placed.ok) throw new Error('定位失败：' + JSON.stringify(placed));
  await session.type(ch);
  await harness.sleep(350);
  return placed;
}

// ─── 用例 ───────────────────────────────────────────────────────────────────────

/** F1'：打开 → 中部真实点击放光标 → 外部进程改一字（等长）→ 等 watcher 静默重载 →
 *  断言光标（源码偏移 + 前缀）与滚动保持。 */
async function caseF1(session, env) {
  const frame = await frameOf(session);
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  if (!(await ev(session, 'window.__r3doc.滚到词("F1锚点词")'))) return { verdict: 'FAIL', detail: { 阶段: '没找到中部锚点词' } };
  await harness.sleep(150);
  const 点 = await ev(session, 'window.__r3doc.词点("F1锚点词")');
  if (!点 || !点.x) return { verdict: 'FAIL', detail: { 阶段: '没取到击点几何', 点 } };
  await session.click(frame.x + 点.x, frame.y + 点.y);            // 真实点击放光标
  await harness.sleep(320);
  const before = await ev(session, 'window.__r3doc.caretInfo()');
  if (!before || !before.ok) return { verdict: 'FAIL', detail: { 阶段: '点击后没读到光标', before } };
  if (!(before.scrollTop > 50)) return { verdict: 'FAIL', detail: { 阶段: '文档没有滚起来（滚动保持断言无意义）', before } };
  await shots(session, frame, 'F1-点击后', before,
    [{ x: before.x, y: before.y, h: before.h, color: '#ff2d2d', label: '光标' },
     { x: 点.x, y: 点.y, h: 20, dash: true, color: '#25d0ff', label: '击点' }]);
  await extReplace(env.file, 'ZZONE', 'ZZTWO');                   // 独立进程外部修改（等长替换）
  const seen = await poll(() => ev(session, 'window.__r3doc.contains("ZZTWO")'), { timeout: 8000, interval: 150 });
  if (!seen) return { verdict: 'FAIL', detail: { 阶段: 'watcher 静默重载没到（iframe 里没出现 ZZTWO）', before } };
  await harness.sleep(900);                                       // 等渲染层还原脉冲（0/200ms）落定
  const after = await ev(session, 'window.__r3doc.caretInfo()');
  const 磁盘含改动 = (readDisk(env.file) || '').includes('ZZTWO');
  await shots(session, frame, 'F1-重载后', after && after.ok ? after : { x: 300, y: 300 },
    (after && after.ok ? [{ x: after.x, y: after.y, h: after.h, color: '#ff2d2d', label: '光标(后)' }] : [])
      .concat([{ x: before.x, y: before.y, h: before.h, dash: true, color: '#f0a020', label: '期望位(前)' }]));
  const 滚动差 = after ? Math.abs(after.scrollTop - before.scrollTop) : 9999;
  const pass = !!(after && after.ok && after.off === before.off && after.前缀 === before.前缀
    && 滚动差 <= 2 && after.hasFocus && 磁盘含改动);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    前: before, 后: after, 滚动差, 磁盘含改动,
    红条件: '旧实现 setValue 后光标偏移归 0/取不到、scrollTop 归 0（前缀与偏移对不上即红）',
    判据: '光标源码偏移相等 + 前缀相等 + |ΔscrollTop|≤2 + 焦点仍在编辑面' } };
}

/** F2'：外部删除 → 状态栏必须亮"不在原位置"类提示；随后 Ctrl+S 必须弹确认且取消后
 *  **不**在原位置静默重建。 */
async function caseF2(session, env) {
  await extUnlink(env.file);                                      // 独立进程 fs.unlinkSync
  const bar = await poll(async () => {
    const st = await statusBar(session);
    return st && st.提示 && st.提示.includes('不在原位置') ? st : null;
  }, { timeout: 6000, interval: 180 });
  const state = await docState(session);
  await session.shot('F2-失联-full');
  await barShot(session, 'F2-失联');
  if (!bar) return { verdict: 'FAIL', detail: { 阶段: '状态栏没亮失联提示', 状态栏: await statusBar(session), 主进程: state } };
  await session.main.clearCalls();
  await session.main.script([{ dialog: 'message', response: 1 }]);  // 用户在确认框上选"取消"
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1200);
  const calls = await session.main.calls();
  const confirm = (calls || []).find(c => c.kind === 'message' && c.options && c.options.title === '文件不在原位置');
  const 仍不存在 = !fs.existsSync(env.file);
  const state2 = await docState(session);
  await session.shot('F2-CtrlS取消后-full');
  const pass = !!(confirm && 仍不存在);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    状态栏: bar, 主进程_失联时: state, 重建确认框: confirm ? {
      title: confirm.options.title, message: confirm.options.message,
      detail: String(confirm.options.detail || '').slice(0, 160), buttons: confirm.options.buttons } : null,
    文件仍不存在: 仍不存在, 主进程_CtrlS后: state2,
    红条件: '旧实现状态栏零反馈（无提示文案即红）；Ctrl+S 静默重建（文件重新出现且无确认框记录即红）' } };
}

/** F3'：注入 EBUSY 占用 → 自动保存真实失败 → 断言排上 10s 退避重试且故障解除后重试
 *  真把脏内容落盘。注入不可行则如实 EVIDENCE。 */
async function caseF3(session, env) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  const stub = await session.main.js(MAIN_BUSY_STUB(env.file));
  if (!stub || !stub.stubbed) {
    return { verdict: 'EVIDENCE', detail: { 通道限制: 'fs/promises.rename 无法在主进程内替换（注入失败），EBUSY 失败路径无法端到端模拟', stub,
      代码级佐证: "scheduleSaveRetry 已在 writeCurrent 失败路径挂接（见 doc.js 修改清单 F3'）" } };
  }
  await typeAt(session, 'F3段落', '庚');
  const mid = await poll(async () => (await docState(session)).saveError ? docState(session) : null,
    { timeout: 9000, interval: 200 });
  if (!mid) return { verdict: 'FAIL', detail: { 阶段: '自动保存没有失败（saveError 一直为空）', stub } };
  const bar = await statusBar(session);
  await session.shot('F3-失败时-full');
  await barShot(session, 'F3-失败时');
  await session.main.js('global.__r3busy = false');                // 故障解除（网盘释放）
  const landed = await poll(() => (readDisk(env.file) || '').includes('庚') ? true : null,
    { timeout: 16000, interval: 250 });
  const end = await docState(session);
  await session.shot('F3-重试落盘后-full');
  const pass = !!(mid.retryTimer && landed && !end.saveError && !end.dirty);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    失败时: { saveError: String(mid.saveError).slice(0, 140), retryTimer: mid.retryTimer, dirty: mid.dirty },
    状态栏_失败时: bar,
    重试落盘: !!landed, 最终: end,
    注入通道: '主进程调试器替换 fs/promises.rename → 对目标文件抛 EBUSY（触发真实 atomicWrite→writeCurrent 失败路径）',
    红条件: '注掉 doc.js 失败路径的 scheduleSaveRetry 后 retryTimer 恒 false、16s 内磁盘无 庚 → FAIL' } };
}

/** F4'：外部改一字（脏态下闩上 externalConflict）→ 打开自动保存被闩住（前置证明）→
 *  外部原样还原 → 闩锁必须解开、自动保存恢复排程并把脏内容写掉。 */
async function caseF4(session, env) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  await session.main.js('(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
    + ' rec.doc.setSetting("autoSave", false); return true; })()');   // 排掉 1.5s 自动保存的时序竞态
  await typeAt(session, 'F4段落', '辛');
  await extReplace(env.file, 'F4KEEP', 'F4GONE');
  const latched = await poll(async () => (await docState(session)).externalConflict ? docState(session) : null,
    { timeout: 6000, interval: 180 });
  if (!latched) return { verdict: 'FAIL', detail: { 阶段: '外部修改没闩上 externalConflict', 主进程: await docState(session) } };
  await session.main.js('(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
    + ' rec.doc.setSetting("autoSave", true); return true; })()');
  const 闩住证明 = await docState(session);                       // 自动保存已开却被闩住：不排程
  await extRestore(env.orig, env.file);                           // 外部原样还原（等价 git checkout）
  const cleared = await poll(async () => {
    const st = await docState(session);
    return st && !st.externalConflict && !st.saveError ? st : null;
  }, { timeout: 6000, interval: 180 });
  const 恢复排程 = cleared ? (cleared.autoSaveTimer || !cleared.dirty) : false;
  const landed = await poll(() => (readDisk(env.file) || '').includes('辛') ? true : null,
    { timeout: 6000, interval: 250 });
  const end = await docState(session);
  await session.shot('F4-还原后-full');
  const pass = !!(cleared && 恢复排程 && landed && !end.saveError);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    闩上时: latched, 开自动保存仍被闩住: { autoSaveTimer: 闩住证明.autoSaveTimer, externalConflict: 闩住证明.externalConflict },
    还原后: cleared, 恢复排程, 脏内容落盘: !!landed, 最终: end,
    红条件: '注掉 doc.js savedDisk 早退分支的清闩锁后 externalConflict 恒 true、磁盘无 辛 → FAIL' } };
}

/** F5'：关本地快照 + 脏态 + 外部修改 → Ctrl+S 的冲突覆盖对话框措辞不得承诺版本历史。 */
async function caseF5(session, env) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  await session.main.js('(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
    + ' rec.doc.setSetting("autoSave", false); rec.doc.setSetting("snapshots", false); return true; })()');
  await typeAt(session, 'F5段落', '壬');
  await extReplace(env.file, 'F5KEEP', 'F5GONE');
  const latched = await poll(async () => (await docState(session)).externalConflict ? docState(session) : null,
    { timeout: 6000, interval: 180 });
  if (!latched) return { verdict: 'FAIL', detail: { 阶段: '外部修改没闩上 externalConflict', 主进程: await docState(session) } };
  await session.main.clearCalls();
  await session.main.script([{ dialog: 'message', response: 1 }]);  // 用户选"取消"（不覆盖）
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1200);
  const calls = await session.main.calls();
  const dialog = (calls || []).find(c => c.kind === 'message' && c.options && c.options.title === '文件已被外部修改');
  await session.shot('F5-冲突取消后-full');
  const detail = dialog ? String(dialog.options.detail || '') : '';
  const 磁盘未覆盖 = (readDisk(env.file) || '').includes('F5GONE') && !(readDisk(env.file) || '').includes('壬');
  const pass = !!(dialog && !detail.includes('版本历史') && detail.includes('快照已关闭') && detail.includes('无法找回') && 磁盘未覆盖);
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    冲突框: dialog ? { title: dialog.options.title, detail: detail.slice(0, 200), buttons: dialog.options.buttons } : null,
    磁盘未覆盖,
    红条件: '恢复无条件措辞后 detail 含「从版本历史恢复为副本」且无快照关闭警告 → FAIL（关快照时承诺了不存在的历史）' } };
}

/** F6'：伪造"失败中的在途保存"（F6' 前置态）→ 手动保存必须落穿继续本次写并成功落盘。 */
async function caseF6(session, env) {
  if (!(await focusOK(session))) return { verdict: 'FAIL', detail: { 阶段: '焦点不在编辑器' } };
  await session.main.js('(() => { const rec = global.windows.find(r => r.win && !r.win.isDestroyed());'
    + ' rec.doc.setSetting("autoSave", false); return true; })()');   // 排掉自动保存抢跑
  await typeAt(session, 'F6段落', '癸');
  const injected = JSON.parse(await session.main.js(MAIN_F6_INJECT));
  if (!injected.ok) return { verdict: 'FAIL', detail: { 阶段: '在途失败注入未成立', injected } };
  const manualOk = await session.main.js('global.__r3manual');     // awaitPromise：等手动保存结算
  const 磁盘含癸 = (readDisk(env.file) || '').includes('癸');
  const end = await docState(session);
  await session.shot('F6-落穿保存后-full');
  const pass = manualOk === true && 磁盘含癸 && !end.saveError && !end.dirty;
  return { verdict: pass ? 'PASS' : 'FAIL', detail: {
    手动保存返回: manualOk, 磁盘含癸, 最终: end,
    注入通道: '主进程内伪造失败中的在途 savePromise（350ms 后返回 false 并落 saveError）；落穿后的写盘 100% 走真实 writeCurrent',
    红条件: '恢复 save() 首行的 if(!ok||this.current!==cur)return ok 后手动保存返回 false、磁盘无 癸 → FAIL' } };
}

// ─── 装配 ───────────────────────────────────────────────────────────────────────

const GROUPS = [
  { doc: 'r3doc-f1.md', content: DOC_F1, open: { minBlocks: 8, settleMs: 1800, timeout: 200000 },
    cases: [['F1静默重载保光标', caseF1]] },
  { doc: 'r3doc-f2.md', content: DOC_F2, cases: [['F2失联提示与重建确认', caseF2]] },
  { doc: 'r3doc-f3.md', content: DOC_F3, cases: [['F3失败后10s重试', caseF3]] },
  { doc: 'r3doc-f4.md', content: DOC_F4, orig: true, cases: [['F4外部还原清闩锁', caseF4]] },
  { doc: 'r3doc-f5.md', content: DOC_F5, cases: [['F5关快照冲突措辞', caseF5]] },
  { doc: 'r3doc-f6.md', content: DOC_F6, cases: [['F6手动保存落穿', caseF6]] },
];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name.toLowerCase()) || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R3DOC ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line);
    log.push(line);
  };
  console.log((DEV ? '开发树模式（electron + app/main/main.js）' : '已安装产物模式') + '：' + EXE);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r3-doc', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let passed = 0, failed = 0, evidenced = 0;
  try {
    for (const group of GROUPS) {
      const todo = group.cases.filter(([name]) => want(name));
      if (!todo.length) continue;
      const file = path.join(OUT, group.doc);
      fs.writeFileSync(file, group.content, 'utf8');
      const env = { file, orig: group.orig ? path.join(OUT, group.doc.replace(/\.md$/, '.orig.md')) : null };
      if (group.orig) fs.writeFileSync(env.orig, group.content, 'utf8');   // F4' 外部还原用的原始副本
      console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      const openOpts = group.open || { minBlocks: 3, settleMs: 1600, timeout: 200000 };
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { ...openOpts, inspect: true });   // 每用例独立实例
        const installed = await session.js(INSTALL);
        if (!installed || !installed.ok) throw new Error('页内工具装载失败：' + JSON.stringify(installed));
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session, env) || {};
            report(name, outcome.verdict || 'FAIL', outcome.detail || {});
            if (outcome.verdict === 'PASS') passed += 1;
            else if (outcome.verdict === 'EVIDENCE') evidenced += 1;
            else failed += 1;
          } catch (error) {
            report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) });
            failed += 1;
          }
        }
      } catch (error) {
        console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
        for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); failed += 1; }
      } finally {
        if (session) await ctx.release(session);     // 释放实例（单 GUI 串行，端口让出来再开下一组）
      }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + passed + ' / FAIL ' + failed + ' / EVIDENCE ' + evidenced + ' ===');
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '；截图：' + OUT + '）');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('probe-r3-doc 失败：', error); process.exit(1); });
