import { Text } from '@codemirror/state';
import { codeBody, scanFencedBlocks } from './markdown-context.js';

/* Explicit Markdown fences only.
 *
 * A bare fence and every programming-language fence stay ordinary source code.
 * The alias set is deliberately just the explicit Markdown spellings: `markdown`
 * (any case) and the common `md` alias. Flavoured names such as `gfm` and
 * `commonmark` are existing source fences and keep their current behavior.
 */
const ALIASES = new Set(['md', 'markdown']);

export function markdownFenceAlias(info) {
  const first = /^([^\s{]+)/.exec(String(info == null ? '' : info).trim());
  const word = first ? first[1].toLowerCase() : '';
  return ALIASES.has(word) ? word : null;
}

export const isMarkdownFence = info => markdownFenceAlias(info) !== null;

/** Body bytes of one fence, with its container prefix and opening indent removed.
 *  The same `codeBody` contract used by the Mermaid projection and the exporter is
 *  the only place that decides what the content of a fence is. */
export function fenceBody(doc, block) {
  const parts = [];
  for (let n = block.startLine + 1; n < block.endLine; n++) parts.push(codeBody(doc.line(n).text, block).text);
  return parts.join('\n');
}

/** Closed, explicitly Markdown fences, in source order. `src` is the exact body
 *  (inner backtick/tilde fences included) so edits round-trip byte for byte. */
export function scanMarkdownFenceBlocks(doc, blocks = scanFencedBlocks(doc)) {
  const out = [];
  for (const block of blocks || []) {
    if (!block || block.closeFrom == null || !isMarkdownFence(block.info)) continue;
    out.push({
      from: block.from,
      to: block.to,
      src: fenceBody(doc, block),
      lang: markdownFenceAlias(block.info),
      info: block.info,
      char: block.char,
      startLine: block.startLine,
    });
  }
  return out;
}

/** Mermaid sources inside a Markdown fragment, deduplicated by source text.
 *  This never recurses into Markdown previews: an inner Markdown fence is just
 *  code in the fragment renderer, exactly as it is in an exported document. */
export function fragmentMermaidSources(source) {
  const text = Text.of(String(source == null ? '' : source).split('\n'));
  const out = [];
  for (const block of scanFencedBlocks(text)) {
    if (block.closeFrom == null || !/^mermaid$/i.test(block.info || '')) continue;
    const src = fenceBody(text, block);
    if (src.trim() && !out.includes(src)) out.push(src);
  }
  return out;
}
