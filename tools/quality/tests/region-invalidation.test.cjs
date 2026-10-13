'use strict';
// Model only. The former full-list predicate is an independent delta oracle.
const path=require('node:path'),{pathToFileURL}=require('node:url'),{test}=require('node:test'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../../..'),url=p=>pathToFileURL(path.join(ROOT,p)).href;
test('shared region invalidation equals full revision/context/retirement oracle',async()=>{
 const {EditorState,StateField,StateEffect}=await import(url('dsh-markpilot/node_modules/@codemirror/state/dist/index.js'));
 const {createRegionIndex}=await import(url('dsh-markpilot/src-cm6/region-index.js'));
 const effect=StateEffect.define(),base=StateField.define({create:()=>0,update:(v,tr)=>{for(const e of tr.effects)if(e.is(effect))v=e.value;return v;}});
 const read=s=>{const rows=[];for(let n=1;n<=s.doc.lines;n++){const l=s.doc.line(n),m=/^(>?)([mcti]):(.*)$/.exec(l.text);if(!m)continue;const kind={m:'math',c:'code',t:'table',i:'image'}[m[2]],r={kind,form:m[3].startsWith('display')?'display':'inline',from:l.from+m[1].length,to:l.to,sourceOwned:['code','table'].includes(kind),content:m[3],context:{key:m[1]+':'+(kind==='image'?s.field(base):0)}};rows.push(r);if(m[3]==='duplicate')rows.push({...r});}return rows;};
 const index=createRegionIndex(read,[base]);let state=EditorState.create({doc:'m:aa\nm:bb\nc:cc\nt:dd\ni:ee\n',extensions:[base,index]});
 const oracle=(before,after)=>{const dirty=new Set;for(const r of after.regions){const old=before?.byId.get(r.id);if(!old||old.revision!==r.revision||old.contextVersion!==r.contextVersion)dirty.add(r.id);}for(const r of before?.regions||[])if(!after.byId.has(r.id))dirty.add(r.id);return[...dirty].sort();};
 assert.deepEqual([...state.field(index).invalidated].sort(),oracle(null,state.field(index)));
 const apply=tr=>{const before=state.field(index);state=state.update(tr).state;const after=state.field(index);assert.deepEqual([...after.invalidated].sort(),oracle(before,after));const saved=[...after.invalidated];const selected=state.update({selection:{anchor:state.doc.length}}).state;assert.strictEqual(selected.field(index),after,'selection-only index reuse');assert.deepEqual([...after.invalidated],saved,'first consumer cannot consume shared footprint');return{before,after};};
 let changed=apply({changes:{from:0,insert:'plain\n'}});assert.equal(changed.after.invalidated.size,0,'pure position mapping');
 let at=state.doc.toString().indexOf('aa');apply({changes:{from:at,to:at+2,insert:'AA'}});
 at=state.doc.toString().indexOf('m:bb');apply({changes:{from:at,insert:'>'}});
 apply({effects:effect.of(1)});assert([...state.field(index).invalidated].every(id=>(state.field(index).byId.get(id)).kind==='image'),'dependency-only base change');
 at=state.doc.toString().indexOf('c:cc')+4;apply({changes:{from:at,insert:'R'}});
 at=state.doc.toString().indexOf('m:AA')+2;apply({changes:{from:at,to:at+2,insert:'display'}});
 at=state.doc.toString().indexOf('>m:bb');apply({changes:{from:at,to:at+5,insert:'i:bb'}});
 const text=state.doc.toString();apply({changes:{from:0,to:state.doc.length,insert:text}});
 apply({changes:{from:state.doc.length,insert:'m:duplicate\n'}});
 apply({changes:{from:0,insert:'x\n'}});
 const line=state.doc.line(state.doc.lines-1);apply({changes:{from:line.from,to:line.to+1,insert:''}});
});
