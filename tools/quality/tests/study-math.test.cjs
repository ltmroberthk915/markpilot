'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const project=path.resolve(__dirname,'../../../dsh-markpilot');
const read=name=>fs.readFileSync(path.join(project,'src-cm6',name),'utf8');
const load=name=>import(pathToFileURL(path.join(project,name)).href);
const main=read('main.js'),inline=read('inline-format.js');
function slice(code,from,to){const a=code.indexOf(from),b=code.indexOf(to,a);assert(a>=0&&b>a,from);return code.slice(a,b);}
const libraries=Promise.all([load('node_modules/@codemirror/state/dist/index.js'),load('src-cm6/markdown-context.js'),load('src-cm6/inline-format.js'),load('src-cm6/tables.js'),load('src-cm6/math-source-map.js')]);
async function scanner(){
 const [cm,md,inf,table,map]=await libraries,keys=['scanFencedBlocks','scanStructuralContext','structuralContextAt','blockAt','tableLead','inlineMathSpans','hasUnescapedDollar','mappedMathSource','singleLineDisplayTex'];
 const helper=inline.includes('export function singleLineDisplayTex(')?new Function(slice(inline,'function singleLineDisplayTex(','const inlineParser')+'; return singleLineDisplayTex;')():undefined;
 const fn=new Function(...keys,slice(main,'function scanMathSpans(', '/** 派生层')+';return scanMathSpans;')(...keys.map(k=>({ ...md,...table,...map,...inf,singleLineDisplayTex:helper }[k])));
 return s=>fn(cm.Text.of(s.split('\n')));
}
test('orphan math delimiters cannot pair across different note containers',async()=>{
 const scan=await scanner();
 for(const [doc,block] of [
 ['PRE\n\n> $$\n> a\n\nOUTSIDE\n\n$$\nb\n$$','$$\nb\n$$'],
 ['PRE\n\n- $$\n  a\n- unrelated\n\n$$\nb\n$$','$$\nb\n$$'],
 ['> $$a\n\nOUTSIDE\n\n$$\nb\n$$','$$\nb\n$$'],
 ['> $\\begin{cases}a\n\nOUTSIDE\n\n$$\nb\n$$','$$\nb\n$$']
 ]){const spans=scan(doc).filter(x=>x.display);assert.deepEqual(spans.map(x=>[doc.slice(x.from,x.to),x.tex]),[[block,'b']]);}
 const valid='> > $$\n> > a\n> > b\n> > $$';
 assert.deepEqual(scan(valid).map(x=>[x.tex,x.display]),[['a\nb',true]]);
});
test('single-line display parsing does not consume prose between separate atoms',async()=>{
 const scan=await scanner();
 assert.deepEqual(scan('$$a$$ versus $$b$$').map(x=>[x.tex,x.display]),[['a',false],['b',false]]);
 assert.deepEqual(scan('before `$$x$$` then $y$').map(x=>x.tex),['y']);
 assert.deepEqual(scan('$$a\\$b$$').map(x=>[x.tex,x.display]),[['a\\$b',true]]);
 assert.deepEqual(scan('$$a$$').map(x=>[x.tex,x.display]),[['a',true]]);
});
async function mathClick(kind){
 const [cm]=await libraries, {EditorState,EditorSelection,StateField,Transaction}=cm;
 const span={from:5,to:12,tex:'a+b',texFrom:8,display:true}, region={kind:'math',from:5,to:12,id:'m'};
 const index=StateField.define({create:()=>({epoch:1,byId:new Map([['m',region]])}),update:x=>x});
 const math=StateField.define({create:()=>({spans:[span]}),update:x=>x});
 let serial=0;const intent={serial:()=>serial};
 const code=slice(main,'const clickToSource = EditorView.domEventHandlers(','const regionKeys =');
 const handlers=new Function('EditorView','regionIndexField','mathSpansField','viewportIntent','mathGlyphOffset','mathSourcePosition','setMathPointerSelection',code+';return clickToSource;')({domEventHandlers:x=>x},index,math,intent,()=>1,(r,i)=>r.texFrom+i,new Function('EditorSelection','Transaction',slice(main,'function setMathPointerSelection(','function floatScrollbarHit(')+';return setMathPointerSelection;')(EditorSelection,Transaction));
 const text='PRE\n\n$$\na+b\n$$\n\nTAIL',view={state:EditorState.create({doc:text,extensions:[EditorState.allowMultipleSelections.of(true),index,math]}),scrollDOM:{scrollTop:0},focus(){},dispatch(spec){this.state=this.state.update(spec).state;}};
 const holder={dataset:{mpRegion:'m'},getBoundingClientRect:()=>({width:10,height:10,left:0,right:10,top:0,bottom:10})};
 if(kind==='remove')view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(0),EditorSelection.cursor(span.from)],1)});
 const event={target:{closest:s=>s.includes('.mp-cm6-math')?holder:null},button:0,buttons:1,detail:1,ctrlKey:kind==='multiple'||kind==='remove',clientX:4,clientY:4}; handlers.mousedown(event,view);
 if(kind==='multiple')view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(0),EditorSelection.cursor(span.from)],1),userEvent:'select.pointer'});
 if(kind==='remove')view.dispatch({selection:EditorSelection.single(0),userEvent:'select.pointer'});
 if(kind==='later'){serial++;view.dispatch({selection:{anchor:text.length},userEvent:'select'});}
 handlers.mouseup({...event,buttons:0},view);return view.state;
}
test('formula release preserves a newer keyboard destination',async()=>{
 const v=await mathClick('later');assert.equal(v.selection.main.head,v.doc.length);
 assert.equal((await mathClick('click')).selection.main.head,9,'ordinary glyph click stays exact');
});
test('modified formula releases retain the native additional selection',async()=>{const v=await mathClick('multiple');assert.equal(v.selection.ranges.length,2);assert.equal(v.selection.mainIndex,1);assert.equal(v.selection.main.head,9,'a glyph, not its surrounding opening fence');assert.equal((await mathClick('remove')).selection.main.head,0,'native removal stays removed');});
async function autoBreakRig(initial,head){
 const [cm,md,inf]=await libraries;const {EditorState,StateField}=cm;
 const dummy=StateField.define({create:()=>null,update:x=>x});let serial=0,next=0;const frames=new Map();
 const Class=new Function('ViewPlugin','requestAnimationFrame','cancelAnimationFrame','viewportIntent','codeBlockAt','inlineMathSpans','lineStylesField','tableDataField',slice(main,'const autoBreakMath =','/* ── 点公式')+';return autoBreakMath;')({fromClass:C=>C},f=>{frames.set(++next,f);return next;},id=>frames.delete(id),{serial:()=>serial},md.codeBlockAt,inf.inlineMathSpans,dummy,dummy);
 const view={state:EditorState.create({doc:initial,selection:{anchor:head},extensions:[md.markdownContext]}),hasFocus:true,composing:false};
 const plugin=new Class(view);
 view.dispatch=spec=>{const tr=view.state.update(spec);if(tr.docChanged)serial++;view.state=tr.state;plugin.update({docChanged:tr.docChanged,selectionSet:!!tr.selection,transactions:[tr],state:view.state});};
 const type=s=>view.dispatch({...view.state.replaceSelection(s),userEvent:'input.type'}),move=head=>{serial++;view.dispatch({selection:{anchor:head},userEvent:'select'});};
 const paint=()=>{const jobs=[...frames.values()];frames.clear();jobs.forEach(f=>f());};
 return {view,type,move,paint};
}
test('auto-break only rewrites the just-typed plain-text math atom',async()=>{
 for(const text of ['Sample `cmd $$x$` tail','Sample ``cmd ` $$x$`` tail','Sample \\$\\$x$ tail']){
   const pos=text.indexOf('x$')+2,r=await autoBreakRig(text,pos);r.type('$');r.paint();assert.equal(r.view.state.doc.toString(),text.slice(0,pos)+'$'+text.slice(pos));
 }
 const normal='Study $$x$',r=await autoBreakRig(normal,normal.length);r.type('$');r.paint();assert.equal(r.view.state.doc.toString(),'Study \n$$x$$');
});
test('a deferred formula break cannot follow a later cursor into old notes',async()=>{
 const text='START\nStudy $$x$$',r=await autoBreakRig(text,0);r.type('N');r.move(r.view.state.doc.length);r.paint();assert.equal(r.view.state.doc.toString(),'N'+text);
});
test('adding a caret keeps earlier partial formula ranges exact in both directions',async()=>{
 const [{EditorState,EditorSelection,StateField,Transaction}]=await libraries;
 const text='START $x+y$ NOTE\n\nSECOND $a+b$ END';
 const spans=[['$x+y$','x+y'],['$a+b$','a+b']].map(([raw,tex])=>({from:text.indexOf(raw),to:text.indexOf(raw)+raw.length,tex}));
 const field=StateField.define({create:()=>({spans}),update:x=>x});
 const filter=new Function('EditorState','EditorSelection','Transaction','mathSpansField','exactFloatingClicks',slice(main,'function mathSnapRange(','/** 引用标记的零宽占位')+';return mathPointerSelectionSnap;')(EditorState,EditorSelection,Transaction,field,new WeakSet());
 const inside=text.indexOf('x+y')+1,outside=text.indexOf('NOTE')+2,second=text.indexOf('a+b')+3;
 for(const [anchor,head] of [[outside,inside],[inside,outside]]){
   const exact=EditorSelection.range(anchor,head),state=EditorState.create({doc:text,selection:EditorSelection.create([exact]),extensions:[EditorState.allowMultipleSelections.of(true),field,filter]});
   const tr=state.update({selection:state.selection.addRange(EditorSelection.cursor(second)),userEvent:'select.pointer'});
   assert.deepEqual(tr.newSelection.ranges[0].toJSON(),exact.toJSON());
 }
 const state=EditorState.create({doc:text,extensions:[field,filter]});
 const ordinary=state.update({selection:{anchor:outside,head:inside},userEvent:'select.pointer'});
 assert.equal(ordinary.newSelection.main.head,spans[0].from,'a new drag still snaps the crossed formula boundary');
});
