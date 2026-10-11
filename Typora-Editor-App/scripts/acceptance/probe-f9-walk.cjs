/** 探针 · F9 巡走三硬伤：把"块 2 前缀 21 处按 → 不前进""块尾按 → 落下一块前缀 1"
 *  "← 第 9 步光标读不到"这三条逐键拆到 DOM 层。
 *
 *  与 134 的差别：134 只报 (块号, 前缀, 块长)；这里每次按键都记
 *  ①光标落在哪个节点的哪个偏移（文字节点内容 + 祖先路径）；②是否落在**视觉隐藏**子树
 *  （KaTeX 的 .katex-mathml 被 clip 到 1px，光标进去用户是看不见的）；③光标矩形；
 *  ④该块的结构自述（每个文字节点在块内 toString 里的区间）。
 *
 *  用法：node scripts/acceptance/probe-f9-walk.cjs [--app=dev|installed] [--at=48,58,72] [--left=9]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-f9');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const AT = ARG('at', '44,45,46,47,48,49,56,57,58,59,60,71,72,73').split(',').map(Number);
const LEFT_AT = ARG('left', '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);

const BODY = [
  '# 巡走文档标题',
  '',
  '第一段：普通中文与 english 混排文字。',
  '',
  '第二段：行内公式 $a+b=c$ 夹在中间的文字。',
  '',
  '$仅此独占一行的公式x+1$',
  '',
  '第三段：公式之后的正文。',
  '',
  '$$',
  '\\int_0^1 x \\, dx = \\frac{1}{2}',
  '$$',
  '',
  '第四段：块公式之后的正文。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '第五段正文。',
  '',
  '![巡走图片](shot-walk.png)',
  '',
  '第六段：图片之后的正文。',
  '',
  '| 表头甲 | 表头乙 |',
  '| --- | --- |',
  '| 单元甲 | 单元乙 |',
  '',
  '末段：巡走收尾。',
  '',
].join('\n');

/** 每次按键后的完整状态：位置 + 节点身份 + 隐藏判定 + 几何。 */
const STATE = `(() => { const w = ${IF}; const d = w && w.document; if (!d) return { 无窗口: true };
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const s = w.getSelection();
  if (!surface) return { 无编辑面: true };
  if (!s || !s.rangeCount) return { 无选区: true, 焦点: d.hasFocus() };
  const r = s.getRangeAt(0);
  const node = r.startContainer, off = r.startOffset;
  const el = node.nodeType === 3 ? node.parentElement : node;
  let top = node; while (top && top.parentElement && top.parentElement !== surface) top = top.parentElement;
  const bi = top && top.parentElement === surface ? [...surface.children].indexOf(top) : -1;
  const 路径 = [];
  for (let n = el; n && n !== surface; n = n.parentElement) {
    路径.unshift(n.nodeName.toLowerCase()
      + (n.dataset && n.dataset.type ? '[' + n.dataset.type + ']' : '')
      + (n.className && typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
  }
  let 隐藏 = null;
  for (let n = el; n && n !== surface; n = n.parentElement) {
    if (n.classList && (n.classList.contains('katex-mathml') || n.classList.contains('vditor-ir__marker'))) 隐藏 = 隐藏 || (n.classList.contains('katex-mathml') ? 'katex-mathml' : 'marker');
    const cs = w.getComputedStyle(n);
    if (cs.clip && cs.clip !== 'auto' && cs.clip !== 'none') 隐藏 = 隐藏 || ('clip:' + cs.clip);
    if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') 隐藏 = 隐藏 || 'aria-hidden';
  }
  const box = r.getBoundingClientRect();
  let 前缀 = null, 块长 = null, 文本图 = [];
  if (bi >= 0) {
    const whole = d.createRange(); whole.selectNodeContents(top);
    块长 = whole.toString().length;
    const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(node, off);
    前缀 = pre.toString().length;
    const walker = d.createTreeWalker(top, NodeFilter.SHOW_TEXT); let n, acc = 0;
    while ((n = walker.nextNode())) {
      const parent = n.parentElement;
      const cls = parent ? String(parent.className || '').trim().split(/\\s+/).slice(0, 2).join('.') : '';
      const hidden = !!(parent && parent.closest && (parent.closest('.katex-mathml') || parent.closest('[aria-hidden="true"]')));
      文本图.push({ 区间: [acc, acc + n.data.length], 节点: parent ? parent.nodeName.toLowerCase() + (cls ? '.' + cls : '') : '?', 隐藏: hidden, 文: n.data.slice(0, 26) });
      acc += n.data.length;
    }
  }
  return { 块: bi, 前缀, 块长, 节点: node.nodeType === 3 ? 'TEXT' : node.nodeName + '.' + String(node.className || ''), 偏移: off,
    文字: node.nodeType === 3 ? String(node.data).slice(0, 40) : String(node.textContent).slice(0, 40),
    路径: 路径.join(' < '), 隐藏, 盒: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
    焦点: d.hasFocus(), 文本图: 文本图.slice(0, 14) }; })()`;

const j = v => JSON.stringify(v, null, 1);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-walk.png'), hi.fixtures.png(120, 80, [150, 90, 200]));
  const file = path.join(OUT, 'walk.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({
      exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-f9', outDir: OUT, timeout: 300000, ...options, args: options.args || [],
    }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 12, settleMs: 1800 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    const info = await session.js(`(() => { const w = ${IF}, d = w.document; const s = d.querySelector(${JSON.stringify(SURFACE)});
      return { 块数: s.children.length, 各块: [...s.children].map((b, i) => ({ i, 标签: b.tagName, 类型: b.getAttribute('data-type') || '', md: String(b.textContent).replace(/\\s+/g, ' ').slice(0, 46) })) }; })()`);
    say('【结构】' + j(info));

    // ── ① → 巡走 ────────────────────────────────────────────────────────────────
    await hi.ensureFocus(session);
    await hi.press(session, 'Home', { modifiers: hi.MOD.ctrl });
    await harness.sleep(300);
    say('\n══ ① → 巡走（Ctrl+Home 起步）══');
    for (let i = 1; i <= 280; i++) {
      const before = await session.js(STATE);
      await hi.press(session, 'ArrowRight');
      await harness.sleep(90);
      const after = await session.js(STATE);
      const 简 = o => o && o.块 !== undefined && o.块 !== null && !o.无选区
        ? `块${o.块} 前${o.前缀}/${o.块长} 盒${JSON.stringify(o.盒)} ${o.路径 || ''}` : JSON.stringify(o);
      say(`→ 第 ${String(i).padStart(3)} 步  ${简(after)}`);
      if (AT.includes(i)) {
        say(`\n──→ 第 ${i} 步 ──`);
        say('  按键前：' + j(before));
        say('  按键后：' + j(after));
        if (i === AT[0]) await session.shot('f9-右走-第' + i + '步');
      }
      if (!after || after.无选区 || after.块 === -1) { say(`\n！！第 ${i} 步后光标无效：` + j(after)); break; }
      if (after.块 >= info.块数 - 1 && after.前缀 >= after.块长) { say(`\n（第 ${i} 步到文末：块 ${after.块} 前缀 ${after.前缀}/${after.块长}）`); break; }
    }
    await session.shot('f9-右走-终点');

    // ── ② ← 巡走 ────────────────────────────────────────────────────────────────
    await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
    await harness.sleep(300);
    say('\n══ ② ← 巡走（Ctrl+End 起步）══');
    for (let i = 1; i <= 120; i++) {
      const before = await session.js(STATE);
      await hi.press(session, 'ArrowLeft');
      await harness.sleep(90);
      const after = await session.js(STATE);
      say(`← 第 ${String(i).padStart(3)} 步  ${after && after.块 !== null && after.块 !== undefined && !after.无选区
        ? `块${after.块} 前${after.前缀}/${after.块长} 盒${JSON.stringify(after.盒)} ${after.路径 || ''}` : JSON.stringify(after)}`);
      if (LEFT_AT.includes(i)) {
        say(`\n──← 第 ${i} 步 ──`);
        say('  按键前：' + j(before));
        say('  按键后：' + j(after));
      }
      if (!after || after.无选区 || after.块 === -1) { say(`\n！！第 ${i} 步后光标无效：` + j(after)); await session.shot('f9-左走-丢光标'); break; }
    }
    await session.shot('f9-左走-终点');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('\n（完整轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
