// Drop-in replacement for dsh-markdown-editor-typora/test/rail-layout.test.mjs.
//
// The shipped test still asserts the 1.5.0 top-rail contract
// (flex:0 0 28px / height:28 / popover top:34). Commit 2bbe3e8
// ("release: 2.0.7") replaced it with an out-of-flow bottom overlay
// (.mp-rail{position:absolute;...;bottom:28px}, data-mp-rail-anchor=bottom)
// and moved the popover to bottom:56. The product behavior follows its
// current documented contract; only these assertions were stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const findByClass = (tree, name) => nodes(tree).find((n) => n.props?.className === name);
const directChildren = (tree) => (tree.children || []).filter(Boolean);
function cssRule(tree, selector) {
  const style = nodes(tree).find((n) => n?.type === 'style');
  const text = String(style?.children?.[0] ?? '');
  const match = text.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*\\}'));
  assert(match, `expected a CSS rule for ${selector}`);
  return match[0];
}

test('rail is a bottom overlay above the editor status bar and the iframe fills the rest in every phase', async () => {
  const h = make();
  await h.boot();
  const phases = [
    { phase: 'loading', detail: '' },
    { phase: 'ready', detail: '', saveStatus: '' },
    { phase: 'ready', detail: '', saveStatus: 'unsaved' },
    { phase: 'ready', detail: '', saveStatus: 'saved' },
    { phase: 'error', detail: 'SAVE_FAILED' },
    { phase: 'conflict', detail: 'STALE' },
    { phase: 'recovery', detail: '', recovery: { text: 'DRAFT', baseVersion: 'v1', ts: 1 } },
  ];
  for (const state of phases) {
    h.setUiForRender(state);
    const tree = h.render();
    const rail = findByClass(tree, 'mp-rail');
    assert(rail, `rail present in ${state.phase}`);
    assert.equal(rail.props.role, 'toolbar');
    assert.equal(rail.props['data-mp-rail-anchor'], 'bottom');

    // Current contract: the rail is out of flow. It must not claim a flex row
    // (the old 1.5.0 contract put flex:0 0 28px + fixed 28px height here).
    assert.equal(rail.props.style.flex, undefined, 'rail must not reserve flex space');
    assert.equal(rail.props.style.height, undefined, 'rail must not set an inline height');
    assert.equal(rail.props.style.minHeight, undefined);
    assert.equal(rail.props.style.maxHeight, undefined);

    const railCss = cssRule(tree, '.mp-rail');
    for (const decl of [
      'position:absolute', 'left:0', 'right:0', 'bottom:28px', 'height:auto',
      'box-sizing:border-box', 'pointer-events:none',
    ]) {
      assert.ok(railCss.includes(decl), `rail CSS keeps ${decl}: ${railCss}`);
    }

    // The root is the positioning context and column flex container.
    assert.equal(tree.props.style.position, 'relative');
    assert.equal(tree.props.style.display, 'flex');
    assert.equal(tree.props.style.flexDirection, 'column');
    assert.equal(tree.props.style.width, '100%');
    assert.equal(tree.props.style.height, '100%');
    assert.equal(tree.props.style.minHeight, 0);

    // The iframe stays the only in-flow child and keeps the full editor area.
    const iframe = nodes(tree).find((n) => n?.type === 'iframe');
    assert(iframe, `iframe present in ${state.phase}`);
    assert.equal(iframe.props.style.flex, '1 1 auto');
    assert.equal(iframe.props.style.minHeight, 0);
    assert.equal(iframe.props.style.width, '100%');
    assert.equal(iframe.props.style.height, 'auto');
    assert.equal(iframe.props.style.border, 0);

    const children = directChildren(tree);
    assert.ok(children.indexOf(rail) >= 0, 'rail is a direct child of the editor root');
    assert.ok(children.indexOf(iframe) > children.indexOf(rail), 'iframe follows the rail sibling');
  }
  h.cleanup();
});

test('rail preserves conflict actions and renders the recovered popover as a sibling overlay', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    phase: 'conflict',
    detail: 'STALE',
    recovered: [{ recoveryPath: 'D:/fixture/recovered.md', at: 1 }],
    railOpen: false,
  });
  const tree = h.render();
  const labels = nodes(tree).filter((n) => n.type === 'button').map((n) => (n.children || []).join(''));
  assert.ok(labels.includes('重载磁盘版本'));
  assert.ok(labels.includes('复制我的内容'));
  assert.ok(labels.includes('复制路径'));

  const children = directChildren(tree);
  const popover = findByClass(tree, 'mp-rail-popover');
  assert(popover, 'recovered popover present');
  assert.ok(children.includes(popover), 'popover is a direct sibling of rail/iframe, not nested inside the rail');
  assert.equal(popover.props.style.position, 'absolute');
  assert.equal(popover.props.style.top, 'auto');
  assert.equal(popover.props.style.bottom, 56);
  assert.equal(popover.props.style.left, 8);
  assert.equal(popover.props.style.right, 8);
  assert.equal(popover.props.style.maxHeight, 'calc(100% - 108px)');
  assert.equal(popover.props.style.overflow, 'auto');
  assert.equal(popover.props.style.overflowX, 'hidden');

  // The popover is present but hidden until railOpen; opening it must reveal
  // the same sibling overlay (user-visible state, not just a class change).
  assert.equal(popover.props.style.display, 'none');
  h.setUiForRender({ railOpen: true });
  const open = findByClass(h.render(), 'mp-rail-popover');
  assert.equal(open.props.style.display, 'block');
  h.cleanup();
});
