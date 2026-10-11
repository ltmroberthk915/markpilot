// Narrow hooks in the pinned, compiled Vditor 3.11.1 bundle.
// All implementation stays in render/js; refuse unknown upstream bytes.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const file = path.join(__dirname, '../extension-src/render/cdn/vditor/dist/index.min.js');
const expected = '2799da0799db95b454bce71f6d7d32148fdea660c64c6de43e5f4c9cd89255a4';
const hooks = [
  ['t.innerHTML=n,(0,M.H)(t,{cdn:e.options.cdn,math:e.options.preview.math})',
   '(window.__typoraUpdateToc?window.__typoraUpdateToc(t,n):t.innerHTML=n),(0,M.H)(t,{cdn:e.options.cdn,math:e.options.preview.math})'],
  ['i=function(e,t){return new Promise((function(n,r){if(document.getElementById(t))',
   'i=function(e,t){if(window.__typoraLoadScript)return window.__typoraLoadScript(e,t);return new Promise((function(n,r){if(document.getElementById(t))'],
  ['s=function(e,t){void 0===e&&(e=document);var n=l.mathRenderAdapter.getElements(e);',
   's=function(e,t){void 0===e&&(e=document);if(window.__typoraScheduleMath&&window.__typoraScheduleMath(e,t))return;var n=l.mathRenderAdapter.getElements(e);'],
  ['"ir"===e.currentMode?e.lute.VditorIRDOM2Md(e.ir.element.innerHTML):""',
   '"ir"===e.currentMode?(e.__typoraPerformance?e.__typoraPerformance.getMarkdown():e.lute.VditorIRDOM2Md(e.ir.element.innerHTML)):""'],
];
let source = fs.readFileSync(file, 'utf8');
let original = source;
for (const [before, after] of hooks) original = original.replace(after, before);
if (createHash('sha256').update(original).digest('hex') !== expected) throw new Error('Unknown Vditor bundle; review hooks before updating');
for (const [before, after] of hooks) {
  if (original.split(before).length !== 2) throw new Error('Hook is not unique: ' + before);
  original = original.replace(before, after);
}
if (source !== original) fs.writeFileSync(file, original);
console.log('Vditor performance hooks verified');
