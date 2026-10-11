/** 族=control-chars · 剪贴板尺子体检（不启动产品，独立可跑）
 *
 *  目的：在用它量产品之前，先证明这把尺子**分辨得出**本族关心的载荷形态：
 *   ASCII / ESC+BEL / 内嵌 NUL / 多行 / 中文。四步里的①②（装弹 → 独立进程回读）在这里先自证；
 *   ③④（按键 → 再回读）由探针执行。
 *  内嵌 NUL 的期望值 = CF_UNICODETEXT 在首个 NUL 处截断后的前缀（平台事实，见 clipcheck 读数）。
 *
 *  用法：node control-chars-clipcheck.cjs
 */
'use strict';
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const CASES = [
  { name: 'ascii', text: 'MPCC-SENTINEL-ASCII-0123456789' },
  { name: 'esc-bel', text: 'MPCC-A\u001bB\u0007C-END' },
  { name: 'nul-mid', text: 'MPCC2-NUL[\u0000]-END', expect: 'MPCC2-NUL[' },
  { name: 'nul-lead', text: '\u0000MPCC2b-LEAD-END', expect: '' },
  { name: 'multiline-lf', text: 'line1\nline2\nline3' },
  { name: 'cjk', text: '中文·哨兵·单行' },
];

(async () => {
  const out = [];
  for (const c of CASES) {
    await L.sleep(250);
    const r = await L.clipArm(c.text, { expect: c.expect === undefined ? c.text : c.expect });
    const rec = {
      name: c.name,
      payloadCodes: L.codes(c.text),
      装弹尝试次数: r.tries,
      装弹成功: r.ok,
      回读字符码: r.backCodes,
      回读原文: JSON.stringify(r.back),
      抢占记录: r.attempts.filter((a) => !a.match).map((a) => ({ 第几次: a.i, 回读到: a.back })),
      截断在NUL: c.text.indexOf('\u0000') >= 0 && r.back !== null && r.back.length === c.text.indexOf('\u0000'),
    };
    out.push(rec);
    console.log(JSON.stringify(rec));
  }
  L.jsonDump(path.join(L.ROOT, 'clipcheck.json'), out);
  console.log('\n=== 体检结论 ===');
  console.log(JSON.stringify({
    用例: out.length, 装弹成功: out.filter((r) => r.装弹成功).length,
    失败: out.filter((r) => !r.装弹成功).map((r) => r.name),
    被抢占过的用例: out.filter((r) => r.抢占记录.length).map((r) => r.name + '(' + r.抢占记录.length + '次)'),
  }));
})();
