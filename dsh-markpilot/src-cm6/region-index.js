import { StateField } from '@codemirror/state';

let nextEpoch = 0;
const keyOf = (r, from = r.from, to = r.to) => `${r.kind}:${r.form || ''}:${from}:${to}`;
const sameValue = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));
const lowerBound = (rows, pos) => {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].from < pos) lo = mid + 1; else hi = mid; }
  return lo;
};

// Producers own recognition. This adapter only reconciles their current ranges;
// selection and geometry transactions do not parse, clone, or map anything.
export function createRegionIndex(readRegions, dependencies = []) {
  function build(state, previous, changes) {
    const epoch = previous?.epoch ?? ++nextEpoch;
    let nextId = previous?.nextId ?? 0;
    const old = new Map(), rightEnds = new Map();
    const unique = (map,key,r) => map.set(key,map.has(key) ? null : r);
    for (const r of previous?.regions || []) {
      let removed = false;
      changes?.iterChangedRanges((a, b) => { if (a <= r.from && b >= r.to && b > a) removed = true; });
      if (removed) continue;
      const from = changes ? changes.mapPos(r.from, 1) : r.from;
      const to = changes ? changes.mapPos(r.to, -1) : r.to;
      const key = keyOf(r,from,to);
      // An ambiguous successor is deliberately given a fresh identity.
      unique(old,key,r);
      if (r.sourceOwned && changes) unique(rightEnds,keyOf(r,from,changes.mapPos(r.to,1)),r);
    }
    const rawRegions = readRegions(state), rawKeys = rawRegions.map(r=>keyOf(r)), counts = new Map();
    for (const key of rawKeys) counts.set(key,(counts.get(key)||0)+1);
    // Reserve every exact successor first. A boundary fallback must not borrow
    // an identity already retained by another region, or resolve an ambiguity.
    const priors = rawRegions.map((raw,i) => {
      const prior = counts.get(rawKeys[i]) === 1 && old.get(rawKeys[i]);
      return prior && !!prior.sourceOwned === !!raw.sourceOwned ? prior : null;
    }), claimed = new Set(priors.filter(Boolean));
    const invalidated = new Set();
    const regions = rawRegions.map((raw,i) => {
      let prior = priors[i];
      const key = rawKeys[i];
      if (!prior && raw.sourceOwned && !old.has(key) && counts.get(key) === 1) {
        const candidate = rightEnds.get(key);
        if (candidate && !claimed.has(candidate)) { prior=candidate; claimed.add(candidate); }
      }
      // Large literal-source owners need no whole-range string on each key.
      // ChangeDesc uses the prior document's coordinates, including boundaries.
      const sameContent = prior && (raw.sourceOwned && prior.sourceOwned
        ? !changes?.touchesRange(prior.from,prior.to)
        : sameValue(raw.content, prior.content));
      const sameContext = prior && raw.context.key === prior.context.key;
      const id = prior?.id ?? `${epoch}:${++nextId}`;
      if (!prior || !sameContent || !sameContext) invalidated.add(id);
      return { ...raw, id,
        revision: prior ? prior.revision + (sameContent ? 0 : 1) : 0,
        contextVersion: prior ? prior.contextVersion + (sameContext ? 0 : 1) : 0 };
    }).sort((a, b) => a.from - b.from || b.to - a.to || a.kind.localeCompare(b.kind));
    const byKind = new Map(), byId = new Map();
    for (const r of regions) {
      byId.set(r.id, r);
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind).push(r);
    }
    for (const r of previous?.regions || []) if (!byId.has(r.id)) invalidated.add(r.id);
    // Delta relative to the directly preceding index. All consumers read it;
    // selection-only reuse must never treat it as a pending/consumable queue.
    return { epoch, nextId, regions, byId, byKind, invalidated, version: (previous?.version ?? -1) + 1 };
  }
  return StateField.define({
    create: state => build(state),
    update(value, tr) {
      if (!tr.docChanged && dependencies.every(f => tr.startState.field(f, false) === tr.state.field(f, false))) return value;
      return build(tr.state, value, tr.changes);
    },
  });
}

export function regionAt(index, pos, kind, inclusive = true) {
  const rows = index?.byKind.get(kind) || [];
  let at = lowerBound(rows, pos + 1) - 1;
  // Regions of a single type are nonoverlapping. Endpoint inclusion is a command
  // policy, never evidence of an explicit preview activation.
  for (; at >= 0 && rows[at].to >= pos; at--) {
    const r = rows[at];
    if (inclusive ? r.from <= pos && pos <= r.to : r.from < pos && pos < r.to) return r;
  }
  return null;
}

export function regionsBetween(index, from, to, kind) {
  const rows = index?.byKind.get(kind) || [];
  let at = lowerBound(rows, from);
  while (at > 0 && rows[at - 1].to >= from) at--;
  const out = [];
  for (; at < rows.length && rows[at].from <= to; at++) if (rows[at].to >= from) out.push(rows[at]);
  return out;
}
