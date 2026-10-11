/** 四方哈希链校验（铁律 11 的判"通过"最小集），不打包、不安装、不发布。
 *
 *  用法：node scripts/verify-chain.cjs <release目录> <VSIX路径> [报告目录]
 *    node scripts/verify-chain.cjs dist/release-2.2.0-private dist/release-2.2.0-private/markpilot-2.2.0.vsix .perf/release100-verify-2.2.0
 *
 *  为什么另写一个（而不是直接用 scripts/verify-release100-private.cjs）：那个脚本是**1.0.x 交付线**
 *  的闸门，断言的是那条线的产物形状（`publisher = markpilot`、`markpilotDistribution` 标记、
 *  `app/shared/out/completion` 共享路径、`.perf/viewflow-delivery/public-before.json`），
 *  而当前私有线（2.1.x→2.2.0）的 VSIX 里 `publisher = jinxi`、没有那个标记、也没有那些共享路径
 *  ——2.1.29 与 2.2.0 两个 VSIX 逐项一致，所以它对本线**恒不可用**（不是本轮产物的问题）。
 *  本脚本只做铁律 11 写明的那四件事 + 清单版本，逐项打印，缺一即失败：
 *    ① extension-src/render == app/renderer
 *    ② app/renderer == 已打包 app.asar 里的 app/renderer
 *    ③ extension-src/render == VSIX 内 extension/render
 *    ④ 两仓 package.json 版本一致，且 vsixmanifest 的 Identity Version 与之相同
 *  附：把每个文件的 sha256 清单写进报告，供复盘比对。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const {pathToFileURL} = require('node:url');

const project = path.resolve(__dirname, '..');
const extension = path.resolve(project, '../Typora-Editor/extension-src');
const release = path.resolve(process.argv[2] || path.join(project, 'dist/release-2.2.0-private'));
const vsix = path.resolve(process.argv[3] || path.join(project, 'dist/release-2.2.0-private/markpilot-2.2.0.vsix'));
const output = path.resolve(process.argv[4] || path.join(project, '.perf/release100-verify'));
fs.mkdirSync(output, {recursive: true});

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const names = root => fs.readdirSync(root, {withFileTypes: true})
  .flatMap(entry => entry.isDirectory() ? names(path.join(root, entry.name)).map(name => entry.name + '/' + name) : [entry.name])
  .sort();
const read = (...parts) => fs.readFileSync(path.join(...parts));
const rows = [];
const check = (label, ok, detail) => {
  rows.push({label, pass: !!ok, detail});
  console.log((ok ? 'PASS  ' : '✗FAIL ') + label + (ok ? (detail ? '  （' + detail + '）' : '') : '  → ' + detail));
  return ok;
};

(async () => {
  const appSource = path.join(project, 'app/renderer');
  const extRender = path.join(extension, 'render');
  const archive = path.join(release, 'win-unpacked/resources/app.asar');

  check('交付目录里有 app.asar（打包产物）', fs.existsSync(archive), archive);
  check('交付目录里有 VSIX', fs.existsSync(vsix), vsix);
  if (!fs.existsSync(archive) || !fs.existsSync(vsix)) { process.exitCode = 1; return; }

  // ── 版本一致性 ─────────────────────────────────────────────────────────────
  const versionApp = JSON.parse(read(project, 'package.json')).version;
  const versionExt = JSON.parse(read(extension, 'package.json')).version;
  check('两仓 package.json 版本一致', versionApp === versionExt, `App ${versionApp} / 扩展 ${versionExt}`);

  const {unzipSync} = await import(pathToFileURL(path.join(extRender, 'js/vendor/fflate.mjs')).href);
  const zip = unzipSync(read(vsix));
  const inZip = name => zip[name] && Buffer.from(zip[name]);
  const versionVsix = JSON.parse(inZip('extension/package.json').toString('utf8')).version;
  check('VSIX 内 package.json 版本一致', versionVsix === versionApp, `VSIX ${versionVsix} / App ${versionApp}`);
  const manifest = inZip('extension.vsixmanifest').toString('utf8');
  check('vsixmanifest 的 Identity Version 一致',
    new RegExp('<Identity\\b[^>]*\\bVersion="' + versionApp.replace(/[.\\]/g, '\\$&') + '"').test(manifest),
    (manifest.match(/<Identity[^>]*>/) || [''])[0].slice(0, 120));

  // ── 四方逐字节一致 ─────────────────────────────────────────────────────────
  const sourceList = names(extRender);
  const desktopList = names(appSource);
  check('① extension-src/render 与 app/renderer 文件清单一致',
    JSON.stringify(sourceList) === JSON.stringify(desktopList),
    `扩展 ${sourceList.length} 个 / 桌面 ${desktopList.length} 个`);

  const zipRender = Object.keys(zip).filter(name => name.startsWith('extension/render/') && !name.endsWith('/'))
    .map(name => name.slice('extension/render/'.length)).sort();
  check('③ VSIX 内 extension/render 文件清单一致',
    JSON.stringify(zipRender) === JSON.stringify(sourceList),
    `VSIX ${zipRender.length} 个 / 扩展 ${sourceList.length} 个`);

  const mismatches = {'1': [], '2': [], '3': []};
  const files = [];
  for (const name of sourceList) {
    const expected = sha(read(extRender, name));
    const desktop = fs.existsSync(path.join(appSource, name)) ? sha(read(appSource, name)) : '(缺)';
    if (desktop !== expected) mismatches['1'].push(name);
    let packed = '(缺)';
    try { packed = sha(asar.extractFile(archive, path.join('app/renderer', name))); } catch { /* 缺失 */ }
    if (packed !== expected) mismatches['2'].push(name);
    const inside = inZip('extension/render/' + name);
    const inZipHash = inside ? sha(inside) : '(缺)';
    if (inZipHash !== expected) mismatches['3'].push(name);
    files.push({path: name, sha256: expected});
  }
  check('① extension-src/render == app/renderer', mismatches['1'].length === 0,
    mismatches['1'].slice(0, 5).join(' ') || `${sourceList.length} 个文件逐字节相同`);
  check('② app/renderer == 打包 app.asar 内的 app/renderer', mismatches['2'].length === 0,
    mismatches['2'].slice(0, 5).join(' ') || `${sourceList.length} 个文件逐字节相同`);
  check('③ extension-src/render == VSIX 内 extension/render', mismatches['3'].length === 0,
    mismatches['3'].slice(0, 5).join(' ') || `${sourceList.length} 个文件逐字节相同`);

  // ── 主进程侧也照一下（渲染侧一致但主进程没进包，最坏情况会发出去一个错版本）──────
  const appFiles = names(path.join(project, 'app')).filter(name => !name.startsWith('renderer/'));
  const appBad = [];
  for (const name of appFiles) {
    try { if (sha(asar.extractFile(archive, path.join('app', name))) !== sha(read(project, 'app', name))) appBad.push(name); }
    catch { appBad.push(name + '(缺)'); }
  }
  check('④ 打包 asar 内的主进程/外壳源码 == 开发树 app/', appBad.length === 0,
    appBad.slice(0, 5).join(' ') || `${appFiles.length} 个文件逐字节相同`);

  const report = {version: versionApp, release, vsix, verified: rows.every(row => row.pass),
    checkedAt: new Date().toISOString(), files, rows};
  fs.writeFileSync(path.join(output, 'chain.json'), JSON.stringify(report, null, 1));
  console.log('\n结论：verified=' + report.verified + '　报告：' + path.join(output, 'chain.json'));
  if (!report.verified) process.exitCode = 1;
})();
