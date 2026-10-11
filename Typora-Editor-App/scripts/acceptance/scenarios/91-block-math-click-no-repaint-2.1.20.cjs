/** 2.1.20 回归：展开态的块公式上"点一下"（没有任何文字变动）**不许整块重排/闪烁**。
 *
 *  用户（2026-09-14 第 12 轮）：
 *    「在block Math公式区中进行键盘移动，并不会移动一次触发一帧的重新预渲染以及整块闪烁,
 *      但是在展开预渲染，展开代码编辑的情况下，进行一次鼠标在代码区的点击与渲染区的点击
 *      都会导致重新渲染一次这种闪烁，你把它修正, 没有任何文字变动，只是点击就不要重新渲染.
 *      而且在键盘修改下, 公式变了，渲染区也是正常的，无闪烁正常出现公式变化, 这个闪烁绝对是
 *      不正常的.」
 *
 *  成因（scripts/acceptance/probe-click-rerender.cjs：逐帧 rAF 采样 + 给块公式 owner 挂
 *  classList 代理抓调用栈）：一次点击里 `--expand` 的变动序列是
 *      refreshMathEditing(render/js/math-edit.js) remove --expand   ← **我们自己摘的**
 *      Vditor B()  add --expand / remove --hidden                   ← 松手后 Vditor 装回来
 *  摘它的原因是第 7 轮治拖拽抖动的那条规则（`blocked`：press 期间块公式进不了 `editing`），
 *  于是"光标明明已经在源码里"也被当成"不该展开"→ 收回。按下与松开之间隔着若干帧，
 *  块盒高度 145→119→145（差的 26px 正是**源码行**那一条）就成了用户看到的整块闪烁。
 *  键盘移动不挂 `.typora-ir-pointer`，所以不闪——与用户描述一致。
 *
 *  修法：press 期间**冻结按下那一刻已经展开的块公式**（`frozen()`）——不展开（防抖语义原样保留），
 *  也不收回；松手后 pointer 类摘掉、快照立刻失效，照常按"光标在不在公式里"收回。
 *
 *  反假通过：
 *    · 逐帧采样（rAF 回调之后紧接着就是绘制，采到的状态就是用户这一帧看到的）——**必须**采到
 *      "折叠态"帧才算失败；同时自证"这一帧真的采到了、而且真的按在公式里"；
 *    · 人手点击的时序：按下后**真的等 250ms** 再松开（探针早先版本把 pressed/released 连着发，
 *      一帧折叠态都采不到，于是"点一下会闪"在台面上看不见）；
 *    · 独立证人：真实文件落盘字节不变 + preview 子节点同一性 + KaTeX 重建计数为 0。
 *  A/B（关掉冻结必须让这个场景变红）：
 *    node -e "const fs=require('fs');const f='app/renderer/js/math-edit.js';const t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,t.replace('const frozen=owner=>!!pressFrozen&&pressFrozen.owners.has(owner);','const frozen=owner=>false;'))"
 *    实测（修前）：一次按住 250ms 的点击里采到 **15 帧连续折叠态**（h 145→119）、块高取值 [145,119]。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '91-block-math-click-no-repaint-2.1.20',
  title: '展开态块公式的单击（无文字变动）：逐帧零折叠、块高不变、不重建渲染',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '91-round');
    fs.mkdirSync(dir, {recursive: true});
    const IF = `document.getElementById('editor').contentWindow`;

    const formula = '\\mathbb{E}_{\\mathbb{P}}[\\mathbf{1}_{E}]=\\int \\mathbf{1}_{E} d\\mathbb{P}'
      + '=\\int_{E} d\\mathbb{P}=\\mathbb{P}(E)';
    const file = path.join(dir, '点击不重渲染.md');
    const source = ['# 点击不重渲染', '',
      '上面一段：公式之前，写点字把版面撑开。', '',
      '$$', formula, '$$', '',
      '下面一段：公式之后，也写点字。', ''].join('\n');
    fs.writeFileSync(file, source);
    const bytesBefore = fs.readFileSync(file);

    const session = await ctx.launch({args: [file]});
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document; if (!doc) return false;
        const leaf = [...doc.querySelectorAll('.vditor-ir__preview [data-typora-source-start]')]
          .filter(n => !n.querySelector('[data-typora-source-start]')).find(n => n.getBoundingClientRect().width > 1);
        return !!leaf && !!doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]'); })()`,
        {timeout: 60000, interval: 80});
      ctx.assert('块公式渲染出了可点的字形（有真几何才谈得上"闪不闪"）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(1200);
      ctx.assert('被测窗口在前台（否则按键/点击送不到编辑器）', await session.foreground() === true, await session.foreground());
      if (!(await session.foreground())) return;

      // ---- 仪表：逐帧采样 + 重建计数 + preview 子节点同一性 ----
      // 逐帧采样器：rAF 回调之后紧接着就是这一帧的样式/布局/绘制，所以这里采到的
      // 块盒几何与 `--expand` 状态就是"用户这一帧看到的"。
      await session.js(`(() => { const w = ${IF}, doc = w.document;
        const R = w.__cc = {on: false, frames: [], builds: 0, kids: 0, kid: null};
        const owner = () => doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]');
        const nm = n => !n ? 'null' : n.nodeType === 3 ? 'TEXT' : n.tagName + String(n.className ? '.' + String(n.className).split(' ')[0] : '');
        R.arm = () => { if (w.katex && !w.katex.__cc && w.katex.renderToString) {
            const original = w.katex.renderToString;
            w.katex.renderToString = function (...args) { R.builds++; return original.apply(this, args); };
            w.katex.__cc = true; } };
        R.arm();
        let real = w.katex;
        try { Object.defineProperty(w, 'katex', {configurable: true, get() { return real; },
          set(value) { real = value; R.arm(); }}); } catch (error) { R.katexHook = String(error); }
        R.reset = () => { const o = owner(), p = o && o.querySelector('.vditor-ir__preview'), c = o && o.querySelector('code');
          R.on = true; R.frames = []; R.builds = 0; R.kid = p ? p.firstElementChild : null;
          R.previewBefore = p ? p.innerHTML : null; R.srcBefore = c ? c.textContent : null;
          R.code = c; R.log = []; return true; };
        R.stop = () => { R.on = false; const o = owner(), p = o && o.querySelector('.vditor-ir__preview'), c = o ? o.querySelector('code') : null;
          const heights = [...new Set(R.frames.map(f => f.h))], tops = [...new Set(R.frames.map(f => f.top))];
          return {frames: R.frames.length, folded: R.frames.filter(f => f.folded).length,
            inOwnerFrames: R.frames.filter(f => f.inOwner).length,
            heights, tops, builds: R.builds,
            expanded: !!o && o.classList.contains('vditor-ir__node--expand'),
            previewByteSame: !!p && p.innerHTML === R.previewBefore,
            sameKid: !!p && p.firstElementChild === R.kid,
            srcByteSame: !!c && c.textContent === R.srcBefore,
            previewKidChanges: R.log.filter(x => x === 'kid').length}; };
        const tick = () => { const o = owner();
          if (R.on && o) { const box = o.getBoundingClientRect();
            const sel = w.getSelection(), node = sel ? sel.focusNode : null;
            const at = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
            R.frames.push({t: Math.round(w.performance.now()),
              folded: !o.classList.contains('vditor-ir__node--expand'),
              top: Math.round(box.top), h: Math.round(box.height),
              inOwner: !!(at && at.closest && at.closest('.vditor-ir__node[data-type="math-block"]'))}); }
          w.requestAnimationFrame(tick); };
        w.requestAnimationFrame(tick);
        const root = doc.querySelector('.vditor-ir .vditor-reset');
        const mo = new w.MutationObserver(records => { if (!R.on) return;
          for (const r of records) { const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
            if (t && t.closest && t.closest('.vditor-ir__node[data-type="math-block"]') && r.type === 'childList') R.log.push('kid'); } });
        if (root) mo.observe(root, {childList: true, subtree: true, characterData: true});
        return true; })()`);

      const box = () => session.js(`(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
        const o = doc.querySelector('.vditor-ir .vditor-ir__node[data-type="math-block"]');
        const at = (node, fy) => { if (!node) return null; const r = node.getBoundingClientRect();
          return {x: Math.round(fr.x + r.left + Math.min(6, r.width * 0.04)), y: Math.round(fr.y + r.top + r.height * fy),
            w: Math.round(r.width), h: Math.round(r.height)}; };
        const pre = o.querySelector('pre.vditor-ir__marker--pre');
        const preview = o.querySelector('.vditor-ir__preview');
        return {expand: o.classList.contains('vditor-ir__node--expand'),
          ownerH: Math.round(o.getBoundingClientRect().height),
          pre: at(pre, 0.5), preview: at(preview, 0.5),
          preDisp: pre ? w.getComputedStyle(pre).display : 'none'}; })()`);

      /** 人手点击：按下 → 等 holdMs（这期间逐帧采样）→ 松开 → 等稳定。 */
      const pressHold = async (point, holdMs) => {
        await session.js(`(() => { return ${IF}.__cc.reset(); })()`);
        await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1});
        await sleep(holdMs);
        await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1});
        await sleep(450);
        return session.js(`(() => { return ${IF}.__cc.stop(); })()`);
      };

      // ---------- A：先点渲染结果，把块公式翻开（预渲染 + 源码同时可见） ----------
      const first = await box();
      await session.click(first.preview.x, first.preview.y);
      await sleep(900);
      const opened = await box();
      ctx.witness('A：点渲染结果之后的几何', opened);
      ctx.assert('A：块公式已展开（--expand + 源码行真的参与布局，源码行高度 > 4px）',
        opened.expand === true && opened.pre && opened.pre.h > 4, opened);
      if (!(opened.expand && opened.pre && opened.pre.h > 4)) return;

      // ---------- B/C：按住 250ms 的单击——源码区、渲染区各一次 ----------
      const rounds = [['B', '源码区', 'pre'], ['C', '渲染区', 'preview'], ['B2', '源码区（第二次）', 'pre']];
      for (const [tag, label, key] of rounds) {
        const geom = await box();                    // 每轮都重新量：展开会让源码行从 0×0 变成实体
        const point = geom[key];
        if (!point || point.h < 4) { ctx.assert(`${tag}：${label} 有点击目标`, false, {几何: geom}); continue; }
        const dump = await pressHold(point, 250);
        ctx.witness(`${tag}：${label} 按住 250ms 期间的逐帧采样`, {
          采样帧数: dump.frames, 采到折叠态的帧: dump.folded, 按在公式里的帧: dump.inOwnerFrames,
          块高取值: dump.heights, 块top取值: dump.tops, KaTeX重建次数: dump.builds,
          preview子节点变动: dump.previewKidChanges,
          仍展开: dump.expanded, preview逐字节不变: dump.previewByteSame,
          首子节点同一: dump.sameKid, 源码逐字节不变: dump.srcByteSame});
        // 自证：真的采到了多帧，而且按下期间光标/选区确实落在这条公式上（不是"什么都没发生"）
        ctx.assert(`${tag}：自证——按住期间采到足够多帧、且光标确实在这条公式里`,
          dump.frames >= 8 && dump.inOwnerFrames >= 3, {采样帧数: dump.frames, 按在公式里的帧: dump.inOwnerFrames});
        // 主断言：一帧折叠态都没有（rAF 之后的绘制就是用户看到的画面）
        ctx.assert(`${tag}：${label}单击（无文字变动）全程**零折叠帧**——块公式没有塌下去再弹回来`,
          dump.folded === 0, {折叠帧: dump.folded, 块高取值: dump.heights});
        ctx.assert(`${tag}：块盒高度/位置全程只有一个取值（不重排）`,
          dump.heights.length === 1 && dump.tops.length === 1, {块高取值: dump.heights, 块top取值: dump.tops});
        ctx.assert(`${tag}：单击之后仍保持展开（--expand 没被收掉）`, dump.expanded === true, dump);
        // 渲染结果没有被重建：KaTeX 没再跑、preview 的子树逐字节不变、首子节点还是原来那个
        ctx.assert(`${tag}：没有重新渲染——KaTeX 重建 0 次、preview 子树逐字节不变、首子节点同一`,
          dump.builds === 0 && dump.previewByteSame === true && dump.sameKid === true && dump.previewKidChanges === 0,
          {KaTeX重建: dump.builds, 逐字节不变: dump.previewByteSame, 首子节点同一: dump.sameKid, preview子节点变动: dump.previewKidChanges});
        ctx.assert(`${tag}：公式源码逐字节不变（用户说"没有任何文字变动"）`, dump.srcByteSame === true, dump);
      }

      // ---------- D：对照——键盘在公式源码内部移动也不许闪 ----------
      // 注意口径：**光标走出公式时块公式收回去是应当的**（那是"收回展开态"的正常语义）。
      // 上一版这里用"折叠帧必须为 0"当断言，光标一走出源码就判红——是断言写错了，不是产品
      // 错了。这里只钉真正的不变量：**光标还在源码里时不许是折叠态**。
      const inside = await box();                    // 光标此时在源码里（上一轮刚点过源码行）
      ctx.assert('D：起手时光标就在公式源码里（对比才有意义）',
        inside.expand === true && inside.pre.h > 4, inside);
      await session.js(`(() => { return ${IF}.__cc.reset(); })()`);
      for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft']) {
        await session.key({key, code: key, vk: key === 'ArrowLeft' ? 37 : 39});
        await sleep(250);
      }
      const keyDump = await session.js(`(() => { const w = ${IF}; const d = w.__cc.stop();
        d.折叠且光标在公式里的帧 = w.__cc.frames.filter(f => f.folded && f.inOwner).length;
        d.光标在公式里的帧 = w.__cc.frames.filter(f => f.inOwner).length; return d; })()`);
      ctx.witness('D：键盘方向键（光标留在公式源码里）逐帧采样',
        {采样帧数: keyDump.frames, 折叠帧: keyDump.folded, 块高取值: keyDump.heights,
          光标在公式里的帧: keyDump.光标在公式里的帧, 折叠且光标在公式里的帧: keyDump.折叠且光标在公式里的帧});
      ctx.assert('D：自证——这一串方向键确实是在公式源码里按的（采到"光标在公式里"的帧）',
        keyDump.光标在公式里的帧 >= 3, keyDump);
      ctx.assert('D：**光标还在公式源码里时一帧折叠态都没有**（键盘移动不闪——用户的原话）',
        keyDump.折叠且光标在公式里的帧 === 0, {折叠且光标在公式里的帧: keyDump.折叠且光标在公式里的帧, 块高取值: keyDump.heights});

      // ---------- 独立证人：真实文件落盘字节不变 ----------
      await sleep(1500);                            // 给自动保存一个窗口，若真改了文档就会写盘
      const bytesAfter = fs.readFileSync(file);
      ctx.witness('独立证人：磁盘文件的字节数与哈希', {前: bytesBefore.length, 后: bytesAfter.length, 相同: bytesBefore.equals(bytesAfter)});
      ctx.assert('独立证人：真实文件逐字节不变（点击没有改文档）', bytesBefore.equals(bytesAfter),
        {前: bytesBefore.length, 后: bytesAfter.length});

      ctx.metric('block-click.repaint-frames', keyDump.折叠且光标在公式里的帧, {unit: '帧', direction: 'lower'});
      ctx.metric('block-click.owner-height-values', keyDump.heights.length, {unit: '种', direction: 'lower'});
    } finally {
      try { await session.close(); } catch {}
    }
  },
};
