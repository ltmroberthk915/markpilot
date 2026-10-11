"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const markdownEditorProvider_1 = require("./provider/markdownEditorProvider");
const {OutlineView} = require("./common/outline-view.cjs");
function activate(context) {
    console.log("init MarkPilot success");
    migrateLegacyStorage(context);
    const outline = new OutlineView(context);
    context.subscriptions.push(
    vscode.window.registerCustomEditorProvider("markpilot.editor", new markdownEditorProvider_1.MarkdownEditorProvider(context, outline), {
        webviewOptions: {
            retainContextWhenHidden: true, // 保留隐藏的Webview上下文
        },
    }));
    // v2.1.0：显式「在新标签页里用 MarkPilot 打开」。
    // 先前的现场问题是：VS Code 默认开「预览标签」，在资源管理器里单击文件会用同一
    // 个标签顶掉上一个，用户看到的就是「只能开一份稿子」。扩展这边能做的两件事：
    //   1) 用 contributes.configurationDefaults 把 enablePreview 的**默认值**改成关
    //      （用户自己设过就尊重用户）；
    //   2) 给一个显式命令，preview:false 强制钉住标签页，任何设置组合下都成立。
    context.subscriptions.push(
    vscode.commands.registerCommand("markpilot.openInNewTab", async (resource) => {
        const target = resource && resource.fsPath ? resource : vscode.window.activeTextEditor?.document.uri;
        if (!target || !target.fsPath) {
            vscode.window.showInformationMessage("请先在资源管理器里选中一个 Markdown 文件。");
            return;
        }
        await vscode.commands.executeCommand("vscode.openWith", target, "markpilot.editor", {
            viewColumn: vscode.ViewColumn.Active,
            preview: false,
        });
    }));
}
exports.activate = activate;
// This method is called when your extension is deactivated
// v2.0.8 rebrand marcopilot.marcopilot -> markpilot.markpilot: embedded
// images live in the old extension's globalStorage. Copy them once so
// documents created before the rebrand keep resolving their images.
function migrateLegacyStorage(context) {
    try {
        const fs = require("node:fs");
        const path = require("node:path");
        const root = context.globalStorageUri.fsPath;
        if (fs.existsSync(root)) return;
        const legacyImages = path.join(path.dirname(root), "marcopilot.marcopilot", "embedded-images");
        if (!fs.existsSync(legacyImages)) return;
        fs.mkdirSync(path.dirname(root), { recursive: true });
        fs.cpSync(legacyImages, path.join(root, "embedded-images"), { recursive: true });
    } catch { /* any surprise: start with a fresh storage dir */ }
}
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map
