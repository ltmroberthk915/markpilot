// Lute only recognizes a closing $$ at the end of a line. Typora documents
// also use $$formula$$, prose. Give Lute separate fence and prose lines while
// keeping TeX bytes (especially \\ and _) intact. Ordinary input is untouched.
// An opener that never closes would otherwise make Lute read every following
// line as TeX, so the text around it loses its formatting; bound it instead.
export function normalizeMathFences(markdown) {
  if(typeof markdown!=='string'||!markdown.includes('$$'))return markdown;
  const newline=markdown.includes('\r\n')?'\r\n':'\n',lines=markdown.split(/\r?\n/),out=[];
  let math=null,fence=null,html=null,changed=false;
  const delimiter=(text,start=0)=>{
    for(let i=text.indexOf('$$',start);i>=0;i=text.indexOf('$$',i+2)){
      if(text[i-1]==='$'||text[i+2]==='$')continue;
      let backslashes=0;for(let j=i-1;j>=0&&text[j]==='\\';j--)backslashes++;
      if(backslashes%2===0)return i;
    }
    return -1;
  };
  for(const line of lines){
    const parts=/^((?: {0,3}>[ \t]?)*)([ \t]*)(.*)$/.exec(line);
    const quote=parts[1],depth=(quote.match(/>/g)||[]).length,indent=parts[2];
    let text=parts[3],prefix=quote+indent,continuation=prefix;
    const list=/^(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(text);
    if(list){prefix+=list[0];continuation+=' '.repeat(list[0].length);text=text.slice(list[0].length);}
    if(math&&depth!==math.depth)math=null;
    if(fence&&depth!==fence.depth)fence=null;
    if(fence){
      if(new RegExp('^'+fence.char+'{'+fence.length+',}\\s*$').test(text))fence=null;
      out.push(line);continue;
    }
    if(html){if(html.test(text))html=null;out.push(line);continue;}
    if(!math){
      const code=/^(`{3,}|~{3,})/.exec(text);
      if(code){fence={char:code[1][0],length:code[1].length,depth};out.push(line);continue;}
      const raw=/^<(pre|code|script|style|textarea)\b/i.exec(text);
      if(raw){const end=new RegExp('</'+raw[1]+'\\s*>','i');if(!end.test(text))html=end;out.push(line);continue;}
      if(text.startsWith('<!--')){if(!text.includes('-->'))html=/-->/;out.push(line);continue;}
      if(text.startsWith('<![CDATA[')){if(!text.includes(']]>'))html=/\]\]>/;out.push(line);continue;}
      if(text.startsWith('<?')){if(!text.includes('?>'))html=/\?>/;out.push(line);continue;}
      // CommonMark block HTML continues to a blank line. Its apparent dollar
      // fences are literal HTML content, not Markdown math.
      if(/^<\/?(?:address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?:\s|\/?>)/i.test(text)||/^<\/?[A-Za-z][^>]*>\s*$/.test(text)){
        html=/^\s*$/;out.push(line);continue;
      }
      if(indent.includes('\t')||indent.length>=4||!text.startsWith('$$')||text[2]==='$'){out.push(line);continue;}
      const at=delimiter(text,2);
      if(at<0){math={depth,open:out.length,continuation};out.push(line);continue;}
      if(!text.slice(at+2).trim()){out.push(line);continue;}
      out.push(prefix+'$$',continuation+text.slice(2,at),continuation+'$$',continuation.trimEnd(),continuation+text.slice(at+2).trimStart());
      changed=true;
    }else{
      const at=delimiter(text);
      if(at<0){out.push(line);continue;}
      math=null;
      if(!text.slice(at+2).trim()){out.push(line);continue;}
      if(at>0)out.push(prefix+text.slice(0,at));
      out.push(continuation+'$$',continuation.trimEnd(),continuation+text.slice(at+2).trimStart());
      changed=true;
    }
  }
  // The block never closed. Close it where it stops being a formula — the first
  // blank line, or the end of the document when there is none. Letting Lute see
  // an unterminated opener eats everything after it, formatting included.
  if(math&&math.open!==undefined){
    let boundary=-1;
    for(let i=math.open+1;i<out.length;i++)if(!out[i].trim()){boundary=i;break;}
    if(boundary>=0){out.splice(boundary,0,math.continuation+'$$');changed=true;}
  }
  return changed?out.join(newline):markdown;
}

/** 【F·行内公式残骸修复】浏览器块合并把 0×0 的 `$` 标记与源码 code 当"不可见内容"
 *  删掉、只留渲染预览（铁证 .zcode-tmp/r15/out/merge/report.json para-mid：Spin IN 里
 *  inline-node 只剩 preview，Lute 把残骸序列化为空，`$a+b=c$` 从 md 与磁盘静默消失，
 *  仅即时 Ctrl+Z 可救）。预览的 .language-math 带着 data-math（可恢复源码），在字符串
 *  进入 Lute 之前把残骸重建成完整骨架：`$` + code + 无渲染 preview + `$`——与 Lute
 *  自产形状逐字节同构（同铁证 heading-h3 的 spin OUT），data-render="2" 由 P 尾部的
 *  预览重渲染巡扫（index.min.js@82400 一带）补画。门只认「inline-node 的首元素子节点
 *  是 preview」这一种残骸签名（健康数学节点 marker 永在最前）；data-math 缺失（被剥
 *  过的尸体）不修，维持现状。开关 localStorage.mpMathWreckRepair='off'（应急/A-B 探针）。 */
const WRECK_PREVIEW_FIRST = /<span(?=[^>]*data-type="inline-node")[^>]*>\s*<span(?=[^>]*vditor-ir__preview)/;
const repairInlineMathWreck = html => {
  if (typeof html !== 'string' || html.indexOf('inline-node') < 0 ||
      globalThis.localStorage?.getItem('mpMathWreckRepair') === 'off' ||
      !WRECK_PREVIEW_FIRST.test(html)) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  let fixed = 0;
  for (const node of template.content.querySelectorAll('span[data-type="inline-node"]')) {
    const preview = node.firstElementChild;
    if (!preview || !preview.classList.contains('vditor-ir__preview') ||
        node.querySelector('code[data-type="math-inline"]')) continue;   // 健康形状零改动
    const source = preview.querySelector('.language-math')?.getAttribute('data-math');
    if (!source) continue;                                               // 无恢复源：不修（现状下界）
    const marker = () => { const $ = document.createElement('span');
      $.className = 'vditor-ir__marker'; $.textContent = '$'; return $; };
    const code = document.createElement('code');
    code.className = 'vditor-ir__marker vditor-ir__marker--pre';
    code.setAttribute('data-type', 'math-inline');
    code.textContent = source;                                           // DOM 赋值自动转义（&<> 安全）
    const fresh = document.createElement('span');
    fresh.className = 'vditor-ir__preview'; fresh.setAttribute('data-render', '2');
    const skeleton = document.createElement('span');
    skeleton.className = 'language-math'; skeleton.textContent = source;
    fresh.append(skeleton);
    node.replaceChildren(marker(), code, fresh, marker());
    fixed++;
  }
  return fixed ? template.innerHTML : html;   // 零命中：原串逐字节返回（无操作门）
};

// Install before Vditor asynchronously loads Lute, covering initial opening,
// paste, setValue, mode changes and preview. DOM-to-Markdown/history stay
// native; the Spin correction below only changes table-cell line-break HTML.
export function prepareMathMarkdown(target=window) {
  if(target.__typoraMathMarkdown)return;
  target.__typoraMathMarkdown=true;
  const wrap=Lute=>{
    if(!Lute?.New||Lute.__typoraMathMarkdown)return Lute;
    const create=Lute.New;
    Lute.New=function(...args){
      const lute=create.apply(this,args);
      for(const [method,index] of [['Md2VditorIRDOM',0],['Md2VditorDOM',0],['Md2HTML',0],['Markdown',1],['MarkdownStr',1]]){
        const native=lute[method];if(typeof native!=='function')continue;
        lute[method]=function(...args){args[index]=normalizeMathFences(args[index]);return native.apply(this,args);};
      }
      // A table line break is editable layout, not an HTML source widget.
      // Normalize the parser result so subsequent input/history sees a real
      // BR from the start and never expands a hidden <br /> code marker.
      for(const method of ['Md2VditorIRDOM','SpinVditorIRDOM']){
        const native=lute[method];if(typeof native!=='function')continue;
        lute[method]=function(...args){return native.apply(this,args).replace(/<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,(whole,tag,attrs,body)=>'<'+tag+(attrs||'')+'>'+body.replace(/<span data-type="html-inline" class="vditor-ir__node[^"]*"><code class="vditor-ir__marker">&lt;br\s*\/?&gt;<\/code><\/span>/gi,'<br>')+'</'+tag+'>');};
      }
      // 【F·B】Spin 入参先行内公式残骸修复（见 repairInlineMathWreck 注释）。覆盖一切
      // 调用方（P 重放 / patchHeadingEnter / patchListTabIndent / media-tools 重放）。
      {
        const nativeSpin = lute.SpinVditorIRDOM;
        if (typeof nativeSpin === 'function') lute.SpinVditorIRDOM = function(...args) {
          if (typeof args[0] === 'string') args[0] = repairInlineMathWreck(args[0]);
          return nativeSpin.apply(this, args);
        };
      }
      return lute;
    };
    Lute.__typoraMathMarkdown=true;return Lute;
  };
  let current=wrap(target.Lute);
  Object.defineProperty(target,'Lute',{configurable:true,get:()=>current,set:value=>{current=wrap(value);}});
}
