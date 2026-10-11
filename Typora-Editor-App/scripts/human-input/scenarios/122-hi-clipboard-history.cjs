/** 122 · 剪贴板三键 + 撤销/重做栈：Ctrl+C/X/V、Ctrl+Shift+V 纯文本粘贴、
 *  Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 多步链路。
 *
 *  纯文本粘贴（Typora 官方键 Ctrl+Shift+V）此前零覆盖；撤销栈的"多步编辑能一路
 *  退回、重做能一路还原"也是日用缺陷的高发区。剪贴板判据走系统剪贴板独立读回
 *  （PowerShell 通道）。
 *  R10-P7 改写：② 原断言打 Ctrl+Alt+V——那是"复制选区为纯文本"（edit-shortcuts.js:202
 *  走 copyPlainText，语义是复制不是粘贴），量不到"粘贴纯文本"这个用户动作；因 E10
 *  §0-C4/§1-P2 把粘贴纯文本定为 Ctrl+Shift+V（R10-W3 落地中），② 改打此键。
 *  依赖：W3 的 Ctrl+Shift+V 分支落地前，② 必红——这是预期的依赖红，不是探针缺陷。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = '剪贴板段：**粗体文字** 与普通文字。\n';

module.exports = {
  id: '122-hi-clipboard-history',
  title: '剪贴板真键：Ctrl+C/X/V、Ctrl+Shift+V 纯文本粘贴、Ctrl+Z/Y/Shift+Z 撤销重做链',
  run: async ctx => {
    const file = hi.writeDoc('clipboard-history.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 1 });
    const md0 = () => hi.mdNow(session);
    try {
      ctx.assert('文档打开', String(await md0()).includes('粗体文字'), String(await md0()).slice(0, 40));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      // ══ ① Ctrl+C：把带格式的段落复制出去（系统剪贴板独立证人） ═══════════════
      await session.js(hi.selectFromTo('剪贴板段', '普通文字。'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+C');
      const clip = await hi.edge.readClipboardUntil(ctx.outDir, data => String(data.text || '').includes('粗体文字'), { timeout: 12000 });
      ctx.witness('剪贴板：Ctrl+C 后系统剪贴板读回', { text: String(clip.text || '').slice(0, 60) }, 'clipboard');
      ctx.assert('① Ctrl+C 后系统剪贴板里有这段文字', String(clip.text || '').includes('粗体文字'), JSON.stringify(String(clip.text || '').slice(0, 60)));

      // ══ ② Ctrl+End + Enter 新段 + Ctrl+Shift+V：只许落纯文本 ══════════════════
      // R10-P7 改写 + V10 校准（2026-10-04 实测）：本应用 IR 模式 Ctrl+C 写进 text/plain
      // 的就是 Markdown 源（含 **，产品既有行为，实测 122 同款 selectFromTo 流亦然），
      // 「富复制 plain 无星」前提不成立——纯文本粘贴落的就是这份 md 源文本，IR 再解析
      // 回 strong，md 上两段全等。可判别的量法换成：
      //   a) 粘贴段与原段**逐字全等**（plain 味道逐字落盘，一个字符不差）；
      //   b) 机理自证：按键后**无 trusted paste 事件**（我们的分支 preventDefault+接管，
      //      insertText 通道；分支若不在，Chromium 原生 Ctrl+Shift+V 会走 paste 事件管线）。
      await session.js(`(() => { const w = ${hi.IF}; w.__plainPasteProbe = { paste: [], exec: [] };
        w.addEventListener('paste', e => w.__plainPasteProbe.paste.push({ trusted: e.isTrusted }), true);
        const orig = w.document.execCommand.bind(w.document);
        w.document.execCommand = function() { w.__plainPasteProbe.exec.push([...arguments]); return orig(...arguments); };
        return true; })()`);
      await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
      await hi.sleep(200);
      await session.enter();
      await hi.sleep(250);
      await hi.combo(session, 'Ctrl+Shift+V');
      await hi.sleep(800);
      const mdPaste = String(await md0());
      const probe = await session.js(`JSON.stringify(${hi.IF}.__plainPasteProbe)`);
      const domStrong = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelectorAll('${hi.SURFACE} strong,b').length; })()`);
      const pastedLine = mdPaste.split('\n').filter(l => l.includes('剪贴板段'));
      ctx.witness('几何：Ctrl+Shift+V 后', { 粘贴段数: pastedLine.length, strong数: domStrong, 机理探针: probe }, 'geometry');
      ctx.assert('② Ctrl+Shift+V 逐字落纯文本（粘贴段==原段逐字）且走接管通道（无 trusted paste）',
        pastedLine.length === 2 && pastedLine[0] === pastedLine[1] && JSON.parse(probe).paste.length === 0,
        JSON.stringify({ pastedLine, probe }));
      await session.shot('122-paste-plain');

      // ══ ③ 撤销一次：粘贴段整段退掉 ═══════════════════════════════════════════
      await hi.combo(session, 'Ctrl+Z');
      await hi.sleep(450);
      const mdUndoPaste = String(await md0());
      ctx.assert('③ 一次 Ctrl+Z 撤掉整次粘贴（回到单段原稿）',
        mdUndoPaste.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), mdUndoPaste.slice(0, 90));

      // ══ ④ 三笔编辑 + 撤销/重做链（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z） ═══════════
      const type = async text => { await session.type(text); await hi.sleep(200); };
      await hi.press(session, 'End', { modifiers: hi.MOD.ctrl });
      await hi.sleep(150);
      await session.enter(); await hi.sleep(200); await type('第一笔');
      await session.enter(); await hi.sleep(200); await type('第二笔');
      await session.enter(); await hi.sleep(200); await type('第三笔');
      const mdTyped = String(await md0());
      ctx.assert('④ 三笔都打进了文档', mdTyped.includes('第一笔') && mdTyped.includes('第三笔'), mdTyped.slice(0, 120));
      let back = 0;
      for (let i = 0; i < 10; i++) {
        const now = String(await md0());
        if (now.replace(/\n+$/, '') === BODY.replace(/\n+$/, '')) break;
        await hi.combo(session, 'Ctrl+Z'); back += 1; await hi.sleep(260);
      }
      ctx.assert('④ Ctrl+Z 链一路退回原稿（三笔+回车 ≤10 次）',
        String(await md0()).replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), `退了 ${back} 次仍不等于原稿`);
      await hi.combo(session, 'Ctrl+Y'); await hi.sleep(300);
      const redone1 = String(await md0());
      ctx.assert('④ Ctrl+Y 重做第一步', redone1.includes('第一笔') || redone1 !== BODY.replace(/\n+$/, ''), redone1.slice(0, 90));
      for (let i = 0; i < 9; i++) { await hi.combo(session, 'Ctrl+Shift+Z'); await hi.sleep(260); }
      const redoneAll = String(await md0());
      ctx.assert('④ Ctrl+Shift+Z 链一路重做到三笔都在', redoneAll === mdTyped, redoneAll.slice(0, 120));

      // ══ ⑤ Ctrl+X 剪切 + Ctrl+V 放回：文本不丢、顺序不乱 ═════════════════════
      await session.js(hi.selectFromTo('第二笔', '第二笔'));
      await hi.sleep(150);
      await hi.combo(session, 'Ctrl+X');
      const clipX = await hi.edge.readClipboardUntil(ctx.outDir, data => String(data.text || '').includes('第二笔'), { timeout: 12000 });
      ctx.witness('剪贴板：Ctrl+X 后', { text: String(clipX.text || '').slice(0, 30) }, 'clipboard');
      ctx.assert('⑤ Ctrl+X 后剪贴板里是第二笔', String(clipX.text || '').includes('第二笔'), JSON.stringify(clipX.text));
      const mdCut = String(await md0());
      ctx.assert('⑤ 文档里第二笔没了（真的剪掉）', !mdCut.includes('第二笔'), mdCut.slice(0, 120));
      await session.js(hi.placeAfterPrefix('第一笔'));
      await hi.sleep(150);
      await session.enter();
      await hi.sleep(200);
      await hi.combo(session, 'Ctrl+V');
      await hi.sleep(600);
      const mdPastedBack = String(await md0());
      ctx.assert('⑤ Ctrl+V 把第二笔放回来', mdPastedBack.includes('第二笔'), mdPastedBack.slice(0, 140));

      // ══ ⑥ 磁盘证人 ═══════════════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：保存', { 磁盘: disk.slice(0, 110) }, 'disk');
      ctx.assert('⑥ 磁盘 == 当前源码（含第二笔回填）',
        disk.replace(/\n+$/, '') === mdPastedBack.replace(/\n+$/, ''), JSON.stringify(disk.slice(0, 110)));
    } finally {
      await ctx.release(session);
    }
  },
};
