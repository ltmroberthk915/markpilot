
// Export and SaveAs consume the same source grammar. A code atom wins by its
// position, so examples inside code never become file-system dependencies.
export const inlineImageAtoms = () => /`([^`]+)`|<img\b[^>]*>|!\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))(?:\s+["'][^"']*["'])?\)/gi;
export const decodeImageAttribute = value => String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>' }, lower = entity.toLowerCase();
  if (named[lower] != null) return named[lower];
  const number = lower.startsWith('&#x') ? parseInt(lower.slice(3),16) : parseInt(lower.slice(2),10);
  return number > 0 && number <= 0x10ffff && (number < 0xd800 || number > 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
});
import { parser } from '@lezer/markdown';
const punctuation = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g;
export const decodeMarkdownDestination = source => decodeImageAttribute(source.replace(punctuation,'$1'));

function htmlImages(source, from, to, output) {
  let at=from;
  while(at<to){
    const open=source.indexOf('<',at);if(open<0||open>=to)break;
    if(source.startsWith('<!--',open)){const end=source.indexOf('-->',open+4);at=end<0?to:end+3;continue;}
    const name=/^<(\/?)\s*([a-z][\w:-]*)\b/i.exec(source.slice(open,Math.min(open+100,to)));
    if(!name){at=open+1;continue;}
    let end=open+name[0].length,quote='';
    for(;end<to;end++){
      const ch=source[end];
      if(quote){if(ch===quote)quote='';continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}
      if(ch==='>')break;
    }
    if(end>=to)break;
    at=end+1;
    // HTML raw-text/code containers do not turn their literal contents into assets.
    if(!name[1]&&/^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext|pre|code)$/i.test(name[2])){
      const close=new RegExp('</'+name[2]+'\\s*>','ig');close.lastIndex=at;const match=close.exec(source);at=match&&match.index<to?close.lastIndex:to;continue;
    }
    if(name[1]||name[2].toLowerCase()!=='img')continue;
    let p=open+name[0].length;
    while(p<end){
      while(p<end&&/[\t\n\f\r /]/.test(source[p]))p++;
      const keyFrom=p;while(p<end&&!/[\t\n\f\r =/>]/.test(source[p]))p++;
      const key=source.slice(keyFrom,p).toLowerCase();if(!key){p++;continue;}
      while(p<end&&/\s/.test(source[p]))p++;
      if(source[p]!=='=')continue;
      p++;while(p<end&&/\s/.test(source[p]))p++;
      const q=source[p]==='"'||source[p]==="'"?source[p++] : '',valueFrom=p;
      if(q){while(p<end&&source[p]!==q)p++;}
      else{while(p<end&&!/\s/.test(source[p]))p++;}
      const valueTo=p;if(q&&p<end)p++;
      if(key==='src'){
        const raw=source.slice(valueFrom,valueTo),target=decodeImageAttribute(raw);
        if(target)output.push({imageFrom:open,imageTo:end+1,from:valueFrom,to:valueTo,target,kind:'html',raw});
        break; // Browser attribute ownership: first src wins, including an empty src.
      }
    }
  }
}

export function scanSourceImageRefs(value){
  const source=String(value??''),output=[];
  if(!/!\[|<img\b/i.test(source))return output;
  parser.parse(source).iterate({enter(ref){
    if(ref.name==='Image'){
      const node=ref.node,url=node.getChild('URL');
      if(url){let from=url.from,to=url.to;if(source[from]==='<'&&source[to-1]==='>'){from++;to--;}
        const raw=source.slice(from,to),target=decodeMarkdownDestination(raw);
        if(target)output.push({imageFrom:node.from,imageTo:node.to,from,to,target,kind:'markdown',raw});
      }
      return false;
    }
    if(ref.name==='HTMLTag'||ref.name==='HTMLBlock'){htmlImages(source,ref.from,ref.to,output);return false;}
    if(['CommentBlock','Comment','InlineCode','FencedCode','CodeBlock'].includes(ref.name))return false;
  }});
  return output.sort((a,b)=>a.from-b.from);
}

export function collectImageRefs(md) {
  return [...new Set(scanSourceImageRefs(md).map(ref => ref.target))];
}
