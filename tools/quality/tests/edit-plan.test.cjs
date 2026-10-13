'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),load=rel=>import(pathToFileURL(path.join(root,rel)).href);
const modules=Promise.all([load('dsh-markpilot/src-cm6/edit-plan.js'),load('dsh-markpilot/src-cm6/command-context.js'),load('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'),load('dsh-markpilot/node_modules/@codemirror/commands/dist/index.js')]);
test('semantic prefix changes reject mapping even when the changed fragment has no delimiter',async()=>{
 const [plan,,{EditorState}]=await modules;
 for(const [text,from,to,insert] of [['# heading',1,2,''],['x# heading',0,1,''],['---',3,3,'x'],['1. item',1,2,''],['> text',0,1,''],['abc',1,1,'\n']]){
  assert.equal(plan.singleLineEdit(EditorState.create({doc:text}).update({changes:{from,to,insert}})),null,text);
 }
 for(const text of ['$x+y$', '> $x+y$', '![alt](file.png)', '  ordinary text']){
  const from=text.includes('y')?text.indexOf('y'):text.indexOf('a')+1;
  assert(plan.singleLineEdit(EditorState.create({doc:text}).update({changes:{from,insert:'z'}})),text);
 }
});
test('inline-code exclusion uses matching backtick runs and respects escaped openers',async()=>{
 const [p]=await modules;
 assert.deepEqual(p.inlineCodeRanges('a `$x$` b'),[[2,7]]);
 assert.deepEqual(p.inlineCodeRanges('``a ` $x$``'),[[0,11]]);
 assert.deepEqual(p.inlineCodeRanges('\\`$x$`'),[]);
 assert.deepEqual(p.inlineCodeRanges('`unclosed'),[]);
});
test('one CM history preserves actual post-replacement selection through external prefix, Undo, Redo and immediate input',async()=>{
 const [,{applySourceHistory},{EditorState,Transaction},{history,undoDepth}]=await modules;
 let state=EditorState.create({doc:'Before\n\n|H|K|\n|---|---|\n|a\\|b|KEEP|\n\nAfter\n',extensions:[history()]});
 const target={get state(){return state},dispatch(tr){state=tr.state}};
 state=state.update({selection:{anchor:29,head:26},annotations:Transaction.addToHistory.of(false)}).state;
 state=state.update({changes:{from:0,insert:'EXT\n'},selection:{anchor:33,head:30},annotations:Transaction.addToHistory.of(false)}).state;
 state=state.update({changes:{from:30,to:33,insert:'R'},selection:{anchor:31},userEvent:'input.type'}).state;
 assert.equal(undoDepth(state),1);assert(applySourceHistory(target,'undo'));
 assert.deepEqual([state.selection.main.anchor,state.selection.main.head],[33,30]);assert(state.doc.toString().startsWith('EXT\n'));
 assert(applySourceHistory(target,'redo'));assert.deepEqual([state.selection.main.anchor,state.selection.main.head],[31,31]);
 state=state.update(state.replaceSelection('1')).state;
 assert(state.doc.toString().includes('|aR1|KEEP|'));
});
