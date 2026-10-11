/* 「导出为文件夹」的**主进程实现**（纯 Node，不依赖 electron —— 便于脱离壳层做基准测量）。
 *
 * 设计（对齐 Typora 的胜负手：图片**不内联**）：
 *   · 图片：逐张 fs 复制到 <目标>/assets/，HTML 里引用相对路径 —— 图片字节从不进渲染进程内存；
 *   · HTML：`createHtmlWriter` 用写流**逐块落盘**，渲染进程一次只持有一块（默认 256KB）；
 *   · 降级：单张复制失败 → 该条目 ok:false，HTML 保留原路径（不假装成功）；
 *   · 并发：复制并发 4（与 v2.3.3 的 embedImages 同量级，但读进来就写出去，不留副本）。
 */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const ILLEGAL = /[\\/:*?"<>|]/g;
/** Windows 文件名净化（导出目录名 / assets 里的文件名都过这里） */
function safeName(name, fallback = 'markpilot') {
  const s = String(name == null ? '' : name).replace(ILLEGAL, '_').replace(/[\r\n\t]/g, ' ').trim().replace(/[. ]+$/, '');
  return s.slice(0, 80) || fallback;
}
/** 外链/内联资源：不进 assets，原样保留 */
const isExternal = (s) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s);
const decode = (s) => { try { return decodeURI(s); } catch { return s; } };
const isAbsWin = (s) => /^[a-z]:[\\/]/i.test(s) || /^\\\\/.test(s);

/** 把 markdown 里的图片地址分类：local（可复制）/ remote（http、data:…）/ unresolved（相对路径但不知道基准目录） */
function classify(raw, { docPath } = {}) {
  const src = String(raw == null ? '' : raw).trim().replace(/^<|>$/g, '');
  if (!src) return { kind: 'empty', src };
  if (/^data:/i.test(src)) return { kind: 'data', src };
  if (/^file:/i.test(src)) {
    let abs = null;
    try { abs = fileURLToPath(src); } catch { abs = null; }
    return abs ? local(abs, src) : { kind: 'remote', src };
  }
  if (isExternal(src)) return { kind: 'remote', src };
  const decoded = decode(src).replace(/\//g, path.sep);
  if (path.isAbsolute(decoded) || isAbsWin(decoded)) return local(path.normalize(decoded), src);
  if (!docPath) return { kind: 'unresolved', src };
  return local(path.resolve(path.dirname(docPath), decoded), src);
}
function local(abs, src) {
  return { kind: 'local', src, abs, base: path.basename(abs.replace(/[\\/]+$/, '')) };
}

/**
 * 复制图片进 <dir>/assets/，返回映射表。
 * @returns {{assetsDir:string, entries:Array, copied:number, failed:number, skipped:number, bytes:number, ms:number}}
 */
async function prepareAssets({ dir, docPath, refs, concurrency = 4, onProgress } = {}) {
  const t0 = Date.now();
  const assetsDir = path.join(dir, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  const entries = [];
  const jobs = [];
  const byAbs = new Map();      // abs(小写) → { rel, bytes }：同一张图多处引用只复制一次
  const usedNames = new Map();  // target(小写) → abs(小写)：不同来源同名时加 -1/-2
  let skipped = 0;

  for (const raw of refs || []) {
    const info = classify(raw, { docPath });
    if (info.kind !== 'local') {
      skipped++;
      entries.push({ src: String(raw), ok: false, skipped: true, reason: info.kind });
      continue;
    }
    const key = info.abs.toLowerCase();
    const seen = byAbs.get(key);
    if (seen) { entries.push({ src: String(raw), ok: true, rel: seen.rel, bytes: seen.bytes, dedup: true }); continue; }
    // 目标文件名去重（同名不同源 → 追加 -1/-2）
    const ext = path.extname(info.base) || '';
    const stemRaw = safeName(path.basename(info.base, ext), 'image');
    let target = safeName(info.base, 'image' + ext);
    let n = 1;
    while (usedNames.has(target.toLowerCase()) && usedNames.get(target.toLowerCase()) !== key) {
      target = `${stemRaw}-${n++}${ext}`;
    }
    usedNames.set(target.toLowerCase(), key);
    jobs.push({ raw: String(raw), info, rel: 'assets/' + target, targetAbs: path.join(assetsDir, target) });
  }

  let cursor = 0, done = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const st = await fsp.stat(job.info.abs);
        if (!st.isFile()) throw new Error('不是普通文件');
        if (job.info.abs.toLowerCase() !== job.targetAbs.toLowerCase()) await fsp.copyFile(job.info.abs, job.targetAbs);
        byAbs.set(job.info.abs.toLowerCase(), { rel: job.rel, bytes: st.size });
        entries.push({ src: job.raw, ok: true, rel: job.rel, bytes: st.size, abs: job.info.abs });
      } catch (e) {
        entries.push({ src: job.raw, ok: false, reason: 'copy-failed', error: e && e.message ? e.message : String(e), abs: job.info.abs });
      }
      done++;
      if (onProgress) { try { onProgress({ done, total: jobs.length, name: job.info.base }); } catch { /* 进度回调不许影响导出 */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length || 1)) }, worker));

  const copied = entries.filter((e) => e.ok && !e.dedup).length;
  const failed = entries.filter((e) => !e.ok && !e.skipped).length;
  const bytes = entries.reduce((n, e) => n + (e.ok && !e.dedup ? e.bytes : 0), 0);
  return { ok: true, assetsDir, entries, copied, failed, skipped, bytes, ms: Date.now() - t0 };
}

let seq = 0;
/** HTML 写流：**分块落盘**，调用方（渲染进程）不需要在内存里攒出整篇 HTML */
function createHtmlWriter({ dir, name } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(name, 'markpilot') + '.html');
  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
  const opened = new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
  });
  opened.catch(() => { /* 由各方法 await 时抛出 */ });
  let bytes = 0, chunks = 0, finished = false;
  const id = `exp-${process.pid}-${++seq}`;
  return {
    id, file,
    async write(text) {
      await opened;
      if (finished) throw new Error('写流已结束');
      const s = String(text == null ? '' : text);
      bytes += Buffer.byteLength(s, 'utf8');
      chunks++;
      await new Promise((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())));
      return { bytes, chunks };
    },
    async finish() {
      await opened;
      if (!finished) {
        finished = true;
        await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));
      }
      return { ok: true, file, bytes, chunks };
    },
    async abort() {
      finished = true;
      try { stream.destroy(); } catch { /* 已关 */ }
      try { await fsp.unlink(file); } catch { /* 没建成就没有 */ }
      return { ok: true, removed: file };
    },
  };
}

module.exports = { safeName, classify, prepareAssets, createHtmlWriter, isExternal };
