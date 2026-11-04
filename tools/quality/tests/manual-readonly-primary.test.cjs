'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const engine=path.resolve(__dirname,'../../../dsh-markpilot');
const load=rel=>import(pathToFileURL(path.join(engine,rel)).href);

test('browsing at the end of a table cannot edit its Markdown through table keyboard commands',async t=>{
  const [{EditorState,Transaction},{keymap},{tableKeys}]=await Promise.all([
    load('node_modules/@codemirror/state/dist/index.js'),load('node_modules/@codemirror/view/dist/index.js'),load('src-cm6/tables.js'),
  ]);
  const text='|A|B|\n|---|---|\n|left|right|';
  for(const [name,key,shift] of [['Enter','Enter',false],['Shift+Enter','Enter',true],['Tab','Tab',false],['ArrowDown','ArrowDown',false]]){
    await t.test(name,()=>{
      for(const readOnly of [false,true]){
        const view={state:EditorState.create({doc:text,selection:{anchor:text.length-1},extensions:[tableKeys,EditorState.readOnly.of(readOnly)]})};
        view.dispatch=spec=>{view.state=spec instanceof Transaction?spec.state:view.state.update(spec).state;};
        const binding=view.state.facet(keymap).flat().find(b=>b.key===key);
        assert(binding);(shift?binding.shift:binding.run)(view);
        assert.equal(view.state.doc.toString()===text,readOnly,'the editable positive control inserts at EOF, the read-only control preserves the document');
      }
    });
  }
});

test('formatting multiple ranges preserves the active caret across extension and undo',async()=>{
  const [{EditorState,EditorSelection,Transaction},{history,undo,redo},{wrap}]=await Promise.all([
    load('node_modules/@codemirror/state/dist/index.js'),load('node_modules/@codemirror/commands/dist/index.js'),load('src-cm6/toolbar.js'),
  ]);
  const doc='abc def';
  const selection=EditorSelection.create([EditorSelection.range(0,3),EditorSelection.range(7,4)],1);
  const view={state:EditorState.create({doc,selection,extensions:[EditorState.allowMultipleSelections.of(true),history()]}),focus(){}};
  view.dispatch=spec=>{view.state=spec instanceof Transaction?spec.state:view.state.update(spec).state;};
  const previous=global.window;
  try{
    global.window={};assert(wrap(view,'**'));assert.equal(view.state.selection.mainIndex,1);
    const formatted=view.state.doc.toString();assert.equal(formatted,'**abc** **def**');
    const carets=view.state.selection,extended=carets.ranges.map(r=>EditorSelection.range(r.anchor,r.head+1));
    view.dispatch({selection:EditorSelection.create(extended,carets.mainIndex),userEvent:'select.extend'});
    assert.equal(view.state.selection.mainIndex,1);assert(undo(view));assert.equal(view.state.doc.toString(),doc);
    assert.equal(view.state.selection.mainIndex,1);assert(redo(view));assert.equal(view.state.doc.toString(),formatted);
  }finally{if(previous===undefined)delete global.window;else global.window=previous;}
});
