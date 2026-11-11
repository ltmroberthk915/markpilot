// dsh-markdown-editor-typora 宿主半边（DSH 0.2.1 契约版）：
//   renderer-cm6 静态路由 + 版本守卫编辑面 API（open/save/stat/edit）+ SSE watch + markdown 模型工具。
//
// 插件三件套形状（宿主 cordis loader 读的就是这个）：
//   export const name / export const inject / export function apply(ctx)
//
// 架构（见 README.md）：引擎 0 改动，插件只做 DSH 皮/桥/文件 IO。
//   · 静态资源来自插件根 renderer-cm6/（core-sync 从 EXE 构建产物逐字节同步）；
//   · 同一文件的写入排队校验 ctx.fs 版本，本地文件使用桌面壳的原子写入与编码处理；
//   · 每次 save 都要求 baseVersion，版本冲突返回 FS_STALE_VERSION；
//   · 写成功后向所有 SSE 连接广播 version（客户端按 path 过滤 + 脏缓冲不覆盖）。
//
// 保留的既有不变量：
//   1. 信任栅栏：只信 ctx.connection.requestRejection（fail-closed）。宿主缺该能力时
//      插件一律 503 host-auth-unavailable，不再退回 loopback Host/Origin 放行。
//   2. body 上限 64MB：含内联图的 Markdown 十几 MB 在真实用户里常见（8MB 曾把 8.13MB 文档拒之门外）。
//   3. fs.watch 是 async（返回 close 函数）；不支持时降级为 2s 探测。旧实现把它当同步调用 ⇒
//      unhandled rejection + watcher 泄漏。这里 await 捕获并幂等 close。
//   4. 每个 async 分支都有 try/catch，错误以 {ok:false,error:{code,message}} 返回，code 原样透传。

import { readFile, stat as fsStat, realpath, writeFile, mkdir, open as fsOpen, link as fsLink, unlink as fsUnlink, rename as fsRename, readdir } from 'node:fs/promises';
import { createReadStream, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { createRequire } from 'node:module';
// 下面三个静态导入**只保留 HMR 依赖边**（host/*.js 变更 ⇒ dsh-hmr 把插件条目一并重启），
// 实例不直接消费：DSH HMR 的替换计划只驱逐「变更模块 + 其 importer」（planReplacement
// 只向上闭包，不向下含依赖），协同更新分批到达时 host/ 的 CJS 三件会混代 ——
// 新 document-store 顶层解构旧 live-documents 的导出 ⇒ “liveCommitDirectory is not a
// function”（real-manager-enable-r1 实证）。消费实例一律经 loadHostModules() 以
// 「整组驱逐 + 同代重载」取得：document-store 与 live-documents 永远来自同一代磁盘内容，
// 不降级、不换目录、共享房间/原子写语义不变。
import rawDiskStore from '../host/document-store.js';
import rawLiveStore from '../host/live-documents.js';
import rawTextCodec from '../host/text-codec.js';
import { createDocumentsService, parseDocumentBlocks } from './documents-service.js';
import { createSessionManager, allowedActions } from './document-sessions.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep, extname, basename, resolve as pathResolve, isAbsolute, relative as pathRelative }  from 'node:path';

const requirePlugin = createRequire(import.meta.url);
const nodeFs = requirePlugin('node:fs');
const nodeModule = requirePlugin('node:module');
/** loader 代际（ABI）：图记录若由不带本代「局部 require 所有权」的旧 loader 建立
 *  （同 digest 的旧 CCB slot 仍在活进程里），一律**不复用**：显式重建一代，
 *  旧 owner 交由其自己的 close/退休路径排空；重建后的同代码热载才稳定复用。 */
const HOST_GRAPH_ABI = 2;
/** 本代 Module → 原始 require（WeakMap：模块可回收，不积累强引用）。 */
const OWNED_ORIGINALS = new WeakMap();
/* ── host 运行时图（digest 整组复用/重载；进程级注册表，realpath 归一）────────────
 * 真实 HMR 实测（real-hmr-worker-count-r2）：每代无条件驱逐 ⇒ 每代一个 file-worker。
 * 方案（v3，按完整 host 清单而非手维护依赖图）：
 *   ① digest = host/ 全部源成员（含 native-worker-lease.js、native-worker-path.ps1、
 *      native/ 子树、package.json）的 rel+字节哈希，目录键走 fs.realpath（junction 拼写归一）；
 *   ② 相同 digest ⇒ 整组复用（不 require、不碰缓存）——worker、SQLite databases、
 *      beforeExit 全部延续；未变 native 写逻辑不可能被旧 writer 顶替；
 *   ③ digest 变 ⇒ 先**预载+验证**新图（拓扑序 require 四入口、导出面形状校验），
 *      全部成功才原子发布；失败则还原被逐出的缓存键并抛出 —— 旧图不被提前退休、
 *      不 shutdown、原样可用；缺文件在读清单时即硬错误（无 sentinel、无静默复用）；
 *   ④ 发布后旧图进 retiredList：其活跃 host 归零时调用**旧代自身**的
 *      shutdownFileWorker（worker 为该模块实例独占；在途写由其内部 operations 排空），
 *      然后清空 modules 引用并移除记录 —— exports/连接不再被注册表持有，模块可被
 *      GC（含其模块级 SQLite databases）；新代冷启不受旧代 closing 影响；
 *   ⑤ 同代多 host/多 live 窗口共享一张图：单 host.close 只减计数，最后一个才释放。
 * 不降级、不换目录、共享房间/原子写语义不变。 */
const HOST_GRAPH_KEY = Symbol.for('dsh-markdown-editor-typora:host-graph');
const HOST_ENTRY_ORDER = ['text-codec.js', 'safe-file.js', 'live-documents.js', 'document-store.js'];   // 依赖拓扑序
function hostGraphSlot(hostDir) {
  const root = (globalThis[HOST_GRAPH_KEY] ??= new Map());
  let slot = root.get(hostDir);
  if (!slot) { slot = { current: null, retiredList: [] }; root.set(hostDir, slot); }
  return slot;
}
const HOST_GRAPH_REQUIRED = new Set(['document-store.js', 'live-documents.js', 'text-codec.js', 'safe-file.js',
  'native-worker-lease.js', 'native-worker-path.ps1', 'native/file-worker.exe', 'native/file-worker.exe.build.json']);
function readHostGraph(hostDir) {
  // 真实 sync-host 约定：manifest 在**插件根**（host/ 上一级）的 host.json。
  // 逐条校验：相对路径、无绝对/..、realpath 后仍在 canonical host 根内（防 symlink 逃逸）、
  // bytes/sha256 与声明一致；必需成员（4 个 JS + native 脚本/二进制 + build manifest）必须声明。
  // 任一不满足 ⇒ 硬失败（publish 之前），旧图保活。
  const manifestPath = join(dirname(hostDir), 'host.json');
  let manifest;
  try { manifest = JSON.parse(nodeFs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { throw Object.assign(new Error('host graph manifest 不可读: ' + manifestPath), { cause: error }); }
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0)
    throw new Error('host graph manifest 形状无效（files 为空）: ' + manifestPath);
  const seen = new Set();
  const members = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) throw new Error('host graph manifest 条目无效');
    const rel = entry.path;
    if (pathIsAbsoluteShim(rel) || rel.split('/').some((segment) => segment === '..'))
      throw new Error('host graph manifest 条目必须为 host 内相对路径: ' + rel);
    if (seen.has(rel)) throw new Error('host graph manifest 重复条目: ' + rel);
    seen.add(rel);
    const real = nodeFs.realpathSync(join(hostDir, rel));       // 缺失/坏链 ⇒ throw（硬失败）
    if (real !== hostDir && !real.startsWith(hostDir + sep))    // canonical 核对：不许 symlink 指到 host 外
      throw new Error('host graph 成员逃逸 canonical 根: ' + rel + ' → ' + real);
    const bytes = nodeFs.readFileSync(real);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== entry.bytes || digest !== entry.sha256)
      throw new Error(`host graph 成员与 manifest 不匹配: ${rel}（期望 ${entry.bytes}B/${String(entry.sha256).slice(0, 12)}，实际 ${bytes.length}B/${digest.slice(0, 12)}）`);
    members.push({ rel, real, bytes });
  }
  for (const required of HOST_GRAPH_REQUIRED)
    if (!seen.has(required)) throw new Error('host graph manifest 缺少必需成员: ' + required);
  members.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const graph = createHash('sha256');
  for (const member of members) {
    graph.update(member.rel); graph.update('\0');
    graph.update(createHash('sha256').update(member.bytes).digest());
  }
  return { digest: graph.digest('hex'), members };
}
function pathIsAbsoluteShim(p) { return p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\'); }
function evictHostCacheKeys(members) {
  // 只逐 .js 成员；缓存键 = realpath。还原函数**先清空本次全部成员键**（含装载新产生、
  // 原先不存在的条目），再放回快照 —— 失败后旧 host 的延迟 require 只见旧实例，不混代。
  const backup = [];
  const keys = [];
  for (const member of members) {
    if (!member.rel.endsWith('.js')) continue;
    keys.push(member.real);
    const existing = requirePlugin.cache[member.real];
    if (existing !== undefined) backup.push([member.real, existing]);
    try { delete requirePlugin.cache[member.real]; } catch { /* 原本不在 */ }
  }
  return () => {
    for (const key of keys) { try { delete requirePlugin.cache[key]; } catch { /* 已不在 */ } }
    for (const [key, mod] of backup) requirePlugin.cache[key] = mod;
  };
}
function finalizeHostRetirement(slot, record) {
  // 顺序约定（transport）：先旧代 retireLiveStorage()（仍有会话/在途 ⇒ MP_LIVE_ACTIVE，
  // 此时**不算已清理**——保持 pending，绝不误判 done），再旧代 safeFile.shutdownFileWorker()
  //（成功后自行移除 beforeExit 监听）。全部完成才清引用、移除记录。
  if (record.retired === 'done') return;         // 幂等：跨代/跨路径重复触发只收一次
  const live = record.modules.get('live-documents.js');
  try {
    const retired = live?.retireLiveStorage?.();
    if (retired && retired.ok !== true) return scheduleRetirementRetry(slot, record);
  } catch (error) {
    if (error?.code === 'MP_LIVE_ACTIVE') return scheduleRetirementRetry(slot, record);
    /* 其它错误：存储未收口也要继续收 worker/引用 —— 进程退出兜底仍在 */
  }
  const safeFile = record.modules.get('safe-file.js');
  try { void Promise.resolve(safeFile?.shutdownFileWorker?.()).catch(() => { /* 旧代关停失败不阻塞；退出 hook 兜底 */ }); }
  catch { /* 旧代关停失败不阻塞 */ }
  record.retired = 'done';
  // 解除本代模块的局部 require 所有权：恢复原 mod.require（不碰全局行为），之后其惰性
  // require 回到普通解析；本代记录随后清引用。
  unbindOwnedRequires(record);
  record.modules.clear();                       // 释放引用：旧模块（含模块级 worker/SQLite 状态）可被 GC
  const at = slot.retiredList.indexOf(record);
  if (at !== -1) slot.retiredList.splice(at, 1);   // 记录不复留：不持有 exports/连接
}
function scheduleRetirementRetry(slot, record) {
  // MP_LIVE_ACTIVE：仍有在途操作/在场会话 —— 稍后重试一次；仍活跃则留 pending（退出兜底）。
  if (record.retireRetry) return;
  record.retireRetry = setTimeout(() => {
    record.retireRetry = null;
    if (record.retired === 'pending' && record.hosts.size === 0) finalizeHostRetirement(slot, record);
  }, 300);
  record.retireRetry.unref?.();
}
function loadHostGraph() {
  // import.meta.url 可能带 HMR 查询串（?g=…）——取文件本体路径。
  const here = dirname(fileURLToPath(import.meta.url.split('?')[0]));
  const hostDir = nodeFs.realpathSync(normalize(join(here, '..', 'host')));   // 缺失 ⇒ 硬错误
  const slot = hostGraphSlot(hostDir);
  const graph = readHostGraph(hostDir);           // 任一成员缺/不可读 ⇒ 硬错误（无 sentinel）
  // 复用条件必须同时满足 digest 与 **loader 代际**：活进程里可能已有同 digest 的旧 CCB slot
  //（不带本代「局部 require 所有权」）—— 它不能无条件复用，须显式按本代重建一次。
  if (slot.current && slot.current.digest === graph.digest && slot.current.abi === HOST_GRAPH_ABI) {
    const current = slot.current;
    return { live: current.modules.get('live-documents.js'), disk: current.modules.get('document-store.js'),
      codec: current.modules.get('text-codec.js'), safeFile: current.modules.get('safe-file.js'), graph: current };
  }
  // 预载新图：逐出本图 .js 成员缓存键（含 native-worker-lease 等），拓扑序 require，形状验证。
  const restore = evictHostCacheKeys(graph.members);
  const loaded = new Map();
  const cjsModules = new Map();
  const cjsByFile = new Map();
  try {
    for (const name of HOST_ENTRY_ORDER) {
      loaded.set(name, requirePlugin('../host/' + name));
      // 捕获本代模块的 CJS Module 对象（供局部 resolver 用；**不写全局 require.cache**）。
      try {
        const resolved = requirePlugin.resolve('../host/' + name);
        const real = nodeFs.realpathSync(resolved);
        const mod = requirePlugin.cache[real] || requirePlugin.cache[resolved] || null;
        cjsModules.set(name, mod);
        if (mod) {
          cjsByFile.set(mod.filename, mod);
          if (real !== mod.filename) cjsByFile.set(real, mod);
        }
      } catch { cjsModules.set(name, null); }
    }
    const live = loaded.get('live-documents.js'), disk = loaded.get('document-store.js');
    if (typeof live?.LiveDocuments !== 'function' || typeof live?.withFileCommit !== 'function'
      || typeof disk?.DocumentStore !== 'function' || typeof disk?.createSession !== 'function'
      || typeof loaded.get('text-codec.js')?.decodeDocument !== 'function'
      || typeof loaded.get('safe-file.js')?.prepareFile !== 'function')
      throw new Error('host graph 新代导出面不完整（digest=' + graph.digest.slice(0, 12) + '）');
  } catch (error) {
    restore();                                    // 回滚缓存：旧图成员（含懒 require 路径）原位、不被破坏
    throw error;
  }
  // ① 发布前校验（绑定/导出一致性）——失败 ⇒ 回滚并抛出；**旧图不退休、不 shutdown**。
  try {
    validateOwnedGraph(loaded, cjsModules);
  } catch (error) {
    restore();
    throw error;
  }
  // ② 在图记录建立后、对外发布前完成逐 Module 实例的 require 绑定；绑定失败同样回滚。
  const nextGraph = { dir: hostDir, abi: HOST_GRAPH_ABI, digest: graph.digest, modules: loaded, cjs: cjsModules, cjsByFile, hosts: new Set(), retired: 'active', generation: (slot.current?.generation ?? 0) + 1 };
  try {
    bindOwnedRequires(nextGraph);
  } catch (error) {
    unbindOwnedRequires(nextGraph);
    restore();
    throw error;
  }
  // ③ 原子发布：旧图记账退休（host 归零才真正释放），新图上桌。
  const previous = slot.current;
  if (previous) {
    previous.retired = previous.hosts.size === 0 ? 'done' : 'pending';
    slot.retiredList.push(previous);
    if (previous.retired === 'done') finalizeHostRetirement(slot, previous);
  }
  slot.current = nextGraph;
  return { live: loaded.get('live-documents.js'), disk: loaded.get('document-store.js'),
    codec: loaded.get('text-codec.js'), safeFile: loaded.get('safe-file.js'), graph: slot.current };
}
/** 发布前绑定/导出一致性校验：真实 Module 对象缺失或 exports 形状不符 ⇒ 直接失败（不静默放过）。 */
function validateOwnedGraph(loaded, cjsModules) {
  for (const name of HOST_ENTRY_ORDER) {
    const mod = cjsModules.get(name);
    if (!mod || !mod.exports || mod.exports !== loaded.get(name))
      throw new Error('host graph 校验失败：成员 Module 缺失或 exports 不匹配（' + name + '）');
  }
  const live = loaded.get('live-documents.js'), disk = loaded.get('document-store.js');
  if (typeof live?.defaultDirectory !== 'function')
    throw new Error('host graph 校验失败：live-documents.defaultDirectory 非函数（混代绑定）');
  if (typeof live?.LiveDocuments !== 'function' || typeof live?.withFileCommit !== 'function')
    throw new Error('host graph 校验失败：live-documents 导出面不完整');
  if (typeof disk?.DocumentStore !== 'function' || typeof disk?.createSession !== 'function')
    throw new Error('host graph 校验失败：document-store 导出面不完整');
  // 只读构造探针：document-store 构造函数仅赋值（无 IO），defaultDirectory 混代时必抛
  // liveCommitDirectory is not a function —— 这正是发布前要拦下的形态。
  const probe = new disk.DocumentStore();
  if (!probe || typeof probe.snapshot !== 'function' || typeof probe.commitDirectory !== 'string' || !probe.commitDirectory)
    throw new Error('host graph 校验失败：DocumentStore 构造绑定异常');
  probe.jobs?.clear?.();
}
/** 逐 Module 实例安装本代 require（WeakMap 保存原 require；非 prototype、非 _load）。 */
function bindOwnedRequires(graph) {
  for (const [name, mod] of graph.cjs) {
    if (!mod || typeof mod.require !== 'function' || !mod.exports)
      throw new Error('host graph 绑定失败：成员 Module 不可用（' + name + '）');
    if (OWNED_ORIGINALS.has(mod)) continue;                     // 已绑定（同代重复发布不应发生）
    const original = mod.require;
    const owned = graph.cjsByFile;
    const wrapped = function ownedRequire(request) {
      if (typeof request === 'string' && request[0] === '.' && owned) {
        let filename = null;
        try { filename = nodeModule._resolveFilename(request, mod, false); } catch { /* 交给原 require 报错 */ }
        if (filename) {
          const hit = owned.get(filename);
          if (hit) return hit.exports;
        }
      }
      return original.call(mod, request);
    };
    OWNED_ORIGINALS.set(mod, original);
    mod.require = wrapped;
  }
}
/** 恢复本代模块的原 require（退役路径）；重复调用安全。 */
function unbindOwnedRequires(record) {
  if (!record || !record.cjs) return;
  for (const [, mod] of record.cjs) {
    const original = OWNED_ORIGINALS.get(mod);
    if (original) { try { mod.require = original; } catch { /* 已冻结则忽略 */ } OWNED_ORIGINALS.delete(mod); }
  }
}
// 无兜底：装载失败就让它失败（绝不回落到可能混代的 raw* 实例掩盖问题）。
const hostModules = loadHostGraph();
const diskStore = hostModules.disk;
const liveStore = hostModules.live;
const textCodec = hostModules.codec;
const activeHostGraph = hostModules.graph;
function registerHost(token) { activeHostGraph.hosts.add(token); }
function scheduleHostRetirement(ownerGraph) {
  // 已接纳的异步 save 排空后才允许关闭旧代资源（worker/连接）；期间另一 active host
  // 不受任何影响（owners 已归零才会走到这里，且只作用于被顶代的图）。
  const here = dirname(fileURLToPath(import.meta.url.split('?')[0]));
  const hostDir = nodeFs.realpathSync(normalize(join(here, '..', 'host')));
  void Promise.allSettled([...saveJobs.values()]).then(() => {
    if (ownerGraph.hosts.size === 0 && ownerGraph.retired === 'pending') finalizeHostRetirement(hostGraphSlot(hostDir), ownerGraph);
  }).catch(() => { /* 排空失败不阻塞 */ });
}
function unregisterHost(token) {
  const ownerGraph = activeHostGraph;
  if (ownerGraph.hosts.delete(token) && ownerGraph.hosts.size === 0 && ownerGraph.retired === 'pending') scheduleHostRetirement(ownerGraph);
}
void rawDiskStore; void rawLiveStore; void rawTextCodec;

export const name = 'dsh-markdown-editor-typora';

/** 必需服务：webServer（路由挂载点）+ fs（版本守卫读写）。 */
export const inject = ['webServer', 'fs'];

const ROUTE_PREFIX = '/dsh-markdown-editor-typora';
const STATIC_PREFIX = ROUTE_PREFIX + '/renderer-cm6/';
const API_PREFIX = ROUTE_PREFIX + '/api/';
// Only the editor's explicit local-file actions use its native file capability.
// The model tool must use the host filesystem's read projection and write policy.
const MODEL_TOOL = Symbol('markdown model tool');
export { MODEL_TOOL };
const IMG_PREFIX = ROUTE_PREFIX + '/img/';
const CORE_JSON_PATH = ROUTE_PREFIX + '/core.json';
const KNOWN_ENDPOINTS = new Set(['open', 'save', 'stat', 'edit', 'live', 'docs/create', 'docs/saveAs', 'documents.fileState', 'documents.locate', 'documents.session', 'documents.recoveryList', 'documents.recoveryRead', 'documents.recoveryDiscard', 'docs/recent', 'docs/archive', 'documents.read', 'documents.applyEdits', 'documents.state', 'documents.reconcile', 'documents.recover', 'documents.discardRecovery', 'documents.undoGroup', 'documents.merge3', 'documents.reviewGroup', 'documents.reviewGroups', 'documents.undoGroups', 'documents.conflictOpen', 'documents.conflictResolve', 'documents.conflictCancel', 'documents.draftMirror', 'documents.draftRead', 'documents.draftClear', 'diag']);
const SESSION_MUTATING_ENDPOINTS = new Set(['open', 'save', 'edit', 'live', 'docs/create', 'docs/saveAs', 'docs/archive', 'documents.applyEdits', 'documents.recover', 'documents.discardRecovery', 'documents.undoGroup', 'documents.undoGroups', 'documents.merge3', 'documents.reviewGroup', 'documents.conflictResolve', 'documents.conflictCancel', 'documents.draftMirror', 'documents.draftClear']);
/** 最近一次客户端布局诊断（仅当页面 URL 带 &mpdiag=1 时上报；生产不会有）。内存里只留最后一份。 */
let lastDiag = null;

/** 请求体上限：64MB。含内联图文档常见 10MB+；上限之外明确 413，不静默截断。 */
export const BODY_MAX_BYTES = 64 * 1024 * 1024;
/** 本地图片响应上限：与请求体同口径。超过只给 413，不把整块内容读进内存。 */
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 120;
const WATCH_PROBE_MS = 2000;
const SSE_HEARTBEAT_MS = 15000;

const HERE = dirname(fileURLToPath(import.meta.url.split('?')[0]));
export const PLUGIN_ROOT = normalize(join(HERE, '..'));
const localDocuments = new diskStore.DocumentStore();
// Shared by all createHost instances in this process. Failures do not poison
// subsequent saves; a queued request must validate its version on admission.
const saveJobs = new Map();
const pathKey = p => process.platform === 'win32' ? normalize(p).toLowerCase() : normalize(p);
async function canonicalTarget(target) {
  const p=nativeTargetPath(target);
  try {return await realpath(p);} catch(error) {if(error.code!=='ENOENT')throw error;return p;}
}
function queueSave(key, action) {
  const job=(saveJobs.get(key)||Promise.resolve()).catch(()=>{}).then(action);
  saveJobs.set(key,job);
  const done=()=>{if(saveJobs.get(key)===job)saveJobs.delete(key);};job.then(done,done);
  return job;
}

/** 静态资源 MIME 表（含 CM6 引擎实际用到的 woff/woff2/ttf/wasm/map，以及 mermaid 的 svg/png）。 */
export const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(filePath) {
  return MIME_BY_EXT[extname(String(filePath)).toLowerCase()] ?? 'application/octet-stream';
}

/** ETag 由 size-mtime 组成（要求口径）；mtime 取整毫秒，避免频繁重建时抖动。 */
export function makeEtag(size, mtimeMs) {
  const s = Number.isFinite(Number(size)) ? Math.trunc(Number(size)) : 0;
  const m = Number.isFinite(Number(mtimeMs)) ? Math.trunc(Number(mtimeMs)) : 0;
  return `"${s}-${m}"`;
}

/** If-None-Match 匹配（支持 *、逗号列表、弱前缀 W/）。命中返回 304。 */
export function isNotModified(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== 'string' || ifNoneMatch.length === 0) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * 缓存策略：
 *   · 入口 HTML、app.js/app.css、dsh-*.js：no-cache（每次带 ETag 校验，拿 304）；
 *   · 字体（woff/woff2/ttf/otf/eot）：public, max-age=604800 —— 内容哈希文件名，长缓存安全；
 *   · 其余（worker/mermaid/图标）：no-cache + ETag。
 */
export function cacheControlFor(filePath) {
  const base = String(filePath).split(/[\\/]/).pop() ?? '';
  const ext = extname(base).toLowerCase();
  if (ext === '.woff' || ext === '.woff2' || ext === '.ttf' || ext === '.otf' || ext === '.eot') {
    return 'public, max-age=604800';
  }
  if (base === 'index.html' || base === 'app.js' || base === 'app.css' || /^dsh-[^/]*\.js$/i.test(base)) {
    return 'no-cache';
  }
  return 'no-cache';
}

/**
 * 把一个 URL 相对路径解析成 renderer-cm6 根内的绝对路径；越界/编码异常/盘符/空字节一律 null。
 * 这是路径穿越防护的唯一入口（纯函数，可被测试直接覆盖）。
 */
export function resolveStaticTarget(rootDir, rawRelative) {
  if (typeof rawRelative !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    return null;
  }
  if (decoded.length === 0) decoded = 'index.html';
  if (decoded.includes('\0')) return null;
  const slashed = decoded.replace(/\\/g, '/');
  if (slashed.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(slashed)) return null;
  const segments = slashed.split('/');
  if (segments.some((segment) => segment === '..')) return null;
  const root = normalize(rootDir);
  const target = normalize(join(root, slashed));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/* ══ 本地图片路由（文档相对路径图的取字节通道）══════════════════════════════════════
 * 为什么需要：CM6 引擎按"当前文档所在目录"解析相对图片路径（`image-path.js` 的
 * resolveImageSource）；桌面壳把它拼成 file:// 并靠 file 页面读盘。DSH 的编辑面是
 * **http 源**：CSP 的 img-src 不含 file:，Chromium 也禁止 http 页面加载 file:// 子资源
 * ⇒ 相对路径图必然"图片加载失败"。所以由插件提供唯一合法的本地图片通道：
 *   GET /dsh-markdown-editor-typora/img/<绝对本地路径（逐段百分号编码，保留 /）>
 * 桥（renderer-cm6/dsh-bridge.js）在 open 时把 <base href> 指到
 *   /dsh-markdown-editor-typora/img/<文档目录>/
 * ⇒ 引擎发出的相对 URL 原样落到本路由。浏览器按 RFC 3986 自己归一化 `../`，
 * 因此这里拿到的永远是规整的绝对路径。
 *
 * 安全边界（三条都必须成立，缺一即拒）：
 *   ① 形态：只接受盘符绝对路径（D:/x/y.png）或 UNC（//server/share/y.png），
 *      拒空段 / 单点 / 双点 / NUL / 坏编码 —— 归一化不靠浏览器，自己逐段验；
 *   ② 扩展名：图片白名单之外一律不服务（本路由不是通用文件服务）；
 *   ③ 只在宿主鉴权栅栏之后（connection.requestRejection；缺能力即 503），且只读、只 GET/HEAD。
 * 说明：该读面不强于既有 /api/open（它本来就能读任意路径文本）。 */

/** 图片 MIME（本路由专用；比静态表窄，且不接受 fonts/wasm 之类）。 */
export const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function imageMimeFor(filePath) {
  return IMAGE_MIME_BY_EXT[extname(String(filePath)).toLowerCase()] ?? null;
}

/**
 * 把 URL 里 `/img/` 之后的剩余路径还原成**绝对本地路径**；不合规一律 null（纯函数）。
 * 规则见本节注释①。解码逐段进行：`%2e%2e` 解出来是 `..`，同样被拒。
 */
export function decodeImageRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const slashed = rawPath.replace(/\\/g, '/');
  let unc = false;
  let rest = slashed;
  if (rest.startsWith('//')) { unc = true; rest = rest.slice(2); }
  else if (rest.startsWith('/')) rest = rest.slice(1);
  if (rest.length === 0) return null;
  const segments = rest.split('/');
  const decoded = [];
  // Windows 设备名段（CON/NUL/COM1…）会被当成设备打开：读 CON 可能把请求挂住，
  // 所以连"图片扩展名"都不看，段一级直接拒。
  const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  for (const segment of segments) {
    let value;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (value.length === 0) return null;
    if (value === '.' || value === '..') return null;
    if (value.includes('\0')) return null;
    if (/[\\/]/.test(value)) return null;   // %2f/%5c 解出来的分隔符不许再切一层
    if (DEVICE_NAME.test(value)) return null;
    if (decoded.length > 0 && value.includes(':')) return null;   // 备用数据流（a.png:b）不收
    decoded.push(value);
  }
  if (decoded.length < 1) return null;
  let localPath;
  if (unc) {
    if (decoded.length < 2) return null;    // //server 后面至少还要有共享名
    localPath = '//' + decoded.join('/');
  } else {
    if (!/^[A-Za-z]:$/.test(decoded[0])) return null;   // 必须是盘符绝对路径
    if (decoded.length < 2) return null;
    localPath = decoded[0].toUpperCase() + '/' + decoded.slice(1).join('/');
  }
  if (!imageMimeFor(localPath)) return null;
  return normalize(localPath);
}

/** 服务一次本地图片请求：ETag/304、HEAD、大小上限、流式输出。返回是否已响应。 */
export async function serveImageFile(req, res, rawPath) {
  const method = req?.method === 'HEAD' ? 'HEAD' : 'GET';
  const target = decodeImageRequestPath(rawPath);
  if (!target) {
    sendText(res, 400, 'bad image path');
    return false;
  }
  let info;
  try {
    info = await fsStat(target);
  } catch (error) {
    sendText(res, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'not found' : 'stat error');
    return false;
  }
  if (!info.isFile()) {
    sendText(res, 404, 'not found');
    return false;
  }
  if (info.size > IMAGE_MAX_BYTES) {
    sendText(res, 413, 'image too large');
    return false;
  }
  const etag = makeEtag(info.size, info.mtimeMs);
  const headers = {
    'content-type': imageMimeFor(target),
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    // SVG 在 <img> 里不执行脚本，但**直接导航**（地址栏/window.open）时就是同源文档、脚本可跑。
    // 这条 CSP 对 <img> 渲染零影响，对文档导航把脚本/表单/子资源全部中和。
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  };
  if (isNotModified(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  // 不写 content-length：stat 与流之间有 TOCTOU（文件被改写会截断/挂住）。
  // 交给 chunked 传输，浏览器按流读完即可。
  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    const stream = createReadStream(target);
    stream.on('error', () => { try { res.destroy(); } catch { /* 已断 */ } done(); });
    stream.on('end', done);
    res.on('close', () => { try { stream.destroy(); } catch { /* 已断 */ } done(); });
    stream.pipe(res);
  });
  return true;
}

/** FsError 等错误的稳定码（分支认码不认文案；不许把 code 吞成 message）。 */
export function errorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (error?.name === 'AbortError') return 'FS_ABORTED';
  return 'fs-error';
}

/**
 * DSH 文件策略拒绝这次写入（workspace-write 只允许会话工作区内的路径）。
 * 只在这个明确码/文案上走原生 fs 回退；OS 的 EACCES/EPERM 仍然照常失败。
 */
export function isSandboxWriteDenied(error) {
  if (errorCode(error) === 'FS_SANDBOX_DENIED') return true;
  const message = String(error?.message ?? error ?? '');
  return /file access denied under (workspace-write|read-only) mode/i.test(message);
}

function validSaveAsPath(raw) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return false;
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(raw)) return false;
  if (raw.startsWith('\\\\?') || raw.startsWith('\\\\.')) return false;
  const parts = raw.split(/[\\/]+/);
  if (/^[A-Za-z]:$/.test(parts[0])) {
    if (parts.slice(1).some((part) => part.includes(':'))) return false;
  } else if (parts.some((part) => part.includes(':'))) {
    return false;
  }
  if (parts.some((part) => part === '..' || part === '.')) return false;
  const base = parts[parts.length - 1] || '';
  if (!/\.md$/i.test(base)) return false;
  if (/[<>:"|?*\u0000-\u001f]/.test(base)) return false;
  if (/[. ]$/.test(base)) return false;
  const stem = base.split('.')[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return false;
  return true;
}

function codedError(code, message, extra) {
  const error = new Error(String(message));
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

/** ctx.fs 的 target 同时带 displayPath 和 realpath targetKey；原生写用后者。 */
function nativeTargetPath(target) {
  const key = target?.targetKey;
  if (typeof key === 'string' && key.length > 0) return key;
  const displayPath = target?.displayPath;
  return typeof displayPath === 'string' ? displayPath : '';
}

/** 与 dsh-fs-local 的 versionOf 同形：dev:ino:size:mtimeNs:ctimeNs（bigint）。 */
function versionOfBigInt(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/**
 * Local Markdown saves share the desktop's stable snapshot, encoding and
 * staged native replacement. Never truncate the destination before commit.
 * The UI's existing explicit local-file write capability remains scoped here.
 */
async function directWriteText(fs, target, text, baseVersion, diskHash) {
  const file=nativeTargetPath(target),session=diskStore.createSession();
  if(!file)throw codedError('FS_IO_ERROR','direct write: target has no native path');
  const version=async()=>{const info=await fs.stat(target);if(!info)throw codedError('FS_NOT_FOUND','file no longer exists');return String(info.version);};
  try {
    if(await version()!==baseVersion)throw codedError('FS_STALE_VERSION','file changed since read');
    await localDocuments.load(session,file);
    if(diskHash && session.baseline.sha256!==diskHash)throw codedError('FS_STALE_VERSION','file changed since the synchronized revision');
    if(await version()!==baseVersion)throw codedError('FS_STALE_VERSION','file changed while preparing save');
    const expected=textCodec.encodeDocument(text,session),expectedHash=createHash('sha256').update(expected).digest('hex');
    localDocuments.markDirty(session,{documentId:session.documentId,revision:1,dirty:true});
    await localDocuments.save(session,{filePath:session.filePath,text,documentId:session.documentId,revision:1});
    const before=await version(),saved=await localDocuments.snapshot(session.filePath),after=await version();
    if(before!==after||saved.baseline.sha256!==expectedHash)throw codedError('FS_STALE_VERSION','file changed after save; draft retained');
    return {version:after,displayPath:target.displayPath,size:saved.bytes.length};
  } catch(error) {
    if(['MP_FILE_CONFLICT','MP_FILE_MISSING'].includes(error.code)) {
      if (error.code === 'MP_FILE_MISSING') error.reason = 'missing';
      error.code='FS_STALE_VERSION';
    } else if (error.code === 'FS_NOT_FOUND') {
      error.code = 'FS_STALE_VERSION';
      error.reason = 'missing';
    }
    throw error;
  }
}


function textBlock(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } };
}

/**
 * 宿主兼容性检测：`connection` 服务是否提供 `requestRejection` 能力。
 *
 * 这是文件 API 唯一的信任来源。宿主没有该能力时插件会 fail-closed（503），
 * 不再退回 loopback Host/Origin 判定 —— 那条兜底在认证缺失时等于跳过鉴权。
 */
export function hostAuthCapability(connection) {
  return typeof connection?.requestRejection === 'function';
}

/**
 * 读请求体，超限返回 {ok:false,code:'too-large'}；网络错误返回 {ok:false,code:'request-error'}。
 * 超限后暂停消费剩余数据（不把 64MB 之外的攻击流量继续读进内存）。
 */
export function readBody(req, limit = BODY_MAX_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        req.pause();
        finish({ ok: false, code: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, code: 'request-error' }));
    req.on('aborted', () => finish({ ok: false, code: 'request-error' }));
  });
}

function sendJson(res, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (res.headersSent) {
    try { res.end(); } catch { /* 已断 */ }
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders) {
  if (res.headersSent) {
    try { res.end(); } catch { /* 已断 */ }
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders });
  res.end(text);
}

/**
 * 宿主核心：把 ctx 依赖收成一个可独立测试的对象。
 * @param {{fs:object, log?:object, rootDir?:string, bodyLimit?:number, watchDebounceMs?:number,
 *          watchProbeMs?:number, heartbeatMs?:number, connectionProvider?:() => any}} [options]
 */
export function createHost(options = {}) {
  const fs = options.fs;
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error('dsh-markdown-editor-typora: a filesystem service (ctx.fs) is required');
  }
  const log = options.log ?? console;
  const rootDir = normalize(options.rootDir ?? PLUGIN_ROOT);
  const staticRoot = normalize(join(rootDir, 'renderer-cm6'));
  const coreJsonFile = normalize(join(rootDir, 'core.json'));
  const bodyLimit = options.bodyLimit ?? BODY_MAX_BYTES;
  const watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  const watchProbeMs = options.watchProbeMs ?? WATCH_PROBE_MS;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const connectionProvider = typeof options.connectionProvider === 'function'
    ? options.connectionProvider
    : () => undefined;

  /** 每个被观察文件一条 entry；refs 计数到 0 才释放（SSE 多 tab 共享）。 */
  const watchers = new Map();
  const fileIdentities = new Map();
  const live = options.liveDocuments ?? new liveStore.LiveDocuments();
  const leases = new Map();
  let closed = false;

  function leaseOf(client) {
    const lease = typeof client === 'string' && leases.get(client);
    if (!lease) throw codedError('MP_LIVE_LEASE', '编辑同步会话已过期，当前草稿已保留');
    return lease;
  }
  function releaseLive(client) {
    if (!leases.delete(client)) return;
    live.leave(client);
  }

  /** Open rooms are the cross-process truth; read them through a short-lived read-only handle. */
  let roomsSqlite = null;
  async function lookupDocument(target) {
    if (closed) return null;
    const dbFile = join(live.directory, 'rooms.sqlite');
    if (!existsSync(dbFile)) return null;
    const canonical = await canonicalTarget(target);
    if (closed) return null;
    const key = pathKey(canonical);
    try {
      // A read-only draft mirror has no room; it is still an unsaved editor
      // buffer and must block generic fs writes exactly like a dirty room.
      const mirror = await live.getDraft?.(canonical, {});
      if (mirror) return { path: canonical, file: key, dirty: true, source: 'mirror', mirror: true };
      if (!roomsSqlite) roomsSqlite = await import('node:sqlite');
      const db = new roomsSqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* 尽力而为 */ }
        const room = db.prepare('SELECT file,epoch,version,saved,disk FROM rooms WHERE file=?').get(key);
        if (!room) return null;
        return {
          path: canonical,
          file: room.file,
          epoch: room.epoch,
          version: room.version,
          savedVersion: room.saved,
          dirty: room.version !== room.saved,
          diskHash: room.disk,
        };
      } finally { try { db.close(); } catch { /* 已关闭 */ } }
    } catch (error) { throw error; }
  }
  function liveEndpoint(payload) {
    leaseOf(payload.client);
    if (payload.action === 'leave') {
      releaseLive(payload.client);
      return {ok:true,value:null};
    }
    if (payload.action === 'refresh') {
      const request = payload.request || {};
      return Promise.resolve(live.refresh(payload.client, request.epoch, { discard: request.discard === true }))
        .then(value=>({ok:true,value}));
    }
    if (payload.action !== 'exchange') return badRequest('unknown live action');
    return Promise.resolve(live.exchange(payload.client,payload.request)).then(value=>({ok:true,value}));
  }
  // B3: the model tool's authority over the current document (buffer or disk).
  // It never creates a room and never writes disk on the buffer branch; the
  // editor's own save path remains the only writer of unsaved buffer text.
  const documents = createDocumentsService({
    live,
    openModel: (payload, invocation) => apiOpen(payload, MODEL_TOOL, undefined, invocation),
    edit: (payload, invocation) => apiEdit(payload, invocation),
    save: (payload) => apiSave(payload),
    archive: (payload) => apiDocsArchive(payload, { prune: true }),
    resolve: (payload, invocation) => fs.resolve(payload?.path ?? '', resolveOptions(payload, invocation)),
    stat: (target) => fs.stat(target),
    canonical: (target) => canonicalTarget(target),
    localPath: (target) => nativeTargetPath(target),
    enqueue: (key, action) => queueSave(pathKey(key), action),
    sandboxMode: fs.sandboxMode,
    log,
  });
  const documentSessions = createSessionManager();
  let sessionGeneration = 0;
  function invalidateSessions() { sessionGeneration += 1; documentSessions.clear(); }
  /** Persisted-file notifications are scoped to the watched target. Unsaved edits use independent document leases. */
  const liveStreams = new Set();

  function watchKeyOf(target) {
    return String(target?.targetKey ?? target?.displayPath ?? '');
  }

  function broadcastChange(target, version, delta, flags) {
    try { invalidateSessions(); } catch { /* shadow cache only */ }
    const data = {
      path: target?.displayPath,
      targetKey: target?.targetKey,
      version: String(version ?? ''),
      ...(flags?.missing === true ? { missing: true } : {}),
      ...(delta ? { delta: { oldString: String(delta.oldString ?? '').slice(0, 400), newString: String(delta.newString ?? '').slice(0, 400) } } : {}),
    };
    const frame = `event: change\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of liveStreams) {
      if(stream.targetKey !== watchKeyOf(target))continue;
      try {
        stream.res.write(frame);
      } catch { /* 连接已断，close 事件会清理 */ }
    }
  }

  async function confirmMissing(entry) {
    try { return (await fs.stat(entry.target)) === undefined; }
    catch { return false; }
  }

  async function tickWatch(entry, baseline = false) {
    if (entry.disposed) return;
    let version = '';
    let missing = false;
    try {
      const info = await fs.stat(entry.target);
      if (info === undefined) missing = true;
      else version = String(info.version ?? '');
    } catch {
      return;
    }
    if (entry.disposed) return;
    const notifiedMissing = entry.missing === true;
    const seen = entry.lastVersion !== undefined || notifiedMissing;
    const becameMissing = missing && !notifiedMissing;
    const becamePresent = !missing && notifiedMissing;
    const versionChanged = !missing && !notifiedMissing && entry.lastVersion !== undefined && version !== entry.lastVersion;
    const changed = seen && (becameMissing || becamePresent || versionChanged);
    if (changed && !baseline) {
      const pendingMissing = missing;
      if (pendingMissing && entry.missingCommitPending === true) return;
      if (entry.debounce) clearTimeout(entry.debounce);
      if (pendingMissing) entry.missingCommitPending = true;
      entry.debounce = setTimeout(() => {
        entry.debounce = null;
        if (entry.disposed) return;
        void (async () => {
          let present = !pendingMissing;
          if (pendingMissing) {
            // A missing latch is committed only after a second stat confirms it.
            // A transient/recreated file must not freeze the stream in missing.
            if (!await confirmMissing(entry)) present = true;
          }
          if (entry.disposed) return;
          if (present) {
            try { const info = await fs.stat(entry.target); if (info !== undefined) { entry.lastVersion = String(info.version ?? ''); entry.missing = false; broadcastChange(entry.target, entry.lastVersion); } }
            catch { /* next tick retries */ }
          } else {
            entry.missing = true;
            broadcastChange(entry.target, '', undefined, { missing: true });
          }
          entry.missingCommitPending = false;
        })().catch(() => { entry.missingCommitPending = false; });
      }, watchDebounceMs);
      entry.debounce.unref?.();
    }
    if (baseline) entry.missing = missing;
    if (!missing) entry.lastVersion = version;
  }

  async function startWatch(entry) {
    if (entry.started) return;
    entry.started = true;
    // FS.watch 是 async：resolve 为 close 函数；不支持时 reject（FS_IO_ERROR）。旧实现把它当
    // 同步调用且不 catch —— 这里必须 await 并保留 close，否则 watcher 泄漏 / unhandled rejection。
    try {
      const close = await fs.watch(entry.target, () => { void tickWatch(entry); }, entry.controller.signal);
      if (entry.disposed) {
        try { if (typeof close === 'function') await close(); } catch { /* 已停 */ }
        return;
      }
      entry.close = typeof close === 'function' ? close : null;
    } catch (error) {
      if (entry.disposed) return;
      log.warn?.('%s: fs.watch unavailable (%s) — SSE 退化为 %dms 探测', name, String(error?.message ?? error), watchProbeMs);
      entry.timer = setInterval(() => { void tickWatch(entry); }, watchProbeMs);
      entry.timer.unref?.();
    }
    await tickWatch(entry, true);
  }

  function ensureWatch(target) {
    const key = watchKeyOf(target);
    let entry = watchers.get(key);
    if (entry) {
      entry.refs += 1;
      return entry;
    }
    entry = {
      refs: 1,
      target,
      lastVersion: undefined,
      missing: false,
      baselineReady: null,
      controller: new AbortController(),
      close: null,
      timer: null,
      debounce: null,
      disposed: false,
      started: false,
    };
    watchers.set(key, entry);
    entry.baselineReady = startWatch(entry);
    return entry;
  }

  function releaseWatch(target) {
    const key = watchKeyOf(target);
    const entry = watchers.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    watchers.delete(key);
    entry.disposed = true;
    try { entry.controller.abort(); } catch { /* 已停 */ }
    if (entry.timer) clearInterval(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    const close = entry.close;
    entry.close = null;
    if (typeof close === 'function') {
      Promise.resolve().then(() => close()).catch(() => { /* close 失败不影响进程 */ });
    }
  }

  async function serveStatic(req, res, rawRelative) {
    const target = resolveStaticTarget(staticRoot, rawRelative);
    if (!target) {
      sendText(res, 403, 'forbidden');
      return;
    }
    let info;
    try {
      info = await fsStat(target);
    } catch (error) {
      sendText(res, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'not found' : 'stat error');
      return;
    }
    let filePath = target;
    if (info.isDirectory()) {
      filePath = join(target, 'index.html');
      try {
        info = await fsStat(filePath);
      } catch {
        sendText(res, 404, 'not found');
        return;
      }
    }
    if (!info.isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    const etag = makeEtag(info.size, info.mtimeMs);
    const headers = {
      'content-type': mimeFor(filePath),
      'cache-control': cacheControlFor(filePath),
      etag,
      'x-content-type-options': 'nosniff',
    };
    if (isNotModified(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      sendText(res, 500, 'read error');
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function serveCoreJson(req, res) {
    let data;
    try {
      data = await readFile(coreJsonFile);
    } catch (error) {
      // 不生成 core.json 的旧包也不能让客户端崩：明确 404 + 可诊断文案。
      sendJson(res, error?.code === 'ENOENT' ? 404 : 500, {
        ok: false,
        error: {
          code: error?.code === 'ENOENT' ? 'not-found' : 'fs-error',
          message: error?.code === 'ENOENT'
            ? 'core.json has not been generated yet (run scripts/sync-core.mjs)'
            : String(error?.message ?? error),
        },
      });
      return;
    }
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const info = await fsStat(coreJsonFile);
      const etag = makeEtag(info.size, info.mtimeMs);
      headers.etag = etag;
      if (isNotModified(req.headers['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    } catch { /* 无 stat 也要能返回内容 */ }
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /** GET /dsh-markdown-editor-typora/api/watch?path=…：SSE 外部变更流；心跳 15s；close 幂等清理。 */
  async function handleWatch(req, res, url) {
    const path = url.searchParams.get('path') ?? '';
    if (!path) {
      sendJson(res, 400, badRequest('path is required'));
      return;
    }
    let target;
    try {
      target = await fs.resolve(path);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { code: errorCode(error), message: String(error?.message ?? error) } });
      return;
    }
    if (res.headersSent) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    const stream = { res, targetKey: watchKeyOf(target) };
    liveStreams.add(stream);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* close 清理 */ }
    }, heartbeatMs);
    heartbeat.unref?.();
    const entry = ensureWatch(target);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      liveStreams.delete(stream);
      releaseWatch(target);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    try {
      res.write(`event: ready\ndata: ${JSON.stringify({ path: target.displayPath, version: String(entry.lastVersion ?? '') })}\n\n`);
    } catch { /* 已断 */ }
    Promise.resolve(entry.baselineReady).then(() => {
      if (closed || entry.disposed || entry.missing !== true) return;
      try {
        res.write(`event: change\ndata: ${JSON.stringify({ path: target.displayPath, targetKey: target.targetKey, version: '', missing: true })}\n\n`);
      } catch { /* 已断 */ }
    }).catch(() => { /* baseline 失败，下一次 tick 会补 */ });
  }

  function resolveOptions(payload, invocation) {
    const cwd = invocation?.cwd ?? payload?.cwd;
    return { ...(typeof cwd === 'string' && cwd ? {cwd} : {}), ...(invocation?.signal ? {signal:invocation.signal} : {}) };
  }

  function diskRevisionSha(text) {
    return createHash('sha256').update(String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')).digest('hex');
  }

  async function apiOpen(payload, authority, resolvedTarget, invocation) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = resolvedTarget ?? await fs.resolve(path, resolveOptions(payload, invocation));
    for(let attempt=0;attempt<3;attempt++) {
      const info=await fs.stat(target, invocation?.signal);
      if(!info)throw codedError('FS_NOT_FOUND',`not found: ${target.displayPath}`);
      if(info.type!=='file')throw codedError('FS_NOT_REGULAR_FILE',`not a regular file: ${target.displayPath}`);
      let text, baseline;
      // The local provider's version identifies native bytes. Use the same
      // strict BOM/EOL decoder as its writer; virtual providers keep their API.
      const native=authority===MODEL_TOOL ? null : await fsStat(nativeTargetPath(target),{bigint:true}).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(native&&versionOfBigInt(native)===String(info.version)) {
        try {const snapshot=await localDocuments.snapshot(nativeTargetPath(target)); baseline=snapshot.baseline.sha256; text=textCodec.decodeDocument(snapshot.bytes,target.displayPath).text;}
        catch(error){if(error.code==='MP_FILE_CONFLICT')continue;throw error;}
      } else text=await fs.readText(target, invocation?.signal);
      const after=await fs.stat(target, invocation?.signal);
      if(!after||String(after.version)!==String(info.version))continue;
      const diskSha=diskRevisionSha(text);
      if (native) await rememberIdentity(target);
      const value={text,version:after.version,displayPath:target.displayPath,size:after.size,type:after.type,diskRevisionSha:diskSha};
      if (payload.live === true && baseline && authority !== MODEL_TOOL) {
        const canonical=await canonicalTarget(target);
        const seed=text.replace(/\r\n?/g,'\n');
        const joined=await live.join(canonical,seed,baseline);
        if (closed) { live.leave(joined.client);throw codedError('MP_LIVE_CLOSED','editor host stopped'); }
        leases.set(joined.client,{canonical:pathKey(canonical)});
        value.live={client:joined.client,epoch:joined.epoch,version:joined.version,diskHash:joined.diskHash,dirty:joined.text!==seed,savedVersion:joined.savedVersion,
          ...(typeof joined.resolvedDisk==='string'&&joined.resolvedDisk?{resolvedDisk:joined.resolvedDisk}:{}),
          ...(Array.isArray(joined.recovered)?{recovered:joined.recovered}:{})};
        value.text=joined.text;
      }
      return {ok:true,value};
    }
    throw codedError('FS_STALE_VERSION','file changed during read; retry after the external write finishes');
  }

  async function rememberIdentity(target) {
    try {
      const native = await fsStat(nativeTargetPath(target), { bigint: true });
      if (!native || native.ino <= 0n || native.dev <= 0n) { fileIdentities.delete(pathKey(await canonicalTarget(target))); return; }
      const canonical = await canonicalTarget(target);
      if (fileIdentities.size >= 2048) fileIdentities.clear();
      fileIdentities.set(pathKey(canonical), { dev: String(native.dev), ino: String(native.ino), size: Number(native.size), mtimeNs: String(native.mtimeNs) });
    } catch { /* identity is an optimization for locate, never a read blocker */ }
  }

  async function sessionKeyFor(payload, invocation, authority) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    let key;
    try {
      const target = await fs.resolve(path, resolveOptions(payload, invocation));
      const info = await fs.stat(target);
      let canonical = null;
      let base;
      try { canonical = await canonicalTarget(target); base = pathKey(canonical); }
      catch { base = pathKey(nativeTargetPath(target) || path); }
      let roomMarker = '';
      let mirrorMarker = '';
      let recoveryMarker = '';
      if (canonical) {
        if (typeof live.readRoom === 'function') {
          try {
            const room = await live.readRoom(canonical);
            if (room) roomMarker = `:${room.epoch}:${room.version}:${room.savedVersion}:${room.members}:${room.localMembers}:${room.resolvedDisk ?? ''}`;
          } catch { /* no room marker; provider version still guards disk changes */ }
        }
        if (typeof live.getDraft === 'function') {
          try {
            const mirror = await live.getDraft(canonical);
            if (mirror) mirrorMarker = `:m:${mirror.textSha256}:${mirror.baseVersion}:${mirror.baseSha256}`;
          } catch { mirrorMarker = ':m:error'; }
        }
        if (typeof live.listAppendRecovery === 'function') {
          try {
            const items = await live.listAppendRecovery(canonical);
            recoveryMarker = `:r:${items.length}:${items[0]?.sha256 ?? ''}`;
          } catch { recoveryMarker = ':r:error'; }
        }
      }
      const policyMarker = `:a:${String(authority)}:${invocation?.policy?.mode ?? ''}:${invocation?.policy?.workspaceRoot ?? ''}`;
      key = base + ':' + String(info?.version ?? 'missing') + roomMarker + mirrorMarker + recoveryMarker + policyMarker;
    } catch {
      key = pathKey(path) + ':missing';
    }
    return key;
  }

  async function apiSession(payload, invocation, authority = 'editor') {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    let key = await sessionKeyFor(payload, invocation, authority);
    const generation = sessionGeneration;
    let loaded = false;
    const load = async () => {
      loaded = true;
      const result = await documents.state(payload, invocation);
      if (!result || result.ok !== true) {
        const error = result?.error || { code: 'FS_IO_ERROR', message: 'state failed' };
        throw Object.assign(new Error(String(error.message || error.code || 'state failed')), { resultError: error });
      }
      return { ...result.value, allowedActions: allowedActions(result.value) };
    };
    let snapshot;
    try {
      snapshot = await documentSessions.resolve(key, load);
      if (loaded) {
        const after = await sessionKeyFor(payload, invocation, authority);
        if (after !== key) {
          documentSessions.clear(key);
          key = after;
          snapshot = await documentSessions.resolve(key, load);
        }
      }
    } catch (error) {
      if (error?.resultError) return { ok: false, error: error.resultError };
      throw error;
    }
    if (generation !== sessionGeneration) documentSessions.clear(key);
    return { ok: true, value: snapshot };
  }

  async function apiRecoveryList(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    if (typeof live.listAppendRecovery !== 'function') return { ok: true, value: { items: [] } };
    const items = await live.listAppendRecovery(nativeTargetPath(target));
    return { ok: true, value: { items: items.map(({ recoveryPath, sha256, at, version, bytes }) => ({ recoveryPath, sha256, at, version, bytes })) } };
  }

  async function apiRecoveryRead(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const recoveryPath = typeof payload?.recoveryPath === 'string' ? payload.recoveryPath : '';
    if (!path || !recoveryPath) return badRequest('path and recoveryPath are required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const value = await live.readAppendRecovery(nativeTargetPath(target), recoveryPath);
    return { ok: true, value };
  }

  async function apiRecoveryDiscard(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const recoveryPath = typeof payload?.recoveryPath === 'string' ? payload.recoveryPath : '';
    if (!path || !recoveryPath) return badRequest('path and recoveryPath are required');
    const target = await fs.resolve(path, resolveOptions(payload));
    if (typeof live.discardAppendRecovery !== 'function') return badRequest('recovery discard unsupported');
    await live.discardAppendRecovery(nativeTargetPath(target), recoveryPath);
    return { ok: true, value: { removed: true } };
  }

  async function apiFileState(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const info = await fs.stat(target);
    return { ok: true, value: {
      path: target.displayPath || path,
      exists: info !== undefined,
      missing: info === undefined,
      ...(info ? { version: String(info.version), size: info.size, type: info.type } : {}),
    } };
  }

  async function apiLocate(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const current = await fs.stat(target);
    if (current !== undefined) return { ok: true, value: { missing: false, candidates: [] } };
    const canonical = await canonicalTarget(target);
    const key = pathKey(canonical);
    const identity = fileIdentities.get(key);
    if (!identity || process.platform !== 'win32' || identity.ino === '0' || identity.dev === '0')
      return { ok: true, value: { missing: true, candidates: [] } };
    const parent = dirname(nativeTargetPath(target));
    let entries = [];
    try { entries = await readdir(parent, { withFileTypes: true }); }
    catch { return { ok: true, value: { missing: true, candidates: [] } }; }
    const truncated = entries.length > 4096;
    entries = entries.slice(0, 4096);
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || entry.name.startsWith('.mp-tmp-')) continue;
      const candidate = join(parent, entry.name);
      try {
        const native = await fsStat(candidate, { bigint: true });
        if (!native || native.ino <= 0n || String(native.dev) !== identity.dev || String(native.ino) !== identity.ino) continue;
        if (Number(native.size) !== identity.size) continue;
        if (identity.mtimeNs && String(native.mtimeNs) !== identity.mtimeNs) continue;
        candidates.push({ path: candidate, version: versionOfBigInt(native), size: Number(native.size) });
      } catch { /* unreadable candidate is not a rename proof */ }
    }
    return { ok: true, value: { missing: true, candidates, truncated } };
  }

  async function rejectDraftMirrorBeforeWrite(current) {
    if (typeof live.getDraft !== 'function') return;
    const mirror = await live.getDraft(nativeTargetPath(current), {});
    if (mirror) throw codedError('MP_DOC_MIRROR_READONLY', 'an unsaved draft mirror exists for this document; refusing to overwrite it');
  }

  async function apiSave(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const text = typeof payload?.text === 'string' ? payload.text : null;
    const baseVersion = typeof payload?.baseVersion === 'string' ? payload.baseVersion : '';
    if (!path) return badRequest('path is required');
    if (text === null) return badRequest('text is required');
    if (!baseVersion) return badRequest('baseVersion is required — refusing to overwrite without a version guard');
    const target = await fs.resolve(path, resolveOptions(payload)),key=pathKey(await canonicalTarget(target));
    return queueSave(key,async()=>{
      const current=await fs.resolve(path,resolveOptions(payload));
      if(pathKey(await canonicalTarget(current))!==key)throw codedError('FS_STALE_VERSION','save target changed while queued');
      const before=await fs.stat(current);
      if(!before)throw codedError('FS_STALE_VERSION','file no longer exists',{reason:'missing'});
      if (payload.rejectIfMirror) await rejectDraftMirrorBeforeWrite(current);
      let result;
      const native=await fsStat(nativeTargetPath(current),{bigint:true}).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      const local=!!native && versionOfBigInt(native)===String(before.version);
      if (payload.live) {
        const ticket=payload.live;
        if(!local||leaseOf(ticket.client).canonical!==key)throw codedError('MP_LIVE_LEASE','synchronized save target changed');
        let writerVersion;
        result=await live.save(ticket.client,{epoch:ticket.epoch,version:ticket.version,text},async({diskHash})=>{
          const version=await fs.stat(current);
          const identity=await fsStat(nativeTargetPath(current),{bigint:true});
          if (!version) throw codedError('FS_STALE_VERSION','file no longer exists',{reason:'missing'});
          if (versionOfBigInt(identity)!==String(version.version) || pathKey(await canonicalTarget(await fs.resolve(path,resolveOptions(payload))))!==key)
            throw codedError('FS_STALE_VERSION','file identity changed while waiting to save');
          const receipt=await directWriteText(fs,current,text,String(version.version),diskHash);
          writerVersion=receipt.version;
          return receipt;
        });
        // 内核最终契约：写者回执保持权威（provider.version 原样），live 元数据以
        // liveVersion/savedVersion/diskHash/epoch 另列。此防御兼容过渡期旧形状
        // （旧内核把 head.version 并进回执盖掉写者版本）—— 两种形状下客户端拿到的
        // version 都是盘版本、房间版本都在 liveVersion。
        if(writerVersion!==undefined&&result&&typeof result==='object'&&String(result.version)!==String(writerVersion))
          result={...result,liveVersion:result.version,version:writerVersion};
      }else if(String(before.version)!==baseVersion)throw codedError('FS_STALE_VERSION','file changed since read');
      else if(local)result=await live.external(nativeTargetPath(current),()=>directWriteText(fs,current,text,baseVersion));
      else try {result=await fs.writeText(current,text,{kind:'replaceIfVersion',version:baseVersion});}
      catch(error){if(!isSandboxWriteDenied(error))throw error;result=await directWriteText(fs,current,text,baseVersion);}
      const version=result?.version;broadcastChange(current,version);
      await rememberIdentity(current);
      const value={version,displayPath:current.displayPath,size:result.size??Buffer.byteLength(text,'utf8'),diskRevisionSha:diskRevisionSha(text)};
      if(payload.live&&result&&typeof result==='object'){
        // 已授权 live 保存专属：按客户端 applyLiveReceipt 约定透传最小 live 元数据
        // （savedVersion/liveVersion/epoch/diskHash；provider version 保持权威）。
        // 普通旧保存与模型写不走此分支 —— live capabilities 不外泄。
        if(Number.isSafeInteger(result.savedVersion))value.savedVersion=result.savedVersion;
        if(Number.isSafeInteger(result.liveVersion))value.liveVersion=result.liveVersion;
        if(typeof result.epoch==='string'&&result.epoch)value.epoch=result.epoch;
        if(typeof result.diskHash==='string'&&result.diskHash)value.diskHash=result.diskHash;
      }
      return {ok:true,value};
    });
  }

  /**
   * 新建文档：在指定文件夹里落一个 .md，绝不覆盖已有文件。
   * 与 apiSave 的区别：这里没有「已存在版本」可守，所以用 wx 独占创建（EEXIST 即换名重试），
   * 天然满足"永不覆盖"；写入内容来自设置里的模板（{title} 已由客户端替换过一次，
   * 这里再兜一次，避免模板里残留占位符）。
   */
  /**
   * 新建文档：在指定文件夹里落一个 .md，绝不覆盖已有文件。
   *
   * 走的是 EXE 那套安全写入（host/document-store.js 同款协议）：
   *   prepareFile(target, tmp, { baseline: null, output:{bytes,sha256} })
   *     → 原生 worker 收到 expected={exists:false}，**在替换层就拒绝覆盖**；
   *   → 内容写进 .mp-tmp-<pid>-<uuid> 临时文件（flag r+，槽位由 prepareFile 建好）；
   *   → commit() 由原生 worker 原子落地；失败保留恢复副本；
   *   → finally 里 abort() 清理，绝不留半截临时文件。
   * 不再裸 writeFile —— 那是这条加固链上唯一的漏洞。
   */

  // First-save drafts use a fixed UUID name. A retry never chooses another file.
  const draftReceipts = new Map();
  // P4 escape hatch. The write must go through ctx.fs so sandbox policy,
  // staging and encoding stay identical to normal saves; never use bare node fs.
  // Contract: {path: source, targetPath: new file, text}. `path` is accepted as
  // the target for the legacy test-only shape.
  async function apiSaveAs(payload, authority) {
    if (authority === MODEL_TOOL) return badRequest('saveAs is editor-only');
    const raw = payload?.targetPath !== undefined ? payload.targetPath : payload?.path;
    const text = payload?.text;
    if (!validSaveAsPath(raw)) return badRequest('save-as path must be an absolute .md path (no ADS/reserved names)');
    if (typeof text !== 'string') return badRequest('text is required');
    const target = await fs.resolve(raw);
    if (await fs.stat(target) !== undefined) throw codedError('FS_EXISTS','save-as target already exists');
    let receipt;
    try {
      receipt = await fs.writeText(target, text, { kind: 'createIfAbsent' });
    } catch (error) {
      if (['FS_NOT_OBSERVED', 'FS_EXISTS', 'EEXIST'].includes(error?.code)) throw codedError('FS_EXISTS','save-as target already exists');
      throw error;
    }
    const info = await fs.stat(target);
    if (info && info.type !== 'file') throw codedError('FS_STALE_VERSION','save-as target is not a regular file');
    await rememberIdentity(target);
    const version = String(receipt?.version ?? info?.version ?? '');
    broadcastChange(target, version);
    return { ok: true, value: {
      path: target.displayPath || raw,
      version,
      size: Buffer.byteLength(text, 'utf8'),
    } };
  }

  async function createExactDraft(payload) {
    const draftId = payload?.draftId;
    if (typeof draftId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(draftId)
      || typeof payload.exactText !== 'string') return badRequest('draftId UUID and exactText are required');
    const rawDir = typeof payload.dir === 'string' ? payload.dir : '';
    if (!rawDir || !isAbsolute(rawDir)) return badRequest('draft directory must be absolute');
    const dir = await realpath(rawDir), directory = await fsStat(dir, {bigint:true});
    if (!directory.isDirectory()) throw codedError('FS_NOT_DIRECTORY','draft directory is not a directory');
    const fileName = '未命名-' + draftId.toLowerCase() + '.md';
    const candidate = join(dir,fileName), key = pathKey(candidate);
    if ((payload.name !== undefined && payload.name !== fileName)
      || (payload.path !== undefined && (!isAbsolute(payload.path) || pathKey(payload.path) !== pathKey(join(rawDir,fileName)))))
      return badRequest('draft path must match its fixed UUID name');
    const bytes = Buffer.from(payload.exactText,'utf8'), sha = createHash('sha256').update(bytes).digest('hex');
    const id = draftId.toLowerCase(), prior = draftReceipts.get(id);
    if (prior && (prior.key !== key || prior.sha !== sha)) throw codedError('MP_DRAFT_REUSED','draft creation identity or first-save content changed');
    if (!prior && draftReceipts.size >= 2048) throw codedError('MP_DRAFT_LIMIT','too many draft creation receipts; current draft is preserved');
    const record = prior || {key,sha,version:null};
    draftReceipts.set(id,record);
    return queueSave(key,async()=>{
      if (closed) throw codedError('MP_HOST_CLOSED','draft host has closed');
      // Do not redirect a held draft through a replaced directory or symlink.
      const currentDir=await realpath(rawDir), currentInfo=await fsStat(currentDir,{bigint:true});
      if (pathKey(currentDir)!==pathKey(dir) || currentInfo.dev!==directory.dev || currentInfo.ino!==directory.ino)
        throw codedError('FS_STALE_VERSION','draft directory changed before creation');
      const receipt = async (reused) => {
        const before=await fsStat(candidate,{bigint:true});
        if(!before.isFile())throw codedError('FS_NOT_REGULAR_FILE','draft target is not a regular file');
        const actual=await readFile(candidate), after=await fsStat(candidate,{bigint:true});
        if(versionOfBigInt(before)!==versionOfBigInt(after) || actual.length!==bytes.length
          || createHash('sha256').update(actual).digest('hex')!==sha)
          throw codedError('FS_STALE_VERSION','draft target differs from the first-save text');
        const target=await fs.resolve(candidate), info=await fs.stat(target);
        if(!info || info.type!=='file' || pathKey(await canonicalTarget(target))!==key
          || String(info.version)!==versionOfBigInt(after))
          throw codedError('FS_STALE_VERSION','draft target changed while resolving its save receipt');
        if(record.version!==null && record.version!==String(info.version))
          throw codedError('FS_STALE_VERSION','draft target changed after its initial save');
        record.version=String(info.version);
        return {ok:true,value:{path:candidate,requestedPath:join(rawDir,fileName),displayPath:target.displayPath||candidate,version:info.version,size:bytes.length,safe:true,draftId:id,idempotent:reused,diskRevisionSha:diskRevisionSha(payload.exactText)}};
      };
      const exists=await fsStat(candidate).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      if(exists)return receipt(true); // Exact-byte reconciliation also covers a lost reply / host restart.
      if(record.version!==null)throw codedError('FS_STALE_VERSION','created draft was removed; refusing to recreate it');
      const temp=join(dir,'.mp-tmp-'+process.pid+'-'+randomUUID());
      let stage, handle, primaryFailure;
      try {
        if(process.platform==='win32') {
          const safeFile=hostModules.safeFile;
          if(typeof safeFile?.prepareFile!=='function')throw codedError('MP_SAFE_FILE_UNAVAILABLE','safe file creation unavailable');
          stage=await safeFile.prepareFile(candidate,temp,{baseline:null,output:{bytes:bytes.length,sha256:sha}});
          await writeFile(temp,bytes,{flag:'r+'});
          await stage.commit();
        } else {
          // POSIX rename would overwrite a racing file; hard-link publication is no-replace.
          handle=await fsOpen(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
          await fsLink(temp,candidate);
        }
      } catch(error) {primaryFailure=error;throw error;}
      finally {
        try {await handle?.close();await stage?.abort();if(process.platform!=='win32')await fsUnlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
        catch(error){if(primaryFailure)primaryFailure.cleanupError=String(error?.message||error);else throw error;}
      }
      const result=await receipt(false);broadcastChange({targetKey:candidate,displayPath:candidate},result.value.version);return result;
    });
  }

  const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
  const AGENT_BEFORE_KEEP_PER_SOURCE = 20;
  const AGENT_BEFORE_KEEP_TOTAL = 200;
  function archiveSourceFold(value) {
    const text = String(value || '');
    return process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
  }
  // Only removes automatic copies for one tag that have a parseable sidecar.
  // Parked recovery files (`recovery/`) and user/other-tag archives are never in
  // this directory match set. A failed/missing sidecar means "leave it alone".
  async function pruneTaggedArchives(dir, currentArchivePath, tag = 'agent-before') {
    const pattern = new RegExp('\\.' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.[0-9a-f]{16}\\.md$');
    let names;
    try { names = await readdir(dir); } catch { return; }
    const entries = [];
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const archivePath = join(dir, name), metaPath = archivePath + '.json';
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8'));
        if (meta?.schema !== 1 || meta?.tag !== tag || typeof meta?.sourcePath !== 'string' || !isAbsolute(meta.sourcePath)) continue;
        if (typeof meta?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) continue;
        const expectedKey = createHash('sha256').update(meta.sourcePath + '\0' + meta.tag + '\0' + meta.sha256).digest('hex').slice(0, 16);
        if (!name.endsWith('.' + expectedKey + '.md')) continue; // not the deterministic auto-copy name
        const at = Date.parse(meta.archivedAt);
        entries.push({ archivePath, metaPath, source: archiveSourceFold(meta.sourcePath), at: Number.isFinite(at) ? at : 0 });
      } catch { /* no sidecar: not an automatic copy we own */ }
    }
    if (!entries.length) return;
    entries.sort((a, b) => (b.at - a.at) || String(b.archivePath).localeCompare(String(a.archivePath)));
    const keep = new Set();
    const perSource = new Map();
    for (const entry of entries) {
      const count = perSource.get(entry.source) || 0;
      if (count < AGENT_BEFORE_KEEP_PER_SOURCE) {
        perSource.set(entry.source, count + 1);
        if (keep.size < AGENT_BEFORE_KEEP_TOTAL) keep.add(entry.archivePath);
      }
    }
    // The caller is about to hand this path to the model. Never delete it, even
    // when an unusually large archive set has already filled the total cap.
    if (currentArchivePath) keep.add(currentArchivePath);
    for (const entry of entries) {
      if (keep.has(entry.archivePath)) continue;
      try { await fsUnlink(entry.archivePath); } catch { /* locked: leave it */ }
      try { await fsUnlink(entry.metaPath); } catch { /* locked: leave it */ }
    }
  }
  function archiveDirectory() {
    const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || homedir();
    return join(base, '.markpilot', 'draft-archive');
  }
  /**
   * Archive a draft/backup copy under the app data directory. Never writes near
   * the source document; the source path only drives naming and metadata. Used
   * to retire superseded recovery slots with a durable copy instead of silently
   * destroying the only surviving draft, and to snapshot the current text before
   * a recovery apply.
   */
  async function apiDocsArchive(payload, options = {}) {
    const rawPath = typeof payload?.path === 'string' ? payload.path : '';
    const text = payload?.text;
    const tag = typeof payload?.tag === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(payload.tag) ? payload.tag.toLowerCase() : 'draft';
    if (!rawPath || !isAbsolute(rawPath)) return badRequest('archive path must be absolute');
    if (typeof text !== 'string') return badRequest('archive text is required');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > ARCHIVE_MAX_BYTES) throw codedError('FS_ARCHIVE_TOO_LARGE', 'archive text exceeds limit');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dir = pathResolve(archiveDirectory());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stem = (basename(rawPath) || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 96) || 'document';
    // Deterministic archive name: the same source/tag/bytes always resolves to the
    // same file, so retrying after a lost reply can never duplicate the archive.
    const sourceKey = createHash('sha256').update(rawPath + '\0' + tag + '\0' + sha).digest('hex').slice(0, 16);
    const name = `${stem}.${tag}.${sourceKey}.md`;
    const target = join(dir, name);
    const existing = await readFile(target).then(buf => buf, error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && createHash('sha256').update(existing).digest('hex') === sha) {
      const metaPath = target + '.json';
      // Older releases could leave an archive without a sidecar. Repair it so
      // retention can account for the file and the returned metaPath exists.
      const meta = { schema: 1, sourcePath: rawPath, tag, archivedAt: new Date().toISOString(), sha256: sha, bytes: bytes.length,
        baseVersion: typeof payload?.baseVersion === 'string' ? payload.baseVersion : null,
        docToken: typeof payload?.docToken === 'string' ? payload.docToken : null };
      try { await readFile(metaPath); }
      catch { await writeFile(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8', flag: 'wx' }).catch(() => { /* concurrent writer */ }); }
      if (options.prune === true) try { await pruneTaggedArchives(dir, target, tag); } catch { /* retention is best effort */ }
      return { ok: true, value: { archivePath: target, metaPath, sha256: sha, bytes: bytes.length, idempotent: true } };
    }
    const temp = join(dir, `.mp-archive-${process.pid}-${randomUUID()}`);
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      try { await fsRename(temp, target); }
      catch (error) {
        // Two tabs can archive the same bytes concurrently; the loser's rename may
        // fail with EPERM/EEXIST on Windows while the winner wrote identical bytes.
        const current = await readFile(target).then(buf => buf, readError => { if (readError.code === 'ENOENT') return null; throw readError; });
        if (!current || createHash('sha256').update(current).digest('hex') !== sha) throw error;
      }
    } finally {
      await fsUnlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const meta = { schema: 1, sourcePath: rawPath, tag, archivedAt: new Date().toISOString(), sha256: sha, bytes: bytes.length,
      baseVersion: typeof payload?.baseVersion === 'string' ? payload.baseVersion : null,
      docToken: typeof payload?.docToken === 'string' ? payload.docToken : null };
    await writeFile(target + '.json', JSON.stringify(meta, null, 2), { encoding: 'utf8', flag: 'wx' }).catch(() => { /* metadata is best effort */ });
    if (options.prune === true) try { await pruneTaggedArchives(dir, target, tag); } catch { /* retention is best effort */ }
    return { ok: true, value: { archivePath: target, metaPath: target + '.json', sha256: sha, bytes: bytes.length } };
  }

  async function apiDocsCreate(payload) {
    if (payload && (Object.hasOwn(payload,'exactText') || Object.hasOwn(payload,'draftId'))) return createExactDraft(payload);
    const dir = typeof payload?.dir === 'string' ? payload.dir.trim() : '';
    const rawName = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const template = typeof payload?.template === 'string' ? payload.template : '';
    if (!dir) return badRequest('dir is required');
    if (!rawName) return badRequest('name is required');

    // 文件名清洗：拆掉路径分隔符与 Windows 非法字符，去掉尾部点，强制 .md
    let name = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim();
    if (!name) return badRequest('name is blank after sanitize');
    if (!/\.(md|markdown)$/i.test(name)) name += '.md';
    const stem = name.replace(/\.(md|markdown)$/i, '');
    const ext = name.slice(stem.length);

    try { await mkdir(dir, { recursive: true }); } catch (error) { throw codedError('MP_DIR_CREATE_FAILED', String(error?.message ?? error)); }

    const safeFile = hostModules?.safeFile;
    if (!safeFile || typeof safeFile.prepareFile !== 'function') {
      throw codedError('MP_SAFE_FILE_UNAVAILABLE', '安全写入模块不可用，拒绝裸写');
    }

    const body = (template || '').replace(/\{title\}/g, stem);
    const out = Buffer.from(body, 'utf8');
    const outHash = createHash('sha256').update(out).digest('hex');

    for (let attempt = 1; attempt <= 99; attempt += 1) {
      const candidate = attempt === 1 ? join(dir, name) : join(dir, `${stem} (${attempt})${ext}`);
      if (await fs.stat(await fs.resolve(candidate)).then(Boolean, () => false)) continue;   // 已存在 → 换序号
      const tmp = join(dir, '.mp-tmp-' + process.pid + '-' + randomUUID());
      let stage, primaryFailure;
      try {
        stage = await safeFile.prepareFile(candidate, tmp, { baseline: null, output: { bytes: out.length, sha256: outHash } });
        await writeFile(tmp, out, { flag: 'r+' });
        await stage.commit();
      } catch (error) {
        primaryFailure = error;
        // 并发抢名：别人刚建了同名 → 换序号重试；其余错误原样透出
        const taken = await fs.stat(await fs.resolve(candidate)).then(Boolean, () => false);
        if (taken) continue;
        throw error;
      } finally {
        try { await stage?.abort(); } catch (error) { if (primaryFailure) primaryFailure.cleanupError = String(error?.message ?? error); }
      }
      let displayPath = candidate, version;
      try {
        const target = await fs.resolve(candidate);
        const info = await fs.stat(target);
        if (target) displayPath = target.displayPath ?? candidate;
        if (info) version = info.version;
      } catch { /* 解析失败不影响"已创建"这个事实 */ }
      return { ok: true, value: { path: candidate, displayPath, version, safe: true } };
    }
    throw codedError('MP_FILE_EXISTS', 'too many files with the same name');
  }

  /* ── 最近打开：与 MarkPilot.EXE 共用同一份 MRU ────────────────────────
   * EXE 侧真源：%APPDATA%\MarkPilot\recents.json（shell/recents.js + main.js）。
   * 语义照抄 EXE：纯字符串数组、绝对路径、Windows 大小写不敏感去重、新的置顶、上限 10、
   * 原子写（临时文件 + rename；rename 失败先删再改名，应对杀软/索引器持有句柄）。
   * 这样 EXE 的「文件 → 最近打开」和插件的文档中心看到的是同一份清单。
   */
  const RECENT_LIMIT = 10;

  function recentsPath() {
    const base = process.env.APPDATA;
    return base ? join(base, 'MarkPilot', 'recents.json') : null;
  }

  function normalizeRecents(value, limit = RECENT_LIMIT) {
    const seen = new Set(); const out = [];
    for (const item of Array.isArray(value) ? value : []) {
      if (typeof item !== 'string' || !item.trim()) continue;
      let abs; try { abs = pathResolve(item); } catch { continue; }
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) continue;
      seen.add(key); out.push(abs);
      if (out.length >= limit) break;
    }
    return out;
  }

  function readRecents() {
    const file = recentsPath();
    if (!file) return [];
    try { return normalizeRecents(JSON.parse(readFileSync(file, 'utf8'))); } catch { return []; }
  }

  function writeRecents(list) {
    const file = recentsPath();
    if (!file) return false;
    const tmp = `${file}.dshtmp-${process.pid}-${randomUUID()}`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
      try { renameSync(tmp, file); }
      catch {
        try { rmSync(file, { force: true }); } catch { /* 目标可能本来就不在 */ }
        renameSync(tmp, file);
      }
      return true;
    } catch { try { rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响主流程 */ } return false; }
  }


  const workspaceRecentJobs = (globalThis[Symbol.for('dsh-markdown-editor-typora:workspace-recent-jobs')] ??= new Map());
  const workspaceRecentFile=()=>join(process.env.APPDATA || process.env.XDG_STATE_HOME || join(process.env.HOME || tmpdir(),'.local','state'),'MarkPilot','workspace-recents.json');
  const insideWorkspace=(cwd,file)=>{const rel=pathRelative(pathKey(cwd),pathKey(file));return rel==='' || (!rel.startsWith('..'+sep) && rel!=='..' && !isAbsolute(rel));};
  async function workspaceRecent(payload) {
    if(typeof payload.workspace!=='string' || !isAbsolute(payload.workspace))return badRequest('workspace must be an absolute directory');
    const cwd=await realpath(payload.workspace), dirInfo=await fsStat(cwd);
    if(!dirInfo.isDirectory())throw codedError('FS_NOT_DIRECTORY','workspace is not a directory');
    const wk=pathKey(cwd), op=payload.op || 'list';
    if(!['list','push','clear'].includes(op))return badRequest('unknown op');
    const work=async()=>{
      const file=workspaceRecentFile();let data={schema:1,workspaces:{}};
      try {data=JSON.parse(await readFile(file,'utf8'));if(data?.schema!==1 || !data.workspaces || typeof data.workspaces!=='object' || Array.isArray(data.workspaces))throw codedError('MP_RECENTS_FORMAT','workspace history is malformed');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      const saved=Object.hasOwn(data.workspaces,wk)?data.workspaces[wk]:null;
      if(saved!==null && !Array.isArray(saved))throw codedError('MP_RECENTS_FORMAT','workspace history entry is malformed');
      let migrated=[];
      if(saved===null && recentsPath()) {
        try {const legacy=JSON.parse(await readFile(recentsPath(),'utf8'));if(!Array.isArray(legacy))throw codedError('MP_RECENTS_FORMAT','legacy history is malformed');migrated=normalizeRecents(legacy).filter(p=>insideWorkspace(cwd,p));}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      let entries=saved || migrated;
      const valid=[];
      for(const p of normalizeRecents(entries,64)) {
        if(!insideWorkspace(cwd,p) || !/\.(md|markdown)$/i.test(p))continue;
        let canonical,info;
        try{canonical=await realpath(p);info=await fsStat(canonical);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')continue;throw error;}
        if(info.isFile()&&insideWorkspace(cwd,canonical)&&!valid.some(x=>pathKey(x)===pathKey(canonical)))valid.push(canonical);
      }
      let next=valid;
      if(op==='push') {
        if(typeof payload.path!=='string' || !isAbsolute(payload.path))return badRequest('workspace recent path must be absolute');
        const canonical=await realpath(payload.path), info=await fsStat(canonical);
        if(!info.isFile() || !/\.(md|markdown)$/i.test(canonical))throw codedError('FS_NOT_REGULAR_FILE','workspace recent is not a Markdown file');
        if(!insideWorkspace(cwd,canonical))return {ok:true,value:{items:valid,recorded:false}};
        next=[canonical,...valid.filter(x=>pathKey(x)!==pathKey(canonical))].slice(0,64);
      }else if(op==='clear')next=[];
      if(op!=='list' || saved===null || JSON.stringify(saved)!==JSON.stringify(next)) {
        // Most-recent workspace first; bounded metadata without touching document recovery.
        data={schema:1,workspaces:Object.fromEntries([[wk,next],...Object.entries(data.workspaces).filter(([key])=>key!==wk)].slice(0,128))};
        await mkdir(dirname(file),{recursive:true});const temp=file+'.tmp-'+randomUUID();
        try{await writeFile(temp,JSON.stringify(data),'utf8');await fsRename(temp,file);}
        finally{await fsUnlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      }
      return {ok:true,value:{items:next,workspace:cwd,recorded:op==='push'}};
    };
    const key=pathKey(workspaceRecentFile());
    const job=(workspaceRecentJobs.get(key)||Promise.resolve()).catch(()=>{}).then(work);workspaceRecentJobs.set(key,job);
    const done=()=>{if(workspaceRecentJobs.get(key)===job)workspaceRecentJobs.delete(key);};job.then(done,done);return job;
  }

  async function apiDocsRecent(payload) {
    if(payload && Object.hasOwn(payload,'workspace'))return workspaceRecent(payload);
    const op = typeof payload?.op === 'string' ? payload.op : 'list';
    if (op === 'list') {
      // 剔除已经不存在的条目并回写：过期 MRU 会让文档中心自动选中一份打不开的文件。
      const all = readRecents();
      const alive = all.filter((item) => { try { return existsSync(item); } catch { return false; } });
      if (alive.length !== all.length) writeRecents(alive);
      return { ok: true, value: { items: alive, pruned: all.length - alive.length } };
    }
    if (op === 'clear') { writeRecents([]); return { ok: true, value: { items: [] } }; }
    if (op === 'push') {
      const raw = typeof payload?.path === 'string' ? payload.path : '';
      if (!raw) return badRequest('path is required');
      let abs = '';
      try {
        const target = await fs.resolve(raw, resolveOptions(payload));
        abs = nativeTargetPath(target) || target.displayPath || pathResolve(raw);
      } catch { abs = pathResolve(raw); }
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      const rest = readRecents().filter((item) => (process.platform === 'win32' ? item.toLowerCase() : item) !== key);
      const next = normalizeRecents([abs, ...rest]);
      const persisted = writeRecents(next);
      return { ok: true, value: { items: next, persisted } };
    }
    return badRequest('unknown op');
  }

  async function apiStat(payload) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    if (!path) return badRequest('path is required');
    const target = await fs.resolve(path, resolveOptions(payload));
    const info = await fs.stat(target);
    if (!info) return { ok: true, value: { missing: true } };
    return { ok: true, value: { version: info.version, size: info.size, type: info.type, displayPath: target.displayPath } };
  }

  async function apiEdit(payload, invocation) {
    const path = typeof payload?.path === 'string' ? payload.path : '';
    const oldString = typeof payload?.oldString === 'string' ? payload.oldString : null;
    const newString = typeof payload?.newString === 'string' ? payload.newString : null;
    if (!path) return badRequest('path is required');
    if (oldString === null || newString === null) return badRequest('oldString and newString are required');
    if(!oldString)return badRequest('oldString must not be empty');
    const resolution=resolveOptions(payload, invocation);
    const target=await fs.resolve(path,resolution),key=pathKey(await canonicalTarget(target));
    return queueSave(key,async()=>{
      invocation?.signal?.throwIfAborted();
      const current=await fs.resolve(path,resolution);
      if(pathKey(await canonicalTarget(current))!==key)throw codedError('FS_STALE_VERSION','edit target changed while queued');
      if (payload.rejectIfMirror) await rejectDraftMirrorBeforeWrite(current);
      const opened=await apiOpen(payload,MODEL_TOOL,current,invocation),value=opened.value;
      if(!opened.ok)return opened;
      if (payload.rejectIfMirror) await rejectDraftMirrorBeforeWrite(current);
      if(payload.baseVersion&&payload.baseVersion!==value.version)throw codedError('FS_STALE_VERSION','file changed since read');
      const first=value.text.indexOf(oldString);
      if(first<0)throw codedError('FS_EDIT_NOT_FOUND','old_string was not found');
      if(payload.replaceAll!==true && value.text.includes(oldString,first+oldString.length))throw codedError('FS_AMBIGUOUS_EDIT','ambiguous edit');
      const write=()=>fs.editText(current,{oldString,newString,replaceAll:payload.replaceAll===true},{version:value.version},invocation?.signal,invocation?.policy);
      const native=await fsStat(nativeTargetPath(current),{bigint:true}).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      const result=native && versionOfBigInt(native)===String(value.version)
        ? await live.external(nativeTargetPath(current),write) : await write();
      broadcastChange(current,result.version,{oldString,newString});
      await rememberIdentity(current);
      return {ok:true,value:{version:result.version,displayPath:current.displayPath,changed:newString!==oldString}};
    });
  }

  async function dispatch(endpoint, payload, authority, execution) {
    try {
      let invocation;
      if (authority === MODEL_TOOL) {
        const session = execution?.agent?.session;
        let policy;
        if ((endpoint === 'edit' || endpoint === 'documents.applyEdits' || endpoint === 'documents.undoGroup' || endpoint === 'documents.merge3') && fs.sandboxMode !== undefined) {
          policy = await options.sandboxPolicy?.()?.resolve(session ? {session} : {});
          if (!policy?.mode) throw codedError('FS_SANDBOX_DENIED', 'Cannot resolve filesystem policy for this tool call');
        }
        invocation = {signal: execution?.signal, cwd: policy?.workspaceRoot ?? session?.header?.cwd, policy};
        invocation.signal?.throwIfAborted();
      }
      switch (endpoint) {
        case 'open': return await apiOpen(payload, authority, undefined, invocation);
        case 'save': return await apiSave(payload);
        case 'stat': return await apiStat(payload);
        case 'live': return authority === MODEL_TOOL ? badRequest('editor lease required') : await liveEndpoint(payload);
        case 'edit': return await apiEdit(payload, invocation);
        case 'documents.read':
          if (authority !== MODEL_TOOL) return badRequest('model tool authority required');
          return await documents.read(payload, invocation);
        case 'documents.applyEdits':
          if (authority !== MODEL_TOOL) return badRequest('model tool authority required');
          return await documents.applyEdits(payload, invocation, invocation?.policy);
        case 'documents.state':
          if (authority !== MODEL_TOOL) return badRequest('model tool authority required');
          if (typeof payload?.path !== 'string' || !payload.path) return await documents.state(payload, invocation);
          return await apiSession(payload, invocation, authority);
        case 'documents.reconcile':
          if (authority !== MODEL_TOOL) return badRequest('model tool authority required');
          return await documents.state(payload, invocation);
        case 'documents.recover':
          return await documents.recover(payload, invocation, invocation?.policy);
        case 'documents.discardRecovery':
          return await documents.discardRecovery(payload, invocation, invocation?.policy);
        case 'documents.undoGroup':
          return await documents.undoGroup(payload, invocation, invocation?.policy);
        case 'documents.reviewGroup':
          return await documents.reviewGroup(payload);
        case 'documents.reviewGroups':
          return await documents.reviewGroups(payload);
        case 'documents.undoGroups':
          return await documents.undoGroups(payload, invocation, invocation?.policy);
        case 'documents.conflictOpen':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.conflictOpen(payload, invocation);
        case 'documents.conflictResolve':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.conflictResolve(payload, invocation, invocation?.policy);
        case 'documents.conflictCancel':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.conflictCancel(payload);
        case 'documents.draftMirror':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.draftMirror(payload, invocation);
        case 'documents.draftRead':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.draftRead(payload, invocation);
        case 'documents.draftClear':
          if (authority === MODEL_TOOL) return badRequest('editor UI authority required');
          return await documents.draftClear(payload, invocation);
        case 'documents.merge3':
          if (authority !== MODEL_TOOL) return badRequest('model tool authority required');
          return await documents.merge3(payload, invocation, invocation?.policy);
        case 'docs/create': return await apiDocsCreate(payload);
        case 'docs/saveAs': return await apiSaveAs(payload, authority);
        case 'documents.fileState': if (authority === MODEL_TOOL) return badRequest('fileState is editor-only'); return await apiFileState(payload);
        case 'documents.locate': if (authority === MODEL_TOOL) return badRequest('locate is editor-only'); return await apiLocate(payload);
        case 'documents.session': if (authority === MODEL_TOOL) return badRequest('session is editor-only'); return await apiSession(payload, invocation, 'editor');
        case 'documents.recoveryList': if (authority === MODEL_TOOL) return badRequest('recoveryList is editor-only'); return await apiRecoveryList(payload);
        case 'documents.recoveryRead': if (authority === MODEL_TOOL) return badRequest('recoveryRead is editor-only'); return await apiRecoveryRead(payload);
        case 'documents.recoveryDiscard': if (authority === MODEL_TOOL) return badRequest('recoveryDiscard is editor-only'); return await apiRecoveryDiscard(payload);
        case 'docs/recent': return await apiDocsRecent(payload);
        case 'docs/archive':
          if (payload?.tag === 'agent-before' && authority !== MODEL_TOOL) return badRequest('model tool authority required');
          return await apiDocsArchive(payload, { prune: authority === MODEL_TOOL && payload?.tag === 'agent-before' });
        case 'diag': {
          lastDiag = { receivedAt: Date.now(), payload };
          // 诊断同时落盘一份，验收时用 PowerShell 直接读，不必开 DevTools、也不受接口鉴权影响。
          try { writeFileSync(join(tmpdir(), 'mp-diag.json'), JSON.stringify(lastDiag, null, 1), 'utf8'); } catch { /* 落盘失败不影响功能 */ }
          return { ok: true };
        }
        default: return badRequest(`unknown endpoint: ${String(endpoint)}`);
      }
    } catch (error) {
      const code = errorCode(error);
      try { log.warn?.('%s: %s failed (%s): %s', name, String(endpoint), code, String(error?.message ?? error)); } catch { /* 日志失败不影响响应 */ }
      const reason = error?.reason || (error?.code === 'MP_FILE_MISSING' ? 'missing' : undefined);
      return { ok: false, error: { code, message: String(error?.message ?? error), ...(reason ? { reason: String(reason) } : {}) } };
    } finally {
      if (SESSION_MUTATING_ENDPOINTS.has(endpoint)) invalidateSessions();
    }
  }

  /** 认证能力缺失时只告警一次；该宿主的全部请求都会 503，日志必须能定位。 */
  let authCapabilityWarned = false;
  function warnAuthCapabilityMissing() {
    if (authCapabilityWarned) return;
    authCapabilityWarned = true;
    try {
      log.warn?.('%s: host does not expose connection.requestRejection — file API fails closed (503 host-auth-unavailable); MarkPilot 1.3+ requires a host with connection authentication', name);
    } catch { /* 日志失败不影响拒绝 */ }
  }

  /**
   * 信任栅栏（fail-closed）：只信宿主 connection.requestRejection。
   *
   * 缺 connection 服务或该能力 = 认证不可用 ⇒ 一律 503，不再退回 loopback
   * Host/Origin 兜底放行（它在认证缺失时等于跳过鉴权）。1.3.0 起放弃对无该
   * 能力旧宿主的兼容：宁可插件不可用，也不放行未认证的文件读写。
   */
  function fenceStatus(req) {
    let connection;
    try { connection = connectionProvider(); } catch { connection = undefined; }
    if (!hostAuthCapability(connection)) {
      warnAuthCapabilityMissing();
      return { status: 503, code: 'host-auth-unavailable' };
    }
    let rejection;
    try {
      rejection = connection.requestRejection.call(connection, req);
    } catch {
      return { status: 403, code: 'forbidden' };
    }
    if (rejection === undefined) return undefined;
    if (rejection === 401) return { status: 401, code: 'unauthorized' };
    return { status: 403, code: 'forbidden' };
  }

  async function handleApiPost(req, res, url) {
    const endpoint = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '');
    if (!KNOWN_ENDPOINTS.has(endpoint)) {
      try { req.resume(); } catch { /* 已断 */ }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unsupported endpoint: ${String(endpoint)}` } });
      return;
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      try { req.resume(); } catch { /* 已断 */ }
      sendJson(res, 415, badRequest('content type must be application/json'));
      return;
    }
    const body = await readBody(req, bodyLimit);
    if (!body.ok) {
      const status = body.code === 'too-large' ? 413 : 400;
      sendJson(res, status, { ok: false, error: { code: body.code, message: body.code === 'too-large' ? `body exceeds ${bodyLimit} bytes` : 'body read failed' } }, { connection: 'close' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body.buffer.toString('utf8'));
    } catch {
      sendJson(res, 400, badRequest('body is not JSON'));
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, badRequest('body must be a JSON object'));
      return;
    }
    const result = await dispatch(endpoint, payload);
    sendJson(res, 200, result);
  }

  const route = {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const rejection = fenceStatus(req);
        if (rejection !== undefined) {
          if (typeof req.url === 'string' && req.url.startsWith(API_PREFIX)) {
            sendJson(res, rejection.status, {
              ok: false,
              error: {
                code: rejection.code,
                message: rejection.status === 503
                  ? 'host does not expose connection.requestRejection; MarkPilot 1.3+ requires a DSH host with connection authentication'
                  : rejection.code,
              },
            });
          } else {
            sendText(res, rejection.status, rejection.code);
          }
          return;
        }
        let url;
        try {
          url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        } catch {
          sendText(res, 400, 'bad request');
          return;
        }
        const pathname = url.pathname;
        const isRead = req.method === 'GET' || req.method === 'HEAD';

        if (isRead && pathname === CORE_JSON_PATH) {
          await serveCoreJson(req, res);
          return;
        }
        // 本地图片通道（文档相对路径图）：见 serveImageFile 上方注释。
        if (isRead && pathname.startsWith(IMG_PREFIX)) {
          await serveImageFile(req, res, pathname.slice(IMG_PREFIX.length));
          return;
        }
        if (isRead && pathname === STATIC_PREFIX.slice(0, -1)) {
          await serveStatic(req, res, 'index.html');
          return;
        }
        if (isRead && pathname.startsWith(STATIC_PREFIX)) {
          await serveStatic(req, res, pathname.slice(STATIC_PREFIX.length));
          return;
        }
        if (req.method === 'GET' && pathname === API_PREFIX + 'watch') {
          await handleWatch(req, res, url);
          return;
        }
        if (isRead && pathname === API_PREFIX + 'diag') {
          sendJson(res, 200, { ok: true, diag: lastDiag });
          return;
        }
        if (req.method === 'POST' && pathname.startsWith(API_PREFIX)) {
          await handleApiPost(req, res, url);
          return;
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `not found: ${pathname}` } });
      } catch (error) {
        const code = errorCode(error);
        try { log.warn?.('%s: request failed (%s): %s', name, code, String(error?.message ?? error)); } catch { /* 日志失败不影响响应 */ }
        if (!res.headersSent) sendJson(res, 200, { ok: false, error: { code, message: String(error?.message ?? error) } });
        else { try { res.end(); } catch { /* 已断 */ } }
      }
    },
  };

  function close() {
    closed=true;
    // 先放本 host 自己的资源（leases → SSE → watchers），再离场代际计数：
    // 已接纳的异步 save 排空后才可能触发旧代资源关闭（scheduleHostRetirement）。
    for(const client of leases.keys())releaseLive(client);
    for (const stream of liveStreams) {
      try { stream.res.end(); } catch { /* 已断 */ }
    }
    liveStreams.clear();
    for (const entry of watchers.values()) {
      entry.disposed = true;
      try { entry.controller.abort(); } catch { /* 已停 */ }
      if (entry.timer) clearInterval(entry.timer);
      if (entry.debounce) clearTimeout(entry.debounce);
      const closeFn = entry.close;
      entry.close = null;
      if (typeof closeFn === 'function') {
        Promise.resolve().then(() => closeFn()).catch(() => { /* close 失败不影响进程 */ });
      }
    }
    watchers.clear();
    unregisterHost(hostToken);   // 代际生命周期：最后一步离场；同代其它 host 不受影响
  }

  const hostToken = {};
  registerHost(hostToken);
  return { route, dispatch, close, broadcastChange, _internals: { watchers, liveStreams, lookupDocument, documents, fileIdentities } };
}

const WRITE_GUARD_DIRTY = 'MP_DOC_DIRTY';

function writeGuardError(code, path, detail) {
  const where = path ? `：${path}` : '';
  let message;
  if (code === 'MP_DOC_LOOKUP_FAILED') {
    message = `[${code}] MarkPilot 连续无法读取未保存状态，已拒绝写入以防覆盖${where}。请稍后重试；若持续失败，先保存并关闭编辑器。`;
  } else {
    message = `[${code}] 文件正在 MarkPilot 中打开且有未保存修改${where}。请先在编辑器中保存或丢弃，然后重试。`;
  }
  return Object.assign(new Error(detail || message), { code, path: String(path || '') });
}

/**
 * B2: refuse file-tool writes to documents with an unsaved MarkPilot draft,
 * and apply expected-version guards to clean open documents. Rooms are the
 * shared truth (cross-process); leases are intentionally not consulted.
 */
export function createWriteGuard({ fs, lookup, log, pluginName = 'markpilot-write-guard', failClosedThreshold = 3, fsSessionIntents = false } = {}) {
  const installed = new WeakSet();
  const warned = new Set();
  let lookupFailures = 0;
  const threshold = Number.isSafeInteger(failClosedThreshold) && failClosedThreshold > 0 ? failClosedThreshold : 3;
  function warn(operation, error) {
    const key = operation + '\0' + String(error?.message ?? error);
    if (warned.has(key)) return;
    warned.add(key);
    try { log?.warn?.('%s: %s guard fail-open: %s', pluginName, operation, String(error?.message ?? error)); } catch { /* 日志失败不影响 */ }
  }
  async function stateOf(target) {
    if (!target || typeof target !== 'object') return null;
    if (typeof target.targetKey !== 'string' && typeof target.displayPath !== 'string') return null;
    try { const state = await lookup(target); lookupFailures = 0; return state; }
    catch (error) {
      lookupFailures += 1;
      if (lookupFailures >= threshold) throw writeGuardError('MP_DOC_LOOKUP_FAILED', target.displayPath || target.targetKey || '');
      warn('lookup', error);
      return undefined;
    }
  }
  async function checked(target) {
    const state = await stateOf(target);
    if (!state) return { state: null, base: undefined };
    if (state.dirty) {
      const detail = state.mirror
        ? `[${WRITE_GUARD_DIRTY}] 文件存在 MarkPilot 草稿镜像（可能来自已关闭的编辑器）${state.path ? '：' + state.path : ''}。请先在编辑器中打开并处理该草稿，或清除镜像后再写。`
        : undefined;
      throw writeGuardError(WRITE_GUARD_DIRTY, state.path || target.displayPath || '', detail);
    }
    return { state, base: undefined };
  }
  async function currentVersion(state, target) {
    const info = await fs.stat(target);
    if (!info) return null; // clean room on a deleted file: let the tool decide (create may succeed)
    return String(info.version);
  }
  function install(ctx) {
    if (!ctx || typeof ctx.on !== 'function' || installed.has(ctx)) return () => {};
    installed.add(ctx);
    const disposers = [];
    if (fsSessionIntents && ctx.fs && typeof ctx.fs === 'object') {
      for (const method of ['writeText', 'editText', 'patchText', 'deleteFile', 'moveFile']) {
        const original = ctx.fs[method];
        if (typeof original !== 'function') continue;
        const hadOwn = Object.prototype.hasOwnProperty.call(ctx.fs, method);
        const wrapper = async function guardedFsSession(target, ...args) {
          const checked = method === 'moveFile' ? [target, args[0]] : [target];
          for (const candidate of checked) {
            const state = await stateOf(candidate);
            if (state && state.dirty) throw writeGuardError(WRITE_GUARD_DIRTY, state.path || candidate?.displayPath || candidate?.targetKey || '');
          }
          return original.call(this, target, ...args);
        };
        try { ctx.fs[method] = wrapper; }
        catch (error) {
          for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* best effort */ } }
          installed.delete(ctx);
          throw error;
        }
        disposers.push(() => {
          try {
            if (ctx.fs[method] !== wrapper) return;
            if (hadOwn) ctx.fs[method] = original;
            else delete ctx.fs[method];
          } catch { /* best effort */ }
        });
      }
    }
    const add = (event, handler) => {
      try {
        const dispose = ctx.on(event, handler, { prepend: true });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        try { log?.warn?.('%s: %s registration failed: %s', pluginName, event, String(error?.message ?? error)); } catch { /* 忽略 */ }
      }
    };
    add('fs/write-intent', async (target, _actor, next) => {
      const base = typeof next === 'function' ? await next() : undefined;
      const checkedState = await checked(target);
      if (!checkedState.state) return base;
      if (base !== undefined) return base; // never weaken another policy's intent
      const version = await currentVersion(checkedState.state, target);
      if (!version) return base;
      return { kind: 'replaceIfVersion', version };
    });
    add('fs/edit-intent', async (target, _actor, next) => {
      const base = typeof next === 'function' ? await next() : undefined;
      const checkedState = await checked(target);
      if (!checkedState.state) return base;
      if (base !== undefined) return base;
      const version = await currentVersion(checkedState.state, target);
      if (!version) return base;
      return { version };
    });
    add('fs/delete-intent', async (target, _actor, next) => {
      const base = typeof next === 'function' ? await next() : undefined;
      const checkedState = await checked(target);
      if (!checkedState.state) return base;
      if (base !== undefined) return base;
      const version = await currentVersion(checkedState.state, target);
      if (!version) return base;
      return { version };
    });
    return () => {
      for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* 已清理 */ } }
      installed.delete(ctx);
    };
  }
  return { install };
}

function safeGet(ctx, serviceName) {
  try {
    return ctx?.get?.(serviceName);
  } catch {
    return undefined;
  }
}

function safeLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger(name);
  } catch { /* 用 console */ }
  return console;
}

export function apply(ctx, config = {}) {
  const log = safeLogger(ctx);
  let fsService = safeGet(ctx, 'fs');
  if (!fsService) {
    try { fsService = ctx.fs; } catch { fsService = undefined; }
  }
  if (!fsService) {
    log.warn?.('%s: ctx.fs unavailable — plugin disabled', name);
    return;
  }

  // 兼容性检测（启动期）：connection 服务已就位但没有 requestRejection ⇒ 旧宿主。
  // 此时文件 API 会 fail-closed（503 host-auth-unavailable）；服务稍后才注册的场景
  // 由每次请求的 fenceStatus 兜底。1.3.0 起不再对这类宿主做 loopback 兼容。
  const startupConnection = safeGet(ctx, 'connection');
  if (startupConnection !== undefined && !hostAuthCapability(startupConnection)) {
    log.warn?.('%s: host connection service lacks requestRejection — file API will fail closed (503 host-auth-unavailable); MarkPilot 1.3+ requires connection authentication', name);
  }

  let host;
  try {
    host = createHost({
      fs: fsService,
      log,
      rootDir: PLUGIN_ROOT,
      sandboxPolicy: () => safeGet(ctx, 'sandboxPolicy'),
      connectionProvider: () => safeGet(ctx, 'connection'),
    });
  } catch (error) {
    log.warn?.('%s: host init failed: %s', name, String(error?.message ?? error));
    return;
  }

  // B2 write guard: shared rooms are only read (never created) from this path;
  // listeners are fiber-scoped and must no-op on hosts whose test ctx has no ctx.on.
  try {
    const guard = createWriteGuard({ fs: fsService, lookup: host._internals.lookupDocument, log, pluginName: name, fsSessionIntents: config?.fsSessionIntents === true });
    if (typeof ctx.effect === 'function') ctx.effect(() => guard.install(ctx), 'dsh-markdown-editor-typora: write guard');
    else guard.install(ctx);
  } catch (error) {
    log.warn?.('%s: write guard install failed: %s', name, String(error?.message ?? error));
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = ctx.webServer.register(host.route);
        log.info?.('%s: routes mounted on %s', name, ROUTE_PREFIX);
        return () => {
          try { if (typeof dispose === 'function') dispose(); } catch { /* 已清理 */ }
          try { host.close(); } catch { /* 已清理 */ }
        };
      }, 'dsh-markdown-editor-typora: routes');
    } else {
      ctx.webServer.register(host.route);
    }
  } catch (error) {
    log.warn?.('%s: route registration failed: %s', name, String(error?.message ?? error));
    try { host.close(); } catch { /* 已清理 */ }
    return;
  }

  // markdown 模型工具：Agent 的编辑入口（与编辑面 tab 同一守卫路径）。
  registerMarkdownTool(ctx, { dispatch: host.dispatch, log });
}

/**
 * markdown 工具定义（纯数据 + execute，不触达宿主）：便于测试/外部校验 defineTool 形态。
 * DSH 0.2.1 的 defineTool 需要 output.schema + output.render；0.2.0 的旧形态（顶层 render）会抛。
 */
export function createMarkdownToolDefinition(dispatch) {
  return {
    name: 'markdown',
    description: [
      '读写 Markdown（及任意文本）文件。read 返回“当前正文”——包含用户在 MarkPilot 编辑器里尚未保存的修改；',
      'edit 在“当前正文”上做字面 oldString→newString 原子替换。',
      '如果 edit 返回 saved:false，说明修改只进入编辑器缓冲区、还没有写到磁盘；不要声称文件已保存，用户会看到并决定何时保存。',
      '冲突纪律：MP_DOC_STALE 表示读取后正文又被改过——必须重新 read 拿新的 version（revision token）再重试，绝不沿用旧值；',
      'MP_DOC_EXTERNAL_CONFLICT / MP_DOC_ORPHAN_DRAFT 必须让用户先在编辑器里处理冲突或恢复草稿。',
      'MP_DOC_UNSAVED_ELSEWHERE 表示另一窗口有未保存修改，AI 不能改；请让用户先在那里保存。',
      'MP_BLOCK_NOT_FOUND 表示块 ID 已因正文变化失效——重新调用 blocks，绝不猜 ID。',
      '共享会话失效（MP_LIVE_*）或归档失败（MP_ARCHIVE_FAILED）时不要改用其它写工具，重新 read 或让用户重试。',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, description: 'read = 读当前正文；edit = 字面/整块替换；blocks = 列块 ID；batch = 原子多处编辑；merge3 = 三方合并；undo = 撤销最近一组 AI 编辑。', enum: ['read', 'edit', 'blocks', 'batch', 'merge3', 'undo'] },
      path: { type: 'string', required: true, description: '文件的绝对路径。' },
      cwd: { type: 'string', description: '可选：相对路径的解析基准目录。' },
      blockId: { type: 'string', description: 'action=edit 可选：从 blocks 结果拿到的 section ID；与 oldString 二选一。' },
      groupId: { type: 'string', description: 'action=undo 必填：edit 返回的 groupId。' },
      baseText: { type: 'string', description: 'action=merge3 必填：共同祖先正文。' },
      otherText: { type: 'string', description: 'action=merge3 必填：另一侧正文。' },
      edits: {
        type: 'array',
        description: 'action=batch 必填：按 from 升序、互不重叠的 {from,to,insert}。',
        items: {
          type: 'object',
          properties: {
            from: { type: 'number', required: true },
            to: { type: 'number', required: true },
            insert: { type: 'string', required: true },
          },
        },
      },
      oldString: { type: 'string', description: 'action=edit 必填：要替换的原文字面量（须唯一，除非 replaceAll）。' },
      newString: { type: 'string', description: 'action=edit 必填：替换后的文字面量。' },
      replaceAll: { type: 'boolean', description: 'action=edit 可选：替换所有出现（默认 false，最多 1000 处）。' },
      baseVersion: { type: 'string', description: '上次 read 返回的 version（revision token）；edit 应回传，过期则 MP_DOC_STALE。' },
      baseRevisionId: { type: 'string', description: '可选：与 baseVersion 等价的显式 revision token。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          readToken: { type: 'string' },
          blockId: { type: 'string' },
          groupId: { type: 'string' },
          undoOf: { type: 'string' },
          totalBlocks: { type: 'number' },
          truncated: { type: 'boolean' },
          clean: { type: 'boolean' },
          merged: { type: 'boolean' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                baseFrom: { type: 'number' },
                baseTo: { type: 'number' },
                base: { type: 'string' },
                ours: { type: 'string' },
                other: { type: 'string' },
              },
            },
          },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                ordinal: { type: 'number' },
                kind: { type: 'string' },
                level: { type: 'number' },
                title: { type: 'string' },
                from: { type: 'number' },
                to: { type: 'number' },
                textLength: { type: 'number' },
                preview: { type: 'string' },
              },
            },
          },
          applied: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'number' },
                to: { type: 'number' },
                insertedLength: { type: 'number' },
              },
            },
          },
          text: { type: 'string' },
          version: { type: 'string' },
          revisionId: { type: 'string' },
          displayPath: { type: 'string' },
          changed: { type: 'boolean' },
          source: { type: 'string' },
          dirty: { type: 'boolean' },
          saved: { type: 'boolean' },
          diskChanged: { type: 'boolean' },
          bufferOwnedElsewhere: { type: 'boolean' },
          unsavedElsewhere: { type: 'boolean' },
          writable: { type: 'boolean' },
          draft: { type: 'boolean' },
          mirrorDraft: { type: 'boolean' },
          draftStale: { type: 'boolean' },
          draftUnknown: { type: 'boolean' },
          checkpointPath: { type: 'string' },
          recoveryPath: { type: 'string' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              currentRevisionId: { type: 'string' },
              source: { type: 'string' },
              dirty: { type: 'boolean' },
              diskChanged: { type: 'boolean' },
              checkpointPath: { type: 'string' },
              draftStale: { type: 'boolean' },
              draftUnknown: { type: 'boolean' },
              reason: { type: 'string' },
            },
          },
        },
      },
      render: (args, value) => {
        if (value?.ok !== true) {
          return textBlock(`markdown ${String(args?.action ?? '')} 失败：${value?.error?.code ?? 'error'} — ${value?.error?.message ?? ''}`);
        }
        if (value.action === 'read') {
          const text = String(value.text ?? '');
          const head = text.length > 8000 ? `${text.slice(0, 8000)}\n…（共 ${text.length} 字符，已截断）` : text;
          const where = value.source === 'buffer' ? '编辑器缓冲区' : '磁盘';
          const dirty = value.dirty === true ? '，含未保存修改' : '';
          return textBlock(`${value.displayPath ?? ''}（${where}${dirty}）\nversion: ${String(value.version ?? '')}\n\n${head}`);
        }
        if (value.action === 'blocks') {
          const blocks = Array.isArray(value.blocks) ? value.blocks : [];
          const total = Number.isFinite(Number(value.totalBlocks)) ? Number(value.totalBlocks) : blocks.length;
          const lines = blocks.map((b) => `- ${b.id}  ${b.kind === 'heading' ? '#'.repeat(b.level) + ' ' : ''}${b.title}  (${b.textLength} 字符) ${b.preview ? '— ' + String(b.preview).slice(0, 80) : ''}`);
          return textBlock(`块列表：${value.displayPath ?? ''}（${blocks.length}/${total} 个）\nreadToken: ${String(value.readToken ?? value.version ?? '')}\n${lines.join('\n')}${value.truncated ? '\n…（仅显示前 200 个）' : ''}`);
        }
        if (value.action === 'merge3') {
          if (value.clean === false) {
            const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
            return textBlock(`未写入：三方合并发现 ${conflicts.length} 处冲突，需用户/调用方决定。\n` + conflicts.map((c) => `- base ${c.baseFrom}..${c.baseTo}: ours=${JSON.stringify(String(c.ours).slice(0, 80))} other=${JSON.stringify(String(c.other).slice(0, 80))}`).join('\n'));
          }
          return textBlock(`三方合并完成：${value.displayPath ?? ''}${value.changed === false ? '（无变化）' : ''}；${value.saved === true ? '已写盘' : '仅进入编辑器缓冲区，未写盘'}；新版本：${String(value.version ?? '')}${value.groupId ? '；groupId：' + value.groupId : ''}`);
        }
        if (value.action === 'batch') {
          const count = Array.isArray(value.applied) ? value.applied.length : 0;
          return textBlock(`已批量应用 ${count} 处编辑：${value.displayPath ?? ''}${value.changed === false ? '（内容未变）' : ''}；${value.saved === true ? '已写盘' : '仅进入编辑器缓冲区，未写盘'}；新版本：${String(value.version ?? '')}${value.groupId ? '；groupId：' + value.groupId : ''}`);
        }
        if (value.action === 'undo') {
          return textBlock(`已撤销 AI 编辑组：${value.undoOf ?? ''}；${value.saved === true ? '已写盘' : '仅进入编辑器缓冲区，未写盘'}；新版本：${String(value.version ?? '')}；撤销组：${String(value.groupId ?? '')}`);
        }
        const target = value.saved === true ? '已写盘' : '仅进入编辑器缓冲区，未写盘；请让用户确认后自行保存';
        const copy = value.checkpointPath ? `；改前副本：${value.checkpointPath}` : '';
        const recovery = value.recoveryPath ? `；恢复副本：${value.recoveryPath}` : '';
        const block = value.blockId ? `；块：${value.blockId}` : '';
        return textBlock(`已应用编辑：${value.displayPath ?? ''}${value.changed === false ? '（内容未变）' : ''}；${target}${block}${copy}${recovery}；新版本：${String(value.version ?? '')}${value.groupId ? '；groupId：' + value.groupId : ''}`);
      },
    },
    async execute(args, execution) {
      const action = args?.action === 'edit' ? 'edit' : args?.action === 'blocks' ? 'blocks'
        : args?.action === 'batch' ? 'batch' : args?.action === 'merge3' ? 'merge3'
          : args?.action === 'undo' ? 'undo' : 'read';
      try {
        if (action === 'read' || action === 'blocks') {
          const result = await dispatch('documents.read', { path: args?.path, cwd: args?.cwd }, MODEL_TOOL, execution);
          if (result.ok !== true) return { ok: false, action, error: result.error };
          const value = result.value;
          if (action === 'blocks') {
            const all = parseDocumentBlocks(String(value.text ?? ''));
            const blocks = all.slice(0, 200);
            return {
              ok: true, action, version: value.version, revisionId: value.revisionId, readToken: value.readToken || value.version,
              displayPath: value.displayPath, source: value.source, dirty: value.dirty === true,
              writable: value.writable !== false,
              ...(value.draft === true ? { draft: true } : {}),
              ...(value.mirrorDraft === true ? { mirrorDraft: true } : {}),
              ...(value.draftStale === true ? { draftStale: true } : {}),
              ...(value.draftUnknown === true ? { draftUnknown: true } : {}),
              blocks, totalBlocks: all.length, truncated: all.length > blocks.length,
            };
          }
          return {
            ok: true,
            action,
            text: value.text,
            version: value.version,
            revisionId: value.revisionId,
            readToken: value.readToken || value.version,
            displayPath: value.displayPath,
            source: value.source,
            dirty: value.dirty === true,
            writable: value.writable !== false,
            ...(value.draft === true ? { draft: true } : {}),
            ...(value.mirrorDraft === true ? { mirrorDraft: true } : {}),
            ...(value.draftStale === true ? { draftStale: true } : {}),
            ...(value.draftUnknown === true ? { draftUnknown: true } : {}),
            ...(typeof value.diskChanged === 'boolean' ? { diskChanged: value.diskChanged } : {}),
            ...(value.bufferOwnedElsewhere === true ? { bufferOwnedElsewhere: true } : {}),
            ...(value.unsavedElsewhere === true ? { unsavedElsewhere: true } : {}),
          };
        }
        if (action === 'merge3') {
          const result = await dispatch('documents.merge3', {
            path: args?.path, cwd: args?.cwd, baseText: args?.baseText, otherText: args?.otherText,
            baseRevisionId: args?.baseRevisionId ?? args?.baseVersion,
          }, MODEL_TOOL, execution);
          if (result.ok !== true) return { ok: false, action, error: result.error };
          const value = result.value;
          return {
            ok: true, action, clean: value.clean !== false, merged: value.merged === true,
            version: value.version, revisionId: value.revisionId, readToken: value.version,
            displayPath: value.displayPath, changed: value.changed === true, source: value.source,
            dirty: value.dirty === true, saved: value.saved === true,
            ...(Array.isArray(value.conflicts) ? { conflicts: value.conflicts } : {}),
            ...(value.groupId ? { groupId: value.groupId } : {}),
            ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
          };
        }
        if (action === 'batch') {
          const result = await dispatch('documents.applyEdits', {
            path: args?.path, cwd: args?.cwd, edits: args?.edits,
            baseVersion: args?.baseVersion, baseRevisionId: args?.baseRevisionId,
          }, MODEL_TOOL, execution);
          if (result.ok !== true) return { ok: false, action, error: result.error };
          const value = result.value;
          return {
            ok: true, action, version: value.version, revisionId: value.revisionId, readToken: value.version,
            displayPath: value.displayPath, changed: value.changed, source: value.source,
            dirty: value.dirty === true, saved: value.saved === true, applied: value.applied,
            groupId: value.groupId,
            ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
            ...(typeof value.recoveryPath === 'string' && value.recoveryPath ? { recoveryPath: value.recoveryPath } : {}),
          };
        }
        if (action === 'undo') {
          const result = await dispatch('documents.undoGroup', { path: args?.path, cwd: args?.cwd, groupId: args?.groupId }, MODEL_TOOL, execution);
          if (result.ok !== true) return { ok: false, action, error: result.error };
          const value = result.value;
          return {
            ok: true, action, version: value.version, revisionId: value.revisionId, readToken: value.version,
            displayPath: value.displayPath, changed: value.changed, source: value.source,
            dirty: value.dirty === true, saved: value.saved === true,
            groupId: value.groupId, undoOf: value.undoOf,
            ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
            ...(typeof value.recoveryPath === 'string' && value.recoveryPath ? { recoveryPath: value.recoveryPath } : {}),
          };
        }
        const result = await dispatch('documents.applyEdits', {
          path: args?.path,
          cwd: args?.cwd,
          blockId: args?.blockId,
          oldString: args?.oldString,
          newString: args?.newString,
          replaceAll: args?.replaceAll === true,
          baseVersion: args?.baseVersion,
          baseRevisionId: args?.baseRevisionId,
        }, MODEL_TOOL, execution);
        if (result.ok !== true) return { ok: false, action, error: result.error };
        const value = result.value;
        return {
          ok: true,
          action,
          version: value.version,
          revisionId: value.revisionId,
          readToken: value.version,
          displayPath: value.displayPath,
          changed: value.changed,
          source: value.source,
          dirty: value.dirty === true,
          saved: value.saved === true,
          ...(value.blockId ? { blockId: value.blockId } : {}),
          ...(value.groupId ? { groupId: value.groupId } : {}),
          ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
          ...(typeof value.recoveryPath === 'string' && value.recoveryPath ? { recoveryPath: value.recoveryPath } : {}),
        };
      } catch (error) {
        return { ok: false, action, error: { code: errorCode(error), message: String(error?.message ?? error), ...(error?.reason ? { reason: String(error.reason) } : {}) } };
      }
    },
  };
}

/**
 * The plugin is installed as an external package (junction/npm), so the bundled
 * `@deepseek-ai/dsh-tools` is not on its ESM resolution path. Convert the
 * author-facing DSL used by `createMarkdownToolDefinition` into the plain JSON
 * Schema a `tools.register()` definition accepts, and use it as a fallback when
 * `defineTool` cannot be imported.
 */
export function authorSchemaToRegistrySchema(node) {
  if (Array.isArray(node)) return node.map(authorSchemaToRegistrySchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && typeof value === 'boolean') continue; // collected by the parent property map
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {}, required = [];
      for (const [name, property] of Object.entries(value)) {
        properties[name] = authorSchemaToRegistrySchema(property);
        if (property?.required === true) required.push(name);
      }
      out.properties = properties;
      if (required.length) out.required = required;
      continue;
    }
    out[key] = authorSchemaToRegistrySchema(value);
  }
  return out;
}

export function createRegistryMarkdownToolDefinition(spec) {
  const parameters = authorSchemaToRegistrySchema({
    type: 'object', properties: spec.parameters, additionalProperties: false,
  });
  const outputSchema = authorSchemaToRegistrySchema(spec.output.schema);
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: { schema: outputSchema, render: spec.output.render },
    async execute(args, execution) { return spec.execute(args, execution); },
  };
}

/**
 * markpilot 模型工具（read/edit）：与编辑面 tab 同一守卫。加载失败只告警，不影响插件其它能力。
 */
export function registerMarkdownTool(ctx, { dispatch, log } = {}) {
  const onWarn = (error) => {
    try { log?.warn?.('dsh-markdown-editor-typora: model tool disabled: %s', String(error?.message ?? error)); } catch { /* 忽略 */ }
  };
  try {
    if (typeof ctx?.inject !== 'function') return;
    ctx.inject(['tools'], (sctx) => {
      try {
        const tools = sctx?.get?.('tools') ?? sctx?.tools;
        if (!tools || typeof tools.register !== 'function') {
          onWarn(new Error('Host tools.register is unavailable'));
          return;
        }
        sctx.effect(() => {
          let stopped = false;
          let dispose;
          Promise.resolve()
            .then(() => import('@deepseek-ai/dsh-tools'))
            .then((mod) => {
              if (stopped) return;
              const defineTool = mod?.defineTool;
              if (typeof defineTool !== 'function') throw new Error('Host defineTool is unavailable');
              const tool = defineTool(createMarkdownToolDefinition(dispatch));
              dispose = tools.register(tool);
            })
            .catch((error) => {
              if (stopped) return;
              try {
                const fallback = createRegistryMarkdownToolDefinition(createMarkdownToolDefinition(dispatch));
                dispose = tools.register(fallback);
                try { log?.info?.('dsh-markdown-editor-typora: markdown tool registered via schema fallback (%s)', String(error?.message ?? error)); } catch { /* 日志失败不影响 */ }
              } catch (fallbackError) {
                onWarn(new Error(String(fallbackError?.message ?? fallbackError) + ' / defineTool: ' + String(error?.message ?? error)));
              }
            });
          return () => {
            stopped = true;
            try { if (typeof dispose === 'function') dispose(); } catch (error) { onWarn(error); }
          };
        }, 'dsh-markdown-editor-typora: markdown tool');
      } catch (error) {
        onWarn(error);
      }
    });
  } catch (error) {
    onWarn(error);
  }
}

export default { name, inject, apply };
