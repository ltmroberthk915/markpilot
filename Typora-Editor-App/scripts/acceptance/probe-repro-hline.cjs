/** "→ 在行尾遇到'整行只有一条行内公式'的下一行"该走到哪里？
 *   H3/H4 的红到底是产品跳行，还是"公式展开把光标那一行顶下去"造成的读数假象——这里验。
 *  用法：node scripts/acceptance/probe-repro-hline.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-hline');
const IF = `document.getElementById('editor').contentWindow`;

const 读数 = `(() => { const s = getSelection(); if (!s.rangeCount) return {无: true};
  const r = s.getRangeAt(0); const rect = r.getBoundingClientRect();
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const 块 = at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th');
  const 链 = (() => { const out = []; let cur = r.startContainer;
    while (cur && out.length < 4) { const cls = (typeof cur.className === 'string' ? cur.className : '').split(' ').filter(Boolean).slice(0, 1).join('.');
      out.push(cur.nodeName + (cur.nodeType === 3 ? '("' + String(cur.data).slice(0, 8) + '")' : (cls ? '.' + cls : ''))); cur = cur.parentNode; }
    return out.join(' < '); })();
  return {x: Math.round(rect.left), y: Math.round(rect.top), h: Math.round(rect.height), 偏移: r.startOffset, 链,
    层: at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏'
      : at.closest('code[data-type]') ? '源码' : '正文',
    所在块: 块 ? String(块.textContent || '').replace(/\s+/g, ' ').slice(0, 26) : null,
    展开的公式: [...document.querySelectorAll('.vditor-ir__node--expand')].map(n => String(n.textContent || '').replace(/\s+/g, ' ').slice(0, 18))}; })()`;

/** 把光标放到某块的首/尾。 */
const 放 = (文字, 首) => `(() => { const 块 = [...document.querySelectorAll('.vditor-ir .vditor-reset > p')]
    .find(p => (p.textContent || '').includes(${JSON.stringify(文字)}));
  if (!块) return null;
  const walker = document.createTreeWalker(块, NodeFilter.SHOW_TEXT, {acceptNode: t => {
    if (!t.data.trim()) return NodeFilter.FILTER_REJECT;
    const at = t.parentElement;
    return at.closest('.vditor-ir__preview,[data-type$="-marker"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }});
  let t = walker.nextNode(); if (!t) { const all = document.createTreeWalker(块, NodeFilter.SHOW_TEXT); t = all.nextNode(); }
  if (!t) return null;
  const r = document.createRange();
  r.setStart(t, ${首 ? 0 : 't.data.length'}); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  return {文本: String(t.data).slice(0, 16)}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, '公式行.md');
  fs.writeFileSync(doc, [
    '第一段文字在这里，写长一点方便落光标。',
    '',
    '$a+b$',
    '',
    '第二段文字在这里，也写长一点。',
    '',
    '再一段：行尾带公式 $x+y$ 的那种。',
    '',
    '第四段收尾。',
    '',
  ].join('\n'), 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-repro-hline', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 200000, interval: 100});
    await sleep(2200);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    const 行 = await session.js(`(() => { const out = [];
      for (const p of document.querySelectorAll('.vditor-ir .vditor-reset > p')) {
        const r = p.getBoundingClientRect();
        out.push({y: Math.round(r.top), 文本: String(p.textContent || '').replace(/\s+/g, ' ').slice(0, 22)}); }
      return out; })()`);
    console.log('段落布局：\n' + JSON.stringify(行, null, 1));
    for (const [标签, 文字, 首, 键] of [
      ['① 第一段末尾按 →', '第一段文字', false, 'ArrowRight'],
      ['② 第二段开头按 ←', '第二段文字', true, 'ArrowLeft'],
      ['③ 第三段末尾按 →（行尾是公式）', '再一段', false, 'ArrowRight'],
      ['④ 四段开头按 ←', '第四段收尾', true, 'ArrowLeft'],
      ['⑤ 第一段末尾按 ↓（下一行是整行公式）', '第一段文字', false, 'ArrowDown'],
      ['⑥ 第二段开头按 ↑（上一行是整行公式）', '第二段文字', true, 'ArrowUp'],
    ]) {
      // 用**真实点击**把光标放到目标行首/行尾（同时把焦点给编辑器——程序化落光标不给焦点，按键收不到）
      const 位 = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const 块 = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(p => (p.textContent || '').includes(${JSON.stringify(文字)}));
        if (!块) return null;
        块.scrollIntoView({block: 'center'});
        const r = 块.getBoundingClientRect();
        return {x: ${首 ? 'Math.round(r.left + 3)' : 'Math.round(r.right - 4)'}, y: Math.round(r.top + r.height / 2)}; })()`);
      if (!位) { console.log(`\n${标签}：找不到段落`); continue; }
      await session.click(frame.x + 位.x, frame.y + 位.y);
      await sleep(300);
      const 前 = await session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(读数)}); })()`);
      await session.key({key: 键, code: 键, vk: {ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38}[键]});
      await sleep(320);
      const 后 = await session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(读数)}); })()`);
      console.log(`\n${标签}：点(${位.x},${位.y})\n  前 ${JSON.stringify(前)}\n  后 ${JSON.stringify(后)}`);
      if (首) {   // 再按一次，看往返是否回到原位
        await session.key({key: 键 === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft', code: 'ArrowRight', vk: 39});
        await sleep(320);
        console.log('  回 ' + JSON.stringify(await session.js(`(() => { const w = ${IF}; return w.eval(${JSON.stringify(读数)}); })()`)));
      }
    }
    const shot = await session.send('Page.captureScreenshot', {format: 'png', clip: {x: frame.x, y: frame.y, width: frame.w, height: 420, scale: 2}});
    fs.writeFileSync(path.join(OUT, '整体.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n图：' + path.join(OUT, '整体.png'));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
