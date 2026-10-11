/** R8 终局回归 · 73-mixed-editing-stress 剪切右键红定点取证。
 *  症状：同场景"粘贴"右键菜单可开，"剪切"在合成选区上右键 3 次尝试菜单都未出现
 *  （{"opened":false,"label":null}），基线（fa86fa6）同步骤通过。
 *  本探针复刻 73 的素材与步骤序列（写段落 → End → 菜单粘贴 → 保存 → 合成选区 →
 *  选区中心右键），逐步倾倒：selectionPoint 读数、顶层 elementFromPoint、命中的
 *  元素是否在 .vditor-content 里、菜单 DOM 存在与否、contextmenu 事件是否到过
 *  编辑面 document（在探针入口先挂一个 capture 计数器）。
 *  用法：node scripts/acceptance/probe-r8-cutmenu.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const edge = require('./edge-helpers.cjs');

const OUT = path.join(harness.project, '.perf/probe-r8-cutmenu');
fs.rmSync(OUT, {recursive: true, force: true});
fs.mkdirSync(OUT, {recursive: true});
const sleep = harness.sleep;
const PASTE_TEXT = '从独立进程写进剪贴板的粘贴串R8';

const 夹具 = [
  '# 混合编辑压力',
  '',
  '第 1 段：查找目标“第二节”不在这段。$a+b=c$ 行内公式一枚。',
  '',
  '第二节：替换与撤销的目标段落，内容再长一点也没关系。',
  '',
  '第 3 段：剪切目标所在的段落，粘贴串会落在第 1 段末尾。',
].join('\n') + '\n';

(async () => {
  const file = path.join(OUT, 'mixed.md');
  fs.writeFileSync(file, 夹具);
  const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
  const APP_MAIN = path.join(harness.project, 'app/main/main.js');
  const session = await harness.launch({exe: EXE, appArgs: [APP_MAIN], args: [file], inspect: true,
    label: 'r8-cutmenu', outDir: path.join(OUT, 'shots'), timeout: 180000});
  const inEditor = expr => `(() => { const doc = document; const frame = doc.getElementById('editor'); const w = frame && frame.contentWindow; const d = w && w.document; ${expr} })()`;
  try {
    await session.until(inEditor(`return !!(d && d.querySelector('.vditor-ir .vditor-reset'))`), {timeout: 60000, interval: 100});
    await edge.settle(session); await sleep(400);

    // 与 73 相同：点第 1 段 → End → 右键菜单粘贴
    const point = await session.js(edge.pointOf(inEditor(`
      const surface = d.querySelector(${JSON.stringify(edge.SURFACE)});
      return [...surface.children].find(node => node.textContent.includes('第 1 段')) || null;`)));
    await session.click(point.x, point.y); await sleep(250);
    await session.key({key: 'End', code: 'End', vk: 35}); await sleep(250);

    // 挂 contextmenu 计数器（capture，最早一层）
    await session.js(inEditor(`w.__r8ctx = 0; d.addEventListener('contextmenu', () => { w.__r8ctx++; }, {capture: true, once: false}); return true;`));

    const written = harness.writeClipboard(path.join(OUT, 'clip'), PASTE_TEXT);
    console.log('剪贴板写入：', JSON.stringify({ok: written.ok, length: written.length}));
    const pasteMenu = await edge.menuClick(session, inEditor(`
      const surface = d.querySelector(${JSON.stringify(edge.SURFACE)});
      return [...surface.children].find(node => node.textContent.includes('第 1 段')) || null;`), 'paste', {wait: 1200});
    console.log('粘贴菜单：', JSON.stringify({opened: pasteMenu.opened, label: pasteMenu.label}));
    await sleep(300);

    // 与 73 相同：合成选区
    const selected = await session.js(inEditor(`return (() => {
      const surface = d.querySelector(${JSON.stringify(edge.SURFACE)});
      const walker = d.createTreeWalker(surface, NodeFilter.SHOW_TEXT, null);
      let node = null;
      while (walker.nextNode()) if (walker.currentNode.data.includes(${JSON.stringify(PASTE_TEXT)})) node = walker.currentNode;
      if (!node) return null;
      const at = node.data.indexOf(${JSON.stringify(PASTE_TEXT)});
      const range = d.createRange();
      range.setStart(node, at); range.setEnd(node, at + ${JSON.stringify(PASTE_TEXT)}.length);
      const selection = w.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      const rect = range.getBoundingClientRect();
      return {text: selection.toString(), length: selection.toString().length, rect: [rect.x, rect.y, rect.width, height = rect.height]};
    })()`));
    console.log('合成选区：', JSON.stringify(selected));

    // selectionPoint 读数 + 顶层命中元素
    const sp = await session.js(edge.selectionPoint);
    console.log('selectionPoint：', JSON.stringify(sp));
    if (sp && sp.ok) {
      const hit = await session.js(`(() => {
        const el = document.elementFromPoint(${sp.x}, ${sp.y});
        const frame = document.getElementById('editor');
        const inner = frame && frame.contentWindow && frame.contentWindow.document.elementFromPoint(${sp.x} - frame.getBoundingClientRect().x, ${sp.y} - frame.getBoundingClientRect().y);
        const describe = node => node ? (node.nodeName + (node.className && typeof node.className === 'string' ? '.' + node.className.split(/\\s+/).join('.') : '')) : null;
        return {top: describe(el), inContent: !!(el && el.closest && el.closest('#editor')),
          inner: describe(inner), innerInContent: !!(inner && inner.closest && inner.closest('.vditor-content')),
          toolbar: !!(el && el.closest && el.closest('.typora-toolbar, .toolbar'))};
      })()`);
      console.log('命中期：', JSON.stringify(hit));
      // 右键
      await session.move(sp.x, sp.y); await sleep(90);
      await session.click(sp.x, sp.y, {button: 'right'});
      for (let i = 0; i < 6; i++) {
        await sleep(150);
        const menu = await session.js(edge.MENU_ITEMS);
        const ctxCount = await session.js(inEditor(`return w.__r8ctx;`));
        if (menu.open || i === 5) {
          console.log('右键后第' + (i + 1) + '拍：menu.open=' + menu.open + ' 项=' + JSON.stringify((menu.items || []).map(x => x.action)) + ' contextmenu到=' + ctxCount);
          if (menu.open) break;
        }
      }
    }
    const fin = await session.js(inEditor(`return {ctx: w.__r8ctx, menu: !!d.querySelector('.typora-editor-context-menu')};`));
    console.log('收尾读数：', JSON.stringify(fin));
  } catch (error) {
    console.log('探针异常：', error && error.stack || error);
  } finally {
    await session.close();
    console.log('DONE');
  }
})();
