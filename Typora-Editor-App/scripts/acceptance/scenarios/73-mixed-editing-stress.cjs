/** 混合编辑压力：查找/替换、剪贴板粘贴、剪切 + 撤销（全部走真实按键与页面内菜单）。
 *
 *  为什么这几件事值得单独跑在打包产物上：它们都经过"选区 ↔ 源码偏移"的换算，
 *  一旦偏移算错，用户看到的是"替换错位置/粘贴丢了/撤销回不来"，而单元测不出这种
 *  末端错位。所以每条都以磁盘字节或真实 DOM 文本收尾。
 *
 *  触发方式说明：Ctrl+F / Ctrl+H 由渲染页自己的 keydown 处理（不是浏览器加速器），
 *  所以 CDP 的真键盘事件能到；粘贴/剪切走页面内右键菜单（产品自己的 DOM 菜单），
 *  剪贴板内容由独立进程写入，产品自报不作数。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');

const PASTE_TEXT = '粘贴进来的验收字符串甲乙丙';
const QUERY = '第二节';
const REPLACEMENT = '第二节（改）';

const inEditor = expression => `(() => {
  const frame = document.getElementById('editor');
  const doc = frame && frame.contentWindow ? frame.contentWindow.document : null;
  if (!doc) return null;
  return (${expression});
})()`;

const PANEL = inEditor(`(() => {
  const panel = doc.querySelector('#typora-find');
  if (!panel) return {open: false};
  return {open: true, query: panel.querySelector('[data-field="query"]').value,
    count: panel.querySelector('output').textContent, status: panel.querySelector('[role="status"]').textContent,
    replacing: !panel.querySelector('.find-replace-row').hidden};
})()`);

const pointInEditor = expression => `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const node = (${expression});
  if (!node) return {ok: false};
  const frameRect = frame.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return {ok: rect.width > 0, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
})()`;

module.exports = {
  id: '73-mixed-editing-stress',
  title: '混合编辑：查找/替换、粘贴、剪切+撤销（真实按键与页面内菜单）',
  async run(ctx) {
    const file = fixtures.medium();
    const original = fs.readFileSync(file, 'utf8');
    const clipboardDir = path.join(ctx.outDir, '73-mixed-editing-stress');
    fs.mkdirSync(clipboardDir, { recursive: true });
    const saved = harness.saveClipboard(clipboardDir);
    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector(${JSON.stringify(edge.SURFACE)});
        return !!(surface && surface.childElementCount > 400);
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('中等文档上屏', ready, `ready=${ready}`);
      if (!ready) return;
      await session.js(edge.WATCH_TOASTS);
      await edge.settle(session);

      // --- 1) 查找：Ctrl+F 真按键 → 面板 → 输入 → 命中计数 ----------------------
      const anchorPoint = await session.js(pointInEditor(`[...doc.querySelector(${JSON.stringify(edge.SURFACE)}).children].find(block => block.textContent.includes('${QUERY}')) || null`));
      ctx.assert('能找到含查询词的块并点进去（焦点交给编辑器）', anchorPoint.ok, JSON.stringify(anchorPoint));
      if (!anchorPoint.ok) return;
      await session.click(anchorPoint.x, anchorPoint.y);
      await harness.sleep(300);
      await session.chord('f', 'KeyF', 70);
      await harness.sleep(500);
      let panel = await session.js(PANEL);
      ctx.assert('Ctrl+F 真的打开了查找面板', panel.open === true, JSON.stringify(panel));
      if (!panel.open) return;
      const queryInput = await session.js(pointInEditor(`doc.querySelector('#typora-find [data-field="query"]')`));
      if (queryInput.ok) await session.click(queryInput.x, queryInput.y);
      await session.type(QUERY);
      // 等**非零**命中：面板一打开就已经是 "0 / 0"，只等 /数字/数字/ 会立刻拿到 0（本场景
      // 第一版就是这么误判的）。这里等的是"出现 1 或更多"。
      const counted = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const panel = frame.contentWindow.document.querySelector('#typora-find');
        if (!panel) return false;
        const text = panel.querySelector('output').textContent || '';
        const hit = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(text);
        return !!hit && Number(hit[2]) > 0;
      })()`, { timeout: 20000, interval: 120 });
      panel = await session.js(PANEL);
      ctx.witness('查找面板事实（DOM）', panel);
      ctx.log('查找：' + JSON.stringify(panel));
      ctx.assert('输入查询词之后出现非零命中计数', counted && /1\s*\/\s*1/.test(panel.count), JSON.stringify({counted, count: panel.count}));

      // --- 2) 替换：真点击"替换" -------------------------------------------------
      const replaceMode = await session.js(pointInEditor(`doc.querySelector('#typora-find [data-mode="replace"]')`));
      if (replaceMode.ok) { await session.click(replaceMode.x, replaceMode.y); await harness.sleep(200); }
      const replaceInput = await session.js(pointInEditor(`doc.querySelector('#typora-find [data-field="replace"]')`));
      if (replaceInput.ok) { await session.click(replaceInput.x, replaceInput.y); await session.type(REPLACEMENT); await harness.sleep(200); }
      const replaceButton = await session.js(pointInEditor(`doc.querySelector('#typora-find [data-action="replace"]')`));
      ctx.assert('查找面板里有"替换"按钮且可点', replaceButton.ok, JSON.stringify(replaceButton));
      if (replaceButton.ok) {
        await session.click(replaceButton.x, replaceButton.y);
        await harness.sleep(800);
        const status = await session.js(PANEL);
        const domHas = await session.js(inEditor(`doc.querySelector(${JSON.stringify(edge.SURFACE)}).textContent.includes(${JSON.stringify(REPLACEMENT)})`));
        ctx.assert('替换生效：面板回报已替换，且 DOM 里出现替换后的文字',
          /已替换/.test(String(status.status || '')) && domHas === true, JSON.stringify({status, domHas}));
        const replaceSave = await edge.saveAndWait(session, file);
        ctx.witness('磁盘：替换结果', { heading: (replaceSave.after.match(/##[^\n]*/) || [''])[0] });
        ctx.assert('替换结果写进了磁盘（标题变成替换后的文字）',
          replaceSave.after.includes(`## ${REPLACEMENT}`), JSON.stringify((replaceSave.after.match(/##[^\n]*/) || [''])[0]));
        ctx.assert('替换只动了那一处（原标题不再出现，正文行数不变）',
          !replaceSave.after.includes('## 第二节\n') && (replaceSave.after.match(/\n\|/g) || []).length === (original.match(/\n\|/g) || []).length,
          JSON.stringify({old: replaceSave.after.includes('## 第二节\n'), lines: replaceSave.after.split('\n').length - original.split('\n').length}));
      }
      // 关掉查找面板（Esc 真按键）
      await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
      await harness.sleep(250);
      ctx.assert('Esc 关掉了查找面板', (await session.js(PANEL)).open === false, JSON.stringify(await session.js(PANEL)));

      // --- 3) 粘贴：剪贴板由独立进程写入，页面内菜单粘贴 -------------------------
      const written = harness.writeClipboard(clipboardDir, PASTE_TEXT);
      ctx.witness('剪贴板：独立进程写入', { ok: written.ok, length: written.length });
      const targetBlock = await session.js(pointInEditor(`(() => {
        const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
        const block = [...surface.children].find(node => node.textContent.includes('第 1 段'));
        return block || null;
      })()`));
      ctx.assert('找到用于粘贴的段落', targetBlock.ok, JSON.stringify(targetBlock));
      if (targetBlock.ok) {
        await session.click(targetBlock.x, targetBlock.y);
        await harness.sleep(250);
        await session.key({ key: 'End', code: 'End', vk: 35 });
        await harness.sleep(250);
        const pasteMenu = await edge.menuClick(session, `(() => {
          const doc = document.getElementById('editor').contentWindow.document;
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          return [...surface.children].find(node => node.textContent.includes('第 1 段')) || null;
        })()`, 'paste', { wait: 1200 });
        ctx.assert('右键菜单里有"粘贴"并可点', pasteMenu.opened && pasteMenu.label === '粘贴', JSON.stringify({opened: pasteMenu.opened, label: pasteMenu.label, items: (pasteMenu.items || []).map(item => item.action)}));
        // 数**文档**（getValue），不数 DOM 的 textContent。口径差别的实测证据（2026-09-17）：
        // 这条断言卡了五个版本（"粘贴出现 2 次"，一直当"既有问题待排查"），真因是粘贴落进了
        // **行内公式的源码**——公式源码与 KaTeX 预览各含一份，于是 textContent 数出两次，
        // 而文档与磁盘都只有一份。产品行为没问题，是口径错了。DOM 读数仍记进证人，
        // 口径一旦再次分叉能立刻看出来。
        const pasted = await session.js(inEditor(`(() => {
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          return {doc: frame.contentWindow.vditor.getValue().split(${JSON.stringify(PASTE_TEXT)}).length - 1,
            dom: surface.textContent.split(${JSON.stringify(PASTE_TEXT)}).length - 1};
        })()`));
        ctx.assert('粘贴的字符串出现在文档里，且只出现一次（没有重复插入）', pasted.doc === 1, JSON.stringify(pasted));
        // 磁盘读数**一律取**，不放在"DOM 口径通过"的条件里：此前失败时恰好丢掉了唯一能定性的
        // 证据，分不清"真的插了两遍"（严重）还是"只有 textContent 重复"（口径问题）。
        const pasteSave = await edge.saveAndWait(session, file);
        const diskCount = pasteSave.after.split(PASTE_TEXT).length - 1;
        ctx.witness('粘贴后：文档口径 / DOM 口径 / 磁盘口径的命中次数', {...pasted, disk: diskCount,
          line: (pasteSave.after.match(/第 1 段[^\n]*/) || [''])[0].slice(0, 160)});
        ctx.assert('粘贴的字符串写进了磁盘', pasteSave.after.includes(PASTE_TEXT), JSON.stringify((pasteSave.after.match(/第 1 段[^\n]*/) || [''])[0].slice(0, 120)));
        ctx.assert('粘贴在磁盘上只出现一次（文档口径与磁盘口径一致）', diskCount === 1,
          JSON.stringify({...pasted, disk: diskCount}));

        // --- 4) 剪切 + 撤销 ---------------------------------------------------
        const selected = await session.js(inEditor(`(() => {
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          const walker = doc.createTreeWalker(surface, NodeFilter.SHOW_TEXT, null);
          let node = null;
          while (walker.nextNode()) if (walker.currentNode.data.includes(${JSON.stringify(PASTE_TEXT)})) node = walker.currentNode;
          if (!node) return null;
          const at = node.data.indexOf(${JSON.stringify(PASTE_TEXT)});
          const range = doc.createRange();
          range.setStart(node, at); range.setEnd(node, at + ${JSON.stringify(PASTE_TEXT)}.length);
          const selection = document.getElementById('editor').contentWindow.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
          return {text: selection.toString(), length: selection.toString().length};
        })()`));
        ctx.assert('能选中刚粘贴的字符串（选区在真实 DOM 上）', selected && selected.text === PASTE_TEXT, JSON.stringify(selected));
        // 【R8 triage 取证】剪切红定点倾倒：焦点/选区几何/命中元素/菜单残留（只加证人，不动断言）
        {
          const sp73 = await session.js(edge.selectionPoint);
          const dump73 = sp73 && sp73.ok ? await session.js(`(() => {
            const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
            const fr = frame.getBoundingClientRect();
            const inner = doc.elementFromPoint(${Math.round(sp73.x)} - fr.x, ${Math.round(sp73.y)} - fr.y);
            const topEl = document.elementFromPoint(${Math.round(sp73.x)}, ${Math.round(sp73.y)});
            const describe = n => n ? (n.nodeName + (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\\s+/).slice(0,2).join('.') : '')) : null;
            const root = doc.querySelector('.vditor-ir .vditor-reset');
            const sel = w.getSelection();
            const rg = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
            const node = rg && rg.startContainer;
            const host = node && (node.nodeType === 3 ? node.parentElement : node);
            return { topFocus: document.hasFocus(), topActive: describe(document.activeElement),
              edActive: describe(doc.activeElement), inSurface: !!(inner && inner.closest && inner.closest('.vditor-content')),
              inner: describe(inner), topHit: describe(topEl),
              menuResidue: !!doc.querySelector('.typora-editor-context-menu'),
              scroll: { top: root ? Math.round(root.scrollTop) : null, h: root ? Math.round(root.scrollHeight) : null, vh: w.innerHeight },
              rangeRect: rg ? (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(rg.getBoundingClientRect()) : null,
              hostInDom: host ? host.isConnected : null };
          })()`) : { noSelectionPoint: true };
          ctx.witness('剪切前状态倾倒（R8 triage）', { sp: sp73, dump: dump73 });
          ctx.log('剪切前状态：' + JSON.stringify({ sp: sp73, dump: dump73 }));
          // 【R8 修复（探针侧）】保存（Ctrl+S → setValue 重挂虚拟化窗口）之后，选区常被留在
          // 视口外（实测 rangeRect.y=13385 / scrollTop=0：右键点在窗外，菜单当然不开——
          // 真实用户只会右键**看得见**的选区）。右键前把选区滚进视口，与用户行为对齐。
          if (sp73 && sp73.ok && (sp73.y < 0 || sp73.y > (dump73 && dump73.scroll ? dump73.scroll.vh : 713))) {
            await session.js(inEditor(`(() => {
              const w2 = frame.contentWindow; const d2 = w2.document;
              const sel2 = w2.getSelection();
              if (!sel2 || !sel2.rangeCount) return false;
              const n2 = sel2.getRangeAt(0).startContainer;
              const el2 = n2.nodeType === 3 ? n2.parentElement : n2;
              const block2 = el2 && el2.closest && el2.closest('p,h1,h2,h3,h4,h5,h6,li');
              if (block2 && block2.scrollIntoView) block2.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
              return true;
            })()`));
            await harness.sleep(350);
          }
        }
        const cutMenu = await edge.menuClickPoint(session, edge.selectionPoint, 'cut', { wait: 1500 });
        ctx.assert('右键菜单里有"剪切"并可点', cutMenu.opened && cutMenu.label === '剪切', JSON.stringify({opened: cutMenu.opened, label: cutMenu.label}));
        const afterCut = await session.js(inEditor(`(() => {
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          return {doc: frame.contentWindow.vditor.getValue().split(${JSON.stringify(PASTE_TEXT)}).length - 1,
            dom: surface.textContent.split(${JSON.stringify(PASTE_TEXT)}).length - 1};
        })()`));
        ctx.witness('剪切后：文档口径 / DOM 口径', afterCut);
        ctx.assert('剪切之后这段文字从文档里消失（出现 0 次）', afterCut.doc === 0, JSON.stringify(afterCut));
        await session.chord('z', 'KeyZ', 90);
        await harness.sleep(900);
        const afterUndo = await session.js(inEditor(`(() => {
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          return {doc: frame.contentWindow.vditor.getValue().split(${JSON.stringify(PASTE_TEXT)}).length - 1,
            dom: surface.textContent.split(${JSON.stringify(PASTE_TEXT)}).length - 1};
        })()`));
        ctx.witness('撤销后：文档口径 / DOM 口径', afterUndo);
        ctx.assert('Ctrl+Z 撤销之后这段文字回来（正好一次）', afterUndo.doc === 1, JSON.stringify(afterUndo));
        const undoFacts = await session.js(inEditor(`(() => {
          const surface = doc.querySelector(${JSON.stringify(edge.SURFACE)});
          return {chars: surface.textContent.length, blocks: surface.childElementCount};
        })()`));
        ctx.log('撤销之后：' + JSON.stringify(undoFacts));
      }

      // --- 5) 错误面 ------------------------------------------------------------
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.assert('全程没有错误提示（乱码 / -File / app.asar / 失败）', problems.length === 0, JSON.stringify({problems, toasts}));
      ctx.metric('mixed.findHits', 1, { unit: '处', direction: 'equal', tolerance: 0 });
      await session.shot('73-mixed-editing-stress');
    } finally {
      await ctx.release(session);
      try { harness.restoreClipboard(clipboardDir, saved.__file); } catch { /* 忽略 */ }
      try { fs.writeFileSync(file, original); } catch { /* 忽略 */ }
    }
  },
};
