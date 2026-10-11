/** 验收素材：全部现场生成，不依赖受保护素材，也不依赖任何历史探针留下的文件。
 *  素材内容刻意包含"容易被忽略的真实情形"：中文全角标点收尾的段落、软换行落点、
 *  公式、表格、相对路径图片。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const project = path.resolve(__dirname, '..', '..');
const room = path.join(project, '.perf/acceptance/fixtures');

const crcTable = (() => { const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, checksum]);
};
const png = (width, height, rgb) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) { raw[row + 1 + x * 3] = rgb[0]; raw[row + 2 + x * 3] = rgb[1]; raw[row + 3 + x * 3] = rgb[2]; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

const write = (name, content) => {
  fs.mkdirSync(room, { recursive: true });
  const file = path.join(room, name);
  fs.writeFileSync(file, content);
  return file;
};

const paragraphs = (count, seed = 0) => Array.from({ length: count }, (_, index) => {
  const n = index + seed;
  // 长短交替 + 公式 + 全角标点收尾：既撑高度，又覆盖"行尾是全角括号"这类边界。
  const tail = n % 3 === 0 ? '（注）' : n % 3 === 1 ? '。）' : '。';
  return `第 ${n + 1} 段：这一段用来把文档撑到真实长度，包含中文与公式 $a_{${n}} + b_{${n}} = c_{${n}}$ 以及收尾标点${tail}`;
}).join('\n\n');

const IMAGE_FILES = [
  { name: 'shot-red.png', color: [220, 60, 60], size: [120, 80] },
  { name: 'shot-green.png', color: [60, 200, 110], size: [140, 90] },
  { name: 'shot-blue.png', color: [70, 110, 230], size: [160, 100] },
];

const images = () => {
  fs.mkdirSync(room, { recursive: true });
  const files = IMAGE_FILES.map(spec => {
    const file = path.join(room, spec.name);
    fs.writeFileSync(file, png(spec.size[0], spec.size[1], spec.color));
    return file;
  });
  const markdown = [
    '# 图片与表格验收',
    '',
    ...IMAGE_FILES.flatMap((spec, index) => [`![图 ${index + 1}](${spec.name})`, '']),
    '图片所在段落之后的正文：这一段用于判断插入位置与滚动位置。',
    '',
    '| 名称 | 数值 | 备注 |',
    '| --- | --- | --- |',
    '| 甲 | 1 | 测度变换 ∩ 概率论 |',
    '| 乙 | 2 | 指数密度 e^{iπ}+1=0 |',
    '',
    paragraphs(6),
    '',
  ].join('\n');
  return { markdown: write('images.md', markdown), images: files };
};

const small = () => write('small.md', [
  '# 小文档验收',
  '',
  '首段：小文件打开要用的最短真实素材。',
  '',
  paragraphs(12),
  '',
  '尾段：结束。',
  '',
].join('\n'));

/** 第二份小文档：热打开控制组要用"另一个文件"，因为对同一个路径调用打开是空操作。 */
const smallB = () => write('small-b.md', [
  '# 小文档验收（乙）',
  '',
  '首段：第二份小素材，用来测"开着一个小文档再打开另一个小文档"。',
  '',
  paragraphs(14, 700),
  '',
  '尾段：结束。',
  '',
].join('\n'));

const medium = () => write('medium.md', [
  '# 中等文档验收',
  '',
  paragraphs(320),
  '',
  '## 第二节',
  '',
  paragraphs(180, 500),
  '',
].join('\n'));

const large = () => write('large.md', [
  '# 大文档验收',
  '',
  paragraphs(900),
  '',
  '## 公式密集节',
  '',
  Array.from({ length: 500 }, (_, index) => `行 ${index + 1}：$\\int_{0}^{${index + 1}} x^2 \\, dx = \\frac{(${index + 1})^3}{3}$ 与 $e^{i\\pi}+1=0$`).join('\n\n'),
  '',
  paragraphs(600, 2000),
  '',
].join('\n'));

/** 文末公式节：大文档 + **公式块紧贴在文档末尾之前**。
 *
 *  为什么把公式放在末尾：要在两个应用里都落到"大文档中后位置"的同一点，唯一可靠的锚点是
 *  `Ctrl+End`——滚轮格数在两个应用里走的距离不同，"向下滚 N 格"会落到完全不同的地方。
 *  Ctrl+End 两边都落在文档最后一行的下方，而这里最后一行前面就是一大片行内公式，
 *  于是"中后位置 + 点击公式"在两边是同一个位置。
 *
 *  公式行刻意写长，让渲染出来的公式占据行的中右部——点击落点是正文区中部偏右，
 *  这样更容易点在公式上（真点到空白也没关系：见证器用像素变化幅度把"展开了公式"
 *  和"只移动了光标"分开，判据写在日志里）。
 */
const largeTailMath = () => write('large-tail-math.md', [
  '# 大文档文末公式节验收',
  '',
  paragraphs(1600),
  '',
  '## 公式密集节（文末）',
  '',
  Array.from({ length: 240 }, (_, index) => `行 ${index + 1}：$\\int_{0}^{${index + 1}} x^2 \\, dx = \\frac{(${index + 1})^3}{3}$ 与 $e^{i\\pi}+1=0$ 以及 $\\sum_{k=1}^{${index + 1}} \\frac{1}{k^2} = \\frac{\\pi^2}{6}$`).join('\n\n'),
  '',
  '末尾段：公式节之后只剩这一行。',
  '',
].join('\n'));

/** 软换行验收：段落以全角右括号收尾（用户实测的落点），后接一段用于判断行插在哪里。 */
const softBreak = () => write('soft-break.md', [
  '# 软换行验收',
  '',
  '前一段：把光标放到下一段的行尾。',
  '',
  '密度 = 测度间的导数"从直觉升格为定理，测度变换的全部技术都从它出发；终章 Heston 里 Girsanov 换测度时用的指数密度，就是它在路径空间上的直接后裔。）',
  '',
  '紧跟其后的段落：如果新行插错了地方，这一段会跟着变。',
  '',
  '最后一段：收尾。',
  '',
].join('\n'));

/** 阅读位置验收：图片 + 明显的锚点段落，锚点用唯一字符串标记。 */
const anchor = () => {
  // 自给自足：单独跑这一个场景时也要有图可显示（不依赖别的场景先创建）。
  fs.mkdirSync(room, { recursive: true });
  const image = path.join(room, 'shot-red.png');
  if (!fs.existsSync(image)) fs.writeFileSync(image, png(120, 80, [220, 60, 60]));
  return write('anchor.md', [
    '# 阅读位置验收',
    '',
    paragraphs(40),
    '',
    '![锚点图](shot-red.png)',
    '',
    paragraphs(40, 100),
    '',
    '锚点甲：这一段的开头就是还原判据，重开之后视口顶部必须还是它。',
    '',
    paragraphs(60, 300),
    '',
    '锚点乙：第二处锚点，用来验证深位置还原。',
    '',
    paragraphs(60, 400),
    '',
  ].join('\n'));
};

/** 表格内公式：用户点名的"在表格单元格里编辑/复制/增删公式"场景。
 *  单元格里是真行内公式（不是纯文本），两侧各留一段正文用于判断表格有没有被撑破。 */
const mathTable = () => write('math-table.md', [
  '# 表格内公式验收',
  '',
  '表格之前的正文：用来确认对单元格的编辑不会串到表格外面。',
  '',
  '| 项目 | 表达式 | 说明 |',
  '| --- | --- | --- |',
  '| 甲 | $x^2+1$ | 单元格里的行内公式 |',
  '| 乙 | $\\frac{a}{b}$ | 分数 |',
  '| 丙 | $e^{i\\pi}+1=0$ | 欧拉恒等式 |',
  '',
  '表格之后的正文：插入/删除行列之后这一段必须原地不动。',
  '',
  '| 单列表 |',
  '| --- |',
  '| $a_1$ |',
  '| $a_2$ |',
  '',
  '末尾段落：收尾。',
  '',
].join('\n'));

/** 公式边缘：行内公式处在行首/行尾/紧邻标点，块级公式，以及"相邻公式"这类
 *  容易让重解析失手的排布。全部内容都要求"不编辑就保存 = 磁盘字节不变"。 */
const denseMath = () => write('dense-math.md', [
  '# 公式边缘验收',
  '',
  '$x+1$ 出现在行首的公式。',
  '',
  '出现在行尾的公式是 $y=2$',
  '',
  '公式紧贴全角括号：$p$）以及 $q$。',
  '',
  '两个公式之间只有标点：$a$、$b$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\int_0^1 x \\, dx = \\frac{1}{2}',
  '$$',
  '',
  '块级公式之后的段落：用来确认块级公式没有吃掉后面的内容。',
  '',
  '表格里的公式：',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 一 | $\\alpha+\\beta$ |',
  '| 二 | $\\gamma$ |',
  '',
  '最后一段：收尾。',
  '',
].join('\n'));

/** 只有公式、没有表格：用来做"往返字节保真"的严格判据。
 *  （含表格的文档在保存时会被 Lute 按列宽重排表格——那是表格对齐行为，不是保真问题，
 *  所以保真这一条必须在没有表格的素材上量，另用 mathTable/denseMath 单独验表格语义。） */
const mathOnly = () => write('math-only.md', [
  '# 公式保真验收',
  '',
  '行首公式：$x+1$ 后面是文字。',
  '',
  '行尾公式：出现在行尾的公式是 $y=2$',
  '',
  '公式紧贴全角括号：$p$）以及 $q$。',
  '',
  '两个公式之间只有标点：$a$、$b$。',
  '',
  '块级公式：',
  '',
  '$$',
  '\\int_0^1 x \\, dx = \\frac{1}{2}',
  '$$',
  '',
  '块级公式之后的段落：用来确认块级公式没有吃掉后面的内容。',
  '',
  '末尾段落：收尾。',
  '',
].join('\n'));

module.exports = { room, images, small, smallB, medium, large, largeTailMath, softBreak, anchor, mathTable, denseMath, mathOnly, png, write, IMAGE_FILES };
