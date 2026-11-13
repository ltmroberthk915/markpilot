import { EditorSelection } from '@codemirror/state';
import { codeBlockAt, quoteLead } from './markdown-context.js';
import { tableBlockOf } from './tables.js';

/**
 * Shift+Enter inside a rendered blockquote must make a soft line break that stays
 * in the quote. The renderer derives `.mp-quote` from the Markdown source, so an
 * empty caret row without a `>` marker is not a quote row at all (CommonMark ends
 * the blockquote at that blank line). Insert the exact existing quote lead instead
 * of styling a line that the document does not own.
 *
 * The command declines outside quotes, inside fenced code, inside tables, and for
 * non-empty selections or mixed multi-cursor ranges. Returning false lets CodeMirror
 * and the existing table/fence/list owners preserve their current behavior.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @returns {boolean} true when this command inserted the soft break
 */
export function quoteSoftBreak(view) {
  const { state } = view;
  let handled = false, declined = false;
  const spec = state.changeByRange((range) => {
    if (!range.empty) { declined = true; return { range }; }
    const line = state.doc.lineAt(range.head);
    const lead = quoteLead(line.text);
    if (!lead.depth || range.head < line.from + lead.off) { declined = true; return { range }; }
    // Table/fence owners run at the same precedence and must keep the key.
    if (codeBlockAt(state, range.head) || tableBlockOf(state, line.number)) { declined = true; return { range }; }
    const at = range.head;
    // `> |` in the middle of a line should read `> text`, not `>  text`.
    // Keep the existing suffix byte-for-byte; only the duplicate joining space
    // belongs to the new prefix.
    let prefix = lead.q, advance = 0;
    const next = at < line.to ? state.sliceDoc(at, at + 1) : '';
    if (next && /[ \t]/.test(next) && /[ \t]$/.test(prefix)) { prefix = prefix.slice(0, -1); advance = 1; }
    handled = true;
    return {
      changes: { from: at, insert: state.lineBreak + prefix },
      range: EditorSelection.cursor(at + state.lineBreak.length + prefix.length + advance),
    };
  });
  // Any non-quote range means this is a mixed gesture: fall through as one gesture
  // so CodeMirror's native keymap (and the table/fence/list owners) stays in charge.
  if (!handled || declined || spec.changes.empty) return false;
  view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input' });
  return true;
}
