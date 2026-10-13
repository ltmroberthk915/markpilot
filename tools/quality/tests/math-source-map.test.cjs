'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const source=import(pathToFileURL(path.resolve(__dirname,'../../../dsh-markpilot/src-cm6/math-source-map.js')).href);

test('quoted math coordinates retain each source line and trimmed whitespace',async()=>{
  const {mappedMathSource,mathSourcePosition}=await source;
  const doc='Intro\n> > $$\n> >   x+\n> > y   \n> > $$\n';
  const span=mappedMathSource([{text:'  x+',from:doc.indexOf('  x+')},{text:'y   ',from:doc.indexOf('y   ')}]);
  assert.equal(span.tex,'x+\ny');
  const expected=[doc.indexOf('x+'),doc.indexOf('x+')+1,doc.indexOf('\n> > y'),doc.indexOf('y   '),doc.indexOf('y   ')+1];
  for(let i=0;i<expected.length;i++)assert.equal(mathSourcePosition(span,i),expected[i],'TeX offset '+i);
  assert.equal(span.texFrom,expected[0]);
  assert.equal(mathSourcePosition(span,-20),expected[0]);
  assert.equal(mathSourcePosition(span,200),expected.at(-1));
});

test('blank leading quoted lines and UTF-16 astral characters map to their actual document offsets',async()=>{
  const {mappedMathSource,mathSourcePosition}=await source;
  const doc='> $$\n>   \n> 🙂+\n> z\n> $$';
  const span=mappedMathSource([{text:'  ',from:doc.indexOf('  ')},{text:'🙂+',from:doc.indexOf('🙂')},{text:'z',from:doc.indexOf('z')}]);
  assert.equal(span.tex,'🙂+\nz');
  const first=doc.indexOf('🙂'),last=doc.indexOf('z');
  assert.deepEqual(Array.from({length:6},(_,i)=>mathSourcePosition(span,i)),[first,first+1,first+2,first+3,last,last+1]);
});

test('ordinary, legacy, and empty formula endpoints remain usable',async()=>{
  const {mappedMathSource,mathSourcePosition}=await source;
  const span=mappedMathSource([{text:' x+y ',from:20}]);
  assert.equal(span.texFrom,21);assert.equal(mathSourcePosition(span,3),24);
  assert.equal(mathSourcePosition({tex:'x+y',texFrom:11},2),13);
  assert.equal(mappedMathSource([],42).texFrom,42);
  assert.equal(mappedMathSource([{text:'   ',from:23}]).texFrom,23);
});
