/** Cache source blocks, never KaTeX's generated DOM, for IR export/history. */
const PREVIEW = ".vditor-ir__preview,.vditor-wysiwyg__preview";
const EXPAND = "vditor-ir__node--expand";
const elementAt = node => node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;

// Shallow recursion deliberately does not clone the thousands of rendered
// descendants that would immediately be discarded by history normalization.
export const cloneSource = (node, expanded = false) => {
  const copy = node.cloneNode(false);
  if (node.nodeType !== Node.ELEMENT_NODE) return copy;
  if (node.matches('[data-type="toc-block"]')) { copy.textContent='[toc]';return copy; }
  if (!expanded && copy.classList.contains(EXPAND)) copy.classList.remove(EXPAND);
  if (node.matches(PREVIEW)) {
    copy.setAttribute("contenteditable", "false");
    const child = node.firstElementChild;
    if (child?.classList.contains("language-math")) {
      const math = child.cloneNode(false);
      math.className = "language-math";
      // data-empty-math（空公式占位标记，math-scheduler 落渲染时按源码是否为空挂/摘）也要
      // 跟着摘掉：克隆出来的这棵树会被重新渲染，留着标记会让"空公式"占位挂在非空公式上。
      math.removeAttribute("data-math");
      math.removeAttribute("data-empty-math");
      math.textContent = node.previousElementSibling?.textContent || "";
      copy.setAttribute("data-render", "2");
      copy.append(math);
      return copy;
    }
    if (child?.matches(".language-echarts,.language-plantuml,.language-mindmap")) {
      const diagram = child.cloneNode(false);
      diagram.removeAttribute("_echarts_instance_");
      diagram.removeAttribute("data-processed");
      diagram.innerHTML = node.previousElementSibling?.firstElementChild?.innerHTML || "";
      copy.setAttribute("data-render", "2");
      copy.append(diagram);
      return copy;
    }
  }
  for (const child of node.childNodes) copy.append(cloneSource(child, expanded));
  return copy;
};
const htmlOf = node => node.nodeType === Node.ELEMENT_NODE ? node.outerHTML
  : node.nodeType === Node.TEXT_NODE ? node.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
// 【P2】内容哈希（FNV-1a，32 位）：只用来给"分组锚"找对位候选。复用分组的
// 最终判据仍是整组 HTML 逐字节相等，所以哈希碰撞最坏只是多一次字符串比较，
// 不可能导致错误的复用——任何路径下输出 markdown 都与逐块重算保持一致。
const hashOf = text => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const cloneBlock = block => {
  if (block.matches?.('[data-type="toc-block"]')) return cloneSource(block);
  const previews = [...block.querySelectorAll?.(PREVIEW) || []];
  // Most source blocks and all not-yet-rendered math can use Chromium's native
  // deep clone. Only populated previews need the source-skipping traversal.
  if (previews.some(preview => !preview.firstElementChild?.classList.contains("language-math") ||
      preview.firstElementChild.hasAttribute("data-math"))) return cloneSource(block);
  const copy = block.cloneNode(true);
  if (copy.nodeType !== Node.ELEMENT_NODE) return copy;
  copy.classList.remove(EXPAND);
  copy.querySelectorAll("." + EXPAND).forEach(node => node.classList.remove(EXPAND));
  copy.querySelectorAll(PREVIEW).forEach(preview => {
    preview.setAttribute("contenteditable", "false");
    preview.setAttribute("data-render", "2");
    const math = preview.firstElementChild;
    math.className = "language-math";
    math.removeAttribute("data-empty-math");
    math.textContent = preview.previousElementSibling?.textContent || "";
  });
  return copy;
};

export const installIncrementalIR = api => {
  const editor = api.vditor;
  const root = editor.ir.element;
  const cache = new WeakMap();
  const snapshots = new Map();
  let blocks = [];
  let structureDirty = true;
  let version = 0;
  let markdownVersion = -1;
  let markdown = "";
  let previousShape = "";
  let separators = null;
  let suffix = "";
  let unsafeEdit = false;
  let units = [];
  // 【P1】本轮是否有 dependent 分组（footnotes/link-ref/yaml-front-matter）真的
  // 发生了内容变化（新建/重转）。只有它才触发整篇校准；文档 merely 含这三类
  // 块不再是理由（旧实现的 `list.some(dependent)` 让这类文档永久失去增量路径）。
  let dependentConverted = false;
  const stats = {calibrations: 0, blockParses: 0, unitReuse: 0, primes: 0, primeMs: 0, get version() { return version; }};
  const blockOf = node => {
    while (node && node !== root && node.parentNode !== root) node = node.parentNode;
    return node?.parentNode === root ? node : null;
  };
  const invalidate = records => {
    for (const record of records) {
      // Previews, caret visibility and generated heading IDs are presentation.
      if (elementAt(record.target)?.closest?.(PREVIEW)) continue;
      if (record.type!=='attributes' && elementAt(record.target)?.closest?.('[data-type="toc-block"]')) continue;
      if (record.type === "attributes" && ["class", "id", "contenteditable", "data-render", "data-math", "data-empty-math"].includes(record.attributeName)) continue;
      if (record.target === root) {
        if (record.type === "childList") structureDirty = true;
        else continue;
      } else {
        const block = blockOf(record.target);
        if (!block) continue;
        cache.delete(block);
      }
      version++;
    }
  };
  const observer = new MutationObserver(invalidate);
  observer.observe(root, {childList: true, subtree: true, characterData: true, attributes: true});
  const drain = () => {
    invalidate(observer.takeRecords());
    if (structureDirty) { blocks = Array.from(root.childNodes); structureDirty = false; }
  };
  const entryFor = block => {
    let entry = cache.get(block);
    if (!entry) {
      const clone = cloneBlock(block);
      const html = htmlOf(clone);
      const type = block.getAttribute?.("data-type") || "";
      // Definition blocks and raw HTML can carry document-wide semantics.
      // They still benefit from source-only serialization and cached history.
      const dependent = /data-type="(?:footnotes|link-ref|yaml-front-matter)/.test(html);
      // 【P1/P4】受支持清单补上 dependent 三类（footnotes*/link-ref*/yaml-front-matter
      // ——它们在 getMarkdown 里独立成组、变化时整篇校准兜底，因此对它们信任学到的
      // 分隔符与信任 P/H1..6 是同一等级）与 html-block/figure/details（cloneSource/
      // cloneBlock 对它们本就逐字节保真）。用前缀匹配：实际 DOM 里是
      // footnotes-block / link-ref-defs-block 这类带后缀的变体。此前白名单外的
      // 顶层块会把 unsafeEdit 顶成真，含这类块的文档从此每键整篇校准（Vditor 还会
      // 在输入时重建这些定义块，unsafeEdit 反复复发）。safe 只影响"能否信任增量
      // 拼装"，不改变任何一块的转换结果。
      const safe = /^(P|H[1-6]|UL|OL|BLOCKQUOTE|HR|TABLE)$/.test(block.nodeName) ||
        block.nodeName === "DIV" && /^(math-block|code-block|toc-block|html-block|figure|details|footnotes|link-ref|yaml-front-matter)/.test(type);
      if (!safe) unsafeEdit = true;
      entry = {html, dependent, shape: block.nodeName + ":" + type, hash: hashOf(html)};
      cache.set(block, entry);
    }
    return entry;
  };
  const entries = () => { drain(); return blocks.map(entryFor); };
  const convert = html => editor.lute.VditorIRDOM2Md(html);
  // 【P2】分组缓存：每个分组记两个锚信息——首块内容哈希 anchor 与块数 count。
  // 重新分组时先按 anchor 把旧分组"认领"回来（锚块出现的位置就是分组边界），
  // 认领到的分组在整组 HTML 逐字节相同时直接复用上次的 md，不做 Lute 转换；
  // 没有任何锚覆盖的新区域（新插入的块）退回 16 块上限的位置切分。文首插块时
  // 旧分组只是整体平移，锚认领让它们原样存活——只有真正变化的内容才付转换。
  // 【P1】dependent 块（footnotes/link-ref/yaml-front-matter）永远独立成组：它们
  // 携带全文语义，不与邻居合并缓存。保守规则（宁可慢不可错）：这类组的内容发生
  // 变化（新建/改动）时本轮整篇校准兜底；它们没变时，普通打字不再为文档里
  // "存在"这三类块而付整篇换算。
  // 安全底线：每处分组/复用都不改变输出 markdown——复用要求整组 HTML 相等，
  // 校准路径与旧实现共用同一条"从 Lute 学分隔符"的代码，绝不猜块怎么拼接。
  const unitFor = (index, group, pinned) => {
    const html = group.map(entry => entry.html).join("");
    if (pinned && pinned.html === html) { stats.unitReuse++; units[index] = pinned; return pinned; }
    let unit = units[index];
    if (!unit || unit.html !== html) {
      unit = {html, md: convert(html), shape: group.map(entry => entry.shape).join(","),
        dependent: group.some(entry => entry.dependent), anchor: group[0].hash, count: group.length};
      stats.blockParses++;
      // 【P1】"内容真的变了"才计 dependentConverted：对位旧组存在但不一致。
      // 首次全量建缓存（没有旧组可对）不算变化——否则含 dependent 块的文档在
      // 打开后的第一次编辑仍会白付一次整篇校准+分隔符作废。
      if (unit.dependent && pinned) dependentConverted = true;
    } else { unit.anchor = group[0].hash; unit.count = group.length; }
    units[index] = unit;
    return unit;
  };
  // 分组计划：按锚认领旧分组（锚块出现的位置就是分组边界），dependent 块独立
  // 成组，没有任何锚覆盖的新区域退回 16 块上限。getMarkdown 与分片预热共用，
  // 预热写下的分组形状与真正装配时一致，不会在打开后的第一次编辑白付一次
  // 重分组校准。
  const groupPlan = source => {
    const claim = new Map();
    for (const unit of units) {
      if (!unit) continue;
      const queue = claim.get(unit.anchor);
      if (queue) queue.push(unit); else claim.set(unit.anchor, [unit]);
    }
    const plan = [];
    let group = [], pinned = null;
    const close = () => { if (!group.length) return; plan.push({group, pinned}); group = []; pinned = null; };
    for (const entry of source) {
      const candidate = claim.get(entry.hash)?.pop();
      if (entry.dependent) {
        // 【P1】dependent 独立成组：先与前置内容切开，自己一组收口。既不把
        // 全文语义并进邻居的缓存，也不让邻居的普通打字连累到整篇校准。
        close();
        plan.push({group: [entry], pinned: candidate});
        continue;
      }
      if (group.length && candidate) close();   // 锚块前收口：分组边界跟着内容走
      if (candidate) pinned = candidate;
      group.push(entry);
      if (pinned ? group.length >= pinned.count : group.length >= 16) close();
    }
    close();
    return plan;
  };
  const getMarkdown = () => {
    const source = entries();
    if (markdownVersion === version) return markdown;
    dependentConverted = false;
    const plan = groupPlan(source);
    const list = plan.map((item, index) => unitFor(index, item.group, item.pinned));
    units = list;
    // 【138 回归修正】分组边界指纹：separator/suffix 只在**边界块内容**没变时才可复用。
    // 空段落这类 md 为空的块，它的全部存在感都落在相邻 separator 里——实测：回车造出
    // 空 P 后校准把分组尾学成 “\n\n” 的分隔符；随后在空 P 里打字，边界块从 P{} 变成
    // P{Z}，拼装路径仍拿旧分隔符拼新边界 → 凭空多一个空行（磁盘 “Z\n\n\n后文”）。
    // 把每个分组首/末块的内容哈希编进 shape：边界块一变就整篇校准。块间拼接是局部
    // 语义（只取决于相邻两块），中段块的编辑不触碰边界，joined 增量路径照常存活——
    // 这也是位置切片（HEAD）从未踩中此坑的原因：小文档单组无边界，大文档 16 块的
    // 固定边界极少正好落在“空段变实段”的那一格上。
    const edges = plan.map(item => item.group[0].hash + ">" + item.group[item.group.length - 1].hash).join(",");
    const shape = list.map(entry => entry.shape + ":" +
      (entry.md.match(/^\s*/)?.[0].length || 0) + ":" + (entry.md.match(/\s*$/)?.[0].length || 0)).join("|") + "@" + edges;
    // stats.why：本轮装配走了哪条路（calibrate 的触发原因 / joined 增量拼装）。
    // 只作探针诊断，不参与任何判定。
    stats.why = !separators ? "no-separators" : shape !== previousShape ? "shape" : dependentConverted ? "dependent" : unsafeEdit ? "unsafeEdit" : "joined";
    if (!separators || shape !== previousShape || dependentConverted || unsafeEdit) {
      // Learn exact separators from Lute, including tables' extra blank line,
      // empty blocks and front matter. Never guess how Markdown blocks join.
      markdown = convert(list.map(entry => entry.html).join(""));
      stats.calibrations++;
      let cursor = 0;
      separators = [];
      for (const entry of list) {
        const start = markdown.indexOf(entry.md, cursor);
        if (start < 0 || markdown.slice(cursor, start).trim()) {
          separators = null;
          // 诊断：对不上的是哪个分组（只进 stats，不影响任何判定）。
          stats.alignFail = {unit: list.indexOf(entry), mdHead: entry.md.slice(0, 24), start,
            gap: JSON.stringify(markdown.slice(cursor, Math.min(start < 0 ? cursor + 24 : start, cursor + 24)))};
          break;
        }
        separators.push(markdown.slice(cursor, start));
        cursor = start + entry.md.length;
      }
      suffix = markdown.slice(cursor);
      if (suffix.trim() || dependentConverted) { separators = null; stats.suffixTail = suffix.slice(0, 24); }
      previousShape = shape;
      unsafeEdit = false;
    } else {
      markdown = list.map((entry, i) => separators[i] + entry.md).join("") + suffix;
    }
    markdownVersion = version;
    return markdown;
  };

  const snapshot = () => {
    const list = entries();
    const html = list.map(entry => entry.html);
    const selection = getSelection();
    if (selection.rangeCount && !html.some(value => value.includes("<wbr>"))) {
      const range = selection.getRangeAt(0);
      const block = blockOf(range.startContainer);
      const index = blocks.indexOf(block);
      if (range.startContainer === root) {
        html.splice(range.startOffset, 0, "<wbr>");
      } else if (index !== -1 && !elementAt(range.startContainer)?.closest?.(PREVIEW)) {
        const copy = cloneSource(block, true);
        const route = [];
        for (let node = range.startContainer; node !== block; node = node.parentNode) {
          route.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
        }
        let target = copy;
        for (const index of route) target = target.childNodes[index];
        // `Range.insertNode` 把节点插进**容器自己的父节点**里；克隆体（copy）没有父节点，
        // 拿它当容器必抛 `HierarchyRequestError: no parent into which to insert`。
        // 什么时候会落到克隆体上：route 为空——也就是键盘给的落点是**元素级**的
        // （`range.startContainer` 就是块本身）。Word 删除（Ctrl+Backspace/Delete）之后
        // 的落点正是这种形状，用户实测"词删之后撤销快照就报错"（交接 F1）。
        // 退路：换到块内**第一个有父节点的文本节点**（容器在克隆体内部，插入安全）；
        // 一个文本节点都没有就跳过 wbr——快照本身照记，只是不带光标标记。
        let 容器 = target;
        let 偏移 = range.startOffset;
        if (!容器 || !容器.parentNode) {
          const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
          let 文 = null;
          while ((文 = walker.nextNode())) { if (文.parentNode) break; }
          容器 = 文 && 文.parentNode ? 文 : null;
          偏移 = 0;
        }
        if (容器) {
          const caret = document.createRange();
          caret.setStart(容器, Math.min(Math.max(偏移, 0), 容器.nodeType === Node.TEXT_NODE ? 容器.length : 容器.childNodes.length));
          caret.collapse(true);
          caret.insertNode(document.createElement("wbr"));
        }
        html[index] = htmlOf(copy);
      }
    }
    const result = html.join("");
    // 记录时不换算 Markdown：打开时的第一次记录正好落在首屏长任务里，而整篇
    // 换算要 839ms（.perf/ir-perf-defer1.json 的调用树：api.clearStack →
    // addToUndoStack → addCaret → snapshot → getMarkdown）。这里只记下当时的
    // DOM 版本号，等真正需要（撤销/重做比对）时再补：版本没变就用缓存里的
    // markdown，变了就按记录下来的 HTML 重新转换——与原实现 cache miss 的回退
    // 是同一条路径，语义不变。
    // 【P3】缓存里的 markdown 若恰好对上当前 DOM 版本，顺手一起存下：打字后
    // 200ms 内的 Ctrl+Z（flush → historyMarkdown）命中的正是这条快照，从此免掉
    // 那次整篇换算。存的值与 convert(result) 回退路径逐字节等价——
    // historyMarkdown 版本命中的原路径（entry.version === version 时直接返回
    // getMarkdown()）依赖的正是这层等价关系，语义不变。
    snapshots.set(result, {markdown: markdownVersion === version ? markdown : null, version});
    while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
    return result;
  };

  // Vditor rebuilds the entire outline on every input, including when hidden.
  // Cache its source signature; preserve native rebuilding and click behavior
  // whenever a heading, its order, or the displayed editor mode changes.
  const outline = editor.outline;
  const renderOutline = outline.render;
  const toggleOutline = outline.toggle;
  outline.toggle = function (...args) {
    const value = toggleOutline.apply(this, args);
    if (outline.element.style.display !== 'none') window.__typoraScheduleMath?.(outline.element, {cdn:editor.options.cdn,math:editor.options.preview.math});
    return value;
  };
  const outlineKey = () => {
    drain();
    return blocks.map((block, index) => /^H[1-6]$/.test(block.nodeName)
      ? index + ":" + entryFor(block).html.replace(/ id="[^"]*"/g, "") : "").filter(Boolean).join("");
  };
  let lastOutlineKey = null;
  let lastOutline = "";
  outline.render = function (state) {
    if (state.currentMode !== "ir" || state.preview.element.style.display === "block") {
      lastOutlineKey = null;
      return renderOutline.call(this, state);
    }
    const key = outlineKey();
    if (key === lastOutlineKey) return lastOutline;
    lastOutline = renderOutline.call(this, state);
    lastOutlineKey = outlineKey();
    return lastOutline;
  };

  // 分片预热：把"整篇首建"从一个不可中断的大步骤拆成若干片，交给 warmup.js 在首屏
  // 之后逐步跑（实测首建 855ms，占打开长任务约四分之一）。
  // 语义上这只是一次缓存预热——getMarkdown 自己照样会检查并补齐任何缺失的分组，
  // 所以任何时刻（甚至预热进行中）调用 getValue/snapshot 都是正确的，只是白预热了。
  // 最后一步装配（分隔符学习 + 全文校准各是一次 O(全文) 的 Lute 调用）单独占一片。
  // 文档一变（用户开始打字）整篇分组的缓存基线就作废，此时重来只会一直重来：
  // 排队在它后面的预热（CV、阅读面几何）就永远轮不上。所以连续作废两次即放弃，
  // 让位给后面的任务；此时首键自己会走 getMarkdown 的同步路径，那本来就是安全网。
  let primeSource = null, primeVersion = -1, primeNext = 0, primeRestarts = 0;
  const prime = budgetMs => {
    drain();
    if (primeSource && (primeVersion !== version || primeSource.length !== blocks.length)) {
      primeSource = null;
      if (++primeRestarts > 2) { stats.primeAbandoned = true; return true; }
    }
    // 用与 getMarkdown 相同的锚定/dependent 隔离分组来预热：预热的分组形状
    // 与真正装配一致，第一次 getValue 不需要重分组（否则那一步会把 dependent
    // 单例重组一遍、多付一次整篇校准）。
    if (!primeSource) { primeSource = groupPlan(blocks.map(entryFor)); primeNext = 0; }
    primeVersion = version;
    const total = primeSource.length;
    if (primeNext < total) {
      // 模块内的 `performance` 是本文件末尾导出的那个对象，会遮蔽全局 performance。
      const started = globalThis.performance.now();
      do {
        const item = primeSource[primeNext];
        unitFor(primeNext, item.group, item.pinned);
        primeNext++;
      } while (primeNext < total && globalThis.performance.now() - started < budgetMs);
      stats.primeMs += globalThis.performance.now() - started;
      return false;
    }
    if (markdownVersion !== version) getMarkdown();
    primeSource = null; primeNext = 0;
    stats.primes++;
    return true;
  };

  const performance = {
    getMarkdown, snapshot, stats, prime,
    sourceBlocks: () => { drain(); return blocks.map(node => ({node, html: entryFor(node).html})); },
    historyMarkdown: html => {
      const entry = snapshots.get(html);
      if (!entry) return convert(html);
      if (entry.markdown === null) entry.markdown = entry.version === version ? getMarkdown() : convert(html);
      return entry.markdown;
    },
    destroy() { observer.disconnect(); snapshots.clear(); outline.render = renderOutline; outline.toggle = toggleOutline; },
  };
  editor.__typoraPerformance = performance;
  return performance;
};
