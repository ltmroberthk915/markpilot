#!/usr/bin/env node
/**
 * MarkPilot · 从源码构建（源码快照专用；只依赖 devDependencies ✓）
 *
 *   node build-from-source.cjs            只构建引擎并同步到壳层（开发态用 npm start 起）
 *   node build-from-source.cjs --package  再打 Windows 的安装包 + 便携版（输出 dist/）
 *
 * 它做四件事：① 体检（模板字符串反引号配平）② esbuild 打包引擎 ③ 同步产物 ④ 可选打包。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const SHELL = path.join(ROOT, 'MarkPilot-CM6');
const SRC = path.join(ROOT, 'dsh-markpilot', 'src-cm6', 'main.js');
const OUT = path.join(SHELL, 'renderer', 'cm6', 'app.js');
const MERMAID_SRC = path.join(ROOT, 'dsh-markpilot', 'renderer', 'cdn', 'vditor', 'dist', 'js', 'mermaid', 'mermaid.min.js');
const MERMAID_DST = path.join(SHELL, 'renderer', 'cm6', 'mermaid.min.js');
const sha16 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

if (!fs.existsSync(SRC)) { console.error('✗ 找不到引擎入口：' + SRC); process.exit(1); }

const text = fs.readFileSync(SRC, 'utf8');
/* ① 入口存在性检查
   【删掉了"反引号配平"那条体检·2026-10-11】它是个**假判据** ✗ —— 源码里合法反引号有 1213 个，
   奇偶完全可能正常（模板串、正则、字符串里都会出现）✓，拿它当门禁只会**拦住正常构建** ✗
   （实测：第一次真跑就被它拦下 ✗）。真正的判据是 esbuild 能不能解析 ✓ —— 交给 ②。 */
if (text.indexOf('__mpEngine') < 0 && !/window.mpEngine/.test(text)) {
  console.warn('· 提示：入口里没看到 window.mpEngine 赋值（改名了？）——继续构建');
}
console.log('· 入口检查通过 ' + fs.statSync(SRC).size + ' B');

/* ② esbuild 打包（IIFE；与壳层 index.html 的 script src 约定一致）
   【找 esbuild 的正确位置·2026-10-11 实测】第一版只找 MarkPilot-CM6/node_modules/esbuild ✗ ——
   那**不存在** ✗；本仓的 esbuild 装在 dsh-markpilot/node_modules ✓（内部构建脚本用的就是它 ✓）。
   ⇒ 按"引擎目录 → 壳层目录"两档找 ✓，找不到就把候选路径打出来（免得再猜 ✗）。
   ⚠️ 本段在**模板字符串里** ⇒ 注释禁用反引号（错-42：写一个反引号就把模板切断 ✗）。 */
const ESBUILD_BIN = [
  path.join(ROOT, 'dsh-markpilot', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(SHELL, 'node_modules', 'esbuild', 'bin', 'esbuild'),
].find((p) => fs.existsSync(p));
if (!ESBUILD_BIN) {
  console.error('✗ 找不到 esbuild。请任选其一：');
  console.error('   · cd dsh-markpilot && npm install');
  console.error('   · 或 npm i -D esbuild');
  process.exit(3);
}
console.log('· esbuild = ' + ESBUILD_BIN);
/* 【必须补齐的两点·2026-10-11 实测（第一次 build-from-source 跑到一半失败 ✗）】
   ① 字体 loader：KaTeX 的 .woff/.woff2/.ttf 走 import ⇒ 不配 loader 会报
      "No loader is configured for .woff2" ✗（内部脚本用 --loader:.woff2=file ✓）；
   ② cwd 必须是 dsh-markpilot：字体是**相对路径** import 的 ✓，从仓库根跑会解析错 ✗；
   ③ --minify：与内部构建同口径 ✓（不开的话产物 hash 对不上，无法做等价性核对 ✗）。 */
const ENGINE_DIR = path.join(ROOT, 'dsh-markpilot');
// Rebuild the maintained source-map renderer and all matching font/CSS assets
// from the exact locked upstream package before resolving engine imports.
execFileSync(process.execPath, [path.join(ROOT, 'tools/vendor/build-katex.cjs')],
  { cwd: ROOT, stdio: 'inherit', windowsHide: true });
execFileSync(process.execPath, [
  ESBUILD_BIN, path.relative(ENGINE_DIR, SRC), '--bundle', '--format=iife',
  '--outfile=' + OUT, '--loader:.woff=file', '--loader:.woff2=file', '--loader:.ttf=file',
  '--minify', '--log-level=error',
], { cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
console.log('· 引擎产物 ' + sha16(OUT) + '  ' + fs.statSync(OUT).size + ' B');
console.log('· 已同步到 ' + path.relative(ROOT, OUT));

// Dedicated Worker is a separate offline asset, not an inline blob. Build it
// with the same locked dependencies as the renderer's parser and wire codec.
const WORKER_SRC = path.join(ENGINE_DIR, 'src-cm6', 'markdown-worker.js');
const WORKER_OUT = path.join(SHELL, 'renderer', 'cm6', 'markdown-worker.js');
execFileSync(process.execPath, [
  ESBUILD_BIN, path.relative(ENGINE_DIR, WORKER_SRC), '--bundle', '--format=iife',
  '--outfile=' + WORKER_OUT, '--minify', '--log-level=error',
], { cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
console.log('· 后台解析包 ' + sha16(WORKER_OUT) + '  ' + fs.statSync(WORKER_OUT).size + ' B');

// Node's SaveAs and the renderer use the same fenced-code/image source parser.
const IMAGES_SRC = path.join(ENGINE_DIR, 'src-cm6', 'resource-images.js');
const IMAGES_OUT = path.join(SHELL, 'shell', 'markdown-images.js');
execFileSync(process.execPath, [ESBUILD_BIN, IMAGES_SRC, '--bundle', '--platform=node', '--format=cjs',
  '--outfile=' + IMAGES_OUT, '--minify', '--log-level=error'],
  { cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
console.log('· 共用图片源码包 ' + sha16(IMAGES_OUT) + '  ' + fs.statSync(IMAGES_OUT).size + ' B');

/* ②-b 打印层用的 Knuth–Plass 排版包（PDF 精细断行；两条产品线共用同一份真源 ✓） */
const KP_SRC = path.join(ROOT, 'Typora-Editor-App', 'app', 'renderer', 'js', 'knuth-plass.mjs');
const KP_OUT = path.join(SHELL, 'renderer', 'pdf-typeset.js');
if (fs.existsSync(KP_SRC)) {
  execFileSync(process.execPath, [
    ESBUILD_BIN, KP_SRC, '--bundle', '--format=iife', '--global-name=MPKP',
    '--outfile=' + KP_OUT, '--minify', '--log-level=error',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('· 排版包 ' + sha16(KP_OUT) + '  ' + fs.statSync(KP_OUT).size + ' B');
} else {
  console.warn('· 跳过排版包（缺 ' + KP_SRC + '）⇒ PDF 会退回 CSS 两端对齐');
}

/* ③ mermaid 资产（离线可用；逐字节拷贝） */
if (fs.existsSync(MERMAID_SRC)) {
  fs.copyFileSync(MERMAID_SRC, MERMAID_DST);
  console.log('· mermaid 资产 ' + sha16(MERMAID_DST) + '  ' + fs.statSync(MERMAID_DST).size + ' B');
} else {
  console.error('✗ 找不到 vendored mermaid：' + MERMAID_SRC + '（图表功能会不可用）');
  process.exit(4);
}

/* ④ 可选打包 */
if (process.argv.includes('--package')) {
  try {
    execFileSync('npx', ['electron-builder', '--win', 'nsis', 'portable'], { cwd: SHELL, stdio: 'inherit', shell: true });
  } catch (e) {
    console.error('✗ electron-builder 失败（瞬时文件锁可重试一次）：' + ((e && e.message) || e));
    process.exit(5);
  }
  console.log('· 打包完成 ⇒ ' + path.join(SHELL, 'dist'));
}
