'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../../..'),tablesURL=pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/tables.js')).href;
const modules=Promise.all([import(tablesURL),import(pathToFileURL(path.join(ROOT,'dsh-markpilot/src-cm6/markdown-context.js')).href),import(pathToFileURL(path.join(ROOT,'dsh-markpilot/node_modules/@codemirror/state/dist/index.js')).href)]);
test('separator recognition preserves the established character and dash grammar',async()=>{
 const [{isSeparatorBody,SEPARATOR_BODY_RE}]=await modules;
 const old=/^\s*\|?[\s:|\-\u2013\u2014]*[\-\u2013\u2014][\s:|\-\u2013\u2014]*\|?\s*$/;
 const inputs=['','|||',' : ',':---:', ' \t| – | — |\n','\u00a0|—|\u3000','---x','x---','---/','---\\','--\u200b','\n-\n'];
 const alphabet=[' ',':','|','-','–','—','x','\t'];
 let seed=340;
 for(let i=0;i<3000;i++){let s='';for(let j=0;j<i%17;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=alphabet[seed%alphabet.length];}inputs.push(s);}
 for(const s of inputs){const expected=old.test(s);assert.equal(isSeparatorBody(s),expected,JSON.stringify(s));assert.equal(SEPARATOR_BODY_RE.test(s),expected,'exported regexp '+JSON.stringify(s));}
});
test('an ordinary invalid 8 KB separator is rejected within a bounded parser call',()=>{
 const code=`const m=await import(${JSON.stringify(tablesURL)});const bad=' '.repeat(4096)+'-'+' '.repeat(4096)+'x';if(m.isSeparatorBody(bad)||!m.isSeparatorBody(bad.slice(0,-1)))process.exit(2);console.log('normal-literal');`;
 const result=cp.spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:2000,encoding:'utf8',windowsHide:true});
 assert.equal(result.error,undefined,'parser must finish without timing out');assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'normal-literal');
});
test('table width scanning accepts 140000 rows and preserves exact column maxima',async()=>{
 const [tables,context,{Text}]=await modules,source=fs.readFileSync(path.join(ROOT,'dsh-markpilot/src-cm6/main.js'),'utf8'),ast=require('acorn').parse(source,{ecmaVersion:'latest',sourceType:'module'});
 const code=['parseTableRow','tablePrefix','scanTables'].map(name=>{const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert(n,name);return source.slice(n.start,n.end);}).join('\n');
 const scope={...tables,...context};
 const scan=Function('scope','with(scope){'+code+';return scanTables;}')(scope);
 const text=['| 名称 | b |','| --- | --- |',...Array(140000).fill('| x | y |')];text[text.length-1]='| 最大列宽文本 | longest-value |';
 const actual=scan(Text.of(text),[]);assert.equal(actual.length,1);assert.equal(actual[0].rows.length,140000);
 assert.deepEqual(actual[0].weights,[12,13]);assert.deepEqual(actual[0].widths,tables.fitWidths([12,13]));
});
