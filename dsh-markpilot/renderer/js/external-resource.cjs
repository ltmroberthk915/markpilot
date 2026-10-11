// 交给外部进程（PowerShell / cmd / 其它解释器）的脚本路径解析。
//
// 打包后 __dirname 落在 app.asar 里——那是 Electron 的虚拟文件系统，只有 Electron
// 自己的 fs 看得到；Windows PowerShell 看不到，于是 `-File <app.asar 里的路径>` 直接
// 失败（用户看到的是"复制图片失败：无法写入系统剪贴板"，而开发树上一切正常）。
// 教训：**交给外部进程的路径，必须在真实文件系统里存在才算可用**。这里按顺序落：
//   1) 未打包（开发树 / 便携目录）→ 同目录文件直接用；
//   2) 打包布局 → app.asar.unpacked 下的同名文件（electron-builder 的 asarUnpack
//      会把声明过的脚本解包到那里）；
//   3) 没解包（配置漏了、或换了打包器）→ 把内容从 asar 里读出来写到临时目录，
//      功能不因打包方式而失效（Electron 的 fs 能读 asar 内的文件）；
//   4) 都拿不到 → 抛错。绝不返回一个不存在的路径去 spawn，让失败发生在最外层。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const insideAsar = dir => /(^|[\\/])(app|electron)\.asar([\\/]|$)/.test(String(dir));
const unpackedPath = dir => String(dir).replace(/([\\/])((?:app|electron)\.asar)(?=[\\/]|$)/, '$1$2.unpacked');

/**
 * @param {string} dir       调用方 __dirname
 * @param {string} name      同目录下的文件名
 * @param {{read?:Function, tempDir?:string}} [options] 测试注入口
 * @returns {{path:string, source:'plain'|'unpacked'|'temp', dir:string}}
 */
const resolveExternal = (dir, name, options = {}) => {
  const read = options.read || (file => { try { return fs.readFileSync(file); } catch { return null; } });
  if (!insideAsar(dir)) {
    const plain = path.join(dir, name);
    if (read(plain)) return { path: plain, source: 'plain', dir };
  }
  const unpacked = path.join(unpackedPath(dir), name);
  if (read(unpacked)) return { path: unpacked, source: 'unpacked', dir: unpackedPath(dir) };
  const bytes = read(path.join(dir, name));
  if (!bytes) {
    throw new Error(`外部脚本找不到：${name}（已试 ${path.join(dir, name)} 与 ${unpacked}）`);
  }
  const tempDir = options.tempDir || path.join(os.tmpdir(), 'markpilot-external');
  // 名字里带内容哈希：同一份脚本复用同一个文件，升级后自动换新，不需要清理逻辑。
  const target = path.join(tempDir, crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '-' + name);
  fs.mkdirSync(tempDir, { recursive: true });
  if (!read(target)) fs.writeFileSync(target, bytes);
  return { path: target, source: 'temp', dir: tempDir };
};

module.exports = { resolveExternal, insideAsar, unpackedPath };
