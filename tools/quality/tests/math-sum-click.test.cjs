'use strict';
/* Focused regression for display ∑ body clicks. The fixture mirrors the real
   KaTeX 0.19.0 shape: the outer .mop container carries the source range while
   the large .op-symbol glyph has none, and \boxed's fbox is the hit target. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const project = path.resolve(__dirname, '../../../dsh-markpilot');
const main = fs.readFileSync(path.join(project, 'src-cm6/main.js'), 'utf8');
const fnStart = main.indexOf('function mathGlyphOffset(');
const fnEnd = main.indexOf('/* ══ 【B-1·③', fnStart);
assert(fnStart > 0 && fnEnd > fnStart, 'mathGlyphOffset source slice');
const mathGlyphOffset = new Function(main.slice(fnStart, fnEnd) + '\nreturn mathGlyphOffset;')();
const mathMap = import(pathToFileURL(path.join(project, 'src-cm6/math-source-map.js')).href);

const LOC = '[data-typora-source-start]';
const LINE = '.frac-line,.overline-line,.underline-line';
const OP = '.mop.op-symbol';
const src = (start, end) => ({ 'data-typora-source-start': start, 'data-typora-source-end': end });

class Node {
  constructor({ cls = '', attrs = {}, rect = [0, 0, 0, 0], text = '', children = [] } = {}) {
    this.className = cls;
    this.attrs = { ...attrs };
    this.rect = rect;
    this.text = text;
    this.children = [];
    this.parent = null;
    for (const child of children) this.append(child);
  }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
    return this;
  }
  get classList() {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    return { contains: (name) => set.has(name) };
  }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  getAttribute(name) { return this.hasAttribute(name) ? String(this.attrs[name]) : null; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  getBoundingClientRect() {
    const [left, top, width, height] = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  getClientRects() {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (matches(node, selector)) return node;
    return null;
  }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
}

function matches(node, selector) {
  if (selector === LOC) return node.hasAttribute('data-typora-source-start');
  if (selector === OP) return node.classList.contains('mop') && node.classList.contains('op-symbol');
  if (selector === LINE) return ['frac-line', 'overline-line', 'underline-line'].some((name) => node.classList.contains(name));
  throw new Error('unexpected selector: ' + selector);
}

const node = (options) => new Node(options);

/* \boxed{\sum_i x+\sum_j y}
   \boxed 0..5  { 6  \sum 7..10  _ 11  i 12  space 13  x 14  + 15
   \sum 16..19  _ 20  j 21  space 22  y 23  } 24 */
const BOXED_TEX = String.raw`\boxed{\sum_i x+\sum_j y}`;

function boxedSums() {
  const holder = node({ cls: 'mp-cm6-math-block', rect: [0, 0, 720, 200] });
  const boxed = node({ cls: 'mord', attrs: src(0, 6), rect: [0, 0, 720, 150] });
  const fbox = node({ cls: 'katex-stretchy fbox', rect: [0, 0, 720, 150] });
  const sum1 = node({ cls: 'mop op-limits', attrs: src(7, 11), rect: [30, 20, 180, 110] });
  const glyph1 = node({ cls: 'mop op-symbol large-op', rect: [80, 30, 60, 50], text: '∑' });
  const sub1 = node({
    cls: 'katex-sizing reset-size6 size3 mtight', attrs: src(12, 13), rect: [100, 100, 20, 20],
    children: [node({ cls: 'mord mathnormal mtight', rect: [100, 100, 20, 20], text: 'i' })],
  });
  const x = node({ cls: 'mord mathnormal', attrs: src(14, 15), rect: [240, 50, 15, 20], text: 'x' });
  const plus = node({ cls: 'mbin', attrs: src(15, 16), rect: [270, 50, 15, 20], text: '+' });
  const sum2 = node({ cls: 'mop op-limits', attrs: src(16, 20), rect: [320, 20, 180, 110] });
  const glyph2 = node({ cls: 'mop op-symbol large-op', rect: [370, 30, 60, 50], text: '∑' });
  const sub2 = node({
    cls: 'katex-sizing reset-size6 size3 mtight', attrs: src(21, 22), rect: [390, 100, 20, 20],
    children: [node({ cls: 'mord mathnormal mtight', rect: [390, 100, 20, 20], text: 'j' })],
  });
  const y = node({ cls: 'mord mathnormal', attrs: src(23, 24), rect: [540, 50, 15, 20], text: 'y' });
  holder.append(boxed);
  boxed.append(fbox, sum1, x, plus, sum2, y);
  sum1.append(glyph1, sub1);
  sum2.append(glyph2, sub2);
  return { holder, boxed, fbox, sum1, glyph1, sub1, x, plus, sum2, glyph2, sub2, y };
}

function click(holder, target, clientX, clientY) {
  return mathGlyphOffset(holder, { target, clientX, clientY }, holder.tex);
}

test('display ∑ body maps to its own \\sum command for left/middle/right points', () => {
  for (const holderCls of ['mp-cm6-math-block', 'mp-inline-float']) {
    const f = boxedSums();
    f.holder.className = holderCls;
    f.holder.tex = BOXED_TEX;
    for (const x of [85, 110, 135]) {
      assert.equal(click(f.holder, f.fbox, x, 55), 8, `${holderCls} x=${x}`);
    }
  }
});

test('repeated ∑ glyphs map to their own source range, never the first match', () => {
  const f = boxedSums();
  f.holder.tex = BOXED_TEX;
  assert.equal(click(f.holder, f.fbox, 110, 55), 8);
  assert.equal(click(f.holder, f.fbox, 400, 55), 17);
});

test('unboxed display ∑ bodies use the same per-glyph mapping', () => {
  /* \sum_i x+\sum_j y: \sum 0..3, _ 4, i 5, space 6, x 7, + 8,
     \sum 9..12, _ 13, j 14, space 15, y 16 */
  const tex = String.raw`\sum_i x+\sum_j y`;
  const holder = node({ rect: [0, 0, 500, 180] });
  const sum1 = node({ cls: 'mop op-limits', attrs: src(0, 4), rect: [10, 20, 150, 100] });
  const glyph1 = node({ cls: 'mop op-symbol large-op', rect: [50, 30, 50, 45], text: '∑' });
  const sub1 = node({ cls: 'katex-sizing mtight', attrs: src(5, 6), rect: [65, 90, 20, 20] });
  const x = node({ cls: 'mord mathnormal', attrs: src(7, 8), rect: [180, 50, 15, 20], text: 'x' });
  const plus = node({ cls: 'mbin', attrs: src(8, 9), rect: [210, 50, 15, 20], text: '+' });
  const sum2 = node({ cls: 'mop op-limits', attrs: src(9, 13), rect: [250, 20, 150, 100] });
  const glyph2 = node({ cls: 'mop op-symbol large-op', rect: [290, 30, 50, 45], text: '∑' });
  const sub2 = node({ cls: 'katex-sizing mtight', attrs: src(14, 15), rect: [305, 90, 20, 20] });
  const y = node({ cls: 'mord mathnormal', attrs: src(16, 17), rect: [420, 50, 15, 20], text: 'y' });
  holder.append(sum1, x, plus, sum2, y); sum1.append(glyph1, sub1); sum2.append(glyph2, sub2); holder.tex = tex;
  assert.equal(click(holder, glyph1, 75, 50), 1);
  assert.equal(click(holder, glyph2, 315, 50), 10);
});

test('subscript and neighbouring text keep the existing half-cell conventions', () => {
  const f = boxedSums();
  f.holder.tex = BOXED_TEX;
  assert.equal(click(f.holder, f.fbox, 105, 110), 12, 'left half of i');
  assert.equal(click(f.holder, f.fbox, 115, 110), 13, 'right half of i');
  assert.equal(click(f.holder, f.fbox, 247, 60), 14, 'left half of x');
  assert.equal(click(f.holder, f.fbox, 252, 60), 15, 'right half of x');
});

test('a followed \\int keeps its own source and the command convention', () => {
  const tex = String.raw`\int+y`;
  const holder = node({ rect: [0, 0, 300, 120] });
  const owner = node({ cls: 'mop', attrs: src(0, 4), rect: [10, 20, 60, 80] });
  const glyph = node({ cls: 'mop op-symbol large-op', attrs: src(0, 4), rect: [20, 30, 40, 50], text: '∫' });
  const plus = node({ cls: 'mbin', attrs: src(4, 5), rect: [80, 50, 15, 20], text: '+' });
  const y = node({ cls: 'mord mathnormal', attrs: src(5, 6), rect: [100, 50, 15, 20], text: 'y' });
  holder.append(owner, plus, y); owner.append(glyph); holder.tex = tex;
  assert.equal(click(holder, glyph, 40, 55), 1);
});

test('a bare \\sum with its own mapping keeps the command convention', () => {
  const tex = String.raw`\sum+y`;
  const holder = node({ rect: [0, 0, 300, 120] });
  const owner = node({ cls: 'mop op-symbol large-op', attrs: src(0, 4), rect: [10, 20, 60, 80], text: '∑' });
  const plus = node({ cls: 'mbin', attrs: src(4, 5), rect: [80, 50, 15, 20], text: '+' });
  const y = node({ cls: 'mord mathnormal', attrs: src(5, 6), rect: [100, 50, 15, 20], text: 'y' });
  holder.append(owner, plus, y); holder.tex = tex;
  assert.equal(click(holder, owner, 40, 55), 1);
});

test('fraction and underline lines keep priority over the glyph candidate', () => {
  /* \frac{\sum_i x}{y}: \frac 0..4, { 5, \sum 6..9, _ 10, i 11, space 12,
     x 13, } 14, { 15, y 16, } 17 */
  const tex = String.raw`\frac{\sum_i x}{y}`;
  const holder = node({ rect: [0, 0, 400, 160] });
  const frac = node({ cls: 'mord', attrs: src(0, 5), rect: [0, 0, 400, 160] });
  const line = node({ cls: 'frac-line', rect: [50, 70, 90, 2] });
  const sum = node({ cls: 'mop op-limits', attrs: src(6, 10), rect: [50, 40, 90, 70] });
  const glyph = node({ cls: 'mop op-symbol large-op', rect: [60, 45, 60, 50], text: '∑' });
  const sub = node({ cls: 'katex-sizing mtight', attrs: src(11, 12), rect: [70, 90, 20, 20] });
  const x = node({ cls: 'mord mathnormal', attrs: src(13, 14), rect: [200, 70, 15, 20], text: 'x' });
  const y = node({ cls: 'mord mathnormal', attrs: src(16, 17), rect: [220, 70, 15, 20], text: 'y' });
  holder.append(frac); frac.append(line, sum, x, y); sum.append(glyph, sub); holder.tex = tex;
  assert.equal(click(holder, line, 90, 71), 1, 'line wins on the line');
  assert.equal(click(holder, glyph, 90, 60), 7, 'glyph body routes to \\sum');
});

test('a display ∑ that is the tail still follows the end-of-line rule', () => {
  const tex = String.raw`\sum`;
  const holder = node({ rect: [0, 0, 200, 100] });
  const owner = node({ cls: 'mop op-limits', attrs: src(0, 4), rect: [10, 10, 80, 70] });
  const glyph = node({ cls: 'mop op-symbol large-op', rect: [20, 20, 50, 40], text: '∑' });
  holder.append(owner); owner.append(glyph); holder.tex = tex;
  assert.equal(click(holder, glyph, 40, 40), 4);
});

test('quoted source maps the ∑ command offset after the line prefix', async () => {
  const { mappedMathSource, mathSourcePosition } = await mathMap;
  const tex = String.raw`\boxed{\sum_i\int_{\underline a}^{\infty}a\,\mu_i(a)\,\mathrm{d}a=0}\ \implies\ \text{定出}\ r`;
  for (const prefix of ['> ', '> > ', '> >   ']) {
    const doc = prefix + tex;
    const from = doc.indexOf(String.raw`\boxed`);
    const span = mappedMathSource([{ text: tex, from }]);
    assert.equal(span.tex, tex);
    assert.equal(mathSourcePosition(span, 7), doc.indexOf(String.raw`\sum`), prefix + ' slash');
    assert.equal(mathSourcePosition(span, 8), doc.indexOf(String.raw`\sum`) + 1, prefix + ' command offset');
    assert.equal(doc[mathSourcePosition(span, 7)], '\\');
    assert.equal(mathSourcePosition(span, 12), from + 12, prefix + ' subscript i');
    assert.equal(mathSourcePosition(span, 14), doc.indexOf(String.raw`\int`) + 1, prefix + ' int command');
  }
});
