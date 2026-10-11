/**
 * Knuth–Plass total-fit 断行（按 2.3.3 的思路在本引擎重写）
 *
 * 为什么单独成模块：它是**纯函数**——输入 box/glue/penalty 序列与行宽，输出最优断点序列。
 * 不碰 DOM、不碰文档、不读全局状态 ⇒ ①能在 Node 里单测（不必起浏览器）；②接阅读模式/PDF 时
 * 只在"进入阅读态"或"打印前"跑一次，**不在键入路径上**，因此不违反"无新增每键 O(整篇)"。
 *
 * 模型（Knuth & Plass, 1981）：
 *   box      —— 不可断单元（一个汉字、一个西文词）
 *   glue     —— 可伸缩空白（西文空格；CJK 无空格）
 *   penalty  —— 断点代价（正=罚、负=奖、Infinity=禁断，用于中文禁则）
 * 目标：最小化总 demerits = Σ (1 + 100·|Δfitness|³ + badness)² + penalty 项。
 * 与贪心（逐行塞满）的区别：total-fit 会**为后文牺牲前文**，因此不会出现"某行稀疏得刺眼"。
 */

export const FITNESS = Object.freeze({ TIGHT: 0, DECENT: 1, LOOSE: 2, VERY_LOOSE: 3 });

export const box = (width, text, breakable = false) => ({ type: 'box', width, text: text || '', breakable });
export const glue = (width, stretch, shrink, text = ' ') => ({ type: 'glue', width, stretch, shrink, text });
export const penalty = (width, cost, flagged = false, text = '') => ({ type: 'penalty', width, cost, flagged, text });
/** 中文禁则：这些标点**不允许出现在行首**（把该处断点设为禁断）。 */
export const NO_BREAK_BEFORE = '。，、；：？！）〉》」』】〕｝”’%‰℃…—·,.!?;:)]}';
/** 这些标点**不允许出现在行尾**。 */
export const NO_BREAK_AFTER = '（〈《「『【〔｛“‘([{';

const INF = 1e9;

function classify(ratio) {
  if (ratio < -0.5) return FITNESS.TIGHT;
  if (ratio <= 0.5) return FITNESS.DECENT;
  if (ratio <= 1) return FITNESS.LOOSE;
  return FITNESS.VERY_LOOSE;
}

/**
 * 求最优断行。返回 { breaks, lines, demerits, feasible }
 *  breaks: 每行结束处的 item 下标（含末项）
 */
export function breakParagraph(items, lineWidth, opts = {}) {
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 200;     // badness 上限（1=很好，100=勉强）
  const maxNodes = Number.isFinite(opts.maxNodes) ? opts.maxNodes : 4000;        // 活跃节点上限（防长段落爆内存）
  const n = items.length;
  if (!n) return { breaks: [0], lines: [], demerits: 0, feasible: true };
  if (!(lineWidth > 0)) return { breaks: [], lines: [], demerits: 0, feasible: false };

  // 累加宽度与伸缩量（前缀和 ⇒ O(1) 取区间）
  const sumW = new Float64Array(n + 1), sumY = new Float64Array(n + 1), sumZ = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    sumW[i + 1] = sumW[i] + (it.type === 'glue' ? it.width : it.type === 'box' ? it.width : 0);
    sumY[i + 1] = sumY[i] + (it.type === 'glue' ? it.stretch : 0);
    sumZ[i + 1] = sumZ[i] + (it.type === 'glue' ? it.shrink : 0);
  }
  const legal = (i) => {                       // items[i] 处是否为合法断点（i 表示"在第 i 项之前断"）
    if (i <= 0 || i >= n) return i === n;
    const prev = items[i - 1], cur = items[i];
    // 【中文断行的关键】西文词内部不能断（box|box 默认禁），但**汉字的字边界可以断** ⇒ 靠 breakable 标记区分。
    // 早先一刀切禁掉 box|box，纯中文段落一个断点都没有 ⇒ 无解（实测 feasible:false / lines:0）。
    if (prev && prev.type === 'box' && cur && cur.type === 'box') return !!prev.breakable;
    if (cur && cur.type === 'penalty') return (cur.cost !== Infinity && cur.cost < INF);
    if (cur && cur.type === 'glue') return true;
    if (prev && prev.type === 'glue') return true;
    return false;
  };
  const widthAt = (i) => {                     // 在 i 处断行时该行"有效宽度"（去掉行尾 glue、加上 penalty 宽度）
    let w = sumW[i];
    let k = i - 1;
    while (k >= 0 && items[k].type === 'glue') { w -= items[k].width; k--; }
    if (k >= 0 && items[k].type === 'penalty' && items[k].width > 0) w += items[k].width;
    return w;
  };

  // 单个不可断 box 比整行还宽时（超长英文单词 / URL），KP 的应急处理是"硬放"这一行——
  // 否则整段直接无解（实测：60 个 a 的单词在 60px 行宽下 feasible:false）。放不下也得放，且只惩罚一次。
  const singleBoxLimit = (nd, i) => {
    let count = 0;
    for (let k = nd.pos; k < i; k++) { const it = items[k]; if (it.type !== 'box') continue; count++; if (count > 1) return false; }
    return count === 1;
  };

  // 活跃窗口：一行最多装得下 lineWidth / 最小 box 宽的 item 数 ⇒ 比这更早的起点不可能属于当前行。
  /* 【★ 2026-10-09 修·纯中文一行一个字的真因】改前窗口按**节点个数**限：
     `for (let a = Math.max(0, nodes.length - maxLagNodes); ...)`。
     可节点数是 O(i²) 增长的（每个 i 对每个可行起点都生成节点）⇒ 到段尾时
     `nodes.length - maxLagNodes` 早就越过了"起点 0"那个节点 ⇒ **整段一行的解被挤出窗口**，
     只剩"起点头部几个字"的解 ⇒ 实测 45 个汉字（恰好一行）被断成 **39 行**、139 字断成 **133 行**。
     窗口的正确口径是**位置**：只考虑 pos ≥ i − maxLagItems 的起点（一行装不下的起点本来就不可能）。
     现在按 pos 分桶索引节点，内层只遍历这个位置区间。 */
  let minBox = Infinity;
  for (const it of items) if (it.type === 'box' && it.width > 0) minBox = Math.min(minBox, it.width);
  const maxLagItems = Number.isFinite(opts.maxLagNodes) ? opts.maxLagNodes
    : Math.max(64, Math.min(2000, Math.ceil(lineWidth / (minBox === Infinity ? 1 : minBox)) * 4));

  const nodes = [{ pos: 0, line: 0, fitness: FITNESS.DECENT, demerits: 0, prev: -1, ratio: 0, badness: 0 }];
  const byPos = new Map();                     // pos → 该位置上的节点下标数组
  byPos.set(0, [0]);
  const done = [];

  for (let i = 1; i <= n; i++) {
    if (!legal(i)) continue;
    const isLast = i === n;
    const lineW = widthAt(i);
    const created = [];
    // 【性能 + 正确性】只遍历"位置窗口"内的起点：一行最多装得下 lineWidth/minBox 个 item
    // ⇒ 比 i − maxLagItems 更早的起点不可能是当前行的起点（见上面 2026-10-09 的修复说明）。
    const loPos = Math.max(0, i - maxLagItems);
    for (let p = loPos; p < i; p++) {
      const bucket = byPos.get(p);
      if (!bucket) continue;
      for (const a of bucket) {
      const nd = nodes[a];
      if (!nd || nd.pos >= i) continue;
      // 【踩过的坑】这里要算"目标行宽 − 本行内容宽"。早先把 `lineW`（累加宽度）当成了目标行宽，
      // 松弛量永远是巨大正数 ⇒ 末行永远"放得下"，整段被排成一行（实测 lines:1）。
      const content = lineW - widthAt(nd.pos);
      const w = lineWidth - content;
      const y = sumY[i] - sumY[nd.pos], z = sumZ[i] - sumZ[nd.pos];
      let ratio, badness;
      // 【踩过的坑】末行只允许"稀疏"，**不允许"放不下"**：早先这里无条件给 ratio=0/badness=0，
      // 等于宣布"最后一行可以无限长" ⇒ 最优解永远是一整段一行（实测 lines:1）。末行同样受行宽约束。
      if (isLast) {
        if (w < 0) {
          if (z <= 0) { if (singleBoxLimit(nd, i)) { ratio = -1; badness = 100; } else continue; }
          else { ratio = w / z; if (ratio < -1) continue; badness = 100 * Math.pow(Math.abs(ratio), 3); }
        } else { ratio = 0; badness = 0; }
      } else if (w < 0) {                                        // 太紧：能压缩多少
        if (z <= 0 && w < -0.5) { if (singleBoxLimit(nd, i)) { ratio = -1; badness = 100; } else continue; }
        else { ratio = z > 0 ? w / z : (w < 0 ? -1 : 0); if (ratio < -1) continue; badness = 100 * Math.pow(Math.abs(ratio), 3); }
      } else if (w > 0) {                                        // 太松：能拉伸多少
        // 【中文的关键】汉字之间没有可拉伸的 glue ⇒ 不能要求"多余松弛必须被拉伸掉"，
        // 否则纯中文段落永远无解（实测 feasible:false）。中文断行本就允许行尾参差：
        // 这里给参差一个**温和**代价（短 10% ≈ badness 20，短 50% ≈ 100），交给 total-fit 去权衡。
        if (y <= 0) { ratio = 0; badness = Math.min(200, (w / lineWidth) * 200); }
        else { ratio = w / y; badness = 100 * Math.pow(ratio, 3); }
      } else { ratio = 0; badness = 0; }
      if (badness > tolerance && !isLast) continue;
      const pen = (items[i - 1] && items[i - 1].type === 'penalty') ? items[i - 1].cost : 0;
      const fit = classify(ratio);
      const df = Math.abs(fit - nd.fitness);
      let d = Math.pow(1 + 100 * Math.pow(df, 3) + badness, 2);
      if (pen >= 0) d += pen * pen; else d -= pen * pen;
      created.push({ pos: i, line: nd.line + 1, fitness: fit, demerits: nd.demerits + d, prev: a, ratio, badness, isLast });
      }
    }
    if (created.length) {
      created.sort((p, q) => p.demerits - q.demerits);
      const keep = created.slice(0, maxNodes);
      for (const c of keep) {
        nodes.push(c);
        const idx = nodes.length - 1;
        const bucket = byPos.get(c.pos);
        if (bucket) bucket.push(idx); else byPos.set(c.pos, [idx]);
        if (c.isLast) done.push(idx);
      }
    }
  }
  if (!done.length) return { breaks: [], lines: [], demerits: Infinity, feasible: false };   // 无可行解 ⇒ 交给调用方降级（贪心）
  let bi = done.reduce((p, q) => (nodes[q].demerits < nodes[p].demerits ? q : p), done[0]);
  const chain = [];
  for (let k = bi; k >= 0; k = nodes[k].prev) chain.push(k);
  chain.reverse();
  return {
    breaks: chain.slice(1).map((k) => nodes[k].pos),
    lines: chain.map((k) => ({ from: nodes[k].prev >= 0 ? nodes[nodes[k].prev].pos : 0, to: nodes[k].pos, ratio: +nodes[k].ratio.toFixed(3), badness: +nodes[k].badness.toFixed(1) })),
    demerits: nodes[bi].demerits,
    feasible: true,
  };
}

/** 贪心（逐行塞满）——只用于对照与降级：KP 不可行时退回它，绝不让断行失败。 */
export function breakGreedy(items, lineWidth) {
  const breaks = []; let start = 0, w = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const add = it.type === 'glue' ? it.width : it.type === 'box' ? it.width : 0;
    if (w + add > lineWidth && i > start) { breaks.push(i); start = i; w = add; }
    else w += add;
  }
  breaks.push(items.length);
  return { breaks, lines: breaks.map((to, k) => ({ from: k ? breaks[k - 1] : 0, to })), demerits: null, feasible: true };
}

/**
 * 把一段文本切成 box/glue/penalty。measure(text, kind) 返回像素宽（调用方传 canvas 测量或等宽近似）。
 * 中文逐字成 box（含禁则罚），西文按词成 box、空格成 glue。
 */
export function tokenize(text, measure, opts = {}) {
  const items = []; const spaceW = measure(' ', 'space');
  const isCJK = (ch) => /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
  const isWordChar = (ch) => /[A-Za-z0-9'’\-]/.test(ch) || /[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { let j = i; while (j < text.length && /\s/.test(text[j])) j++; items.push(glue(spaceW * (j - i), spaceW * 0.5 * (j - i), spaceW * 0.33 * (j - i), text.slice(i, j))); i = j; continue; }
    if (isCJK(ch)) {
      const w = measure(ch, 'cjk');
      const prev = items[items.length - 1];
      if (prev && prev.type === 'box' && NO_BREAK_AFTER.includes(prev.text)) items.push(penalty(0, Infinity));   // 禁则：不在开引号后断
      if (NO_BREAK_BEFORE.includes(ch)) items.push(penalty(0, Infinity));                                        // 禁则：不在收标点前断
      items.push(box(w, ch, true));   // 汉字：字边界可断（breakable=true）——中文断行全靠它
      i++; continue;
    }
    let j = i; while (j < text.length && !/\s/.test(text[j]) && !isCJK(text[j])) j++;
    const word = text.slice(i, j);
    items.push(box(measure(word, 'word'), word));
    i = j;
  }
  return items;
}

/** 用固定宽度函数近似测量（Node 单测用；浏览器里传 canvas 的 measureText）。 */
export function monospaceMeasure(cjkWidth, latinWidth) {
  return (t, kind) => (kind === 'cjk' ? cjkWidth * t.length : kind === 'space' ? latinWidth * t.length : latinWidth * t.length * 0.5);
}
