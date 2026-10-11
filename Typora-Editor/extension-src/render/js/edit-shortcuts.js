/** Configurable editing commands shared by Electron and VSCode Webviews. */
import {toggleUnderline} from './underline.js';
import {inlineMarkdown} from './selection-markdown.js';
import {copyPlainText,pasteClipboardAsText} from './media-tools.js';
import {toggleMath} from './math-edit.js';
import {dialogSlotFree} from './util.js';
export const DEFAULT_SHORTCUTS = Object.freeze({
  math: 'Ctrl+Shift+E', quote: 'Ctrl+Shift+Q', code: 'Ctrl+Shift+K',
  underline: 'Ctrl+U',
});
const ACTIONS = [
  ['math', '添加 / 取消公式', '选区转为公式；在公式内再次按下可取消'],
  ['quote', '引用', '将选中的段落转为引用，支持多行'],
  ['code', '代码', '单行用行内代码，多行用代码块'],
  ['underline', '下划线', '添加 / 去除下划线，保存为 <u>…</u>'],
];
const PREVIEW = '.vditor-ir__preview,.vditor-wysiwyg__preview';
// TeX 源码本身（行内与块），格式快捷键不能在它里面生效。
const MATH_SOURCE = 'code[data-type="math-inline"],code[data-type="math-block"]';
const STORAGE = 'typora-editor-shortcuts';
const RESERVED=new Set(['Ctrl+B','Ctrl+I','Ctrl+F','Ctrl+H','Ctrl+S','Ctrl+O','Ctrl+Z','Ctrl+Y','Ctrl+X','Ctrl+C','Ctrl+V','Ctrl+A','Ctrl+Shift+Z','Ctrl+Alt+V','Ctrl+Shift+V']);
const elementAt = node => node?.nodeType === 3 ? node.parentElement : node;
// 【S1·R2】【S3·R2】公式禁区判定：选区端点落在 TeX 源码里（MATH_SOURCE），或落在公式
// 围栏 marker（$ / $$）上。围栏口径与 math-edit.js 的 MARKER+ownMath 一致——marker 必须
// 属于一个"直接持有公式源码"的壳；标题的 #、加粗的 ** 也叫 marker，但不是公式围栏，不吞。
const FENCE_MARKER = 'span.vditor-ir__marker,span[data-type$="-marker"]';
const inMathZone = node => {
  const at = elementAt(node);
  if (!at) return false;
  if (at.closest(MATH_SOURCE)) return true;
  const marker = at.closest(FENCE_MARKER);
  return !!marker && !!marker.closest('.vditor-ir__node,.vditor-wysiwyg__block')
    ?.querySelector(':scope > code[data-type="math-inline"],:scope > pre > code[data-type="math-block"]');
};
// 【S3·R2】这些键在公式源码/围栏上与 B/U 同口径吞掉：I/D/K 默认不映射到本文件的
// ACTIONS，会落到 Vditor 自建绑定（Ctrl+I 斜体 *、Ctrl+D 删除线 ~~、Ctrl+K 链接 []()），
// 与映射过的格式命令一样只会把符号塞进 TeX 源码。
const FORMAT_KEYS = new Set(['Ctrl+B','Meta+B','Ctrl+I','Meta+I','Ctrl+U','Meta+U','Ctrl+D','Meta+D','Ctrl+K','Meta+K']);

function canonical(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 80) return null;
  const parts = value.split('+').map(part => part.trim().toLowerCase());
  const key = parts.pop();
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) return null;
  const names = {ctrl:'Ctrl', control:'Ctrl', alt:'Alt', shift:'Shift', meta:'Meta', cmd:'Meta'};
  if (parts.some(part => !names[part])) return null;
  const modifiers = new Set(parts.map(part => names[part]));
  if (!modifiers.has('Ctrl') && !modifiers.has('Alt') && !modifiers.has('Meta')) return null;
  return ['Ctrl','Alt','Shift','Meta'].filter(part => modifiers.has(part)).concat(key.toUpperCase()).join('+');
}
export function normalizeShortcuts(value) {
  return Object.fromEntries(ACTIONS.map(([action]) => {
    const item = value && Object.prototype.hasOwnProperty.call(value, action) ? canonical(value[action]) : null;
    return [action, item === null ? DEFAULT_SHORTCUTS[action] : item];
  }));
}
let current = {...DEFAULT_SHORTCUTS};
try { current = normalizeShortcuts(JSON.parse(localStorage.getItem(STORAGE))); } catch { /* use defaults */ }
export function configureShortcuts(value) {
  current = normalizeShortcuts(value);
  try { localStorage.setItem(STORAGE, JSON.stringify(current)); } catch { /* host still persists settings */ }
  return {...current};
}
function fromEvent(event) {
  let key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key;
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4]))$/i.test(key || '')) return null;
  return canonical([event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift',
    event.metaKey && 'Meta', key].filter(Boolean).join('+'));
}

function selectedMarkdown(editor, range) {
  const container = document.createElement('div');
  container.append(range.cloneContents());
  container.querySelectorAll(PREVIEW).forEach(node => node.remove());
  if (editor.currentMode === 'sv') return container.textContent;
  const convert = editor.currentMode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md';
  return editor.lute[convert](container.innerHTML).replace(/\n$/, '');
}

/** 【R6·F5】加粗作用域按 html-inline 岛（<u>…</u> 等）边界切分：岛标记原样保留，
 *  标记两侧的每段文本各自包裹（`<u>**岛**</u>**外**`）。整段一刀切会得到
 *  `**<u>岛</u>外**`——岛标记被吞进 strong，存盘 md 残留跨岛 `**`，撤销/重排
 *  即嵌套坏标记。Lute 实测切分形双 strong 且 round-trip 保真。 */
function islandScopedMarkdown(editor,box,wrap) {
  const markers=[...box.querySelectorAll('[data-type="html-inline"]')];
  const piece=document.createRange();piece.setStart(box,0);
  const edge=(marker,after)=>{const parent=marker.parentNode;
    return[parent,[...parent.childNodes].indexOf(marker)+(after?1:0)];};
  let md='';
  for(const marker of markers){
    const [parent,offset]=edge(marker,false);
    piece.setEnd(parent,offset);
    md+=wrap(inlineMarkdown(editor,piece));
    const whole=document.createRange();whole.selectNode(marker);
    md+=inlineMarkdown(editor,whole);
    const [startParent,startOffset]=edge(marker,true);
    piece.setStart(startParent,startOffset);
  }
  piece.setEnd(box,box.childNodes.length);
  md+=wrap(inlineMarkdown(editor,piece));
  return md;
}

/** 【R6·F17】无选区取词口径（判词：连续英文数字一词、CJK 连续段一词）：
 *光标落在 ASCII 字母/数字串内（词中/词首/词尾同词）→ 整串一词；落在 CJK 连续段内
 * → 整段（向两侧扩到非 CJK 边界）；两侧都取不到（空格/标点/边界）→ null。
 * 【121②·R10 F9 取证】CJK 由旧「先左后右各一字」改为整段：真机 Typora 16/16 实测，
 * `中文加粗测试` 整段裹、`词中混a合测试` 裹「词中混」或「合测试」（ASCII 是边界）；
 * CJK|ASCII 类边界上 ASCII 侧保持整词（Typora #13 同款优先级，见下方先查 wordChar 的次序）。
 * 只在光标所在文本节点内取词、不跨节点——公式源码与 html-inline 标记天然成界。 */
function wordAroundCaret(range) {
  if (!range.collapsed || range.startContainer.nodeType !== 3) return null;
  const text = range.startContainer.data, i = range.startOffset;
  const wordChar = ch => /[A-Za-z0-9]/.test(ch);
  const cjkChar = ch => /[\u3041-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
  const at = (start, end) => { const r = range.cloneRange(); r.setStart(range.startContainer, start); r.setEnd(range.startContainer, end); return r; };
  let start = i; while (start > 0 && wordChar(text[start - 1])) start--;
  let end = i; while (end < text.length && wordChar(text[end])) end++;
  if (end > start) return at(start, end);
  // CJK 连续段：start/end 从光标在 cjkChar 连续段内双向扩展到非 CJK 边界，返回整段。
  const cjkRun = j => {
    let s = j; while (s > 0 && cjkChar(text[s - 1])) s--;
    let t = j; while (t < text.length && cjkChar(text[t])) t++;
    return t > s ? at(s, t) : null;
  };
  if (i > 0 && cjkChar(text[i - 1])) return cjkRun(i);
  if (i < text.length && cjkChar(text[i])) return cjkRun(i);
  return null;
}

function boldAcrossBlocks(api,range) {
  const e=api.vditor,root=e.ir.element;
  if(e.currentMode!=='ir'||range.collapsed)return false;
  const selector='p,h1,h2,h3,h4,h5,h6,li,td,th';
  const blocks=[...root.querySelectorAll(selector)].filter(n=>!n.querySelector(selector)&&(!n.closest('pre')||n.closest('pre')===root)&&range.intersectsNode(n));
  const parts=blocks.map(block=>{
    const part=document.createRange();part.selectNodeContents(block);
    if(block.contains(range.startContainer))part.setStart(range.startContainer,range.startOffset);
    if(block.contains(range.endContainer))part.setEnd(range.endContainer,range.endOffset);
    return part;
  }).filter(part=>!part.collapsed&&part.toString());
  // 【S2·R2】单块选区含公式/图片时同样走本路的 inlineMarkdown 序列化（PREVIEWS 剥除、
  // 公式保真）：过去单块一律 return false 委派 toolbar 的 vendor bold，它用
  // Range.toString 抓出"源码+预览"双份文本、再 deleteContents，公式当场被毁。纯文本
  // 单块照旧交回 toolbar——vendor 对它没有坑，原生手感（撤销栈、光标归位）不动。
  // 【R6·F5】单块含 html-inline 岛（<u>…</u>）同样不能交回 vendor：vendor bold 的
  // deleteContents 只删选区，把岛标记拆散（留下半个 <u>）再塞 **，即嵌套坏标记。
  // 含岛单块并入本路按岛边界切分；纯文本单块（含跨标题/li 收敛成单块的形态）照旧
  // 回落 vendor，原生手感不动。
  if(parts.length===1){
    const box=document.createElement('div');box.append(parts[0].cloneContents());
    if(!box.querySelector('code[data-type="math-inline"],code[data-type="math-block"],img,[data-type="html-inline"]'))return false;
  }
  if(!parts.length)return false;
  // Native IR bold serializes the entire range as one inline string, merging
  // paragraphs and cells. Keep every block boundary as a separate transaction.
  const selectedText=[];
  for(const part of parts){
    const walker=document.createTreeWalker(part.commonAncestorContainer,NodeFilter.SHOW_TEXT);
    if(part.commonAncestorContainer.nodeType===3)selectedText.push(part.commonAncestorContainer);
    else{let n;while(n=walker.nextNode())if(part.intersectsNode(n)&&n.data.trim()&&!n.parentElement.closest(PREVIEW+',.vditor-ir__marker'))selectedText.push(n);}
  }
  const remove=selectedText.length>0&&selectedText.every(n=>n.parentElement.closest('strong,b'));
  const replacements=parts.map(part=>{
    const box=document.createElement('div');box.append(part.cloneContents());
    for(const node of box.querySelectorAll('[data-type="strong"],strong,b')){
      if(!box.contains(node))continue;
      const content=node.matches('[data-type="strong"]')?node.querySelector('strong,b'):node;
      if(content)node.replaceWith(...content.childNodes);
    }
    const inner=document.createRange();inner.selectNodeContents(box);
    // 【R6·F5】含 html-inline 岛时按岛边界切分作用域（岛内/岛外各自包裹）；
    // 无岛时保持整段一刀切（原行为）。
    const wrap=text=>text.replace(/^(\s*)([\s\S]*?)(\s*)$/,(_,a,b,c)=>b?a+'**'+b+'**'+c:text);
    const text=box.querySelector('[data-type="html-inline"]')
      ?islandScopedMarkdown(e,box,remove?t=>t:wrap)
      :(remove?inlineMarkdown(e,inner):wrap(inlineMarkdown(e,inner)));
    const template=document.createElement('template');template.innerHTML=e.lute.Md2VditorIRDOM(text);
    const p=template.content.firstElementChild,fragment=document.createDocumentFragment();
    if(!p||p.tagName!=='P')return null;
    fragment.append(...p.childNodes);return{part,fragment,first:fragment.firstChild,last:fragment.lastChild};
  });
  if(replacements.some(x=>!x||!x.first))return false;
  const before=api.getValue();
  for(const {part,fragment}of [...replacements].reverse()){part.deleteContents();part.insertNode(fragment);}
  const selected=document.createRange();selected.setStartBefore(replacements[0].first);selected.setEndAfter(replacements.at(-1).last);
  getSelection().removeAllRanges();getSelection().addRange(selected);
  const after=api.getValue();if(after!==before)e.options.input?.(after);
  window.__typoraScheduleMath?.(root,{cdn:e.options.cdn,math:e.options.preview.math});
  return true;
}

export function installEditorShortcuts(api, flushIR) {
  const editor = api.vditor;
  const keydown = event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.altKey || event.metaKey)) return;
    const root = editor[editor.currentMode]?.element;
    if (!root?.contains(event.target) || (editor.currentMode !== 'sv' && !root.isContentEditable)) return;
    // Formatting shortcuts (bold/italic/underline/quote/code/math…) rebuild the
    // block they touch without firing beforeinput. Open the preview guard's
    // typing window so unchanged formulas on that line are transplanted
    // synchronously instead of flashing source until the scheduler re-renders.
    root.__inputPreviewGuard?.markEdit?.();
    const key = fromEvent(event);
    if(key==='Ctrl+Alt+V'){
      const selection=getSelection();
      if(!selection.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat&&!event.isComposing&&!editor[editor.currentMode].composingLock)copyPlainText(api).catch(error=>console.warn(error));
      return;
    }
    // 【F13②·R10】Ctrl+Shift+V 粘贴纯文本（Typora 官方键，产品此前零绑定）：只取剪贴板
    // text/plain 味道落纯文字，不取 html——富文本选区粘进来不新建 strong 等格式节点。
    // 通道复用右键「粘贴」的 read-text→insertText 链（media-tools.pasteClipboardAsText），
    // 撤销由 begin/finishDocumentEdit 包成一条。IME 组字期（isComposing/composingLock）
    // 与按键重复只吞不动作，与 Ctrl+Alt+V 同款守卫。
    if(key==='Ctrl+Shift+V'){
      const selection=getSelection();
      if(!selection.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat&&!event.isComposing&&!editor[editor.currentMode].composingLock)pasteClipboardAsText(api).catch(error=>console.warn(error));
      return;
    }
    const action = key === 'Ctrl+B' || key === 'Meta+B' ? 'bold' : key && ACTIONS.find(([name]) => current[name] === key)?.[0];
    const selection = getSelection();
    if (!selection.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
    // 公式源码与围栏（$ / $$）里没有 Markdown 格式：加粗/下划线/引用/代码/删除线/链接
    // 这些命令会把 ****、<u></u>、> 、`、~~、[]() 直接插进 TeX 源码，公式当场坏掉
    // （v2.1.1 报告）。公式命令本身照旧。
    // 【S1·R2】过去只查 anchorNode：锚在正文、焦在公式源码中段的选区（拖选 / Shift+扩选
    //      的常见形状）整条漏掉，Ctrl+B 照样把源码拆坏。补查 focusNode，双端同形。
    // 【S3·R2】围栏 marker 是公式自己的边界字符：光标站 $/$$ 上按格式键，委派出去的
    //      vendor bold（Range.toString 抓出"源码+预览"双份文本再 deleteContents）会把
    //      公式整条毁掉。判定不依赖 action 映射——Ctrl+I/D/K 默认落在 Vditor 自建绑定
    //      上，与 B/U 同口径吞键（这一支在 !action 早退之前跑，否则接不到它们）。
    if (action !== 'math' && (action || FORMAT_KEYS.has(key)) &&
        (inMathZone(selection.anchorNode) || inMathZone(selection.focusNode))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!action) return;
    if(action!=='math'&&elementAt(event.target)?.closest(PREVIEW)) return;
    if (action!=='math'&&(elementAt(selection.anchorNode)?.closest(PREVIEW) || elementAt(selection.focusNode)?.closest(PREVIEW))) return;
    event.preventDefault();
    // Capture before Vditor's built-in bindings and Webview host forwarding.
    event.stopImmediatePropagation();
    if (event.repeat || event.isComposing || editor[editor.currentMode].composingLock) return;
    if (editor.currentMode === 'ir') flushIR();
    else editor.undo.addToUndoStack(editor);
    editor.undo.recordFirstPosition(editor, event);
    if (action === 'bold') {
      const range=selection.getRangeAt(0),strong=elementAt(range.startContainer)?.closest('strong,b');
      if (boldAcrossBlocks(api,range)) {
        // The multi-block edit already retained its block boundaries.
      } else if (editor.currentMode==='ir' && strong?.contains(range.endContainer)) {
        const wrapper=strong.closest('[data-type="strong"]') || strong;
        const whole=document.createRange();whole.selectNode(wrapper);
        const prefix=range.cloneRange(),suffix=range.cloneRange();prefix.selectNodeContents(strong);suffix.selectNodeContents(strong);
        prefix.setEnd(range.startContainer,range.startOffset);suffix.setStart(range.endContainer,range.endOffset);
        const wrap=text=>text.trim()?text.replace(/^(\s*)([\s\S]*?)(\s*)$/,(_,a,b,c)=>a+'**'+b+'**'+c):text;
        const content=document.createRange();content.selectNodeContents(strong);
        const text=range.collapsed?inlineMarkdown(editor,content):wrap(inlineMarkdown(editor,prefix))+inlineMarkdown(editor,range)+wrap(inlineMarkdown(editor,suffix));
        selection.removeAllRanges();selection.addRange(whole);document.execCommand('insertText',false,text);
      } else editor.toolbar.elements.bold.querySelector('button').click();
    } else if (action === 'math') {
      toggleMath(api);
    } else if (action === 'underline') {
      toggleUnderline(api);
    } else {
      const multiline = /[\r\n]/.test(selection.toString());
      if (multiline) {
        // Vditor's quote/code toolbar only operates on the first IR block.
        // Its Markdown insertion API replaces the complete selected range.
        const markdown = selectedMarkdown(editor, selection.getRangeAt(0));
        if (action === 'quote') api.insertMD(markdown.split('\n').map(line => '> ' + line).join('\n'));
        else {
          const longest = Math.max(0, ...Array.from(markdown.matchAll(/`+/g), match => match[0].length));
          const fence = '`'.repeat(Math.max(3, longest + 1));
          api.insertMD(fence + '\n' + markdown + '\n' + fence);
        }
      } else {
        // 【R6·F17】无选区的代码键不再落 vendor 的空反引号对：按 bold collapsed
        // 分支同一口径先取词（连续英文数字一词、CJK 按字/词界），取到词整词裹 `；
        // 光标本就在行内代码里则整块取消（与 bold collapsed 在 strong 里整块取消
        // 同构）。取不到词（空格/标点/边界）保持 vendor 原行为。
        let wordDone = false;
        if (editor.currentMode === 'ir' && action === 'code') {
          const range = selection.getRangeAt(0);
          if (range.collapsed) {
            // 【R6·F17 取证纠错】"不在代码块里"的判定不能写 closest('pre')：IR 的编辑面本身就是
            // <pre class="vditor-reset">（光标祖先链 CODE<SPAN[code]<P<PRE 实测），于是行内代码
            // 的 wrapper 永远"在 pre 里"、取消分支永远进不去——二按落进取词分支再裹一层反引号
            // （\`\`omega77\`\`）。真正的"块代码"是 div[data-type="code-block"]（其 pre 带
            // vditor-ir__marker 类），按它判。
            const wrapper = elementAt(range.startContainer)?.closest('[data-type="code"]');
            if (wrapper && !wrapper.closest('[data-type="code-block"],pre.vditor-ir__marker')) {
              const whole = document.createRange(); whole.selectNode(wrapper);
              const core = wrapper.querySelector(':scope > code');
              selection.removeAllRanges(); selection.addRange(whole);
              document.execCommand('insertText', false, core ? core.textContent : wrapper.textContent);
              wordDone = true;
            } else {
              const word = wordAroundCaret(range);
              if (word) {
                selection.removeAllRanges(); selection.addRange(word);
                document.execCommand('insertText', false, '`' + inlineMarkdown(editor, word) + '`');
                wordDone = true;
              }
            }
          }
        }
        const tool = !wordDone ? (action === 'quote' ? 'quote' : 'inline-code') : null;
        if (tool) {
          const button=editor.toolbar.elements[tool].querySelector('button');
          if(editor.currentMode==='wysiwyg'&&tool==='inline-code'){
            // Vditor updates toolbar state on a timer. A quick shortcut after
            // leaving math must use the actual selection, not its old code flag.
            const code=elementAt(selection.anchorNode)?.closest('code');
            button.classList.toggle('vditor-menu--current',!!code&&code.contains(selection.focusNode));
          }
          button.click();
        }
      }
    }
    if (editor.currentMode === 'ir' || action === 'math') editor.undo.addToUndoStack(editor);
  };
  window.addEventListener('keydown', keydown, true);
  return () => window.removeEventListener('keydown', keydown, true);
}

export function showShortcutSettings({shortcuts = current, onSave} = {}) {
  if (!dialogSlotFree('typora-shortcuts')) return;
  const previousFocus = document.activeElement;
  const selection = getSelection();
  const savedRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const dialog = document.createElement('dialog');
  dialog.id = 'typora-shortcuts';
  dialog.dataset.theme = localStorage.getItem('dark') === 'false' ? 'light' : 'dark';
  dialog.setAttribute('aria-labelledby', 'shortcuts-title');
  dialog.innerHTML = '<form method="dialog"><h2 id="shortcuts-title">快捷键设置</h2>' +
    '<p class="shortcut-help">点击快捷键后按下新的组合键。按 Backspace 或 Delete 可停用。</p>' +
    '<div class="shortcut-rows"></div><p class="shortcut-error" role="alert"></p>' +
    '<footer><button type="button" data-action="reset">恢复默认</button><span></span>' +
    '<button value="cancel">取消</button><button type="button" data-action="save">保存</button></footer></form>';
  const values = normalizeShortcuts(shortcuts);
  const inputs = {};
  const error = dialog.querySelector('.shortcut-error');
  const save = dialog.querySelector('[data-action="save"]');
  const validate = () => {
    const keys = Object.values(values).filter(Boolean);
    error.textContent = new Set(keys).size !== keys.length ? '不同操作不能使用相同的快捷键。' : '';
    if(keys.some(key=>RESERVED.has(key)))error.textContent='该快捷键已用于编辑、查找或文件操作，请选择其他组合键。';
    save.disabled = !!error.textContent;
  };
  for (const [action, title, description] of ACTIONS) {
    const row = document.createElement('label');
    row.className = 'shortcut-row';
    const label = document.createElement('span');
    label.textContent = title;
    const detail = document.createElement('small');
    detail.textContent = description;
    label.append(detail);
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = values[action];
    input.placeholder = '未设置';
    input.dataset.action = action;
    input.setAttribute('aria-label', title + '快捷键');
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab' || event.key === 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (event.isComposing) return;
      const value = ['Backspace', 'Delete'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey
        ? '' : fromEvent(event);
      if (value === null) return;
      values[action] = value;
      input.value = value;
      validate();
    });
    inputs[action] = input;
    row.append(label, input);
    dialog.querySelector('.shortcut-rows').append(row);
  }
  dialog.querySelector('[data-action="reset"]').onclick = () => {
    Object.assign(values, DEFAULT_SHORTCUTS);
    for (const [name, input] of Object.entries(inputs)) input.value = values[name];
    validate();
  };
  // 收尾只做一次：正常路径靠 close 事件，隐藏文档里则由关闭动作自己收尾（见下）。
  const finish = () => {
    if (!dialog.isConnected) return;
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    if (savedRange?.startContainer.isConnected && savedRange.endContainer.isConnected) {
      selection.removeAllRanges(); selection.addRange(savedRange);
    }
  };
  // 隐藏文档（窗口被别的窗口完全遮挡、后台 webview）里 <dialog> 的 close 事件可能
  // 永远不派发（Chromium 既有行为，实测：多窗口下新建的 dialog 调 close() 后事件
  // 不触发）。只靠事件收尾会把这个节点永久留在 DOM 里，而本函数开头正是按 id 判重
  // ——于是「快捷键设置」再也打不开。所以关闭动作自己收尾，close 事件只作兜底。
  const closeDialog = () => { try { dialog.close(); } catch { /* 已关闭 */ } finish(); };
  save.onclick = async () => {
    validate();
    if (save.disabled) return;
    save.disabled = true;
    try {
      if (onSave) await onSave({...values});
      else window.handler?.emit('shortcuts-set', {...values});
      configureShortcuts(values);
      closeDialog();
    } catch (failure) {
      error.textContent = '保存失败：' + failure.message;
      save.disabled = false;
    }
  };
  dialog.querySelector('[value="cancel"]').onclick = () => closeDialog();
  dialog.addEventListener('close', finish, {once: true});
  document.body.append(dialog);
  validate();
  dialog.showModal();
}
