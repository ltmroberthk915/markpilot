import {prepareMathMarkdown} from './math-markdown.js';
import {generateDocx,base64} from './office-docx.mjs';
prepareMathMarkdown();
const root=new URL('../',import.meta.url),article=document.querySelector('#content'),warnings=[];
const load=file=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=new URL(file,root).href;script.onload=resolve;script.onerror=()=>reject(new Error('无法加载 Word 导出资源'));document.head.append(script);});
const allowed=new Set('a p div span br hr h1 h2 h3 h4 h5 h6 blockquote pre code strong b em i s del u sub sup mark small kbd ul ol li dl dt dd table thead tbody tfoot tr th td caption img input details summary section nav'.split(' '));
const attrs=new Set('id class title alt width height colspan rowspan align start value reversed checked type href data-typora-align'.split(' '));
export function sanitize(html){
  const template=document.createElement('template');template.innerHTML=html;
  for(const node of template.content.querySelectorAll('*')){
    if(!allowed.has(node.localName)){node.remove();continue;}
    if(node.localName==='img'){node.dataset.exportSrc=node.getAttribute('src')||'';node.removeAttribute('src');}
    for(const attr of [...node.attributes])if(!attrs.has(attr.name)&&!(node.localName==='img'&&attr.name==='data-export-src'))node.removeAttribute(attr.name);
    if(node.hasAttribute('href')&&!/^(?:https?:|mailto:|#)/i.test(node.getAttribute('href')))node.removeAttribute('href');
    if(node.localName==='input'){node.type='checkbox';node.disabled=true;}
  }return template.content;
}
window.prepareWord=async({text,title})=>{
  const start=performance.now();document.title=title;warnings.length=0;
  const html=await Vditor.md2html(text,{cdn:new URL('cdn/vditor',root).href,markdown:{toc:true},math:{inlineDigit:true}});article.replaceChildren(sanitize(html));
  const formulas=[...article.querySelectorAll('.language-math')];
  if(formulas.length){await load('cdn/vditor/dist/js/katex/katex.min.js');await load('cdn/vditor/dist/js/katex/mhchem.min.js');const macros={};
    for(let i=0;i<formulas.length;i++){const node=formulas[i],source=node.textContent;node.dataset.latex=source;
      try{node.innerHTML=katex.renderToString(source,{output:'mathml',displayMode:node.tagName==='DIV',macros,throwOnError:true,trust:false});}
      catch{warnings.push('公式暂不支持转换，保留源码：'+source.slice(0,100));}
      if(i%32===31)await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  const diagrams=[...article.querySelectorAll('.language-mermaid')];
  if(diagrams.length){await load('cdn/vditor/dist/js/mermaid/mermaid.min.js');mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default'});
    for(let i=0;i<diagrams.length;i++){
      const code=diagrams[i];try{const result=await mermaid.render('word-diagram-'+i,code.textContent),template=document.createElement('template');template.innerHTML=result.svg;const svg=template.content.firstElementChild,view=svg.getAttribute('viewBox')?.split(/\s+/).map(Number);if(view){svg.setAttribute('width',view[2]);svg.setAttribute('height',view[3]);}const img=document.createElement('img');img.alt='Mermaid 图表';img.dataset.exportSrc='data:image/svg+xml;base64,'+base64(new TextEncoder().encode(svg.outerHTML));(code.parentElement.tagName==='PRE'?code.parentElement:code).replaceWith(img);}catch{warnings.push('图表无法转换，已保留 Mermaid 源码');}
    }
  }
  return{images:[...article.querySelectorAll('img')].map(img=>img.dataset.exportSrc),formulas:formulas.length,diagrams:diagrams.length,prepareMs:performance.now()-start};
};
window.finishWord=async({assets={},assetWarnings=[]}={})=>{
  for(const img of article.querySelectorAll('img')){const src=img.dataset.exportSrc;delete img.dataset.exportSrc;img.src=assets[src]||(src?.startsWith('data:')?src:'');if(!img.src)warnings.push('图片未嵌入：'+(img.alt||''));}
  await Promise.all([...article.querySelectorAll('img')].map(img=>img.decode().catch(()=>warnings.push('图片无法解码：'+img.alt))));
  const start=performance.now(),result=await generateDocx(article,document.title,{initialWarnings:[...warnings,...assetWarnings]});
  return{data:base64(result.bytes),warnings:result.warnings,counts:result.counts,packMs:performance.now()-start};
};
// The plugin uses an isolated frame; desktop calls the same functions in an
// invisible, dedicated renderer. Only our parent can drive this frame.
window.addEventListener('message',async event=>{
  if(event.source!==parent||parent===window||event.data?.scope!=='typora-office')return;
  const {id,action,payload}=event.data;try{const result=action==='prepare'?await window.prepareWord(payload):action==='finish'?await window.finishWord(payload):null;parent.postMessage({scope:'typora-office',id,action,result},'*');}catch(error){parent.postMessage({scope:'typora-office',id,action,error:error.message},'*');}
});
