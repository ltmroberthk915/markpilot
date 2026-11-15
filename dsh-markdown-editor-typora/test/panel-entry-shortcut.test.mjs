// Panel-entry shortcut contract.
//
// Clicking the sidebar's Markdown row used to hand the click to the host, whose
// `layout.selectPanel(id)` swaps the main slot's entry key and unmounts the whole
// conversation subtree before remounting it — the long-chat stall users feel on
// every open. The plugin now short-circuits that click: it opens its own overlay
// workbench and leaves the conversation mounted.
//
// These assertions pin the parts that must not regress: the row is identified by
// our own icon inside it (not by a localized label, and not by an ancestor
// selector that only matches icon clicks), every activation path resolves the
// same row, foreign rows are left to the host, and teardown removes the listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

/** The shortcut installer, body included. */
function shortcutBody() {
  const at = source.indexOf('function installPanelEntryShortcut()');
  assert(at >= 0, 'installPanelEntryShortcut must exist');
  const rest = source.slice(at);
  // Bound the slice at the NEXT top-level installer, so a sibling function with
  // the same listener signature cannot satisfy these assertions.
  const next = rest.indexOf('\n    function installWorkspaceNavigation(', 1);
  assert(next > 0, 'installPanelEntryShortcut must be followed by the next installer');
  return rest.slice(0, next);
}

test('the sidebar row is identified by our own icon inside the button', () => {
  const body = shortcutBody();
  // Resolve the row first, then look for the marker as a descendant.
  assert.match(body, /target\.closest\("nav button"\)/,
    'the handler must resolve the enclosing row from the event target');
  assert.match(body, /row\.querySelector\("\[" \+ DOCS_PANEL_MARK \+ "\]"\)/,
    'the handler must find our icon INSIDE the resolved row');
  // The ancestor-selector form only fires when the click lands on the icon.
  assert.doesNotMatch(body, /closest\("nav button \[" \+ DOCS_PANEL_MARK/,
    'must not look for a marked ancestor: label, padding and keyboard clicks target the button');
  assert.doesNotMatch(body, /DOCS_PANEL_LABEL|aria-label/,
    'ownership must not depend on the localized label');
});

test('the marker is a static attribute on the icon we render into that row', () => {
  assert.match(source, /var DOCS_PANEL_MARK = "data-mp-docs-entry"/,
    'the marker name must be declared next to the panel registration');
  // The icon carries it, so the host's button owns a descendant with the marker.
  const iconAt = source.indexOf('function DocsPanelIcon(props)');
  assert(iconAt >= 0, 'DocsPanelIcon must exist');
  const icon = source.slice(iconAt, iconAt + 900);
  assert.match(icon, /mark\[DOCS_PANEL_MARK\] = ""/,
    'the icon must set the marker attribute');
  assert.match(icon, /Object\.assign\(\{[\s\S]*?\}, mark\)/,
    'the marker must be merged into the same svg element the host wraps');
});

test('every activation path is gated the same way', () => {
  const body = shortcutBody();
  // Rejections that keep host behavior intact.
  assert.match(body, /ev\.defaultPrevented/, 'an already-handled click must be left alone');
  assert.match(body, /ev\.button !== 0/, 'non-primary buttons must be left alone');
  assert.match(body, /ev\.metaKey \|\| ev\.ctrlKey \|\| ev\.altKey \|\| ev\.shiftKey/,
    'modified clicks must be left alone');
  // A foreign row resolves but fails the ownership check and falls through.
  assert.match(body, /if \(!ours\) return;/,
    'a row without our icon must fall through to the host');
});

test('the shortcut opens the workbench without switching the main slot', () => {
  const body = shortcutBody();
  assert.match(body, /void openWorkspace\(workspaceContext\(\)\)/,
    'the click must open the workbench directly');
  assert.match(body, /void closeWorkspaceEditor\(\)/,
    'a second activation must close it, matching the host toggle');
  // The only selectPanel call is the recovery path for "user is on another
  // panel", which must restore the conversation rather than select our page.
  const selectCalls = body.match(/selectPanel\(([^)]*)\)/g) || [];
  assert.equal(selectCalls.length, 1, 'exactly one selectPanel call is allowed');
  assert.match(selectCalls[0], /selectPanel\(null\)/,
    'that call must restore the conversation, never select our panel id');
  assert.doesNotMatch(body, /selectPanel\(DOCS_PANEL_ID\)/,
    'the shortcut must never select the plugin panel id');
});

test('the listener is capture-phase, immediate, and removed on teardown', () => {
  const body = shortcutBody();
  // Pin the registration exactly once, with the capture flag spelled literally:
  // a bubble-phase listener would run after the host's handler and be useless.
  const add = body.match(/document\.addEventListener\("[^"]*", onClick, ([^)]*)\)/g) || [];
  assert.equal(add.length, 1, 'exactly one registration is allowed');
  assert.match(add[0], /, true\)$/, 'registration must use capture:true');
  assert.doesNotMatch(add[0], /false\)$/, 'registration must not use the bubble phase');
  assert.match(body, /ev\.stopImmediatePropagation\(\)/,
    'the host handler must not also run for our row');
  // Teardown must be the returned disposer and must remove the SAME listener.
  const remove = body.match(/document\.removeEventListener\("[^"]*", onClick, true\)/g) || [];
  assert.equal(remove.length, 1, 'the returned disposer must remove the listener once');
  assert.match(body, /return function \(\) \{ try \{ document\.removeEventListener/,
    'removal must live in the function the installer returns');
});

test('the shortcut is installed through the plugin effect chain', () => {
  assert.match(source, /ctx\.effect\(\(\) => installPanelEntryShortcut\(\), "dsh-markdown-editor-typora: panel entry"\)/,
    'the shortcut must be registered as a disposable effect');
});
