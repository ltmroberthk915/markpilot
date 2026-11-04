'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const project = path.resolve(__dirname, '../../../dsh-markpilot');
const load = file => import(pathToFileURL(path.join(project, file)).href);

test('italic uses an emphasis delimiter, not one character of the surrounding strong pair', async () => {
  const { EditorState } = await load('node_modules/@codemirror/state/dist/index.js');
  const { wrap } = await load('src-cm6/toolbar.js');
  const prior = global.window;
  try {
    global.window = {};
    for (const [doc, anchor, head, expected] of [
      ['**term**', 2, 6, '***term***'], ['**term**', 6, 2, '***term***'],
      ['**term**', 8, 0, '***term***'], ['***term***', 3, 7, '**term**'],
      ['*term*', 1, 5, 'term'], ['*term*', 6, 0, 'term'],
    ]) {
      const view = { state: EditorState.create({doc, selection: {anchor, head}}), focus() {} };
      view.dispatch = spec => { view.state = view.state.update(spec).state; };
      wrap(view, '*');
      assert.equal(view.state.doc.toString(), expected);
    }
  } finally {
    if (prior === undefined) delete global.window; else global.window = prior;
  }
});

test('clipboard formula prefers annotated TeX and never invents it for ordinary HTML', async () => {
  const { clipboardFormula } = await load('src-cm6/rich-clipboard.js');
  const math = {localName:'math', getAttribute:()=>'inline', querySelector:()=>({textContent:' x^2 '})};
  assert.equal(clipboardFormula(math), '$x^2$');
  const display = {localName:'span', classList:{contains:c=>c==='katex-display'}, querySelector:()=>math};
  assert.equal(clipboardFormula(display).trim(), '$$\nx^2\n$$');
  const tex = String.raw`\text{$x$}`;
  const internal = {...math, querySelector:()=>({textContent:tex})};
  assert.equal(clipboardFormula(internal).trim(),'$$\n'+tex+'\n$$');
  const embedded = {...math, querySelector:()=>({textContent:'a\n$$\nb'})};
  assert.equal(clipboardFormula(embedded).trim(),'```tex\na\n$$\nb\n```');
  assert.equal(clipboardFormula({...math, querySelector:()=>null}), null);
  assert.equal(clipboardFormula({localName:'span'}), null);
});

test('scientific and editorial marks survive source and rich projection without forwarding HTML attributes', async () => {
  const {clipboardStyle,markedClipboardRun} = await load('src-cm6/rich-clipboard.js');
  const clipboardMarks = (el,text) => markedClipboardRun(clipboardStyle(el),text);
  const {renderInline} = await load('src-cm6/inline-format.js');
  assert.equal(clipboardMarks({tagName:'SPAN',style:{fontWeight:'700',fontStyle:'italic'}},' a '), ' ***a*** ');
  assert.equal(clipboardMarks({tagName:'U'},'term'), '<u>term</u>');
  assert.equal(clipboardMarks({tagName:'SPAN',style:{verticalAlign:'super'}},'2'), '<sup>2</sup>');
  assert.equal(renderInline('H<sub>2</sub>O and m<sup>2</sup>'), 'H<sub>2</sub>O and m<sup>2</sup>');
  assert.equal(renderInline('<sup>x'), '&lt;sup&gt;x');
  assert(!renderInline('<sup onclick="y()">x</sup>').includes('<sup onclick'));
});
