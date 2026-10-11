'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const ROOT = path.resolve(__dirname, '../..');
function filesBelow(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' ? [] : filesBelow(p)) : [p];
  });
}
function importOrderIssues(text) {
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const imports = new Map();
  for (const node of ast.body) if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) if (d.id.type === 'Identifier' && d.init?.type === 'CallExpression'
      && d.init.callee.name === 'require' && /^(node:)?(path|fs|os|crypto)$/.test(d.init.arguments[0]?.value || '')) {
      imports.set(d.id.name, { start: node.start, node, declaration: d });
    }
  }
  const issues = [];
  function eager(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (/^(Function|ArrowFunction)/.test(node.type || '')) return;
    if (node.type === 'Identifier' && imports.has(node.name)) {
      const reference = !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        && !(parent?.type === 'Property' && parent.key === node && !parent.computed);
      if (reference && node.start < imports.get(node.name).start)
        issues.push({ name: node.name, line: node.loc.start.line, declarationLine: imports.get(node.name).node.loc.start.line });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) value.forEach(child => eager(child, node));
      else if (value && typeof value === 'object') eager(value, node);
    }
  }
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) eager(d.init, d);
    else if (node.type === 'ExpressionStatement') eager(node.expression, node);
  }
  return { ast, imports, issues };
}
function inspect(root = ROOT) {
  const probes = filesBelow(path.join(root, 'tools/probes')).filter(p => /\.cjs$/.test(p));
  const result = { schema: 1, total: probes.length, syntaxFailures: [], eagerImportFailures: [], legacyDependencyPaths: [] };
  for (const file of probes) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replaceAll('\\', '/');
    try {
      const data = importOrderIssues(text);
      if (data.issues.length) result.eagerImportFailures.push({ file: relative, issues: data.issues });
    } catch (e) { result.syntaxFailures.push({ file: relative, message: e.message }); }
    if (/['"][A-Z]:[/\\][^'"]*node_modules[/\\]playwright-core['"]/.test(text))
      result.legacyDependencyPaths.push(relative);
  }
  result.ok = result.total > 0 && !result.syntaxFailures.length && !result.eagerImportFailures.length && !result.legacyDependencyPaths.length;
  return result;
}
if (require.main === module) {
  const result = inspect();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
module.exports = { importOrderIssues, inspect, filesBelow };
