import { parser, Strikethrough, InlineContext } from '@lezer/markdown';
import { inlineImageAtoms } from './resource-images.js';

// One source-only projection for cells and HTML exits. The editor continues to
// own the original Markdown; these trees never become an editing document.
const htmlMarks = {
  u: { resolve: 'Underline', mark: 'UnderlineMark' },
  sup: { resolve: 'Superscript', mark: 'SuperscriptMark' },
  sub: { resolve: 'Subscript', mark: 'SubscriptMark' },
};
const images = new RegExp(inlineImageAtoms().source, 'iy');
export function hasUnescapedDollar(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$') return true;
  }
  return false;
}
// A block occupying one line ends at its first unescaped double delimiter.
export function singleLineDisplayTex(text) {
  if (!text.startsWith('$$')) return null;
  for (let i = 2; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text.startsWith('$$', i)) return text.slice(i + 2).trim() ? null : text.slice(2, i);
  }
  return null;
}
const inlineParser = parser.configure([Strikethrough, {
  remove: ['IndentedCode', 'FencedCode', 'Blockquote', 'HorizontalRule',
    'BulletList', 'OrderedList', 'ATXHeading', 'HTMLBlock', 'SetextHeading', 'LinkReference'],
  defineNodes: ['Underline', 'UnderlineMark', 'Superscript', 'SuperscriptMark', 'Subscript', 'SubscriptMark', 'SourceMath', 'SourceImage'],
  parseInline: [{
    name: 'SourceLiteralLinkText', before: 'LinkEnd',
    parse(cx, next, pos) {
      if (next !== 93 || cx.char(pos + 1) === 40) return -1;
      const link = cx.findOpeningDelimiter(InlineContext.linkStart);
      if (link == null) return -1;
      const image = cx.findOpeningDelimiter(InlineContext.imageStart);
      if (image != null && image > link) return -1;
      const content = cx.takeContent(link);
      for (const child of content) cx.addElement(child);
      return pos + 1;
    },
  }, {
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
      const match = /^<(\/?)(u|sup|sub)\s*>/i.exec(cx.slice(pos, Math.min(cx.end, pos + 16)));
      return match ? cx.addDelimiter(htmlMarks[match[2].toLowerCase()], pos, pos + match[0].length, !match[1], !!match[1]) : -1;
    },
  }, {
    name: 'SourceMath', before: 'Emphasis',
    parse(cx, next, pos) {
      if (next !== 36) return -1;
      const width = cx.char(pos + 1) === 36 ? 2 : 1;
      for (let end = pos + width; end < cx.end; end++) {
        if (cx.char(end) === 92) { end++; continue; }
        if (cx.char(end) !== 36) continue;
        // An incomplete double-dollar atom must not donate its closing single
        // dollar to a later formula (e.g. $$a$ **bold** $B$).
        if (width === 2 && cx.char(end + 1) !== 36)
          return end + 1;
        if (!cx.slice(pos + width, end).trim())
          return width === 2 ? end + width : -1;
        return cx.addElement(cx.elt('SourceMath', pos, end + width));
      }
      return width === 2 ? pos + 2 : -1;
    },
  }],
}]);

const trees = new Map();
let cachedChars = 0;
const escapeText = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tags = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's', Underline: 'u', Superscript: 'sup', Subscript: 'sub' };

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

// Code span fences must be longer than every literal run inside the sample.
// Padding separates a literal edge backtick from its fence, and compensates
// for Markdown stripping one symmetric space from nonblank code.
export function codeSpanPadding(text) {
  return text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text) ? 1 : 0;
}
export function codeSpanMarkers(text) {
  let width = 1;
  for (const run of text.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
  const fence = '`'.repeat(width);
  const pad = text.startsWith('`') || text.endsWith('`') || codeSpanPadding(text.replace(/\r\n?|\n/g, ' ')) ? ' ' : '';
  return { open: fence + pad, close: pad + fence };
}
export function inlineCodeSpans(source) {
  if (!source.includes('`')) return [];
  const spans = [];
  treeOf(source).iterate({ enter(node) {
    if (['SourceMath', 'SourceImage', 'Image'].includes(node.name)) return false;
    if (node.name !== 'InlineCode') return;
    const marks = node.node.getChildren('CodeMark');
    const start = marks[0].to, end = marks[marks.length - 1].from;
    const pad = codeSpanPadding(source.slice(start, end).replace(/\r\n?|\n/g, ' '));
    spans.push({ from: node.from, to: node.to, innerFrom: start + pad, innerTo: end - pad });
    return false;
  } });
  return spans;
}

export function inlineEmphasisSpans(source) {
  const text = String(source ?? '');
  if (!text.includes('*')) return [];
  const out = [], stack = [treeOf(text).topNode];
  const opaque = new Set(['InlineCode', 'SourceMath', 'SourceImage', 'Image']);
  while (stack.length) {
    const node = stack.pop();
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const width = child.name === 'StrongEmphasis' ? 2 : child.name === 'Emphasis' ? 1 : 0;
      if (width && text.slice(child.from, child.from + width) === '*'.repeat(width) &&
          text.slice(child.to - width, child.to) === '*'.repeat(width))
        out.push({ from: child.from, to: child.to, width });
      if (!opaque.has(child.name)) stack.push(child);
    }
  }
  return out;
}

export function inlineStrongSpans(source) {
  return inlineEmphasisSpans(source).filter(span => span.width === 2)
    .map(({ from, to }) => ({ from, to }));
}

export function inlineMathSpans(source) {
  const text = String(source ?? '');
  if (!text.includes('$')) return [];
  const spans = [], stack = [treeOf(text).topNode];
  const opaque = new Set(['InlineCode', 'SourceImage', 'Image']);
  while (stack.length) {
    const node = stack.pop();
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'SourceMath') {
        const raw = text.slice(child.from, child.to), width = raw.startsWith('$$') ? 2 : 1;
        spans.push({ from: child.from, to: child.to, width, tex: raw.slice(width, -width) });
      } else if (!opaque.has(child.name)) stack.push(child);
    }
  }
  return spans.sort((a, b) => a.from - b.from);
}

export function inlineLinkSpans(source) {
  const s = String(source ?? '');
  if (!s.includes('[')) return [];
  const out = [];
  const skip = new Set(['Image', 'SourceImage', 'InlineCode', 'SourceMath']);
  const stack = [treeOf(s).topNode];
  while (stack.length) {
    const node = stack.pop();
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'Link') {
        if (s[child.from] !== '[') continue;
        const url = child.getChild('URL'), marks = child.getChildren('LinkMark');
        if (url && marks.length >= 2) out.push({ from: child.from, to: child.to,
          hides: [[child.from, marks[0].to], [marks[1].from, child.to]] });
      } else if (!skip.has(child.name)) stack.push(child);
    }
  }
  return out.sort((a, b) => a.from - b.from);
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
    } else if (/^(Emphasis|Strikethrough|Underline|Superscript|Subscript)Mark$/.test(node.name)) {
      // Matched delimiters are hidden; unmatched delimiters remain text gaps.
    } else if (node.name === 'Escape') {
      out.push(escapeText(raw.slice(1)));
    } else if (node.name === 'InlineCode') {
      const marks = node.getChildren('CodeMark');
      const body = source.slice(marks[0].to, marks[marks.length - 1].from).replace(/\r\n?|\n/g, ' ');
      const pad = codeSpanPadding(body);
      const code = body.slice(pad, body.length - pad);
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
  const source = String(value ?? '');
  if (!/<br\s*\/?>/i.test(source)) return renderInlineSegment(source, options);
  const spans = inlineCodeSpans(source), out = [];
  let start = 0, index = 0;
  for (const br of source.matchAll(/<br\s*\/?>/gi)) {
    while (index < spans.length && spans[index].to <= br.index) index++;
    if (spans[index] && spans[index].from <= br.index) continue;
    out.push(renderInlineSegment(source.slice(start, br.index), options), '<br>');
    start = br.index + br[0].length;
  }
  out.push(renderInlineSegment(source.slice(start), options));
  return out.join('');
}
