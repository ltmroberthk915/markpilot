'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..');
const projectRequire=require('node:module').createRequire(path.join(root,'tools/quality/tests/table-capacity.test.cjs'));
const load=file=>import(pathToFileURL(path.join(root,'dsh-markpilot',file)).href);
const modules=Promise.all([
  load('node_modules/@codemirror/state/dist/index.js'),
  load('node_modules/@codemirror/commands/dist/index.js'),
  load('src-cm6/tables.js'),
  load('src-cm6/cell-source-map.js'),
]);
const source=fs.readFileSync(path.join(root,'dsh-markpilot/src-cm6/main.js'),'utf8');
const tree=projectRequire('acorn').parse(source,{ecmaVersion:'latest',sourceType:'module'});
const declaration=name=>tree.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
const fragment=node=>source.slice(node.start,node.end);
const keydown=declaration('ensureCellOverlay').body.body.find(node=>
  node.expression?.callee?.property?.name==='addEventListener'&&node.expression.arguments[0]?.value==='keydown'
).expression.arguments[1];
const bind=(body,bindings={})=>new Function(...Object.keys(bindings),body)(...Object.values(bindings));
const parseRow=bind(fragment(declaration('parseTableRow'))+'; return parseTableRow');
const note='|H|K|\n|---|---|\n|ab|KEEP|';

// Use real CM transactions, undo history and the registered cell key handler.
// The fake editable implements the browser's pre-key selection and native deletion.
async function cell(text,anchor,head=anchor) {
  const [{EditorState,EditorSelection,StateEffect},{history,undo,redo},tables,codec]=await modules;
  const initial=EditorSelection.single(anchor,head);
  const view={state:EditorState.create({doc:text,selection:initial,extensions:[history()]}),focus(){}};
  view.dispatch=spec=>{view.state=(spec.startState?spec:view.state.update(spec)).state;};
  const start=text.indexOf('ab'),row=view.state.doc.lineAt(start);
  const div={textContent:'ab',contains:()=>true,caret:2};
  const owner={from:start,to:start+2,text:'ab',rowFrom:row.from,col:0};
  const noOp=()=>{};
  const bindings={div,view,cellEdit:owner,cellComposing:false,runScopeHandlers:()=>false,EditorSelection,setActiveCell:StateEffect.define(),...tables,...codec,
    cellDOMSelection:()=>({anchor:div.caret,head:div.caret}),
    setCellDOMSelection:(_node,_anchor,end)=>{div.caret=end;},syncCellSelection:noOp,updateCellSizer:noOp,
    scheduleCellOverlay:noOp,deactivateCellOverlay:noOp,regionIndexField:0,embeddedImages:()=>[],
    moveActiveCellByKey:run=>run(),resyncCellEdit:()=>{div.textContent=codec.mappedCellSource(view.state.sliceDoc(owner.from,owner.to)).text;},
  };
  const sync=bind(fragment(declaration('syncCellEdit'))+'; return syncCellEdit',bindings);
  const key=bind('return '+fragment(keydown),{...bindings,
    getSelection:()=>({isCollapsed:view.state.selection.main.empty,anchorNode:div}),
    document:{execCommand(command){assert.equal(command,'delete');div.textContent='';div.caret=0;div.__mpCellInputType='deleteContentBackward';sync(div);}},
  });
  const input=(value,caret)=>{div.textContent=value;div.caret=caret;div.__mpCellInputType='insertText';sync(div);};
  const press=(name,shiftKey=false)=>key({key:name,shiftKey,preventDefault:noOp});
  return {view,initial,input,key:press,undo:()=>undo(view),redo:()=>redo(view),text:()=>view.state.doc.toString()};
}

test('a path or TeX prefix typed against a pipe preserves the neighboring cell',async()=>{
  const quoted=note.split('\n').map(line=>'> '+line).join('\n');
  const start=quoted.indexOf('ab'),c=await cell(quoted,start+2);
  c.input('ab\\',3);
  assert.deepEqual(parseRow(c.view.state.doc.line(3).text,2).cells,['ab\\','KEEP']);
  assert.equal(c.view.state.selection.main.head,start+3);
  c.input('ab\\frac ',7);
  assert.deepEqual(parseRow(c.view.state.doc.line(3).text,2).cells,['ab\\frac','KEEP']);
  const openEnd=note.replace('|ab|KEEP|','|KEEP|ab'),unclosed=await cell(openEnd,openEnd.length);
  unclosed.input('ab\\',3);assert.equal(unclosed.text(),openEnd+'\\');
});
test('one Enter on selected last-cell text is one undoable edit',async()=>{
  const pos=note.indexOf('ab'),c=await cell(note,pos+2,pos);
  c.key('Enter');const edited=note.replace('ab','')+'\n|  |  |';assert.equal(c.text(),edited);
  assert(c.undo());assert.equal(c.text(),note);assert(c.view.state.selection.eq(c.initial));
  assert(c.redo());assert.equal(c.text(),edited);
});
test('shift-down at the last row never creates a document line',async()=>{
  const start=note.indexOf('ab'),c=await cell(note,start,start+1);
  c.key('ArrowDown',true);assert.equal(c.text(),note);assert(c.view.state.selection.eq(c.initial));
  c.key('ArrowDown');assert.equal(c.text(),note+'\n');
});
test('inline break preserves a selected structural row and still replaces text within a cell',async()=>{
  const [,,{applyEnterBr}]=await modules,row=note.lastIndexOf('\n')+1,pos=note.indexOf('ab');
  const whole=await cell(note,row,note.length);applyEnterBr(whole.view);
  assert.equal(whole.text(),note);assert(whole.view.state.selection.eq(whole.initial));
  const inside=await cell(note,pos+2,pos);applyEnterBr(inside.view);
  assert.equal(inside.text(),note.replace('ab','<br>'));assert(inside.undo());assert(inside.view.state.selection.eq(inside.initial));
});
