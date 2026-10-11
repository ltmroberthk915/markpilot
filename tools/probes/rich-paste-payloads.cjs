/** rich-paste 族夹具：两种来源的剪贴板载荷（HTML 口味 + 浏览器口径的 text/plain）
 *
 *  为什么两种都要有 plain：真实复制（Chrome / Word）**总是同时写 HTML 与纯文本两个口味**，
 *  产品要在这两者间做选择 —— 只喂 HTML 会得到一个不存在的世界。
 *
 *  · web_* ：按 Chromium `StyledMarkupSerializer` 的选择结果取语义标签形态（h2/p/b/a/ul/table），
 *            这是网页选区复制最常见的形态；text/plain 按 Chrome 的块语义给（块间空行、单元格间 TAB）。
 *  · word_*：按 Word「另存为网页」的真实形态 —— 段落带 `class=MsoNormal`，列表**不是** ul/li 而是
 *            `p.MsoListParagraph` + `mso-list:l0 level1 lfo1` + `<!--[if !supportLists]-->` 里的
 *            `mso-list:Ignore` 序号文本；表格是 `table.MsoTableGrid` + 单元格内 `p.MsoNormal`。
 *            Word 的 text/plain 里列表编号是 `1.\t第一项`（真实的制表符）。
 */
'use strict';

const H2 = '<h2>季度报告</h2>';
const P_RICH = '<p>这是<b>加粗</b>与<a href="https://example.com/x">示例链接</a>。</p>';
const UL = '<ul><li>项目一</li><li>项目二</li></ul>';
const TBL = '<table border="1"><tbody>'
  + '<tr><th>姓名</th><th>数量</th></tr>'
  + '<tr><td>甲</td><td>1</td></tr>'
  + '<tr><td>乙</td><td>2</td></tr>'
  + '</tbody></table>';

const WORD_P1 = '<p class=MsoNormal><b style=\'mso-bidi-font-weight:normal\'>加粗文字</b>'
  + '<span style=\'mso-spacerun:yes\'>&nbsp;</span>普通文字'
  + '<a href="https://example.com/y">示例链接</a></p>';
const wordLi = (n, text, cls) => '<p class=' + cls + ' style=\'margin-left:36.0pt;text-indent:-18.0pt;'
  + 'mso-list:l0 level1 lfo1\'><![if !supportLists]><span style=\'mso-list:Ignore\'>' + n
  + '.<span style=\'font:7.0pt "Times New Roman"\'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>'
  + text + '</p>';
const WORD_TD = (inner) => '<td width=120 valign=top style=\'width:90.0pt;border:solid windowtext 1.0pt;'
  + 'padding:0cm 5.4pt 0cm 5.4pt\'><p class=MsoNormal>' + inner + '</p></td>';
const WORD_TBL = '<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0 '
  + 'style=\'border-collapse:collapse;border:none\'>'
  + '<tr>' + WORD_TD('项目<span style=\'mso-spacerun:yes\'>&nbsp;</span>A') + WORD_TD('数值') + '</tr>'
  + '<tr>' + WORD_TD('甲') + WORD_TD('100') + '</tr>'
  + '</table>';

const PAYLOADS = {
  web_rich: {
    id: 'web_rich', src: '网页', note: 'h2 + 段落(加粗+链接) + 无序列表，无表格',
    frag: H2 + P_RICH + UL,
    text: '季度报告\n\n这是加粗与示例链接。\n\n项目一\n项目二',
    want: { bold: true, link: true, list: true, table: false, plainText: '季度报告\n\n这是加粗与示例链接。\n\n项目一\n项目二' },
  },
  web_table_only: {
    id: 'web_table_only', src: '网页', note: '只有一张表（3 行 × 2 列）',
    frag: TBL,
    text: '姓名\t数量\n甲\t1\n乙\t2',
    want: { bold: false, link: false, list: false, table: true },
  },
  web_para_table: {
    id: 'web_para_table', src: '网页', note: '表格前还有一句正文（看这句会不会被吞掉）',
    frag: '<p>下面是一张表：</p>' + TBL,
    text: '下面是一张表：\n\n姓名\t数量\n甲\t1\n乙\t2',
    want: { bold: false, link: false, list: false, table: true, leadParagraph: '下面是一张表：' },
  },
  web_all: {
    id: 'web_all', src: '网页', note: '四件套齐活：标题 + 加粗 + 链接 + 列表 + 表格',
    frag: H2 + P_RICH + UL + TBL,
    text: '季度报告\n\n这是加粗与示例链接。\n\n项目一\n项目二\n\n姓名\t数量\n甲\t1\n乙\t2',
    want: { bold: true, link: true, list: true, table: true },
  },
  web_inline: {
    id: 'web_inline', src: '网页', note: '单行行内格式：加粗 + 链接（没有块级结构，看行内标记会不会被转）',
    frag: '<span>结果：<b>加粗</b>，见<a href="https://example.com/z">说明</a>。</span>',
    text: '结果：加粗，见说明。',
    want: { bold: true, link: true, list: false, table: false },
  },
  word_text: {
    id: 'word_text', src: 'Word', note: 'MsoNormal 段落(加粗+链接) + mso-list 两级编号列表',
    frag: '<div class=WordSection1>' + WORD_P1
      + wordLi(1, '第一项', 'MsoListParagraphCxSpFirst')
      + wordLi(2, '第二项', 'MsoListParagraphCxSpLast')
      + '</div>',
    text: '加粗文字\u00a0普通文字示例链接\n1.\t第一项\n2.\t第二项',
    want: { bold: true, link: true, list: true, table: false },
  },
  word_table: {
    id: 'word_table', src: 'Word', note: 'table.MsoTableGrid，格内 p.MsoNormal',
    frag: WORD_TBL,
    text: '项目\u00a0A\t数值\n甲\t100',
    want: { bold: false, link: false, list: false, table: true },
  },
  word_mixed: {
    id: 'word_mixed', src: 'Word', note: 'Word 一整段真实复制：段落(粗体+链接) + mso 编号列表 + MsoTableGrid 表格',
    frag: '<div class=WordSection1>' + WORD_P1
      + wordLi(1, '第一项', 'MsoListParagraphCxSpFirst')
      + wordLi(2, '第二项', 'MsoListParagraphCxSpLast') + WORD_TBL + '</div>',
    text: '加粗文字\u00a0普通文字示例链接\n1.\t第一项\n2.\t第二项\n\n项目\u00a0A\t数值\n甲\t100',
    want: { bold: true, link: true, list: true, table: true },
  },
};

/* ── 文档夹具 ─────────────────────────────────────────────────────────────── */
const FIX_BODY = '前置段落。\n\n后置段落。\n';                       // 2 号行是空行 ⇒ 落点
const FIX_CODE = '正文段落。\n\n```js\nconst a = 1;\n```\n\n尾部段落。\n';  // 4 号行在围栏内

/* ── 判据（写成"用户能看见的性质"，不写"某个处理器被调用"）────────────────── */
/** 落在文档里的**文字内容**（不论有没有转成 Markdown 标记都必须还在的字眼）。
 *  用来把"标记没转"（结构保真度问题）与"文字整段没了"（内容丢失问题）分开 ——
 *  前者是体验，后者是数据。 */
const CONTENT_TOKENS = {
  web_rich: ['季度报告', '加粗', '示例链接', '项目一', '项目二'],
  web_table_only: ['姓名', '数量', '甲', '乙'],
  web_para_table: ['下面是一张表：', '姓名', '甲', '乙'],
  web_all: ['季度报告', '加粗', '示例链接', '项目一', '项目二', '姓名', '甲', '乙'],
  web_inline: ['结果：', '加粗', '说明'],
  word_text: ['加粗文字', '普通文字', '示例链接', '第一项', '第二项'],
  word_table: ['项目', 'A', '数值', '甲', '100'],
  word_mixed: ['加粗文字', '普通文字', '示例链接', '第一项', '第二项', '数值', '甲', '100'],
};
function contentCheck(docText, id) {
  const toks = CONTENT_TOKENS[id] || [];
  const missing = toks.filter((t) => docText.indexOf(t) < 0);
  return { 检查: toks.length, 丢失的文字: missing, 内容丢失: missing.length > 0 };
}

function judge(docText, srcPlain, want, insertedFrom, insertedTo) {
  const ins = typeof insertedFrom === 'number' ? docText.slice(insertedFrom, insertedTo) : docText;
  const bold = /\*\*[^*\n]+\*\*/.test(ins);
  const link = /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(ins);
  const list = /(^|\n)\s*(?:[-*+]\s+|\d+\.\s+)\S/.test(ins);
  const table = /(^|\n)\s*\|[^\n]*\|\s*(\n|$)/.test(ins) && /(^|\n)\s*\|[\s:|-]*-{2,}[\s:|-]*\|\s*(\n|$)/.test(ins);
  const out = { bold, link, list, table, verbatimPlain: ins.replace(/\s+$/, '') === String(srcPlain).replace(/\s+$/, ''), ins };
  if (want) {
    out.结构齐全 = ['bold', 'link', 'list', 'table'].every((k) => (!want[k]) || out[k]);
    out.该有的丢了 = ['bold', 'link', 'list', 'table'].filter((k) => want[k] && !out[k]);
  }
  return out;
}

module.exports = { PAYLOADS, FIX_BODY, FIX_CODE, judge, CONTENT_TOKENS, contentCheck };
