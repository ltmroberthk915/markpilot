export const THEMES={'light':'默认浅色','dark':'默认深色','konayuki-light':'Konayuki Light','konayuki-dark':'Konayuki Dark','telari-light':'宋体-朙','telari-dark':'宋体-暗'};
import {dialogSlotFree, closeDialog} from './util.js';
import {adaptTyporaTheme, inlineThemeImports} from './user-theme.mjs';

/* ── 自定义主题：把 Typora 社区主题拖进来 ────────────────────────────────────────
 *
 *  为什么开这条口子：内置的 Konayuki / 宋体-朙 本来就是 Typora 社区主题（靠
 *  tools/adapt_konayuki.cjs 在打包时改写进仓库）。只有 6 套固定配色，等于把这块能力锁在发布
 *  流程里——想要别的颜色只能等我们出新版。现在改成：用户自己导入，运行时改写后作为一层样式
 *  注入（`js/user-theme.mjs` 负责改写）。
 *
 *  做法与边界（都在实测里确认过：test/user-theme.test.cjs，素材见 scripts/fetch-typora-themes.cjs）：
 *   · Typora 主题的正文规则挂在 `#write`，改写落到我们的写作区 `.vditor-reset`；`:root` 上的
 *     变量定义照搬（与内置主题同一手法），所以主题自己定义的配色变量照常生效。
 *   · 主题是**文件夹**（`vue.css` 里有 `@import 'vue/fonts.css'`），因此支持多选文件，本地
 *     @import 按路径后缀/文件名内联。
 *   · **相对路径的字体与图片不会跟着走**（那些文件不在我们手里）：带相对 src 的 @font-face 丢掉、
 *     其它相对 url() 换成 none，不让 webview 去 404。导入后把条数如实告诉用户。
 *   · 自定义主题是**叠在**当前主题之上的一层，随时可停用（停用＝摘掉作用域属性 + 移除样式表，
 *     页面不留残迹），也可删除。EXE 与 VSIX 共用同一份渲染层，行为一致。
 */
const USER_THEMES_KEY='typora-user-themes';
const USER_ACTIVE_KEY='typora-user-theme-active';
const USER_MAX_BYTES=1024*1024;   // 单套主题源码上限：够用（最流行的 7 套都在 100KB 内），也防呆
export function userThemes(){try{const list=JSON.parse(localStorage.getItem(USER_THEMES_KEY)||'[]');return Array.isArray(list)?list:[];}catch{return[];}}
const saveUserThemes=list=>{try{localStorage.setItem(USER_THEMES_KEY,JSON.stringify(list));}catch(error){throw new Error('保存失败（本地存储写不进去）：'+error.message);}};
export const activeUserTheme=()=>localStorage.getItem(USER_ACTIVE_KEY)||'';
const themeById=id=>userThemes().find(item=>item.id===id)||null;
/** 改写一套主题：内联 @import → 改写选择器 → 给出可注入的 CSS 与统计。 */
export function compileUserTheme(theme){
  const inlined=inlineThemeImports(theme.entry||theme.files?.[0]?.name||'',theme.files||[]);
  const {css,report}=adaptTyporaTheme(inlined.css);
  return {css,report,inlined};
}
export function applyUserTheme(id){
  const theme=themeById(id);
  if(!theme)return null;
  const {css,report,inlined}=compileUserTheme(theme);
  let style=document.getElementById('typora-user-theme');
  if(!style){style=document.createElement('style');style.id='typora-user-theme';document.documentElement.append(style);}
  style.textContent=css;
  document.documentElement.dataset.userTheme='on';
  localStorage.setItem(USER_ACTIVE_KEY,id);
  window.__typoraUserTheme={id,name:theme.name,cssBytes:css.length,report,missing:inlined.missing,external:inlined.external};
  return {theme,css,report,inlined};
}
export function disableUserTheme(){
  document.getElementById('typora-user-theme')?.remove();
  delete document.documentElement.dataset.userTheme;
  localStorage.removeItem(USER_ACTIVE_KEY);
  window.__typoraUserTheme=null;
}
/** 启动与主题切换后都要重新套上——它是叠在基础主题之上的一层。 */
export function restoreUserTheme(){const id=activeUserTheme();if(id&&themeById(id))applyUserTheme(id);else disableUserTheme();}
/** 把选中的文件读成主题素材（保留相对路径，@import 才找得到）。 */
export const readThemeFiles=files=>Promise.all([...files].map(file=>new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error('读不了文件：'+file.name));
  reader.onload=()=>resolve({name:file.name,path:file.webkitRelativePath||file.name,text:String(reader.result)});
  reader.readAsText(file);
})));
/** 导入：定名、挑入口（优先与主题同名的那个，其次排除字体文件），存进本地。 */
export function importUserTheme({name,files}){
  if(!files?.length)throw new Error('没有可用的 CSS');
  const total=files.reduce((sum,file)=>sum+file.text.length,0);
  if(total>USER_MAX_BYTES)throw new Error(`主题太大（${Math.round(total/1024)}KB，上限 ${USER_MAX_BYTES/1024}KB）`);
  const cssFiles=files.filter(file=>/\.css$/i.test(file.name));
  if(!cssFiles.length)throw new Error('选中的文件里没有 .css');
  const clean=String(name||'').trim()||cssFiles[0].name.replace(/\.css$/i,'');
  const entry=cssFiles.find(file=>file.name.replace(/\.css$/i,'')===clean)
    ||cssFiles.find(file=>!/(?:^|\/)fonts?\.css$/i.test(file.name))
    ||cssFiles[0];
  const list=userThemes().filter(item=>item.name!==clean);
  const theme={id:'user-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:clean,entry:entry.name,
    files:files.map(({name:fileName,path,text})=>({name:fileName,path,text})),importedAt:new Date().toISOString()};
  list.push(theme);
  saveUserThemes(list);
  return theme;
}
export function removeUserTheme(id){
  if(activeUserTheme()===id)disableUserTheme();
  saveUserThemes(userThemes().filter(item=>item.id!==id));
}

export function preferredTheme(){const saved=localStorage.getItem('editor-theme');if(THEMES[saved])return saved;
  // v2.0.5 起未做过选择的用户默认落在 Telari 式衬线阅读主题（详见
  // docs/TELARI-TYPOGRAPHY-ANALYSIS.md）；已保存的偏好永远优先。
  return localStorage.getItem('dark')==='false'?'telari-light':'telari-dark';}
export function applyTheme(api,theme,persist=false){
  if(!THEMES[theme])theme=preferredTheme();
  const dark=theme.endsWith('dark');
  localStorage.setItem('editor-theme',theme);localStorage.setItem('dark',String(dark));
  document.documentElement.dataset.editorTheme=theme;
  const custom=themeById(activeUserTheme());
  api?.vditor.toolbar.elements['theme-settings']?.querySelector('button')?.setAttribute('aria-label',`主题：${THEMES[theme]}${custom?` + 自定义(${custom.name})`:''}（点击切换）`);
  if(api && api.__typoraAppliedTheme!==theme){
    api.setTheme(dark?'dark':'light',dark?'dark':'light',dark?'github-dark':'github');
    api.__typoraAppliedTheme=theme;
  }
  restoreUserTheme();   // 基础主题换了，自定义那一层要重新注入（顺序上它永远在最后）
  if(persist)window.handler?.emit('theme-set',theme);
  return theme;
}
/** 主题对话框：内置主题 + 自定义主题（导入 / 使用 / 停用 / 删除）。
 *  导入后的一行统计是**如实**给出的：多少条规则生效、多少条因为不属于写作区被丢掉、
 *  多少本地字体没跟过来——用户据此知道"为什么和 Typora 里长得不完全一样"。 */
export function showThemeSettings(){
  if(!dialogSlotFree('typora-themes'))return;
  const previous=document.activeElement,selection=getSelection(),range=selection.rangeCount?selection.getRangeAt(0).cloneRange():null;
  const dialog=document.createElement('dialog');dialog.id='typora-themes';dialog.setAttribute('aria-label','选择主题');
  dialog.innerHTML='<form method="dialog"><h2>主题</h2><div class="theme-options"></div>'
    +'<section class="user-theme"><h3>自定义主题（导入 Typora 主题）</h3>'
    +'<p class="user-theme-hint">选整套主题的文件（可多选，含 <code>@import</code> 的子文件），或直接粘贴 CSS。'
    +'主题里写的字体文件与图片不会跟过来，用主题自带的字体时会退回系统字体。</p>'
    +'<div class="user-theme-row"><input type="file" accept=".css,text/css" multiple id="typora-theme-files"><button type="button" data-action="pick">选择 CSS 文件…</button></div>'
    +'<div class="user-theme-row"><input type="text" id="typora-theme-name" placeholder="主题名（可留空，默认用文件名）"></div>'
    +'<div class="user-theme-row"><textarea id="typora-theme-paste" rows="3" placeholder="或把主题 CSS 粘在这里…"></textarea><button type="button" data-action="paste">导入粘贴的 CSS</button></div>'
    +'<ul class="user-theme-list"></ul><p class="user-theme-status" role="status"></p></section>'
    +'<footer><button>关闭</button></footer></form>';
  const listBox=dialog.querySelector('.theme-options');
  for(const [id,name] of Object.entries(THEMES)){
    const button=document.createElement('button');button.type='button';button.textContent=name;button.dataset.theme=id;button.setAttribute('aria-pressed',String(preferredTheme()===id));
    button.onclick=()=>{applyTheme(window.vditor,id,true);paint();};
    listBox.append(button);
  }
  const status=dialog.querySelector('.user-theme-status');
  const say=(text,bad=false)=>{status.textContent=text;status.classList.toggle('bad',!!bad);};
  const paint=()=>{
    dialog.querySelectorAll('[data-theme]').forEach(button=>button.setAttribute('aria-pressed',String(preferredTheme()===button.dataset.theme)));
    const list=dialog.querySelector('.user-theme-list');list.textContent='';
    const active=activeUserTheme();
    for(const theme of userThemes()){
      const item=document.createElement('li');item.dataset.id=theme.id;item.dataset.active=String(theme.id===active);
      const label=document.createElement('span');label.className='name';label.textContent=theme.name;
      const size=document.createElement('span');size.className='meta';size.textContent=`${theme.files.length} 个文件 · ${Math.round(theme.files.reduce((sum,file)=>sum+file.text.length,0)/1024)}KB`;
      const toggle=document.createElement('button');toggle.type='button';toggle.dataset.action='toggle';toggle.textContent=theme.id===active?'停用':'使用';
      toggle.onclick=()=>{
        try{
          if(theme.id===active){disableUserTheme();say(`已停用「${theme.name}」`);}
          else{const {report,inlined}=applyUserTheme(theme.id)||{};
            say(`已启用「${theme.name}」：生效 ${report?.rules??0} 条规则、${report?.mediaKept??0} 个媒体查询；`
              +`丢弃 ${report?.droppedSelectors??0} 条非写作区样式；本地字体 ${report?.fontFacesDropped??0} 个未加载`
              +(inlined?.missing?.length?`；${inlined.missing.length} 个 @import 没找到`:''));}
        }catch(error){say(error.message,true);}
        paint();
      };
      const del=document.createElement('button');del.type='button';del.dataset.action='delete';del.textContent='删除';
      del.onclick=()=>{removeUserTheme(theme.id);say(`已删除「${theme.name}」`);paint();};
      item.append(label,size,toggle,del);list.append(item);
    }
    if(!userThemes().length){const empty=document.createElement('li');empty.className='empty';empty.textContent='还没有导入自定义主题。';list.append(empty);}
  };
  const importFrom=async files=>{
    try{
      const material=await readThemeFiles(files);
      const theme=importUserTheme({name:dialog.querySelector('#typora-theme-name').value,files:material});
      dialog.querySelector('#typora-theme-name').value='';
      const {report,inlined}=applyUserTheme(theme.id)||{};
      say(`已导入并启用「${theme.name}」：生效 ${report?.rules??0} 条规则、${report?.mediaKept??0} 个媒体查询；`
        +`丢弃 ${report?.droppedSelectors??0} 条非写作区样式；本地字体 ${report?.fontFacesDropped??0} 个未加载`
        +(inlined?.missing?.length?`；${inlined.missing.length} 个 @import 没找到`:''));
      paint();
    }catch(error){say(error.message,true);}
  };
  dialog.querySelector('[data-action=pick]').onclick=()=>dialog.querySelector('#typora-theme-files').click();
  dialog.querySelector('#typora-theme-files').onchange=event=>importFrom(event.target.files);
  dialog.querySelector('[data-action=paste]').onclick=()=>{
    const text=dialog.querySelector('#typora-theme-paste').value;
    if(!text.trim()){say('先粘一段 CSS',true);return;}
    const name=dialog.querySelector('#typora-theme-name').value.trim()||'粘贴的主题';
    importFrom([new File([text],name.replace(/[\\/:*?"<>|]/g,'-')+'.css',{type:'text/css'})]);
  };
  const finish=()=>{dialog.remove();previous?.focus({preventScroll:true});if(range?.startContainer.isConnected){selection.removeAllRanges();selection.addRange(range);}};
  dialog.addEventListener('close',finish,{once:true});
  // 隐藏文档里 close 事件可能永远不派发（见 util.js 的说明），所以「关闭」按钮自己收尾
  dialog.querySelector('footer button').addEventListener('click',()=>closeDialog(dialog,finish));
  paint();
  document.body.append(dialog);dialog.showModal();
}
