import { StateField } from '@codemirror/state';
import { quoteLead, fenceAt } from './markdown-context.js';

// One producer-neutral ruler for ordinary edits. Classification compares whole
// old/new prefixes: deleting a space or a leading letter can create a block.
export function lineSignature(text) {
  const quote = quoteLead(text), body = text.slice(quote.off);
  const list = /^(\s*)(?:[-+*]|\d{1,9}[.)])\s+/.exec(body)?.[0] || '';
  const heading = /^( {0,3})(#{1,6})([ \t]+|$)/.exec(body)?.[0] || '';
  const fence = fenceAt(body);
  return JSON.stringify([quote.q, list, heading, fence && [fence.char, fence.len, fence.indent, fence.info],
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(body), /(?<!\\)\|/.test(body),
    /^\s*\$\\begin\{/.test(body), /^\s*\$\$/.test(body), /\$\$\s*$/.test(body),
    body.includes('<!--'), body.includes('-->')]);
}
export function inlineCodeRanges(text) {
  const ranges = [], runs = /`+/g; let open;
  while ((open = runs.exec(text))) {
    let slashes = 0; for (let p = open.index - 1; p >= 0 && text[p] === '\\'; p--) slashes++;
    if (slashes % 2) continue;
    const close = /`+/g; close.lastIndex = runs.lastIndex; let match;
    while ((match = close.exec(text))) if (match[0].length === open[0].length) {
      ranges.push([open.index, close.lastIndex]); runs.lastIndex = close.lastIndex; break;
    }
  }
  return ranges;
}
export function rangesTouching(rows, from, to) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].from < from) lo = mid + 1; else hi = mid; }
  while (lo > 0 && rows[lo - 1].to >= from) lo--;
  const out = [];
  for (; lo < rows.length && rows[lo].from <= to; lo++) if (rows[lo].to >= from) out.push(rows[lo]);
  return out;
}
export function singleLineEdit(tr) {
  let plan = null, safe = true;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const before = tr.startState.doc.lineAt(fromA), after = tr.state.doc.lineAt(fromB);
    const removed = tr.startState.doc.sliceString(fromA, toA), added = inserted.toString();
    if (toA > before.to || toB > after.to || /[\r\n]/.test(removed + added) || (plan && (plan.before.from !== before.from || plan.after.from !== after.from))) safe = false;
    if (!plan) plan = { before, after, changes: [] };
    plan.changes.push({ fromA, toA, fromB, toB, removed, added });
  });
  return safe && plan && lineSignature(plan.before.text) === lineSignature(plan.after.text) ? plan : null;
}
export const editPlan = StateField.define({ create: () => null, update: (value, tr) => tr.docChanged ? singleLineEdit(tr) : value });
