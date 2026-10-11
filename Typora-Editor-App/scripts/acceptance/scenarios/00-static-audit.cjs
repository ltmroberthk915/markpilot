/** 静态审计：产物哈希链、版本一致性、路径卫生、打包配置。
 *
 *  这一条不需要 GUI，但它是"假通过"的第一道闸门：前两条用户报的故障都栽在
 *  "被测对象不是交付产物"上——
 *    · 用户装的 app.asar 里的 renderer 必须与开发树（= extension-src 源）逐字节相同，
 *      否则"我在开发树上验过了"毫无意义；
 *    · 交给外部进程的脚本必须真的能在产物里找到（app.asar 是虚拟文件系统，
 *      PowerShell 打不开它）；
 *    · 版本三方一致（产物 / 应用仓 / 扩展仓）。
 */
'use strict';
const harness = require('../harness.cjs');

module.exports = {
  id: '00-static-audit',
  title: '产物静态审计（哈希链 / 版本 / 路径卫生）',
  packagedOnly: true,
  async run(ctx) {
    const audit = harness.auditArtifact({ exe: ctx.app.exe });
    for (const check of audit.checks) ctx.assert(check.name, check.pass, check.detail);
    ctx.witness('产物指纹', { asar: audit.asarPath, packagedVersion: audit.packagedVersion, appVersion: audit.appVersion, extensionVersion: audit.extensionVersion });
    ctx.log(`审计对象：${audit.asarPath}（版本 ${audit.packagedVersion}）`);
  },
};
