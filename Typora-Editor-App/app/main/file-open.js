'use strict';
const fs = require('node:fs');
const path = require('node:path');
const VALUE_OPTIONS = new Set(['--user-data-dir', '--profile-directory', '--disk-cache-dir', '--log-file', '--remote-debugging-port']);

function isNewFileLaunch(argv,{isPackaged}) {
  for(let i=isPackaged?1:2;i<argv.length;i++) {
    const arg=argv[i];if(arg==='--')break;
    if(VALUE_OPTIONS.has(arg)){i++;continue;}
    if(arg==='--new-md')return true;
  }
  return false;
}

// 收集命令行里所有存在的位置参数。资源管理器里多选文件会一次把多个路径传进来，
// 2.1.0 起每个文件开一个窗口，所以这里必须能拿到全部目标而不只是第一个。
function findLaunchPaths(argv, {isPackaged, appPath, cwd = process.cwd()}) {
  const paths = [];
  let positional = false;
  for (let i = isPackaged ? 1 : 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!positional && arg === '--') {positional = true; continue;}
    if (!positional && arg.startsWith('-')) {
      if (VALUE_OPTIONS.has(arg)) i++;
      continue;
    }
    try {
      const target = path.resolve(cwd, arg);
      if (target.toLowerCase() === path.resolve(appPath).toLowerCase()) continue;
      if (fs.existsSync(target)) paths.push(target);
    } catch { /* Ignore non-path arguments. */ }
  }
  return paths;
}

function findLaunchPath(argv, options) {
  return findLaunchPaths(argv, options)[0] || null;
}

// Hold launch/menu requests until the shell has registered its doc-load listener.
// Serialize subsequent requests so overlapping disk reads cannot open an older file last.
class FileOpenQueue {
  constructor(open) {
    this.open = open;
    this.started = false;
    this.pending = [];
    this.tail = Promise.resolve();
  }

  request(target) {
    if (this.started) return this.run(() => this.open(target));
    return new Promise((resolve, reject) => this.pending.push({target, resolve, reject}));
  }

  run(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async start(restoreSession) {
    if (!this.started) {
      this.started = true;
      const requests = this.pending.splice(0);
      if (requests.length) {
        for (const {target, resolve, reject} of requests) this.run(() => this.open(target)).then(resolve, reject);
      } else {
        await this.run(restoreSession);
      }
    }
    let pending;
    do {pending = this.tail; await pending;} while (pending !== this.tail);
  }
}

module.exports = {findLaunchPath, findLaunchPaths, isNewFileLaunch, FileOpenQueue};
