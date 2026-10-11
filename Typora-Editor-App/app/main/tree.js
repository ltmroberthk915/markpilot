// 工作区目录树：枚举、新建、重命名、删除（回收站）、监视刷新
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

function isMdFile(name) {
  return MD_EXTS.has(path.extname(name).toLowerCase());
}

async function listDir(dir) {
  let names;
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const ent of names) {
    // Windows 上符号链接/junction 会导致递归爆炸，跳过
    if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
    const item = { name: ent.name, path: path.join(dir, ent.name) };
    if (ent.isDirectory()) dirs.push({ ...item, isDir: true });
    else if (ent.isFile()) files.push({ ...item, isDir: false, isMd: isMdFile(ent.name) });
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);
  return dirs.concat(files);
}

function uniquePath(target) {
  // 已存在则追加序号：a.md -> a 1.md / 文件夹 -> 文件夹 1
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const cand = path.join(dir, ext ? `${base} ${i}${ext}` : `${base} ${i}`);
    if (!fs.existsSync(cand)) return cand;
  }
  throw new Error('无法生成唯一名称');
}

// 2.1.0 多窗口：同一个目录可能被多个窗口同时打开。递归 watch 每个根一个句柄，
// 重复开纯粹是浪费，还会把同一次磁盘变更放大成 N 次刷新；所以按根复用并引用计数。
const watchHub = new Map(); // root -> {watcher, subscribers:Set<fn>, timer}

function notifyEntry(entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    for (const notify of [...entry.subscribers]) { try { notify(); } catch { /* 窗口可能已销毁 */ } }
  }, 300);
}

function subscribeWatch(root, notify) {
  let entry = watchHub.get(root);
  if (!entry) {
    entry = {watcher: null, subscribers: new Set(), timer: null};
    watchHub.set(root, entry);
    try {
      entry.watcher = fs.watch(root, { recursive: true }, () => notifyEntry(entry));
      entry.watcher.on('error', () => notifyEntry(entry));
    } catch (e) {
      console.error('watch failed:', e.message);
    }
  }
  entry.subscribers.add(notify);
  return () => {
    const current = watchHub.get(root);
    if (!current) return;
    current.subscribers.delete(notify);
    if (current.subscribers.size) return;
    try { current.watcher?.close(); } catch { /* ignore */ }
    clearTimeout(current.timer);
    watchHub.delete(root);
  };
}

class Workspace {
  constructor(onChanged) {
    this.root = null;
    this.onChanged = onChanged; // (root) => void，防抖后通知外壳刷新
    this._unsubscribe = null;
  }

  open(root) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
    this.root = root;
    this.startWatch();
    return true;
  }

  startWatch() {
    this.closeWatch();
    if (!this.root) return;
    this._unsubscribe = subscribeWatch(this.root, () => this.notify());
  }

  notify() {
    // 工作区根被删则退到最近仍存在的祖先目录
    if (this.root && !fs.existsSync(this.root)) {
      let p = path.dirname(this.root);
      while (p && p !== path.dirname(p) && !fs.existsSync(p)) p = path.dirname(p);
      this.root = fs.existsSync(p) ? p : null;
      this.startWatch();
    }
    try { this.onChanged(this.root); } catch { /* 外壳可能已销毁 */ }
  }

  closeWatch() {
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
  }

  async createEntry(parentDir, name, isDir) {
    const safe = name.trim().replace(/[\\/:*?"<>|]/g, ' ');
    if (!safe) throw new Error('名称不能为空');
    const target = uniquePath(path.join(parentDir, safe + (isDir ? '' : (isMdFile(safe) ? '' : '.md'))));
    if (isDir) await fsp.mkdir(target);
    else await fsp.writeFile(target, '', 'utf8');
    return target;
  }

  async rename(from, newName) {
    const safe = newName.trim().replace(/[\\/:*?"<>|]/g, ' ');
    if (!safe) throw new Error('名称不能为空');
    const to = path.join(path.dirname(from), safe);
    if (fs.existsSync(to)) throw new Error('目标已存在：' + safe);
    await fsp.rename(from, to);
    return to;
  }

  async trash(target) {
    await shell.trashItem(target);
  }

  reveal(target) {
    shell.showItemInFolder(target);
  }
}

module.exports = { Workspace, listDir, isMdFile, uniquePath, subscribeWatch };
