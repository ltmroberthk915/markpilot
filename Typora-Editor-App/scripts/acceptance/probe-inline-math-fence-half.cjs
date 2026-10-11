/** 探针 · 用户 2026-10-01 第二轮更正的口径：**围栏外侧一半算公式外面**。
 *  展开态下，以右 `$`（围栏）盒的中线为界：中线右侧（含右半像素）→ 光标落公式之后；
 *  中线左侧 → 进源码编辑。左围栏对称：中线左侧 → 公式之前，右侧 → 进源码。
 *  逐格扫描（中线 ±1/±3/±6px），把"翻界线在哪"钉到像素。
 *
 *  用法：node scripts/acceptance/probe-inline-math-fence-half.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-inline-math-fence-half');
const IF = hi.IF, SURFACE = hi.SURFACE;
const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

/** 展开态的几何：owner / 两个围栏盒 / 各自的里外边界（页面坐标）+ 点击点。 */
const 几何 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
  if (!owner) return { ok: false };
  const b = owner.getBoundingClientRect();
  const 标 = [...owner.children].filter(子 => 子.nodeName === 'SPAN' && 子.classList.contains('vditor-ir__marker'));
  const 盒 = el => { const r = el.getBoundingClientRect(); return {l: Math.round(r.left), r: Math.round(r.right), 中: r.left + r.width / 2, w: Math.round(r.width)}; };
  const y = Math.round(frame.y + b.top + b.height / 2);
  return { ok: true, 展开: owner.classList.contains('vditor-ir__node--expand'),
    owner: {l: Math.round(b.left), r: Math.round(b.right)},
    左围栏: 标.length ? 盒(标[0]) : null, 右围栏: 标.length > 1 ? 盒(标[标.length - 1]) : null,
    frame: Math.round(frame.x), y }; })()`;

const 读 = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 选区: null };
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  const owner = at && at.closest ? at.closest('.vditor-ir__node[data-type="inline-node"]') : null;
  return { 层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('[data-type$="-marker"]') ? '围栏'
      : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级',
    容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' : n.nodeName, 偏移: o, 在公式内: !!owner,
    展开: !!d.querySelector('.vditor-ir__node[data-type="inline-node"].vditor-ir__node--expand') }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'fence-half.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-inline-math-fence-half', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  /** 进展开态：点行末空白 → 真实 ←。 */
  const 进展开 = async () => {
    const g = await session.js(几何);
    await session.click(g.frame + g.owner.r + 24, g.y);
    await hi.sleep(220);
    await session.key({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 });
    await hi.sleep(380);
  };
  try {
    await hi.ensureFocus(session);
    await 进展开();
    const g = await session.js(几何);
    say('展开态几何：owner=' + JSON.stringify(g.owner) + ' 左围栏=' + JSON.stringify(g.左围栏) + ' 右围栏=' + JSON.stringify(g.右围栏));
    say('（页面坐标；围栏中线＝里外翻界）\n');
    say('── 右围栏（右 `$`）：中线 ' + (g.右围栏 ? g.右围栏.中.toFixed(1) : '-') + ' ──');
    for (const dx of [-6, -3, -1, 1, 3, 6]) {
      await 进展开();
      const g2 = await session.js(几何);
      const x = Math.round(g2.frame + g2.右围栏.中 + dx);
      await session.click(x, g2.y);
      await hi.sleep(320);
      const r = await session.js(读);
      const 期望 = dx >= 0 ? '公式外（正文）' : '源码';
      say(`  dx=${String(dx).padStart(3)} x=${x} → 层=${r.层} 偏移=${r.偏移} 在公式内=${r.在公式内} 展开=${r.展开}   期望=${期望}`);
    }
    say('\n── 左围栏（左 `$`）：中线 ' + (g.左围栏 ? g.左围栏.中.toFixed(1) : '-') + ' ──');
    for (const dx of [-6, -3, -1, 1, 3, 6]) {
      await 进展开();
      const g2 = await session.js(几何);
      const x = Math.round(g2.frame + g2.左围栏.中 + dx);
      await session.click(x, g2.y);
      await hi.sleep(320);
      const r = await session.js(读);
      const 期望 = dx <= 0 ? '公式外（正文）' : '源码';
      say(`  dx=${String(dx).padStart(3)} x=${x} → 层=${r.层} 偏移=${r.偏移} 在公式内=${r.在公式内} 展开=${r.展开}   期望=${期望}`);
    }
    // 折叠态对照：渲染结果的右缘仍是边界（围栏没有像素）
    say('\n── 折叠态对照（围栏无像素，边界退回节点盒）──');
    await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
    await hi.sleep(300);
    await session.click(g.frame + g.owner.r + 24, g.y);
    await hi.sleep(300);
    const 折 = await session.js(几何);
    say('  折叠几何：owner=' + JSON.stringify(折.owner) + ' 左围栏=' + JSON.stringify(折.左围栏) + ' 右围栏=' + JSON.stringify(折.右围栏) + ' 展开=' + 折.展开);
    for (const dx of [-2, 2]) {
      await session.click(Math.round(折.frame + 折.owner.r + dx), 折.y);
      await hi.sleep(320);
      const r = await session.js(读);
      say(`  节点盒右缘 ${dx > 0 ? '+' : ''}${dx}px → 层=${r.层} 偏移=${r.偏移} 在公式内=${r.在公式内}`);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
