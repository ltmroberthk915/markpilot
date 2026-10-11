const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Both references include the independently tested SV escaping correction;
// this comparison isolates the autolink optimization across all four renderers.
const referenceFile=path.resolve(__dirname,'../.backups/2026-09-08-release100/lute-before-autolink.min.js');
const referenceModule=new(require('node:module'))(referenceFile);
referenceModule._compile(require('./patch-lute-sv-table.cjs').patchSource(fs.readFileSync(referenceFile,'utf8')),referenceFile);const Original=global.Lute;
require('../../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');const Patched=global.Lute;
const original=Original.New(),patched=Patched.New();
for(const lute of [original,patched])lute.SetInlineMathAllowDigitAfterOpenMarker(true);
const methods=['Md2HTML','Md2VditorIRDOM','Md2VditorDOM','Md2VditorSVDOM'];
const compare=(source,label)=>{for(const method of methods)assert.equal(patched[method](source),original[method](source),label+' '+method);};
test('Native output stays byte-identical for protocol, www, email and punctuation boundaries',()=>{
  const urls=['a://b','scheme://target','123://45','HTTP://example.com','http://example.com','https://example.com/path?q=2#anchor','ftp://example.com:21/path','www.example.com','a.b+tag@example.com','mailto:a@example.com','foo-bar://x','foo_bar://x','myhttp://example.com','myhttps://x','myftp://x','://','a://','a://b://c','a://b https://x.com','https://x.com a://b','w','www','www.','WWW.example.com','a://b?','a://b(c))','www.example.com/path?a=1&amp;','http://x.com:','www.example.com，中文'];
  for(const [i,url]of urls.entries())for(const prefix of ['','前缀 ','abc','abc_','abc-','x: ','/','😀'])compare(prefix+url+' 后缀\n','url '+i+'/'+prefix);
});
test('Seeded mixtures preserve all four renderers without disabling links',()=>{
  const parts=['alpha','Z12',' ',':','/', '://','http://a.com','https://b.org','ftp://c.net','www.d.com','user@e.org','中文','🙂','_','-','*','(',')','\n','<br>','&amp;'];
  let seed=99173;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<256;i++){let source='';for(let j=0;j<18;j++)source+=parts[random()%parts.length];compare(source+'\n','seed '+i);}
});
test('Links inside tables, math neighbors and formatting remain identical',()=>{
  const sources=['**粗体 http://example.com 与 $x+1$**\n','| A | B |\n| --- | --- |\n| www.example.com | $\\frac{x}{y}$ |\n','> - a://b 与 user@example.com\n','`www.example.com` and <https://example.org>\n','[ref][id]\n\n[id]: https://example.org\n','<div>www.example.com</div>\n'];
  for(const source of sources)compare(source,source.slice(0,50));
  for(const file of ['.backups/2026-09-08-release100/user-note-resumed-1788864957504.md','.backups/2026-09-08-math-table/user-note-original.md'])compare(fs.readFileSync(path.resolve(__dirname,'..',file),'utf8'),file);
});
test('Long prefixes preserve standard and custom link behavior at original slice offsets',()=>{
  for(const link of ['www.example.com','https://example.com','abc://target','user@example.com'])compare('a'.repeat(4096)+' '+link+'\n',link);
});
test('900k plain text, native SV spin and following linked document remain exact',()=>{
  const text='a'.repeat(900000)+'\n',sv=patched.Md2VditorSVDOM(text);
  const reference=Original.New();reference.SetGFMAutoLink(false);
  assert.equal(sv,reference.Md2VditorSVDOM(text));assert.equal(patched.SpinVditorSVDOM(sv),reference.SpinVditorSVDOM(sv));
  compare('https://example.org and www.example.com and user@example.com\n','following linked document');
  const html=patched.Md2HTML('https://example.org\n');assert.ok(html.includes('<a href="https://example.org"'));
});
