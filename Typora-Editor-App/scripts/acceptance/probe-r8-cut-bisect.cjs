/** R8 终局回归 · 73 剪切红成分二分：
 *  已证：C 形（小文档、无查找环）剪切菜单可开 → 红的触发成分只剩两个候选：
 *   D 形 = 小文档 + 73 的查找/替换环（Ctrl+F → 输入 → 替换 → Esc）再走粘贴/剪切；
 *   E 形 = fixtures.medium()（502 块）不走走查找环，直接粘贴/剪切。
 *  哪形复刻出 opened:false，哪形成分就是必要条件。
 *  用法：node scripts/acceptance/probe-r8-cut-bisect.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const edge = require('./edge-helpers.cjs');
const fixtures = require('./fixtures.cjs');

const OUT = path.join(harness.project, '.perf/probe-r8-final/t2cut-iso');
fs.mkdirSync(OUT, { recursive: true });
const PASTE_TEXT = '从独立进程写进剪贴板的粘贴串R8';
const QUERY = '第二节';
const REPLACEMENT = '第二节改';

const inEditor = expr => `(() => { const doc = document; const frame = doc.getElementById('editor'); const w = frame && frame.contentWindow; const d = w && w.document; ${expr} })()`;
const elemOf = marker => inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
  return [...s.children].find(n=>n.textContent.includes(${JSON.stringify(marker)})) || null;`);
const firstPara = () => inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
  const ps=[...s.children].filter(n=>n.tagName==='P'); return ps[0] || null;`);

(async () => {
  const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const APP = path.join(harness.project, 'app/main/main.js');

  /** 一条完整链：点段 → End → 菜单粘贴 → Ctrl+S → 合成选区 PASTE_TEXT → selectionPoint 右键 cut。 */
  async function chain(session, file, finderExpr, tag) {
    const elPoint = await session.js(`(() => {
      const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
      const node = (${finderExpr});
      if (!node) return null;
      if (node.scrollIntoView) node.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
      const fr = frame.getBoundingClientRect(); const r = node.getBoundingClientRect();
      return {x: Math.round(fr.x + r.x + r.width/2), y: Math.round(fr.y + r.y + r.height/2)};
    })()`);
    if (!elPoint) { console.log(tag + ' 找不到目标段'); return; }
    await session.click(elPoint.x, elPoint.y); await harness.sleep(250);
    await session.key({ key: 'End', code: 'End', vk: 35 }); await harness.sleep(250);
    const written = harness.writeClipboard(path.join(OUT, 'clip-' + tag), PASTE_TEXT);
    const pasteMenu = await edge.menuClick(session, finderExpr, 'paste', { wait: 1200 });
    // 上一行的 finder 太绕，直接换成按 tag 找已粘贴段（粘贴后 PASTE_TEXT 就在段里）
    console.log(tag + ' 粘贴菜单：', JSON.stringify({ opened: pasteMenu.opened, label: pasteMenu.label }));
    if (!pasteMenu.opened) return;
    const save = await edge.saveAndWait(session, file);
    console.log(tag + ' 保存：', JSON.stringify({ 含粘贴串: (save.after || '').includes(PASTE_TEXT) }));
    const sel = await session.js(inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
      const walker=d.createTreeWalker(s,NodeFilter.SHOW_TEXT,null); let node=null;
      while(walker.nextNode()) if(walker.currentNode.data.includes(${JSON.stringify(PASTE_TEXT)})) node=walker.currentNode;
      if(!node)return null; const at=node.data.indexOf(${JSON.stringify(PASTE_TEXT)});
      const range=d.createRange(); range.setStart(node,at); range.setEnd(node,at+${JSON.stringify(PASTE_TEXT)}.length);
      const selection=w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return {text:selection.toString(),length:selection.toString().length};`));
    console.log(tag + ' 合成选区：', JSON.stringify(sel));
    const sp = await session.js(edge.selectionPoint);
    console.log(tag + ' selectionPoint：', JSON.stringify(sp));
    const cut = await edge.menuClickPoint(session, edge.selectionPoint, 'cut', { wait: 1500 });
    console.log(tag + ' 剪切菜单：', JSON.stringify({ opened: cut.opened, label: cut.label, tries: (cut.tries || []).length }));
  }

  // ── D 形：小文档 + 查找/替换环 ────────────────────────────────────────────
  {
    const file = path.join(OUT, 'smallD.md');
    fs.writeFileSync(file, [
      '# 右键菜单隔离（D 形：查找环）', '',
      '第 1 段：查找目标“第二节”不在这段。$a+b=c$ 行内公式一枚。', '',
      `## ${QUERY}`, '',
      '第三节：普通段落。', '',
    ].join('\n') + '\n');
    const session = await harness.launch({ exe: EXE, appArgs: [APP], args: [file], inspect: true,
      label: 'r8cutD', outDir: OUT, timeout: 120000 });
    try {
      await session.until(inEditor(`return !!(d && d.querySelector('.vditor-ir .vditor-reset'))`), { timeout: 60000, interval: 100 });
      await edge.settle(session); await harness.sleep(400);
      // 查找环（复刻 73 第 1-2 步）
      const anchor = await session.js(`(() => { const frame=document.getElementById('editor'); const w=frame.contentWindow; const doc=w.document;
        const surface=doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const block=[...surface.children].find(b=>b.textContent.includes(${JSON.stringify(QUERY)})) || surface.children[1];
        if(!block)return null; block.scrollIntoView({block:'center'});
        const fr=frame.getBoundingClientRect(); const r=block.getBoundingClientRect();
        return {x:Math.round(fr.x+r.x+r.width/2),y:Math.round(fr.y+r.y+r.height/2)}; })()`);
      await session.click(anchor.x, anchor.y); await harness.sleep(300);
      await session.chord('f', 'KeyF', 70); await harness.sleep(500);
      const qin = await session.js(`(() => { const frame=document.getElementById('editor'); const w=frame.contentWindow; const doc=w.document;
        const el=doc.querySelector('#typora-find [data-field="query"]'); if(!el)return null;
        el.scrollIntoView({block:'center'}); const fr=frame.getBoundingClientRect(); const r=el.getBoundingClientRect();
        return {x:Math.round(fr.x+r.x+r.width/2),y:Math.round(fr.y+r.y+r.height/2)}; })()`);
      if (qin) { await session.click(qin.x, qin.y); await session.type(QUERY); }
      await session.until(inEditor(`const p=d.querySelector('#typora-find'); if(!p)return false;
        const t=(p.querySelector('output')||{}).textContent||''; const m=/\\d+\\s*\\/\\s*(\\d+)/.exec(t);
        return !!m && Number(m[1])>0;`), { timeout: 15000, interval: 120 });
      const rmode = await session.js(`(() => { const frame=document.getElementById('editor'); const w=frame.contentWindow; const doc=w.document;
        const el=doc.querySelector('#typora-find [data-mode="replace"]'); if(!el)return null;
        const fr=frame.getBoundingClientRect(); const r=el.getBoundingClientRect();
        return {x:Math.round(fr.x+r.x+r.width/2),y:Math.round(fr.y+r.y+r.height/2)}; })()`);
      if (rmode) { await session.click(rmode.x, rmode.y); await harness.sleep(200); }
      const rin = await session.js(`(() => { const frame=document.getElementById('editor'); const w=frame.contentWindow; const doc=w.document;
        const el=doc.querySelector('#typora-find [data-field="replace"]'); if(!el)return null;
        const fr=frame.getBoundingClientRect(); const r=el.getBoundingClientRect();
        return {x:Math.round(fr.x+r.x+r.width/2),y:Math.round(fr.y+r.y+r.height/2)}; })()`);
      if (rin) { await session.click(rin.x, rin.y); await session.type(REPLACEMENT); await harness.sleep(200); }
      const rbtn = await session.js(`(() => { const frame=document.getElementById('editor'); const w=frame.contentWindow; const doc=w.document;
        const el=doc.querySelector('#typora-find [data-action="replace"]'); if(!el)return null;
        const fr=frame.getBoundingClientRect(); const r=el.getBoundingClientRect();
        return {x:Math.round(fr.x+r.x+r.width/2),y:Math.round(fr.y+r.y+r.height/2)}; })()`);
      if (rbtn) { await session.click(rbtn.x, rbtn.y); await harness.sleep(800); }
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 }); await harness.sleep(250);
      console.log('D形 查找环完成（面板已 Esc）');
      await chain(session, file, `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        return [...surface.children].find(node => node.textContent.includes('第 1 段')) || null; })()`, 'D形');
    } finally { await session.close(); }
  }

  // ── E 形：medium 大文档（502 块），无查找环 ───────────────────────────────
  {
    const file = fixtures.medium();
    const session = await harness.launch({ exe: EXE, appArgs: [APP], args: [file], inspect: true,
      label: 'r8cutE', outDir: OUT, timeout: 180000 });
    try {
      await session.until(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        return !!(surface && surface.childElementCount > 400); })()`, { timeout: 90000, interval: 20 });
      await edge.settle(session); await harness.sleep(400);
      await chain(session, file, `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        return [...surface.children].find(node => node.tagName === 'P') || null; })()`, 'E形');
    } finally { await session.close(); }
  }
  console.log('DONE');
})().catch(e => { console.error('探针异常：', e && e.stack || e); process.exitCode = 1; });
