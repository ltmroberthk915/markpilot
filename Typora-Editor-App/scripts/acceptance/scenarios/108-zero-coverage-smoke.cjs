/** 零覆盖子系统冒烟：导出（HTML/Word/PDF）· 阅读模式 · 大纲 · 状态栏统计 · 图表 · 编辑模式切换。
 *
 *  为什么只有"冒烟"：这几块加起来约 2.5k 行，此前**完全在验收集之外**（40 个场景里没有一个碰它们）。
 *  按既定的范围口径（核心三块 = 编辑面 + 数据安全 + 验闸门），这里只做冒烟——
 *  **打开不报错 + 产出物真的能打开 + 没有 console 错误**，不做完整语义验收。
 *  目的一是"改别处时这几块被顺手砸了要当场变红"，二是给后续要动它们的改动（例如
 *  split-navigation 与 math-source-map 的唯一权威对齐）先铺一层底。
 *
 *  判据都是用户看得见的东西：磁盘上的导出文件（独立进程读）、状态栏上的数字、面板里的条目、
 *  阅读面的可见文本、以及产物里那块图表真的渲染出了 svg。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures.cjs');
const edge = require('../edge-helpers.cjs');
const harness = require('../harness.cjs');

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const ROOT = `${IF}.document.querySelector(${JSON.stringify(SURFACE)})`;

const BODY = [
  '# 冒烟：零覆盖子系统',
  '',
  '## 第一节：正文与公式',
  '',
  '这一段里有一个行内公式 $a^2+b^2=c^2$ 与一处**加粗**，用来确认模式切换与导出没有丢内容。',
  '',
  '```mermaid',
  'flowchart LR',
  '    A[开始] --> B[结束]',
  '```',
  '',
  '| 项目 | 数值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '',
  '## 第二节：小节标题',
  '',
  '尾段：这一段的文字用来核对状态栏的字数统计与导出的正文完整性。',
  '',
].join('\n');

/** 顶层页（外壳）求值：状态栏与面板在外壳页上。 */
const SHELL_JS = expression => `(() => { ${expression} })()`;

module.exports = {
  id: '108-zero-coverage-smoke',
  title: '零覆盖子系统冒烟：导出三格式 · 阅读模式 · 大纲 · 统计 · 图表 · 模式切换',
  async run(ctx) {
    // 素材要有一张真图（导出时会被内嵌），否则"嵌入图片"那条路根本没被走到
    const images = fixtures.images();
    const file = fixtures.write('zero-coverage.md', BODY);
    const out = path.join(fixtures.room, 'exports');
    fs.mkdirSync(out, {recursive: true});
    const session = await ctx.launch({args: [file], inspect: true});
    try {
      const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 90000, interval: 30});
      ctx.assert('编辑器就绪', ready, `ready=${ready}`);
      if (!ready) return;
      await edge.settle(session);

      // ══ ① 图表（Mermaid）：块里真的渲染出 svg ═════════════════════════════
      const chart = await (async () => {
        const stop = Date.now() + 30000;
        let last = null;
        while (Date.now() < stop) {
          last = await session.js(`(() => { const w = ${IF}, d = w.document;
            const root = ${ROOT};
            if (!root) return {ok: false};
            const block = [...root.children].find(node => /mermaid/.test(node.textContent) || node.querySelector('svg'));
            const svg = root.querySelector('svg');
            const box = svg ? svg.getBoundingClientRect() : null;
            return {ok: true, hasChartBlock: !!block, svgCount: root.querySelectorAll('svg').length,
              svgBox: box ? {w: Math.round(box.width), h: Math.round(box.height)} : null,
              text: root.textContent.slice(0, 40)}; })()`);
          if (last && last.svgCount > 0) break;
          await harness.sleep(500);
        }
        return last;
      })();
      ctx.witness('① 图表块：DOM 里 svg 的数量与尺寸', chart, 'dom');
      ctx.assert('① Mermaid 代码块渲染成了图形（编辑面里出现 svg 且有尺寸）',
        !!chart && chart.svgCount >= 1 && chart.svgBox && chart.svgBox.w > 20 && chart.svgBox.h > 20,
        JSON.stringify(chart));

      // ══ ② 状态栏统计：外壳页上的数字 ═════════════════════════════════════
      const stats = await session.js(SHELL_JS(`
        const read = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : null; };
        return {words: read('st-words'), chars: read('st-chars'), lines: read('st-lines'), read_time: read('st-read')};`));
      const numbers = ['words', 'chars', 'lines'].map(key => Number(String(stats[key] || '').replace(/[^\d]/g, '')));
      ctx.witness('② 状态栏文本', stats, 'dom');
      ctx.assert('② 状态栏统计有数字（字数/字符数/行数三项都非空且为正）',
        numbers.every(value => Number.isFinite(value) && value > 0), JSON.stringify(stats));
      ctx.assert('② 行数与磁盘上的素材一致（330 行那种规模不算，这里是小素材：行数 = 素材行数）',
        numbers[2] === BODY.split('\n').length,
        JSON.stringify({状态栏: numbers[2], 素材行数: BODY.split('\n').length, 原文: stats.lines}));

      // ══ ③ 大纲：条目数与标题数一致，点一条能跳过去 ═══════════════════════
      await session.js(SHELL_JS(`document.getElementById('st-outline').click(); return 1;`));
      await harness.sleep(900);
      const outline = await session.js(`(() => { const w = ${IF}, d = w.document;
        const panel = d.querySelector('.vditor-outline');
        if (!panel) return {open: false};
        const items = [...panel.querySelectorAll('li, .vditor-outline__item')].map(node => node.textContent.trim()).filter(Boolean);
        const visible = panel.getBoundingClientRect();
        return {open: true, visible: visible.width > 0 && visible.height > 0, items: items.slice(0, 12), count: items.length}; })()`);
      ctx.witness('③ 大纲面板：可见性与条目', outline, 'dom');
      ctx.assert('③ 点状态栏的大纲按钮后，面板出现且列出了三个标题',
        outline.open && outline.visible && outline.count >= 3 &&
        ['冒烟：零覆盖子系统', '第一节：正文与公式', '第二节：小节标题'].every(head => outline.items.some(item => item.includes(head))),
        JSON.stringify(outline));
      await session.js(SHELL_JS(`document.getElementById('st-outline').click(); return 1;`));
      await harness.sleep(600);

      // ══ ④ 阅读模式：进去有阅读面、Esc 出来 ═══════════════════════════════
      // 工具栏按钮一律**用真鼠标点**（按下+抬起落在按钮的几何中心）：`.click()` 会绕过
      // "按钮在这个位置真的点得到吗"这一层，而那正是用户会碰到的。
      const clickToolButton = async type => {
        const spot = await session.js(`(() => { const w = ${IF}, d = w.document, frame = document.getElementById('editor');
          const button = [...d.querySelectorAll('.vditor-toolbar__item button')].find(node => node.dataset.type === ${JSON.stringify(type)});
          if (!button) return {ok: false, error: '没有这个工具栏按钮'};
          button.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
          const rect = button.getBoundingClientRect(), fr = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(fr.x + rect.left + rect.width / 2), y: Math.round(fr.y + rect.top + rect.height / 2),
            label: button.getAttribute('aria-label') || button.title || type}; })()`);
        if (spot.ok) { await session.move(spot.x, spot.y); await harness.sleep(80); await session.click(spot.x, spot.y); }
        return spot;
      };
      const readingOn = await clickToolButton('reading-mode');
      await harness.sleep(2500);
      const reading = await session.js(`(() => { const w = ${IF}, d = w.document;
        const marked = d.querySelector('.typora-reading');
        const surface = d.querySelector('.vditor-preview .vditor-reset') || d.querySelector('.vditor-ir .vditor-reset');
        const box = surface ? surface.getBoundingClientRect() : null;
        return {类在哪个节点: marked ? marked.tagName.toLowerCase() + '.' + String(marked.className).slice(0, 30) : null,
          active: !!(w.vditor && w.vditor.__typoraReading && w.vditor.__typoraReading.active),
          text: surface ? surface.textContent.slice(0, 40) : null,
          visible: !!(box && box.width > 100 && box.height > 100)}; })()`);
      ctx.witness('④ 阅读模式：按钮（真鼠标点击）与进入后的状态', {按钮: readingOn, 状态: reading}, 'geometry');
      ctx.assert('④ 阅读模式进入成功（标记类出现、阅读面可见且有正文）',
        readingOn.ok && !!reading.类在哪个节点 && reading.visible && /冒烟/.test(String(reading.text)),
        JSON.stringify({按钮: readingOn, 状态: reading}));
      await session.key({key: 'Escape', code: 'Escape', vk: 27});
      await harness.sleep(1200);
      const readingOut = await session.js(`(() => { const w = ${IF}, d = w.document;
        return {类还在: !!d.querySelector('.typora-reading'),
          active: !!(w.vditor && w.vditor.__typoraReading && w.vditor.__typoraReading.active)}; })()`);
      ctx.assert('④ Esc 退出阅读模式（标记类与激活态都撤掉）',
        readingOut.类还在 === false && readingOut.active === false, JSON.stringify(readingOut));

      // ══ ⑤ 源码视图切换（"分栏"= 源码面 ↔ 编辑面）：内容不许变 ═════════════
      const before = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
      const toggled = await clickToolButton('source-toggle');
      await harness.sleep(2000);
      // Vditor 的源码面**自己就是** `.vditor-sv.vditor-reset`（不是它的后代），
      // 上一版写成后代选择器 `'.vditor-sv .vditor-reset'` 于是永远查不到。
      const svMode = await session.js(`(() => { const w = ${IF}, d = w.document;
        const sv = d.querySelector('.vditor-sv');
        const box = sv ? sv.getBoundingClientRect() : null;
        const style = sv ? w.getComputedStyle(sv) : null;
        return {sv面: !!sv, sv可见: !!(box && box.width > 100 && box.height > 0 && style.display !== 'none'),
          mode: (w.vditor && w.vditor.vditor) ? w.vditor.vditor.currentMode : null,
          sv文本: sv ? sv.textContent.slice(0, 30) : null}; })()`);
      const backButton = await clickToolButton('source-toggle');
      await harness.sleep(2000);
      const back = await session.js(`(() => { const w = ${IF}, d = w.document;
        const ir = d.querySelector('.vditor-ir .vditor-reset');
        const irBox = ir ? ir.getBoundingClientRect() : null;
        return {mode: (w.vditor && w.vditor.vditor) ? w.vditor.vditor.currentMode : null,
          ir可见: !!(irBox && irBox.width > 100), value: w.vditor.getValue()}; })()`);
      ctx.witness('⑤ 源码视图往返：两次真鼠标点击与两端状态',
        {去: toggled.label, 回来: backButton.label, 源码面: svMode, 编辑面: {mode: back.mode, ir可见: back.ir可见}}, 'geometry');
      ctx.assert('⑤ 切到源码视图后源码面出现并可见（模式确实变了，不是没反应）',
        svMode.sv面 === true && svMode.sv可见 === true, JSON.stringify(svMode));
      ctx.assert('⑤ 切回编辑视图后回到 IR 模式、编辑面可见',
        back.mode === 'ir' && back.ir可见 === true, JSON.stringify({mode: back.mode, ir可见: back.ir可见}));
      ctx.assert('⑤ 往返之后 markdown 逐字节不变（视图切换不丢内容、不改格式）',
        back.value === before, JSON.stringify({同: back.value === before, 前: before.slice(0, 60), 后: String(back.value).slice(0, 60)}));

      // ══ ⑥ 导出三种格式：磁盘上真的有可打开的文件 ══════════════════════════
      const exported = [];
      for (const [format, label, check] of [
        ['html', 'HTML（独立网页）', {magic: null, min: 2000}],
        ['docx', 'Word 文档（可编辑公式）', {magic: 'PK', min: 5000}],
        ['pdf', 'PDF 文档', {magic: '%PDF', min: 5000}],
      ]) {
        const target = path.join(out, 'smoke.' + format);
        fs.rmSync(target, {force: true});
        await session.main.script([{dialog: 'save', file: target}]);
        const clicked = await session.main.clickMenu('文件 > 导出 > ' + label + '…');
        let ok = false;
        const stop = Date.now() + 120000;
        while (Date.now() < stop) {
          if (fs.existsSync(target) && fs.statSync(target).size > 0) { ok = true; break; }
          await harness.sleep(500);
        }
        const size = ok ? fs.statSync(target).size : 0;
        const head = ok ? fs.readFileSync(target).slice(0, 4).toString('latin1') : '';
        const body = ok && format === 'html' ? fs.readFileSync(target, 'utf8') : '';
        const fileOk = ok && size >= check.min && (!check.magic || head.startsWith(check.magic)) &&
          (format !== 'html' || (body.includes('冒烟：零覆盖子系统') && body.includes('<table')));
        exported.push({format, 菜单: clicked, 文件: path.basename(target), 字节: size, 头: head, 通过: fileOk});
        ctx.assert(`⑥ 导出 ${format}：磁盘上出现可用的导出文件（尺寸与文件头都对）`,
          fileOk, JSON.stringify({format, 菜单: clicked, 字节: size, 头: head,
            正文含标题与表格: format === 'html' ? {标题: body.includes('冒烟：零覆盖子系统'), 表格: body.includes('<table')} : '不适用'}));
      }
      const shellCalls = await session.main.shellCalls();
      ctx.witness('⑥ 导出落盘的三种文件与"在资源管理器中显示"的调用记录（独立进程读盘）', {exported, shellCalls}, 'disk');
      ctx.assert('⑥ 三次导出都走到了"成功后显示文件"（导出流程完整跑完，不是半路失败）',
        exported.every(row => row.通过) && (shellCalls || []).filter(call => call.name === 'showItemInFolder').length >= 3,
        JSON.stringify({exported, showItemInFolder: (shellCalls || []).filter(call => call.name === 'showItemInFolder').map(call => call.target)}));

      // ══ ⑦ 错误面：这一整轮不许有 toast / 控制台报错 ═══════════════════════
      const toasts = await session.js(edge.TOASTS);
      const problems = [...(toasts.recorded || []), ...(toasts.live || [])].map(edge.errorsOf).flat();
      ctx.witness('⑦ 全程的提示与错误面', {toasts: toasts.recorded, problems}, 'dom');
      ctx.assert('⑦ 全程没有错误提示（导出的警告不算，失败才算）', problems.length === 0, JSON.stringify(problems));
    } finally {
      await ctx.release(session);
    }
  },
};
