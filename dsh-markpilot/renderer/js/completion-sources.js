const snippets = [
  ['table','表格','| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n'],
  ['code','代码块','```text\n\n```\n'],
  ['python','Python 代码块','```python\n\n```\n'],
  ['javascript','JavaScript 代码块','```javascript\n\n```\n'],
  ['mermaid','Mermaid 流程图','```mermaid\nflowchart LR\n    A[开始] --> B[结束]\n```\n'],
  ['math','公式块','$$\n\n$$\n'],
  ['quote','引用','> 引用内容\n'],
  ['task','任务列表','- [ ] 待办事项\n'],
  ['frontmatter','文档元信息','---\ntitle: 标题\n---\n'],
  ['details','折叠内容','<details>\n<summary>标题</summary>\n\n内容\n\n</details>\n'],
];

// 命令分组：只用于"同类补全"的提示与排序（见 localCandidates）。
// 用户 2026-09-14 第 8 轮：「插入补全 \mathbb，它会自动给我提示出其他的 \mathscr \mathbf
// 之类的同是表示字体语法」——同族兄弟要一起给出来，而不是只给键名精确匹配的那一条。
const FONT = '字体';
const TEXT = '文字';
const BIGOP = '大运算符';
const GREEK = '希腊字母';
const REL = '关系符';
const ARROW = '箭头';
const DELIM = '括号与省略号';
const ACCENT = '重音与上下括号';
const SPACE = '间距';
const FRAC = '分式与根式';
const ENV = '矩阵与环境';
const LOGIC = '集合与逻辑';
const FUNC = '函数名';
const CALC = '微积分符号';

/** 公式命令表：`[键, 说明, 插入文本, 分组]`。 */
const commands = [
  // FRAC
  ['frac','分式','\\frac{}{}',FRAC],
  ['sqrt','根号','\\sqrt{}',FRAC],
  // BIGOP
  ['sum','求和','\\sum_{}^{}',BIGOP],
  ['int','积分','\\int_{}^{}',BIGOP],
  ['lim','极限','\\lim_{}',BIGOP],
  // CALC
  ['partial','偏导','\\partial',CALC],
  ['nabla','梯度','\\nabla',CALC],
  ['infty','无穷','\\infty',CALC],
  // GREEK
  ['alpha','α','\\alpha',GREEK],
  ['beta','β','\\beta',GREEK],
  ['gamma','γ','\\gamma',GREEK],
  ['delta','δ','\\delta',GREEK],
  ['epsilon','ε','\\epsilon',GREEK],
  ['theta','θ','\\theta',GREEK],
  ['lambda','λ','\\lambda',GREEK],
  ['mu','μ','\\mu',GREEK],
  ['pi','π','\\pi',GREEK],
  ['sigma','σ','\\sigma',GREEK],
  ['omega','ω','\\omega',GREEK],
  ['Omega','Ω','\\Omega',GREEK],
  ['Delta','Δ','\\Delta',GREEK],
  ['Gamma','Γ','\\Gamma',GREEK],
  // FONT
  ['mathbb','黑板粗体（ℝ）','\\mathbb{}',FONT],
  ['mathbf','数学粗体','\\mathbf{}',FONT],
  ['mathcal','花体','\\mathcal{}',FONT],
  ['mathrm','正体','\\mathrm{}',FONT],
  ['text','公式内文字','\\text{}',TEXT],
  // ENV
  ['begin','对齐环境','\\begin{aligned}\n  a &= b \\\\\n  c &= d\n\\end{aligned}',ENV],
  ['pmatrix','圆括号矩阵','\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}',ENV],
  ['bmatrix','方括号矩阵','\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}',ENV],
  ['cases','分段函数','\\begin{cases}a & x>0 \\\\ b & x\\le 0\\end{cases}',ENV],
  // ACCENT
  ['underbrace','下括号','\\underbrace{}_{说明}',ACCENT],
  ['overbrace','上括号','\\overbrace{}^{说明}',ACCENT],
  // DELIM
  ['left','可伸缩括号','\\left( \\right)',DELIM],
  // CALC
  ['times','乘号','\\times',CALC],
  ['cdot','点乘','\\cdot',CALC],
  // REL
  ['leq','小于等于','\\leq',REL],
  ['geq','大于等于','\\geq',REL],
  ['neq','不等于','\\neq',REL],
  // FONT
  ['mathscr','手写体','\\mathscr{}',FONT],
  ['mathfrak','哥特体','\\mathfrak{}',FONT],
  ['mathsf','无衬线','\\mathsf{}',FONT],
  ['mathtt','等宽','\\mathtt{}',FONT],
  ['mathit','斜体','\\mathit{}',FONT],
  ['boldsymbol','粗斜体（希腊字母也能加粗）','\\boldsymbol{}',FONT],
  ['mathnormal','默认数学体','\\mathnormal{}',FONT],
  ['operatorname','函数名（正体）','\\operatorname{}',FONT],
  // BIGOP
  ['prod','连乘','\\prod_{}^{}',BIGOP],
  ['coprod','余积','\\coprod_{}^{}',BIGOP],
  ['iint','二重积分','\\iint',BIGOP],
  ['iiint','三重积分','\\iiint',BIGOP],
  ['oint','环路积分','\\oint',BIGOP],
  ['max','最大值','\\max',BIGOP],
  ['min','最小值','\\min',BIGOP],
  ['sup','上确界','\\sup',BIGOP],
  ['inf','下确界','\\inf',BIGOP],
  ['limsup','上极限','\\limsup_{}',BIGOP],
  ['liminf','下极限','\\liminf_{}',BIGOP],
  ['bigcup','大并集','\\bigcup_{}^{}',BIGOP],
  ['bigcap','大交集','\\bigcap_{}^{}',BIGOP],
  ['bigoplus','直和','\\bigoplus_{}^{}',BIGOP],
  ['bigotimes','张量积','\\bigotimes_{}^{}',BIGOP],
  // GREEK
  ['varepsilon','ε（变体）','\\varepsilon',GREEK],
  ['zeta','ζ','\\zeta',GREEK],
  ['eta','η','\\eta',GREEK],
  ['vartheta','θ（变体）','\\vartheta',GREEK],
  ['iota','ι','\\iota',GREEK],
  ['kappa','κ','\\kappa',GREEK],
  ['nu','ν','\\nu',GREEK],
  ['xi','ξ','\\xi',GREEK],
  ['rho','ρ','\\rho',GREEK],
  ['tau','τ','\\tau',GREEK],
  ['upsilon','υ','\\upsilon',GREEK],
  ['phi','φ','\\phi',GREEK],
  ['varphi','φ（变体）','\\varphi',GREEK],
  ['chi','χ','\\chi',GREEK],
  ['psi','ψ','\\psi',GREEK],
  ['Theta','Θ','\\Theta',GREEK],
  ['Lambda','Λ','\\Lambda',GREEK],
  ['Xi','Ξ','\\Xi',GREEK],
  ['Pi','Π','\\Pi',GREEK],
  ['Sigma','Σ','\\Sigma',GREEK],
  ['Phi','Φ','\\Phi',GREEK],
  ['Psi','Ψ','\\Psi',GREEK],
  // REL
  ['approx','约等于','\\approx',REL],
  ['equiv','恒等/同余','\\equiv',REL],
  ['sim','相似/服从分布','\\sim',REL],
  ['simeq','渐近等于','\\simeq',REL],
  ['cong','全等','\\cong',REL],
  ['propto','正比于','\\propto',REL],
  ['ll','远小于','\\ll',REL],
  ['gg','远大于','\\gg',REL],
  ['prec','先于','\\prec',REL],
  ['succ','后于','\\succ',REL],
  ['subset','真子集','\\subset',REL],
  ['supset','真超集','\\supset',REL],
  ['subseteq','子集','\\subseteq',REL],
  ['supseteq','超集','\\supseteq',REL],
  ['in','属于','\\in',REL],
  ['notin','不属于','\\notin',REL],
  ['ni','包含','\\ni',REL],
  ['mid','整除/条件竖线','\\mid',REL],
  ['parallel','平行','\\parallel',REL],
  ['perp','垂直','\\perp',REL],
  // ARROW
  ['to','趋于','\\to',ARROW],
  ['rightarrow','右箭头','\\rightarrow',ARROW],
  ['leftarrow','左箭头','\\leftarrow',ARROW],
  ['leftrightarrow','双向箭头','\\leftrightarrow',ARROW],
  ['Rightarrow','推出','\\Rightarrow',ARROW],
  ['Leftarrow','反向推出','\\Leftarrow',ARROW],
  ['Leftrightarrow','等价','\\Leftrightarrow',ARROW],
  ['implies','蕴含','\\implies',ARROW],
  ['iff','当且仅当','\\iff',ARROW],
  ['uparrow','上箭头','\\uparrow',ARROW],
  ['downarrow','下箭头','\\downarrow',ARROW],
  ['mapsto','映射到','\\mapsto',ARROW],
  ['longrightarrow','长右箭头','\\longrightarrow',ARROW],
  ['hookrightarrow','嵌入','\\hookrightarrow',ARROW],
  ['twoheadrightarrow','满射','\\twoheadrightarrow',ARROW],
  // DELIM
  ['right','可伸缩右括号','\\right)',DELIM],
  ['bigl','大左括号','\\bigl(',DELIM],
  ['bigr','大右括号','\\bigr)',DELIM],
  ['Bigl','更大左括号','\\Bigl(',DELIM],
  ['Bigr','更大右括号','\\Bigr)',DELIM],
  ['biggl','极大左括号','\\biggl(',DELIM],
  ['biggr','极大右括号','\\biggr)',DELIM],
  ['langle','左尖括号','\\langle',DELIM],
  ['rangle','右尖括号','\\rangle',DELIM],
  ['lceil','上取整左','\\lceil',DELIM],
  ['rceil','上取整右','\\rceil',DELIM],
  ['lfloor','下取整左','\\lfloor',DELIM],
  ['rfloor','下取整右','\\rfloor',DELIM],
  ['lvert','绝对值左','\\lvert',DELIM],
  ['rvert','绝对值右','\\rvert',DELIM],
  ['lVert','范数左','\\lVert',DELIM],
  ['rVert','范数右','\\rVert',DELIM],
  ['lbrace','左大括号','\\lbrace',DELIM],
  ['rbrace','右大括号','\\rbrace',DELIM],
  ['dots','省略号','\\dots',DELIM],
  ['cdots','居中省略号','\\cdots',DELIM],
  ['ldots','底线省略号','\\ldots',DELIM],
  ['vdots','竖省略号','\\vdots',DELIM],
  ['ddots','斜省略号','\\ddots',DELIM],
  // ACCENT
  ['hat','帽子','\\hat{}',ACCENT],
  ['widehat','宽帽子','\\widehat{}',ACCENT],
  ['bar','上横线','\\bar{}',ACCENT],
  ['vec','向量箭头','\\vec{}',ACCENT],
  ['dot','单点','\\dot{}',ACCENT],
  ['ddot','双点','\\ddot{}',ACCENT],
  ['tilde','波浪线','\\tilde{}',ACCENT],
  ['widetilde','宽波浪线','\\widetilde{}',ACCENT],
  ['overline','上划线（共轭）','\\overline{}',ACCENT],
  ['underline','下划线','\\underline{}',ACCENT],
  ['overrightarrow','上箭头','\\overrightarrow{}',ACCENT],
  ['overleftarrow','上左箭头','\\overleftarrow{}',ACCENT],
  ['mathring','圆环','\\mathring{}',ACCENT],
  ['check','倒帽子','\\check{}',ACCENT],
  // SPACE
  ['quad','一个中空','\\quad',SPACE],
  ['qquad','两个中空','\\qquad',SPACE],
  [' ','小空格','\\ ',SPACE],
  [',','极细空格','\\,',SPACE],
  [';','较宽空格','\\;',SPACE],
  ['!','负空格','\\!',SPACE],
  // FRAC
  ['dfrac','大号分式','\\dfrac{}{}',FRAC],
  ['tfrac','小号分式','\\tfrac{}{}',FRAC],
  ['cfrac','连分数','\\cfrac{}{}',FRAC],
  // ENV
  ['end','结束环境','\\end{aligned}',ENV],
  ['vmatrix','行列式','\\begin{vmatrix}a & b \\\\ c & d\\end{vmatrix}',ENV],
  ['Vmatrix','范数矩阵','\\begin{Vmatrix}a & b \\\\ c & d\\end{Vmatrix}',ENV],
  ['array','数组','\\begin{array}{cc}a & b \\\\ c & d\\end{array}',ENV],
  ['aligned','多行对齐','\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',ENV],
  ['gathered','多行居中','\\begin{gathered}a = b \\\\ c = d\\end{gathered}',ENV],
  // LOGIC
  ['forall','任意','\\forall',LOGIC],
  ['exists','存在','\\exists',LOGIC],
  ['nexists','不存在','\\nexists',LOGIC],
  ['neg','非','\\neg',LOGIC],
  ['land','且','\\land',LOGIC],
  ['lor','或','\\lor',LOGIC],
  ['emptyset','空集','\\emptyset',LOGIC],
  ['varnothing','空集（变体）','\\varnothing',LOGIC],
  ['cup','并集','\\cup',LOGIC],
  ['cap','交集','\\cap',LOGIC],
  ['setminus','差集','\\setminus',LOGIC],
  ['complement','补集','\\complement',LOGIC],
  ['therefore','所以','\\therefore',LOGIC],
  ['because','因为','\\because',LOGIC],
  // FUNC
  ['sin','正弦','\\sin',FUNC],
  ['cos','余弦','\\cos',FUNC],
  ['tan','正切','\\tan',FUNC],
  ['cot','余切','\\cot',FUNC],
  ['sec','正割','\\sec',FUNC],
  ['csc','余割','\\csc',FUNC],
  ['arcsin','反正弦','\\arcsin',FUNC],
  ['arccos','反余弦','\\arccos',FUNC],
  ['arctan','反正切','\\arctan',FUNC],
  ['sinh','双曲正弦','\\sinh',FUNC],
  ['cosh','双曲余弦','\\cosh',FUNC],
  ['tanh','双曲正切','\\tanh',FUNC],
  ['log','对数','\\log',FUNC],
  ['ln','自然对数','\\ln',FUNC],
  ['lg','常用对数','\\lg',FUNC],
  ['exp','指数','\\exp',FUNC],
  ['det','行列式','\\det',FUNC],
  ['dim','维数','\\dim',FUNC],
  ['ker','核','\\ker',FUNC],
  ['deg','次数','\\deg',FUNC],
  ['gcd','最大公约数','\\gcd',FUNC],
  ['arg','辐角/自变量','\\arg',FUNC],
  // CALC
  ['prime','导数撇','\\prime',CALC],
  ['div','散度/除号','\\div',CALC],
  ['pm','正负号','\\pm',CALC],
  ['mp','负正号','\\mp',CALC],
  ['ast','星号','\\ast',CALC],
  ['circ','复合','\\circ',CALC],
  ['oplus','直和（小）','\\oplus',CALC],
];

/** 面板最多给几条（含同类补全）。 */
const MAX_ITEMS = 12;
/** 前缀命中的条数少于这个数时，才补"同族兄弟"——少了就补，多了不堆。 */
const FAMILY_BELOW = 4;

/** 最长公共前缀长度：用来在同族里挑"离你敲的那条最近"的兄弟。 */
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/** 子序列模糊分（VS Code `base/common/filters.js` 里 fuzzyScore 的思路，简版）：
 *  字符必须按顺序出现；词首（命令首字母 / 驼峰边界）与连续命中加分，跨得越远扣得越多。
 *  返回 null 表示不是子序列。 */
const fuzzyScore = (key, token) => {
  let at = -1, score = 0, streak = 0;
  for (const ch of token) {
    const found = key.indexOf(ch, at + 1);
    if (found < 0) return null;
    const wordStart = found === 0 || /[a-z][A-Z]/.test(key.slice(found - 1, found + 1));
    streak = found === at + 1 ? streak + 1 : 0;
    score += 1 + (wordStart ? 3 : 0) + streak * 2 - Math.min(4, found - at - 1) * 0.5;
    at = found;
  }
  return score;
};

/** 公式命令补全的打分策略。
 *
 *  参照成熟实现（VS Code 的补全排序模型）：**匹配质量决定次序**，`sortText` / 声明顺序只在
 *  "匹配得一样好"时打破平局（`vscode.d.ts`：sortText 只用于初始排序，键入前缀后按匹配好坏排；
 *  实现见 `base/common/filters.js` 的 fuzzyScore / matchOnWordStartOnly）。
 *  这里的分档（越小越靠前）：
 *
 *    0  完全命中命令名        —— 键入 `\mathbb` 时它自己排第一
 *    1  命令名前缀命中        —— 同档内按"键入部分占命令名的比例"降序（更贴近的靠前）
 *    2  **同族兄弟**          —— 只在 0/1 档加起来不足 FAMILY_BELOW 条时补入；同族内按"与键入
 *                               那条的最长公共前缀"降序，所以 `\mathbb` 之后是 `\mathbf`（公共前缀
 *                               `mathb`）再是 `\mathcal`/`\mathscr`…（公共前缀 `math`）
 *    3  说明（中文）命中      —— 例如键入「粗体」
 *    4  子序列模糊命中        —— 最后一档，只在键入 ≥2 个字符时开（`\lr` → `\leftrightarrow`）
 *
 *  同档内次序：本文档公式里已经用过（精确 token，只在键入非空时算）→ 表里的声明顺序
 *  （表是按常用度人工排过的：`\frac`/`\sqrt`/`\sum`/`\int`/`\lim` 在最前）。
 *  **上下文只在同档内起作用**——旧实现把"公式里出现过"直接加 3 分，结果在一个含 `\int`/`\mathbf`
 *  的公式里敲 `\`，`\int`/`\in` 被顶到了 `\mathbb` 前面（用户 2026-09-14 第 8 轮的截图就是这个）。
 */
export function localCandidates(prefix, context = {}) {
  const trigger = prefix[0];
  if (context.kind === 'math' && trigger === '/') return [];
  const source = trigger === '/' ? snippets : trigger === '\\' ? commands : [];
  const token = prefix.slice(1);
  const query = token.toLowerCase();
  const nearby = (context.mathBefore || '') + (context.mathAfter || '');
  const used = new Set((nearby.match(/\\[A-Za-z]+/g) || []).map(match => match.slice(1)));
  const rankOf = ([key, title]) => {
    const lower = key.toLowerCase();
    if (!query) return {rank: 1, fuzzy: 0};                       // 只敲了一个 `\`：全部按常用度排
    if (lower === query) return {rank: 0, fuzzy: 0};
    if (lower.startsWith(query)) return {rank: 1, fuzzy: 0};
    if (title.includes(query)) return {rank: 3, fuzzy: 0};
    if (query.length < 2) return null;
    const fuzzy = fuzzyScore(lower, query);
    return fuzzy === null ? null : {rank: 4, fuzzy};
  };
  const scored = [];
  source.forEach((row, index) => {
    const hit = rankOf(row);
    if (hit) scored.push({row, index, ...hit});
  });
  // 同档内：先用"本文档公式里已用过"，再用表序。比例排序只用于第 1 档（前缀命中）。
  const ratio = row => (query && row[0].length ? commonPrefix(row[0].toLowerCase(), query) / row[0].length : 0);
  scored.sort((a, b) => a.rank - b.rank ||
    (query ? Number(used.has(b.row[0])) - Number(used.has(a.row[0])) : 0) ||
    b.fuzzy - a.fuzzy ||
    (a.rank === 1 ? ratio(b.row) - ratio(a.row) : 0) ||
    a.index - b.index);
  // 强命中（完全命中 + 前缀命中）与弱命中（说明命中 + 模糊命中）分开：同族补全插在两者之间。
  const strong = scored.filter(item => item.rank <= 1);
  const weak = scored.filter(item => item.rank > 1);
  const rows = strong.slice(0, MAX_ITEMS).map(item => item.row);
  const taken = new Set(rows.map(row => row[0]));
  // **同类补全**：把一个命令的"同族兄弟"一起提示出来。
  // 用户第 8 轮：「插入补全 \mathbb，它会自动给我提示出其他的 \mathscr \mathbf 之类的同是表示字体语法」；
  // 第 9 轮又强调：「MathBB 应该优先弹出来 mathbf、mathscr」。所以：
  //   · 判定只看**强命中**条数——模糊命中不算"够了"，否则 `\frac`（前缀只有 1 条、却有
  //     dfrac/tfrac/cfrac 三条模糊命中）会把同族补全整个跳过（实测踩过：`\sqrt` 因此消失）；
  //   · 同族条目插在强命中之后、弱命中之前；同族内按"与命中那条的最长公共前缀"降序，
  //     所以 `\mathbb` → 先是 `\mathbf`，再是 `\mathcal`/`\mathscr`…
  if (trigger === '\\' && query && strong.length < FAMILY_BELOW) {
    const group = strong[0]?.row?.[3];
    if (group) {
      const anchorKey = strong[0].row[0].toLowerCase();
      const siblings = source.filter(item => item[3] === group && !taken.has(item[0]))
        .map((item, index) => ({item, index, near: commonPrefix(item[0].toLowerCase(), anchorKey)}))
        .sort((a, b) => b.near - a.near || a.index - b.index);
      for (const sibling of siblings) {
        if (taken.has(sibling.item[0])) continue;
        taken.add(sibling.item[0]);
        rows.push(sibling.item);
        if (rows.length >= MAX_ITEMS) break;
      }
    }
  }
  for (const item of weak) {
    if (rows.length >= MAX_ITEMS) break;
    if (taken.has(item.row[0])) continue;
    taken.add(item.row[0]);
    rows.push(item.row);
  }
  return rows.map(([key, title, text]) => {
    const after = trigger === '\\' ? (context.suffix || '').match(/^[A-Za-z]*/)[0].length : 0;
    // Complete the command token while retaining existing arguments to its
    // right, e.g. \fr|ac{x}{y} becomes \frac{x}{y}, not \frac{}{}ac{x}{y}.
    if (trigger === '\\' && /^[{[_^]/.test((context.after || '').slice(after))) text = '\\' + key;
    // 说明栏**只放命令自己的中文解释**。分组只是内部用来挑同族兄弟的，不许出现在界面上——
    // 用户目测到的原话：「怎么候选框还有"同一类"这种工程字眼漏出来了」。
    return {label: trigger + key, detail: title, text, before: prefix.length, after, markdown: trigger === '/', source: 'local'};
  });
}
