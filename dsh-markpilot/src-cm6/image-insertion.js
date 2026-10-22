import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';

const reserveTicket = StateEffect.define();
const cancelTicket = StateEffect.define();
const commitTicket = StateEffect.define();
export const cancelImageInsertions = StateEffect.define();

function selectedTextChanged(ticket, changes) {
  if (ticket.from === ticket.to) return false;
  let touched = false;
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (from < ticket.to && to > ticket.from ||
        from === to && inserted.length > 0 && from > ticket.from && from < ticket.to) touched = true;
  });
  return touched;
}

// All pending positions belong to the document state and follow CM6 changes.
export const imageInsertions = StateField.define({
  create: () => ({ tickets: [], identity: {} }),
  update(state, tr) {
    const tickets = state.tickets;
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo') ||
        tr.effects.some(effect => effect.is(cancelImageInsertions))) return { tickets: [], identity: {} };
    const committed = tr.effects.find(effect => effect.is(commitTicket));
    const ownerIndex = committed ? tickets.findIndex(ticket => ticket.id === committed.value) : -1;
    const owner = ownerIndex < 0 ? null : tickets[ownerIndex];
    const canceled = new Set(tr.effects.filter(effect => effect.is(cancelTicket)).map(effect => effect.value));
    if (!tr.docChanged && !tr.effects.length) return state;
    const next = [];
    for (let index = 0; index < tickets.length; index++) {
      const ticket = tickets[index];
      if (canceled.has(ticket.id) || owner && ticket.id === owner.id) continue;
      if (!tr.docChanged) { next.push(ticket); continue; }
      if (owner && ticket.from === owner.from && ticket.to === owner.to) {
        const at = index > ownerIndex
          ? tr.changes.mapPos(owner.to, 1)
          : tr.changes.mapPos(owner.from, -1);
        next.push({ id: ticket.id, from: at, to: at });
      } else if (!selectedTextChanged(ticket, tr.changes)) {
        const from = tr.changes.mapPos(ticket.from, ticket.from === ticket.to ? -1 : 1);
        const to = ticket.from === ticket.to ? from : tr.changes.mapPos(ticket.to, -1);
        next.push({ id: ticket.id, from, to });
      }
    }
    for (const effect of tr.effects) if (effect.is(reserveTicket)) next.push(effect.value);
    return { tickets: next, identity: state.identity };
  },
});

// Text edits and explicit document resets invalidate commands. Selection and
// background parser transactions do not invalidate an open image dialog.
export function captureImageDocument(view) {
  const doc = view.state.doc, identity = view.state.field(imageInsertions).identity;
  return () => view.state.doc === doc && view.state.field(imageInsertions).identity === identity;
}

// Reserve before reading the image or asking the host to write a file.
export function reserveImageInsertion(view) {
  const ranges = view.state.selection.ranges;
  if (ranges.length !== 1 || !view.state.field(imageInsertions, false)) return null;
  const id = {}, range = ranges[0];
  const headAtStart = range.head === range.from;
  view.dispatch({ effects: reserveTicket.of({ id, from: range.from, to: range.to }), annotations: Transaction.addToHistory.of(false) });
  const current = () => {
    const ticket = view.state.field(imageInsertions, false)?.tickets.find(item => item.id === id);
    return ticket ? { from: ticket.from, to: ticket.to, head: headAtStart ? ticket.from : ticket.to } : null;
  };
  return {
    current,
    commit(md, userEvent = 'input.paste') {
      if (typeof md !== 'string' || !md.length) return false;
      const ticket = current();
      if (!ticket) return false;
      const selections = view.state.selection.ranges;
      const stillAtOriginal = selections.length === 1 && selections[0].from === ticket.from && selections[0].to === ticket.to;
      view.dispatch({
        changes: { from: ticket.from, to: ticket.to, insert: md },
        effects: commitTicket.of(id),
        ...(stillAtOriginal ? { selection: { anchor: ticket.from + md.length }, scrollIntoView: true } : {}),
        annotations: isolateHistory.of('full'),
        userEvent,
      });
      return true;
    },
    cancel() {
      if (!current()) return false;
      view.dispatch({ effects: cancelTicket.of(id), annotations: Transaction.addToHistory.of(false) });
      return true;
    },
  };
}
