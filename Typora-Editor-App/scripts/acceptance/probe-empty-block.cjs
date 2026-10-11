/** 追捕 A：空块公式（`$$` 一行 / 空行 / `$$` 一行）到底是什么形状、
 *  为什么"看不见也删不掉"，以及为什么在里面按删除会把字面 `span` 写进 markdown。
 *
 *  probe-math-keys.cjs 已经量到：setValue 后 getValue 从 `$$\n\n$$` 变成 `$$\n\n\n$$`（源码是
 *  一个 `\n`）；点进去再按删除，markdown 变成 `$$\nspan\n$$`。这里把每一步的 DOM 与 markdown
 *  同时打出来，定位"span"从哪来。
 *
 *  用法：node scripts/acceptance/probe-empty-block.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-empty-block');
const IF = `document.getElementById('editor').contentWindow`;

const SHAPE = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector('.vditor-ir .vditor-reset');
  if (!surface) return {ok: false, error: '没有编辑面'};
  const pretty = html => String(html || '').replace(/></g, '>\\n<').slice(0, 2200);
  const rows = [...surface.children].map((node, index) => {
    const box = node.getBoundingClientRect();
    return {i: index, tag: node.nodeName.toLowerCase(), type: node.dataset ? node.dataset.type || null : null,
      h: Math.round(box.height), text: JSON.stringify(String(node.innerText || '').slice(0, 30)),
      html: pretty(node.outerHTML)};
  });
  const blocks = [...surface.querySelectorAll('code[data-type="math-block"]')].map(code => {
    const owner = code.closest('.vditor-ir__node,div[data-type]') || code;
    return {src: JSON.stringify(code.textContent), empty: !code.textContent.trim(),
      expanded: owner.classList.contains('vditor-ir__node--expand'),
      ownerHTML: pretty(owner.outerHTML), parent: owner.parentElement ? owner.parentElement.nodeName.toLowerCase() : null};
  });
  return {ok: true, rows, blocks, md: w.vditor.getValue(),
    caret: (() => { const s = w.getSelection(); if (!s.rangeCount) return null; const r = s.getRangeAt(0);
      const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
      const owner = at.closest && at.closest('.vditor-ir__node,div[data-type]');
      return {collapsed: r.collapsed, container: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName,
        offset: r.startOffset, layer: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('.vditor-ir__marker') ? '围栏' : '正文',
        owner: owner ? owner.nodeName.toLowerCase() + (owner.dataset && owner.dataset.type ? '[' + (owner.dataset.type || '') + ']' : '') : null,
        box: (() => { const b = r.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })()}; })()}; })()`;

const MD = `(() => { const w = ${IF}; return w.vditor.getValue(); })()`;
const TOAST = `(() => { const w = ${IF}; const node = w.document.querySelector('.typora-context-toast'); return node ? node.textContent : null; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'empty.md');
  fs.writeFileSync(doc, '占位\n', 'utf8');
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-empty-block', outDir: OUT, args: [doc], timeout: 600000, inspect: true,
  });
  const dump = async label => {
    const shape = await session.js(SHAPE);
    console.log(`\n──── ${label} ────`);
    console.log('  markdown : ' + JSON.stringify(shape.md));
    console.log('  光标     : ' + JSON.stringify(shape.caret));
    for (const row of shape.rows) console.log(`  块#${row.i} ${row.tag}${row.type ? '[' + row.type + ']' : ''} h=${row.h} text=${row.text}`);
    for (const block of shape.blocks) console.log(`  ── 块公式（${block.empty ? '空' : '有内容'}${block.expanded ? ' 展开' : ''}）父=${block.parent}\n${block.ownerHTML.split('\n').map(line => '     ' + line).join('\n')}`);
  };
  const clickIn = async (index, share) => {
    const hit = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
      const surface = d.querySelector('.vditor-ir .vditor-reset');
      const block = surface.children[${index}];
      block.scrollIntoView({block: 'center', behavior: 'instant'});
      const box = block.getBoundingClientRect(), fr = frame.getBoundingClientRect();
      return {x: Math.round(fr.x + box.left + box.width / 2), y: Math.round(fr.y + box.top + box.height * ${share})}; })()`);
    await session.click(hit.x, hit.y);
    await sleep(360);
    return hit;
  };
  const press = async (key, vk) => { await session.key({key, code: key, vk}); await sleep(420);
    return {md: await session.js(MD), toast: await session.js(TOAST)}; };

  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`, {timeout: 140000, interval: 80});
    await sleep(1600);
    const setValue = async text => {
      await session.js(`(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(text)}); return 1; })()`);
      await sleep(1400);
    };

    console.log('══════ ① 对照：有内容的块公式长什么样 ══════');
    await setValue('前段甲\n\n$$\na+b\n$$\n\n后段乙\n');
    await dump('有内容（折叠）');
    await clickIn(1, 0.5);
    await dump('有内容（点击后）');

    console.log('\n══════ ② 空块公式 ══════');
    const md = '前段甲\n\n$$\n\n$$\n\n后段乙\n';
    await setValue(md);
    await dump('空块（刚装载）');
    const hit = await clickIn(1, 0.55);
    console.log('\n  点在第 1 块的 55% 高度处：' + JSON.stringify(hit));
    await dump('空块（点击后）');
    let result = await press('Delete', 46);
    console.log('\n  按 Delete：md=' + JSON.stringify(result.md) + ' 提示=' + JSON.stringify(result.toast));
    await dump('按 Delete 之后');
    await session.chord('z', 'KeyZ', 90); await sleep(600);
    console.log('\n  撤销后 md=' + JSON.stringify(await session.js(MD)));
    result = await press('Backspace', 8);
    console.log('\n  按 Backspace：md=' + JSON.stringify(result.md) + ' 提示=' + JSON.stringify(result.toast));
    await dump('按 Backspace 之后');

    console.log('\n══════ ③ 用户文档的形状（正文 → 空块 → 加粗标题）══════');
    await setValue('则最多可服\n\n$$\n\n$$\n\n**非整数解**:目标\n');
    await dump('用户形状（刚装载）');
    await clickIn(1, 0.5);
    await dump('用户形状（点击后）');
    result = await press('Delete', 46);
    console.log('\n  按 Delete：md=' + JSON.stringify(result.md) + ' 提示=' + JSON.stringify(result.toast));
    console.log('  磁盘/内存一致吗：' + JSON.stringify(await session.js(MD)));

    console.log('\n══════ ④ 空块在文档末尾 ══════');
    await setValue('前段甲\n\n$$\n\n$$\n');
    await dump('末尾空块');
    await clickIn(1, 0.5);
    result = await press('Delete', 46);
    console.log('\n  按 Delete：md=' + JSON.stringify(result.md));

    console.log('\n══════ ⑤ 空块在段落中间（前后都有文字，空块紧贴整段）══════');
    await setValue('段落甲\n\n$$\n$$\n\n段落乙\n');
    await dump('紧邻空块（$$ 与 $$ 之间没有空行）');
    await clickIn(1, 0.5);
    result = await press('Delete', 46);
    console.log('\n  按 Delete：md=' + JSON.stringify(result.md));

    const errors = await session.jsSoft(`(() => { const w = ${IF}; return (w.__acc && w.__acc.errors) || []; })()`);
    console.log('\nconsole 错误：' + JSON.stringify(errors.value));
    await session.shot('empty-block').catch(() => {});
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
