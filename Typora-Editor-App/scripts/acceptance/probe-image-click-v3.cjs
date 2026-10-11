/** 探针 · 图片交互第三批：逐条钉死。
 *
 *  A. 连点 2/3/4/5 次：每次读 `--expand` 终态；并给 DOMTokenList.add/remove 装带调用栈的
 *     记录器，指名道姓谁在"第 3 次点击"时把 `--expand` 摘掉。
 *  B. "点右侧/下方之后真的打字"：截图里的光标可能是合成的；判据是**打进去的字落在哪**
 *     （源码 mdNow + 落点读数）。
 *
 *  用法：node scripts/acceptance/probe-image-click-v3.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-image-click-v3');
const IF = hi.IF;

const BODY_MID = ['# 中图文档', '', '前文甲乙丙。', '', '![中图](shot-blue.png)', '', '后文丁戊己。', ''].join('\n');
const BODY_TAIL = ['# 尾图文档', '', '正文一行。', '', '![尾图](shot-blue.png)', ''].join('\n');

const PICK = alt => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '') === '${alt}');
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  let top = img; while (top.parentElement && top.parentElement !== s) top = top.parentElement;
  const b = top.getBoundingClientRect();
  return { ok: true,
    中心: { x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) },
    右外40: { x: Math.round(fr.x + r.right + 40), y: Math.round(fr.y + r.top + r.height / 2) },
    右外200: { x: Math.round(fr.x + r.right + 200), y: Math.round(fr.y + r.top + r.height / 2) },
    图下20: { x: Math.round(fr.x + r.left + 20), y: Math.round(fr.y + r.bottom + 20) },
    块索引: [...s.children].indexOf(top), 块数: s.children.length,
    块盒: { l: Math.round(fr.x + b.left), r: Math.round(fr.x + b.right), t: Math.round(fr.y + b.top), b: Math.round(fr.y + b.bottom) },
    图盒: { l: Math.round(fr.x + r.left), r: Math.round(fr.x + r.right), t: Math.round(fr.y + r.top), b: Math.round(fr.y + r.bottom) } }; })()`;

const READ = alt => `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection(); const s = d.querySelector('${hi.SURFACE}');
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '') === '${alt}');
  const owner = img && img.closest('.vditor-ir__node[data-type="img"]');
  const 展开 = owner ? owner.classList.contains('vditor-ir__node--expand') : null;
  const 类 = owner ? owner.className : null;
  if (!sel || !sel.rangeCount) return { 选区: null, 展开, 类 };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const inEditor = !!(at && s.contains(at));
  let 块 = -1; if (inEditor) { let top = at; while (top.parentElement && top.parentElement !== s) top = top.parentElement; 块 = [...s.children].indexOf(top); }
  const 层 = !inEditor ? '外' : at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
  const prefix = r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 16), r.startOffset) : '';
  const box = r.getBoundingClientRect();
  return { 展开, 类, 块, 层, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed, 前缀: prefix, 在节点内: !!(at.closest && at.closest('.vditor-ir__node[data-type="img"]')),
    h: Math.round(box.height), x: Math.round(box.left) }; })()`;

const ARM_CLASS = `(() => { const w = ${IF}; if (w.__clsArmed) { w.__clsProbe.changes.length = 0; return { ok: true, re: true }; }
  const log = w.__clsProbe = { changes: [] };
  const t0 = w.performance.now();
  const proto = Object.getPrototypeOf(w.document.querySelector('${hi.SURFACE}').classList);
  const wrap = (name, original) => function (...args) {
    let val = null; try { val = this.value; } catch { val = null; }
    if (val && String(val).includes('vditor-ir__node')) {
      const stack = String(new Error().stack || '').split('\\n').slice(2, 6).map(s => s.trim().replace(/https?:[^)]*\\//, '').slice(0, 110));
      log.changes.push({ t: +(w.performance.now() - t0).toFixed(1), op: name + '(' + args.join(',') + ')', 前: String(val).slice(0, 70), 栈: stack });
    }
    return original.apply(this, args);
  };
  proto.add = wrap('add', proto.add); proto.remove = wrap('remove', proto.remove);
  w.__clsArmed = true;
  return { ok: true }; })()`;
const READ_CLS = `(() => { const w = ${IF}; return w.__clsProbe ? w.__clsProbe.changes : null; })()`;

async function clickAt(session, x, y, clickCount) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}
async function enter(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await session.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
const textPointOf = word => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('${word}'));
  const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const midFile = path.join(OUT, 'mid.md'); fs.writeFileSync(midFile, BODY_MID, 'utf8');
  const tailFile = path.join(OUT, 'tail.md'); fs.writeFileSync(tailFile, BODY_TAIL, 'utf8');
  const exe = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: [path.join(harness.project, 'app/main/main.js')],
      label: 'probe-image-click-v3', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };

  // ══ A. 连点次数 × 展开态 + 摘 class 的凶手 ═══════════════════════════════════
  {
    const session = await hi.openDoc(ctx, midFile, { minBlocks: 4, settleMs: 1400 });
    try {
      const geom = await session.js(PICK('中图'));
      const textPoint = await session.js(textPointOf('前文甲乙丙'));
      await session.js(ARM_CLASS);
      for (const 次数 of [1, 2, 3, 4, 5]) {
        await clickAt(session, textPoint.x, textPoint.y, 1); await harness.sleep(280);
        await session.js(ARM_CLASS);
        for (let i = 1; i <= 次数; i++) { await clickAt(session, geom.中心.x, geom.中心.y, i); await harness.sleep(45); }
        await harness.sleep(380);
        const 终 = await session.js(READ('中图'));
        const 轨迹 = await session.js(READ_CLS);
        say({ ['A/连点' + 次数 + '次']: { 展开: 终.展开, 类: 终.类, 层: 终.层, 容器: 终.容器, 偏移: 终.偏移,
          class变更: (轨迹 || []).map(c => ({ t: c.t, op: c.op, 前: c.前, 栈顶: c.栈[0] })) } });
      }
      await session.shot('A-连点终态');
    } finally { await ctx.release(session); }
  }

  // ══ B. 右侧/下方点击之后打字，字落哪 ═════════════════════════════════════════
  {
    const session = await hi.openDoc(ctx, tailFile, { minBlocks: 3, settleMs: 1400 });
    try {
      const geom = await session.js(PICK('尾图'));
      say({ B几何: geom });
      const 点集 = [{ 名: '右外40', 点: geom.右外40 }, { 名: '右外200', 点: geom.右外200 }, { 名: '图下20', 点: geom.图下20 }];
      for (const { 名, 点 } of 点集) {
        const textPoint = await session.js(textPointOf('正文一行'));
        await clickAt(session, textPoint.x, textPoint.y, 1); await harness.sleep(260);
        const 前 = String(await hi.mdNow(session));
        await clickAt(session, 点.x, 点.y, 1);
        await harness.sleep(340);
        const 落 = await session.js(READ('尾图'));
        await session.type('Q');
        await harness.sleep(420);
        const 打后 = String(await hi.mdNow(session));
        const 焦点 = await session.js(hi.FOCUS);
        say({ ['B/' + 名]: { 落点: 落, 打Q后源码: 打后, 焦点: 焦点.ok, 变化: 前 === 打后 ? '无' : '有' } });
        await session.shot('B-' + 名 + '-打Q');
        // 撤销 Q
        await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
        await harness.sleep(260);
        // 也试"点右侧 → 回车 → 打字"
        if (名 !== '图下20') {
          await clickAt(session, textPoint.x, textPoint.y, 1); await harness.sleep(240);
          await clickAt(session, 点.x, 点.y, 1); await harness.sleep(300);
          await enter(session); await harness.sleep(420);
          const 回车后 = String(await hi.mdNow(session));
          await session.type('Z'); await harness.sleep(400);
          const 打Z = String(await hi.mdNow(session));
          say({ ['B/' + 名 + '+回车+Z']: { 回车后: 回车后 === 前 ? '无变化' : '有变化', 打Z后: 打Z, 焦点: (await session.js(hi.FOCUS)).ok } });
          await session.shot('B-' + 名 + '-回车打Z');
          await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
          await harness.sleep(200);
          await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
          await harness.sleep(240);
        }
      }
    } finally { await ctx.release(session); }
  }

  fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
