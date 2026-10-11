import {cloneSource} from './incremental-ir.js';
import {sourceKind, intentOf} from './completion-policy.mjs';
const PREVIEW = '.vditor-ir__preview,.vditor-wysiwyg__preview';
const elementAt = node => node?.nodeType === 3 ? node.parentElement : node;
function point(selection) {
  let node = selection.anchorNode, offset = selection.anchorOffset;
  if (node?.nodeType === 1) {
    const previous = node.childNodes[offset - 1], next = node.childNodes[offset];
    if (previous?.nodeType === 3) {node = previous;offset = previous.length;}
    else if (next?.nodeType === 3) {node = next;offset = 0;}
  }
  return {node, offset};
}
export function captureContext(api, includeSource = true) {
  const editor = api.vditor, mode = editor.currentMode, root = editor[mode]?.element;
  const selection = getSelection();
  if (!root?.isContentEditable || !selection.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode) ||
      elementAt(selection.anchorNode)?.closest(PREVIEW) || editor[mode].composingLock) return null;
  const {node, offset} = point(selection), text = node.nodeType === 3 ? node.data : '';
  const range = selection.getRangeAt(0).cloneRange();range.setStart(node, offset);range.collapse(true);
  const prefix = text.slice(Math.max(0, offset - 512), offset).match(/(?:\\[A-Za-z]*|\/[\p{L}\p{N}-]*|[@!][^\s]*|#[^\s#]*|[\p{L}\p{N}_./-]{2,})$/u)?.[0] || '';
  const suffix = text.slice(offset, offset + 512).match(/^[\p{L}\p{N}_./-]*/u)?.[0] || '';
  const math = elementAt(node)?.closest('[data-type="math-inline"],[data-type="math-block"]');
  const code = elementAt(node)?.closest('code');
  const local = sourceKind(text.slice(0, offset));
  const kind = math ? 'math' : code || elementAt(node)?.closest('[data-type="code-block"]') ? 'code' : local.kind;
  // Local candidates need only the caret token. A large quote/list/paragraph
  // must not disable them just because exact host source mapping is bounded.
  const context = {root, mode, node, offset, range, prefix, suffix, needle: '', caret: 0, kind,
    before: text.slice(Math.max(0, offset - 4000), offset), after: text.slice(offset, offset + 1000),
    mathBefore: kind === 'math' ? local.mathBefore || text.slice(0, offset) : '',
    mathAfter: kind === 'math' ? text.slice(offset).split(local.delimiter || '\u0000')[0] : '',
    matches() {const s = getSelection(), p = point(s);return node.isConnected && editor.currentMode === mode && s.isCollapsed && p.node === node && p.offset === offset;},
    replacement(before = prefix.length, after = 0) {
      if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || after < 0 || offset < before ||
          (node.nodeType === 3 ? offset + after > node.length : before !== 0 || after !== 0)) return null;
      const r = range.cloneRange();if (node.nodeType === 3) {r.setStart(node, offset - before);r.setEnd(node, offset + after);}return r;
    },
  };
  if (math && code?.contains(node)) {
    const left = range.cloneRange();left.selectNodeContents(code);left.setEnd(node, offset);
    const right = range.cloneRange();right.selectNodeContents(code);right.setStart(node, offset);
    context.mathBefore = left.toString().replaceAll('\u200b', '').slice(-1800);
    context.mathAfter = right.toString().replaceAll('\u200b', '').slice(0, 1200);
  }
  if (!includeSource) return context;
  const pathTo = target => {const route = []; for (let n = node; n !== target; n = n.parentNode) {if (!n.parentNode) return null; route.unshift([...n.parentNode.childNodes].indexOf(n));} return route;};
  let block = node;
  while (block.parentNode && block.parentNode !== root) block = block.parentNode;
  if (block.parentNode !== root) return context;
  let group = [block.previousSibling, block, block.nextSibling].filter(Boolean);
  // Bound preparation even for a pathological one-paragraph document. Do not
  // walk generated KaTeX subtrees or enumerate all document blocks per request.
  const bounded = blocks => {
    const stack = [...blocks];let nodes = 0, characters = 0;
    while (stack.length) {
      const current = stack.pop();
      if (++nodes > 2048) return false;
      if (current.nodeType === 3) {characters += current.length;if (characters > 32000) return false;}
      else if (!current.matches?.(PREVIEW)) for (const child of current.childNodes) {if (stack.length + nodes >= 2048) return false;stack.push(child);}
    }
    return true;
  };
  if (!bounded(group)) {group = [block];if (!bounded(group)) return context;}
  const marker = 'MDCARET' + crypto.randomUUID().replaceAll('-', '');
  const container = document.createElement('div');
  for (const original of group) {
    const clone = cloneSource(original, true);
    if (original === block) {
      let target = clone;
      for (const step of pathTo(block)) target = target?.childNodes[step];
      if (!target) return context;
      if (target.nodeType === 3) target.insertData(offset, marker);
      else target.insertBefore(document.createTextNode(marker), target.childNodes[offset] || null);
    }
    container.append(clone);
  }
  const marked = mode === 'sv' ? container.textContent : editor.lute[mode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md'](container.innerHTML);
  const caret = marked.indexOf(marker);
  if (caret < 0 || marked.indexOf(marker, caret + marker.length) >= 0 || marked.length > 32000) return context;
  const source = marked.replace(marker, '');
  const leading = source.match(/^\n*/)[0].length;
  const needle = source.replace(/^\n+|\n+$/g, '');
  const relativeCaret = caret - leading;
  if (relativeCaret < 0 || relativeCaret > needle.length) return context;
  const full = {...context, needle, caret: relativeCaret,
    before: source.slice(0, caret).slice(-4000), after: source.slice(caret).slice(0, 1000),
  };
  if (!math && !code) {
    const scanned = sourceKind(full.before);full.kind = scanned.kind;
    if (scanned.kind === 'math') {full.mathBefore = scanned.mathBefore;full.mathAfter = full.after.split(scanned.delimiter)[0];}
  }
  return full;
}

/** Add a bounded section and nearby notes only when AI is actually requested. */
export function enrichContext(api, context) {
  const editor = api.vditor, {root, mode} = context;
  let block = context.node;
  while (block.parentNode && block.parentNode !== root) block = block.parentNode;
  if (block.parentNode !== root) return {...context, intent: intentOf(context)};
  const fragments = [];let remaining = 1800, heading = '';
  const read = node => {
    const stack = [node];let nodes = 0, chars = 0;
    while (stack.length) {
      const current = stack.pop();
      if (++nodes > 256) return '';
      if (current.nodeType === 3) {chars += current.length;if (chars > 3000) return '';}
      else if (!current.matches?.(PREVIEW)) for (const child of current.childNodes) {if (stack.length + nodes > 256) return '';stack.push(child);}
    }
    if (mode === 'sv') return node.textContent;
    const clone = cloneSource(node, true);
    return editor.lute[mode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md'](clone.outerHTML || clone.textContent);
  };
  const add = node => {
    if (remaining <= 0) return;
    const source = read(node).trim();
    if (!source || context.before.includes(source) || context.after.includes(source)) return;
    const excerpt = source.slice(0, Math.min(600, remaining));remaining -= excerpt.length;fragments.push(excerpt);
  };
  if (/^H[1-6]$/.test(block.nodeName)) heading = read(block).trim().slice(0, 200);
  for (let n = block.previousSibling, i = 0; n && i < 48; n = n.previousSibling, i++) {
    if (/^H[1-6]$/.test(n.nodeName) || mode === 'sv' && /^#{1,6} /.test(n.textContent || '')) {heading = read(n).trim().slice(0, 200);break;}
    if (i < 6) add(n);
  }
  fragments.reverse();
  for (let n = block.nextSibling, i = 0; n && i < 3; n = n.nextSibling, i++) {
    if (/^H[1-6]$/.test(n.nodeName) || mode === 'sv' && /^#{1,6} /.test(n.textContent || '')) break;
    add(n);
  }
  return {...context, heading, nearby: fragments.join('\n\n'), intent: intentOf(context)};
}
