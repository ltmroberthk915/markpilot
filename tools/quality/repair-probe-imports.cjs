'use strict';
// One-time migration of the injected portability header, using AST source ranges.
const fs = require('node:fs');
const path = require('node:path');
const { importOrderIssues, filesBelow } = require('./preflight.cjs');
const ROOT = path.resolve(__dirname, '../..');
const changes = [], skipped = [];
for (const file of filesBelow(path.join(ROOT, 'tools/probes')).filter(p => /\.cjs$/.test(p))) {
  let text = fs.readFileSync(file, 'utf8');
  const { ast, imports, issues } = importOrderIssues(text);
  for (const name of [...new Set(issues.map(i => i.name))]) {
    const { node } = imports.get(name);
    if (node.declarations.length !== 1) { skipped.push({ file, name, reason: 'combined declaration; manual review required' }); continue; }
    const statement = text.slice(node.start, node.end);
    const directive = ast.body.find(n => n.directive === 'use strict');
    const insertAt = directive?.end || 0;
    text = text.slice(0, insertAt) + '\n' + statement + text.slice(insertAt, node.start) + text.slice(node.end);
    break; // Reparse after each moved statement if another eager import remains.
  }
  const importIssues = importOrderIssues(text).issues;
  if (importIssues.length) skipped.push({ file, reason: 'remaining import issue', issues: importIssues });
  const loader = path.relative(path.dirname(file), path.join(__dirname, 'dependencies.cjs')).replaceAll('\\', '/');
  const next = text.replace(/require\(\s*['"][A-Z]:[/\\][^'"]*node_modules[/\\]playwright-core['"]\s*\)/g,
    () => "require('" + (loader.startsWith('.') ? loader : './' + loader) + "').playwright()");
  if (next !== fs.readFileSync(file, 'utf8')) {
    changes.push(path.relative(ROOT, file).replaceAll('\\', '/'));
    if (process.argv.includes('--write')) fs.writeFileSync(file, next, 'utf8');
  }
}
console.log(JSON.stringify({ write: process.argv.includes('--write'), changes, skipped }, null, 2));
if (skipped.length) process.exitCode = 1;
