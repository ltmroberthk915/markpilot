// All geometry here uses viewport CSS pixels. Consumers own their anchors,
// vertical policy and DOM lifecycle; placement never changes editor state.
export function horizontalFrame({left, right, preferredLeft, naturalWidth, center = false}) {
  if (![left, right, preferredLeft, naturalWidth].every(Number.isFinite) ||
      right <= left || naturalWidth <= 0) return null;
  const maxWidth = right - left;
  const width = Math.min(naturalWidth, maxWidth);
  const x = center ? left + (maxWidth - width) / 2
    : Math.max(left, Math.min(preferredLeft, right - width));
  return {left: x, width, maxWidth};
}

export function localPoint({left, top}, parent) {
  const z = parent.zoom;
  if (!Number.isFinite(z) || z <= 0) return null;
  return {
    left: (left - parent.left) / z - parent.clientLeft + parent.scrollLeft,
    top: (top - parent.top) / z - parent.clientTop + parent.scrollTop,
  };
}

export function horizontalScrollbarHit(box, x, y) {
  if (box.scrollWidth <= box.clientWidth) return false;
  const trackTop = box.top + (box.clientTop + box.clientHeight) * box.zoom;
  const trackBottom = box.bottom - box.borderBottom * box.zoom;
  return trackBottom > trackTop && x >= box.left && x <= box.right &&
    y >= trackTop && y < trackBottom;
}
