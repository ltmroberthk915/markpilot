/** Configurable editing commands shared by Electron and VSCode Webviews. */
import {toggleUnderline} from './underline.js';
import {inlineMarkdown} from './selection-markdown.js';
import {copyPlainText} from './media-tools.js';
import {toggleMath} from './math-edit.js';
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
const STORAGE = 'typora-editor-shortcuts';
const RESERVED=new Set(['Ctrl+B','Ctrl+I','Ctrl+F','Ctrl+H','Ctrl+S','Ctrl+O','Ctrl+Z','Ctrl+Y','Ctrl+X','Ctrl+C','Ctrl+V','Ctrl+A','Ctrl+Shift+Z']);
const elementAt = node => node?.nodeType === 3 ? node.parentElement : node;

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
  if(parts.length<2)return false;
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
    const md=inlineMarkdown(e,inner),text=remove?md:md.replace(/^(\s*)([\s\S]*?)(\s*)$/,(_,a,b,c)=>b?a+'**'+b+'**'+c:md);
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
    const key = fromEvent(event);
    if(key==='Ctrl+Alt+V'){
      const selection=getSelection();
      if(!selection.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat&&!event.isComposing&&!editor[editor.currentMode].composingLock)copyPlainText(api).catch(error=>console.warn(error));
      return;
    }
    const action = key === 'Ctrl+B' || key === 'Meta+B' ? 'bold' : key && ACTIONS.find(([name]) => current[name] === key)?.[0];
    if (!action) return;
    if(action!=='math'&&elementAt(event.target)?.closest(PREVIEW)) return;
    const selection = getSelection();
    if (!selection.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
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
        const tool = action === 'quote' ? 'quote' : 'inline-code';
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
    if (editor.currentMode === 'ir' || action === 'math') editor.undo.addToUndoStack(editor);
  };
  window.addEventListener('keydown', keydown, true);
  return () => window.removeEventListener('keydown', keydown, true);
}

export function showShortcutSettings({shortcuts = current, onSave} = {}) {
  if (document.getElementById('typora-shortcuts')) return;
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
  save.onclick = async () => {
    validate();
    if (save.disabled) return;
    save.disabled = true;
    try {
      if (onSave) await onSave({...values});
      else window.handler?.emit('shortcuts-set', {...values});
      configureShortcuts(values);
      dialog.close();
    } catch (failure) {
      error.textContent = '保存失败：' + failure.message;
      save.disabled = false;
    }
  };
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    if (savedRange?.startContainer.isConnected && savedRange.endContainer.isConnected) {
      selection.removeAllRanges(); selection.addRange(savedRange);
    }
  }, {once: true});
  document.body.append(dialog);
  validate();
  dialog.showModal();
}
