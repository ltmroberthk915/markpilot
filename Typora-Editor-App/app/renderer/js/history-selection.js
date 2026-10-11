import {scrollIntoViewSafe} from './large-doc.js';

// History HTML merges adjacent text nodes and removes temporary caret markers.
// Store source positions independently of those incidental DOM nodes. Paths
// visit only ancestors/siblings, never a formula's rendered descendants.
const PREVIEW = '.vditor-ir__preview,.vditor-wysiwyg__preview';
const elements = parent => [...parent.children].filter(n => n.tagName !== 'WBR');
const groups = parent => {
  const result = [];
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      if (!node.length) continue;
      const last = result.at(-1);
      if (last?.[0].nodeType === 3) last.push(node);
      else result.push([node]);
    } else if (node.nodeType === 1 && node.tagName !== 'WBR') result.push([node]);
  }
  return result;
};
function point(root, node, offset) {
  const parent = node?.nodeType === 3 ? node.parentElement : node;
  if (!parent || !root.contains(parent) || parent.closest(PREVIEW)) return null;
  const route = [];
  for (let n = parent; n !== root; n = n.parentElement) {
    route.unshift([elements(n.parentElement).indexOf(n), n.tagName]);
  }
  const list = groups(parent);
  if (node.nodeType === 3 && node.length) {
    const index = list.findIndex(g => g.includes(node));
    const preceding = list[index].slice(0, list[index].indexOf(node));
    return {route, index, text: preceding.reduce((sum, n) => sum + n.length, offset)};
  }
  // Normalize empty text nodes and element boundaries to the next source node.
  const start = node.nodeType === 3 ? [...parent.childNodes].indexOf(node) : offset;
  const next = [...parent.childNodes].slice(start).find(n => list.some(g => g.includes(n)));
  const index = next ? list.findIndex(g => g.includes(next)) : list.length;
  const text = next?.nodeType === 3
    ? list[index].slice(0, list[index].indexOf(next)).reduce((sum, n) => sum + n.length, 0) : null;
  return {route, index, text};
}
function resolve(root, saved) {
  let parent = root;
  for (const [index, tag] of saved.route) {
    parent = elements(parent)[index];
    if (!parent || parent.tagName !== tag) return null;
  }
  const list = groups(parent), group = list[saved.index];
  if (saved.text !== null && saved.text !== undefined) {
    if (group?.[0]?.nodeType === 3) {
      let offset = saved.text;
      for (const node of group) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      return null;
    }
    // 【J·收束轮1】捕获时所在的文本组在重放后的 DOM 里没了——ZWSP 渲染脚手架
    // （vendored 空段/软换行尾/图片零宽锚）会被 undo 的序列化剥掉，选区就还原失败、
    // 掉到编辑面外壳层（p3zwsp -8a 四形态全红实测）。落点退到该组原来的位置：
    // 组前边界（saved.index 现在指向的正是它后面那个组）或块尾。捕获侧不动，
    // 正常路径行为不变；这里只把「原本 null→壳层」变成「面内边界」。
    if (saved.index >= list.length) return [parent, parent.childNodes.length];
    return [parent, [...parent.childNodes].indexOf(group[0])];
  }
  if (saved.index > list.length) return null;
  return [parent, group ? [...parent.childNodes].indexOf(group[0]) : parent.childNodes.length];
}
export function captureHistorySelection(root) {
  const selection = getSelection();
  if (!selection.rangeCount) return null;
  const anchor = point(root, selection.anchorNode, selection.anchorOffset);
  const focus = point(root, selection.focusNode, selection.focusOffset);
  return anchor && focus ? {anchor, focus} : null;
}
export function restoreHistorySelection(root, saved) {
  if (!saved) return false;
  const anchor = resolve(root, saved.anchor), focus = resolve(root, saved.focus);
  if (!anchor || !focus) return false;
  root.focus({preventScroll:true});
  getSelection().setBaseAndExtent(...anchor, ...focus);
  const target = focus[0].nodeType === 3 ? focus[0].parentElement : focus[0];
  if (target !== root) scrollIntoViewSafe(target, {block:'nearest', inline:'nearest'});
  return true;
}

// Undo may restore a position before queued math has regained its final height.
// Follow only that exact selection, for this short render transaction. Any new
// user action relinquishes the viewport immediately; there is no ongoing loop.
export function followHistorySelection(root, isCurrent, popover) {
  const selection = getSelection();
  const saved = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
  if (!saved[0] || !saved[2] || !root.contains(saved[0]) || !root.contains(saved[2])) return () => {};
  let frame = 0, quiet = 0, expired = false;
  const events = ['keydown', 'beforeinput', 'pointerdown', 'wheel', 'compositionstart'];
  const valid = () => {
    const s = getSelection();
    return !expired && root.isConnected && isCurrent() &&
      s.anchorNode === saved[0] && s.anchorOffset === saved[1] &&
      s.focusNode === saved[2] && s.focusOffset === saved[3] && root.contains(saved[2]);
  };
  const stop = () => {
    if (expired) return;
    expired = true;
    cancelAnimationFrame(frame); clearTimeout(quiet); clearTimeout(deadline);
    observer.disconnect(); resize.disconnect();
    for (const event of events) document.removeEventListener(event, stop, true);
    document.removeEventListener('selectionchange', changed);
    document.removeEventListener('focusin', focusChanged, true);
    window.removeEventListener('blur', stop);
  };
  const changed = () => { if (!valid()) stop(); };
  const focusChanged = event => { if (!root.contains(event.target)) stop(); };
  const measure = () => {
    frame = 0;
    if (!valid()) { stop(); return; }
    const range = document.createRange();
    range.setStart(saved[2], saved[3]); range.collapse(true);
    let rect = [...range.getClientRects()].find(r => r.height);
    // Empty cells/element boundaries may have no collapsed range rectangle.
    if (!rect) {
      const target = saved[2].nodeType === 3 ? saved[2].parentElement : saved[2];
      if (target !== root) rect = target.getBoundingClientRect();
    }
    const bounds = root.getBoundingClientRect(), scale = bounds.height / root.offsetHeight || 1;
    const top = Math.max(0, bounds.top + root.clientTop * scale) + 8;
    const bottom = Math.min(innerHeight, bounds.top + (root.clientTop + root.clientHeight) * scale) - 8;
    const element = saved[2].nodeType === 3 ? saved[2].parentElement : saved[2];
    const cell = element?.closest?.('td,th'), cellRect = cell?.getBoundingClientRect();
    // A normal-height cell should remain wholly visible, including its bottom
    // border. Very tall cells still follow the focus line rather than jumping
    // to a distant cell edge.
    if (cellRect?.height && cellRect.height <= bottom - top) rect = cellRect;
    if (rect?.height && bottom > top) {
      const delta = rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
      if (delta) root.scrollTop += delta / scale;
    }
    // Vditor positions table controls before the async math layout has settled,
    // then its scroll listener keeps using the old data-top. Refresh that native
    // anchor too, so the toolbar cannot cover the restored row. The panel lives
    // outside the editable root and never enters Markdown/history snapshots.
    if (cell && popover?.style.display === 'block' && popover.querySelector('[data-type="insertRow"]')) {
      const table = cell.closest('table'), anchor = table.offsetTop - 21;
      const y = Math.max(-8, anchor - root.scrollTop), x = Math.min(table.offsetLeft, root.clientWidth - popover.clientWidth);
      if (popover.getAttribute('data-top') !== String(anchor)) popover.setAttribute('data-top', String(anchor));
      if (Math.abs(parseFloat(popover.style.top) - y) > .1 || !popover.style.top) popover.style.top = y + 'px';
      if (Math.abs(parseFloat(popover.style.left) - x) > .1 || !popover.style.left) popover.style.left = x + 'px';
    }
    clearTimeout(quiet);
    quiet = setTimeout(() => { if (!window.__typoraMathStats?.pending) stop(); }, 350);
  };
  const schedule = () => { if (!expired && !frame) frame = requestAnimationFrame(measure); };
  const observer = new MutationObserver(schedule), resize = new ResizeObserver(schedule);
  const deadline = setTimeout(stop, 4000);
  observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class', 'style', 'data-math', 'data-empty-math']});
  if (popover) observer.observe(popover, {childList:true, attributes:true, attributeFilter:['class', 'style', 'data-top']});
  resize.observe(root);
  for (const event of events) document.addEventListener(event, stop, {capture:true, passive:true});
  document.addEventListener('selectionchange', changed);
  document.addEventListener('focusin', focusChanged, true);
  window.addEventListener('blur', stop);
  document.fonts?.ready.then(schedule);
  schedule();
  return stop;
}
