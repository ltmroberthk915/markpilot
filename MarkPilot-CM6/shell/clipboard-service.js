'use strict';
/* MarkPilot-CM6/shell/clipboard-service.js — Electron 44 public-contract clipboard
 * adaptation (private proposal api44-fix-r1; not yet promoted into the candidate).
 *
 * Verified against v44.9.3 lib/browser/api/clipboard.ts (Root read): write() is an
 * async function that validates an Array of ClipboardItem-like entries (mime-keyed
 * objects whose values are strings or Blobs), awaits each Blob->Buffer, then commits
 * with a single native write. The wrapper is native-only (no renderer callbacks), so
 * awaiting it can never deadlock a sendSync-blocked renderer.
 *
 * Design (approved STRATEGY-R1 decisions):
 *  - One serialization lane for ALL native writes, in submission order: a late
 *    finishing old write can never overwrite a newer one. The lane holds ONLY the
 *    native write promise; immutable allowlisted items are built BEFORE enqueue.
 *  - At the lane head, caller-supplied synchronous guard() re-validates identity/
 *    frame/adopted; consume() and clipboard.write() are adjacent with no await in
 *    between. guard/consume run synchronously on the lane; nothing here ever waits
 *    on the renderer.
 *  - MIME allowlist exactly text/plain, text/html, image/png. image/png bytes come
 *    only from an already-validated NativeImage.toPNG() Buffer; arbitrary renderer
 *    keys are rejected, never passed through.
 *  - A failed write resolves {status:'failed'} and never poisons the tail; the next
 *    queued job still runs. No legacy Electron clipboard API emulation and no
 *    private native bindings (process._linkedBinding etc.) anywhere.
 *  - readInfo() preserves the historical {ok,hasImage,width,height,textLen} reply
 *    shape via await clipboard.read()/readText(): text length only (never content),
 *    image/png preferred then the first decodable image/* entry, dimensions measured
 *    with nativeImage, unknown/custom platform payloads ignored, reads capped. */
const ALLOWED_CLIPBOARD_MIME = Object.freeze(['text/plain', 'text/html', 'image/png']);
const READ_IMAGE_MIME_RE = /^image\//i;
const MAX_IMAGE_READ_BYTES = 64 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isBlobLike(v) {
  return !!v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number';
}
function looksLikePng(buf) {
  return Buffer.isBuffer(buf) && buf.length > PNG_MAGIC.length && PNG_MAGIC.every((b, i) => buf[i] === b);
}

function createClipboardService(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('clipboard-service: deps object required');
  const clipboard = deps.clipboard;
  const nativeImage = deps.nativeImage;
  const ClipboardItem = deps.ClipboardItem;
  if (!clipboard || typeof clipboard.write !== 'function' || typeof clipboard.read !== 'function'
    || typeof clipboard.readText !== 'function')
    throw new Error('clipboard-service: Electron 44 public clipboard API required (write/read/readText — only what the service actually uses)');
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function')
    throw new Error('clipboard-service: nativeImage.createFromBuffer required');
  if (typeof ClipboardItem !== 'function')
    throw new Error('clipboard-service: ClipboardItem constructor required (Electron 44 clipboard.write validates instanceof ClipboardItem)');
  const dbg = typeof deps.dbg === 'function' ? deps.dbg : () => { };
  const BlobCtor = deps.Blob || globalThis.Blob;

  let tail = Promise.resolve();
  let serial = 0;

  /* Build ONE immutable ClipboardItem carrying all copied flavors of this single
   * copy action ({'text/plain', 'text/html', 'image/png'} — strings or Blob), so
   * the native commit is a single atomic entry. v44.9.3 clipboard.ts validates
   * instanceof ClipboardItem; plain mime-keyed objects are NOT accepted and png
   * bytes come only from an already-validated NativeImage.toPNG() Buffer. */
  function buildItems(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'bad-input' };
    for (const k of Object.keys(input)) if (!['text', 'html', 'png'].includes(k)) return { ok: false, error: 'unknown-key:' + k };
    const data = {};
    if (input.text !== undefined) {
      if (typeof input.text !== 'string') return { ok: false, error: 'bad-text' };
      if (input.text) data['text/plain'] = input.text;
    }
    if (input.html !== undefined) {
      if (typeof input.html !== 'string') return { ok: false, error: 'bad-html' };
      if (input.html) data['text/html'] = input.html;
    }
    if (input.png !== undefined) {
      if (!looksLikePng(input.png)) return { ok: false, error: 'bad-png' };
      if (!BlobCtor) return { ok: false, error: 'blob-unavailable' };
      data['image/png'] = new BlobCtor([input.png], { type: 'image/png' });
    }
    if (!Object.keys(data).length) return { ok: false, error: 'empty' };
    let item;
    try { item = new ClipboardItem(data); }
    catch (e) { return { ok: false, error: 'clipboard-item-constructor:' + String((e && e.message) || e) }; }
    return { ok: true, items: Object.freeze([item]) };
  }

  /* job = { items, guard() -> 'ok'|'stale'|'adopted', consume() -> boolean, label }.
   * Outcomes: {status:'committed'} | {status:'canceled'} | {status:'failed',error}
   * | {status:'skipped',reason:'stale'|'adopted'} — skipped means the lane was
   * released WITHOUT writing or consuming; the caller decides (async arm: settle
   * adoption outside the lane, then re-enqueue; sync bridge/menu: terminal canceled).
   * B1 fix: guard, consume and the single clipboard.write share ONE try — a throw
   * from ANY of the three (including caller-side guard/consume logic) resolves as
   * {status:'failed'} instead of producing an unhandled rejection; the lane recovers
   * for the next job. consume() and clipboard.write() remain adjacent with no await
   * between them (consecutive statements in the same try). */
  function enqueueWrite(job) {
    if (!job || !Array.isArray(job.items) || !job.items.length) return Promise.resolve({ status: 'failed', error: 'no-items' });
    if (typeof job.guard !== 'function' || typeof job.consume !== 'function') return Promise.resolve({ status: 'failed', error: 'bad-job' });
    const id = ++serial;
    const run = tail.then(async () => {
      try {
        const g = job.guard();
        if (g !== 'ok') return { status: 'skipped', reason: g === 'adopted' ? 'adopted' : 'stale' };
        if (!job.consume()) return { status: 'canceled' };
        await clipboard.write(job.items);
        return { status: 'committed' };
      } catch (e) {
        dbg('clipboardService:write-failed', { id, label: job.label, error: String((e && e.message) || e) });
        return { status: 'failed', error: String((e && e.message) || e) };
      }
    });
    /* A rejected/failed write must never poison the tail: later jobs still run. */
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /* Resolves when every queued native write has settled (used by recent:test-copy-path
   * and by tests); never rejects. */
  function idle() {
    const t = tail;
    return t.then(() => undefined, () => undefined);
  }

  /* Historical clipboard:hasImage shape via the 44 public reads. Only lengths are
   * reported — clipboard content never leaves this function. */
  async function readInfo() {
    const out = { ok: true, hasImage: false, width: 0, height: 0, textLen: 0 };
    let text = '';
    try { text = await clipboard.readText(); } catch (e) { out.ok = false; out.error = String((e && e.message) || e); return out; }
    out.textLen = typeof text === 'string' ? text.length : 0;
    let items = [];
    try { items = await clipboard.read(); } catch (e) { out.ok = false; out.error = String((e && e.message) || e); return out; }
    if (!Array.isArray(items)) return out;
    /* Electron 44 public ClipboardItem read shape ONLY: item.types (array of mime
     * strings) + await item.getType(mime) -> Blob. No object-key enumeration, no
     * property access guessing formats, no invented data-URL objects. Prefer
     * image/png, then the first decodable image/* type. */
    let chosen = null;
    for (const it of items) {
      if (!it || !Array.isArray(it.types) || typeof it.getType !== 'function') continue;
      const mime = it.types.includes('image/png')
        ? 'image/png'
        : it.types.find((m) => READ_IMAGE_MIME_RE.test(String(m)));
      if (!mime) continue;
      try {
        const blob = await it.getType(mime);
        if (isBlobLike(blob)) { chosen = { mime, blob }; break; }
      } catch { /* unreadable entry is skipped, never an error reply */ }
    }
    if (!chosen) return out;
    try {
      if (chosen.blob.size > MAX_IMAGE_READ_BYTES) return out;
      const ab = await chosen.blob.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!buf.length || buf.length > MAX_IMAGE_READ_BYTES) return out;
      const img = nativeImage.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        out.hasImage = true; out.width = size.width; out.height = size.height;
      }
    } catch { /* unreadable image stays hasImage:false — never an error reply */ }
    return out;
  }

  return Object.freeze({ buildItems, enqueueWrite, idle, readInfo });
}

module.exports = Object.freeze({ createClipboardService, ALLOWED_CLIPBOARD_MIME });
