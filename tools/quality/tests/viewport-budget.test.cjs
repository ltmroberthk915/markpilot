'use strict';
const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),builder=require('../../vendor/build-codemirror-view.cjs');
test('maintained view is deterministic and preserves upstream selection and tall-block coverage logic',()=>{
 const generated=builder.generate().text,file=path.join(root,'dsh-markpilot/renderer/vendor/codemirror/view.js');
 assert.equal(generated,fs.readFileSync(file,'utf8'));
 const upstream=fs.readFileSync(path.join(root,'dsh-markpilot/node_modules/@codemirror/view/dist/index.js'),'utf8');
 for(const [start,end] of [['    viewportIsAppropriate(', '    mapLineGaps('],['    updateForViewport()', '    updateScaler()']]){
  const section=text=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
  assert(section(upstream).length>100);assert.equal(section(generated),section(upstream));
 }
 assert.equal((generated.match(/const margin = this.state.facet\(viewportMargin\)/g)||[]).length,1);
});
test('public viewport budget retains upstream default and finite 300..1000 bounds',async()=>{
 const {EditorState}=await import(pathToFileURL(path.join(root,'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href);
 const {EditorView}=await import(pathToFileURL(path.join(root,'dsh-markpilot/renderer/vendor/codemirror/view.js')).href);
 const field=EditorView.viewportMargin;
 assert.equal(EditorState.create().facet(field),1000);
 for(const [input,expected] of [[300,300],[400,400],[200,300],[-1,300],[2000,1000],[NaN,1000],[Infinity,1000]]){
  assert.equal(EditorState.create({extensions:[field.of(input)]}).facet(field),expected);
 }
});
