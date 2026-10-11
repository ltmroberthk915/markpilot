/** 探针 · 第 1 轮判决"通过"项 D1/D2/D8/D4 的实机验收 + 存疑项 D7 取证（2026-10-02）。
 *
 *  判决来源：E:/MarkPilot/.zcode-tmp/round1-verdicts.md（D1、D2+D8、D4 为通过项；D7 存疑取证）。
 *  被测对象：Typora-Editor/extension-src/render/js/media-tools.js 的四条修改。
 *  **跑前先 `npm run sync`**（extension-src → 开发树 app/renderer/js），本探针按 harness
 *  dev 模式拉起开发树；--installed 则拉起安装版 EXE。
 *
 *  用例与红条件：
 *    D1 一段两张 md 图 `![a](x.png) ![b](y.png)`，Ctrl+点选两张 → 真实 Backspace
 *       PASS：两张全删、无错误 toast、编辑区保有焦点（Ctrl+多选焦点保留契约）
 *       红（旧代码）：只删掉一张 + toast「请在编辑区选择图片后重试」
 *    D2 断链 md 图（src 指向不存在的文件）右键 → 居中对齐
 *       PASS：toast 报「图片尚未加载完成」且源码一字不改
 *       红（旧代码）：无 toast、源码被改写进 width="1"
 *    D8 断链 HTML 图（带 width 属性）右键 → 图片设置…
 *       PASS：缩放输入框初值 100
 *       红（旧代码）：(width||0)/0 → Infinity → number 输入框显示为空
 *    D4 裸 HTML `<img src=…>` 块右侧空白按下 → 拖到下段文字松手 → insertText 替换
 *       PASS：selection 不含 '<img' 字样，替换后图片仍在、文字落在图片之后
 *       红（旧代码）：选区锚点在隐藏源码里，替换把图片源码一起吃掉
 *    D7 `![](file:///…?a=1&b=2)` 的图缩放 50% 应用
 *       EVIDENCE：光标落点 offset 与图片源码区间（只取证，不判 PASS/FAIL）
 *
 *  输出：每用例一行 `R1MEDIA <名> PASS/FAIL/EVIDENCE <JSON>`；整页 + 图片/光标附近
 *  2x 局部截图存 .perf/probe-r1-media/；素材（小图、md）全部现场生成，不碰受保护素材。
 *
 *  用法：node scripts/acceptance/probe-r1-media.cjs [--installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r1-media');
const IF = hi.IF;
const S = hi.SURFACE;
const FRAME = `document.getElementById('editor').getBoundingClientRect()`;

// D7 的 file:/// 图必须指向真实存在的小图（缩放守卫要求 naturalWidth>0），带 ?a=1&b=2 查询串
const D7_FILE = path.join(OUT, 'shot-d7.png').replace(/\\/g, '/');

const BODY = [
  '# R1 媒体修复验收',
  '',
  '前文一段，用来垫在第一张图之前。',
  '',
  '![断链](missing-d2.png)',
  '',
  '<img src="missing-d8.png" width="300" height="60">',
  '',
  '![](file:///' + D7_FILE + '?a=1&b=2)',
  '',
  '<img src="shot-red.png" width="140">',
  '',
  '下段文字甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥，这是用来承接空白带拖选替换的一段话。',
  '',
  '![a](x.png) ![b](y.png)',
  '',
  '后文一段，验收收尾。',
  '',
].join('\n');

// ─── 页内读数（全部走 iframe 真实 DOM，不做任何产品内状态注入） ─────────────────
/** 图片几何：按 alt / src 子串找图，滚到视口中间，给出页面坐标盒 + 所在节点类型。 */
const GEOM = which => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const imgs=[...d.querySelectorAll('${S} img')];
  const img=(${which})(imgs);
  if(!img)return {ok:false,共:imgs.length};
  img.scrollIntoView({block:'center',behavior:'instant'});
  const r=img.getBoundingClientRect();
  const owner=img.closest('.vditor-ir__node[data-type]');
  const or=owner?owner.getBoundingClientRect():r;
  let block=img;const s=d.querySelector('${S}');while(block.parentElement&&block.parentElement!==s)block=block.parentElement;
  const br=block.getBoundingClientRect();
  return {ok:true,nat:img.naturalWidth,alt:img.getAttribute('alt'),src:(img.getAttribute('src')||'').slice(0,90),
    类:owner?owner.getAttribute('data-type'):null,
    图:{l:Math.round(fr.x+r.left),t:Math.round(fr.y+r.top),r:Math.round(fr.x+r.right),b:Math.round(fr.y+r.bottom),w:Math.round(r.width),h:Math.round(r.height)},
    节:{l:Math.round(fr.x+or.left),t:Math.round(fr.y+or.top),r:Math.round(fr.x+or.right),b:Math.round(fr.y+or.bottom)},
    块右:Math.round(fr.x+br.right)}; })()`;
const byAlt = a => `imgs=>imgs.find(n=>(n.getAttribute('alt')||'')==='${a}')`;
const bySrc = part => `imgs=>imgs.find(n=>(n.getAttribute('src')||'').includes('${part}'))`;

const TOAST = `(() => { const w=${IF},d=w.document;const t=d.querySelector('.typora-context-toast');
  return t?{有:true,文:t.textContent}:{有:false}; })()`;

/** 元素中心点（页面坐标）：右键菜单按钮 / 对话框按钮 / 输入框都用它来真实点击。 */
const POINT = selector => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const el=d.querySelector(${JSON.stringify(selector)});
  if(!el)return null;const r=el.getBoundingClientRect();
  return {x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2),文:(el.textContent||'').trim().slice(0,16)}; })()`;

const DIALOG = `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const dlg=d.getElementById('typora-image-settings');
  if(!dlg)return {开:false};
  const r=dlg.getBoundingClientRect();
  return {开:true,值:dlg.querySelector('input[name="scale"]').value,错:(dlg.querySelector('.media-error')||{}).textContent||'',
    盒:{x:Math.round(fr.x+r.left),y:Math.round(fr.y+r.top),w:Math.round(r.width),h:Math.round(r.height)}}; })()`;

const SEL = `(() => { const w=${IF};const s=w.getSelection();
  if(!s||!s.rangeCount)return {无:true};
  const txt=s.toString();
  const lay=node=>{const el=node?(node.nodeType===3?node.parentElement:node):null;
    return el?(el.closest('code,[class*="vditor-ir__marker"]')?'源码':el.closest('.vditor-ir__preview')?'预览':'正文'):'?';};
  return {文本:txt.slice(0,180),长:txt.length,含img:txt.includes('<img'),折叠:s.isCollapsed,
    锚层:lay(s.anchorNode),焦层:lay(s.focusNode)}; })()`;

const AB_STATE = `(() => { const w=${IF},d=w.document;
  const imgs=[...d.querySelectorAll('${S} img')];
  return {剩余ab:imgs.filter(n=>['a','b'].includes(n.getAttribute('alt')||'')).length,
    多选数:imgs.filter(n=>n.classList.contains('typora-img-multi-selected')).length}; })()`;

const SCROLL = `(() => { const w=${IF},d=w.document;const s=d.querySelector('${S}');return s?Math.round(s.scrollTop):null; })()`;

/** D4 专用：图与"下段文字"一次取齐（只滚一次，坐标才互相一致）。 */
const D4_PICK = `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const img=[...d.querySelectorAll('${S} img')].find(n=>(n.getAttribute('src')||'').includes('shot-red'));
  if(!img)return {ok:false,无图:true};
  let block=img;const s=d.querySelector('${S}');while(block.parentElement&&block.parentElement!==s)block=block.parentElement;
  block.scrollIntoView({block:'center',behavior:'instant'});
  const t=[...d.querySelectorAll('${S} p')].find(p=>p.textContent.includes('下段文字'));
  if(!t)return {ok:false,无段落:true};
  const r=img.getBoundingClientRect(),br=block.getBoundingClientRect(),tr=t.getBoundingClientRect();
  return {ok:true,类:block.getAttribute('data-type'),
    图:{l:Math.round(fr.x+r.left),t:Math.round(fr.y+r.top),r:Math.round(fr.x+r.right),b:Math.round(fr.y+r.bottom)},
    块右:Math.round(fr.x+br.right),
    至:{x:Math.round(fr.x+tr.left+110),y:Math.round(fr.y+tr.top+Math.max(10,Math.round(tr.height/2)))}}; })()`;

// ─── 真实输入原语（CDP Input 通道） ────────────────────────────────────────────
async function clickAt(session, x, y, options = {}) {
  const modifiers = options.modifiers || 0;
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
}
async function rightClick(session, x, y) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
/** 整页截图之外补一张"图片/光标附近 2x 局部"（截图证据规则第 2 条）。 */
async function shot2x(session, name, box) {
  try {
    const clip = { x: Math.max(0, Math.round(box.x - 40)), y: Math.max(0, Math.round(box.y - 30)),
      width: Math.max(120, Math.min(Math.round(box.w + 80), 1500)),
      height: Math.max(80, Math.min(Math.round(box.h + 60), 900)), scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { console.log('截图失败(' + name + ')：' + error.message); }
}
const boxOf = (g, key) => ({ x: g[key].l, y: g[key].t, w: g[key].r - g[key].l, h: g[key].b - g[key].t });
/** 点图（或图所在节点）中心：断链图盒可能只有几个像素，优先用可见盒、退化用节点盒。 */
function centerOf(g) {
  const use = (g.图.w >= 4 && g.图.h >= 4) ? g.图 : g.节;
  return { x: Math.round((use.l + use.r) / 2), y: Math.round((use.t + use.b) / 2), 用节点: use === g.节 };
}

// ─── 用例 ──────────────────────────────────────────────────────────────────────
/** D2：断链 md 图右键 → 居中对齐。绿：toast 报未加载 + 源码不变；红：写入 width="1"。 */
async function caseD2(session, say) {
  const g = await session.js(GEOM(byAlt('断链')));
  if (!g.ok) { say('R1MEDIA D2断链对齐 FAIL ' + JSON.stringify({ 阶段: '没找到断链图' })); return; }
  const before = String(await hi.mdNow(session));
  const at = centerOf(g);
  await rightClick(session, at.x, at.y);
  await harness.sleep(320);
  const btn = await session.js(POINT('#typora-editor-context-menu [data-action="image-align-center"]'));
  if (!btn) { say('R1MEDIA D2断链对齐 FAIL ' + JSON.stringify({ 阶段: '右键菜单没出现', 断图: { nat: g.nat, alt: g.alt } })); return; }
  await clickAt(session, btn.x, btn.y);
  await harness.sleep(380);
  const toast = await session.js(TOAST);
  const after = String(await hi.mdNow(session));
  await session.shot('D2断链对齐-整页');
  const w1 = after.includes('width="1"');
  const pass = !!toast.有 && /尚未加载/.test(toast.文) && after === before && !w1;
  say(`R1MEDIA D2断链对齐 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    断图: { naturalWidth: g.nat, alt: g.alt, 类: g.类 }, 点击的菜单项: btn.文,
    toast, 源码一字未改: after === before, 写入width1: w1 }));
}

/** D8：断链 HTML 图（带 width=300）右键 → 图片设置…。绿：初值 100；红：Infinity→空。 */
async function caseD8(session, say) {
  const g = await session.js(GEOM(bySrc('missing-d8')));
  if (!g.ok) { say('R1MEDIA D8对话框初值 FAIL ' + JSON.stringify({ 阶段: '没找到断链 HTML 图' })); return; }
  const at = centerOf(g);
  await rightClick(session, at.x, at.y);
  await harness.sleep(320);
  const btn = await session.js(POINT('#typora-editor-context-menu [data-action="image-settings"]'));
  if (!btn) { say('R1MEDIA D8对话框初值 FAIL ' + JSON.stringify({ 阶段: '右键菜单没出现', 断图: { nat: g.nat, 类: g.类 } })); return; }
  await clickAt(session, btn.x, btn.y);
  await harness.sleep(450);
  const dlg = await session.js(DIALOG);
  if (dlg.开) await shot2x(session, 'D8对话框-2x', dlg.盒);
  const pass = !!dlg.开 && dlg.值 === '100';
  say(`R1MEDIA D8对话框初值 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    断图: { naturalWidth: g.nat, 类: g.类, 盒宽: g.图.w }, 对话框开着: !!dlg.开, 初值: dlg.值, 空: dlg.值 === '' }));
  const close = await session.js(POINT('#typora-image-settings [data-close]'));
  if (close) { await clickAt(session, close.x, close.y); await harness.sleep(260); }
}

/** D7（存疑取证）：file:///…?a=1&b=2 的图缩放 50% 应用 → 光标落点 + 图片源码区间。 */
async function caseD7(session, say) {
  const loaded = await session.until(`(() => { const w=${IF},d=w.document;
    const i=[...d.querySelectorAll('${S} img')].find(n=>(n.getAttribute('src')||'').includes('shot-d7'));
    return !!(i&&i.naturalWidth>0); })()`, { timeout: 15000, interval: 200 });
  const g = await session.js(GEOM(bySrc('shot-d7')));
  if (!loaded || !g.ok || !g.nat) { say('R1MEDIA D7缩放落点 EVIDENCE ' + JSON.stringify({ 加载失败: true, 几何: g })); return; }
  const at = centerOf(g);
  await rightClick(session, at.x, at.y);
  await harness.sleep(320);
  const btn = await session.js(POINT('#typora-editor-context-menu [data-action="image-settings"]'));
  if (!btn) { say('R1MEDIA D7缩放落点 EVIDENCE ' + JSON.stringify({ 阶段: '菜单没出现' })); return; }
  await clickAt(session, btn.x, btn.y);
  await harness.sleep(450);
  const dlg0 = await session.js(DIALOG);
  if (!dlg0.开) { say('R1MEDIA D7缩放落点 EVIDENCE ' + JSON.stringify({ 阶段: '对话框没开' })); return; }
  await shot2x(session, 'D7对话框初值-2x', dlg0.盒);
  const inp = await session.js(POINT('#typora-image-settings input[name="scale"]'));
  await clickAt(session, inp.x, inp.y); await harness.sleep(140);
  for (let i = 0; i < 3; i++) { await hi.press(session, 'Backspace'); await harness.sleep(70); }
  await session.type('50'); await harness.sleep(160);
  const dlg1 = await session.js(DIALOG);
  const apply = await session.js(POINT('#typora-image-settings button[type="submit"]'));
  await clickAt(session, apply.x, apply.y); await harness.sleep(800);
  const md = String(await hi.mdNow(session));
  const caret = await hi.caret(session);
  const dlg2 = await session.js(DIALOG);
  const g2 = await session.js(GEOM(bySrc('shot-d7')));
  await session.shot('D7缩放50-整页');
  if (g2.ok) await shot2x(session, 'D7缩放50-2x', boxOf(g2, '图'));
  const hit = /data-typora-scale="50"/.exec(md);
  const start = hit ? md.lastIndexOf('<img', hit.index) : -1;
  const end = hit ? md.indexOf('>', hit.index) : -1;
  say('R1MEDIA D7缩放落点 EVIDENCE ' + JSON.stringify({
    初值: dlg0.值, 输入后: dlg1.值, 对话框已关: !dlg2.开, 表单错误: dlg1.错 || dlg2.错 || '',
    已应用: !!hit, 图片区间: hit ? { start, end: end + 1, 长: end + 1 - start } : null,
    片段: hit ? md.slice(start, end + 1) : null,
    光标: caret, 缩放后显示宽: g2.ok ? g2.图.w : null }));
}

/** D4：裸 HTML 图块右侧空白按下 → 拖到下段文字松手 → insertText。绿：选区不含 <img、图仍在。 */
async function caseD4(session, say) {
  const p = await session.js(D4_PICK);
  if (!p.ok) { say('R1MEDIA D4空白带拖选 FAIL ' + JSON.stringify({ 阶段: '没找到图或下段', 挑选: p })); return; }
  const 从 = { x: Math.min(p.图.r + 60, p.块右 - 20), y: Math.round((p.图.t + p.图.b) / 2) };
  const 命中 = await session.js(`(() => { const w=${IF},d=w.document;const el=d.elementFromPoint(${从.x},${从.y});
    return el?el.nodeName+'.'+String(el.className||'').split(' ').slice(0,2).join('.'):'null'; })()`);
  await hi.drag(session, 从, p.至, { steps: 12, interval: 35, after: 380 });
  const sel = await session.js(SEL);
  await session.shot('D4拖选-整页');
  await shot2x(session, 'D4拖选-2x', { x: p.图.l - 30, y: p.图.t - 20, w: Math.max(p.至.x + 130, p.图.r) - (p.图.l - 30), h: p.至.y - p.图.t + 70 });
  await session.type('替换好了'); await harness.sleep(550);
  const md = String(await hi.mdNow(session));
  const g2 = await session.js(GEOM(bySrc('shot-red')));
  await session.shot('D4替换后-整页');
  if (g2.ok) await shot2x(session, 'D4替换后-2x', boxOf(g2, '图'));
  const m = /<img[^>]*shot-red[^>]*>/.exec(md);
  const 图尾 = m ? m.index + m[0].length : -1;
  const typedAt = md.indexOf('替换好了');
  const okSel = !!sel && !sel.无 && !sel.含img && !sel.折叠;
  const pass = okSel && g2.ok && 图尾 >= 0 && typedAt > 图尾;
  say(`R1MEDIA D4空白带拖选 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    块类型: p.类, 空白带命中: 命中, 起点: 从, 终点: p.至,
    选区: sel, 图仍在DOM: g2.ok, 图源码仍在md: 图尾 >= 0, 文字落在图后: typedAt > 图尾,
    md尾: md.slice(-140) }));
}

/** D1：一段两图 Ctrl+点选 → 真实 Backspace。绿：两张全删、无错误 toast、焦点保留。 */
async function caseD1(session, say) {
  const ga = await session.js(GEOM(byAlt('a')));
  if (!ga.ok) { say('R1MEDIA D1多选删除 FAIL ' + JSON.stringify({ 阶段: '没找到图 a' })); return; }
  const ca = centerOf(ga);
  await clickAt(session, ca.x, ca.y, { modifiers: harness.MOD.ctrl });
  await harness.sleep(340);
  const t1 = await session.js(TOAST);
  const gb = await session.js(GEOM(byAlt('b')));
  if (!gb.ok) { say('R1MEDIA D1多选删除 FAIL ' + JSON.stringify({ 阶段: '没找到图 b' })); return; }
  const cb = centerOf(gb);
  await clickAt(session, cb.x, cb.y, { modifiers: harness.MOD.ctrl });
  await harness.sleep(340);
  const t2 = await session.js(TOAST);
  const 状态 = await session.js(AB_STATE);
  const focus = await session.js(hi.FOCUS);
  const 滚前 = await session.js(SCROLL);
  await session.shot('D1双选-整页');
  await shot2x(session, 'D1双选-2x', {
    x: Math.min(ga.图.l, gb.图.l) - 30, y: Math.min(ga.图.t, gb.图.t) - 20,
    w: Math.max(ga.图.r, gb.图.r) - Math.min(ga.图.l, gb.图.l) + 60,
    h: Math.max(ga.图.b, gb.图.b) - Math.min(ga.图.t, gb.图.t) + 40 });
  // 选择提示 toast 寿命 2.2s：等它过期，保证退格后读到的 toast 只可能是删除错误
  await harness.sleep(2300);
  const 清了 = await session.js(TOAST);
  await hi.press(session, 'Backspace');
  await harness.sleep(700);
  const toast = await session.js(TOAST);
  const md = String(await hi.mdNow(session));
  const 后 = await session.js(AB_STATE);
  const 滚后 = await session.js(SCROLL);
  await session.shot('D1删除后-整页');
  const pass = 后.剩余ab === 0 && !toast.有 && !md.includes('![a]') && !md.includes('![b]') && focus.ok;
  say(`R1MEDIA D1多选删除 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    双选提示: [t1 && t1.文, t2 && t2.文], 多选高亮数: 状态.多选数, 焦点保留: focus.ok,
    退格前toast已清: !清了.有, 删除toast: toast, 剩余ab: 后.剩余ab,
    md含图a: md.includes('![a]'), md含图b: md.includes('![b]'), 滚动前后: [滚前, 滚后], md尾: md.slice(-110) }));
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  // 素材房：小图现场生成（与 md 同目录，相对/绝对路径都能加载）
  fs.writeFileSync(path.join(OUT, 'x.png'), hi.fixtures.png(120, 80, [70, 110, 230]));
  fs.writeFileSync(path.join(OUT, 'y.png'), hi.fixtures.png(140, 90, [60, 200, 110]));
  fs.writeFileSync(path.join(OUT, 'shot-red.png'), hi.fixtures.png(160, 100, [220, 60, 60]));
  fs.writeFileSync(path.join(OUT, 'shot-d7.png'), hi.fixtures.png(150, 90, [130, 90, 200]));
  const file = path.join(OUT, 'r1-media.md');
  fs.writeFileSync(file, BODY, 'utf8');

  const exe = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, ...(DEV ? { appArgs: [path.join(harness.project, 'app/main/main.js')] } : {}),
      label: 'probe-r1-media', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const session = await hi.openDoc(ctx, file, { minBlocks: 6, settleMs: 1600 });
  try {
    // 顺序：非破坏性用例在前，D1（删图）最后
    const cases = [['D2断链对齐', caseD2], ['D8对话框初值', caseD8], ['D7缩放落点', caseD7], ['D4空白带拖选', caseD4], ['D1多选删除', caseD1]];
    for (const [名, fn] of cases) {
      try { await fn(session, say); }
      catch (error) { say(`R1MEDIA ${名} FAIL ` + JSON.stringify({ 探针异常: String(error.message).slice(0, 220) })); }
    }
    say(JSON.stringify({ console错误: session.errors.slice(0, 5), 警告: session.warnings.slice(0, 3) }));
  } finally {
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
    await ctx.release(session);
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
