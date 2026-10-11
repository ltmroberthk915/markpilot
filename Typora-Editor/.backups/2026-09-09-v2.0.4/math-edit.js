/** Math commands are local DOM transactions, including inside live tables.
 * Never insert dollar text into an existing formula or re-find a caret by
 * formula contents: both lose the editing boundary when formulas repeat.
 */
const PREVIEW='.vditor-ir__preview,.vditor-wysiwyg__preview';
const EXPAND='vditor-ir__node--expand';
const MATH='code[data-type="math-inline"],code[data-type="math-block"]';
const INLINE='code[data-type="math-inline"]';
const el=node=>node?.nodeType===3?node.parentElement:node;
const clean=text=>text.replace(/\u200b/g,'');
// GFM reserves a bare | even inside inline math. Use the equivalent TeX
// delimiter instead of a Markdown escape (\| means a double bar in TeX).
// TeX ignores these source line breaks; literal newlines would split GFM rows.
const tableSource=text=>text.replace(/(?<!\\)\|/g,'\\vert{}').replace(/\r\n?|\n/g,' ');
import {sourceText} from './source-text.js';
const blurredEditors=new WeakSet();
const choose=(root,node,offset)=>{
  root.focus({preventScroll:true});
  getSelection().collapse(node,Math.min(offset,node.nodeType===3?node.length:node.childNodes.length));
};
const ownerFor=code=>code?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
// Formatting wrappers may contain many formulas. Owning a formula requires a
// direct source child; a caret in bold/link text must not activate its first one.
const ownMath=owner=>owner?.querySelector(':scope > code[data-type="math-inline"],:scope > pre > code[data-type="math-block"]');
function emptyPairAt(root,range) {
  if(!range?.collapsed||el(range.startContainer)?.closest('code'))return null;
  const scope=el(range.startContainer)?.closest('td,th,p,h1,h2,h3,h4,h5,h6,li')||root,index=sourceText(scope);
  const span=index.spans.find(item=>item.node===range.startContainer);let at=span?span.start+range.startOffset:-1;
  if(!span){const prefix=range.cloneRange();prefix.selectNodeContents(scope);prefix.setEnd(range.startContainer,range.startOffset);const box=document.createElement('div');box.append(prefix.cloneContents());at=sourceText(box).text.length;}
  return at>0&&index.text.slice(at-1,at+1)==='$$'?index.range(at-1,at+1):null;
}
function formulaAt(range) {
  const a=el(range.startContainer)?.closest(MATH),b=el(range.endContainer)?.closest(MATH);
  if(a&&a===b)return a;
  const startOwner=el(range.startContainer)?.closest('.vditor-ir__node,.vditor-wysiwyg__block'),endOwner=el(range.endContainer)?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
  if(startOwner&&startOwner===endOwner&&ownMath(startOwner))return ownMath(startOwner);
  // Selecting the entire rendered/source wrapper is also a toggle-off.
  if(!range.collapsed&&range.startContainer===range.endContainer&&range.startContainer.nodeType===1&&range.endOffset===range.startOffset+1){
    const node=range.startContainer.childNodes[range.startOffset];
    if(node?.matches?.('.vditor-ir__node,.vditor-wysiwyg__block'))return ownMath(node);
  }
  return null;
}
function unwrap(root,code,range) {
  const owner=ownerFor(code);if(!owner)return null;
  const text=clean(code.textContent),prefix=range.cloneRange();
  let offset=text.length;
  if(code.contains(range.endContainer)){prefix.selectNodeContents(code);prefix.setEnd(range.endContainer,range.endOffset);offset=clean(prefix.toString()).length;}
  const node=document.createTextNode(text);
  if(owner.matches('[data-type="math-block"]')){
    const p=document.createElement('p');p.dataset.block='0';p.append(node);owner.replaceWith(p);
  }else owner.replaceWith(node);
  choose(root,node,offset);return node;
}
function makeFormula(mode,text) {
  const owner=document.createElement('span'),code=document.createElement('code'),preview=document.createElement('span'),math=document.createElement('span');
  // Preserve Lute's native WYSIWYG source sentinel. Empty WYSIWYG formulas
  // use the plain placeholder in wrap/commit instead of this rich subtree.
  code.dataset.type='math-inline';code.append(document.createTextNode((mode==='wysiwyg'?'\u200b':'')+text));
  preview.className='vditor-'+mode+'__preview';preview.dataset.render='2';preview.contentEditable='false';
  math.className='language-math';math.textContent=text;preview.append(math);
  if(mode==='ir'){
    owner.dataset.type='inline-node';owner.className='vditor-ir__node '+EXPAND;
    code.dataset.newline='1';code.className='vditor-ir__marker vditor-ir__marker--pre';
    const marker=()=>{const n=document.createElement('span');n.className='vditor-ir__marker';n.textContent='$';return n;};
    owner.append(marker(),code,preview,marker());
  }else{owner.dataset.type='math-inline';owner.className='vditor-wysiwyg__block';owner.append(code,preview);}
  return {owner,code};
}
function wrap(root,mode,range) {
  const fragment=range.cloneContents();fragment.querySelectorAll(PREVIEW).forEach(n=>n.remove());
  const raw=clean(fragment.textContent),text=el(range.startContainer)?.closest('td,th')?tableSource(raw):raw;
  // WYSIWYG's empty math AST has no render child and cannot be serialized by
  // Lute. Keep its native $$ placeholder until the first real input parses it.
  if(mode==='wysiwyg'&&!text){const node=document.createTextNode('$$');range.deleteContents();range.insertNode(node);choose(root,node,1);return node;}
  const {owner,code}=makeFormula(mode,text);
  range.deleteContents();range.insertNode(owner);choose(root,code.firstChild,code.firstChild.length);
  return owner;
}
function sourceToggle(editor,root,range) {
  // Source highlighting and history both split text nodes. Resolve source
  // offsets, so syntax spans do not change the command's toggle semantics.
  const index=sourceText(root);
  const offset=(node,at)=>{const span=index.spans.find(item=>item.node===node);if(span)return span.start+at;const r=document.createRange();r.selectNodeContents(root);r.setEnd(node,at);const box=document.createElement('div');box.append(r.cloneContents());return sourceText(box).text.length;};
  const a=offset(range.startContainer,range.startOffset),b=offset(range.endContainer,range.endOffset),text=index.text;
  {
    const pairs=[...text.matchAll(/(?<![\\$])\$(?!\$)([^\n]*?)(?<!\\)\$(?!\$)/g)];
    const pair=pairs.find(m=>a>=m.index+1&&b<=m.index+m[0].length-1)||pairs.find(m=>a===m.index&&b===m.index+m[0].length);
    const empty=a===b&&text.slice(a-1,a+1)==='$$';
    if(pair||empty){const replacement=pair?index.range(pair.index,pair.index+pair[0].length):index.range(a-1,a+1);getSelection().removeAllRanges();getSelection().addRange(replacement);document.execCommand('insertText',false,pair?pair[1]:'');return;}
  }
  const selected=range.toString();document.execCommand('insertText',false,'$'+selected+'$');getSelection().modify('move','backward','character');
}
export function toggleMath(api) {
  const e=api.vditor,mode=e.currentMode,root=e[mode].element,s=getSelection();
  if(!s.rangeCount)return;
  const range=s.getRangeAt(0).cloneRange();
  if(mode==='sv'){sourceToggle(e,root,range);return;}
  const before=api.getValue(),code=formulaAt(range);
  // Literal inline/fenced code must not receive a nested rich math subtree.
  // The code shortcut can remove that literal-code boundary first.
  if(!code&&el(range.startContainer)?.closest('code'))return;
  const empty=code?null:emptyPairAt(root,range);
  if(code)unwrap(root,code,range);
  else if(empty){
    // Vditor history splits text nodes around its caret marker. A dollar pair
    // can therefore span two adjacent text nodes even without another edit.
    empty.deleteContents();choose(root,empty.startContainer,empty.startOffset);
  }
  else {
    // A code block is literal text. Leave its language and fences intact.
    if(el(range.startContainer)?.closest('pre,[data-type="code-block"]')&&el(range.startContainer)?.closest('pre,[data-type="code-block"]')!==root)return;
    const startCell=el(range.startContainer)?.closest('td,th'),endCell=el(range.endContainer)?.closest('td,th');
    if(startCell!==endCell){
      // Preserve a rectangular table selection. Apply separately within each
      // selected cell instead of replacing table/tr elements with dollar text.
      const cells=[...root.querySelectorAll('td,th')].filter(c=>range.intersectsNode(c));
      for(const cell of cells.reverse()){
        const part=document.createRange();part.selectNodeContents(cell);
        if(cell.contains(range.startContainer))part.setStart(range.startContainer,range.startOffset);
        if(cell.contains(range.endContainer))part.setEnd(range.endContainer,range.endOffset);
        if(!part.collapsed)wrap(root,mode,part);
      }
    }else{
      const a=el(range.startContainer)?.closest('p,h1,h2,h3,h4,h5,h6,li'),b=el(range.endContainer)?.closest('p,h1,h2,h3,h4,h5,h6,li');
      if(!startCell&&a!==b){
        // An inline shortcut must not consume block boundaries.
        const blocks=[...root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')].filter(n=>!n.querySelector('p,li')&&!n.closest('table')&&range.intersectsNode(n));
        for(const block of blocks.reverse()){
          const part=document.createRange();part.selectNodeContents(block);
          if(block.contains(range.startContainer))part.setStart(range.startContainer,range.startOffset);
          if(block.contains(range.endContainer))part.setEnd(range.endContainer,range.endOffset);
          if(!part.collapsed)wrap(root,mode,part);
        }
      }else wrap(root,mode,range);
    }
  }
  const after=api.getValue();
  if(after!==before)e.options.input?.(after);
  refreshMathEditing(api);
  window.__typoraScheduleMath?.(root,{cdn:e.options.cdn,math:e.options.preview.math});
}

export function refreshMathEditing(api) {
  const e=api.vditor,mode=e.currentMode;if(!['ir','wysiwyg'].includes(mode))return;
  const root=e[mode].element,s=getSelection();
  const focused=!blurredEditors.has(api)&&(document.activeElement===root||root.contains(document.activeElement));
  const at=el(s?.focusNode),caretOwner=at?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
  const active=root.contains(s?.focusNode)&&focused?(at?.closest(MATH)||ownMath(caretOwner)):null;
  const selectedPreview=el(s?.focusNode)?.closest(PREVIEW);
  for(const code of root.querySelectorAll(INLINE)){
    if(code.closest(PREVIEW))continue;
    const owner=ownerFor(code);if(!owner)continue;
    const editing=code===active||!!selectedPreview&&owner.contains(selectedPreview);
    if(mode==='ir')owner.classList.toggle(EXPAND,editing);
    else code.style.display=editing?'':'none';
  }
}

export function installMathEditing(api) {
  const e=api.vditor,removers=[];
  const queueUndo=()=>{const mode=e.currentMode;clearTimeout(e[mode].processTimeoutId);e[mode].processTimeoutId=setTimeout(()=>{if(e.currentMode===mode)e.undo.addToUndoStack(e);},e.options.undoDelay||200);};
  const activeCode=()=>{const s=getSelection(),root=e[e.currentMode]?.element;if(!s?.rangeCount||!root?.contains(s.focusNode))return null;const a=el(s.anchorNode)?.closest(INLINE),b=el(s.focusNode)?.closest(INLINE);return a&&a===b&&!a.closest(PREVIEW)?a:null;};
  const activeEmpty=()=>{const s=getSelection(),root=e[e.currentMode]?.element;return s?.rangeCount&&root?.contains(s.focusNode)?emptyPairAt(root,s.getRangeAt(0)):null;};
  const commit=code=>{
    if(!clean(code.textContent)){
      // Chromium leaves a BR when deleting the final character of a grid
      // item. Lute serializes that BR as a literal newline inside a GFM row.
      // Both modes need a plain empty pair before any history/save/reparse.
      const node=document.createTextNode('$$');ownerFor(code).replaceWith(node);choose(e[e.currentMode].element,node,1);
      e.options.input?.(api.getValue());queueUndo();return;
    }
    if(code.closest('td,th')){
      const raw=code.textContent,normalized=tableSource(raw);
      if(raw!==normalized){
        const s=getSelection(),prefix=document.createRange();prefix.selectNodeContents(code);prefix.setEnd(s.focusNode,s.focusOffset);
        const offset=tableSource(prefix.toString()).length;code.textContent=normalized;choose(e[e.currentMode].element,code.firstChild,offset);
      }
    }
    const owner=ownerFor(code),preview=owner?.querySelector(PREVIEW);
    if(preview){
      const math=document.createElement('span');math.className='language-math';math.textContent=clean(code.textContent);preview.replaceChildren(math);preview.dataset.render='2';preview.contentEditable='false';
      window.__typoraScheduleMath?.(preview,{cdn:e.options.cdn,math:e.options.preview.math});
    }
    e.options.input?.(api.getValue());
    queueUndo();
    refreshMathEditing(api);
  };
  const fillEmpty=(range,text)=>{
    if(!text)return;
    const root=e[e.currentMode].element,value=el(range.startContainer)?.closest('td,th')?tableSource(text):text;
    const {owner,code}=makeFormula(e.currentMode,value);range.deleteContents();range.insertNode(owner);choose(root,code.firstChild,code.firstChild.length);commit(code);
  };
  for(const mode of ['ir','wysiwyg']){
    const root=e[mode].element;let pending=null,compositionCode=null;
    const recoverMarkerInput=code=>{
      if(mode!=='ir'||!code?.isConnected||!root.contains(code)||!code.matches(INLINE))return false;
      // Chromium can insert at code@0 into the adjacent dollar marker instead
      // of the inline code. Keep that input in its original formula; otherwise
      // Markdown changes but the preview and following source edits go stale.
      const owner=ownerFor(code),left=code.previousElementSibling,right=owner?.lastElementChild;
      if(!left?.matches('.vditor-ir__marker')||!right?.matches('.vditor-ir__marker')||
          !left.textContent.startsWith('$')||!right.textContent.endsWith('$'))return false;
      const prefix=left.textContent.slice(1),suffix=right.textContent.slice(0,-1);
      if(!prefix&&!suffix)return false;
      const s=getSelection(),source=code.textContent;
      let offset=prefix.length;
      if(right.contains(s.focusNode))offset=prefix.length+source.length+Math.min(s.focusOffset,suffix.length);
      else if(left.contains(s.focusNode))offset=Math.max(0,s.focusOffset-1);
      else if(code.contains(s.focusNode)){
        const before=document.createRange();before.selectNodeContents(code);before.setEnd(s.focusNode,s.focusOffset);
        offset+=before.toString().length;
      }
      left.textContent='$';right.textContent='$';code.textContent=prefix+source+suffix;
      choose(root,code.firstChild,offset);return true;
    };
    const keydown=event=>{
      if(event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return;
      const code=activeCode(),empty=activeEmpty();if(!code&&!empty)return;
      if(['Backspace','Delete'].includes(event.key)&&(empty||code&&!clean(code.textContent))){
        event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);toggleMath(api);queueUndo();return;
      }
      // Vditor treats | as a table-navigation delimiter and $ as Markdown.
      // Inside formula source both are ordinary TeX input. Keep the browser's
      // native edit, but don't run Vditor's general Markdown key handler.
      if(event.key.length===1&&!event.isComposing){e.undo.recordFirstPosition(e,event);event.stopImmediatePropagation();}
    };
    const beforeinput=event=>{
      pending=activeCode()||compositionCode;if(pending||event.isComposing||!event.cancelable||event.inputType!=='insertText'||!event.data)return;
      const empty=activeEmpty();if(empty){event.preventDefault();event.stopImmediatePropagation();fillEmpty(empty,event.data);}
    };
    const input=event=>{
      const code=pending||compositionCode||activeCode();pending=null;if(!code?.isConnected||!root.contains(code))return;
      event.stopImmediatePropagation();
      // Keep the browser's live composition node intact until it commits.
      if(event.isComposing)return;
      recoverMarkerInput(code);commit(code);
    };
    const compositionstart=()=>{compositionCode=activeCode();};
    const compositionend=()=>{const code=compositionCode;compositionCode=null;if(recoverMarkerInput(code))commit(code);};
    const paste=event=>{
      const code=activeCode(),empty=code?null:activeEmpty();if((!code&&!empty)||!event.clipboardData)return;
      event.preventDefault();event.stopImmediatePropagation();
      const text=event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n');
      if(empty)fillEmpty(empty,text);
      else {pending=code;document.execCommand('insertText',false,code.closest('td,th')?tableSource(text):text);}
    };
    root.addEventListener('keydown',keydown,true);root.addEventListener('beforeinput',beforeinput,true);root.addEventListener('input',input,true);root.addEventListener('paste',paste,true);
    root.addEventListener('compositionstart',compositionstart,true);root.addEventListener('compositionend',compositionend,true);
    removers.push(()=>{root.removeEventListener('keydown',keydown,true);root.removeEventListener('beforeinput',beforeinput,true);root.removeEventListener('input',input,true);root.removeEventListener('paste',paste,true);root.removeEventListener('compositionstart',compositionstart,true);root.removeEventListener('compositionend',compositionend,true);});
  }
  let scheduled=false;
  const refresh=()=>refreshMathEditing(api);
  const queue=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;refresh();});};
  const blur=()=>{blurredEditors.add(api);queue();},focus=()=>{blurredEditors.delete(api);queue();};
  document.addEventListener('selectionchange',queue);
  document.addEventListener('pointerup',queue);
  document.addEventListener('keyup',queue);
  window.addEventListener('blur',blur);
  window.addEventListener('focus',focus);
  return()=>{removers.forEach(remove=>remove());document.removeEventListener('selectionchange',queue);document.removeEventListener('pointerup',queue);document.removeEventListener('keyup',queue);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);blurredEditors.delete(api);};
}
