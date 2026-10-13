'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../..'),requireEngine=createRequire(path.join(root,'dsh-markpilot/package.json'));
const common=requireEngine('@lezer/common'),{Tree,NodeProp}=common;
const {markdownLanguage,markdown}=requireEngine('@codemirror/lang-markdown');
const {Language,StreamLanguage}=requireEngine('@codemirror/language');
const modules=import(pathToFileURL(path.join(root,'dsh-markpilot/src-cm6/worker-tree-codec.js')).href);

test('raw wire roundtrip preserves buffers/properties and rejects incompatible or malformed packets',async()=>{
 const {createRawTreeCodec}=await modules,codec=createRawTreeCodec(common),parser=markdownLanguage.parser;
 const text='> quote\n\n'+'paragraph *em*\n\n'.repeat(80),raw=parser.parse(text),wire=codec.encode(raw,parser.nodeSet);
 assert.deepEqual(codec.encode(codec.decode(structuredClone(wire),parser.nodeSet),parser.nodeSet),wire);
 const looked=new Tree(raw.type,raw.children,raw.positions,raw.length,[[NodeProp.lookAhead,42]]);
 assert.equal(codec.decode(codec.encode(looked,parser.nodeSet),parser.nodeSet).prop(NodeProp.lookAhead),42);
 const changed=structuredClone(wire);changed.types[1][1]='Incompatible';assert.throws(()=>codec.decode(changed,parser.nodeSet),/manifest/);
 assert.throws(()=>codec.decode({...wire,schema:'unknown'},parser.nodeSet),/schema/);
 assert.throws(()=>codec.decode({...wire,root:{k:'t',i:0,l:0,c:[wire.root],p:[1],v:[]}},parser.nodeSet),/exceeds/);
});

test('fresh ready trees preserve nested-language positions without mutating a prior mixed tree',async()=>{
 const {createRawTreeCodec,createReadyPartial}=await modules,codec=createRawTreeCodec(common),parser=markdownLanguage.parser;
 const js=StreamLanguage.define(requireEngine('@codemirror/legacy-modes/mode/javascript').javascript);
 const text='😀\n\n```js\nconst answer = 42;\n```\n',wire=codec.encode(parser.parse(text),parser.nodeSet);
 const base=new Language(markdownLanguage.data,parser.configure({wrap:(_inner,input)=>createReadyPartial({wire,nodeSet:parser.nodeSet,codec,inputLength:input.length})}),[],markdownLanguage.name);
 const actual=markdown({base,codeLanguages:()=>js}).language.parser;
 const reference=markdown({base:markdownLanguage,codeLanguages:()=>js}).language.parser;
 const signature=tree=>Array.from({length:text.length+1},(_,pos)=>{const nodes=[];for(let n=tree.resolveInner(pos,1);n;n=n.parent)nodes.push([n.name,n.from,n.to]);return nodes;});
 const first=actual.parse(text),before=signature(first);assert.deepEqual(before,signature(reference.parse(text)));assert.notEqual(first.resolveInner(text.indexOf('answer')+1,1).name,'CodeText','the fixture must really mount JavaScript');
 assert.throws(()=>codec.encode(first,parser.nodeSet),/per-node/);
 const second=actual.parse(text);assert.notEqual(first,second);assert.deepEqual(signature(first),before);assert.deepEqual(signature(second),before);
 const partial=createReadyPartial({wire,nodeSet:parser.nodeSet,codec,inputLength:text.length});partial.stopAt(8);partial.stopAt(5);assert.throws(()=>partial.stopAt(6),/forward/);assert.equal(partial.advance().length,text.length);assert.equal(partial.parsedPos,text.length);
});

test('actual Worker callbacks isolate retired instances in readable/minified code, with a discriminating negative control',async t=>{
 const esbuild=requireEngine('esbuild'),file=path.join(root,'dsh-markpilot/src-cm6/async-markdown.js'),source=fs.readFileSync(file,'utf8');
 assert.equal(source.split('!this.closed && this.worker === worker').length-1,2);assert.equal(source.split('this.closed || this.worker !== worker').length-1,1);
 const negative=source.replaceAll('!this.closed && this.worker === worker','!this.closed').replace('this.closed || this.worker !== worker','this.closed');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markpilot-worker-unit-'));
 Object.defineProperty(globalThis,'navigator',{value:{platform:'Win32',userAgent:'Node callback test'},configurable:true});
 try{for(const minify of [false,true])for(const identityRemoved of [false,true])await t.test((minify?'minified':'readable')+' '+(identityRemoved?'identity removed':'identity preserved'),async()=>{
  const outfile=path.join(dir,`worker-${minify}-${identityRemoved}.cjs`);
  await esbuild.build({entryPoints:[path.join(__dirname,'fixtures/worker-isolation.mjs')],bundle:true,platform:'node',format:'cjs',minify,outfile,logLevel:'error',nodePaths:[path.join(root,'dsh-markpilot/node_modules')],plugins:[{name:'owned-in-memory-control',setup(build){build.onLoad({filter:/src-cm6[\\/]async-markdown\.js$/},()=>({contents:identityRemoved?negative:source,loader:'js',resolveDir:path.dirname(file)}));}}]});
  const result=await require(outfile).runTests({identityRemoved,minify});assert.equal(result.total,10);assert.equal(result.passed,10,JSON.stringify(result.cases.filter(c=>!c.pass)));
 });}finally{const actual=fs.realpathSync(dir);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('markpilot-worker-unit-'));fs.rmSync(actual,{recursive:true,force:true});}
});
