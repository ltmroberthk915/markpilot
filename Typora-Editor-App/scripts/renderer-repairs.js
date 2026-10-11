const delay=(ms=300)=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(30);}throw new Error('Timed out '+f);}
export async function runRepairs(){
  const api=window.vditor,e=api.vditor,results=[];
  const {sourceText,selectRange}=await import('/render/js/source-text.js');
  const {applyTheme,showThemeSettings}=await import('/render/js/themes.js');
  const {configureShortcuts,DEFAULT_SHORTCUTS}=await import('/render/js/edit-shortcuts.js');configureShortcuts(DEFAULT_SHORTCUTS);
  const check=(c,label)=>{if(!c)throw new Error(label+'\n'+api.getValue().slice(0,1200));results.push('PASS '+label);};
  const root=()=>e[e.currentMode].element;
  const key=(k,shift=false)=>{const event=new KeyboardEvent('keydown',{key:k,code:'Key'+k.toUpperCase(),ctrlKey:true,shiftKey:shift,bubbles:true,cancelable:true});root().dispatchEvent(event);return event;};
  const select=(word)=>{const index=sourceText(root()),at=index.text.indexOf(word);if(at<0)throw new Error('Missing '+word);selectRange(root(),index.range(at,at+word.length));};
  const load=async md=>{api.setValue(md,true);await delay();api.clearStack();};
  const history=async(before,after,label)=>{e.undo.undo(e);await delay();check(api.getValue()===before,label+' one undo');e.undo.redo(e);await delay();check(api.getValue()===after,label+' one redo');};
  await load('**加粗 bold** ordinary $x+1$\n\n'+Array.from({length:120},(_,i)=>`段落 ${i} $x_${i}+1$`).join('\n\n')+'\n');
  await until(()=>window.__typoraMathStats.pending===0);
  const before=api.getValue();select('加粗 bold');root().dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await delay(100);key('b');await delay();
  check(!root().querySelector('strong'),'Ctrl+B removes selected bold');
  const after=api.getValue(),nodes=[...root().querySelectorAll('.language-math[data-math]')],rendered=__typoraMathStats.rendered;
  key('z');
  check(api.getValue()===before && nodes.every(n=>n.isConnected),'undo preserves every unchanged formula immediately');
  await delay();check(__typoraMathStats.rendered===rendered,'undo does not render unchanged formulas again');
  check(getComputedStyle(root().querySelector('strong')).fontWeight==='900','bold has a visible 900 weight');
  key('z',true);await delay();check(api.getValue()===after && nodes.every(n=>n.isConnected),'redo retains formula DOM and source');
  await load('**left *middle* $x+1$ right**\n');await until(()=>__typoraMathStats.pending===0);
  root().focus();getSelection().collapse(root().querySelector('strong').firstChild,2);key('b');await delay();
  check(api.getValue().trim()==='left *middle* $x+1$ right','Ctrl+B preserves nested emphasis and formula source when unbolding');

  for(const mode of ['ir','wysiwyg','sv']){
    e.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${mode}"]`).click();
    await load('alpha beta\n');let before=api.getValue();select('alpha');check(key('u').defaultPrevented,mode+' Ctrl+U intercepted');await delay();
    const underlined=api.getValue();check(underlined.trim()==='<u>alpha</u> beta',mode+' underline keeps paragraph and outside text');
    if(mode!=='sv')check(CSS.highlights.get('typora-underline').size>0,mode+' underline display highlight exists');
    await history(before,underlined,mode+' underline');select('alpha');key('u');await delay();check(!api.getValue().includes('<u>')&&api.getValue().includes('alpha beta'),mode+' Ctrl+U toggles off');
    await load('Alpha alpha ALPHA\n\nmath $alpha+1$\n\n`alpha`\n\n中文 alpha\n');
    before=api.getValue();root().focus();getSelection().collapse(root(),0);check(key('h').defaultPrevented,mode+' Ctrl+H opens replace');
    const find=api.__typoraFind,panel=document.getElementById('typora-find'),replacement=panel.querySelector('[data-field=replace]'),sensitive=panel.querySelector('[data-field=case]');
    let q=panel.querySelector('[data-field=query]');
    q.value='alpha';find.search();await until(()=>!find.state.pending);check(find.state.count===6,mode+' case-insensitive search includes code and formula source');
    sensitive.checked=true;find.search();await until(()=>!find.state.pending);check(find.state.count===4,mode+' case matching');
    replacement.value='OMEGA';find.replace(false);await until(()=>!find.state.pending);await delay();check(api.getValue().includes('Alpha OMEGA ALPHA'),mode+' replace current occurrence');
    find.replace(true);await until(()=>!find.state.pending);await delay();let after=api.getValue();check(!/\balpha\b/.test(after)&&after.includes('$OMEGA+1$')&&after.includes('`OMEGA`'),mode+' replace all keeps math and code syntax');
    find.close();e.undo.undo(e);await delay();check(api.getValue().includes('Alpha OMEGA ALPHA')&&api.getValue().includes('$alpha+1$'),mode+' replace all undoes in one step');
    e.undo.undo(e);await delay();check(api.getValue()===before,mode+' previous single replacement undo');
    root().focus();key('h');q=document.getElementById('typora-find').querySelector('[data-field=query]');
    q.value='中文';find.search();await until(()=>!find.state.pending);check(find.state.count===1,mode+' Chinese search');find.close();
  }
  e.toolbar.elements['edit-mode'].querySelector('button[data-mode="ir"]').click();
  await load('[toc]\n\n# 标题 $x+1$\n\n正文 target\n');await until(()=>__typoraMathStats.pending===0);
  if(root().querySelector('[data-type="toc-block"]')){
    select('target');document.execCommand('insertText',false,'changed');await delay();
    const toc=root().querySelector('[data-type="toc-block"]'),tocMath=toc?.querySelector('.language-math');
    e.undo.undo(e);await delay();check(toc.isConnected&&(!tocMath||tocMath.isConnected),'document TOC retains generated formula nodes across undo '+JSON.stringify({toc:toc.isConnected,math:tocMath?.isConnected,reuse:e.__typoraRenderReuse}));
  }
  api.__typoraFind.open(true);document.querySelector('#typora-find [data-field=query]').value='标题';api.__typoraFind.search();await until(()=>!api.__typoraFind.state.pending);
  check(api.__typoraFind.state.count===1,'search excludes duplicate generated TOC labels');api.__typoraFind.close();
  await load('# Konayuki 主题\n\n普通文字与 **加粗文字**，<u>下划线文字</u>。\n\n> 引用：阅读与书写\n\n公式 $a^2+b^2=c^2$\n\n```js\nconst snow = "粉雪";\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 查找替换 | 可用 |\n');
  await until(()=>__typoraMathStats.pending===0);const formula=root().querySelector('.language-math');
  for(const theme of ['konayuki-light','konayuki-dark','light','dark']){
    applyTheme(api,theme);await delay();check(document.documentElement.dataset.editorTheme===theme&&formula.isConnected,theme+' switches without replacing formulas');
    check(getComputedStyle(root().querySelector('strong')).fontWeight==='900',theme+' keeps bold distinct');
  }
  applyTheme(api,'konayuki-dark');showThemeSettings();check(document.querySelectorAll('#typora-themes [data-theme]').length===6,'theme chooser has six choices');document.getElementById('typora-themes').close();
  return results;
}
