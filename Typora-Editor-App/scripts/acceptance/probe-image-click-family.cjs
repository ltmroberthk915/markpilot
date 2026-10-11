/** 探针 · 用户 2026-10-02 报的两个图片交互缺陷。
 *
 *  ① "点击图片高频率点击有概率触发无法展开源码"：同一张图上连续快速点击（真人双击/连点），
 *     有时 `vditor-ir__node--expand` 加不上——源码展不开。本探针按固定间隔/固定次数重放
 *     点击序列，每次都从"折叠态"起步，记录 mousedown/mouseup/click 的 detail、产品处理器的
 *     preventDefault 结局、节点 class 变更时间线，最后读展开态与光标层。
 *  ② "图片右侧空白点击后，逻辑应该是插入一个图片之后的光标，回车创建新一行"：
 *     在图片右缘外 40px、图片垂直中线处点一下，读落点（块/层/偏移/前缀），再按 Enter 看
 *     是否在图片之后新起一行；文档以图片结尾的版本同样测。
 *
 *  用法：node scripts/acceptance/probe-image-click-family.cjs [--dev]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, DEV ? '.perf/probe-image-click-family-dev' : '.perf/probe-image-click-family');
const IF = hi.IF;

const BODY = [
  '# 图片交互',
  '',
  '前文甲乙丙。',
  '',
  '![靶图](shot-blue.png)',
  '',
  '后文丁戊己。',
  '',
].join('\n');

const BODY_TAIL = [
  '# 尾图文档',
  '',
  '正文一行。',
  '',
  '![尾图](shot-blue.png)',
  '',
].join('\n');

/** 图片几何 + 点击点（页面坐标）：中心、右缘外 40px（同一行）、左缘外 40px。 */
const PICK = alt => `(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '') === '${alt}');
  if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type="img"]');
  const block = (() => { let top = img; const s = d.querySelector('${hi.SURFACE}'); while (top.parentElement && top.parentElement !== s) top = top.parentElement; return top; })();
  const bs = d.querySelector('${hi.SURFACE}');
  return { ok: true,
    中心: { x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) },
    右外: { x: Math.round(fr.x + r.right + 40), y: Math.round(fr.y + r.top + r.height / 2) },
    左外: { x: Math.round(fr.x + r.left - 40), y: Math.round(fr.y + r.top + r.height / 2) },
    图右缘: Math.round(fr.x + r.right), 图左缘: Math.round(fr.x + r.left),
    块索引: [...bs.children].indexOf(block),
    块盒: (() => { const b = block.getBoundingClientRect(); return { l: Math.round(fr.x + b.left), r: Math.round(fr.x + b.right), t: Math.round(fr.y + b.top), b: Math.round(fr.y + b.bottom) }; })(),
    节点HTML: owner ? owner.outerHTML.slice(0, 300) : null,
    块HTML: block.outerHTML.slice(0, 400) }; })()`;

/** 落点读数：光标在哪一层、哪个容器、偏移、前缀、是否在图片节点里、展开态。 */
const READ = alt => `(() => { const w = ${IF}, d = w.document; const sel = w.getSelection();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '') === '${alt}');
  const owner = img && img.closest('.vditor-ir__node[data-type="img"]');
  const 展开 = owner ? owner.classList.contains('vditor-ir__node--expand') : null;
  if (!sel || !sel.rangeCount) return { 选区: null, 展开 };
  const r = sel.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const s = d.querySelector('${hi.SURFACE}');
  const inEditor = !!(at && s.contains(at));
  const 层 = !inEditor ? '外' : at.closest('code') ? '源码' : at.closest('.vditor-ir__preview') ? '预览'
    : at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
  const prefix = r.startContainer.nodeType === 3 ? r.startContainer.data.slice(Math.max(0, r.startOffset - 16), r.startOffset) : '';
  return { 展开, 层, 在图片节点内: !!(at && owner && owner.contains(at)),
    容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 折叠: r.collapsed, 前缀: prefix }; })()`;

/** 在 iframe 里装事件时间线：mousedown/up/click 的 detail 与"产品是否 preventDefault"、
 *  以及图片节点 class 的变更时间线。探针的监听器在产品之后注册，所以读到的
 *  `defaultPrevented` 就是"产品（含同节点更早的监听器）是否已拦"——同一阶段按注册顺序跑。 */
const ARM = alt => `(() => { const w = ${IF}, d = w.document;
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].find(n => (n.getAttribute('alt') || '') === '${alt}');
  if (!img) return { ok: false, error: '没有图片' };
  const owner = img.closest('.vditor-ir__node[data-type="img"]');
  if (!owner) return { ok: false, error: '没有 IR 节点外壳' };
  const log = w.__imgProbe = { events: [], classes: [] };
  const t0 = w.performance.now();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    d.addEventListener(type, event => {
      const target = event.target;
      log.events.push({ t: +(w.performance.now() - t0).toFixed(1), type, detail: event.detail,
        target: target.nodeName + '.' + String(target.className || '').split(' ').slice(0, 2).join('.'),
        图片上: !!(target.closest && target.closest('img')), 已拦: event.defaultPrevented, 阶段: '捕获' });
    }, true);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) if (record.attributeName === 'class') {
      log.classes.push({ t: +(w.performance.now() - t0).toFixed(1), cls: owner.className });
    }
  });
  observer.observe(owner, { attributes: true, attributeFilter: ['class'] });
  return { ok: true, 初始类: owner.className, 节点HTML: owner.outerHTML.slice(0, 260) }; })()`;

const READLOG = `(() => { const w = ${IF}; return w.__imgProbe || null; })()`;

/** 点击一个点：press/release 一对，clickCount 按真人连点递增。 */
async function clickAt(session, x, y, clickCount) {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
}

/** 把状态复位到"折叠、光标在正文"：点正文段落再按 Esc 兜底。 */
async function reset(session, textPoint) {
  await clickAt(session, textPoint.x, textPoint.y, 1);
  await harness.sleep(260);
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await harness.sleep(220);
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'shot-blue.png'), hi.fixtures.png(160, 100, [70, 110, 230]));
  const file = path.join(OUT, 'img-click.md');
  fs.writeFileSync(file, BODY, 'utf8');
  const exe = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
  const ctx = {
    launch: options => harness.launch({ exe, ...(DEV ? { appArgs: [path.join(harness.project, 'app/main/main.js')] } : {}),
      label: 'probe-image-click-family', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 4, settleMs: 1500 });
  const log = [];
  const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); console.log(line); log.push(line); };
  try {
    const geom = await session.js(PICK('靶图'));
    say({ 几何: geom });
    say({ 文本点: await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
      const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('前文甲乙丙'));
      const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`) });

    // ══ ① 高频点击 → 展开 ═════════════════════════════════════════════════════
    const 变体 = [
      { 名: '双击60ms', 序列: [{ d: 1, gap: 0 }, { d: 2, gap: 60 }] },
      { 名: '双击120ms', 序列: [{ d: 1, gap: 0 }, { d: 2, gap: 120 }] },
      { 名: '双击250ms', 序列: [{ d: 1, gap: 0 }, { d: 2, gap: 250 }] },
      { 名: '连点4次40ms', 序列: [{ d: 1, gap: 0 }, { d: 2, gap: 40 }, { d: 3, gap: 40 }, { d: 4, gap: 40 }] },
      { 名: '单击1次', 序列: [{ d: 1, gap: 0 }] },
    ];
    for (const 变 of 变体) {
      const 结果 = [];
      for (let 轮 = 1; 轮 <= 4; 轮++) {
        const textPoint = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
          const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('前文甲乙丙'));
          const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`);
        await reset(session, textPoint);
        await session.js(ARM('靶图'));
        for (const step of 变.序列) {
          if (step.gap) await harness.sleep(step.gap);
          await clickAt(session, geom.中心.x, geom.中心.y, step.d);
        }
        await harness.sleep(420);
        const 读 = await session.js(READ('靶图'));
        const ev = await session.js(READLOG);
        结果.push({ 轮, 展开: 读.展开, 层: 读.层, 在图片节点内: 读.在图片节点内, 容器: 读.容器, 偏移: 读.偏移,
          detail序列: ev.events.filter(e => e.type === 'click').map(e => e.detail + (e.已拦 ? '拦' : '放')),
          class轨迹: ev.classes.map(c => (c.cls.includes('--expand') ? '展开' : '折叠')) });
        if (轮 === 1 && 变.名 === '双击60ms') await session.shot('①第一轮-' + 变.名);
      }
      say({ '①': 变.名, 结果 });
    }

    // ══ ② 图片右侧空白点击 → 光标应在图片之后，回车新行 ═════════════════════════
    const 右 = await (async () => {
      const textPoint = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('前文甲乙丙'));
        const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`);
      await reset(session, textPoint);
      const 前 = String(await hi.mdNow(session));
      const 命中 = await session.js(`(() => { const w = ${IF}, d = w.document; const el = d.elementFromPoint(${geom.右外.x}, ${geom.右外.y});
        return el ? el.nodeName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.') : null; })()`);
      await clickAt(session, geom.右外.x, geom.右外.y, 1);
      await harness.sleep(400);
      const 落 = await session.js(READ('靶图'));
      await session.shot('②右外点击');
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await session.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await harness.sleep(500);
      const 后 = String(await hi.mdNow(session));
      await session.shot('②右外点击后回车');
      return { 命中元素: 命中, 落点: 落, 回车后新增行: 后 !== 前, 前: 前.slice(0, 120), 后: 后.slice(0, 140) };
    })();
    say({ '②右外点击': 右 });

    // ══ ③ 图片左外点击（对照） ═══════════════════════════════════════════════════
    const 左 = await (async () => {
      const textPoint = await session.js(`(() => { const w = ${IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('前文甲乙丙'));
        const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`);
      await reset(session, textPoint);
      await clickAt(session, geom.左外.x, geom.左外.y, 1);
      await harness.sleep(320);
      return await session.js(READ('靶图'));
    })();
    say({ '③左外点击': 左 });
  } finally {
    say({ console错误: session.errors.slice(0, 4), 警告: session.warnings.slice(0, 4) });
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
    await ctx.release(session);
  }
})();
