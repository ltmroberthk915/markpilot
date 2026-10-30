'use strict';
const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict'),acorn=require('acorn');
const root=path.resolve(__dirname,'../../..');
const maintained=fs.readFileSync(path.join(root,'dsh-markpilot/renderer/vendor/codemirror/view.js'),'utf8');
const upstream=fs.readFileSync(path.join(root,'dsh-markpilot/node_modules/@codemirror/view/dist/index.js'),'utf8');
function actualGeometry(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});
 const names=['LineGap','LineGapWidget','lineStructure','findPosition','findFraction','find'];
 const parts=ast.body.filter(n=>names.includes(n.id?.name)).map(n=>source.slice(n.start,n.end));
 const state=ast.body.find(n=>n.type==='ClassDeclaration'&&n.id.name==='ViewState');
 const methods=state.body.body.filter(n=>['ensureLineGaps','gapSize'].includes(n.key.name)).map(n=>source.slice(n.start,n.end));
 const scope={WidgetType:class{},Decoration:{replace:spec=>({range:(from,to)=>({from,to,...spec})})},document:{createElement:()=>({style:{}})},RangeSet:{spans(){}},BlockType:{Text:0},Direction:{LTR:0}};
 return Function('scope','with(scope){'+parts.join('\n')+';return {LineGap,LineGapWidget,methods:{'+methods.join(',')+'}};}')(scope);
}
test('long-line gap DOM uses CSS lengths while height estimates remain client lengths',()=>{
 for(const scale of [.8,1,1.25,1.65,2])for(const vertical of [false,true]){
  const {LineGap}=actualGeometry(maintained),gap=new LineGap(100,5000,3200,3200);
  const widget=gap.draw({scaleX:scale,scaleY:scale},vertical).widget,dom=widget.toDOM();
  assert(Math.abs(parseFloat(dom.style[vertical?'height':'width'])*scale-3200)<1e-6);
  assert.equal(widget.estimatedHeight,vertical?3200:-1);
  assert.equal(widget.eq(gap.draw({scaleX:scale,scaleY:scale},vertical).widget),true);
  assert.equal(widget.eq(gap.draw({scaleX:scale+.1,scaleY:scale+.1},vertical).widget),false,'zoom changes invalidate DOM geometry');
 }
 const {LineGap}=actualGeometry(upstream),old=new LineGap(100,5000,3200,3200).draw({scaleX:1.65,scaleY:1.65},true).widget;
 assert(Math.abs(parseFloat(old.toDOM().style.height)*1.65-3200)>1000,'original bug is discriminated');
});
test('compressed long-line viewport retains the characters at the visible midpoint',()=>{
 const state=methods=>({...methods,state:{selection:{main:{from:0,to:0,empty:true}}},stateDeco:[],heightOracle:{lineWrapping:true,lineLength:80,lineHeight:20},scrollTarget:null,
  pixelViewport:{top:4250000,bottom:4250600},visibleTop:6550000,visibleBottom:6550600,viewportLines:[{from:0,to:100000,length:100000,top:4000000,height:500000,type:0}]});
 const fixed=state(actualGeometry(maintained).methods),broken=state(actualGeometry(upstream).methods);
 const fixedGaps=fixed.ensureLineGaps([]),oldGaps=broken.ensureLineGaps([]);
 assert(!fixedGaps.some(g=>g.from<50000&&g.to>50000),'visible text must not be replaced by a gap');
 assert(oldGaps.some(g=>g.from<50000&&g.to>50000),'original compression bug hides the visible midpoint');
 // With identity scaling both definitions must produce the same intervals.
 broken.visibleTop=broken.pixelViewport.top;broken.visibleBottom=broken.pixelViewport.bottom;
 assert.deepEqual(fixedGaps.map(g=>[g.from,g.to]),broken.ensureLineGaps([]).map(g=>[g.from,g.to]));
});
