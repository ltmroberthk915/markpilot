/** 130 · 侧栏大纲/外部链接/焦点完整性：Ctrl+Alt+B 开关侧栏、大纲面板点条目跳转、
 *  点链接交给系统（shell 替身证人）、侧栏操作后打字仍落进编辑器。
 *
 *  举一反三自 2.2.8「查找面板焦点被抢」：任何面板/侧栏交互之后，键盘输入必须
 *  仍然落进编辑器——这是"焦点完整性"这一类，不是查找面板那一个点。
 *  R10-P7 改写（E10 抽查 13 / §0-C8）：② 原断言双错位——在 **shell 文档**里查
 *  aside,nav,[class*=outline] 找大纲条目（大纲面板其实渲染在**编辑器 iframe 内**，
 *  由 shell 状态栏 #st-outline 按钮驱动，shell.js:138-143），而且从未点开大纲面板、
 *  旧读数 HEADING_VISIBLE 还自带 scrollIntoView（读数自己把标题滚进视口，量法永真）。
 *  改写对齐 battery18 E1 的绿色量法：点 #st-outline 开面板 → iframe 内查
 *  .vditor-outline__item 含『节一甲』→ 点击 → 对应标题滚进视口上部；读数不再自带滚动。
 */
'use strict';
const hi = require('../hi.cjs');

// R10-P7 改写：正文加填充段把『节一甲』推出首屏——大纲点击的"滚进视口上部"必须有
// 可滚的距离才量得出真跳转（原短文档标题本来就全在视口内，跳转断言空转）。
const BODY = [
  '# 章一',
  '',
  '章一内容甲。',
  '',
  ...Array.from({ length: 40 }, (_, i) => [`填充第 ${i + 1} 段：把后面的标题推出首屏。`, '']).flat(),
  '## 节一甲',
  '',
  '节一甲内容。',
  '',
  '## 节一乙',
  '',
  '节一乙内容。',
  '',
  '# 章二',
  '',
  '[外部链接点这里](https://example.com/human-input)',
  '',
  '章二内容收尾。',
  '',
].join('\n');

const SIDEBAR_STATE = `(() => {
  const nodes = [...document.querySelectorAll('aside, nav, [class*="sidebar" i], [class*="outline" i]')];
  const visible = nodes.filter(n => { const r = n.getBoundingClientRect(); return r.width > 80 && r.height > 120; });
  return { 可见数: visible.length, 标识: visible.map(n => n.tagName + '.' + String(n.className).slice(0, 40)).slice(0, 4) }; })()`;

// R10-P7 改写：删原 OUTLINE_ENTRY（在 shell 文档找大纲条目——域错）与原
// HEADING_VISIBLE（读数里自带 head.scrollIntoView，量法永真），换 battery18 E1 量法：
// 面板开关在 shell 状态栏，面板条目在编辑器 iframe 内，标题位置只读不滚。
const OUTLINE_BTN = `(() => { const b = document.getElementById('st-outline'); if (!b) return { ok: false };
  const r = b.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;

const OUTLINE_ITEMS = `(() => { const w = ${hi.IF}; if (!w || !w.document) return [];
  const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  return [...w.document.querySelectorAll('.vditor-outline__item, .vditor-outline li, .vditor-outline a')].map(el => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim().slice(0, 24), x: Math.round(fr.x + r.x + 8), y: Math.round(fr.y + r.y + r.height / 2), h: Math.round(r.height) }; }); })()`;
// 【V10 校准】上一行原为 `…; })()`——map 回调闭掉后直接 `()`，外层 IIFE 未闭合，
// 运行时 SyntaxError: Unexpected end of input（r10-v10-human 实测）。补 `; });` 闭合。

const HEADING_TOP = word => `(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
  const s = d.querySelector('${hi.SURFACE}');
  const head = [...s.querySelectorAll('h1,h2,h3')].find(n => n.textContent.includes('${word}'));
  if (!head) return { ok: false };
  const r = head.getBoundingClientRect();
  return { ok: true, 顶: Math.round(r.top), 可见: r.top >= 0 && r.bottom <= fr.height, 帧高: Math.round(fr.height) }; })()`;

module.exports = {
  id: '130-hi-outline-links-sidebar',
  title: '侧栏/大纲/链接：Ctrl+Alt+B 开关、大纲点击跳转标题可见、链接交系统替身、面板后打字仍进编辑器',
  run: async ctx => {
    const file = hi.writeDoc('outline-links.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 12, inspect: true });
    try {
      const md0 = String(await hi.mdNow(session));
      ctx.assert('文档打开', md0.includes('节一甲') && md0.includes('外部链接'), md0.slice(0, 40));

      // ══ ① Ctrl+Alt+B：侧栏状态翻转（不管初始开还是关） ═══════════════════════════
      const before = await session.js(SIDEBAR_STATE);
      await hi.combo(session, 'Ctrl+Alt+B');
      await hi.sleep(900);
      const after = await session.js(SIDEBAR_STATE);
      ctx.witness('几何：Ctrl+Alt+B 前后的侧栏状态', { 前: before, 后: after }, 'geometry');
      ctx.assert('① Ctrl+Alt+B 后侧栏状态翻转（可见数变化）', after.可见数 !== before.可见数, JSON.stringify({ before, after }));

      // ══ ② 大纲面板：点 #st-outline 开面板 → 点『节一甲』条目 → 标题滚进视口上部 ═══
      // R10-P7 改写：原断言「侧栏开着时在 shell 文档找大纲条目」双错位（E10 抽查 13：
      // 大纲面板在编辑器 iframe 内渲染、由 shell 状态栏 #st-outline 驱动，shell 文档里
      // 根本没有大纲条目；且原流程从未点开过面板）。按 battery18 E1 的绿色量法重做：
      // 点开关 → iframe 内查 .vditor-outline__item → 真点击 → 标题位置只读不滚。
      // 断言两头都量：点击前标题不在视口上部（有可滚的距离，防空转），点击后滚进上部。
      const outlineBtn = await session.js(OUTLINE_BTN);
      ctx.assert('② 前置：shell 状态栏有 #st-outline 大纲开关', outlineBtn.ok, JSON.stringify(outlineBtn));
      if (!outlineBtn.ok) {
        ctx.assert('② 大纲面板开→点条目→跳转（无开关，整段无法执行）', false, JSON.stringify(outlineBtn));
      } else {
        const beforeHeading = await session.js(HEADING_TOP('节一甲'));
        await session.click(outlineBtn.x, outlineBtn.y);
        await hi.sleep(2000);
        const outlineItems = await session.js(OUTLINE_ITEMS);
        // 【V10 校准】原 find(text.includes) 会先命中分组容器项（如「章一节一甲节一乙」
        // h=78，列表首位）——点分组头是展开/收起不是跳转（r10-v10-human-130 实测不滚；
        // 隔离诊断 battery18 同式 + 叶子项过滤后 scrollTop 0→1424 正常跳）。改精确文本
        // 匹配叶子项。
        const entry = outlineItems.find(item => item.text === '节一甲' && item.h > 0)
          || outlineItems.find(item => item.text.includes('节一甲') && item.h > 0 && item.h < 40);
        ctx.witness('几何：大纲面板条目（iframe 内 vditor-outline）',
          { 条目数: outlineItems.length, 目标: entry || null, 点击前标题位置: beforeHeading }, 'geometry');
        ctx.assert('② 点开大纲面板后，iframe 里有『节一甲』条目可点', !!entry,
          JSON.stringify({ 条目样本: outlineItems.slice(0, 6), 点击前标题: beforeHeading }));
        if (entry) {
          await session.move(entry.x, entry.y);
          await session.click(entry.x, entry.y);
          await hi.sleep(2200);
          const afterHeading = await session.js(HEADING_TOP('节一甲'));
          ctx.witness('几何：点大纲条目前后的标题位置', { 前: beforeHeading, 后: afterHeading }, 'geometry');
          ctx.assert('② 点大纲『节一甲』后标题滚进视口上半（点击前不可见，跳转是真的）',
            // 【V10 校准·对齐 battery18 E1 量法】E1 绿色判据=「跳转发生」（滚动量变化）；
            // 实测 vditor 大纲跳转把标题停在中上区（1854→348/帧高713），「顶<=200」超出
            // 产品行为。校准为：点击前不可见 + 点击后可见且落上半视口（顶 <= 帧高/2）。
            !!(afterHeading.ok && afterHeading.可见 && afterHeading.顶 <= Math.round(afterHeading.帧高 / 2)
              && (!beforeHeading.ok || !beforeHeading.可见)),
            JSON.stringify({ 前: beforeHeading, 后: afterHeading }));
        }
        await session.click(outlineBtn.x, outlineBtn.y);   // 收起面板，别遮后面的链接/打字
        await hi.sleep(800);
      }

      // ══ ③ 点外部链接文字：交给系统（shell 替身证人），编辑器不导航 ═══════════════
      const link = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const frame = document.getElementById('editor'); const fr = frame.getBoundingClientRect();
        const s = d.querySelector('${hi.SURFACE}');
        for (const block of s.children) {
          const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT); let node;
          while (node = walker.nextNode()) {
            const at = node.data.indexOf('外部链接点这里');
            if (at < 0) continue;
            const r = d.createRange(); r.setStart(node, at); r.setEnd(node, at + 7);
            const rect = r.getBoundingClientRect();
            if (rect.width > 0) return { ok: true, x: Math.round(fr.x + rect.x + rect.width / 2), y: Math.round(fr.y + rect.y + rect.height / 2) };
          }
        }
        return { ok: false }; })()`);
      if (link.ok) {
        const shellBefore = (await session.main.shellCalls()).length;
        await session.click(link.x, link.y);
        await hi.sleep(900);
        const calls = await session.main.shellCalls();
        const openExternal = calls.filter(call => call.name === 'openExternal' && String(call.target).includes('example.com/human-input'));
        ctx.witness('进程：链接点击后的 shell 调用', { calls: calls.slice(-3), openExternal数: openExternal.length }, 'process');
        ctx.assert('③ 链接交给系统打开（openExternal 且 URL 正确；IR 模式若需 Ctrl+点击则记为待定）',
          openExternal.length >= 1, JSON.stringify(calls.slice(-3)));
        const hrefNow = await session.js(`(() => { const w = ${hi.IF}; return w.location.href; })()`);
        ctx.assert('③ 编辑器没有被导航走（还在 /shell）', String(hrefNow).includes('shell') || !String(hrefNow).includes('example.com'), String(hrefNow));
      } else {
        ctx.assert('③ 找到链接文字坐标（前置）', false, JSON.stringify(link));
      }

      // ══ ④ 焦点完整性：面板/侧栏操作之后打字仍落进编辑器 ═════════════════════════
      await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
      await hi.sleep(300);
      await session.type('尾部加字');
      await hi.sleep(400);
      const mdTyped = String(await hi.mdNow(session));
      ctx.assert('④ 侧栏/链接操作后打字落进文档末尾', mdTyped.includes('尾部加字'), mdTyped.slice(-40));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ⑤ 再按一次收起侧栏 + 磁盘证人 ═════════════════════════════════════════
      await hi.combo(session, 'Ctrl+Alt+B');
      await hi.sleep(900);
      const closed = await session.js(SIDEBAR_STATE);
      ctx.assert('⑤ 再按 Ctrl+Alt+B 侧栏收起', closed.可见数 <= before.可见数, JSON.stringify({ closed, before }));
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 60) }, 'disk');
      ctx.assert('⑤ 磁盘 == 原文（撤销已清掉打字）', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 60));
    } finally {
      await ctx.release(session);
    }
  },
};
