import {sourceText,selectRange,PREVIEWS} from './source-text.js';
import {cloneSource} from './incremental-ir.js';
import {selectionPlainText} from './media-tools.js';
import {scrollIntoViewSafe} from './large-doc.js';

// Blob workers work in both the desktop iframe and VSCode's isolated Webview.
function searchWorker() {
  self.onmessage=({data:{id,text,query,matchCase}})=>{
    const started=performance.now(), offsets=[];
    if(query){
      const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const pattern=new RegExp(escaped,matchCase?'gu':'giu');
      for(const match of text.matchAll(pattern))offsets.push(match.index,match.index+match[0].length);
    }
    const hits=new Int32Array(offsets);
    self.postMessage({id,hits,ms:performance.now()-started},[hits.buffer]);
  };
}
export function installFindReplace(api,flushIR) {
  const e=api.vditor;
  let panel=null,worker=null,blob=null,query,replace,matchCase,count,status;
  let index=null,hits=new Int32Array(),active=-1,request=0,timer=0,pending=false,replacing=false,running=false;
  const root=()=>e[e.currentMode].element;
  const all=new Highlight(),current=new Highlight();
  const controls=()=>{if(!panel)return;panel.querySelectorAll('[data-action]').forEach(b=>{if(b.dataset.action!=='close')b.disabled=pending||!hits.length;});};
  const paint=()=>{
    all.clear();current.clear();if(!panel)return;
    // Keep paint cost bounded, even when one character occurs 100,000 times.
    const start=Math.max(0,active-400),end=Math.min(hits.length/2,start+800);
    for(let i=start;i<end;i++)all.add(index.range(hits[i*2],hits[i*2+1]));
    if(active>=0)current.add(index.range(hits[active*2],hits[active*2+1]));
    count.textContent=pending?'查找中…':(hits.length?`${active+1} / ${hits.length/2}`:'0 / 0');controls();
  };
  const search=()=>{
    clearTimeout(timer);if(!panel)return;
    index=sourceText(root());hits=new Int32Array();active=-1;pending=true;paint();
    worker.postMessage({id:++request,text:index.text,query:query.value,matchCase:matchCase.checked});
  };
  const schedule=()=>{if(panel){request++;pending=true;controls();clearTimeout(timer);timer=setTimeout(search,120);}};
  // 【R7 数据损坏级】reveal 的口径分支——焦点在面板=不落选区；焦点在编辑面=保留落选区。
  // 旧实现无条件把文档选区放上命中：选区落进可编辑面时 Chromium 会把**焦点**一起拽
  // 过去（实测 activeElement 从面板输入框变成编辑面 PRE），面板里再按 Enter 就落进
  // 编辑器，把选中的命中文字删成换行、随存盘写进文件（病例 125④⑤：打字后 200ms
  // 焦点翻转，Enter 后 md 与磁盘都变成 删"命中词" 增"\n\n\n"）。修复后面板发起的
  // 搜索/导航一律不动 DOM 选区：滚动照旧、展开折叠公式照旧（REVEAL 类）——焦点在
  // 输入框时 Chromium 的文档选区为空（input 聚焦即清空），math-edit 的 enforce 收回
  // 与 refreshMathEditing 都不会被选区事件唤起，展开得以保持；当前命中的视觉指示由
  // 查找层自己的高亮承担（CSS Highlight 的 typora-find-current，paint() 已有）。
  // 编辑面上的 F3 导航保留 R4 的落选区口径：焦点本来就在编辑面，不存在夺焦；选区
  // 落到命中也是 Typora 的手感，且公式展开靠"光标真在源码里"成为 math-edit 认可的
  // 合法状态（FR3：纯加类会被 enforce 观察者在光标停于编辑面它处时收回，选区落进
  // 源码后才能一直保持）。
  const reveal=()=>{
    if(active<0||pending)return;
    const range=index.range(hits[active*2],hits[active*2+1]);
    const node=range.startContainer.parentElement;
    for(let n=node;n&&n!==root();n=n.parentElement)if(n.classList.contains('vditor-ir__node'))n.classList.add('vditor-ir__node--expand');
    if(root().contains(document.activeElement)){
      try{const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}catch{}
    }
    node && scrollIntoViewSafe(node,{block:'center',inline:'nearest'});paint();
  };
  const navigate=step=>{if(!pending&&hits.length){active=(active+step+hits.length/2)%(hits.length/2);reveal();}};
  // 【P5】单处替换的增量通道：命中范围被限制在同一个顶层块、且端点都落在可
  // 编辑的源文本层（不在渲染预览里）时，直接在活动 DOM 上完成这次替换——
  // flushIR 已把之前的编辑入栈，改完显式 addToUndoStack 把这一步入栈；
  // incremental-ir 因此只需重转被改的那一块，其余分组的缓存原样存活。
  // 替换产物与旧路径（克隆全文→整篇转换→setValue 全文重析）逐字节一致：两条
  // 路径都把替换文本作为 DOM 文本交给 VditorIRDOM2Md。有意不走
  // execCommand('insertText')：那会进 Vditor 输入管线把替换文本里的 markdown
  // 语法当场渲染，语义反而偏离旧路径（旧路径替换的是源文本字面量，语法保持
  // 字面）。跨块/预览内/非 IR 模式的命中一律回退全量管线。
  const topBlockOf=node=>{for(let n=node;n&&n!==root();n=n.parentElement)if(n.parentElement===root())return n;return null;};
  const replaceInPlace=()=>{
    const range=index.range(hits[active*2],hits[active*2+1]);
    const at=node=>node?(node.nodeType===3?node.parentElement:node):null;
    const start=at(range.startContainer),end=at(range.endContainer);
    const block=topBlockOf(range.startContainer);
    if(!block||topBlockOf(range.endContainer)!==block)return false;
    // 【FR1】命中所在的块只要含公式（源码 code 或渲染出的 .language-math），增量通道
    // 直接放弃：replaceInPlace 只改源文本层，不会触发 KaTeX 重排，结果就是源码已换、
    // 预览还停在旧公式上（getValue 与所见不一致）。保守回退全量管线（克隆→整篇转换→
    // setValue），代价是重转一块的缓存，换来预览与 getValue 永远一致。
    if(block.querySelector('code[data-type^="math"],.language-math'))return false;
    if(start?.closest?.(PREVIEWS)||end?.closest?.(PREVIEWS))return false;
    const scroll=root().scrollTop;
    range.deleteContents();
    const text=document.createTextNode(replace.value);
    range.insertNode(text);
    const caret=document.createRange();caret.setStart(text,0);caret.collapse(true);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(caret);
    root().scrollTop=scroll;
    clearTimeout(e.ir.processTimeoutId);
    e.undo.addToUndoStack(e);
    return true;
  };
  const apply=async allMatches=>{
    if(pending||active<0||running)return;
    // Revalidate the editable source before using worker offsets. Rendering
    // mutations do not invalidate results; actual edits always do.
    if(sourceText(root()).text!==index.text){search();return;}
    if(e.currentMode==='ir')flushIR();else e.undo.addToUndoStack(e);
    const selected=allMatches?Array.from({length:hits.length/2},(_,i)=>i):[active];
    const position=hits[active*2],amount=selected.length;
    if(!allMatches&&e.currentMode==='ir'&&replaceInPlace()){
      e.options.input?.(api.getValue());
      status.textContent=`已替换 ${amount} 处`;
      // 【FR6】单处替换后焦点留在替换框：连按 Enter 就是连续替换下一处
      // （焦点跳去查找框的话，第二下 Enter 会变成"下一处"导航）。【R7】重搜的
      // reveal 面板分支不落选区，焦点根本不会被拽走，无需事后还焦。
      replace.focus({preventScroll:true});search();
      return;
    }
    // 【P5】"全部替换"保持全量管线（跨块结构改写仍交给 Vditor 的 setValue），
    // 只把替换循环按 400 处一片让出主线程、进度实时可见；分片只影响节奏，
    // 产物（克隆→整篇转换→setValue）与旧实现一致。
    const copy=cloneSource(root(),true),cloned=sourceText(copy);
    running=true;
    try{
      const order=[...selected].reverse();
      for(let i=0;i<order.length;i++){
        const range=cloned.range(hits[order[i]*2],hits[order[i]*2+1]);
        range.deleteContents();range.insertNode(document.createTextNode(replace.value));
        if(order.length>400&&i%400===399){
          status.textContent=`正在替换 ${i+1} / ${order.length}`;
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
    }finally{running=false;}
    const md=e.currentMode==='sv'?copy.textContent:e.lute[e.currentMode==='ir'?'VditorIRDOM2Md':'VditorDOM2Md'](copy.innerHTML);
    const scroll=root().scrollTop;
    api.setValue(md);
    const nextIndex=sourceText(root()),caret=nextIndex.range(Math.min(position,nextIndex.text.length),Math.min(position,nextIndex.text.length));
    selectRange(root(),caret);root().scrollTop=scroll;
    if(e.currentMode==='ir'){clearTimeout(e.ir.processTimeoutId);e.undo.addToUndoStack(e);}
    e.options.input?.(api.getValue());
    status.textContent=`已替换 ${amount} 处`;
    // 【FR6】全量管线同口径：全部替换后回查找框方便改词；单处替换（含公式块的
    // FR1 回退路径）留在替换框，Enter 连续替换的手感两条管线一致。
    (allMatches?query:replace).focus({preventScroll:true});search();
  };
  const close=()=>{
    if(!panel)return;
    const restoreFocus=panel.contains(document.activeElement);
    const selection=restoreFocus&&active>=0&&!pending?index.range(hits[active*2],hits[active*2+1]):null;
    clearTimeout(timer);worker?.terminate();worker=null;if(blob)URL.revokeObjectURL(blob);blob=null;
    panel.remove();panel=null;all.clear();current.clear();CSS.highlights.delete('typora-find');CSS.highlights.delete('typora-find-current');
    if(selection?.startContainer.isConnected)selectRange(root(),selection);else if(restoreFocus)root().focus({preventScroll:true});
    index=null;hits=new Int32Array();active=-1;pending=false;request++;
  };
  const setMode=value=>{
    replacing=!!value;
    panel.querySelector('.find-replace-row').hidden=!replacing;
    panel.querySelectorAll('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String((button.dataset.mode==='replace')===replacing)));
  };
  const open=(value=false)=>{
    // 【FC4】关补全浮层：installCompletion 是动态 import，注册晚于本模块，同一个
    // window 捕获阶段的 keydown 里 find-replace 先跑、stopImmediatePropagation 挡掉
    // 补全自己的收起逻辑——不显式 dismiss 的话 z1000 的浮层会盖在 z100 的查找框上。
    api.__completion?.dismiss();
    if(panel){setMode(value);query.focus();query.select();return;}
    panel=document.createElement('section');panel.id='typora-find';panel.setAttribute('role','search');panel.setAttribute('aria-label','查找和替换');
    panel.innerHTML='<div class="find-header"><div class="find-modes" role="group" aria-label="查找模式"><button type="button" data-mode="find">查找</button><button type="button" data-mode="replace">替换</button></div><button type="button" data-action="close" title="关闭（Esc）" aria-label="关闭查找和替换（Esc）">×</button></div><div class="find-row"><input data-field="query" aria-label="查找内容" placeholder="查找当前文档"/><label title="区分大小写"><input type="checkbox" data-field="case"/> Aa</label><output aria-live="polite"></output><button data-action="previous" title="上一个（Shift+Enter）">↑</button><button data-action="next" title="下一个（Enter）">↓</button></div><div class="find-replace-row"><input data-field="replace" aria-label="替换内容" placeholder="替换为"/><button data-action="replace">替换</button><button data-action="all">全部替换</button></div><p role="status"></p>';
    query=panel.querySelector('[data-field="query"]');replace=panel.querySelector('[data-field="replace"]');matchCase=panel.querySelector('[data-field="case"]');count=panel.querySelector('output');status=panel.querySelector('[role="status"]');
    // 【FR5】播种用复制同口径的 selectionPlainText：选中公式时预填的是带围栏的
    // 源码（$x^2$），而不是把 KaTeX 渲染 DOM 的 textContent（垃圾文本）塞进查找框。
    let seeded='';try{seeded=selectionPlainText(api);}catch{}
    if(seeded.length<300&&!/[\r\n]/.test(seeded))query.value=seeded;
    setMode(value);
    panel.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.mode==='replace')));
    panel.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action==='close')close();else if(action==='previous')navigate(-1);else if(action==='next')navigate(1);else if(action==='replace'||action==='all')apply(action==='all');});
    // 【FR7】IME 组字中间态不触发即时搜索（每键全篇索引 + 高亮闪烁，中文主场景卡）；
    // 组字结束的最后一次 input（isComposing=false）与 compositionend 兜底会补上。
    query.addEventListener('input',event=>{if(event.isComposing)return;schedule();});
    query.addEventListener('compositionend',()=>schedule());
    matchCase.addEventListener('change',search);
    panel.addEventListener('keydown',event=>{event.stopPropagation();if(event.isComposing)return;if(event.key==='Enter'&&(event.target===query||event.target===replace)){event.preventDefault();if(event.target===replace)apply(false);else navigate(event.shiftKey?-1:1);}});
    document.body.append(panel);CSS.highlights.set('typora-find',all);CSS.highlights.set('typora-find-current',current);
    blob=URL.createObjectURL(new Blob(['('+searchWorker.toString()+')()'],{type:'text/javascript'}));worker=new Worker(blob);
    worker.onmessage=({data})=>{if(!panel||data.id!==request)return;hits=data.hits;active=hits.length?0:-1;pending=false;e.__typoraSearchMs=data.ms;paint();
      // 【FR2】面板里发起的搜索（输入/改词/替换后的重搜）完成后定位当前命中：滚动到
      // 第一处、展开它所在的折叠公式。焦点在编辑面时的重搜（面板开着继续打字的场景）
      // 不 reveal——那会把打字中的光标和视口一起拽走，属于已另行裁决不动的 FR8 域。
      // 【R7】reveal 内部按焦点分支：面板发起时不落选区（焦点留在输入框，Enter 永远
      // 是"下一处"），打字与替换两条流程的连续手感同源，不再需要 returnFocus 还焦。
      if(active>=0&&panel.contains(document.activeElement))reveal();};
    worker.onerror=()=>{pending=true;count.textContent='查找失败';status.textContent='请关闭查找栏后重试。';controls();};
    // 【A-006】载入后第一次编辑就是查找替换时，撤销目标（undoStack[0] 载入态首快照）没有
    // <wbr> 光标标记，vendored renderDiff 走兜底把选区丢到编辑面之外的壳层 div.vditor-ir
    // （rect 0×0 无可见光标）。按 A-005/9b4a598 乙A 的 beginDocumentEdit 先例在此补喂一次；
    // **必须赶在 query.focus() 抢走文档选区之前**（实测：面板聚焦后补喂的等值守卫与选区捕获
    // 同时失效；装机 304B→309B 带 wbr 是"面板前"那一拍）。apply() 里补喂实测无效，勿加。
    // 哑事件 {key:'Enter'} 同 completion 先例，非 Backspace 不触发 mac 卫兵；sv 不喂（与
    // captureBeforeInput 的 sv 政策一致）。
    // 硬化【D′】：工具栏（toolbar.js click）与应用菜单（render/index.js on('find')）也调
    // open()，那两条入口不要求编辑面有焦点——冷启动实测 getSelection().rangeCount===0，原生
    // 守卫第一道门就返回，补喂静默空转、撤销照样落壳层。所以先确认编辑面内有选区；没有就把
    // 折叠选区落进**第一个顶层块的第一个非空文本节点**再喂——落点必须是文本节点：元素边界
    // （面自身 / 首块元素 offset 0）实测撤销后 rect 仍是 0×0，光标不可见；文本节点落点行盒
    // 16px 一眼可辨（D3c 三腿对照：collapse/collapse2 均 0×0，文本节点腿 0x34）。
    // 已知脆性【E】：光标所在块含 ≥2 层 --expand（如标题内公式展开态）时，<wbr> 补喂会因
    // 快照归一化剥不干净而静默空转——但用户可见面仍绿（wrapper 的 captureBeforeInput →
    // historySelections 那条腿兜底撤销落点）。**不要**拿"undoStack[0] 必须带 <wbr>"当判据。
    if(e.currentMode!=='sv'){
      const 面=root(),选=getSelection();
      let 面内有选区=false;
      if(选.rangeCount){try{面内有选区=面.contains(选.getRangeAt(0).startContainer);}catch{}}
      if(!面内有选区){const 折=document.createRange(),首块=面.firstElementChild||面;let 文=null;
        try{const w=document.createTreeWalker(首块,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){if(n.length){文=n;break;}}}catch{}
        if(文)折.setStart(文,0);else 折.selectNodeContents(首块);
        折.collapse(true);选.removeAllRanges();选.addRange(折);}
      e.undo.recordFirstPosition(e,{key:'Enter'});
    }
    query.focus();query.select();search();
  };
  const keydown=event=>{
    if(event.isComposing)return;
    // Capture before editor shortcuts, including after the caret returns to
    // the document. A modal dialog keeps its own Escape/IME behavior.
    if(event.key==='Escape'&&panel&&!event.target.closest?.('dialog[open]')){
      event.preventDefault();event.stopImmediatePropagation();close();return;
    }
    const key=event.key.toLowerCase(),inside=root().contains(event.target)||panel?.contains(event.target);
    if(!inside)return;
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&['f','h'].includes(key)){
      event.preventDefault();event.stopImmediatePropagation();open(key==='h');
    }else if(event.key==='F3'&&panel){event.preventDefault();event.stopImmediatePropagation();navigate(event.shiftKey?-1:1);}
  };
  window.addEventListener('keydown',keydown,true);
  const observer=new MutationObserver(records=>{if(panel&&records.some(r=>!(r.target.nodeType===3?r.target.parentElement:r.target)?.closest?.(PREVIEWS)))schedule();});
  for(const mode of ['ir','wysiwyg','sv'])observer.observe(e[mode].element,{subtree:true,childList:true,characterData:true});
  api.__typoraFind={open,close,search,navigate,replace:apply,get state(){return{pending,count:hits.length/2,active,replacing};}};
  return ()=>{close();observer.disconnect();window.removeEventListener('keydown',keydown,true);};
}
