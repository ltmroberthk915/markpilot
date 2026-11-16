// Context isolation for the MarkPilot "修改此处" (selection edit) submission.
//
// The client sends one normal Session prompt that carries a short-lived
// `mp-edit:<nonce>` marker. The host plugin claims that single submission in an
// `agent/pre-step` listener BEFORE the main loop builds its request:
//   · downstream pre-step hooks still run first (they may reject the step);
//   · only this plugin's marked submission is consumed; messages already
//     filtered by those hooks are never resurrected;
//   · the edit itself runs as an independent, history-free model call through
//     `ctx.llm.stream()` with only the edit payload (plus a bounded excerpt of
//     the *relevant* recent discussion when the user explicitly asked for it);
//   · the model's `markdown` tool call goes through the official
//     `ctx.tools.execute()` pipeline, so restrictions, `tools/pre-execute`,
//     approvals, timeouts and cancellation behave exactly like a normal
//     markdown call;
//   · the visible instruction and result are appended to the parent Session as
//     ordinary user/assistant surface messages, so they survive a refresh;
//   · the pre-step decision then enters the turn with no messages, so the
//     parent model is never called for this turn.
//
// No existing session log, checkpoint, or surface entry is rewritten. The
// parent conversation keeps its full history and ordinary chat still sees it.

import { randomUUID } from 'node:crypto';
import { extractDiscussionExcerpt } from './discussion-excerpt.js';

export const EDIT_RPC_PREFIX = 'mp-edit:';
export const EDIT_MARKER_PREFIX = '[[mp-edit:';
export const EDIT_ISOLATION_VERSION = 2;

const RECORD_TTL_MS = 10 * 60 * 1000;
const TERMINAL_TTL_MS = 2 * 60 * 1000;
const MAX_PAYLOAD_CHARS = 192 * 1024;
const MAX_TOOL_STEPS = 3;
const EDIT_TIMEOUT_MS = 4 * 60 * 1000;

const SYSTEM_PROMPT = 'Apply exactly one edit to the selected Markdown text with the markdown tool.';

const MARKDOWN_TOOL = Object.freeze({
  name: 'markdown',
  description: 'Read or replace the captured Markdown selection through the editor authority.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['editSelection', 'readSelection'] },
      path: { type: 'string', description: 'Absolute path of the edited document.' },
      selectionId: { type: 'string', description: 'Host capture id shown in the user message.' },
      newString: { type: 'string', description: 'Complete replacement text for a single-range selection.' },
      replacements: {
        type: 'array',
        items: { type: 'string' },
        description: 'One replacement per captured range, in original order.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
});

function nowMs(now) {
  return typeof now === 'function' ? now() : Date.now();
}

function coded(code, message, details) {
  const error = { code: String(code || 'MP_EDIT_FAILED'), message: String(message || '修改失败') };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

function failureOf(result, fallbackCode, fallbackMessage) {
  const error = result && typeof result === 'object' ? result.error : null;
  if (error && typeof error === 'object') {
    return {
      ok: false,
      error: {
        code: typeof error.code === 'string' && error.code ? error.code : fallbackCode,
        message: typeof error.message === 'string' && error.message ? error.message : fallbackMessage,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return coded(fallbackCode, fallbackMessage);
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

function contentText(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n');
}

function markerNonce(message) {
  if (!message || message.role !== 'user') return '';
  const source = message.source && typeof message.source === 'object' ? message.source : {};
  if (typeof source.rpcId === 'string' && source.rpcId.startsWith(EDIT_RPC_PREFIX)) {
    return source.rpcId.slice(EDIT_RPC_PREFIX.length);
  }
  return '';
}

/**
 * Identify candidate markers. A request-id marker is ours by construction; a
 * text-only marker is only ours when it exactly matches a held record's
 * payload, so forged `[[mp-edit:...]]` user text is left alone.
 *
 * @param {object} message - claimed user message.
 * @returns {{ nonce: string, via: 'rpc' | 'text', text?: string } | null}
 */
function markerInfo(message) {
  if (!message || message.role !== 'user') return null;
  const source = message.source && typeof message.source === 'object' ? message.source : {};
  if (typeof source.rpcId === 'string' && source.rpcId.startsWith(EDIT_RPC_PREFIX)) {
    return { nonce: source.rpcId.slice(EDIT_RPC_PREFIX.length), via: 'rpc' };
  }
  const text = messageText(message);
  if (!text.startsWith(EDIT_MARKER_PREFIX)) return null;
  const end = text.indexOf(']]\n');
  if (end < 0) return null;
  return { nonce: text.slice(EDIT_MARKER_PREFIX.length, end), via: 'text', text };
}

function markerText(nonce) {
  return EDIT_MARKER_PREFIX + nonce + ']]\n';
}

function clipText(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)) + '…';
}

function referenceBlock(excerpt) {
  return ['【参考材料：刚才的讨论（节选）】', excerpt.text].join('\n');
}

function lineSpan(record) {
  if (!Number.isSafeInteger(record.lineStart) || record.lineStart <= 0) return '';
  const end = Number.isSafeInteger(record.lineEnd) && record.lineEnd > record.lineStart ? record.lineEnd : record.lineStart;
  return ` · 第 ${record.lineStart}${end !== record.lineStart ? '–' + end : ''} 行`;
}

function instructionText(record) {
  const preview = clipText(record.selectionText, 400);
  return [
    `修改此处：${record.displayPath || record.path}${lineSpan(record)}`,
    '',
    record.intent,
    ...(preview ? ['', '选中内容（节选）：', preview] : []),
  ].join('\n');
}

function successText(record, outcome) {
  const value = outcome.value && typeof outcome.value === 'object' ? outcome.value : {};
  const modelText = typeof outcome.text === 'string' ? outcome.text.trim() : '';
  const changed = value.changed === false ? '内容没有变化' : '已完成修改';
  const head = modelText || `${changed}（${record.displayPath || record.path}${lineSpan(record)}）。`;
  const note = value.saved === true
    ? '修改已写盘。'
    : '修改已进入编辑器缓冲区，尚未写盘；可在编辑器中查看差异、撤销或保留保存。';
  return `${head}\n\n${note}`;
}

function failureText(error) {
  const message = error && (error.message || error.code) ? String(error.message || error.code) : '未知原因';
  return `修改失败：${message}。可在编辑器中确认当前内容，或重试。`;
}

function cancelText() {
  return '已停止修改；请在编辑器中确认当前内容。';
}

/** Abort when any of the supplied signals is cancelled. */
function combinedSignal(...signals) {
  const present = signals.filter((signal) => signal && typeof signal.addEventListener === 'function');
  if (!present.length) return undefined;
  for (const signal of present) if (signal.aborted) return signal;
  if (present.length === 1) return present[0];
  const controller = new AbortController();
  const abort = () => {
    try {
      const reason = present.find((signal) => signal.aborted)?.reason;
      controller.abort(reason);
    } catch { controller.abort(); }
  };
  for (const signal of present) signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/**
 * Create the host-side edit isolation service.
 *
 * @param {{
 *   ctx: object,
 *   documents?: object,
 *   log?: object,
 *   now?: () => number,
 *   uuid?: () => string,
 * }} options
 */
export function createEditIsolation(options = {}) {
  const ctx = options.ctx;
  const log = options.log ?? console;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const uuid = typeof options.uuid === 'function' ? options.uuid : randomUUID;
  const records = new Map();
  let installed = false;

  function getService(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  function recordFor(nonce) {
    return records.get(String(nonce || '')) || null;
  }

  function prune() {
    const at = nowMs(now);
    for (const [nonce, record] of records) {
      if (record.expiresAt > at) continue;
      if (record.status === 'held' || record.status === 'running') {
        record.status = 'expired';
        record.error = { code: 'MP_EDIT_EXPIRED', message: '修改请求已超时' };
        record.endedAt = at;
        record.expiresAt = at + TERMINAL_TTL_MS;
        try { record.controller.abort(new Error('edit-expired')); } catch { /* 已停 */ }
        continue;
      }
      records.delete(nonce);
    }
  }

  function activeForSession(sessionId) {
    prune();
    for (const record of records.values()) {
      if (record.sessionId !== String(sessionId || '')) continue;
      if (record.status === 'held' || record.status === 'running') return record;
    }
    return null;
  }

  function finish(record, status, value, error) {
    if (!record) return;
    record.status = status;
    if (value !== undefined) record.result = value;
    if (error !== undefined) record.error = error;
    record.endedAt = nowMs(now);
    record.expiresAt = record.endedAt + TERMINAL_TTL_MS;
    if (status === 'cancelled') {
      try { record.controller.abort(error || new Error('edit-cancelled')); } catch { /* 已停 */ }
    }
  }

  async function prepare(payload) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    const path = typeof payload?.path === 'string' ? payload.path.trim() : '';
    if (!sessionId) return coded('MP_EDIT_INVALID', '缺少目标会话');
    if (!path) return coded('MP_EDIT_INVALID', '缺少文档路径');
    const intent = typeof payload?.intent === 'string' ? payload.intent.trim() : '';
    if (!intent) return coded('MP_EDIT_INTENT_REQUIRED', '请先填写修改要求');
    const active = activeForSession(sessionId);
    if (active) {
      return coded('MP_EDIT_BUSY', '当前对话已有一个修改请求在进行中；请等它完成或先停止它');
    }
    let captured;
    try {
      captured = await options.documents?.captureSelection?.({
        protocol: 2,
        path,
        sessionId,
        docToken: payload?.docToken,
        baseVersion: payload?.baseVersion,
        live: payload?.live,
        originRevision: payload?.originRevision,
        origin: payload?.origin,
        docLength: payload?.docLength,
        lineStart: payload?.lineStart,
        lineEnd: payload?.lineEnd,
        capturedAt: payload?.capturedAt,
        ranges: payload?.ranges,
      });
    } catch (error) {
      return coded('MP_EDIT_CAPTURE_FAILED', String(error?.message || error));
    }
    if (!captured || captured.ok !== true) return failureOf(captured, 'MP_EDIT_CAPTURE_FAILED', '选区已失效');
    const selectionId = captured.value && typeof captured.value.selectionId === 'string' ? captured.value.selectionId : '';
    if (!selectionId) return coded('MP_EDIT_CAPTURE_FAILED', '宿主没有返回选区标识');
    const ranges = Array.isArray(payload?.ranges) ? payload.ranges : [];
    const selectionText = ranges.map((range) => String(range?.text ?? '')).join('\n');
    const nonce = uuid();
    const createdAt = nowMs(now);
    const lineStart = Number.isSafeInteger(payload?.lineStart) ? payload.lineStart : 0;
    const lineEnd = Number.isSafeInteger(payload?.lineEnd) ? payload.lineEnd : lineStart;
    const record = {
      nonce,
      rpcId: EDIT_RPC_PREFIX + nonce,
      sessionId,
      path,
      displayPath: typeof payload?.displayPath === 'string' && payload.displayPath ? payload.displayPath : path,
      intent,
      selectionText,
      lineStart,
      lineEnd,
      explicitReference: payload?.explicitReference === true,
      selectionId,
      status: 'held',
      armed: false,
      payload: '',
      meta: null,
      result: null,
      error: null,
      createdAt,
      startedAt: null,
      endedAt: null,
      expiresAt: createdAt + RECORD_TTL_MS,
      turn: null,
      provider: '',
      model: '',
      persistedUser: false,
      persistedAssistant: false,
      persistError: null,
      controller: new AbortController(),
    };
    records.set(nonce, record);
    return {
      ok: true,
      value: {
        nonce,
        rpcId: record.rpcId,
        marker: markerText(nonce),
        selectionId,
        explicitReference: record.explicitReference,
        expiresAt: record.expiresAt,
      },
    };
  }

  async function arm(payload) {
    const record = recordFor(payload?.nonce);
    if (!record) return coded('MP_EDIT_EXPIRED', '修改请求已失效');
    if (record.status !== 'held') return coded('MP_EDIT_USED', '修改请求已被处理');
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text.trim()) return coded('MP_EDIT_INVALID', '修改指令为空');
    if (text.length > MAX_PAYLOAD_CHARS) return coded('MP_EDIT_INVALID', '修改指令过长');
    if (!text.includes(record.selectionId)) return coded('MP_EDIT_INVALID', '修改指令没有绑定本次选区');
    record.payload = text;
    record.meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : null;
    record.armed = true;
    record.expiresAt = nowMs(now) + RECORD_TTL_MS;
    return { ok: true, value: { nonce: record.nonce } };
  }

  function status(payload) {
    prune();
    const record = recordFor(payload?.nonce);
    if (!record) return { ok: true, value: { status: 'missing' } };
    return {
      ok: true,
      value: {
        nonce: record.nonce,
        status: record.status,
        selectionId: record.selectionId,
        explicitReference: record.explicitReference,
        result: record.result,
        error: record.error,
        persistError: record.persistError,
      },
    };
  }

  function abort(payload) {
    const record = recordFor(payload?.nonce);
    if (!record) return { ok: true, value: { status: 'missing' } };
    if (record.status === 'held' || record.status === 'running') {
      finish(record, 'cancelled', undefined, { code: 'MP_EDIT_CANCELLED', message: '已停止修改' });
    }
    return { ok: true, value: { status: record.status } };
  }

  function persistUser(record, agent) {
    if (record.persistedUser) return true;
    try {
      agent.session.append('user/message', {
        id: 'mp-edit-user-' + record.nonce,
        role: 'user',
        content: [{ type: 'text', text: instructionText(record) }],
        source: { kind: 'user', rpcId: record.rpcId },
      }, { surfaceOp: 'append' });
      record.persistedUser = true;
      return true;
    } catch (error) {
      record.persistError = String(error?.message || error);
      return false;
    }
  }

  function persistAssistant(record, agent, text) {
    if (record.persistedAssistant) return true;
    const body = typeof text === 'string' && text.trim() ? text.trim() : '修改流程已结束。';
    const at = nowMs(now);
    const provider = record.provider || 'markpilot';
    const model = record.model || 'markpilot-edit';
    try {
      agent.session.append('assistant/message', {
        turn: Number.isSafeInteger(record.turn) ? record.turn : 1,
        step: 0,
        message: {
          id: 'mp-edit-assistant-' + record.nonce,
          role: 'assistant',
          content: [{ type: 'text', text: body }],
          source: { kind: 'model', provider, model },
        },
        stream: [
          { type: 'text-chunks', time0: at, index: 0, dt: [], texts: [body] },
          { type: 'chunk', time: at, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ],
      }, { surfaceOp: 'append' });
      record.persistedAssistant = true;
      return true;
    } catch (error) {
      record.persistError = String(error?.message || error);
      return false;
    }
  }

  async function executeTool(tools, agent, modelSelection, toolSet, call, args, signal) {
    const request = {
      type: 'tool-call',
      id: call.id || uuid(),
      name: 'markdown',
      arguments: JSON.stringify(args),
    };
    let batch;
    try {
      batch = await tools.execute({
        calls: [request],
        signal,
        agent,
        toolSet,
        // No log: this call happens outside the parent model's step, so it
        // must not commit root tool/call and tool/result events.
      });
    } catch (error) {
      return coded(error?.code || 'MP_EDIT_TOOL', String(error?.message || error));
    }
    const first = Array.isArray(batch?.results) ? batch.results[0] : null;
    if (!first || !first.result) return coded('MP_EDIT_TOOL', '工具没有返回结果');
    const result = first.result;
    if (result.isError) {
      return coded('MP_EDIT_TOOL', contentText(result.content) || '工具调用失败');
    }
    const value = result.value;
    if (!value || value.ok !== true) {
      return failureOf(value, 'MP_EDIT_TOOL', contentText(result.content) || '工具调用失败');
    }
    return { ok: true, value, content: result.content };
  }

  async function run(record, payload, signal) {
    if (!record.armed || !record.payload) return coded('MP_EDIT_NOT_ARMED', '修改请求尚未就绪');
    const llm = getService('llm');
    if (!llm || typeof llm.stream !== 'function') {
      return coded('MP_EDIT_LLM_UNAVAILABLE', '宿主没有可用的模型服务（隔离修改需要 ctx.llm）');
    }
    const tools = getService('tools');
    if (!tools || typeof tools.execute !== 'function' || typeof tools.resolve !== 'function') {
      return coded('MP_EDIT_TOOLS_UNAVAILABLE', '宿主没有可用的工具调度服务（隔离修改需要 ctx.tools）');
    }
    const agent = payload?.agent;
    if (!agent || !agent.session) return coded('MP_EDIT_NO_AGENT', '修改请求没有可用的会话');
    if (String(agent.id) !== record.sessionId) {
      return coded('MP_EDIT_SESSION', '选区属于另一个对话，已拒绝');
    }
    const selection = payload?.modelSelection && typeof payload.modelSelection === 'object' ? payload.modelSelection : {};
    if (!selection.provider || !selection.model) {
      return coded('MP_EDIT_NO_MODEL', '当前对话没有选择模型');
    }
    record.provider = selection.provider;
    record.model = selection.model;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      try { timeout.abort(new Error('edit-timeout')); } catch { /* 已停 */ }
    }, EDIT_TIMEOUT_MS);
    timer.unref?.();
    const runSignal = combinedSignal(signal, record.controller.signal, timeout.signal);
    let toolSet = null;
    try {
      try {
        toolSet = await tools.resolve({ agent, modelSelection: selection, signal: runSignal });
      } catch (error) {
        return coded(error?.code || 'MP_EDIT_TOOL_ACTIVATION', String(error?.message || error));
      }
      if (typeof tools.get === 'function' && tools.get('markdown', agent, toolSet) === undefined) {
        return coded('MP_EDIT_TOOL_DISABLED', '当前对话的 markdown 工具不可用（可能被禁用或限制）');
      }

      const messages = [];
      if (record.explicitReference) {
        const query = [record.intent, record.selectionText, record.path].join('\n');
        let excerpt = { text: '', count: 0, truncated: false, matched: false };
        try {
          excerpt = extractDiscussionExcerpt(agent.session.deriveMessages(), query, {});
        } catch (error) {
          if (log && typeof log.warn === 'function') log.warn('%s: discussion excerpt failed: %s', 'dsh-markdown-editor-typora', String(error?.message || error));
        }
        if (excerpt.text) messages.push({ role: 'user', content: [{ type: 'text', text: referenceBlock(excerpt) }] });
        if (!excerpt.text) {
          // Never let the model guess at a discussion it did not receive.
          return coded('MP_EDIT_REFERENCE_EMPTY', '没有找到与本次修改相关的最近讨论');
        }
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: record.payload }] });

      for (let stepIndex = 0; stepIndex < MAX_TOOL_STEPS; stepIndex += 1) {
        if (runSignal && runSignal.aborted) {
          if (timeout.signal.aborted) return coded('MP_EDIT_TIMEOUT', '修改超时');
          return { ok: false, cancelled: true, error: { code: 'MP_EDIT_CANCELLED', message: '已停止修改' } };
        }
        const request = {
          provider: selection.provider,
          model: selection.model,
          messages,
          system: SYSTEM_PROMPT,
          tools: [MARKDOWN_TOOL],
          signal: runSignal,
          sessionId: agent.id,
        };
        if (selection.reasoningEffort !== undefined) request.reasoningEffort = selection.reasoningEffort;
        if (agent.options && Number.isSafeInteger(agent.options.maxTokens) && agent.options.maxTokens > 0) {
          request.maxTokens = agent.options.maxTokens;
        }
        const streamed = await streamOnce(llm, request, runSignal);
        if (!streamed.ok) {
          if (timeout.signal.aborted) return coded('MP_EDIT_TIMEOUT', '修改超时');
          return streamed;
        }
        if (!streamed.toolCalls.length) {
          return coded('MP_EDIT_NO_TOOL_CALL', '模型没有调用 editSelection');
        }
        if (streamed.toolCalls.length > 1) {
          return coded('MP_EDIT_TOOL_BATCH', '模型一次返回了多个工具调用');
        }
        const call = streamed.toolCalls[0];
        if (call.name !== 'markdown') return coded('MP_EDIT_TOOL', '模型调用了不支持的工具：' + call.name);
        let args;
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          return coded('MP_EDIT_TOOL_ARGS', '工具参数不是有效 JSON');
        }
        const action = typeof args?.action === 'string' ? args.action : '';
        if (action === 'readSelection') {
          if (runSignal && runSignal.aborted) return { ok: false, cancelled: true, error: { code: 'MP_EDIT_CANCELLED', message: '已停止修改' } };
          const read = await executeTool(tools, agent, selection, toolSet, call,
            { action: 'readSelection', path: record.path, selectionId: record.selectionId }, runSignal);
          if (!read.ok) {
            if (timeout.signal.aborted) return coded('MP_EDIT_TIMEOUT', '修改超时');
            return read;
          }
          messages.push({
            role: 'assistant',
            content: [{ type: 'tool-call', id: call.id || uuid(), name: 'markdown', arguments: call.arguments }],
            source: { kind: 'model', provider: selection.provider, model: selection.model },
            id: uuid(),
          });
          messages.push({
            role: 'tool',
            content: read.content,
            source: { kind: 'tool', callId: call.id || '' },
            toolCallId: call.id || '',
            id: uuid(),
          });
          continue;
        }
        if (action === 'editSelection') {
          // Re-check cancellation not only before dispatch but also inside the
          // official tool pipeline; the tool receives this same signal and its
          // write path observes it.
          if (runSignal && runSignal.aborted) return { ok: false, cancelled: true, error: { code: 'MP_EDIT_CANCELLED', message: '已停止修改' } };
          const editArgs = { action: 'editSelection', path: record.path, selectionId: record.selectionId };
          if (typeof args?.newString === 'string') editArgs.newString = args.newString;
          if (Array.isArray(args?.replacements) && args.replacements.every((value) => typeof value === 'string')) {
            editArgs.replacements = args.replacements;
          }
          const edited = await executeTool(tools, agent, selection, toolSet, call, editArgs, runSignal);
          if (!edited.ok) {
            if (timeout.signal.aborted) return coded('MP_EDIT_TIMEOUT', '修改超时');
            return edited;
          }
          return { ok: true, value: edited.value, content: edited.content, text: streamed.text };
        }
        return coded('MP_EDIT_TOOL_ACTION', '模型调用了不支持的动作：' + action);
      }
      return coded('MP_EDIT_TOOL_STEPS', '模型工具调用步数过多');
    } finally {
      try { if (toolSet && typeof toolSet.dispose === 'function') toolSet.dispose(); } catch { /* 已清理 */ }
      clearTimeout(timer);
    }
  }

  async function streamOnce(llm, request, signal) {
    const toolCalls = [];
    const deltaCalls = new Map();
    let finish;
    let text = '';
    let deltaText = '';
    try {
      for await (const chunk of llm.stream(request)) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') {
          deltaText += String(chunk.text || '');
          continue;
        }
        if (chunk.type === 'tool-call-delta') {
          const key = Number.isSafeInteger(chunk.index) ? chunk.index : 0;
          const prior = deltaCalls.get(key) || { id: '', name: '', arguments: '' };
          deltaCalls.set(key, {
            id: prior.id || String(chunk.id || ''),
            name: prior.name || String(chunk.name || ''),
            arguments: prior.arguments + String(chunk.argumentsDelta || ''),
          });
          continue;
        }
        if (chunk.type === 'block-end') {
          const block = chunk.block;
          if (block && block.type === 'tool-call') {
            toolCalls.push({
              id: String(block.id || ''),
              name: String(block.name || ''),
              arguments: String(block.arguments || ''),
            });
          } else if (block && block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
          continue;
        }
        if (chunk.type === 'finish') finish = chunk.reason;
      }
    } catch (error) {
      if (signal && signal.aborted) return { ok: false, cancelled: true, error: { code: 'MP_EDIT_CANCELLED', message: '已停止修改' } };
      return coded('MP_EDIT_LLM', String(error?.message || error));
    }
    if (finish && finish.kind === 'aborted') {
      return { ok: false, cancelled: true, error: { code: 'MP_EDIT_CANCELLED', message: '已停止修改' } };
    }
    if (finish && finish.kind === 'error') {
      const failure = finish.failure && typeof finish.failure === 'object' ? finish.failure : {};
      return coded(failure.code || 'MP_EDIT_LLM', failure.message || '模型调用失败');
    }
    if (!toolCalls.length && deltaCalls.size) {
      for (const call of deltaCalls.values()) {
        if (call.name) toolCalls.push(call);
      }
    }
    return { ok: true, toolCalls, text: text || deltaText };
  }

  async function preStep(payload, next) {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
        const info = markerInfo(message);
        if (info) {
          const record = recordFor(info.nonce);
          if (record && (record.status === 'held' || record.status === 'running')) {
            finish(record, 'failed', undefined, { code: 'MP_EDIT_STEP_FAILED', message: String(error?.message || error) });
          }
        }
      }
      throw error;
    }

    const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
    const agentId = String(payload?.agent?.id || '');
    const at = nowMs(now);
    prune();

    // A reject discards the claimed batch. Mark our held records blocked and
    // leave the decision exactly as the permission/downstream hook made it.
    if (decision.kind === 'reject') {
      for (const message of claimed) {
        const info = markerInfo(message);
        if (!info) continue;
        const record = recordFor(info.nonce);
        if (record && record.sessionId === agentId && (record.status === 'held' || record.status === 'running')) {
          finish(record, 'failed', undefined, { code: 'MP_EDIT_BLOCKED', message: '修改请求被宿主的安全策略拒绝' });
        }
      }
      return decision;
    }

    const approvedIds = new Set((Array.isArray(decision.messages) ? decision.messages : [])
      .map((message) => message && message.id).filter(Boolean));

    // Only markers we can prove are ours participate:
    //   · an rpc-id marker is ours by construction (and is dropped fail-safe if
    //     its record is gone/expired/wrong-session);
    //   · a text-only marker is ours only when a held record exists for this
    //     session and the message text exactly equals marker + recorded payload;
    //   · `next()` must still have admitted the marker message (approvedIds).
    const owners = [];
    const valid = [];
    for (const message of claimed) {
      const info = markerInfo(message);
      if (!info) continue;
      const record = recordFor(info.nonce);
      if (info.via === 'rpc') {
        owners.push(message);
        if (!record) continue;
        if (record.sessionId !== agentId) {
          finish(record, 'failed', undefined, { code: 'MP_EDIT_SESSION', message: '选区属于另一个对话，已拒绝' });
          continue;
        }
        if (record.status !== 'held' || record.expiresAt <= at) {
          if (record.status === 'held') finish(record, 'failed', undefined, { code: 'MP_EDIT_EXPIRED', message: '修改请求已超时' });
          continue;
        }
        if (!record.armed) {
          finish(record, 'failed', undefined, { code: 'MP_EDIT_NOT_ARMED', message: '修改请求尚未就绪' });
          continue;
        }
        if (!approvedIds.has(message.id)) {
          finish(record, 'failed', undefined, { code: 'MP_EDIT_FILTERED', message: '修改请求被宿主过滤' });
          continue;
        }
        valid.push({ message, record });
        continue;
      }
      // Text-only marker: never consume forged user text.
      if (!record) continue;
      if (record.sessionId !== agentId) continue;
      if (record.status !== 'held' || record.expiresAt <= at || !record.armed) continue;
      if (info.text !== markerText(info.nonce) + record.payload) continue;
      owners.push(message);
      if (!approvedIds.has(message.id)) {
        finish(record, 'failed', undefined, { code: 'MP_EDIT_FILTERED', message: '修改请求被宿主过滤' });
        continue;
      }
      valid.push({ message, record });
    }
    if (!owners.length) return decision;

    const ownerIds = new Set(owners.map((message) => message && message.id).filter(Boolean));
    const remaining = Array.isArray(decision.messages)
      ? decision.messages.filter((message) => !ownerIds.has(message && message.id))
      : [];
    // A runtime-context/provider message added by next() must not wake the
    // parent model on its own. Keep the decision only when a real user message
    // remains; otherwise this isolated turn completes with no model call.
    const hasRealUser = remaining.some((message) => message && message.role === 'user'
      && message.source && message.source.kind === 'user');
    const noMarkers = () => (hasRealUser ? { ...decision, messages: remaining } : { ...decision, messages: [] });

    let primary = null;
    for (const entry of valid) {
      if (!primary) { primary = entry; continue; }
      finish(entry.record, 'failed', undefined, { code: 'MP_EDIT_SUPERSEDED', message: '同一轮有多个修改请求，后一个未执行' });
    }
    if (!primary) return noMarkers();
    const record = primary.record;
    // agent-loop computes `const step = phase.step + 1` before preStep, so a
    // fresh turn's first callback carries step=1. Only step > 1 is a later step
    // inside a running turn; consuming the marker there would let the loop open
    // a step with no messages and fall back to the parent history.
    if (Number.isSafeInteger(payload?.step) && payload.step > 1) {
      finish(record, 'failed', undefined, {
        code: 'MP_EDIT_ACTIVE_TURN',
        message: '当前轮次进行中，隔离修改未启动；请等本轮结束后重试',
      });
      return hasRealUser ? { ...decision, messages: remaining } : { kind: 'reject' };
    }

    record.turn = Number.isSafeInteger(payload?.turn) ? payload.turn : record.turn;
    const agent = payload?.agent;
    if (!persistUser(record, agent)) {
      finish(record, 'failed', undefined, {
        code: 'MP_EDIT_PERSIST',
        message: '修改指令未能写入当前对话',
      });
      return noMarkers();
    }
    record.status = 'running';
    record.startedAt = nowMs(now);
    let outcome;
    try {
      outcome = await run(record, payload, payload?.signal);
    } catch (error) {
      if (payload?.signal && payload.signal.aborted) {
        finish(record, 'cancelled', undefined, { code: 'MP_EDIT_CANCELLED', message: '已停止修改' });
        persistAssistant(record, agent, cancelText());
        throw error;
      }
      outcome = coded(error?.code || 'MP_EDIT_FAILED', String(error?.message || error));
    }
    if (outcome.ok === true) {
      persistAssistant(record, agent, successText(record, outcome));
      finish(record, 'done', outcome.value, null);
    } else if (outcome.cancelled === true) {
      persistAssistant(record, agent, cancelText());
      finish(record, 'cancelled', undefined, outcome.error || { code: 'MP_EDIT_CANCELLED', message: '已停止修改' });
    } else {
      const error = outcome.error || { code: 'MP_EDIT_FAILED', message: '修改失败' };
      const text = error.code === 'MP_EDIT_REFERENCE_EMPTY'
        ? '没有找到与本次修改相关的最近讨论，未执行修改；请补充要参考的内容，或直接在指令里说明修改要求。'
        : failureText(error);
      persistAssistant(record, agent, text);
      finish(record, 'failed', undefined, error);
    }
    return noMarkers();
  }

  function install() {
    if (installed) return () => {};
    if (!ctx || typeof ctx.on !== 'function') return () => {};
    installed = true;
    const dispose = ctx.on('agent/pre-step', (payload, next) => preStep(payload, next), { prepend: true });
    return () => {
      installed = false;
      try { if (typeof dispose === 'function') dispose(); } catch { /* 已清理 */ }
    };
  }

  return {
    version: EDIT_ISOLATION_VERSION,
    prepare,
    arm,
    status,
    abort,
    preStep,
    install,
    get installed() { return installed; },
    _records: records,
  };
}
