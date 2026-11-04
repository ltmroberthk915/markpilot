'use strict';
const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const here=__dirname,root=path.resolve(here,'../../..');
const prod=path.join(root,'dsh-markpilot/src-cm6');
const src=process.env.MP_STUDY_STRUCTURE_SOURCES||prod;
const mathSource=fs.readFileSync(path.join(src,'rich-clipboard.js'),'utf8').replace("'./inline-format.js'",JSON.stringify(pathToFileURL(path.join(prod,'inline-format.js')).href));
const math=import('data:text/javascript;base64,'+Buffer.from(mathSource).toString('base64'));
const extras=fs.readFileSync(path.join(src,'extras.js'),'utf8');
const {parse}=require('node:module').createRequire(path.join(root,'tools/quality/package.json'))('acorn');
const items=parse(extras,{ecmaVersion:'latest',sourceType:'module'}).body.find(x=>x.declaration?.id?.name==='installExtras').declaration.body.body;
const actual=items.filter(x=>['htmlRichToMd','structuredClipboardTable','rowsToMdTable','tableRowsFromElement'].includes(x.id?.name)).map(x=>extras.slice(x.start,x.end)).join('\n');
const htmlRich=Function('clipboardStyle','htmlInlineNodesToMd','HTML_BLOCKS',actual+'\n return htmlRichToMd;')(()=>'',ns=>Array.from(ns,n=>n.textContent).join(''),'p,table');
class Element {
 constructor(name, children=[], attrs={}) {
  this.localName=name;this.tagName=name.toUpperCase();this.namespaceURI='http://www.w3.org/1998/Math/MathML';this.nodeType=1;this.attrs={...attrs};
  this.childNodes=children.map(x=>typeof x==='string'?{nodeType:3,nodeValue:x,textContent:x}:x);
  this.children=this.childNodes.filter(n=>n.nodeType===1);
  for(const c of this.children)c.parentElement=this;
 }
 get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
 get firstElementChild(){return this.children[0];}
 get attributes(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}
 getAttribute(n){return this.attrs[n]??null;}
 removeAttribute(n){delete this.attrs[n];}
 get rowSpan(){return +(this.attrs.rowspan??1);}
 get colSpan(){return +(this.attrs.colspan??1);}
 get rows(){return this.querySelectorAll('tr').filter(tr=>tr.closest('table')===this);}
 get cells(){return this.children.filter(c=>c.localName==='td'||c.localName==='th');}
 get caption(){return this.children.find(c=>c.localName==='caption');}
 get outerHTML(){return '<'+this.localName+this.attributes.map(a=>' '+a.name+'="'+a.value+'"').join('')+'>'+this.childNodes.map(c=>c.nodeType===3?c.textContent:c.outerHTML).join('')+'</'+this.localName+'>';}
 cloneNode(){return new Element(this.localName,this.childNodes.map(n=>n.nodeType===3?n.textContent:n.cloneNode()),this.attrs);}
 matches(selector){return selector.split(',').some(s=>s==='*'||s===this.localName||s.startsWith('[rowspan]')&&this.rowSpan!==1||s.startsWith('[colspan]')&&this.colSpan!==1);}
 closest(s){return this.matches(s)?this:this.parentElement?.closest(s);}
 querySelectorAll(s){return this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)]);}
 querySelector(s){
  if(s.includes('annotation[')){
   let candidates=this.querySelectorAll('annotation');
   if(s.startsWith(':scope'))candidates=candidates.filter(a=>a.parentElement?.localName==='semantics'&&a.parentElement.parentElement===this);
   return candidates.find(a=>a.attrs.encoding==='application/x-tex')||null;
  }
  return this.querySelectorAll(s)[0]||null;
 }
}
const el=(name,...children)=>new Element(name,children);
const cell=(text,attrs={})=>new Element('td',[text],attrs);
test('unannotated MathML keeps both sides of fractions, powers and subscripts',async()=>{
 const {clipboardFormula}=await math;
 const source=el('math',el('mfrac',el('msup',el('mi','x'),el('mn','2')),el('msub',el('mi','y'),el('mn','1'))));
 assert.equal(clipboardFormula(source),'$\\frac{{x}^{2}}{{y}_{1}}$');
 assert.equal(clipboardFormula(el('math',el('mrow',el('mi','x'),el('mtext',' is '),el('mi','y')))),'$x\\text{ is }y$');
});
test('an annotation from a nested expression does not replace a whole formula',async()=>{
 const {clipboardFormula}=await math;
 const nested=el('semantics',el('mi','a'),new Element('annotation',['WRONG'],{encoding:'application/x-tex'}));
 assert.equal(clipboardFormula(el('math',el('mfrac',nested,el('mi','b')))),'$\\frac{a}{b}$');
 const mixed=el('math',nested,el('mo','+'),el('mi','k'));
 assert.equal(clipboardFormula(mixed),'$a+k$');
 const direct=el('math',el('semantics',el('mi','a'),new Element('annotation',['a^2'],{encoding:'application/x-tex'})));
 assert.equal(clipboardFormula(direct),'$a^2$');
});
test('unknown or semantically styled MathML remains inert source',async()=>{
 const {clipboardFormula}=await math;
 const enclosed=el('math',new Element('menclose',[el('mi','z')],{notation:'box',onclick:'NEVER()'}));
 assert.equal(clipboardFormula(enclosed),String.fromCharCode(96)+'<math><menclose notation="box"><mi>z</mi></menclose></math>'+String.fromCharCode(96));
 const unbarred=el('math',new Element('mfrac',[el('mi','a'),el('mi','b')],{linethickness:'0'}));
 assert(clipboardFormula(unbarred).includes('linethickness="0"'));
 const glyph=el('math',new Element('mglyph',[],{src:'https://example.invalid/symbol.svg',alt:'triangle',onload:'X'}));
 const safe=clipboardFormula(glyph);assert(safe.includes('symbol.svg')&&safe.includes('alt="triangle"')&&!safe.includes('onload'));
 const toggle=el('math',new Element('maction',[el('mi','a'),el('mi','b')],{actiontype:'toggle',selection:'2',onclick:'BAD'}));
 const literal=clipboardFormula(toggle);assert(literal.includes('selection="2"')&&literal.includes('actiontype="toggle"')&&!literal.includes('onclick'));
});
test('merged grid keeps range anchors, empty columns and exactly one copy of real data',()=>{
 const table=el('table',el('tbody',el('tr',cell('Trial',{rowspan:'2'}),cell('Observed',{colspan:'2'})),el('tr',cell('North'),cell('South')),el('tr',cell('Q17'),cell('21'),cell('42'))));
 assert.equal(htmlRich(el('body',table)),'| Trial | Observed |  |\n| --- | --- | --- |\n|  | North | South |\n| Q17 | 21 | 42 |\n\n合并单元格：R1C1:R2C1、R1C2:R1C3');
 const zero=el('table',el('thead',el('tr',cell('A',{rowspan:'0'}),cell('B')),el('tr',cell('C'))),el('tbody',el('tr',cell('D'),cell('E'))));
 const s=htmlRich(el('body',zero));assert(s.includes('|  | C |')&&s.includes('| D | E |')&&s.includes('R1C1:R2C1'));
 const rect=el('table',el('tr',cell('symbol',{rowspan:'2',colspan:'2'}),cell('A')),el('tr',cell('B')));
 const r=htmlRich(el('body',rect));assert(r.includes('| symbol |  | A |')&&r.includes('|  |  | B |')&&r.includes('R1C1:R2C2'));
});
test('extreme/wrong spans and nested tables retain bounded, ordered cell descriptions',()=>{
 const huge=el('table',el('tr',cell('First',{colspan:'1000'}),cell('Last')));
 const s=htmlRich(el('body',huge));assert(s.length<300&&s.includes('跨1000列')&&s.includes('First')&&s.includes('Last'));
 const nested=el('table',el('tr',cell('OUTER'),new Element('td',[el('table',el('tr',cell('INNER')))])));
 const n=htmlRich(el('body',nested));assert(n.includes('单元格 2')&&n.includes('| INNER |')&&n.indexOf('OUTER')<n.indexOf('INNER'));
});

