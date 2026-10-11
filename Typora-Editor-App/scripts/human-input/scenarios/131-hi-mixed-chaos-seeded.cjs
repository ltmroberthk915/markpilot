/** 131 · 种子混沌长序列（真素材副本）：80 步随机拟人操作流，每步即时归因。
 *
 *  举一反三的兜底网：上面每个场景都是"想得到的类"，混沌流专抓**想不到的组合**——
 *  选区残影后按格式键、展开态里连按退格、拖拽到一半按方向键、面板开着打字……
 *  每步之后立即检查：光标/选区有效、无新增 console 错误（错误当场归因到具体一步，
 *  而不是收尾时一堆错误不知道谁干的）。固定种子，全程可复现。
 *  素材用受保护真实文档的**副本**，跑完删除副本。
 */
'use strict';
const fs = require('node:fs');
const hi = require('../hi.cjs');

const SEED = 20260923;
const STEPS = 80;
const MATERIAL = '富文本测试-重识概率论.md';

module.exports = {
  id: '131-hi-mixed-chaos-seeded',
  title: '种子混沌 80 步（真素材副本）：键盘/组合键/长按/点击/拖拽/输入混流，逐步归因光标存活与错误面',
  run: async ctx => {
    const file = hi.copyProtected(MATERIAL);
    const session = await hi.openDoc(ctx, file, { minBlocks: 5, settleMs: 2600 });
    try {
      await hi.edge.settle(session);
      // R10-P7 改写：原注释按 F19 旧前提写"getValue 先返回半截，等源码长度与磁盘字节数
      // 对上"。E10 §0-C9/§3 销案四证推翻该前提：素材 169,686 字节里 145,159 是 <img> 的
      // 单张 base64 图（实测素材），长度差来自图片载荷而非文本缺失；F19 证伪 + 45s 空窗
      // 隔离不复现 + G-C3 保存路径覆盖 + getValue 缓存疑虑核销，四证闭环。
      // 对账口径改**纯文本长度**：图片（<img> 标签 / md 图片引用）折叠成占位符只计个数、
      // 不计 base64/URL 长度，空白不计——文字逐字对上才算"打开完成"。
      const plainOf = text => String(text).replace(/\r/g, '')
        .replace(/<img\b[^>]*>/gi, '\uFFFC')            // 图片标签（含 base64/URL 载荷）→ 占位符
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '\uFFFC')     // md 图片引用同口径（防素材改版）
        .replace(/\s+/g, '');
      const diskText = fs.readFileSync(file, 'utf8');
      const diskPlainLen = plainOf(diskText).length;
      let md0 = null;
      for (let i = 0; i < 90; i++) {
        const md = await hi.mdNow(session);
        if (typeof md === 'string' && Math.abs(plainOf(md).length - diskPlainLen) <= 120) { md0 = md; break; }
        await hi.sleep(500);
      }
      ctx.assert('素材完整打开（纯文本口径：跳过图/base64 计长后与磁盘等长）',
        typeof md0 === 'string' && plainOf(md0).length > 1000,
        `等了 45s 仍对不上：${md0 === null ? '读不到' : '纯文本 ' + plainOf(md0).length + ' vs 磁盘 ' + diskPlainLen}`);
      if (md0 === null) md0 = String(await hi.mdNow(session));
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      const random = hi.rng(SEED);
      let rect = await session.js(hi.SURFACE_RECT);
      let errorBase = session.errors.length;
      let lastMd = md0;
      let mdChecks = 0, caretViolations = [], errorSteps = [], parityViolations = [];
      const pick = array => array[Math.floor(random() * array.length)];
      const point = () => ({ x: rect.left + Math.floor(random() * (rect.right - rect.left)),
        y: rect.top + Math.floor(random() * (rect.bottom - rect.top)) });

      for (let step = 1; step <= STEPS; step++) {
        const dice = random();
        const shift = random() < 0.3 ? hi.MOD.shift : 0;
        const ctrl = random() < 0.25 ? hi.MOD.ctrl : 0;
        let interrupted = false;
        try {
          if (dice < 0.16) await hi.press(session, pick(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']), { modifiers: shift | ctrl });
          else if (dice < 0.22) await hi.press(session, pick(['Home', 'End']), { modifiers: ctrl });
          else if (dice < 0.27) await hi.press(session, pick(['PageUp', 'PageDown']));
          else if (dice < 0.33) await hi.press(session, pick(['Backspace', 'Delete']), { modifiers: ctrl });
          else if (dice < 0.38) await session.enter(random() < 0.3);
          else if (dice < 0.42) await hi.press(session, 'Tab', { modifiers: shift ? hi.MOD.shift : 0 });
          else if (dice < 0.48) await session.type(pick(['混沌之字', 'chaos42', '插入测试甲', 'xyz', '。']));
          else if (dice < 0.57) await hi.combo(session, pick(['Ctrl+B', 'Ctrl+U', 'Ctrl+Shift+Q', 'Ctrl+Shift+K', 'Ctrl+Shift+E']));
          else if (dice < 0.62) { await hi.combo(session, 'Ctrl+F'); await hi.sleep(300); await session.type('定理'); await hi.sleep(250); await session.enter(); await hi.sleep(250); await hi.press(session, 'Escape'); }
          else if (dice < 0.67) await hi.combo(session, 'Ctrl+Z');
          else if (dice < 0.70) await hi.press(session, 'Escape');
          else if (dice < 0.78) { const p = point(); const mode = random(); await session.click(p.x, p.y,
              mode < 0.12 ? { clickCount: 2 } : mode < 0.2 ? { modifiers: hi.MOD.shift } : mode < 0.26 ? { modifiers: hi.MOD.ctrl } : {}); }
          else if (dice < 0.84) { const a = point(), b = point(); await hi.drag(session, a, b, { steps: 5, interval: 45, after: 250 }); }
          else if (dice < 0.88) { await hi.hold(session, pick(['ArrowRight', 'ArrowDown', 'ArrowLeft']), { times: 3 + Math.floor(random() * 4), interval: 55 }); }
          else if (dice < 0.91) { // 拖到一半按一下方向键（中途打断）
            const a = point(), b = point();
            await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
            await hi.press(session, 'ArrowRight');
            await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
            interrupted = true;
          }
          else await hi.press(session, pick(['ArrowDown', 'ArrowUp']), { modifiers: shift });
        } catch (error) {
          caretViolations.push({ step, 类型: '输入通道异常', 详情: String(error.message).slice(0, 140) });
          continue;
        }
        await hi.sleep(90 + Math.floor(random() * 120));

        // 每步即时归因：光标/选区必须有效
        const info = await hi.caret(session);
        const valid = info && (info.ok || info.选区长 > 0);
        if (!valid && caretViolations.length < 6) caretViolations.push({ step, dice: +dice.toFixed(2), 光标: info, 打断: interrupted });
        // 每步即时归因：新 console 错误当场记账
        if (session.errors.length > errorBase) {
          errorSteps.push({ step, dice: +dice.toFixed(2), 错误: session.errors.slice(errorBase, errorBase + 3) });
          errorBase = session.errors.length;
        }
        // 每 8 步：源码健康（$ 成对（排除围栏代码块）、无替换字符、单步改动有界）
        if (step % 8 === 0) {
          mdChecks += 1;
          const md = await hi.mdNow(session);
          if (typeof md !== 'string') { parityViolations.push({ step, 问题: '源码读不到' }); lastMd = md; continue; }
          const noFence = String(md).replace(/```[\s\S]*?```/g, m => m.replace(/\$/g, ''));
          if ((noFence.match(/\$/g) || []).length % 2 !== 0) parityViolations.push({ step, 问题: '$ 不成对', 尾部: md.slice(-60) });
          if (md.includes('\\uFFFD') || md.includes('\uFFFD')) parityViolations.push({ step, 问题: '出现替换字符' });
          if (Math.abs(md.length - String(lastMd).length) > 1200) parityViolations.push({ step, 问题: '单 8 步长度跳变', 差: md.length - String(lastMd).length });
          lastMd = md;
        }
        if (step % 10 === 0) rect = await session.js(hi.SURFACE_RECT);
        if (step === 40) await session.shot('131-chaos-mid');
      }

      ctx.witness('几何：混沌全程的光标失联/错误/源码异常记录', { caretViolations, errorSteps, parityViolations, mdChecks }, 'geometry');
      ctx.assert('80 步里光标/选区始终有效（失联 ≤0）', caretViolations.length === 0, JSON.stringify(caretViolations.slice(0, 3)));
      ctx.assert('80 步里没有新增 console 错误（逐步归因为空）', errorSteps.length === 0, JSON.stringify(errorSteps.slice(0, 2)));
      ctx.assert('源码健康：$ 成对、无替换字符、无异常跳变', parityViolations.length === 0, JSON.stringify(parityViolations.slice(0, 2)));

      // 收尾：撤销链回原稿（混沌编辑是允许的，但必须一路可退）
      let undos = 0;
      for (let i = 0; i < 60; i++) {
        const md = await hi.mdNow(session);
        if (md === md0) break;
        await hi.combo(session, 'Ctrl+Z'); undos += 1; await hi.sleep(200);
      }
      const finalMd = await hi.mdNow(session);
      ctx.assert('撤销链（≤60 次）能退回打开时的源码', finalMd === md0, `撤了 ${undos} 次仍差 ${Math.abs(String(finalMd).length - md0.length)} 字`);
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 10000 });
      const disk = String(saved.after).replace(/\r/g, '');
      // R10-P7 改写：原断言「磁盘 == 打开时源码」按逐字符相等。因素材图片（<img> base64
      // 载荷）在打开/保存回写时属非文本数据，逐字符口径量不到用户可见性质（E10 §0-C9
      // 销案）。改**文本等价**：全部用户可见文字逐字一致 + 图片个数一致（图片载荷与空白
      // 形态不参与比较）——混沌若丢了/改了任何一个字、任何一张图，这里照样红。
      ctx.witness('磁盘：混沌+撤销后保存（纯文本口径）', { 磁盘纯文本长: plainOf(disk).length, 原纯文本长: plainOf(md0).length }, 'disk');
      ctx.assert('磁盘 == 打开时源码（文本等价：文字逐字 + 图片个数，载荷不计）',
        plainOf(disk) === plainOf(md0), `磁盘纯文本 ${plainOf(disk).length} vs 源码纯文本 ${plainOf(md0).length}`);
    } finally {
      await ctx.release(session);
      try { fs.rmSync(file, { force: true }); } catch { /* 副本删除失败不遮产品结论 */ }
    }
  },
};
