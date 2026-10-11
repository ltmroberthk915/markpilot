'use strict';
// Sidebar outline for the markpilot custom editor. The IDE's built-in
// Outline view is API-locked to real text editors and stays empty for custom
// editors, so this tree view lives in the same Explorer area and drives the
// webview: clicking an entry scrolls the editor to that heading.
// 'vscode' is required lazily so Node tests can import the pure parser.
const parseOutline = text => {
  const headings = [];
  let fence = null;
  const lines = String(text || '').split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const textLine = lines[line];
    const opened = /^\s{0,3}(`{3,}|~{3,})/.exec(textLine);
    if (opened) {
      if (!fence) fence = opened[1][0];
      else if (new RegExp('^\\s{0,3}\\' + fence + '{3,}').test(textLine)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(textLine);
    if (heading) headings.push({level: heading[1].length, text: heading[2].replace(/[`*_~]+/g, '').trim() || '(无标题)', line});
  }
  // Nest by level: a heading becomes the child of the nearest preceding
  // ancestor with a smaller level, matching the render-side outline panel.
  const roots = [], stack = [];
  headings.forEach((heading, index) => {
    heading.index = index;heading.children = [];
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(heading);
    stack.push(heading);
  });
  return {roots, flat: headings};
};
class OutlineView {
  constructor(context) {
    const vscode = require('vscode');
    this.active = null; // {entry}
    const emitter = new vscode.EventEmitter();
    this.onDidChange = emitter;
    const tree = this;
    const provider = {
      onDidChangeTreeData: emitter.event,
      getTreeItem(node) {
        const item = new vscode.TreeItem(node.text, node.children.length
          ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.description = 'H' + node.level;
        item.tooltip = node.text;
        item.command = {title: '跳转到标题', command: 'markpilot.outline.reveal', arguments: [node]};
        return item;
      },
      getChildren(node) { return tree.active ? (node ? node.children : tree.active.headings) : []; },
    };
    this.view = vscode.window.createTreeView('markpilot.outline', {treeDataProvider: provider, showCollapseAll: true});
    context.subscriptions.push(this.view);
    context.subscriptions.push(vscode.commands.registerCommand('markpilot.outline.reveal', node => {
      if (!this.active || !node) return;
      // Tree rows can carry node objects from an earlier refresh; a refresh
      // that lands between render and click would break identity, so match
      // the heading semantically (document line + text) instead.
      const current = this.active.flat[node.index];
      if (current && current.line === node.line && current.text === node.text)
        this.active.handler.emit('outline-reveal', {index: node.index, line: node.line, text: node.text});
    }));
  }
  // Test hook: flat heading list of the active document.
  headings() { return this.active ? this.active.flat : []; }
  bind(panel, document, handler, getText) {
    const vscode = require('vscode');
    const entry = {panel, document, handler, getText, headings: [], flat: []};
    let timer = 0;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => this.refreshNow(), 250); };
    entry.listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.fsPath !== document.uri.fsPath) return;
      schedule();
    });
    panel.onDidChangeViewState(() => { if (panel.active) this.setActive(entry); });
    panel.onDidDispose(() => {
      entry.listener.dispose();
      clearTimeout(timer);
      if (this.active === entry) { this.active = null; this.onDidChange.fire(); }
    });
    if (panel.active) this.setActive(entry);
    return entry;
  }
  setActive(entry) {
    if (this.active === entry) return;
    this.active = entry;
    this.refreshNow();
  }
  refreshNow() {
    if (this.active) {
      const parsed = parseOutline(this.active.getText());
      this.active.headings = parsed.roots;
      this.active.flat = parsed.flat;
      this.view.message = parsed.flat.length ? undefined : '当前文档没有标题';
    }
    this.onDidChange.fire();
  }
}
module.exports = {OutlineView, parseOutline};
