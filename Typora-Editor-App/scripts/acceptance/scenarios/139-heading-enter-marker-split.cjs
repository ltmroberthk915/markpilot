/** 139 · 标题回车：标记之后按回车＝标记钉在原行、内容落到下一行变普通段落
 *
 *  用户 2026-10-05 报（问题1）：「### [光标] 标题内容 这个情形，在光标位置按回车，并不会让
 *  这三个井号所表示的三级标题固定在当前行不动、只让标题内容被回撤到下一行变成普通文本；
 *  按回车会导致整个标题行向下移动——那这样和 [光标] ###标题内容 按回车不就没有区别了吗」。
 *
 *  现状取证（修复前，dev 树实测）：`### |标题内容`（光标在标记之后）与 `|### 标题内容`
 *  （光标在标记之前）按回车**完全同形**——都是"标题上方插一个空段、标题整行原样下移"，
 *  光标被送回标题的标记前。于是"井号被固定在原行"这件事在界面上根本不存在。
 *
 *  修复后的契约（三条必须同时成立）：
 *    ① 光标在标记**之前**：仍然是"在标题前插空段、标题整行下移"（Typora 块首语义，不回退）。
 *    ② 光标在标记**之后**（含正好停在标记末尾）：标记留在原行（那一行仍是 h1..h6、内容为空），
 *       标记之后的内容被回撤到**下一行并落成普通段落**；光标落在新段落开头。
 *    ③ 光标停在标记文字**中间**：按块首语义处理（不许把 `##|# 标题` 拆成 `#`+`## 标题`
 *       这种级别错乱），仍走空行分支。
 *
 *  同族扩面（以点扫面：一个 bug 点扫一整面）：
 *    · h1..h6 六级都走同一条契约（不许只有 h3 对）；
 *    · 标题里带**行内公式**时拆分不许丢公式（F 案数据丢失面的同族形态）；
 *    · 拆分之后**立刻退格**（enter-bs 陷阱：碎片合并是行内公式静默消失的历史入口）不许丢；
 *    · 拆分之后 Ctrl+Z 一步回到原样；
 *    · 拆分结果必须真的落盘（磁盘逐字节证人），不是只改了屏上 DOM。
 *
 *  护栏（不许改坏的既有语义）：
 *    · 「文字中间 Enter」的既有拆分形态（左半留在标题里、右半变段落）不回退；
 *    · 标题行完整性：拆分不产生第二枚标记、不改标题级别。
 *
 *  突变验证（把修复注掉必须变红）：
 *    · 把 patchHeadingEnter 里 `!光标在标记之后` 退回成旧判据（只看左半有没有文字）
 *      → ② 的 DOM/落盘断言立刻变红（第一行不再是空的 h3、内容仍是标题）。
 *
 *  证人：磁盘（②⑧ 保存后逐字节读回）+ 几何（块序列/光标层）。
 */
'use strict';
const hi = require('../../human-input/hi.cjs');

const BODY = ['### 标题内容', '', '后文。', ''].join('\n');
const MATH_BODY = ['### 标题甲 $a+b=c$ 收尾', '', '后文。', ''].join('\n');

/** 块序列 + 光标层：块用 `TAG[文本]` 记，heading 额外标出"内容是否为空"。 */
const 读结构 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { ok: false };
  const 块 = [...s.children].map(b => {
    const 是标题 = /^H[1-6]$/.test(b.tagName);
    const 标记 = b.querySelector('[data-type="heading-marker"]');
    const 正文 = 标记 ? [...b.childNodes].filter(n => !(n.nodeType === 1 && n.getAttribute('data-type') === 'heading-marker'))
      .map(n => n.textContent).join('') : b.textContent;
    return { tag: b.tagName, 标题: 是标题, 标记: 标记 ? 标记.textContent : null,
      空: !正文.replace(/[\\s\\u200b]/g, ''), 文本: b.textContent.replace(/\\u200b/g, '').slice(0, 30) };
  });
  const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const at = r ? (r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer) : null;
  return { ok: true, 块, 光标: r ? { 折叠: r.collapsed, 偏移: r.startOffset,
    层: !at || !s.contains(at) ? '外' : at.closest('h1,h2,h3,h4,h5,h6') ? '标题' : at.closest('p') ? '段' : '其他' } : null }; })()`;

const 放光标 = (off, 中) => `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false };
  let t = null;
  if (${中}) { t = [...h.childNodes].filter(n => n.nodeType === 3).pop() || null; }
  else { const marker = h.querySelector('[data-type="heading-marker"]'); t = marker ? marker.firstChild : null; }
  if (!t || t.nodeType !== 3) return { ok: false, why: 'no-text', html: h.outerHTML };
  const off = Math.min(${off}, t.data.length);
  const r = d.createRange(); r.setStart(t, off); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return { ok: true, off, len: t.data.length, 文本: t.data }; })()`;

const 置文 = md => `(() => { const w = ${hi.IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;

/** 光标在不在编辑面里（按键类读数前的必过闸门）。 */
const 读焦点 = `(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
  if (!w || !w.document) return { ok: false };
  const a = w.document.activeElement;
  return { ok: !!w.document.hasFocus() && !!a && (a === w.document.body || a.closest?.('.vditor-ir')) }; })()`;

const 非空行 = text => String(text).replace(/\r/g, '').split('\n').filter(line => line.trim());

async function 回车(session) { await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' }); await hi.sleep(420); }
async function 退格(session) { await session.key({ key: 'Backspace', code: 'Backspace', vk: 8 }); await hi.sleep(420); }
async function 撤销(session) { await hi.combo(session, 'Ctrl+z'); await hi.sleep(500); }

module.exports = {
  id: '139-heading-enter-marker-split',
  title: '标题回车：标记之后=标记钉原行、内容落下一行变普通段落（六级/公式/退格/撤销/落盘同族）',
  run: async ctx => {
    // ══ 会话一：语义矩阵（①块首 ②标记之后 ③标记中间 ④内容中部 ⑤空标题） ═══════════
    const file = hi.writeDoc('heading-enter-split.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 2 });
    try {
      ctx.assert('会话一 焦点在编辑器（按键类读数前置）', (await hi.ensureFocus(session)).ok, '');

      // ── ① 光标在标记之前：块首语义，标题整行下移（不许回退） ─────────────────────
      await session.js(置文(BODY)); await hi.sleep(560);
      const 放1 = await session.js(放光标(0, false));
      ctx.assert('① 前置：光标落在标记之前', 放1.ok && 放1.off === 0, JSON.stringify(放1));
      await 回车(session);
      const 构1 = await session.js(读结构);
      ctx.assert('① 光标在标记之前按回车：标题**整行**下移（第一块是空段，标题留在第二块）',
        构1.ok && 构1.块[0].tag === 'P' && 构1.块[0].空 && 构1.块[1].tag === 'H3' && !构1.块[1].空,
        JSON.stringify(构1.块));
      ctx.assert('① 标题内容原样留在标题里（没有被降级成普通段落）',
        构1.块[1].文本.includes('标题内容'), JSON.stringify(构1.块[1]));
      await session.shot('139-①标记之前-块首语义');

      // ── ② 光标在标记之后：标记钉原行、内容落下一行变普通段落【本轮核心】 ──────────
      await session.js(置文(BODY)); await hi.sleep(560);
      const 放2 = await session.js(放光标(4, false));
      ctx.assert('② 前置：光标落在标记之后（标记 4 个字符全在光标左边）', 放2.ok && 放2.off === 4 && 放2.文本 === '### ', JSON.stringify(放2));
      await 回车(session);
      const 构2 = await session.js(读结构);
      ctx.assert('② 标记钉在原行：第一块仍是 H3 且**只剩标记**（不许整行下移）',
        构2.ok && 构2.块[0].tag === 'H3' && 构2.块[0].标题 && 构2.块[0].空 && 构2.块[0].标记 === '### ',
        JSON.stringify(构2.块[0]));
      ctx.assert('② 内容被回撤到下一行、变成**普通段落**（不是标题）',
        构2.块[1] && 构2.块[1].tag === 'P' && !构2.块[1].标题 && 构2.块[1].文本 === '标题内容',
        JSON.stringify(构2.块[1]));
      ctx.assert('② 光标落在新段落开头（用户可以接着往下打字）',
        构2.光标 && 构2.光标.层 === '段' && 构2.光标.偏移 === 0, JSON.stringify(构2.光标));
      ctx.assert('② 只产生一枚标记、级别不变（不许出现 `### ###`）',
        构2.块.filter(b => b.标记).length === 1, JSON.stringify(构2.块.map(b => b.标记)));
      await session.shot('139-②标记之后-标记钉原行');
      // 磁盘证人：拆分结果真的落盘
      const 盘2 = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const 行2 = 非空行(盘2.after);
      ctx.witness('磁盘：② 拆分后的文件', { 行: 行2 }, 'disk');
      ctx.assert('② 落盘核对：第一行只剩三个井号（空三级标题），第二行是**没有井号**的普通文本行',
        行2.length >= 3 && /^#{3}\s*$/.test(行2[0]) && 行2[1] === '标题内容' && 行2[2] === '后文。',
        JSON.stringify(行2));

      // ── ③ 光标停在标记文字中间：仍按块首语义，不许拆出级别错乱 ──────────────────
      await session.js(置文(BODY)); await hi.sleep(560);
      await session.js(放光标(1, false));
      await 回车(session);
      const 构3 = await session.js(读结构);
      ctx.assert('③ 光标停在标记中间按回车：仍走块首语义（标题整行下移、级别不变）',
        构3.ok && 构3.块[0].tag === 'P' && 构3.块[1].tag === 'H3' && 构3.块[1].文本.includes('标题内容'),
        JSON.stringify(构3.块));

      // ── ④ 光标在内容中部：既有拆分形态不回退 ──────────────────────────────────
      await session.js(置文(BODY)); await hi.sleep(560);
      await session.js(放光标(1, true));
      await 回车(session);
      const 构4 = await session.js(读结构);
      ctx.assert('④ 内容中部按回车：左半留在标题里、右半变普通段落（既有契约不回退）',
        构4.ok && 构4.块[0].tag === 'H3' && 构4.块[0].文本.includes('标') && 构4.块[1].tag === 'P'
        && 构4.块[1].文本 === '题内容', JSON.stringify(构4.块));

      // ── ⑤ 空标题、光标在标记之后：标记留原行、光标落到下一行空段 ────────────────
      await session.js(置文('### \n\n后文。\n')); await hi.sleep(560);
      await session.js(放光标(4, false));
      await 回车(session);
      const 构5 = await session.js(读结构);
      ctx.assert('⑤ 空标题、光标在标记之后按回车：空的 H3 留在原行、光标落到下一行空段',
        构5.ok && 构5.块[0].tag === 'H3' && 构5.块[0].空 && 构5.块[1].tag === 'P' && 构5.块[1].空
        && 构5.光标 && 构5.光标.层 === '段', JSON.stringify(构5.块) + ' ' + JSON.stringify(构5.光标));
    } finally {
      await ctx.release(session);
    }

    // ══ 会话二：h1..h6 六级同一契约（一个 bug 点扫一整面） ═════════════════════════
    const file2 = hi.writeDoc('heading-enter-levels.md', BODY);
    const session2 = await hi.openDoc(ctx, file2, { minBlocks: 2 });
    try {
      ctx.assert('会话二 焦点在编辑器', (await hi.ensureFocus(session2)).ok, '');
      for (let 级 = 1; 级 <= 6; 级++) {
        await session2.js(置文('#'.repeat(级) + ' 标题内容\n\n后文。\n')); await hi.sleep(560);
        await session2.js(放光标(级 + 1, false));
        await 回车(session2);
        const 构 = await session2.js(读结构);
        ctx.assert(`⑥ h${级}：标记留在原行（第一块仍是 H${级} 且只剩标记）`,
          构.ok && 构.块[0].tag === 'H' + 级 && 构.块[0].空 && 构.块[0].标记 === '#'.repeat(级) + ' ',
          JSON.stringify(构.块[0]));
        ctx.assert(`⑥ h${级}：内容落到下一行普通段落`,
          构.块[1] && 构.块[1].tag === 'P' && 构.块[1].文本 === '标题内容', JSON.stringify(构.块[1]));
      }
    } finally {
      await ctx.release(session2);
    }

    // ══ 会话三：标题里带行内公式——拆分/退格/撤销都不许丢公式（数据保真面） ═══════
    const file3 = hi.writeDoc('heading-enter-math.md', MATH_BODY);
    const session3 = await hi.openDoc(ctx, file3, { minBlocks: 2 });
    try {
      ctx.assert('会话三 焦点在编辑器', (await hi.ensureFocus(session3)).ok, '');
      const 原件 = require('node:fs').readFileSync(file3, 'utf8');

      // ── ⑦ 标记之后 Enter：公式必须原样活下来 ────────────────────────────────
      await session3.js(放光标(4, false));
      await 回车(session3);
      const 构7 = await session3.js(读结构);
      ctx.assert('⑦ 标题带公式、标记之后回车：第一块是空的 H3、第二块是普通段落',
        构7.ok && 构7.块[0].tag === 'H3' && 构7.块[0].空 && 构7.块[1].tag === 'P',
        JSON.stringify(构7.块));
      const 盘7 = await hi.edge.saveAndWait(session3, file3, { timeout: 8000 });
      ctx.witness('磁盘：⑦ 带公式标题拆分后的文件', { 盘: 盘7.after.replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('⑦ 落盘：行内公式 `$a+b=c$` 一个字符都不许丢（F 案数据丢失面的同族形态）',
        String(盘7.after).includes('$a+b=c$'), JSON.stringify(String(盘7.after)));

      // ── ⑧ 拆分之后立刻退格（enter-bs 陷阱）：公式仍不许丢 ────────────────────
      await 退格(session3);
      const 盘8 = await hi.edge.saveAndWait(session3, file3, { timeout: 8000 });
      ctx.witness('磁盘：⑧ 退格合并后的文件', { 盘: 盘8.after.replace(/\n/g, '\\n') }, 'disk');
      ctx.assert('⑧ 拆分后立刻退格合并：公式仍然在盘上（enter-bs 陷阱不许复活）',
        String(盘8.after).includes('$a+b=c$'), JSON.stringify(String(盘8.after)));
      ctx.assert('⑧ 退格合并后标题行文字回到原样（`### 标题甲 $a+b=c$ 收尾`）',
        /^#{3}\s*标题甲\s*\$a\+b=c\$\s*收尾\s*$/m.test(String(盘8.after).replace(/\r/g, '')),
        JSON.stringify(非空行(盘8.after)));

      // ── ⑨ 撤销一步回到原样 ────────────────────────────────────────────────
      await session3.js(置文(MATH_BODY)); await hi.sleep(560);
      await session3.js(放光标(4, false));
      await 回车(session3);
      const 拆 = await session3.js(读结构);
      ctx.assert('⑨ 前置：拆分已发生', 拆.块[0].空 && 拆.块[1].tag === 'P', JSON.stringify(拆.块));
      await 撤销(session3);
      const 构9 = await session3.js(读结构);
      ctx.assert('⑨ Ctrl+Z 一步回到拆分前（标题连同公式一起回来）',
        构9.ok && 构9.块[0].tag === 'H3' && !构9.块[0].空 && 构9.块[0].文本.includes('标题甲')
        && 构9.块[0].文本.includes('收尾'), JSON.stringify(构9.块));
      ctx.witness('磁盘：③ 用例素材原件与最终盘面', { 原件: 原件.replace(/\n/g, '\\n') }, 'disk');
    } finally {
      await ctx.release(session3);
    }
  },
};
