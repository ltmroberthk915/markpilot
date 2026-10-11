/** 124 · Tab / Shift+Tab 真键：列表缩进/反缩进、代码块里 Tab 是字符、普通段落行为记录。
 *
 *  列表缩进是 Vditor 内建行为，验收场景此前零覆盖（.perf 里只有一次性探针）。
 *  缩进的用户可见语义：Tab 把列表项变成上一项的子项（源码加缩进）、Shift+Tab 退回；
 *  代码块里 Tab 必须是字面缩进字符、不许动列表结构。
 */
'use strict';
const hi = require('../hi.cjs');

const FENCE = '```';
const BODY = [
  '# 缩进练习',
  '',
  '- 列表甲',
  '- 列表乙',
  '- 列表丙',
  '',
  '1. 数字一',
  '2. 数字二',
  '',
  '普通段落文字。',
  '',
  FENCE + 'js',
  'code line',
  FENCE,
  '',
].join('\n');

module.exports = {
  id: '124-hi-tab-indent',
  title: 'Tab/Shift+Tab 真键：列表项缩进成子项、代码块 Tab 是字面缩进、段落行为记录在案',
  run: async ctx => {
    const file = hi.writeDoc('tab-indent.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 5 });
    const md0 = () => hi.mdNow(session);
    const listItemDom = text => session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
      // 【V11 校准】嵌套真发生后，父项 li 的 textContent 也包含子项文本，find 按文档序
      // 先命中的是父 li（其父是 UL ⇒ 嵌套:null 假红，V11 首跑实测）。取文档序最后一个
      // 匹配 = 最内层叶子 li；非嵌套态只有一个匹配，② 的判定语义不变。
      const li = [...s.querySelectorAll('li')].filter(n => n.textContent.includes('${text}')).pop();
      if (!li) return { ok: false };
      const parentLi = li.parentElement.parentElement;
      // 【V11 校准】父项 textContent 含子列表全文（"列表甲列表乙"），取**自有文本**（直接
      // 文本节点 + 非 UL/OL 子元素，兼容松散列表的 p 包装）再比对。
      let own = '';
      if (parentLi && parentLi.tagName === 'LI') {
        for (const part of parentLi.childNodes) {
          if (part.nodeType === 3) own += part.data;
          else if (part.tagName !== 'UL' && part.tagName !== 'OL') own += part.textContent;
        }
      }
      own = own.replace(/\\s+/g, ' ').trim();
      return { ok: true, 文本: li.textContent.slice(0, 12), 嵌套: parentLi && parentLi.tagName === 'LI' ? own.slice(0, 12) : null }; })()`);
    try {
      ctx.assert('文档打开（列表在）', String(await md0()).includes('- 列表甲'), String(await md0()).slice(0, 50));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① 列表乙 + Tab → 成为列表甲的子项 ═════════════════════════════════════
      await session.js(hi.placeAfterPrefix('列表乙'));
      await hi.sleep(150);
      await hi.press(session, 'Tab');
      await hi.sleep(500);
      let md = String(await md0());
      const domIndent = await listItemDom('列表乙');
      ctx.witness('几何：列表乙 Tab 后的 DOM 嵌套', domIndent, 'geometry');
      ctx.assert('① Tab 后列表乙嵌进列表甲（DOM 子列表）',
        domIndent.ok && domIndent.嵌套 === '列表甲', JSON.stringify(domIndent));
      ctx.assert('① 源码里列表乙前有缩进（空格或制表符）',
        // 【V10 校准·E10-P3 预授权】原正则 (\t|    +) 要求 ≥4 空格/tab——headless 实测
        // VditorIRDOM2Md 对嵌套列表恒归一 2 空格（`- ` 父项）/3 空格（`1. ` 父项），tab
        // 与 4 空格缩进的 md 经 IR DOM 往返也全归一 2 空格；vendor 原生行首 Tab 缩进同样
        // 产 2 空格——原断言在任何实现下都不可满足（W4 §二取证）。校准为 ≥2 空格。
        /(\t|  +)- 列表乙/.test(md), JSON.stringify(md.split('\n').filter(l => l.includes('列表乙'))));

      // ══ ② Shift+Tab → 退回顶层 ════════════════════════════════════════════════
      await hi.press(session, 'Tab', { modifiers: hi.MOD.shift });
      await hi.sleep(500);
      md = String(await md0());
      const domOutdent = await listItemDom('列表乙');
      ctx.assert('② Shift+Tab 退回顶层（不再嵌套）',
        domOutdent.ok && domOutdent.嵌套 === null, JSON.stringify(domOutdent));
      ctx.assert('② 源码里列表乙回到无缩进', /^- 列表乙/m.test(md), JSON.stringify(md.split('\n').filter(l => l.includes('列表乙'))));

      // ══ ③ 列表甲 + Tab（首项缩进）：结构不许坏 ═══════════════════════════════
      await session.js(hi.placeAfterPrefix('列表甲'));
      await hi.sleep(150);
      await hi.press(session, 'Tab');
      await hi.sleep(500);
      md = String(await md0());
      ctx.witness('几何：列表甲 Tab 后的源码形态', { 行: md.split('\n').slice(0, 6) }, 'geometry');
      ctx.assert('③ 首项 Tab 后三个列表项都还在（没有丢项/并项）',
        md.includes('列表甲') && md.includes('列表乙') && md.includes('列表丙'), md.slice(0, 80));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ④ 代码块里 Tab：字面缩进字符，列表纹丝不动 ════════════════════════════
      const mdBeforeCode = String(await md0());
      await session.js(hi.placeAfterPrefix('code line'));
      await hi.sleep(150);
      await hi.press(session, 'Tab');
      await hi.sleep(500);
      md = String(await md0());
      const codeLine = md.split('\n').find(l => l.includes('code line')) || '';
      const listUntouched = md.split('\n').filter(l => l.includes('列表')).join('|') === mdBeforeCode.split('\n').filter(l => l.includes('列表')).join('|');
      ctx.witness('几何：代码块里 Tab 之后的代码行', { codeLine: JSON.stringify(codeLine) }, 'geometry');
      ctx.assert('④ 代码块里 Tab 产生字面缩进（制表符或 ≥2 空格），列表结构没被动',
        /code line(\t|  )/.test(md), JSON.stringify(codeLine));
      ctx.assert('④ 列表行一个字符都没变', listUntouched, md.slice(0, 100));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ⑤ 普通段落里 Tab：行为记录在案（不判死口径，先看清是什么） ═════════════
      const mdBeforePara = String(await md0());
      await session.js(hi.placeAfterPrefix('普通段落文字'));
      await hi.sleep(150);
      const caretBefore = await hi.caret(session);
      await hi.press(session, 'Tab');
      await hi.sleep(500);
      md = String(await md0());
      const caretAfter = await hi.caret(session);
      ctx.witness('几何：普通段落 Tab 的实际行为', { 之前: mdBeforePara.slice(0, 60), 之后: md.slice(0, 60), 光标前: caretBefore.前缀, 光标后: caretAfter.前缀 }, 'geometry');
      ctx.assert('⑤ 普通段落 Tab 后光标仍在编辑器里（不丢）', caretAfter.ok, JSON.stringify(caretAfter));
      ctx.assert('⑤ 普通段落 Tab 不产生半截损坏结构（列表/代码块原样）',
        md.includes('- 列表甲') && md.includes('code line'), md.slice(0, 100));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ⑥ 顶层项 Shift+Tab：已在顶层时不得破坏 ════════════════════════════════
      await session.js(hi.placeAfterPrefix('列表丙'));
      await hi.sleep(150);
      const mdBeforeST = String(await md0());
      await hi.press(session, 'Tab', { modifiers: hi.MOD.shift });
      await hi.sleep(500);
      md = String(await md0());
      ctx.assert('⑥ 顶层 Shift+Tab 不丢项（列表丙还在，或记录其重排形态）',
        md.includes('列表丙'), JSON.stringify(md.split('\n').filter(l => l.includes('列表'))));

      // ══ ⑦ 收尾：退回原稿 + 磁盘 ═══════════════════════════════════════════════
      for (let i = 0; i < 10; i++) { await hi.combo(session, 'Ctrl+Z'); await hi.sleep(240); }
      const finalMd = String(await md0());
      ctx.assert('⑦ 撤销链退回原稿', finalMd.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), finalMd.slice(0, 80));
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 70) }, 'disk');
      ctx.assert('⑦ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 80));
    } finally {
      await ctx.release(session);
    }
  },
};
