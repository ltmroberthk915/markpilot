/** 134 · 全文档 ←/→ 步进巡走：逐键断言"块内只进、块尾必到紧邻下一块首、永不回头、
 *  永不卡死（死路）、光标永不丢"。
 *
 *  举一反三自 2.2.7「横向进独占一行的公式丢光标」、2.2.8「标题块首 ← 死路」、
 *  2.2.9「横向 ←/→ 校正跨行跳标题」——这三只 bug 都是同一类：**横向步进的行归属**
 *  出错。钉场景只钉得住一个位置；这里把整篇文档逐键走一遍，把这一类在**任何位置**
 *  的发作都变成红灯。巡走覆盖：标题/正文/行内公式/独占行公式/块公式/列表/图片/表格。
 *
 *  ── 判据口径（2026-09-23 重写：此前用"块内字符前缀必须变大"，抓得住 bug 也会误报）──
 *  1. **推进用 DOM 顺序判**，不用字符前缀、也不用像素坐标：
 *     · 字符前缀过不了行内公式——离开公式源码时落点从"右 `$` 标记"走到"紧随其后的文本节点"，
 *       两者前缀都是 21（实测 probe-f9-walk 第 47→48 步），看着像卡死，其实是推进；
 *     · 像素纵向顺序过不了表格——`thead`/`tbody` 的画法顺序与 DOM 顺序不一致
 *       （实测同一篇文档两次巡走的 y 值反向）。
 *     DOM 顺序对这两种都成立，而且"回退/卡死/跳行"照样抓得住（F9 的回绕 bug 就是 DOM 顺序后退）。
 *  2. **光标必须看得见**：原生 caret 矩形有高度、**或落点在一行有内容的版面上**（版面条：
 *     元素级落点矩形是 0×0 但 Chromium 照画——真屏连拍实测，见 probe-caret-native-truth.cjs）。
 *     2026-10-02 双重光标取消轮2 删掉合成光标补丁后，合成竖线不再是可见性来源；读数里的
 *     `合成` 腿保留作**金丝雀**——恒应为 null，出现即有画线回潮。"看不见"是用户报告过的硬伤：
 *     矩形 0×0（2.2.7 的源）与光标整根消失。
 *  3. **不许同屏两根光标**：原生可见时合成竖线必须收起（F10 族；2026-10-02 起为金丝雀恒真）。
 *  4. 跨块必须落到**紧邻**块的**边缘**：往前落到块首（不越过块首第一处可见文字）、
 *     往后落到块尾；跳行/跳标题在这一条上变红。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const hi = require('../hi.cjs');

const BODY = [
  '# 巡走文档标题',
  '',
  '第一段：普通中文与 english 混排文字。',
  '',
  '第二段：行内公式 $a+b=c$ 夹在中间的文字。',
  '',
  '$仅此独占一行的公式x+1$',
  '',
  '第三段：公式之后的正文。',
  '',
  '$$',
  '\\int_0^1 x \\, dx = \\frac{1}{2}',
  '$$',
  '',
  '第四段：块公式之后的正文。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '第五段正文。',
  '',
  '![巡走图片](shot-walk.png)',
  '',
  '第六段：图片之后的正文。',
  '',
  '| 表头甲 | 表头乙 |',
  '| --- | --- |',
  '| 单元甲 | 单元乙 |',
  '',
  '末段：巡走收尾。',
  '',
].join('\n');

/** 一次读数。四个组件各有分工（DOM 节点过不了 CDP，读数必须是纯 JSON）：
 *  · `前缀`（块内文本偏移，range.toString 长度）= **纵向推进的唯一尺子**，跨重渲染稳定；
 *  · `像素`（原生矩形或合成竖线）= 区分"同一个文本偏移但落点换了"（行内公式的
 *    "右 `$` 标记 → 紧随其后的文本节点"就是这种：前缀同为 21，视觉上往前挪了一格）；
 *  · `指纹`（块 HTML 长度 + 展开节点数）= 捕捉"展开/收起"这类 DOM 状态变化，
 *    配合像素一起判"这一次按键到底有没有发生任何变化"；
 *  · `层` + 原生/合成 = 可见性与双光标。 */
const 站 = `(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
  if (!s) return { 没编辑面: true };
  const sel = w.getSelection();
  if (!sel || !sel.rangeCount) return { 无选区: true, 焦点: d.hasFocus() };
  const r = sel.getRangeAt(0);
  const 节点 = r.startContainer;
  let top = 节点;
  while (top && top.parentElement && top.parentElement !== s) top = top.parentElement;
  const 块 = top && top.parentElement === s ? [...s.children].indexOf(top) : -1;
  const box = r.getBoundingClientRect();
  const 原生 = box && box.height > 0 ? { x: Math.round(box.left), y: Math.round(box.top), h: Math.round(box.height) } : null;
  const 条 = [...d.querySelectorAll('[data-typora-caret-proxy]')].filter(b => b.style.display !== 'none' && b.getBoundingClientRect().height > 0)[0] || null;   // 金丝雀（补丁已删，恒 null；出现即回潮）
  const 条框 = 条 ? 条.getBoundingClientRect() : null;
  const 合成 = 条框 ? { x: Math.round(条框.left), y: Math.round(条框.top), h: Math.round(条框.height) } : null;
  const 上级 = 节点.nodeType === 3 ? 节点.parentElement : 节点;
  const 层 = 节点.nodeType === 3
    ? (上级?.closest?.('code[data-type]') ? '源码'
      : 上级?.closest?.('.vditor-ir__preview') ? '预览'
      : 上级?.closest?.('.vditor-ir__marker,[data-type$="-marker"]') ? '围栏' : '正文')
    : '元素级';
  let 前缀 = null, 块长 = null, 指纹 = null;
  if (块 >= 0 && top) {
    const whole = d.createRange(); whole.selectNodeContents(top);
    块长 = whole.toString().length;
    const pre = d.createRange(); pre.selectNodeContents(top); pre.setEnd(节点, r.startOffset);
    前缀 = pre.toString().length;
    指纹 = top.innerHTML.length + '|' + top.querySelectorAll('.vditor-ir__node--expand').length + '|' + top.childNodes.length;
  }
  // 版面可见：块内光标之前/之后任一侧能取到**有高度的行盒** = Chromium 自己画得出光标。
  // （元素级落点矩形读回来 0×0，原生照样画着——真屏连拍实测 probe-caret-native-truth.cjs；
  //  2.2.13 曾把矩形当判据，于是把"两根光标"当成尺子误报，见 LOG-2.2.13 §十二。）
  const 版面 = (() => {
    if (块 < 0 || !top) return false;
    const 偏 = 节点.nodeType === 3 ? Math.min(r.startOffset, 节点.length) : Math.min(r.startOffset, 节点.childNodes.length);
    const 有行 = rr => { try { return [...rr.getClientRects()].some(b => b.height > 0); } catch (error) { return false; } };
    const 甲 = d.createRange(); try { 甲.setStart(top, 0); 甲.setEnd(节点, 偏); if (有行(甲)) return true; } catch (error) { /* 跨块非法区间：换下一条 */ }
    const 乙 = d.createRange(); try { 乙.setStart(节点, 偏); 乙.setEnd(top, top.childNodes.length); if (有行(乙)) return true; } catch (error) { /* 同上 */ }
    return false;
  })();
  return { 块, 前缀, 块长, 指纹, 偏移: r.startOffset, 层, 折叠: r.collapsed, 原生, 合成, 版面,
    选区长: sel.toString().length, 焦点: d.hasFocus() }; })()`;

/** 这一键"动了没"：向前 / 倒退 / 原地（原地＝前缀、像素、块指纹三者全都没变）。 */
const 动了 = (prev, now) => {
  if (now.前缀 > prev.前缀) return '向前';
  if (now.前缀 < prev.前缀) return '倒退';
  if (JSON.stringify(now.原生 || now.合成) !== JSON.stringify(prev.原生 || prev.合成)) return '同前缀换落点';
  if (now.指纹 !== prev.指纹) return '同前缀换形态';
  return '原地';
};
const 可见吗 = o => !!(o && (o.原生 || o.版面));   // 2026-10-02 起：合成竖线已删，可见性只认原生矩形或版面行盒
const 像素 = o => o ? (o.原生 || o.合成) : null;
const 描述 = o => o && o.块 !== undefined
  ? `块${o.块} 前缀${o.前缀}/${o.块长}@${o.偏移}(${o.层}) 原生${JSON.stringify(o.原生)} 合成${JSON.stringify(o.合成)}`
  : JSON.stringify(o);

module.exports = {
  id: '134-hi-horizontal-full-walk',
  title: '全文档 →/← 逐键巡走：DOM 顺序只进不回、块尾必到紧邻块首、无死路、光标全程可见',
  run: async ctx => {
    fs.mkdirSync(hi.ROOM, { recursive: true });
    fs.writeFileSync(path.join(hi.ROOM, 'shot-walk.png'), hi.fixtures.png(120, 80, [150, 90, 200]));
    const file = hi.writeDoc('horizontal-walk.md', BODY);
    const session = await hi.openDoc(ctx, file, { minBlocks: 12, settleMs: 1800 });
    try {
      const md0 = String(await hi.mdNow(session));
      const blockCount = await session.js(`(() => { const w = ${hi.IF}, d = w.document; return d.querySelector('${hi.SURFACE}').children.length; })()`);
      ctx.assert('文档打开（块数 ≥12）', md0.includes('巡走文档标题') && blockCount >= 12, `块数 ${blockCount}`);
      const focus = await hi.ensureFocus(session);
      ctx.assert('焦点在编辑器', focus.ok, JSON.stringify(focus));

      const read = () => session.js(站);
      const walk = async (key, cap) => {
        const forward = key === 'ArrowRight';
        const 违规 = [];
        let 步数 = 0;
        await hi.press(session, forward ? 'Home' : 'End', { modifiers: hi.MOD.ctrl });
        await hi.sleep(320);
        let prev = await read();
        if (!prev || prev.无选区 || prev.块 === -1 || !prev.折叠) {
          return { 违规: [{ 第几步: 0, 问题: '起点读不到光标', 实际: 描述(prev) }], 步数: 0, 终点: prev };
        }
        for (let i = 1; i <= cap; i++) {
          步数 = i;
          await hi.press(session, key);
          await hi.sleep(90);
          const now = await read();
          const 证据 = { 第几步: i, 之前: 描述(prev), 实际: 描述(now) };
          if (!now || now.无选区 || now.块 === -1 || !now.折叠) {
            // 元素级落点在**块与块之间**（编辑面上的兄弟位置）——F9 报告里"← 巡走第 9 步
            // 光标丢失"就是这个形状：行首按 ← 没落到上一行行尾，而是停在两行之间。
            违规.push({ ...证据, 问题: '光标停在块与块之间（没落进任何一块）' });
            break;
          }
          if (!可见吗(now)) 违规.push({ ...证据, 问题: '光标不可见（原生矩形 0×0 且版面无行盒）' });
          else if (now.原生 && now.合成) 违规.push({ ...证据, 问题: '同屏两根光标（原生可见时合成竖线没收；金丝雀：合成线已删，触发即画线回潮）' });
          let 到头 = false;
          if (now.块 !== prev.块) {
            const 期望块 = prev.块 + (forward ? 1 : -1);
            if (now.块 !== 期望块) 违规.push({ ...证据, 问题: forward ? '跨块没有落到紧邻下一块' : '跨块没有落到紧邻上一块' });
          } else {
            const 动 = 动了(prev, now);
            if (forward ? 动 === '倒退' : 动 === '向前') {
              违规.push({ ...证据, 问题: forward ? '光标往回走了' : '光标往前走了' });
            } else if (动 === '原地') {
              // 原地不动：只有文末（→）/ 文首（←）允许，其余都是卡死
              if (forward ? now.块 === blockCount - 1 : now.块 === 0) 到头 = true;
              else 违规.push({ ...证据, 问题: '原地不动（卡死）' });
            }
          }
          if (违规.length >= 4) break;
          prev = now;
          if (到头) break;
          if (!forward && now.块 === 0 && now.层 === '正文' && now.偏移 === 0) break;
        }
        return { 违规, 步数, 终点: prev, 像素: 像素(prev) };
      };

      // ══ ① → 全篇巡走（含公式/列表/图片/表格） ══════════════════════════════════
      const right = await walk('ArrowRight', 300);
      ctx.witness('几何：→ 巡走的违规与终点', { 违规: right.违规, 步数: right.步数, 终点: 描述(right.终点) }, 'geometry');
      ctx.assert('① → 逐键巡走：可见、只进、块尾必到紧邻下一块首（无跳行/无死路/不丢光标）',
        right.违规.length === 0, JSON.stringify(right.违规.slice(0, 3)));
      ctx.assert('① → 巡走确实走到了文档最末块',
        !!right.终点 && right.终点.块 === blockCount - 1, 描述(right.终点));
      await session.shot('134-walk-end');

      // ══ ② ← 从文末巡走回文首 ════════════════════════════════════════════════════
      const left = await walk('ArrowLeft', 300);
      ctx.witness('几何：← 巡走的违规与终点', { 违规: left.违规, 步数: left.步数, 终点: 描述(left.终点) }, 'geometry');
      ctx.assert('② ← 逐键巡走：可见、只退、块首必到紧邻上一块尾（无跳标题/无死路/不丢光标）',
        left.违规.length === 0, JSON.stringify(left.违规.slice(0, 3)));
      ctx.assert('② ← 巡走回到了文档最首块首',
        !!left.终点 && left.终点.块 === 0, 描述(left.终点));

      // ══ ③ 磁盘证人：巡走零编辑 ══════════════════════════════════════════════════
      const saved = await hi.edge.saveAndWait(session, file, { timeout: 8000 });
      const disk = String(saved.after).replace(/\r/g, '');
      ctx.witness('磁盘：巡走零编辑保存', { 磁盘长: disk.length }, 'disk');
      ctx.assert('③ 磁盘 == 原文', disk.replace(/\n+$/, '') === BODY.replace(/\n+$/, ''), disk.slice(0, 50));
    } finally {
      await ctx.release(session);
    }
  },
};
