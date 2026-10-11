'use strict';
// An in-memory Markdown heading index. No DOM work, file scan, or API request.
// Offsets use normalized LF / UTF-16, like the exact Webview source needle.
const LIMIT=1200;
function parseHeadings(source) {
  const text=String(source).replace(/\r\n?/g,'\n'),headings=[],parents=[],definitions=[];
  let definitionFence=null;
  const definition=(line,offset)=>{
    const quoted=line.replace(/^ {0,3}(?:> ?)+/,'').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(quoted){if(!definitionFence)definitionFence=quoted[1];else if(quoted[1][0]===definitionFence[0]&&quoted[1].length>=definitionFence.length&&!quoted[2].trim())definitionFence=null;return;}
    if(definitionFence||line.includes('`')||line.length>320||line.length<8||!/\$|\\[A-Za-z]/.test(line)||/修正|建议|存疑|🔧|配置关系|<!--|<script|\|/.test(line))return;
    if(/定义|(?:^|[>\s])记\s|记为|终值|终端|遗赠|初值|其中|维数|协方差|概率.*[：:]|:=|\\coloneqq/.test(line))definitions.push({offset,end:offset+line.length,text:line.trim()});
  };
  let fence=null,math=false,comment=false,html=null,front=false,previous=null,offset=0;
  const add=(level,title,start)=>{
    while(parents.length&&headings[parents.at(-1)].level>=level)parents.pop();
    const item={level,title:title.trim().replace(/[\u0000-\u001f]/g,' ').slice(0,160),offset:start,parent:parents.at(-1)??-1};
    headings.push(item);parents.push(headings.length-1);
  };
  for(const line of text.split('\n')) {
    const at=offset;offset+=line.length+1;
    if(at===0&&/^\uFEFF?---\s*$/.test(line)){front=true;continue;}
    if(front){if(/^(?:---|\.\.\.)\s*$/.test(line))front=false;continue;}
    if(fence){const closing=line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);if(closing&&closing[1][0]===fence[0]&&closing[1].length>=fence.length)fence=null;continue;}
    if(math){if(/^ {0,3}\$\$\s*$/.test(line))math=false;else definition(line,at);continue;}
    if(comment){if(line.includes('-->'))comment=false;previous=null;continue;}
    if(line.includes('<!--')){comment=!line.includes('-->',line.indexOf('<!--')+4);previous=null;continue;}
    if(html){if(new RegExp('</'+html+'\\s*>','i').test(line))html=null;previous=null;continue;}
    const block=line.match(/^ {0,3}<(pre|script|style|textarea)(?:\s|>)/i);
    if(block){if(!new RegExp('</'+block[1]+'\\s*>','i').test(line))html=block[1];previous=null;continue;}
    if(/^ {0,3}\$\$\s*$/.test(line)){math=!math;previous=null;continue;}
    const opening=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(opening&&!(opening[1][0]==='`'&&opening[2].includes('`'))){fence=opening[1];previous=null;continue;}
    if(!/^(?: {4}|\t| {0,3}#)/.test(line))definition(line,at);
    const atx=line.replace(/^\uFEFF/,'').match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/);
    if(atx){add(atx[1].length,(atx[2]||'').replace(/[ \t]+#+[ \t]*$/,''),at);previous=null;continue;}
    const setext=line.match(/^ {0,3}(=+|-+)\s*$/);
    if(previous&&setext){add(setext[1][0]==='='?1:2,previous.text,previous.offset);previous=null;continue;}
    // Setext only follows a plain paragraph, not list/quote/indented code or HTML.
    if(!line.trim()||/^(?: {4}|\t| {0,3}(?:>|[-+*]\s|\d+[.)]\s|<|\[.+\]:))/.test(line)||setext)previous=null;
    else if(previous)previous.text+=' '+line.trim();
    else previous={text:line.trim(),offset:at};
    if(previous&&previous.text.length>512)previous.text=previous.text.slice(0,512);
  }
  return {text,headings,definitions};
}

// Reuse the existing in-memory index. Only literal, short definitions from the
// same chapter are eligible; no model call, guessed identity, or math rewrite.
function notationAt(index,position,context={}) {
  if(context.kind!=='math')return '';
  const local=String(context.before||'').slice(-4000)+'\n'+String(context.after||'').slice(0,1000)+'\n'+String(context.nearby||'').slice(0,1800);
  const ignored=new Set(['\\frac','\\nabla','\\partial','\\boxed','\\left','\\right','\\text','\\begin','\\end','\\mathbb','\\mathcal','\\mathrm','\\color','\\top','\\in','\\sum','\\int','\\sup','\\max','\\cdot','\\times','\\qquad','\\quad','x','t','u','i','j','n','d','z']);
  const symbols=value=>new Set((String(value).match(/\\[A-Za-z]+|[A-Za-z]+/g)||[]).filter(s=>(s[0]==='\\'||s.length===1)&&!ignored.has(s)));
  const left=String(context.mathBefore||'').slice(-1800),wanted=symbols(left+String(context.mathAfter||'').slice(0,1200));
  const preceding=String(context.before||'').slice(-180),terminal=/终值|终端|遗赠/.test(preceding),node=/节点|场景/.test(preceding);
  const lhs=left.match(/((?:\\[A-Za-z]+|[A-Za-z])(?:[_^](?:\{[^{}\n]+\}|[A-Za-z0-9*]))*)\s*(?::=|=)\s*$/)?.[1];
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(!wanted.size&&!terminal&&!node)return '';
  let start=Math.max(0,position-24000),end=Math.min(index.text.length,position+4000),chapter;
  for(const h of index.headings){if(h.offset>position)break;if(h.level<=2)chapter=h;}
  if(chapter){start=Math.max(start,chapter.offset);const next=index.headings.find(h=>h.offset>position&&h.level<=chapter.level);if(next)end=Math.min(end,next.offset);}
  const ranked=[];
  for(const d of index.definitions||[]){
    if(d.offset<start||d.offset>=end||d.offset<=position&&position<=d.end||local.includes(d.text))continue;
    const found=symbols(d.text),shared=[...wanted].filter(s=>found.has(s)),matches=shared.length,topic=terminal&&/终值|终端|遗赠/.test(d.text)||node&&/节点|场景/.test(d.text);
    if(!matches&&!topic)continue;
    const exact=lhs&&new RegExp(escape(lhs)+'\\s*(?::=|=)').test(d.text);
    const declared=shared.some(s=>new RegExp(escape(s)+'(?:[_^](?:\\{[^{}\\n]+\\}|[A-Za-z0-9*]))*(?:\\([^()=$]{0,32}\\))?\\s*:=').test(d.text));
    ranked.push({...d,exact,score:matches*2+(topic?(node?16:8):0)+(exact?16:0)+(declared?8:0)-d.text.length/160-Math.abs(d.offset-position)/24000});
  }
  ranked.sort((a,b)=>b.score-a.score||a.offset-b.offset);
  const selected=[];let size=0;
  for(const d of ranked){if(selected.includes(d.text)||size+d.text.length>480)continue;selected.push(d.text);size+=d.text.length+1;if(d.exact||selected.length===2)break;}
  return selected.length?'DEFINITIONS (literal excerpts):\n'+selected.join('\n'):'';
}
function sectionAt(index,position) {
  const {headings}=index;if(!headings.length)return '';
  let lo=0,hi=headings.length;
  while(lo<hi){const middle=(lo+hi)>>>1;if(headings[middle].offset<=position)lo=middle+1;else hi=middle;}
  const current=lo-1,path=[];
  for(let i=current;i>=0;i=headings[i].parent)path.unshift(i);
  const lines=[],included=new Set();
  const add=(i,label)=>{if(i<0||i>=headings.length||included.has(i))return;included.add(i);const h=headings[i];lines.push(label+' '+ '#'.repeat(h.level)+' '+h.title);};
  // The ancestry is more useful than a large flat document TOC.
  path.forEach(i=>add(i,i===current?'CURRENT':'PARENT'));
  if(current<0)headings.slice(0,3).forEach((_,i)=>add(i,'NEXT'));
  else {
    // At most one previous sibling and the nearest two following headings.
    for(let i=current-1;i>=0;i--){if(headings[i].level<headings[current].level)break;if(headings[i].parent===headings[current].parent){add(i,'PREVIOUS');break;}}
    add(current+1,'NEXT');add(current+2,'NEXT');
  }
  return lines.join('\n').slice(0,LIMIT);
}
class StructureCache {
  constructor(document){this.version=null;this.index=null;this.builds=0;this.refresh(document);}
  refresh(document) {
    if(this.index&&this.version===document.version)return;
    this.index=parseHeadings(document.getText());this.version=document.version;this.builds++;
  }
  forRequest(document,request) {
    this.refresh(document);
    const {needle,caret}=request;
    if(typeof needle!=='string'||!needle||needle.length>32000||!Number.isInteger(caret)||caret<0||caret>needle.length)return '';
    const start=this.index.text.indexOf(needle);
    // Ambiguous source locations retain the original local context only.
    if(start<0||this.index.text.indexOf(needle,start+1)>=0)return '';
    const position=start+caret,section=sectionAt(this.index,position);
    const notation=notationAt(this.index,position,request.aiContext||{});
    return notation&&section.length+notation.length+1<=LIMIT?section+'\n'+notation:section;
  }
  dispose(){this.index=null;}
}
module.exports={LIMIT,parseHeadings,sectionAt,notationAt,StructureCache};
