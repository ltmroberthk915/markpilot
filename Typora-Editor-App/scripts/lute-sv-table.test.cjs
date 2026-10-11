const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
require('../.backups/2026-09-08-release100/lute-before-sv-table.min.js');const original=global.Lute.New();
require('../../Typora-Editor/extension-src/render/cdn/vditor/dist/js/lute/lute.min.js');const lute=global.Lute.New();
for(const l of [original,lute])l.SetInlineMathAllowDigitAfterOpenMarker(true);
const text=html=>html.replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|#39|#34);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",'#34':'"'}[entity]));
const cells=['first<br />second','<br>start<br/>end<BR />','<u>下划线</u> <span style="color:red">色</span>','&amp; &lt; &gt; &#124; &nbsp; &quot;','`<br /> &amp;`','**粗 $x<y$ 后 $a>b$**',String.raw`$\begin{matrix}a&b\\c&d\end{matrix}$`,String.raw`literal \| pipe & < 3 > 1`,"中文🙂 ' quote \" end",'<span data-type="newline">literal</span>'];
for(const [i,cell]of cells.entries())test('SV table preserves literal HTML and entities '+i,()=>{
  const markdown='| A | B |\n| - | - |\n| '+cell+' | 不变 |\n';
  for(const method of ['Md2VditorSVDOM','SpinVditorSVDOM'])assert.equal(text(lute[method](markdown)).trimEnd(),markdown.trimEnd(),method);
  for(const method of ['Md2HTML','Md2VditorIRDOM','Md2VditorDOM'])assert.equal(lute[method](markdown),original[method](markdown),method+' is unchanged');
});
test('SV table escaping preserves the real note and surrounding source blocks',()=>{
  const note=fs.readFileSync(path.resolve(__dirname,'../.backups/2026-09-08-release100/user-note-resumed-1788864957504.md'),'utf8');
  const source=note+'\n\n```html\n<table><tr><td><br /></td></tr></table>\n```\n\n| A | B |\n| - | - |\n| 首格<br />第二行 | $x<y$ |\n\n**后文 $z$**\n';
  // Non-table output is unchanged. All table source tokens must remain text,
  // including the original note's existing entities, formulas and escapes.
  const fixed=lute.Md2VditorSVDOM(source),old=original.Md2VditorSVDOM(source);
  const tables=/<span data-type="table">[\s\S]*?<\/span><\/span><\/span>/g;
  assert.equal(fixed.replace(tables,'TABLE'),old.replace(tables,'TABLE'));
  assert.ok(text(fixed).includes('首格<br />第二行'));
  assert.equal(lute.Md2VditorIRDOM(source),original.Md2VditorIRDOM(source));
});
