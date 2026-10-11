/** 121 · 块级格式快捷键真键：Ctrl+Shift+Q（引用）、Ctrl+Shift+K（代码，单行/多行/围栏加长）、
 *  Ctrl+Shift+E（公式包裹/再按取消）。
 *
 *  这三个组合键是可配置快捷键的默认值（edit-shortcuts.js DEFAULT_SHORTCUTS），
 *  之前的验收场景只覆盖过 Ctrl+Shift+E 一处。多行语义（引用逐行加 > 、代码按内容里
 *  最长反引号串加长围栏）是产品实现里最容易碎的分支，全部用真组合键触发。
 */
'use strict';
const hi = require('../hi.cjs');

const BODY = [
  '# 引用与代码练习',
  '',
  '普通一行文字。',
  '',
  '引用目标行甲',
  '',
  '引用目标行乙',
  '',
  '代码目标行',
  '',
  '含三反引号 ```x``` 的一行',
  '',
  '数学目标 42',
  '',
].join('\n');

module.exports = {
  id: '121-hi-block-hotkeys',
  title: '块快捷键真键：Ctrl+Shift+Q 引用、Ctrl+Shift+K 代码（含围栏加长）、Ctrl+Shift+E 公式开关',
  run: async ctx => {
    const file = hi.writeDoc('block-hotkeys.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 6 });
    const md0 = () => hi.mdNow(session);
    const domCount = selector => session.js(`(() => { const w = ${hi.IF}, d = w.document;
      return d.querySelectorAll('${selector}').length; })()`);
    try {
      ctx.assert('文档打开', String(await md0()).includes('引用目标行甲'), String(await md0()).slice(0, 50));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① Ctrl+Shift+Q 多行引用：两行都加 > ═════════════════════════════════
      await session.js(hi.selectFromTo('引用目标行甲', '引用目标行乙'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+Shift+Q');
      await hi.sleep(600);
      let md = String(await md0());
      const quoteDom = await domCount('blockquote');
      ctx.witness('几何：Ctrl+Shift+Q 后', { blockquote: quoteDom, md: md.slice(0, 110) }, 'geometry');
      ctx.assert('① 多行引用：blockquote 出现且两行都被 > 前缀',
        quoteDom >= 1 && md.includes('> 引用目标行甲') && md.includes('> 引用目标行乙'), md.slice(0, 110));
      await session.shot('121-quote');
      // 撤销：一次 Ctrl+Z 应当回到普通段落（多行是一次事务）
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(450);
      md = String(await md0());
      ctx.assert('① 一次 Ctrl+Z 撤销整个多行引用（一次事务，不留半截）',
        !md.includes('> 引用目标行甲') && !md.includes('> 引用目标行乙'), md.slice(0, 110));

      // ══ ② Ctrl+Shift+K 单行：行内代码 ═══════════════════════════════════════
      await session.js(hi.placeAfterPrefix('代码目标行'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+Shift+K');
      await hi.sleep(600);
      md = String(await md0());
      ctx.assert('② 单行 Ctrl+Shift+K → 行内代码 `代码目标行`',
        md.includes('`代码目标行`'), md.slice(0, 140));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ③ Ctrl+Shift+K 多行且内容含三连反引号：围栏必须加长到 4 ═══════════════
      await session.js(hi.selectFromTo('代码目标行', '的一行'));   // 跨两个块 → 多行分支
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+Shift+K');
      await hi.sleep(600);
      md = String(await md0());
      const fence = /(^|\n)(`{3,})\n[\s\S]*?含三反引号[\s\S]*?\n\2(?=\n|$)/.exec(md);
      ctx.witness('磁盘前读数：含反引号内容的围栏形态', { md: md.slice(0, 160) }, 'geometry');
      ctx.assert('③ 内容含 ``` 时围栏加长到 ≥4 个反引号（不破语法）',
        !!fence && fence[2].length >= 4, '围栏形态：' + JSON.stringify(md.slice(0, 160)));
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(400);

      // ══ ④ Ctrl+Shift+E：选区包成公式，再按取消 ══════════════════════════════
      await session.js(hi.selectFromTo('42', '42'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+Shift+E');
      await hi.sleep(600);
      md = String(await md0());
      ctx.assert('④ Ctrl+Shift+E 把选区包成 $42$', md.includes('$42$'), md.slice(0, 140));
      await hi.combo(session, 'Ctrl+Shift+E');
      await hi.sleep(600);
      md = String(await md0());
      ctx.assert('④ 再按一次取消公式（42 裸文本回来、$ 成对消失）',
        md.includes('数学目标 42') && !md.includes('$42$'), md.slice(0, 140));

      // ══ ⑤ 收尾：撤销到原稿 + 磁盘证人 ═══════════════════════════════════════
      let undos = 0;
      for (let i = 0; i < 10; i++) {
        const now = String(await md0());
        if (now.replace(/\n+$/, '') === BODY.replace(/\n+$/, '')) break;
        await hi.combo(session, 'Ctrl+Z');
        undos += 1;
        await hi.sleep(280);
      }
      const finalMd = String(await md0());
      ctx.assert('⑤ 撤销链退回原稿', finalMd.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''),
        `撤了 ${undos} 次：` + finalMd.slice(0, 100));
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 90) }, 'disk');
      ctx.assert('⑤ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 100));
    } finally {
      await ctx.release(session);
    }
  },
};
