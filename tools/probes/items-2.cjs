/** 验收集条目（§3 表格 · §4 引用区） */
'use strict';
const U = require('./assets/uris.json');
const items = [];
const it = (o) => { items.push(o); return o; };

/* ════════════════ §3 表格 ════════════════ */
it({
  id: '3.1', title: '标准表（2 列 2 行）',
  expect: '表头带底纹、两行数据带边框；**列宽按内容比例**（首列窄、次列宽），文字不竖排。',
  fixture: [
    '| 名称 | 说明 |',
    '| --- | --- |',
    '| 甲 | 第一行说明文字 |',
    '| 乙 | 第二行说明文字 |',
  ],
  how: '光标移开看：4 行源码应变成一张表（表头 1 行 + 数据 2 行，分隔行被吸收）。',
  judge: '渲染出表格 widget；表头格文字为「名称／说明」；数据行文字齐全；不出现字面管道。',
  probe: { kind: 'table', expect: { minRows: 3, cols: 2, cellContains: [{ row: 0, col: 0, includes: '名称' }, { row: 1, col: 0, includes: '甲' }, { row: 2, col: 1, includes: '第二行' }] } },
});
it({
  id: '3.2', title: '分隔行用 ASCII 连字符 `-`',
  expect: '`| --- | --- |` 作为分隔行，表格正常成表。',
  fixture: [
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| A | 1 |',
  ],
  how: '光标移开看。',
  judge: '成表（3 行 widget），无字面管道行。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, cellContains: [{ row: 0, col: 0, includes: '列一' }, { row: 1, col: 0, includes: 'A' }] } },
});
it({
  id: '3.3', title: '分隔行用 en dash `–`（U+2013）',
  expect: '把分隔行写成 `| –– | –– |`（en dash）时，**同样成表**（3.0.5 起短横三种写法都认）。',
  fixture: [
    '| 列甲 | 列乙 |',
    '| –– | –– |',
    '| A2 | 2 |',
  ],
  how: '光标移开看：不应看到三行裸源码。',
  judge: '成表；无字面管道行；不出现 `––` 字面文本。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, cellContains: [{ row: 0, col: 0, includes: '列甲' }, { row: 1, col: 0, includes: 'A2' }] } },
});
it({
  id: '3.4', title: '分隔行用 em dash `—`（U+2014）',
  expect: '分隔行写成 `| —— | —— |`（中文破折号，用户原文的真实形态）时**同样成表**——这是 3.0.5 的用户报障根因。',
  fixture: [
    '| 名称 | 向后 | 向前 |',
    '| —— | —— | —— |',
    '| 有限状态 | 状态转移 | 观测更新 |',
  ],
  how: '光标移开看：这张表应当渲染出来，而不是四行裸源码。',
  judge: '成表（表头 + 1 数据行）；无字面 `|` 行；不出现 `——` 字面文本。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 3, cellContains: [{ row: 0, col: 0, includes: '名称' }, { row: 1, col: 0, includes: '有限状态' }] } },
});
it({
  id: '3.5', title: '参差行（源码格数少于表头）',
  expect: '表头 3 列、某行只写了 2 格时，这一行渲染出 **3 格**（第 3 格空白，按"幻影格"处理）；点第 3 格不会跳到别的格。',
  fixture: [
    '| 一 | 二 | 三 |',
    '| --- | --- | --- |',
    '| 1 | 2 | 3 |',
    '| 4 | 5 |',
  ],
  how: '光标移开看：最后一行应有 3 个格子，第 3 格空。再用鼠标点最后一行第 3 格，看编辑框里是不是空的（不该显示上一格的字）。',
  judge: '最后一行渲染 3 格且第 3 格标了 phantom（源码里没有这一格）。',
  probe: { kind: 'table', expect: { minRows: 3, cols: 3, phantomCol: { row: 2, col: 2 } } },
});
it({
  id: '3.6', title: '空格子',
  expect: '中间格留空时渲染成**空单元格**（边框仍在），不塌成两列。',
  fixture: [
    '| 甲 | 乙 | 丙 |',
    '| --- | --- | --- |',
    '| 1 |  | 3 |',
  ],
  how: '光标移开看：中间那格应是空的，但格子还在（3 列）。',
  judge: '第 2 行第 2 格文本为空，且列数仍为 3。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 3, cellEmpty: { row: 1, col: 1 } } },
});
it({
  id: '3.7', title: '格内 `\\|` 转义',
  expect: '`| 甲 \\| 乙 | 丙 |` 渲染成 **2 列**，第 1 格文字是 `甲 | 乙`（转义的管道属于内容，不切格）。',
  fixture: [
    '| 左 | 右 |',
    '| --- | --- |',
    '| 甲 \\| 乙 | 丙 |',
  ],
  how: '光标移开看：数据行应有 2 格，第 1 格里能看到一个竖线字符。',
  judge: '数据行列数为 2；第 1 格文本含 `|`；不出现 `\\|` 字面残留。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, cellContains: [{ row: 1, col: 0, includes: '|' }] } },
});
it({
  id: '3.8', title: '格内行内代码',
  expect: '按 Typora 口径，格内 `` `x=1` `` 应显示成等宽带底的代码（反引号不显示）。**本机实测：格内不投影行内标记**（见注记）。',
  fixture: [
    '| 写法 | 含义 |',
    '| --- | --- |',
    '| `x=1` | 赋值 |',
  ],
  how: '光标移开看第 1 格：是等宽代码，还是带反引号的字面文本？',
  judge: '第 1 格文字不含反引号（反引号被投影掉）。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, cellNoBacktick: { row: 1, col: 0 } } },
});
it({
  id: '3.9', title: '格内公式：转义美元 / 正常公式 / 未闭合美元',
  expect: '第 1 格 `\\$5` 显示字面 `$5`；第 2 格 `$a<b$` 渲染成数学体；第 3 格未闭合的 `$x` **原样显示**（不许把后面的内容一起吞掉）。',
  fixture: [
    '| 价格 | 不等式 | 未闭合 |',
    '| --- | --- | --- |',
    '| 价格 \\$5 | $a<b$ | 未闭合 $x |',
  ],
  how: '光标移开看这一行的三个格。',
  judge: '第 2 格有 KaTeX 渲染体；第 3 格文本里能看到字面 `$x`；三格文字都不丢。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 3, cellKatex: [{ row: 1, col: 1 }], cellContains: [{ row: 1, col: 2, includes: '$x' }] } },
});
it({
  id: '3.10', title: '引用区表格（单层 `>`）',
  expect: '`> | 甲 | 乙 |` 形态渲染成**表格**（不是四行裸源码）；表格左缘与引用文字左缘对齐，左侧有引用竖条。',
  fixture: [
    '> | 名称 | 数值 |',
    '> | --- | --- |',
    '> | 甲 | 1 |',
    '> | 乙 | 2 |',
  ],
  how: '光标移开看：四行源码应变成一张 2 列表；表左侧应有引用竖条。',
  judge: '成表（表头 + 2 数据行）；无字面管道行；表格带引用样式（mp-table-quote）。',
  probe: { kind: 'table', expect: { minRows: 3, cols: 2, quote: true, cellContains: [{ row: 1, col: 0, includes: '甲' }, { row: 2, col: 1, includes: '2' }] } },
});
it({
  id: '3.11', title: '引用区表格（嵌套 `>>`）',
  expect: '两层引用里的表格同样渲染成表，并比单层再多缩进一档；每行前缀必须**逐字相同**才算同一张表。',
  fixture: [
    '>> | 层 | 值 |',
    '>> | --- | --- |',
    '>> | 二 | 22 |',
  ],
  how: '光标移开看：应成表且整体比 3.10 更靠右。',
  judge: '成表（表头 + 1 数据行）；表带引用样式且层级为 2。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, quote: true, qDepth: 2, cellContains: [{ row: 1, col: 0, includes: '二' }] } },
});
it({
  id: '3.12', title: '紧贴正文、前后无空行',
  expect: '表格**上下都不留空行**时也照样成表；表格上面那行正文与下面那行正文各自独立，**不被吃进表格**。',
  fixture: [
    '表格上面紧贴的正文一行。',
    '| 紧贴甲 | 紧贴乙 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '表格下面紧贴的正文一行。',
  ],
  how: '光标移开看：中间 3 行成表；上下两行仍是普通正文（不是表格行）。',
  judge: '成表（表头 + 1 数据行）；上下的正文行以普通行渲染、文字完整。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, cellContains: [{ row: 0, col: 0, includes: '紧贴甲' }], neighbors: ['表格上面紧贴的正文一行。', '表格下面紧贴的正文一行。'] } },
});
it({
  id: '3.13', title: '10 列超宽表',
  expect: '10 列表格**不横向溢出**版心：每列都被压到能放下短内容，不出现"某一列宽到把别的列挤没"。',
  fixture: [
    '| 列01 | 列02 | 列03 | 列04 | 列05 | 列06 | 列07 | 列08 | 列09 | 列10 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| a1 | a2 | a3 | a4 | a5 | a6 | a7 | a8 | a9 | a10 |',
    '| b1 | b2 | b3 | b4 | b5 | b6 | b7 | b8 | b9 | b10 |',
  ],
  how: '光标移开看：10 列表头应齐全；表格右缘不超过正文列右缘。',
  judge: '成表且列数 10；表宽不超过正文列宽（不横向溢出）。',
  probe: { kind: 'table', expect: { minRows: 3, cols: 10, maxOverflow: 2, cellContains: [{ row: 2, col: 9, includes: 'b10' }] } },
});

it({
  id: '3.14', title: '非引用表格**不应**带引用区样式（左竖条 / 引用底色）',
  expect: '正文里的普通表格应只有**表格外观**（表头底纹 + 边框），左边**不该**出现引用区那条竖条，也不该有引用底色。判断方法：把这张表和 3.10 那张引用区表格对比——两张若长得一样（都带左竖条），就是本条不通过。',
  fixture: [
    '| 普通表甲 | 普通表乙 |',
    '| --- | --- |',
    '| 1 | 2 |',
  ],
  how: '光标移开看：这张表左边有没有一条竖线？',
  judge: '表格容器**不带** mp-table-quote 引用样式类，且 table 左侧没有引用竖条。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, notQuote: true, cellContains: [{ row: 1, col: 0, includes: '1' }] } },
});

/* ════════════════ §4 引用区 ════════════════ */
it({
  id: '4.1', title: '单层引用',
  expect: '`>` 记号隐藏，整行左侧有竖条 + 引用底色，文字比正文略小、略暗。',
  fixture: ['> 这是单层引用的一行文字。'],
  how: '光标移开看：行首不该出现 `>`。',
  judge: '该行有引用行样式（mp-quote）；行首无字面 `>`。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote', noGt: true, includes: '单层引用' } },
});
it({
  id: '4.2', title: '嵌套引用（两层）',
  expect: '两层引用比单层**再缩进一档**（`mp-quote-d2`），竖条仍是一条、底色连续。',
  fixture: ['>> 这是两层引用的文字。'],
  how: '光标移开，与 4.1 比缩进。',
  judge: '该行引用层级为 2；无字面 `>`。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote-d2', noGt: true, includes: '两层引用' } },
});
it({
  id: '4.3', title: '多级引用（三层）',
  expect: '三层引用缩进第三档（`mp-quote-d3`），字号更小。',
  fixture: ['>>> 这是三层引用的文字。'],
  how: '光标移开，与 4.2 比缩进。',
  judge: '引用层级为 3；无字面 `>`。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote-d3', noGt: true, includes: '三层引用' } },
});
it({
  id: '4.4', title: '引用里含列表',
  expect: '按 Typora 口径，引用里的 `- ` 应投影成圆点、保留列表形态。**本机实测：列表圆点只在行首识别**（见注记）。',
  fixture: [
    '> - 引用里的第一项',
    '> - 引用里的第二项',
  ],
  how: '光标移开看：行首是圆点，还是字面 `-`？',
  judge: '两行首都不显示字面 `-`（投影成圆点）。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote', bullet: true, noDash: true } },
});
it({
  id: '4.5', title: '引用里含代码块',
  expect: '按 Typora 口径，引用里的围栏代码块应显示成等宽 + 代码底色。**本机实测：围栏判定只在行首**（见注记）。',
  fixture: [
    '> ```',
    '> const inQuote = 1;',
    '> ```',
  ],
  how: '光标移开看中间那行：是等宽代码（带底色），还是普通引用文字？',
  judge: '引用内的代码行带代码样式（mp-code 或等宽字体）。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote', wantsCode: true } },
});
it({
  id: '4.6', title: '引用里含表格',
  expect: '引用里含一张两列表（与 3.10 同一形态，此处再验一次"引用块中间夹表格"的连续性）。',
  fixture: [
    '> 引用正文一行。',
    '>',
    '> | 甲 | 乙 |',
    '> | --- | --- |',
    '> | 1 | 2 |',
    '>',
    '> 引用又一行。',
  ],
  how: '光标移开看：表格出现，且上下引用行与表格左侧对齐。',
  judge: '成表（表头 + 1 数据行）+ 引用样式；上下引用文字行完整。',
  probe: { kind: 'table', expect: { minRows: 2, cols: 2, quote: true, cellContains: [{ row: 1, col: 0, includes: '1' }] } },
});
it({
  id: '4.7', title: '引用里含公式（行内 + 块级）',
  expect: '引用区里既有行内公式也有块级公式，两者都渲染；块级公式居中且竖条不断。',
  fixture: [
    '> 引用区行内：$a^2+b^2=c^2$；',
    '> 下面是块级：',
    '> $\\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}$',
  ],
  how: '光标移开看：应有 2 处公式（一处在文字里，一处在下一行居中）。',
  judge: '引用行内 KaTeX ≥1；块级公式体 ≥1；无字面 `$`。',
  probe: { kind: 'math', expect: { katex: 1, display: true, quote: true, noDollar: true } },
});
it({
  id: '4.8', title: '引用里含图片（多行引用中的一行）',
  expect: '多行引用的第 2 行里出 96×64 真图；引用竖条在这一行不断开。',
  fixture: [
    '> 引用第一行文字。',
    '> 引用第二行带图：![引用区图二](' + U.small + ')',
  ],
  how: '光标移开看第二行。',
  judge: '该行有引用样式 + 真图 96×64；无字面 `!`。',
  probe: { kind: 'img', expect: { alt: '引用区图二', naturalW: 96, quote: true, noLiteral: true } },
});
it({
  id: '4.9', title: '引用前后**紧贴**正文（无空行）',
  expect: '引用行上下都紧贴正文、没有空行时：三行各自独立渲染（正文 / 引用 / 正文），引用不"吃掉"上下正文。',
  fixture: [
    '紧贴引用上面一行正文。',
    '> 被正文紧贴的引用行。',
    '紧贴引用下面一行正文。',
  ],
  how: '光标移开看：三行应是"正文、引用、正文"三种不同外观。',
  judge: '中间行是引用行；上下两行是普通行且文字完整。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote', noGt: true, neighbors: ['紧贴引用上面一行正文。', '紧贴引用下面一行正文。'] } },
});
it({
  id: '4.10', title: '引用前后**留空行**',
  expect: '引用行上下各留一个空行时：引用与正文之间的间距应比 4.9 明显更大（空行仍然是空行）。',
  fixture: [
    '留空引用上面一行正文。',
    '',
    '> 上下各留一空行的引用行。',
    '',
    '留空引用下面一行正文。',
  ],
  how: '光标移开，和 4.9 对比上下间距。',
  judge: '中间行是引用行；上下正文行完整；引用行上下各有一个空行（高度 > 0）。',
  probe: { kind: 'quote', expect: { cls: 'mp-quote', noGt: true, blankAround: true, neighbors: ['留空引用上面一行正文。', '留空引用下面一行正文。'] } },
});

module.exports = items;
