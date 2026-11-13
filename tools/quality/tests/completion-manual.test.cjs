'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{parse}=require('acorn');
const project=path.resolve(__dirname,'../../../dsh-markpilot');
const load=relative=>import(pathToFileURL(path.join(project,relative)).href);

// Exercise the menu's actual lexical handlers with a deferred repaint. The
// view stub supplies only CM transactions and focus, without starting a DOM.
async function menuAt(doc, head) {
  const [{EditorState,Transaction},{codeBlockAt},{sourceKind},{localCandidates}]=await Promise.all([
    load('node_modules/@codemirror/state/dist/index.js'),load('src-cm6/markdown-context.js'),
    load('renderer/js/completion-policy.mjs'),load('renderer/js/completion-sources.js')
  ]);
  const src=fs.readFileSync(path.join(project,'src-cm6/completion.js'),'utf8');
  const ast=parse(src,{ecmaVersion:'latest',sourceType:'module'});
  const lexical=ast.body.filter(n=>n.type==='FunctionDeclaration'||n.type==='VariableDeclaration').map(n=>src.slice(n.start,n.end)).join('\n');
  const view={state:EditorState.create({doc,selection:{anchor:head}}),hasFocus:true,composing:false,focus(){}};
  view.dispatch=spec=>{view.state=spec instanceof Transaction?spec.state:view.state.update(spec).state;};
  const menu=new Function('codeBlockAt','sourceKind','localCandidates','owner',lexical+`
    view=owner;
    const hit=candidatesFor(view.state,true);
    rows=hit.rows;tokenFrom=hit.from;tokenTo=hit.head;
    return label=>accept(rows.findIndex(row=>row.label===label));
  `)(codeBlockAt,sourceKind,localCandidates,view);
  return {view,menu};
}

test('accepting a displayed math completion before repaint uses the latest token extent', async()=>{
  const {view,menu}=await menuAt('$\\fr$',4);
  view.dispatch({...view.state.replaceSelection('a'),userEvent:'input.type'});
  menu('\\frac');
  assert.equal(view.state.doc.toString(),'$\\frac{}{}$');
});
test('accepting inside an existing command consumes its suffix and retains its arguments', async()=>{
  const {view,menu}=await menuAt('$\\frac{x}{y}$',4);
  const original=view.state.doc;
  menu('\\frac');
  assert.equal(view.state.doc,original);
  assert.equal(view.state.doc.toString(),'$\\frac{x}{y}$');
  assert.equal(view.state.selection.main.head,6);
});
test('an intervening edit that retires the token makes its completion ineligible', async()=>{
  const {view,menu}=await menuAt('$\\fr$',4);
  view.dispatch({changes:{from:0,to:5,insert:'fresh'},selection:{anchor:5},userEvent:'input.type'});
  assert.equal(menu('\\frac'),false);
  assert.equal(view.state.doc.toString(),'fresh');
});
test('non-token tails exit before the 12000-char window and sourceKind', async()=>{
  const [{EditorState},{codeBlockAt},{sourceKind},{localCandidates}]=await Promise.all([
    load('node_modules/@codemirror/state/dist/index.js'),load('src-cm6/markdown-context.js'),
    load('renderer/js/completion-policy.mjs'),load('renderer/js/completion-sources.js')
  ]);
  const file=process.env.MP_COMPLETION_SOURCE||path.join(project,'src-cm6/completion.js');
  const src=fs.readFileSync(file,'utf8');
  const ast=parse(src,{ecmaVersion:'latest',sourceType:'module'});
  const lexical=ast.body.filter(n=>n.type==='FunctionDeclaration'||n.type==='VariableDeclaration').map(n=>src.slice(n.start,n.end)).join('\n');
  let calls=0;
  const counted=text=>{calls+=1;return sourceKind(text);};
  const run=new Function('codeBlockAt','sourceKind','localCandidates','owner',lexical+`
    view=owner;
    return (state,manual)=>candidatesFor(state,manual);
  `)(codeBlockAt,counted,localCandidates,null);
  for(const doc of ['中'.repeat(12000),'中'.repeat(12000)+' ','中'.repeat(12000)+'。']){
    calls=0;
    const state=EditorState.create({doc,selection:{anchor:doc.length}});
    assert.equal(state.selection.main.head,doc.length,'the caret must sit after the Chinese tail');
    assert.equal(run(state,true),null);
    assert.equal(calls,0,'non-token tails must not call sourceKind');
  }
  calls=0;
  const math=EditorState.create({doc:'$\\fr$',selection:{anchor:4}});
  const mathHit=run(math,false);
  assert.ok(mathHit);
  assert.equal(calls,1);
  const prose=EditorState.create({doc:'abc /fr',selection:{anchor:7}});
  const proseHit=run(prose,false);
  assert.ok(proseHit);
  assert.equal(proseHit.from,4);
  assert.equal(proseHit.rows.some(row=>row.label==='/frontmatter'),true);
  assert.ok(run(math,true),'manual Ctrl+Space keeps working on a legal backslash prefix');
});
