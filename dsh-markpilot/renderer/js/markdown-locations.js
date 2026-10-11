// Locations for Lute's own syntax tree. Offsets are UTF-16, like DOM Range.
// Parsing and navigation use the same Markdown dialect; rendered text is never
// searched globally (identical paragraphs and empty cells remain distinct).
// Lute 的每个文本节点都带 base64 载荷。复用同一个 TextDecoder、避开
// Uint8Array.from 的回调式构造：实测这一步只占解析总时 ~20ms（大头是
// RenderJSON 本身），但逐节点新建解码器没有理由留着。
const utf8 = new TextDecoder();
const decode64 = value => {
  if (!value) return '';
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return utf8.decode(bytes);
};
const visible = new Set(['NodeText','NodeLinkText','NodeCodeSpanContent','NodeBackslashContent']);
export function tableCells(line, start = 0) {
  const pipes=[];
  for(let i=0;i<line.length;i++) if(line[i]==='|') {
    let escapes=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)escapes++;
    if(!(escapes%2))pipes.push(i);
  }
  const edges=[-1,...pipes,line.length],cells=[];
  for(let i=0;i<edges.length-1;i++){
    let a=edges[i]+1,b=edges[i+1];
    if((i===0||i===edges.length-2)&&!line.slice(a,b).trim())continue;
    while(a<b&&/[ \t]/.test(line[a]))a++;
    while(b>a&&/[ \t]/.test(line[b-1]))b--;
    cells.push({start:start+a,end:start+b});
  }
  return cells;
}

export function markdownLocations(source, tree, {coarse=false} = {}) {
  const blocks=[],footnotes=[];let cursor=0,limit=source.length,current=null;
  const consume = text => {
    text=String(text||'');if(!text)return [];
    const exact=source.indexOf(text,cursor);
    if(exact>=0&&exact+text.length<=limit){cursor=exact+text.length;return coarse?[exact,cursor-1]:Array.from({length:text.length},(_,i)=>exact+i);}
    // Quote/list prefixes and escaped pipes can interrupt a parser text token.
    const positions=[];let at=cursor;
    const record=position=>{if(!coarse||!positions.length)positions.push(position);else positions[1]=position;};
    for(let i=0;i<text.length;i++){
      const found=source.indexOf(text[i],at);
      if(found<0||found>=limit){record(Math.max(cursor,Math.min(limit,at)));continue;}
      record(found);at=found+1;
    }
    cursor=Math.min(limit,at);return positions;
  };
  const add=(kind,text,positions,extra={})=>{
    if(!current)return;
    const start=positions[0]??cursor,end=positions.length?positions.at(-1)+1:start;
    current.units.push({kind,text,positions,start,end,...extra});
  };
  const block=(kind,node,fn,range)=>{
    const parent=current,entry={kind,start:range?.start??cursor,end:range?.end??cursor,units:[]};
    current=entry;fn();current=parent;
    if(!range){entry.start=entry.units[0]?.start??entry.start;entry.end=Math.max(cursor,entry.units.at(-1)?.end??entry.start);}
    blocks.push(entry);return entry;
  };
  const children=node=>{for(const child of node.Children||[])visit(child);};
  const visit=node=>{
    const type=node.Type,data=node.Data||'';
    if(type==='NodeDocument'){children(node);return;}
    if(type==='NodeTable'){
      const start=source.indexOf(data,cursor),base=start>=0?start:cursor;
      const lines=data.split('\n'),starts=[];let pos=base;
      for(const line of lines){starts.push(pos);pos+=line.length+1;}
      const rows=[];for(const child of node.Children||[])if(child.Type==='NodeTableHead')rows.push(...child.Children);else if(child.Type==='NodeTableRow')rows.push(child);
      const outerLimit=limit;
      rows.forEach((row,index)=>{
        const line=index?index+1:0,ranges=tableCells(lines[line]||'',starts[line]??base);
        (row.Children||[]).forEach((cell,i)=>{
          const range=ranges[i]||{start:starts[line]??base,end:starts[line]??base};
          cursor=range.start;limit=range.end;block('cell',cell,()=>children(cell),range);
        });
      });
      cursor=base+data.length;limit=outerLimit;return;
    }
    if(type==='NodeParagraph'||type==='NodeHeading'){
      block(type==='NodeHeading'?'heading':'paragraph',node,()=>children(node));
      if(node.HeadingSetext){const end=source.indexOf('\n',cursor);if(end>=0){const underline=/^\n[ \t]*[=-]+[ \t]*(?:\n|$)/.exec(source.slice(end));if(underline)cursor=end+underline[0].length;}}
      return;
    }
    if(type==='NodeCodeBlock'||type==='NodeMathBlock'){
      block(type==='NodeMathBlock'?'math':'code',node,()=>children(node));return;
    }
    if(type==='NodeInlineMathContent'||type==='NodeMathBlockContent'){
      add('math',data,consume(data));return;
    }
    if(type==='NodeCodeBlockCode'){add('text',data,consume(data));return;}
    if(type==='NodeInlineMathOpenMarker'||type==='NodeInlineMathCloseMarker'){consume('$');return;}
    if(type==='NodeMathBlockOpenMarker'||type==='NodeMathBlockCloseMarker'){consume('$$');return;}
    if(type==='NodeCodeBlockFenceInfoMarker'){consume(decode64(node.CodeBlockInfo));return;}
    if(type==='NodeHTMLEntity'){
      const positions=consume(decode64(node.HtmlEntityTokens)||data);add('text',data,Array.from({length:data.length},()=>positions[0]??cursor),{end:cursor,entity:true});return;
    }
    if(type==='NodeBackslash'){consume('\\');children(node);return;}
    if(type==='NodeImage'){
      const start=cursor,old=current;current=null;children(node);current=old;
      const label=(node.Children||[]).filter(n=>n.Type==='NodeLinkText').map(n=>n.Data||'').join('');
      add('image',label,[start],{end:cursor});return;
    }
    if(type==='NodeLink'&&node.LinkType===3){
      for(const child of node.Children||[]){if(child.Type==='NodeOpenParen')break;visit(child);}
      const tail=/^\[[^\]\n]*\]/.exec(source.slice(cursor));if(tail)cursor+=tail[0].length;return;
    }
    if(type==='NodeLinkRefDefBlock'){
      for(const definition of node.Children||[]){
        consume('['+(definition.Data||'')+']:');
        const end=source.indexOf('\n',cursor);cursor=end<0?source.length:end;
      }
      return;
    }
    if(type==='NodeFootnotesDefBlock'){
      const before=blocks.length;children(node);footnotes.push(...blocks.splice(before));return;
    }
    if(type==='NodeFootnotesDef'){consume('['+data+']:');children(node);return;}
    if(type==='NodeFootnotesRef'){
      const locations=consume('['+data+']');add('text',node.FootnotesRefId||'1',[locations[0]??cursor]);return;
    }
    if(type==='NodeHTMLBlock'){
      const locations=consume(data);blocks.push({kind:'html',start:locations[0]??cursor,end:cursor,units:[{kind:'html',text:data,positions:locations,start:locations[0]??cursor,end:cursor}]});return;
    }
    if(type==='NodeInlineHTML'){
      const positions=consume(data);if(/^<br\s*\/?\s*>$/i.test(data))add('text','\n',[positions[0]??cursor]);return;
    }
    if(type==='NodeThematicBreak'){const positions=consume(data||'---');blocks.push({kind:'rule',start:positions[0]??cursor,end:cursor,units:[]});return;}
    if(type==='NodeToC'){const positions=consume(data||'[toc]');blocks.push({kind:'toc',start:positions[0]??cursor,end:cursor,units:[]});return;}
    if(type==='NodeTaskListItemMarker'){const positions=consume(data);add('checkbox','',[positions[0]??cursor]);return;}
    if(type==='NodeSoftBreak'||type==='NodeHardBreak'){const positions=consume('\n');add('text','\n',positions);return;}
    if(visible.has(type)){add('text',data,consume(data));return;}
    if(data)consume(data);
    children(node);
  };
  visit(tree);blocks.push(...footnotes);return blocks;
}
