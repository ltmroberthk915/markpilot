// Which formula the active cell's caret is editing, and where its render may sit.
// The cell keeps its native source text; these are the only two decisions the
// preview makes, so they stay free of editor state, KaTeX and the DOM.
import { inlineMathSpans } from './inline-format.js';

export const CELL_PREVIEW_GAP = 4;
export const CELL_PREVIEW_MIN_HEIGHT = 18;

/* The formula under the caret, using the body's own grammar
 * (inline-format's SourceMath: inline $…$, single-line display $$…$$, escaped
 * dollars and inline code protected). Boundaries match正文:
 *   · the caret may sit on either delimiter: `$x|$` and `|$x$` both count, and so
 *     does the moment just after the closing dollar (`$x$|`, the "just finished
 *     typing it" case);
 *   · when two formulas share that boundary, the one the caret is *closing*
 *     wins, because that is the formula being written;
 *   · a plain-text caret yields null, so no stale render can survive a move.
 * A $$…$$ that owns the whole cell content is the cell's single-line display
 * formula (same rule as a whole-line block in the body); a $$…$$ embedded in
 * other text stays inline, exactly like a mid-line one. */
export function cellMathTarget(text, caret) {
  const source = String(text ?? '');
  if (!source.includes('$')) return null;
  const offset = Number(caret);
  if (!Number.isFinite(offset)) return null; // NaN/Infinity：不是光标，宁可不画也不画错
  const head = Math.max(0, Math.min(source.length, Math.round(offset)));
  let pick = null;
  for (const span of inlineMathSpans(source)) {
    if (head < span.from || head > span.to) continue;
    if (!span.tex || !span.tex.trim()) continue; // `$$` / `$ $`: delimiters only
    if (!pick || (head === span.to && pick.to !== head)) pick = span;
  }
  if (!pick) return null;
  const first = source.length - source.trimStart().length;
  const last = first + source.trim().length;
  // Only a whole-cell $$…$$ is the display form; the cell renderer itself keeps
  // every other formula inline, and so does a mid-line $$…$$ in the body.
  const display = pick.width === 2 && pick.from === first && pick.to === last;
  return { from: pick.from, to: pick.to, width: pick.width, display,
    tex: display ? pick.tex.trim() : pick.tex };
}

/* Placement policy in viewport CSS pixels (every input comes from
 * getBoundingClientRect, so zoom is already baked in and is divided out exactly
 * once when the caller writes local coordinates).
 * Prefer the strip just under the cell — the cell's own source stays readable —
 * then the strip above it when the card would leave the editor band, and only
 * when neither side holds it, clamp inside the band on the roomier side and let
 * the card scroll instead of spilling a long formula off screen. The card is
 * never narrower than the column allows and never wider than the visible
 * column, so a narrow cell yields a readable card instead of a squeezed one.
 * The card never covers the cell it belongs to unless the band has no room at
 * all on either side. */
export function placeCellMathPreview(options) {
  const { cell, bounds, column, width, height,
    gap = CELL_PREVIEW_GAP, minimumHeight = CELL_PREVIEW_MIN_HEIGHT } = options || {};
  const finite = value => Number.isFinite(value);
  if (!cell || !bounds || !column) return null;
  if (![cell.left, cell.right, cell.top, cell.bottom, bounds.top, bounds.bottom,
    column.left, column.right, width, height].every(finite)) return null;
  const columnWidth = column.right - column.left;
  const band = bounds.bottom - bounds.top;
  if (!(columnWidth > 0) || !(band > 0) || !(width > 0) || !(height > 0)) return null;
  const cardWidth = Math.min(width, columnWidth);
  const left = Math.max(column.left, Math.min(cell.left, column.right - cardWidth));
  const scrollX = cardWidth < width;
  const below = cell.bottom + gap;
  const belowRoom = Math.max(0, bounds.bottom - below);
  const aboveBottom = cell.top - gap;
  const aboveTop = aboveBottom - height;
  const aboveRoom = Math.max(0, aboveBottom - bounds.top);
  // Choose a side that can hold the card whole; a formula taller than the band
  // can never fit, so it only has to be *placed*, then scrolled inside.
  const fitHeight = Math.min(height, band);
  const frame = (top, room, placement) => ({
    left, top, width: cardWidth, maxHeight: room, placement,
    scrollX, scrollY: room + 0.5 < height,
  });
  if (belowRoom >= fitHeight) return frame(below, belowRoom, 'below');
  if (aboveRoom >= fitHeight) return frame(Math.max(bounds.top, aboveTop), aboveRoom, 'above');
  const useBelow = belowRoom >= aboveRoom;
  const room = Math.min(band, Math.max(useBelow ? belowRoom : aboveRoom, minimumHeight));
  // Roomier side cannot hold it whole: keep it inside the band there and scroll
  // internally rather than covering the cell or spilling out of the editor.
  const top = Math.max(bounds.top, Math.min(useBelow ? below : aboveBottom - room, bounds.bottom - room));
  return { left, top, width: cardWidth, maxHeight: room, placement: 'clamped', scrollX, scrollY: room + 0.5 < height };
}

// The render key of a resolved target: the preview only re-parses when this
// changes, so the same formula keeps the exact same mounted KaTeX nodes.
export function cellPreviewRenderKey(target) {
  return target ? (target.display ? 'B' : 'I') + target.tex : '';
}

/* Whether the card is worth showing at all: the cell must still intersect the
 * editor band. A cell scrolled out of view hides its card without discarding the
 * rendered nodes, so scrolling back only repositions. */
export function cellPreviewOnscreen(cell, bounds) {
  if (!cell || !bounds) return false;
  return cell.bottom > bounds.top && cell.top < bounds.bottom;
}

/* Whether the card already holds this formula's render. Identity is the mounted
 * element itself (not its parent), so a caret move inside the formula, a scroll,
 * a resize or a re-measure never rebuilds KaTeX nodes. A detached/emptied card
 * (new overlay box, failed parse) is never current. */
export function cellPreviewIsCurrent(state, key, card) {
  return !!state && !!key && state.key === key && state.dom === card && !!state.rendered;
}

/* A card that fits is pure paint: pointer-events stay off so a click anywhere on
 * it still lands on the cell's source (never a focus/caret steal). Only a card
 * that actually has something to scroll becomes interactive — that is the one
 * case where the user must be able to drag its scrollbar to read the rest of a
 * long formula. Computed from the rendered element as well, so a formula whose
 * text overflows horizontally (scrollWidth) also qualifies. */
export function cellPreviewInteractive(placement, card = null) {
  if (!placement) return false;
  if (placement.scrollX || placement.scrollY) return true;
  if (!card) return false;
  const slack = (card.scrollWidth - card.clientWidth) > 1 || (card.scrollHeight - card.clientHeight) > 1;
  return slack;
}

// Viewport placement -> the overlay box's local CSS pixels. One division by the
// editor zoom, nothing else: the box already lives in the scroller's scroll
// space, so scrolling needs no correction and zoom is the only conversion.
export function cellPreviewLocal(placement, box, zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (!placement || !box) return null;
  return {
    left: (placement.left - box.left) / z,
    top: (placement.top - box.top) / z,
    width: placement.width / z,
    maxHeight: placement.maxHeight / z,
  };
}
