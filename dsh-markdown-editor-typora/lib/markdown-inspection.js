import { createHash } from 'node:crypto';

// Inspect the persisted bytes through the same filesystem provider as other
// model tools. The editor buffer can contain a different, unsaved revision.
export async function inspectMarkdownFile(fs, target, signal, decodeDocument) {
  const before = await fs.stat(target, signal);
  if (!before) throw Object.assign(new Error('文件不存在：' + target.displayPath), { code: 'FS_NOT_FOUND' });
  const bytes = Buffer.from(await fs.readBytes(target, signal, 8 * 1024 * 1024));
  const after = await fs.stat(target, signal);
  if (!after || before.version !== after.version || before.size !== bytes.length || after.size !== bytes.length) {
    throw Object.assign(new Error('磁盘文件在检查期间发生变化，请重新检查。'), { code: 'MP_DOC_STALE' });
  }
  const { text, encoding, bom } = decodeDocument(bytes, target.displayPath);
  const stride = encoding === 'utf8' ? 1 : 2;
  const unit = encoding === 'utf8' ? i => bytes[i] : encoding === 'utf16le'
    ? i => bytes.readUInt16LE(i) : i => bytes.readUInt16BE(i);
  let crlf = 0, cr = 0, lf = 0;
  for (let i = 0; i < bytes.length; i += stride) {
    const code = unit(i);
    if (code === 10) lf++;
    if (code !== 13) continue;
    if (i + stride < bytes.length && unit(i + stride) === 10) { crlf++; i += stride; }
    else cr++;
  }
  let lines = 0, h2 = 0, h3 = 0, tableDelimiterRows = 0, fencesOpened = 0, fencesClosed = 0;
  let fence = null;
  for (let start = 0; start < text.length;) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end < 0 ? text.length : end);
    start = end < 0 ? text.length : end + 1;
    lines++;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) {
        fence = null; fencesClosed++;
      }
      continue;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length, line: lines }; fencesOpened++; continue;
    }
    if (/^ {0,3}##(?:[ \t]|$)/.test(line)) h2++;
    if (/^ {0,3}###(?:[ \t]|$)/.test(line)) h3++;
    if (line.includes('|') && !/^(?: {4}|\t)/.test(line) &&
        /^:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*$/.test(line.trim().replace(/^\||\|$/g, '').trim())) tableDelimiterRows++;
  }
  let replacementCharacters = 0;
  for (let i = text.indexOf('\uFFFD'); i >= 0; i = text.indexOf('\uFFFD', i + 1)) replacementCharacters++;
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding, bom,
    crlf, lf, cr, lines, endsWithNewline: text.endsWith('\n'), replacementCharacters, h2, h3, tableDelimiterRows,
    fencesOpened, fencesClosed, unclosedFenceLine: fence?.line ?? null };
}
