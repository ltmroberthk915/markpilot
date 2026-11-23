import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const failure = message => ({ ok: false, error: { code: 'MP_ANSWER_UNAVAILABLE', message } });

export function createAnswerWriter({ directory, resolve, read, group, apply }) {
  const active = new Set();
  return async (key, write) => {
    if (!key || Object.keys(key).some(k => !['sessionId', 'turn', 'endSeq', 'answerSeq'].includes(k)) ||
        typeof key.sessionId !== 'string' || !key.sessionId || ![key.turn, key.endSeq, key.answerSeq].every(Number.isSafeInteger))
      return failure('这条回复的标识无效。');
    const offer = resolve(key);
    if (!offer) return failure('引用已变化，请使用当前对话中的回复。');
    const hex = createHash('sha256').update(JSON.stringify([key.sessionId, key.turn, key.endSeq, key.answerSeq, offer.path])).digest('hex');
    const groupId = [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20,32)].join('-');
    const folder = join(directory, 'answer-claims'), claim = join(folder, hex);
    const existing = async () => {
      const record = await group(offer.path, groupId);
      return record ? { ok: true, value: { path: offer.path, groupId, undoneAt: record.undoneAt ?? null } }
        : failure('这条回复已提交，尚无可确认的写入记录。');
    };
    if (existsSync(claim)) return existing();
    if (!write) return { ok: true, value: { path: offer.path } };
    if (active.has(claim)) return failure('这条回复正在写入。');
    active.add(claim);
    try {
      const doc = await read(offer.path, key);
      if (!doc.ok) return doc;
      if (doc.value.canonical !== offer.path || resolve(key)?.body !== offer.body) return failure('引用或回复已经变化。');
      mkdirSync(folder, { recursive: true });
      // An exclusive, durable claim also covers a crash between file save and
      // recording its undo group. Unknown outcomes cannot append a second copy.
      let fd;
      try { fd = openSync(claim, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return existing(); throw error; }
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const text = doc.value.text, separator = !text || /(?:\r?\n){2}$/u.test(text) ? '' : /[\r\n]$/u.test(text) ? '\n' : '\n\n';
      const check = () => {
        if (resolve(key)?.body !== offer.body) throw Object.assign(new Error('引用或回复已经变化。'), {code: 'MP_ANSWER_REVOKED'});
      };
      const result = await apply({ path: offer.path, position: 'end', baseRevisionId: doc.value.revisionId, newString: separator + offer.body }, key, {groupId, check});
      if (!result.ok) {
        if (result.error?.prewrite === true || ['MP_ANSWER_REVOKED', 'MP_DOC_STALE', 'FS_STALE_VERSION', 'FS_SANDBOX_DENIED',
            'MP_DOC_UNSAVED_ELSEWHERE', 'MP_DOC_ORPHAN_DRAFT', 'MP_DOC_EXTERNAL_CONFLICT', 'MP_DOC_MIRROR_READONLY'].includes(result.error?.code)) unlinkSync(claim);
        return result;
      }
      return existing();
    } finally { active.delete(claim); }
  };
}
