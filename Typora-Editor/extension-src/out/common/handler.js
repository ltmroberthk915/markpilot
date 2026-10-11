"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Hanlder = void 0;
const events_1 = require("events");
const vscode = require("vscode");
class Hanlder {
    constructor(panel, eventEmitter) {
        this.panel = panel;
        this.eventEmitter = eventEmitter;
    }
    on(event, callback) {
        if (event !== 'init') {
            const listens = this.eventEmitter.listeners(event);
            if (listens.length >= 1) {
                this.eventEmitter.removeListener(event, listens[0]);
            }
        }
        this.eventEmitter.on(event, async (content) => {
            try {
                await callback(content);
            }
            catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        });
        return this;
    }
    emit(event, content) {
        this.panel.webview.postMessage({ type: event, content });
        return this;
    }
    static bind(panel, uri) {
        const eventEmitter = new events_1.EventEmitter();
        const fileWatcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
        fileWatcher.onDidChange(e => {
            eventEmitter.emit("fileChange", e);
        });
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === uri.toString() && e.contentChanges.length > 0) {
                eventEmitter.emit("externalUpdate", e);
            }
        });
        panel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            eventEmitter.emit("dispose");
        });
        // bind from webview
        panel.webview.onDidReceiveMessage((message) => {
            eventEmitter.emit(message.type, message.content);
        });
        return new Hanlder(panel, eventEmitter);
    }
}
exports.Hanlder = Hanlder;
//# sourceMappingURL=handler.js.map