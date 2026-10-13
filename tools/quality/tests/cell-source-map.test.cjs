'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const source=import(pathToFileURL(path.resolve(__dirname,'../../../dsh-markpilot/src-cm6/cell-source-map.js')).href);

test('literal table pipes have distinct DOM and source boundaries',async()=>{
 const {mappedCellSource,cellSourceOffset,cellTextOffset}=await source;
 const mapped=mappedCellSource('a\\|b');assert.equal(mapped.text,'a|b');assert.deepEqual(mapped.offsets,[0,1,3,4]);
 assert.deepEqual([0,1,2,3].map(p=>cellSourceOffset(mapped,p)),[0,1,3,4]);
 assert.deepEqual([0,1,3,4].map(p=>cellTextOffset(mapped,p)),[0,1,2,3]);
 assert.equal(cellTextOffset(mapped,2,-1),1);assert.equal(cellTextOffset(mapped,2,1),2);
 assert.equal(cellSourceOffset(mapped,999),4);assert.equal(cellTextOffset(mapped,-1),0);
});

test('a following character and selected deletion preserve the pipe escape',async()=>{
 const {cellTextChange}=await source;
 assert.deepEqual(cellTextChange('a\\|b','a|Xb'),{from:3,to:3,insert:'X',source:'a\\|Xb'});
 assert.deepEqual(cellTextChange('a\\|Xb','aXb'),{from:1,to:3,insert:'',source:'aXb'});
 assert.deepEqual(cellTextChange('ab','a|b'),{from:1,to:1,insert:'\\|',source:'a\\|b'});
 assert.equal(cellTextChange('a\\|b','a|b'),null);
});

test('visible backslashes and TeX remain literal while table escapes round trip',async()=>{
 const {mappedCellSource,encodeCellText,cellTextChange}=await source;
 const raw='a\\\\|b \\alpha \\$ <br> **bold**';
 const mapped=mappedCellSource(raw);assert.equal(mapped.text,'a\\|b \\alpha \\$ <br> **bold**');assert.equal(encodeCellText(mapped.text),raw);
 assert.deepEqual(cellTextChange('ab','a\\|b'),{from:1,to:1,insert:'\\\\|',source:'a\\\\|b'});
 assert.equal(cellTextChange(raw,mapped.text),null);
});

test('astral characters and multiple pipes use UTF-16 offsets',async()=>{
 const {mappedCellSource,cellSourceOffset,cellTextChange}=await source;
 const raw='🙂\\|甲\\|z',mapped=mappedCellSource(raw);assert.equal(mapped.text,'🙂|甲|z');assert.deepEqual(mapped.offsets,[0,1,2,4,5,7,8]);
 assert.equal(cellSourceOffset(mapped,3),4);
 assert.deepEqual(cellTextChange(raw,'🙂|X甲|z'),{from:4,to:4,insert:'X',source:'🙂\\|X甲\\|z'});
});

test('leading, trailing, and empty cell text retain exact source changes',async()=>{
 const {mappedCellSource,encodeCellText,cellTextChange}=await source;
 assert.equal(encodeCellText('|x|'),'\\|x\\|');assert.deepEqual(mappedCellSource(''),{text:'',offsets:[0]});
 assert.deepEqual(cellTextChange('\\|x\\|',''),{from:0,to:5,insert:'',source:''});
 assert.deepEqual(cellTextChange('  x  ','  y  '),{from:2,to:3,insert:'y',source:'  y  '});
});
