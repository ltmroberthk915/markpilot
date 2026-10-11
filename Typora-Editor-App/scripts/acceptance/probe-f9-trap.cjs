/** 探针 · F9 陷阱定点：独占一行公式（`$仅此独占一行的公式x+1$`）的行尾按 → **回到本行开头**，
 *  用户被卡在这一行里出不去（134 的 ① 巡走终点停在块 3 就是它）。
 *
 *  做法：给 Selection.prototype 的写入口全部装表（记调用栈），同时监听 selectionchange 记光标态；
 *  然后 Ctrl+Home 起步、逐次按 → 走到那块，把"陷阱那一下"的每一次选区写入连栈打出来。
 *
 *  用法：node scripts/acceptance/probe-f9-trap.cjs [--app=dev|installed] [--block=3] [--steps=90]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-f9-trap');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const BLOCK = Number(ARG('block', '3'));
const STEPS = Number(ARG('steps', '90'));
const LEFT_STEPS = Number(ARG('left', '16'));

const BODY = [
  '# 巡走文档标题', '',
  '第一段：普通中文与 english 混排文字。', '',
  '第二段：行内公式 $a+b=c$ 夹在中间的文字。', '',
  '$仅此独占一行的公式x+1$', '',
  '第三段：公式之后的正文。', '',
  '$$', '\\int_0^1 x \\, dx = \\frac{1}{2}', '$$', '',
  '第四段：块公式之后的正文。', '',
  '- 列表项甲', '- 列表项乙', '',
  '第五段正文。', '',
  '![巡走图片](shot-walk.png)', '',
  '第六段：图片之后的正文。', '',
  '| 表头甲 | 表头乙 |', '| --- | --- |', '| 单元甲 | 单元乙 |', '',
  '末段：巡走收尾。', '',
].join('\n');

/** 位置读数（同 134 口径，用 toString 前缀）。 */
const POS = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector(${JSON.stringify(SURFACE)});
  const sel = w.getSelection();
  if (!s || !sel || !sel.rangeCount) return { 无选区: true };
  const r = sel.getRangeAt(0);
  const 节点 = r.startContainer; const el = 节点.nodeType === 3 ? 节点.parentElement : 节点;
  let top = 节点; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  const bi = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
  const whole = d.createRange(); whole.selectNodeContents(top || s);
  const pre = d.createRange(); pre.selectNodeContents(top || s); pre.setEnd(节点, r.startOffset);
  const box = r.getBoundingClientRect();
  return { 块: bi, 前缀: pre.toString().length, 块长: whole.toString().length,
    容器: 节点.nodeType === 3 ? 'TEXT' : 节点.nodeName + '.' + String(节点.className || '').slice(0, 24),
    偏移: r.startOffset, 折叠: r.collapsed,
    路径: (() => { const p = []; for (let n = el; n && n !== s; n = n.parentElement)
      p.unshift(n.nodeName.toLowerCase() + (n.dataset && n.dataset.type ? '[' + n.dataset.type + ']' : '')); return p.join('<'); })(),
    x: Math.round(box.left), y: Math.round(box.top), h: Math.round(box.height) }; })()`;

/** 装表：Selection 写入口 + selectionchange 时间线。 */
const HOOK = `(() => { const w = ${IF}; const d = w.document;
  if (!w.__f9) w.__f9 = { 写: [], 变: [], 标记: [] };
  const F = w.__f9; F.写 = []; F.变 = []; F.标记 = [];
  F.t0 = w.performance.now();
  const P = w.Selection && w.Selection.prototype;
  if (P && !P.__f9Wrapped) { P.__f9Wrapped = true;
    for (const name of ['addRange', 'removeAllRanges', 'collapse', 'setBaseAndExtent', 'extend', 'empty', 'setStart', 'setEnd', 'setPosition']) {
      const orig = P[name]; if (typeof orig !== 'function') continue;
      P[name] = function (...a) { try {
        const 栈 = String(new w.Error().stack || '').split('\\n').slice(2, 6)
          .map(l => l.trim().replace(/^at\\s+/, '').replace(/\\s*\\(.*?([^\\/\\\\]+:\\d+:\\d+)\\)?$/, ' @$1')).join(' | ');
        F.写.push({ t: Math.round(w.performance.now() - F.t0), 谁: name,
          参: a.map(v => v && v.nodeType ? (v.nodeType === 3 ? 'TEXT' : v.nodeName + '.' + String(v.className || '').slice(0, 18)) : String(v)).join(',').slice(0, 120), 栈: 栈.slice(0, 420) }); } catch (e) {}
        return orig.apply(this, a); };
    }
  }
  if (!F.有变) { F.有变 = true;
    d.addEventListener('selectionchange', () => { try {
      const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const n = r ? r.startContainer : null;
      F.变.push({ t: Math.round(w.performance.now() - F.t0),
        位置: n ? (n.nodeType === 3 ? 'TEXT@' + r.startOffset + '「' + String(n.data).slice(0, 18) + '」' : n.nodeName + '.' + String(n.className || '').slice(0, 20) + '@' + r.startOffset) : '（无选区）' }); } catch (e) {} }, true);
  }
  return 1; })()`;

const READ = `(() => { const F = ${IF}.__f9; if (!F) return null;
  return { 写: F.写.slice(-40), 变: F.变.slice(-14), 标记: F.标记.slice(-20) }; })()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-walk.png'), hi.fixtures.png(120, 80, [150, 90, 200]));
  const file = path.join(OUT, 'walk.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-f9-trap', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 12, settleMs: 1800 });
  const out = [];
  const say = line => { console.log(line); out.push(line); };
  try {
    await hi.ensureFocus(session);
    await session.js(HOOK);
    await hi.press(session, 'Home', { modifiers: hi.MOD.ctrl });
    await harness.sleep(350);
    let 上一步 = await session.js(POS);
    say('起点：' + JSON.stringify(上一步));
    for (let i = 1; i <= STEPS; i++) {
      await session.js(`(() => { const F = ${IF}.__f9; F.写 = []; F.变 = []; F.标记.push(${i}); return 1; })()`);
      await hi.press(session, 'ArrowRight');
      await harness.sleep(110);
      const now = await session.js(POS);
      const 在目标块 = 上一步 && (上一步.块 === BLOCK || (now && now.块 !== 上一步.块));
      if (在目标块) {
        const 表 = await session.js(READ);
        say('\n══ 第 ' + i + ' 步：' + JSON.stringify(上一步) + '\n   →→ ' + JSON.stringify(now));
        for (const v of (表?.变 || [])) say('     · 选区变 ' + String(v.t).padStart(6) + 'ms  ' + v.位置);
        for (const x of (表?.写 || [])) say('     ✎ ' + String(x.t).padStart(6) + 'ms  ' + x.谁 + '(' + x.参 + ')\n         ' + x.栈);
      }
      if (!now || now.无选区 || now.块 === -1) { say('\n！！第 ' + i + ' 步后光标无效：' + JSON.stringify(now)); await session.shot('f9trap-无效'); break; }
      上一步 = now;
    }
    say('\n终点：' + JSON.stringify(上一步));
    await session.shot('f9trap-终点');

    // ── ③ ← 方向：从文末往回走，重点看"块首按 ← 落到哪" ──────────────────────────
    say('\n══ ③ ← 从文末往回走（每步全量记录，遇到无效位置不中断）══');
    await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
    await harness.sleep(350);
    let 左 = await session.js(POS);
    say('起点：' + JSON.stringify(左));
    let 无效数 = 0;
    for (let i = 1; i <= LEFT_STEPS; i++) {
      await session.js(`(() => { const F = ${IF}.__f9; F.写 = []; F.变 = []; F.标记.push(${i}); return 1; })()`);
      await hi.press(session, 'ArrowLeft');
      await harness.sleep(110);
      const now = await session.js(POS);
      const 原始 = await session.js(`(() => { const w = ${IF}, d = w.document; const s = w.getSelection();
        if (!s || !s.rangeCount) return { 无选区: true };
        const r = s.getRangeAt(0); const n = r.startContainer; const box = r.getBoundingClientRect();
        return { 容器: n.nodeType === 3 ? 'TEXT' : n.nodeName + '.' + String(n.className || '').slice(0, 22),
          偏移: r.startOffset, 折叠: r.collapsed, 矩形: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
          父: n.parentElement ? n.parentElement.nodeName + '.' + String(n.parentElement.className || '').slice(0, 22) : null }; })()`);
      say('\n── 第 ' + i + ' 步：' + JSON.stringify(左) + '\n   ←← ' + JSON.stringify(now) + '\n   原始 ' + JSON.stringify(原始));
      const 坏 = !now || now.无选区 || now.块 === -1 || (now && now.h === 0);
      if (坏) {
        无效数++;
        const 表 = await session.js(READ);
        for (const v of (表?.变 || [])) say('     · 选区变 ' + String(v.t).padStart(6) + 'ms  ' + v.位置);
        for (const x of (表?.写 || [])) say('     ✎ ' + String(x.t).padStart(6) + 'ms  ' + x.谁 + '(' + x.参 + ')\n         ' + x.栈);
        if (无效数 === 1) await session.shot('f9trap-左走-无效');
      }
      左 = now;
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), out.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
