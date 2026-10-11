/** 保真预言机：**打开 → 改一个字 → 保存**，磁盘上除了那个字之外不许有任何变化。
 *
 *  为什么要有它（2026-09-17 定位）：所有"打开过我的文件之后它就被改了"的问题，此前都是靠
 *  手写探针逐个取证（probe-file-fidelity、场景 77/78…），新出现一种就成一次用户报告。
 *  这里改成一条**通用**判据，把这类问题的暴露从"用户报告"提前到"验收变红"。
 *
 *  期望值**从素材自身推导**，不硬编码（铁律 13）：原文件用什么行尾就还用那个行尾，原本末尾
 *  有没有换行就保持原样。所以期望字节 = 去掉末尾那一个行尾终结符 + 'Z' + 原本的终结符，
 *  逐字节比对。**行尾终结符要整段剥（`\r\n` 或 `\n`）**——只剥 `\n` 会留下孤立的 `\r`，
 *  第一版就是这么误判 CRLF 的。
 *
 *  两档：
 *   · **exact**：必须逐字节相等（绿）。
 *   · **declared**：已知的损失。不装作它不存在，也不让它把闸门永久弄红——判据是"损失仍是
 *     **声明过的那个形状**"（结构判据，取自实测证据）+ 一句"损失确实还在"。于是它被**修好**
 *     或被**改成别的形状**都会当场变红，提醒把这一档升级成 exact。
 *
 *  真实素材：受保护目录里的文档**只读复制**到 scratch（原素材一个字节不动）。它们的长度
 *  变化量进台账（容差 0），任何漂移都算退化。大文档里"把光标放到正文末尾"不能靠
 *  `selectNodeContents(surface).collapse(false)`——那个位置落不到真实文本节点上，第一版
 *  两份真实素材的 delta 都是 0，即触发根本没生效。所以改成**走 TreeWalker 找最后一个真实
 *  文本节点**，并且**先断言"字真的打进去了"**再去断言产品的行为，免得把"测试没触发"读成
 *  "产品没问题"。
 *
 *  用法（排查）：node scripts/acceptance/run.cjs --app=dev --only=106-fidelity-oracle
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('../harness.cjs');
const sleep = harness.sleep;
const project = harness.project;

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本';
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/** 期望字节：把 chunk 加在正文末尾——保留素材自己的行尾，也保留"末尾有没有换行"。 */
const withTyped = (bytes, chunk) => {
  const text = bytes.toString('utf8');
  const tail = /(\r\n|\n)$/.exec(text);
  const core = tail ? text.slice(0, -tail[1].length) : text;
  return Buffer.from(core + chunk + (tail ? tail[1] : ''), 'utf8');
};

const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};
const snippet = (buffer, at) => JSON.stringify(buffer.subarray(Math.max(0, at - 30), at + 30).toString('utf8'));

/** 光标落到**最后一个真实文本节点**的末尾（跳过预览与标记子树），再敲一个字符。 */
const TYPE_AT_END = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return {ok: false, why: '没有编辑面'};
  const walker = d.createTreeWalker(surface, NodeFilter.SHOW_TEXT, {acceptNode: node =>
    node.parentElement && node.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker,.katex')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  let last = null;
  while (walker.nextNode()) if (walker.currentNode.data.length) last = walker.currentNode;
  if (!last) return {ok: false, why: '找不到文本节点'};
  surface.focus();
  const range = d.createRange(); range.setStart(last, last.data.length); range.collapse(true);
  const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  return {ok: true, tail: last.data.slice(-12)}; })()`;

const TEXT_LEN = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  return surface ? surface.innerText.replace(/\\s+/g, '').length : -1; })()`;

const REAL_CASES = [
  {file: '排版测试-数理逻辑1(1).md', delta: -3, lossy: true,
    loss: '引用块里的**空行（`>` 无内容）被合并掉**——原文用它在引用块内分隔公式，实测 2 处'},
  {file: '富文本测试-重识概率论.md', delta: 1, lossy: false, loss: ''},
];

const LF = '第一段 $a$ 甲\n\n第二段 乙\n';
const CASES = [
  {name: 'lf', tier: 'exact', body: LF},
  {name: 'crlf', tier: 'exact', body: LF.replace(/\n/g, '\r\n')},
  {name: 'no-final-newline', tier: 'exact', body: '第一段 甲\n\n第二段 乙'},
  {name: 'utf8-bom', tier: 'exact', body: '\uFEFF' + LF},
  {name: 'hard-break-spaces', tier: 'exact', body: '第一行  \n第二行\n\n尾段\n'},
  {name: 'softbreak-then-text', tier: 'exact', body: '一段\n第二段（软换行）\n\n尾段\n'},
  {name: 'fence-info', tier: 'exact', body: '```js {1,3-5}\nvar x = 1;\n```\n\n尾段\n'},
  // ── 已知损失（2026-09-17 实测取证）────────────────────────────────────
  {name: 'inline-dollars', tier: 'declared', body: '前段\n\n甲$$a=b$$乙\n\n后段\n',
    loss: '行中 $$…$$ 被 Lute 建成块级公式，夹着它的正文被拆成独立段落（存盘结构被改写）',
    holds: text => /\n\$\$\na=b\n\$\$\n/.test(text)},
  {name: 'block-math-prose', tier: 'declared', body: '**整数解**\n\n$$\n(16,4),(15,6)\n$$所有移动的树\n\n后段\n',
    loss: '收尾 $$ 后面紧跟的正文被拆成独立段落（多出一个空行）',
    holds: text => text.includes('$$\n\n所有移动的树')},
  {name: 'indented-code', tier: 'declared', body: '前段\n\n    var x = 1;\n    第二行\n\n后段\n',
    loss: '缩进代码块**后面那个空行被吃掉**（代码块与下一段之间的空行消失）',
    holds: text => text.includes('    第二行\n后段')},
  {name: 'linkref-title', tier: 'declared', body: '[一]: https://example.com "标题"\n\n正文见 [一]。\n',
    // 【2.3.2 契约更新】旧的"已声明损失"是"定义行被移到文末"。2.3.2 实测：装机 2.3.1（不含本轮
    // 改动）与本轮 dev 读数**逐字相同**、各跑 3 次全一致 —— 定义行现在**原地不动**了，代价换成了
    // "定义行与正文之间的空行被吃掉"。损失更小，但仍是保真偏差，所以门继续钉住它：定义行必须在
    // 原位、标题必须保住、那条空行必须是被吃掉的那个形状。
    loss: '引用式定义行**原地不动**（不再被移到文末），代价是定义行与正文之间的空行被吃掉（标题本身**保住了**，靠 doc.js 的 restoreLinkRefTitles）',
    holds: text => /^\[一\]:/.test(text) && text.includes('"标题"') && !/\n[ \t]*\n/.test(text)},
  {name: 'table-escaped-pipe', tier: 'declared', body: '| 甲 | 乙 |\n|---|---|\n| a\\|b | c |\n',
    loss: '表格分隔行的横线被补齐对齐（转义的竖线本身**保住了**，语义等价、字节变了）',
    holds: text => text.includes('a\\|b') && /\|\s-{2,}\s/.test(text)},
];

module.exports = {
  id: '106-fidelity-oracle',
  title: '保真预言机：改一个字之外，磁盘不许有任何变化',
  async run(ctx) {
    const dir = path.join(project, '.perf/repro-fidelity');
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    fs.mkdirSync(dir, {recursive: true});

    const plan = [];
    for (const item of CASES) {
      const file = path.join(dir, item.name + '.md');
      const bytes = Buffer.from(item.body, 'utf8');
      fs.writeFileSync(file, bytes);
      plan.push({...item, file, bytes});
    }
    // 真实素材：声明值取自**实测**（git diff --no-index 逐行核对过），不是估的。
    // 排版测试那份的唯一差异是"引用块里的空行 `>` 被合并掉"（2 处，-3 字节）——2026-09-17 由本
    // 预言机首次抓到的真实缺陷；`富文本测试` 那份往返零损失，所以 delta 就是那一个字。
    for (const real of REAL_CASES) {
      const source = path.join(MATERIAL, real.file);
      if (!fs.existsSync(source)) continue;
      const file = path.join(dir, 'real-' + real.file);
      fs.copyFileSync(source, file);
      // copyFileSync 连**只读属性**一起复制（素材原件是 -r--r--r--），副本会存不进去——
      // 第一版两份真实素材的 delta 都是 0 就是这个原因，读起来却像"产品没保真"。
      fs.chmodSync(file, 0o666);
      plan.push({...real, tier: 'real', name: 'real-' + real.file, file, bytes: fs.readFileSync(file), source});
    }
    ctx.witness('素材清单与原始哈希（测试进程独立写出/复制，原素材只读）',
      plan.map(item => ({name: item.name, tier: item.tier, bytes: item.bytes.length, sha256: sha256(item.bytes),
        source: item.source ? path.basename(item.source) : '生成'})));

    const session = await ctx.launch({inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
      await sleep(1800);

      for (const item of plan) {
        const before = item.bytes;
        const slow = item.tier === 'real';
        await session.main.clearCalls();
        await session.main.script([{dialog: 'open', files: [item.file]}]);
        await session.main.clickMenu('文件 > 在此窗口打开文件…');
        await sleep(slow ? 4500 : 2600);

        const landed = await session.js(TYPE_AT_END);
        await sleep(350);
        const lenBefore = await session.js(TEXT_LEN);
        await session.type('Z');
        await sleep(500);
        const lenAfter = await session.js(TEXT_LEN);
        // 判"字真的打进去了"要看**长度差恰好为 1**，不能看 innerText 的结尾：真实文档末尾是公式，
        // KaTeX 渲染出来的文字排在 innerText 最后；而 linkref 用例的插入点后面还有链接定义行——
        // 这两种情形下 endsWith('Z') 都会把成功的触发读成失败（实测各误判一次）。
        const triggered = Number.isFinite(lenBefore) && lenAfter === lenBefore + 1;
        await sleep(slow ? 5200 : 3600);            // 自动保存 1.5 秒去抖，等足两个周期
        const after = fs.readFileSync(item.file);

        // 先证明"字真的打进去了"——否则后面的读数全是空的
        ctx.assert(`${item.name}：测试触发成功（字真的打进了编辑区）`, triggered,
          JSON.stringify({caret: landed, lenBefore, lenAfter}));
        if (!triggered) continue;

        const expected = withTyped(before, 'Z');
        const at = firstDiff(after, expected);

        if (item.tier === 'exact') {
          ctx.witness(`${item.name}：改一字后的磁盘字节`, {before: before.length, after: after.length,
            expected: expected.length, same: at < 0, firstDiffAt: at, sha256: sha256(after),
            afterSnippet: at < 0 ? null : snippet(after, at), expectedSnippet: at < 0 ? null : snippet(expected, at)});
          ctx.assert(`${item.name}：改一个字之后，磁盘上除了那个字之外逐字节未变（tier=exact）`, at < 0,
            JSON.stringify({firstDiffAt: at, afterBytes: after.length, expectedBytes: expected.length,
              after: at < 0 ? null : snippet(after, at), expected: at < 0 ? null : snippet(expected, at)}));
        } else if (item.tier === 'declared') {
          const text = after.toString('utf8');
          ctx.witness(`${item.name}：已知损失的实测形状`, {loss: item.loss, bytes: after.length,
            expectedBytes: expected.length, holds: item.holds(text), stillLossy: at >= 0,
            sha256: sha256(after), text: text.slice(0, 200)});
          ctx.assert(`${item.name}：已知损失「${item.loss}」仍是声明过的形状`, item.holds(text),
            JSON.stringify({loss: item.loss, holds: item.holds(text), text: text.slice(0, 200)}));
          ctx.assert(`${item.name}：这条损失**确实还在**（若哪天被修好，请把它升级成 tier=exact）`,
            at >= 0, JSON.stringify({bytes: after.length, expectedBytes: expected.length}));
        } else {
          const delta = after.length - before.length;
          const expectedDelta = expected.length - before.length;
          const text = after.toString('utf8');
          ctx.witness(`${item.name}：真实素材改一字后的变化`,
            {before: before.length, after: after.length, delta, expectedDelta, loss: item.loss,
              lossy: delta !== expectedDelta, replacements: (text.match(/\uFFFD/g) || []).length,
              sha256: sha256(after), source: path.basename(item.source)});
          ctx.metric(`fidelity.${item.name}.deltaBytes`, delta, {unit: 'B', direction: 'equal', tolerance: 0});
          ctx.assert(`${item.name}：长度变化仍是声明过的 ${item.delta} 字节（改一字${item.delta === expectedDelta ? '' : ' 加上已知损失 ' + (item.delta - expectedDelta) + ' 字节'}）`,
            delta === item.delta,
            JSON.stringify({before: before.length, after: after.length, delta, declared: item.delta, expectedDelta}));
          if (item.lossy) {
            ctx.assert(`${item.name}：已知损失「${item.loss}」**确实还在**（若哪天被修好，请把声明值改成 ${expectedDelta}）`,
              delta !== expectedDelta, JSON.stringify({delta, expectedDelta, loss: item.loss}));
          } else {
            ctx.assert(`${item.name}：这条素材往返零损失，长度变化必须正好是那一个字`,
              delta === expectedDelta, JSON.stringify({delta, expectedDelta}));
          }
          ctx.assert(`${item.name}：真实素材里没有被写进替换字符（U+FFFD）`,
            !/\uFFFD/.test(text), JSON.stringify({replacements: (text.match(/\uFFFD/g) || []).length}));
        }
      }
    } finally {
      await ctx.release(session);
      await sleep(300);
    }
  },
};
