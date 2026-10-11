import {markdownLocations} from './markdown-locations.js';
import {normalizeMathFences} from './math-markdown.js';
import {mappedMathNodeAtPoint} from './math-source-map.js';
import {installSplitResize} from './split-resize.js';

const element = node => node?.nodeType===3?node.parentElement:node;
const atomSelector='.language-math,img,input[type="checkbox"]';
const rangeAt=(node,offset=0)=>{const range=document.createRange();range.setStart(node,Math.min(offset,node.nodeType===3?node.length:node.childNodes.length));range.collapse(true);return range;};
function sourceModel(root){
  let length=0;const chunks=[],spans=[],byNode=new Map(),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  for(let node;node=walker.nextNode();){
    const data=node.data,positions=data.includes('\u200b')?Array.from({length:data.length},(_,i)=>i).filter(i=>data[i]!=='\u200b'):null;
    const visible=positions?data.replaceAll('\u200b',''):data,item={node,start:length,end:length+visible.length,positions};
    chunks.push(visible);length=item.end;if(visible.length)spans.push(item);byNode.set(node,item);
  }
  const text=chunks.join('');
  return {text,point(offset){
    offset=Math.max(0,Math.min(text.length,offset));
    let low=0,high=spans.length;while(low<high){const middle=(low+high)>>>1;if(spans[middle].end<=offset)low=middle+1;else high=middle;}
    const item=spans[low]||spans.at(-1),local=item?offset-item.start:0;
    return item?[item.node,item.positions?(item.positions[local]??item.node.length):Math.min(local,item.node.length)]:[root,0];
  },offset(node,at){
    const item=byNode.get(node);if(item)return item.start+(item.positions?item.positions.filter(i=>i<at).length:Math.min(at,node.length));
    const range=document.createRange();range.selectNodeContents(root);range.setEnd(node,at);return range.toString().replaceAll('\u200b','').length;
  }};
}
function pointRect(node,offset=0){
  if(node.nodeType!==3)return node.getBoundingClientRect?.()||element(node)?.getBoundingClientRect();
  const line=node.parentElement.closest('[data-type="newline"]');
  if(line){const br=line.querySelector('br');if(br)return br.getBoundingClientRect();}
  let range=rangeAt(node,offset),rect=range.getClientRects()[0];
  if(rect?.height)return rect;
  if(node.length){range=rangeAt(node,Math.min(offset,node.length-1));range.setEnd(node,Math.min(node.length,Math.max(offset+1,1)));rect=range.getClientRects()[0];}
  return rect?.height?rect:node.parentElement.getBoundingClientRect();
}
const center=rect=>rect.top+rect.height/2;
function revealHorizontal(point,stop){
  for(let node=element(point.node);node;node=node.parentElement){
    if(node.scrollWidth>node.clientWidth+1&&/auto|scroll/.test(getComputedStyle(node).overflowX)){
      const rect=pointRect(point.node,point.nodeOffset),box=node.getBoundingClientRect();
      if(rect.left<box.left+8)node.scrollLeft+=rect.left-box.left-8;
      else if(rect.right>box.right-8)node.scrollLeft+=rect.right-box.right+8;
    }
    if(node===stop)break;
  }
}
function projection(items){
  let text='';const points=[];
  for(const item of items){
    const str=item.kind==='text'?item.text:'\ufffc';
    for(let i=0;i<str.length;i++){
      if(str[i]==='\u200b')continue;
      const char=/\s/.test(str[i])?' ':str[i];
      if(char===' '&&(!text||text.endsWith(' ')))continue;
      text+=char;points.push({...item,index:i,source:item.positions?.[i]??item.start,nodeOffset:item.offset==null?i:item.offset+i});
    }
  }
  if(text.endsWith(' ')){text=text.slice(0,-1);points.pop();}
  return {text,points};
}
function domItems(root,visual=false){
  const items=[];
  const visit=node=>{
    if(node.nodeType===3){items.push({kind:'text',text:node.data,node});return;}
    if(node.nodeType!==1||node.matches('script,style,.hljs-ln-numbers,.vditor-linenumber__rows,.vditor-linenumber__temp,.vditor-copy,.katex-mathml,.vditor-anchor,.footnotes-backref'))return;
    if(visual&&node.matches('code[data-type="html-inline"]'))return;
    if(visual&&node.matches('.vditor-wysiwyg__block[data-type="html-entity"],.vditor-ir__node[data-type="html-entity"]')){
      const shown=node.querySelector('.vditor-wysiwyg__preview,.vditor-ir__preview'),code=node.querySelector('code[data-type="html-entity"]');
      if(shown){const walker=document.createTreeWalker(shown,NodeFilter.SHOW_TEXT);for(let text;text=walker.nextNode();)items.push({kind:'text',text:text.data,node:text});}
      else if(code){const template=document.createElement('template');template.innerHTML=code.textContent.replaceAll('\u200b','');items.push({kind:'text',text:template.content.textContent,node:code.firstChild});}
      return;
    }
    if(visual&&node.matches('code[data-type="math-inline"],code[data-type="math-block"]')){
      const wrapper=node.closest('.vditor-ir__node,.vditor-wysiwyg__block');
      const rendered=wrapper?.querySelector('.vditor-ir__preview .language-math,.vditor-wysiwyg__preview .language-math');
      items.push({kind:'math',node:rendered||node,sourceNode:node,text:node.textContent.replaceAll('\u200b','')});return;
    }
    if(visual&&node.matches('.vditor-ir__marker,.vditor-ir__preview,.vditor-wysiwyg__preview'))return;
    if(node!==root&&!root.matches('code,pre')&&node.matches('ul,ol,p,table,pre,blockquote,h1,h2,h3,h4,h5,h6'))return;
    if(node.matches('.language-math')){items.push({kind:'math',node,text:node.getAttribute('data-math')||node.textContent});return;}
    if(node.matches('img,input[type="checkbox"]')){items.push({kind:node.tagName==='IMG'?'image':'checkbox',node,text:''});return;}
    if(node.tagName==='BR'){items.push({kind:'text',text:'\n',node});return;}
    for(const child of node.childNodes)visit(child);
  };
  visit(root);return items;
}
function previewBlocks(root,visual=false,coarse=false){
  const blocks=[];
  const push=(kind,node)=>blocks.push({kind,node});
  const visit=node=>{
    if(node.nodeType!==1)return;
    if(visual&&node.matches('div[data-type="code-block"],div[data-type="math-block"]')){
      const code=node.querySelector('pre:not(.vditor-ir__preview):not(.vditor-wysiwyg__preview) code');
      const rendered=node.querySelector('.vditor-ir__preview code,.vditor-wysiwyg__preview code');
      const math=node.dataset.type==='math-block';
      // 粗绑定只用来把块映射回源码区间，不需要知道源码/预览谁可见；读几何会
      // 对每个代码块触发强制布局（12 万字 5689 个公式块实测秒级）。
      const visible=!coarse&&code?.parentElement.getBoundingClientRect().height>1&&code?.parentElement.getBoundingClientRect().width>1;
      blocks.push({kind:math?'math':'code',node:math?code:(visible?code:rendered||code)||node,container:node,sourceCode:code});return;
    }
    if(node.matches('[data-type="toc-block"],.vditor-toc')){push('toc',node);return;}
    if(node.matches('h1,h2,h3,h4,h5,h6')){push('heading',node);return;}
    if(node.matches('th,td')){push('cell',node);return;}
    if(node.tagName==='PRE'){push(node.querySelector('.language-math')?'math':'code',node.querySelector('code')||node);return;}
    if(node.matches('.language-math')){push('math',node);return;}
    if(node.tagName==='P'){push('paragraph',node);return;}
    if(node.tagName==='HR'){push('rule',node);return;}
    if(node.tagName==='LI'){
      if(!node.querySelector(':scope > p')&&domItems(node).some(i=>i.kind!=='text'||i.text.trim()))push('paragraph',node);
      for(const child of node.children)if(child.matches('ul,ol,p,pre,blockquote,table'))visit(child);
      return;
    }
    if(node.matches('table,thead,tbody,tr,ul,ol,blockquote,.footnotes,.footnotes-defs-div,section')){for(const child of node.children)visit(child);return;}
    push('html',node);
  };
  for(const child of root.children)visit(child);return blocks;
}
function htmlUnits(unit){
  const template=document.createElement('template');template.innerHTML=unit.text;
  const text=template.content.textContent||'';let cursor=0;
  return [{kind:'text',text,positions:Array.from(text,c=>{let at=unit.text.indexOf(c,cursor);if(at<0)at=cursor;cursor=at+1;return unit.positions[at]??unit.start;}),start:unit.start,end:unit.end}];
}
function bindBlocks(locations,root,visual=false,coarse=false,selection=null){
  const candidates=previewBlocks(root,visual,coarse),bound=[];let next=0;
  const findKind=kind=>{for(let i=next;i<candidates.length;i++)if(candidates[i].kind===kind)return i;return -1;};
  for(const [ordinal,location] of locations.entries()){
    let index=findKind(location.kind);
    if(index<0&&location.kind==='code')index=findKind('html');
    if(index<0)continue;
    const candidate=candidates[index];next=index+1;
    if(coarse||selection&&!selection.intersectsNode(candidate.container||candidate.node)){bound.push({...location,ordinal,node:candidate.container||candidate.node,sourceCode:candidate.sourceCode,points:[],nodePoints:new Map(),coarse:true});continue;}
    const expected=projection(location.units.flatMap(unit=>unit.kind==='html'?htmlUnits(unit):[unit]));
    const actual=projection(domItems(candidate.node,visual));
    const points=[],nodePoints=new Map();let offset=0;
    for(let i=0;i<actual.text.length;i++){
      let at=expected.text.indexOf(actual.text[i],offset);
      if(at<0||at>offset+64)at=Math.min(offset,Math.max(0,expected.points.length-1));
      const from=expected.points[at];if(!from)continue;
      const to=actual.points[i],point={...to,source:from.source,unit:from};
      points.push(point);if(!nodePoints.has(to.node))nodePoints.set(to.node,[]);nodePoints.get(to.node).push(point);offset=at+1;
    }
    bound.push({...location,ordinal,node:candidate.container||candidate.node,sourceCode:candidate.sourceCode,points,nodePoints});
  }
  return bound;
}
/** 粗粒度块↔源码区间绑定：只按文档顺序匹配块种类，不做逐字符投影。
 *  阅读模式（reading-mode.js）用它把只读渲染面的块映射回 Markdown 偏移，
 *  与分屏导航共用同一套块识别规则（previewBlocks/bindBlocks）。
 *  位置表按 coarse 建（每个 unit 两个偏移而不是逐字符），12 万字下逐字符表
 *  是几十 MB 的常驻数组。两个渲染面共用同一份位置表，只解析一次。 */
export function documentLocations(api, markdown) {
  return markdownLocations(markdown, JSON.parse(api.vditor.lute.RenderJSON(normalizeMathFences(markdown))), {coarse: true});
}
export function bindCoarseBlocks(locations, root, visual = true) {
  return bindBlocks(locations, root, visual, true);
}
const locationKey=block=>block.kind+'\0'+block.units.map(unit=>unit.kind+':'+unit.text).join('\0');
function translateLocation(oldLocations,newLocations,block,offset){
  const keys=oldLocations.map(locationKey),nextKeys=newLocations.map(locationKey);let prefix=0,suffix=0;
  while(prefix<keys.length&&prefix<nextKeys.length&&keys[prefix]===nextKeys[prefix])prefix++;
  while(suffix<keys.length-prefix&&suffix<nextKeys.length-prefix&&keys.at(-1-suffix)===nextKeys.at(-1-suffix))suffix++;
  let index=block.ordinal;
  if(index>=keys.length-suffix)index+=nextKeys.length-keys.length;
  else if(index>=prefix)index=prefix+Math.min(index-prefix,Math.max(0,nextKeys.length-prefix-suffix-1));
  const next=newLocations[index];if(!next)return Math.min(offset,newLocations.at(-1)?.end||0);
  if(block.coarse)return Math.round(next.start+(next.end-next.start)*Math.max(0,Math.min(1,(offset-block.start)/Math.max(1,block.end-block.start))));
  const flatten=entry=>({text:entry.units.map(u=>u.text).join(''),positions:entry.units.flatMap(u=>Array.from({length:u.text.length},(_,i)=>u.positions[i]??u.start))});
  const before=flatten(block),after=flatten(next);if(!before.text||!after.text)return next.start;
  let local=before.positions.findIndex(position=>position>=offset);if(local<0)local=before.text.length;
  prefix=0;suffix=0;
  while(prefix<before.text.length&&prefix<after.text.length&&before.text[prefix]===after.text[prefix])prefix++;
  while(suffix<before.text.length-prefix&&suffix<after.text.length-prefix&&before.text.at(-1-suffix)===after.text.at(-1-suffix))suffix++;
  if(local>=before.text.length-suffix)local+=after.text.length-before.text.length;
  else if(local>prefix)local=prefix+Math.min(local-prefix,after.text.length-prefix-suffix);
  return after.positions[local]??after.positions.at(-1)+1;
}
function nearestMathPoint(node,sourceOffset,unit){
  const index=unit.positions.findIndex(pos=>pos>=sourceOffset),local=index<0?unit.text.length:index;
  const symbols=[...node.querySelectorAll('[data-typora-source-start]')];
  const match=symbols.filter(n=>Number(n.dataset.typoraSourceStart)<=local&&Number(n.dataset.typoraSourceEnd)>local)
    .sort((a,b)=>(Number(a.dataset.typoraSourceEnd)-Number(a.dataset.typoraSourceStart))-(Number(b.dataset.typoraSourceEnd)-Number(b.dataset.typoraSourceStart))||a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
  return match||node;
}

const inView=(rect,viewport)=>rect?.height>0&&rect.bottom>viewport.top+1&&rect.top<viewport.bottom-1&&rect.right>=viewport.left&&rect.left<=viewport.right;
const closestBlock=(items,node)=>items.filter(b=>b.node.contains(node)).sort((a,b)=>a.node.contains(b.node)?1:-1)[0];
function offsetAtDOM(block,node,at,position){
  const code=block.sourceCode;
  if(code?.contains(node)){
    const local=sourceModel(code).offset(node,at),unit=block.units.find(u=>u.kind==='math'||u.kind==='text');
    return unit?.positions[local]??(unit?.start||block.start)+local;
  }
  for(const point of block.points){
    if(point.kind!=='math')continue;
    if(point.sourceNode?.contains(node)){
      const local=sourceModel(point.sourceNode).offset(node,at);return point.unit.positions[local]??point.unit.start+local;
    }
    if(point.node.contains(node)){
      const symbol=position&&mappedMathNodeAtPoint(point.node,{target:element(node),clientX:position.x,clientY:position.y});
      return symbol?(point.unit.positions[Number(symbol.dataset.typoraSourceStart)]??point.unit.start):point.unit.start;
    }
  }
  const points=block.nodePoints.get(node);
  if(points?.length){const point=points.reduce((a,b)=>Math.abs(b.nodeOffset-at)<Math.abs(a.nodeOffset-at)?b:a);return point.unit.entity&&at>point.nodeOffset?point.unit.end:point.source+Math.max(0,at-point.nodeOffset);}
  const rect=block.node.getBoundingClientRect();
  return block.coarse&&position?Math.round(block.start+(block.end-block.start)*Math.max(0,Math.min(1,(position.y-rect.top)/Math.max(1,rect.height)))):block.start;
}
function viewportAnchor(items,scroller,y){
  const viewport=scroller.getBoundingClientRect();y??=viewport.top+viewport.height*.3;
  const visible=items.map(block=>({block,rect:block.node.getBoundingClientRect()})).filter(({rect})=>inView(rect,viewport));
  if(!visible.length)return null;
  visible.sort((a,b)=>Math.max(a.rect.top-y,0,y-a.rect.bottom)-Math.max(b.rect.top-y,0,y-b.rect.bottom)||a.rect.left-b.rect.left);
  const {block,rect}=visible[0],x=Math.max(rect.left,viewport.left)+Math.min(18,Math.max(1,rect.width*.15));
  const targetY=Math.max(Math.max(rect.top,viewport.top)+1,Math.min(y,Math.min(rect.bottom,viewport.bottom)-1));
  if(block.coarse)return{block,offset:offsetAtDOM(block,block.node,0,{x,y:targetY}),y:targetY};
  const hit=document.caretRangeFromPoint(x,targetY);
  if(hit&&block.node.contains(hit.startContainer)){
    const point=pointRect(hit.startContainer,hit.startOffset);
    if(inView(point,viewport)&&hit.startContainer.nodeType===3)return{block,offset:offsetAtDOM(block,hit.startContainer,hit.startOffset,{x,y:targetY}),y:center(point)};
  }
  const point=block.points.find(p=>inView(pointRect(p.node,p.nodeOffset),viewport));
  return{block,offset:point?.source??block.start,y:point?center(pointRect(point.node,point.nodeOffset)):targetY};
}

// A native chat attachment needs offsets in the host's current source, which
// may retain CRLF endings and original table spacing. Map the selected DOM
// directly to that source without serializing or rewriting the document.
export function selectedMarkdownRange(api,range,original){
  const editor=api.vditor,mode=editor.currentMode;
  const root=editor[mode].element,preview=editor.preview.previewElement;
  const inPreview=mode==='sv'&&preview.contains(range.commonAncestorContainer);
  if(range.collapsed||!range.startContainer.isConnected||!range.endContainer.isConnected||
    !(inPreview||root.contains(range.commonAncestorContainer)))return null;
  const cr=[];let removed=0;
  const markdown=original.replace(/\r\n/g,(match,at)=>{cr.push(at-removed++);return '\n';});
  const nativeOffset=offset=>{let low=0,high=cr.length;while(low<high){const mid=(low+high)>>>1;if(cr[mid]<offset)low=mid+1;else high=mid;}return offset+low;};
  if(mode==='sv'&&!inPreview){
    const model=sourceModel(root),normalized=model.text.replaceAll('\r\n','\n');
    const offset=(node,at)=>model.text.slice(0,model.offset(node,at)).replaceAll('\r\n','\n').length;
    let start=offset(range.startContainer,range.startOffset),end=offset(range.endContainer,range.endOffset);
    if(normalized.replace(/\n+$/,'')!==markdown.replace(/\n+$/,'')){
      // Entering source mode can canonicalize table padding while the native
      // document correctly retains its original formatting and clean state.
      const parse=value=>markdownLocations(value,JSON.parse(editor.lute.RenderJSON(normalizeMathFences(value))));
      const before=parse(normalized),after=parse(markdown);
      if(before.length!==after.length||before.some((block,i)=>locationKey(block)!==locationKey(after[i])))throw Error('正文仍在同步，请稍后重试 Alt+U。');
      const translate=at=>{
        let ordinal=before.findIndex(block=>at>=block.start&&at<=block.end);
        if(ordinal<0)ordinal=before.reduce((best,block,i)=>Math.min(Math.abs(block.start-at),Math.abs(block.end-at))<Math.min(Math.abs(before[best].start-at),Math.abs(before[best].end-at))?i:best,0);
        const block=before[ordinal],next=after[ordinal];if(!block)return at;
        for(let i=0;i<block.units.length;i++){
          const unit=block.units[i],mapped=next.units[i];
          if(at<unit.start||at>unit.end)continue;
          if(at===unit.end)return mapped.end;
          const local=unit.positions.findIndex(position=>position>=at);
          return mapped.positions[local]??mapped.start;
        }
        const anchors=[{from:block.start,to:next.start},{from:block.end,to:next.end},...block.units.flatMap((unit,i)=>[{from:unit.start,to:next.units[i].start},{from:unit.end,to:next.units[i].end}])].sort((a,b)=>Math.abs(a.from-at)-Math.abs(b.from-at));
        for(const anchor of anchors){
          const target=anchor.to+at-anchor.from;
          if(target<0||target>markdown.length)continue;
          if(normalized.slice(Math.min(at,anchor.from),Math.max(at,anchor.from))===markdown.slice(Math.min(target,anchor.to),Math.max(target,anchor.to)))return target;
        }
        return anchors[0].to;
      };
      start=translate(start);end=translate(end);
    }
    return end>start?{start:nativeOffset(start),end:nativeOffset(end)}:null;
  }
  const locations=markdownLocations(markdown,JSON.parse(editor.lute.RenderJSON(normalizeMathFences(markdown))));
  const blocks=bindBlocks(locations,inPreview?preview:root,!inPreview,false,range);
  const boundary=(node,at,end)=>{
    const block=closestBlock(blocks,node);if(!block||block.coarse)return null;
    if(block.sourceCode?.contains(node)||block.nodePoints.has(node))return offsetAtDOM(block,node,at);
    for(const point of block.points){
      if(point.kind!=='math')continue;
      if(point.sourceNode?.contains(node))return offsetAtDOM(block,node,at);
      if(point.node.contains(node)){
        const symbol=element(node)?.closest('[data-typora-source-start]');
        if(symbol&&point.node.contains(symbol)){
          const local=Number(end?symbol.dataset.typoraSourceEnd:symbol.dataset.typoraSourceStart);
          return point.unit.positions[local]??point.unit.end;
        }
        return end?point.unit.end:point.unit.start;
      }
    }
    return null;
  };
  let start=boundary(range.startContainer,range.startOffset,false),end=boundary(range.endContainer,range.endOffset,true);
  if(start==null||end==null){
    const hits=[];
    const selectionStart=range.cloneRange(),selectionEnd=range.cloneRange();selectionStart.collapse(true);selectionEnd.collapse(false);
    for(const block of blocks)for(const point of block.points){
      const part=document.createRange();
      if(point.kind==='text'&&point.node.nodeType===3){part.setStart(point.node,point.nodeOffset);part.setEnd(point.node,Math.min(point.node.length,point.nodeOffset+1));}
      else part.selectNode(point.sourceNode?.closest('.vditor-ir__node,.vditor-wysiwyg__block')||point.node);
      const partStart=part.cloneRange(),partEnd=part.cloneRange();partStart.collapse(true);partEnd.collapse(false);
      if(selectionEnd.compareBoundaryPoints(Range.START_TO_START,partStart)<=0||selectionStart.compareBoundaryPoints(Range.START_TO_START,partEnd)>=0)continue;
      const math=point.kind==='math',a=math&&markdown[point.unit.start-1]==='$'?point.unit.start-1:point.source;
      const b=math&&markdown[point.unit.end]==='$'?point.unit.end+1:point.kind==='text'?point.source+1:point.unit.end;
      hits.push({start:a,end:b});
    }
    if(!hits.length)return null;
    start??=hits[0].start;end??=hits.at(-1).end;
  }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>markdown.length)return null;
  return{start:nativeOffset(start),end:nativeOffset(end)};
}

export function installSplitNavigation(api){
  const editor=api.vditor,source=editor.sv.element,preview=editor.preview.element,content=editor.preview.previewElement;
  let active=false,disposed=false,frame=0,dirty=true,renderedSource=null,lastHTMLSource=null,blocks=[],model=null,gesture=null,lastAnchor=null;
  let locationSource=null,locations=[],viewportRequest=null,driver='idle',modelDirty=true,quality='precise';
  let pendingEntry=null,heldEntry=null,capturedEntry=null,comparisonModel=null,comparisonSource=null,sameSource=false,parsedCache=[];
  let timer=0,lastSync=0,resizing=false;
  const stats={modelBuilds:0,parses:0,bindings:0,scrollSyncs:0,maxSyncMs:0,maxScrollSyncMs:0};
  const ignoredScroll=new Map(),observedScroll=new Map();
  const setQuality=length=>{quality=length>900000?'ratio':length>150000?'blocks':'precise';};
  const getModel=()=>{if(modelDirty||!model){model=sourceModel(source);modelDirty=false;stats.modelBuilds++;setQuality(model.text.length);}return model;};
  const parseLocations=markdown=>{
    const coarse=markdown.length>150000,cached=parsedCache.find(item=>item.source===markdown&&item.coarse===coarse);if(cached)return cached.locations;
    const entries=markdownLocations(markdown,JSON.parse(editor.lute.RenderJSON(normalizeMathFences(markdown))),{coarse});stats.parses++;
    parsedCache=[{source:markdown,coarse,locations:entries},...parsedCache].slice(0,2);return entries;
  };
  const saved=new Map(),listeners=[];
  const listen=(node,type,fn,options)=>{node.addEventListener(type,fn,options);listeners.push(()=>node.removeEventListener(type,fn,options));};
  const enabled=()=>editor.currentMode==='sv'&&getComputedStyle(source).display!=='none'&&getComputedStyle(preview).display!=='none';
  const equivalent=(a,b)=>a?.replace(/\n+$/,'')===b?.replace(/\n+$/,'');
  const preparePane=(node,scroller)=>{
    if(saved.has(node))return;
    saved.set(node,{before:node.style.getPropertyValue('--typora-nav-before'),after:node.style.getPropertyValue('--typora-nav-after'),extra:0});
    node.style.setProperty('--typora-nav-after',scroller.clientHeight+'px');
    node.classList.add('typora-navigation-pane');
  };
  const restore=()=>{for(const [node,state] of saved){node.style.setProperty('--typora-nav-before',state.before);node.style.setProperty('--typora-nav-after',state.after);node.classList.remove('typora-navigation-pane');}saved.clear();lastAnchor=null;};
  const updateActive=()=>{
    const now=enabled();if(now===active)return now;
    active=now;dirty=true;driver='idle';
    divider.setActive(active);
    if(active){preparePane(source,source);preparePane(content,preview);observedScroll.set(source,source.scrollTop);observedScroll.set(preview,preview.scrollTop);}else{restore();pendingEntry=null;heldEntry=null;}
    return now;
  };
  const align=(node,scroller,rect,targetY)=>{
    if(!rect||!Number.isFinite(rect.top)||!Number.isFinite(targetY))return;
    preparePane(node,scroller);
    const state=saved.get(node);let top=scroller.scrollTop+center(rect)-targetY;
    if(top<-.5){state.extra-=top;node.style.setProperty('--typora-nav-before',state.extra+'px');top=0;}
    const bottom=scroller.clientHeight+'px';
    if(node.style.getPropertyValue('--typora-nav-after')!==bottom)node.style.setProperty('--typora-nav-after',bottom);
    scroller.scrollTop=top;ignoredScroll.set(scroller,scroller.scrollTop);
  };
  const refresh=(allowStale=false)=>{
    if(!updateActive())return false;
    getModel();
    if(comparisonModel!==model||comparisonSource!==renderedSource){sameSource=equivalent(model.text,renderedSource);comparisonModel=model;comparisonSource=renderedSource;}
    const same=sameSource;
    if(renderedSource==null||!same&&!allowStale)return false;
    const markdown=same?model.text:renderedSource;
    if(quality==='ratio'){blocks=[];locations=[];locationSource=markdown;return true;}
    if(locationSource!==markdown){locations=parseLocations(markdown);locationSource=markdown;dirty=true;}
    if(dirty){blocks=bindBlocks(locations,content,false,quality==='blocks');dirty=false;stats.bindings++;}
    return true;
  };
  const blockForOffset=offset=>{
    const exact=blocks.filter(b=>offset>=b.start&&offset<=b.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    return exact||blocks.reduce((best,b)=>!best||Math.min(Math.abs(b.start-offset),Math.abs(b.end-offset))<Math.min(Math.abs(best.start-offset),Math.abs(best.end-offset))?b:best,null);
  };
  const previewPoint=(block,offset)=>{
    if(block.coarse){const rect=block.node.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(offset-block.start)/Math.max(1,block.end-block.start)));return{node:block.node,nodeOffset:0,source:offset,rect:{...rect.toJSON(),top:rect.top+rect.height*fraction,height:0}};}
    let best=null,distance=Infinity;
    for(const point of block.points){const unit=point.unit;
      if(point.kind==='math'&&offset>=unit.start&&offset<=unit.end)return {node:nearestMathPoint(point.node,offset,unit),nodeOffset:0,source:offset};
      const delta=Math.abs(point.source-offset);if(delta<distance){distance=delta;best=point;}
    }
    return best||{node:block.node,nodeOffset:0,source:block.start};
  };
  const mappedRect=point=>point.rect||pointRect(point.node,point.nodeOffset);
  const scrollRatio=(from,to)=>{
    const ratio=from.scrollTop/Math.max(1,from.scrollHeight-from.clientHeight);
    to.scrollTop=ratio*Math.max(0,to.scrollHeight-to.clientHeight);ignoredScroll.set(to,to.scrollTop);
  };
  const followSource=(fromScroll=false)=>{
    if(!refresh())return;
    // Native window activation can restore a caret at the editor container
    // before the user's first click reaches the preview. Do not move its
    // target until the user actually interacts with the source or navigates.
    if(driver!=='source'&&!fromScroll)return;
    if(quality==='ratio'){scrollRatio(source,preview);return;}
    const selection=getSelection(),sourceSelection=source.contains(selection.focusNode);if(!sourceSelection&&!fromScroll)return;
    // A native focus restore can place the caret at an element boundary; a
    // delayed history marker can leave an empty text node. Resolve both to
    // the corresponding text offset, never the center of the whole pane.
    const boundary=sourceSelection&&(selection.focusNode.nodeType!==3||!selection.focusNode.length);
    const visible=sourceSelection?(boundary?model.point(model.offset(selection.focusNode,selection.focusOffset)):[selection.focusNode,selection.focusOffset]):[null,0];
    if(boundary&&!fromScroll&&selection.isCollapsed&&(visible[0]!==selection.focusNode||visible[1]!==selection.focusOffset))selection.collapse(...visible);
    let [node,at]=visible,rect=node&&pointRect(node,at);const viewport=source.getBoundingClientRect();
    if(!rect||center(rect)<viewport.top||center(rect)>viewport.bottom){
      if(!fromScroll)return;
      const hit=document.caretRangeFromPoint(viewport.left+Math.min(60,viewport.width/4),viewport.top+viewport.height*.35);
      if(!hit||!source.contains(hit.startContainer))return;
      node=hit.startContainer;at=hit.startOffset;rect=pointRect(node,at);
    }
    const offset=model.offset(node,at);
    const block=blockForOffset(offset);if(!block)return;
    const point=previewPoint(block,offset);lastAnchor={offset,y:center(rect)};
    revealHorizontal(point,preview);
    align(content,preview,mappedRect(point),center(rect));
  };
  const followPreview=()=>{
    if(!refresh(true))return;
    if(quality==='ratio'){scrollRatio(preview,source);return;}
    const anchor=viewportAnchor(blocks,preview);if(!anchor)return;
    let offset=anchor.offset;
    if(!sameSource)offset=translateLocation(locations,parseLocations(model.text),anchor.block,offset);
    const [node,at]=model.point(offset);lastAnchor={offset,y:anchor.y};
    align(source,source,pointRect(node,at),anchor.y);
  };
  const maintainEntry=()=>{
    const entry=pendingEntry||heldEntry;if(!entry||!refresh())return false;
    if(quality==='ratio'||entry.ratio!=null){
      const ratio=entry.ratio??entry.scrollRatio;
      for(const pane of [source,preview]){pane.scrollTop=ratio*Math.max(0,pane.scrollHeight-pane.clientHeight);ignoredScroll.set(pane,pane.scrollTop);}
      pendingEntry=null;heldEntry=entry;driver='entry';return true;
    }
    let offset=entry.offset;
    if(!equivalent(entry.source,model.text))offset=translateLocation(entry.locations,locations,entry.block,offset);
    const block=blockForOffset(offset);if(!block)return false;
    const point=previewPoint(block,offset),[node,at]=model.point(offset),viewport=source.getBoundingClientRect();
    const y=Math.max(viewport.top+8,Math.min(viewport.bottom-8,entry.y));
    align(source,source,pointRect(node,at),y);align(content,preview,mappedRect(point),y);
    // Vditor's deferred source highlighting can replace the selected node or
    // restore the container boundary after the first aligned frame. Keep the
    // entry caret until a real user action takes over; resizing never changes it.
    const selection=getSelection();
    if(entry.caret!==false&&(pendingEntry||selection.focusNode!==node||selection.focusOffset!==at)){
      if(pendingEntry)source.focus({preventScroll:true});selection.collapse(node,at);
    }
    lastAnchor={offset,y};pendingEntry=null;heldEntry=entry;driver='entry';return true;
  };
  const schedule=()=>{
    if(disposed||frame||timer)return;
    const interval=quality==='ratio'?70:quality==='blocks'?40:0,wait=interval-(performance.now()-lastSync);
    if(wait>1){timer=setTimeout(()=>{timer=0;schedule();},wait);return;}
    frame=requestAnimationFrame(()=>{
      frame=0;const start=performance.now(),scroll=viewportRequest;viewportRequest=null;
      if(pendingEntry||heldEntry&&driver==='entry')maintainEntry();
      else if(scroll==='preview'||driver==='preview')followPreview();else followSource(scroll==='source');
      lastSync=performance.now();if(scroll){stats.scrollSyncs++;stats.maxScrollSyncMs=Math.max(stats.maxScrollSyncMs,lastSync-start);}stats.maxSyncMs=Math.max(stats.maxSyncMs,lastSync-start);
    });
  };
  const captureVisual=(mode=editor.currentMode,markdown=api.getValue())=>{
    if(!['ir','wysiwyg'].includes(mode))return null;
    if(capturedEntry?.mode===mode&&performance.now()-capturedEntry.at<1000){const entry=capturedEntry;capturedEntry=null;return entry;}
    const root=editor[mode].element,viewport=root.getBoundingClientRect(),ratio=root.scrollTop/Math.max(1,root.scrollHeight-root.clientHeight);
    if(markdown.length>900000)return{mode,source:markdown,ratio,scrollRatio:ratio,at:performance.now()};
    const coarse=markdown.length>150000,entries=parseLocations(markdown);
    // Locate the visible caret/block before allocating per-character points.
    // Only that block is needed to carry an entry anchor into source mode.
    const bound=bindBlocks(entries,root,true,true),selection=getSelection();let anchor=null;
    const precise=block=>coarse?block:bindBlocks(entries,root,true,false,{intersectsNode:node=>node===block.node}).find(item=>item.ordinal===block.ordinal)||block;
    if(root.contains(selection.focusNode)&&selection.focusNode!==root){
      const rect=pointRect(selection.focusNode,selection.focusOffset);let block=closestBlock(bound,selection.focusNode);
      if(block&&inView(rect,viewport)){block=precise(block);const y=center(rect),x=rect.left;anchor={block,offset:offsetAtDOM(block,selection.focusNode,selection.focusOffset,{x,y}),y};}
    }
    if(!anchor){
      anchor=viewportAnchor(bound,root);
      if(anchor&&!coarse)anchor=viewportAnchor([precise(anchor.block)],root);
    }
    return anchor?{...anchor,mode,source:markdown,locations:entries,scrollRatio:ratio,at:performance.now()}:null;
  };
  const enterAt=entry=>{capturedEntry=null;if(entry){pendingEntry=entry;heldEntry=null;schedule();}};
  const releaseEntry=()=>{pendingEntry=null;heldEntry=null;};
  const cancelEntry=()=>{releaseEntry();capturedEntry=null;};
  // Toolbar/find commands and external document refreshes are new actions,
  // too. An entry anchor must not pull their explicit selection back later.
  listen(window,'pointerdown',cancelEntry,true);
  listen(window,'keydown',event=>{if(source.contains(event.target))cancelEntry();},true);
  const divider=installSplitResize(source,preview,{
    begin(){
      resizing=true;if(!refresh())return;
      const ratio=source.scrollTop/Math.max(1,source.scrollHeight-source.clientHeight);
      if(quality==='ratio')heldEntry={ratio,scrollRatio:ratio,caret:false};
      else{
        let anchor=driver==='preview'?viewportAnchor(blocks,preview):null;
        if(!anchor){
          const viewport=source.getBoundingClientRect(),y=viewport.top+viewport.height*.3;
          const hit=document.caretRangeFromPoint(viewport.left+Math.min(60,viewport.width/4),y);
          if(hit&&source.contains(hit.startContainer)){
            const offset=model.offset(hit.startContainer,hit.startOffset);anchor={offset,y:center(pointRect(hit.startContainer,hit.startOffset)),block:blockForOffset(offset)};
          }
        }
        if(anchor?.block)heldEntry={...anchor,source:model.text,locations,scrollRatio:ratio,caret:false};
      }
      pendingEntry=null;driver='entry';
    },
    change:schedule,
    end(){schedule();requestAnimationFrame(()=>{resizing=false;
      // 【MW4】拖完就放手：heldEntry 留着的话，下一次 schedule（预览异步重渲染、
      // resize、字体就绪都会再排一次同步）仍会走 maintainEntry，把两面拽回**拖动
      // 开始时**抓的锚点——用户眼里就是视口莫名回跳（程序滚动/跨 frame 翻页不
      // 经过 wheel/pointerdown 的释放路径，拦不住它）。等一帧让拖动的最后一次
      // 对齐先完成，再 releaseEntry；此后同步回到"跟随当前驱动面"的正常路径。
      releaseEntry();});}
  });
  const nativeHTML=editor.lute.Md2HTML;
  editor.lute.Md2HTML=function(markdown,...args){const html=nativeHTML.call(this,markdown,...args);if(enabled())lastHTMLSource=markdown;return html;};
  const nativeAfter=editor.preview.afterRender;
  editor.preview.afterRender=function(...args){const result=nativeAfter.apply(this,args);renderedSource=lastHTMLSource;dirty=true;schedule();return result;};
  const nativeRender=editor.preview.render;
  editor.preview.render=function(...args){const result=nativeRender.apply(this,args);updateActive();if(!api.getValue().trim()){renderedSource='';dirty=true;}schedule();return result;};
  const mutations=new MutationObserver(records=>{if(records.some(record=>!element(record.target)?.closest('.language-math')))dirty=true;schedule();});mutations.observe(content,{childList:true,subtree:true,characterData:true});
  const sourceMutations=new MutationObserver(()=>{modelDirty=true;schedule();});sourceMutations.observe(source,{childList:true,subtree:true,characterData:true});
  const modes=new MutationObserver(schedule);modes.observe(source,{attributes:true,attributeFilter:['style']});modes.observe(preview,{attributes:true,attributeFilter:['style']});
  const resize=new ResizeObserver(schedule);resize.observe(source);resize.observe(content);
  listen(document,'selectionchange',schedule);
  const sourceAction=()=>{releaseEntry();driver='source';viewportRequest=null;schedule();};
  listen(source,'click',sourceAction,true);listen(source,'pointerup',sourceAction,true);listen(source,'keydown',sourceAction,true);listen(source,'keyup',sourceAction,true);listen(source,'beforeinput',sourceAction,true);listen(source,'input',()=>{modelDirty=true;dirty=true;sourceAction();});
  for(const [pane,side] of [[source,'source'],[preview,'preview']]){
    listen(pane,'pointerdown',()=>{if(active){ignoredScroll.delete(pane);releaseEntry();driver=side;}},true);
    listen(pane,'scroll',event=>{
      if(event.target!==pane||!updateActive())return;
      event.stopImmediatePropagation();
      const top=pane.scrollTop,previous=observedScroll.get(pane);observedScroll.set(pane,top);
      // Mode changes and width reflow emit native scroll events before the
      // final content/selection is installed. Keep the captured entry anchor.
      if(resizing||pendingEntry||heldEntry&&driver==='entry')return;
      const expected=ignoredScroll.get(pane);ignoredScroll.delete(pane);
      if(Math.abs(top-(expected??-Infinity))<1||previous!=null&&Math.abs(top-previous)<.5)return;
      releaseEntry();driver=side;viewportRequest=side;schedule();
    },true);
    listen(pane,'wheel',event=>{if(!event.ctrlKey&&!event.metaKey&&Math.abs(event.deltaY)>Math.abs(event.deltaX)){ignoredScroll.delete(pane);releaseEntry();driver=side;}},{passive:true});
  }
  listen(content,'load',schedule,true);
  listen(content,'pointerdown',event=>{releaseEntry();driver='preview';gesture={x:event.clientX,y:event.clientY,dragged:false};},true);
  listen(content,'pointermove',event=>{if(gesture&&Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>4)gesture.dragged=true;},true);
  listen(content,'click',event=>{
    if(!updateActive()||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||gesture?.dragged)return;
    const selection=getSelection();if(!selection.isCollapsed&&content.contains(selection.anchorNode))return;
    if(!refresh(true))return;
    if(quality==='ratio')return;
    let target=element(event.target),block=blocks.filter(b=>b.node.contains(target)).sort((a,b)=>a.node.contains(b.node)?1:-1)[0];
    const toc=target.closest('[data-target-id]');
    if(toc){const heading=content.querySelector('#'+CSS.escape(toc.getAttribute('data-target-id')));block=blocks.find(b=>b.node===heading)||block;target=heading||target;}
    if(!block)return;
    let offset=block.start;
    const atom=target.closest(atomSelector),mapped=atom&&block.points.find(p=>p.node===atom);
    if(mapped){
      offset=mapped.unit.start;
      if(mapped.kind==='math'){
        const symbol=mappedMathNodeAtPoint(atom,event);
        if(symbol){const index=Number(symbol.dataset.typoraSourceStart);offset=mapped.unit.positions[index]??mapped.unit.start+index;}
      }
    }else{
      const hit=document.caretRangeFromPoint(event.clientX,event.clientY),points=hit&&block.nodePoints.get(hit.startContainer);
      if(points?.length){const point=points.reduce((a,b)=>Math.abs(b.nodeOffset-hit.startOffset)<Math.abs(a.nodeOffset-hit.startOffset)?b:a);offset=point.source;if(hit.startOffset>point.nodeOffset)offset+=hit.startOffset-point.nodeOffset;}
      else if(block.points.length){const point=block.points.reduce((a,b)=>Math.abs(center(pointRect(b.node,b.nodeOffset))-event.clientY)<Math.abs(center(pointRect(a.node,a.nodeOffset))-event.clientY)?b:a);offset=point.source;}
    }
    event.preventDefault();event.stopImmediatePropagation();gesture=null;driver='source';
    // A preview may still show the previous keystroke during its render delay.
    // Preserve the clicked occurrence while translating through that edit.
    if(!equivalent(model.text,locationSource)){
      const currentLocations=parseLocations(model.text);
      offset=translateLocation(locations,currentLocations,block,offset);
    }
    const [node,at]=model.point(offset);source.focus({preventScroll:true});getSelection().collapse(node,at);
    revealHorizontal({node,nodeOffset:at},source);
    align(source,source,pointRect(node,at),event.clientY);followSource();
  },true);
  const toggle=editor.toolbar.elements['source-toggle']?.querySelector('button');
  if(toggle)listen(toggle,'pointerdown',()=>{capturedEntry=captureVisual();},true);
  const sourceMode=editor.toolbar.elements['edit-mode']?.querySelector('button[data-mode="sv"]');
  if(sourceMode)listen(sourceMode,'click',()=>{if(editor.currentMode!=='sv'&&!pendingEntry)enterAt(captureVisual());},true);
  api.__splitNavigation={get active(){return active;},get blocks(){return blocks;},get source(){return renderedSource;},refresh,followSource,captureVisual,enterAt,cancelEntry,get quality(){return quality;},get stats(){return{...stats};},get anchor(){return lastAnchor;}};
  if(enabled())editor.preview.render(editor);
  document.fonts?.ready.then(()=>{if(!disposed)schedule();});
  return ()=>{
    disposed=true;cancelAnimationFrame(frame);clearTimeout(timer);divider.destroy();mutations.disconnect();sourceMutations.disconnect();modes.disconnect();resize.disconnect();listeners.forEach(remove=>remove());restore();
    editor.lute.Md2HTML=nativeHTML;editor.preview.afterRender=nativeAfter;editor.preview.render=nativeRender;delete api.__splitNavigation;
  };
}
