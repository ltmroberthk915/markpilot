/** 日常操作巡检出身的回归场景（2026-09-13 那一轮"模拟真人日用"扫出来的三条真缺陷 + 若干现状记录）。
 *
 *  背景：用户要求"模拟日常操作找 bug"。用一批日用动作（新建/重命名文件、编辑保存、缩放、
 *  表格增删、列表回车、撤销重做、查找替换、IME、拖选…）逐条量，最终确认并**修好**了三条：
 *    A 文件树里的内联输入框（新建 Markdown / F2 重命名）**拿不到焦点**：用户点完"新建"直接
 *      打字，字全丢（activeElement 一直停在工具栏按钮上）；先点一下输入框再打字，光标落到
 *      末尾，文件名被接长成"未命名.md我的笔记.md"。根因：输入框是在离屏 DocumentFragment 里
 *      造出来的，focus() 排在 queueMicrotask 里，跑的时候它还没挂到文档上。
 *    B **CRLF 文件保存后被整篇换成 LF**（实测 CRLF 6 → 0）：Windows 上记事本打开会变成一行，
 *      git 里显示"整篇都被改了"。根因：编辑区一律 \n，落盘时没有按原文行尾还原。
 *    C 桌面版**内容缩放快捷键全哑**（Ctrl+= / Ctrl+- / Ctrl+0）：比例徽章恒为 100%，只有
 *      Ctrl+滚轮能动。根因：桌面 preload 故意提供了 acquireVsCodeApi 兼容层，vscode.js 于是
 *      把桌面版也判成 VS Code webview（__vscodeHost=true），而 zoom.js 正是用这个标志决定
 *      要不要装桌面版专属快捷键。
 *
 *  本场景把这三条钉住（另外把"末尾无换行/BOM 保留"一并钉住，它们和 B 是同一段逻辑）。
 *  判据全部落在**代码之外**：磁盘文件名与磁盘字节（PowerShell/node 读盘）、DOM 的
 *  activeElement、比例徽章的真实文本。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');

const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');

module.exports = {
  id: '77-daily-ops-regressions',
  title: '日用回归：新建/重命名输入框焦点、CRLF/BOM/末尾换行保真、桌面版缩放快捷键',
  async run(ctx) {
    const dir = path.join(ctx.outDir, '77-daily-ops');
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws, {recursive: true});
    const shot = async (session, name) => {
      try { await session.shot(name); ctx.witness('截图', {name: name + '.png'}); }
      catch (error) { ctx.witness('截图失败', {name, error: String(error && error.message)}); }
    };

    // ================= A / B：内联输入框焦点（新建 + 重命名） =================
    {
      const file = path.join(ws, 'a.md');
      fs.writeFileSync(file, ['# A', '', '第一段文字。', ''].join('\n'));
      const session = await ctx.launch({args: [file]});
      try {
        const ready = await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.textContent.includes('第一段文字')); })()`,
          {timeout: 120000, interval: 30});
        ctx.assert('工作区打开、正文上屏', ready, `ready=${ready}`);
        await harness.sleep(2000);

        // ---- B F2 重命名：同样要拿到焦点 ----
        const f2 = await session.js(`(() => {
          const row = [...document.querySelectorAll('#tree .row')].find(el => (el.dataset.path || '').endsWith('a.md'));
          if (!row) return {ok: false};
          const rect = row.getBoundingClientRect();
          return {ok: true, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
        })()`);
        if (f2.ok) {
          await session.move(f2.x, f2.y);
          await session.click(f2.x, f2.y);
          await harness.sleep(300);
          await session.key({key: 'F2', code: 'F2', vk: 113});
          await harness.sleep(700);
          const renameState = await session.js(`(() => {
            const input = document.querySelector('#tree input, #sidebar input');
            return {hasInput: !!input, focused: input ? document.activeElement === input : false, value: input ? input.value : null};
          })()`);
          ctx.witness('DOM：F2 重命名时的内联输入框状态', renameState);
          ctx.assert('【B】F2 重命名框同样自动获得焦点', renameState.hasInput && renameState.focused, renameState);
          if (renameState.hasInput && renameState.focused) {
            // F2 之后主名已被选中：直接打新名字（扩展名应自动保留）
            await session.key({key: 'E', code: 'KeyE', vk: 69, text: 'e'});
            await harness.sleep(300);
            await session.key({key: 'Enter', code: 'Enter', vk: 13, text: '\r'});
            await harness.sleep(2200);
            const after = fs.readdirSync(ws).sort();
            ctx.witness('磁盘：重命名之后的目录清单', {after});
            ctx.assert('【B】重命名之后磁盘上的文件名真的变了（改成了 e.md）', after.includes('e.md'), {after});
          }
        } else {
          ctx.witness('【B】没找到树的条目行，重命名小节跳过', f2);
        }
        // ---- A 新建 Markdown：点按钮后输入框必须已经拿到焦点 ----
        const button = await session.js(`(() => { const node = document.getElementById('btn-new-md');
          const rect = node.getBoundingClientRect();
          return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()`);
        await session.move(button.x, button.y);
        await session.click(button.x, button.y);
        await harness.sleep(900);
        const focusState = await session.js(`(() => {
          const input = document.querySelector('#tree input, #sidebar input');
          return {hasInput: !!input, focused: input ? document.activeElement === input : false,
            value: input ? input.value : null,
            selection: input ? [input.selectionStart, input.selectionEnd] : null,
            active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null};
        })()`);
        ctx.witness('DOM：点"新建 Markdown"之后的内联输入框状态', focusState);
        ctx.assert('【A】新建 Markdown 的内联输入框**自动获得焦点**（用户可以直接打字）',
          focusState.hasInput && focusState.focused, focusState);
        ctx.assert('【A】默认名只选中"未命名"（扩展名保留）',
          focusState.hasInput && focusState.selection && focusState.selection[0] === 0 && focusState.selection[1] < String(focusState.value).length,
          {value: focusState.value, selection: focusState.selection});

        // 真按键打字：用 harness 的 key()（rawKeyDown + char + keyUp，char 只发一次）。
        // 注意别自己拼 keyDown(text:...) + char —— 那样一个字符会被插入两次（实测得到
        // "我我的的笔记记"），断言就会误判成"没替换默认名"。
        for (const char of ['我', '的', '笔', '记']) {
          await session.key({key: char, code: 'KeyA', vk: 0, text: char});
          await harness.sleep(140);
        }
        const typed = await session.js(`(() => { const input = document.querySelector('#tree input, #sidebar input');
          return input ? {value: input.value} : null; })()`);
        ctx.witness('DOM：直接打字之后输入框里的名字', typed);
        ctx.assert('【A】直接打字会**替换**默认名，而不是接在后面（不是"未命名.md我的笔记.md"）',
          !!typed && !/^未命名\.md/.test(String(typed.value)) && String(typed.value).includes('我的笔记'),
          {value: typed && typed.value});
        await session.key({key: 'Enter', code: 'Enter', vk: 13, text: '\r'});
        await harness.sleep(2500);
        const files = fs.readdirSync(ws).sort();
        ctx.witness('磁盘：新建之后的目录清单', {files});
        ctx.assert('【A】回车之后磁盘上出现的是干净的文件名',
          files.includes('我的笔记.md') && !files.some(name => name.includes('未命名')),
          {files});

      } finally {
        await ctx.release(session);
      }
    }

    // ================= C/D/E：行尾与 BOM 保真 =================
    const fidelity = [
      {id: 'CRLF', name: 'crlf.md', body: ['# 标题甲', '', '正文一行乙。', ''].join('\r\n'),
        check: text => /\r\n/.test(text) && !/(?<!\r)\n/.test(text), describe: '全篇仍是 CRLF'},
      {id: 'CRLF-无尾换行', name: 'crlf-noeol.md', body: ['# 标题甲', '', '正文一行乙。'].join('\r\n'),
        check: text => /\r\n/.test(text) && !/\n$/.test(text), describe: 'CRLF 且末尾没有换行'},
      {id: 'LF-无尾换行', name: 'lf-noeol.md', body: ['# 标题甲', '', '正文一行乙。'].join('\n'),
        check: text => !/\r/.test(text) && !/\n$/.test(text), describe: 'LF 且末尾没有换行'},
      {id: 'BOM', name: 'bom.md', body: '\uFEFF' + ['# 标题甲', '', '正文一行乙。', ''].join('\n'),
        check: text => text.charCodeAt(0) === 0xFEFF, describe: '开头的 UTF-8 BOM 还在'},
    ];
    for (const item of fidelity) {
      const file = path.join(ws, item.name);
      fs.writeFileSync(file, item.body);
      const session = await ctx.launch({args: [file]});
      try {
        const ready = await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.textContent.includes('正文一行乙')); })()`,
          {timeout: 120000, interval: 30});
        await harness.sleep(1800);
        const point = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow, doc = w.document;
          const para = doc.querySelector(${SURFACE} + ' p');
          if (!para) return {ok: false};
          para.scrollIntoView({block: 'center', behavior: 'instant'});
          const rect = para.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(frameRect.x + rect.x + 30), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
        })()`);
        await session.move(point.x, point.y);
        await session.click(point.x, point.y);
        await harness.sleep(350);
        await session.key({key: 'End', code: 'End', vk: 35});
        await harness.sleep(200);
        await session.type('改');
        await harness.sleep(700);
        await session.chord('s', 'KeyS', 83);
        await harness.sleep(2600);
        const after = fs.readFileSync(file, 'utf8');
        const crlfCount = (after.match(/\r\n/g) || []).length;
        const loneLf = (after.match(/(?<!\r)\n/g) || []).length;
        ctx.witness('磁盘：' + item.id + ' 保存后的字节特征', {crlfCount, loneLf, endsWithNewline: /\n$/.test(after),
          bytes: after.length, head: JSON.stringify(after.slice(0, 30))});
        ctx.assert('【' + item.id + '】编辑一个字并保存后，' + item.describe + '，且改动确实落盘',
          ready && item.check(after) && after.includes('改'),
          {check: item.check(after), edited: after.includes('改'), crlfCount, loneLf});
      } finally {
        await ctx.release(session);
      }
    }

    // ================= F：桌面版缩放快捷键 =================
    {
      const file = path.join(ws, 'zoom.md');
      fs.writeFileSync(file, ['# 缩放', '', '第一段文字。', ''].join('\n'));
      const session = await ctx.launch({args: [file]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.textContent.includes('第一段文字')); })()`,
          {timeout: 120000, interval: 30});
        await harness.sleep(1800);
        const point = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const para = w.document.querySelector(${SURFACE} + ' p');
          para.scrollIntoView({block: 'center', behavior: 'instant'});
          const rect = para.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {x: Math.round(frameRect.x + rect.x + 30), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
        })()`);
        await session.move(point.x, point.y);
        await session.click(point.x, point.y);
        await harness.sleep(400);
        const ZOOM = `(() => { const w = document.getElementById('editor').contentWindow, doc = w.document;
          const badge = doc.querySelector('.typora-zoom-badge');
          const content = doc.querySelector('.vditor-content');
          return {badge: badge ? badge.textContent : null, inline: content ? content.style.zoom : null,
            value: w.vditor.getValue(), host: w.__vscodeHost}; })()`;
        const start = await session.js(ZOOM);
        ctx.witness('DOM：缩放起点（比例徽章 / 内联 zoom / __vscodeHost）', start);
        ctx.assert('桌面版没有被误判成 VS Code 宿主（__vscodeHost 必须为假，否则缩放快捷键不装）',
          start.host === false, {vscodeHost: start.host});
        await session.chord('=', 'Equal', 187);
        await harness.sleep(600);
        const zoomedIn = await session.js(ZOOM);
        await session.chord('=', 'Equal', 187);
        await harness.sleep(600);
        const zoomedIn2 = await session.js(ZOOM);
        await session.chord('-', 'Minus', 189);
        await harness.sleep(600);
        const zoomedOut = await session.js(ZOOM);
        await session.chord('0', 'Digit0', 48);
        await harness.sleep(600);
        const reset = await session.js(ZOOM);
        ctx.witness('DOM：缩放四种操作的读数', {start: start.badge, in1: zoomedIn.badge, in2: zoomedIn2.badge,
          out: zoomedOut.badge, reset: reset.badge, inlineAfterReset: reset.inline});
        const num = text => Number(String(text || '').replace('%', ''));
        ctx.assert('【F】Ctrl+= 放大（徽章数字变大）', num(zoomedIn.badge) > num(start.badge),
          {start: start.badge, after: zoomedIn.badge});
        ctx.assert('【F】再按一次 Ctrl+= 继续放大', num(zoomedIn2.badge) > num(zoomedIn.badge),
          {after1: zoomedIn.badge, after2: zoomedIn2.badge});
        ctx.assert('【F】Ctrl+- 缩小', num(zoomedOut.badge) < num(zoomedIn2.badge),
          {before: zoomedIn2.badge, after: zoomedOut.badge});
        ctx.assert('【F】Ctrl+0 回到 100%', num(reset.badge) === 100, {badge: reset.badge});
        ctx.assert('【F】缩放全程不改文档一个字节', reset.value === start.value, {});
        await shot(session, 'F-缩放');
      } finally {
        await ctx.release(session);
      }
    }

    // ================= G：引用式链接定义的标题（曾丢失；2.1.6 已修） =================
    {
      const file = path.join(ws, 'linkref.md');
      const original = ['# 链接文档', '', '正文里用 [带标题][doc] 引用。', '',
        '[doc]: https://example.com/doc "示例标题"', '', '结尾段。', ''].join('\n');
      fs.writeFileSync(file, original);
      const session = await ctx.launch({args: [file]});
      try {
        await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.textContent.includes('正文里用')); })()`,
          {timeout: 120000, interval: 30});
        await harness.sleep(1800);
        const opened = await session.js(`document.getElementById('editor').contentWindow.vditor.getValue()`);
        const point = await session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow;
          const para = [...w.document.querySelectorAll(${SURFACE} + ' p')].find(n => n.textContent.includes('正文里用'));
          para.scrollIntoView({block: 'center', behavior: 'instant'});
          const rect = para.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {x: Math.round(frameRect.x + rect.x + 30), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
        })()`);
        await session.move(point.x, point.y);
        await session.click(point.x, point.y);
        await harness.sleep(350);
        await session.key({key: 'End', code: 'End', vk: 35});
        await harness.sleep(200);
        await session.type('改');
        await harness.sleep(700);
        await session.chord('s', 'KeyS', 83);
        await harness.sleep(2500);
        const disk = fs.readFileSync(file, 'utf8');
        const titleAtOpen = opened.includes('示例标题');
        const titleOnDisk = disk.includes('示例标题');
        ctx.witness('引用式链接定义的标题：打开时（解析层）/ 保存后（磁盘）', {
          originalHasTitle: original.includes('示例标题'), titleAtOpen, titleOnDisk,
          diskDefLine: (disk.split('\n').find(line => line.startsWith('[doc]:')) || ''),
        });
        // 解析层（Vditor/Lute 的 Md→IR）仍会把 `"标题"` 丢掉，所以编辑区里看不到它——这是已知的
        // 呈现限制（本轮只保证**文件不被改坏**）。保存时必须把原文那一行还原回去。
        ctx.assert('【G】带标题的链接引用定义：改别处并保存后，磁盘上的定义行仍带标题（原文逐字节保留）',
          titleOnDisk && disk.includes('[doc]: https://example.com/doc "示例标题"'),
          {titleOnDisk, diskDefLine: (disk.split('\n').find(line => line.startsWith('[doc]:')) || '')});
        ctx.assert('【G】同一份文件里其它内容照常落盘', disk.includes('正文里用') && disk.includes('改'),
          {diskHead: disk.slice(0, 80)});
      } finally {
        await ctx.release(session);
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      try { fs.rmSync(ws, {recursive: true, force: true, maxRetries: 3, retryDelay: 200}); break; }
      catch { await harness.sleep(500); }
    }
  },
};
