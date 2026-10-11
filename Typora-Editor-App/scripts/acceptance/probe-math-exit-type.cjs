/** 探针 · 复现"光标在展开的行内公式源码末尾 → 按方向键右键 → 键入 → 字跳回公式内部"。
 *  四种变体各跑一遍，每遍都读：字符落在哪个节点、公式源码有没有变长、磁盘上的 md 长什么样。
 *
 *  用法：node scripts/acceptance/probe-math-exit-type.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-math-exit-type');
const IF = hi.IF, SURFACE = hi.SURFACE;

/** 与用户截图同一形态：行内公式收在段末（源码 `$s_n=L(2n-1)k$`，同一段里前面还有一条）。 */
const BODY = [
  '# 行程问题', '',
  '甲在第n次相遇走的路程记为 $s_n$，则 $s_n=L(2n-1)k$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

/** 读：光标在哪 + **公式节点内的文本** + 段外文本（两者对比就知道字落在里还是外）。 */
const 读 = `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  const s = d.querySelector('${hi.SURFACE}');
  const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const owner = 全部[全部.length - 1];
  const 源码 = owner && owner.querySelector('code[data-type]') ? owner.querySelector('code[data-type]').textContent : null;
  const 节点内文本 = owner ? owner.textContent : null;
  const 段 = owner && owner.closest('p');
  const 段外文本 = 段 && owner ? (() => { let out = ''; for (const n of 段.childNodes) { if (n === owner) continue; out += n.textContent || ''; } return out; })() : null;
  if (!sel || !sel.rangeCount) return { 选区: null, 源码, 节点内文本, 段外文本 };
  const n = sel.focusNode, o = sel.focusOffset;
  const at = n.nodeType === 3 ? n.parentElement : n;
  const 内 = !!(at && at.closest && at.closest('.vditor-ir__node[data-type="inline-node"]'));
  return { 层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,li,h1,h2,h3,h4,h5,h6') ? '正文' : '元素级',
    容器: n.nodeType === 3 ? 'TEXT(' + n.data.length + ')' + JSON.stringify(n.data) : n.nodeName + '.' + String(n.className || '').slice(0, 22),
    偏移: o, 在公式节点内: 内,
    父链: (() => { const out = []; let cur = at; let i = 0;
      while (cur && i < 4) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '') + (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(' ')[0] : '')); cur = cur.parentElement; i++; }
      return out.join(' < '); })(),
    源码, 节点内文本, 段外文本,
    展开数: 全部.filter(x => x.classList.contains('vditor-ir__node--expand')).length }; })()`;

const 定位 = `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const 全部 = [...s.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
  const owner = 全部[全部.length - 1];
  if (!owner) return { ok: false };
  const b = owner.getBoundingClientRect();
  return { ok: true, 中: Math.round(frame.x + b.left + b.width / 2), 右缘: Math.round(frame.x + b.right),
    y: Math.round(frame.y + b.top + b.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'exit-type.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-math-exit-type', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  const 真键打字 = (session, ch) => session.key({ key: ch, code: 'Key' + ch, vk: ch.charCodeAt(0), text: ch });
  try {
    const session = await hi.openDoc(ctx, file, { minBlocks: 3, settleMs: 1500 });
    await hi.ensureFocus(session);
    /** 把光标放到"展开态源码末尾"：点公式 → End。 */
    const 到源码末尾 = async () => {
      const g = await session.js(定位);
      await session.click(g.中, g.y);
      await hi.sleep(350);
      await hi.press(session, 'End');
      await hi.sleep(300);
      return session.js(读);
    };

    say('【起点】' + JSON.stringify(await 到源码末尾()));

    // V1：源码末尾 → 一次 → → 真键打 "Z"
    say('\n══ V1：源码末尾 →(1次) → 真键 Z ══');
    await hi.press(session, 'ArrowRight');
    await hi.sleep(250);
    say('  → 之后：' + JSON.stringify(await session.js(读)));
    await 真键打字(session, 'Z');
    await hi.sleep(400);
    say('  打字后：' + JSON.stringify(await session.js(读)));

    // V2：重置 → 源码末尾 → 两次 → → 真键打 "Y"
    say('\n══ V2：源码末尾 →(2次) → 真键 Y ══');
    say('  重置：' + JSON.stringify(await 到源码末尾()));
    await hi.press(session, 'ArrowRight');
    await hi.sleep(200);
    await hi.press(session, 'ArrowRight');
    await hi.sleep(250);
    say('  →→ 之后：' + JSON.stringify(await session.js(读)));
    await 真键打字(session, 'Y');
    await hi.sleep(400);
    say('  打字后：' + JSON.stringify(await session.js(读)));

    // V3：源码末尾 → 一次 → → 立刻打（不等待）"X"
    say('\n══ V3：源码末尾 →(1次) → 立刻真键 X（不等待）══');
    say('  重置：' + JSON.stringify(await 到源码末尾()));
    await session.key({ key: 'ArrowRight', code: 'ArrowRight', vk: 39 });
    await 真键打字(session, 'X');
    await hi.sleep(450);
    say('  打字后：' + JSON.stringify(await session.js(读)));

    // V4：源码末尾 → 一次 → → insertText 打 "W"
    say('\n══ V4：源码末尾 →(1次) → insertText W ══');
    say('  重置：' + JSON.stringify(await 到源码末尾()));
    await hi.press(session, 'ArrowRight');
    await hi.sleep(250);
    await session.type('W');
    await hi.sleep(450);
    say('  打字后：' + JSON.stringify(await session.js(读)));

    // V5：**点公式右半**进源码（用户更可能的入口）→ End → → → 真键 "P"
    say('\n══ V5：点公式右缘内侧进源码 → End → → → 真键 P ══');
    const g5 = await session.js(定位);
    await session.click(g5.右缘 - 12, g5.y);
    await hi.sleep(400);
    say('  点右缘内侧 12px：' + JSON.stringify(await session.js(读)));
    await hi.press(session, 'End');
    await hi.sleep(250);
    await hi.press(session, 'ArrowRight');
    await hi.sleep(250);
    say('  → 之后：' + JSON.stringify(await session.js(读)));
    await 真键打字(session, 'P');
    await hi.sleep(400);
    say('  打字后：' + JSON.stringify(await session.js(读)));

    // V6：中文输入法通道（composition）：光标在围栏上，用 IME 上屏一个 "Q"
    say('\n══ V6：源码末尾 → →(到围栏上) → IME 组字上屏 Q ══');
    say('  重置：' + JSON.stringify(await 到源码末尾()));
    await hi.press(session, 'ArrowRight');
    await hi.sleep(250);
    const 前6 = await session.js(读);
    say('  落点：' + JSON.stringify({ 容器: 前6.容器, 偏移: 前6.偏移, 在公式节点内: 前6.在公式节点内 }));
    await session.send('Input.imeSetComposition', { text: 'q', selectionStart: 1, selectionEnd: 1 });
    await hi.sleep(200);
    await session.send('Input.insertText', { text: 'Q' });
    await hi.sleep(450);
    say('  上屏后：' + JSON.stringify(await session.js(读)));

    const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
    const disk = String(saved.after).replace(/\r/g, '');
    say('\n【磁盘】' + JSON.stringify(disk.slice(0, 160)));
    for (const ch of ['Z', 'Y', 'X', 'W', 'P', 'Q']) {
      if (!disk.includes(ch)) { say(`  ${ch}：磁盘里没有 ✗（被吞了？）`); continue; }
      const 在公式里 = new RegExp('\\$[^$\\n]*' + ch + '[^$\\n]*\\$').test(disk);
      say(`  ${ch}：` + (在公式里 ? '落在 $…$ **里面** ✗' : '在 $…$ 外面 ✓'));
    }
    await ctx.release(session);
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
