/** Reconcile source snapshots without destroying unchanged rendered subtrees.
 * No rendered HTML is copied into history: the live DOM itself is the cache.
 */
import {cloneSource} from './incremental-ir.js';
const PREVIEW = '.vditor-ir__preview';
const keyOf = html => /^<[^>]+data-type="toc-block"/.test(html) ? 'generated-toc'
  : html.replace(/<wbr\s*\/?>/g, '').replace(/ id="[^"]*"/g, '');
// 【P4】definitions 是纯函数，对同一字符串 memoize（LRU，4 条）没有任何语义
// 差别；撤销跳步循环里相邻两次 reconcile 常对着同一段旧文本各扫一遍正则，
// 这里把重复的那遍省掉。逐块缓存的改法（按块拼 definitions）会改变跨块匹配
// 的边界语义，不做——保真优先于速度。
const defsMemo = new Map();
const definitions = text => {
  if (defsMemo.has(text)) {
    const hit = defsMemo.get(text);
    defsMemo.delete(text); defsMemo.set(text, hit);
    return hit;
  }
  const value = (text.match(/\\(?:gdef|xdef|edef|global|def|newcommand|renewcommand|providecommand|let|futurelet)\b[^\n]*/g) || []).join('\n');
  defsMemo.set(text, value);
  if (defsMemo.size > 4) defsMemo.delete(defsMemo.keys().next().value);
  return value;
};
// 【P4】模板节点若不含预览/展开态/生成目录这三类子树，cloneSource(node) 的
// 序列化与 node.outerHTML 逐字节相同（cloneSource 的全部可观察特殊处理都挂在
// 这三类子树与节点自身的展开类上）。命中时跳过"克隆一遍再序列化"，撤销跳步
// 循环的每步 reconcile 少一遍 O(全文) 的 JS 克隆分配；条件不满足时走原路径，
// 输出不变。sourceBlocks 侧无需改动：块级条目本就按节点 WeakMap 缓存，跨步
// 复用同一批存活节点。
const CLONE_SENSITIVE = '.vditor-ir__preview,[data-type="toc-block"],.vditor-ir__node--expand';
const normalizedHTML = node => (node.nodeType !== 1 ||
    node.matches('[data-type="toc-block"],.vditor-ir__node--expand') ||
    node.querySelector(CLONE_SENSITIVE))
  ? cloneSource(node).outerHTML : node.outerHTML;
const previewKey = preview => {
  const code = preview.previousElementSibling, child = preview.firstElementChild;
  if (!code || !child) return null;
  // Only reusable, source-mapped KaTeX nodes. Stateful diagram widgets keep
  // Vditor's normal lifecycle; source changes never borrow an old rendering.
  if (!child.matches('.language-math[data-math]') && !child.matches('.language-math')) return null;
  // Zero-width markers are caret anchors, not math source: WYSIWYG rebuilds
  // differ from rendered nodes only by them, so they must not break identity.
  const text = code.textContent.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
  if (child.hasAttribute('data-math') && child.getAttribute('data-math') !== text) return null;
  // Inline and block formulas both expose a .language-math child, so a block
  // preview (katex-display) could otherwise be transplanted into an inline
  // node, painting a tall display box inside the source line (v2.0.4 report).
  const kind = code.tagName === 'CODE' ? 'inline' : 'block';
  return kind + ':' + child.tagName + ':' + text;
};
export function preserveIR(api, operation) {
  const e=api.vditor, root=e.ir.element;
  if (e.currentMode !== 'ir' || Object.hasOwn(root,'innerHTML')) return operation();
  const native=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  Object.defineProperty(root,'innerHTML',{
    configurable:true, get(){ return native.get.call(this); },
    set(html){ reconcile(api, String(html)); },
  });
  try { return operation(); } finally { delete root.innerHTML; }
}
/** Typing in a formula-bearing block rebuilds that block, flashing its other
 * already-rendered formulas back to source until the scheduler re-renders.
 * This guard transplants the removed rendered previews into the rebuilt
 * block synchronously (mutation microtasks run before paint), so only the
 * formula actually being edited - whose source changed and no longer matches
 * any removed preview - ever re-renders. */
export function installInputPreviewGuard(api, root, selector = PREVIEW) {
  let swapping = false;
  // Diagnostics plus a hard circuit breaker: reuse is strictly one-way
  // (fresh unrendered -> previously rendered), so a swap can never queue
  // another swap; the breaker is a last resort against foreign loops.
  // markEdit() opens the same typing window for keyboard formatting (bold,
  // italic, underline…): those rebuild blocks without ever firing
  // beforeinput, so their same-line formulas would flash back to source
  // until the idle scheduler re-renders them (user report v2.0.3).
  const stats = {batches: 0, swaps: 0, cached: 0, keys: [], tripped: false,
    markEdit() { lastEdit = performance.now(); }};
  root.__inputPreviewGuard = stats;
  // WYSIWYG removes rendered previews in one mutation batch and inserts the
  // rebuilt blank ones in a later batch, so the cache must outlive a batch.
  // Bounded (64 nodes) and self-expiring (200 idle batches).
  const cache = new Map();
  let cacheSize = 0, lastUse = 0;
  // The guard exists for typing rebuilds. A click (open formula, caret move)
  // also rebuilds blocks in WYSIWYG and must NOT have its fresh preview
  // replaced, or the opened formula would snap shut again. beforeinput fires
  // for every real edit (keys, IME, paste) before the DOM changes and never
  // for clicks, so a short window after it is a deterministic discriminator.
  let lastEdit = 0;
  const beforeInput = () => { lastEdit = performance.now(); };
  root.addEventListener('beforeinput', beforeInput, true);
  const collect = (node, list) => {
    if (node.nodeType !== 1) return;
    if (node.matches(selector)) list.push(node);
    if (node.querySelectorAll) list.push(...node.querySelectorAll(selector));
  };
  const observer = new MutationObserver(records => {
    stats.batches++;
    if (swapping) return;
    const removed = [], added = [];
    for (const record of records) {
      for (const node of record.removedNodes) collect(node, removed);
      for (const node of record.addedNodes) collect(node, added);
    }
    if (stats.batches - lastUse > 200) { cache.clear(); cacheSize = 0; }
    for (const preview of removed) {
      // Only reuse rendered output. Caching an unrendered preview would let
      // a later swap trade a rendered node for a blank one, handing the math
      // scheduler endless re-renders (the table-completion hot loop).
      // A render without any inline positioning (vlist/pstrut styles) is a
      // stripped corpse (v2.0.4: Vditor's post-input [style] cleanup used to
      // delete KaTeX's geometry before removal); caching it would preserve a
      // collapsed layout forever. Let it re-render instead.
      if (!preview.querySelector('.katex') || !preview.querySelector('[style]')) continue;
      const key = previewKey(preview);
      if (!key) continue;
      if (!cache.has(key)) cache.set(key, []);
      cache.get(key).push(preview); cacheSize++; lastUse = stats.batches; stats.cached++;
      stats.keys.push(key); if (stats.keys.length > 8) stats.keys.shift();
    }
    while (cacheSize > 64) {
      let dropped = false;
      for (const [key, queue] of cache) {
        queue.shift(); cacheSize--; dropped = true;
        if (!queue.length) cache.delete(key);
        break;
      }
      if (!dropped) break;
    }
    if (!cacheSize || !added.length) return;
    if (performance.now() - lastEdit > 400) return; // not a typing rebuild
    swapping = true;
    try {
      for (const preview of added) {
        if (!preview.isConnected || preview.querySelector('.katex')) continue;
        // Opening a formula for editing (click-to-expand) rebuilds its block
        // with the code focused; restoring the preview there would snap it
        // shut again. Only formulas away from the caret are transplanted.
        const code = preview.previousElementSibling;
        if (code && code.contains(getSelection().anchorNode)) continue;
        const key = previewKey(preview);
        const cached = key && cache.get(key)?.shift();
        if (cached) cacheSize--;
        // A cached node may have been re-attached by reconcile since; a live
        // node must never be stolen from its current position. Stale inline
        // geometry (a previous expanded layout) must not travel with it.
        if (cached && !cached.isConnected) { lastUse = stats.batches; cached.removeAttribute('style'); preview.replaceWith(cached); stats.swaps++; }
      }
      if (stats.swaps > 2000 && !stats.tripped) {
        stats.tripped = true;
        observer.disconnect();
        console.error('input preview guard circuit breaker tripped; guard disabled');
      }
    } finally { swapping = false; }
  });
  observer.observe(root, {childList: true, subtree: true});
  return () => { observer.disconnect(); root.removeEventListener('beforeinput', beforeInput, true); };
}
function reconcile(api, html) {
  const started=performance.now(), e=api.vditor, root=e.ir.element;
  const old=e.__typoraPerformance.sourceBlocks();
  const template=document.createElement('template');template.innerHTML=html;
  const sameMacros=definitions(old.map(item=>item.html).join('')) === definitions(html);
  const blocks=new Map(), previews=new Map();
  for (const item of old) {
    const key=keyOf(item.html);
    if (!blocks.has(key)) blocks.set(key,[]);
    blocks.get(key).push(item.node);
  }
  const stats={retainedBlocks:0, retainedPreviews:0, changedBlocks:0, ms:0};
  const used=new Set();
  const desired=[...template.content.childNodes].map(node=>{
    if (node.nodeType!==1 || node.matches('wbr') || node.querySelector('wbr') || !sameMacros) return node;
    const normalized=normalizedHTML(node);
    const match=blocks.get(keyOf(normalized))?.shift();
    if (!match) return node;
    used.add(match);stats.retainedBlocks++;
    match.querySelectorAll?.('.vditor-ir__node--expand').forEach(n=>n.classList.remove('vditor-ir__node--expand'));
    match.classList?.remove('vditor-ir__node--expand');
    return match;
  });
  if (sameMacros) for (const {node} of old) {
    if (used.has(node)) continue;
    for (const preview of node.querySelectorAll?.(PREVIEW) || []) {
      if (!preview.querySelector('.language-math[data-math]')) continue;
      if (!preview.querySelector('.katex')) continue; // never reuse blank output
      if (!preview.querySelector('[style]')) continue; // stripped corpse (v2.0.4)
      const key=previewKey(preview);
      if (!key) continue;
      if (!previews.has(key)) previews.set(key,[]);
      previews.get(key).push(preview);
    }
  }
  for (const node of desired) {
    if (used.has(node)) continue;
    stats.changedBlocks++;
    for (const preview of node.querySelectorAll?.(PREVIEW) || []) {
      const key=previewKey(preview), cached=key && previews.get(key)?.shift();
      if (cached) { preview.replaceWith(cached);stats.retainedPreviews++; }
    }
  }
  // Remove discarded nodes first; leave retained blocks attached and in order.
  const keep=new Set(desired);
  for (const node of [...root.childNodes]) if (!keep.has(node)) node.remove();
  let cursor=root.firstChild;
  for (const node of desired) {
    if (node===cursor) cursor=cursor.nextSibling;
    else root.insertBefore(node,cursor);
  }
  stats.ms=performance.now()-started;
  e.__typoraRenderReuse=stats;
}
