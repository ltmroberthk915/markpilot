const delay = (ms = 260) => new Promise(resolve => setTimeout(resolve, ms));
const PREVIEW = '.vditor-ir__preview,.vditor-wysiwyg__preview';
export async function runFeatures() {
  const results = [];
  const api = window.vditor, e = api.vditor;
  const {configureShortcuts, showShortcutSettings, DEFAULT_SHORTCUTS} = await import('/render/js/edit-shortcuts.js');
  configureShortcuts(DEFAULT_SHORTCUTS);
  const check = (value, label) => { if (!value) throw new Error(label + '\n' + api.getValue()); results.push('PASS ' + label); };
  const root = () => e[e.currentMode].element;
  const textNodes = () => {
    const nodes = [], walker = document.createTreeWalker(root(), 4);
    let node;
    while ((node = walker.nextNode())) if (!node.parentElement.closest(PREVIEW)) nodes.push(node);
    return nodes;
  };
  const select = (start, a, end = start, b = a) => {
    root().focus(); const range = document.createRange(); range.setStart(start,a);range.setEnd(end,b);
    getSelection().removeAllRanges();getSelection().addRange(range);
  };
  const key = (letter, options = {}, target = root()) => {
    const event = new KeyboardEvent('keydown', {key:letter,code:'Key'+letter.toUpperCase(),ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true,...options});
    target.dispatchEvent(event);return event;
  };
  const load = async (md = 'alpha beta\n\nsecond line\n') => { api.setValue(md,true);await delay();api.clearStack(); };
  const history = async (before, after, label) => {
    e.undo.undo(e); await delay(); check(api.getValue()===before,label+' undo');
    e.undo.redo(e); await delay(); check(api.getValue()===after,label+' redo');
  };
  for (const mode of ['ir','wysiwyg','sv']) {
    e.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${mode}"]`).click();
    await load();
    let before = api.getValue(), t=textNodes().find(n=>n.textContent.includes('alpha'));
    select(t,5);check(key('e').defaultPrevented, mode+' math key remains in editor');
    const caret = getSelection();
    const prefix=document.createRange(),suffix=document.createRange();prefix.selectNodeContents(root());suffix.selectNodeContents(root());
    prefix.setEnd(caret.focusNode,caret.focusOffset);suffix.setStart(caret.focusNode,caret.focusOffset);
    const mathSource=caret.focusNode?.parentElement?.closest('code[data-type="math-inline"]');
    check(caret.isCollapsed && (mathSource || prefix.toString().endsWith('$') && suffix.toString().startsWith('$')),mode+' empty formula caret inside its source '+JSON.stringify({node:caret.focusNode.textContent,offset:caret.focusOffset}));
    document.execCommand('insertText',false,'x+1'); await delay();
    check(api.getValue().includes('alpha$x+1$ beta'),mode+' typing enters empty formula');

    await load(); before=api.getValue();t=textNodes().find(n=>n.textContent.includes('alpha'));
    select(t,0,t,5);key('e');await delay();
    let after=api.getValue();check(after.includes('$alpha$ beta'),mode+' selected text wrapped in math');
    await history(before,after,mode+' math');

    await load();before=api.getValue();t=textNodes().find(n=>n.textContent.includes('alpha'));
    select(t,0,t,5);key('k');await delay();after=api.getValue();
    check(after.includes('`alpha` beta'),mode+' single line inline code');
    await history(before,after,mode+' inline code');

    for(const [letter,label] of [['q','quote'],['k','code block']]) {
      await load();before=api.getValue();
      const first=textNodes().find(n=>n.textContent.includes('alpha')),last=textNodes().find(n=>n.textContent.includes('second line'));
      select(first,0,last,last.length);key(letter);await delay();after=api.getValue();
      check(letter==='q' ? /^> alpha beta/m.test(after)&&/^> second line/m.test(after)
        : after.includes('```')&&after.includes('alpha beta')&&after.includes('second line'), mode+' multi paragraph '+label);
      await history(before,after,mode+' '+label);
    }
    await load();before=api.getValue();t=textNodes().find(n=>n.textContent.includes('alpha'));select(t,0,t,5);
    key('e',{isComposing:true});check(api.getValue()===before,mode+' IME composition does not trigger command');
    const input=document.createElement('input');document.body.append(input);input.focus();
    check(!key('k',{},input).defaultPrevented,mode+' settings and outside inputs keep their shortcuts');input.remove();
  }
  e.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();
  await load('left alpha\n\nbeta right\n\nsafe $x+1$\n');
  let edgeBefore=api.getValue();
  let first=textNodes().find(n=>n.textContent.includes('left alpha')),last=textNodes().find(n=>n.textContent.includes('beta right'));
  select(first,5,last,4);key('q');await delay();
  check(api.getValue().includes('left')&&api.getValue().includes('right')&&api.getValue().includes('$x+1$')&&/^> alpha/m.test(api.getValue())&&/^> beta/m.test(api.getValue()),'partial multi paragraph quote preserves outside text and formulas');
  await history(edgeBefore,api.getValue(),'partial quote');
  await load('alpha beta\n');first=textNodes().find(n=>n.textContent.includes('alpha'));
  select(first,0,first,5);key('e');document.execCommand('insertText',false,'Z');await delay();
  check(api.getValue().includes('$alphaZ$'),'selected formula leaves caret inside closing dollar');
  await load();let t=textNodes().find(n=>n.textContent.includes('alpha'));select(t,0,t,5);
  const beforeSettings=api.getValue();showShortcutSettings();
  const mathInput=document.querySelector('#typora-shortcuts input[data-action="math"]');
  key('q',{},mathInput);
  check(document.querySelector('#typora-shortcuts [data-action="save"]').disabled,'duplicate shortcut rejected');
  key('m',{shiftKey:false,altKey:true},mathInput);
  document.querySelector('#typora-shortcuts [data-action="save"]').click();await delay(40);
  check(!document.querySelector('#typora-shortcuts'),'settings save closes dialog');
  check(api.getValue()===beforeSettings,'changing shortcuts preserves document');
  select(t,0,t,5);key('e');check(!api.getValue().includes('$alpha$'),'old shortcut no longer inserts math');
  await load();t=textNodes().find(n=>n.textContent.includes('alpha'));select(t,0,t,5);
  key('m',{shiftKey:false,altKey:true});await delay();
  check(api.getValue().includes('$alpha$'),'custom math shortcut applies immediately');
  check(JSON.parse(localStorage.getItem('typora-editor-shortcuts')).math==='Ctrl+Alt+M','shortcut value persisted');
  showShortcutSettings();document.querySelector('#typora-shortcuts [data-action="reset"]').click();
  document.querySelector('#typora-shortcuts [data-action="save"]').click();await delay(40);
  check(JSON.parse(localStorage.getItem('typora-editor-shortcuts')).math===DEFAULT_SHORTCUTS.math,'restore defaults persisted');
  configureShortcuts(DEFAULT_SHORTCUTS);
  await load('```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```\n');
  const mermaidEnd=Date.now()+30000;
  while(!root().querySelector('.language-mermaid svg') && Date.now()<mermaidEnd) await delay(50);
  check(!!root().querySelector('.language-mermaid svg'),'bundled Mermaid renders flowchart through Vditor');
  check(!!(await mermaid.parse('sequenceDiagram\nAlice->>Bob: Hello')),'bundled Mermaid supports sequence diagrams');
  check(!!(await mermaid.parse('venn-beta\nset A\nset B\nunion A,B',{suppressErrors:true})),'Mermaid 11.17.2 supports Venn syntax');
  check(!!(await mermaid.parse('treeView-beta\n  src/\n    index.js',{suppressErrors:true})),'Mermaid 11.17.2 supports TreeView syntax');
  return results;
}
