/**
 * Knuth–Plass total-fit line breaking (TeX §859–879, single-column variant)
 * plus a DOM applier that re-typesets finished renderings for print.
 *
 * The live editor keeps browser-owned line breaking: a contenteditable cannot
 * hand breaking over to an external engine without destroying caret, IME and
 * undo. The applier therefore only runs on read-only renderings (PDF export),
 * where measured margins and explicit <br> reproduce the chosen line boxes.
 *
 * Everything the applier mutates is reversible: text pieces gain wrapper
 * spans, collapsed break gaps become hidden spans, inserted line breaks are
 * <br data-kp>, element margins are recorded before being set.
 */

export const FORCED_COST = -10000;
const INFINITE_COST = 100000;
const AUTOSPACE_EM = 0.125;
const KANJI_STRETCH_EM = 0.25;
const KANJI_SHRINK_EM = 0.0833;

export const items = {
  box: width => ({type: 'box', width}),
  glue: (width, stretch = 0, shrink = 0) => ({type: 'glue', width, stretch, shrink}),
  penalty: (cost, width = 0) => ({type: 'penalty', cost, width}),
};

/** TeX badness plumbing: how far a line's glue must move to hit the target. */
function adjustmentRatio(naturalWidth, stretch, shrink, target) {
  const gap = target - naturalWidth;
  if (gap > 0.5) return stretch > 0 ? gap / stretch : Infinity;
  if (gap < -0.5) return shrink > 0 ? gap / shrink : -Infinity;
  return 0;
}

/**
 * Total-fit breaking over box/glue/penalty items. The paragraph must end with
 * a forced penalty (cost <= FORCED_COST); conventionally an infinite-stretch
 * glue sits before it so the final line stays ragged. Returns null when the
 * tolerance cannot be met (caller keeps CSS justification), otherwise
 * {lines:[{start, breakIndex, ratio}]} where a line covers items[start..breakIndex).
 */
export function breakLines(stream, lineWidth, {tolerance = 1.6} = {}) {
  if (!stream.length || !(lineWidth > 0)) return null;
  const origin = {position: -1, line: 0, fitness: 1, width: 0, stretch: 0, shrink: 0, demerits: 0, previous: null};
  let actives = [origin];
  let finisher = null;
  let previousWasBox = false;

  const consider = (index, cost, widthOfBreak) => {
    const forced = cost <= FORCED_COST;
    let best = null;
    const survivors = [];
    for (const node of actives) {
      if (forced) {
        // A forced break (source <br> or the paragraph end) ends every
        // alternative path: the line before it is ragged by author intent,
        // so no ratio test and no extra demerits apply.
        const demerits = node.demerits;
        if (!best || demerits < best.demerits) {
          best = {position: index, line: node.line + 1, fitness: node.fitness, width: 0, stretch: 0, shrink: 0, demerits, previous: {node, ratio: 0}};
        }
        continue;
      }
      const ratio = adjustmentRatio(node.width + widthOfBreak, node.stretch, node.shrink, lineWidth);
      if (ratio < -1 || ratio > tolerance || ratio === Infinity || ratio === -Infinity) {
        if (node.width + widthOfBreak - node.shrink <= lineWidth + 1) survivors.push(node);
        continue;
      }
      const badness = Math.min(10000, Math.round(100 * Math.abs(ratio) ** 3));
      const fitness = ratio < -0.5 ? 0 : ratio <= 0.5 ? 1 : ratio <= 1 ? 2 : 3;
      const classPenalty = Math.abs(fitness - node.fitness) > 1 ? 10000 : 0;
      const demerits = node.demerits + (badness + cost) ** 2 + classPenalty;
      if (!best || demerits < best.demerits) {
        best = {position: index, line: node.line + 1, fitness, width: 0, stretch: 0, shrink: 0, demerits, previous: {node, ratio}};
      }
      survivors.push(node);
    }
    if (!best) {actives = survivors;return;}
    if (forced) {
      if (finisher) finisher = best.demerits < finisher.demerits ? best : finisher;
      else if (index === stream.length - 1) finisher = best;
      else actives = [best]; // all paths funnel through the forced break
    } else actives = survivors.concat(best);
  };

  // Glue/penalty widths feed only lines that did NOT break at this item: a
  // break consumes its glue (TeX semantics), so newly created break nodes
  // must start their totals clean.
  const addTo = (list, item) => {
    for (const node of list) {node.width += item.width || 0; node.stretch += item.stretch || 0; node.shrink += item.shrink || 0;}
  };

  for (const [index, item] of stream.entries()) {
    if (item.type === 'box') {
      for (const node of actives) node.width += item.width;
      // Deactivate nodes that overflow and can never shrink back into a line.
      actives = actives.filter(node => node.width - node.shrink <= lineWidth + 1);
      if (!actives.length) return null;
      previousWasBox = true;
    } else if (item.type === 'glue') {
      const open = actives;
      if (previousWasBox) consider(index, 0, 0);
      addTo(open, item);
      previousWasBox = false;
    } else {
      const open = actives;
      if (item.cost < INFINITE_COST && (previousWasBox || item.cost <= FORCED_COST)) consider(index, item.cost, item.width);
      addTo(open, item);
      if (item.cost <= FORCED_COST && finisher) break;
      previousWasBox = false;
    }
  }
  if (!finisher) return null;
  const chain = [];
  for (let node = finisher; node.previous; node = node.previous.node) {
    chain.push({breakIndex: node.position, ratio: node.previous.ratio});
  }
  chain.reverse();
  const lines = [];
  let start = 0;
  for (const link of chain) {
    lines.push({start, breakIndex: link.breakIndex, ratio: link.ratio});
    start = link.breakIndex + 1;
  }
  return {lines};
}

/* ------------------------------------------------------------------ */
/* DOM applier: collect → wrap → measure → break → bake (reversible).   */
/* ------------------------------------------------------------------ */

const ATOMIC_TAGS = new Set(['IMG', 'SVG', 'VIDEO', 'IFRAME', 'CANVAS', 'INPUT', 'OBJECT', 'EMBED']);
const ATOMIC_CLASS = /(?:^|\s)(?:katex|language-math)(?:\s|$)/;
const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'DL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'HR', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CJK_SOURCE = '\\u2E80-\\u2FDF\\u3005\\u3007\\u3021-\\u3029\\u3038-\\u303A\\u3041-\\u30FF\\u3105-\\u312F\\u31F0-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA960-\\uA97F\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
const CJK_TEST = new RegExp(`^[${CJK_SOURCE}]`);
const LATIN_WORD = /[A-Za-z0-9](?:[A-Za-z0-9'\u2019\u2010-\u2015-]*[A-Za-z0-9])?/;
const CLOSING = new Set(['，', '。', '、', '；', '：', '？', '！', '）', '】', '》', '」', '』', '”', '’', '…', '·', '—', '～', '％', '‰', '℃', '〕', '〉', '〗', '〙', '〛', '.', ',', ';', ':', '!', '?', '%', '°', '"', "'", ']', '}', ')', '\u00a0']);
const OPENING = new Set(['（', '【', '《', '「', '『', '“', '‘', '〔', '〈', '〖', '〘', '〚', '(', '[', '{', '"', "'"]);
const MAX_ATOMS = 4000;

function segmentText(text) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {out.push({kind: 'gap', text: space[0]});at += space[0].length;continue;}
    if (CJK_TEST.test(rest[0])) {out.push({kind: 'cjk', text: rest[0]});at++;continue;}
    const word = LATIN_WORD.exec(rest);
    if (word && word.index === 0 && word[0].length) {out.push({kind: 'word', text: word[0]});at += word[0].length;continue;}
    out.push({kind: 'sym', text: rest[0]});at++;
  }
  return out;
}

/**
 * Walk inline content, isolating every piece in its own inline-block span
 * (whitespace gaps stay as bare text nodes). Returns a flat atom list whose
 * order matches document order; adjacency (no gap between) is implicit in
 * that order. Throws only on unexpected node types, which the caller treats
 * as "leave this paragraph to CSS".
 */
function collectAtoms(block) {
  const atoms = [];
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.data) continue;
        let remaining = child;
        for (const segment of segmentText(child.data)) {
          if (segment.kind === 'gap') {
            remaining.splitText(segment.text.length);
            atoms.push({kind: 'gap', node: remaining});
            remaining = remaining.nextSibling;
            continue;
          }
          remaining.splitText(segment.text.length);
          const isolated = remaining;
          remaining = remaining.nextSibling;
          const span = block.ownerDocument.createElement('span');
          span.className = 'kp-token';
          span.style.display = 'inline-block';
          isolated.replaceWith(span);
          span.append(isolated);
          atoms.push({kind: segment.kind, span, text: segment.text});
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'BR') {atoms.push({kind: 'br', node: child});continue;}
      if (ATOMIC_TAGS.has(child.tagName) || ATOMIC_CLASS.test(child.className || '')) {atoms.push({kind: 'element', node: child});continue;}
      walk(child);
    }
  };
  walk(block);
  return atoms;
}

/** Kinsoku + Latin punctuation: closing marks join the previous token, opening
 *  marks join the next one, so no legal break can ever strand them. */
function groupAtoms(atoms) {
  const groups = [];
  const isContent = atom => atom.kind !== 'gap' && atom.kind !== 'br';
  let pendingOpen = null;
  const flushOpen = () => {if (pendingOpen) {groups.push({kind: 'tok', pieces: [pendingOpen]});pendingOpen = null;}};
  for (const [index, atom] of atoms.entries()) {
    if (!isContent(atom)) {flushOpen();groups.push({kind: atom.kind, node: atom.node});continue;}
    const adjacent = index > 0 && isContent(atoms[index - 1]);
    const text = atom.text || '';
    const previous = groups[groups.length - 1];
    if (adjacent && previous && previous.kind === 'tok' && text.length === 1 && CLOSING.has(text)) {
      previous.pieces.push(atom);continue;
    }
    if (text.length === 1 && OPENING.has(text)) {flushOpen();pendingOpen = atom;continue;}
    if (pendingOpen) {
      groups.push({kind: 'tok', pieces: [pendingOpen, atom]});
      pendingOpen = null;
      continue;
    }
    groups.push({kind: 'tok', pieces: [atom]});
  }
  flushOpen();
  return groups;
}

const pieceNode = piece => piece.span || piece.node;
const firstRect = group => pieceNode(group.pieces[0]).getBoundingClientRect();
const lastRect = group => pieceNode(group.pieces[group.pieces.length - 1]).getBoundingClientRect();

function glueFor(before, after, gapWidth, fontSize) {
  const kindOf = piece => piece.kind === 'cjk' ? 'cjk' : (piece.kind === 'element' ? 'word' : piece.kind);
  const left = kindOf(before), right = kindOf(after);
  const em = fontSize;
  if (left === 'cjk' && right === 'cjk') {
    // TeX \kanjiskip: ideographs may spread or squeeze a little.
    return {natural: 0, stretch: em * KANJI_STRETCH_EM, shrink: em * KANJI_SHRINK_EM, autospace: false};
  }
  if ((left === 'cjk' || right === 'cjk') && left !== 'sym' && right !== 'sym') {
    // Ideograph ↔ word/number/formula: always breathe a little (the same
    // 1/8 em the editor's text-autospace inserts), still flexibly.
    const natural = Math.max(gapWidth, em * AUTOSPACE_EM);
    return {natural, stretch: em * (KANJI_STRETCH_EM + AUTOSPACE_EM), shrink: em * AUTOSPACE_EM, autospace: gapWidth < em * AUTOSPACE_EM - 0.01};
  }
  const width = Math.max(gapWidth, 0);
  return {natural: width, stretch: Math.max(width * 0.55, fontSize * 0.1), shrink: Math.max(width * 0.33, 0), autospace: false};
}

/**
 * Typeset one block element in place. Returns {applied, lines, fallback} —
 * fallback keeps the paragraph untouched for CSS justification.
 */
export function typesetBlock(block, {tolerance = 1.6, slack = 1.5} = {}) {
  const document = block.ownerDocument;
  const style = getComputedStyle(block);
  const fontSize = parseFloat(style.fontSize) || 16;
  const available = block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (!(available > 80)) return {applied: false, fallback: 'narrow'};
  if ([...block.querySelectorAll('*')].some(node => BLOCK_TAGS.has(node.tagName))) return {applied: false, fallback: 'nested'};
  const text = block.textContent || '';
  if (text.replace(/\s+/g, '').length < 2) return {applied: false, fallback: 'short'};

  let atoms;
  try {atoms = collectAtoms(block);} catch {return {applied: false, fallback: 'collect'};}
  if (atoms.length > MAX_ATOMS) {restoreBlock(block);return {applied: false, fallback: 'atoms'};}
  const groups = groupAtoms(atoms);
  if (!groups.some(group => group.kind === 'tok')) {restoreBlock(block);return {applied: false, fallback: 'empty'};}

  // Measure everything on one forced line; gaps come from neighbor edges so
  // real space widths (and any CSS letter-spacing) are honored.
  const previousWhitespace = block.style.whiteSpace;
  block.style.whiteSpace = 'nowrap';
  for (const group of groups) {
    if (group.kind !== 'tok') continue;
    const head = firstRect(group), tail = lastRect(group);
    group.rect = {left: head.left, right: tail.right};
  }
  const tooWide = groups.some(group => group.rect && group.rect.right - group.rect.left > available);
  block.style.whiteSpace = previousWhitespace;
  if (tooWide) {restoreBlock(block);return {applied: false, fallback: 'wide'};}

  const stream = [];
  const boundaries = new Map(); // glue item index → {groupBefore, groupAfter, gapNode, glue}
  const boundaryDump = [];
  let previousGroup = null;
  for (const group of groups) {
    if (group.kind === 'tok') {
      if (previousGroup) {
        const gapWidth = Math.max(0, group.rect.left - previousGroup.rect.right);
        const gapGroup = groups[groups.indexOf(previousGroup) + 1];
        const gapNode = gapGroup && gapGroup.kind === 'gap' ? gapGroup.node : null;
        const glue = glueFor(previousGroup.pieces[previousGroup.pieces.length - 1], group.pieces[0], gapWidth, fontSize);
        boundaries.set(stream.length, {groupBefore: previousGroup, groupAfter: group, gapNode, glue});
        boundaryDump.push({after: previousGroup.pieces[previousGroup.pieces.length - 1].text || '[el]', before: group.pieces[0].text || '[el]', gapWidth: +gapWidth.toFixed(2), natural: +glue.natural.toFixed(2), stretch: +glue.stretch.toFixed(2), shrink: +glue.shrink.toFixed(2), autospace: glue.autospace, measuredNowrap: +(previousGroup.rect.right - previousGroup.rect.left).toFixed(2)});
        stream.push(items.glue(glue.natural, glue.stretch, glue.shrink));
      }
      for (const piece of group.pieces) {
        boundaryDump.push({piece: piece.text || '[el]', widthAtStream: +pieceNode(piece).getBoundingClientRect().width.toFixed(2)});
        stream.push(items.box(pieceNode(piece).getBoundingClientRect().width));
      }
      previousGroup = group;
    } else if (group.kind === 'br') {
      stream.push(items.penalty(FORCED_COST));
      previousGroup = null;
    } else {
      // Inter-token whitespace: it becomes the breakable glue when the next
      // token group arrives (gapNode is picked up from this group), so it
      // must NOT break the adjacency chain.
      continue;
    }
  }
  stream.push(items.glue(0, available * 10, 0));
  stream.push(items.penalty(FORCED_COST));

  const result = breakLines(stream, available - slack, {tolerance});
  if (!result) {restoreBlock(block);return {applied: false, fallback: 'tolerance'};}

  const touched = [];
  const applyMargin = (boundary, extra) => {
    const target = pieceNode(boundary.groupAfter.pieces[0]);
    const value = (boundary.glue.autospace ? fontSize * AUTOSPACE_EM : 0) + extra;
    if (Math.abs(value) < 0.01) return;
    if (target.classList?.contains('kp-token')) target.style.marginLeft = value + 'px';
    else {target.dataset.kpMargin = target.style.marginLeft || '';target.style.marginLeft = value + 'px';touched.push(target);}
  };
  const bakeBreak = boundary => {
    const anchor = pieceNode(boundary.groupAfter.pieces[0]);
    const br = document.createElement('br');
    br.dataset.kp = 'line';
    if (boundary.gapNode) {
      const hidden = document.createElement('span');
      hidden.className = 'kp-gap';
      hidden.style.display = 'none';
      boundary.gapNode.replaceWith(hidden);
      hidden.append(boundary.gapNode);
      hidden.after(br);
    } else {
      anchor.before(br);
    }
  };
  for (const line of result.lines) {
    for (let index = line.start; index < line.breakIndex; index++) {
      const boundary = boundaries.get(index);
      if (!boundary) continue;
      const {glue} = boundary;
      const extra = line.ratio >= 0 ? line.ratio * glue.stretch : line.ratio * glue.shrink;
      applyMargin(boundary, extra);
    }
    const boundary = boundaries.get(line.breakIndex);
    if (boundary) bakeBreak(boundary);
  }
  const diag = result.lines.map(line => {
    let natural = 0, stretch = 0, shrink = 0;
    for (let index = line.start; index < line.breakIndex; index++) {
      const item = stream[index];
      natural += item.width || 0;stretch += item.stretch || 0;shrink += item.shrink || 0;
    }
    return {natural: +natural.toFixed(2), stretch: +stretch.toFixed(2), shrink: +shrink.toFixed(2),
      ratio: +line.ratio.toFixed(3), predicted: +(natural + line.ratio * (line.ratio >= 0 ? stretch : shrink)).toFixed(2)};
  });
  return {applied: true, lines: result.lines.length, touched, diag, target: +(available - slack).toFixed(2), boundaryDump: boundaryDump.slice(0, 60)};
}

/** Undo every mutation typesetBlock may have made. */
export function restoreBlock(block) {
  for (const span of [...block.querySelectorAll('span.kp-token')]) span.replaceWith(...span.childNodes);
  for (const span of [...block.querySelectorAll('span.kp-gap')]) span.replaceWith(...span.childNodes);
  for (const br of [...block.querySelectorAll('br[data-kp="line"]')]) br.remove();
  for (const element of [...block.querySelectorAll('[data-kp-margin]')]) {element.style.marginLeft = element.dataset.kpMargin;element.removeAttribute('data-kp-margin');}
}

/**
 * Typeset every eligible leaf block under root (default: prose selectors).
 * Returns aggregate stats for tests and export warnings.
 */
export function typesetArticle(root, selector = 'p, li, blockquote p') {
  const stats = {applied: 0, fallback: {}, lines: 0};
  for (const block of [...root.querySelectorAll(selector)]) {
    if (!block.textContent.trim()) continue;
    try {
      const result = typesetBlock(block);
      if (result.applied) {stats.applied++;stats.lines += result.lines;}
      else stats.fallback[result.fallback] = (stats.fallback[result.fallback] || 0) + 1;
    } catch {
      restoreBlock(block);
      stats.fallback.error = (stats.fallback.error || 0) + 1;
    }
  }
  return stats;
}
