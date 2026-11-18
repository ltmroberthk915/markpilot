import { scanStructuralContext, structuralContextAt } from './markdown-context.js';
import { isSeparatorBody } from './tables.js';
import { inlineCodeSpans } from './inline-format.js';
import { mappedMathSource } from './math-source-map.js';

// Source offsets: escaped dollars and pairs never close a single-dollar atom.
function dollarAt(text, from = 0) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$') return i;
  }
  return -1;
}
const hasPipe = text => /(?<!\\)\|/.test(text);
const closingTail = text => /^[ \t.,;:!?，。；：！？、)\]）】"'”’]*$/.test(text);
function boundary(text) {
  return !text.trim() || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(text) ||
    /^\s*(?:-{3,}|\*{3,}|_{3,}|=+)\s*$/.test(text) ||
    isSeparatorBody(text) || /^[ \t]*\$\$/.test(text);
}
function opening(text) {
  const m = /^[ \t]*\$(?!\$)/.exec(text);
  return m ? m[0].length - 1 : -1;
}

// A changed suffix or paragraph boundary invalidates an unclosed candidate,
// including edits that contain no dollar. Ordinary body edits keep their key.
export function singleDollarLineKey(body) {
  const open = opening(body), at = dollarAt(body, open >= 0 ? open + 1 : 0);
  return [boundary(body), hasPipe(body), open >= 0, at < 0 ? 0 : body[at + 1] === '$' ? 2 : 1,
    at >= 0 && closingTail(body.slice(at + 1))].join(':');
}

// Shared by the editor and public snapshots. A pending block owns no output
// until it closes, so an unfinished formula cannot suppress following atoms.
export function scanSingleDollarMath(doc, excluded = [], structure = scanStructuralContext(doc)) {
  const result = [], blocks = excluded.slice().sort((a, b) => a.from - b.from);
  let blocked = 0, pending = null, table = null, code = [], codeCursor = 0;
  let paragraphStart = 1, paragraphOwner = null, codeUntil = 0, codeFrom = 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    while (blocked < blocks.length && blocks[blocked].to <= line.from) blocked++;
    const context = structuralContextAt(structure, line.from);
    const owner = context?.path.at(-1) ?? null, lead = context?.lead ?? 0;
    const body = line.text.slice(lead), from = line.from + lead;
    if (paragraphOwner !== owner) { paragraphOwner = owner; paragraphStart = n; }
    if (!body.trim()) paragraphStart = n + 1;
    if (blocks[blocked]?.from < line.to && blocks[blocked].to > line.from) {
      pending = null; table = null; paragraphStart = n + 1; continue;
    }
    // The separator belongs to its immediately preceding header, not to an
    // earlier pipe-containing formula. Subsequent pipe rows share that owner.
    if (table && (table.owner !== owner || n !== table.separator && !hasPipe(body))) table = null;
    if (!table && hasPipe(body) && n < doc.lines) {
      const next = doc.line(n + 1), cx = structuralContextAt(structure, next.from);
      if ((cx?.path.at(-1) ?? null) === owner && isSeparatorBody(next.text.slice(cx?.lead ?? 0)) &&
          !(blocks[blocked]?.from < next.to && blocks[blocked].to > next.from))
        table = { owner, separator: n + 1 };
    }
    if (table) { pending = null; paragraphStart = n + 1; continue; }
    if (boundary(body)) {
      pending = null; paragraphStart = n + 1; continue;
    }
    if (pending?.owner !== owner) pending = null;
    if (pending) {
      const at = dollarAt(body);
      if (at < 0) {
        pending.parts.push({ text: body, from }); continue;
      }
      if (body[at + 1] !== '$' && closingTail(body.slice(at + 1))) {
        pending.parts.push({ text: body.slice(0, at), from });
        const source = mappedMathSource(pending.parts);
        if (source.tex) result.push({ from: pending.from, to: from + at + 1, ...source, display: pending.environment || !body.slice(at + 1).trim() });
        pending = null; continue;
      }
      pending = null;
    }
    const open = opening(body);
    if (open < 0) continue;
    // Parse only this paragraph, once. The shared inline parser owns backtick
    // pairing; an already-open formula owns its own contents. A forward cursor
    // makes lookahead linear across paragraphs, not a document parse per edit.
    if (n > codeUntil || codeFrom !== paragraphStart) {
      let end = n;
      for (let j = n + 1; j <= doc.lines; j++) {
        const next = doc.line(j), cx = structuralContextAt(structure, next.from);
        if ((cx?.path.at(-1) ?? null) !== owner || boundary(next.text.slice(cx?.lead ?? 0)) ||
            blocks[blocked]?.from < next.to && blocks[blocked].to > next.from) break;
        end = j;
      }
      const start = doc.line(Math.min(paragraphStart, n)).from;
      code = inlineCodeSpans(doc.sliceString(start, doc.line(end).to))
        .map(range => ({ from: start + range.from, to: start + range.to }));
      codeCursor = 0; codeUntil = end; codeFrom = paragraphStart;
    }
    while (code[codeCursor]?.to <= from + open) codeCursor++;
    if (code[codeCursor]?.from <= from + open) continue;
    const at = dollarAt(body, open + 1);
    if (at < 0) {
      pending = { from: from + open, owner, environment: body.startsWith('\\begin{', open + 1), parts: [{ text: body.slice(open + 1), from: from + open + 1 }] };
    } else if (body[at + 1] !== '$' && body.startsWith('\\begin{', open + 1)) {
      // Keep standalone environments in display style, closing at the first
      // delimiter so subsequent inline atoms remain independent.
      const source = mappedMathSource([{ text: body.slice(open + 1, at), from: from + open + 1 }]);
      if (source.tex) result.push({ from: from + open, to: from + at + 1, ...source, display: true });
    }
  }
  return result;
}

