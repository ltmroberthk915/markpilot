/** Math commands are local DOM transactions, including inside live tables.
 * Never insert dollar text into an existing formula or re-find a caret by
 * formula contents: both lose the editing boundary when formulas repeat.
 */
const PREVIEW='.vditor-ir__preview,.vditor-wysiwyg__preview';
const EXPAND='vditor-ir__node--expand';
const POINTER='typora-ir-pointer';
const MATH='code[data-type="math-inline"],code[data-type="math-block"]';
const INLINE='code[data-type="math-inline"]';
const el=node=>node?.nodeType===3?node.parentElement:node;
const clean=text=>text.replace(/\u200b/g,'');
/** 源码里除了空白什么都没有。空块公式的源码实测是**一个换行**（`$$\n\n$$` → `"\n"`），
 *  所以判空必须看 `\S`，不能只看长度——只去零宽空格会把 "\n" 当成有内容。 */
const blank=code=>!/\S/.test(clean(code.textContent));
// GFM reserves a bare | even inside inline math. Use the equivalent TeX
// delimiter instead of a Markdown escape (\| means a double bar in TeX).
// TeX ignores these source line breaks; literal newlines would split GFM rows.
const tableSource=text=>text.replace(/(?<!\\)\|/g,'\\vert{}').replace(/\r\n?|\n/g,' ');
import {sourceText} from './source-text.js';
const blurredEditors=new WeakSet();
/** 【2026-09-17 口径变更】过去这里有一段 FENCE_HINT / BOUNDARY_HINT 文案：围栏上按退格
 *  只弹说明、不改文档。用户看过后要求按 Typora 的围栏手感来——"最好能直接把这些 fence
 *  当普通字符处理，你现在这样太别扭了，卡手"。于是围栏位置改成**真的删掉那一个 `$`**
 *  （deleteFenceChar：行内公式降级成字面文本，块公式的围栏写成一个 `$` 由 Lute 重新配对），
 *  提示文案与 mathHint 一并删除。真正还会挡住的只剩"块级合并"那一类（见 openFormula）。 */
const MARKER='span.vditor-ir__marker,span[data-type$="-marker"]';
const choose=(root,node,offset)=>{
  root.focus({preventScroll:true});
  getSelection().collapse(node,Math.min(offset,node.nodeType===3?node.length:node.childNodes.length));
};
const ownerFor=code=>code?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
// Formatting wrappers may contain many formulas. Owning a formula requires a
// direct source child; a caret in bold/link text must not activate its first one.
const ownMath=owner=>owner?.querySelector(':scope > code[data-type="math-inline"],:scope > pre > code[data-type="math-block"]');
// Keys that carry a Markdown formatting command. Inside TeX source they only
// corrupt the formula (Ctrl+B inserts **, Ctrl+I *, Ctrl+U <u></u>).
// 【S4·R2】D/K 同口径吞键：Ctrl+D 删除线 ~~、Ctrl+K 链接 []()（Vditor 自建绑定）与
// B/I/U 一样只会把符号塞进 TeX 源码，公式当场坏掉。
const FORMATTING=new Set(['b','i','u','d','k']);
/**
 * 围栏标记（块公式的 $$ / 行内公式的 $）上的位置。
 * 展开态下它就是屏幕上的真文本，光标站上去是**真实可用的位置**（用户要的"光标自由插入
 * 到前后两个 dollar 符的位置"，$ 前 / 两个 $ 之间 / $ 后都能站）；折叠态下它是 display:none，
 * 停在那里既画不出来又会让公式弹出预渲染框（v2.1.1 报告的行尾形状），仍按外边界处理。
 */
const markerEdge=(node,owner)=>{
  const host=node.nodeType===1?node:node.parentElement;
  if(!host||host.parentElement!==owner||!host.matches?.(MARKER))return null;
  return {where:host===owner.firstElementChild?'start':'end',layer:owner.classList.contains(EXPAND)?'fence':'outer'};
};
/**
 * "贴边"位置：光标停在公式之前/之后，而不是源码里面。
 * Chromium 把行首/行尾的光标落在 owner 的首尾子位置、或落在零宽的首尾 $ 标记里；
 * 块公式的围栏在 IR 里是伪元素，源码的第 0 个与最后一个位置就是围栏位置。
 * layer 区分两种贴边：'outer' 是 owner/标记本身的外边界，'code' 是源码的 0 / 末尾。
 */
const formulaEdge=(owner,range)=>{
  if(!owner||!range?.collapsed)return null;
  const code=ownMath(owner);if(!code)return null;
  const node=range.startContainer,offset=range.startOffset;
  if(node===owner){
    if(offset<=0)return {where:'start',layer:'outer'};
    return offset>=owner.childNodes.length?{where:'end',layer:'outer'}:null;
  }
  // 元素级位置：光标容器不是文本节点，而是"源码元素自己 / 围栏标记元素自己"。
  // Chromium 把大量点击解析成这种形状——实测点块公式渲染结果正中得到
  // code[data-type="math-block"]@0，点前 $$ 得到标记元素@1。它们和文本级的 0 / 末尾
  // 是同一个边界，必须一起认：2.1.1 漏了这一支，于是"点一下块公式再按退格"没命中任何
  // 保护，整块 $$…$$ 被 Vditor 拆进上一段（用户报告：(2) 前一行按退格，(1) 的公式直接
  // 被删除）。围栏标记里的位置同样属于公式边界，不算"在源码里编辑"。
  if(node===code){
    if(offset<=0)return {where:'start',layer:'code'};
    return offset>=code.childNodes.length?{where:'end',layer:'code'}:null;
  }
  if(node.nodeType===1&&node.parentElement===owner&&node.matches(MARKER)){
    return markerEdge(node,owner);
  }
  // 元素级位置落在 owner 里但不是源码里（渲染预览的子树、owner 自己的子位置）：
  // Chromium 把"点块公式下方留白"也解析成这类位置（实测 preview@27、code@0）。
  // 预览不是可编辑内容，所以这里只归成边界——但**不把光标挪走**：WYSIWYG 下"光标落在
  // 预览里"正是 Vditor 用来显示公式源码的状态（实测挪走它会把源码重新藏起来、源码高度归零，
  // math-colors 套件立刻抓到）。【2026-09-17】这个位置上的退格/删除现在按"围栏当普通字符"
  // 处理：删掉靠这一端的那一个 `$`（见 boundaryNode 的注释），不再只弹说明。
  if(node.nodeType===1&&node!==code&&owner.contains(node)){
    if(node.closest?.(PREVIEW))return {where:'end',layer:'preview'};
    const code2=ownMath(owner);
    return {where:node.compareDocumentPosition(code2)&Node.DOCUMENT_POSITION_FOLLOWING?'start':'end',layer:'outer'};
  }
  if(node.nodeType!==3||!owner.contains(node))return null;
  const host=node.parentElement;
  if(host.matches?.(MARKER))return markerEdge(node,owner);
  if(host===owner.firstElementChild)return offset<=0?{where:'start',layer:'outer'}:null;
  if(host===owner.lastElementChild)return offset>=node.length?{where:'end',layer:'outer'}:null;
  if(host===code){
    if(offset<=0)return {where:'start',layer:'code'};
    return offset>=node.length?{where:'end',layer:'code'}:null;
  }
  return null;
};
// 贴边的光标停在 display:none 的 $ 标记或 owner 的缝隙里：既画不出来，又会被
// Vditor 当成"光标在这个 vditor-ir__node 里"而展开公式（行尾一停就浮出预渲染框）。
// 把光标挪到公式外面——视觉位置不变，但语义就是行首/行尾。
const caretOutside=(owner,where,range)=>{
  const parent=owner?.parentNode;if(!parent||!range)return false;
  const next=range.cloneRange();
  if(where==='start')next.setStartBefore(owner);else next.setStartAfter(owner);
  next.collapse(true);
  const selection=getSelection();selection.removeAllRanges();selection.addRange(next);
  return true;
};
// 选区正好圈定一个公式节点本身（selectNode(owner) 的形状，也是取消公式时用的形状）。
const mathNodeOfRange=(root,range)=>{
  if(!range||range.collapsed||range.startContainer!==range.endContainer)return null;
  if(range.startContainer.nodeType!==1||range.endOffset!==range.startOffset+1)return null;
  const node=range.startContainer.childNodes[range.startOffset];
  return node?.nodeType===1&&root.contains(node)&&ownMath(node)?node:null;
};
// 紧贴光标的相邻元素节点：退格看光标之前、删除看光标之后。
const neighbour=(range,backward)=>{
  const node=range.startContainer,offset=range.startOffset;
  let sibling;
  if(node.nodeType===3){
    if(backward?offset>0:offset<node.length)return null;
    sibling=node[backward?'previousSibling':'nextSibling'];
  }else sibling=node.childNodes[backward?offset-1:offset];
  while(sibling&&sibling.nodeType===3&&!sibling.length)sibling=sibling[backward?'previousSibling':'nextSibling'];
  return sibling?.nodeType===1?sibling:null;
};
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

// IR 模式下被本模块加上过展开类的 owner。收回它们只需要碰这些节点，不必每键把全篇
// 公式扫一遍（大文档 2500 处公式 → 每键 3–8ms 的纯固定成本，与光标在哪无关）。
const expandedOwners=new Set();
/** 一次鼠标 press 期间被冻住的块公式（避免"点一下就把展开态收掉"的整块闪烁）。
 *  只在按下开始时快照一次；pointer 类摘掉（松手/失焦/按键介入）后自动失效。 */
let pressFrozen=null;
/** owner 的源码即将随折叠隐藏，而光标还停在它里面：把光标搬到 owner 之后（root 层边界，
 *  永远可编辑可见）。不搬的后果（A1 装机取证 + R10-P8 病例 4 公式族同源）：折叠后光标
 *  留在 display:none 的源码文本上——用户看到「光标没了」，下一次输入落在不可见处。 */
const rescueHiddenCaret=owner=>{
  const s=getSelection();
  if(!s?.rangeCount||!owner.isConnected||!s.focusNode||!owner.contains(s.focusNode))return;
  const range=document.createRange();
  range.setStartAfter(owner);range.collapse(true);
  s.removeAllRanges();s.addRange(range);
};
export function refreshMathEditing(api) {
  const e=api.vditor,mode=e.currentMode;if(!['ir','wysiwyg'].includes(mode))return;
  const root=e[mode].element,s=getSelection();
  const focused=!blurredEditors.has(api)&&(document.activeElement===root||root.contains(document.activeElement));
  const at=el(s?.focusNode),caretOwner=at?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
  const range=s?.rangeCount?s.getRangeAt(0):null;
  const inEditor=!!s&&root.contains(s.focusNode)&&focused;
  // 行尾/行首只是"路过"公式：贴边的光标不算在编辑公式，否则一停就展开、浮出预渲染框
  // （v2.1.1 用户报告：光标插在一行最后、而这一行以公式的 $ 结尾时预渲染框会弹出来）。
  const edge=caretOwner&&ownMath(caretOwner)?formulaEdge(caretOwner,range):null;
  const outer=edge?.layer==='outer'?edge:null;
  if(outer&&inEditor)caretOutside(caretOwner,outer.where,range);
  const active=inEditor&&!outer?(at?.closest(MATH)||ownMath(caretOwner)):null;
  const selectedPreview=el(s?.focusNode)?.closest(PREVIEW);
  if(mode==='ir'){
    // 展开态是加在 owner 上的类，默认折叠：没被我们展开过的 owner 本来就是对的。
    // 于是这里只需保证"该展开的展开、展开过的该收回的收回"，其余一律不碰。
    const editing=new Set();
    const ownerOf=code=>ownerFor(code);
    // 鼠标按着（拖拽选中）期间**不展开块公式**。
    // 用户 2026-09-14 第 7 轮：「从下往上拉动拖拽选中，一旦经过 $$…$$，出现高频抖动仍未解决」。
    // 实测（scripts/acceptance/probe-jitter.cjs，逐拍 40ms）：向上拖经过块公式时，块公式的
    // `--expand` 翻转 4 次、块盒高度在 91 ↔ 118 之间来回（差的 27px 正是**源码行**那一条），
    // 下面的文字整段跟着位移 → 指针底下的内容变了、拖拽端点落到别处 → 再翻一次，来回打转。
    // 行内公式由 v2.1.11 的 `.typora-ir-pointer` CSS 从视觉上压回渲染态（DOM 类不动）；
    // 块公式压不住——它的源码行是**参与布局**的块级元素（而且折叠态的那点间距来自 Vditor
    // 画在 ::before/::after 上的围栏，压不出同一个高度，实测反而从 118 掉到 27）。所以这里
    // 在按下期间干脆不展开它，版面全程停在折叠态（松手后 pointer 类摘掉，照旧恢复）。
    const pointerDown=root.classList.contains(POINTER);
    const blocked=owner=>pointerDown&&owner.dataset?.type==='math-block';
    // 但"不展开"不等于"要收回"：按下那一刻**已经展开**的块公式必须在整道 press 里原样冻住。
    // 用户 2026-09-14 第 12 轮：「在展开预渲染、展开代码编辑的情况下，鼠标在代码区的点击与
    // 渲染区的点击都会导致重新渲染一次这种闪烁……没有任何文字变动，只是点击就不要重新渲染。」
    // 取证（scripts/acceptance/probe-click-rerender.cjs：逐帧 rAF 采样 + classList 代理抓调用栈）：
    //   点源码区 / 渲染区各一次，`--expand` 的变动序列都是
    //     refreshMathEditing（下面 `let reclaimed=false` 那两条收回循环）remove --expand  ← 我们自己摘的
    //     Vditor B() add --expand / remove --hidden                                      ← 松手后 Vditor 又装回来
    //   摘它的原因就是上面那条 `blocked`：press 期间块公式进不了 `editing`，于是"光标明明已经
    //   在源码里"也被当成"不该展开"→ 收回。真实点击的按下与松开之间隔着若干帧（探针里 CDP 把
    //   pressed/released 连着发、所以一帧都采不到折叠态；人手点击必然采得到），块盒高度
    //   145→119→145（差的 26px 正是源码行那一条）就成了用户看到的"整块闪烁"。键盘移动不挂
    //   这个 pointer 类，所以不闪——与用户描述完全一致。
    // 冻结点是**按下开始时快照一次**（不是每帧重算）：这样无论光标是在按下瞬间就进了源码，
    // 还是等 Vditor 的 click 处理器才把它挪进去，结果都一样。松手后 pointer 类摘掉，
    // 快照立刻失效，下一帧照常按"光标在不在公式里"收回——第 7 轮的防抖语义与它不冲突
    // （那条只管"别展开"，冻结点只管"别收回"）。
    if(!pointerDown)pressFrozen=null;
    else if(!pressFrozen||pressFrozen.root!==root)pressFrozen={root,owners:new Set([...root.getElementsByClassName(EXPAND)]
      .filter(node=>node.dataset?.type==='math-block'&&ownMath(node)))};
    const frozen=owner=>!!pressFrozen&&pressFrozen.owners.has(owner);
    if(active){const owner=ownerOf(active);if(owner&&!blocked(owner))editing.add(owner);}
    // R11（2026-10-04 辩论裁决）：预览岛命中≠公式。html-block（图片）/code-block/html-entity
    // 的渲染岛同为 .vditor-ir__preview，无门时会被误收进名册：单击图片的选区落岛 → 污染入册
    // 并预挂 --expand → 光标进源码的下一拍又被下面的收回循环折回——源码闪现一帧后消失
    // （用户报「点图源码闪现即没」，dev 取证 expand→collapse 11.4/14.3/15.8ms）。非公式岛
    // 的展开归 media-tools 的用户手势管辖，本模块不收编（与 :323 活集合循环的守卫对称）。
    if(selectedPreview){const owner=selectedPreview.closest('.vditor-ir__node,.vditor-wysiwyg__block');if(owner&&ownMath(owner)&&!blocked(owner))editing.add(owner);}
    // Vditor 自己也会给光标所在（或紧邻）的 vditor-ir__node 挂 --expand，所以即使这个
    // owner 不是我们展开的，也要在"光标并不在公式里"时收回来。
    // 用 getElementsByClassName 而不是 querySelectorAll：这一段每次选区变化都要跑，而
    // 后代类选择器在 Blink 里必须遍历整棵子树。实测（49 万字符 / 5634 条公式 / 4.5 万元素
    // 的真实素材，scripts/math-edit-perf-probe.cjs）：querySelectorAll 0.213–0.228ms，
    // getElementsByClassName 0.0003–0.002ms（570–640×），而整个 refreshMathEditing 一次
    // 0.289ms——九成就是这一句。返回的是**活集合**，下面会一边移除 EXPAND 一边遍历，
    // 所以遍历前先快照成数组（快照本身实测 0.00033ms）。
    const expanded=root.getElementsByClassName(EXPAND);
    if(!editing.size&&!expandedOwners.size&&!expanded.length)return;
    let reclaimed=false;
    for(const owner of [...expandedOwners]){
      if(editing.has(owner)||frozen(owner))continue;
      expandedOwners.delete(owner);
      // R11：与下面活集合循环的 !ownMath 守卫对称的纵深防御——名册按构造只含公式成员
      //（:305 已门化），但任何未来入口漏门时，非公式成员也只出册、不摘展开类：那可能是
      // media-tools 用户手势展开的检视态，不是本模块的管辖物（出册以绝 DOM 引用滞留）。
      if(!ownMath(owner))continue;
      rescueHiddenCaret(owner);
      if(owner.isConnected)owner.classList.remove(EXPAND);
    }
    for(const owner of Array.from(expanded)){
      if(editing.has(owner)||frozen(owner)||!ownMath(owner))continue;
      owner.classList.remove(EXPAND);
      expandedOwners.delete(owner);
      reclaimed=true;
    }
    for(const owner of editing){
      expandedOwners.add(owner);
      owner.classList.add(EXPAND);
    }
    // 收回靠的是"光标贴边"，而点击的最终落点通常在浏览器/Vditor 处理完之后才定下来：
    // 实测点公式正中时先看到的是 owner 边界、随后光标才被移进源码，一次收回会把该
    // 展开的也收掉。所以收回之后再确认一遍（只在这一条路径上多跑一次，不增加常态成本）。
    if(reclaimed)setTimeout(()=>{if(root.isConnected)refreshMathEditing(api);},0);
    return;
  }
  // WYSIWYG 的源码块靠 display 显隐，新建的块初始可见，必须每次归一化，保持原样。
  for(const code of root.querySelectorAll(INLINE)){
    if(code.closest(PREVIEW))continue;
    const owner=ownerFor(code);if(!owner)continue;
    code.style.display=(code===active||!!selectedPreview&&owner.contains(selectedPreview))?'':'none';
  }
}

export function installMathEditing(api) {
  const e=api.vditor,removers=[];
  const queueUndo=()=>{const mode=e.currentMode;clearTimeout(e[mode].processTimeoutId);e[mode].processTimeoutId=setTimeout(()=>{if(e.currentMode===mode)e.undo.addToUndoStack(e);},e.options.undoDelay||200);};
  const activeCode=()=>{const s=getSelection(),root=e[e.currentMode]?.element;if(!s?.rangeCount||!root?.contains(s.focusNode))return null;const a=el(s.anchorNode)?.closest(INLINE),b=el(s.focusNode)?.closest(INLINE);return a&&a===b&&!a.closest(PREVIEW)?a:null;};
  // 同上，但把块公式的源码也算进来（格式快捷键与回车要覆盖两者）。
  const activeMath=()=>{const s=getSelection(),root=e[e.currentMode]?.element;if(!s?.rangeCount||!root?.contains(s.focusNode))return null;const a=el(s.anchorNode)?.closest(MATH),b=el(s.focusNode)?.closest(MATH);return a&&a===b&&!a.closest(PREVIEW)?a:null;};
  const activeEmpty=()=>{const s=getSelection(),root=e[e.currentMode]?.element;return s?.rangeCount&&root?.contains(s.focusNode)?emptyPairAt(root,s.getRangeAt(0)):null;};
  // 删掉整条公式：块公式换成一个空段落（不这么做浏览器删 div 会留下残渣），行内公式
  // 留一个零长文本锚点接管光标，随后照常推给宿主（input 回调）与历史。
  const removeNode=node=>{
    const element=e[e.currentMode].element,anchor=document.createTextNode('');
    if(node.matches('[data-type="math-block"]')){
      const paragraph=document.createElement('p');paragraph.dataset.block='0';paragraph.append(anchor);
      node.replaceWith(paragraph);
    }else node.replaceWith(anchor);
    choose(element,anchor,0);
    e.options.input?.(api.getValue());
    queueUndo();
    refreshMathEditing(api);
    window.__typoraScheduleMath?.(element,{cdn:e.options.cdn,math:e.options.preview.math});
  };
  // ---- 整篇被删空之后留下的"空公式壳" ----
  // 用户手势：Ctrl+A 全选 + 一次退格。实测（真产物，探针 run：scripts/acceptance/
  // probe-empty-math-and-marker.cjs）——整篇正文与全部公式源码确实都删净了，但**当文档最后
  // 一块是块公式时**，Vditor 把那个块公式节点留作光标载体、只把它的源码清空，于是 markdown
  // 里剩下一个空 `$$` 壳（实测 `"$$\n\n\n$$\n"`，8 字符），而光标**落在源码里**
  // （实测 `inMathCode: true`）。用户接着打字，字就直接进公式源码：打 `abc` 实测得到
  // `$$\nabc\n$$`——屏幕上是一段被当成公式渲染的斜体字，而不是他想要的正文。
  //
  // 归因（同一份探针里的三条实验，都不是我们干的）：
  //   1. 我们的删除路径只摘掉**一条**节点——只选中最后那条块公式再退格，实测删掉 15 字符、
  //      其余 196 字符原样留着；而全选那一下是 221 → 8（整篇没了）。两者不是一个路径。
  //   2. 用 `execCommand('delete')` 删（完全不经过 keydown，我们的键处理一次都不跑）
  //      照样留下同一个空壳 + 光标在源码里。
  //   3. 把文档换成"最后一块是围栏代码块"再全选退格，清空后只剩一个空段落
  //      （实测 `blocks: []`、`value: "\n"`，接着打字进的是正文）——所以这是公式特有的
  //      形状，不是通用的删块行为，也不是"空 $$ 对本来就该留着"。
  //
  // 修法：只在"整篇被选中"这个前提下、且删完只剩一个**空的**块公式时才动手，把那个壳换成
  // 空段落（复用 removeNode——它本来就是"整条公式被删掉时换成空段落"的路径，撤消/保存都
  // 走既有通道）。判据卡得很死，所以用户自己 `$$` 回车新建的空公式块不会被误伤：那条路径
  // 上没有"整篇被选中"，clearedAt 根本不会被置起来。
  // 改完实测（同一探针，开发树）：清空后 `value: "\n"`、光标在空段落里（`inMathCode: false`）、
  // 接着打 `abc` 得到 `"abc\n"` 也就是正文；清空后**一次** Ctrl+Z 依旧逐字节回到原文
  // （历史粒度没被多推一层——这是这条修法唯一可能伤到的地方，专门钉了读数）。
  // 已知未覆盖：`document.execCommand('delete')` 这种**不发 beforeinput、也没有 keydown**
  // 的编程式删除（实测事件流里只有一条 input）。本产品的菜单里没有这种入口（Edit 菜单只有
  // 剪切，剪切会发 `deleteByCut`，属于被覆盖的），所以留着这个口子并在探针里如实记账。
  let clearedAt=0;
  /** 选区是不是覆盖了整篇（从第一块跨到最后一块）。用**结构**判断，不比较文本长度：
   *  长度对比不可用——surface.textContent / 现场算的"可见文本"都含 0×0 的隐藏源码，
   *  而 `getSelection().toString()` 不给它（实测 118 对 184，比值必然误判）。 */
  const wholeSelected=(root,range)=>{
    if(!range||range.collapsed)return false;
    if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return false;
    const kids=root.children;if(!kids.length)return false;
    // 两种形状都要认：选区端点落在首/末块**内部**（Chromium 常见，实测 Ctrl+A 给的是
    // start/end 都是文本节点），或直接落在编辑面**元素**上（offset 0 / 子节点数）。
    const indexOf=(node,offset)=>{
      if(node===root)return offset<=0?0:(offset>=root.childNodes.length?kids.length-1:-1);
      const block=el(node)?.closest?.('[data-block]');
      return block&&root.contains(block)?[...kids].indexOf(block):-1;
    };
    return indexOf(range.startContainer,range.startOffset)===0&&indexOf(range.endContainer,range.endOffset)===kids.length-1;
  };
  /** 整篇只剩一个空的块公式 → 返回那个 owner，否则 null。 */
  const emptyMathShell=()=>{
    const root=e[e.currentMode]?.element;
    if(!root||e.currentMode!=='ir'||root.children.length!==1)return null;
    const owner=root.children[0];
    if(!owner.matches('.vditor-ir__node[data-type="math-block"]'))return null;
    const code=ownMath(owner);
    return code&&code.matches('[data-type="math-block"]')&&!/\S/.test(clean(code.textContent))?owner:null;
  };
  const reclaimCleared=()=>{
    if(!clearedAt)return;
    const owner=emptyMathShell();
    if(!owner)return;
    clearedAt=0;
    removeNode(owner);
  };
  /** 记下"整篇刚被删"这件事，并在接下来的一小段时间里反复看一眼（Vditor 的重排可能比
   *  浏览器默认删除晚一拍）。最后一次尝试之后把记号清掉，别让它一直挂着。 */
  const watchCleared=()=>{
    clearedAt=Date.now();
    const root=e[e.currentMode].element;
    for(const delay of [0,60,160,320,600])setTimeout(()=>{if(root.isConnected)reclaimCleared();if(delay===600)clearedAt=0;},delay);
  };
  const commit=code=>{
    if(!clean(code.textContent)){
      // Chromium leaves a BR when deleting the final character of a grid
      // item. Lute serializes that BR as a literal newline inside a GFM row.
      // Both modes need a plain empty pair before any history/save/reparse.
      const owner=ownerFor(code),element=e[e.currentMode].element;
      // 用户 2026-09-17 报告："一旦把这个 inline math 的 fence 内的内容删掉之后, 会突变成
      // block math fence!"——落成字面 `$$` 之后，**如果它独占一行**，Lute 就把这一行读成
      // 块公式的开围栏（文档结构当场变形）。段落里还有别的文字时保留字面 `$$`（Typora 同款：
      // 空的行内公式就是一段普通文本）；只剩它自己的时候整条摘掉，用户看到的是"公式没了"，
      // 而不是"公式变成了另一种公式"。块公式不受影响（它的空壳本来就该留着并可见，见
      // emptyMathBlock 与 index.css 的占位）。
      const host=owner?.closest('p,li,h1,h2,h3,h4,h5,h6');
      const alone=!!host&&[...host.childNodes].every(child=>{
        if(child===owner)return true;
        if(child.nodeType===3)return !child.data.replace(/[\s\u200b]/g,'');
        return child.nodeType===1&&child.matches?.('.vditor-ir__marker')&&!child.textContent.replace(/[\s\u200b]/g,'');
      });
      if(owner&&alone){removeNode(owner);return;}
      const node=document.createTextNode('$$');ownerFor(code).replaceWith(node);choose(element,node,1);
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
      if(mode!=='ir'||!code?.isConnected||!root.contains(code)||!code.matches(MATH))return false;
      const owner=ownerFor(code);
      if(code.matches('[data-type="math-block"]')){
        // 块公式的 $$ 围栏同样不能持有字符：它会被 Lute 当成源码的一部分（实测把闭合围栏
        // 写成单个 $ 之后，紧跟的 `> (2)` 那行被吞进公式源码里）。落到哪边就并进源码哪一端。
        const left=owner?.querySelector(':scope > span[data-type="math-block-open-marker"]'),right=owner?.querySelector(':scope > span[data-type="math-block-close-marker"]');
        // 围栏不再恒等于 `$$`：用户按"围栏当普通字符"删掉一个 `$` 之后它是单个 `$`，
        // 而这时围栏**更容易**接住光标——所以改成看待"这一个 `$` 之后多出来的字符"，
        // 并且原样还原围栏文本（不能写死成 `$$`，那会把用户删掉的 `$` 又补回来）。
        // 围栏不再恒等于 `$$`（用户按"围栏当普通字符"删掉一个 `$` 之后它是单个 `$`），
        // 但**多出来的字符**要按"这条围栏自己的长度"算：`$$` 上多一个是 slice(2)、
        // 降级过的单个 `$` 上多一个是 slice(1)。这里一度写成一律 slice(1)，于是把正常
        // `$$` 的第二个 `$` 当成"多出来的字符"搬进了源码——实测在开围栏处打字得到
        // `$Zx+y=1$`（场景 74 的"在前 $$ 处打字"当场变红）。还原时也只把围栏还原成它
        // 本来就该有的样子（`$$` 还是 `$$`，降级过的还是 `$`），不把用户删掉的 `$` 补回来。
        if(!left||!right||!left.textContent.startsWith('$')||!right.textContent.endsWith('$'))return false;
        const open=left.textContent,close=right.textContent;
        const openFence=open.startsWith('$$')?2:1,closeFence=close.endsWith('$$')?2:1;
        const prefix=open.slice(openFence),suffix=close.slice(0,close.length-closeFence);
        if(!prefix&&!suffix)return false;
        const s=getSelection(),source=code.textContent,atEnd=s&&right.contains(s.focusNode);
        left.textContent=open.slice(0,openFence);right.textContent=close.slice(close.length-closeFence);
        code.textContent=prefix+source+suffix;
        const text=code.firstChild;
        choose(root,text,atEnd?text.length:Math.min(prefix.length,text.length));return true;
      }
      // Chromium can insert at code@0 into the adjacent dollar marker instead
      // of the inline code. Keep that input in its original formula; otherwise
      // Markdown changes but the preview and following source edits go stale.
      const left=code.previousElementSibling,right=owner?.lastElementChild;
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
    /** 围栏上的退格/删除（`side==='end'` = 靠后那一个 `$`，`'start'` = 靠前那一个）。
     *
     *  **行内**：围栏是渲染生成的，改它等于改 markdown——把公式降级成字面文本
     *  （`$a$` + 退格 → `$a`，内容一个字符都不少，只是不再是公式）。这是"fence 当普通字符"
     *  的直接实现（Typora 的行内 `$` 就是普通字符）。
     *
     *  **块**：不做成"删掉一个 `$`"。两条实测理由（scripts/acceptance/probe-fence-text.cjs
     *  的 F6/F9，上一轮 FENCE_HINT 的注释里也有同样的记录）：(1) 块公式的围栏文本是渲染
     *  生成的，直接改它的文本 getValue() 一个字节都不变——用户按下去像"什么都没发生"；
     *  (2) 真去 markdown 里把围栏写成单个 `$` 会让 Lute 重新配对围栏、把后面的内容吞进公式
     *  源码，而我们的"未闭合围栏收尾"（math-markdown.js，场景 102）又会把它补回来——用户
     *  的一次退格跟两条自动化规则打架。所以块公式这一下改成**删源码里靠自己这一端的一个
     *  字符**（Typora 里块公式的光标本来就在源码里，`$$` 只是外壳），源码删空之后由
     *  emptyMathBlock 那条路整条移除。 */
    const deleteFenceChar=(owner,side)=>{
      const code=ownMath(owner);
      if(!code)return false;
      if(blank(code)){removeNode(owner);return true;}
      if(owner.matches('[data-type="math-block"]'))return deleteSourceChar(owner,side==='end');
      const source=clean(code.textContent);
      const node=document.createTextNode(side==='end'?'$'+source:source+'$');
      owner.replaceWith(node);
      choose(root,node,side==='end'?node.length:0);
      e.options.input?.(api.getValue());
      queueUndo();
      refreshMathEditing(api);
      return true;
    };
    /** 删公式源码里靠自己这一端的一个字符（块公式的围栏位置、以及源码两端之外的位置用）。
     *  零宽空格是脚手架，跳过它删真字符；删空之后整条移除（空公式=页面上的一块空白）。 */
    const deleteSourceChar=(owner,backward)=>{
      const code=ownMath(owner);
      if(!code)return false;
      if(blank(code)){removeNode(owner);return true;}
      const nodes=[];
      {const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
       while(walker.nextNode())nodes.push(walker.currentNode);}
      const list=backward?[...nodes].reverse():nodes;
      const text=list.find(node=>clean(node.data).length)||list[0];
      if(!text){removeNode(owner);return true;}
      let at=backward?text.data.length-1:0;
      while(at>=0&&at<text.data.length&&text.data[at]==='\u200b')at+=backward?-1:1;
      at=Math.max(0,Math.min(at,text.data.length-1));
      text.data=text.data.slice(0,at)+text.data.slice(at+1);
      if(blank(code)){removeNode(owner);return true;}
      choose(root,text,Math.min(at,text.data.length));
      commit(code);
      return true;
    };
    /** 贴边的"合并"手势（段首退格 / 段尾删除 + 块公式）仍然不改文档——那是**块级合并**，
     *  实测会把整段引用块的 `>` 前缀削掉、把后面的段落并进公式（用户 2.1.x 报告过）。
     *  但不再只弹一句说明：展开成源码形态、整条源码选中、光标停在靠用户这一端
     *  （用户 2026-09-17："直接帮用户选中, 展开编辑公式代码形态"）。 */
    const openFormula=owner=>{
      const code=ownMath(owner);
      if(!code)return false;
      if(blank(code)){removeNode(owner);return true;}
      const nodes=[];
      {const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
       while(walker.nextNode())nodes.push(walker.currentNode);}
      const first=nodes[0],last=nodes[nodes.length-1];
      if(!first||!last){removeNode(owner);return true;}
      expandedOwners.add(owner);owner.classList.add(EXPAND);
      const range=document.createRange();
      range.setStart(first,0);range.setEnd(last,last.data.length);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      return true;
    };
    /** 贴着公式的位置判定（v2.2.1：**围栏当普通字符**）。
     *
     *  用户 2026-09-17 的要求："点退格也好，方向键也好，鼠标拖拽选中也好，最好能直接把这些
     *  fence 当普通字符处理，你现在这样太别扭了，卡手"。于是过去"拦下 + 弹一句说明"的那几类
     *  改成**真的删掉那一个 `$`**：行内公式降级成字面文本（`$a$` + 退格 → `$a`，内容一个
     *  字符都不少，只是不再是公式），块公式的围栏写成一个 `$`、由 Lute 重新配对（markdown
     *  本来就是这个语义，Typora 也一样）。
     *
     *  返回：null = 这一下是正常编辑（放行给浏览器/Vditor）；
     *        {owner,char:'start'|'end'} = 删掉公式这一端的那一个 `$`（见 deleteFenceChar）；
     *        {owner,action:'open'} = 只挪光标不改文档（块级合并那两类，见 openFormula）。
     */
    const boundaryNode=(range,backward)=>{
      if(!range.collapsed)return null;
      const at=el(range.startContainer);
      const owner=at?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
      const edge=owner&&ownMath(owner)?formulaEdge(owner,range):null;
      if(edge){
        const block=owner.matches('[data-type="math-block"]');
        // 光标站在围栏文本上（展开态下它就是屏幕上的真文本）：删掉这一个 `$`。
        // 但站在围栏**两端**时，退格/删除指的是围栏外那一个字符——那不是我们的事，放行。
        if(edge.layer==='fence'){
          const text=range.startContainer;
          const inside=text.nodeType!==3||(backward?range.startOffset>0:range.startOffset<text.data.length);
          if(inside)return {owner,char:edge.where};
          // 【B4·R1 判决】上面"放行"只对**行内**公式成立（围栏外那一个字符确实是正文）。
          // 块公式的开 $$ 围栏文本最左端（offset 0）退格一旦放行，浏览器接着做的是**块级
          // 合并**：上一段并进公式、引用块的 `>` 前缀被削掉——正是 openFormula 一直在挡、
          // 外边界那条（layer==='outer'）已经挡住的同一类，只是从围栏文本这个入口漏了进来。
          // 所以这一支与外边界同路：action:'open' 展开源码整条选中，不并段、不删字符。
          if(block&&backward&&edge.where==='start')return {owner,action:'open'};
          return null;
        }
        // 光标落在渲染预览子树里：删的也是靠这一端的那一个 `$`。
        if(edge.layer==='preview')return {owner,char:edge.where};
        // 外边界：贴边那一下删的就是靠这一端的那一个 `$`（`$a$` 后面退格 → 闭 `$` 没了，
        // 公式变成 `$a` 这段普通文本；内容一个字符都不少）。
        if(edge.layer==='outer'){
          if(backward?edge.where==='end':edge.where==='start')return {owner,char:edge.where};
          // 块公式外侧开头的退格是**块级合并**（把整块并进上一段，实测 公式前的段落。x+y=1）。
          // 与围栏无关，仍然挡住了——挡住的理由、实测证据见 openFormula 上面那段注释。
          if(block&&backward&&edge.where==='start')return {owner,action:'open'};
          return null;
        }
        // 源码的 0 处退格 = 删开围栏、源码末尾删除 = 拆闭围栏，两者都是那一个 `$`。
        // 向内删除（源码末尾退格、源码开头删除）是正常改公式，放行——用户修公式尾巴的常规手势。
        if(edge.layer==='code'&&(backward?edge.where==='start':edge.where==='end'))return {owner,char:edge.where};
      }
      // 光标落在**位置型**（元素级）位置上、相邻的那个元素是公式节点：贴边那一下删的是它靠
      // 这一端的围栏字符。块公式不走这一支——块与块之间的相邻关系是**块级合并**（见下面两条），
      // 与围栏无关；实测（子代理扫全仓）在元素级位置上把块公式当"围栏字符"删会把
      // 75 的 Ctrl+End/文末删除那几条"文档结构不变"的断言一起带红。
      const inlineOwner=node=>node?.nodeType===1&&ownMath(node)&&!node.matches('[data-type="math-block"]');
      const before=neighbour(range,true),after=neighbour(range,false);
      if(backward&&inlineOwner(before))return {owner:before,char:'end'};
      if(!backward&&inlineOwner(after))return {owner:after,char:'start'};
      // 光标停在块公式旁边（位置型相邻，两个方向都算）：块级边界，见 openFormula。
      // 实测（probe-fence-text.cjs 的 F5）：这个位置放行给浏览器时，一次退格会把**后面
      // 那一整段**删掉（`后段乙` 从 markdown 里消失）——所以这里必须继续挡住。
      const blockNear=node=>node?.nodeType===1&&node.matches('[data-type="math-block"]')&&ownMath(node);
      if(blockNear(before)||blockNear(after))return {owner:blockNear(before)?before:after,action:'open'};
      // 段落贴边：段首退格 / 段尾删除会把相邻的块公式并成一行文本。相邻的块公式不一定在
      // 同一个父节点下——素材里 `> $$` 与后面那行 `(2)` 之间夹了一行不带 > 的空行时，两者
      // 分处两个 blockquote，实测段首退格会把整段引用块的 > 前缀削掉（用户报告的就是这一类）。
      const block=at?.closest('p,li');
      if(!block||!block.contains(range.startContainer))return null;
      const probe=document.createRange();probe.selectNodeContents(block);
      if(backward)probe.setEnd(range.startContainer,range.startOffset);else probe.setStart(range.startContainer,range.startOffset);
      if(clean(probe.toString()).length)return null;
      const near=nearBlockOf(block,backward);
      return near?{owner:near,action:'open'}:null;
    };
    // 从段落往上找"紧邻的块公式"：同级兄弟，或上一层的兄弟**末尾/开头**就是块公式
    // （blockquote 的最后一个子节点是公式时，段首退格会把这行并进公式里）。
    const nearBlockOf=(block,backward)=>{
      let node=block;
      while(node&&node!==root&&root.contains(node)){
        let near=node[backward?'previousElementSibling':'nextElementSibling'];
        while(near&&near.nodeType===3&&!near.textContent.trim())near=near[backward?'previousElementSibling':'nextElementSibling'];
        if(near){
          if(near.nodeType!==1)return null;
          if(near.matches('[data-type="math-block"]')&&ownMath(near))return near;
          const edge=near[backward?'lastElementChild':'firstElementChild'];
          return edge?.matches?.('[data-type="math-block"]')&&ownMath(edge)?edge:null;
        }
        node=node.parentElement;
      }
      return null;
    };
    /** 光标所在的**空块公式**（源码里没有任何字符，可能只挂着一个 <wbr>）。
     *  用户报告（2026-09-17）：`$$\n\n$$` 这样的空块在页面上完全看不见，也删不掉。实测
     *  （scripts/acceptance/probe-empty-block.cjs）点进它的源码再按删除，浏览器会在
     *  `pre > code` 里删出一个 Lute 认不出的形状，markdown 当场写进一行**字面 `span`**
     *  （`$$\nspan\n$$`，公式于是渲染出 "span" 这个词）。所以这一下不回文档：整条空公式
     *  按"删掉整条公式"处理（removeNode 本来就是这条路径，撤消/保存在既有通道上）。 */
    const emptyMathBlock=()=>{
      const s=getSelection(),node=e[e.currentMode]?.element;
      if(!s?.rangeCount||!node?.contains(s.focusNode))return null;
      const owner=el(s.focusNode)?.closest?.('.vditor-ir__node[data-type="math-block"]');
      if(!owner||owner.closest?.(PREVIEW))return null;
      const code=ownMath(owner);
      if(!code||!code.matches('[data-type="math-block"]'))return null;
      return blank(code)?owner:null;
    };
    const keydown=event=>{
      if(event.isComposing)return;
      // 公式源码里没有 Markdown 行内格式：Ctrl+B/I/U/D/K 会把 **** / ** / <u></u> /
      // ~~ / []() 插进 TeX 源码（实测 $a+1$ → $a****+1$，公式当场坏掉）。剪贴板、历史、
      // 全选照旧。【S4·R2】d/k 是本轮补的：与 b/i/u 同一条吞键路径（FORMATTING 集合）。
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&FORMATTING.has(String(event.key||'').toLowerCase())){
        const math=activeMath();
        if(math){event.preventDefault();event.stopImmediatePropagation();return;}
      }
      // Ctrl/Cmd + 退格/删除（按词删）走的是同一段浏览器默认删除，只是步长一个词：它同样
      // 会把块公式整条并进上一段、把围栏拆散。实测在用户素材上：光标停在 `$$ … $$` 之前按
      // Ctrl+Backspace，`> (1)` 那一行当场变成 `> (1)\neg\,\exists x\in A, P(x)\;\Leftrightarrow…`
      // （公式散成引用块里的文字）。所以带 Ctrl/Cmd 的退格/删除也要过一遍下面那段贴边保护；
      // 保护之外的行为一个字都不改（判完就返回，交给 Vditor 与浏览器）。Alt 不碰：
      // Windows 上 Alt+Backspace 是系统的"撤销"。
      const wordDelete=(event.ctrlKey||event.metaKey)&&!event.altKey&&(event.key==='Backspace'||event.key==='Delete');
      if((event.ctrlKey||event.metaKey||event.altKey||event.isComposing)&&!wordDelete)return;
      // 行内公式源码里回车会把 TeX 拆断（实测 $a+1$ → $a$a+1+1$）。TeX 的单行公式不能
      // 跨行，所以这一下不回文档：只把光标移到公式之后（第二下回车就是正常断行）。
      // 块公式是多行源码，回车照旧插入换行。
      if(event.key==='Enter'){
        const code=activeCode();
        if(code){
          event.preventDefault();event.stopImmediatePropagation();
          const selection=getSelection();
          if(selection?.rangeCount)caretOutside(ownerFor(code),'end',selection.getRangeAt(0));
          return;
        }
      }
      const code=activeCode(),empty=activeEmpty(),selection=getSelection();
      const range=selection?.rangeCount?selection.getRangeAt(0):null;
      // 空块公式：它是屏幕上的一处空白（用户报的"隐形垃圾"），浏览器在它里面删除会把
      // markdown 写坏（见 emptyMathBlock 上面那段注释）。这一下由我们整条移除。
      const shell=['Backspace','Delete'].includes(event.key)?emptyMathBlock():null;
      /** 行内公式只剩**最后一个字符**、而这一下正好删它：整条摘掉，不留空壳。
       *  用户 2026-09-17 报告："一旦把这个 inline math 的 fence 内的内容删掉之后, 会突变成
       *  block math fence!"——空的行内公式会被序列化成独占一行的 `$$`，下一次解析就成了
       *  块公式围栏。实测（probe-fence-text.cjs F7b）这条路**不一定**经过 commit（打点计数：
       *  commit 1 次、blank 0 次），所以不能只在 commit 里兜底，删除方向上直接自己接管。 */
      const lastCharHit=()=>{
        if(!code||!range||!code.contains(range.startContainer))return false;
        const rest=clean(code.textContent);
        if(rest.length!==1)return false;
        const box=document.createRange();box.selectNodeContents(code);
        box.setEnd(range.startContainer,range.startOffset);
        const at=clean(box.toString()).length;
        return event.key==='Backspace'?at>=rest.length:at<=0;
      };
      if(event.key==='Backspace'||event.key==='Delete'){
        if(shell){
          event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);
          removeNode(shell);return;
        }
        if(lastCharHit()){
          event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);
          removeNode(ownerFor(code));return;
        }
        // 整篇被选中 → 记一笔，等浏览器删完、Vditor 重排完再看是不是留了空公式壳
        // （怎么发现的、为什么这么修，全写在 reclaimCleared 上面那段注释里）。
        if(wholeSelected(e[e.currentMode].element,range))watchCleared();
        // 整条公式被选中（上一步刚选中的形状，或用户自己拖选出来的）→ 自己摘掉节点。
        // 浏览器删 div[data-type="math-block"] 会在 markdown 里留下残渣（实测出现一行
        // 字面 "span"，后面的段落也一起被吃掉）。
        const picked=mathNodeOfRange(root,range);
        if(picked){
          event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);
          removeNode(picked);return;
        }
        // 贴着公式的位置（公式前/后、块公式的围栏、源码的 0 处、渲染结果里）：
        // **围栏当普通字符**——删掉靠这一端的那一个 `$`（见 boundaryNode / deleteFenceChar）。
        // 只剩"块级合并"那一类（相邻段落首/尾紧贴块公式）仍然不改文档，改成展开+选中源码。
        // 这条检查必须跑在"光标在公式源码里"之前：源码的 0 处也是围栏位置。
        const hit=range&&root.contains(selection.focusNode)?boundaryNode(range,event.key==='Backspace'):null;
        if(hit){
          event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);
          // 围栏当普通字符：删掉那一个 `$`（见 boundaryNode / deleteFenceChar 的注释）。
          if(hit.char)deleteFenceChar(hit.owner,hit.char);
          else if(hit.action==='open')openFormula(hit.owner);
          refreshMathEditing(api);
          return;
        }
      }
      // 带 Ctrl/Cmd 的退格/删除只借道上面那段贴边保护，其余一概照旧交给 Vditor 与浏览器
      // （按词删、跨行删都不该因为我们而变样）。
      if(event.ctrlKey||event.metaKey)return;
      if(!code&&!empty)return;
      if(['Backspace','Delete'].includes(event.key)&&(empty||code&&!clean(code.textContent))){
        event.preventDefault();event.stopImmediatePropagation();e.undo.recordFirstPosition(e,event);toggleMath(api);queueUndo();return;
      }
      // Vditor treats | as a table-navigation delimiter and $ as Markdown.
      // Inside formula source both are ordinary TeX input. Keep the browser's
      // native edit, but don't run Vditor's general Markdown key handler.
      if(event.key.length===1&&!event.isComposing){e.undo.recordFirstPosition(e,event);event.stopImmediatePropagation();}
    };
    const beforeinput=event=>{
      // 整篇被选中后删除：除了键盘，还有右键菜单 / Edit 菜单的"删除"这类入口（实测走
      // execCommand('delete')，那条路径上**一次 keydown 都没有**，只靠 keydown 记的那一笔
      // 会漏掉它——探针的 execCommand 实验就是这么露出空壳的）。删除发生**之前**选区还是
      // "整篇"，判据与 keydown 那条完全相同，所以这里多看一处不增加任何风险面。
      // （R1·B7 曾在此扩到 insertText，复现轮证明该形态现状已正确——撤销，不落地。）
      if(String(event.inputType||'').startsWith('delete')){
        const s=getSelection(),range=s?.rangeCount?s.getRangeAt(0):null;
        if(range&&wholeSelected(e[e.currentMode].element,range))watchCleared();
      }
      // 光标站在围栏上打字：围栏不是文档里的字符，字符只能落进源码。先把光标挪到源码的
      // 对应一端（开围栏→0，闭围栏→末尾），再替浏览器把这次输入插进去。
      const fence=fenceCaret();
      if(fence&&event.cancelable&&event.inputType==='insertText'&&event.data){
        event.preventDefault();event.stopImmediatePropagation();
        // 光标站在围栏的**外侧**（开 $ 之前 / 闭 $ 之后）：这一下属于正文，别塞回公式
        if(fence.outside){insertBeside(fence.owner,event.data,fence.outside==='end');return;}
        const text=fence.open?fence.code.firstChild:fence.code.lastChild;
        if(text?.nodeType===3){choose(root,text,fence.open?0:text.length);pending=fence.code;document.execCommand('insertText',false,event.data);}
        return;
      }
      if(fence&&event.inputType==='insertCompositionText'){
        // 输入法在围栏外侧起手：先把光标挪到公式外的**真实文本位置**再让输入法往里打，
        // 否则上屏的字会落进 `$` 标记、被当成公式源码收走。
        if(fence.outside){standOutside(fence.owner,fence.outside==='end');compositionCode=null;return;}
        compositionCode=fence.code;choose(root,fence.open?fence.code.firstChild:fence.code.lastChild,fence.open?0:fence.code.lastChild.length);return;
      }
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
    const compositionstart=()=>{
      const fence=fenceCaret();
      if(fence){
        // 【2026-10-01 用户报"重大 bug"】光标站在围栏的**外侧那一半**时（开 `$` 之前 / 闭 `$`
        // 之后），输入法起手不能把光标挪进源码——挪进去之后 composition 上屏的字就成了公式源码。
        // 实测（scripts/acceptance/probe-math-exit-type.cjs V6）：源码末尾按 → 到闭 `$` 之后，
        // 输入法上屏一个 Q → 落点变成 `CODE[math-inline]@13`、源码长成 `…kQ`，存盘 `$…kQ$`，
        // 字落在 `$…$` **里面**。普通按键走 beforeinput 那条路本来就有 outside 分支，
        // 只有这里漏了：补上同一判断（外侧 → 先把光标立到公式外的真实文本位置）。
        if(fence.outside){standOutside(fence.owner,fence.outside==='end');compositionCode=null;return;}
        compositionCode=fence.code;choose(root,fence.open?fence.code.firstChild:fence.code.lastChild,fence.open?0:fence.code.lastChild.length);return;
      }
      compositionCode=activeCode();
    };
    const compositionend=()=>{const code=compositionCode;compositionCode=null;if(recoverMarkerInput(code))commit(code);};
    const paste=event=>{
      const fence=fenceCaret();
      if(fence&&event.clipboardData){
        event.preventDefault();event.stopImmediatePropagation();
        const text=event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n');
        // 【A1·R1 判决】光标站在围栏的**外侧那一半**（开 $ 之前 / 闭 $ 之后）：粘贴的内容属于
        // 正文，不能塞回公式源码。beforeinput（insertText）与 compositionstart（输入法起手）
        // 早就是这条口径（各自都有 fence.outside 分支），唯独 paste 这里漏了——于是闭 $ 右半
        // Ctrl+V 的文字整段落进源码、存盘后被包进 $…$ 里。对齐同一条路：insertBeside 把
        // 内容落到公式外侧的真实文本位置（块公式没有 outside，不经过这支，维持有意设计）。
        if(fence.outside){insertBeside(fence.owner,text,fence.outside==='end');return;}
        const tail=fence.open?fence.code.firstChild:fence.code.lastChild;
        // 【E2·R1 实测】行内公式源码里不能有换行：多行文本粘进来，存盘的 md 变成
        // $xa\n\nb\n$，重开文件整条公式散架（Lute 行内不跨行）。块公式源码本来就
        // 多行，保持原样。表格里的行内公式先压平再交给 tableSource。
        const body=fence.code.matches?.('[data-type="math-inline"]')?text.replace(/\n+/g,' '):text;
        if(tail?.nodeType===3){choose(root,tail,fence.open?0:tail.length);pending=fence.code;document.execCommand('insertText',false,fence.code.closest('td,th')?tableSource(body):body);}
        return;
      }
      const code=activeCode(),empty=code?null:activeEmpty();if((!code&&!empty)||!event.clipboardData)return;
      event.preventDefault();event.stopImmediatePropagation();
      // 【E2·R1】同上：粘进**行内**公式源码（含空公式起手）的文本先压平换行，块公式不动。
      const flat=code?.matches?.('[data-type="math-inline"]')||empty?.code?.matches?.('[data-type="math-inline"]');
      const text=flat?event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n').replace(/\n+/g,' '):event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n');
      if(empty)fillEmpty(empty,text);
      else {pending=code;document.execCommand('insertText',false,code.closest('td,th')?tableSource(text):text);}
    };
    /** 光标是不是站在公式的围栏（$$ / $）上——围栏是渲染生成的，字符只能进源码。
     *  返回 null（不在围栏上）或 {code, owner, open, outside}。
     *
     *  【2026-09-16】行内公式的围栏只有一个 `$` 宽，它**有两半**：
     *      ab|$y$     光标在开 `$` 之前 → 外侧，字符属于正文
     *      ab$|y$     光标在开 `$` 之后 → 内侧，字符属于公式（源码开头）
     *      ab$y|$     光标在闭 `$` 之前 → 内侧，字符属于公式（源码末尾）
     *      ab$y$|     光标在闭 `$` 之后 → 外侧，字符属于正文
     *  原来四者一律当成"进源码"，于是用户把光标挪到右 `$` 之外再打字，字又被塞回公式里
     *  （用户 2026-09-16 报告："右方向键到右 dollar 符之外再键入任何内容，光标也会跳回数学区"）。
     *  块公式的 `$$` 是块自己的边界（前后没有"外侧正文"这回事），保持原样。 */
    const fenceCaret=()=>{
      const s=getSelection();
      if(!s?.rangeCount||!root.contains(s.focusNode))return null;
      const at=el(s.focusNode);
      const owner=at?.closest('.vditor-ir__node,.vditor-wysiwyg__block');
      const code=owner&&ownMath(owner);
      if(!code||!owner.contains(at)||at===code||at.closest('code'))return null;
      const mark=at.closest?.(MARKER);
      if(!mark||!owner.contains(mark))return null;
      const open=mark===owner.firstElementChild;
      if(code.matches('[data-type="math-inline"]')){
        const text=mark.firstChild;
        const width=text&&text.nodeType===3?text.data.length:0;
        const offset=text&&text.nodeType===3&&s.focusNode===text?s.focusOffset:0;
        // 开 $ 的内侧是 offset>=1，闭 $ 的内侧是 offset<=len-1；外侧则相反
        if(!(open?offset>=1:offset<=width-1))return {code,owner,open,outside:open?'start':'end'};
      }
      return {code,owner,open};
    };
    /** 在公式节点的**外侧**落一段文本：直接建一个装着这段文字的文本节点。
     *  不落在"位置型光标"或"空文本节点"上——那两种位置会被 Chromium 归一化回紧邻的 `$` 标记，
     *  字就进了公式（探针 probe-outside-point：位置型光标本身没问题，空文本节点上的位置会跑偏）。
     *  $ 外侧本来就有文本节点时直接用它。 */
    const insertBeside=(owner,data,after)=>{
      const block=owner?.parentNode;if(!block)return false;
      const adjacent=after?owner.nextSibling:owner.previousSibling;
      if(adjacent&&adjacent.nodeType===3&&adjacent.length){
        // after：插在公式**之后**那段正文的开头（offset 0）；before：插在它前面那段的末尾
        choose(root,adjacent,after?0:adjacent.length);
        pending=null;document.execCommand('insertText',false,data);return true;
      }
      const text=document.createTextNode(data);
      if(after)owner.after(text);else owner.before(text);
      choose(root,text,text.length);
      // 走和软换行同一条路：自己派发 input 事件，宿主才知道文档被改过
      e[mode].preventInput=true;
      root.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data}));
      e.undo.addToUndoStack(e);
      return true;
    };
    /** 只把光标挪到公式外侧（不插字）：给输入法起手用（候选串要落在公式外）。
     *  优先用外侧已有的文本节点；没有就用父元素的边界位置。 */
    const standOutside=(owner,after)=>{
      const block=owner?.parentNode;if(!block)return false;
      let adjacent=after?owner.nextSibling:owner.previousSibling;
      while(adjacent&&adjacent.nodeType===3&&!adjacent.length)adjacent=after?adjacent.nextSibling:adjacent.previousSibling;
      if(adjacent&&adjacent.nodeType===3){choose(root,adjacent,after?0:adjacent.length);return true;}
      choose(root,block,[...block.childNodes].indexOf(owner)+(after?1:0));
      return true;
    };
    // 展开后，前后两道围栏（块公式的 $$、行内的 $）是屏幕上真实的文本节点，Vditor 却不把
    // 它们当可编辑内容：实测点后 $$ 光标会跑到下一段、点前 $$ 左半边光标被甩到块外。用户要
    // 的是"光标可以自由插入到前后两个 dollar 符的位置"，所以这里按**几何**落点自己放光标：
    //   点渲染结果        → 交给 Vditor（点公式=展开源码，光标落到源码开头）
    //   点围栏 $$（展开态）→ 光标就落在围栏自己身上（$ 前 / 两个 $ 之间 / $ 后）
    //   点折叠态的空白留白 → 光标落到公式块之前或之后（按点在上半还是下半）
    // 第三条是关键：折叠时源码是隐藏的（实测源码 pre 是 0×0 的壳，点它下边的留白会被
    // Chromium 映射成源码里某个看不见的位置，再按退格就删掉了公式里的一个字符——用户报告
    // "在 (2) 之前按退格，直接删除 $$…$$ 内部的公式"）。落点必须翻译成看得见的位置。
    /** 贴着折叠块公式的空白留白：返回 {node, after}，否则 null。
     *  顶层块按纵向排列（文档序 = 纵向序），所以先按 clientY 二分定位到"点所在的那一块"，
     *  避免在几千个顶层块上逐个量几何（大文档里那是几十毫秒）。只在点确实落在公式盒子上/
     *  下方 10px 以内、且横向在编辑面之内时才认。
     *  **落点压在别的块身上就不算留白**（用户报告 2026-09-14 第 5 条："点任何字的**偏上**都会
     *  跑到这行的最开始，应该是点击在行内相对高度判定的问题"）。实测（探针 probe-paren13，
     *  真产物 + 用户文档第 227 行附近）：上一块是 130px 高的块公式、盒子到 y=387 为止，
     *  下一段正文的盒子从 y=387 开始；±10px 容差于是把"正文第一行字的上半截"（字形盒大约从
     *  y=386/391 起）整段算成了"公式下方的留白"，落点被翻译成公式之后那个插入点 `(根, 92)`
     *  ——正好是**这一行的最开始**，与用户描述完全一致。留白在几何上就是"任何块的盒子之外"，
     *  所以补这一条判定：落点落在别的块的盒子里 → 那是正文，交回给浏览器。 */
    const blankLanding=(x,y)=>{
      const kids=root.children;if(!kids.length)return null;
      let lo=0,hi=kids.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(kids[mid].getBoundingClientRect().bottom<y)lo=mid+1;else hi=mid;}
      for(const index of [lo,lo-1]){
        const block=kids[index];if(!block)continue;
        const node=block.matches('.vditor-ir__node[data-type="math-block"]')?block
          :[block.firstElementChild,block.lastElementChild].find(child=>child?.matches?.('.vditor-ir__node[data-type="math-block"]'));
        if(!node||!ownMath(node)||node.classList.contains(EXPAND))continue;
        const box=node.getBoundingClientRect(),host=root.getBoundingClientRect();
        if(x<host.left-2||x>host.right+2)continue;
        if(y<box.top-10||y>box.bottom+10)continue;
        const other=kids[index===lo?lo-1:lo];
        if(other){const side=other.getBoundingClientRect();
          if(y>=side.top&&y<=side.bottom&&x>=side.left-1&&x<=side.right+1)return null;}
        return {node,after:y>box.top+box.height/2};
      }
      return null;
    };
    const fenceClick=event=>{
      if(event.button!==0)return;
      // 只接管"平平常常的单次左键点击"。带修饰键（shift 扩选、ctrl 多选）和双击/三连击
      // 都交给浏览器，免得把拖选、选词这类手势一起废掉。
      if(event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.detail>1)return;
      const target=el(event.target);
      const owner=target?.closest?.('.vditor-ir__node,.vditor-wysiwyg__block');
      const code=owner&&ownMath(owner);
      if(!code||!owner.contains(target)){
        // 落点不在任何公式里，但可能**贴着**一条折叠的块公式（公式上/下方那条留白，或者
        // 文档最上面的页边距）。留白不属于任何块，Chromium 会把这个点解析成隐藏源码里
        // 离它最近的位置。实测点"文档首块公式上方 4px"，得到的光标是
        // `CODE.math-block@7`（也就是 a0+b0=1 的末尾），我们自己的刷新随后把这条公式
        // 展开、让它看起来像"用户正在编辑公式尾巴"，接着一次退格就把源码吃成 a0+b0=。
        // 文档序里"公式之前的留白"就是"这条公式之前"这个插入点，所以按几何翻译过去。
        const blank=blankLanding(event.clientX,event.clientY);
        if(!blank)return;
        event.preventDefault();event.stopImmediatePropagation();
        const landing=document.createRange();
        if(blank.after)landing.setStartAfter(blank.node);else landing.setStartBefore(blank.node);
        landing.collapse(true);
        const caret=getSelection();caret.removeAllRanges();caret.addRange(landing);
        refreshMathEditing(api);
        return;
      }
      if(target.closest?.(PREVIEW))return;
      const expanded=owner.classList.contains(EXPAND);
      const type=target.dataset?.type||'';
      const open=/open-marker/.test(type)||(!type&&target===owner.firstElementChild&&target.matches?.(MARKER));
      const close=/close-marker/.test(type)||(!type&&target===owner.lastElementChild&&target.matches?.(MARKER));
      if(open||close){
        if(!expanded)return;
        const text=target.firstChild?.nodeType===3?target.firstChild:null;
        if(!text)return;
        const rect=target.getBoundingClientRect();
        const share=rect.width?(event.clientX-rect.left)/rect.width:0;
        event.preventDefault();event.stopImmediatePropagation();
        choose(root,text,Math.round(share*text.length));
        refreshMathEditing(api);
        return;
      }
      // 展开态下源码/预览都是看得见的，落点交给浏览器就是所见即所得。
      // 【2026-09-23】"源码看得见"不止 `--expand` 一种：拖选跨过渲染结果会让节点带上
      // `typora-ir-selected`（REVEAL，见 math-select-reveal.js），源码同样摊在屏幕上。
      // 旧实现只认 `--expand`，于是 REVEAL 态里**按在源码文字上**也被当成"点折叠公式"：
      // 一律 preventDefault + stopImmediatePropagation，把光标扔到公式外（下半区 → 公式之后）。
      // 实测（scripts/acceptance/probe-repro-reveal-press-flip.cjs）：点源码第 8 格，
      // 松手快时光标落到源码第 0 位。按下落点在源码 `code` 里就是所见即所得，交给浏览器。
      if(expanded||target.closest?.(MATH))return;
      const box=owner.getBoundingClientRect();
      const forward=code.matches(INLINE)?event.clientX>box.left+box.width/2:event.clientY>box.top+box.height/2;
      event.preventDefault();event.stopImmediatePropagation();
      const range=document.createRange();
      if(forward)range.setStartAfter(owner);else range.setStartBefore(owner);
      range.collapse(true);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      refreshMathEditing(api);
    };
    root.addEventListener('keydown',keydown,true);root.addEventListener('beforeinput',beforeinput,true);root.addEventListener('input',input,true);root.addEventListener('paste',paste,true);
    root.addEventListener('compositionstart',compositionstart,true);root.addEventListener('compositionend',compositionend,true);
    root.addEventListener('mousedown',fenceClick,true);
    removers.push(()=>{root.removeEventListener('keydown',keydown,true);root.removeEventListener('beforeinput',beforeinput,true);root.removeEventListener('input',input,true);root.removeEventListener('paste',paste,true);root.removeEventListener('compositionstart',compositionstart,true);root.removeEventListener('compositionend',compositionend,true);root.removeEventListener('mousedown',fenceClick,true);});
  }
  let scheduled=false;
  const refresh=()=>refreshMathEditing(api);
  const queue=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;refresh();});};
  const blur=()=>{blurredEditors.add(api);queue();},focus=()=>{blurredEditors.delete(api);queue();};
  // Vditor 自己会在选区变化时给光标所在（或紧邻的）vditor-ir__node 挂上 --expand，时机
  // 不受我们控制：我们那一遍"收回"常常跑在它前面，于是预渲染框留在屏幕上、光标却已经在
  // 外面的文字里——用户报告的就是这个（行尾插光标，最后一个公式弹出预渲染框）。同一处
  // 点击实测有时收得回、有时收不回，靠"再跑一遍"永远是在赌时序。所以这里改成结构上强制：
  // 只要公式节点上的展开类不是"光标真的在它的源码/预览里"造成的，立刻撤掉。
  const enforce=records=>{
    const mode=e.currentMode;if(mode!=='ir'&&mode!=='wysiwyg')return;
    const active=e[mode]?.element;if(!active)return;
    // 文档装载/切换过程中 Vditor 会成批改类，这里只挑"公式节点上的展开类"这一件事检查，
    // 命中不了就立刻返回；单条记录的代价是一次 classList 判断。
    for(const record of records){
      const node=record.target;
      if(node.nodeType!==1||!node.classList?.contains(EXPAND))continue;
      if(!active.contains(node)||!ownMath(node))continue;
      const selection=getSelection();
      if(!selection?.rangeCount||!active.contains(selection.focusNode))continue;
      const at=el(selection.focusNode);
      const code=at?.closest(MATH);
      const preview=at?.closest(PREVIEW);
      // 光标在源码里、或选区落在渲染预览里，才算"这条公式正在被编辑"。
      if(code&&!code.closest(PREVIEW)&&ownerFor(code)===node)continue;
      if(preview&&node.contains(preview))continue;
      // 光标站在围栏 $$ 上（展开态下真实可见的位置）同样算"正在编辑这条公式"：
      // 收回展开类会把光标留在一个 display:none 的标记里。
      const mark=at?.closest?.(MARKER);
      if(mark&&node.contains(mark))continue;
      node.classList.remove(EXPAND);
      expandedOwners.delete(node);
    }
  };
  const observer=new MutationObserver(enforce);
  observer.observe(document,{subtree:true,attributes:true,attributeFilter:['class']});
  // ---- ↑/↓ 落进相邻空段落（2026-10-02 用户报告：光标在 `### 工程问题` 行首，上一行已
  // 是 Enter 建立的新空行，按 ↑ 上不去） ----
  // 复现读数（.zcode-tmp/r15/n-repro2 + n-diag，真实素材副本 + 真实输入）：标题行首按
  // Enter 正确建立 `<p data-block="0"><br></p>`（带 25px）；随后三发 ↑ 光标全部钉死在
  // 标题 marker 文本 offset 0 不动，typora-patches 纵向补丁的 trace 全程
  // `resolve 候选:[]`。微观取证：空段带内 caretRangeFromPoint 只给 `(P,0)`、矩形
  // [0,0,0,0]——usable 的 visibleBox(height) 筛子把它整段拒收，scan 于是零候选，
  // 走"到顶/到底"分支 preventDefault+stopImmediatePropagation 吞键。空行也是行
  // （验收规则三.1：两次落点之间不许还有能落光标的行），↑ 必须能落进去。
  //
  // 修法（本文件注册于 installMathEditing，applyTyporaPatches 里先于
  // patchVerticalMathLine 调用——同一 window 同阶段监听按注册序执行，这里先到先得）：
  // 只接管"光标贴着所在块的首/末视觉行、且该方向上紧邻的兄弟块是一条空段落"的那一按，
  // 把光标放到 `(空P, 0)`（空行上唯一的位置，无目标列语义）并拦下后续监听；其余情形
  // 一律原样放行，逐行行进仍归 typora-patches 的纵向补丁。从空段落**出来**的方向不用
  // 管且不能管：那里光标锚框是 0×0、纵向补丁会让位（无 before 锚即 return，不吞键），
  // 浏览器原生接管，实测空段里按 ↓ 原生落点正确（n-diag：落标题行首 marker@0）。
  // 若主会话后续把空段落接进 typora-patches 的 scan/usable，本段可整体摘除。
  const emptyLineVertical=event=>{
    if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
    if(event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    if(event.isComposing||e.ir?.composingLock)return;
    if(e.currentMode!=='ir')return;
    if(event.defaultPrevented)return;
    // 补全浮层开着时 ↑/↓ 是面板导航键（与 typora-patches C2 同判据同口径）：让位。
    if(document.querySelector('.md-completion:not([hidden]),.md-completion-preview:not([hidden],dialog.md-completion-settings[open]'))return;
    const irRoot=e.ir?.element;if(!irRoot)return;
    const surface=irRoot.matches?.('.vditor-reset')?irRoot:irRoot.querySelector?.('.vditor-reset');
    if(!surface)return;
    const selection=getSelection();
    if(!selection?.rangeCount||!selection.isCollapsed)return;
    if(!surface.contains(selection.focusNode))return;
    if(!document.hasFocus())return;
    // 出发锚：光标此刻必须量得出可见矩形。空段落里的 (P,0) 是 0×0（上面"出来方向"
    // 的注释），没有"从哪一行出发"的锚就不属于这里的案子。
    const probe=document.createRange();
    probe.setStart(selection.focusNode,selection.focusOffset);probe.collapse(true);
    const box=probe.getBoundingClientRect();
    if(!box||!(box.height>0))return;
    // 光标所在的顶层块（surface 直接子级）。
    let node=selection.focusNode;
    while(node&&node.parentElement&&node.parentElement!==surface)node=node.parentElement;
    if(!node||node.nodeType!==1||node.parentElement!==surface)return;
    const blockBox=node.getBoundingClientRect();
    if(!(blockBox.height>0))return;
    const forward=event.key==='ArrowDown';
    // 只认"贴着块缘"的那一按：↑ 须在块的首视觉行、↓ 须在块的末视觉行；块内换行的
    // 中间行不属于这里（逐行行进交给纵向补丁，本段不得截胡）。判缘用**块内容行盒**
    // （selectNodeContents 的 client rects）：光标行上方/下方还有整条内容行＝不在缘上。
    // 比"行高×系数"的容差可靠——容差会把两行块的第二行也放进来（行距 ≈ 1.0×行高时
    // 罩不住），↑ 一步跨过第一行＝跳行。
    const contentRects=(()=>{const r=document.createRange();
      try{r.selectNodeContents(node);}catch{return[];}
      return [...r.getClientRects()].filter(b=>b.height>0);})();
    if(!contentRects.length)return;
    const above=contentRects.some(b=>b.bottom<=box.top+2);    // 光标行上方还有内容行
    const below=contentRects.some(b=>b.top>=box.bottom-2);    // 光标行下方还有内容行
    const onEdge=forward?!below:!above;
    if(!onEdge)return;
    // 方向上紧邻的可见兄弟块。
    let sibling=forward?node.nextElementSibling:node.previousElementSibling;
    while(sibling&&sibling.nodeType===1&&!sibling.getClientRects().length)
      sibling=forward?sibling.nextElementSibling:sibling.previousElementSibling;
    if(!sibling||sibling.tagName!=='P'||sibling.parentElement!==surface)return;
    // 空段落＝没有任何可落文字，子节点只剩 <br>/<wbr> 与空白/零宽哨兵文本
    // （Enter 建立的形状实测是 `<p data-block="0"><br></p>`）。含公式/图片等元素
    // 子节点的一律不算——那些行有自己的落点语义，交回纵向补丁。
    let emptyLine=true;
    for(const child of sibling.childNodes){
      if(child.nodeType===3){if(child.data.replace(/[\s\u200b]/g,'')){emptyLine=false;break;}continue;}
      if(child.nodeType===1&&/^(BR|WBR)$/.test(child.tagName))continue;
      emptyLine=false;break;
    }
    if(!emptyLine)return;
    const siblingBox=sibling.getBoundingClientRect();
    if(!(siblingBox.height>0))return;
    // 方向 sanity：目标块须真的在来向一侧（↑ 的目标在上方 / ↓ 的在下方）。
    if(forward?siblingBox.top<box.bottom-2:siblingBox.bottom>box.top+2)return;
    const landing=document.createRange();
    landing.setStart(sibling,0);landing.collapse(true);
    event.preventDefault();event.stopImmediatePropagation();
    surface.focus({preventScroll:true});
    selection.removeAllRanges();selection.addRange(landing);
    // 探针读得到的落点标记（与 __typoraMarkerCaret 同款取证口径）。
    window.__typoraEmptyLineLanding={at:Date.now(),dir:forward?'down':'up',
      from:node.tagName,fromTop:Math.round(blockBox.top),landedTop:Math.round(siblingBox.top)};
  };
  window.addEventListener('keydown',emptyLineVertical,true);
  removers.push(()=>window.removeEventListener('keydown',emptyLineVertical,true));
  document.addEventListener('selectionchange',queue);
  document.addEventListener('pointerup',queue);
  document.addEventListener('keyup',queue);
  window.addEventListener('blur',blur);
  window.addEventListener('focus',focus);
  return()=>{removers.forEach(remove=>remove());observer.disconnect();document.removeEventListener('selectionchange',queue);document.removeEventListener('pointerup',queue);document.removeEventListener('keyup',queue);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);blurredEditors.delete(api);};
}
