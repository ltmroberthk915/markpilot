// Positions end at the last character of the closing delimiter. The next
// line belongs to Markdown, even when the caret is at its first character.
const opener = /^\uFEFF?---[ \t]*\r?$/;
const closer = /^(?:---|\.\.\.)[ \t]*\r?$/;
const cached = new WeakMap();
export const sourceFrontMatter = /^\uFEFF?---[ \t]*\r?\n((?:[\s\S]*?\n)?)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
function hasOpener(doc) {
  return /^\uFEFF?---/.test(doc.sliceString(0, 4)) && opener.test(doc.line(1).text);
}

export function frontMatterOf(doc) {
  if (cached.has(doc)) return cached.get(doc);
  let range = null;
  if (hasOpener(doc)) {
    let number = 1;
    for (const text of doc.iterLines(2)) {
      number++;
      if (closer.test(text)) {
        range = { endLine: number, to: doc.line(number).to };
        break;
      }
    }
  }
  cached.set(doc, range);
  return range;
}

export function updateFrontMatter(tr) {
  const before = frontMatterOf(tr.startState.doc);
  let touched = false;
  tr.changes.iterChanges((from, to, nextFrom, nextTo, inserted) => {
    if (before ? from <= before.to : from <= tr.startState.doc.line(1).to) touched = true;
    // An unclosed header may be closed by an edit later in the document.
    if (!before && hasOpener(tr.newDoc) &&
        (inserted.lines > 1 || closer.test(tr.newDoc.lineAt(nextFrom).text) ||
          closer.test(tr.newDoc.lineAt(nextTo).text))) touched = true;
  });
  if (!touched) cached.set(tr.newDoc, before);
  return before !== frontMatterOf(tr.newDoc);
}

// Lezer supplies a chunked Input both in the UI and in the offline worker.
// Look ahead without consuming the parser when an opener has no closer.
function hasClosingLine(input) {
  let pending = '', first = true;
  for (let at = 0; at < input.length;) {
    const chunk = input.chunk(at);
    if (!chunk.length) break;
    at += chunk.length;
    let from = 0, end;
    while ((end = chunk.indexOf('\n', from)) >= 0) {
      const line = pending + chunk.slice(from, end);
      if (!first && closer.test(line)) return true;
      first = false; pending = ''; from = end + 1;
    }
    pending += chunk.slice(from);
  }
  return !first && closer.test(pending);
}

export const frontMatterSyntax = {
  defineNodes: [{ name: 'FrontMatter', block: true }],
  parseBlock: [{
    name: 'FrontMatter', before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || !opener.test(line.text) || !hasClosingLine(cx.input)) return false;
      while (cx.nextLine()) {
        if (!closer.test(line.text)) continue;
        const end = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addElement(cx.elt('FrontMatter', 0, end));
        return true;
      }
      return false;
    },
  }],
};
