// Host-side model call for "AI 润色选区" (selection rewrite) in the DSH plugin.
//
// One selected passage goes to the host's official, tool-less model stream and
// exactly one replacement text comes back. The module is deliberately small and
// self-contained: it reads no user configuration, opens no chat or session, and
// sends no document, path, or conversation. The caller supplies the installed
// `ctx.llm` and the route the server already verified.
//
// Contract:
//   rewriteSelectedText({ llm, selection, text, signal })
//     llm        installed `ctx.llm` (requires `stream(options)`).
//     selection  server-verified `{ provider, model, reasoningEffort? }`.
//     text       the selected Markdown, exactly as captured.
//     signal     optional AbortSignal; a cancelled call never returns text.
//   returns { ok: true, text } | { ok: false, code, error }
//
// `code` is one of REWRITE_CODES, or the provider-neutral LLM failure code the
// host reported verbatim (`MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`,
// `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_REASONING_EFFORT`, ...), so callers
// never have to parse prose.
//
// Model semantics honored here (official StreamChunk protocol):
//   · every text-delta of one text block is concatenated in stream order;
//   · `block-end` carrying a text block is authoritative: its text replaces the
//     deltas, so a normal stream is never doubled;
//   · reasoning deltas, usage, and unknown future chunk kinds are not reply text;
//   · the terminal `finish` ends the read immediately (nothing after it counts):
//     `error`/`aborted` become failures, `max-tokens` is a truncated result and
//     is rejected instead of handing back half a rewrite, and `tool-calls` is
//     impossible for a request that offers no tools;
//   · a stream that ends without a terminal finish is a protocol failure.
//
// Size bounds are local and independent of any provider configuration: the
// selection may not exceed MAX_SELECTION_CHARS, and the streamed reply may not
// exceed a budget derived from it (a rewrite is about as long as its input).
// No maxTokens is sent: the adapter's configured output cap applies whenever the
// request omits one.

export const MAX_SELECTION_CHARS = 24_000;
export const MAX_REPLY_CHARS = 120_000;

const MIN_REPLY_CHARS = 4_096;
const REPLY_GROWTH = 8;
const MAX_ERROR_CHARS = 320;

const FRAME_OPEN = '<<<SELECTION';
const FRAME_CLOSE = 'SELECTION>>>';

export const REWRITE_CODES = Object.freeze({
  unavailable: 'MP_REWRITE_UNAVAILABLE',
  noModel: 'MP_REWRITE_NO_MODEL',
  badInput: 'MP_REWRITE_BAD_INPUT',
  emptyText: 'MP_REWRITE_EMPTY_TEXT',
  tooLong: 'MP_REWRITE_TOO_LONG',
  aborted: 'MP_REWRITE_ABORTED',
  stream: 'MP_REWRITE_STREAM',
  noFinish: 'MP_REWRITE_NO_FINISH',
  badFinish: 'MP_REWRITE_BAD_FINISH',
  truncated: 'MP_REWRITE_TRUNCATED',
  toolCalls: 'MP_REWRITE_TOOL_CALLS',
  emptyReply: 'MP_REWRITE_EMPTY_REPLY',
  replyTooLong: 'MP_REWRITE_REPLY_TOO_LONG',
  failed: 'MP_REWRITE_FAILED',
  internal: 'MP_REWRITE_INTERNAL',
});

export const SYSTEM_PROMPT = [
  '你是 Markdown 文本的润色助手。用户会给你一段选中的 Markdown 原文。',
  '任务：在不改变原意与事实的前提下，让这段文字更准确、简洁、通顺。',
  '硬性要求：',
  '1. 只返回润色后的 Markdown 文本本身；不要解释、不要前言、不要用代码围栏包裹。',
  '2. 保持原有的 Markdown 结构（标题层级、列表符号、强调标记、链接、行内代码、公式 $…$）。',
  '3. 不要增删列表项，不要改变引用块的层级。',
  '4. 保留原文的语言。',
  '5. 原文已经足够好时，原样返回原文。',
].join('\n');

/**
 * The one user message this request carries: the selection, framed, nothing else.
 * @param {string} text - the captured Markdown selection.
 * @returns {string}
 */
export function userMessageText(text) {
  return `${FRAME_OPEN}\n${text}\n${FRAME_CLOSE}`;
}

/**
 * Rewrite one selected Markdown passage through the host's model service.
 * @param {{
 *   llm?: unknown,
 *   selection?: { provider?: unknown, model?: unknown, reasoningEffort?: unknown },
 *   text?: unknown,
 *   signal?: AbortSignal,
 * }} [input]
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string, error: string }>}
 */
export async function rewriteSelectedText(input) {
  try {
    return await rewrite(input);
  } catch (error) {
    // The caller always gets a result object, even if something exotic throws
    // while reading a hostile argument or a malformed stream object.
    return fail(REWRITE_CODES.internal, errorMessage(error));
  }
}

async function rewrite(input) {
  const request = input !== null && typeof input === 'object' ? input : {};
  const llm = request.llm;
  const selection = request.selection !== null && typeof request.selection === 'object' ? request.selection : {};
  const text = request.text;
  const signal = request.signal;

  if (llm === null || (typeof llm !== 'object' && typeof llm !== 'function') || typeof llm.stream !== 'function') {
    return fail(REWRITE_CODES.unavailable, '宿主没有可用的模型服务：该安装版本的 ctx.llm 没有 stream');
  }
  // The route is exactly what the server verified: it is never trimmed,
  // aliased, or defaulted here. Only a blank route is refused up front.
  const provider = typeof selection.provider === 'string' ? selection.provider : '';
  const model = typeof selection.model === 'string' ? selection.model : '';
  if (!provider.trim() || !model.trim()) {
    return fail(REWRITE_CODES.noModel, '当前对话没有已核验的模型路由（provider/model），无法润色选区');
  }
  if (typeof text !== 'string') return fail(REWRITE_CODES.badInput, '选区内容不是文本');
  if (!text.trim()) return fail(REWRITE_CODES.emptyText, '请先选中要润色的文字');
  if (text.length > MAX_SELECTION_CHARS) {
    return fail(REWRITE_CODES.tooLong, `选区过长（${text.length} 字，上限 ${MAX_SELECTION_CHARS} 字），请分段润色`);
  }
  if (isAborted(signal)) return fail(REWRITE_CODES.aborted, '已取消');

  const effort = selection.reasoningEffort;
  const options = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessageText(text) }] }],
    system: SYSTEM_PROMPT,
    ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
    ...(signal === undefined || signal === null ? {} : { signal }),
  };

  return streamReply(llm, options, signal, replyBudget(text.length));
}

/**
 * Read one reply out of the official chunk stream and finalize it exactly once.
 * @param {{ stream: (options: object) => unknown }} llm
 * @param {object} options
 * @param {AbortSignal | undefined} signal
 * @param {number} budget - maximum reply characters.
 */
async function streamReply(llm, options, signal, budget) {
  let source;
  try {
    source = llm.stream(options);
  } catch (error) {
    return thrownFailure(error, signal);
  }
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')
    || typeof source[Symbol.asyncIterator] !== 'function') {
    return fail(REWRITE_CODES.stream, '宿主模型服务没有返回可读取的流');
  }

  let iterator;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch (error) {
    return thrownFailure(error, signal);
  }

  const parts = new Map();
  const order = [];
  let finish;
  let toolCall = false;
  let aborted = false;

  const part = (index) => {
    const key = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    let item = parts.get(key);
    if (item === undefined) {
      item = { text: '', closed: false };
      parts.set(key, item);
      order.push(key);
    }
    return item;
  };
  const total = () => {
    let chars = 0;
    for (const item of parts.values()) chars += item.text.length;
    return chars;
  };

  try {
    for (;;) {
      if (isAborted(signal)) { aborted = true; break; }
      const step = await nextChunk(iterator, signal);
      if (step === ABORTED) { aborted = true; break; }
      if (step === null || typeof step !== 'object' || step.done === true) break;
      const chunk = step.value;
      if (chunk === null || typeof chunk !== 'object') continue;

      switch (chunk.type) {
        case 'text-delta': {
          const item = part(chunk.index);
          if (!item.closed && typeof chunk.text === 'string' && chunk.text.length > 0) item.text += chunk.text;
          break;
        }
        case 'block-start': {
          if (chunk.blockType === 'text') part(chunk.index);
          else if (chunk.blockType === 'tool-call') toolCall = true;
          break;
        }
        case 'block-end': {
          const block = chunk.block;
          if (block === null || typeof block !== 'object') break;
          if (block.type === 'text') {
            const item = part(chunk.index);
            // A second block-end for one index is malformed (the official
            // assembler ignores it too), so it cannot rewrite a closed block.
            if (!item.closed) {
              if (typeof block.text === 'string') item.text = block.text;
              item.closed = true;
            }
          } else if (block.type === 'tool-call') {
            toolCall = true;
          }
          break;
        }
        case 'tool-call-delta':
          toolCall = true;
          break;
        case 'finish':
          finish = chunk.reason !== null && typeof chunk.reason === 'object' ? chunk.reason : { kind: 'invalid' };
          break;
        case 'reasoning-delta':
        case 'usage':
        default:
          // Not reply text. Unknown kinds are ignored so a host upgrade that
          // adds a chunk type cannot break this module.
          break;
      }

      if (total() > budget) {
        return fail(REWRITE_CODES.replyTooLong, `模型返回的内容过长（超过 ${budget} 字），已停止`);
      }
      if (finish !== undefined) break;
    }
  } catch (error) {
    return thrownFailure(error, signal);
  } finally {
    // The read is over on every path (result, failure, cancellation), so close
    // the source exactly once here.
    await closeIterator(iterator);
  }

  if (aborted) return fail(REWRITE_CODES.aborted, '已取消');
  if (finish === undefined) return fail(REWRITE_CODES.noFinish, '模型流结束但没有给出结束标记');

  switch (finish.kind) {
    case 'stop':
      break;
    case 'aborted':
      return fail(REWRITE_CODES.aborted, failureMessage(finish.failure) || '已取消');
    case 'error': {
      const code = failureCode(finish.failure);
      if (code === 'ABORTED') return fail(REWRITE_CODES.aborted, failureMessage(finish.failure) || '已取消');
      return fail(code || REWRITE_CODES.failed, failureMessage(finish.failure) || '模型调用失败');
    }
    case 'max-tokens':
      return fail(REWRITE_CODES.truncated, '模型输出达到长度上限，结果不完整，已放弃');
    case 'tool-calls':
      return fail(REWRITE_CODES.toolCalls, '模型返回了工具调用，本次润色不允许工具');
    default:
      return fail(REWRITE_CODES.badFinish, `模型流给出了无法识别的结束标记：${clipped(String(finish.kind))}`);
  }

  if (toolCall) return fail(REWRITE_CODES.toolCalls, '模型返回了工具调用，本次润色不允许工具');

  // Text blocks of one reply are joined the way the official session-title
  // consumer joins them. The reply itself is returned verbatim: no trimming, no
  // fence stripping, no "looks like the input" guessing — those belong to the
  // caller's review step, not to the transport.
  const reply = order
    .map((key) => parts.get(key).text)
    .filter((value) => value.length > 0)
    .join(' ');
  if (!reply.trim()) return fail(REWRITE_CODES.emptyReply, '模型没有返回可用的文字');
  return { ok: true, text: reply };
}

/** Reply budget for one selection: a rewrite is about as long as its input. */
function replyBudget(chars) {
  return Math.min(MAX_REPLY_CHARS, Math.max(MIN_REPLY_CHARS, chars * REPLY_GROWTH));
}

function isAborted(signal) {
  return signal !== null && typeof signal === 'object' && signal.aborted === true;
}

const ABORTED = Symbol('aborted');

/**
 * Await one chunk while honoring the caller's signal even if the provider does
 * not observe it: the read loses to cancellation, and the source is closed in
 * the `finally` of the caller so the request stops promptly.
 * @param {{ next: () => unknown }} iterator
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<unknown | typeof ABORTED>}
 */
async function nextChunk(iterator, signal) {
  if (isAborted(signal)) return ABORTED;
  const listening = signal !== null && typeof signal === 'object' && typeof signal.addEventListener === 'function';
  if (!listening) return await iterator.next();
  return await new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(iterator.next()).then(
      (value) => resolve(value),
      (error) => reject(error),
    ).finally(() => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* 已摘除 */ }
    });
  });
}

/** Close the source after the read so the provider request stops promptly. */
async function closeIterator(iterator) {
  if (iterator === null || typeof iterator !== 'object' || typeof iterator.return !== 'function') return;
  try {
    await iterator.return();
  } catch {
    // Already closed or closing failed; the read is over either way.
  }
}

function failureCode(failure) {
  return failure !== null && typeof failure === 'object' && typeof failure.code === 'string' && failure.code.length > 0
    ? failure.code
    : '';
}

function failureMessage(failure) {
  return failure !== null && typeof failure === 'object' && typeof failure.message === 'string' && failure.message.length > 0
    ? failure.message
    : '';
}

function thrownFailure(error, signal) {
  if (isAborted(signal) || (error !== null && typeof error === 'object' && error.name === 'AbortError')) {
    return fail(REWRITE_CODES.aborted, '已取消');
  }
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : '';
  if (code === 'ABORTED') return fail(REWRITE_CODES.aborted, errorMessage(error) || '已取消');
  return fail(code || REWRITE_CODES.stream, errorMessage(error) || '模型流读取失败');
}

function errorMessage(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return '未知错误';
  }
}

/** One-line, bounded diagnostic text; never carries the selection. */
function clipped(value) {
  let text;
  try {
    text = String(value === undefined || value === null ? '' : value);
  } catch {
    text = '未知内容';
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function fail(code, error) {
  return { ok: false, code: String(code), error: clipped(error) };
}
