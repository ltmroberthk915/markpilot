'use strict';
// Record the Worker and shared image parser alongside the editor and save owner.
// 【live 协同·2026-11-03】新增 shell/live-documents.js：跨进程共享房间权威（join/exchange/
// save/external/leave），asar 内随 shell/ 整目录打包，此处补进身份清单，使 artifact.json
// 记录其 sha256（freeze/integrity）。旧 baseline app（无该模块）经两个消费者的既有约定
// 落为 sha256:null——不报错、缺失明确可见（stage-app.cjs 的 existsSync?:null 映射与
// lifecycle.cjs 的在机读回同口径）。
module.exports = ['main.js','preload.js','renderer/host.js','shell/document-store.js','shell/live-documents.js','shell/text-codec.js','shell/save-policy.js','shell/appearance-store.js','shell/font-preferences.cjs','shell/data-images.cjs','shell/safe-file.js','shell/native/file-worker.exe','renderer/cm6/app.js','renderer/cm6/markdown-worker.js','export-folder.js','shell/markdown-images.js','shell/save-as-assets.js','export-pdf.js','shell/pdf-process.js','shell/pdf-worker.js','shell/native/pdf-worker-guard.exe','shell/native-worker-lease.js','shell/clipboard-service.js'];
