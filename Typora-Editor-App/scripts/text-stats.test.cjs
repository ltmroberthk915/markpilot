const {test}=require('node:test'),assert=require('node:assert/strict');
const {computeStats}=require('../app/main/text-stats');
const legacy=text=>{const cjk=(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)||[]).length;return text?{words:cjk+(text.match(/[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g)||[]).length,chars:text.replace(/\s/g,'').length,cjk,lines:text.split('\n').length}:{words:0,chars:0,cjk:0,lines:0};};
test('Statistics preserve CJK, contractions, emoji, CRLF and all UTF-16 whitespace/boundary behavior',()=>{
  for(const text of ['',"a--b a'b a’b x_2\r\n",'🙂𠀀\ufeff\u200b\u2028数学 $x$\n',Array.from({length:65536},(_,i)=>'a'+String.fromCharCode(i)+'b').join('')])assert.deepEqual(computeStats(text),legacy(text));
  assert.deepEqual(computeStats('中文 abc\n'),{words:3,chars:5,cjk:2,lines:2});
});
test('Random mixed-Unicode statistics match the established implementation',()=>{
  let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<600;i++){const text=Array.from({length:random()%700},()=>String.fromCharCode(random()%65536)).join('');assert.deepEqual(computeStats(text),legacy(text));}
});
