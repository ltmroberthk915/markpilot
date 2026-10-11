const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({win,output,application})=>{
  const fe=async code=>{const r=await win.webContents.executeJavaScript(`(async()=>{const w=document.getElementById('editor').contentWindow;try{return{value:await w.eval(${JSON.stringify(code)})}}catch(e){return{error:e.stack}}})()`,true);if(r.error)throw Error(r.error);return r.value;};
  const source='# 选区测试\n\n前文 **加粗中文🙂** 普通 &amp; 文本 $x+1$ 后文。\n\n重复段落\n\n重复段落\n\n| A | B | C |\n|---|---|---|\n| 一 | 重复项 | $\\frac{a}{b}$ |\n| 二 | 重复项 | a\\|b |\n\n> 引用 **选中文字**\n> 第二行引用\n\n- 一级列表\n  - 二级选区\n\n```js\nconst foo = 12;\nconst bar = 34;\n```\n\n结尾段落\n';
  const rich='链接 [链接选区](#target)，*斜体选区*，~~删除选区~~，<u>下划线选区</u>，格式后正文。\n';
  const cases=[],tests=[
    {name:'bold',needle:'加粗中文🙂'},
    {name:'emoji',needle:'🙂'},
    {name:'second-paragraph',needle:'重复段落',occurrence:1},
    {name:'second-cell',needle:'重复项',occurrence:1},
    {name:'quote',needle:'选中文字'},
    {name:'nested-list',needle:'二级选区'},
    {name:'code',needle:'foo = 12'},
    {name:'math-source',needle:'x+1',math:true},
    {name:'table-math-source',needle:'\\frac{a}{b}',math:true},
    {name:'cross-paragraph',needle:'重复段落',endNeedle:'重复段落',endOccurrence:1},
    {name:'cross-cells',needle:'重复项',endNeedle:'重复项',endOccurrence:1},
    {name:'end',needle:'结尾段落'},
    {name:'link',needle:'链接选区'},
    {name:'italic',needle:'斜体选区'},
    {name:'strike',needle:'删除选区'},
    {name:'underline',needle:'下划线选区'},
    {name:'after-underline',needle:'格式后正文'},
  ];
  for(const mode of ['ir','wysiwyg','sv'])for(const eol of ['LF','CRLF']){
    const raw=eol==='CRLF'?(source+'\n'+rich).replaceAll('\n','\r\n'):source+'\n'+rich;
    await fe(`(async()=>{const e=vditor.vditor;e.toolbar.elements['edit-mode'].querySelector('button[data-mode="${mode==='sv'?'ir':mode}"]').click();vditor.setValue(${JSON.stringify(raw)},true);await new Promise(r=>setTimeout(r,200));if(${JSON.stringify(mode)}==='sv'){e.toolbar.elements['edit-mode'].querySelector('button[data-mode="sv"]').click();await new Promise(r=>setTimeout(r,200));}window.__selectSource=(await import(new URL('./js/split-navigation.js',document.querySelector('script[type="module"][src*="index.js"]').src).href)).selectedMarkdownRange;return true})()`);
    for(const test of tests){
      const value=await fe(`(()=>{const t=${JSON.stringify(test)},e=vditor.vditor,root=e[e.currentMode].element;
        const find=(needle,occurrence=0)=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n,count=0;while(n=w.nextNode()){if(n.parentElement.closest('.vditor-ir__preview,.vditor-wysiwyg__preview'))continue;for(let at=n.data.indexOf(needle);at>=0;at=n.data.indexOf(needle,at+needle.length))if(count++===occurrence)return[n,at];}throw Error('Missing '+needle)};
        const a=find(t.needle,t.occurrence),b=t.endNeedle?find(t.endNeedle,t.endOccurrence):a,r=document.createRange();r.setStart(a[0],a[1]);r.setEnd(b[0],b[1]+(t.endNeedle||t.needle).length);
        const before=vditor.getValue(),mapped=__selectSource(vditor,r,${JSON.stringify(raw)});return{mapped,before,after:vditor.getValue(),html:a[0].parentElement.closest('p,td,th,pre')?.outerHTML};})()`);
      const occurrence=(needle,n=0)=>{let at=-1;do{at=raw.indexOf(needle,at+1);}while(n-->0);return at;};
      const expected={start:occurrence(test.needle,test.occurrence),end:occurrence(test.endNeedle||test.needle,test.endNeedle?test.endOccurrence:test.occurrence)+(test.endNeedle||test.needle).length};
      if(JSON.stringify(value.mapped)!==JSON.stringify(expected))fs.writeFileSync(path.join(output,'mapping-failure.json'),JSON.stringify({mode,eol,test,value,expected,raw},null,2));
      assert.deepEqual(value.mapped,expected,mode+' '+eol+' '+test.name);assert.equal(value.before,value.after);
      cases.push({name:[mode,eol,test.name].join('-'),status:'PASS'});
    }
    if(mode!=='sv'){
      for(const [name,selector,expectedText] of [['element-paragraph','p','前文 **加粗中文🙂** 普通 &amp; 文本 $x+1$ 后文。'],['element-cell','tbody tr:nth-child(2) td:nth-child(2)','重复项']]){
        const result=await fe(`(()=>{const r=document.createRange();r.selectNodeContents(vditor.vditor[${JSON.stringify(mode)}].element.querySelector(${JSON.stringify(selector)}));return __selectSource(vditor,r,${JSON.stringify(raw)})})()`);
        assert.equal(raw.slice(result?.start,result?.end),expectedText,mode+' '+eol+' '+name);cases.push({name:[mode,eol,name].join('-'),status:'PASS'});
      }
    }
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({application,cases,failed:0},null,2));console.log('PASS '+cases.length+' source selection mappings; original Markdown unchanged');
};
