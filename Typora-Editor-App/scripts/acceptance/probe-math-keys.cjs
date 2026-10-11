/** 复现用户 2026-09-17 报的四件事（只取证，不改产品代码）：
 *
 *  A 空的块公式（`$$` 一行、空行、`$$` 一行）：渲染后页面上完全看不见，点不到、选不中、
 *    也删不掉——用户原话"会留下很多隐形垃圾, 且无法被选中删除"。
 *  B 有内容的块公式：光标停在**闭围栏 $$ 之后**，按住 Shift 再按 ← 选不中（用户原话
 *    "尝试选中失败"）。
 *  C 一行里只有行内公式时，上下方向键跳过这一行（用户原话"会导致光标跳过这一行"）。
 *  D 紧贴公式块按退格/删除：目前只弹一句提示、什么都不做（用户要求改成"直接帮用户选中，
 *    展开编辑公式代码形态，光标插到最后"）。
 *
 *  用法：node scripts/acceptance/probe-math-keys.cjs
 *        node scripts/acceptance/probe-math-keys.cjs --only=A,B
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-math-keys');
const IF = `document.getElementById('editor').contentWindow`;
const PREVIEW = `.vditor-ir__preview,.vditor-wysiwyg__preview`;

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** 文档形状：每块的盒子 + 公式节点 + 磁盘/内存 markdown。 */
const SHAPE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (!surface) return {ok: false, error: '没有编辑面'};
  const round = value => Math.round(value);
  const rows = [...surface.children].map((node, index) => {
    const box = node.getBoundingClientRect();
    return {i: index, tag: node.nodeName.toLowerCase(), type: node.dataset ? node.dataset.type || null : null,
      rect: [round(box.left), round(box.top), round(box.width), round(box.height)],
      text: String(node.innerText || '').replace(/\\n+/g, ' | ').slice(0, 40)};
  });
  const blocks = [...surface.querySelectorAll('code[data-type="math-block"]')].map(code => {
    const owner = code.closest('.vditor-ir__node,div[data-type]') || code;
    const box = owner.getBoundingClientRect();
    const preview = owner.querySelector(':scope > ' + ${JSON.stringify(PREVIEW)}) || owner.querySelector(${JSON.stringify(PREVIEW)});
    const pbox = preview ? preview.getBoundingClientRect() : null;
    const markers = [...owner.querySelectorAll('.vditor-ir__marker')].map(m => m.textContent);
    return {src: JSON.stringify(code.textContent), empty: !code.textContent.trim(),
      owner: owner.nodeName.toLowerCase() + (owner.dataset && owner.dataset.type ? '[' + owner.dataset.type + ']' : ''),
      expanded: owner.classList.contains('vditor-ir__node--expand'), markers,
      rect: [round(box.left), round(box.top), round(box.width), round(box.height)],
      previewRect: pbox ? [round(pbox.left), round(pbox.top), round(pbox.width), round(pbox.height)] : null};
  });
  return {ok: true, rows, blocks, md: w.vditor.getValue()}; })()`;

/** 光标读数：它在哪一段、哪一层、可见矩形多大。 */
const CARET = `(() => { const w = ${IF}, d = w.document;
  const s = w.getSelection();
  if (!s || !s.rangeCount) return {none: true};
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  const blocks = surface ? [...surface.children] : [];
  const block = at.closest && at.closest('p,li,h1,h2,h3,h4,h5,h6,div');
  const owner = at.closest && at.closest('.vditor-ir__node,div[data-type]');
  const box = r.getBoundingClientRect();
  const boxAt = d.caretRangeFromPoint ? d.caretRangeFromPoint(Math.round(box.x + 1), Math.round(box.y + 2)) : null;
  return {collapsed: r.collapsed, text: String(s).slice(0, 50), length: r.toString().length,
    blockIndex: blocks.indexOf(block), container: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName,
    offset: r.startOffset,
    layer: at.closest('code[data-type]') ? '源码' : at.closest(${JSON.stringify(PREVIEW)}) ? '预览' : at.closest('.vditor-ir__marker') ? '围栏' : '正文',
    owner: owner ? owner.nodeName.toLowerCase() + (owner.dataset && owner.dataset.type ? '[' + owner.dataset.type + ']' : '') + (owner.classList.contains('vditor-ir__node--expand') ? '(展开)' : '') : null,
    box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    boxBack: boxAt ? {container: boxAt.startContainer.nodeType === 3 ? 'TEXT' : boxAt.startContainer.nodeName, offset: boxAt.startOffset} : null}; })()`;

const MD = `(() => { const w = ${IF}; return w.vditor.getValue(); })()`;

/** 落点：把世界坐标（iframe 内）换算到顶层页坐标交给 CDP。 */
const point = async (session, spec) => {
  const hit = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
    const surface = d.querySelector('.vditor-ir .vditor-reset');
    if (!surface) return {ok: false, error: '没有编辑面'};
    const fr = frame.getBoundingClientRect();
    const block = [...surface.children][${spec.index}] || surface;
    if (${spec.scroll !== false}) block.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    const box = block.getBoundingClientRect();
    const code = block.querySelector('code[data-type="math-block"]');
    const owner = code ? code.closest('.vditor-ir__node,div[data-type]') : null;
    const preview = owner ? owner.querySelector(${JSON.stringify(PREVIEW)}) : null;
    const base = ${JSON.stringify(spec.at)} === 'preview' && preview ? preview.getBoundingClientRect()
      : ${JSON.stringify(spec.at)} === 'owner' && owner ? owner.getBoundingClientRect() : box;
    const x = Math.round(base.left + (${spec.left} === null ? base.width / 2 : ${spec.left}) + (${spec.dx || 0}));
    const y = Math.round(base.top + (${spec.top} === null ? base.height / 2 : ${spec.top}) + (${spec.dy || 0}));
    const at = d.elementFromPoint(x, y);
    return {ok: true, x, y, frameX: Math.round(fr.x), frameY: Math.round(fr.y),
      base: [Math.round(base.left), Math.round(base.top), Math.round(base.width), Math.round(base.height)],
      hit: at ? at.nodeName.toLowerCase() + (at.dataset && at.dataset.type ? '[' + at.dataset.type + ']' : '') + (at.className && typeof at.className === 'string' && at.className ? '.' + at.className.split(' ').slice(0, 2).join('.') : '') : null,
      inOwner: !!(owner && at && owner.contains(at)), onSurface: !!(at && surface.contains(at))}; })()`);
  if (!hit.ok) return hit;
  return {...hit, clickX: hit.frameX + hit.x, clickY: hit.frameY + hit.y};
};

const clickAt = async (session, spec) => {
  const hit = await point(session, spec);
  if (!hit.ok) return hit;
  await session.click(hit.clickX, hit.clickY);
  await sleep(320);
  return hit;
};

/** 把世界坐标上的光标放到指定位置（程序建 Range，绕开鼠标）。 */
const place = async (session, js) => {
  const out = await session.js(`(() => { const w = ${IF}, d = w.document;
    const surface = d.querySelector('.vditor-ir .vditor-reset');
    surface.focus(); const placed = (${js});
    if (!placed || !placed.range) return {ok: false, error: placed ? placed.why : '没有结果'};
    const s = w.getSelection(); s.removeAllRanges(); s.addRange(placed.range);
    return {ok: true, why: placed.why + (placed.note ? ' ' + placed.note : '')}; })()`);
  await sleep(300);
  return out;
};

/** 依次按一串键，每按一下读一次光标（Shift 一直按着）。 */
const shiftWalk = async (session, times) => {
  const steps = [];
  for (let i = 0; i < times; i++) {
    await session.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, modifiers: harness.MOD.shift});
    await sleep(260);
    const caret = await session.js(CARET);
    steps.push({第i: i + 1, 选区长度: caret.length, 选区: caret.text, 容器: caret.container, 偏移: caret.offset, 层: caret.layer});
  }
  return steps;
};

const showCaret = caret => caret.none ? '（没有选区）'
  : `段#${caret.blockIndex} ${caret.layer} 容器=${caret.container}@${caret.offset}` +
    ` 可见=${caret.box[2]}x${caret.box[3]}${caret.owner ? ' 节点=' + caret.owner : ''}` +
    `${caret.collapsed ? '' : ' 选中=' + JSON.stringify(caret.text)}`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'keys.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-math-keys', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  const only = argOf('only', 'A,B,C,D').split(',').filter(Boolean);
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);

    const setValue = async text => {
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(text)}); return 1; })()`);
      await sleep(1400);
    };

    if (only.includes('A')) {
      console.log('\n════════ A 空块公式：能不能看见 / 点到 / 删掉 ════════');
      const md = '前段甲\n\n$$\n\n$$\n\n后段乙\n';
      await setValue(md);
      const shape = await session.js(SHAPE);
      console.log('markdown : ' + JSON.stringify(md));
      console.log('getValue : ' + JSON.stringify(shape.md));
      console.log('块序列   : ' + JSON.stringify(shape.rows));
      console.log('块公式   : ' + JSON.stringify(shape.blocks));
      const empty = shape.blocks.findIndex(b => b.empty);
      console.log(`空公式序号: ${empty}（共 ${shape.blocks.length} 条）`);
      if (empty < 0) console.log('  ✗ 没造出空公式块，后面的读数没意义');
      // 空块在"前段甲"与"后段乙"之间的空隙里：点它应该落在哪儿
      const gap = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        const prev = surface.children[0].getBoundingClientRect(), next = surface.children[2].getBoundingClientRect();
        return {top: Math.round(prev.bottom), bottom: Math.round(next.top), x: Math.round(surface.children[0].getBoundingClientRect().left + 20)}; })()`);
      console.log(`空隙：y ${gap.top} → ${gap.bottom}（共 ${gap.bottom - gap.top}px）`);
      const probe = await clickAt(session, {index: 0, at: 'block', left: 20, top: null, dy: (gap.bottom - gap.top) / 2 + 26});
      console.log('点在空隙里  : elementFromPoint=' + probe.hit + ' 在公式节点内=' + probe.inOwner);
      console.log('  点后光标  : ' + showCaret(await session.js(CARET)));
      await session.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(320);
      console.log('  按删除后  : 光标 ' + showCaret(await session.js(CARET)) + ' / getValue=' + JSON.stringify(await session.js(MD)));
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(320);
      console.log('  按退格后  : 光标 ' + showCaret(await session.js(CARET)) + ' / getValue=' + JSON.stringify(await session.js(MD)));
      // 键盘能不能走到空块那一行
      const placed = await place(session, `(() => { const p = surface.children[0].firstChild;
        if (!p || p.nodeType !== 3) return {why: '前段甲不是文本节点'};
        const r = d.createRange(); r.setStart(p, p.data.length); r.collapse(true); return {range: r, why: '前段甲末尾'}; })()`);
      console.log('起点        : ' + JSON.stringify(placed) + ' → ' + showCaret(await session.js(CARET)));
      for (let i = 1; i <= 3; i++) {
        await session.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40});
        await sleep(280);
        console.log(`  第 ${i} 次 ↓ : ` + showCaret(await session.js(CARET)));
      }
      // 能不能用鼠标拖选到它
      const drag = await session.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector('.vditor-ir .vditor-reset');
        const prev = surface.children[0].getBoundingClientRect(), next = surface.children[2].getBoundingClientRect();
        const first = surface.children[0].lastChild;
        const r = d.createRange(); r.selectNodeContents(surface); return {ok: true,
          from: [Math.round(prev.left + 2), Math.round(prev.top + prev.height / 2)],
          to: [Math.round(next.left + 2), Math.round(next.top + next.height / 2)]}; })()`);
      console.log('可拖选范围  : ' + JSON.stringify(drag));
      const p1 = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
        const surface = d.querySelector('.vditor-ir .vditor-reset'), prev = surface.children[0].getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        return {x: Math.round(fr.x + prev.left + 2), y: Math.round(fr.y + prev.top + prev.height / 2)}; })()`);
      const p2 = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
        const surface = d.querySelector('.vditor-ir .vditor-reset'), next = surface.children[2].getBoundingClientRect();
        const fr = frame.getBoundingClientRect();
        return {x: Math.round(fr.x + next.left + 2), y: Math.round(fr.y + next.top + next.height / 2)}; })()`);
      await session.click(p1.x, p1.y);
      await sleep(200);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', buttons: 1, clickCount: 1});
      for (let step = 1; step <= 6; step++) {
        const x = Math.round(p1.x + (p2.x - p1.x) * step / 6), y = Math.round(p1.y + (p2.y - p1.y) * step / 6);
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, buttons: 1});
        await sleep(40);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', buttons: 0, clickCount: 1});
      await sleep(400);
      const dragged = await session.js(CARET);
      console.log('拖过空块    : ' + showCaret(dragged));
      await session.key({key: 'Delete', code: 'Delete', vk: 46});
      await sleep(400);
      console.log('  拖后删除  : getValue=' + JSON.stringify(await session.js(MD)));
      await session.shot('A-empty-block').catch(() => {});
    }

    if (only.includes('B')) {
      console.log('\n════════ B 闭围栏 $$ 之后 Shift+← ════════');
      const md = '前段甲\n\n$$\na+b=1\n$$\n\n后段乙\n';
      await setValue(md);
      const shape = await session.js(SHAPE);
      console.log('markdown : ' + JSON.stringify(md));
      console.log('块序列   : ' + JSON.stringify(shape.rows));
      console.log('块公式   : ' + JSON.stringify(shape.blocks));
      const spots = [
        {why: '点公式渲染区正中', spec: {index: 1, at: 'preview', left: null, top: null}},
        {why: '点公式末行右侧空白', spec: {index: 1, at: 'owner', left: null, top: null, dx: 0}},
      ];
      for (const spot of spots) {
        const hit = await clickAt(session, spot.spec);
        console.log(`\n  ── ${spot.why} ── elementFromPoint=${hit.hit} 在公式节点内=${hit.inOwner}`);
        console.log('    点后光标: ' + showCaret(await session.js(CARET)));
        const walk = await shiftWalk(session, 3);
        walk.forEach(step => console.log(`      Shift+← #${step.第i}: 长度=${step.选区长度} 选中=${JSON.stringify(step.选区)} 容器=${step.容器}@${step.偏移} 层=${step.层}`));
        console.log('    三次之后: ' + showCaret(await session.js(CARET)));
        console.log('    getValue: ' + JSON.stringify(await session.js(MD)));
      }
      // 程序化的三个"闭围栏之后"形状
      const shapes = [
        ['段末（后段乙@0）', `(() => { const t = surface.children[2].firstChild; const r = d.createRange(); r.setStart(t, 0); r.collapse(true); return {range: r, why: '后段乙@0'}; })()`],
        ['owner 之后（位置型）', `(() => { const owner = surface.children[1]; const r = d.createRange(); r.setStartAfter(owner); r.collapse(true); return {range: r, why: '块节点之后'}; })()`],
        ['围栏内（闭 $ 上）', `(() => { const owner = surface.children[1]; const marks = [...owner.querySelectorAll('.vditor-ir__marker')];
            const last = marks[marks.length - 1]; const t = last.firstChild; if (!t) return {why: '闭围栏没有文本'};
            const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true); return {range: r, why: '闭围栏文本末尾'}; })()`],
      ];
      for (const [why, js] of shapes) {
        const placed = await place(session, js);
        console.log(`\n  ── 程序放位 ${why} ── ${JSON.stringify(placed)}`);
        console.log('    放位后光标: ' + showCaret(await session.js(CARET)));
        const walk = await shiftWalk(session, 3);
        walk.forEach(step => console.log(`      Shift+← #${step.第i}: 长度=${step.选区长度} 选中=${JSON.stringify(step.选区)}`));
      }
      console.log('\n  ── 对照：行内公式尾 $ 之后 Shift+← ──');
      await setValue('前段甲 $a+b=1$ 后段乙\n');
      const walkInline = await (async () => {
        const placed = await place(session, `(() => { const owner = surface.querySelector('.vditor-ir__node[data-type="inline-node"]');
          const r = d.createRange(); r.setStartAfter(owner); r.collapse(true); return {range: r, why: '行内公式之后'}; })()`);
        console.log('    ' + JSON.stringify(placed) + ' → ' + showCaret(await session.js(CARET)));
        return shiftWalk(session, 4);
      })();
      walkInline.forEach(step => console.log(`      Shift+← #${step.第i}: 长度=${step.选区长度} 选中=${JSON.stringify(step.选区)} 层=${step.层}`));
    }

    if (only.includes('C')) {
      console.log('\n════════ C 整行只有行内公式：上下方向键 ════════');
      const docs = [
        ['对照——中间行是纯文字', '上段甲\n\n中段乙\n\n下段丙\n'],
        ['中间行只有一条行内公式', '上段甲\n\n$a$\n\n下段丙\n'],
        ['中间行有两条行内公式', '上段甲\n\n$a$ $b$\n\n下段丙\n'],
        ['中间行：公式 + 文字', '上段甲\n\n$a$ 乙\n\n下段丙\n'],
        ['中间行是块公式', '上段甲\n\n$$\na+b\n$$\n\n下段丙\n'],
      ];
      for (const [label, md] of docs) {
        await setValue(md);
        console.log(`\n  ── ${label} ── ${JSON.stringify(md)}`);
        console.log('    块序列: ' + JSON.stringify((await session.js(SHAPE)).rows.map(row => `#${row.i}:${row.tag}${row.type ? '[' + row.type + ']' : ''} h=${row.rect[3]}`)));
        const start = await place(session, `(() => { const p = surface.children[0].lastChild; if (!p || p.nodeType !== 3) return {why: '首段不是文本'};
          const r = d.createRange(); r.setStart(p, p.data.length); r.collapse(true); return {range: r, why: '首段末尾'}; })()`);
        console.log('    起点: ' + JSON.stringify(start) + ' → ' + showCaret(await session.js(CARET)));
        for (let i = 1; i <= 3; i++) {
          await session.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40});
          await sleep(280);
          console.log(`    ↓ #${i}: ` + showCaret(await session.js(CARET)));
        }
        const end = await place(session, `(() => { const kids = [...surface.children]; const p = kids[kids.length - 1].firstChild;
          if (!p || p.nodeType !== 3) return {why: '末段不是文本'};
          const r = d.createRange(); r.setStart(p, 0); r.collapse(true); return {range: r, why: '末段开头'}; })()`);
        console.log('    终点: ' + JSON.stringify(end) + ' → ' + showCaret(await session.js(CARET)));
        for (let i = 1; i <= 3; i++) {
          await session.key({key: 'ArrowUp', code: 'ArrowUp', vk: 38});
          await sleep(280);
          console.log(`    ↑ #${i}: ` + showCaret(await session.js(CARET)));
        }
      }
    }

    if (only.includes('D')) {
      console.log('\n════════ D 紧贴公式块按退格/删除：现在只弹提示 ════════');
      const md = '前段甲\n\n$$\na+b\n$$\n\n后段乙\n';
      await setValue(md);
      const cases = [
        ['段尾删除（前段甲末尾按 Delete）', `(() => { const p = surface.children[0].lastChild; const r = d.createRange(); r.setStart(p, p.data.length); r.collapse(true); return {range: r, why: '前段甲末尾'}; })()`, 'Delete'],
        ['段首退格（后段乙开头按 Backspace）', `(() => { const p = surface.children[2].firstChild; const r = d.createRange(); r.setStart(p, 0); r.collapse(true); return {range: r, why: '后段乙开头'}; })()`, 'Backspace'],
      ];
      for (const [label, js, key] of cases) {
        const placed = await place(session, js);
        console.log(`\n  ── ${label} ── ${JSON.stringify(placed)} → ${showCaret(await session.js(CARET))}`);
        await session.key({key, code: key, vk: key === 'Delete' ? 46 : 8});
        await sleep(400);
        const toast = await session.js(`(() => { const w = ${IF}; const node = w.document.querySelector('.typora-context-toast'); return node ? node.textContent : null; })()`);
        console.log(`    按 ${key} 后：提示=${JSON.stringify(toast)} 光标=${showCaret(await session.js(CARET))}`);
        const now = await session.js(MD);
        console.log('    getValue=' + JSON.stringify(now) + '（与打开时' + (now === md ? '相同' : '不同') + '）');
      }
      // 点渲染区再退格
      const hit = await clickAt(session, {index: 1, at: 'preview', left: null, top: null});
      console.log(`\n  ── 点公式渲染区再退格 ── elementFromPoint=${hit.hit} → ${showCaret(await session.js(CARET))}`);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(400);
      console.log('    提示=' + JSON.stringify(await session.js(`(() => { const w = ${IF}; const node = w.document.querySelector('.typora-context-toast'); return node ? node.textContent : null; })()`)));
      console.log('    getValue=' + JSON.stringify(await session.js(MD)));
      // 展开态下的围栏退格（用户说的"第二组 $$ fence 后"顺带按退格）
      const placed = await place(session, `(() => { const owner = surface.children[1]; const marks = [...owner.querySelectorAll('.vditor-ir__marker')];
        const last = marks[marks.length - 1]; const t = last.firstChild; if (!t) return {why: '闭围栏没有文本'};
        const r = d.createRange(); r.setStart(t, t.data.length); r.collapse(true); return {range: r, why: '闭围栏末尾'}; })()`);
      console.log(`\n  ── 闭围栏上退格 ── ${JSON.stringify(placed)} → ${showCaret(await session.js(CARET))}`);
      await session.key({key: 'Backspace', code: 'Backspace', vk: 8});
      await sleep(400);
      console.log('    提示=' + JSON.stringify(await session.js(`(() => { const w = ${IF}; const node = w.document.querySelector('.typora-context-toast'); return node ? node.textContent : null; })()`)));
      console.log('    光标=' + showCaret(await session.js(CARET)));
      console.log('    getValue=' + JSON.stringify(await session.js(MD)));
    }

    const errors = await session.jsSoft(`(() => { const w = ${IF}; return (w.__acc && w.__acc.errors) || []; })()`);
    console.log('\nconsole 错误：' + JSON.stringify(errors.value));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
