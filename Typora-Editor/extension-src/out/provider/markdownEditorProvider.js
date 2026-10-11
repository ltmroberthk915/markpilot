"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownEditorProvider = void 0;
const fs_1 = require("fs");
const crypto = require("crypto");
const { fileURLToPath } = require("url");
const path = require("path");
const vscode = require("vscode");
const handler_1 = require("../common/handler");
const fileUtil_1 = require("../common/fileUtil");
const path_1 = require("path");
const {saveImage} = require('../../render/js/image-assets.cjs');
const {PortableImages}=require('../../render/js/portable-images.cjs');
const {imageBytes,windowsClipboard,TYPES}=require('../../render/js/media-host.cjs');
const {CompletionManager} = require('../completion/host.cjs');
// One summary per operation; opening a document never fails because of a
// single bad embedded image (bad ones keep their original source text).
const showImageWarnings = (images) => {
    const warns = images.consumeWarnings();
    if (warns.length)
        vscode.window.showWarningMessage('内嵌图片：' + warns.slice(0, 3).join('；'));
};
const buildPath = (data, webview, contextPath) => {
    return data
        .replace(/((src|href)=("|')?)(\/\/)/gi, "$1http://")
        .replace(/((src|href)=("|'))((?!(http|#)).+?["'])/gi, "$1" + webview.asWebviewUri(vscode.Uri.file(`${contextPath}`)) + "/$4");
};
class MarkdownEditorProvider {
    constructor(ctx, outline) {
        this.ctx = ctx;
        this.text = {};
        this.context = ctx;
        this.state = ctx.globalState;
        this.panels = new Set();
        this.documents=new WeakMap();
        this.outline = outline;
        this.completions = new CompletionManager(ctx);
        this.nativeChat = new (require('../common/native-chat.cjs').NativeChat)(ctx);
        // 文档关闭时清掉它名下的滚动恢复键（scrollTop_ / scrollAnchor_）：globalState
        // 不清理的话，每打开过一个 .md 就永久留下两把键，只增不减（第 5 轮 B3）。
        ctx.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
            for (const key of [`scrollTop_${doc.uri.fsPath}`, `scrollAnchor_${doc.uri.fsPath}`]) {
                if (this.state.get(key) !== undefined) this.state.update(key, undefined);
            }
        }));
    }
    getFolders() {
        const data = [];
        for (var i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`));
        }
        return data;
    }
    resolveCustomTextEditor(document, webviewPanel, token) {
        const webview = webviewPanel.webview;
        let stored=this.documents.get(document);
        if(!stored){
            const images=new PortableImages({root:path.join(this.context.globalStorageUri.fsPath,'embedded-images'),urlFor:file=>webview.asWebviewUri(vscode.Uri.file(file)).toString()});
            let text=document.getText();
            try{text=images.maskSync(text,{tolerant:true});}
            catch(error){vscode.window.showWarningMessage('内嵌图片加载失败，已按原文本打开：'+error.message);}
            showImageWarnings(images);
            stored={images,version:document.version,text};this.documents.set(document,stored);
        }
        const compact=()=>{if(stored.version!==document.version){try{stored.text=stored.images.maskSync(document.getText(),{tolerant:true});}catch{stored.text=document.getText();}stored.version=document.version;}return stored.text;};
        // A plain facade, not a Proxy: current VS Code builds expose
        // TextDocument.getText as a frozen data property, and a Proxy get
        // trap returning a different function violates the invariant and
        // throws during activation. Data members stay live getters; range
        // methods delegate to the real native-position document.
        const sourceDocument={
            uri:document.uri,
            get version(){return document.version;},
            getText:range=>range?document.getText(range):compact(),
            toNativePosition:found=>{const text=compact();let offset=0;for(let line=0;line<found.line;line++)offset=text.indexOf('\n',offset)+1;return document.positionAt(stored.images.rawOffset(text,offset+found.character));},
            get fileName(){return document.fileName;},
            get languageId(){return document.languageId;},
            get eol(){return document.eol;},
            get lineCount(){return document.lineCount;},
            get isDirty(){return document.isDirty;},
            get isClosed(){return document.isClosed;},
            get isUntitled(){return document.isUntitled;},
            positionAt:offset=>document.positionAt(offset),
            offsetAt:position=>document.offsetAt(position),
            lineAt:line=>document.lineAt(line),
            range:(...args)=>document.range(...args),
            getWordRangeAtPosition:(...args)=>document.getWordRangeAtPosition(...args),
            validateRange:range=>document.validateRange(range),
            validatePosition:position=>document.validatePosition(position),
            save:()=>document.save(),
        };
        this.panels.add(webviewPanel);
        const folderPath = vscode.Uri.joinPath(document.uri, "..");
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()],
        };
        this.text[document.uri.fsPath] = compact();
        const contextPath = `${this.context.extensionPath}/render`;
        const rootPath = webview
            .asWebviewUri(vscode.Uri.file(`${contextPath}`))
            .toString();
        const basePath = folderPath;
        const baseUrl = webview
            .asWebviewUri(basePath)
            .toString()
            .replace(/\?.+$/, "")
            .replace("https://git", "https://file");
        webview.html = buildPath((0, fs_1.readFileSync)(`${this.context.extensionPath}/render/index.html`, "utf8")
            .replace("{{rootPath}}", rootPath)
            .replace("{{baseUrl}}", baseUrl), webview, contextPath);
        const handler = handler_1.Hanlder.bind(webviewPanel, document.uri);
        require('../common/office-export.cjs').bindOfficeExport({provider:this,document,panel:webviewPanel,handler,rootPath});
        const completion = this.completions.bind(sourceDocument, webviewPanel, handler, content => this.updateTextDocument(document, content));
        this.nativeChat.bind({document,panel:webviewPanel,handler,compact,images:stored.images,synchronized:completion.synchronized});
        if (this.outline) this.outline.bind(webviewPanel, document, handler, () => compact().replace(/\u0000/g, ''));
        // 隐藏的 webview 不保证收到推送，所以记住最后推过去的正文，
        // 重新可见时按宿主权威文本对齐（见下方 onDidChangeViewState）。
        let pushedText = null;
        const pushSetValue = value => { pushedText = value; handler.emit("setValue", value); };
        handler.on("init", async () => {
            await stored.images.flush();
            const scrollTop = this.state.get(`scrollTop_${document.uri.fsPath}`, 0);
            // 渲染层 util.js 的 scrollEditor(top, anchor) 优先按锚点还原：含图片的文档
            // 重开时像素值不可靠（图片未占位内容偏矮），锚点才是可还原的坐标。
            // 之前 VSIX 只存/回像素值，锚点字段整条链路缺失（第 5 轮 B3）。
            const scrollAnchor = this.state.get(`scrollAnchor_${document.uri.fsPath}`) || null;
            handler.emit("open", {
                title: (0, path_1.basename)(document.uri.fsPath),
                language: vscode.env.language,
                scrollTop,
                scrollAnchor,
                rootPath,
                content: compact(),
                shortcuts: this.state.get('editorShortcuts', {}),
                theme: this.state.get('editorTheme'),
                palette: this.state.get('readingPalette','theme'),
                completion: completion.boot(),
                nativeChat:true,
            });
            pushedText = compact();
        });
        handler.on("change", (content) => {
            this.updateTextDocument(document, content);
        });
        handler.on('shortcuts-set', async (value) => {
            if (!value || !['math', 'quote', 'code'].every(key => typeof value[key] === 'string' && value[key].length <= 80)) return;
            const shortcuts = {math: value.math, quote: value.quote, code: value.code,underline:typeof value.underline==='string'?value.underline:'Ctrl+U'};
            await this.state.update('editorShortcuts', shortcuts);
            for (const panel of this.panels) panel.webview.postMessage({type: 'shortcuts-changed', content: shortcuts});
        });
        handler.on('theme-set', async (value) => {
            // v2.0.6:telari 主题补进允许列表(与桌面 doc.js 同步修复:漏掉导致选拓然宋不持久)。
            if (!['light', 'dark', 'konayuki-light', 'konayuki-dark', 'telari-light', 'telari-dark'].includes(value)) return;
            await this.state.update('editorTheme',value);
            for (const panel of this.panels) panel.webview.postMessage({type:'theme-changed',content:value});
        });
        handler.on('palette-set', async (value) => {
            if(!['theme','beige','green'].includes(value))return;
            await this.state.update('readingPalette',value);
            for(const panel of this.panels)panel.webview.postMessage({type:'palette-changed',content:value});
        });
        // 监听文件变化自动更新
        const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if(doc.uri.fsPath!==document.uri.fsPath)return;
            const val = compact();await stored.images.flush();
            if (doc.uri.fsPath === document.uri.fsPath &&
                this.text[document.uri.fsPath] !== val) {
                this.text[document.uri.fsPath] = val;
                pushSetValue(val);
                completion.notify();
            }
        });
        webviewPanel.onDidDispose(() => {
            this.panels.delete(webviewPanel);
            saveListener.dispose();
        });
        // 标签页切回来时对齐一次内容：隐藏期间宿主推的 setValue 不保证送达（VS Code
        // 只保证可见 webview 的投递），不对齐的话切回来的标签会显示陈旧内容。内容
        // 一致就什么都不做——无谓的 setValue 会冲掉撤销历史与光标。
        webviewPanel.onDidChangeViewState(() => {
            if (!webviewPanel.visible) return;
            const current = compact();
            if (current === pushedText) return;
            pushSetValue(current);
        });
        this.handleEvent(document, handler);
    }
    handleEvent(document, handler) {
        handler.on('media-command',async value=>{
            let cancelled=false;
            try{
                if(value.action==='copy-table'){
                    if(typeof value.html!=='string'||value.html.length>5000000||typeof value.text!=='string')throw new Error('无效或过大的表格');
                    // 非 Windows 没有 PowerShell 剪贴板桥，退化为纯文本 TSV：
                    // vscode.env.clipboard 是扩展宿主自带 API，mac/linux 都可用（第 5 轮 B6）。
                    if(process.platform==='win32')await windowsClipboard(value);
                    else await vscode.env.clipboard.writeText(value.text);
                }else if(value.action==='copy-images'){
                    // 一次把多张图放进剪贴板：主格式是文件拖放列表 CF_HDROP（微信/资源
                    // 管理器/Chrome 系网页读的都是它）。没有磁盘路径的来源（内嵌 data:、
                    // http(s)、失效的相对引用）先取字节落到内嵌图片缓存，拿到真实路径，
                    // 保证每一张都能进文件列表——与桌面 doc.js 的 copy-images 同一语义
                    // （第 5 轮 B1：此前 VSIX 无此分支，右键/ Ctrl+C 复制图片必报
                    // “不支持的图片或表格操作”）。
                    const items=Array.isArray(value.items)?value.items.slice(0,20):[];
                    if(!items.length)throw new Error('没有选中图片');
                    const stored=this.documents.get(document);
                    if(!stored)throw new Error('文档已关闭');
                    const files=[];
                    for(const item of items){
                        const source=typeof item==='string'?item:item?.src;
                        if(typeof source!=='string'||!source)continue;
                        const image=await imageBytes(stored.images.expand(source),document.uri.fsPath);
                        const ext=TYPES[image.mime];
                        if(!ext)continue;
                        const key=crypto.createHash('sha256').update(image.bytes).digest('hex')+'.'+ext;
                        const target=path.join(stored.images.root,key);
                        await fs_1.promises.mkdir(stored.images.root,{recursive:true});
                        try{await fs_1.promises.writeFile(target,image.bytes,{flag:'wx'});}
                        catch(error){if(error.code!=='EEXIST')throw error;}
                        files.push(target);
                    }
                    if(!files.length)throw new Error('没有可放进剪贴板的图片文件');
                    await windowsClipboard({action:'copy-images',files,composite:files.length>1});
                }else if(['copy-image','save-image'].includes(value.action)){
                    const image=await imageBytes(this.documents.get(document).images.expand(value.src),document.uri.fsPath);
                    if(value.action==='copy-image')await windowsClipboard({action:value.action,data:image.bytes.toString('base64'),mime:image.mime});
                    else{
                        const ext=TYPES[image.mime],target=await vscode.window.showSaveDialog({title:'导出原图',defaultUri:vscode.Uri.file(path.join(path.dirname(document.uri.fsPath),path.basename(value.name||'图片')+'.'+ext)),filters:{'原始图片':[ext]}});
                        if(!target)cancelled=true; // 用户取消不是成功也不是错误
                        else{if(target.fsPath.toLowerCase()===document.uri.fsPath.toLowerCase())throw new Error('不能覆盖 Markdown 原文件');await vscode.workspace.fs.writeFile(target,image.bytes);}
                    }
                }else throw new Error('不支持的图片或表格操作');
                handler.emit('media-result',{id:value.id,ok:true,...(cancelled?{cancelled:true}:{})});
            }catch(error){handler.emit('media-result',{id:value.id,error:error.message});}
        });
        handler
            .on("openLink", async (uri) => {
            if (typeof uri !== 'string' || !uri || uri.startsWith('#')) return;
            // 三类“本地文件”来源（第 5 轮 B5：此前只认 webview 资源域一条，Ctrl+点
            // 相对链接全失效）：
            //   1. webview 资源域绝对地址——<base href> 把文档相对链接解析成了
            //      vscode-cdn 的 URL，路径段就是本地盘符路径（百分号编码）；
            //   2. file: URL；
            //   3. 相对/绝对本地路径文本——IR 模式 marker 的 textContent 原样发出。
            const webviewFile = uri.match(/^https:\/\/file[^/]*\.vscode-cdn\.net\/([^?#]*)/i);
            let local = null;
            if (webviewFile) {
                try { local = decodeURIComponent(webviewFile[1]); } catch { local = webviewFile[1]; }
                if (process.platform !== 'win32' && !/^[a-z]:/i.test(local)) local = '/' + local;
            }
            else if (/^file:/i.test(uri)) {
                try { local = fileURLToPath(uri); } catch { local = null; }
            }
            else if (!/^[a-z][a-z\d+.-]*:/i.test(uri) && !uri.startsWith('//')) {
                local = /^[a-z]:[\\/]/i.test(uri) ? path.normalize(uri)
                    : path.normalize(path.join(path.dirname(document.uri.fsPath), uri));
            }
            if (local) {
                if (/\.(md|markdown|mdown|mkd)$/i.test(local)) {
                    // MarkPilot 是 .md 的默认编辑器，vscode.open 等价桌面版的 openFile。
                    if (fs_1.existsSync(local)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local));
                    else await vscode.window.showWarningMessage('链接目标不存在：' + local);
                    return;
                }
                try { if (await vscode.env.openExternal(vscode.Uri.file(local))) return; }
                catch { /* openExternal 拒绝 file: 时退回 VS Code 内置预览 */ }
                try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local)); } catch { /* 目标打不开就保持沉默 */ }
                return;
            }
            try { await vscode.env.openExternal(vscode.Uri.parse(uri)); } catch { /* 无效链接：与桌面版一致静默 */ }
        })
            .on("img", async (img) => {
            try {
                const image = typeof img==='string'?await saveImage(document.uri.fsPath,img):await this.documents.get(document).images.insert(img);
                handler.emit(image.id ? 'image-result' : 'insertValue',image.id ? {id:image.id,markdown:image.markdown} : image.markdown);
            } catch(error) {
                if(img?.id) handler.emit('image-result',{id:img.id,error:error.message});
                else vscode.window.showErrorMessage('图片保存失败：'+error.message);
            }
        })
            .on("scroll", (value) => {
            // 与桌面 doc.js 的 setScroll/setScrollAnchor 同一语义（第 5 轮 B3）：像素
            // 值与锚点双字段一起存；锚点记“顶部块序号 + 块内偏移 + 块开头文本”，含图
            // 文档重开时渲染层按锚点还原并在图片占位后重贴。
            if (typeof value?.scrollTop === 'number' && isFinite(value.scrollTop))
                this.state.update(`scrollTop_${document.uri.fsPath}`, value.scrollTop);
            const anchor = value?.anchor;
            if (anchor && typeof anchor === 'object') {
                const index = Number(anchor.index), delta = Number(anchor.delta);
                if (isFinite(index) && isFinite(delta)) {
                    this.state.update(`scrollAnchor_${document.uri.fsPath}`, {
                        index: Math.max(0, Math.round(index)),
                        delta: Math.round(delta),
                        head: typeof anchor.head === 'string' ? anchor.head.slice(0, 60) : '',
                        total: Number(anchor.total) || 0,
                    });
                }
            }
        })
            .on("editInVSCode", (full) => {
            vscode.commands.executeCommand("vscode.openWith", document.uri, "default", vscode.ViewColumn.Active);
        })
            .on("reload", async () => {
                const stored=this.documents.get(document);
                try{const text=await stored.images.mask(document.getText(),{tolerant:true});stored.text=text;stored.version=document.version;showImageWarnings(stored.images);pushSetValue(text);}
                catch(error){vscode.window.showErrorMessage('重新加载失败：'+error.message);}
        })
        // webview 侧 hostApi 兼容层的宿主端（第 5 轮 B2）：渲染层共享代码用
        // window.hostApi.invoke(cmd,args) 调宿主能力（读剪贴板、写纯文本、开外链、
        // 取版本号）。桌面版由 preload 直连主进程；VSIX 由 render/js/vscode.js 的
        // shim 把它翻译成 host-invoke 消息，这里应答 host-result。
        .on("host-invoke", async (request) => {
            if (!request || typeof request.id !== 'string') return;
            let result, error;
            try {
                const cmd = request.cmd, args = request.args;
                if (cmd === 'clipboard-read-text') result = await vscode.env.clipboard.readText();
                else if (cmd === 'clipboard-write-text') {
                    await vscode.env.clipboard.writeText(typeof args?.text === 'string' ? args.text : String(args?.text ?? ''));
                    result = true;
                }
                else if (cmd === 'open-external') {
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(String(args?.url || '')));
                    if (!opened) throw new Error('系统未受理该链接');
                    result = true;
                }
                else if (cmd === 'app-info') {
                    const pkg = this.context.extension.packageJSON || {};
                    result = { name: pkg.name || 'MarkPilot', version: pkg.version, channel: 'VS Code 扩展' };
                }
                else throw new Error('宿主不支持该命令：' + cmd);
            }
            catch (e) { error = e.message; }
            handler.emit('host-result', { id: request.id, ...(error !== undefined ? { error } : { result }) });
        });
    }
    async updateTextDocument(document, content) {
        const stored=this.documents.get(document);
        let before=content;
        if(stored){try{before=stored.version===document.version?stored.text:stored.images.maskSync(document.getText(),{tolerant:true});}catch{before=document.getText();}}
        else before=document.getText();
        if (content === before) { this.text[document.uri.fsPath] = content;return true; }
        const edit = new vscode.WorkspaceEdit();
        if(stored){const change=stored.images.diff(before,content);edit.replace(document.uri,new vscode.Range(document.positionAt(change.start),document.positionAt(change.end)),change.text);}
        else edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);
        const ok=await vscode.workspace.applyEdit(edit);
        if(ok){this.text[document.uri.fsPath]=content;if(stored){stored.text=content;stored.version=document.version;}}
        return ok;
    }
}
exports.MarkdownEditorProvider = MarkdownEditorProvider;
//# sourceMappingURL=markdownEditorProvider.js.map
