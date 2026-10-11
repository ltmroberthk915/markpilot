const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({win,ev,until,output})=>{
  const results=[],pass=s=>results.push('PASS '+s),pause=ms=>new Promise(r=>setTimeout(r,ms));
  const examples=[
    ['Venn','venn-beta\nset A["数学"]\nset B["应用"]\nunion A,B["交集"]'],
    ['TreeView','treeView-beta\n    notes/\n        "数学 笔记.md"\n        chapters/\n            HJB.md'],
    ['flowchart','flowchart LR\n  A[开始] --> B{条件}\n  B -->|成立| C[结束]'],
    ['sequence','sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: OK'],
  ];
  const markdown=examples.map(([name,code])=>'## '+name+'\n\n```mermaid\n'+code+'\n```').join('\n\n')+'\n\n公式 $x^2+1$\n';
  await ev(`__open(${JSON.stringify(markdown)})`);await until('!!window.vditor?.vditor?.__typoraPatched');
  for(const mode of ['ir','wysiwyg']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();true`);await pause(250);
    await until(`vditor.vditor.${mode}.element.querySelectorAll('.language-mermaid[data-processed="true"]').length===4`,30000);
    const state=await ev(`(()=>{const root=vditor.vditor.${mode}.element;return{diagrams:[...root.querySelectorAll('.language-mermaid[data-processed="true"]')].map(n=>({svg:!!n.querySelector('svg'),error:!!n.querySelector('.error-icon,.error-text'),text:n.textContent})),md:vditor.getValue(),math:!!root.querySelector('.katex')}})()`);
    assert.equal(state.diagrams.length,4);for(let i=0;i<4;i++){assert.ok(state.diagrams[i].svg&&!state.diagrams[i].error,JSON.stringify({mode,name:examples[i][0],...state.diagrams[i]}));pass(mode+' renders '+examples[i][0]+' through the unchanged Vditor adapter');}
    for(const [,code] of examples)assert.ok(state.md.includes(code));assert.ok(state.math);pass(mode+' preserves Mermaid source and surrounding math');
  }
  for(const theme of ['light','dark']){
    await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,${JSON.stringify(theme)}))`);
    // Exercise the adapter explicitly; theme CSS changes do not replace documents.
    await ev(`(()=>{const host=document.createElement('div');host.id='diagram-fixtures';document.body.append(host);${JSON.stringify(examples)}.forEach(([,text])=>{const code=document.createElement('code');code.className='language-mermaid';code.textContent=text;host.append(code)});Vditor.mermaidRender(host,vditor.vditor.options.cdn,${JSON.stringify(theme)})})()`);
    await until(`document.querySelectorAll('#diagram-fixtures [data-processed="true"] svg').length===4`,30000);
    assert.equal(await ev(`document.querySelectorAll('#diagram-fixtures .error-icon,#diagram-fixtures .error-text').length`),0);pass(theme+' renders all four diagram types');
    await ev(`document.getElementById('diagram-fixtures').remove();true`);
  }
  // Bad syntax must not poison Mermaid's shared render queue.
  assert.ok(await ev(`mermaid.parse('venn-beta\\nunion Missing,Other').then(()=>false,()=>true)`));
  assert.ok(await ev(`mermaid.render('valid-after-error',${JSON.stringify(examples[0][1])}).then(r=>r.svg.includes('<svg'))`));pass('Invalid diagram followed by a valid Venn recovers');
  await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="ir"]').click();vditor.setValue(${JSON.stringify(markdown)},true);true`);await pause(600);
  fs.writeFileSync(path.join(output,'mermaid-11.17.png'),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'mermaid.json'),JSON.stringify(results,null,2));return results;
};
