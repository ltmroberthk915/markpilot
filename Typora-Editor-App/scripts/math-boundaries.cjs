const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.runMathBoundaries=async({win,ev,until,output})=>{
  const results=[],pass=label=>results.push('PASS '+label),delay=ms=>new Promise(r=>setTimeout(r,ms));
  const formula=String.raw`\underbrace{\begin{array}{cc}a&b\\c&d\end{array}}_{n\times n}`;
  const fixture=`# Boundary check\n\n> $$${formula}$$, prose **bold** $x+1$\n> next paragraph\n`;
  await ev(`__open(${JSON.stringify(fixture)})`);await until('window.vditor?.vditor?.__typoraPatched&&__typoraMathStats.pending===0');await delay(300);
  const check=async label=>{
    const state=await ev(`(()=>{const e=vditor.vditor,r=e[e.currentMode].element;return{md:vditor.getValue(),formula:r.querySelector('code[data-type="math-block"]')?.textContent,error:r.querySelectorAll('.vditor-math-error').length}})()`);
    assert.equal(state.formula,formula);assert.equal(state.error,0);assert.ok(state.md.includes(formula)&&state.md.includes('prose **bold** $x+1$'));pass(label);
  };
  await check('Initial Markdown load keeps punctuation/prose outside display math');
  for(const mode of ['wysiwyg','sv','ir']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('button[data-mode="${mode}"]').click();true`);await delay(300);
    if(mode==='sv'){
      await ev(`vditor.setValue(${JSON.stringify(fixture)},true);true`);await delay(250);
      assert.ok(await ev(`vditor.getValue().includes(${JSON.stringify(formula)})`));pass('Source mode preserves TeX backslashes and subscripts');
    }else await check(mode+' mode conversion preserves formula and adjacent prose');
  }
  await ev(`vditor.setValue(${JSON.stringify(fixture)},true);true`);await delay(300);await check('External setValue uses the same fence compatibility');
  await ev(`(()=>{const r=vditor.vditor.ir.element;r.focus();getSelection().collapse(r,r.childNodes.length);vditor.insertMD(${JSON.stringify('\n\n> $$a+b$$，新增 $z$\n')})})()`);await delay(300);
  assert.ok(await ev(`!vditor.vditor.ir.element.querySelector('.vditor-math-error')&&vditor.getValue().includes('，新增 $z$')`));pass('Markdown insertion keeps subsequent inline formula outside display math');
  await ev(`(()=>{vditor.setValue(${JSON.stringify(fixture)},true);const r=vditor.vditor.ir.element;r.focus();const t=r.querySelector('strong').firstChild;getSelection().selectAllChildren(t);window.__mathBoundaryBefore=vditor.getValue()})()`);await delay(300);
  for(const keyCode of ['B','Z']){
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:['control']});await delay(300);
  }
  assert.ok(await ev('vditor.getValue()===__mathBoundaryBefore'));await check('Bold undo preserves exact matrix row separators and subscripts');
  const fixtureFile=process.env.MATH_BOUNDARY_FIXTURE?path.resolve(process.env.MATH_BOUNDARY_FIXTURE):path.resolve(__dirname,'../.perf/dynamic-planning/repaired.md'),target=path.join(output,'dynamic-planning/repaired.md');
  fs.mkdirSync(path.dirname(target),{recursive:true});if(fixtureFile!==target)fs.copyFileSync(fixtureFile,target);
  const repaired=fs.readFileSync(target,'utf8');
  await ev(`vditor.setValue(${JSON.stringify(repaired)},true);true`);await until('__typoraMathStats.pending===0');await delay(600);await until('__typoraMathStats.pending===0');
  const report=await ev(`(()=>{const r=vditor.vditor.ir.element;return{sourceMath:r.querySelectorAll('code[data-type="math-inline"],code[data-type="math-block"]').length,rendered:r.querySelectorAll('.vditor-ir__preview .language-math[data-math]').length,errors:[...r.querySelectorAll('.vditor-math-error')].map(n=>n.textContent.slice(0,120))}})()`);
  assert.equal(report.errors.length,0);
  // Count the delimiters in the fixture itself instead of trusting a constant: the default was
  // 2844 while this fixture had already been swapped for the 5,634-formula textbook, which made
  // the check a stale expectation failure unrelated to the renderer.
  const blockDelims=(repaired.match(/\$\$[\s\S]*?\$\$/g)||[]).length;
  const inlineDelims=(repaired.replace(/\$\$[\s\S]*?\$\$/g,'').match(/\$[^$\n]+\$/g)||[]).length;
  const declared=blockDelims+inlineDelims;
  const expected=Number(process.env.MATH_BOUNDARY_FORMULA_COUNT||declared);
  console.log('MATH-BOUNDARY measured source='+report.sourceMath+' rendered='+report.rendered+' declared='+declared+' (block='+blockDelims+' inline='+inlineDelims+') expected='+expected);
  assert.equal(report.sourceMath,expected);assert.equal(report.rendered,expected);pass('Repaired desktop textbook renders all '+expected+' formulas without error tails');
  await ev(`import('/render/js/themes.js').then(m=>m.applyTheme(vditor,'konayuki-dark'))`);
  await ev(`(()=>{const r=vditor.vditor.ir.element,node=[...r.querySelectorAll('code[data-type="math-block"]')].find(n=>n.textContent.includes('partial g_1'));if(!node)return;getSelection().removeAllRanges();r.blur();node.parentElement.parentElement.scrollIntoView({block:'start'})})()`);await delay(350);
  fs.writeFileSync(path.join(output,'dynamic-planning/matrix-fixed.png'),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output,'math-boundaries.json'),JSON.stringify({results,textbook:report},null,2));return results;
};
