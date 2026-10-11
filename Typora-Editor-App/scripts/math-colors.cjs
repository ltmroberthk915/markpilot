const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output,baseline=false})=>{
  const checks=[],samples=[],failures=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
  const lum=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return v[0]*.2126+v[1]*.7152+v[2]*.0722;};
  const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
  await ev(`__open('# 配色检查\\n\\n公式 $x^2+y$\\n')`);await until('vditor?.vditor?.__typoraPatched');
  win.focus();
  await ev(`(async()=>{window.__palette=await import('/render/js/reading-palette.js');window.__themes=await import('/render/js/themes.js');return true})()`);
  for(const mode of ['ir','wysiwyg'])for(const theme of ['dark','light','konayuki-dark','konayuki-light'])for(const palette of ['theme','beige','green'])for(const kind of ['inline','block']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();__themes.applyTheme(vditor,${JSON.stringify(theme)});__palette.applyPalette(vditor,${JSON.stringify(palette)});true`);
    const source='# 数学源码与下方预览\n\n保持公式 $a+1$。\n\n'+(kind==='inline'?'编辑 $x^2+y$ 并预览。':'$$\nx^2+y\n$$')+'\n\n其他内容。\n';
    await ev(`vditor.setValue(${JSON.stringify(source)},true);true`);await until('__typoraMathStats.pending===0');await pause(120);
    await ev(`(()=>{
      const e=vditor.vditor,r=e[e.currentMode].element,c=[...r.querySelectorAll('code')].find(n=>n.textContent.replaceAll('\u200b','').trim()==='x^2+y'),owner=c.closest('.vditor-ir__node,.vditor-wysiwyg__block'),preview=owner.querySelector('.vditor-ir__preview,.vditor-wysiwyg__preview');
      window.__colorsKeep=r.querySelector('.katex');window.__colorsOriginal=vditor.getValue();preview.dispatchEvent(new MouseEvent('click',{bubbles:true}));r.focus();getSelection().collapse(c.firstChild,c.firstChild.length);c.scrollIntoView({block:'center'});
      const background=n=>{let rgb=[0,0,0],alpha=0;for(let p=n;p&&alpha<1;p=p.parentElement){const v=getComputedStyle(p).backgroundColor.match(/[\\d.]+/g).map(Number),a=v[3]??1;rgb=rgb.map((c,i)=>c+v[i]*a*(1-alpha));alpha+=a*(1-alpha);}return'rgb('+rgb.map(c=>Math.round(c+255*(1-alpha))).join(', ')+')';};
      const colors=n=>({bg:background(n),ownBg:getComputedStyle(n).backgroundColor,fg:getComputedStyle(n).color,caret:getComputedStyle(n).caretColor,height:n.getBoundingClientRect().height});
      window.__mathColorSample=()=>({source:colors(c),preview:colors(preview.querySelector('.katex')||preview),previewBox:colors(preview),dark:e.element.classList.contains('vditor--dark'),panel:getComputedStyle(c).getPropertyValue('--panel-background-color'),owner:owner.outerHTML.slice(0,1600)});return true;
    })()`);
    await pause(120);const sample=await ev('__mathColorSample()');
    Object.assign(sample,{mode,theme,palette,kind});samples.push(sample);
    const light=palette!=='theme'||theme.endsWith('light');
    const failed=sample.source.height<=0||sample.preview.height<=0||contrast(sample.source.fg,sample.source.bg)<4.5||contrast(sample.source.caret,sample.source.bg)<4.5||contrast(sample.preview.fg,sample.preview.bg)<4.5||(light&&(lum(sample.source.bg)<.6||lum(sample.preview.bg)<.6||lum(sample.previewBox.bg)<.6));
    if(failed){failures.push(sample);if(failures.length<=4)fs.writeFileSync(path.join(output,'math-colors-'+(baseline?'before':'failed')+'-'+failures.length+'.png'),(await win.webContents.capturePage()).toPNG());}
    if(!baseline&&!failed&&mode==='ir'&&kind==='inline')fs.writeFileSync(path.join(output,`math-colors-${theme}-${palette}.png`),(await win.webContents.capturePage()).toPNG());
    assert.equal(await ev('vditor.getValue()'),source);
    if(!failed)checks.push('PASS '+[mode,theme,palette,kind].join(' ')+': readable source, caret and lower preview');
  }
  fs.writeFileSync(path.join(output,'math-colors'+(baseline?'-before':'')+'.json'),JSON.stringify({checks,failures,samples},null,2));
  if(baseline)return['Captured '+samples.length+' combinations; '+failures.length+' unreadable/mismatched editing surfaces'];
  assert.equal(failures.length,0,JSON.stringify(failures.map(({owner,...s})=>s),null,2));return checks;
};
