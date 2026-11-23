import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { frontMatterOf } from './frontmatter.js';

class MetadataPreview extends WidgetType {
  constructor(source) { super(); this.source = source; }
  eq(other) { return this.source === other.source; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'mp-frontmatter-preview';
    const fragment = document.createDocumentFragment();
    let from = 0;
    const lines = this.source.split('\n');
    for (let i = 1; i < lines.length - 1; i++) {
      from += lines[i - 1].length + 1;
      const text = lines[i], row = document.createElement('div');
      row.className = 'mp-metadata-row';
      row.dataset.sourcePos = String(from);
      // Present simple top-level mappings in columns. Indentation, block
      // scalars, comments and complex YAML stay literal and in source order.
      const pair = /^([\p{L}\p{N}_.-]+):(?:[ \t]+|$)/u.exec(text);
      if (pair) {
        const key = document.createElement('strong'), value = document.createElement('span');
        key.textContent = pair[1]; value.textContent = text.slice(pair[0].length);
        value.dataset.sourcePos = String(from + pair[0].length);
        row.append(key, value);
      } else {
        row.classList.add('mp-metadata-literal');
        row.textContent = text;
      }
      fragment.appendChild(row);
    }
    box.appendChild(fragment);
    box.addEventListener('mousedown', event => {
      if (event.button || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || view.state.readOnly) return;
      const hit = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = hit?.startContainer;
      const target = node?.nodeType === 3 && box.contains(node) ? node.parentElement : event.target;
      const row = target.closest('[data-source-pos]');
      const pos = Number(row?.dataset.sourcePos ?? 0) + (target.contains(node) && node?.nodeType === 3 ? hit.startOffset : 0);
      event.preventDefault();
      view.dispatch({ selection: {anchor: Math.min(pos, this.source.length)}, userEvent:'select.pointer' });
      view.focus();
    });
    return box;
  }
}

const presentations = new WeakMap();
export const frontMatterView = EditorView.decorations.compute(['doc', 'selection', EditorState.readOnly], state => {
  const range = frontMatterOf(state.doc);
  if (!range) return Decoration.none;
  let pair = presentations.get(range);
  if (!pair) {
    const styles = [];
    for (let i = 1; i <= range.endLine; i++) {
      styles.push(Decoration.line({class:'mp-frontmatter-source'}).range(state.doc.line(i).from));
    }
    const widget = new MetadataPreview(state.doc.sliceString(0, range.to));
    pair = {source: Decoration.set(styles), preview: Decoration.set([Decoration.replace({block:true, widget}).range(0, range.to)])};
    presentations.set(range, pair);
  }
  return !state.readOnly && state.selection.ranges.some(s => s.from <= range.to) ? pair.source : pair.preview;
});

const linkHint = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl';
export function linkAttributes(href) {
  return {class:'mp-doc-link', role:'link', tabindex:'0', 'data-mp-href':href, title:linkHint + '+单击打开链接'};
}

// Both rendered cells and CM marks forward the same click to the owning
// shell. Capture the down before either editor swaps the clicked DOM for source.
export function documentLinkGestures(open, copyHeld) {
  return ViewPlugin.define(view => {
    let press = null;
    const linkAt = e => e.target.closest?.('.mp-doc-link[data-mp-href]');
    const activation = e => !e.shiftKey && !e.altKey && !copyHeld() &&
      (view.state.readOnly || e.ctrlKey || e.metaKey);
    const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
    const down = e => {
      press = null;
      const link = linkAt(e);
      if (!link || e.button !== 0 || !activation(e)) return;
      press = { link, x:e.clientX, y:e.clientY };
      if (!view.state.readOnly) stop(e);
    };
    const move = e => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) press = null;
    };
    const click = e => {
      const link = linkAt(e), start = press; press = null;
      if (link && start?.link === link && e.button === 0 && activation(e)) {
        stop(e); open(link.dataset.mpHref);
      }
    };
    const key = e => {
      const link = linkAt(e);
      if (link && e.key === 'Enter' && !e.isComposing) { stop(e); open(link.dataset.mpHref); }
    };
    const controller = new AbortController();
    const listen = (type, fn) => view.dom.addEventListener(type, fn, { capture:true, signal:controller.signal });
    listen('pointerdown', down);
    listen('mousedown', e => { if (press && !view.state.readOnly) stop(e); });
    listen('pointermove', move);
    listen('pointercancel', () => { press = null; });
    listen('click', click);
    listen('keydown', key);
    return {destroy() {controller.abort();}};
  });
}
