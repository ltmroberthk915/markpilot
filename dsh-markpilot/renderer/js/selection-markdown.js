import {PREVIEWS} from './source-text.js';
/** Serialize an inline selection with sentinels so Lute retains edge spaces. */
export function inlineMarkdown(editor,range){
  if(editor.currentMode==='sv')return range.toString();
  const container=document.createElement('p');container.setAttribute('data-block','0');container.append(range.cloneContents());
  container.querySelectorAll(PREVIEWS).forEach(n=>n.remove());
  const id='TYPORA'+crypto.randomUUID().replaceAll('-',''),left=id+'BEGIN',right=id+'END';
  container.prepend(document.createTextNode(left));container.append(document.createTextNode(right));
  const md=editor.lute[editor.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md'](container.outerHTML);
  const a=md.indexOf(left),b=md.indexOf(right);
  return a>=0&&b>=a ? md.slice(a+left.length,b) : range.toString();
}
