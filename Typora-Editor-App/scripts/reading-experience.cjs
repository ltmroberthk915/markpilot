const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,ev,until,output})=>{
  const checks=[],pass=label=>checks.push('PASS '+label),delay=ms=>new Promise(r=>setTimeout(r,ms));
  const source='# 阅读配色 · 数学笔记\n\n## 动态规划与最优控制\n\n普通文字、**加粗文字**、[参考链接](https://example.org) 与公式 $V_x(x)=2x$。\n\n> 条件：价值函数连续，边界条件已给定。\n\n$$\n\\frac{\\partial V}{\\partial t}+\\min_u\\{f(x,u)+V_x g(x,u)\\}=0\n$$\n\n```python\n# Value function\ndef value(x):\n    return max(x ** 2, 1)\n```\n\n| 变量 | 含义 |\n| --- | --- |\n| x | 状态 |\n| u | 控制 |\n';
  await ev(`__open(${JSON.stringify(source)})`);await until('vditor?.vditor?.__typoraPatched');await until('__typoraMathStats.pending===0');
  await ev(`(async()=>{window.__palette=await import('/render/js/reading-palette.js');window.__themes=await import('/render/js/themes.js');return true})()`);
  const colors=[];
  const contrast=(a,b)=>{const lum=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return v[0]*.2126+v[1]*.7152+v[2]*.0722;};const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  for(const theme of ['light','dark','konayuki-light','konayuki-dark']){
    await ev(`__themes.applyTheme(vditor,${JSON.stringify(theme)});true`);await delay(250);await until('__typoraMathStats.pending===0');
    await ev(`window.__readingBefore=vditor.getValue();window.__readingNodes=[...vditor.vditor.ir.element.querySelectorAll('.language-math[data-math]')];window.__readingRendered=__typoraMathStats.rendered;true`);
    for(const palette of ['beige','green','theme']){
      await ev(`__palette.applyPalette(vditor,${JSON.stringify(palette)},true);true`);await delay(60);
      assert.equal(await ev('document.documentElement.dataset.editorTheme'),theme);
      assert.ok(await ev('vditor.getValue()===__readingBefore&&__readingNodes.every(n=>n.isConnected)&&__typoraMathStats.rendered===__readingRendered'));
      if(palette!=='theme'){
        const c=await ev(`(()=>{const root=vditor.vditor.ir.element,style=getComputedStyle(root),code=root.querySelector('.hljs');return{bg:style.backgroundColor,fg:style.color,link:getComputedStyle(root.querySelector('.vditor-ir__link')).color,line:getComputedStyle(root.querySelector('.vditor-linenumber__rows>span'),'::before').color,codeBg:getComputedStyle(code).backgroundColor,tokens:[...code.querySelectorAll('[class*="hljs-"]')].map(n=>getComputedStyle(n).color)}})()`);
        assert.ok(contrast(c.fg,c.bg)>7,JSON.stringify(c));assert.ok(contrast(c.link,c.bg)>=4.5&&contrast(c.line,c.codeBg)>=4.5,JSON.stringify(c));assert.ok(c.tokens.every(color=>contrast(color,c.codeBg)>=4.5),JSON.stringify(c));colors.push({theme,palette,...c});
        if(theme==='konayuki-dark')fs.writeFileSync(path.join(output,'reading-'+palette+'.png'),(await win.webContents.capturePage()).toPNG());
      }
    }
    pass(theme+': all palettes preserve source, formula nodes and theme; reading/code contrast remains legible');
  }
  await ev(`vditor.__typoraFind.open(false);document.querySelector('button[data-type="reading-palette"]').click();true`);
  assert.equal(await ev(`document.querySelectorAll('#typora-palette [data-palette]').length`),3);
  assert.ok(await ev(`!document.querySelector('button[data-type="reading-palette"]').textContent.trim()`));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(100);
  assert.ok(await ev(`!document.getElementById('typora-palette')&&!!document.getElementById('typora-find')`));
  await ev('vditor.__typoraFind.close();true');pass('Icon-only palette button opens choices; Escape closes its dialog before a background find panel');
  for(const mode of ['wysiwyg','sv','ir']){
    await ev(`vditor.vditor.toolbar.elements['edit-mode'].querySelector('[data-mode="${mode}"]').click();__palette.applyPalette(vditor,'beige');true`);await delay(250);
    assert.ok(await ev(`(()=>{const style=getComputedStyle(vditor.vditor[vditor.vditor.currentMode].element);return style.backgroundColor==='rgb(244, 239, 223)'&&style.color==='rgb(62, 57, 47)'})()`));
    pass(mode+': palette follows the active editing mode');
  }
  for(const width of [1180,650,420]){
    win.setContentSize(width,800);await delay(250);
    await ev('vditor.vditor.outline.toggle(vditor.vditor,false);true');await delay(100);
    const before=await ev(`(()=>{const b=document.querySelector('button[data-type="outline"]'),r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,left:r.x,top:r.y,height:vditor.vditor.toolbar.element.offsetHeight}})()`);
    const hit=()=>{for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(before.x),y:Math.round(before.y)});};
    hit();await delay(150);
    const opened=await ev(`(()=>{const b=document.querySelector('button[data-type="outline"]'),r=b.getBoundingClientRect();return{left:r.x,top:r.y,expanded:b.getAttribute('aria-expanded'),height:vditor.vditor.toolbar.element.offsetHeight,shown:vditor.vditor.outline.element.style.display,tag:vditor.vditor.toolbar.elements.outline.tagName,html:vditor.vditor.toolbar.elements.outline.outerHTML.slice(0,700)}})()`);
    assert.ok(Math.abs(opened.left-before.left)<1&&Math.abs(opened.top-before.top)<1&&opened.expanded==='true'&&opened.height===before.height,JSON.stringify({width,before,opened}));
    hit();await delay(150);assert.equal(await ev(`vditor.vditor.outline.element.style.display`),'none');
    pass(width+' px: clicking the same screen point opens and closes outline without moving or reflowing toolbar');
  }
  win.setContentSize(1180,800);await delay(100);
  await ev(`__palette.applyPalette(vditor,'green',true);vditor.destroy();__open(${JSON.stringify(source)});true`);await until('vditor?.vditor?.__typoraPatched');
  assert.equal(await ev('document.documentElement.dataset.readingPalette'),'green');pass('Recreating the editor restores the independent palette preference');
  await ev(`import('/render/js/reading-palette.js').then(m=>m.applyPalette(vditor,'theme'));true`);
  fs.writeFileSync(path.join(output,'reading-experience.json'),JSON.stringify({checks,colors},null,2));return checks;
};
