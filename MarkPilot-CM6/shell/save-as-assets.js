'use strict';
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { classify } = require('../export-folder');
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
const problem = (code, message) => Object.assign(new Error(message), { code });
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function identical(a, b) {
  const [x, y] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  return x.isFile() && y.isFile() && x.size === y.size && await digest(a) === await digest(b);
}
async function prepareSaveAsAssets({ sourcePath, filePath, text, canonical, current }) {
  const summary = { copied: 0, reused: 0, unavailable: 0 };
  if (!sourcePath || key(path.dirname(sourcePath)) === key(path.dirname(filePath))) return {summary};
  const { collectImageRefs } = require('./markdown-images');
  const check = () => { if (!current()) throw problem('MP_DOC_MISMATCH', '另存为的文档或窗口已改变'); };
  const jobs = [], seen = new Map();
  for (const raw of collectImageRefs(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(raw)) continue;
    const source = classify(raw, { docPath: sourcePath }), target = classify(raw, { docPath: filePath });
    if (source.kind !== 'local' || target.kind !== 'local') continue;
    check();
    try {
      const stat = await fsp.stat(source.abs);
      if (!stat.isFile()) { summary.unavailable++; continue; }
      await fsp.access(source.abs, fs.constants.R_OK);
    } catch (e) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code)) { summary.unavailable++; continue; }
      throw e;
    }
    const from = await canonical(source.abs), to = await canonical(target.abs);
    if (key(from) === key(to)) { summary.reused++; continue; }
    const prior = seen.get(key(to));
    if (prior) {
      if (key(prior.from) !== key(from) && !await identical(prior.from, from)) throw problem('MP_ASSET_CONFLICT', '另存为的图片路径冲突，请选择其他位置');
      continue;
    }
    const job = { from, to, target: target.abs }; seen.set(key(to), job); jobs.push(job);
  }
  // Serial exclusive copies keep memory bounded; this never runs on ordinary
  // Save/autosave or key input. Publish resources before the document receipt.
  for (const job of jobs) {
    check();
    if (key(await canonical(job.target)) !== key(job.to)) throw problem('MP_ASSET_TARGET', '另存为的图片位置已改变，请重新选择');
    check();
    await fsp.mkdir(path.dirname(job.to), { recursive: true });
    if (key(await canonical(job.target)) !== key(job.to)) throw problem('MP_ASSET_TARGET', '另存为的图片位置已改变，请重新选择');
    check();
    const tmp = path.join(path.dirname(job.to), '.mp-image-' + process.pid + '-' + crypto.randomUUID());
    try {
      await fsp.copyFile(job.from, tmp, fs.constants.COPYFILE_EXCL);
      job.sha256=await digest(tmp);
      check();
      if (key(await canonical(job.target)) !== key(job.to)) throw problem('MP_ASSET_TARGET', '另存为的图片位置已改变，请重新选择');
      check();
      try { await fsp.copyFile(tmp, job.to, fs.constants.COPYFILE_EXCL); summary.copied++; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (!await identical(tmp, job.to)) throw problem('MP_ASSET_CONFLICT', '另存为位置已有不同的图片，请选择其他位置');
        summary.reused++;
      }
    } finally { await fsp.unlink(tmp).catch(() => {}); }
  }
  check();
  return {summary,validate:async()=>{
    check();
    for(const job of jobs){
      if(key(await canonical(job.target))!==key(job.to)||await digest(job.to)!==job.sha256)
        throw problem('MP_ASSET_TARGET','另存为的图片位置或内容已改变，请重新选择');
    }
    check();
  }};
}
module.exports = { prepareSaveAsAssets };
