/** 探针 · 第 2 轮判决"通过"项 T2/T3/T6/T7/T8/S5/W4/W5 的实机验收（2026-10-02）。
 *
 *  判决来源：E:/MarkPilot/.zcode-tmp/round2-verdicts.md（仅"通过"项）。
 *  被测对象：Typora-Editor/extension-src/render/js/media-tools.js 的七条修改。
 *  **跑前先 `npm run sync`**（extension-src → 开发树 app/renderer/js），本探针按 harness
 *  dev 模式拉起开发树；--installed 则拉起安装版 EXE。
 *
 *  用例与红条件（旧代码必须 FAIL、新代码必须 PASS）：
 *    T6首格ShiftTab  首格（表头第 1 格）按 Shift+Tab
 *       PASS：行数不变、焦点仍在编辑器、光标仍在表格内（产品层不吞）
 *       红：产品层误接管 → 行数变 / 焦点丢 / 光标丢
 *    T6末格Tab       末格（最后行最后格）按 Tab
 *       PASS：新增一条数据行（行数 +1、表头仍 1 行、新行全 TD）、光标落新行首格(行末-1? 见断言)
 *       红（旧代码无接管）：行数不变、光标留在原格或跳出表
 *    T3词删放行      格内词中（折叠光标）Ctrl+Backspace
 *       PASS：只删前一个词（'alpha beta gamma'→'alpha gamma'）、行还在（行数不变）
 *       红（旧代码劫成删行）：行数 -1、该行整行消失
 *    T8选区回车替换  格内选 3 字（乙乙乙）按 Enter
 *       PASS：选中 3 字被删（格内无'乙'）、余文完好、行数不变、格内出现 br（vendor 插入）
 *       红（旧代码）：选中的 3 字没被替换（'乙乙乙' 仍在）或表/行被破坏
 *    T7外来表格粘入  独立进程构造外来剪贴板（html=<table><tr><td>a_b*c $x$</td></tr></table>
 *                   + text/plain），格内 Ctrl+V
 *       PASS：格文本原样 'a_b*c $x$'、无 em/strong/公式节点（plain 转义路径）
 *       红（旧代码按 markdown 还原）：* _ $ 被 Lute 吃成斜体/公式、格文本 ≠ 原样
 *    S5公式单份复制  选"文甲 $x+y$ 文乙" Ctrl+Alt+V
 *       PASS：系统剪贴板文本 === '文甲 $x+y$ 文乙'，'x+y' 恰好出现 1 次（单份带围栏源码）
 *       红（旧代码）：'x+y' 出现 ≥2 次（KaTeX MathML+注记+可视层多份）或源码缺失
 *    W4三击选段      双击图旁词（词选态）→ 第 3 击点图（detail=3）
 *       PASS：整段选中（选区非折叠、含图、含正文词）、图片**不**展开源码
 *       红（旧代码）：第三击被 detail≥2 展开分支吃掉 → --expand 出现、选区被抢
 *    W4对照两击展开  纯两击连点另一张图（138 契约对照，防修过头）
 *       PASS：owner 带 vditor-ir__node--expand（双击仍展开）
 *       红：双击不展开（契约 138 被破坏）
 *    W5Ctrl双击取消  同一张图快速 Ctrl 两击（clickCount 1→2，均带 Ctrl）
 *       PASS：多选被取消（无 multi/单选高亮）、不展开、编辑器保有焦点
 *       红（旧代码 detail<2 拦掉第二击）：第二击落到 click 的 detail≥2 分支 → 源码展开
 *    T2表头下插行    表头行右键 → 下方插入行（live 断言）
 *       PASS：表头仍 1 行、总行数 +1、新行是 tbody 首行且全 TD、空文本
 *       红（旧代码插进 thead）：表头行数 2 / 新行是 th
 *    T2存盘          Ctrl+S 后读磁盘 md
 *       PASS：分隔行之后、a1 行之前有一条空数据行，表格结构完好
 *    T2重开          关闭重开同一文件（铁律 3：先关再开，一次只有一个 GUI 任务）
 *       PASS：thead 1 行、tbody 2 行、首行全 TD 空、a1 行在
 *       红（旧代码）：重开后表格破碎或新行不是 tbody 首行数据行
 *
 *  剪贴板纪律：探针开头 saveClipboard、结尾 restoreClipboard；外来载荷（T7）由独立
 *  PowerShell 进程构造（运行时生成的 set-clip-html.ps1，CF_HTML 走 Win32 原始 UTF-8 字节）。
 *  素材（表格/公式/小图）全部现场生成到 .perf/probe-r2-media2/，不碰受保护素材。
 *
 *  输出：每用例一行 `R2MD <名> PASS/FAIL <JSON>`；整页 + 关键处 2x 局部截图存
 *  .perf/probe-r2-media2/；log.json 汇总。
 *
 *  用法：node scripts/acceptance/probe-r2-media2.cjs [--installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r8-final/t2seq');
const IF = hi.IF;
const S = hi.SURFACE;
const FRAME = `document.getElementById('editor').getBoundingClientRect()`;
const CTRL = harness.MOD.ctrl;

const BODY = [
  '# R2 媒体修复验收（T2/T3/T6/T7/T8/S5/W4/W5）',
  '',
  '文甲 $x+y$ 文乙',
  '',
  '前词词甲 ![w4图](w4.png) 词乙后词',
  '',
  '![对照图](w4b.png)',
  '',
  '![w5图](w5.png)',
  '',
  '| T6头甲 | T6头乙 |',
  '| --- | --- |',
  '| t6左 | t6右 |',
  '',
  '| T3头甲 | T3头乙 |',
  '| --- | --- |',
  '| alpha beta gamma | t3右 |',
  '',
  '| T7头甲 | T7头乙 |',
  '| --- | --- |',
  '| 待粘贴 | t7右 |',
  '',
  '| T8头甲 | T8头乙 |',
  '| --- | --- |',
  '| 甲甲甲乙乙乙丙丙丙丁丁丁 | t8右 |',
  '',
  '| T2头甲 | T2头乙 |',
  '| --- | --- |',
  '| a1 | b1 |',
  '',
].join('\n');

// ─── 页内读数（全部走 iframe 真实 DOM，不做任何产品内状态注入） ─────────────────
/** 按表头标记找表：表格顺序可能随块变化，认表头文本最稳。 */
const TABLE_STATE = mark => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const ts=[...d.querySelectorAll('${S} table')];
  const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
  if(!t)return {有:false,共表:ts.length};
  t.scrollIntoView({block:'center',behavior:'instant'});
  const r=t.getBoundingClientRect();
  const body=t.tBodies[0];
  const 首体=[...(body?.rows[0]?.cells||[])].map(c=>c.tagName);
  return {有:true,表序:ts.indexOf(t),行数:t.rows.length,
    表头行:t.tHead?t.tHead.rows.length:0,体行:body?body.rows.length:0,
    首体tag:首体,首体空:!((body?.rows[0]?.textContent||'').trim()),
    各行:[...t.rows].map(row=>[...row.cells].map(c=>c.textContent.trim().slice(0,18))),
    盒:{x:Math.round(fr.x+r.left),y:Math.round(fr.y+r.top),w:Math.round(r.width),h:Math.round(r.height)}}; })()`;

/** 光标落在哪个表的哪一格（行/列/tag/格文本/折叠）。 */
const CARET_CELL = `(() => { const w=${IF},d=w.document;const s=w.getSelection();
  if(!s||!s.rangeCount)return {有:false};
  const el=n=>n?(n.nodeType===3?n.parentElement:n):null;
  const cell=el(s.focusNode)?.closest?.('td,th');
  if(!cell)return {有:false,折叠:s.isCollapsed,选区:s.toString().slice(0,30),在:'表外'};
  const row=cell.parentElement,table=row.closest('table');
  const ts=[...d.querySelectorAll('${S} table')];
  return {有:true,表序:ts.indexOf(table),行:[...table.rows].indexOf(row),列:cell.cellIndex,
    tag:cell.tagName,格文本:cell.textContent.trim().slice(0,24),折叠:s.isCollapsed}; })()`;

/** 把折叠光标放进指定格（前置设置；动作仍走真实键鼠）。 */
const PLACE_CELL = (mark, row, col, offset) => `(() => { const w=${IF},d=w.document;
  const ts=[...d.querySelectorAll('${S} table')];
  const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
  if(!t)return {ok:false,错:'没找到表 ${mark}'};
  const cell=t.rows[${row}]?.cells[${col}];
  if(!cell)return {ok:false,错:'没有格 ${row},${col}'};
  t.scrollIntoView({block:'center',behavior:'instant'});
  const walker=d.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let node=null;
  while(walker.nextNode()){const n=walker.currentNode;
    if(n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))continue;
    if(n.data.replace(/[\\s\\u200b]/g,'')){node=n;break;}}
  const s=d.querySelector('${S}');s.focus();
  const r=d.createRange();
  if(node)r.setStart(node,Math.min(${offset},node.data.length));
  else{r.selectNodeContents(cell);}
  r.collapse(true);
  const sel=w.getSelection();sel.removeAllRanges();sel.addRange(r);
  return {ok:true,格文本:node?node.data.slice(0,24):'(空)',tag:cell.tagName}; })()`;

/** 在指定格内选一段字符（前置设置）。 */
const SELECT_CELL = (mark, row, col, from, to) => `(() => { const w=${IF},d=w.document;
  const ts=[...d.querySelectorAll('${S} table')];
  const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
  if(!t)return {ok:false,错:'没找到表 ${mark}'};
  const cell=t.rows[${row}]?.cells[${col}];
  if(!cell)return {ok:false,错:'没有格 ${row},${col}'};
  t.scrollIntoView({block:'center',behavior:'instant'});
  const walker=d.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let node=null;
  while(walker.nextNode()){const n=walker.currentNode;
    if(n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))continue;
    if(n.data.replace(/[\\s\\u200b]/g,'')){node=n;break;}}
  if(!node)return {ok:false,错:'格里没有文字'};
  const s=d.querySelector('${S}');s.focus();
  const r=d.createRange();r.setStart(node,${from});r.setEnd(node,${to});
  const sel=w.getSelection();sel.removeAllRanges();sel.addRange(r);
  return {ok:true,选区:sel.toString()}; })()`;

/** 指定格的深度状态：文本 / br 数 / 样式·公式节点数。 */
const CELL_DEEP = (mark, row, col) => `(() => { const w=${IF},d=w.document;
  const ts=[...d.querySelectorAll('${S} table')];
  const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
  const c=t?.rows[${row}]?.cells[${col}];
  if(!c)return {有:false};
  return {有:true,文本:c.textContent,br:c.querySelectorAll('br').length,
    样式节点:c.querySelectorAll('em,strong,b,i,code.language-math,.vditor-ir__node,.vditor-wysiwyg__node').length}; })()`;

/** 指定格中心点（页面坐标，右键用）。 */
const CELL_POINT = (mark, row, col) => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const ts=[...d.querySelectorAll('${S} table')];
  const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
  const c=t?.rows[${row}]?.cells[${col}];
  if(!c)return null;
  t.scrollIntoView({block:'center',behavior:'instant'});
  const r=c.getBoundingClientRect();
  return {x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2)}; })()`;

/** 图片状态：加载/展开态/多选·单选高亮/页面坐标盒。 */
const IMG_STATE = alt => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const img=[...d.querySelectorAll('${S} img')].find(n=>(n.getAttribute('alt')||'')==='${alt}');
  if(!img)return {有:false};
  img.scrollIntoView({block:'center',behavior:'instant'});
  const r=img.getBoundingClientRect();
  const owner=img.closest('.vditor-ir__node[data-type],.vditor-wysiwyg__node[data-type]');
  return {有:true,nat:img.naturalWidth,
    展开态:!!(owner&&owner.classList.contains('vditor-ir__node--expand')),
    多选高亮:img.classList.contains('typora-img-multi-selected'),
    单选高亮:img.classList.contains('typora-img-selected'),
    图:{l:Math.round(fr.x+r.left),t:Math.round(fr.y+r.top),r:Math.round(fr.x+r.right),b:Math.round(fr.y+r.bottom),w:Math.round(r.width),h:Math.round(r.height)}}; })()`;

/** 选区事实（含是否盖住指定图）。 */
const SEL_IMG = alt => `(() => { const w=${IF},d=w.document;const s=w.getSelection();
  if(!s||!s.rangeCount)return {有选区:false};
  const img=[...d.querySelectorAll('${S} img')].find(n=>(n.getAttribute('alt')||'')==='${alt}');
  const txt=s.toString();
  return {有选区:true,非折叠:!s.isCollapsed,文本:txt.replace(/\\s+/g,' ').slice(0,120),
    含图:!!(img&&s.getRangeAt(0).intersectsNode(img)),含词:txt.includes('词乙')||txt.includes('词甲'),含前词:txt.includes('前词')}; })()`;

/** W4 用：图旁词的页面坐标（'词乙'两字的中心）。 */
const WORD_POINT = `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const s=d.querySelector('${S}');if(!s)return {ok:false};
  let hit=null;
  for(const p of s.querySelectorAll('p')){
    const walker=d.createTreeWalker(p,NodeFilter.SHOW_TEXT);let n;
    while(n=walker.nextNode()){const at=n.data.indexOf('词乙后词');if(at>=0){hit={n,at};break;}}
    if(hit)break;}
  if(!hit)return {ok:false};
  hit.n.parentElement.closest('p').scrollIntoView({block:'center',behavior:'instant'});
  const r=d.createRange();r.setStart(hit.n,hit.at);r.setEnd(hit.n,hit.at+2);
  const b=r.getBoundingClientRect();
  return {ok:true,x:Math.round(fr.x+b.left+b.width/2),y:Math.round(fr.y+b.top+b.height/2)}; })()`;

/** S5 用：整段选中含"文甲…文乙"的段落——selectNodeContents 从段首前一字罩到段尾后一字，
 *  公式 owner 完整落在选区内（段落文本本身就是"文甲 $x+y$ 文乙"，剪贴板期望即段文本；
 *  旧版 A→B 端点选法实测只罩到公式尾，'文乙'没进选区）。 */
const SELECT_PARA = (a, b) => `(() => { const w=${IF},d=w.document;
  const s=d.querySelector('${S}');if(!s)return {ok:false,错:'没有编辑面'};
  let P=null;
  for(const block of s.children){
    const t=block.textContent||'';
    if(t.includes('${a}')&&t.includes('${b}')&&t.includes('$')){P=block;break;}}
  if(!P)return {ok:false,错:'没找到含 ${a} 与 ${b} 的段落'};
  P.scrollIntoView({block:'center',behavior:'instant'});
  s.focus();
  const r=d.createRange();r.selectNodeContents(P);
  const sel=w.getSelection();sel.removeAllRanges();sel.addRange(r);
  return {ok:true,段文本:(P.textContent||'').replace(/\\s+/g,' ').slice(0,60),
    选区:sel.toString().replace(/\\s+/g,' ').slice(0,80)}; })()`;

const TOAST = `(() => { const w=${IF},d=w.document;const t=d.querySelector('.typora-context-toast');
  return t?{有:true,文:t.textContent}:{有:false}; })()`;

const POINT = selector => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
  const el=d.querySelector(${JSON.stringify(selector)});
  if(!el)return null;const r=el.getBoundingClientRect();
  return {x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2),文:(el.textContent||'').trim().slice(0,16)}; })()`;

// ─── 真实输入原语（CDP Input 通道） ────────────────────────────────────────────
async function clickAt(session, x, y, modifiers = 0) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
}
/** 连击序列中的一击：clickCount 由调用方指定（CDP 的 clickCount 即 DOM event.detail）。 */
async function clickN(session, x, y, count, modifiers = 0) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: count, modifiers });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: count, modifiers });
}
async function rightClick(session, x, y) {
  // 【R8 triage】真实用户右键前鼠标必然先移动到目标上（悬停态会随 mousemove 更新）。
  // 实测：W5 的 Ctrl+双击之后不带 move 的裸右键打不开菜单；带 move 的右键正常。
  if (process.env.R8_NO_MOVE !== '1') {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await harness.sleep(90);
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
/** 整页截图之外补一张"关键处 2x 局部"（截图证据规则第 2 条）。 */
async function shot2x(session, name, box) {
  try {
    const clip = { x: Math.max(0, Math.round(box.x - 40)), y: Math.max(0, Math.round(box.y - 30)),
      width: Math.max(120, Math.min(Math.round(box.w + 80), 1500)),
      height: Math.max(80, Math.min(Math.round(box.h + 60), 900)), scale: 2 };
    const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  } catch (error) { console.log('截图失败(' + name + ')：' + error.message); }
}
const norm = t => String(t || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();

// ─── 外来剪贴板（独立进程构造：CF_HTML 走 Win32 原始 UTF-8 字节 + text/plain） ──
const SET_CLIP_PS1 = [
  'param([string]$InHtml = \'\', [string]$InText = \'\')',
  '# Independent-process constructor for a FOREIGN clipboard payload (both text/html and',
  '# text/plain). ASCII only on purpose: PS 5.1 decodes BOM-less scripts with ANSI code page.',
  '# CF_HTML must be written as raw UTF-8 bytes via Win32 (WinForms SetData would store a',
  '# UTF-16 string under the custom format, which Chromium cannot parse).',
  '$ErrorActionPreference = \'Stop\'',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -Namespace Acc -Name ClipPut -MemberDefinition @\'',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool EmptyClipboard();',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool SetClipboardData(uint format, IntPtr data);',
  '[DllImport("user32.dll", SetLastError=true)] public static extern bool CloseClipboard();',
  '[DllImport("user32.dll")] public static extern uint RegisterClipboardFormat(string format);',
  '[DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);',
  '[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr handle);',
  '[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr handle);',
  '\'@',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '$frag = [IO.File]::ReadAllText($InHtml)',
  '$text = [IO.File]::ReadAllText($InText)',
  '$prefix = \'<html><body>\' + [char]13 + [char]10 + \'<!--StartFragment-->\'',
  '$suffix = \'<!--EndFragment--></body></html>\'',
  '$body = $prefix + $frag + $suffix',
  '$hdr = \'Version:0.9\' + [char]13 + [char]10 + \'StartHTML:{0:D10}\' + [char]13 + [char]10 + \'EndHTML:{1:D10}\' + [char]13 + [char]10 + \'StartFragment:{2:D10}\' + [char]13 + [char]10 + \'EndFragment:{3:D10}\' + [char]13 + [char]10',
  '$hdrLen = [Text.Encoding]::ASCII.GetByteCount(($hdr -f 0,0,0,0))',
  '$startHtml = $hdrLen',
  '$startFrag = $hdrLen + $utf8.GetByteCount($prefix)',
  '$endFrag = $startFrag + $utf8.GetByteCount($frag)',
  '$endHtml = $hdrLen + $utf8.GetByteCount($body)',
  '$cf = ($hdr -f $startHtml, $endHtml, $startFrag, $endFrag) + $body',
  '$bytes = $utf8.GetBytes($cf)',
  '$opened = $false',
  'for($i = 0; $i -lt 5 -and -not $opened; $i++) {',
  '  $opened = [Acc.ClipPut]::OpenClipboard([IntPtr]::Zero)',
  '  if(-not $opened) { Start-Sleep -Milliseconds 250 }',
  '}',
  'if(-not $opened) { throw \'clipboard busy\' }',
  'try {',
  '  [void][Acc.ClipPut]::EmptyClipboard()',
  '  $hfmt = [Acc.ClipPut]::RegisterClipboardFormat(\'HTML Format\')',
  '  $hptr = [Acc.ClipPut]::GlobalAlloc(0x0002, [UIntPtr][uint64]($bytes.Length + 1))',
  '  $lock = [Acc.ClipPut]::GlobalLock($hptr)',
  '  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $lock, $bytes.Length)',
  '  [Runtime.InteropServices.Marshal]::WriteByte($lock, $bytes.Length, 0)',
  '  [void][Acc.ClipPut]::GlobalUnlock($hptr)',
  '  [void][Acc.ClipPut]::SetClipboardData($hfmt, $hptr)',
  '  $tbytes = [Text.Encoding]::Unicode.GetBytes($text + [char]0)',
  '  $tptr = [Acc.ClipPut]::GlobalAlloc(0x0002, [UIntPtr][uint64]$tbytes.Length)',
  '  $tlock = [Acc.ClipPut]::GlobalLock($tptr)',
  '  [Runtime.InteropServices.Marshal]::Copy($tbytes, 0, $tlock, $tbytes.Length)',
  '  [void][Acc.ClipPut]::GlobalUnlock($tptr)',
  '  [void][Acc.ClipPut]::SetClipboardData(13, $tptr)',
  '} finally { [void][Acc.ClipPut]::CloseClipboard() }',
  'Write-Output \'ok\'',
].join('\r\n');

function foreignClipboard(htmlFragment, plainText) {
  fs.writeFileSync(path.join(OUT, 'set-clip-html.ps1'), SET_CLIP_PS1, 'utf8');
  fs.writeFileSync(path.join(OUT, 'foreign.html'), htmlFragment, 'utf8');
  fs.writeFileSync(path.join(OUT, 'foreign.txt'), plainText, 'utf8');
  const out = execFileSync(harness.POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(OUT, 'set-clip-html.ps1'), '-InHtml', path.join(OUT, 'foreign.html'), '-InText', path.join(OUT, 'foreign.txt')],
    { encoding: 'utf8', windowsHide: true });
  return out.trim();
}

// ─── 用例 ──────────────────────────────────────────────────────────────────────
/** T6-a：首格 Shift+Tab 不吞。红：产品层误接管（行数变/焦点丢/光标丢）。 */
async function caseT6ShiftTab(session, say) {
  const t0 = await session.js(TABLE_STATE('T6头甲'));
  if (!t0.有) { say('R2MD T6首格ShiftTab FAIL ' + JSON.stringify({ 阶段: '没找到 T6 表' })); return; }
  const placed = await session.js(PLACE_CELL('T6头甲', 0, 0, 2));
  if (!placed.ok) { say('R2MD T6首格ShiftTab FAIL ' + JSON.stringify({ 阶段: '光标放置失败', 放置: placed })); return; }
  await hi.combo(session, 'Shift+Tab');
  await harness.sleep(350);
  const t1 = await session.js(TABLE_STATE('T6头甲'));
  const caret = await session.js(CARET_CELL);
  const focus = await session.js(hi.FOCUS);
  await session.shot('T6首格ShiftTab-整页');
  const pass = t1.行数 === t0.行数 && focus.ok && !!caret.有 && caret.表序 === t0.表序;
  say(`R2MD T6首格ShiftTab ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    行数前后: [t0.行数, t1.行数], 焦点在: focus.ok, 光标: caret }));
}

/** T6-b：末格 Tab 补行。红（旧）：行数不变、光标不进新行首格。 */
async function caseT6Tab(session, say) {
  const t0 = await session.js(TABLE_STATE('T6头甲'));
  if (!t0.有) { say('R2MD T6末格Tab FAIL ' + JSON.stringify({ 阶段: '没找到 T6 表' })); return; }
  const lastRow = t0.行数 - 1, lastCol = (t0.各行[lastRow] || []).length - 1;
  const placed = await session.js(PLACE_CELL('T6头甲', lastRow, lastCol, 9));
  if (!placed.ok) { say('R2MD T6末格Tab FAIL ' + JSON.stringify({ 阶段: '光标放置失败', 放置: placed })); return; }
  await hi.press(session, 'Tab');
  await harness.sleep(450);
  const t1 = await session.js(TABLE_STATE('T6头甲'));
  const caret = await session.js(CARET_CELL);
  await session.shot('T6末格Tab-整页');
  await shot2x(session, 'T6末格Tab-2x', t1.盒);
  const 新行全TD = t1.首体tag.length > 0 && t1.首体tag.every(tag => tag === 'TD');
  const 光标进新行首格 = !!caret.有 && caret.行 === t1.行数 - 1 && caret.列 === 0 && caret.折叠;
  const pass = t1.行数 === t0.行数 + 1 && t1.表头行 === t0.表头行 && 新行全TD && 光标进新行首格;
  say(`R2MD T6末格Tab ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    行数前后: [t0.行数, t1.行数], 表头行: t1.表头行, 新行tag: t1.首体tag, 新行空: t1.首体空,
    光标: caret, 各行: t1.各行 }));
}

/** T3：格内词中 Ctrl+Backspace 只删词。红（旧）：劫成删行 → 行数 -1、行消失。 */
async function caseT3(session, say) {
  const t0 = await session.js(TABLE_STATE('T3头甲'));
  if (!t0.有) { say('R2MD T3词删放行 FAIL ' + JSON.stringify({ 阶段: '没找到 T3 表' })); return; }
  const placed = await session.js(PLACE_CELL('T3头甲', t0.行数 - 1, 0, 11));   // 'alpha beta '之后
  if (!placed.ok) { say('R2MD T3词删放行 FAIL ' + JSON.stringify({ 阶段: '光标放置失败', 放置: placed })); return; }
  await hi.combo(session, 'Ctrl+Backspace');
  await harness.sleep(450);
  const t1 = await session.js(TABLE_STATE('T3头甲'));
  const cell = await session.js(CELL_DEEP('T3头甲', t1.行数 > 1 ? 1 : 0, 0));
  await session.shot('T3词删-整页');
  await shot2x(session, 'T3词删-2x', t1.盒);
  const 文本 = norm(cell.文本);
  const pass = t1.行数 === t0.行数 && 文本 === 'alpha gamma';
  say(`R2MD T3词删放行 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    行数前后: [t0.行数, t1.行数], 词后格文本: 文本, beta没了: !文本.includes('beta'),
    行还在: t1.行数 === t0.行数, 各行: t1.各行 }));
}

/** T8：格内选 3 字 Enter 被替换。红（旧）：'乙乙乙' 仍在（没替换）或表被破坏。 */
async function caseT8(session, say) {
  const t0 = await session.js(TABLE_STATE('T8头甲'));
  if (!t0.有) { say('R2MD T8选区回车替换 FAIL ' + JSON.stringify({ 阶段: '没找到 T8 表' })); return; }
  const selected = await session.js(SELECT_CELL('T8头甲', 1, 0, 3, 6));   // '乙乙乙'
  if (!selected.ok) { say('R2MD T8选区回车替换 FAIL ' + JSON.stringify({ 阶段: '选区设置失败', 设置: selected })); return; }
  await session.enter();
  await harness.sleep(550);
  const t1 = await session.js(TABLE_STATE('T8头甲'));
  const cell = await session.js(CELL_DEEP('T8头甲', 1, 0));
  const md = String(await hi.mdNow(session));
  await session.shot('T8选区回车-整页');
  await shot2x(session, 'T8选区回车-2x', t1.盒);
  const 文本 = norm(cell.文本);
  const pass = cell.有 && !文本.includes('乙') && 文本.includes('甲甲甲') && 文本.includes('丙丙丙')
    && t1.行数 === t0.行数 && (cell.br >= 1 || md.includes('<br'));
  say(`R2MD T8选区回车替换 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    选区: selected.选区, 格文本: 文本, br数: cell.br, 行数前后: [t0.行数, t1.行数],
    乙已删: !文本.includes('乙'), 甲丙完好: 文本.includes('甲甲甲') && 文本.includes('丙丙丙'),
    md含br: md.includes('<br'), 各行: t1.各行 }));
}

/** T7：外来 html+text 剪贴板粘入，* _ $ 原样。红（旧）：markdown 路径吃掉记号。 */
async function caseT7(session, say) {
  const t0 = await session.js(TABLE_STATE('T7头甲'));
  if (!t0.有) { say('R2MD T7外来表格粘入 FAIL ' + JSON.stringify({ 阶段: '没找到 T7 表' })); return; }
  let put = null;
  try { put = foreignClipboard('<table><tr><td>a_b*c $x$</td></tr></table>', 'a_b*c $x$'); }
  catch (error) { say('R2MD T7外来表格粘入 FAIL ' + JSON.stringify({ 阶段: '外来剪贴板构造失败', 错: String(error.message).slice(0, 200) })); return; }
  await harness.sleep(300);
  const clip = await harness.readClipboard(OUT);   // 独立进程证人：载荷真的在剪贴板上
  const placed = await session.js(PLACE_CELL('T7头甲', t0.行数 - 1, 0, 3));
  if (!placed.ok) { say('R2MD T7外来表格粘入 FAIL ' + JSON.stringify({ 阶段: '光标放置失败', 放置: placed })); return; }
  await hi.combo(session, 'Ctrl+V');
  await harness.sleep(600);
  const t1 = await session.js(TABLE_STATE('T7头甲'));
  const cell = await session.js(CELL_DEEP('T7头甲', t1.行数 - 1, 0));
  const md = String(await hi.mdNow(session));
  await session.shot('T7外来粘入-整页');
  await shot2x(session, 'T7外来粘入-2x', t1.盒);
  const 文本 = norm(cell.文本);
  const pass = cell.有 && 文本 === 'a_b*c $x$' && cell.样式节点 === 0
    && t1.行数 === t0.行数 && (md.includes('a\\_b') || md.includes('a_b'));
  say(`R2MD T7外来表格粘入 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    构造: put, 载荷在剪贴板: { hasHtml: !!clip.hasHtml, hasText: !!clip.hasText },
    格文本: 文本, 原样: 文本 === 'a_b*c $x$', 样式节点数: cell.样式节点,
    行数前后: [t0.行数, t1.行数], md片段: (md.match(/\|[^|\n]*a[^|\n]*\|/) || [''])[0].slice(0, 60) }));
}

/** S5：整段选住"文甲 $x+y$ 文乙" Ctrl+Alt+V 单份。红（旧）：'x+y' ≥2 份或缺失。 */
async function caseS5(session, say) {
  const selected = await session.js(SELECT_PARA('文甲', '文乙'));
  if (!selected.ok) { say('R2MD S5公式单份复制 FAIL ' + JSON.stringify({ 阶段: '选区设置失败', 设置: selected })); return; }
  await hi.combo(session, 'Ctrl+Alt+V');
  await harness.sleep(500);
  const clip = await harness.readClipboard(OUT);   // 独立进程读系统剪贴板
  await session.shot('S5公式单份-整页');
  const text = norm(clip.text);
  const 份数 = text.split('x+y').length - 1;
  const pass = !!clip.hasText && text === '文甲 $x+y$ 文乙' && 份数 === 1;
  say(`R2MD S5公式单份复制 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    选区: selected.选区, 剪贴板文本: text, 期望: '文甲 $x+y$ 文乙', x加y份数: 份数, hasText: !!clip.hasText }));
}

/** W4：双击图旁词 → 第 3 击点图 = 原生三击选段。红（旧）：第三击展开源码、选区被抢。 */
async function caseW4(session, say) {
  const word = await session.js(WORD_POINT);
  const img = await session.js(IMG_STATE('w4图'));
  if (!word.ok || !img.有) { say('R2MD W4三击选段 FAIL ' + JSON.stringify({ 阶段: '定位失败', 词点: word, 图: img })); return; }
  await clickN(session, word.x, word.y, 1);
  await harness.sleep(70);
  await clickN(session, word.x, word.y, 2);   // 双击 → 词选态
  await harness.sleep(160);
  const afterWord = await session.js(SEL_IMG('w4图'));
  await clickN(session, Math.round((img.图.l + img.图.r) / 2), Math.round((img.图.t + img.图.b) / 2), 3);   // 第 3 击点图
  await harness.sleep(420);
  const sel = await session.js(SEL_IMG('w4图'));
  const state = await session.js(IMG_STATE('w4图'));
  await session.shot('W4三击选段-整页');
  await shot2x(session, 'W4三击选段-2x', { x: Math.min(word.x, img.图.l) - 30, y: img.图.t - 30, w: Math.max(img.图.r, word.x + 40) - Math.min(word.x, img.图.l) + 60, h: img.图.b - img.图.t + 60 });
  const pass = sel.有选区 && sel.非折叠 && sel.含图 && sel.含词 && !state.展开态 && afterWord.非折叠;
  say(`R2MD W4三击选段 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    双击后词选态: { 非折叠: afterWord.非折叠, 文本: afterWord.文本 },
    三击后: { 非折叠: sel.非折叠, 含图: sel.含图, 含词: sel.含词, 文本: sel.文本 },
    展开了: state.展开态 }));
}

/** W4 对照（138 契约）：纯两击连点另一张图仍展开。红：双击不展开（修过头）。 */
async function caseW4Control(session, say) {
  const img = await session.js(IMG_STATE('对照图'));
  if (!img.有) { say('R2MD W4对照两击展开 FAIL ' + JSON.stringify({ 阶段: '没找到对照图' })); return; }
  const cx = Math.round((img.图.l + img.图.r) / 2), cy = Math.round((img.图.t + img.图.b) / 2);
  await clickN(session, cx, cy, 1);
  await harness.sleep(80);
  await clickN(session, cx, cy, 2);
  await harness.sleep(380);
  const state = await session.js(IMG_STATE('对照图'));
  await session.shot('W4对照两击-整页');
  await shot2x(session, 'W4对照两击-2x', { x: img.图.l - 30, y: img.图.t - 25, w: img.图.r - img.图.l + 60, h: img.图.b - img.图.t + 50 });
  const pass = !!state.展开态;
  say(`R2MD W4对照两击展开 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({ 展开了: !!state.展开态, nat: state.nat }));
}

/** W5：Ctrl 快速两击同图 = 选入再取消，不展开。红（旧）：第二击展开源码。 */
async function caseW5(session, say) {
  const img = await session.js(IMG_STATE('w5图'));
  if (!img.有) { say('R2MD W5Ctrl双击取消 FAIL ' + JSON.stringify({ 阶段: '没找到 w5 图' })); return; }
  const cx = Math.round((img.图.l + img.图.r) / 2), cy = Math.round((img.图.t + img.图.b) / 2);
  await clickN(session, cx, cy, 1, CTRL);
  await harness.sleep(340);
  const toast1 = await session.js(TOAST);
  await clickN(session, cx, cy, 2, CTRL);
  await harness.sleep(420);
  const toast2 = await session.js(TOAST);
  const state = await session.js(IMG_STATE('w5图'));
  const focus = await session.js(hi.FOCUS);
  await session.shot('W5Ctrl双击-整页');
  await shot2x(session, 'W5Ctrl双击-2x', { x: img.图.l - 30, y: img.图.t - 25, w: img.图.r - img.图.l + 60, h: img.图.b - img.图.t + 50 });
  const pass = !state.展开态 && !state.多选高亮 && !state.单选高亮 && focus.ok;
  say(`R2MD W5Ctrl双击取消 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    第一击toast: toast1, 第二击toast: toast2, 展开了: !!state.展开态,
    多选残留: !!state.多选高亮, 单选残留: !!state.单选高亮, 焦点在: focus.ok }));
}

/** R8 诊断：W5 之后右键还开不开 —— 正文右键 + 表头右键各读一次菜单 DOM。 */
async function caseR8Diag(session, say) {
  const CELL = mark => `(() => { const w=${IF},d=w.document;const fr=${FRAME};
    const ts=[...d.querySelectorAll('${S} table')];
    const t=ts.find(x=>(x.rows[0]?.cells[0]?.textContent||'').includes('${mark}'));
    if(!t)return null; const c=t.rows[0].cells[0];
    t.scrollIntoView({block:'center',behavior:'instant'});
    const r=c.getBoundingClientRect();
    return {x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2)}; })()`;
  const PARA = `(() => { const w=${IF},d=w.document;const fr=${FRAME};
    const ps=[...d.querySelectorAll('${S} p')].find(p=>p.textContent.includes('普通'));
    if(!ps)return null; ps.scrollIntoView({block:'center',behavior:'instant'});
    const r=ps.getBoundingClientRect();
    return {x:Math.round(fr.x+r.left+40),y:Math.round(fr.y+r.top+r.height/2)}; })()`;
  const MENU = `(() => { const w=${IF},d=w.document;
    const m=d.querySelector('#typora-editor-context-menu');
    if(!m)return {open:false};
    return {open:true,items:[...m.querySelectorAll('[data-action]')].map(b=>b.dataset.action)}; })()`;
  const rc = async (x, y) => {
    await session.move(x, y); await harness.sleep(90);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
    await harness.sleep(450);
    const m = await session.js(MENU);
    await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
    await harness.sleep(200);
    return m;
  };
  const para = await session.js(PARA);
  const paraMenu = para ? await rc(para.x, para.y) : { noPara: true };
  const head = await session.js(CELL('T2头甲'));
  const headMenu = head ? await rc(head.x, head.y) : { noTable: true };
  const state = await session.js(`(() => { const w=${IF},d=w.document;
    const s=w.getSelection();
    return {选区非折叠:!!(s&&s.rangeCount&&!s.isCollapsed), 多选残留:d.querySelectorAll('.typora-img-multi-selected').length,
      菜单残留:!!d.querySelector('.typora-editor-context-menu')}; })()`);
  say(`R2MD R8诊断 ${paraMenu.open ? 'PASS' : 'FAIL'} ` + JSON.stringify({ 正文菜单: paraMenu, 表头菜单: headMenu, 状态: state }));
}

/** T2-a：表头行右键"下方插入行"（live 断言）。红（旧）：新行进 thead（th、表头区）。 */
async function caseT2Insert(session, say) {
  const t0 = await session.js(TABLE_STATE('T2头甲'));
  if (!t0.有) { say('R2MD T2表头下插行 FAIL ' + JSON.stringify({ 阶段: '没找到 T2 表' })); return; }
  const at = await session.js(CELL_POINT('T2头甲', 0, 0));
  if (!at) { say('R2MD T2表头下插行 FAIL ' + JSON.stringify({ 阶段: '没取到表头格坐标' })); return; }
  await rightClick(session, at.x, at.y);
  await harness.sleep(350);
  const btn = await session.js(POINT('#typora-editor-context-menu [data-action="table-row-below"]'));
  if (!btn) { say('R2MD T2表头下插行 FAIL ' + JSON.stringify({ 阶段: '右键菜单没出现' })); return; }
  await clickAt(session, btn.x, btn.y);
  await harness.sleep(500);
  const t1 = await session.js(TABLE_STATE('T2头甲'));
  await session.shot('T2表头下插行-整页');
  await shot2x(session, 'T2表头下插行-2x', t1.盒);
  const 新行全TD = t1.首体tag.length > 0 && t1.首体tag.every(tag => tag === 'TD');
  const pass = t1.表头行 === t0.表头行 && t1.行数 === t0.行数 + 1 && 新行全TD && t1.首体空
    && t1.体行 === t0.体行 + 1;
  say(`R2MD T2表头下插行 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    点击的菜单项: btn.文, 行数前后: [t0.行数, t1.行数], 表头行前后: [t0.表头行, t1.表头行],
    体行前后: [t0.体行, t1.体行], 首体tag: t1.首体tag, 首体空: t1.首体空, 各行: t1.各行 }));
}

/** T2-b：Ctrl+S 存盘后读磁盘。红（旧）：分隔行后直接 a1（或表头两行把表写坏）。 */
async function caseT2Save(session, say, file) {
  await hi.combo(session, 'Ctrl+S');
  await harness.sleep(1000);
  let disk = '';
  try { disk = fs.readFileSync(file, 'utf8'); } catch (error) { disk = ''; }
  await session.shot('T2存盘-整页');
  const lines = disk.split(/\r?\n/);
  const h = lines.findIndex(line => line.includes('T2头甲'));
  const 片 = h >= 0 ? lines.slice(h, h + 5) : [];
  const 分隔 = 片[1] || '', 空行 = 片[2] || '', a1行 = 片[3] || '';
  const 分隔ok = /^[\s|:-]+$/.test(分隔) && 分隔.includes('-') && 分隔.includes('|');
  const 空行ok = /[|]/.test(空行) && !/[^\s|]/.test(空行);   // 只含竖线与空白＝空数据行
  const a1ok = a1行.includes('a1') && a1行.includes('|');
  const pass = 分隔ok && 空行ok && a1ok;
  say(`R2MD T2存盘 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    找到表头行: h >= 0, 片段: 片, 分隔行ok: 分隔ok, 空行ok: 空行ok, a1行ok: a1ok }));
}

/** T2-c：关闭重开后断言新行是 td 数据行。红（旧）：thead 两行 → 重开后表格破碎。 */
async function caseT2Reopen(session, say) {
  const t = await session.js(TABLE_STATE('T2头甲'));
  await session.shot('T2重开-整页');
  if (!t.有) { say('R2MD T2重开 FAIL ' + JSON.stringify({ 阶段: '重开后没找到 T2 表', 共表: t.共表 })); return; }
  await shot2x(session, 'T2重开-2x', t.盒);
  const 首行全TD = t.首体tag.length > 0 && t.首体tag.every(tag => tag === 'TD');
  const a1在 = t.各行.some(row => row.some(c => c.includes('a1')));
  const pass = t.表头行 === 1 && t.体行 === 2 && 首行全TD && t.首体空 && a1在 && t.行数 === 3;
  say(`R2MD T2重开 ${pass ? 'PASS' : 'FAIL'} ` + JSON.stringify({
    表头行: t.表头行, 体行: t.体行, 行数: t.行数, 首体tag: t.首体tag, 首体空: t.首体空,
    a1行在: a1在, 各行: t.各行 }));
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  // 素材房：小图现场生成（与 md 同目录）
  fs.writeFileSync(path.join(OUT, 'w4.png'), hi.fixtures.png(150, 70, [80, 130, 220]));
  fs.writeFileSync(path.join(OUT, 'w4b.png'), hi.fixtures.png(140, 80, [90, 190, 110]));
  fs.writeFileSync(path.join(OUT, 'w5.png'), hi.fixtures.png(130, 90, [210, 120, 80]));
  const file = path.join(OUT, 'r2-media2.md');
  fs.writeFileSync(file, BODY, 'utf8');

  // 剪贴板 save：全程结束后 restore（铁律：不许把测试载荷留在用户剪贴板上）
  const saved = harness.saveClipboard(OUT);

  const exe = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, ...(DEV ? { appArgs: [path.join(harness.project, 'app/main/main.js')] } : {}),
      label: 'probe-r2-media2', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    const session = await hi.openDoc(ctx, file, { minBlocks: 12, settleMs: 1800 });
    try {
      // 等三张小图真的加载完（W4/W5 的点击坐标依赖图片盒）
      await session.until(`(() => { const w=${IF},d=w.document;
        const imgs=[...d.querySelectorAll('${S} img')];
        return imgs.length>=3&&imgs.every(n=>n.naturalWidth>0); })()`, { timeout: 20000, interval: 200 }).catch(() => {});
      // 顺序：R8 triage —— 默认只保留 T2 之前的最近三个前置（W4/W4对照/W5）；
      // R8_CASES=W5,T2 之类可再收窄（逗号分隔，按名过滤）
      const allCases = [
        ['W4三击选段', caseW4], ['W4对照两击展开', caseW4Control],
        ['W5Ctrl双击取消', caseW5], ['R8诊断右键', caseR8Diag], ['T2表头下插行', caseT2Insert],
      ];
      const pick = (process.env.R8_CASES || '').split(',').filter(Boolean);
      const cases = pick.length ? allCases.filter(([名]) => pick.some(p => 名.startsWith(p))) : allCases;
      for (const [名, fn] of cases) {
        try { await fn(session, say); }
        catch (error) { say(`R2MD ${名} FAIL ` + JSON.stringify({ 探针异常: String(error.message).slice(0, 220) })); }
      }
      try { await caseT2Save(session, say, file); }
      catch (error) { say('R2MD T2存盘 FAIL ' + JSON.stringify({ 探针异常: String(error.message).slice(0, 220) })); }
      say(JSON.stringify({ console错误: session.errors.slice(0, 5), 警告: session.warnings.slice(0, 3) }));
      await ctx.release(session);   // 铁律 3：一次只能有一个 GUI 任务——先关再开
    } finally {
      // 上面的 release 若因异常没走到，这里兜底关掉，保证重开前端口已让出
      try { await session.close(); } catch { /* 已关 */ }
    }
    // 重开断言（T2 的持久证据：磁盘 → 新会话 DOM）
    const session2 = await hi.openDoc(ctx, file, { minBlocks: 12, settleMs: 1800 });
    try {
      try { await caseT2Reopen(session2, say); }
      catch (error) { say('R2MD T2重开 FAIL ' + JSON.stringify({ 探针异常: String(error.message).slice(0, 220) })); }
      say(JSON.stringify({ 重开后console错误: session2.errors.slice(0, 5) }));
    } finally { await ctx.release(session2); }
  } finally {
    try { harness.restoreClipboard(OUT, saved.__file); } catch (error) { console.log('剪贴板还原失败：' + error.message); }
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
