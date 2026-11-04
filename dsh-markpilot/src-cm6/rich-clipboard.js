import { codeSpanMarkers, hasUnescapedDollar, renderInline } from './inline-format.js';

// Convert only unambiguous presentation MathML. If the tree uses another
// notation, preserve its inert source instead of concatenating its operands.
function presentationTex(node, depth = 0) {
  if (!node || depth > 48) return null;
  const kind = node.localName;
  if (Array.from(node.attributes || []).some(attr => !/^(?:xmlns|class|id|display|role|aria-.*|data-.*)$/.test(attr.name))) return null;
  if (kind === 'semantics') {
    const first = node.firstElementChild;
    return first && !first.localName.startsWith('annotation') ? presentationTex(first, depth + 1) : null;
  }
  if (['mi','mn','mo','mtext'].includes(kind)) {
    if (node.children.length) return null;
    const value = node.textContent.trim();
    if (kind === 'mi') return /^[a-zA-Z\u0391-\u03a9\u03b1-\u03c9]$/u.test(value) ? value : null;
    if (kind === 'mn') return /^\d+(?:[.,]\d+)?$/.test(value) ? value : null;
    if (kind === 'mo') return /^[+\u2212*/=:,.!?()[\]|<>±×÷≠≤≥…∞-]$/u.test(value) ? value : null;
    const phrase = node.textContent.replace(/\s+/g, ' ');
    return /^[\p{L}\p{N}\s.,!?:()-]+$/u.test(phrase) ? '\\text{' + phrase + '}' : null;
  }
  if (Array.from(node.childNodes).some(n => n.nodeType === 3 && n.nodeValue.trim())) return null;
  const args = Array.from(node.children, child => presentationTex(child, depth + 1));
  if (!args.length || args.includes(null)) return null;
  if (kind === 'math' || kind === 'mrow') return args.join('');
  if (kind === 'msqrt') return '\\sqrt{' + args.join('') + '}';
  const [base, second, third] = args;
  if (kind === 'mfrac' && args.length === 2) return '\\frac{' + base + '}{' + second + '}';
  if (kind === 'mroot' && args.length === 2) return '\\sqrt[{' + second + '}]' + '{' + base + '}';
  if (kind === 'msub' && args.length === 2) return '{' + base + '}_{' + second + '}';
  if (kind === 'msup' && args.length === 2) return '{' + base + '}^{' + second + '}';
  if (kind === 'msubsup' && args.length === 3) return '{' + base + '}_{' + second + '}^{' + third + '}';
  return null;
}

function literalMathML(math) {
  const copy = math.cloneNode(true);
  for (const hidden of copy.querySelectorAll('script,style')) hidden.remove();
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    if (el.namespaceURI !== math.namespaceURI) {
      el.replaceWith(el.textContent || el.getAttribute('alt') || '');
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      // An external glyph is authored mathematical content. Its address stays
      // inside the code span only; importing it does not fetch the resource.
      if (el.localName === 'mglyph' && (attr.name === 'alt' || attr.name === 'src' && !/^\s*(?:javascript|vbscript):/i.test(attr.value))) continue;
      // This is inert Markdown code. Keep even unfamiliar MathML layout
      // attributes, e.g. maction's selection or mstack's alignment.
      if (attr.name === 'xml:lang' || attr.name === 'xml:space') continue;
      if (/^(?:on|data-|aria-)|:|^(?:class|id|role|style|src|href|altimg|nonce|integrity|crossorigin|referrerpolicy|poster|background)$/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  const text = copy.outerHTML.replace(/[\r\n]+/g, ' ');
  const {open, close} = codeSpanMarkers(text);
  return open + text + close;
}

// Keep the supported semantics of a clipboard fragment without copying its
// HTML attributes, event handlers or presentation-only math into Markdown.
export function clipboardFormula(element) {
  const isMath = element.localName === 'math';
  const isDisplay = element.classList?.contains?.('katex-display');
  if (!isMath && !isDisplay && !element.classList?.contains?.('katex')) return null;
  const math = isMath ? element : element.querySelector('math');
  // A directly annotated subexpression alongside another operand does not
  // describe the entire formula either.
  const annotation = math?.children?.length > 1 ? null : math?.querySelector(':scope > semantics > annotation[encoding="application/x-tex" i]');
  let tex = annotation?.textContent.trim();
  if (!tex) {
    if (!math?.children?.length) return null;
    tex = presentationTex(math);
    if (!tex) return literalMathML(math);
  }
  const display = isDisplay || math.getAttribute('display') === 'block';
  // An isolated display fence inside the annotation cannot itself be delimited
  // by $$ without losing part of the source. Preserve it as a literal TeX block.
  if (/^\s*\$\$\s*$/m.test(tex)) {
    const width = Array.from(tex.matchAll(/`+/g)).reduce((width, match) => Math.max(width, match[0].length + 1), 3);
    const ticks = String.fromCharCode(96).repeat(width);
    return '\n\n' + ticks + 'tex\n' + tex + '\n' + ticks + '\n\n';
  }
  return display || tex.includes('\n') || hasUnescapedDollar(tex) ? '\n\n$$\n' + tex + '\n$$\n\n' : '$' + tex + '$';
}

// A short, canonical style key lets adjacent DOM runs with the same semantics
// share one Markdown delimiter pair, even when their HTML tags differ.
export function clipboardStyle(element, inherited = '') {
  if (!element) return inherited;
  const style = element.style || {}, tag = element.tagName;
  const deco = (style.textDecorationLine || style.textDecoration || '').split(/\s+/);
  const bold = style.fontWeight && style.fontWeight !== 'inherit'
    ? style.fontWeight === 'bold' || Number(style.fontWeight) >= 600
    : tag === 'B' || tag === 'STRONG' || inherited.includes('b');
  const italic = style.fontStyle && style.fontStyle !== 'inherit'
    ? /^(italic|oblique)(?: |$)/.test(style.fontStyle)
    : tag === 'I' || tag === 'EM' || inherited.includes('i');
  const strike = tag === 'DEL' || tag === 'S' || tag === 'STRIKE' || deco.includes('line-through') || inherited.includes('s');
  const underline = tag === 'U' || deco.includes('underline') || inherited.includes('u');
  const vertical = style.verticalAlign || (tag === 'SUP' ? 'super' : tag === 'SUB' ? 'sub' : '');
  const script = vertical === 'super' ? '^' : vertical === 'sub' ? '_' : vertical ? '' : inherited.match(/[\^_]/)?.[0] || '';
  return (bold ? 'b' : '') + (italic ? 'i' : '') + (strike ? 's' : '') + (underline ? 'u' : '') + script;
}

export function markedClipboardRun(marks, text) {
  if (!marks || !text.trim()) return text;
  const leading = text.match(/^\s*/)[0], trailing = text.match(/\s*$/)[0];
  let marked = text.trim();
  if (marks.includes('b')) marked = '**' + marked + '**';
  if (marks.includes('i')) marked = '*' + marked + '*';
  if (marks.includes('s')) marked = '~~' + marked + '~~';
  if (marks.includes('u')) marked = '<u>' + marked + '</u>';
  if (marks.includes('^')) marked = '<sup>' + marked + '</sup>';
  if (marks.includes('_')) marked = '<sub>' + marked + '</sub>';
  return leading + marked + trailing;
}

export function serializeClipboardRuns(runs) {
  if (!runs.length) return '';
  if (runs.length === 1) return markedClipboardRun(runs[0].style, runs[0].text);
  const raw = runs.map(run => run.text).join('');
  if (!runs.some(run => run.style)) return raw;
  // Check delimiter boundaries around an inline image without parsing its URI.
  // Use the real image bytes only for the source returned to the editor.
  const checkRuns = raw.length > 16384 ? runs.map(run => run.probe ? {text:run.probe, style:run.style} : run) : runs;
  const checkText = checkRuns === runs ? raw : checkRuns.map(run => run.text).join('');
  if (checkText.length > 16384) return raw;
  function write(group) {
    let result = '';
    for (let i = 0; i < group.length;) {
      if (!group[i].style) { result += group[i++].text; continue; }
      let mark, end = i;
      for (const candidate of group[i].style) {
        let j = i;
        while (j < group.length && group[j].style.includes(candidate)) j++;
        if (j > end) { end = j; mark = candidate; }
      }
      // Keep the longest shared semantic wrapper, e.g. <b>A<i>B</i>C</b>.
      const inner = group.slice(i,end).map(run => ({text:run.text,style:run.style.replace(mark,'')}));
      result += markedClipboardRun(mark, write(inner));
      i = end;
    }
    return result;
  }
  const formatted = write(checkRuns);
  const visible = md => renderInline(md).replace(/<\/?(?:strong|em|s|u|sup|sub)>/g,'');
  if (visible(formatted) !== visible(checkText)) return raw;
  return checkRuns === runs ? formatted : write(runs);
}
