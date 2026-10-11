/** 探针 · 折叠态点"公式右缘内侧"到底是谁把光标送进源码的：
 *  逐步 dump 祖先链 + 三个补丁自己的标记（`__typoraInlineMathClick` / `__typoraClickIntoFormula`）
 *  + 合成光标日记，逐个排除。
 *
 *  用法：node scripts/acceptance/probe-inline-math-owner.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-inline-math-owner');
const IF = hi.IF, SURFACE = hi.SURFACE;
const BODY = [
  '# 行程问题', '',
  '纵向时刻表，横向：路程/速度=时间', '',
  '循环往返问题：对侧相向出发：$S=L(2n-1)$', '',
  '错时接送问题：接者省时距离是慢者出发地到相遇地距离的2倍。', '',
].join('\n');

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'owner.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-inline-math-owner', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const 链 = await session.js(`(() => { const w = ${IF}, d = w.document; const s = d.querySelector(${JSON.stringify(SURFACE)});
      const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
      const 描 = n => n.nodeName + (n.getAttribute && n.getAttribute('data-type') ? '[dt=' + n.getAttribute('data-type') + ']' : '')
        + (typeof n.className === 'string' && n.className ? '.' + n.className.replace(/ /g, '.') : '');
      const 上行 = []; let cur = owner; while (cur && 上行.length < 12) { 上行.push(描(cur)); cur = cur.parentElement; }
      const 段 = owner.closest('p');
      const 侧链 = []; cur = 段; while (cur && 侧链.length < 12) { 侧链.push(描(cur)); cur = cur.parentElement; }
      const pre = owner.querySelector('[data-type="text-open-marker"]');
      const code = owner.querySelector('code[data-type="math-inline"]');
      return {inline链: 上行, p链: 侧链, 子节点: [...owner.childNodes].map(n => 描(n) + (n.nodeType === 3 ? '(len' + n.data.length + ')' : '')),
        段子节点: [...段.childNodes].map(n => 描(n) + (n.nodeType === 3 ? '(len' + n.data.length + ')' : '')),
        preview样式: (() => { const pv = owner.querySelector('.vditor-ir__preview'); if (!pv) return null;
          const st = w.getComputedStyle(pv); return {pointerEvents: st.pointerEvents, display: st.display, visibility: st.visibility}; })(),
        code样式: (() => { if (!code) return null; const st = w.getComputedStyle(code);
          return {pointerEvents: st.pointerEvents, display: st.display, width: st.width, height: st.height}; })()}; })()`);
    say('inline 链：' + 链.inline链.join(' < '));
    say('p 链：' + 链.p链.join(' < '));
    say('inline 子节点：' + JSON.stringify(链.子节点));
    say('段子节点：' + JSON.stringify(链.段子节点));
    say('preview 样式：' + JSON.stringify(链.preview样式) + '  code 样式：' + JSON.stringify(链.code样式));
    const 复位 = async () => {
      const p = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const s = d.querySelector(${JSON.stringify(SURFACE)});
        const 段 = [...s.children].find(n => n.textContent.includes('错时接送'));
        const walker = d.createTreeWalker(段, NodeFilter.SHOW_TEXT); let n = null;
        while (walker.nextNode()) if (walker.currentNode.data.length > 3) { n = walker.currentNode; break; }
        const r = d.createRange(); r.setStart(n, 2); r.setEnd(n, 3); const b = r.getBoundingClientRect();
        return {x: Math.round(frame.x + b.left), y: Math.round(frame.y + b.top + b.height / 2)}; })()`);
      await session.click(p.x, p.y);
      await harness.sleep(200);
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
      await harness.sleep(250);
    };
    const 探 = async 标签 => {
      const 读 = await session.js(`(() => { const w = ${IF};
        const sel = w.getSelection(); const n = sel && sel.focusNode;
        const at = n ? (n.nodeType === 3 ? n.parentElement : n) : null;
        return {光标: n ? {层: at.closest?.('code[data-type]') ? '源码' : at.closest?.('p,h1,h2,h3') ? '正文' : '元素级',
            容器: n.nodeType === 3 ? 'TEXT' : n.nodeName, 偏移: sel.focusOffset,
            在公式内: !!at.closest?.('.vditor-ir__node[data-type="inline-node"]')} : null,
          展开: !!w.document.querySelector('.vditor-ir__node[data-type="inline-node"].vditor-ir__node--expand'),
          标记1: w.__typoraInlineMathClick || null, 标记2: w.__typoraClickIntoFormula || null,
          日记: (w.__caretProxyLog || []).slice(-2)}; })()`);
      say(`【${标签}】` + JSON.stringify(读));
    };
    for (const dx of [-20, -6, -2.5, -1.5, -0.5]) {
      await 复位();
      const g = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const s = d.querySelector(${JSON.stringify(SURFACE)}); const owner = s.querySelector('.vditor-ir__node[data-type="inline-node"]');
        const b = owner.getBoundingClientRect();
        const x = Math.round(frame.x + b.right + ${dx}); const y = Math.round(frame.y + b.top + b.height / 2);
        const el = d.elementFromPoint(x, y);
        return {x, y, 命中: el ? el.nodeName + (el.getAttribute?.('data-type') ? '[' + el.getAttribute('data-type') + ']' : '') + (typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') : null}; })()`);
      await session.js(`(() => { const w = ${IF}; delete w.__typoraInlineMathClick; delete w.__typoraClickIntoFormula; return 1; })()`);
      say(`\n── dx=${dx} 点(${g.x},${g.y}) 命中元素=${g.命中} ──`);
      await session.click(g.x, g.y);
      await harness.sleep(350);
      await 探('点后 350ms');
      await harness.sleep(400);
      await 探('点后 750ms');
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'trace.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（轨迹：' + path.join(OUT, 'trace.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
