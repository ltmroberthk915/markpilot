/** 源码形态保真回归（2026-09-13 那一轮"日用巡检"最后扫出来的一族缺陷，2.1.6 修好）。
 *
 *  这一族的共同根因：**IR 里表达不了的源码写法，在序列化时被悄悄吃掉**，于是"改一个字保存"
 *  就把文件改坏了——渲染结果跟着变（硬换行没了、代码块变正文、标题片段丢了）。逐条：
 *    A 行尾两个空格（Markdown 硬换行）→ 保存后被剥掉，本该换行的地方不换行了
 *    B 行尾反斜杠（另一种硬换行写法）→ 同样被剥掉
 *    C **4 空格缩进的代码块**（Markdown 最老的代码写法）→ 反向序列化吐不出缩进，代码块散成正文
 *    D 围栏**信息串**（`js {1,3-5}`、`python title="示例"`）→ 只剩语言，高亮范围/标题指令丢失
 *    E 引用式链接定义的**标题**（`[doc]: url "标题"`）→ 解析层就丢了，保存后永久丢失
 *    F 上面五条在 **CRLF 文件**上会**全部失效**（收集时按 \r\n 切行、比较时是 LF）——修复自身的缺口
 *  判据一律是**磁盘字节**（代码之外的通道）：改别处一个字并保存后，这些写法必须逐字节还在。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');

const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');
const ANCHOR = '锚点段落';

const editAndSave = async (ctx, session, file, shot) => {   // shot 为 null 时不截图
  const point = await session.js(`(() => {
    const frame = document.getElementById('editor');
    const w = frame.contentWindow, doc = w.document;
    const para = [...doc.querySelectorAll(${SURFACE} + ' p')].find(n => n.textContent.includes(${JSON.stringify(ANCHOR)}));
    if (!para) return {ok: false};
    para.scrollIntoView({block: 'center', behavior: 'instant'});
    const rect = para.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
    return {ok: true, x: Math.round(frameRect.x + rect.x + 30), y: Math.round(rect.y + frameRect.y + rect.height / 2)};
  })()`);
  if (!point.ok) return {ok: false};
  await session.move(point.x, point.y);
  await session.click(point.x, point.y);
  await harness.sleep(320);
  await session.key({key: 'End', code: 'End', vk: 35});
  await harness.sleep(200);
  await session.type('标');
  await harness.sleep(700);
  await session.chord('s', 'KeyS', 83);
  await harness.sleep(2600);
  const disk = fs.readFileSync(file, 'utf8');
  if (shot) await shot(session, shot);   // 见上
  return {ok: true, disk, edited: disk.includes(ANCHOR + '。标')};
};

module.exports = {
  id: '78-source-form-fidelity',
  title: '源码形态保真：硬换行两写法 / 缩进代码块 / 围栏信息串 / 引用式标题 / CRLF 组合',
  async run(ctx) {
    const dir = path.join(ctx.outDir, '78-source-form');
    fs.mkdirSync(dir, {recursive: true});
    const shot = async (session, name) => {
      try { await session.shot(name); ctx.witness('截图', {name: name + '.png'}); }
      catch (error) { ctx.witness('截图失败', {name, error: String(error && error.message)}); }
    };

    const CASES = [
      {id: 'A-行尾两空格硬换行', eol: 'lf', body: '硬换行这一行  \n下一行继续。',
        check: text => /硬换行这一行 {2}\n/.test(text), why: '两空格硬换行逐字节还在'},
      {id: 'B-行尾反斜杠硬换行', eol: 'lf', body: '反斜杠结尾这一行\\\n再下一行。',
        check: text => /反斜杠结尾这一行\\\n/.test(text), why: '反斜杠硬换行逐字节还在'},
      {id: 'C-缩进代码块', eol: 'lf', body: '    const indented = 1;\n    const second = 2;',
        check: text => /^ {4}const indented = 1;$/m.test(text) && /^ {4}const second = 2;$/m.test(text),
        why: '四空格缩进代码块的两行都还在（没有被拉平成正文）'},
      {id: 'D-围栏信息串', eol: 'lf', body: '```js {1,3-5}\nconst a = 1;\n```',
        check: text => /```js \{1,3-5\}/.test(text), why: '围栏后面的信息串 `{1,3-5}` 还在'},
      {id: 'E-引用式标题', eol: 'lf', body: '用 [带标题][doc] 引用。\n\n[doc]: https://example.com/doc "示例标题"',
        check: text => /\[doc\]: https:\/\/example\.com\/doc "示例标题"/.test(text), why: '引用式定义的标题还在'},
      {id: 'F-CRLF 组合（五项一起）', eol: 'crlf',
        body: ['硬换行这一行  ', '下一行继续。', '', '反斜杠结尾这一行\\', '再下一行。', '',
          '    const indented = 1;', '    const second = 2;', '', '```js {1,3-5}', 'const a = 1;', '```', '',
          '[doc]: https://example.com/doc "示例标题"'].join('\n'),
        check: text => /硬换行这一行 {2}\r\n/.test(text) && /反斜杠结尾这一行\\\r\n/.test(text) &&
          /^ {4}const indented = 1;\r?$/m.test(text) && /```js \{1,3-5\}/.test(text) &&
          /"示例标题"/.test(text) && /\r\n/.test(text),
        why: 'CRLF 文件上五项保真同时成立（含 CRLF 行尾本身）'},
    ];

    for (const item of CASES) {
      const file = path.join(dir, item.id.replace(/[^\w\u4e00-\u9fff-]+/g, '_') + '.md');
      const text = ['# 保真', '', ANCHOR + '。', '', item.body, '', '结束段。', ''].join('\n');
      fs.writeFileSync(file, item.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text);
      const original = fs.readFileSync(file, 'utf8');
      const session = await ctx.launch({args: [file]});
      try {
        const ready = await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
          const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.textContent.includes(${JSON.stringify(ANCHOR)})); })()`,
          {timeout: 120000, interval: 30});
        await harness.sleep(2000);
        // 打开时的渲染形态（比如缩进代码块应当渲染成 code-block）
        const dom = await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
          const root = w.document.querySelector(${SURFACE});
          return [...root.children].map(n => n.tagName + (n.getAttribute('data-type') ? '[' + n.getAttribute('data-type') + ']' : '')); })()`);
        const result = await editAndSave(ctx, session, file, null);
        ctx.witness('磁盘：' + item.id + '（编辑并保存后的字节）', {
          bytes: original.length, edited: !!result.edited, eol: item.eol,
          crlfCount: ((result.disk || '').match(/\r\n/g) || []).length,
          domBlocks: dom,
          snippet: JSON.stringify(String(result.disk || '').slice(0, 200)),
        });
        ctx.assert('【' + item.id + '】打开后文档正常就绪', ready, {ready, dom});
        ctx.assert('【' + item.id + '】改别处一个字并保存：编辑确实落盘', !!result.edited, {edited: !!result.edited});
        ctx.assert('【' + item.id + '】' + item.why, !!result.disk && item.check(result.disk),
          {snippet: JSON.stringify(String(result.disk || '').slice(0, 260))});
      } finally {
        await ctx.release(session);
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 3, retryDelay: 200}); break; }
      catch { await harness.sleep(500); }
    }
  },
};
