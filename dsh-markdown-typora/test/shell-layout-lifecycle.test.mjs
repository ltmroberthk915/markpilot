import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-shell.cjs';

const flatten = tree => {
  const out = [];
  (function walk(x) { if (!x || typeof x !== 'object') return; out.push(x); for (const c of x.children || []) walk(c); })(tree);
  return out;
};

test('floating workbench actions reserve no full-height rail and retain independent hit targets', () => {
  const f = fixture.make();
  f.store.set('dsh.markpilot.settings.v1', '{"docsListCollapsed":true}');
  let nodes = flatten(f.a.DocsWorkbench({ close() {} }));
  const header = nodes.find(n => n.props['data-mp-workbench-controls'] === 'floating');
  const actions = nodes.filter(n => n.props['data-mp-rail-action']);
  assert(nodes.some(n => n.props.ref && n.props.style?.width === 0));
  assert.equal(header.props.style.position, 'absolute');
  assert.equal(header.props.style.left, 12);
  assert.equal(header.props.style.flexDirection, 'column');
  assert.equal(header.props.style.width, 32);
  assert.equal(header.props.style.gap, 12);
  assert.equal(header.props.style.pointerEvents, 'none');
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.equal(action.props.style.width, 32); assert.equal(action.props.style.height, 32);
    assert.equal(action.props.style.pointerEvents, 'auto'); assert.equal(action.props.type, 'button');
  }
  assert(nodes.some(n => typeof n.type === 'function' && n.props.workbenchCollapsed === true));
  actions[0].props.onClick();
  nodes = flatten(f.a.DocsWorkbench({ close() {} }));
  assert(nodes.some(n => n.props['data-mp-workbench-controls'] === 'inline'));
  assert(nodes.some(n => typeof n.type === 'function' && n.props.workbenchCollapsed === false));
});

function pinnedShell() {
  const f = fixture.make(), a = f.a, frame = f.node(), col = f.node(), panel = f.node(), handle = f.node();
  frame.parentNode = f.parent;
  frame.style.gridTemplateColumns = '280px minmax(400px,1fr) minmax(0px,576px)';
  panel.setAttribute('data-sidebar-right-panel', 'push');
  panel.style.setProperty('width', '576px'); panel.style.setProperty('--dsh-sidebar-width', '576px');
  panel.style.setProperty('transform', 'translateX(2px)'); panel.closest = () => null;
  col.querySelector = () => panel; col.contains = n => n === panel;
  col.querySelectorAll = selector => selector === '[data-sidebar-right-panel]' ? [panel] : [];
  frame.querySelector = selector => selector.includes('rightbarCol') ? col : null;
  a.installHandleLifecycle(f.ctx); a.privateSetDocs(true);
  a.handleState.frame = frame; a.handleState.sb = 180; a.handleState.rb = 200;
  a.handleState.sbUser = a.handleState.rbUser = true;
  a.pinGrid(frame, 180, 200, 400); a.fitRightbarContent();
  handle.style.setProperty('left', '704px', 'important'); a.setNativeHandleLeft(handle, '1080px');
  return { f, a, frame, col, panel, handle };
}

test('default close releases grid/pane/native-handle overrides without overwriting native styles', () => {
  const { f, a, frame, col, panel, handle } = pinnedShell();
  assert.equal(col.style.getPropertyValue('--mp-rightbar-fit-width'), '300px');
  assert.equal(Number(col.style.getPropertyValue('--mp-rightbar-fit-zoom')), 2 / 3);
  a.closeDocsWorkbench();
  assert.equal(frame.hasAttribute('data-mp-grid'), false);
  assert.equal(col.hasAttribute('data-mp-rightbar-fit'), false);
  assert.equal(col.style.getPropertyValue('--mp-rightbar-fit-width'), '');
  assert.equal(col.style.getPropertyValue('--mp-rightbar-fit-zoom'), '');
  assert.equal(frame.style.gridTemplateColumns, '280px minmax(400px,1fr) minmax(0px,576px)');
  assert.equal(handle.style.getPropertyValue('left'), '704px');
  assert.equal(handle.style.getPropertyPriority('left'), 'important');
  assert.equal(panel.style.getPropertyValue('width'), '576px');
  assert.equal(panel.style.getPropertyValue('--dsh-sidebar-width'), '576px');
  assert.equal(panel.style.getPropertyValue('transform'), 'translateX(2px)');
  assert.equal(f.listeners().doc, 0);
  assert.equal(f.ids.has('dsh-markdown-typora-grid-style'), false);
});

test('keep opt-in survives close, then opt-out releases ownership immediately', () => {
  const { f, a, frame, col, panel } = pinnedShell();
  a.layout.writeSettings(f.storage, { keepResizeHandlesAfterClose: true });
  f.emit('dsh-markdown-typora:settings-changed'); a.closeDocsWorkbench();
  assert(frame.hasAttribute('data-mp-grid')); assert(col.hasAttribute('data-mp-rightbar-fit'));
  assert.equal(f.listeners().doc, 4);
  a.layout.writeSettings(f.storage, { keepResizeHandlesAfterClose: false });
  f.emit('dsh-markdown-typora:settings-changed');
  assert.equal(frame.hasAttribute('data-mp-grid'), false);
  assert.equal(col.hasAttribute('data-mp-rightbar-fit'), false);
  assert.equal(f.listeners().doc, 0);
});

test('native closing keeps its transform distance, while fullscreen releases the sizing override', () => {
  const { a, col, panel } = pinnedShell();
  a.handleState.rb = 0; a.fitRightbarContent();
  assert.equal(col.style.getPropertyValue('--mp-rightbar-fit-width'), '300px');
  panel.setAttribute('data-sidebar-right-panel', 'fullscreen'); a.fitRightbarContent();
  assert.equal(col.hasAttribute('data-mp-rightbar-fit'), true, 'column lease is inert in fullscreen and ready for a returning push panel');
  assert.equal(panel.getAttribute('data-sidebar-right-panel'), 'fullscreen');
  assert.equal(panel.style.getPropertyValue('width'), '576px');
});
