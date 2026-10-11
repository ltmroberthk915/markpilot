/** 2.1.23 回归：AI 补全的**灰字建议框**要能读、能滚，点它不再消失，长内容给够窗口。
 *
 *  用户（2026-09-15）：
 *    「这个AI补全的显示框无法上下滚动，如果补全内容超过一行，一点就跑，一点就全框消失，
 *      这个问题要解决」
 *    「对于行数过多的补全内容，你给一个自动优化的窗口大小，尽量让用户少拉动页面滚动条」
 *
 *  修前（对 2.1.22 安装版跑同一套断言，除控制组外全红）：
 *    · `.md-completion-preview` 的 computed `pointer-events` 是 `none`（原意"别挡着点正文"）：
 *      命中的是它背后的正文，`elementFromPoint` 返回编辑器内容，滚轮也直接穿到正文 ⇒ 框自己滚不动；
 *    · 写死 `max-height:180px`：多行建议被截断，截掉的部分既看不见也拉不到；
 *    · completion.js 里那条 document mousedown 守卫只放过候选列表 `popup`，不放过 `preview`
 *      ⇒ 按在建议框上＝关框＋光标落到正文（一次点击两件事，用户看到的就是"一点就跑、全框消失"）；
 *    · 框内滚动会触发 scroll 守卫的重新落位（只排除了 popup）⇒ 刚读到的地方被挪走。
 *
 *  修法：
 *    · CSS：`pointer-events:auto` + `overflow-y:auto` + `overscroll-behavior:contain`，
 *      上限 `min(56vh,440px)`（真正高度由 position() 按光标上下可用空间算）；
 *    · completion.js：把 preview 并入"补全 UI"——press 在框里 preventDefault（不落光标）、
 *      document mousedown 守卫与 scroll 守卫都跳过框内事件；
 *    · position()：建议框的上限放大到 `min(520, 60vh)`（候选列表仍是 360）。
 *
 *  采样口径：断言全部落在**真 DOM + 真命中测试 + 真 CDP 输入**上：
 *    elementFromPoint 证明"点击落在框上"（它尊重 pointer-events），
 *    mousePressed/Released 与 wheel 用外壳视口坐标真送（iframe 偏移照加），
 *    再逐帧量光标是否被挪动。为了几何可判定，测试自己把框放到固定位置（框架本身不参与定位断言）。
 *
 *  A/B（把这一版的 pointer-events 改回 none 必须变红）：
 *    node -e "const fs=require('fs');const f='app/renderer/css/completion.css';const t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,t.replace('pointer-events:auto}','pointer-events:none}'))"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '93-ai-preview-box-scroll-2.1.23',
  title: 'AI 建议框：可命中、可滚动、点它不关框不动光标，长内容给足窗口',
  async run(ctx) {
    const harness = require('../harness.cjs');
    const sleep = harness.sleep;
    const dir = path.join(ctx.outDir, '93-round');
    fs.mkdirSync(dir, { recursive: true });
    const IF = `document.getElementById('editor').contentWindow`;

    const file = path.join(dir, 'AI建议框.md');
    const source = ['# AI 建议框', '', '这一段用来撑开版面，让编辑器有内容可点。', '', '再来一句收尾。', ''].join('\n');
    fs.writeFileSync(file, source);
    const bytesBefore = fs.readFileSync(file);

    const session = await ctx.launch({ args: [file] });
    try {
      const ready = await session.until(`(() => { const w = ${IF}, doc = w && w.document;
        return !!(doc && doc.querySelector('.vditor-ir') && doc.querySelector('.md-completion-preview')); })()`,
        { timeout: 60000, interval: 80 });
      ctx.assert('渲染层装好了补全组件（真元素 .md-completion-preview 在文档里）', ready, 'timeout 60s');
      if (!ready) return;
      await sleep(900);
      ctx.assert('被测窗口在前台（否则真输入送不到编辑器）', await session.foreground() === true, await session.foreground());
      if (!(await session.foreground())) return;

      // ---- 把建议框摆到一个可判定的位置，并塞进 60 行"长建议" ----
      const fixture = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const preview = doc.querySelector('.md-completion-preview');
        preview.hidden = false;
        preview.style.left = '60px'; preview.style.top = '70px'; preview.style.maxHeight = '';
        preview.replaceChildren();
        const body = doc.createElement('div'); body.className = 'md-completion-ghost';
        body.textContent = Array.from({length: 60}, (_, i) => '第 ' + (i + 1) + ' 行建议内容').join('\\n');
        const hint = doc.createElement('small'); hint.textContent = 'AI · Tab 接受 · Esc 取消 · 内容多可直接滚动';
        preview.append(body, hint);
        const style = w.getComputedStyle(preview), r = preview.getBoundingClientRect();
        const fr = w.frameElement.getBoundingClientRect();
        return {pointerEvents: style.pointerEvents, overflowY: style.overflowY, overscroll: style.overscrollBehavior,
          maxHeight: style.maxHeight, clientHeight: preview.clientHeight, scrollHeight: preview.scrollHeight,
          boxHeight: Math.round(r.height), box: {left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
            shellLeft: Math.round(fr.x + r.left), shellTop: Math.round(fr.y + r.top)}}; })()`);
      ctx.witness('建议框：computed 样式、可滚动量、盒子几何（外壳坐标）', fixture);

      ctx.assert('建议框自己收事件（pointer-events: auto，修前是 none：点击与滚轮都穿到正文）',
        fixture.pointerEvents === 'auto', fixture.pointerEvents);
      ctx.assert('建议框可上下滚动（overflow-y: auto）', fixture.overflowY === 'auto', fixture.overflowY);
      ctx.assert('长建议的窗口比旧的 180px 上限更大，且真的溢出可滚',
        parseFloat(fixture.maxHeight) > 180 && fixture.scrollHeight > fixture.clientHeight && fixture.clientHeight > 180,
        {maxHeight: fixture.maxHeight, clientHeight: fixture.clientHeight, scrollHeight: fixture.scrollHeight});

      // ---- 命中测试：框中央那一点命中的必须是框自己 ----
      const hit = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const preview = doc.querySelector('.md-completion-preview'), r = preview.getBoundingClientRect();
        const node = doc.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(40, r.height / 2)));
        return {tag: node ? node.tagName : null, inPreview: !!(node && node.closest && node.closest('.md-completion-preview'))}; })()`);
      ctx.witness('elementFromPoint（iframe 坐标）在框中央命中的节点', hit);
      ctx.assert('框中央命中的是建议框自己（pointer-events:none 时这里返回的是背后的正文）', hit.inPreview === true, hit);

      // ---- 真输入：按在框上不关框、不挪光标 ----
      const selection = () => session.js(`(() => { const w = ${IF}, doc = w.document;
        const sel = w.getSelection(); if (!sel || !sel.rangeCount) return null;
        const rg = sel.getRangeAt(0);
        const path = node => { const parts = []; let n = node;
          while (n && n.nodeType === 1) { parts.unshift([...n.parentNode.children].indexOf(n)); n = n.parentNode; }
          return parts.join('.') + ':' + (node.nodeType === 3 ? 'text' : node.tagName) + '@' + rg.startOffset; };
        return path(rg.startContainer); })()`);
      const before = await selection();
      const center = { x: fixture.box.shellLeft + Math.round(fixture.box.w / 2), y: fixture.box.shellTop + Math.round(fixture.box.h / 2) };
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(120);
      const held = await session.js(`(() => { const w = ${IF}, doc = w.document;
        return {hidden: doc.querySelector('.md-completion-preview').hidden}; })()`);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(160);
      const after = await selection();
      const stillShown = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const preview = doc.querySelector('.md-completion-preview');
        return {hidden: preview.hidden, scrollTop: preview.scrollTop}; })()`);
      ctx.witness('点击前后：建议框可见性 / 编辑器选区', {held, after, before});
      ctx.assert('按住建议框时它不消失', held.hidden === false, held);
      ctx.assert('点一下建议框：不关框（用户实测的"一点就全框消失"）', stillShown.hidden === false, stillShown);
      ctx.assert('点建议框不会把光标挪到正文里（用户实测的"一点就跑"）', after === before, {before, after});

      // ---- 框内滚轮只滚框，不把正文滚走 ----
      const scrollBefore = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const scroller = doc.querySelector('.vscode-scrollable, .vditor-reset') || doc.scrollingElement || doc.documentElement;
        return {editor: doc.scrollingElement ? doc.scrollingElement.scrollTop : 0,
          preview: doc.querySelector('.md-completion-preview').scrollTop}; })()`);
      await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: 160 });
      await sleep(220);
      const scrollAfter = await session.js(`(() => { const w = ${IF}, doc = w.document;
        const preview = doc.querySelector('.md-completion-preview');
        return {editor: doc.scrollingElement ? doc.scrollingElement.scrollTop : 0, preview: preview.scrollTop}; })()`);
      ctx.witness('滚轮前后（框内 scrollTop / 正文 scrollTop）', {scrollBefore, scrollAfter});
      ctx.assert('滚轮在框里滚的是框自己（修前事件穿到正文，框内 scrollTop 一动不动）',
        scrollAfter.preview > scrollBefore.preview, {scrollBefore, scrollAfter});
      ctx.assert('框内滚动不把正文滚走', scrollAfter.editor === scrollBefore.editor, {scrollBefore, scrollAfter});

      // ---- 控制组：点正文照旧收起来（别把"点外面不关"也一起改坏）----
      const editorPoint = await session.js(`(() => { const w = ${IF}, doc = w.document, fr = w.frameElement.getBoundingClientRect();
        const p = doc.querySelector('.vditor-ir p, .vditor-reset p'), r = p.getBoundingClientRect();
        return {x: Math.round(fr.x + r.left + 8), y: Math.round(fr.y + r.top + Math.round(r.height / 2))}; })()`);
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editorPoint.x, y: editorPoint.y, button: 'left', buttons: 1, clickCount: 1 });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editorPoint.x, y: editorPoint.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(200);
      const dismissed = await session.js(`(() => { const w = ${IF}, doc = w.document;
        return {hidden: doc.querySelector('.md-completion-preview').hidden}; })()`);
      ctx.assert('点正文仍然照旧把建议框收起来（控制组：只有框内被豁免）', dismissed.hidden === true, dismissed);

      // ---- 独立证人：被测文件字节不变 ----
      ctx.assert('被测文件字节未变（本轮只碰内存里的 DOM）', Buffer.compare(bytesBefore, fs.readFileSync(file)) === 0, 'bytes');
    } finally {
      await session.close();
    }
  },
};
