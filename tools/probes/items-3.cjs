/** 验收集条目（§5 其它 · §6 附录 A 重载夹具） */
'use strict';
const U = require('./assets/uris.json');
const items = [];
const it = (o) => { items.push(o); return o; };

/* 30,000 字符的长段落（无行内标记，验证"长行护栏不影响无图行"） */
const LONG30K = ('长段落填充文字0123456789abcdefghij'.repeat(1200)).slice(0, 30000) + '【三万字符行末尾标记】';
/* 200,000+ 字符的超长单行（行尾挂一张小图，验证巨行里图片扫描不受护栏影响） */
const LONG200K = ('超长单行填充0123456789ABCDEFGHIJ'.repeat(10000)).slice(0, 199860) + '【二十万字符行末尾标记】 ![A3尾图](' + U.small + ')';

/* ════════════════ §5 其它 ════════════════ */
it({
  id: '5.1', title: '六级标题 `#` ~ `######`',
  expect: '六行标题按级别递减字号／字重；行首的 `#` 在阅读态**隐藏**（光标进入那一行才显源码）。',
  fixture: [
    '# 一级标题示例',
    '## 二级标题示例',
    '### 三级标题示例',
    '#### 四级标题示例',
    '##### 五级标题示例',
    '###### 六级标题示例',
  ],
  how: '光标停在第 1 行上时第 1 行会显 `#`（F7 契约）；把光标移开，六行都不该显示 `#`。',
  judge: '六行分别带 mp-h1..mp-h6 行类；阅读态行首无 `#`。',
  probe: { kind: 'headings', expect: { levels: [1, 2, 3, 4, 5, 6], texts: ['一级标题示例', '六级标题示例'] } },
});
it({
  id: '5.2', title: '无序 / 有序 / 嵌套列表',
  expect: '无序列表行首是圆点 `•`；有序列表行首是数字编号 `1.`；嵌套项按缩进层级向右排（缩进是两空格一档）。',
  fixture: [
    '- 一级无序项',
    '  - 二级无序项（缩进两格）',
    '    - 三级无序项（缩进四格）',
    '1. 一级有序项',
    '2. 第二个有序项',
    '   - 有序项里嵌无序项',
  ],
  how: '光标移开看：前三行行首应是圆点、缩进递增。',
  judge: '至少 4 个圆点 widget；嵌套行左缩进大于上一级；有序列表行首保留数字编号。',
  probe: { kind: 'bullets', expect: { minBullets: 4, indents: [0, 2, 4] } },
});
it({
  id: '5.3', title: '任务列表',
  expect: '`- [ ]` 显示成**未勾选方框**、`- [x]` 显示成**已勾选方框**；方框可直接点（点一下翻转源码里的 `[ ]`/`[x]`）。',
  fixture: [
    '- [ ] 未完成的任务',
    '- [x] 已完成的任务',
  ],
  how: '光标移开看两个方框的勾选状态；再点第一个方框，看它是否变成勾选（源码里 `[ ]` → `[x]`）。',
  judge: '两个复选框 widget；第 1 个未勾选、第 2 个已勾选。',
  probe: { kind: 'task', expect: { boxes: 2, checked: [false, true] } },
});
it({
  id: '5.4', title: '行内代码',
  expect: '反引号隐藏，代码文字变成**等宽字体 + 浅底色胶囊**。',
  fixture: ['行内代码对照：`inline code` 与 `x = 1` 都在句子里。'],
  how: '光标移开看：反引号不该显示，两段代码应有胶囊底色与等宽字形。',
  judge: '行内无字面反引号；至少 2 段文字带等宽字体 + 非透明底色。',
  probe: { kind: 'inlineCode', expect: { minSpans: 2, noBacktick: true } },
});
it({
  id: '5.5', title: '围栏代码块（带语言）',
  expect: '三反引号**围栏行被压扁隐藏**，代码内容整块带代码底色与等宽字体；`js` 语言有语法着色（关键字/字符串换色）。',
  fixture: [
    '```js',
    'function add(a, b) {',
    '  const s = "hello";',
    '  return a + b; // 注释',
    '}',
    '```',
  ],
  how: '光标移开看：应看到 5 行带底色的代码，围栏行几乎不可见（高度被压到 12px）。',
  judge: '代码行带 mp-code 行类；围栏行带 mp-fence 行类；行内出现多种颜色的 token。',
  probe: { kind: 'fence', expect: { codeLines: 5, fenceLines: 2, minColors: 2 } },
});
it({
  id: '5.6', title: '行内链接',
  expect: '只显示**链接文字**（主题主色），`[`、`](地址)` 被隐藏；光标移入该段时恢复源码。',
  fixture: ['行内链接：请见 [MarkPilot 官网](https://example.com/markpilot) 的说明。'],
  how: '光标移开看：行内不该出现 `](https://…`。',
  judge: '行内无 `](`；链接文字颜色为主题主色。',
  probe: { kind: 'inlineText', expect: { noLiteral: ['](', 'https://example.com'], includes: 'MarkPilot 官网' } },
});
it({
  id: '5.7', title: '自动链接（尖括号与裸 URL）',
  expect: '按 Typora 口径，`<https://example.com>` 与裸 `https://example.com` 都应变成链接（尖括号消失、URL 变链接色）。**本机实测见注记。**',
  fixture: [
    '尖括号自动链接：<https://example.com/auto> 后面还有字。',
    '裸地址自动链接：https://example.com/bare 后面还有字。',
  ],
  how: '光标移开看两行：尖括号还在吗？URL 是链接色吗？',
  judge: '两行的 URL 都带链接色；尖括号形态的 `<`、`>` 不显示。',
  probe: { kind: 'autolink', expect: { lines: 2 } },
});
it({
  id: '5.8', title: '粗体 / 斜体 / 粗斜体嵌套',
  expect: '`**粗体**` 变粗、`*斜体*` 变斜、`***粗斜体***` 又粗又斜、`__粗体__` 变粗、`**粗体里 *斜体* 缀**` 嵌套也不留星号。',
  fixture: ['强调对照：**粗体**、*斜体*、***粗斜体***、__下划线粗体__、以及 **粗体里 *斜体* 收尾**。'],
  how: '光标移开看：行内不该出现任何 `*` 或 `_`。',
  judge: '行内无字面星号/下划线；至少有 900 字重与斜体两种样式同时出现。',
  probe: { kind: 'emphasis', expect: { noStar: true, noUnderscore: true, minBold: 1, minItalic: 1 } },
});
it({
  id: '5.9', title: '删除线',
  expect: '`~~删除线~~` 的波浪号隐藏，文字带删除线。',
  fixture: ['删除线对照：这段 ~~不该再要了~~ 的文字应带中划线。'],
  how: '光标移开看：波浪号不该显示，文字应有中划线。',
  judge: '行内无 `~~`；存在 line-through 的文字。',
  probe: { kind: 'strike', expect: { noTilde: true, minStrike: 1 } },
});
it({
  id: '5.10', title: '水平线',
  expect: '整行 `---` 变成**一条通宽细横线**（源码那三个短横在阅读态不可见）。',
  fixture: ['水平线上面的正文。', '', '---', '', '水平线下面的正文。'],
  how: '光标移开看：应看到一条横线，而不是 `---` 三个字。',
  judge: '该行带 mp-hr 行类（文字透明 + 下边线）。',
  probe: { kind: 'hr', expect: { cls: 'mp-hr' } },
});
it({
  id: '5.11', title: 'HTML 注释',
  expect: '按 Typora 口径，`<!-- … -->` 注释应**不可见**（或至少以注释样式弱化）。**本机实测见注记。**',
  fixture: [
    '注释上面一行正文。',
    '<!-- 这一整行是 HTML 注释，按 Typora 口径不该显示 -->',
    '注释下面一行正文。',
  ],
  how: '光标移开看中间那行：它还显示成 `<!-- … -->` 字面文本吗？',
  judge: '中间那行不以字面 `<!--` 显示。',
  probe: { kind: 'comment', expect: { hidden: true } },
});
it({
  id: '5.12', title: '中文标点 / 全角空格 / 零宽字符对照',
  expect: '三行都按原字符显示：中文标点正常；**全角空格占一个汉字宽**；零宽字符**不占宽度但存在**（光标能落到它两侧、退格能删掉它）。',
  fixture: [
    '中文标点对照：“双引号”、‘单引号’、（括号）、——破折号、……省略号。',
    '全角空格对照：甲\u3000乙（甲乙之间是一个全角空格）。',
    '零宽对照：零\u200b宽\u200b字符（零/宽/字之间各有一个 U+200B）。',
  ],
  how: '1) 看第 2 行甲乙之间是否有明显空隙；2) 把光标点到「零」与「宽」之间，按一次退格，看是否只删掉一个零宽字符（看起来没变化但字数少 1）。',
  judge: '第 2 行全角空格实测占宽 ≥ 6px；第 3 行零宽字符实测占宽 ≤ 2px；三行文字都完整保留。',
  probe: { kind: 'chars', expect: {} },
});
it({
  id: '5.13', title: '单行 3 万字符的长段落',
  expect: '超长（>20,000 字符）的**纯文字**行仍按普通段落换行显示，末尾标记可见，编辑器不卡死。\n> 口径：这类巨行**不做行内标记投影**（`**粗体**`、`` `代码` `` 会保持字面），这是 3.0.3 记录的取舍（见 LOG-3.0.3 §4.1），不是缺陷。',
  fixture: [LONG30K],
  how: '下面这一行会占约 600 行的高度，滚过去即可；确认末尾的「三万字符行末尾标记」能看到、拖动滚动条不卡。',
  judge: '该行文字 ≥30,000 字符、末尾标记存在、行高 > 0。',
  probe: { kind: 'longline', expect: { minChars: 30000, tail: '【三万字符行末尾标记】' } },
});

/* ════════════════ §6 附录 A：重载夹具 ════════════════ */
it({
  id: 'A.1', title: '≥800KB 的 data URI 大图',
  expect: '下面这行显示成一张 **560×400** 的彩色噪声大图（四象限 + 斜纹）；打开这段时编辑器不该卡死（首屏 ≤ 1 秒级）。',
  fixture: ['![A1大图](' + U.big + ')'],
  how: '滚到这一行看：出图即通过。想量化可以把这一行复制到别处再等一秒看是否还卡。',
  judge: '真图且自然尺寸 560×400；行内不残留 base64 字面文本；该行行高是图片高度（不是几十万像素的巨块）。',
  probe: { kind: 'img', expect: { alt: 'A1大图', naturalW: 560, naturalH: 400, noLiteral: true, noDataLiteral: true, maxLineHeight: 2000 } },
});
it({
  id: 'A.2', title: '同一 data URI 引用 3 次',
  expect: '同一个大图地址在**连续三行**各引用一次：三张图都显示、尺寸一致（560×400），没有"只有第一张出图"。',
  fixture: [
    '第一张：![A2重复图一](' + U.big + ')',
    '第二张：![A2重复图二](' + U.big + ')',
    '第三张：![A2重复图三](' + U.big + ')',
  ],
  how: '滚到这三行看：三张图都应在。',
  judge: '三行各有一张 560×400 真图；三张的 src 指纹相同。',
  probe: { kind: 'imgMulti', expect: { count: 3, naturalW: 560, naturalH: 400 } },
});
it({
  id: 'A.3', title: '超长单行（≥20 万字符）+ 行尾小图',
  expect: '这一行有 20 万字符（约 3,000 行高）：末尾的**小图仍应正常渲染**（图片扫描不受长行护栏影响），编辑器不崩、滚动不卡死。',
  fixture: [LONG200K],
  how: '这是全文最后一行：直接 Ctrl+End 到底，确认末尾「【二十万字符行末尾标记】」右边有一张 96×64 小图。',
  judge: '该行 ≥200,000 字符；末尾存在 96×64 真图；行高 > 0。',
  probe: { kind: 'longline', expect: { minChars: 200000, tail: '【二十万字符行末尾标记】', img: { alt: 'A3尾图', naturalW: 96, naturalH: 64 } } },
});

module.exports = items;
