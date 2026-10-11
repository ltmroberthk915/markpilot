export const THEMES={'light':'默认浅色','dark':'默认深色','konayuki-light':'Konayuki Light','konayuki-dark':'Konayuki Dark'};
export function preferredTheme(){const saved=localStorage.getItem('editor-theme');return THEMES[saved]?saved:(localStorage.getItem('dark')==='false'?'light':'dark');}
export function applyTheme(api,theme,persist=false){
  if(!THEMES[theme])theme=preferredTheme();
  const dark=theme.endsWith('dark');
  localStorage.setItem('editor-theme',theme);localStorage.setItem('dark',String(dark));
  document.documentElement.dataset.editorTheme=theme;
  api?.vditor.toolbar.elements['theme-settings']?.querySelector('button')?.setAttribute('aria-label',`主题：${THEMES[theme]}（点击切换）`);
  if(api && api.__typoraAppliedTheme!==theme){
    api.setTheme(dark?'dark':'light',dark?'dark':'light',dark?'github-dark':'github');
    api.__typoraAppliedTheme=theme;
  }
  if(persist)window.handler?.emit('theme-set',theme);
  return theme;
}
export function showThemeSettings(){
  if(document.getElementById('typora-themes'))return;
  const previous=document.activeElement,selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0).cloneRange():null;
  const dialog=document.createElement('dialog');dialog.id='typora-themes';dialog.setAttribute('aria-label','选择主题');
  dialog.innerHTML='<form method="dialog"><h2>主题</h2><div class="theme-options"></div><footer><button>关闭</button></footer></form>';
  for(const [id,name] of Object.entries(THEMES)){
    const button=document.createElement('button');button.type='button';button.textContent=name;button.dataset.theme=id;button.setAttribute('aria-pressed',String(preferredTheme()===id));
    button.onclick=()=>{applyTheme(window.vditor,id,true);dialog.querySelectorAll('[data-theme]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));};
    dialog.querySelector('.theme-options').append(button);
  }
  dialog.addEventListener('close',()=>{dialog.remove();previous?.focus({preventScroll:true});if(range?.startContainer.isConnected){selection.removeAllRanges();selection.addRange(range);}},{once:true});
  document.body.append(dialog);dialog.showModal();
}
