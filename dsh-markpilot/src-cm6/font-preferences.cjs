'use strict';
// Pure appearance contract shared by the browser engine and native hosts.
const FONT_ROLES=Object.freeze([
 ['body','正文'],['h1','一级标题 H1'],['h2','二级标题 H2'],['h3','三级标题 H3'],['h4','四级标题 H4'],['h5','五级标题 H5'],['h6','六级标题 H6'],['italic','斜体'],['bold','粗体'],['code','代码']
].map(([id,label])=>Object.freeze({id,label})));
function normalizeFontPreferences(input={}) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('字体设置格式无效');
 const keys=new Set(FONT_ROLES.map(r=>r.id));
 for(const key of Object.keys(input))if(!keys.has(key))throw new Error('未知字体项：'+key);
 const out={};
 for(const {id} of FONT_ROLES){const v=input[id]??'';if(typeof v!=='string'||v.length>400||/[;{}<>\\\u0000-\u001f]/.test(v))throw new Error('字体名称无效');out[id]=v.trim();}
 return out;
}
function fontPreferenceCss(input={},forExport=false) {
 const p=normalizeFontPreferences(input),out=[];
 const selectors=forExport?{body:'body',italic:'em',bold:'strong',code:'pre,code',...Object.fromEntries([1,2,3,4,5,6].map(n=>['h'+n,'h'+n]))}:{body:'.cm-content',italic:'.cm-content em',bold:'.cm-content strong',code:'.cm-content code,.cm-content .cm-line.mp-code,.mp-cell-code',...Object.fromEntries([1,2,3,4,5,6].map(n=>['h'+n,'.cm-content .cm-line.mp-h'+n]))};
 for(const {id} of FONT_ROLES)if(p[id]){out.push(':root{--mp-type-'+id+':'+p[id]+'}');out.push(selectors[id]+'{font-family:var(--mp-type-'+id+') !important}');}
 return out.join('\n');
}
module.exports={FONT_ROLES,normalizeFontPreferences,fontPreferenceCss};
