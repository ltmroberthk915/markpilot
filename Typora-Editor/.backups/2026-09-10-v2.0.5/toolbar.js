// Vditor binds formatting shortcuts through toolbar registrations. Keep bold
// and italic registered but hidden so Ctrl+B / Ctrl+I still work in every mode.
import { showShortcutSettings } from './edit-shortcuts.js';
import { showSurfaceSettings } from './surface.js';
import {showThemeSettings,applyTheme,preferredTheme} from './themes.js';
import {showPaletteSettings} from './reading-palette.js';
const VISUAL_MODES=new Set(['ir','wysiwyg']);
const modeButton=(editor,mode)=>editor?.toolbar?.elements?.['edit-mode']?.querySelector(`button[data-mode="${mode}"]`);
const updateSourceToggle=(api,mode=api?.vditor?.currentMode)=>{
  const button=api?.vditor?.toolbar?.elements?.['source-toggle']?.querySelector('button');
  if(!button)return;
  const source=mode==='sv';
  button.setAttribute('aria-label',source?'返回编辑视图（保留未变更内容）':'切换源码视图（再次点击返回）');
  button.setAttribute('aria-pressed',String(source));
  button.classList.toggle('typora-source-toggle--active',source);
};
const restoreSelection=(range,root)=>{
  if(!range?.startContainer?.isConnected||!range.endContainer?.isConnected)return;
  root.focus({preventScroll:true});const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
};
function restoreCachedVisual(api,state){
  const editor=api?.vditor,mode=state?.mode;
  if(!editor||!VISUAL_MODES.has(mode)||api.getValue()!==state.source||!editor[mode]?.element)return false;
  editor.preview.element.style.display='none';editor.sv.element.style.display='none';
  editor.ir.element.parentElement.style.display=mode==='ir'?'block':'none';
  editor.wysiwyg.element.parentElement.style.display=mode==='wysiwyg'?'block':'none';
  editor.lute.SetVditorIR(mode==='ir');editor.lute.SetVditorWYSIWYG(mode==='wysiwyg');editor.lute.SetVditorSV(!1);editor.currentMode=mode;
  editor.undo.resetIcon(editor);editor[mode].element.focus();restoreSelection(state.range,editor[mode].element);
  if(Number.isFinite(state.scrollTop))editor[mode].element.scrollTop=state.scrollTop;
  if(mode==='wysiwyg')editor.wysiwyg.popover.style.display='none';
  editor.toolbar.elements['edit-mode']?.querySelectorAll('button').forEach(button=>button.classList.toggle('vditor-menu--current',button.dataset.mode===mode));
  editor.outline.toggle(editor,editor.options.outline.enable);
  api.__typoraSourceReturnMode=mode;window.localStorage.setItem('edit-mode',mode);updateSourceToggle(api,mode);return true;
}
export function toggleSourceView(){
  const api=window.vditor,editor=api?.vditor;if(!editor)return false;
  if(editor.currentMode==='sv'){
    const state=editor.__typoraSourceToggle;
    if(restoreCachedVisual(api,state)){editor.__typoraSourceToggle=null;return true;}
    const target=VISUAL_MODES.has(state?.mode)?state.mode:'ir';modeButton(editor,target)?.click();api.__typoraSourceReturnMode=target;updateSourceToggle(api,target);return true;
  }
  const mode=VISUAL_MODES.has(editor.currentMode)?editor.currentMode:'ir';
  const source=api.getValue();
  const entry=api.__splitNavigation?.captureVisual(mode,source);
  api.__splitNavigation?.enterAt(entry);
  editor.__typoraSourceToggle={mode,source,scrollTop:editor[mode].element.scrollTop,range:getSelection()?.rangeCount?getSelection().getRangeAt(0).cloneRange():null};
  api.__typoraSourceReturnMode=mode;modeButton(editor,'sv')?.click();
  // Vditor serializes the visual tree once while entering SV. Restore the
  // exact pre-toggle source afterwards so formatting-only differences (blank
  // lines, table padding, reference placement) do not count as an edit.
  if(api.getValue()!==source)api.setValue(source);
  // SV's text model may normalize Markdown block separators while it builds
  // its editable spans. Use that stable source as the cache key for the
  // return path; entering/leaving the view itself must not create a change.
  editor.__typoraSourceToggle.source=api.getValue();
  window.localStorage.setItem('edit-mode',mode);updateSourceToggle(api,editor.currentMode);return true;
}
export const toolbar = [
  {
    name: "outline",
    tipPosition: "s",
    click() {
      const currentOutline = window.localStorage.getItem("outline") === 'true';
      window.localStorage.setItem("outline", currentOutline?'false':'true');
    },
  },
  {name:'theme-settings',tip:'主题（含 Konayuki Light / Dark）',tipPosition:'s',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',click:showThemeSettings},
  {name:'reading-palette',tip:'阅读调色盘：米色 / 淡绿',tipPosition:'s',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.3a2 2 0 0 0 1.4-3.4c-.6-.6-.2-1.6.6-1.6H17a4 4 0 0 0 4-4 9 9 0 0 0-9-9Z" fill="none" stroke="currentColor" stroke-width="1.6"/><g fill="currentColor"><circle cx="7" cy="10" r="1.3"/><circle cx="10" cy="6.7" r="1.3"/><circle cx="15" cy="7.5" r="1.3"/><circle cx="7.5" cy="15" r="1.3"/></g></svg>',click:showPaletteSettings},
  { name: "emoji", tipPosition: "s" },
  { name: "headings", tipPosition: "s" },
  { name: "bold", tipPosition: "s", className: "typora-keyboard-only" },
  { name: "italic", tipPosition: "s", className: "typora-keyboard-only" },
  { name: "strike", tipPosition: "s" },
  { name: 'find-replace', tip: '查找和替换（Ctrl+F / Ctrl+H）', tipPosition: 's',
    icon: '<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 6 6" stroke="currentColor" stroke-width="2"/></svg>',
    click(){window.vditor?.__typoraFind.open(true);}},
  { name: "link", tipPosition: "s" },
  "|",
  { name: "list", tipPosition: "s" },
  { name: "ordered-list", tipPosition: "s" },
  { name: "check", tipPosition: "s" },
  { name: "outdent", tipPosition: "s" },
  { name: "indent", tipPosition: "s" },
  "|",
  { name: "quote", tipPosition: "s" },
  { name: "line", tipPosition: "s", hotkey: '' },
  { name: "code", tipPosition: "s" },
  { name: "inline-code", tipPosition: "s" },
  { name: "insert-before", tipPosition: "s" },
  { name: "insert-after", tipPosition: "s" },
  "|",
  { name: "upload", tipPosition: "e" },
  { name: "record", tipPosition: "s" },
  { name: "table", tipPosition: "s" },
  "|",
  { name: "undo", tipPosition: "s" },
  { name: "redo", tipPosition: "s" },
  "|",
  { name: "fullscreen", tipPosition: "s" },
  {
    name: 'shortcut-settings',
    tip: '快捷键设置',
    tipPosition: 's',
    icon: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 5h18v14H3zM6 9h2m3 0h2m3 0h2M6 12h2m3 0h2m3 0h2M7 16h10"/></svg>',
    click() { showShortcutSettings(); },
  },
  {
    tipPosition: "s",
    tip: "使用vscode默认编辑器",
    className: "right",
    icon: '<svg height="2455" viewBox="-11.9 -2 1003.9 995.6" width="2500" xmlns="http://www.w3.org/2000/svg"><path d="m12.1 353.9s-24-17.3 4.8-40.4l67.1-60s19.2-20.2 39.5-2.6l619.2 468.8v224.8s-.3 35.3-45.6 31.4z" fill="#2489ca"/><path d="m171.7 498.8-159.6 145.1s-16.4 12.2 0 34l74.1 67.4s17.6 18.9 43.6-2.6l169.2-128.3z" fill="#1070b3"/><path d="m451.9 500 292.7-223.5-1.9-223.6s-12.5-48.8-54.2-23.4l-389.5 354.5z" fill="#0877b9"/><path d="m697.1 976.2c17 17.4 37.6 11.7 37.6 11.7l228.1-112.4c29.2-19.9 25.1-44.6 25.1-44.6v-671.2c0-29.5-30.2-39.7-30.2-39.7l-197.7-95.3c-43.2-26.7-71.5 4.8-71.5 4.8s36.4-26.2 54.2 23.4v887.5c0 6.1-1.3 12.1-3.9 17.5-5.2 10.5-16.5 20.3-43.6 16.2z" fill="#3c99d4"/></svg>',
    click() {
      handler.emit("editInVSCode");
    },
  },
  {
    name: "edit-mode",
    tipPosition: "s",
    click() {
      window.localStorage.setItem("edit-mode", window.vditor.getCurrentMode());
      updateSourceToggle(window.vditor);
    },
  },
  {
    name: 'source-toggle',
    tip: '切换源码视图（再次点击返回）',
    tipPosition: 's',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    click: toggleSourceView,
  },
  {
    name: "more",
    tipPosition: "s",
    toolbar: [
      "both",
      "code-theme",
      "content-theme",
      {name:'surface-settings',tip:'界面透明度（弹窗 / 工具栏）',tipPosition:'s',
        icon:'<svg viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px;vertical-align:-3px"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg><span class="typora-toolbar-label">透明度</span>',
        click() { showSurfaceSettings(); }},
      {name:'document-export',tip:'导出 Word / 便携 Markdown',
        icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        click(){if(window.hostApi)window.hostApi.invoke('export-menu');else window.handler.emit('office-export',{text:window.vditor.getValue()});}},
      "export",
      "preview",
      "devtools",
      "info",
      "help",
    ],
  },
  {
    tip: "切换暗黑/明亮模式",
    tipPosition: "s",
    icon: '<svg t="1697597615827" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="3614" width="200" height="200"><path d="M320 85.333333C243.626667 134.4 192 221.013333 192 320 192 418.986667 243.626667 505.6 321.28 554.666667 190.293333 554.666667 85.333333 449.706667 85.333333 320 85.333333 190.293333 190.293333 85.333333 320 85.333333M813.653333 149.333333 874.666667 210.346667 210.346667 874.666667 149.333333 813.653333 813.653333 149.333333M549.973333 253.013333 486.826667 213.333333 425.386667 256 443.306667 183.466667 384 138.24 458.666667 133.12 483.413333 62.72 512 132.266667 585.813333 133.546667 528.213333 181.76 549.973333 253.013333M409.173333 407.04 359.68 375.893333 311.893333 409.173333 326.4 352.853333 279.893333 317.44 337.92 313.6 357.12 258.56 378.88 312.746667 436.906667 314.026667 392.106667 351.146667 409.173333 407.04M810.666667 576C810.666667 705.706667 705.706667 810.666667 576 810.666667 523.946667 810.666667 475.733333 793.6 436.906667 765.013333L765.013333 436.906667C793.6 475.733333 810.666667 523.946667 810.666667 576M622.933333 856.746667 741.12 807.68 730.88 950.613333 622.933333 856.746667M807.68 741.546667 856.746667 623.36 950.613333 731.733333 807.68 741.546667M856.746667 529.92 808.106667 411.306667 950.613333 421.546667 856.746667 529.92M410.88 807.68 529.066667 856.746667 421.12 950.186667 410.88 807.68Z" p-id="3615"></path></svg>',
    click() {
      const current=preferredTheme();
      applyTheme(window.vditor,(current.startsWith('konayuki-')?'konayuki-':'')+(current.endsWith('dark')?'light':'dark'),true);
    },
  },
  {
    tip: "重新加载文件内容",
    tipPosition: "s",
    icon: '<svg t="1697607836033" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="8385" width="200" height="200"><path d="M909.1 209.3l-56.4 44.1C775.8 155.1 656.2 92 521.9 92 290 92 102.3 279.5 102 511.5 101.7 743.7 289.8 932 521.9 932c181.3 0 335.8-115 394.6-276.1 1.5-4.2-0.7-8.9-4.9-10.3l-56.7-19.5c-4.1-1.4-8.6 0.7-10.1 4.8-1.8 5-3.8 10-5.9 14.9-17.3 41-42.1 77.8-73.7 109.4-31.6 31.6-68.4 56.4-109.3 73.8-42.3 17.9-87.4 27-133.8 27-46.5 0-91.5-9.1-133.8-27-40.9-17.3-77.7-42.1-109.3-73.8-31.6-31.6-56.4-68.4-73.7-109.4-17.9-42.4-27-87.4-27-133.9s9.1-91.5 27-133.9c17.3-41 42.1-77.8 73.7-109.4 31.6-31.6 68.4-56.4 109.3-73.8 42.3-17.9 87.4-27 133.8-27 46.5 0 91.5 9.1 133.8 27 40.9 17.3 77.7 42.1 109.3 73.8 9.9 9.9 19.2 20.4 27.8 31.4l-60.2 47c-5.3 4.1-3.5 12.5 3 14.1l175.6 43c5 1.2 9.9-2.6 9.9-7.7l0.8-180.9c-0.1-6.6-7.8-10.3-13-6.2z" p-id="8386"></path></svg>',
    click() {
      handler.emit("reload");
    },
  },
];
