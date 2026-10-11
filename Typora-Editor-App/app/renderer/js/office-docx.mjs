import {zip,strToU8} from './vendor/fflate.mjs';
import {officeMath} from './office-math.mjs';
const xml=value=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const NS='http://schemas.openxmlformats.org/';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const toBytes=url=>{const data=atob(url.slice(url.indexOf(',')+1));return Uint8Array.from(data,c=>c.charCodeAt(0));};
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
const PNG='image/png';
async function pngOf(img){
  const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  if(!canvas.width||!canvas.height||canvas.width*canvas.height>60000000)throw new Error('图片尺寸过大或无法解码');
  canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL(PNG);
}
export async function generateDocx(article,title,{initialWarnings=[]}={}){
  const warnings=[...initialWarnings],files={},relations=[],mathCache=new Map(),media=new Map(),mimeTypes=new Map(),numberings=[];
  let drawingId=0,formulaCount=0,editableFormulas=0,paragraphs=0,imageCount=0,tableCount=0;
  const relation=(type,target,external=false)=>{const id='rId'+(relations.length+1);relations.push({id,type,target,external});return id;};
  const rPr=style=>'<w:rPr>'+ (style.bold?'<w:b/>':'')+(style.italic?'<w:i/>':'')+(style.underline?'<w:u w:val="single"/>':'')+(style.strike?'<w:strike/>':'')+(style.code?'<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>':'')+(style.sub?'<w:vertAlign w:val="subscript"/>':'')+(style.sup?'<w:vertAlign w:val="superscript"/>':'')+'</w:rPr>';
  const run=(text,style={})=>String(text).split(/(\n|\t)/).filter(Boolean).map(part=>'<w:r>'+rPr(style)+(part==='\n'?'<w:br/>':part==='\t'?'<w:tab/>':'<w:t xml:space="preserve">'+xml(part)+'</w:t>')+'</w:r>').join('');
  const image=async img=>{
    imageCount++;let source=img.src,mime=/^data:([^;]+);base64,/.exec(source)?.[1];
    if(!mime){warnings.push('图片未内嵌，保留说明：'+(img.alt||''));return run('[图片未能嵌入：'+(img.alt||'')+']');}
    try{
      const original=toBytes(source),key=await hash(original);let item=media.get(key);
      if(!item){
        let extension={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/bmp':'bmp','image/svg+xml':'svg'}[mime];
        if(!extension){
          const originalExt=mime.split('/')[1].replace(/[^a-z0-9]/g,'')||'bin';files['word/media/original-'+key+'.'+originalExt]=original;mimeTypes.set(originalExt,mime);
          source=await pngOf(img);mime=PNG;extension='png';warnings.push('图片转为无损 PNG 以兼容 Word，并在 DOCX 内保留原文件：'+(img.alt||originalExt));
        }
        const name='image-'+key+'.'+extension;files['word/media/'+name]=toBytes(source);mimeTypes.set(extension,mime);
        const id=relation('image','media/'+name);item={id};
        if(extension==='svg'){
          try{const fallbackName='preview-'+key+'.png';files['word/media/'+fallbackName]=toBytes(await pngOf(img));mimeTypes.set('png',PNG);item={id:relation('image','media/'+fallbackName),svgId:id};}
          catch{warnings.push('此 SVG 未生成旧版 Office 预览；已保留矢量图：'+img.alt);}
        }
        media.set(key,item);
      }
      const natural=img.naturalWidth||640,naturalH=img.naturalHeight||320;
      const requested=Number(img.getAttribute('width'))||natural,width=Math.min(624,requested),height=width*naturalH/natural;
      const cx=Math.max(1,Math.round(width*9525)),cy=Math.max(1,Math.round(height*9525)),id=++drawingId;
      const extension=item.svgId?'<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="'+item.svgId+'"/></a:ext></a:extLst>':'';
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="图片 ${id}" descr="${xml(img.alt||'')}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${NS}drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(img.alt||'图片')}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${item.id}">${extension}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }catch(error){warnings.push('图片保留为说明：'+(img.alt||'')+'（'+error.message+'）');return run('[图片：'+(img.alt||'无法解码')+']');}
  };
  const inline=async(node,style={})=>{
    if(node.nodeType===3)return run(node.textContent,style);
    if(node.nodeType!==1)return '';
    const tag=node.localName;
    if(node.matches('.language-math')){
      formulaCount++;const math=node.querySelector('math');
      if(math){try{
        const source=math.outerHTML;let omml=mathCache.get(source);if(!omml){omml=officeMath(math);if(!/<m:oMath[\s>]/.test(omml)||new DOMParser().parseFromString(omml,'application/xml').querySelector('parsererror'))throw new Error('无效的 Office 公式');mathCache.set(source,omml);}editableFormulas++;return omml;
      }catch(error){warnings.push('公式保留 LaTeX 源码：'+(node.dataset.latex||node.textContent).slice(0,120));}}
      return run(node.dataset.latex||node.textContent,{code:true});
    }
    if(tag==='img')return image(node);
    if(tag==='br')return '<w:r><w:br/></w:r>';
    if(tag==='input')return run(node.checked?'☑ ':'☐ ');
    const next={...style,bold:style.bold||['b','strong','th'].includes(tag),italic:style.italic||['i','em'].includes(tag),underline:style.underline||tag==='u',strike:style.strike||['s','del'].includes(tag),sub:style.sub||tag==='sub',sup:style.sup||tag==='sup',code:style.code||tag==='code'};
    let text='';for(const child of node.childNodes)text+=await inline(child,next);
    if(tag==='a'&&/^https?:|^mailto:/i.test(node.getAttribute('href')||'')){const id=relation('hyperlink',node.getAttribute('href'),true);return '<w:hyperlink r:id="'+id+'">'+text+'</w:hyperlink>';}
    return text;
  };
  const pPr=({heading,quote,list,code,align}={})=>'<w:pPr>'+(heading?`<w:pStyle w:val="Heading${heading}"/><w:keepNext/>`:'')+(quote?'<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="8" w:color="B7B7B7" w:space="8"/></w:pBdr>':'')+(list?`<w:numPr><w:ilvl w:val="${Math.min(8,list.level)}"/><w:numId w:val="${list.id}"/></w:numPr>`:'')+(code?'<w:shd w:fill="F5F5F5"/><w:spacing w:after="80"/>':'')+(align&&align!=='left'?`<w:jc w:val="${align}"/>`:'')+'</w:pPr>';
  const paragraph=async(node,options={})=>{paragraphs++;if(paragraphs%32===0)await tick();
    // v2.0.7：图片对齐导出——图片独占的块把 data-typora-align 映射成 w:jc。
    if(!options.align){const img=node.querySelector?.('img[data-typora-align]');if(img&&!node.textContent.trim())options={...options,align:img.getAttribute('data-typora-align')};}
    return '<w:p>'+pPr(options)+await inline(node,options.code?{code:true}:{})+'</w:p>';};
  const table=async node=>{
    tableCount++;const rows=[...node.rows],columns=Math.max(1,...rows.map(row=>[...row.cells].reduce((n,cell)=>n+(cell.colSpan||1),0))),width=Math.floor(9360/columns),active=[];let content='';
    for(const row of rows){let col=0,cells='';const add=async(cell,span,merge)=>{
      const props=`<w:tcW w:w="${width*span}" w:type="dxa"/>`+(span>1?`<w:gridSpan w:val="${span}"/>`:'')+(merge?`<w:vMerge${merge==='restart'?' w:val="restart"':''}/>`:'')+(cell?.localName==='th'?'<w:shd w:fill="EAEFF4"/>':'');
      cells+='<w:tc><w:tcPr>'+props+'</w:tcPr>'+(cell?await blocks(cell):'<w:p/>')+'</w:tc>';
    };
    const carry=async()=>{while(active[col]?.remaining>0){const item=active[col];await add(null,item.span,'continue');item.remaining--;col+=item.span;}};
    for(const cell of row.cells){await carry();const span=cell.colSpan||1,rowspan=cell.rowSpan||1;await add(cell,span,rowspan>1?'restart':null);if(rowspan>1)active[col]={span,remaining:rowspan-1};col+=span;}await carry();content+='<w:tr><w:trPr>'+(row.parentElement?.localName==='thead'?'<w:tblHeader/>':'')+'</w:trPr>'+cells+'</w:tr>';
    }
    const borders=['top','left','bottom','right','insideH','insideV'].map(side=>`<w:${side} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>'+borders+'</w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>'+Array.from({length:columns},()=>`<w:gridCol w:w="${width}"/>`).join('')+'</w:tblGrid>'+content+'</w:tbl><w:p/>';
  };
  const blocks=async(container,options={})=>{
    let out='',pending=[];
    const flush=async()=>{if(!pending.length)return;const span=document.createElement('span');for(const node of pending)span.append(node.cloneNode(true));pending=[];if(span.textContent.trim()||span.querySelector('img,.language-math'))out+=await paragraph(span,options);};
    for(const node of container.childNodes){
      if(node.nodeType!==1){pending.push(node);continue;}
      const tag=node.localName;
      if(!/^(p|div|h[1-6]|table|ul|ol|li|blockquote|pre|hr|section|details|summary)$/.test(tag)){pending.push(node);continue;}
      await flush();
      if(tag==='table')out+=await table(node);
      else if(tag==='ul'||tag==='ol'){const list={id:numberings.length+1,ordered:tag==='ol',level:(options.list?.level??-1)+1,start:Number(node.getAttribute('start'))||1};numberings.push(list);for(const li of node.children)if(li.localName==='li')out+=await blocks(li,{...options,list});}
      else if(tag==='blockquote')out+=await blocks(node,{...options,quote:true});
      else if(tag==='hr')out+='<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:color="B7B7B7"/></w:pBdr></w:pPr></w:p>';
      else if(node.matches('.language-math'))out+=await paragraph(node,options);
      else if(/^h[1-6]$/.test(tag))out+=await paragraph(node,{...options,heading:tag.slice(1)});
      else if(tag==='pre')out+=await paragraph(node,{...options,code:true});
      else if(tag==='p'||tag==='summary')out+=await paragraph(node,options);
      else out+=await blocks(node,options);
    }
    await flush();return out||'<w:p/>';
  };
  const body=await blocks(article);
  relation('styles','styles.xml');relation('numbering','numbering.xml');relation('settings','settings.xml');
  files['word/document.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${NS}wordprocessingml/2006/main" xmlns:r="${NS}officeDocument/2006/relationships" xmlns:m="${NS}officeDocument/2006/math" xmlns:wp="${NS}drawingml/2006/wordprocessingDrawing" xmlns:a="${NS}drawingml/2006/main" xmlns:pic="${NS}drawingml/2006/picture" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1273" w:bottom="1080" w:left="1273" w:header="600" w:footer="600"/></w:sectPr></w:body></w:document>`);
  files['word/styles.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${NS}wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1,2,3,4,5,6].map(level=>`<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="120"/><w:outlineLvl w:val="${level-1}"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="${[32,28,25,24,23,22][level-1]}"/></w:rPr></w:style>`).join('')}</w:styles>`);
  const abstracts=[1,2].map(id=>`<w:abstractNum w:abstractNumId="${id}">${Array.from({length:9},(_,level)=>`<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${id===1?'bullet':'decimal'}"/><w:lvlText w:val="${id===1?'•':'%'+(level+1)+'.'}"/><w:pPr><w:ind w:left="${(level+1)*360}" w:hanging="240"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>`).join('');
  const numbers=numberings.map(list=>`<w:num w:numId="${list.id}"><w:abstractNumId w:val="${list.ordered?2:1}"/><w:lvlOverride w:ilvl="${Math.min(8,list.level)}"><w:startOverride w:val="${list.start}"/></w:lvlOverride></w:num>`).join('');
  files['word/numbering.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${NS}wordprocessingml/2006/main">${abstracts}${numbers}</w:numbering>`);
  files['word/settings.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="${NS}wordprocessingml/2006/main" xmlns:m="${NS}officeDocument/2006/math"><w:doNotAutoCompressPictures/><m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr></w:settings>`);
  const rels=items=>'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="'+NS+'package/2006/relationships">'+items.map(item=>`<Relationship Id="${item.id}" Type="${NS}officeDocument/2006/relationships/${item.type}" Target="${xml(item.target)}"${item.external?' TargetMode="External"':''}/>`).join('')+'</Relationships>';
  files['word/_rels/document.xml.rels']=strToU8(rels(relations));files['_rels/.rels']=strToU8(rels([{id:'rId1',type:'officeDocument',target:'word/document.xml'}]));
  files['[Content_Types].xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...mimeTypes].map(([ext,mime])=>`<Default Extension="${ext}" ContentType="${mime}"/>`).join('')}${[['document','document.main'],['styles','styles'],['numbering','numbering'],['settings','settings']].map(([name,type])=>`<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`).join('')}</Types>`);
  const bytes=await new Promise((resolve,reject)=>zip(files,{level:6},(error,data)=>error?reject(error):resolve(data)));
  // 产物上限 150,000,000 字节，与宿主侧（VSIX office-export.cjs / EXE export.js）的
  // 200,000,000 base64 字符是同一预算（base64 长度 = 字节数 ×4/3，两者判定等价）：
  // 超限在打包完成点即拒绝，避免白做 base64 巨串与跨进程传输。
  if(bytes.length>150000000)throw new Error('Word 导出数据无效或过大');
  return{bytes,warnings:[...new Set(warnings)],counts:{formulas:formulaCount,editableFormulas,images:imageCount,tables:tableCount,paragraphs},title};
}
export function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
