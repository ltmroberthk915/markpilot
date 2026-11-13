import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const findByClass = (tree, name) => nodes(tree).find((n) => n.props?.className === name);

test('rail is a fixed 28px sibling and the iframe fills the rest in every phase', async () => {
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
    assert.equal(rail.props.style.flex, '0 0 28px');
    assert.equal(rail.props.style.height, 28);
    assert.equal(rail.props.style.boxSizing, 'border-box');
    const iframe = nodes(tree).find((n) => n.type === 'iframe');
    assert(iframe, `iframe present in ${state.phase}`);
    assert.equal(iframe.props.style.flex, '1 1 auto');
    assert.equal(iframe.props.style.minHeight, 0);
  }
  h.cleanup();
});

test('rail preserves conflict actions and renders the recovered popover as a sibling', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    phase: 'conflict',
    detail: 'STALE',
    recovered: [{ recoveryPath: 'D:/fixture/recovered.md', at: 1 }],
  });
  const tree = h.render();
  const labels = nodes(tree).filter((n) => n.type === 'button').map((n) => (n.children || []).join(''));
  assert.ok(labels.includes('重载磁盘版本'));
  assert.ok(labels.includes('复制我的内容'));
  assert.ok(labels.includes('复制路径'));
  assert.ok((tree.children || []).filter(Boolean).some((n) => n.props?.className === 'mp-rail-popover'));
  const popover = findByClass(tree, 'mp-rail-popover');
  assert.equal(popover.props.style.position, 'absolute');
  assert.equal(popover.props.style.top, 34);
  assert.equal(popover.props.style.overflow, 'auto');
  h.cleanup();
});
