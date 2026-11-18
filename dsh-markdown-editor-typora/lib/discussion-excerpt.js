// Bounded excerpt of the *visible* conversation around an explicit
// "参考刚才的讨论 / 按前面的约定" edit request.
//
// Only direct human user text and model-published assistant text are eligible.
// Reasoning, tool calls/results, system prompt, runtime reminders, injected
// context, permission/approval traffic and unbounded transcripts never enter
// the excerpt. The excerpt starts at the most recent user message that shares a
// topic term with the current request and stops at the first later user message
// that is a different task, so an unrelated earlier task is not dragged in.
//
// The plugin's own isolated edit turns (persisted user instruction + assistant
// result) are excluded by their `mp-edit-` message ids / rpc ids.

const DEFAULTS = Object.freeze({
  candidateWindow: 18,
  maxMessages: 6,
  maxChars: 6000,
  perMessageChars: 1600,
  maxTerms: 24,
});

const INTERNAL_TEXT_PREFIXES = [
  '<system-reminder>',
  'The following information describes your current session',
  'Current runtime context',
];

const META_REFERENCE_PHRASES = [
  '参考', '参照', '刚才', '刚刚', '讨论', '对话', '交流', '前面', '之前', '上文', '前文',
  '以上', '上一轮', '上一条', '上一段', '前述', '此前', '约定', '继续', '沿用', '延续',
  '接续', '接着', '按照', '依照', '根据', '依据', '结合', '一下', '修改', '改成', '改一下',
  '这里', '这段', '内容', '要求', '方式', '格式', '说明', '意见', '结论', '方案', '安排',
  '说法', '回复', '答复', '评审', '上下文', '对照', '明确', '本条',
];

const SHORT_FOLLOW_UP = /^(?:继续|接着|好的?|嗯+|对|是的|然后|可以|行|谢谢|收到|明白)[。！？!?，,\s]*$/;

function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (block.text.length === 0) continue;
    parts.push(block.text);
  }
  return parts.join('\n');
}

function isInternalText(text) {
  const head = text.trimStart();
  for (const prefix of INTERNAL_TEXT_PREFIXES) if (head.startsWith(prefix)) return true;
  return false;
}

function isOwnEdit(message) {
  const id = typeof message?.id === 'string' ? message.id : '';
  if (id.startsWith('mp-edit-')) return true;
  const source = message && typeof message.source === 'object' ? message.source : {};
  return typeof source.rpcId === 'string' && source.rpcId.startsWith('mp-edit:');
}

/**
 * Project derived model messages to visible conversation turns.
 *
 * @param {readonly unknown[]} messages - `Session.deriveMessages()` output.
 * @returns {{ role: 'user' | 'assistant', text: string }[]}
 */
export function visibleDiscussionMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const source = message.source && typeof message.source === 'object' ? message.source : {};
    if (role === 'user' && source.kind !== 'user') continue;
    if (isOwnEdit(message)) continue;
    const text = textOfMessage(message);
    if (!text.trim()) continue;
    if (isInternalText(text)) continue;
    out.push({ role, text });
  }
  return out;
}

function cleanupQuery(query, maxChars) {
  let text = String(query || '');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  for (const phrase of META_REFERENCE_PHRASES) text = text.split(phrase).join(' ');
  return text;
}

function queryTerms(query, maxTerms) {
  const text = cleanupQuery(query, 8000).toLowerCase();
  const terms = new Set();
  for (const word of text.match(/[a-z0-9_]{2,}/g) || []) {
    terms.add(word);
    if (terms.size >= maxTerms) return [...terms];
  }
  const han = text.replace(/[^\u3400-\u9fff]/g, '');
  for (let i = 0; i + 1 < han.length; i += 1) {
    terms.add(han.slice(i, i + 2));
    if (terms.size >= maxTerms) break;
  }
  return [...terms];
}

function overlapScore(text, terms) {
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

function clip(text, limit) {
  if (text.length <= limit) return { text, clipped: false };
  return { text: text.slice(0, Math.max(0, limit - 1)) + '…', clipped: true };
}

/**
 * Build a bounded, topic-coherent excerpt of the recent visible discussion.
 *
 * The anchor is the most recent user message that shares a topic term with the
 * request (intent + selected text + file name), falling back to the most recent
 * matching message. Messages after the anchor are kept through the assistant
 * reply and a continuing same-topic exchange; the first later user message that
 * shares no topic term (and is not a short follow-up) ends the excerpt. No
 * matching topic means no excerpt rather than an unrelated task.
 *
 * @param {readonly unknown[]} messages - `Session.deriveMessages()` output.
 * @param {string} query - intent + selected text + file name.
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ text: string, count: number, truncated: boolean, matched: boolean }}
 */
export function extractDiscussionExcerpt(messages, query, options = {}) {
  const opts = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
  const visible = visibleDiscussionMessages(messages);
  if (!visible.length) return { text: '', count: 0, truncated: false, matched: false };

  const window = visible.slice(-Math.max(1, opts.candidateWindow));
  const terms = queryTerms(query, Math.max(1, opts.maxTerms));
  if (!terms.length) return { text: '', count: 0, truncated: false, matched: false };
  const scored = window.map((message, index) => ({
    ...message,
    index,
    score: overlapScore(message.text, terms),
  }));

  let anchor = -1;
  for (let i = scored.length - 1; i >= 0; i -= 1) {
    if (scored[i].role === 'user' && scored[i].score > 0) { anchor = i; break; }
  }
  if (anchor < 0) {
    for (let i = scored.length - 1; i >= 0; i -= 1) {
      if (scored[i].score > 0) { anchor = i; break; }
    }
    while (anchor > 0 && scored[anchor].role !== 'user') anchor -= 1;
  }
  if (anchor < 0) return { text: '', count: 0, truncated: false, matched: false };

  const selected = [];
  let sawAssistant = false;
  for (let i = anchor; i < scored.length; i += 1) {
    const message = scored[i];
    if (i > anchor && message.role === 'user' && message.score === 0 && sawAssistant
      && !SHORT_FOLLOW_UP.test(message.text.trim())) {
      break;
    }
    selected.push(message);
    if (message.role === 'assistant') sawAssistant = true;
    if (selected.length >= Math.max(1, opts.maxMessages)) break;
  }

  const bounded = [];
  let used = 0;
  let truncated = false;
  for (const message of selected) {
    const clipped = clip(message.text, Math.max(160, opts.perMessageChars));
    if (clipped.clipped) truncated = true;
    let text = clipped.text;
    if (used + text.length > opts.maxChars) {
      const remaining = Math.max(0, opts.maxChars - used);
      if (bounded.length && remaining < 160) { truncated = true; break; }
      text = clip(message.text, Math.max(80, remaining)).text;
      truncated = true;
    }
    bounded.push({ role: message.role, text });
    used += text.length;
    if (used >= opts.maxChars) { truncated = true; break; }
  }

  const text = bounded
    .map((message) => (message.role === 'user' ? '用户：' : '助手：') + message.text)
    .join('\n\n');
  return { text, count: bounded.length, truncated, matched: bounded.length > 0 };
}

export const DISCUSSION_EXCERPT_DEFAULTS = DEFAULTS;
