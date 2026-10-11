const {test}=require('node:test'),assert=require('node:assert/strict');
const modulePromise=import('../../Typora-Editor/extension-src/render/js/office-math.mjs');
const pua=index=>String.fromCharCode(0xE000+index);
test('placeholder symbol skips private-use characters already in the formula',async()=>{
  const {freePuaSymbol}=await modulePromise;
  const empty=new Set(),taken=new Set();
  assert.equal(freePuaSymbol(empty,taken),pua(0));
  taken.add(pua(0));
  assert.equal(freePuaSymbol(empty,taken),pua(1));
  // A literal U+E000 in the source must never become a placeholder marker.
  const used=new Set([pua(0)]);
  assert.equal(freePuaSymbol(used,taken),pua(1));
  assert.equal(freePuaSymbol(new Set([pua(0),pua(1)]),taken),pua(2));
  const dense=new Set(Array.from({length:4096},(_,i)=>pua(i)));
  assert.throws(()=>freePuaSymbol(dense,new Set()),/公式嵌套过多/);
});
