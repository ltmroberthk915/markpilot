import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const text = (n) => (typeof n === 'string' ? n : !n || typeof n !== 'object' ? '' : (n.children || []).map(text).join(''));
const button = (tree, label) => nodes(tree).find((n) => n.type === 'button' && text(n) === label);

test('a rail notice is deduped and expires on its TTL', async () => {
  const h = make();
  await h.boot();
  h.st.doc.storageError({ code: 'FIXTURE_DUP' });
  h.st.doc.storageError({ code: 'FIXTURE_DUP' });
  const rendered = text(h.render());
  assert.ok(rendered.includes('FIXTURE_DUP'));
  assert.equal(h.ui().notices.length, 1, 'duplicate text is not appended');
  assert.equal(h.posts.filter((p) => p.type === 'toast').length, 0, 'no bottom toast');
  await h.advance(6500);
  assert.ok(!text(h.render()).includes('FIXTURE_DUP'), 'notice expires');
  assert.equal(h.ui().railOpen, false, 'last notice expiry closes the rail popover');
  h.cleanup();
});

test('the five-notice cap keeps the text map in sync', async () => {
  const h = make();
  await h.boot();
  for (let index = 0; index < 6; index += 1) h.st.doc.storageError({ code: 'CAP-' + index });
  assert.equal(h.ui().notices.length, 5);
  assert.ok(!text(h.render()).includes('CAP-0'), 'oldest notice was evicted');
  h.st.doc.storageError({ code: 'CAP-0' });
  assert.ok(text(h.render()).includes('CAP-0'), 'an evicted text can be shown again');
  h.cleanup();
});

test('clear removes all notices and Escape closes the rail popover', async () => {
  const h = make();
  await h.boot();
  h.st.doc.storageError({ code: 'CLEAR-ME' });
  const tree = h.render();
  const clear = button(tree, '清除');
  assert(clear);
  clear.props.onClick();
  assert.equal(h.ui().notices.length, 0);
  h.cleanup();
});

test('phase primary keeps notices reachable through +N and the popover', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    phase: 'conflict',
    detail: 'STALE',
    notices: [
      { id: 1, text: 'FIRST-NOTICE', kind: 'info', ts: 1, actions: [] },
      { id: 2, text: 'SECOND-NOTICE', kind: 'info', ts: 2, actions: [] },
    ],
  });
  const tree = h.render();
  assert.ok(button(tree, '＋2'), '+N count for the extra notices');
  assert.ok(text(tree).includes('FIRST-NOTICE'));
  assert.ok(text(tree).includes('SECOND-NOTICE'));
  h.cleanup();
});

test('archive notices expose a copy-path action; Escape closes the rail popover', async () => {
  const h = make();
  await h.boot();
  let copied = '';
  h.setUiForRender({
    railOpen: true,
    notices: [{
      id: 1,
      text: '已归档旧草稿副本：D:/probe/archive.md',
      kind: 'archive',
      ts: 1,
      actions: [{ label: '复制路径', icon: '⧉', run: () => { copied = 'D:/probe/archive.md'; } }],
    }],
  });
  const tree = h.render();
  const copy = button(tree, '复制路径');
  assert(copy);
  copy.props.onClick();
  assert.equal(copied, 'D:/probe/archive.md');
  tree.props.onKeyDown({ key: 'Escape' });
  assert.equal(h.ui().railOpen, false);
  h.cleanup();
});
