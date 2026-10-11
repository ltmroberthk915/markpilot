/** R8 终局回归 · 73 剪切红第三轮隔离：C 形 = 73 全序列含 Ctrl+S（前两轮已证：
 *  无保存时选区右键菜单可开、cut 项在 → 差异只剩「粘贴后保存」这一步）。
 *  用法：node scripts/acceptance/probe-r8-cut-save.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const edge = require('./edge-helpers.cjs');

const OUT = path.join(harness.project, '.perf/probe-r8-final/t2cut-iso');
fs.mkdirSync(OUT, { recursive: true });
const PASTE_TEXT = '从独立进程写进剪贴板的粘贴串R8';
const DOC = path.join(OUT, 'mixC.md');
fs.writeFileSync(DOC, [
  '# 右键菜单隔离（C 形：73 全序列含保存）',
  '',
  '第 1 段：查找目标“第二节”不在这段。$a+b=c$ 行内公式一枚。',
  '',
  '第二节：替换与撤销的目标段落，内容再长一点也没关系。',
  '',
  '第 3 段：剪切目标所在的段落，粘贴串会落在第 1 段末尾。',
].join('\n') + '\n');

const inEditor = expr => `(() => { const doc = document; const frame = doc.getElementById('editor'); const w = frame && frame.contentWindow; const d = w && w.document; ${expr} })()`;
const elemOf = marker => inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
  return [...s.children].find(n=>n.textContent.includes(${JSON.stringify(marker)})) || null;`);
const pointOfEl = marker => inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
  const el=[...s.children].find(n=>n.textContent.includes(${JSON.stringify(marker)})); if(!el)return null;
  const r=el.getBoundingClientRect(); const fr=doc.getElementById('editor').getBoundingClientRect();
  return {x:Math.round(fr.x+r.left+30),y:Math.round(fr.y+r.top+r.height/2)};`);

(async () => {
  const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const APP = path.join(harness.project, 'app/main/main.js');
  const session = await harness.launch({ exe: EXE, appArgs: [APP], args: [DOC], inspect: true,
    label: 'r8cutC', outDir: OUT, timeout: 120000 });
  try {
    await session.until(inEditor(`return !!(d && d.querySelector('.vditor-ir .vditor-reset'))`), { timeout: 60000, interval: 100 });
    await edge.settle(session); await harness.sleep(400);
    const p = await session.js(pointOfEl('第 1 段'));
    await session.click(p.x, p.y); await harness.sleep(250);
    await session.key({ key: 'End', code: 'End', vk: 35 }); await harness.sleep(250);
    const written = harness.writeClipboard(path.join(OUT, 'clipC'), PASTE_TEXT);
    console.log('剪贴板写入：', JSON.stringify({ ok: written.ok }));
    const pasteMenu = await edge.menuClick(session, elemOf('第 1 段'), 'paste', { wait: 1200 });
    console.log('粘贴菜单：', JSON.stringify({ opened: pasteMenu.opened, label: pasteMenu.label }));
    await harness.sleep(300);
    // ★ 73 在这里 Ctrl+S（前两轮隔离缺的就是这一步）
    const save = await edge.saveAndWait(session, DOC);
    console.log('保存完成：', JSON.stringify({ len: (save.after || '').length, 含粘贴串: (save.after || '').includes(PASTE_TEXT) }));
    const sel = await session.js(inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
      const walker=d.createTreeWalker(s,NodeFilter.SHOW_TEXT,null); let node=null;
      while(walker.nextNode()) if(walker.currentNode.data.includes(${JSON.stringify(PASTE_TEXT)})) node=walker.currentNode;
      if(!node)return null; const at=node.data.indexOf(${JSON.stringify(PASTE_TEXT)});
      const range=d.createRange(); range.setStart(node,at); range.setEnd(node,at+${JSON.stringify(PASTE_TEXT)}.length);
      const selection=w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return {text:selection.toString(),length:selection.toString().length};`));
    console.log('合成选区：', JSON.stringify(sel));
    const sp = await session.js(edge.selectionPoint);
    console.log('selectionPoint：', JSON.stringify(sp));
    const cut = await edge.menuClickPoint(session, edge.selectionPoint, 'cut', { wait: 1500 });
    console.log('C形 剪切菜单：', JSON.stringify({ opened: cut.opened, label: cut.label, tries: (cut.tries || []).length }));
    const q = await session.js(pointOfEl('第二节'));
    const plain = await edge.menuClick(session, elemOf('第二节'), 'copy', { wait: 800 });
    console.log('C形 对照(保存后正文右键copy菜单)：', JSON.stringify({ opened: plain.opened, label: plain.label }));
  } finally { await session.close(); console.log('DONE'); }
})().catch(e => { console.error('探针异常：', e && e.stack || e); process.exitCode = 1; });
