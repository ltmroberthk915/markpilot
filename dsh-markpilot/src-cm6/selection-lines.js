// Source selections are half-open. A terminal line start belongs to the next
// line only when the selection contains at least one of that line's characters.
export function selectedLines(doc, range) {
  return { first: doc.lineAt(range.from).number,
    last: doc.lineAt(range.empty ? range.to : range.to - 1).number };
}
