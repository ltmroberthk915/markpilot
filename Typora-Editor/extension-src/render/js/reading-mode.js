/** 融合路线 #3：阅读态窗口化只读渲染面。
 *
 *  复用 Vditor 自带的"预览模式"（preview 工具项）作为全宽只读阅读面，只在
 *  它的顶层块上做窗口化：视口 ± BUFFER 内的块挂载真实节点，其余换成等高占位。
 *  编辑面（contenteditable）完全不参与，因此不存在 caret/撤销/序列化风险。
 *
 *  设计取舍与实测证据见 docs/READING-MODE-ROUTE3.md：
 *  - 占位块复制原块的 `offsetHeight` 与外边距 → 总高逐像素保持，滚动位置记忆/
 *    大纲跳转/点击定位都不会漂移（实测总高偏差 <0.5%，与 CV 同口径）。
 *  - 占位块里放该块的纯文本（去掉 KaTeX 的 MathML 注释层与复制按钮），并
 *    `color: transparent` + `overflow: hidden` 裁掉：Ctrl+A / 拖选跨未挂载区
 *    时浏览器原生复制仍然拿到完整正文，不需要伪造剪贴板载荷。
 *  - 准备阶段等预览渲染与公式队列都静止（与 large-doc.js 的 CV 同一道门），
 *    在公式渲染完成前量高度会系统性偏小。
 *
 *  小文档（顶层块 < THRESHOLD）完全不窗口化，零规则命中。
 */
import {documentLocations, bindCoarseBlocks} from './split-navigation.js';
import {scrollIntoViewSafe} from './large-doc.js';
import {updateReadingToggle} from './toolbar.js';
import {afterPaint} from './warmup.js';

const THRESHOLD = 1200;
const BUFFER = 1200;
const MIN_MOUNT = 8;
const PREVIEWS = '.vditor-ir__preview,.vditor-wysiwyg__preview';
// KaTeX 的 MathML 注释层会重复一遍公式文本，复制按钮/行号也属于装饰。
const DECORATION = '.katex-mathml,.vditor-copy,.vditor-linenumber__rows,.vditor-anchor';

const elementAt = node => node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
const clamp01 = value => Math.max(0, Math.min(1, value));
const plainText = node => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {acceptNode(text) {
    return text.parentElement?.closest(DECORATION) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  }});
  let value = "";
  for (let text; text = walker.nextNode();) value += text.data;
  return value;
};
/** 顶层块内的第一个"源码文本"落点：跳过公式预览岛与隐藏源码。 */
const sourceTextNodes = ifBlock => {
  const walker = document.createTreeWalker(ifBlock, NodeFilter.SHOW_TEXT, {acceptNode(text) {
    return text.parentElement?.closest(PREVIEWS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  }});
  const nodes = [];
  for (let text; text = walker.nextNode();) nodes.push(text);
  return nodes;
};
const firstIndexAtOrAfter = (tops, value) => {
  let low = 0, high = tops.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tops[middle] < value) low = middle + 1; else high = middle;
  }
  return low;
};

export const installReadingMode = api => {
  const editor = api.vditor;
  const host = editor.element;
  const scroller = editor.preview.element;
  const surface = editor.preview.previewElement;
  const outline = editor.outline?.element;
  const previewButton = () => editor.toolbar?.elements?.['preview']?.querySelector('button');
  const previewShown = () => !!previewButton()?.classList.contains('vditor-menu--current');

  let active = false, prepared = false, preparing = false, disposed = false;
  let frame = 0, poll = 0, hintTimer = 0, resizeTimer = 0;
  let saved = null, status = null;
  let state = null, bounds = null, source = "";
  // 阅读位置记忆：退出时记下"顶部块序号 + 块内偏移"，再次进入时按块还原，
  // 不依赖两次会话的像素高度完全一致（改过宽度也成立）。
  let readingAnchor = null;
  const stats = {prepares: 0, attaches: 0, detaches: 0, windowMs: 0, bindMs: 0, jumps: 0, jumpMisses: 0, blocks: 0, mounted: 0, skipped: 0};

  /* ---------- 状态提示 ---------- */
  const sync = () => updateReadingToggle(api, active);
  const notify = (message, sticky = false) => {
    if (!status) {
      status = document.createElement("div");
      status.className = "typora-reading-status";
      status.setAttribute("role", "status");
      host.append(status);
    }
    clearTimeout(hintTimer);
    status.textContent = message;
    status.hidden = !message;
    if (message && !sticky) hintTimer = setTimeout(() => { status.textContent = ""; status.hidden = true; }, 2600);
  };

  /* ---------- 窗口化 ---------- */
  const teardownWindow = () => {
    if (!state) return;
    // 一次性重建整份子节点列表：2576 次 replaceWith 的自失效累计实测 ~5s。
    const fragment = document.createDocumentFragment();
    for (const node of state.originals) fragment.append(node);
    surface.replaceChildren(fragment);
    state = null;
    prepared = false;
  };
  const measureTops = () => {
    const tops = new Array(state.slots.length);
    for (let i = 0; i < tops.length; i++) tops[i] = state.slots[i].offsetTop;
    state.tops = tops;
    state.total = scroller.scrollHeight;
  };
  const update = () => {
    frame = 0;
    if (!state || !active) return;
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    let first = Math.max(0, firstIndexAtOrAfter(state.tops, top - BUFFER) - 1);
    let last = Math.min(state.slots.length - 1, firstIndexAtOrAfter(state.tops, bottom + BUFFER) + 1);
    if (last - first + 1 < MIN_MOUNT) last = Math.min(state.slots.length - 1, first + MIN_MOUNT - 1);
    let mounted = 0;
    for (let i = 0; i < state.slots.length; i++) {
      const wanted = i >= first && i <= last;
      // 槽位仍在文档里 ⇔ 该块被窗口卸下（挂载时槽位被真实节点换走）。
      const offline = state.slots[i].parentElement !== null;
      if (wanted && offline) {
        state.slots[i].replaceWith(state.nodes[i]);
        stats.attaches++;
        mounted++;
      } else if (!wanted && !offline) {
        state.nodes[i].replaceWith(state.slots[i]);
        stats.detaches++;
      } else if (wanted) mounted++;
    }
    stats.mounted = mounted;
  };
  const schedule = () => { if (!frame && active) frame = requestAnimationFrame(update); };

  const windowize = () => {
    const nodes = [...surface.children];
    if (nodes.length < THRESHOLD) { stats.skipped++; return false; }
    const heights = new Array(nodes.length), margins = new Array(nodes.length);
    const memo = new Map();
    // 先全部读，再全部写：读-写交错会让每次写触发一次全文档重排。
    for (let i = 0; i < nodes.length; i++) {
      heights[i] = nodes[i].offsetHeight;
      const key = nodes[i].tagName + "|" + (nodes[i].getAttribute("class") || "");
      let pair = memo.get(key);
      if (!pair) {
        const computed = getComputedStyle(nodes[i]);
        pair = [computed.marginTop, computed.marginBottom];
        memo.set(key, pair);
      }
      margins[i] = pair;
    }
    const realTotal = scroller.scrollHeight;
    const slots = new Array(nodes.length);
    const fragment = document.createDocumentFragment();
    const originals = [...surface.childNodes];
    const ordinal = new Map();
    nodes.forEach((node, i) => ordinal.set(node, i));
    for (const child of originals) {
      const i = ordinal.get(child);
      if (i === undefined) { fragment.append(child); continue; }
      const slot = document.createElement("div");
      slot.className = "typora-read-slot";
      slot.style.height = heights[i] + "px";
      slot.style.marginTop = margins[i][0];
      slot.style.marginBottom = margins[i][1];
      // 占位块里的纯文本让浏览器原生复制（Ctrl+A / 跨未挂载区拖选）拿到完整
      // 正文；视觉上被 color:transparent + overflow:hidden 裁掉。
      slot.textContent = plainText(nodes[i]);
      slots[i] = slot;
      fragment.append(slot);
    }
    // 还原顺序表：退出时一次 replaceChildren 回到原状。
    const replacements = originals.map(child => ordinal.has(child) ? nodes[ordinal.get(child)] : child);
    surface.replaceChildren(fragment);
    state = {nodes, slots, heights, originals: replacements, tops: null, total: 0};
    // 一次总量校准：占位盒与真实块的外边距折叠若有残差，按比例摊回，
    // 保证启用后的 scrollHeight 与真实值一致（同 CV 的做法）。
    const placed = scroller.scrollHeight;
    if (realTotal > 0 && placed > 0 && Math.abs(placed - realTotal) / realTotal > 0.005) {
      const scale = realTotal / placed;
      for (let i = 0; i < slots.length; i++) slots[i].style.height = Math.max(0, Math.round(heights[i] * scale)) + "px";
    }
    measureTops();
    stats.blocks = slots.length;
    prepared = true;
    update();
    return true;
  };

  /* ---------- 块↔源码区间绑定（只在源码变化时算一次，点击/大纲跳转共用） ---------- */
  const ensureBounds = () => bounds || computeBounds();
  const captureReadingPosition = () => {
    if (!active) return;
    const kids = surface.children;
    if (!kids.length) return;
    const top = scroller.scrollTop;
    let index = -1, base = 0;
    if (state?.tops) {
      index = Math.max(0, firstIndexAtOrAfter(state.tops, top + 1) - 1);
      base = state.tops[index] ?? 0;
    } else {
      let low = 0, high = kids.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (kids[middle].offsetTop <= top) low = middle + 1; else high = middle;
      }
      index = Math.max(0, low - 1);
      base = kids[index]?.offsetTop ?? 0;
    }
    if (index >= 0) readingAnchor = {index, delta: top - base, source: api.getValue()};
  };
  const restoreReadingPosition = () => {
    const anchor = readingAnchor;
    if (!anchor || anchor.source !== api.getValue()) return false;
    const kids = surface.children;
    const child = kids[Math.min(anchor.index, kids.length - 1)];
    if (!child) return false;
    const base = state?.tops?.[anchor.index] ?? child.offsetTop;
    scroller.scrollTop = Math.max(0, base + anchor.delta);
    update();
    return true;
  };
  const computeBounds = () => {
    const markdown = source || api.getValue();
    const started = performance.now();
    const locations = documentLocations(api, markdown);
    const parsed = performance.now();
    const surfaceBlocks = bindCoarseBlocks(locations, surface, true);
    const bound = performance.now();
    const editorBlocks = bindCoarseBlocks(locations, editor[editor.currentMode]?.element || editor.ir.element, true);
    bounds = {source: markdown, surface: surfaceBlocks, editor: editorBlocks};
    stats.bindMs = +(performance.now() - started).toFixed(1);
    stats.parseMs = +(parsed - started).toFixed(1);
    stats.surfaceBindMs = +(bound - parsed).toFixed(1);
    stats.editorBindMs = +(performance.now() - bound).toFixed(1);
    return bounds;
  };

  const prepare = () => {
    clearTimeout(poll);
    if (!active || prepared || preparing) return;
    preparing = true;
    // 窗口化必须等公式队列清空：未渲染公式的块更矮，量出来的占位高度会系统性
    // 偏小（同 large-doc.js 的 CV）。这段时间阅读面已经可用，只是还在全量 DOM 上。
    notify("正在生成阅读视图…", true);
    const started = performance.now();
    let stable = 0, previous = -1;
    const attempt = () => {
      poll = 0;
      if (disposed || !active) { preparing = false; notify(""); return; }
      if (!surface.isConnected) { preparing = false; notify(""); return; }
      const count = surface.childElementCount;
      if (count && count === previous) stable++; else stable = 0;
      previous = count;
      // Vditor 的 preview.render 是延迟 + 异步的：块数连续两次不变才算成型。
      // 公式队列未清空时量高度会系统性偏小（未渲染公式的块更矮）。
      const settled = count > 0 && stable >= 2 && !window.__typoraMathStats?.pending;
      if (settled || performance.now() - started > 90000) {
        const value = api.getValue();
        // 绑定必须赶在窗口化之前：窗口化后渲染面里只剩占位盒，块种类识别会失败。
        // 位置表按源码建、与布局无关，所以只在源码变化时重算（窗口缩放只需重量高度）。
        if (!bounds || bounds.source !== value) { source = value; bounds = null; computeBounds(); }
        const started2 = performance.now();
        windowize();
        stats.windowMs = performance.now() - started2;
        stats.prepares++;
        preparing = false;
        notify(prepared ? "阅读模式 · Esc 返回编辑" : "");
        restoreReadingPosition();
        return;
      }
      poll = setTimeout(attempt, 200);
    };
    poll = setTimeout(attempt, 200);
  };

  /* ---------- 进出 ---------- */
  const showSurface = () => {
    const button = previewButton();
    if (button && !previewShown()) { button.click(); return true; }
    if (button) return false;
    // 工具项缺失（宿主未生成 more 子菜单）时的等价路径。
    scroller.style.display = "block";
    if (editor.currentMode === "sv") editor.sv.element.style.display = "none";
    else editor[editor.currentMode].element.parentElement.style.display = "none";
    editor.preview.render(editor);
    return true;
  };
  const hideSurface = () => {
    const button = previewButton();
    if (button) { if (previewShown()) button.click(); return; }
    scroller.style.display = "none";
    editor[editor.currentMode].element.parentElement.style.display = "";
  };
  const blurEditor = () => {
    const focused = document.activeElement;
    if (focused && host.contains(focused) && !scroller.contains(focused)) focused.blur();
  };
  const enter = () => {
    if (active) return false;
    if (previewShown()) return false;   // 已是 Vditor 预览态：让用户自己用它，不接管
    if (!api.getValue().trim()) return false;
    active = true;
    saved = {scrollTop: editor[editor.currentMode]?.element?.scrollTop ?? 0};
    host.classList.add("typora-reading");
    // 滚动锚定会在窗口外内容变化时自行改 scrollTop；占位高度是逐块精确的，
    // 锚定只会带来额外抖动。
    scroller.style.overflowAnchor = "none";
    showSurface();
    blurEditor();
    scroller.tabIndex = -1;                       // 让方向键 / PageDown / 空格原生滚动阅读面
    scroller.focus({preventScroll: true});
    notify("正在生成阅读视图…", true);
    prepare();
    sync();
    return true;
  };
  const exit = () => {
    if (!active) return false;
    captureReadingPosition();
    active = false;
    clearTimeout(poll);
    clearTimeout(resizeTimer);
    poll = resizeTimer = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    teardownWindow();
    host.classList.remove("typora-reading");
    scroller.style.removeProperty("overflow-anchor");
    scroller.removeAttribute("tabindex");
    hideSurface();
    // 预览面退出后是隐藏的：不清掉就会把这次阅读的十几万节点留在编辑态常驻
    // （Vditor 原生预览模式的行为）。源码视图下预览是可见面，交给它自己维护。
    if (editor.currentMode !== "sv") {
      surface.replaceChildren();
      bounds = null;
    }
    const element = editor[editor.currentMode]?.element;
    if (element && saved) element.scrollTop = saved.scrollTop;
    saved = null;
    notify("");
    sync();
    return true;
  };
  const toggle = () => active ? exit() : enter();

  /* ---------- 点击进编辑 ---------- */
  const surfaceChild = node => {
    let current = node;
    while (current && current.parentElement !== surface) current = current.parentElement;
    return current;
  };
  const clickOffset = event => {
    if (!bounds) ensureBounds();
    const child = surfaceChild(elementAt(event.target));
    if (!child || !bounds?.surface.length) return null;
    const anchored = child.classList.contains("typora-read-slot")
      ? state?.nodes[state.slots.indexOf(child)] : child;
    if (!anchored) return null;
    const candidates = bounds.surface.filter(block => anchored.contains(block.node));
    if (!candidates.length) return null;
    const rect = child.getBoundingClientRect();
    const hit = candidates.find(block => {
      const box = block.node.getBoundingClientRect?.();
      return box?.height > 0 && event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1;
    });
    const block = hit || candidates[0];
    if (!block) return null;
    return {block, fraction: clamp01((event.clientY - rect.top) / Math.max(1, rect.height))};
  };
  const placeCaret = (offset, blocks) => {
    const root = editor[editor.currentMode]?.element;
    if (!root || !blocks?.length) return false;
    const exact = blocks.filter(block => offset >= block.start && offset <= block.end);
    const block = exact.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      || blocks.reduce((best, item) => !best ||
        Math.min(Math.abs(item.start - offset), Math.abs(item.end - offset)) <
        Math.min(Math.abs(best.start - offset), Math.abs(best.end - offset)) ? item : best, null);
    if (!block?.node) return false;
    // 只做块内按比例的落点：源码偏移与渲染文本长度并不同构，
    // 按字符比例落点比"整块开头"更接近用户点击的位置。
    const texts = sourceTextNodes(block.node);
    const total = texts.reduce((sum, text) => sum + text.length, 0);
    const fraction = clamp01((offset - block.start) / Math.max(1, block.end - block.start));
    let want = Math.round(fraction * total), consumed = 0, target = texts[texts.length - 1], at = 0;
    for (const text of texts) {
      if (want <= consumed + text.length) { target = text; at = want - consumed; break; }
      consumed += text.length;
    }
    if (!target) return false;
    root.focus({preventScroll: true});
    const selection = getSelection();
    selection.removeAllRanges();
    selection.collapse(target, Math.max(0, Math.min(at, target.length)));
    const element = target.parentElement;
    if (element && element !== root) scrollIntoViewSafe(element, {block: "center", inline: "nearest"});
    return true;
  };
  const onClick = event => {
    if (!active || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.detail > 1) return;
    const hit = clickOffset(event);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = editor[editor.currentMode]?.element;
    const scrollTop = element?.scrollTop ?? 0;
    // 退出会作废绑定表（预览面被清空），先把落点算出来再退出。
    const editorBlocks = bounds?.editor;
    const offset = Math.round(hit.block.start + (hit.block.end - hit.block.start) * hit.fraction);
    exit();
    if (!placeCaret(offset, editorBlocks) && element) element.scrollTop = scrollTop;
  };

  /* ---------- 大纲跳转 ---------- */
  // 顶层子节点序号：被窗口卸下的块没有到 surface 的父链，用窗口表反查。
  const topIndex = node => {
    let current = node;
    while (current?.parentElement && current.parentElement !== surface) current = current.parentElement;
    if (!current) return -1;
    if (current.parentElement === surface) return [...surface.children].indexOf(current);
    return state ? state.nodes.indexOf(current) : -1;
  };
  const scrollToBlock = node => {
    const index = topIndex(node);
    if (index < 0 || index >= surface.childElementCount) return false;
    const child = surface.children[index];
    // 窗口化后槽位与真实块同序同高，两条路径给出的位置一致。
    const top = state?.tops ? state.tops[index] : child.offsetTop;
    scroller.scrollTop = Math.max(0, top - 12);
    update();
    return true;
  };
  const headingFor = id => {
    if (!id) return null;
    // 目标标题多数在窗口外（未挂载），文档里查不到；绑定的块表持有全部节点，
    // 按标题 id 精确查找，不依赖大纲条目与大标题块的序号是否一一对应。
    const bound = bounds?.surface.find(block => block.kind === "heading" && block.node?.id === id);
    return bound?.node || surface.querySelector("#" + CSS.escape(id));
  };
  const onOutlineClick = event => {
    if (!active) return;
    const item = elementAt(event.target)?.closest?.("li > span[data-target-id]");
    if (!item) return;
    if (!bounds) ensureBounds();
    const heading = headingFor(item.getAttribute("data-target-id"));
    if (!heading) { stats.jumpMisses++; return; }
    stats.jumps++;
    event.preventDefault();
    event.stopImmediatePropagation();
    scrollToBlock(heading);
  };

  /* ---------- 键盘：Esc 退出、Ctrl+F/H 交回编辑态查找 ---------- */
  const onKeydown = event => {
    if (!active || event.isComposing) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented || document.querySelector("dialog[open],#typora-find")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      exit();
      return;
    }
    const key = (event.key || "").toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === "f" || key === "h")) {
      // 阅读面是窗口化的，查找栏仍工作在编辑面上：先回到编辑态再打开，
      // 否则查找结果与高亮会落在被窗口卸下的块之外。
      event.preventDefault();
      event.stopImmediatePropagation();
      const replacing = key === "h";
      exit();
      api.__typoraFind?.open(replacing);
    }
  };

  /* ---------- 宽度变化（窗口缩放 / 缩放级别 / 大纲宽度）后重排占位高度 ---------- */
  let lastWidth = 0;
  const resizeObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect?.width || 0;
    if (!active || !prepared) { lastWidth = width; return; }
    if (Math.abs(width - lastWidth) < 1) return;
    lastWidth = width;
    clearTimeout(resizeTimer);
    // 占位高度是按当前宽度量的：宽度变了必须整篇重新量一次，缩放式补偿在
    // 文本重排下误差不可控。拖动窗口期间只在停手后做一次。
    resizeTimer = setTimeout(() => {
      if (!active || !prepared) return;
      teardownWindow();
      prepare();
    }, 350);
  });

  /* ---------- 外部重载：编辑面会被整体重建，阅读视图必须先让位 ---------- */
  const setValue = api.setValue;
  api.setValue = function (...args) {
    if (active) exit();
    return setValue.apply(this, args);
  };

  const onSurfaceAttribute = () => {
    // 用户直接点了 Vditor 的预览工具项：跟随它退出，不要再点一次。
    if (active && scroller.style.display === "none") {
      captureReadingPosition();
      active = false;
      clearTimeout(poll);
      cancelAnimationFrame(frame);
      teardownWindow();
      host.classList.remove("typora-reading");
      scroller.style.removeProperty("overflow-anchor");
      scroller.removeAttribute("tabindex");
      saved = null;
      notify("");
      sync();
    }
  };

  scroller.addEventListener("scroll", schedule, {passive: true});
  surface.addEventListener("click", onClick, true);
  outline?.addEventListener("click", onOutlineClick, true);
  window.addEventListener("keydown", onKeydown, true);
  const attributes = new MutationObserver(onSurfaceAttribute);
  attributes.observe(scroller, {attributes: true, attributeFilter: ["style"]});
  resizeObserver.observe(surface);
  // 这一读发生在刚插入 2.8MB IR DOM 之后，会强制整篇文档的首次重排（实测 169ms），
  // 而它记的只是宽度基准，供 ResizeObserver 判断"宽度变了没有"。首次量取放到首屏
  // 之后：期间 ResizeObserver 自己会补上基准，读到 0 也只是多一次无害的重绑。
  afterPaint('reading-width', () => { lastWidth = surface.getBoundingClientRect().width; return true; });

  api.__typoraReading = {
    enter, exit, toggle, bind: computeBounds, get update() { return update; },
    get active() { return active; },
    get prepared() { return prepared; },
    get preparing() { return preparing; },
    get stats() { return {...stats}; },
    get bounds() { return bounds; },
  };
  return () => {
    disposed = true;
    if (active) exit();
    clearTimeout(poll);
    clearTimeout(hintTimer);
    clearTimeout(resizeTimer);
    cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", schedule);
    surface.removeEventListener("click", onClick, true);
    outline?.removeEventListener("click", onOutlineClick, true);
    window.removeEventListener("keydown", onKeydown, true);
    attributes.disconnect();
    resizeObserver.disconnect();
    api.setValue = setValue;
    status?.remove();
    delete api.__typoraReading;
  };
};
