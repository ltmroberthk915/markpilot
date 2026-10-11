// 「最近打开」的持久化清单（MRU）——**纯 Node，可单测**：不 require electron。
// 壳层（main.js）注入三件事：文件路径、原子写、以及"文件在不在"的判据；
// 这里只管口令：绝对路径、Windows 大小写不敏感去重、新开的置顶、上限 10、旧字段迁移。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 10;
const isWin = process.platform === 'win32';
const key = (p) => (isWin ? String(p).toLowerCase() : String(p));

/** 归一化 + 去重 + 截断。非字符串、空串、解析不出绝对路径的一律丢掉。 */
function normalize(value, limit = LIMIT) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    let abs; try { abs = path.resolve(item); } catch { continue; }
    const k = key(abs);
    if (seen.has(k)) continue;
    seen.add(k); out.push(abs);
    if (out.length >= limit) break;
  }
  return out;
}

/** 原子写：临时文件 + rename。半截 JSON 会让「最近打开」整段消失。
 *  Windows 上 rename 到已存在文件可能 EPERM/EEXIST（杀软/索引器持有句柄），退一步先删再改名。 */
function save(file, list) {
  const tmp = `${file}.mp-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch {
    try { fs.rmSync(file, { force: true }); } catch { /* 目标可能本来就不在 */ }
    fs.renameSync(tmp, file);
  }
  return file;
}

/** 读清单：文件在就用文件（它就是真源）；文件不在/坏了才退回 settings.json 里的旧字段。
 *  返回不落盘 —— 落盘时机由调用方决定（首启、或真的变了）。 */
function load({ file, legacy = [], limit = LIMIT } = {}) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* 首次运行 */ }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      return { list: normalize(parsed, limit), source: 'file', migrated: false };
    } catch { /* 坏了：当作没有，走迁移 */ }
  }
  const list = normalize(legacy, limit);
  return { list, source: list.length ? 'legacy' : 'empty', migrated: list.length > 0 };
}

/** 记一条（置顶）。`exists` 为假不记：避免"打开过又删掉"的幽灵条目一进菜单就报错。
 *  返回 {list, changed}；changed=false 表示顺序内容都没动，调用方可以不落盘。 */
function push(current, filePath, exists, limit = LIMIT) {
  const cur = normalize(current, limit);
  let abs; try { abs = path.resolve(String(filePath || '')); } catch { return { list: cur, changed: false, skipped: 'bad-path' }; }
  let alive = false; try { alive = !!(exists ? exists(abs) : fs.existsSync(abs)); } catch { alive = false; }
  if (!alive) return { list: cur, changed: false, skipped: 'missing' };
  const next = normalize([abs, ...cur], limit);
  return { list: next, changed: JSON.stringify(next) !== JSON.stringify(cur) };
}

/** 摘掉一条（文件没了/打开失败时用）。 */
function drop(current, filePath, limit = LIMIT) {
  const cur = normalize(current, limit);
  const k = key(path.resolve(String(filePath)));
  const next = cur.filter((x) => key(x) !== k);
  return { list: next, changed: next.length !== cur.length };
}

function clear() { return { list: [], changed: true }; }

/** 「文件 → 最近打开」子菜单的**模型**（纯函数，可单测）：壳层照它建菜单。
 *  文件被删/改名 ⇒ 该条灰掉 + 标「(文件不存在)」，不弹错误框、也不静默消失。 */
function menuModel(list, isFile) {
  const files = normalize(list);
  if (!files.length) return [{ type: 'normal', label: '（暂无记录）', enabled: false, id: null, path: null }];
  const items = files.map((p, i) => {
    let alive = false; try { alive = !!(isFile ? isFile(p) : fs.statSync(p).isFile()); } catch { alive = false; }
    return { type: 'normal', id: `recent-file-${i}`, label: path.basename(p) + (alive ? '' : ' (文件不存在)'), sublabel: p, enabled: alive, path: p };
  });
  items.push({ type: 'separator', id: null, label: '', enabled: false, path: null });
  items.push({ type: 'normal', id: 'menu-clear-recent', label: '清除最近记录', enabled: true, path: null });
  return items;
}

/** 菜单模型的标签序列（验收脚本与单测都读它）。 */
const menuLabels = (list, isFile) => menuModel(list, isFile).map((it) => it.label);

module.exports = { LIMIT, key, normalize, save, load, push, drop, clear, menuModel, menuLabels };
