import test from 'node:test';
import assert from 'node:assert/strict';
import {breakLines, items, FORCED_COST} from '../app/renderer/js/knuth-plass.mjs';

const {box, glue, penalty} = items;
const finisher = () => [glue(0, 1e5, 0), penalty(FORCED_COST)];

/** Compose a Latin-style paragraph: word boxes separated by space glue. */
const words = (widths, space = 10, stretch = 6, shrink = 3) => {
  const stream = [];
  widths.forEach((width, index) => {
    if (index) stream.push(glue(space, stretch, shrink));
    stream.push(box(width));
  });
  return stream;
};

/** Natural width of items[start..end) ignoring the trailing break item. */
const natural = (stream, start, end) => {
  let total = 0;
  for (let i = start; i < end; i++) total += stream[i].width || 0;
  return total;
};
/** Total shrink available inside items[start..end). */
const shrinkOf = (stream, start, end) => {
  let total = 0;
  for (let i = start; i < end; i++) total += stream[i].shrink || 0;
  return total;
};

test('Latin paragraph: every line fits, breaks only at glue, ratios in tolerance', () => {
  const stream = [...words([20, 24, 18, 22, 21, 19, 23, 20, 22, 18], 6, 3, 2), ...finisher()];
  const result = breakLines(stream, 100);
  assert.ok(result, 'feasible layout exists');
  const {lines} = result;
  assert.ok(lines.length >= 2, 'wraps into multiple lines');
  for (const line of lines) {
    assert.ok(stream[line.breakIndex].type === 'glue' || stream[line.breakIndex].type === 'penalty',
      'breaks happen at glue or the final penalty');
    assert.ok(Math.abs(line.ratio) <= 1.6 + 1e-9, `ratio ${line.ratio} within tolerance`);
  }
  // Coverage: consecutive lines tile the whole stream without gaps.
  assert.equal(lines[0].start, 0);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].start, lines[i - 1].breakIndex + 1);
  const last = lines[lines.length - 1];
  assert.equal(last.breakIndex, stream.length - 1, 'final break is the trailing forced penalty');
  // A middle line's natural width may exceed the measure only by its own
  // shrink (ratio >= -1); the engine's ratio must match that arithmetic.
  for (const line of lines.slice(0, -1)) {
    const width = natural(stream, line.start, line.breakIndex);
    const shrink = shrinkOf(stream, line.start, line.breakIndex);
    assert.ok(width - shrink <= 100 + 1e-6, `line natural width ${width} fits after shrink ${shrink}`);
    if (width > 100) {
      const expected = (100 - width) / shrink;
      assert.ok(Math.abs(line.ratio - expected) < 1e-6, `ratio ${line.ratio} matches shrink arithmetic`);
    }
  }
});

test('CJK stream: zero-width glue lets breaks fall between ideographs', () => {
  const char = () => box(16);
  const kanjiGlue = () => glue(0, 4, 1.3);
  const stream = [];
  for (let i = 0; i < 30; i++) {if (i) stream.push(kanjiGlue());stream.push(char());}
  stream.push(...finisher());
  const result = breakLines(stream, 160);
  assert.ok(result);
  const {lines} = result;
  assert.ok(lines.length > 1);
  for (const line of lines.slice(0, -1)) {
    // 160px / 16px chars ≈ 10 per line; kinsoku-free stream may fill to 10.
    assert.ok(natural(stream, line.start, line.breakIndex) <= 160 + 1e-6);
    assert.ok(line.breakIndex - line.start >= 8, 'lines use most of the measure');
  }
});

test('overwide unbreakable content reports infeasible (caller falls back to CSS)', () => {
  const stream = [box(400), glue(10, 6, 3), box(50), ...finisher()];
  assert.equal(breakLines(stream, 200), null);
  assert.equal(breakLines([], 200), null);
  assert.equal(breakLines(stream, 0), null);
});

test('forced penalty always breaks and resets the line', () => {
  const stream = [box(50), glue(10, 6, 3), box(50), penalty(FORCED_COST), glue(10, 6, 3), box(50), ...finisher()];
  const result = breakLines(stream, 300);
  assert.ok(result);
  const forcedAt = stream.findIndex(item => item.type === 'penalty' && item.cost <= FORCED_COST);
  assert.ok(result.lines.some(line => line.breakIndex === forcedAt), 'forced break is used');
  assert.equal(result.lines.length, 2);
});

test('Knuth-Plass is never looser than first-fit on a stretched case', () => {
  // Greedy fills line 1 with 4 words (70px) leaving 1 word alone; total-fit
  // balances both lines. Line counts must match or improve on greedy.
  const stream = [...words([10, 10, 10, 10, 10], 10, 12, 4), ...finisher()];
  const optimal = breakLines(stream, 70, {tolerance: 3});
  assert.ok(optimal);
  let greedyLines = 1, width = 0;
  for (let i = 0; i < stream.length - 2; i++) {
    const item = stream[i];
    if (item.type === 'box' && width + item.width > 70 && width > 0) {greedyLines++;width = item.width;}
    else width += item.width || 0;
  }
  assert.ok(optimal.lines.length <= greedyLines);
  const demerits = optimal.lines.reduce((total, line) => total + (1 + Math.abs(line.ratio) * 100) ** 2, 0);
  assert.ok(Number.isFinite(demerits));
});

test('empty final line is never produced', () => {
  const stream = [box(30), glue(10, 6, 3), box(30), ...finisher()];
  const result = breakLines(stream, 500);
  assert.ok(result);
  assert.equal(result.lines.length, 1);
});
