/** 临时侦察件（Lead 接管轮）：验证「标记之后 Enter」与「点两下必出源码」两条新契约。
 *  出结论后本文件会被正式场景取代。 */
'use strict';
const fs = require('node:fs');
const hi = require('../../human-input/hi.cjs');

const FULL = ['### 标题内容', '', '后文。', ''].join('\n');
const EMPTY = ['### ', '', '后文。', ''].join('\n');

const 读标题 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false };
  const h = s.querySelector('h1,h2,h3,h4,h5,h6');
  return { ok: true, h3: h ? h.outerHTML : null,
    块: [...s.children].map(b => b.tagName + '[' + (b.textContent || '').replace(/\\u200b/g, '<z>').slice(0, 24) + ']') }; })()`;

const 放光标 = (off, 中) => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false };
  let t = null;
  if (${中}) { t = [...h.childNodes].filter(n => n.nodeType === 3).pop() || null; }
  else { const marker = h.querySelector('[data-type="heading-marker"]'); t = marker ? marker.firstChild : null; }
  if (!t || t.nodeType !== 3) return { ok: false, why: 'no-text', html: h.outerHTML };
  const off = Math.min(${off}, t.data.length);
  const r = d.createRange(); r.setStart(t, off); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, off, len: t.data.length }; })()`;

const 读光标 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const sel = w.getSelection(); if (!sel || !sel.rangeCount) return { 无选区: true };
  const r = sel.getRangeAt(0); const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  return { 折叠: r.collapsed, 容器: r.startContainer.nodeType === 3 ? 'TEXT(' + r.startContainer.data.length + ')' : r.startContainer.nodeName,
    偏移: r.startOffset, 层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段' : '其他' }; })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

const 图片几何 = `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
  const img = [...d.querySelectorAll('${hi.SURFACE} img')].pop(); if (!img) return { ok: false };
  img.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = img.getBoundingClientRect();
  const owner = img.closest('.vditor-ir__node[data-type]');
  const sel = w.getSelection(); const rr = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = rr ? (rr.startContainer.nodeType === 3 ? rr.startContainer.parentElement : rr.startContainer) : null;
  return { ok: true, 中心: { x: Math.round(frame.x + r.left + r.width / 2), y: Math.round(frame.y + r.top + r.height / 2) },
    展开: !!owner && owner.classList.contains('vditor-ir__node--expand'),
    选中: !!img.classList.contains('typora-img-selected'),
    光标在源码: !!(rr && at && owner && owner.contains(at) && at.closest('code[data-type],.vditor-ir__marker')) }; })()`;

const 图BODY = ['# 图', '', '前文甲。', '', '![靶图](shot-blue.png)', '', '后文乙。', ''].join('\n');

/** 拟真连点：按 OS 双击计数规则给 clickCount（间隔 ≤480ms 且位移 ≤4px 时递增，否则归 1）。 */
async function 拟真连点(session, 点, 次数, 间隔) {
  let count = 0, last = -1e9, lx = 0, ly = 0;
  for (let i = 0; i < 次数; i++) {
    if (i) await hi.sleep(间隔);
    const now = Date.now();
    count = (now - last <= 480 && Math.abs(点.x - lx) <= 4 && Math.abs(点.y - ly) <= 4) ? count + 1 : 1;
    last = now; lx = 点.x; ly = 点.y;
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 点.x, y: 点.y, button: 'left', buttons: 1, clickCount: count });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 点.x, y: 点.y, button: 'left', buttons: 0, clickCount: count });
    await hi.sleep(120);
  }
}

module.exports = {
  id: 'leadrecon-heading-and-image',
  title: '侦察：标记之后 Enter 拆行 + 点两下必出源码',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(`${hi.ROOM}/shot-blue.png`, hi.fixtures.png(160, 100, [70, 110, 230]));

    // ══ 一、标题回车 ═════════════════════════════════════════════════════════════
    const file = hi.writeDoc('leadrecon-heading.md', FULL);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      await hi.ensureFocus(session);
      const 用例 = [
        ['① 光标在 marker 之前(off=0)', FULL, 0, false],
        ['② 光标在 marker 之后(off=4)', FULL, 4, false],
        ['③ 光标在 marker 中间(off=1)', FULL, 1, false],
        ['④ 光标在内容中部', FULL, 1, true],
        ['⑤ 空标题 光标在 marker 之后(off=4)', EMPTY, 4, false],
      ];
      for (const [名, md, off, 中] of 用例) {
        await session.js(置文(md));
        await hi.sleep(560);
        await session.js(放光标(off, 中));
        const 前文 = await hi.mdNow(session);
        await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
        await hi.sleep(460);
        const 后文 = await hi.mdNow(session);
        const 后 = await session.js(读标题);
        const 标 = await session.js(读光标);
        ctx.log(`【${名}】前md=${JSON.stringify(前文)} → 后md=${JSON.stringify(后文)}`);
        ctx.log(`    块=${JSON.stringify(后.块)} 光标=${JSON.stringify(标)}`);
        ctx.witness('标题回车侦察：' + 名, { 前文, 后文, 块: 后.块, 标 }, 'dom');
      }
      await session.shot('leadrecon-heading');
    } finally {
      await ctx.release(session);
    }

    // ══ 二、图片出源码 ═══════════════════════════════════════════════════════════
    const file2 = hi.writeDoc('leadrecon-image.md', 图BODY);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 4 });
    try {
      await hi.ensureFocus(session2);
      const 文 = await session2.js(`(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor').getBoundingClientRect();
        const t = [...d.querySelectorAll('${hi.SURFACE} p')].find(p => p.textContent.includes('后文乙'));
        const r = t.getBoundingClientRect(); return { x: Math.round(frame.x + r.left + 20), y: Math.round(frame.y + r.top + r.height / 2) }; })()`);
      const 场景 = [[1, 500, '单击 1 次（护栏：只选中）'], [2, 700, '慢点 2 次 @700ms'],
        [2, 1800, '极慢点 2 次 @1800ms（不许有时间坎）'], [3, 700, '慢点 3 次 @700ms'],
        [2, 150, '快点 2 次 @150ms'], [3, 150, '快点 3 次 @150ms'],
        [4, 150, '快点 4 次 @150ms'], [6, 700, '慢点 6 次 @700ms']];
      for (const [次数, 间隔, 名] of 场景) {
        await session2.click(文.x, 文.y); await hi.sleep(320);
        const g = await session2.js(图片几何);
        await 拟真连点(session2, g.中心, 次数, 间隔);
        await hi.sleep(420);
        const 终 = await session2.js(图片几何);
        const 判 = 次数 === 1 ? (!终.展开 && 终.选中) : 终.展开;
        ctx.log(`图片【${名}】→ 展开=${终.展开} 选中=${终.选中} 光标在源码=${终.光标在源码} ${判 ? 'OK' : '✗'}`);
        ctx.witness(`图片 ${名}`, { 展开: 终.展开, 选中: 终.选中, 光标在源码: 终.光标在源码, 判 }, 'dom');
      }

      // ── R-3 复查（审计报告指出的名册/延迟 B() 排队风险）：点正文收起之后再真实失焦，
      //    源码不许自己冒出来。
      const 外点 = await session2.js(`(() => { const f = document.getElementById('editor').getBoundingClientRect();
        const 候选 = [...document.querySelectorAll('*')].filter(n => { const r = n.getBoundingClientRect();
          return r.width > 40 && r.height > 12 && r.top < f.top - 4 && r.bottom <= f.top; }).slice(0, 3);
        return { frameTop: Math.round(f.top), 候选: 候选.map(n => n.className || n.tagName) }; })()`);
      ctx.log('失焦候选点调查：' + JSON.stringify(外点));
      const 靶 = { x: 240, y: Math.max(6, Math.round(外点.frameTop / 2)) };
      await session2.click(文.x, 文.y); await hi.sleep(300);
      const g10 = await session2.js(图片几何);
      await 拟真连点(session2, g10.中心, 2, 700);
      const 展 = await session2.js(图片几何);
      await session2.click(文.x, 文.y); await hi.sleep(420);
      const 收 = await session2.js(图片几何);
      await session2.click(靶.x, 靶.y); await hi.sleep(900);          // 真实鼠标点编辑面之外 → blur
      const 失焦后 = await session2.js(图片几何);
      ctx.log(`R-3 复查：展开=${展.展开} → 点正文收起=${收.展开} → 真实失焦后=${失焦后.展开}（期望 false/false）`);
      ctx.witness('R-3 名册复活复查', { 展开: 展.展开, 收起: 收.展开, 失焦后: 失焦后.展开 }, 'dom');
      await session2.shot('leadrecon-image');
    } finally {
      await ctx.release(session2);
    }
  },
};
