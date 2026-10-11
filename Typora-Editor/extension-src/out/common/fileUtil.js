"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkspacePath = exports.adjustImgPath = exports.wrieteFile = exports.buildPath = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const vscode = require("vscode");
function buildPath(data, webview, contextPath) {
    return data.replace(/((src|href)=("|')?)(\/\/)/gi, "$1http://")
        .replace(/((src|href)=("|'))((?!(http|#)).+?["'])/gi, "$1" + webview.asWebviewUri(vscode.Uri.file(`${contextPath}`)) + "/$4");
}
exports.buildPath = buildPath;
function wrieteFile(path, buffer) {
    const dir = (0, path_1.dirname)(path);
    if (!(0, fs_1.existsSync)(dir)) {
        (0, fs_1.mkdirSync)(dir, { recursive: true });
    }
    vscode.workspace.fs.writeFile(vscode.Uri.file(path), buffer);
}
exports.wrieteFile = wrieteFile;
function adjustImgPath(uri, withworkspace = false) {
    let imgPath = "images/${fileName}/${now}.png"
        .replace("${fileName}", (0, path_1.parse)(uri.fsPath).name.replace(/\s/g, ''))
        .replace("${now}", new Date().getTime() + "");
    return {
        relPath: imgPath.replace(/\$\{workspaceDir\}\/?/, ''),
        fullPath: imgPath.replace("${workspaceDir}", getWorkspacePath(uri))
    };
}
exports.adjustImgPath = adjustImgPath;
/**
 * 根据uri获取其工作空间路径
 * @param uri
 * @returns
 */
function getWorkspacePath(uri) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return '';
    }
    let workspacePath = folders[0]?.uri?.fsPath;
    if (folders.length > 1) {
        for (const folder of folders) {
            if (uri.fsPath.includes(folder.uri.fsPath)) {
                return folder.uri.fsPath;
            }
        }
    }
    return workspacePath;
}
exports.getWorkspacePath = getWorkspacePath;
//# sourceMappingURL=fileUtil.js.map