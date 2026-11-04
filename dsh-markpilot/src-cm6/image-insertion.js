import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';

const reserveTicket = StateEffect.define();
const cancelTicket = StateEffect.define();
const commitTicket = StateEffect.define();
export const cancelImageInsertions = StateEffect.define();

function reservationOverwritten(ticket, changes) {
  let overwritten = false;
  changes.iterChangedRanges((from, to) => {
    // Replacing the entire old draft also retires reservations at its endpoints.
    if ((from === 0 && to === changes.length && to > 0) ||
        (from < ticket.to && to > ticket.from)) overwritten = true;
  });
  return overwritten;
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
      } else if (!reservationOverwritten(ticket, tr.changes)) {
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
  if (ranges.length !== 1) return null;
  return reserveImageRange(view, ranges[0]);
}

function reserveImageRange(view, range) {
  if (!range || view.state.readOnly || !view.state.field(imageInsertions, false)) return null;
  const id = {};
  const headAtStart = range.head === range.from;
  view.dispatch({ effects: reserveTicket.of({ id, from: range.from, to: range.to }), annotations: Transaction.addToHistory.of(false) });
  const current = () => {
    const ticket = view.state.field(imageInsertions, false)?.tickets.find(item => item.id === id);
    return ticket ? { from: ticket.from, to: ticket.to, head: headAtStart ? ticket.from : ticket.to } : null;
  };
  return {
    current,
    fork: () => reserveImageRange(view, current()),
    commit(md, userEvent = 'input.paste') {
      if (view.state.readOnly || typeof md !== 'string' || !md.length) return false;
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
