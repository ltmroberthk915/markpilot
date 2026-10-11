/** v2.0.7 内容缩放（编辑区文字/图片整体缩放，工具栏不动）。
 * 背景：Electron 菜单 zoomIn role 的加速键是 Ctrl+Plus（要按 Shift），Windows
 * 上按 Ctrl+= 永远不触发——用户报告"只有减号能缩、加号恢复不了，只能 Ctrl+0"。
 * 本模块统一接管：Ctrl+滚轮、桌面版 Ctrl+= / Ctrl+- / Ctrl+0、右下角比例徽章
 * （下拉预设 + 自由输入，可精确校准回 100%）。VSIX 里 Ctrl+= 归 VS Code 全局
 * 缩放，不拦截；滚轮与徽章照常。
 */
const SELECTOR='.vditor-content';
const STORAGE_KEY='typora-content-zoom';
const MIN=30,MAX=500,STEP=5;
const PRESETS=[50,70,80,90,100,110,125,150,175,200];
let state=100;
let badge=null,popup=null,input=null;
const clamp=value=>Math.max(MIN,Math.min(MAX,Math.round(value)));
function apply(next){
  state=clamp(next);
  for(const element of document.querySelectorAll(SELECTOR))element.style.zoom=state+'%';
  try{localStorage.setItem(STORAGE_KEY,String(state));}catch{/* private mode */}
  if(badge)badge.textContent=state+'%';
  if(popup){
    for(const button of popup.querySelectorAll('[data-preset]'))button.classList.toggle('is-active',Number(button.dataset.preset)===state);
    if(input&&document.activeElement!==input)input.value=String(state);
  }
  return state;
}
function build(){
  badge=document.createElement('button');
  badge.type='button';badge.className='typora-zoom-badge';badge.textContent='100%';
  badge.title='内容缩放（Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0）';
  badge.addEventListener('mousedown',event=>event.preventDefault());
  badge.addEventListener('click',event=>{event.preventDefault();togglePopup();});
  popup=document.createElement('div');
  popup.className='typora-zoom-pop';popup.hidden=true;popup.setAttribute('role','dialog');popup.setAttribute('aria-label','内容缩放');
  const title=document.createElement('div');title.className='typora-zoom-pop__title';title.textContent='内容缩放';popup.append(title);
  const grid=document.createElement('div');grid.className='typora-zoom-pop__grid';
  for(const preset of PRESETS){
    const button=document.createElement('button');button.type='button';button.className='typora-zoom-pop__preset';button.dataset.preset=String(preset);button.textContent=preset+'%';
    button.addEventListener('click',()=>{apply(preset);input.value=String(preset);});
    grid.append(button);
  }
  popup.append(grid);
  const row=document.createElement('div');row.className='typora-zoom-pop__row';
  const label=document.createElement('label');label.textContent='自定义';
  input=document.createElement('input');input.type='number';input.min=String(MIN);input.max=String(MAX);input.step='1';input.value='100';input.setAttribute('aria-label','缩放百分比');
  const unit=document.createElement('span');unit.textContent='%';
  const ok=document.createElement('button');ok.type='button';ok.textContent='应用';
  const applyInput=()=>{
    const value=Number(input.value);
    if(!Number.isFinite(value)||value<MIN||value>MAX){input.classList.add('typora-zoom-pop__invalid');input.focus();return;}
    input.classList.remove('typora-zoom-pop__invalid');apply(value);
  };
  ok.addEventListener('click',applyInput);
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyInput();}});
  input.addEventListener('input',()=>input.classList.remove('typora-zoom-pop__invalid'));
  row.append(label,input,unit,ok);popup.append(row);
  const reset=document.createElement('button');reset.type='button';reset.className='typora-zoom-pop__reset';reset.textContent='重置为 100%（Ctrl+0）';
  reset.addEventListener('click',()=>apply(100));
  popup.append(reset);
  document.addEventListener('mousedown',event=>{
    if(popup.hidden)return;
    if(!popup.contains(event.target)&&!badge.contains(event.target))popup.hidden=true;
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!popup.hidden){popup.hidden=true;event.stopPropagation();}
  },true);
  document.body.append(badge,popup);
}
function togglePopup(){if(!popup)return;popup.hidden=!popup.hidden;if(!popup.hidden){apply(state);input.value=String(state);input.select();}}
export function installContentZoom(){
  if(badge)return;
  build();
  let saved=Number.NaN;
  try{saved=Number(localStorage.getItem(STORAGE_KEY));}catch{/* private mode */}
  apply(Number.isFinite(saved)&&saved>=MIN&&saved<=MAX?saved:100);
  document.addEventListener('wheel',event=>{
    if(!event.ctrlKey&&!event.metaKey)return;
    if(!event.target.closest?.(SELECTOR))return;
    event.preventDefault();
    apply(state+(event.deltaY<0?STEP:-STEP));
  },{passive:false,capture:true});
  // 桌面版键盘接管（VSIX 中这些组合键属于 VS Code 自身的界面缩放；
  // 宿主标志由 vscode.js 写入 window.__vscodeHost）。
  if(!window.__vscodeHost){
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing||!event.ctrlKey||event.altKey||event.metaKey)return;
      const zoomIn=event.key==='+'||event.key==='='||event.code==='NumpadAdd';
      const zoomOut=event.key==='-'||event.key==='_'||event.code==='NumpadSubtract';
      const reset=event.key==='0'||event.code==='Numpad0';
      if(!zoomIn&&!zoomOut&&!reset)return;
      // 输入框里的 Ctrl+= 等留给表单/无障碍行为，不劫持。
      if(event.target.closest?.('input,textarea,[contenteditable="true"]')&&!event.target.closest('.vditor-reset'))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(reset)apply(100);
      else if(zoomIn)apply(state+STEP);
      else apply(state-STEP);
    },true);
  }
  window.handler?.on?.('zoom',payload=>{
    if(!payload)return;
    if(Number.isFinite(Number(payload.set)))apply(Number(payload.set));
    else if(Number.isFinite(Number(payload.delta)))apply(state+Number(payload.delta));
    else if(payload.open&&popup?.hidden)togglePopup();
  });
}
export const contentZoom={get:()=>state,set:apply};
