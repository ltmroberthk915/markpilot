'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const project=path.resolve(__dirname,'../../../dsh-markpilot');
const read=name=>fs.readFileSync(path.join(project,'src-cm6',name),'utf8');
const load=name=>import(pathToFileURL(path.join(project,'src-cm6',name)).href);
const source=read('extras.js'),inline=read('inline-format.js');
function cut(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);assert(a>=0&&b>a);return text.slice(a,b);}
async function exportHtml(doc){
 const [md,table,inf]=await Promise.all([load('markdown-context.js'),load('tables.js'),load('inline-format.js')]);
 const helper=inline.includes('export function singleLineDisplayTex(')?new Function(cut(inline,'function singleLineDisplayTex(','const inlineParser')+';return singleLineDisplayTex;')():undefined;
 const keys=['scanFenceLines','tableLead','quoteLead','isSeparatorBody','codeBody','hasUnescapedDollar','singleLineDisplayTex','CHUNK_CHARS','MATH_TEX_MAX','inlineMd','isHrLine','esc'];
 const ctx={...md,...table,...inf,singleLineDisplayTex:helper,CHUNK_CHARS:65536,MATH_TEX_MAX:32768,
   inlineMd:s=>inf.renderInline(s,{math:t=>'<i>'+t+'</i>'}),isHrLine:s=>/^---$/.test(s),esc:s=>s.replaceAll('<','&lt;')};
 const fn=new Function(...keys,cut(source,'function* mdBodyChunks(','  function mdToHtml')+';return mdBodyChunks;')(...keys.map(k=>ctx[k]));
 return [...fn(doc)].join('');
}
test('export math cannot swallow a quote or sibling list while seeking its closing fence',async()=>{
 const doc='PRE\n\n$$\na\n\n> other\n\nOUTSIDE\n\n$$\nb\n$$',html=await exportHtml(doc);
 assert.match(html,/<blockquote>\s*<p>other<\/p>\s*<\/blockquote>/);assert.match(html,/<p>OUTSIDE<\/p>/);
 assert.deepEqual([...html.matchAll(/<pre class="mp-math">([\s\S]*?)<\/pre>/g)].map(m=>m[1].trim()),['b']);
 const orphan=await exportHtml('PRE\n\n$$');assert.match(orphan,/<p>\$\$<\/p>/);assert(!orphan.includes('<pre class="mp-math">'));
 const quoted=await exportHtml('> $$\n> p\n> $$');assert.match(quoted,/<blockquote>\s*<pre class="mp-math">\s*p<\/pre>/);
 assert(!((await exportHtml('$\\begin{cases}a\n\nSENTENCE\nx$')).includes('<pre class="mp-math">')));
});
test('same-line export preserves text between two formulas and ordinary inline code',async()=>{
 assert.match(await exportHtml('$$a$$ / $$b$$'),/<p><i>a<\/i> \/ <i>b<\/i><\/p>/);
 assert.match(await exportHtml('$$a$$'),/<pre class="mp-math">a<\/pre>/);
 assert.match(await exportHtml('`$$a$$` $x$'),/<code>\$\$a\$\$<\/code> <i>x<\/i>/);
});
