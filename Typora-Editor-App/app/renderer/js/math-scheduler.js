/** Cooperative KaTeX work; loaded once per webview, shared by editor/outline. */
export const prepareMathScheduling = () => {
  if (window.__typoraScheduleMath) return;
  const tocSources = new WeakMap();
  window.__typoraUpdateToc = (node, html) => {
    if (tocSources.get(node) === html && node.childNodes.length) return;
    node.innerHTML = html;
    tocSources.set(node, html);
  };
  const scripts = new Map();
  window.__typoraLoadScript = (url, id) => {
    if (scripts.has(id)) return scripts.get(id);
    if (document.getElementById(id)) return Promise.resolve(true);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => { script.id = id; resolve(true); };
      script.onerror = () => {
        scripts.delete(id);
        script.remove();
        reject(new Error("Unable to load " + url));
      };
      document.head.append(script);
    });
    scripts.set(id, promise);
    return promise;
  };

  const jobs = new Map();
  const prepared = new Map();
  const near = new Set();
  const copied = new WeakSet();
  const markupCache = new Map();
  let cacheChars = 0;
  let libraries = null;
  let ready = false;
  let timer = 0;
  let idle = 0;
  let frame = 0;
  let viewportFrame = 0;
  let commitFrame = 0;
  let pausedUntil = 0;
  let composing = false;
  // Global TeX definitions depend on document order. Keep FIFO in that case.
  let orderedMacros = false;
  const stats = {rendered: 0, slices: 0, commits: 0, maxSliceMs: 0, maxCommitMs: 0, gated: 0,
    get pending() { return jobs.size + prepared.size; }};
  window.__typoraMathStats = stats;
  const prioritizeViewport = () => {
    if (viewportFrame || !stats.pending) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      near.clear();
      // 阅读面（.vditor-preview）在源码视图与阅读模式下是可见渲染面：
      // 只优先编辑面会让这两处的视口内公式退到 FIFO 队尾。
      const root = [...document.querySelectorAll(".vditor-ir .vditor-reset,.vditor-wysiwyg .vditor-reset,.vditor-preview .vditor-reset")]
        .find(node => node.getClientRects().length);
      if (!root) return;
      const view = root.getBoundingClientRect();
      const blocks = root.children;
      let lo = 0, hi = blocks.length;
      // Top-level blocks are in vertical order. A binary search on scrolling
      // avoids tracking/recomputing thousands of formula intersection boxes
      // after every background render.
      while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        if (blocks[middle].getBoundingClientRect().bottom < view.top - 800) lo = middle + 1;
        else hi = middle;
      }
      for (let i = lo; i < blocks.length; i++) {
        if (blocks[i].getBoundingClientRect().top > view.bottom + 800) break;
        for (const node of blocks[i].querySelectorAll(".language-math")) if (jobs.has(node) || prepared.has(node)) near.add(node);
      }
      schedule();
    });
  };

  // ---- windowed math rendering (very large IR documents only) ----------------
  // KaTeX trees are 84% of all DOM nodes (229,561 of 272,411) and ~540MB of renderer
  // private bytes on the 5,689-formula fixture. Fresh-load A/B, interleaved, gc() before
  // every reading: .perf/math-perf-a5.json 1131MB with math vs .perf/math-perf-b5.json
  // 591MB without. Freeing them after the fact returns nothing to the OS -- an in-place
  // ablation of all 224k nodes left privateBytes at 1048-1080MB -- because Chromium's
  // allocator keeps the pool. So the only way to save the memory is to never allocate it:
  // render what is near the viewport and hand the rest back to its source text, which lets
  // the pool be reused instead of grown. The markdown read-back is unaffected by
  // construction (incremental-ir.js reads the sibling source `code`, and Lute skips
  // `data-render` previews), verified end to end: swapping every preview for its source
  // text left vditor.getValue() byte-identical (mdDelta 0 in every probe run).
  // Opt out with localStorage.mathWindow = 'off'.
  // Everything from the top of the document down to one look-ahead band below the viewport is
  // rendered; nothing above that line is ever taken away again. Two properties fall out of the
  // one-way rule: the height of every block above the viewport is exact, so the saved scroll
  // offset that util.js restores right after open still lands on the same content (the
  // frontier walks down to meet it), and content can never shift under the reader because
  // nothing above them is removed.
  // The markdown read-back is unaffected by construction (incremental-ir.js serializes the
  // sibling source `code` and Lute skips `data-render` previews), verified end to end:
  // swapping every preview for its source text left vditor.getValue() byte-identical
  // (mdDelta 0 in every probe run). Opt out with localStorage.mathWindow = 'off'.
  const GATE_THRESHOLD = 1500;   // top-level blocks; same scale as large-doc.js
  const LOOKAHEAD = 2;           // viewport heights rendered below the viewport
  const COMMIT_BATCH = 64;
  let gateEnabled = true;
  try { gateEnabled = localStorage.getItem("mathWindow") !== "off"; } catch { /* no storage */ }
  let latest = null;
  let windowFrame = 0;
  let windowTimer = 0;
  let windowRetries = 0;
  let windowCatchUps = 0;
  let frontier = 0;
  let cutoff = 0;
  let blockCount = 0;
  const parkedBlock = new WeakMap();
  const parked = new Set();
  const parkedByBlock = new Map();
  window.__typoraMathWindow = {mode: gateEnabled ? "on" : "off",
    get parked() { return parked.size; }, get frontier() { return frontier; },
    get cutoff() { return cutoff; }, get rendered() { return stats.rendered; }};
  // Only the IR edit surface is gated. The reading surface (.vditor-preview) builds its own
  // windowed copy whose slot heights must be measured from fully rendered blocks, and the
  // outline renders on demand, so neither may be starved of its formulas.
  const editSurface = node => node.closest?.(".vditor-ir .vditor-reset") || null;
  const areaOf = surface => {
    const view = surface.getBoundingClientRect();
    return view.height ? {surface, view, margin: view.height * LOOKAHEAD} : null;
  };
  const blockOf = (node, surface) => {
    let block = node;
    while (block && block.parentNode !== surface) block = block.parentNode;
    return block?.parentNode === surface ? block : null;
  };
  const admits = node => {
    if (!gateEnabled || orderedMacros) return true;
    const surface = editSurface(node);
    if (!surface || surface.childElementCount < GATE_THRESHOLD) return true;
    const area = areaOf(surface);
    if (!area) return false; // not laid out yet: park it and retry on the next refresh
    const block = blockOf(node, surface);
    return !!block && block.getBoundingClientRect().top <= area.view.bottom + area.margin;
  };
  // Parked formulas are indexed by their top-level block, so the catch-up walk crosses a
  // block with one map lookup instead of a geometry read per formula in the document.
  const park = node => {
    const surface = editSurface(node);
    const block = surface && blockOf(node, surface);
    if (!block) return false;
    parked.add(node);
    parkedBlock.set(node, block);
    let waiting = parkedByBlock.get(block);
    if (!waiting) parkedByBlock.set(block, waiting = new Set());
    waiting.add(node);
    stats.gated++;
    return true;
  };
  const unpark = node => {
    if (!parked.delete(node)) return;
    stats.gated = Math.max(0, stats.gated - 1);
    const block = parkedBlock.get(node);
    parkedBlock.delete(node);
    const waiting = block && parkedByBlock.get(block);
    if (waiting) { waiting.delete(node); if (!waiting.size) parkedByBlock.delete(block); }
  };
  const enqueue = (node, options) => {
    const adapter = Vditor.adapterRender.mathRenderAdapter;
    const source = adapter.getCode(node).replace(/\u00a0/g, " ");
    if (prepared.get(node)?.source === source) return false;
    prepared.delete(node);
    if (!orderedMacros && /\\(?:gdef|xdef|edef|global|def|newcommand|renewcommand|providecommand|let|futurelet)\b/.test(source)) {
      // Document-wide TeX definitions make the queue order-semantic, which a viewport
      // window cannot honour, so the whole document goes back to plain FIFO.
      orderedMacros = true;
      markupCache.clear(); cacheChars = 0;
      for (const waiting of parked) jobs.set(waiting, {math: options.math || {}});
      parked.clear(); parkedByBlock.clear(); stats.gated = 0;
    }
    jobs.set(node, {math: options.math || {}});
    return true;
  };
  const refreshWindow = () => {
    if (windowFrame || !gateEnabled || orderedMacros) return;
    windowFrame = requestAnimationFrame(() => {
      windowFrame = 0;
      if (document.hidden || composing || !latest) return;
      // 【P8】失联清扫：undo/裁剪缩短文档后，被移除的块仍以键的形式留在
      // parkedByBlock 里（块节点游离，parentElement 断开或不再连接）。遍历
      // 窗口时顺手把这些键连同它们的 parked 公式一起释放（unpark 保持
      // parked/parkedBlock/stats.gated 三处记账一致），数学窗口不再随编辑
      // 历史单向增长。保留判定用 isConnected：reconcile 复用的块会重新挂回
      // 同一 surface，不会被误清。
      for (const block of [...parkedByBlock.keys()]) {
        const surface = block.parentElement;
        if (surface && surface.isConnected) continue;
        for (const node of [...(parkedByBlock.get(block) || [])]) unpark(node);
      }
      const options = latest;
      let admitted = 0, unlaid = false, behind = false;
      for (const surface of new Set([...parkedByBlock.keys()].map(block => block.parentElement))) {
        if (!surface?.isConnected || surface.childElementCount < GATE_THRESHOLD) continue;
        const area = areaOf(surface);
        if (!area) { unlaid = true; continue; }
        const blocks = surface.children;
        // An edit can renumber every block, which makes the frontier meaningless for this
        // pass; the geometric predicate is still correct, so restart the walk from the top.
        if (blocks.length !== blockCount) { blockCount = blocks.length; frontier = 0; }
        // First block whose top is past the band: everything above it stays rendered.
        let lo = 0, hi = blocks.length;
        while (lo < hi) {
          const middle = (lo + hi) >>> 1;
          if (blocks[middle].getBoundingClientRect().top <= area.view.bottom + area.margin) lo = middle + 1;
          else hi = middle;
        }
        cutoff = lo;
        let index = Math.min(frontier, lo);
        for (; index < lo && admitted < COMMIT_BATCH; index++) {
          const waiting = parkedByBlock.get(blocks[index]);
          if (!waiting) continue;
          for (const node of [...waiting]) {
            if (admitted >= COMMIT_BATCH) break;
            unpark(node);
            if (node.isConnected && enqueue(node, options)) admitted++;
          }
        }
        frontier = index;
        if (index < lo) behind = true;
      }
      if (admitted) { windowRetries = 0; load(options); schedule(); }
      // Keep walking down to the cutoff without waiting for another scroll event: that is what
      // makes a restored scroll offset -- and any content the user has already passed -- exact.
      if (behind && windowCatchUps < 400) {
        windowCatchUps++;
        windowTimer = setTimeout(() => { windowTimer = 0; refreshWindow(); }, 0);
      }
      // The surface is often not laid out yet when the first blocks arrive (the window then
      // has no height and nothing can be admitted), so retry briefly instead of leaving the
      // parked formulas stranded with an empty queue.
      else if (unlaid && windowRetries < 60) {
        windowRetries++;
        windowTimer = setTimeout(() => { windowTimer = 0; refreshWindow(); }, 50);
      } else {
        windowCatchUps = 0;
      }
    });
  };
  const load = options => {
    if (libraries) return libraries;
    const cdn = options.cdn;
    if (!document.getElementById("vditorKatexStyle")) {
      const link = document.createElement("link");
      link.id = "vditorKatexStyle";
      link.rel = "stylesheet";
      link.href = cdn + "/dist/js/katex/katex.min.css?v=0.16.9";
      document.head.append(link);
    }
    libraries = window.__typoraLoadScript(cdn + "/dist/js/katex/katex.min.js?v=0.16.9", "vditorKatexScript")
      .then(() => window.__typoraLoadScript(cdn + "/dist/js/katex/mhchem.min.js?v=0.16.9", "vditorKatexChemScript"))
      .then(() => { ready = true; prioritizeViewport(); schedule(); })
      .catch(error => { libraries = null; console.error(error); });
    return libraries;
  };
  const commit = node => {
    const item = prepared.get(node);
    prepared.delete(node);
    near.delete(node);
    if (!item || !node.isConnected || node.hasAttribute("data-math")) return false;
    if (Vditor.adapterRender.mathRenderAdapter.getCode(node).replace(/\u00a0/g, " ") !== item.source) {
      if (!jobs.has(node)) jobs.set(node, item.job);
      return false;
    }
    node.setAttribute("data-math", item.source);
    // 空公式（源码里除了空白什么都没有）在折叠态下没有任何字形：页面上只留一块**看不见的
    // 空白**。用户报告（2026-09-17）："这个在渲染后根本无法从页面上看到, 会留下很多隐形垃圾,
    // 且无法被选中删除"。挂一个标记，由 index.css 画一枚"空公式"占位——看得见、点得到，
    // 点进去就是源码形态，退格/删除整条移除。
    if (item.source.trim()) node.removeAttribute("data-empty-math");
    else node.setAttribute("data-empty-math", "");
    node.replaceChildren(item.fragment);
    if (item.failed) node.className = "language-math vditor-reset--error";
    if (!copied.has(node)) {
      copied.add(node);
      node.addEventListener("copy", event => {
        event.stopPropagation();
        event.preventDefault();
        event.clipboardData.setData("text/html", node.innerHTML);
        event.clipboardData.setData("text/plain", node.getAttribute("data-math"));
      });
    }
    stats.rendered++;
    return true;
  };
  const render = (node, immediate = false) => {
    if (prepared.has(node)) return immediate ? commit(node) : false;
    const job = jobs.get(node);
    jobs.delete(node);
    near.delete(node);
    if (!job || !node.isConnected || node.hasAttribute("data-math")) return false;
    const adapter = Vditor.adapterRender.mathRenderAdapter;
    const source = adapter.getCode(node).replace(/\u00a0/g, " ");
    const template = document.createElement("template");
    let failed = false;
    try {
      const macros = job.math.macros || {};
      const displayMode = node.tagName === "DIV";
      const key = !orderedMacros && Object.values(macros).every(value => typeof value === "string")
        ? JSON.stringify([source, displayMode, macros]) : null;
      let markup = key && markupCache.get(key);
      if (markup) {
        markupCache.delete(key); markupCache.set(key, markup);
      } else {
        markup = window.katex.renderToString(source, {displayMode, output: "html", macros});
        if (key && markup.length + key.length < 1000000) {
          markupCache.set(key, markup); cacheChars += markup.length + key.length;
          while (markupCache.size > 128 || cacheChars > 1000000) {
            const oldest = markupCache.keys().next().value;
            cacheChars -= oldest.length + markupCache.get(oldest).length;
            markupCache.delete(oldest);
          }
        }
      }
      template.innerHTML = markup;
    } catch (error) {
      failed = true;
      template.content.append(document.createTextNode(error.message));
    }
    prepared.set(node, {source, job, fragment: template.content, failed});
    if (immediate) commit(node);
    return true;
  };
  const active = () => {
    const selection = getSelection();
    const element = selection.focusNode?.nodeType === Node.TEXT_NODE
      ? selection.focusNode.parentElement : selection.focusNode;
    const block = element?.closest?.(".vditor-ir__node");
    const math = block?.querySelector(".vditor-ir__preview .language-math");
    return jobs.has(math) || prepared.has(math) ? math : null;
  };
  const slice = deadline => {
    idle = 0;
    if (document.hidden || composing) return;
    if (performance.now() < pausedUntil) { schedule(); return; }
    // While real input is queued the work must stay tiny, but with an idle main thread
    // there is nothing to protect and a slice can be several times larger. Waiting for
    // requestIdleCallback in the idle case cost ~160ms per 64-formula batch (idle callbacks
    // fall back to their 120ms timeout), which is why a document that needs under a second
    // of CPU took 14.3s to finish: 215 slices, maxSliceMs 5.3 (.perf/math-perf-a5.json).
    const busy = navigator.scheduling?.isInputPending?.() === true;
    const budget = busy ? 4 : 8;
    const cap = busy ? 32 : COMMIT_BATCH;
    const start = performance.now();
    let count = 0;
    while ((jobs.size || near.size) && count < cap && prepared.size < COMMIT_BATCH) {
      if (navigator.scheduling?.isInputPending?.()) break;
      const node = !orderedMacros && near.size ? near.values().next().value : jobs.keys().next().value;
      if (!node) break;
      if (render(node, near.has(node))) count++;
      if (performance.now() - start >= budget || deadline.timeRemaining() < 1) break;
    }
    stats.slices++;
    stats.maxSliceMs = Math.max(stats.maxSliceMs, performance.now() - start);
    schedule();
  };
  const scheduleCommit = () => {
    if (commitFrame) return;
    commitFrame = requestAnimationFrame(() => {
      commitFrame = 0;
      if (document.hidden || composing) return;
      if (performance.now() < pausedUntil || navigator.scheduling?.isInputPending?.()) { schedule(); return; }
      const start = performance.now();
      // Fragment construction was already sliced off-DOM. Group these cheap insertions so
      // background rendering pays for layout once per batch, rather than relaying out a
      // 270k-node document for every few formulas. The batch is bounded by time, not by a
      // fixed count, so a slow frame never inherits a whole batch of forced layout.
      for (const node of [...prepared.keys()]) {
        commit(node);
        if (performance.now() - start >= 6) break;
      }
      stats.commits++;
      stats.maxCommitMs = Math.max(stats.maxCommitMs, performance.now() - start);
      schedule();
    });
  };
  function schedule() {
    if (!ready || !stats.pending || document.hidden || composing) return;
    // The formula being edited can refresh on the next frame while background
    // work is paused. The browser still owns input and IME composition.
    if (!frame && !orderedMacros && active()) frame = requestAnimationFrame(() => {
      frame = 0;
      const node = active();
      if (node && !composing) render(node, true);
      schedule();
    });
    if (timer || idle) return;
    const delay = pausedUntil - performance.now();
    if (delay > 0) {
      timer = setTimeout(() => { timer = 0; schedule(); }, delay);
    } else if (prepared.size >= COMMIT_BATCH || !jobs.size || [...near].some(node => prepared.has(node))) {
      scheduleCommit();
    } else if (navigator.scheduling?.isInputPending?.() || typeof requestIdleCallback !== "function") {
      // Input is queued: only spend genuine idle time on formulas.
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(slice, {timeout: 120});
      else timer = setTimeout(() => { timer = 0; slice({timeRemaining: () => 2}); }, 16);
    } else {
      // Nothing is waiting on us: chain slices back to back. slice() still yields on input,
      // on the 8ms budget, and on pauses after keystrokes.
      timer = setTimeout(() => { timer = 0; slice({timeRemaining: () => 8}); }, 0);
    }
  }
  const pause = () => {
    pausedUntil = performance.now() + 180;
    if (idle) { cancelIdleCallback(idle); idle = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
    schedule();
  };
  document.addEventListener("keydown", pause, true);
  document.addEventListener("beforeinput", pause, true);
  document.addEventListener("input", schedule, true);
  const onScroll = () => { prioritizeViewport(); refreshWindow(); };
  document.addEventListener("scroll", onScroll, {capture: true, passive: true});
  window.addEventListener("resize", onScroll);
  document.addEventListener("compositionstart", () => { composing = true; pause(); }, true);
  document.addEventListener("compositionend", () => { composing = false; pause(); }, true);
  document.addEventListener("visibilitychange", () => { prioritizeViewport(); refreshWindow(); schedule(); });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer); clearTimeout(windowTimer);
    cancelAnimationFrame(frame); cancelAnimationFrame(viewportFrame); cancelAnimationFrame(commitFrame); cancelAnimationFrame(windowFrame);
    if (idle) cancelIdleCallback(idle);
    timer = idle = frame = viewportFrame = commitFrame = windowFrame = windowTimer = 0;
    jobs.clear(); prepared.clear(); near.clear(); parked.clear(); parkedByBlock.clear();
    markupCache.clear(); cacheChars = 0;
  });
  window.__typoraScheduleMath = (scope, options) => {
    if (!options?.cdn || options.math?.engine && options.math.engine !== "KaTeX") return false;
    latest = options;
    const adapter = Vditor.adapterRender.mathRenderAdapter;
    for (const node of adapter.getElements(scope)) {
      const outline = node.closest('.vditor-outline');
      if (outline && outline.style.display === 'none') continue;
      if (node.hasAttribute("data-math") || node.parentElement?.matches(".vditor-wysiwyg__pre,.vditor-ir__marker--pre")) continue;
      if (prepared.get(node)?.source === adapter.getCode(node).replace(/\u00a0/g, " ")) continue;
      if (!jobs.has(node) && !admits(node) && park(node)) {
        // Out of the rendering window for now; refreshWindow() revisits it as the user
        // scrolls and enqueues the ones that come back into range.
        continue;
      }
      unpark(node);
      enqueue(node, options);
    }
    if (jobs.size) { load(options); schedule(); }
    else if (parked.size && stats.gated) refreshWindow();
    return true;
  };
};
