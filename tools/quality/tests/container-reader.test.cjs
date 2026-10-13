'use strict';
// Model only: compare every cached descriptor field against the uncached reader.
const path=require('node:path'),{pathToFileURL}=require('node:url'),{test}=require('node:test'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../..'),url=p=>pathToFileURL(path.join(ROOT,p)).href;
test('row context cache preserves semantic paths, endpoints, code ownership and base versions',async()=>{
 const {EditorState}=await import(url('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'));
 const {containerContext,createContainerContextReader}=await import(url('dsh-markpilot/src-cm6/container-presentation.js'));
 const {scanStructuralContext,blockAt}=await import(url('dsh-markpilot/src-cm6/markdown-context.js'));
 const fixtures=['plain $x$ and $y$\nnext $z$\n','> quote $x$\nlazy $y$\n\n> > nested $z$\n','- outer\n  > nested $x$\n    lazy $y$\n\nplain\n','> ```js\n> - literal $x$\n> ```\n> after $y$\n','```\n> literal\n- literal\n```\n- actual list\n'];
 let comparisons=0;
 for(const text of fixtures){const doc=EditorState.create({doc:text}).doc,structure=scanStructuralContext(doc),reader=createContainerContextReader(doc,structure);
  for(let line=1;line<=doc.lines;line++){const row=doc.line(line);
   for(const pos of new Set([row.from,Math.floor((row.from+row.to)/2),row.to]))for(const base of [0,1,9])for(const code of [null,blockAt(structure.blocks,pos)]){
    const actual=reader(pos,code,base),expected=containerContext(doc,pos,code,base,structure);assert.deepEqual(actual,expected);comparisons++;
    Object.freeze(actual.path);for(const p of actual.path)Object.freeze(p);Object.freeze(actual);
    assert.strictEqual(reader(pos,code,base),actual,'same state and semantic row reuse');
   }
  }
  const next=EditorState.create({doc:'prefix\n'+text}).doc,newStructure=scanStructuralContext(next),newReader=createContainerContextReader(next,newStructure);
  assert.deepEqual(newReader(0),containerContext(next,0,null,0,newStructure));assert.notStrictEqual(newReader(0),reader(0));
 }
 // Without structural records, truthy code with undefined depth still disables
 // list recognition. It must never alias the explicit no-code cache entry.
 const doc=EditorState.create({doc:'- item $x$\n'}).doc,reader=createContainerContextReader(doc),none=reader(0,null),code=reader(0,{});
 assert(none.path.some(p=>p.kind==='list'));assert(!code.path.some(p=>p.kind==='list'));assert.notStrictEqual(none,code);
 assert(comparisons>200);
});
