import { parser, Strikethrough } from '@lezer/markdown';
import { inlineImageAtoms } from './resource-images.js';

// One source-only projection for cells and HTML exits. The editor continues to
// own the original Markdown; these trees never become an editing document.
const underline = { resolve: 'Underline', mark: 'UnderlineMark' };
const images = new RegExp(inlineImageAtoms().source, 'iy');
const inlineParser = parser.configure([Strikethrough, {
  remove: ['IndentedCode', 'FencedCode', 'Blockquote', 'HorizontalRule',
    'BulletList', 'OrderedList', 'ATXHeading', 'HTMLBlock', 'SetextHeading', 'LinkReference'],
  defineNodes: ['Underline', 'UnderlineMark', 'SourceMath', 'SourceImage'],
  parseInline: [{
    name: 'SourceImage', before: 'HTMLTag',
    parse(cx, next, pos) {
      if (next !== 33 && next !== 60) return -1;
      images.lastIndex = pos - cx.offset;
      const match = images.exec(cx.text);
      return match ? cx.addElement(cx.elt('SourceImage', pos, pos + match[0].length)) : -1;
    },
  }, {
    name: 'Underline', before: 'HTMLTag',
    parse(cx, next, pos) {
      if (next !== 60) return -1;
      const match = /^<(\/?)u\s*>/i.exec(cx.slice(pos, Math.min(cx.end, pos + 16)));
      return match ? cx.addDelimiter(underline, pos, pos + match[0].length, !match[1], !!match[1]) : -1;
    },
  }, {
    name: 'SourceMath', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 36) return -1;
      const width = cx.char(pos + 1) === 36 ? 2 : 1;
      for (let end = pos + width; end < cx.end; end++) {
        if (cx.char(end) === 92) { end++; continue; }
        if (cx.char(end) !== 36) continue;
        if (width === 2 && cx.char(end + 1) !== 36) continue;
        if (!cx.slice(pos + width, end).trim()) return -1;
        return cx.addElement(cx.elt('SourceMath', pos, end + width));
      }
      return -1;
    },
  }],
}]);

const trees = new Map();
let cachedChars = 0;
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tags = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's', Underline: 'u' };

function treeOf(source) {
  const cached = trees.get(source);
  if (cached) { trees.delete(source); trees.set(source, cached); return cached; }
  const tree = inlineParser.parse(source);
  // Long data URIs and one-off long cells must not evict the working set or
  // retain resource HTML. Cache only source/tree, never document-specific URLs.
  if (source.length <= 16384) {
    trees.set(source, tree); cachedChars += source.length;
    while (trees.size > 256 || cachedChars > 131072) {
      const key = trees.keys().next().value;
      cachedChars -= key.length; trees.delete(key);
    }
  }
  return tree;
}

export function renderInlineSegment(value, options = {}) {
  const source = String(value ?? '');
  if (!/[\*_~`$\\<!\[]/.test(source)) return escapeText(source);
  const out = [], root = treeOf(source).topNode;
  const stack = [{ child: root.firstChild, pos: 0, end: source.length, close: '' }];
  while (stack.length) {
    const frame = stack[stack.length - 1], node = frame.child;
    if (!node || node.from >= frame.end) {
      out.push(escapeText(source.slice(frame.pos, frame.end)), frame.close);
      stack.pop(); continue;
    }
    frame.child = node.nextSibling;
    if (node.to <= frame.pos) continue;
    out.push(escapeText(source.slice(frame.pos, node.from)));
    frame.pos = Math.min(node.to, frame.end);
    const raw = source.slice(node.from, node.to), tag = tags[node.name];
    if (tag || node.name === 'Paragraph') {
      if (tag) out.push('<' + tag + '>');
      stack.push({ child: node.firstChild, pos: node.from, end: node.to, close: tag ? '</' + tag + '>' : '' });
    } else if (/^(Emphasis|Strikethrough|Underline)Mark$/.test(node.name)) {
      // Matched delimiters are hidden; unmatched delimiters remain text gaps.
    } else if (node.name === 'Escape') {
      out.push(escapeText(raw.slice(1)));
    } else if (node.name === 'InlineCode') {
      const marks = node.getChildren('CodeMark');
      const code = source.slice(marks[0].to, marks[marks.length - 1].from);
      out.push(options.code?.(code) ?? '<code>' + escapeText(code) + '</code>');
    } else if (node.name === 'SourceMath') {
      const width = raw.startsWith('$$') ? 2 : 1;
      out.push(options.math?.(raw.slice(width, -width), width === 2) ?? escapeText(raw));
    } else if (node.name === 'SourceImage') {
      images.lastIndex = 0;
      const match = images.exec(raw);
      const image = /^<img\b/i.test(raw) ? { raw } : { raw, alt: match[2], src: match[3] ?? match[4] };
      out.push(options.image?.(image) ?? escapeText(raw));
    } else if (node.name === 'Link') {
      const url = node.getChild('URL'), marks = node.getChildren('LinkMark');
      if (!url || marks.length < 2) { out.push(escapeText(raw)); continue; }
      let href = source.slice(url.from, url.to);
      if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
      out.push(options.link ? options.link(href) : escapeText(source.slice(node.from, marks[0].to)));
      stack.push({ child: node.firstChild, pos: marks[0].to, end: marks[1].from,
        close: options.link ? '</a>' : escapeText(source.slice(marks[1].from, node.to)) });
    } else {
      out.push(escapeText(raw));
    }
  }
  return out.join('');
}

export function renderInline(value, options = {}) {
  // Keep the existing source-cell / export <br> contract. Splitting precedes
  // atom parsing, so a literal <br> cannot be injected into KaTeX output.
  return String(value ?? '').split(/(<br\s*\/?>)/i)
    .map((part, index) => index % 2 ? '<br>' : renderInlineSegment(part, options)).join('');
}
