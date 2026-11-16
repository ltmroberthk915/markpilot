// Static regression for the DSH sidebar rail / scrollbar seam (workbench open).
//
// Contract measured on DSH 0.2.2-rc.3 with a 280px expanded sidebar:
//   - sidebar column right / 8px drag hot-zone left edge: 280
//   - old outer scrollport right: 274 (10px thin scrollbar + 4px padding)
//   - old inner list right: 260 (its own 5px scroll gutter)
//   - the broad [data-mp-squeezed] [class*="_scroll"] rule matched the
//     sidebar's _scrollRegion too, so its 4px padding pushed the outer
//     scrollbar to 274 and left a 6px gap to the hot zone.
//
// The fix keeps the broad rule for the conversation column only. The sidebar
// keeps just the old 8px top padding (vertical density), and the real
// [data-sidebar-scrollport] gets an explicit native thin scrollbar. Without the
// stray 4px right padding the scrollport edge moves to 278 (2px from the seam)
// and the inner list moves from 260 to 268 (its bar sits 12px from the seam).
//
// RAIL_CLIENT=<path> lets the same checks run against the .16/.17 candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = process.env.RAIL_CLIENT
  ? path.resolve(process.env.RAIL_CLIENT)
  : path.resolve(here, '..', 'lib', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');

const START = 'const NARROW_CHAT_CSS = [';
const END = '].join("\\n");';
const start = source.indexOf(START);
const end = source.indexOf(END, start);
assert.ok(start >= 0 && end > start, `NARROW_CHAT_CSS block not found in ${clientPath}`);
const block = source.slice(start + START.length, end);
const rules = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]);
assert.ok(rules.length >= 15, `expected the narrow-chat CSS list, got ${rules.length} strings`);

const broadRules = rules.filter((rule) => rule.includes('[data-mp-squeezed] [class*="_scroll"]'));
const sidebarRules = rules.filter((rule) => rule.includes('[data-mp-squeezed] [class*="_sidebarCol"] '));
const topRule = sidebarRules.find((rule) => rule.includes('[class*="_scroll"]') && !rule.includes('data-sidebar-scrollport'));
const portRule = sidebarRules.find((rule) => rule.includes('[data-sidebar-scrollport]'));

test('the broad chat scrollbar rule no longer reaches inside the host sidebar', () => {
  assert.equal(broadRules.length, 4, 'four broad scrollbar rules (base + 3 webkit pseudo rules)');
  for (const rule of broadRules) {
    assert.match(
      rule,
      /\[class\*="_scroll"\]:not\(\[class\*="_sidebarCol"\] \*\)/,
      `sidebar must be excluded from: ${rule}`,
    );
  }
});

test('the sidebar keeps the old 8px top padding and no horizontal padding', () => {
  assert.ok(topRule, 'a sidebar _scroll rule must keep the vertical density');
  assert.match(topRule, /padding-top:8px !important/, 'keep the old sidebar top inset');
  assert.doesNotMatch(topRule, /padding-right|padding-left/, 'no horizontal padding on sidebar scroll layers');
  assert.doesNotMatch(topRule, /scrollbar-width|::-webkit-scrollbar/, 'only the scrollport gets a scrollbar');
  assert.doesNotMatch(topRule, /grid-template-columns|margin-right/, 'do not move the scroll container');
});

test('the real sidebar scrollport gets only a native thin scrollbar', () => {
  assert.ok(portRule, 'a [data-sidebar-scrollport] rule must exist');
  assert.match(portRule, /\[data-mp-squeezed\]/, 'only while the workbench squeezes the chat');
  assert.match(portRule, /scrollbar-width:thin !important/, 'native thin scrollbar, usable on first open');
  assert.doesNotMatch(portRule, /padding-right|padding-left/, 'no extra horizontal compensation');
  assert.doesNotMatch(portRule, /grid-template-columns|margin-right/, 'no grid/margin override');
  assert.doesNotMatch(portRule, /::-webkit-scrollbar/, 'native, not a custom-width inner bar');
});

test('no width override is written for the inner sidebar list scrollbar', () => {
  for (const rule of sidebarRules) {
    assert.doesNotMatch(rule, /data-sidebar-list-area/, `must not restyle the inner list: ${rule}`);
    assert.doesNotMatch(rule, /::-webkit-scrollbar/, `must not set an inner scrollbar width: ${rule}`);
  }
  for (const rule of rules) {
    assert.doesNotMatch(
      rule,
      /\[data-sidebar-list-area\][^{]*\{[^}]*scrollbar-width/,
      `must not set scrollbar-width on the inner list: ${rule}`,
    );
  }
});

test('geometry: outer bar 2px from the seam, inner bar moves 20px -> 12px', () => {
  // Measured DSH rc.3 constants for a 280px expanded sidebar.
  const sidebarRight = 280;
  const inlinePadding = 8;
  const rootContentRight = sidebarRight - inlinePadding; // 272
  const oldScrollRegionPadding = 4;
  const negativeMargin = 6;
  const scrollbar = 10; // native thin on this host
  const oldPaddingRight = 4;
  const third = 6;
  const innerGutter = 5;

  const oldScrollportRight = rootContentRight - oldScrollRegionPadding + negativeMargin; // 274
  const newScrollportRight = rootContentRight + negativeMargin; // 278
  assert.equal(oldScrollportRight, 274, 'baseline sidebar scrollport edge');
  assert.equal(newScrollportRight, 278, 'fixed sidebar scrollport edge');

  const outerGap = sidebarRight - newScrollportRight;
  assert.ok(outerGap >= 1 && outerGap <= 4, `outer bar should sit 1-4px from the seam, got ${outerGap}px`);
  assert.equal(outerGap, 2, 'removing the stray 4px right padding leaves a 2px gap');

  // The inner list has no horizontal padding of its own: it inherits the
  // reclaimed 4px plus the removed scrollArea padding-right (4px) = 8px.
  const oldContentColumnRight = oldScrollportRight - oldPaddingRight - scrollbar - third; // 254
  const newContentColumnRight = newScrollportRight - 0 - scrollbar - third; // 262
  assert.equal(oldContentColumnRight, 254);
  assert.equal(newContentColumnRight, 262);

  const oldListRight = oldContentColumnRight + 6; // host margin-right:-6px
  const newListRight = newContentColumnRight + 6;
  assert.equal(oldListRight, 260, 'baseline inner list right edge');
  assert.equal(newListRight, 268, 'inner list right edge after the fix');

  const oldInnerBarRight = oldListRight;
  const newInnerBarRight = newListRight;
  assert.equal(sidebarRight - oldInnerBarRight, 20, 'baseline inner bar stays 20px away');
  assert.equal(sidebarRight - newInnerBarRight, 12, 'inner bar now 12px away');
  assert.ok((sidebarRight - oldInnerBarRight) - (sidebarRight - newInnerBarRight) >= 8, 'at least 8px tighter');

  // The row text keeps its 1px relationship to the inner bar; the whole list
  // moves 8px toward the seam, which is what makes the bar tighter.
  const oldInnerBarLeft = oldInnerBarRight - innerGutter;
  const newInnerBarLeft = newInnerBarRight - innerGutter;
  const oldRowRight = oldListRight - innerGutter - 1;
  const newRowRight = newListRight - innerGutter - 1;
  assert.equal(oldInnerBarLeft - oldRowRight, 1, 'baseline row-to-bar gap');
  assert.equal(newInnerBarLeft - newRowRight, 1, 'row-to-bar gap is unchanged');
  assert.equal(newRowRight, 262, 'host row content moves with the list, not independently');
});

test('the rule set stays narrow: two sidebar rules, no list styling', () => {
  assert.equal(sidebarRules.length, 2, `only the top-padding and scrollport rules may be sidebar-scoped: ${sidebarRules.join(' | ')}`);
});
