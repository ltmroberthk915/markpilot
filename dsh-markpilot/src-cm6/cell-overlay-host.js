// The editing surface shares its cell's scroll space, outside CM's contentDOM.
const overlayOwners = new WeakMap();

export function mountCellOverlay(editor, box) {
  const host = editor.scrollDOM, text = box.firstElementChild;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  Object.assign(box.style, { position: 'absolute', pointerEvents: 'none', padding: '0px' });
  Object.assign(text.style, { pointerEvents: 'auto', width: '100%', height: '100%', boxSizing: 'border-box' });
  host.appendChild(box);
  overlayOwners.set(box, { editor, host });
}

export function ownsCellOverlay(editor, box) {
  const owner = overlayOwners.get(box);
  return !!owner && owner.editor === editor && owner.host === editor.scrollDOM &&
    box.parentElement === owner.host && box.isConnected;
}

export function readCellOverlayPlacement(editor, box, cell, source, scale) {
  if (!ownsCellOverlay(editor, box) || !cell.isConnected ||
      !editor.contentDOM.contains(cell) || !cell.contains(source)) return null;
  const host = editor.scrollDOM, h = host.getBoundingClientRect();
  const r = cell.getBoundingClientRect(), sr = source.getBoundingClientRect();
  // Use the editor's existing CSS zoom authority. Integer box sizes round,
  // while resolved CSS width can exclude a reserved scrollbar gutter.
  const sx = scale, sy = scale;
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return null;
  return {
    editor, doc: editor.state.doc, owner: overlayOwners.get(box), host, cell, source,
    left: (r.left - h.left) / sx + host.scrollLeft - host.clientLeft,
    top: (r.top - h.top) / sy + host.scrollTop - host.clientTop,
    width: r.width / sx, height: r.height / sy,
    padding: [Math.max(0, sr.top - r.top) / sy, Math.max(0, r.right - sr.right) / sx,
      Math.max(0, r.bottom - sr.bottom) / sy, Math.max(0, sr.left - r.left) / sx],
    sx, sy,
  };
}

export function applyCellOverlayPlacement(box, p) {
  if (!p || !ownsCellOverlay(p.editor, box) || overlayOwners.get(box) !== p.owner ||
      p.editor.state.doc !== p.doc || !p.cell.isConnected || !p.source.isConnected) return false;
  const styles = { left: p.left + 'px', top: p.top + 'px', width: p.width + 'px', height: p.height + 'px' };
  for (const [key, value] of Object.entries(styles)) if (box.style[key] !== value) box.style[key] = value;
  // Padding belongs to the native editable surface. Every point inside the
  // cell therefore keeps the same focus and browser selection/IME session.
  const text = box.firstElementChild, padding = p.padding.map(x => x + 'px').join(' ');
  if (text.style.padding !== padding) text.style.padding = padding;
  return true;
}
