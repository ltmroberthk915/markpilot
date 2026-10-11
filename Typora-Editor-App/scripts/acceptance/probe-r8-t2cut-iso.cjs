/** R8 终局回归 · T2/73 右键菜单红隔离探针（新会话逐一复刻触发形）。
 *  背景：层1 场景 73 剪切菜单 opened:false（基线 fa86fa6 同步骤绿）；层3 probe-r2-media2
 *  T2 表头右键「右键菜单没出现」（R2 当轮全绿）。而 r8-cutmenu 复刻（选区=第 1 段粘贴串，
 *  光标同在第 1 段）菜单可开、cut 项在。差异点：73 的合成选区在第 3 段（光标远在第 1 段），
 *  T2 右键的是表头格。本探针用**全新会话**分别复刻两个形，并在每形前后右键一次**正文**
 *  （对照），逐拍读菜单 DOM 与打点，判定红是「会话状态污染」还是「干净可复现」。
 *  用法：node scripts/acceptance/probe-r8-t2cut-iso.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const edge = require('./edge-helpers.cjs');

const OUT = path.join(harness.project, '.perf/probe-r8-final/t2cut-iso');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = harness.sleep;

const DOC_MIX = path.join(OUT, 'mix.md');
fs.writeFileSync(DOC_MIX, [
  '# 右键菜单隔离（73 形）',
  '',
  '第 1 段：起点段，光标常驻这里。$a+b=c$ 行内公式一枚。',
  '',
  '第 2 段：间隔段。',
  '',
  '第 3 段：剪切目标所在的段落，合成选区落在这段文字上。',
].join('\n') + '\n');

const DOC_TAB = path.join(OUT, 'tab.md');
fs.writeFileSync(DOC_TAB, [
  '# 右键菜单隔离（T2 形）',
  '',
  '普通一段正文，作表前对照。',
  '',
  '| T2头甲 | T2头乙 |',
  '| ------ | ------ |',
  '| a1     | b1     |',
  '',
  '表后一段正文，作表后对照。',
].join('\n') + '\n');

const inEditor = expr => `(() => { const doc = document; const frame = doc.getElementById('editor'); const w = frame && frame.contentWindow; const d = w && w.document; ${expr} })()`;

/** 右键真实 CDP 三事件 + 逐拍读菜单（最多 6 拍 ×150ms）。 */
async function rightClickProbe(session, tag, x, y) {
  await session.move(x, y); await sleep(90);
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  let open = null;
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    const menu = await session.js(edge.MENU_ITEMS);
    if (menu && menu.open) { open = menu; break; }
    if (i === 5) open = menu;
  }
  console.log(tag + '：menu.open=' + !!(open && open.open) + ' 项=' + JSON.stringify(((open && open.items) || []).map(v => v.action)));
  return !!(open && open.open);
}

(async () => {
  const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const APP_MAIN = path.join(harness.project, 'app/main/main.js');

  // ── 形 A：73 剪切形（合成选区在第 3 段，光标留在第 1 段）──────────────────
  {
    const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], args: [DOC_MIX], inspect: true,
      label: 'r8t2cut', outDir: OUT, timeout: 120000 });
    try {
      await session.until(inEditor(`return !!(d && d.querySelector('.vditor-ir .vditor-reset'))`), { timeout: 60000, interval: 100 });
      await edge.settle(session); await sleep(400);
      // 光标点进第 1 段
      const p1 = await session.js(inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
        const p=[...s.children].find(n=>n.textContent.includes('第 1 段')); if(!p)return null;
        const r=p.getBoundingClientRect(); const fr=doc.getElementById('editor').getBoundingClientRect();
        return {x:Math.round(fr.x+r.left+30),y:Math.round(fr.y+r.top+r.height/2)};`));
      await session.click(p1.x, p1.y); await sleep(300);
      // 合成选区：第 3 段的「合成选区落在这段文字上」…取整段一半
      const sel = await session.js(inEditor(`const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
        const p=[...s.children].find(n=>n.textContent.includes('第 3 段')); if(!p)return null;
        const walker=d.createTreeWalker(p,NodeFilter.SHOW_TEXT); let node=null;
        while(walker.nextNode()){const n=walker.currentNode; if(n.data.includes('合成选区'))node=n;}
        if(!node)return null; const at=node.data.indexOf('合成选区');
        const range=d.createRange(); range.setStart(node,at); range.setEnd(node,at+8);
        const selection=w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const r=range.getBoundingClientRect(); const fr=doc.getElementById('editor').getBoundingClientRect();
        return {ok:true,text:selection.toString(),x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2)};`));
      console.log('73形 合成选区：', JSON.stringify(sel));
      if (sel && sel.ok) {
        const a = await rightClickProbe(session, '73形 选区右键(光标在第1段)', sel.x, sel.y);
        // 对照：把选区去掉（折叠到第 3 段尾）再右键同一位置
        await session.js(inEditor(`const s=w.getSelection(); if(s&&s.rangeCount){const rg=s.getRangeAt(0);rg.collapse(false);s.removeAllRanges();s.addRange(rg);} return true;`));
        await sleep(200);
        const b = await rightClickProbe(session, '73形 对照(选区折叠后同点右键)', sel.x, sel.y);
        console.log('73形 判定：' + (a ? '选区右键菜单可开（与 73 场景红不一致→场景态问题）' : (b ? '仅选区态不开（产品分支红）' : '两点都不开（产品红）')));
      }
    } finally { await session.close(); }
  }

  // ── 形 B：T2 表头形（全新会话右键表头格；前后各右键正文对照）──────────────
  {
    const session = await harness.launch({ exe: EXE, appArgs: [APP_MAIN], args: [DOC_TAB], inspect: true,
      label: 'r8t2cut', outDir: OUT, timeout: 120000 });
    try {
      await session.until(inEditor(`return !!(d && d.querySelector('.vditor-ir .vditor-reset'))`), { timeout: 60000, interval: 100 });
      await edge.settle(session); await sleep(400);
      const points = await session.js(inEditor(`const fr=doc.getElementById('editor').getBoundingClientRect();
        const pt=el=>{const r=el.getBoundingClientRect();return {x:Math.round(fr.x+r.left+r.width/2),y:Math.round(fr.y+r.top+r.height/2)};};
        const out={};
        const s=d.querySelector(${JSON.stringify(edge.SURFACE)});
        out.表前=[...s.children].find(n=>n.textContent.includes('普通一段正文'));
        const tbl=d.querySelector(${JSON.stringify(edge.SURFACE)}+' table');
        out.表头=tbl&&tbl.rows[0]&&tbl.rows[0].cells[0];
        out.表体=tbl&&tbl.rows[2]&&tbl.rows[2].cells[0];
        out.表后=[...s.children].find(n=>n.textContent.includes('表后一段正文'));
        for(const k of Object.keys(out)) out[k]=out[k]?pt(out[k]):null;
        return out;`));
      console.log('T2形 取点：', JSON.stringify(points));
      if (points && points.表头) {
        const pre = points.表前 ? await rightClickProbe(session, 'T2形 对照(表前正文右键)', points.表前.x, points.表前.y) : null;
        const head = await rightClickProbe(session, 'T2形 表头格右键', points.表头.x, points.表头.y);
        const body = points.表体 ? await rightClickProbe(session, 'T2形 表体格右键', points.表体.x, points.表体.y) : null;
        console.log('T2形 判定：' + (head ? '表头右键菜单可开（media2 T2 红=会话态/顺序问题）'
          : (pre || body ? '仅表头不开（产品表头分支红）' : '全不开（产品红）')));
      }
    } finally { await session.close(); }
  }
  console.log('DONE');
})().catch(error => { console.error('探针异常：', error && error.stack || error); process.exitCode = 1; });
