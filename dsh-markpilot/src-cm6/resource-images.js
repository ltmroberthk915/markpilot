import { scanFenceLines } from './markdown-context.js';

// Export and SaveAs consume the same source grammar. A code atom wins by its
// position, so examples inside code never become file-system dependencies.
export const inlineImageAtoms = () => /`([^`]+)`|<img\b[^>]*>|!\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))(?:\s+["'][^"']*["'])?\)/gi;
export const decodeImageAttribute = value => String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>' }, lower = entity.toLowerCase();
  if (named[lower] != null) return named[lower];
  const number = lower.startsWith('&#x') ? parseInt(lower.slice(3),16) : parseInt(lower.slice(2),10);
  return number > 0 && number <= 0x10ffff && (number < 0xd800 || number > 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
});
export function collectImageRefs(md) {
  const lines = String(md).split('\n'), blocks = scanFenceLines(lines), refs = new Set();
  let block = 0;
  for (let i = 0; i < lines.length; i++) {
    while (blocks[block]?.endLine < i + 1) block++;
    if (blocks[block] && blocks[block].startLine <= i + 1) continue;
    for (const m of lines[i].matchAll(inlineImageAtoms())) {
      if (m[1] != null) continue;
      if (m[2] != null) refs.add((m[3] != null ? m[3] : m[4]).trim());
      else {
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]);
        if (src) refs.add(decodeImageAttribute(src[1] ?? src[2]).trim());
      }
    }
  }
  refs.delete('');
  return [...refs];
}
