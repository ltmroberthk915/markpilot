// Compact-chrome contract for the DSH split workbench.
//
// These assertions pin the parts of the compact layout that must not drift:
// the setting exists and defaults on, the stylesheet is scoped to a flag the
// engine only writes while the workbench is open, the wide rule keeps the
// title row and the view tabs on one line, and the sidebar rules exclude the
// drawer, the collapsed rail and the Windows caption.
//
// Geometry and hit-testing are proven separately by the offline DOM replay in
// `.mp-verify/compact/` (real host CSS + real injected stylesheet); this file
// guards the contract that replay depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

/** The stylesheet the plugin injects, read verbatim from the shipped source. */
function layoutCss() {
  const match = source.match(/const LAYOUT_STYLE_CSS = `([\s\S]*?)`;\n/);
  assert(match, 'lib/client.js must define LAYOUT_STYLE_CSS');
  return match[1];
}

/**
 * Parse the stylesheet into rule blocks, resolving CSS nesting.
 *
 * The sheet nests (`&` children inside a scoped parent). A flat regex over
 * flattened text confuses parent declarations with child ones, so this walks
 * the braces once, splits each block into its own declarations and its child
 * blocks, and rewrites `&` to the parent selector. Assertions can then name a
 * rule by any fragment of its fully resolved selector.
 * @param {string} css - the injected stylesheet.
 * @returns {{selector: string, decls: string}[]} every rule, parents and children.
 */
function parseRules(css, parentSelector = '') {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let decls = '';
  let buffer = '';
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') {
      // `buffer` is a selector; find its matching close brace.
      let d = 0;
      let j = i;
      for (; j < clean.length; j += 1) {
        if (clean[j] === '{') d += 1;
        else if (clean[j] === '}') { d -= 1; if (d === 0) break; }
      }
      const rawSelector = buffer.trim();
      const selector = parentSelector === ''
        ? rawSelector
        : rawSelector.replace(/&/g, parentSelector);
      out.push(...parseRules(clean.slice(i + 1, j), selector));
      buffer = '';
      i = j;
      continue;
    }
    if (ch === ';') {
      decls += `${buffer.trim()};`;
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  // The last declaration of a block has no trailing semicolon.
  if (buffer.trim() !== '') decls += `${buffer.trim()};`;
  if (parentSelector !== '' && decls !== '') out.unshift({ selector: parentSelector, decls: decls.trim() });
  return out;
}

/**
 * The last compound of a resolved selector (its own subject), so a parent that
 * merely mentions a fragment inside `:has(...)` never satisfies a child query.
 * Splits on combinators, whitespace and `>`/`+`/`~`, then returns the trailing
 * compound.
 * @param {string} selector - a fully resolved selector.
 * @returns {string} the trailing compound selector.
 */
function subject(selector) {
  const parts = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/** Declarations of the first rule whose own subject contains every fragment. */
function declsFor(css, ...fragments) {
  const hit = parseRules(css).find((rule) => {
    const tail = subject(rule.selector);
    return fragments.every((f) => tail.includes(f));
  });
  return hit ? hit.decls : null;
}

/**
 * Declarations of the first rule that is scoped by `scope` AND whose own
 * subject contains every fragment. Use this when the distinguishing part of
 * the selector is an ancestor (`[data-mp-chrome="wide"]`), not the subject.
 * @param {string} css - the injected stylesheet.
 * @param {string} scope - a fragment that must appear in the full selector.
 * @param {...string} fragments - fragments the subject must contain.
 * @returns {string|null} the declarations, or null when no rule matches.
 */
function scopedDeclsFor(css, scope, ...fragments) {
  const hit = parseRules(css).find((rule) => {
    if (!rule.selector.includes(scope)) return false;
    const tail = subject(rule.selector);
    return fragments.every((f) => tail.includes(f));
  });
  return hit ? hit.decls : null;
}

test('the compact switch defaults on and survives a settings round trip', () => {
  const defaults = source.match(/const SETTINGS_DEFAULTS = \{([\s\S]*?)\n\};/);
  assert(defaults, 'SETTINGS_DEFAULTS must exist');
  assert.match(defaults[1], /compactChrome:\s*true/, 'compactChrome must default to true');

  const reader = source.match(/function readSettings\(storage\) \{([\s\S]*?)\n\}/);
  assert(reader, 'readSettings must exist');
  assert.match(reader[1], /compactChrome:\s*SETTINGS_DEFAULTS\.compactChrome/,
    'readSettings must seed compactChrome from the defaults');
  assert.match(reader[1], /typeof s\.compactChrome === "boolean"/,
    'readSettings must only accept a boolean compactChrome');

  assert.match(source, /compactChrome: e\.target\.checked/,
    'the settings section must write compactChrome from its checkbox');
  assert.match(source, /"aria-label": "紧凑工作台"/,
    'the settings checkbox must be reachable by name');
});

test('the flag is written only from the engine and removed on restore', () => {
  // Written in apply(): wide/narrow chosen from the conversation column width.
  const writer = source.match(/var chrome = cfg\.compactChrome === false \? null : \(rect\.width >= 680 \? "wide" : "narrow"\);/);
  assert(writer, 'apply() must derive wide/narrow from the measured column width');

  // Removed in restore(): no residue after close, setting off, or teardown.
  assert.match(source, /state\.root\.removeAttribute\("data-mp-chrome"\)/,
    'restore() must drop the compact flag');

  // The setting can change while the workbench is open.
  assert.match(source, /cfg\.compactChrome = readSettings\(storage\)\.compactChrome;/,
    'mountLayout must read the setting before building the engine');
  assert.match(source, /var syncChrome = function \(event\) \{/,
    'a settings listener must re-apply when the switch changes');
  assert.match(source, /win\.removeEventListener\(SETTINGS_CHANGED_EVENT, syncChrome\)/,
    'the settings listener must be removed on teardown');
});

test('the stylesheet is scoped so an inactive workbench renders the host layout', () => {
  const css = layoutCss();
  const rules = parseRules(css);
  // The width-handle rule is the only one allowed to act without the flag; it
  // hangs off data-mp-layout, which is written and removed by the same engine.
  const global = rules.filter((rule) => !rule.selector.includes('[data-mp-chrome'));
  assert.equal(global.length, 1, 'exactly one rule may exist outside the compact flag');
  assert.match(global[0].selector, /\[data-mp-layout="on"\] \[data-width-handle\]/,
    'the unscoped rule must be the width-handle suppression');
  assert.match(global[0].decls, /display:\s*none/);

  // Every other rule is gated on the flag the engine writes and removes.
  const compact = rules.filter((rule) => rule.selector.includes('[data-mp-chrome'));
  assert(compact.length >= 20, 'expected the header, wide, narrow and sidebar rule sets');
  for (const rule of compact) {
    const gated = rule.selector.includes('[data-mp-chrome]')
      || rule.selector.includes('[data-mp-chrome="wide"]')
      || rule.selector.includes('[data-mp-chrome="narrow"]')
      || rule.selector.includes(':has([data-mp-chrome])');
    assert(gated, `ungated compact rule: ${rule.selector}`);
  }
});

test('wide layout puts the title group and the view tabs on one line, in reading order', () => {
  const css = layoutCss();
  const wide = parseRules(css).find((r) =>
    r.selector.includes('[data-mp-chrome="wide"]') && subject(r.selector).startsWith('header[data-window-drag]'));
  assert(wide, 'the wide header rule must be present');
  assert.match(wide.decls, /display:\s*flex/, 'the wide header must be a single flex row');
  assert.match(wide.decls, /flex-wrap:\s*nowrap/, 'the wide header must not wrap');

  // Reading order: title (1) -> tabs (2) -> utilities (3) -> corner (4).
  const order = (fragment) => {
    const rule = parseRules(css).find((r) =>
      r.selector.includes('[data-mp-chrome="wide"]') && r.selector.endsWith(fragment));
    assert(rule, `the wide rule must place ${fragment}`);
    const m = rule.decls.match(/order:\s*(\d+)/);
    assert(m, `${fragment} must carry an explicit order`);
    return Number(m[1]);
  };
  const titleOrder = order('[class*="_titleCluster"]');
  const tabOrder = order('div:has(> [data-conversation-tabs])');
  const utilOrder = order('[class*="_headerUtilities"]');
  const cornerOrder = order('[data-conversation-header-corner]');
  assert(titleOrder < tabOrder, 'the title must precede the tabs');
  assert(tabOrder < utilOrder, 'the tabs must precede the trailing tools');
  assert(utilOrder < cornerOrder, 'the utilities must precede the corner seat');

  // The gap between the title group and the tabs is the design's 14px, and the
  // tab row's width must not depend on the visible tab count.
  const tabRow = parseRules(css).find((r) =>
    r.selector.includes('[data-mp-chrome="wide"]') && r.selector.endsWith('div:has(> [data-conversation-tabs])'));
  assert.match(tabRow.decls, /margin-inline-start:\s*14px/, 'the title-to-tabs gap must be 14px');
  assert.match(tabRow.decls, /width:\s*clamp\(/, 'the tab row must use a fixed clamp, not a content-derived width');
});

test('narrow layout is two rows with the tab row aligned to the title start', () => {
  const css = layoutCss();
  const narrow = parseRules(css).find((r) =>
    r.selector.includes('[data-mp-chrome="narrow"]') && subject(r.selector).startsWith('header[data-window-drag]'));
  assert(narrow, 'the narrow header rule must be present');
  assert.match(narrow.decls, /display:\s*grid/, 'the narrow header must be a two-row grid');
  assert.match(narrow.decls, /grid-template-rows:\s*auto auto/, 'the narrow header must define two rows');

  const place = (fragment) => {
    const rule = parseRules(css).find((r) =>
      r.selector.includes('[data-mp-chrome="narrow"]') && r.selector.endsWith(fragment));
    assert(rule, `the narrow rule must place ${fragment}`);
    const m = rule.decls.match(/grid-area:\s*([\d/ ]+)/);
    assert(m, `${fragment} must carry a grid-area`);
    return m[1].trim();
  };
  // Title, utilities and corner share row 1; the tab row starts row 2.
  assert.match(place('[class*="_titleCluster"]'), /^1\//, 'the title sits on row 1');
  assert.match(place('[class*="_headerUtilities"]'), /^1\//, 'the utilities sit on row 1');
  assert.match(place('[data-conversation-header-corner]'), /^1\//, 'the corner sits on row 1');
  const tabArea = place('div:has(> [data-conversation-tabs])');
  assert.match(tabArea, /^2\/2/, 'the tab row must start on row 2 at the title column');

  // Row 2 must start at the title's own start edge.
  const tabRule = parseRules(css).find((r) =>
    r.selector.includes('[data-mp-chrome="narrow"]') && r.selector.endsWith('div:has(> [data-conversation-tabs])'));
  assert.match(tabRule.decls, /margin-inline-start:\s*0/, 'the tab row must not be pushed off the title start');
});

test('the tab strip keeps its width so the host can still count visible views', () => {
  const css = layoutCss();
  // DSH measures the tab row's clientWidth to decide how many views stay
  // visible and how many move into its More menu. Collapsing it to zero (or
  // hiding it) would silently drop views, so no rule may do that.
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('[data-conversation-tabs]')) continue;
    assert.doesNotMatch(rule.decls, /display:\s*none/,
      `the tab strip must never be display:none (${rule.selector})`);
    assert.doesNotMatch(rule.decls, /visibility:\s*hidden/,
      `the tab strip must never be visibility:hidden (${rule.selector})`);
    assert.doesNotMatch(rule.decls, /(?:^|;)\s*width:\s*0(?:px)?(?:;|$)/,
      `the tab strip must keep a measurable width (${rule.selector})`);
  }
  // The shared rule keeps the strip on one line without shrinking it.
  const strip = declsFor(css, '[data-conversation-tabs]');
  assert(strip, 'the shared rule must lay the strip out');
  assert.match(strip, /flex-wrap:\s*nowrap/, 'the strip must lay out on one line');
});

test('every control in the compact row stays a hit target', () => {
  const css = layoutCss();
  const more = declsFor(css, '[class*="_viewsMore"][aria-haspopup="menu"]');
  assert(more, 'the More launcher must keep an explicit box');
  assert.match(more, /min-width:\s*28px/, 'the More launcher needs a 28px wide hit box');
  assert.match(more, /min-height:\s*28px/, 'the More launcher needs a 28px tall hit box');

  const tab = declsFor(css, '[role="tab"]');
  assert(tab, 'tabs must keep an explicit box');
  assert.match(tab, /--dsh-tab-hit-inline:\s*8px/, 'tabs must keep an inline hit band');
  assert.match(tab, /min-height:\s*28px/, 'tabs must keep a 28px tall hit box');

  // The utilities seat is lifted above the title cluster's fade band so its
  // button, not the band, receives the click.
  const utilities = declsFor(css, '[class*="_headerUtilities"]');
  assert.match(utilities, /position:\s*relative/, 'the utilities seat needs its own stacking context');
  assert.match(utilities, /z-index:\s*1/, 'the utilities seat must sit above the title cluster fade');

  // Resting chrome must stay the host's: the compact rules may only add hover
  // and focus feedback, never a new resting fill, border, shadow or type size.
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('[data-mp-chrome')) continue;
    assert.doesNotMatch(rule.decls, /box-shadow/, `no new shadow (${rule.selector})`);
    assert.doesNotMatch(rule.decls, /font-size:\s*(?!inherit)/, `no new type size (${rule.selector})`);
    // A background is only allowed on a hover/focus state.
    if (/background/.test(rule.decls)) {
      assert.match(rule.selector, /:hover|:focus/,
        `resting background added by ${rule.selector}`);
    }
    // Same for borders beyond the header's own hairline.
    if (/(?:^|;)\s*border(?:-(?:top|right|bottom|left))?:/.test(rule.decls)) {
      assert.ok(rule.selector.includes('header[data-window-drag]') || /:hover|:focus/.test(rule.selector),
        `resting border added by ${rule.selector}`);
    }
  }

  // The header itself must not clip its occupants. The title cluster clips its
  // own text (that is the host's ellipsis), but no rule may clip the header.
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('[data-slot="conversation.header"]')) continue;
    const clipsHeader = /overflow(?:-x|-y)?:\s*(?:hidden|clip)/.test(rule.decls)
      && !rule.selector.includes('[class*="_titleCluster"]');
    assert.ok(!clipsHeader, `the compact header must not clip its controls (${rule.selector})`);
  }
});

test('sidebar rules apply only to the expanded column, never the drawer or rail', () => {
  const css = layoutCss();
  const scope = parseRules(css).find((rule) => rule.selector.includes('[data-mp-squeezed]'));
  assert(scope, 'the sidebar rule block must exist');
  assert.match(scope.selector, /:not\(\[data-sidebar-drawer\]\)/,
    'sidebar rules must exclude the drawer');
  assert.match(scope.selector, /:not\(\[data-sidebar-collapsed="true"\]\)/,
    'sidebar rules must exclude the collapsed rail');
  assert.match(scope.selector, /:has\(\[data-mp-chrome\]\)/,
    'sidebar rules must apply only while the compact flag is on');

  const logo = declsFor(css, '[class*="_logoRow"]');
  assert.match(logo, /height:\s*32px/, 'the brand row must shrink');
  // Brand, entry button and panel rows share one inline start.
  assert.match(logo, /padding:\s*0 0 0 12px/, 'the brand row must keep the column left rhythm');
  const newSession = declsFor(css, 'button[class*="_newSession"]');
  assert.match(newSession, /height:\s*30px/, 'the new-session bar must shrink');
  assert.match(newSession, /padding-inline:\s*12px/, 'the entry button must share the left rhythm');
  const panelRow = declsFor(css, 'button[class*="_panelRow"]');
  assert.match(panelRow, /min-height:\s*28px/, 'panel rows must shrink');
  // A tall plugin footer scrolls instead of pushing the session list out.
  const foot = declsFor(css, '[class*="_footArea"]');
  assert.match(foot, /max-height:\s*32%/, 'the footer must cap its height');
  assert.match(foot, /overflow-y:\s*auto/, 'the footer must scroll');

  // Keyboard focus stays visible on the sidebar controls. Each interactive
  // sidebar control must have its OWN :focus-visible rule that draws a ring.
  const focusRules = parseRules(css).filter((rule) =>
    rule.selector.includes('[data-mp-squeezed]') && rule.selector.includes(':focus-visible'));
  assert(focusRules.length > 0, 'sidebar controls need a visible focus ring');
  const ringed = new Set();
  for (const rule of focusRules) {
    assert.match(rule.decls, /outline:\s*2px solid/, `focus ring must be drawn (${rule.selector})`);
    if (rule.selector.includes('_newSession')) ringed.add('newSession');
    if (rule.selector.includes('_panelRow')) ringed.add('panelRow');
  }
  assert.deepEqual([...ringed].sort(), ['newSession', 'panelRow'],
    'both the entry button and the panel rows need their own focus ring');
  // The ring must be on :focus-visible, never only on hover.
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('[data-mp-squeezed]')) continue;
    if (!/outline:\s*2px solid/.test(rule.decls)) continue;
    assert.match(rule.selector, /:focus-visible/,
      `the sidebar ring belongs to :focus-visible (${rule.selector})`);
  }

  // Nothing here may touch the Windows caption strip or the frame zoom.
  for (const rule of parseRules(css)) {
    if (!rule.selector.includes('[data-mp-squeezed]')) continue;
    assert.doesNotMatch(rule.decls, /windows-titlebar|zoom|transform:\s*scale/,
      `sidebar rules must not touch the Windows caption or the frame zoom (${rule.selector})`);
  }
});

test('dsh-ui-alt keeps ownership when its own compact header is on', () => {
  const css = layoutCss();
  // Every header rule (shared, wide, narrow) stands down under dsh-ui-alt.
  const headerRules = parseRules(css).filter((rule) =>
    rule.selector.includes('[data-mp-chrome') && rule.selector.includes('header[data-window-drag]'));
  assert(headerRules.length >= 3, 'expected the shared, wide and narrow header rules');
  for (const rule of headerRules) {
    assert.match(rule.selector, /html:not\(\[data-dcc-enabled="on"\]\[data-dcc-compact-header="on"\]\)/,
      `header rule must stand down under dsh-ui-alt (${rule.selector})`);
  }
});

test('selectors survive the host adding state classes', () => {
  const css = layoutCss();
  // DSH appends state classes to some elements (e.g. "_treeBody _wide"), which
  // breaks suffix matching. Compact rules must use substring matching.
  // Check every resolved selector, so a suffix matcher anywhere in a nested
  // block is caught (a line filter would miss it).
  const compact = parseRules(css).filter((rule) => rule.selector.includes('[data-mp-chrome'));
  assert(compact.length > 0, 'expected compact rules to inspect');
  for (const rule of compact) {
    assert.doesNotMatch(rule.selector, /\[class\$=/,
      `compact rules must not use suffix matching (${rule.selector})`);
  }
  // And the host classes we depend on are matched by substring.
  const titleRow = parseRules(css).find((rule) => rule.selector.includes('_titleRow'));
  assert(titleRow, 'a title-row rule must exist');
  assert.match(titleRow.selector, /\[class\*="_titleRow"\]/,
    'the title row must match by substring');
});














