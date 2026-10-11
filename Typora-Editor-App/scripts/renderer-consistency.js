// Run against actual Lute as the oracle, including before MutationObserver's
// delivery turn. No production code is mocked.
export const runConsistency = async () => {
  const api = window.vditor;
  const editor = api.vditor;
  const root = editor.ir.element;
  const results = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = label => {
    const actual = api.getValue();
    const expected = editor.lute.VditorIRDOM2Md(root.innerHTML);
    if (actual !== expected) {
      let i = 0; while (actual[i] === expected[i] && i < actual.length) i++;
      throw new Error(label + ' @' + i + ': ' + JSON.stringify({actual:actual.slice(i-30,i+80),expected:expected.slice(i-30,i+80)}));
    }
    results.push('PASS ' + label);
  };
  const fixtures = [
    '', '\n', 'a\n\nb\n', '# heading\n\ntext\n', '## $x+1$ **title**\n\nbody\n',
    'a  \nb\n\n**bold** _italic_ ~~strike~~ `code`\n',
    'a\n\n| col | num |\n| --- | ---: |\n| A | 1 |\n\nb\n',
    '---\ntitle: example\n---\n\nbody\n',
    'text[^x]\n\n[^x]: note\n', '[link][id]\n\n[id]: https://example.org "Title"\n',
    '[toc]\n\n# One\n\n## Two $x$\n',
    'before\n\n<div>custom <b>HTML</b></div>\n\nafter\n',
    'before\n\n<img src="missing.png" style="zoom:33%" />\n\nafter\n',
    '- a\n- b\n\n1. one\n2. two\n\n- [ ] todo\n- [x] done\n',
    '3. three\n4. four\n\n    nested\n\nend\n',
    '> quote\n>\n> - item $a$\n> - next\n\nend\n',
    'a\n\n---\n\nb\n',
    '```js\nconst n = 1;\n```\n\nend\n',
    '$x$ and $\\frac{a}{b}$\n\n$$\nx^2+1\n$$\n',
    '$\\Omega\\Omeg$\n\n$$\n\\begin{matrix} a&b\\\\c&d\\end{matrix}\n$$\n',
  ];
  for (const [i, fixture] of fixtures.entries()) {
    api.setValue(fixture, true);
    equal('fixture '+i+' pending previews');
    await delay(280);
    equal('fixture '+i+' rendered previews');
    const p = root.querySelector('p');
    if (p?.firstChild?.nodeType === Node.TEXT_NODE && p.firstChild.length) {
      root.focus(); getSelection().collapse(p.firstChild,1);
      document.execCommand('insertText', false, '增量🙂');
      equal('fixture '+i+' browser insertion');
      editor.undo.undo(editor);
      equal('fixture '+i+' immediate undo');
      editor.undo.redo(editor);
      equal('fixture '+i+' immediate redo');
    }
  }
  // Direct synchronous mutations are used by native toolbar commands too.
  api.setValue('one\n\ntwo\n\nthree\n', true);
  for (const html of ['<p data-block="0"><br></p>', '<p data-block="0"></p>', '<hr data-block="0">']) {
    root.insertAdjacentHTML('afterbegin',html); equal('insert block '+html);
    root.append(root.firstChild); equal('move block '+html);
    root.lastChild.remove(); equal('remove block '+html);
  }
  const p = root.firstElementChild;
  p.firstChild.textContent += ' direct'; equal('direct text mutation before observer callback');
  p.replaceWith(root.ownerDocument.createTextNode('loose text')); equal('non-block root text fallback');
  api.setValue('- [ ] task\n\n|a|\n|-|\n|b|\n',true);
  const checkbox = root.querySelector('input'); checkbox.setAttribute('checked','checked'); equal('checkbox attribute');
  root.querySelector('td').setAttribute('align','right'); equal('table alignment attribute');

  // Random combinations exercise separators, lists, tables and structural edits.
  let seed=729;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
  const pieces=['plain\n','## header\n','$x+y$\n','- a\n- b\n','> quote\n','---\n','| A |\n| --- |\n| B |\n','```txt\ncode\n```\n'];
  for(let i=0;i<24;i++) {
    api.setValue(Array.from({length:6},()=>pieces[Math.floor(random()*pieces.length)]).join('\n'),true);
    equal('mixed document '+i);
    const blocks=[...root.children];
    const target=blocks.find(n=>n.tagName==='P'&&n.firstChild?.nodeType===Node.TEXT_NODE);
    if(target) {target.firstChild.textContent+=' changed';equal('mixed edit '+i)}
    if(blocks.length>1) {root.insertBefore(blocks.at(-1),blocks[0]);equal('mixed reorder '+i)}
  }
  api.setValue('# Heading\n\nbody $x+1$\n',true);
  await delay(500);
  editor.outline.render(editor);
  const outline=editor.outline.element.lastElementChild;
  const oldFirst=outline.firstChild;
  root.querySelector('p').firstChild.textContent+='body edit';
  editor.outline.render(editor);
  assert(oldFirst===outline.firstChild,'body edit rebuilt outline');
  root.querySelector('h1').lastChild.textContent='Updated title';
  editor.outline.render(editor);
  assert(outline.textContent.includes('Updated title'),'heading edit left stale outline');
  results.push('PASS outline cached for body, rebuilt for heading');
  assert(root.querySelector('.katex'),'visible formula did not render');
  assert(!root.querySelector('.vditor-ir__preview').isContentEditable,'preview is editable');
  results.push('PASS rendered formula remains protected');
  document.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  api.setValue(Array.from({length:180},(_,i)=>'$x_{'+i+'}+1$').join('\n\n'),true);
  const beforePause=window.__typoraMathStats.rendered;
  await delay(100);
  assert(window.__typoraMathStats.rendered===beforePause,'background queue ran during composition');
  document.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
  api.setValue('$\\Omega+latest$\n',true);
  await delay(500);
  equal('replacement while old formulas queued');
  assert(root.querySelector('.language-math').getAttribute('data-math')==='\\Omega+latest','stale prepared formula committed');
  assert(window.__typoraMathStats.pending===0,'detached jobs retained after document replacement');
  results.push('PASS composition pauses queue; stale prepared fragments are discarded');
  api.setValue('$$\n\\gdef\\testmacro{z}\n$$\n\n$\\testmacro + \\ce{H2O}$\n',true);
  await delay(500);
  const formula=root.querySelector('code[data-type="math-inline"]').parentElement.querySelector('.language-math');
  assert(formula.querySelector('.katex') && formula.textContent.includes('z') && !formula.textContent.includes('Undefined'),'macro order or chemistry renderer changed');
  equal('global macro and chemistry serialization');
  results.push('PASS global macro order and mhchem survive scheduling');
  return results;
};
