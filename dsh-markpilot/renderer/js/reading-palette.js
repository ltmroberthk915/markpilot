export const PALETTES={theme:'跟随主题',beige:'米色纸张',green:'柔和淡绿'};
import {dialogSlotFree, closeDialog} from './util.js';
export function preferredPalette(){const saved=localStorage.getItem('reading-palette');return PALETTES[saved]?saved:'theme';}
export function applyPalette(api,palette,persist=false){
  if(!PALETTES[palette])palette='theme';
  document.documentElement.dataset.readingPalette=palette;
  localStorage.setItem('reading-palette',palette);
  const button=api?.vditor.toolbar.elements['reading-palette']?.querySelector('button');
  button?.setAttribute('aria-label','阅读调色盘：'+PALETTES[palette]);
  if(persist)window.handler?.emit('palette-set',palette);
  return palette;
}
export function showPaletteSettings(){
  if(!dialogSlotFree('typora-palette'))return;
  const previous=document.activeElement,selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0).cloneRange():null;
  const dialog=document.createElement('dialog');dialog.id='typora-palette';dialog.setAttribute('aria-label','阅读调色盘');
  dialog.innerHTML='<form method="dialog"><h2>阅读调色盘</h2><p>与主题独立，调整正文、公式和代码的阅读配色。</p><div class="palette-options"></div><footer><button>关闭</button></footer></form>';
  for(const [id,name] of Object.entries(PALETTES)){
    const button=document.createElement('button');button.type='button';button.textContent=name;button.dataset.palette=id;
    button.setAttribute('aria-pressed',String(preferredPalette()===id));
    button.onclick=()=>{applyPalette(window.vditor,id,true);dialog.querySelectorAll('[data-palette]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));};
    dialog.querySelector('.palette-options').append(button);
  }
  const finish=()=>{dialog.remove();previous?.focus({preventScroll:true});if(range?.startContainer.isConnected){selection.removeAllRanges();selection.addRange(range);}};
  dialog.addEventListener('close',finish,{once:true});
  // 隐藏文档里 close 事件可能永远不派发（见 util.js 的说明），所以「关闭」按钮自己收尾
  dialog.querySelector('footer button').addEventListener('click',()=>closeDialog(dialog,finish));
  document.body.append(dialog);dialog.showModal();
}
