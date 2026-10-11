const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.runShellMath=async({win,ev,until,output})=>{
  const frame='document.getElementById("editor").contentWindow',results=[];
  const math=String.raw`\underbrace{\begin{array}{cc}a&b\\c&d\end{array}}_{n\times n}`;
  const file=path.join(output,'math-boundary-host.md');
  fs.writeFileSync(file,`# Math boundary\n\n> $$${math}$$, body $x+1$\n> next\n`);
  await ev(`hostApi.invoke('open-in-window',{path:${JSON.stringify(file)}})`);
  await until(`${frame}.vditor?.vditor?.__typoraPatched&&${frame}.vditor.getValue().includes('Math boundary')&&${frame}.__typoraMathStats.pending===0`);
  assert.equal(await ev(`${frame}.vditor.vditor.ir.element.querySelector('code[data-type="math-block"]').textContent`),math);
  assert.equal(await ev(`${frame}.vditor.vditor.ir.element.querySelectorAll('.vditor-math-error').length`),0);
  results.push('PASS Actual desktop file load separates quoted math and trailing prose');
  await ev(`(()=>{const w=${frame},r=w.vditor.vditor.ir.element;w.focus();r.focus();const h=r.querySelector('h1');w.getSelection().selectAllChildren(h);w.getSelection().collapseToEnd()})()`);
  await win.webContents.insertText(' 检查');await until(`${frame}.vditor.getValue().includes('检查')`);
  // Wait for the actual input message before saving, not just the DOM change.
  for(let i=0;i<60&&!global.doc.current.text.includes('检查');i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(global.doc.current.text.includes('检查'));await global.doc.save();
  const saved=fs.readFileSync(file,'utf8');assert.ok(saved.includes(math));assert.ok(saved.includes('> $$\n>\n> , body $x+1$'));
  results.push('PASS Native desktop edit/save preserves matrix row separators, subscripts and following prose');
  return results;
};
