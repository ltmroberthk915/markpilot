import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fixture from './fixtures/layout-bootstrap.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = process.env.MP_TEST_CLIENT
  ? path.resolve(process.env.MP_TEST_CLIENT)
  : path.join(HERE, '..', 'lib', 'client.js');

function make() {
  return fixture.createFixture(CLIENT, {
    activation: 'native', viewportWidth: 1463, initialSb: 280, initialRb: 300,
  });
}

test('late header height schedules a fresh anchor without root/body resize', () => {
  const f = make();
  try {
    const initialTop = f.stage.style.getPropertyValue('top');
    const normal = { ...f.header.getBoundingClientRect() };
    // Header existed with zero height, then the tab strip mounts and grows.
    f.header.getBoundingClientRect = () => ({ ...normal, height: 0, bottom: 36 });
    f.header.rawRect = f.header.getBoundingClientRect;
    f.engine.flush(); f.flush();
    assert.equal(f.stage.style.getPropertyValue('top'), '36px');
    f.header.getBoundingClientRect = () => ({ ...normal });
    f.header.rawRect = f.header.getBoundingClientRect;
    const headerRo = f.ros.find((ro) => ro.targets.includes(f.header));
    assert.ok(headerRo, 'header geometry must be observed; baseline rc.11 has no header observer');
    headerRo.cb([{ target: f.header, contentRect: normal }]);
    f.flush();
    assert.equal(f.stage.style.getPropertyValue('top'), initialTop);
    // Width-only RO echo must not schedule a fresh apply.
    const applied = f.engine.snapshot().applies;
    headerRo.cb([{ target: f.header, contentRect: { ...normal, width: normal.width + 20 } }]);
    f.flush();
    assert.equal(f.engine.snapshot().applies, applied, 'width-only header resize must not invalidate');
  } finally { f.dispose(); }
});

test('body-first direct children still place the handle under the real header', () => {
  const f = make();
  try {
    f.root.children = [f.body, f.header];
    f.engine.flush(); f.flush();
    const headerBottom = f.header.rawRect().bottom;
    assert.equal(f.stage.style.getPropertyValue('top'), Math.round(headerBottom) + 'px');
    const commit = f.engine.measureCommit();
    assert.ok(commit, 'commit geometry must be available');
    assert.equal(commit.topEdge, Math.round(headerBottom), 'commit geometry must use the same body-first header anchor');
  } finally { f.dispose(); }
});

test('direct header replacement is seen without replacing root/body', () => {
  const f = make();
  try {
    const oldTop = f.stage.style.getPropertyValue('top');
    const normal = f.header.getBoundingClientRect();
    const next = {
      tagName: 'DIV', className: '_tabs-v2', isConnected: true, parentElement: f.root,
      children: [], style: f.header.style, dataset: {},
      getBoundingClientRect() { return { ...normal, height: 64, bottom: 100 }; },
      rawRect() { return { ...normal, height: 64, bottom: 100 }; },
      querySelectorAll() { return []; },
      getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
      contains() { return false; },
    };
    f.root.children[0] = next;
    const structureMo = f.mos.find((mo) => mo.targets.some((x) => x.node === f.root && x.opts.childList === true));
    assert.ok(structureMo, 'root direct-child structure must be observed');
    structureMo.cb([{ type: 'childList', target: f.root, addedNodes: [next], removedNodes: [] }]);
    f.flush();
    assert.notEqual(f.stage.style.getPropertyValue('top'), oldTop);
    assert.equal(f.stage.style.getPropertyValue('top'), '100px');
  } finally { f.dispose(); }
});

test('streaming body descendants do not add an apply path and both handles release cleanly', () => {
  const f = make();
  try {
    const headerWs = f.mos.filter((mo) => mo.targets.some((x) =>
      (x.node === f.root || x.node === f.header || x.node === f.header.parentElement) && (x.opts.subtree || x.opts.attributes)));
    assert.equal(headerWs.length, 0, 'header watcher must not observe descendant subtree/style/class');
    const before = f.engine.snapshot().applies;
    // Model a streamed body child mutation; there must be no header-specific apply.
    const bodyMo = f.mos.find((mo) => mo.targets.some((x) => x.node === f.document.body && x.opts.subtree));
    if (bodyMo) bodyMo.cb([{ type: 'childList', target: f.body, addedNodes: [], removedNodes: [] }]);
    f.flush();
    assert.ok(f.engine.snapshot().applies - before <= 1, 'only the existing document observer may coalesce one apply');
    assert.doesNotThrow(() => {
      const x = f.start('sidebar');
      for (let i = 1; i <= 10; i += 1) f.P.onHandleMove(f.event(x + i));
      f.P.onHandleUp(f.event(x + 10, undefined, 'pointerup'));
      const y = f.start('rightbar');
      for (let i = 1; i <= 10; i += 1) f.P.onHandleMove(f.event(y - i, undefined, 'pointermove'));
      f.P.onHandleUp(f.event(y - 10, undefined, 'pointerup'));
      f.flush();
    }, 'both handle releases must not throw');
  } finally { f.dispose(); }
});
