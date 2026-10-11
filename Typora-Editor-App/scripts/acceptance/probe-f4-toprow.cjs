/** 探针 · F4 附：↑ 回顶到最后两行时**列被钳成行首**（x=74 → 46）。
 *
 *  纵向补丁的轨迹显示：目标行明明在可视区里（box [46,14,16]），但 `caretRangeFromPoint` 在
 *  x=74/66/82/58/90/42 全部不可用，只有 x=0 能用（拿回行首 46）。这一支把那一带的
 *  **命中测试**与**覆盖元素**（elementFromPoint）逐点打出来，定位"是谁挡在那儿"。
 *
 *  用法：node scripts/acceptance/probe-f4-toprow.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-f4-toprow');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

const LINES = Array.from({ length: 16 }, (_, i) => `L${String(i + 1).padStart(2, '0')} 甲乙丙丁戊己庚辛壬癸`);
const BODY = [...LINES, 'A01 englishlineabcdefghijkmnopqrstuvwxyz尾巴', 'L99 收尾专用尾巴文字有长度'].join('\n\n') + '\n';

/** 在 (x,y) 上做两件事：caretRangeFromPoint 拿到什么、elementFromPoint 是谁挡着。 */
const 探 = (x, y) => `(() => { const w = ${IF}, d = w.document;
  const 描 = n => { if (!n) return null; const p = []; let c = n.nodeType === 3 ? n.parentElement : n;
    while (c && p.length < 4) { p.push(c.nodeName.toLowerCase() + (c.className && typeof c.className === 'string' && c.className.trim() ? '.' + c.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')); c = c.parentElement; }
    return p.join(' < '); };
  const hit = d.caretRangeFromPoint ? d.caretRangeFromPoint(${x}, ${y}) : null;
  const box = hit ? hit.getBoundingClientRect() : null;
  const el = d.elementFromPoint ? d.elementFromPoint(${x}, ${y}) : null;
  const eb = el ? el.getBoundingClientRect() : null;
  const cs = el ? w.getComputedStyle(el) : null;
  return { 点: [${x}, ${y}],
    命中: hit ? { 容器: hit.startContainer.nodeType === 3 ? 'TEXT' : hit.startContainer.nodeName, 偏移: hit.startOffset,
      路径: 描(hit.startContainer), 盒: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)] : null } : null,
    覆盖: el ? { 路径: 描(el), 类: String(el.className || '').slice(0, 40), 盒: eb ? [Math.round(eb.left), Math.round(eb.top), Math.round(eb.width), Math.round(eb.height)] : null,
      display: cs.display, z: cs.zIndex, pe: cs.pointerEvents, pos: cs.position } : null }; })()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'toprow.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-f4-toprow', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 17, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    await session.js(hi.placeCaretAt(2, 4));
    await hi.sleep(200);
    await hi.hold(session, 'ArrowDown', { times: 17, interval: 60 });
    await hi.sleep(300);
    await hi.hold(session, 'ArrowUp', { times: 17, interval: 60 });
    await hi.sleep(400);
    const 态 = await session.js(`(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
      const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      const box = r ? r.getBoundingClientRect() : null; const fr = s.getBoundingClientRect();
      return { 面框: [Math.round(fr.top), Math.round(fr.bottom)], 面滚: Math.round(s.scrollTop),
        光标盒: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.height)] : null,
        各块: [...s.children].map((b, i) => ({ i, 顶: Math.round(b.getBoundingClientRect().top), 文: String(b.textContent).slice(0, 14) })).filter(b => b.顶 > -30 && b.顶 < 60) }; })()`);
    say('【往返之后的状态】' + JSON.stringify(态));
    for (const y of [态.光标盒 ? 态.光标盒[1] : 14, 27, 40, 55]) {
      for (const x of [0, 46, 60, 74, 90, 140]) {
        const r = await session.js(探(x, y));
        say(`  点(${x},${y})  命中=${r.命中 ? r.命中.路径 + '@' + r.命中.偏移 + ' ' + JSON.stringify(r.命中.盒) : 'null'}`);
        if (r.覆盖 && r.覆盖.路径) say(`           覆盖=${r.覆盖.路径} 类=${r.覆盖.类} 盒=${JSON.stringify(r.覆盖.盒)} display=${r.覆盖.display} pos=${r.覆盖.pos} pe=${r.覆盖.pe} z=${r.覆盖.z}`);
      }
    }
    await session.shot('f4-toprow');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
