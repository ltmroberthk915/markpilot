// 持久化状态：窗口、最近打开、滚动位置、展开节点、侧边栏偏好
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { atomicWriteSync, stamp } = require('./snapshots');

const DEFAULTS = {
  bounds: null,
  maximized: false,
  lastWs: null,
  lastFile: null,
  recentFolders: [],
  recentFiles: [],
  editorShortcuts: {},
  settings: { autoSave: true, snapshots: true },
  scrollStore: {},
  scrollAnchor: {},
  expanded: {},
  sidebar: { width: 240, visible: true, mdOnly: false },
};

const RECENT_LIMIT = 50;
function defaultStateFile() {
  const userData = app.getPath('userData');
  const target = path.join(userData, 'state.json');
  if (fs.existsSync(target)) return target;
  // Keep existing personal settings when upgrading from the previous brand.
  for (const legacyDir of ['TyporaEditor', 'Typora Editor']) {
    const legacy = path.join(app.getPath('appData'), legacyDir, 'state.json');
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.copyFileSync(legacy, target);
      break;
    } catch { /* the new profile will start with defaults */ }
  }
  return target;
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
function normalizeRecent(value) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const normalized = path.resolve(item);
    const key = pathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key); result.push(normalized);
    if (result.length === RECENT_LIMIT) break;
  }
  return result;
}
class AppState {
  constructor({file, onRecentChange} = {}) {
    this.file = file || defaultStateFile();
    this.onRecentChange = onRecentChange;
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this._timer = null;
    this.load();
  }

  load() {
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { /* 首次运行：还没有偏好文件 */ }
    if (raw !== null) {
      try {
        this.data = { ...DEFAULTS, ...JSON.parse(raw) };
      } catch (error) {
        // 损坏时**不再静默重置**。此前解析失败被整个吞掉，表现是"最近打开、滚动位置、
        // 展开节点、侧边栏偏好全没了"，更糟的是 autoSave / snapshots 被悄悄翻回 true。
        // 现在留一份现场，并把这件事交给上层说出来。
        const backup = this.file.replace(/\.json$/i, '') + '.corrupt-' + stamp(new Date()) + '.json';
        try { fs.copyFileSync(this.file, backup); } catch { /* 备份失败也没关系，原始错误照样要报 */ }
        this.loadError = error.message;
        this.corruptBackup = backup;
        console.error('偏好文件解析失败：' + error.message + '，已备份为 ' + backup);
      }
    }
    const settings=this.data.settings;
    this.data.settings={autoSave:typeof settings?.autoSave==='boolean'?settings.autoSave:true,snapshots:typeof settings?.snapshots==='boolean'?settings.snapshots:true};
    this.data.recentFiles = normalizeRecent(this.data.recentFiles);
    this.data.recentFolders = normalizeRecent(this.data.recentFolders);
  }

  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; this.saveSoon(); }

  saveSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 原子写：此前是 writeFileSync，写到一半崩溃/断电就把 state.json 截断成半截 JSON，
      // 下次启动解析失败 → 静默重置全部偏好。这条路径在退出/关窗时被同步调用，所以用同步版。
      atomicWriteSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('state save failed:', e.message);
    }
  }

  recent() {
    return {recentFiles: [...this.data.recentFiles], recentFolders: [...this.data.recentFolders]};
  }

  pushRecent(listKey, value) {
    if (!['recentFiles', 'recentFolders'].includes(listKey) || !value) return;
    const list = normalizeRecent([value, ...this.data[listKey]]);
    if (JSON.stringify(list) === JSON.stringify(this.data[listKey])) return;
    this.data[listKey] = list;
    this.saveSoon();
    this.onRecentChange?.(this.recent());
  }

  updateRecentPath(from, to) {
    const oldPath = path.resolve(from);
    const oldKey = pathKey(oldPath);
    for (const key of ['recentFiles', 'recentFolders']) {
      this.data[key] = normalizeRecent(this.data[key].flatMap(value => {
        const current = pathKey(value);
        if (current !== oldKey && !current.startsWith(oldKey + path.sep)) return [value];
        return to ? [path.resolve(to) + value.slice(oldPath.length)] : [];
      }));
    }
    this.saveSoon();
    this.onRecentChange?.(this.recent());
  }

  setScroll(file, top) {
    if (typeof top === 'number' && isFinite(top)) {
      this.data.scrollStore[file] = Math.round(top);
      this.saveSoon();
    }
  }

  // 阅读位置锚点：单一像素值在含图片的文档里不可靠——重开时图片还没占位，内容比记录时矮，
  // 一次 scrollTo 会落偏（实测系统性偏上）。锚点记"顶部块序号 + 块内偏移 + 该块开头文本"，
  // 重开时按块还原，并在图片陆续加载、公式补渲染之后重贴。
  setScrollAnchor(file, anchor) {
    if (!anchor || typeof anchor !== 'object') return;
    const index = Number(anchor.index), delta = Number(anchor.delta);
    if (!isFinite(index) || !isFinite(delta)) return;
    this.data.scrollAnchor[file] = {
      index: Math.max(0, Math.round(index)), delta: Math.round(delta),
      head: typeof anchor.head === 'string' ? anchor.head.slice(0, 60) : '',
      total: Number(anchor.total) || 0,
    };
    this.saveSoon();
  }

  getScrollAnchor(file) { return this.data.scrollAnchor[file] || null; }
}

module.exports = { AppState, RECENT_LIMIT };
