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
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { planDataImages } = require('./shell/data-images.cjs');

function* dataImageChunks(info) {
  if (info.base64) {
    let part = '';
    for (let i = 0; i < info.body.length; i += 32768) {
      part += info.body.slice(i, i + 32768).replace(/[ \t\r\n\f]/g, '');
      const complete = part.length - part.length % 4;
      if (complete) { yield Buffer.from(part.slice(0, complete), 'base64'); part = part.slice(complete); }
    }
    if (part) yield Buffer.from(part, 'base64');
    return;
  }
  let buffer = Buffer.allocUnsafe(32768), offset = 0;
  for (let i = 0; i < info.body.length; i++) {
    const c = info.body.charCodeAt(i);
    if (c === 37 || c < 128) {
      buffer[offset++] = c === 37 ? parseInt(info.body.slice(i + 1, i + 3), 16) : c;
      if (c === 37) i += 2;
      if (offset === buffer.length) { yield buffer; buffer = Buffer.allocUnsafe(32768); offset = 0; }
      continue;
    }
    const cp = info.body.codePointAt(i), piece = Buffer.from(String.fromCodePoint(cp));
    if (cp > 0xffff) i++;
    for (const byte of piece) {
      buffer[offset++] = byte;
      if (offset === buffer.length) { yield buffer; buffer = Buffer.allocUnsafe(32768); offset = 0; }
    }
  }
  if (offset) yield buffer.subarray(0, offset);
}

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
  const text = String(raw == null ? '' : raw).trim();
  const src = text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
  if (!src) return { kind: 'empty', src };
  if (/^data:/i.test(src)) return { kind: 'data', src };
  if (/^file:/i.test(src)) {
    let abs = null;
    try { abs = fileURLToPath(src); } catch { abs = null; }
    return abs ? local(abs, src) : { kind: 'remote', src };
  }
  if (/^\/\//.test(src)) return { kind: 'remote', src };
  if (path.isAbsolute(src) || isAbsWin(src)) return local(path.normalize(src), src);
  if (isExternal(src)) return { kind: 'remote', src };
  if (!docPath) return { kind: 'unresolved', src };
  try { return local(fileURLToPath(new URL(src.replace(/\\/g, '/'), pathToFileURL(path.dirname(docPath) + path.sep))), src); }
  catch { return { kind: 'unresolved', src }; }
}
function local(abs, src) {
  return { kind: 'local', src, abs, base: path.basename(abs.replace(/[\\/]+$/, '')) };
}

/**
 * 复制图片进 <dir>/assets/，返回映射表。
 * @returns {{assetsDir:string, entries:Array, copied:number, failed:number, skipped:number, bytes:number, ms:number}}
 */
async function prepareAssets({ dir, docPath, refs, concurrency = 4, onProgress, isCanceled, dataImages = false } = {}) {
  const t0 = Date.now();
  const dataPlans = dataImages ? planDataImages(refs) : null;
  const assetsDir = path.join(dir, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  const entries = [];
  const jobs = [];
  const byAbs = new Map();
  const keyOf = p => process.platform === 'win32' ? p.toLowerCase() : p;
  let skipped = 0;

  for (const raw of refs || []) {
    let info = classify(raw, { docPath });
    if (info.kind === 'data' && dataPlans) {
      const plan = dataPlans.get(info.src);
      info = { ...info, ...plan, base: 'image' + plan.ext };
      const seen = byAbs.get(info.src);
      if (seen) seen.consumers.push(String(raw));
      else { const job = { info, consumers: [String(raw)] }; byAbs.set(info.src, job); jobs.push(job); }
      continue;
    }
    if (info.kind !== 'local') {
      skipped++;
      entries.push({ src: String(raw), ok: false, skipped: true, reason: info.kind });
      continue;
    }
    try {
      const abs = await fsp.realpath(info.abs), key = keyOf(abs);
      const seen = byAbs.get(key);
      if (seen) { seen.consumers.push(String(raw)); continue; }
      const job = { info: { ...info, abs }, consumers: [String(raw)] };
      byAbs.set(key, job); jobs.push(job); // Reserve before any copying begins.
    } catch (error) { entries.push({ src: String(raw), ok: false, reason: 'copy-failed', error: error.message }); }
  }

  let cursor = 0, done = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      if (isCanceled?.()) return;
      const job = jobs[cursor++];
      const temp = path.join(assetsDir, '.mp-asset-' + crypto.randomUUID() + '.tmp');
      try {
        const inline = job.info.kind === 'data';
        const st = inline ? { size: job.info.bytes, isFile: () => true } : await fsp.stat(job.info.abs);
        if (isCanceled?.()) return;
        if (!st.isFile()) throw new Error('不是普通文件');
        const hash = crypto.createHash('sha256');
        await pipeline(inline ? Readable.from(dataImageChunks(job.info)) : fs.createReadStream(job.info.abs), new Transform({ transform(chunk, _encoding, next) {
          if (isCanceled?.()) return next(new Error('导出已取消'));
          hash.update(chunk); next(null, chunk);
        } }), fs.createWriteStream(temp, { flags: 'wx', flush: true }));
        if (!inline) {
          const after = await fsp.stat(job.info.abs);
          if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ino !== after.ino || st.dev !== after.dev) throw new Error('复制期间图片已改变');
        }
        const digest = hash.digest('hex'), ext = path.extname(job.info.base), stem = safeName(path.basename(job.info.base, ext), 'image');
        const target = stem + '-' + digest + (/^\.[a-z0-9]{1,10}$/i.test(ext) ? ext : '.bin');
        const targetAbs = path.join(assetsDir, target), rel = 'assets/' + encodeURIComponent(target); let reused = false;
        try { await fsp.link(temp, targetAbs); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(targetAbs)) existing.update(chunk);
          if (existing.digest('hex') !== digest) throw new Error('目标资源已存在且内容不符，未覆盖');
          reused = true;
        }
        for (const [index, raw] of job.consumers.entries()) entries.push({ src: raw, ok: true, rel, bytes: st.size, abs: job.info.abs, dedup: index > 0, reused });
      } catch (e) {
        for (const raw of job.consumers) entries.push({ src: raw, ok: false, kind: job.info.kind, reason: 'copy-failed', error: e && e.message ? e.message : String(e), abs: job.info.abs });
      } finally { await fsp.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      done++;
      if (onProgress) { try { onProgress({ done, total: jobs.length, name: job.info.base }); } catch { /* 进度回调不许影响导出 */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length || 1)) }, worker));
  if (isCanceled?.()) return { ok: false, canceled: true, assetsDir, entries };

  const copied = entries.filter((e) => e.ok && !e.dedup && !e.reused).length;
  const failed = entries.filter((e) => !e.ok && !e.skipped).length;
  const bytes = entries.reduce((n, e) => n + (e.ok && !e.dedup && !e.reused ? e.bytes : 0), 0);
  return { ok: true, assetsDir, entries, copied, failed, skipped, bytes, ms: Date.now() - t0 };
}

let seq = 0;
const htmlTargets = new Set();
const targetKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
function nextHtmlPath(dir, stem, start = 0) {
  for (let n = start; n < start + 10000; n++) {
    const file = path.join(dir, stem + (n ? '-' + n : '') + '.html');
    if (!fs.existsSync(file) && !htmlTargets.has(targetKey(file))) { htmlTargets.add(targetKey(file)); return { file, index: n }; }
  }
  throw new Error('导出目录中同名文件过多');
}
/** HTML 写流：**分块落盘**，调用方（渲染进程）不需要在内存里攒出整篇 HTML */
function createHtmlWriter({ dir, name } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(dir), stem = safeName(name, 'markpilot').replace(/(?:\.html?)+$/i, '') || 'markpilot';
  let reservation = nextHtmlPath(root, stem), file = reservation.file;
  const temp = path.join(root, '.mp-html-' + crypto.randomUUID() + '.tmp');
  const stream = fs.createWriteStream(temp, { encoding: 'utf8', flags: 'wx', flush: true });
  const closed = new Promise(resolve => stream.once('close', resolve));
  const opened = new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
    stream.once('close', () => reject(new Error('写流已关闭')));
  });
  stream.on('error', () => { /* write/end callbacks and opened own the failure. */ });
  opened.catch(() => { /* 由各方法 await 时抛出 */ });
  let bytes = 0, chunks = 0, finished = false, aborted = false, committed = false, committedInfo = null, finishing, aborting;
  const id = `exp-${process.pid}-${++seq}`;
  return {
    id, get file() { return file; },
    async write(text) {
      if (finished || aborted) throw new Error('写流已结束');
      await opened;
      if (finished || aborted) throw new Error('写流已结束');
      const s = String(text == null ? '' : text);
      bytes += Buffer.byteLength(s, 'utf8');
      chunks++;
      await new Promise((resolve, reject) => stream.write(s, (e) => (e ? reject(e) : resolve())));
      return { bytes, chunks };
    },
    finish() {
      return finishing ||= (async () => {
        if (aborted) throw new Error('写流已取消');
        finished = true;
        await opened;
        if (aborted) throw new Error('写流已取消');
        await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));
        await closed;
        if (aborted) throw new Error('写流已取消');
        // link creates the complete final file without replacing anything. If
        // another process wins this name, choose another name and try again.
        for (;;) {
          try { await fsp.link(temp, file); break; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            htmlTargets.delete(targetKey(file)); reservation = nextHtmlPath(root, stem, reservation.index + 1); file = reservation.file;
          }
        }
        committed = true; committedInfo = await fsp.stat(file); await fsp.unlink(temp); htmlTargets.delete(targetKey(file));
        return { ok: true, file, bytes, chunks };
      })();
    },
    abort({ remove = true } = {}) {
      if (aborting) return aborting;
      aborted = true;
      finished = true;
      stream.destroy();
      return aborting = (async () => {
        await closed;
        if (remove && !committed) {
          try { await fsp.unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        let removed = null;
        if (remove && committed && committedInfo) {
          const actual = await fsp.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
          if (actual && actual.ino === committedInfo.ino && actual.dev === committedInfo.dev && actual.size === committedInfo.size && actual.mtimeMs === committedInfo.mtimeMs) { await fsp.unlink(file); removed = file; }
        }
        htmlTargets.delete(targetKey(file));
        return { ok: true, ...(removed ? { removed } : committed ? { retained: file } : remove ? { removed: temp } : { retained: temp }) };
      })();
    },
  };
}

module.exports = { safeName, classify, prepareAssets, createHtmlWriter, isExternal };
