/** 探针 · F4 长按 ↓ 丢步：逐发采样"这一发到底走没走"，再读纵向补丁自己的决策轨迹。
 *
 *  交接件读数：17 发 ↓ 只走 13 行（76%），30ms/60ms 同值、终点固定，→/退格/Shift+→ 不丢。
 *  本探针把"丢的那几发"钉到具体位置：每发之后记 (块号, 光标矩形, 是否可见)，
 *  同时打开 `window.__vertTraceOn`（纵向补丁的环形轨迹：每发扫描的起点/扫到的 y/命中行）。
 *
 *  用法：node scripts/acceptance/probe-f4-hold-steps.cjs [--app=dev|installed] [--times=20] [--interval=60]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-f4');
const IF = hi.IF, SURFACE = hi.SURFACE;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const TIMES = Number(ARG('times', '20'));
const INTERVAL = Number(ARG('interval', '60'));

const LINES = Array.from({ length: 16 }, (_, i) => `L${String(i + 1).padStart(2, '0')} 甲乙丙丁戊己庚辛壬癸`);
const ASCII_LINE = 'A01 englishlineabcdefghijkmnopqrstuvwxyz尾巴';
const LAST_LINE = 'L99 收尾专用尾巴文字有长度';
const BODY = [...LINES, ASCII_LINE, LAST_LINE].join('\n\n') + '\n';
const START = 2;

const 采 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 无选区: true };
  const r = sel.getRangeAt(0); const n = r.startContainer;
  let top = n; while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  const 块 = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
  const box = r.getBoundingClientRect();
  const pre = d.createRange(); pre.selectNodeContents(top || s); pre.setEnd(n, r.startOffset);
  const 上级 = n.nodeType === 3 ? n.parentElement : n;
  return { 块, 前缀: pre.toString().length, 偏移: r.startOffset,
    层: n.nodeType === 3 ? (上级?.closest?.('code[data-type]') ? '源码' : 上级?.closest?.('.vditor-ir__marker,[data-type$="-marker"]') ? '围栏' : '正文') : '元素级',
    盒: [Math.round(box.left), Math.round(box.top), Math.round(box.height)],
    视口: (() => { const s2 = d.querySelector('${SURFACE}'); const ir = d.querySelector('.vditor-ir');
      const b2 = s2 ? s2.getBoundingClientRect() : null;
      return { 窗高: w.innerHeight, 面: b2 ? [Math.round(b2.top), Math.round(b2.bottom)] : null,
        面滚: s2 ? Math.round(s2.scrollTop) : null, 面内容高: s2 ? Math.round(s2.scrollHeight) : null,
        ir滚: ir ? Math.round(ir.scrollTop) : null, 文档滚: Math.round(w.scrollY) }; })() }; })()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'repeat.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-f4', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 17, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    await session.js(`(() => { const w = ${hi.IF}; w.__vertTraceOn = true; w.__vtrace = []; return 1; })()`);
    await session.js(hi.placeCaretAt(START, 4));
    await hi.sleep(200);
    const 起点 = await session.js(采);
    say(`起点 ${JSON.stringify(起点)}  连发 ${TIMES} 次 @${INTERVAL}ms`);

    const 序列 = [];
    await session.js(`(() => { const w = ${hi.IF}; w.__sent = []; return 1; })()`);
    await hi.hold(session, 'ArrowDown', { times: TIMES, interval: INTERVAL, onEvery: { every: 1, run: async i => {
      const s = await session.js(采);
      序列.push({ 发: i, 块: s && s.块, 盒: s && s.盒, 前缀: s && s.前缀, 层: s && s.层 });
    } } });
    await hi.sleep(400);
    const 终点 = await session.js(采);
    say('\n【逐发落点】');
    let 上 = 起点;
    for (const s of 序列) {
      const 动 = s.块 !== null && 上 && 上.块 !== null ? (s.块 - 上.块) : null;
      const v = s.视口 || {};
      say(`   第 ${String(s.发).padStart(2)} 发  块${s.块} 前缀${s.前缀} 盒${JSON.stringify(s.盒)} 面滚${v.面滚} 面内容${v.面内容高} 面底${v.面 && v.面[1]} 窗高${v.窗高} ${动 === 0 ? '← 没动！' : 动 !== null && 动 > 1 ? `← 跳了 ${动} 行` : ''}`);
      上 = s;
    }
    say(`\n终点 ${JSON.stringify(终点)}`);

    // ── 假设验证：停住是不是因为"下一行在可视区之外" ──────────────────────────
    say('\n【假设验证】把滚动容器往下滚 120px，再按一次 ↓');
    const 滚前 = await session.js(采);
    await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${SURFACE}');
      s.scrollTop += 120; return s.scrollTop; })()`);
    await hi.sleep(250);
    await hi.press(session, 'ArrowDown');
    await hi.sleep(250);
    const 滚后 = await session.js(采);
    say('   滚动前 ' + JSON.stringify({ 块: 滚前.块, 盒: 滚前.盒, 面滚: 滚前.视口.面滚 }));
    say('   滚动后 ' + JSON.stringify({ 块: 滚后.块, 盒: 滚后.盒, 面滚: 滚后.视口.面滚 }) + (滚后.块 !== 滚前.块 ? '  → 能走了：卡死与"下一行在可视区外"一致' : '  → 还是不动'));
    await session.shot('f4-滚动验证');

    // ── ② 到底之后再长按 ↑ 回顶：目标列在整条往返里必须守住 ────────────────────
    await session.js(hi.placeCaretAt(START, 4));
    await hi.sleep(200);
    const 出发 = await session.js(采);
    say(`\n【往返】出发 块${出发.块} x=${出发.盒[0]} 面滚${出发.视口.面滚}`);
    await session.js(`(() => { const w = ${hi.IF}; w.__vtrace = []; return 1; })()`);
    const 下行 = [];
    await hi.hold(session, 'ArrowDown', { times: 17, interval: 60, onEvery: { every: 1, run: async i => {
      const s = await session.js(采); 下行.push({ 发: i, 块: s.块, x: s.盒[0], 滚: s.视口.面滚 });
    } } });
    await hi.sleep(300);
    const 下行末 = 下行[下行.length - 1];
    say('  ↓ 17 发：' + 下行.map(s => `${s.块}@${s.x}`).join(' → '));
    say(`  ↓ 终点 块${下行末.块} x=${下行末.x} 滚${下行末.滚}（出发 x=${出发.盒[0]}）`);
    const 上行 = [];
    await hi.hold(session, 'ArrowUp', { times: 17, interval: 60, onEvery: { every: 1, run: async i => {
      const s = await session.js(采); 上行.push({ 发: i, 块: s.块, x: s.盒[0], 滚: s.视口.面滚 });
    } } });
    await hi.sleep(300);
    const 终点2 = await session.js(采);
    say('  ↑ 17 发：' + 上行.map(s => `${s.块}@${s.x}`).join(' → '));
    say(`  ↑ 终点 块${终点2.块} x=${终点2.盒[0]} 滚${终点2.视口.面滚}`);
    const 列丢 = 上行.filter(s => Math.abs(s.x - 出发.盒[0]) > 5);
    say(`  列偏离出发列(x=${出发.盒[0]}) 的按键：${列丢.length ? 列丢.map(s => `第${s.发}发→块${s.块}@${s.x}`).join('，') : '无'}`);
    const 轨迹2 = await session.js(`(() => { const w = ${hi.IF}; return (w.__vtrace || []).slice(-14); })()`);
    say('【往返期间的轨迹】');
    for (const t of (轨迹2 || [])) say('   ' + t);
    await session.shot('f4-往返');
    const 有效 = 起点 && 终点 ? 终点.块 - 起点.块 : null;
    say(`\n【汇总】连发 ${TIMES} 发 → 块位移 ${有效}（${((有效 || 0) / TIMES * 100).toFixed(0)}%）；文档共 18 块（0-17）`);

    const 轨迹 = await session.js(`(() => { const w = ${hi.IF}; return (w.__vtrace || []).slice(-40); })()`);
    say('\n【纵向补丁轨迹】（最后 40 条）');
    for (const t of (轨迹 || [])) say('   ' + t);
    await session.shot('f4-终点');
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
