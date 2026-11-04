'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const encodedPart = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const tickets = new Map();
const relativeTarget = target => target && !/^(?:[a-z][a-z0-9+.-]*:|[/\\]{2}|[#?])/i.test(target);
const httpAddress = target => /^https?:/i.test(target);
const mailAddress = target => /^mailto:/i.test(target);
// Paired with the renderer's inlineableExternal: only http(s) links and
// images, and mailto links, may be inlined verbatim. file:, data:,,
// javascript:, OS-handler schemes, UNC paths and control characters are
// refused so nothing auto-effective crosses notes through the receipt.
const inlineableExternal = (target, head) => typeof head === 'string' && head.length > 0
  && !/[\u0000-\u001f\u007f]/.test(target)
  && (head.startsWith('!') ? httpAddress(target) : httpAddress(target) || mailAddress(target));
const anchorTarget = target => /^[?#]/.test(target);
// Canonical file identity for the private receipt only: the same directory is
// not the same document, and same-document pastes must stay verbatim. The
// identity never leaves this process — not the clipboard, not other tabs.
function canonicalFile(file) {
  try { return fs.realpathSync(file); } catch { return path.normalize(file); }
}

// The system clipboard carries only the opaque id. Never export the source
// note's path or retain the selected text in this process. Reference-style
// usages additionally carry the preserved `[text]` head and the definition
// title; both are slices of the already-trusted raw selection payload.
function rememberImageSource(file, {length, hash, refs, linewise = false}) {
  if (!file || !path.isAbsolute(file) || !Number.isSafeInteger(length) || !/^[0-9a-f]{64}$/.test(hash) ||
      !Array.isArray(refs) || !refs.length || refs.length > 4096) return null;
  const dir = path.dirname(file), base = pathToFileURL(dir + path.sep);
  const targets = [];
  let storedBytes = 0;
  for (const ref of refs) {
    if (!Number.isInteger(ref.from) || !Number.isInteger(ref.to) || ref.from < (targets.at(-1)?.to ?? 0) ||
        ref.from >= ref.to || ref.to > length || typeof ref.raw !== 'string' || ref.raw.length !== ref.to - ref.from ||
        typeof ref.target !== 'string') return null;
    // Verbatim refs keep an unfetchable remote/mailto URI exactly as copied
    // (http(s)/mailto only, paired with the renderer); anchor refs carry a
    // fragment-only destination that resolves against the source note's own
    // file at recover time. The two never combine.
    const verbatim = ref.verbatim === true;
    const anchor = ref.anchor == null ? null : ref.anchor;
    if (verbatim && anchor !== null) return null;
    if (anchor !== null && (typeof anchor !== 'string' || !anchorTarget(anchor) || anchor.length > 2048 || /[\r\n]/.test(anchor))) return null;
    if (verbatim && (!inlineableExternal(ref.target, ref.head) || ref.target.length > 2048 || /[\r\n]/.test(ref.target))) return null;
    if (!verbatim && anchor === null && !relativeTarget(ref.target)) return null;
    const head = ref.head == null ? null : ref.head;
    const title = ref.title == null || ref.title === '' ? null : ref.title;
    if (head !== null && (typeof head !== 'string' || head.length > 1024 || /[\r\n]/.test(head) || !ref.raw.startsWith(head))) return null;
    if (title !== null && (typeof title !== 'string' || title.length > 1024 || /[\r\n]/.test(title))) return null;
    storedBytes += Buffer.byteLength(ref.raw) + Buffer.byteLength(ref.target)
      + (anchor ? Buffer.byteLength(anchor) : 0)
      + (head ? Buffer.byteLength(head) : 0) + (title ? Buffer.byteLength(title) : 0);
    if (storedBytes > 512 * 1024) return null;
    let href = null;
    if (!verbatim && anchor === null) {
      const target = new URL(ref.target.replace(/\\/g, '/'), base);
      if (target.protocol !== 'file:') return null;
      href = target.href;
    }
    targets.push({from: ref.from, to: ref.to, raw: ref.raw, target: ref.target, href, head, title, verbatim, anchor});
  }
  const id = randomUUID();
  tickets.set(id, {dir, file: canonicalFile(file), targets, length, hash, linewise});
  if (tickets.size > 32) tickets.delete(tickets.keys().next().value);
  return id;
}

function recoverImageSource(file, id, length, hash) {
  const ticket = tickets.get(id);
  if (!ticket || length !== ticket.length || hash !== ticket.hash) return null;
  const changes = [];
  // A paste back into the same actual file is a local copy: verbatim bytes,
  // native history, no reconciliation. Same directory does NOT qualify.
  if (file && ticket.file === canonicalFile(file))
    return {changes, linewise: ticket.linewise, sameDocument: true};
  const dir = file && path.dirname(file);
  for (const ref of ticket.targets) {
    let address;
    if (ref.verbatim) {
      // The exact original remote URI: never rewritten, never fetched.
      address = ref.target;
    } else if (ref.anchor !== null) {
      // Fragment-only destinations keep their explicit origin — the anchor of
      // the source note itself — so a same-label local anchor cannot steal it.
      address = null;
      if (dir) try {
        const rel = path.relative(dir, ticket.file);
        if (rel && !path.isAbsolute(rel)) address = rel.split(path.sep).map(encodedPart).join('/') + ref.anchor;
      } catch { /* fall through to the absolute form */ }
      if (address === null) try { address = pathToFileURL(ticket.file).href + ref.anchor; } catch { continue; }
    } else {
      const url = new URL(ref.href);
      address = url.href;
      // Electron's display code accepts URL forms for which Node refuses to
      // create a filesystem path, e.g. malformed % and encoded separators.
      // Keep that exact origin URL and continue with its valid neighbors.
      if (dir) try {
        const rel = path.relative(dir, fileURLToPath(url));
        if (rel && !path.isAbsolute(rel)) address = rel.split(path.sep).map(encodedPart).join('/') + url.search + url.hash;
      } catch { /* Cross-volume and undecodable addresses can stay absolute. */ }
    }
    // Query and fragment portions can contain literal Markdown delimiters.
    address = address.replace(/[()'"<>]/g, encodedPart);
    // Both HTML attributes and Markdown destinations decode entities once.
    address = address.replace(/&/g, '&amp;');
    let insert = address;
    if (ref.head != null) {
      // A relocated reference-style usage becomes a self-contained inline
      // link: the `[text]` head is kept verbatim and the definition title
      // travels as Markdown, not as percent-encoded text — delimiters the
      // title does not use are chosen, and quotes/parens that must not break
      // the span are backslash-escaped.
      const body = ref.title ? ref.title.replace(/\\/g, '\\\\') : '';
      const delim = body.includes('"') && !body.includes("'") ? "'" : '"';
      const title = body ? ' ' + delim + body.replace(/["'()]/g, ch =>
        ch === delim || ch === '(' || ch === ')' ? '\\' + ch : ch) + delim : '';
      insert = ref.head + '(' + address + title + ')';
    }
    changes.push({from: ref.from, to: ref.to, raw: ref.raw, insert});
  }
  return {changes, linewise: ticket.linewise, sameDocument: false};
}
module.exports = {rememberImageSource, recoverImageSource};
