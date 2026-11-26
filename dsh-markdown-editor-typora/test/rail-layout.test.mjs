import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make, drain } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const findByClass = (tree, name) => nodes(tree).find((n) => n.props?.className === name);

test('the document rail floats above its sibling iframe without reserving editor height in every phase', async t => {
  const h = make();
  t.after(() => h.cleanup());
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
    assert.equal(tree.props.style.position, 'relative');
    assert.equal(rail.props['data-mp-rail-anchor'], 'bottom');
    const css = tree.children.find(n => n?.type === 'style').children.join('');
    const rule = css.match(/\.mp-rail\s*\{([^}]+)\}/)[1];
    assert.match(rule, /position:\s*absolute/);
    assert.match(rule, /bottom:\s*\d/);
    const iframe = tree.children.find((n) => n?.type === 'iframe');
    assert(iframe, `iframe present in ${state.phase}`);
    assert.equal(iframe.props.style.flex, '1 1 auto');
    assert.equal(iframe.props.style.minHeight, 0);
  }
});

test('the recovery popover opens above the rail and the conflict actions remain available', async t => {
  const h = make();
  t.after(() => h.cleanup());
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
  assert.ok(tree.children.some((n) => n?.props?.className === 'mp-rail-popover'));
  const popover = findByClass(tree, 'mp-rail-popover');
  assert.equal(popover.props.style.position, 'absolute');
  assert.equal(popover.props.style.display, 'none');
  assert.equal(popover.props.style.top, 'auto');
  assert.ok(popover.props.style.bottom > 0);
  assert.equal(popover.props.style.overflow, 'auto');
  const toggle = nodes(tree).find(n => n.type === 'button' && n.props.title === '查看共享会话恢复的草稿副本');
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick();
  await drain();
  const expanded = h.render();
  assert.equal(findByClass(expanded, 'mp-rail-popover').props.style.display, 'block');
  const copy = nodes(findByClass(expanded, 'mp-rail-popover')).find(n => n.type === 'button' && n.props?.title === '复制路径');
  assert.ok(copy);
});
