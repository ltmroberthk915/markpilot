/** 追捕纵向移动的两个手感缺陷（用户 2026-09-18 报告）：
 *   ① "上方向键移动的时候还是会跳过 inline math 跑到更前一行"；
 *   ② "上键移动后再下键回来, 光标位置首位不闭合, 逻辑混乱"。
 *
 *  量法：把光标放在"纯公式行"下面那一行的指定列上，然后 **↑/↓ 交替按 N 次**，每一步都读：
 *    · 光标落在第几个块（块文本 + 块序号）
 *    · 光标容器与偏移（在正文 / 在公式源码 / 在围栏）
 *    · 那一段里有没有公式被展开
 *  这样能直接看出"跳过"与"往返不对称"。
 *
 *  用法：node scripts/acceptance/probe-vertical-roundtrip.cjs
 *        node scripts/acceptance/probe-vertical-roundtrip.cjs --only=A,B
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-vertical-roundtrip');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const READ = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const s = w.getSelection();
  if (!s.rangeCount) return {none: true};
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const block = at.closest('p,li,h1,h2,h3,h4,h5,h6,div');
  const owner = at.closest('.vditor-ir__node[data-type]');
  const box = r.getBoundingClientRect();
  return {块: blocks.indexOf(block), 块文本: String(block?.textContent || '').replace(/\\s+/g, ' ').slice(0, 18),
    容器: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName, 偏移: r.startOffset,
    层: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文',
    公式展开: !!surface.querySelector('.vditor-ir__node--expand'),
    盒: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
    折叠选: r.collapsed}; })()`;

const FIXTURES = {
  A: {
    why: '纯公式行夹在两段文字之间（用户最可能的那一种）',
    md: '第一段文字\n\n第二段文字\n\n$q$\n\n第三段文字\n\n第四段文字\n',
  },
  B: {
    why: '纯公式行只有一条（文档末尾）',
    md: '第一段文字\n\n第二段文字\n\n$q$\n',
  },
  C: {
    why: '长行 + 纯公式行 + 长行（列位置落在公式右侧）',
    md: '上段：' + '甲'.repeat(30) + '\n\n$q$\n\n下段：' + '乙'.repeat(30) + '\n',
  },
};

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'vertical.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-vertical-roundtrip', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  const only = argOf('only', '').split(',').filter(Boolean);
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`,
      {timeout: 140000, interval: 80});
    await sleep(1600);
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      if (only.length && !only.includes(key)) continue;
      console.log(`\n════ ${key}：${fixture.why} ════`);
      console.log('  ' + JSON.stringify(fixture.md));
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(fixture.md)}); return 1; })()`);
      await sleep(1400);
      // 起点：纯公式行**下面**那一段的第一行、指定列
      const placed = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const blocks = [...surface.children];
        const code = [...surface.querySelectorAll('code[data-type="math-inline"]')]
          .find(node => node.textContent.replace(/\\u200b/g, '') === 'q');
        if (!code) return {ok: false, error: '没有 q 公式'};
        const line = code.closest('p,li,h1,h2,h3,h4,h5,h6');
        const index = blocks.indexOf(line);
        const below = blocks[index + 1];
        if (!below) return {ok: false, error: '纯公式行下面没有段落'};
        const walker = d.createTreeWalker(below, NodeFilter.SHOW_TEXT, null);
        let text = null, candidate = null;
        while (walker.nextNode()) { candidate = walker.currentNode; if (candidate.data.replace(/[\\s\\u200b]/g, '')) text = candidate; }
        if (!text) return {ok: false, error: '下面那一段没有文本'};
        surface.focus();
        const r = d.createRange(); r.setStart(text, 0); r.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
        return {ok: true, 公式行: index, 起点行: index + 1}; })()`);
      console.log('  起点：' + JSON.stringify(placed));
      if (!placed.ok) continue;
      await sleep(350);
      console.log('  起点光标：' + JSON.stringify(await session.js(READ)));
      const keys = ['ArrowUp', 'ArrowDown', 'ArrowUp', 'ArrowDown', 'ArrowUp'];
      for (let step = 0; step < keys.length; step++) {
        const key = keys[step];
        await session.key({key, code: key, vk: key === 'ArrowUp' ? 38 : 40});
        await sleep(420);
        const now = await session.js(READ);
        console.log(`  ${key.padEnd(9)} #${step + 1} → 块${now.块}「${now.块文本}」${now.层} ${now.容器}@${now.偏移}` +
          ` 展开=${now.公式展开} 盒=${JSON.stringify(now.盒)}`);
      }
    }
    if (!only.length || only.includes('D')) {
      console.log('\n════ D：从上往下进公式行，再往上走出去（看有没有整行跳过）════');
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue('第一段文字\\n\\n第二段文字\\n\\n$q$\\n\\n第三段文字\\n\\n第四段文字\\n'); return 1; })()`);
      await sleep(1400);
      await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const blocks = [...surface.children];
        const above = blocks[1];
        const walker = d.createTreeWalker(above, NodeFilter.SHOW_TEXT, null);
        let text = null; while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) text = walker.currentNode; }
        surface.focus();
        const r = d.createRange(); r.setStart(text, 0); r.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
        return 1; })()`);
      await sleep(350);
      console.log('  起点：' + JSON.stringify(await session.js(READ)));
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown'];
      for (let step = 0; step < keys.length; step++) {
        const key = keys[step];
        await session.key({key, code: key, vk: key === 'ArrowUp' ? 38 : 40});
        await sleep(420);
        const now = await session.js(READ);
        console.log(`  ${key.padEnd(9)} #${step + 1} → 块${now.块}「${now.块文本}」${now.层} ${now.容器}@${now.偏移} 盒=${JSON.stringify(now.盒)}`);
      }
    }
    if (!only.length || only.includes('E')) {
      console.log('\n════ E：块公式的选中（Shift+方向键 / 鼠标拖拽）════');
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue('上段文字\\n\\n$$\\na+b=1\\n$$\\n\\n下段文字\\n'); return 1; })()`);
      await sleep(1500);
      const start = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const above = surface.children[0];
        const walker = d.createTreeWalker(above, NodeFilter.SHOW_TEXT, null);
        let text = null; while (walker.nextNode()) { if (walker.currentNode.data.replace(/[\\s\\u200b]/g, '')) text = walker.currentNode; }
        surface.focus();
        const r = d.createRange(); r.setStart(text, text.data.length); r.collapse(true);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
        return {ok: true}; })()`);
      console.log('  起点（上段末尾）：' + JSON.stringify(start));
      console.log('  起点光标：' + JSON.stringify(await session.js(READ)));
      for (let step = 1; step <= 4; step++) {
        await session.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39, modifiers: harness.MOD.shift});
        await sleep(360);
        const now = await session.js(READ);
        console.log(`  Shift+→ #${step} → 块${now.块}「${now.块文本}」${now.层} 选中长度=${now.折叠选 === false ? '非折叠' : 0} 盒=${JSON.stringify(now.盒)}`);
      }
      const sel = await session.js(`(() => { const w = ${IF}; const s = w.getSelection(); return {text: JSON.stringify(s.toString()).slice(0, 60), length: s.toString().length, collapsed: s.isCollapsed}; })()`);
      console.log('  选中内容：' + JSON.stringify(sel));
      await session.shot('E-block-select').catch(() => {});
    }
    if (!only.length || only.includes('F')) {
      console.log('\n════ F：鼠标拖拽跨过块公式 ════');
      // 记录拖拽之后的选区时间线 + 是谁改的选区（Selection API 代理带调用栈）
      await session.js(`(() => { const w = ${IF};
        if (w.__selF) return;
        const log = w.__selF = {changes: [], calls: []};
        w.document.addEventListener('selectionchange', () => { const s = w.getSelection();
          log.changes.push({t: Math.round(performance.now()), text: JSON.stringify(s.toString()).slice(0, 40), collapsed: s.isCollapsed,
            anchor: s.anchorNode ? (s.anchorNode.nodeName + '@' + s.anchorOffset) : null}); });
        for (const name of ['collapse', 'extend', 'setBaseAndExtent', 'removeAllRanges', 'addRange']) {
          const original = w.Selection.prototype[name];
          w.Selection.prototype[name] = function (...args) {
            log.calls.push({op: name, t: Math.round(performance.now()),
              by: String((new Error()).stack || '').split('\\n').slice(1, 4).map(l => l.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+\\//, '')).join(' ← ').slice(0, 160)});
            return original.apply(this, args);
          };
        }
        return 1; })()`);
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue('上段文字\\n\\n$$\\na+b=1\\n$$\\n\\n下段文字\\n'); return 1; })()`);
      await sleep(1500);
      const drag = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const above = surface.children[0], below = surface.children[2];
        const ar = above.getBoundingClientRect(), br = below.getBoundingClientRect(), fr = frame.getBoundingClientRect();
        return {from: {x: Math.round(fr.x + ar.left + ar.width - 6), y: Math.round(fr.y + ar.top + ar.height / 2)},
          to: {x: Math.round(fr.x + br.left + 30), y: Math.round(fr.y + br.top + br.height / 2)}}; })()`);
      await session.click(drag.from.x, drag.from.y);
      await sleep(250);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: drag.from.x, y: drag.from.y, button: 'left', buttons: 1, clickCount: 1});
      for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', buttons: 1,
          x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * step / 8),
          y: Math.round(drag.from.y + (drag.to.y - drag.from.y) * step / 8)});
        await sleep(45);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: drag.to.x, y: drag.to.y, button: 'left', buttons: 0, clickCount: 1});
      await sleep(500);
      const after = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        const s = w.getSelection();
        const block = [...surface.children].find(node => node.dataset.type === 'math-block');
        const code = block?.querySelector('code[data-type="math-block"]');
        const box = code ? code.getBoundingClientRect() : null;
        return {选中: JSON.stringify(s.toString()).slice(0, 80), 长度: s.toString().length,
          块被标选中: !!block?.classList.contains('typora-ir-selected'),
          块源码可见: !!box && box.width > 0 && box.height > 0,
          源码盒: box ? [Math.round(box.width), Math.round(box.height)] : null,
          公式展开: !!surface.querySelector('.vditor-ir__node--expand')}; })()`);
      console.log('  拖拽结果：' + JSON.stringify(after));
      const note = await session.js(`(() => { const w = ${IF}; return w.__typoraMathRecover || null; })()`);
      console.log('  recover 自证：' + JSON.stringify(note));
      const timeline = await session.js(`(() => { const w = ${IF}; return w.__selF || null; })()`);
      console.log('  选区时间线：');
      for (const change of (timeline?.changes || []).slice(-8)) {
        console.log(`    +${change.t}ms ${change.collapsed ? '塌' : '非塌'} ${change.text} anchor=${change.anchor}`);
      }
      console.log('  改选区的调用：');
      for (const call of (timeline?.calls || []).slice(-8)) console.log(`    ${call.op} ← ${call.by}`);
      console.log('  拖后 1 秒内逐帧采样（选区文本 / 块是否挂 REVEAL / 源码是否可见）：');
      for (let tick = 0; tick < 8; tick++) {
        const sample = await session.js(`(() => { const w = ${IF}, d = w.document;
          const surface = d.querySelector(${JSON.stringify(SURFACE)});
          const block = [...surface.children].find(node => node.dataset.type === 'math-block');
          const code = block?.querySelector('code[data-type="math-block"]');
          const box = code ? code.getBoundingClientRect() : null;
          const s = w.getSelection();
          return {选中: JSON.stringify(s.toString()).slice(0, 24), 挂类: !!block?.classList.contains('typora-ir-selected'),
            源码可见: !!box && box.width > 4, 源码盒: box ? [Math.round(box.width), Math.round(box.height)] : null,
            块still: !!block?.isConnected, 端点节点: s.anchorNode ? s.anchorNode.nodeName + '@' + s.anchorOffset : null}; })()`);
        console.log(`    #${tick} ` + JSON.stringify(sample));
        await sleep(120);
      }
      await session.shot('F-block-drag').catch(() => {});
    }
    const errors = await session.jsSoft(`(() => { const w = ${IF}; return (w.__acc && w.__acc.errors) || []; })()`);
    console.log('\nconsole 错误：' + JSON.stringify(errors.value));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
