import {mml2omml} from './vendor/mathml2omml.mjs';
const M='http://schemas.openxmlformats.org/officeDocument/2006/math';
const ML='http://www.w3.org/1998/Math/MathML';
const escape=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
// KaTeX emits fences as adjacent mo nodes. The general converter treats those
// as ordinary runs; explicitly preserve stretchy grouping around matrices and
// tall expressions using native Office delimiters, without changing the math.
// Pick the first free E000-EFFF placeholder that neither the literal formula
// text (used) nor the already-issued substitutions (taken) occupy.
export function freePuaSymbol(used,taken){
  for(let code=0xE000;code<=0xEFFF;code++){const symbol=String.fromCharCode(code);if(!used.has(symbol)&&!taken.has(symbol))return symbol;}
  throw new Error('公式嵌套过多');
}
export function officeMath(source){
  const math=source.cloneNode(true),substitutions=new Map();
  // Literal private-use characters in the formula would collide with the
  // placeholder markers; skip every E000-EFFF code point already in use.
  const used=new Set([...math.textContent].filter(ch=>ch>='\uE000'&&ch<='\uEFFF'));
  for(const token of math.querySelectorAll('mo,mi'))if(!token.hasAttribute('mathvariant')&&/^[A-Za-z]{2,}$/.test(token.textContent))token.setAttribute('mathvariant','normal');
  const render=element=>{
    const output=new DOMParser().parseFromString(mml2omml(element.outerHTML),'application/xml');
    if(output.querySelector('parsererror'))throw new Error('公式转换生成了无效 XML');
    for(const text of [...output.getElementsByTagNameNS(M,'t')]){
      const content=text.textContent,parts=content.split(/([\uE000-\uEFFF])/);if(parts.length===1)continue;
      const run=text.parentElement;if(run?.localName!=='r')continue;const fragment=output.createDocumentFragment();
      for(const part of parts){if(!part)continue;const replacement=substitutions.get(part);if(replacement){const parsed=new DOMParser().parseFromString(replacement,'application/xml');fragment.append(output.importNode(parsed.documentElement,true));}
        else{const copy=run.cloneNode(true);copy.getElementsByTagNameNS(M,'t')[0].textContent=part;fragment.append(copy);}}
      run.replaceWith(fragment);
    }
    return output.documentElement;
  };
  for(const row of [...math.querySelectorAll('mrow')].reverse()){
    const nodes=[...row.children],first=nodes[0],last=nodes.at(-1);
    if(nodes.length<3||first.localName!=='mo'||last.localName!=='mo'||first.getAttribute('stretchy')==='false'||last.getAttribute('stretchy')==='false')continue;
    const open=first.textContent,close=last.textContent;
    if(!['(', '[', '{', '|','‖','⟨'].includes(open)||![')',']','}','|','‖','⟩'].includes(close))continue;
    const inner=document.createElementNS(ML,'math'),body=document.createElementNS(ML,'mrow');for(const node of nodes.slice(1,-1))body.append(node.cloneNode(true));inner.append(body);
    const converted=render(inner),symbol=freePuaSymbol(used,substitutions);
    const content=[...converted.childNodes].map(node=>new XMLSerializer().serializeToString(node)).join('');
    substitutions.set(symbol,`<m:d xmlns:m="${M}"><m:dPr><m:begChr m:val="${escape(open)}"/><m:endChr m:val="${escape(close)}"/><m:grow m:val="1"/></m:dPr><m:e>${content}</m:e></m:d>`);
    const marker=document.createElementNS(ML,'mtext');marker.textContent=symbol;row.replaceWith(marker);
  }
  return new XMLSerializer().serializeToString(render(math));
}
