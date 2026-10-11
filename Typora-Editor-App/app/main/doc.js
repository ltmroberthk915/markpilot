// 文档控制器：提供与 IDE 插件一致的 Markdown 编辑宿主行为。
// renderer 消息：init/change/img/openLink/scroll/reload/editInVSCode
// 推送消息：open / setValue / insertValue
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { dialog, shell, clipboard, ClipboardItem, nativeImage } = require('electron');
const {saveImage} = require('../renderer/js/image-assets.cjs');
const {PortableImages}=require('../renderer/js/portable-images.cjs');
const {imageBytes,TYPES,windowsClipboard}=require('../renderer/js/media-host.cjs');
const {imageSources}=require('../renderer/js/portable-markdown.cjs');
const {imageFile,imageMime}=require('./export-assets');
const {mimeOf}=require('./server');
const {createCompletionManager,uri} = require('./completion-platform');
const {SnapshotStore,atomicWrite}=require('./snapshots');
const {computeStats}=require('./text-stats');
const {readText}=require('./disk-encoding');

const LANG = 'zh-cn';
const RES_REG = /https:\/\/file.*\.net/i; // renderer 里 file:/// 图片被改写成这种伪域名
/** 手动保存（Ctrl+S / 另存为）前向渲染层拉活值的兜底时限：正常一次 getValue + IPC
 *  往返在 696KB 文档上也是百毫秒量级，3s 只防渲染层卡死把 Ctrl+S 拖成挂起向量；
 *  到点即降级按主进程已有的旧值照常保存——绝不允许因拉值失败而丢一次保存。 */
const PULL_EDITOR_TIMEOUT_MS = 3000;

/** 按行拆开：CRLF/LF/CR 都要能拆（收集器拿到的可能是带 \r\n 的原始磁盘内容）。 */
const sourceLines = text => String(text).split(/\r\n|\r|\n/);

/** 磁盘文件的行尾风格：只要出现过 CRLF 就当 CRLF 文件（混合文件也按 CRLF 还原，
 *  这是各编辑器的通行做法：宁可多一个 \r，也不要把 Windows 文件整篇改成 LF）。 */
const fileEol = text => (/\r\n/.test(String(text)) ? 'crlf' : 'lf');

/** 引用式链接定义行：`[标签]: 地址` 或 `[标签]: 地址 "标题"`（标题是 Lute 解析时**会丢**的部分）。 */
const LINK_REF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S.*$/;
/** 记下带标题的引用式定义：标签 → {url, line}。
 *  Md→IR 解析会把 `"标题"` 丢掉（实测打开那一刻 `vditor.getValue()` 里就没有标题了），改任何一处
 *  再保存，磁盘上的定义行就永久变成无标题形态——用户的文件被悄悄改坏。这里在**读取原文**时把
 *  这些行记下来，保存时若该行仍是"同一地址、且没有被写成别的形态"，就把原文那一行还原回去。 */
const collectLinkRefTitles = text => {
  const map = new Map();
  for (const line of sourceLines(text)) {
    if (!LINK_REF.test(line)) continue;
    const hit = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)[ \t]+("([^"]*)"|'([^']*)'|\(([^)]*)\))[ \t]*$/.exec(line);
    if (!hit) continue;
    map.set(hit[1], {url: hit[2], line});
  }
  return map;
};
/** Markdown 的两种**行内硬换行**写法：行尾两个以上空格（或制表符）、行尾奇数个反斜杠。
 *  两者都会被 Lute 的序列化吃掉，于是"改一个字保存，硬换行没了"——本该换行的地方变成不换行，
 *  渲染结果跟着变（实测：行尾两空格、行尾反斜杠都会消失）。这里把原文里这些**行内容**记下来
 *  （键=去掉行尾标记的那一行），保存时若该行除了标记之外没被动过，就把原文行还原回去；
 *  已经被用户改成别的写法（或他新敲的软换行）就不动。 */
const hardBreakLine = line => {
  const spaces = /^(.*\S)( {2,}|\t+)$/.exec(line);
  if (spaces) return spaces[1];
  const slash = /^(.*\S)(\\+)$/.exec(line);
  if (slash && slash[2].length % 2 === 1) return slash[1];   // 奇数个反斜杠才是硬换行（`\\` 是转义）
  return null;
};
const collectHardBreakLines = text => {
  const map = new Map();
  for (const line of sourceLines(text)) {
    const key = hardBreakLine(line);
    if (key !== null) map.set(key, line);
  }
  return map;
};
const restoreHardBreaks = (text, lines) => {
  if (!lines || !lines.size) return text;
  let changed = false;
  const out = sourceLines(text).map(line => {
    if (hardBreakLine(line) !== null) return line;   // 自己已经带硬换行标记：不动
    const original = lines.get(line);
    if (!original) return line;
    changed = true;
    return original;
  });
  return changed ? out.join('\n') : text;
};

/** **4 空格缩进的代码块**（Markdown 最老的一种代码写法）在 Md→IR 里没有围栏标记节点，
 *  于是 Vditor 反向序列化时**吐不出缩进**：一打开 `getValue()` 就已经是"去掉缩进的裸行"，
 *  改一个字保存，磁盘上代码块就散成了普通段落（渲染从"代码块"变成"正文"，实测确认）。
 *  这里按 Markdown 的定义认出缩进代码块（前后是空行、连续 4 空格以上的行成一段），把每段
 *  的**原文行**记下来；保存时若在结果里找到"同样顺序的裸行"，就把缩进还原回去。
 *  只在整段裸行完全对得上时才动手（单行的还要求它在全文里只出现一处），避免误伤正文。 */
const collectIndentedCode = text => {
  const lines = sourceLines(text);
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {4,}\S/.test(lines[i])) continue;
    const before = i === 0 ? '' : lines[i - 1];
    if (before.trim()) continue;                     // 缩进代码块必须紧跟在空行之后
    const start = i;
    while (i + 1 < lines.length && (/^ {4,}\S/.test(lines[i + 1]) || !lines[i + 1].trim())) {
      if (!lines[i + 1].trim()) {                    // 段里的空行：只有后面还是缩进行才继续
        if (!/^ {4,}\S/.test(lines[i + 2] || '')) break;
      }
      i++;
    }
    const originals = lines.slice(start, i + 1).filter(line => line.trim());
    if (originals.length) runs.push({originals, trimmed: originals.map(line => line.replace(/^ {4,}/, ''))});
  }
  return runs;
};
const restoreIndentedCode = (text, runs) => {
  if (!runs || !runs.length) return text;
  let lines = sourceLines(text);
  for (const run of runs) {
    const {originals, trimmed} = run;
    if (trimmed.length === 1 && lines.filter(line => line === trimmed[0]).length !== 1) continue;  // 单行且不唯一：不动
    for (let i = 0; i + trimmed.length <= lines.length; i++) {
      let hit = true;
      for (let k = 0; k < trimmed.length; k++) if (lines[i + k] !== trimmed[k]) { hit = false; break; }
      if (!hit) continue;
      lines = [...lines.slice(0, i), ...originals, ...lines.slice(i + trimmed.length)];
      break;
    }
  }
  const out = lines.join('\n');
  return out === text ? text : out;
};

/** 围栏代码块的**信息串**：CommonMark 里开头围栏后面那一整串都是信息串（`js {1,3-5}`、
 *  `python title="示例"` 这类高亮范围/标题指令在文档站与 Pandoc 系工具里是有意义的），
 *  而 Vditor 反向序列化只留语言本身 —— 改别处保存一次，后面那截就没了（实测丢掉）。
 *  这里按**文档顺序**记下每个开头围栏的原文行与语言；保存时若结果里的围栏数量与语言序列
 *  与它完全一致（用户没增删代码块、也没换语言），就按顺序把信息串还原；对不上就不动。 */
const fenceLang = line => {
  const hit = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^ \t`~]*)/.exec(line);
  return hit ? hit[2] : null;
};
const collectFenceInfo = text => {
  const list = [];
  for (const line of sourceLines(text)) {
    if (!/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) continue;
    list.push({line, lang: fenceLang(line)});
  }
  return list;
};
const restoreFenceInfo = (text, fences) => {
  if (!fences || !fences.length) return text;
  const lines = sourceLines(text);
  const indices = [];
  for (let i = 0; i < lines.length; i++) if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(lines[i])) indices.push(i);
  if (indices.length !== fences.length) return text;                       // 增删过代码块：不动
  for (let k = 0; k < indices.length; k++) {
    if (lines[indices[k]] === fences[k].line) continue;
    if (fenceLang(lines[indices[k]]) !== fences[k].lang) return text;      // 语言被改过：不动
  }
  const out = lines.slice();
  let changed = false;
  for (let k = 0; k < indices.length; k++) {
    if (out[indices[k]] !== fences[k].line) { out[indices[k]] = fences[k].line; changed = true; }
  }
  return changed ? out.join('\n') : text;
};
/** 保存前把那几行的标题还原（只动"地址没变、当前无标题"的定义行，用户改过地址就按用户的来）。 */
const restoreLinkRefTitles = (text, titles) => {
  if (!titles || !titles.size) return text;
  let changed = false;
  const out = sourceLines(text).map(line => {
    if (!LINK_REF.test(line)) return line;
    const hit = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)[ \t]*$/.exec(line);
    if (!hit || hit[2].includes('"') || hit[2].includes("'")) return line;   // 已经有标题形态：不动
    const known = titles.get(hit[1]);
    if (!known || known.url !== hit[2]) return line;
    changed = true;
    return known.line;
  });
  return changed ? out.join('\n') : text;
};

/** 一个文档从**磁盘原文**推出的全部"保真特征"，一次构造齐。
 *
 *  此前这段字段清单被复制了四份（打开 + 三处重载），加一个字段就得改四处，漏一处就会出现
 *  "从某个入口进来的文档少了这项保真"。``encoding`` 不走这里：它由磁盘**字节**决定，
 *  见 readDiskText()。 */
const diskTraits = text => ({
  eol: fileEol(text),
  finalNewline: /\n$/.test(text),
  linkRefTitles: collectLinkRefTitles(text),
  hardBreakLines: collectHardBreakLines(text),
  indentedCode: collectIndentedCode(text),
  fenceInfo: collectFenceInfo(text),
});

class DocController {
  constructor({ win, state, serverPort, onFileChange, snapshots, workspaceRoot, onPreferenceChange }) {
    this.win = win;
    this.state = state;
    this.port = serverPort;
    this.current = null; // { file, text, savedText, dirty, frameId }
    this.docVersion = 0;
    // 2.1.0 多窗口：一个窗口一个控制器，这里的「工作区」必须是本窗口的（补全取
    // 工作区根时用），全局偏好改了要广播给别的窗口（否则后台窗口停在旧配色）。
    this.workspaceRoot = workspaceRoot || null;   // () => string|null
    this.onPreferenceChange = onPreferenceChange || null; // (name, value) => void
    this._fileWatcher = null;
    this._watchDebounce = null;
    this._savePending = false;
    this._statsTimer = null;
    this._statsCache={text:null,stats:null};
    this._autoSaveTimer=null;this._snapshotTimer=null;this._retryTimer=null;this._disposed=false;
    this.snapshots=snapshots||new SnapshotStore();
    this.onDirtyChange = null; // 回调：标题栏更新
    this.onFileChange = onFileChange;
    this.completions = createCompletionManager(this);
    this.completionSession = null;
    win.on('closed', () => {this._disposed=true;this.cancelTimers();clearTimeout(this._statsTimer);this.closeWatch();this.disposeCompletion();});
  }

  get file() { return this.current ? this.current.file : null; }
  get dirty() { return !!(this.current && this.current.dirty); }

  docUrl(file) {
    this.docVersion += 1;
    return `/doc/${encodeURIComponent(file)}?v=${this.docVersion}`;
  }

  updateTitle() {
    if (!this.current) { this.win.setTitle("MarkPilot"); return; }
    const dot = this.current.dirty ? '● ' : '';
    this.win.setTitle(`${dot}${path.basename(this.current.file)} - MarkPilot`);
  }

  // 有未保存修改时弹确认框。返回 true=可以继续，false=用户取消
  async confirmDiscard() {
    this.cancelTimers();
    // R10 confirmDiscard（门4）：渲染层 change 推送是 200ms 尾随去抖，键入后立刻关窗/切档/
    // 退出时 change 未达、dirty 仍是 false——不先把活值落账就会在下面整体早退，那一拍键入
    // 静默丢失。与 save() 同一 helper 同一顺序（拉值放在等在途保存之前：在途保存收尾会把
    // dirty 按它捕获的旧 view 归零）。拉值失败/超时在这里静默降级为「按已知 dirty 继续」，
    // 绝不挂死弹框链；干净文档上 pending=false 时 flushEditorText 本就是 no-op，不会置脏、
    // 不会弹假确认框（负门口径）。
    try { if (this.current) await this.flushEditorText(this.current); } catch { /* 按已知 dirty 继续 */ }
    await this.finishSave();
    if (!this.dirty) return true;
    const choice = dialog.showMessageBoxSync(this.win, {
      type: 'warning',
      title: '未保存的修改',
      message: `${path.basename(this.current.file)} 有未保存的修改`,
      detail: '关闭前是否保存？',
      buttons: ['保存', '放弃修改', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) return await this.save();
    if(choice===1){await this.capture(this.current,'discard');return true;}
    this.scheduleProtection();return false;
  }

  async openFile(file, {confirmedDiscard} = {}) {
    file = path.resolve(file); // 统一为反斜杠，保证与文件树、scrollStore 键一致
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    if (this.current && this.current.file.toLowerCase() === file.toLowerCase()) {
      // A recent link to the current document must not discard unsaved edits.
      this.state.pushRecent('recentFiles', file);
      return true;
    }
    // 单文档模型：切换前若有未保存修改，先确认（插件版每个文件独立 webview 无此问题）。
    // R10 confirmDiscard（门3）：同族早退——脏判据同样吃不到 200ms 去抖窗内的键入
    // （change 未达、dirty=false），不先拉活账就会直接切文档、那一拍静默丢。拉值失败/
    // 超时静默降级为按已知 dirty 继续；干净文档 pending=false 时是 no-op（负门）。
    try { if (this.current) await this.flushEditorText(this.current); } catch { /* 按已知 dirty 继续 */ }
    if (this.current && this.current.dirty && this.current.file !== file) {
      const confirmed=confirmedDiscard?.current===this.current&&confirmedDiscard.text===this.current.text;
      if (!confirmed && !(await this.confirmDiscard())) return false;
    }
    let content, encoding;
    try {
      ({ text: content, encoding } = await this.readDiskText(file));
    } catch (e) {
      dialog.showMessageBoxSync(this.win, { type: 'error', message: '无法打开文件', detail: e.message });
      this.scheduleProtection();
      return false;
    }
    // 本产品只写 UTF-8，所以"磁盘不是 UTF-8"必须在这里当场说清楚，并**拒绝写回原文件**。
    // 老行为是静默按 UTF-8 有损解码，默认开启的自动保存再把乱码写回去——用户的文件当面损坏。
    if (!encoding.writable) {
      const choice = dialog.showMessageBoxSync(this.win, { type: 'warning', title: '文件编码',
        message: `无法安全保存这个文件（${encoding.name}）`,
        detail: `${encoding.detail}\n\n仍可打开查看与编辑，但 MarkPilot 不会写回这个文件，`
          + `原文件保持原样。需要保留修改时请用 文件 → 另存为，存成 UTF-8 的新文件。`,
        buttons: ['仍然打开（不会写回原文件）', '取消'], defaultId: 0, cancelId: 1 });
      if (choice !== 0) { this.scheduleProtection(); return false; }
    }
    // Mask the new document before touching the old one: if anything fails,
    // the current document keeps its completion session, autosave and
    // snapshot timers untouched (bad images degrade, never block opening).
    const images=new PortableImages({root:path.join(path.dirname(this.state.file),'embedded-images')});
    let view;
    try{view=await images.mask(content,{tolerant:true});}
    catch(error){dialog.showMessageBoxSync(this.win,{type:'error',message:'无法加载内嵌图片',detail:error.message});this.scheduleProtection();return false;}
    this.disposeCompletion();
    this.cancelTimers();
    // 记下磁盘文件的行尾与"末尾有没有换行"：编辑区里一律是 \n，保存时按这里还原。
    // 不记的话 CRLF 文件改一个字保存一次就会被整篇换成 LF（实测 CRLF 6 → 0）：
    // Windows 上记事本打开会变成一行，git 里显示"整篇都被改动"。
    this.current = { file, text:view, savedText:view, savedDisk:content, images, encoding,
      ...diskTraits(content),
      dirty: false, frameId: null, version:1 };
    const openWarnings=images.consumeWarnings();
    if(openWarnings.length)dialog.showMessageBox(this.win,{type:'warning',message:'部分内嵌图片未加载',detail:openWarnings.slice(0,6).join('\n')});
    this.capture(this.current,'open');
    this.watchFile();
    this.state.set('lastFile', file);
    this.state.pushRecent('recentFiles', file);
    this.updateTitle();
    this.onFileChange?.();
    this.loadInShell();
    await this.offerRecovery(this.current);
    return true;
  }

  loadInShell() {
    if (!this.current) return;
    this.disposeCompletion();
    this.current.frameId = null;
    this.win.webContents.send('doc-load', {url: this.docUrl(this.file), file: this.file});
    // MW6：doc-load 的同一刻立即推一次这份文档的统计。只靠 400ms 去抖的话，切换文档后
    // 状态栏会先亮上一份文档的字数与保存横幅（残影 400ms+）。主进程此刻拿 current.text
    // 算出来的就是新文档的数，saveError/snapshotError 也一并归位，横幅随推随清。
    this.pushStats();
  }

  settings(){return this.state.get('settings')||{autoSave:true,snapshots:true};}
  cancelTimers(){clearTimeout(this._autoSaveTimer);clearTimeout(this._snapshotTimer);clearTimeout(this._retryTimer);this._autoSaveTimer=this._snapshotTimer=this._retryTimer=null;}
  async capture(cur,reason,text=cur?.text){
    if(!cur||!this.settings().snapshots)return;
    try{
      const item=await this.snapshots.capture(cur.file,this.diskText(cur,text),reason);
      if(cur.snapshotError){cur.snapshotError=null;if(this.current===cur)this.scheduleStats();}return item;
    }catch(error){
      if(this.current===cur&&!this._disposed){cur.snapshotError=error.message;this.scheduleStats();}
      console.error('Snapshot failed:',error.message);
    }
  }
  scheduleProtection({resetAutoSave=true}={}){
    if(resetAutoSave){clearTimeout(this._autoSaveTimer);this._autoSaveTimer=null;}
    const cur=this.current,settings=this.settings();
    if(!cur?.dirty||this._disposed){this.cancelTimers();return;}
    if(resetAutoSave&&settings.autoSave&&!cur.externalConflict&&!cur.deleted&&cur.encoding?.writable!==false){
      this._autoSaveTimer=setTimeout(()=>{this._autoSaveTimer=null;if(this.current===cur&&this.settings().autoSave)this.save({automatic:true});},1500);this._autoSaveTimer.unref?.();
    }
    if(!settings.snapshots){clearTimeout(this._snapshotTimer);this._snapshotTimer=null;}
    else if(!this._snapshotTimer){this._snapshotTimer=setTimeout(async()=>{this._snapshotTimer=null;if(this.current===cur&&cur.dirty&&!this._disposed){await this.capture(cur,'interval');this.scheduleProtection({resetAutoSave:false});}},60*1000);this._snapshotTimer.unref?.();}
  }
  /** F3'：保存失败后的 10s 退避重试。旧代码自动保存失败一次后就永远不再排程（只有用户
   *  再打一个字才会重挂），OneDrive/网盘短暂占用一过就停摆——脏内容只剩 60s 快照兜底。
   *  这里失败即排一次 10s 重试；到点时 dirty 仍在、故障态未被人工接管（无冲突/失联/不可写
   *  编码）就再存一次，再失败会从同一条失败路径把重试续排下去。 */
  scheduleSaveRetry(cur){
    if(this.current!==cur||this._disposed)return;
    clearTimeout(this._retryTimer);
    this._retryTimer=setTimeout(()=>{
      this._retryTimer=null;
      if(this.current!==cur||this._disposed||!cur.dirty||!cur.saveError||cur.savePromise)return;
      if(!this.settings().autoSave||cur.externalConflict||cur.deleted||cur.encoding?.writable===false)return;
      this.save({automatic:true});
    },10*1000);
    this._retryTimer.unref?.();
  }
  /** 保存成功/故障标志清除时撤掉退避重试排程。 */
  clearSaveRetry(){clearTimeout(this._retryTimer);this._retryTimer=null;}
  setSetting(name,enabled){
    if(!['autoSave','snapshots'].includes(name)||typeof enabled!=='boolean')throw new Error('无效的保存设置');
    this.state.set('settings',{...this.settings(),[name]:enabled});
    if(name==='snapshots'&&enabled)this.capture(this.current,'enabled');
    this.scheduleProtection();
  }
  async finishSave(){if(this.current?.savePromise)await this.current.savePromise;}
  /** 编辑区里的文本 → 落盘文本。**这里是唯一的转换点**（保存、另存为、快照都走它）：
   *  ① 展开被掩码的内嵌图片（原有行为）；② 按文件原来的行尾风格还原（CRLF 文件不许被换成
   *  LF）；③ 原文末尾没有换行时不要把编辑器补的那个换行写进去（只去掉一个，用户自己
   *  在末尾留的空行仍然保留）。 */
  diskText(cur=this.current,text=cur?.text){
    let out=cur?.images?.expand(text)||text;
    out=restoreLinkRefTitles(out,cur?.linkRefTitles);
    out=restoreHardBreaks(out,cur?.hardBreakLines);
    out=restoreIndentedCode(out,cur?.indentedCode);
    out=restoreFenceInfo(out,cur?.fenceInfo);
    if(cur?.eol==='crlf')out=out.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n');
    if(cur&&cur.finalNewline===false)out=out.replace(/\n$/,'');
    return out;
  }
  /** 读文档文件：**唯一的解码入口**（打开 / 三处重载 / 监听 / 冲突比较全部走它）。
   *  统一入口是必须的：若监听器按 UTF-8 读、而当前文档是按 UTF-16 解码的，两者一比就会被
   *  判成"磁盘有外部修改"，接着用 UTF-8 的乱码把正确内容覆盖掉。 */
  async readDiskText(file){
    return readText(await fsp.readFile(file));
  }
  /** 上次退出时可能带着未保存的内容——本地快照里有比磁盘**更新且内容不同**的版本时问一句。
   *  硬崩最多丢到下一次快照，而用户此前连"有东西可恢复"都不知道，得自己摸到
   *  文件 → 版本历史… → 恢复为副本。
   *
   *  判定必须**比内容**，不能只比时间：打开时本函数之前就会 capture 一条 reason='open'
   *  的快照，它的时间必然比文件 mtime 新，只看时间会在每次打开都误报。
   *  reason==='discard' 也不算：用户当时明确选了"放弃修改"，不该下次开机再来问他一遍。
   *  恢复动作只**生成副本**（`wx` 独占创建，永不覆盖），磁盘上的原文件一个字节都不动。 */
  async offerRecovery(cur){
    if(!cur?.file||cur.encoding?.writable===false||!this.settings().snapshots)return;
    // 比内容，不比哈希：快照正文是 **diskText 写过的"磁盘形态"**（行尾还原成文件的行尾、
    // 内嵌图片展开回 base64），而编辑区里的 `cur.text` 是**视图形态**（内嵌图片被遮成引用）。
    // 所以必须把当前内容也过一遍 diskText 再比——**拿视图形态比磁盘形态，凡是含内嵌图片的
    // 文档都会被判成"有东西可恢复"**：实测（2026-09-17）受保护素材（含 base64 内嵌图）一打开
    // 就弹"发现未保存的内容"模态框，而那份内容其实就是刚从磁盘读出来的、同一个字节不差。
    // 模态框还会把应用挡住（无人应答时不恢复），把"打开大素材"整条路堵死。
    const bare=value=>String(value).replace(/\r\n?/g,'\n');
    let current;try{current=bare(this.diskText(cur));}catch(error){console.error('比对恢复内容失败',error.message);return;}
    let candidate=null;
    try{
      // **往回找第一条与磁盘不同的**，不能只看 list()[0]：打开时本函数之前就会写一条
      // reason='open' 的快照（内容==磁盘），它必然是最新的一条，只看最新就会被它挡掉、
      // 真正的崩溃残留永远问不出来（实测踩到）。
      // 遇到 'discard' 就停：用户当时明确选了"放弃修改"，不该下次开机再来问一遍。
      for(const item of (await this.snapshots.list(cur.file)).slice(0,10)){
        if(item.reason==='discard')break;
        const body=await this.snapshots.full(cur.file,item.id);
        if(bare(body)!==current){candidate=item;break;}
      }
    }catch(error){console.error('读取快照失败',error.message);return;}
    if(!candidate)return;
    let stat;try{stat=fs.statSync(cur.file);}catch{return;}
    if(!(candidate.created>stat.mtimeMs))return;                   // 快照不比文件新：那只是历史版本
    if(Date.now()-candidate.created>14*24*3600*1000)return;        // 太旧的别拿来打扰用户
    const when=new Date(candidate.created).toLocaleString(LANG);
    const choice=dialog.showMessageBoxSync(this.win,{type:'warning',title:'发现未保存的内容',
      message:'上次退出时可能有未保存的修改',
      detail:`本地快照里有一份比磁盘更新的内容（${when}，约 ${candidate.words||0} 字），`
        +`而磁盘上的文件没有被改动过。\n可以生成一份恢复副本放在文档旁边，再自行比对；原文件不会被动。`,
      buttons:['生成恢复副本','忽略'],defaultId:0,cancelId:1});
    if(choice!==0)return;
    try{
      const copy=await this.snapshots.restore(cur.file,candidate.id);
      const next=dialog.showMessageBoxSync(this.win,{type:'info',title:'恢复副本已生成',
        message:'恢复副本已生成，原文件未被改动',detail:copy,
        buttons:['打开副本','打开所在文件夹','关闭'],defaultId:0,cancelId:2});
      if(next===0)shell.openPath(copy).catch(error=>console.error('打开恢复副本失败',error.message));
      else if(next===1)shell.showItemInFolder(copy);
    }catch(error){
      dialog.showMessageBoxSync(this.win,{type:'error',title:'生成恢复副本失败',message:'生成恢复副本失败',detail:error.message});
    }
  }
  // Save-as may move the document to a different directory (or machine):
  // embed every image referenced by a relative path so the copy stays
  // self-contained. Remote URLs and already-embedded data URIs stay as-is;
  // unreadable or oversized images keep their original reference + warning.
  /** 相对路径图片引用（另存为时可内嵌的候选）：data: 内嵌图、带协议/协议相对的远程
   *  URL、Windows 绝对路径都不算。saveAs 的告知框与 embedRelativeImages 共用这一份
   *  判定，两处口径才不会漂移（弹框说 N 张、实际嵌的不是 N 张）。 */
  relativeImageSpans(text){
    return imageSources(text).filter(item=>!item.src.startsWith('data:')&&!/^[a-z][a-z\d+.-]*:|^\/\//i.test(item.src)&&!/^[a-z]:[\\/]/i.test(item.src));
  }
  async embedRelativeImages(cur){
    for(let attempt=0;attempt<2;attempt++){
      const source=cur.text;
      const spans=this.relativeImageSpans(source);
      const assets=new Map(),warnings=[];
      for(const src of [...new Set(spans.map(item=>item.src))]){
        try{const image=await imageBytes(src,cur.file);assets.set(src,'data:'+image.mime+';base64,'+image.bytes.toString('base64'));}
        catch(error){warnings.push(src.slice(0,120)+'：'+error.message);}
      }
      if(cur.text!==source)continue; // user typed while reading; retry on the newer text
      let cursor=0;const parts=[];
      for(const item of spans){
        const url=assets.has(item.src)?cur.images.register(assets.get(item.src),{tolerant:true}):null;
        parts.push(source.slice(cursor,item.start),url||item.src);cursor=item.end;
      }
      parts.push(source.slice(cursor));
      await cur.images.flush();
      return {text:parts.join(''),warnings};
    }
    // The editor never quiesced: keep the user's latest text unmodified.
    return {text:cur.text,warnings:[]};
  }
  /** 从渲染层拉"活"编辑值（与 export.js 导出捕获同一惯用法：在 shell 主帧里经同源
   *  iframe 直接读 vditor.getValue()——incremental-ir 的 getMarkdown 会同步
   *  takeRecords 吞掉挂在 MutationObserver 上的未处理变更，读到的永远是当前 DOM，
   *  没有缓存窗口）。任何失败（编辑器未就绪 / 渲染层异常 / 3s 超时）都返回 null，
   *  由调用方按旧行为降级；竞速输掉后迟到的拒绝也必须吞掉，不能变成主进程未处理拒绝。
   *  captured.pending = 渲染层是否**接过真实输入**（index.js 在编辑器文档上挂的捕获相
   *  input 监听置位 window.__mpInputSeen；键入/粘贴/拖放文本的同一拍同步置位，先于
   *  vditor 的 200ms 去抖推送，文档切换整帧重载后天然归零）。 */
  pullLiveText() {
    if (this._disposed || !this.win || this.win.isDestroyed()) return Promise.resolve(null);
    const task = this.win.webContents.executeJavaScript(`(() => {const frame=document.getElementById('editor');const editor=frame?.contentWindow?.vditor;if(!editor)return null;return {text:editor.getValue(),url:frame.src,pending:!!frame.contentWindow.__mpInputSeen};})()`);
    task.catch(() => {});
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), PULL_EDITOR_TIMEOUT_MS); timer.unref?.(); });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  }
  /** 手动保存落盘前把渲染层的活值落账到 cur：拉回文本与 cur.text 不同时走 applyText
   *  （与渲染层 change 推送同一入口，dirty / 标题 / 统计的语义天然一致），之后 save
   *  正常落盘的就是新值。帧身份守卫与 export.js 同款（url 文件名 + 加载代号 v）：
   *  iframe 未就绪或正在切文档时视为"没有更新"。只拉值、**不清**渲染层的 200ms 去抖
   *  定时器：自然到点的同文本推送经 applyText 是 no-op，标题不会闪脏闪回；IME 组合期
   *  拉到的是组合中的 DOM 文本（与 Typora 同类语义），照存不拦。
   *  【R9 补充（场景 111/134 回归发现）】渲染层**从未接过输入**（pending=false）时不走
   *  applyText：Lute 的 IR 往返对表格对齐/块公式围栏有归一化改写，纯净文档上的
   *  getValue() 本就可能与磁盘原文差这些字节——拉值若无条件落账，会让**未做任何编辑
   *  的手动 Ctrl+S** 把归一化结果写盘（mtime 变、git 噪声；Typora 同情形是彻底 no-op）。
   *  只有渲染层真的接过输入（__mpInputSeen）才把活值当新文本落账。 */
  async flushEditorText(cur) {
    if (this.current !== cur || this._disposed) return;
    // R10：便宜的「飞行中」探针先行——pending=false（没有未推送输入）时连 getValue 都
    // 不必拉：大文档上一次 getValue 要数百 ms（72 台阶实测切档 invokeToDom +313ms，恰是
    // 每次切换前多付的那次拉值）。渲染层真的接过未推送输入才付全量拉值；探针失败/超时
    // 按「没有」处理（最坏等于不拉值，回到旧的按已知账目行为）。
    const inflight = await this.pullPendingFlag();
    if (this.current !== cur || this._disposed || inflight !== true) return;
    let captured = null;
    try { captured = await this.pullLiveText(); } catch { captured = null; }
    if (!captured || typeof captured.text !== 'string') return;
    if (this.current !== cur || this._disposed) return;
    let urlFile = null, version = null;
    try {
      const url = new URL(captured.url);
      urlFile = decodeURIComponent(url.pathname.slice(5));
      version = url.searchParams.get('v');
    } catch { return; }
    if (urlFile !== cur.file || version !== String(this.docVersion)) return;
    if (captured.pending === false) return;
    if (captured.text !== cur.text) this.applyText(cur, captured.text);
  }
  /** 只读渲染层「输入在飞行中」标志（__mpInputSeen，index.js 收窄口径后它精确等价于
   *  「键入后 200ms 去抖未到点」）。帧身份不在此查——误报至多触发一次随后会被身份守卫
   *  拦下的全量拉值，无行为影响。 */
  pullPendingFlag() {
    if (this._disposed || !this.win || this.win.isDestroyed()) return Promise.resolve(null);
    const task = this.win.webContents.executeJavaScript(`(() => { const frame = document.getElementById('editor'); const w = frame && frame.contentWindow; return w ? !!w.__mpInputSeen : null; })()`);
    task.catch(() => {});
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), PULL_EDITOR_TIMEOUT_MS); timer.unref?.(); });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  }
  async saveAs(cur=this.current){
    if(!cur)return false;
    // C：另存为同源病灶——嵌图、图片数提示框、落盘读的 cur.text 同样可能落后渲染层
    // 一拍（Ctrl+Shift+S 与 Ctrl+S 同为主进程加速键，不经渲染层），进对话框前先拉活值。
    await this.flushEditorText(cur);
    if(this.current!==cur)return false;
    const chosen=await dialog.showSaveDialog(this.win,{title:'另存为 Markdown',defaultPath:path.join(path.dirname(cur.file),path.basename(cur.file,path.extname(cur.file))+'-副本.md'),filters:[{name:'Markdown',extensions:['md']}],properties:['showOverwriteConfirmation','createDirectory']});
    if(chosen.canceled||!chosen.filePath||this.current!==cur)return false;
    const target=chosen.filePath.toLowerCase().endsWith('.md')?chosen.filePath:chosen.filePath+'.md';
    // MW2：目标文件如果在**别的窗口**已经打开，绝不能落盘成第二份——两个窗口会各自把
    // 对方的保存当外部变更（自动保存互相暂停、会话恢复还会带出两份）。openPaths 打开
    // 已有文件时就是"只聚焦、不重复开"，另存为必须是同一条规则：拦下并聚焦那个窗口。
    const clash=(global.windows||[]).find(r=>r&&r.win!==this.win&&!r.win.isDestroyed()&&r.doc&&r.doc.file&&r.doc.file.toLowerCase()===target.toLowerCase());
    if(clash){
      const pick=dialog.showMessageBoxSync(this.win,{type:'warning',title:'目标文件已在其他窗口打开',
        message:`「${path.basename(target)}」已经在另一个窗口打开`,
        detail:'同一个文件不能由两个窗口同时编辑，否则两边会互相判定为外部修改而停止自动保存。\n可以聚焦那个窗口继续编辑，或换一个文件名另存。',
        buttons:['聚焦该窗口','取消'],defaultId:0,cancelId:1});
      if(pick===0){try{if(clash.win.isMinimized())clash.win.restore();clash.win.focus();}catch{/* 窗口可能刚销毁 */}}
      return false;
    }
    try{
      const {distinctTarget,fingerprint}=require('./export');await distinctTarget(cur.file,target);
      const initial=await fingerprint(target);
      // D2：另存为默认把相对路径图片内嵌成 base64——这是对文档的主动重写（Typora 等
      // 编辑器可能把大内嵌图显示为源码文本），必须先告知再动手。没有相对路径图片时
      // 不弹框，保持原体验；「保留引用」= 只写文本不嵌图，由用户自行把图带到新位置。
      const relatives=[...new Set(this.relativeImageSpans(cur.text).map(item=>item.src))];
      let embed=true;
      if(relatives.length){
        const choice=dialog.showMessageBoxSync(this.win,{type:'question',title:'另存为：相对路径图片',
          message:`这份文档引用了 ${relatives.length} 张相对路径图片`,
          detail:`另存为副本会把 ${relatives.length} 张相对路径图片内嵌为 base64（便于单文件分发；但 Typora 等编辑器可能把大内嵌图显示为源码文本）。\n`
            +'选择「保留相对路径引用」则只写文本、不嵌图：新文件仍按原相对路径找图，请自行把图片带到新位置。',
          buttons:['内嵌（单文件便携）','保留相对路径引用','取消'],defaultId:0,cancelId:2});
        if(choice===2)return false;
        embed=choice===0;
      }
      const embedded=embed?await this.embedRelativeImages(cur):{text:cur.text,warnings:[]},text=embedded.text,data=this.diskText(cur,text);
      await fsp.mkdir(path.dirname(target),{recursive:true});
      await atomicWrite(target,data,{beforeCommit:async()=>{await distinctTarget(cur.file,target);if(await fingerprint(target)!==initial)throw new Error('目标文件已被外部修改，请重新另存');}});
      if(this.current!==cur)return true;
      cur.file=target;cur.text=text;cur.savedText=text;cur.savedDisk=data;cur.dirty=false;cur.deleted=false;cur.externalConflict=false;cur.saveError=null;this.clearSaveRetry();
      // 另存为写出的是我们自己编码的 UTF-8，所以从这一刻起这份文档是"可写"的。
      // 不重置的话，从"编码不可写"的文件另存出来之后，新文件也会被永久拒绝保存。
      cur.encoding={name:'UTF-8',writable:true,detail:''};
      this.state.set('lastFile',target);this.state.pushRecent('recentFiles',target);this.watchFile();this.updateTitle();this.onFileChange?.();this.loadInShell();await this.capture(cur,'save-as',text);
      if(embedded.warnings.length)dialog.showMessageBox(this.win,{type:'warning',message:'另存完成，部分图片未能内嵌',detail:'以下图片仍按原路径引用，移动文件后可能失效：\n'+embedded.warnings.slice(0,8).join('\n')});
      if(!embed)dialog.showMessageBox(this.win,{type:'info',title:'另存完成（图片引用保留）',message:'副本已保存，图片仍按相对路径引用',detail:'新文件没有内嵌图片，仍引用原来的相对路径；请把图片目录一起带到新位置（保持相对结构），否则图片无法显示。',buttons:['确定']});
      return true;
    }catch(error){dialog.showMessageBoxSync(this.win,{type:'error',message:'另存失败',detail:error.message});return false;}
  }
  async save({automatic=false}={}) {
    const cur=this.current;if(!cur)return true;
    // C（快 Ctrl+S）：手动保存先把渲染层的活值拉回账上，再走下面任何 dirty 早退。渲染层
    // change 推送是 200ms 尾随去抖（IME 组合期还会被 composingLock 吞掉重排，窗口更大），
    // 而 Ctrl+S 是主进程菜单加速键、不经渲染层——主进程侧 cur.text 可能落后 DOM 一拍。
    // 已脏文档只是落盘缺最后一拍；"干净文档"变体（change 未达、dirty=false）会在早退处
    // 整体返回、一个字节都不写，比缺一拍更重。拉值还必须放在「等在途保存」之前：在途
    // 保存收尾会把 dirty 按它捕获的旧 view 归零，先拉值才能让那个早退看见新文本。
    // 自动保存不走拉值：它只在 dirty=true 时被排程、1.5s 也远大于 200ms 去抖窗，没有
    // 本病灶，维持原行为（改动最小化）。拉值失败/超时在 flushEditorText 内静默降级为
    // "没有更新"，保存照常按主进程已有的旧值进行，绝不因拉值失败而丢保存。
    if(!automatic){await this.flushEditorText(cur);if(this.current!==cur)return true;}
    // F6'：撞上"失败中的在途保存"（比如自动保存正被网盘占用后失败而归）时，手动保存
    // 不再陪着返回那次假失败——等在途结束后落穿，把用户按下的这一次保存真正写掉。
    if(cur.savePromise){
      const ok=await cur.savePromise;
      if(this.current!==cur)return ok;
      if(ok&&!cur.dirty)return true;
    }
    if(!cur.dirty)return true;
    if(automatic&&(!this.settings().autoSave||cur.externalConflict||cur.deleted||cur.encoding?.writable===false))return false;
    clearTimeout(this._autoSaveTimer);this._autoSaveTimer=null;
    // Serial per-document writes: the completed operation can only mark its
    // captured text as saved, never newer edits received while I/O was pending.
    if(cur.savePromise)return this.save({automatic});
    const operation=this.writeCurrent(cur,automatic);cur.savePromise=operation;
    let ok;try{ok=await operation;}finally{if(cur.savePromise===operation)cur.savePromise=null;}
    if(ok&&this.current===cur&&cur.dirty&&!automatic)return this.save();
    if(ok)this.scheduleProtection();return ok;
  }
  async writeCurrent(cur,automatic){
    // 磁盘不是 UTF-8（非 UTF-8 编码 / 含 NUL）：**绝不写回原文件**。这一条挡在"写盘"唯一
    // 入口的最前面，自动保存与显式保存两条路都从这里过。原文件因此一个字节都不会被改动。
    if(cur.encoding&&!cur.encoding.writable){
      cur.saveError=`文件是 ${cur.encoding.name}，为避免损坏原文件已停止保存；可用 文件 → 另存为 存成 UTF-8 新文件`;
      if(this.current===cur)this.scheduleStats();
      if(!automatic){
        const choice=dialog.showMessageBoxSync(this.win,{type:'warning',title:'无法写回原文件',
          message:`这个文件是 ${cur.encoding.name}`,
          detail:`${cur.encoding.detail}\n\nMarkPilot 不会写回这个文件，以免损坏内容；原文件保持原样。`
            +`可另存为 UTF-8 的新文件。`,
          buttons:['另存为副本…','取消'],defaultId:0,cancelId:1});
        if(choice===0)return this.saveAs(cur);
      }
      return false;
    }
    const file=cur.file,view=cur.text,text=this.diskText(cur,view),savedText=cur.savedDisk??cur.savedText;this._savePending=true;
    try{
      const readDisk=async()=>this.readDiskText(file).then(result=>result.text).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      let disk=await readDisk();
      if(this.current!==cur||cur.file!==file)return false;
      if(disk!==null&&disk!==savedText&&disk!==text){
        cur.externalConflict=true;await this.capture(cur,'external',disk);await this.capture(cur,'conflict',text);
        if(automatic){cur.saveError='磁盘有更新，自动保存已暂停；按 Ctrl+S 处理';this.scheduleStats();return false;}
        // F5'：只有本地快照开着时才存在"外部版本已留存"这回事；关着快照就绝不能向用户
        // 承诺"可从版本历史恢复"——那是一条不存在的历史，覆盖后外部版本无从找回。
        const historyHint=this.settings().snapshots
          ?'也可以取消并从版本历史恢复为副本。'
          :'注意：本地快照已关闭，磁盘上的外部版本没有备份，覆盖后将无法找回。';
        const choice=dialog.showMessageBoxSync(this.win,{type:'warning',title:'文件已被外部修改',message:'磁盘内容与打开时不同',detail:'当前编辑仍保留在窗口中。覆盖会用当前编辑替换磁盘内容；'+historyHint,buttons:['覆盖磁盘文件','取消'],defaultId:1,cancelId:1});
        if(choice!==0)return false;
      }
      if(disk===null){
        if(automatic){cur.deleted=true;cur.saveError='文件已不在原位置（可能被移走、改名或删除）；按 Ctrl+S 确认后重新保存';this.scheduleStats();return false;}
        // F2'：ENOENT 上区分不了"真删除"与"被改名/移走"，Ctrl+S 绝不静默重建——否则外部
        // 改名场景会在原位置留下一份陈旧副本，两份内容各自漂移。必须用户确认才重建。
        const choice=dialog.showMessageBoxSync(this.win,{type:'warning',title:'文件不在原位置',
          message:`「${path.basename(file)}」已不在原位置`,
          detail:'文件可能被移动、改名，或在原位置被删除。\n\n选择「重新保存」会在原位置重建这个文件；若它只是被移动或改名了，请取消并改用 文件 → 另存为。',
          buttons:['重新保存','取消'],defaultId:1,cancelId:1});
        if(choice!==0)return false;
      }
      await fsp.mkdir(path.dirname(file),{recursive:true});
      const target=await fsp.realpath(file).catch(error=>{if(error.code==='ENOENT')return file;throw error;});
      await atomicWrite(target,text,{beforeCommit:async()=>{
        if(this.current!==cur||cur.file!==file)throw new Error('文件已切换，保存已取消');
        const latest=await readDisk();if(latest!==disk){cur.externalConflict=true;throw new Error('写盘期间文件被外部修改，未覆盖磁盘内容');}
      }});
      cur.savedText=view;cur.savedDisk=text;cur.dirty=cur.text!==view;cur.externalConflict=false;cur.deleted=false;cur.saveError=null;
      this.clearSaveRetry();
      this.updateTitle();this.onDirtyChange?.(cur.dirty);this.scheduleStats();this.watchFile();
      await this.capture(cur,'save',text);return true;
    }catch(error){
      cur.saveError=error.message;
      if(this.current===cur&&!this._disposed){this.scheduleStats();await this.capture(cur,'save-failed');this.scheduleSaveRetry(cur);if(!automatic){
        const choice=dialog.showMessageBoxSync(this.win,{type:'error',message:'保存失败',detail:error.message+'\n可使用 文件 → 另存为，将当前编辑保存为副本。',buttons:['确定','另存为副本…'],defaultId:1,cancelId:0});
        if(choice===1)return this.saveAs(cur);
      }}
      return false;
    }finally{this._savePending=false;}
  }

  closeDoc() {
    this.cancelTimers();
    this.disposeCompletion();
    this.closeWatch();
    this.current = null;
    this.updateTitle();
    this.onFileChange?.();
  }

  // ---- 当前文件监听（外部修改 → setValue，复刻 onDidSaveTextDocument 逻辑） ----
  watchFile() {
    this.closeWatch();
    if (!this.current) return;
    try {
      this._fileWatcher = fs.watch(this.current.file, () => this.scheduleFileCheck());
      this._fileWatcher.on('error', () => this.scheduleFileCheck());
    } catch { /* 文件可能刚被删除 */ }
  }

  closeWatch() {
    if (this._fileWatcher) { try { this._fileWatcher.close(); } catch { /* ignore */ } this._fileWatcher = null; }
    clearTimeout(this._watchDebounce);
  }

  scheduleFileCheck() {
    clearTimeout(this._watchDebounce);
    this._watchDebounce = setTimeout(() => this.checkFile(), 200);
  }

  async checkFile() {
    const cur = this.current;
    if (!cur || this._savePending) return;
    let disk, encoding;
    try {
      ({ text: disk, encoding } = await this.readDiskText(cur.file));
    } catch {
      // 文件失联（被删除 / 被改名移走 / 暂时读不到）：ENOENT 上区分不了"删除"与"改名"，
      // 统一按"失联"处理——保留内容、停排自动保存，并把原因亮到状态栏（旧代码零反馈，
      // 用户根本不知道文件已经不在了，Ctrl+S 还会静默在原位置重建一份陈旧副本）。
      if (this.current===cur&&!fs.existsSync(cur.file)) {
        cur.dirty = true;
        cur.deleted=true;
        cur.saveError='文件已不在原位置（可能被移走、改名或删除）；自动保存已暂停，按 Ctrl+S 确认后重新保存';
        this.cancelTimers();this.scheduleProtection();
        this.updateTitle();this.scheduleStats();
      }
      return;
    }
    if(this.current!==cur||this._savePending)return;
    if (disk === this.diskText(cur)) {
      if (cur.dirty) { cur.dirty = false; this.updateTitle(); }
      cur.savedText = cur.text;cur.savedDisk=disk;cur.encoding=encoding;Object.assign(cur,diskTraits(disk));
      cur.externalConflict=false;cur.deleted=false;cur.saveError=null;this.clearSaveRetry();this.scheduleProtection();this.scheduleStats();
      return;
    }
    if (disk === (cur.savedDisk??cur.savedText)) {
      // F4'：磁盘回到上次保存时的形态（外部 git checkout 还原、同步盘回滚等）。旧代码在
      // 这里直接早退，externalConflict/deleted/saveError 闩锁永远解不开——"自动保存已暂停"
      // 常驻状态栏，脏内容从此只能手动保存。清掉闩锁并恢复排程（dirty 仍在就重挂自动保存）。
      if(cur.externalConflict||cur.deleted||cur.saveError){
        cur.externalConflict=false;cur.deleted=false;cur.saveError=null;
        this.clearSaveRetry();
        if(this.current===cur){this.scheduleProtection();this.scheduleStats();}
      }
      return; // 自己保存触发的通知
    }
    if(cur.dirty){
      cur.externalConflict=true;cur.saveError='磁盘有更新，自动保存已暂停；按 Ctrl+S 处理';
      this.capture(cur,'external',disk);this.capture(cur,'conflict');this.scheduleProtection();this.scheduleStats();return;
    }
    // 外部修改：以磁盘为准（坏图降级保留原文，不吞其他错误）
    let view;
    try{view=await cur.images.mask(disk,{tolerant:true});}
    catch(error){cur.externalConflict=true;cur.saveError='外部更新无法加载：'+error.message;this.scheduleStats();return;}
    if(this.current!==cur||cur.dirty||this._savePending)return;
    const reloadWarnings=cur.images.consumeWarnings();
    if(reloadWarnings.length)dialog.showMessageBox(this.win,{type:'warning',message:'部分内嵌图片未加载',detail:reloadWarnings.slice(0,6).join('\n')});
    cur.text = view;
    cur.version++;
    cur.savedText = view;cur.savedDisk=disk;cur.encoding=encoding;Object.assign(cur,diskTraits(disk));
    cur.dirty = false;
    cur.externalConflict=false;cur.deleted=false;cur.saveError=null;this.cancelTimers();this.capture(cur,'external');this.watchFile();
    this.updateTitle();
    this.completionSession?.controller.notify();
    this.push('setValue', view);
    this.scheduleStats();
  }

  // ---- renderer → 主进程 ----
  disposeCompletion() {
    this.completionSession?.dispose();this.completionSession=null;
  }
  bindCompletion(cur) {
    this.disposeCompletion();const handlers=new Map();let dispose=()=>{},view=()=>{};
    const document={uri:uri(cur.file),get version(){return cur.version;},getText:()=>cur.text};
    const panel={visible:true,onDidDispose:fn=>{dispose=fn;},onDidChangeViewState:fn=>{view=fn;}};
    const handler={on:(name,fn)=>{handlers.set(name,fn);return handler;},emit:(name,value)=>{if(this.current===cur)this.push(name,value);}};
    const controller=this.completions.bind(document,panel,handler,async text=>{
      if(this.current!==cur)return false;this.applyText(cur,text);return true;
    });
    const hidden=()=>{panel.visible=false;view();},shown=()=>{panel.visible=true;view();};
    this.win.on('minimize',hidden);this.win.on('restore',shown);
    this.completionSession={handlers,controller,dispose:()=>{dispose();this.win.removeListener('minimize',hidden);this.win.removeListener('restore',shown);}};
    return controller.boot();
  }
  applyText(cur,text) {
    if(this.current!==cur)return;
    if(cur.text!==text){cur.text=text;cur.version++;}
    if(cur.dirty!==(cur.text!==cur.savedText)) {
      cur.dirty=cur.text!==cur.savedText;this.updateTitle();this.onDirtyChange?.(cur.dirty);
    }
    this.scheduleStats();
    this.scheduleProtection();
  }
  /** K1（R9 E9-A 裁决）：粘贴时归档。渲染层在 paste 拦截处识别出 CF_HTML 里指向本机
   *  路径的 img（Word/Outlook 的 msohtmlclip 临时目录）后，把原始 src 发来；这里读字节、
   *  按扩展名核 mime 与 20 MB 上限（与 export-assets.embedImages 同一套判定），再走
   *  cur.images.insert 的既有归档管线（embedded-images 目录落盘 + 会话登记）。返回的
   *  markdown 引用是伪 CDN 缓存 URL：编辑期经 webRequest 重定向显示，存盘时由
   *  images.expand 内嵌为 base64——源临时目录被清、文档被搬走都不再断链。
   *  读不到字节/格式不受支持会抛错，渲染层收到 error 后退回原样引用（=现状），粘贴
   *  本身不被阻塞。安全面与既有显示通道同级：webRequest/ws-file 本就服务任意本地路径，
   *  这里只多了 mime 白名单与大小上限。 */
  async insertClipboardImage(cur,{id,path:source,name}){
    if(typeof source!=='string'||!source||source.length>1000)throw new Error('无效的图片路径');
    const local=imageFile(source,cur.file,`http://127.0.0.1:${this.port}`);
    if(!local)throw new Error('不支持的图片地址');
    const mime=mimeOf(local).split(';')[0];
    if(!imageMime(mime))throw new Error('不支持的图片格式');
    const stat=await fsp.stat(local);
    if(!stat.isFile()||stat.size>20*1024*1024)throw new Error('图片超过 20 MB 或不是文件');
    const bytes=await fsp.readFile(local);
    return cur.images.insert({id,name:name||path.basename(local),mime,data:bytes.toString('base64')});
  }
  async handleRendererMsg(event, message) {
    if (!message || typeof message.type !== 'string') return;
    const { type, content } = message;
    const cur = this.current;
    if (!cur) return;
    // 过滤已销毁旧 iframe 的迟到消息
    if (type === 'init') {
      if(event.senderFrame) {
        const source=new URL(event.senderFrame.url);
        if(source.origin!==`http://127.0.0.1:${this.port}`||source.pathname!=='/doc/'+encodeURIComponent(cur.file)||source.searchParams.get('v')!==String(this.docVersion))return;
      }
      const generation=this.docVersion;
      // v2.0.9:补全引导失败（如保险库密文跨应用身份不可解）绝不能挡住
      // 文档打开——'open' 不下发，渲染页就永远停在半初始化（无工具栏、
      // 空白正文，2.0.8 用户实测）。降级为无补全继续打开。
      try { await this.completions.ready; }
      catch (error) { console.error('completion bootstrap failed, opening without completion:', error); }
      if(this.current!==cur||generation!==this.docVersion)return;
      cur.frameId = event.frameId;
      let completion=null;
      try { completion=this.bindCompletion(cur); }
      catch (error) { console.error('completion bind failed, opening without completion:', error); }
      this.push('open', {
        title: path.basename(cur.file),
        language: LANG,
        scrollTop: this.state.get('scrollStore')[cur.file] || 0,
        scrollAnchor: this.state.getScrollAnchor(cur.file),
        rootPath: '/render',
        content: cur.text,
        shortcuts: this.state.get('editorShortcuts') || {},
        theme: this.state.get('editorTheme'),
        palette: this.state.get('readingPalette') || 'theme',
        completion,
      }, event);
      return;
    }
    if (cur.frameId === null || event.frameId !== undefined && event.frameId !== cur.frameId) return;
    if(type.startsWith('completion-')) {
      await this.completionSession?.handlers.get(type)?.(content);return;
    }
    switch (type) {
      case 'media-command':{
        const id=content?.id;let cancelled=false;
        try{
          if(content.action==='copy-table'){
            if(typeof content.html!=='string'||content.html.length>5000000||typeof content.text!=='string')throw new Error('无效或过大的表格');
            if(process.platform==='win32')await windowsClipboard({action:'copy-table',html:content.html,text:content.text});
            else await clipboard.write([new ClipboardItem({'text/html':content.html,'text/plain':content.text})]);
          }else if(content.action==='copy-images'){
            // 一次把多张图放进剪贴板：主格式是文件拖放列表（微信/资源管理器/Chrome 系
            // 网页读的都是它）。没有磁盘路径的来源（内嵌 data:、http(s)、失效的相对引用）
            // 先取字节并落到图片缓存，拿到真实路径，保证每一张都能进 CF_HDROP。
            const items=Array.isArray(content.items)?content.items.slice(0,20):[];
            if(!items.length)throw new Error('没有选中图片');
            const files=[];
            for(const item of items){
              const source=typeof item==='string'?item:item?.src;
              if(typeof source!=='string'||!source)continue;
              let local=null;
              try{local=imageFile(source,cur.file,`http://127.0.0.1:${this.port}`);}catch{local=null;}
              if(local){
                try{const stat=await fsp.stat(local);if(stat.isFile()&&stat.size<=20*1024*1024){files.push(local);continue;}}catch{/* 落到字节路径 */}
              }
              const image=await imageBytes(cur.images.expand(source),cur.file);
              const ext=TYPES[image.mime];
              if(!ext)continue;
              const key=crypto.createHash('sha256').update(image.bytes).digest('hex')+'.'+ext;
              const target=path.join(cur.images.root,key);
              await fsp.mkdir(cur.images.root,{recursive:true});
              try{await fsp.writeFile(target,image.bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
              files.push(target);
            }
            if(!files.length)throw new Error('没有可放进剪贴板的图片文件');
            await windowsClipboard({action:'copy-images',files,composite:files.length>1});
          }else if(['copy-image','save-image'].includes(content.action)){
            const image=await imageBytes(cur.images.expand(content.src),cur.file);
            if(content.action==='copy-image'){
              // Word/Excel hang in SaveAs when the pasted image came from an
              // Electron-owned OLE clipboard object; the WinForms bridge writes
              // owner-free HGLOBAL data that every Office app saves cleanly.
              const bytes=image.mime==='image/png'?image.bytes:nativeImage.createFromBuffer(image.bytes).toPNG();
              if(!bytes||!bytes.length)throw new Error('此图片格式无法直接复制，请导出原图');
              await windowsClipboard({action:'copy-image',mime:'image/png',data:bytes.toString('base64')});
            }else{
              const ext=TYPES[image.mime],chosen=await dialog.showSaveDialog(this.win,{title:'导出原图',defaultPath:path.join(path.dirname(cur.file),path.basename(content.name||'图片')+'.'+ext),filters:[{name:'原始图片',extensions:[ext]}],properties:['showOverwriteConfirmation','createDirectory']});
              if(chosen.canceled)cancelled=true; // 用户取消不是成功也不是错误
              else if(chosen.filePath){if(path.resolve(chosen.filePath).toLowerCase()===cur.file.toLowerCase())throw new Error('不能覆盖 Markdown 原文件');await atomicWrite(chosen.filePath,image.bytes);}
            }
          }else throw new Error('不支持的图片或表格操作');
          if(this.current===cur)this.push('media-result',{id,ok:true,...(cancelled?{cancelled:true}:{})},event);
        }catch(error){if(this.current===cur)this.push('media-result',{id,error:error.message},event);}break;
      }
      case 'change':
        this.applyText(cur,typeof content === 'string' ? content : '');
        break;
      case 'shortcuts-set':
        if (content && ['math', 'quote', 'code'].every(key => typeof content[key] === 'string' && content[key].length <= 80)) {
          const shortcuts = {math: content.math, quote: content.quote, code: content.code, underline: typeof content.underline==='string'?content.underline:'Ctrl+U'};
          this.state.set('editorShortcuts', shortcuts);
          this.push('shortcuts-changed', shortcuts);
          this.onPreferenceChange?.('shortcuts', shortcuts);
        }
        break;
      case 'theme-set':
        // v2.0.6:补上 telari 主题——2.0.5 漏了允许列表,选拓然宋后 theme-set 被丢弃,
        // 每次开机都回退到旧主题。
        if (['light', 'dark', 'konayuki-light', 'konayuki-dark', 'telari-light', 'telari-dark'].includes(content)) {
          this.state.set('editorTheme',content);
          this.push('theme-changed',content);
          this.win.webContents.send('editor-theme',content);
          this.onPreferenceChange?.('theme',content);
        }
        break;
      case 'palette-set':
        if(['theme','beige','green'].includes(content)){
          this.state.set('readingPalette',content);
          this.push('palette-changed',content);
          this.onPreferenceChange?.('palette',content);
        }
        break;
      case 'img': {
        try {
          // K1（R9 E9-A 裁决）：{id,path} 变体来自渲染层的"粘贴时归档"拦截——剪贴板
          // CF_HTML 里的 file:/// 图（Word/Outlook msohtmlclip 临时路径）先读字节归档，
          // 拿到缓存 URL 再让 vditor 原生粘贴管线落图，存盘不再写临时路径引用。
          const image = typeof content==='string'?await saveImage(cur.file,content)
            : typeof content?.path==='string'?await this.insertClipboardImage(cur,content)
            : await cur.images.insert(content);
          if (this.current !== cur) break;
          if (image.id) this.push('image-result', {id:image.id,markdown:image.markdown},event);
          else this.push('insertValue',image.markdown,event);
        } catch (e) {
          if (this.current !== cur) break;
          if (content?.id) this.push('image-result',{id:content.id,error:e.message},event);
          else dialog.showMessageBoxSync(this.win, { type: 'error', message: '图片保存失败', detail: e.message });
        }
        break;
      }
      case 'openLink': this.openLink(content); break;
      case 'scroll':
        this.state.setScroll(cur.file, content && content.scrollTop);
        // 与像素值一起存锚点：含图片的文档重开时像素值不可靠，锚点才是可还原的坐标。
        if (content && content.anchor) this.state.setScrollAnchor(cur.file, content.anchor);
        break;
      case 'reload': {
        try {
          if(!(await this.confirmDiscard())||this.current!==cur)break;
          const {text:disk, encoding} = await this.readDiskText(cur.file);
          if(this.current!==cur)break;
          const view=await cur.images.mask(disk,{tolerant:true});if(this.current!==cur)break;
          const reloadWarnings=cur.images.consumeWarnings();
          if(reloadWarnings.length)dialog.showMessageBox(this.win,{type:'warning',message:'部分内嵌图片未加载',detail:reloadWarnings.slice(0,6).join('\n')});
          cur.text = view;
          cur.version++;
          cur.savedText = view;cur.savedDisk=disk;cur.encoding=encoding;Object.assign(cur,diskTraits(disk));
          cur.dirty = false;
          cur.externalConflict=false;cur.deleted=false;cur.saveError=null;this.cancelTimers();this.capture(cur,'reload');
          this.updateTitle();
          this.completionSession?.controller.notify();
          this.push('setValue', view);
          this.scheduleStats();
        } catch (error) {
          // 文件不存在属正常取消；其他失败必须反馈而不是静默吞掉
          if(error.code!=='ENOENT')dialog.showMessageBoxSync(this.win,{type:'error',message:'重新加载失败',detail:error.message});
        }
        break;
      }
      case 'editInVSCode':
        if (cur.file) shell.openPath(cur.file);
        break;
      default: break;
    }
  }

  openLink(uri) {
    if (!uri || typeof uri !== 'string') return;
    try {
      if (uri.startsWith('#')) return;
      if (RES_REG.test(uri)) {
        // 伪 webview 资源域 → 本地路径，交给系统默认程序
        shell.openPath(uri.replace(RES_REG, ''));
        return;
      }
      const u = new URL(uri, `http://127.0.0.1:${this.port}`);
      if (u.host === `127.0.0.1:${this.port}`) {
        if (u.pathname.startsWith('/ws/')) {
          const rest = u.pathname.slice('/ws/'.length);
          const slash = rest.indexOf('/');
          const baseDir = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
          const rel = slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
          let local = /^[A-Za-z]:[\\/]/.test(rel) ? rel : path.join(baseDir, rel);
          local = path.normalize(local);
          if (/\.(md|markdown|mdown|mkd)$/i.test(local)) {
            this.openFile(local);
          } else {
            shell.openPath(local);
          }
          return;
        }
        if (u.pathname.startsWith('/ws-file/')) {
          const local = path.normalize(decodeURIComponent(u.pathname.slice('/ws-file/'.length)));
          if (/\.(md|markdown|mdown|mkd)$/i.test(local)) this.openFile(local);
          else shell.openPath(local);
          return;
        }
      }
      if (/^https?:/i.test(uri)) {
        if (u.host === `127.0.0.1:${this.port}`) return;
        shell.openExternal(uri);
        return;
      }
      // 相对路径文本（IR 模式 marker 的 textContent）
      let p = uri;
      if (/^[A-Za-z]:[\\/]/.test(p)) {
        p = path.normalize(p);
      } else {
        p = path.normalize(path.join(path.dirname(this.current.file), p));
      }
      if (fs.existsSync(p)) {
        if (/\.(md|markdown|mdown|mkd)$/i.test(p)) this.openFile(p);
        else shell.openPath(p);
      }
    } catch (e) {
      console.error('openLink failed:', uri, e.message);
    }
  }

  // ---- 主进程 → renderer ----
  push(type, content, optEvent) {
    const payload = { type, content };
    const wc = this.win.webContents;
    const frameId = optEvent ? optEvent.frameId : (this.current && this.current.frameId);
    if (frameId !== null && frameId !== undefined && typeof wc.sendToFrame === 'function') {
      try { wc.sendToFrame(frameId, 'ed-push', payload); return; } catch { /* 落到中继 */ }
    }
    wc.send('ed-relay', payload); // 外壳转发进 iframe（同源 contentWindow.postMessage）
  }

  // ---- 字符统计（Typora 规则：中文逐字、英文按词）----
  /** 立即推一次当前文档统计（含保存横幅状态）。MW6：doc-load 时同步调用，
   *  其余高频路径（每键 change）仍走 scheduleStats 的 400ms 去抖。 */
  pushStats() {
    if(this._disposed||this.win.isDestroyed?.())return;
    const text = this.current ? this.current.text : '';
    if(this._statsCache.text!==text)this._statsCache={text,stats:computeStats(text)};
    this.win.webContents.send('shell-push', { type: 'doc-stats', payload: { ...this._statsCache.stats, dirty: this.dirty, file: this.file,saveError:this.current?.saveError,snapshotError:this.current?.snapshotError } });
  }
  scheduleStats() {
    clearTimeout(this._statsTimer);
    this._statsTimer = setTimeout(() => this.pushStats(), 400);
  }

  // 文件树操作波及当前文档时的联动
  onFileRenamed(oldPath, newPath) {
    if (!this.current) return;
    const relative = path.relative(oldPath, this.file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    this.current.file = path.join(newPath, relative);
    this.cancelTimers();this.current.deleted=false;this.current.externalConflict=false;this.current.saveError=null;this.capture(this.current,'rename',this.current.savedText);this.scheduleProtection();
    this.state.set('lastFile', this.file);
    this.updateTitle();
    this.watchFile();
    this.onFileChange?.();
    this.loadInShell();
  }

  onFileDeleted(target) {
    if (!this.current) return;
    const relative=path.relative(target,this.current.file);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return;
    this.current.dirty = true;
    this.current.deleted=true;this.cancelTimers();this.scheduleProtection();
    this.closeWatch();
    this.updateTitle();
  }
}

module.exports = { DocController };
