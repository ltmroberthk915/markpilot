import { isOwnAttachmentDefinition } from './attachment-image.js';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseDocumentBlocks } from './documents-service.js';
import {
  describeSectionIntent, emptySectionIntent, enforceSectionWrite, intentMatchesFile, readSectionDirective,
  reduceSectionEvent, stripScopeNegations,
} from './section-scope.js';

// The public quote text survives draft restoration, session replay and HMR.
// Only the editor-facing endpoint issues a signature, over the session and
// canonical target together. A copied or relabelled quote stays read-only.
export function referenceSigner(directory) {
  let key;
  return (session, file) => {
    if (!key) {
      const name = join(directory, 'reference-scope.key');
      try { key = readFileSync(name); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        mkdirSync(directory, { recursive: true });
        const temp = name + '.' + randomUUID();
        writeFileSync(temp, randomBytes(32), { flag: 'wx', mode: 0o600 });
        try { linkSync(temp, name); }
        catch (race) { if (race.code !== 'EEXIST') throw race; }
        finally { unlinkSync(temp); }
        key = readFileSync(name);
      }
      if (key.length !== 32) { key = null; throw new Error('引用签名不可用'); }
    }
    return createHmac('sha256', key).update(JSON.stringify([session, file])).digest('base64url');
  };
}

const header = /^> 只读引用：(.+?) · (?:第 \d+(?:[–-]\d+)? 行|文件)(?: 【MP引用 ([\w-]{43})】)?$/u;
const human = m => m?.role === 'user' && m.source?.kind === 'user';
export const emptyScope = () => ({ files: [], chosen: -1, write: false, receivedReferences: false });

function asksToWrite(input) {
  // A question can precede an explicit request to insert. Only the user's
  // own clauses reach here; quoted document text was removed by admitMessage.
  const text = input.replace(/“[^”]*”|「[^」]*」|"[^"]*"/gu, '引文');
  const clauses = text.trim().split(/[，,。！？!?；;\n]+|\s+(?=(?:请|再|直接)?(?:补到|加到|补入|追加到|写入|放到))/u).map(s => s.trim()).filter(Boolean);
  const last = clauses.at(-1) || '';
  const noWrite = /不要|不用|别|不必|先不|不需要|不改|不写|不执行|不落盘|不落地|讨论|建议|先分析|先给我看|只给我看|算了|取消|仅说明|如果|假如|比如/u;
  const question = /什么|哪里|哪儿|哪些|怎样|怎么|如何|会不会|好不好|你觉得|能否|是否|要不要|能不能|可不可以|[吗呢]\s*$/u;
  // "只改 M 节，别动 J、架构图和目录" is a write request whose negation points
  // at other sections. The generic noWrite scan below would read "别" as "do not
  // write at all", so the named-scope form is decided first, from the user's own
  // clauses with the exclusion list removed.
  const scoped = readSectionDirective(text);
  if (scoped?.conflict) return false;
  if (scoped?.targets?.length) {
    const own = stripScopeNegations(text);
    if (!/讨论|建议|分析|解释|说明|点评|评价|审阅|评审|意见|举例|演示/u.test(own)
        && !/[?？]/u.test(own)
        && !/(?:如果|假如|要是|假设|是否|要不要|能不能|可不可以|会不会|行不行|对不对|对吗|吗|呢)\s*$/u.test(own.trim())) return true;
  }
  if (noWrite.test(text) || /[?？]\s*$/u.test(text) || question.test(last)) return false;
  const command = text.replace(/^(?:(?:请(?:你)?|麻烦(?:你)?|现在|直接|那就|继续|开始|帮我)\s*)+/u, '');
  const request = last.replace(/^(?:(?:这个|那就|请你?|麻烦你?|帮我|你|先|再|直接|现在|也|都|给我|给)\s*)+/u, '');
  const insertion = '(?:新增|补入|添加|追加|加入|插入|加到|补到|补上)';
  if (new RegExp('^(?:在.{1,120}?' + insertion + '|(?:把|将).{1,140}?' + insertion + '|' + insertion + '|放到附录)', 'u').test(request)) return true;
  if (/[?？]/u.test(text)) return false;
  if (/^(?:改成|改为|改写成|修改为|更新为|替换为)/u.test(command)) return true;
  const edit = /^(?:改(?:一下|吧|了|好|成|为|掉|动|写|下|一改)?|修改|修订|更改|替换|补充|补上|更新|写入|落实修改)/u;
  const target = /^(?:$|[\s，,。！!：:]|成|为|一下|这里|这段|这个|文件|正文|引用|上面|刚才|原文|第|到|好)/u;
  const match = edit.exec(command);
  if (match && target.test(command.slice(match[0].length))) return true;
  if (/^(?:按.{1,60}(?:修改|改)|把.{1,100}(?:改成|改为|替换|补充|写入))/u.test(command)) return true;
  return /^(?:please\s+)?(?:edit|modify|update|replace|apply the changes)\b/i.test(text)
    && !/\b(?:discuss|explain|suggestions?|advice|proposal|me on|do not|don't|without writing)\b/i.test(text);
}

// Track only offers that can still act on the same reference. Message IDs and
// sequence numbers identify the answer without duplicating its body in state.
export function reduceReferenceEvent(state, event) {
  let scope = state;
  let turn = state.turn ?? -1, pending = state.pending ?? null, offers = state.offers || [];
  if (event.type === 'turn/start') {
    turn = event.data.turn; pending = null;
    scope = { ...state, write: false, receivedReferences: false };
  } else if (event.type === 'user/message' && human(event.data)) {
    scope = admitMessage(state, event.data);
    const text = event.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      .split(/\r?\n/).filter(line => !line.startsWith('>') && !line.startsWith('只读引用：')).join('\n').trim();
    const file = scope.files[scope.chosen];
    const quoted = event.data.content.some(b => b.type === 'text' && /(?:^|\n)> 只读引用：/u.test(b.text));
    const cancelled = /(?:不要|不用|别|先不)(?:再|往.{0,16})?(?:写|改|补|动文件|落地|落盘)|取消|算了|先给我看|只给我看|只讨论|仅讨论|不落盘/u.test(text);
    if (quoted || !file || cancelled || /^(?:选择目标|修改目标|结束引用)/u.test(text)) offers = [];
    pending = null;
    if (!scope.write && file?.signature && !cancelled && !event.data.source.rpcId?.startsWith('mp-edit:') &&
        /(?:补|给|写|整理)(?:一[个份条]|个|份)?答案/u.test(text.replace(/“[^”]*”|「[^」]*」|"[^"]*"/gu, '')))
      pending = { file, userSeq: event.seq, answerSeq: -1, messageId: '' };
  } else if (event.type === 'assistant/message' && pending && event.data.turn === turn) {
    const message = event.data.message;
    pending = { ...pending, answerSeq: -1, messageId: '' };
    if (!event.data.interrupted && message?.source?.kind === 'model' &&
        message.content.some(b => b.type === 'text' && b.text.trim()) && !message.content.some(b => b.type === 'tool-call'))
      pending = { ...pending, answerSeq: event.seq, messageId: message.id };
  } else if (pending && ['tool/call', 'tool/result', 'llm/retry'].includes(event.type)) {
    pending = { ...pending, answerSeq: -1, messageId: '' };
  } else if (event.type === 'turn/end') {
    if (pending?.answerSeq >= 0 && event.data.turn === turn && event.data.reason?.kind === 'completed')
      offers = [...offers, { ...pending, turn, endSeq: event.seq }];
    pending = null;
    scope = { ...state, write: false, receivedReferences: false };
  } else return state;
  return { ...scope, turn, pending, offers };
}

export function admitMessage(previous, message) {
  if (!human(message)) return previous;
  if (message.source.rpcId?.startsWith('mp-edit:')) return previous.write ? { ...previous, write: false } : previous;
  const content = (Array.isArray(message.content) ? message.content : []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (!previous.files.length && !content.includes('只读引用：')) return previous;
  const lines = content.split(/\r?\n/);
  const files = [];
  let inQuote = false;
  const userLines = [];
  for (const line of lines) {
    const legacy = line.startsWith('只读引用：');
    if (line.startsWith('>') || legacy) {
      if (!inQuote) {
        const match = header.exec(legacy ? '> ' + line : line);
        if (match && !files.some(f => f.path === match[1] && f.signature === (match[2] || ''))) {
          files.push({ path: match[1], signature: !legacy && match[2] || '' });
        }
      }
      inQuote = true;
    } else {
      inQuote = false;
      userLines.push(line);
    }
  }
  const body = userLines.join('\n').trim();
  if (!files.length && content.trim() === '结束引用') return emptyScope();
  if (!files.length && !previous.files.length) return previous;
  const candidates = files.length && previous.receivedReferences
    ? [...previous.files, ...files.filter(f => !previous.files.some(old => old.path === f.path && old.signature === f.signature))]
    : files.length ? files : previous.files;
  let chosen = files.length ? (candidates.length === 1 ? 0 : -1) : previous.chosen;
  let intent = body;
  const choice = /^(?:选择目标|修改目标)\s*([1-9]\d*)(?:[，,：:\s]+|$)/u.exec(body);
  if (choice) {
    const idx = Number(choice[1]) - 1;
    chosen = idx < candidates.length ? idx : -1;
    intent = body.slice(choice[0].length).trim();
  } else if (/^(?:选择目标|修改目标)\s+/u.test(body)) {
    const first = body.split('\n', 1)[0];
    const path = first.replace(/^(?:选择目标|修改目标)\s+/u, '').trim();
    chosen = candidates.findIndex(f => f.path === path);
    intent = body.slice(first.length).trim();
  }
  return { files: candidates, chosen, write: chosen >= 0 && asksToWrite(intent), receivedReferences: !!files.length || previous.receivedReferences };
}

function scopeNotice(state) {
  if (state.chosen < 0) return '请先选择修改目标。回复“选择目标 1”等编号，再提出修改要求。\n' +
    state.files.map((f, i) => (i + 1) + '. ' + f.path).join('\n');
  const file = state.files[state.chosen];
  if (!file.signature) return '这条引用仅供讨论。如需写入，请保存并在当前对话重新引用该文件：' + file.path;
  const section = state.section && intentMatchesFile(state.section, file) ? state.section : null;
  const constraint = section ? '\n本次范围：' + describeSectionIntent(section)
    + '。越出该章节的写入会被拦下，不需要再确认；要改别处请直接说出新的章节名。' : '';
  return (state.write ? '本次只可修改 ' + file.path + '。写入时请使用该文件的绝对路径。'
    : '本次讨论为只读。继续回复“改”可修改 ' + file.path + '。') + constraint;
}

const readTools = new Set(['read', 'glob', 'grep']);
// These operations may read data or record a result in the conversation.
// A new argument (for example, an output destination) needs its own review.
const discussionFields = new Map(Object.entries({
  web_fetch: ['url'], web_search: ['queries'], read_image: ['file_path'],
  ask_user_question: ['questions'], present: ['files'], skill: ['name'], todo_write: ['todos'],
  working_directory: ['cd'], get_goal: [], job_list: [], job_output: ['job_id', 'wait', 'timeout_ms'],
  list_agents: [], list_subagent_models: ['provider', 'model'], wait_agent: ['timeout_ms'],
  team_task_get: ['task_id'], team_task_list: ['status', 'owner', 'unowned', 'ready', 'cursor', 'limit'],
  terminal_list: [], terminal_read: ['sessionId', 'offset', 'count'], user_terminal_list: [], user_terminal_read: ['id', 'lines'],
  schedule_list: ['active', 'limit', 'offset'], schedule_view: ['id'],
  session_event_read: ['session_id', 'seq', 'before', 'after'], session_event_trace: ['session_id', 'seq'],
  session_event_search: ['session_id', 'query', 'seq_from', 'seq_to', 'time_from', 'time_to', 'event_types', 'surfaces'],
  session_trace: ['session_id'], session_search: ['query', 'session_ids', 'created_at_from', 'created_at_to',
    'parent_session_ids', 'include_root_sessions', 'availability', 'event_seq_from', 'event_seq_to',
    'event_time_from', 'event_time_to', 'event_types', 'event_surfaces'],
  plugin_manager: ['action', 'offset', 'limit'], load_workspace_dependencies: [],
  list_mcp_resources: ['server', 'cursor'], list_mcp_resource_templates: ['server', 'cursor'], read_mcp_resource: ['server', 'uri'],
  cordis_inspect_list: [], cordis_inspect_query: ['platform', 'provider', 'method', 'input'],
  office_render: ['input', 'pages', 'sheet', 'range', 'dpi'], office_convert: ['input', 'format', 'sheet'], office_recalculate: ['input', 'format'],
  computer_ask: ['question'], computer_ctrl: ['action', 'why', 'temporary'], see_now: ['action'],
  rw_machines: ['environment', 'location', 'tags', 'query'],
  remote_list_hosts: [], remote_list_workspaces: ['hostId'], remote_get_operation: ['operationId'],
  remote_list_sessions: ['hostId', 'backend', 'workspaceId', 'offset', 'limit'],
  remote_read_session: ['hostId', 'backend', 'workspaceId', 'sessionId', 'maxMessages', 'cursor'],
  remote_wait_sessions: ['targets', 'timeoutMs'],
  session_telecom: ['action', 'query', 'limit', 'targetSessionId', 'sessionId', 'last', 'mode'],
}));

function isInheritedTool(exec, tools, scopeParentOf) {
  const inherited = tools?.get?.(exec.name, scopeParentOf?.(exec.agent));
  return !!inherited && tools.get(exec.name, exec.agent, exec.toolSet) === inherited;
}

function isDiscussionTool(exec, tools, scopeParentOf) {
  const fields = discussionFields.get(exec.name);
  const args = exec.arguments;
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args) ||
      !Object.keys(args).every(key => fields.includes(key))) return false;
  if (exec.name === 'plugin_manager' && !['list_plugins', 'list_bundles', 'list_version_exemptions'].includes(args.action)) return false;
  if (exec.name === 'session_telecom' && !['list', 'read', 'peek'].includes(args.action ?? 'list')) return false;
  if (exec.name === 'see_now' && !['help', 'status'].includes(args.action)) return false;
  if (exec.name === 'computer_ctrl' && !['release', 'stop', 'exit'].includes(args.action)) return false;
  return isInheritedTool(exec, tools, scopeParentOf);
}

export function authorizeReference(state, session, exec, sign, tools, scopeParentOf) {
  if (!state.files.length || readTools.has(exec.name)) return;
  if (exec.name === 'attachment_read_image') {
    const attachmentDefinition = tools?.get?.(exec.name, exec.agent, exec.toolSet);
    if (attachmentDefinition && isOwnAttachmentDefinition(attachmentDefinition)) return;
  }
  if (isDiscussionTool(exec, tools, scopeParentOf)) return;
  const args = exec.arguments;
  if (exec.name === 'markdown' && ['read', 'readSelection'].includes(args?.action)) return;
  if (exec.name === 'markdown' && ['blocks', 'inspect'].includes(args?.action) && isInheritedTool(exec, tools, scopeParentOf)) return;
  if (exec.name === 'str_replace_editor' && args?.command === 'view') return;
  const file = state.files[state.chosen];
  let raw = exec.name === 'edit' || exec.name === 'write' ? args?.file_path
    : exec.name === 'markdown' && args?.action === 'edit' ? args.path : undefined;
  if ((exec.name === 'markdown' && ['insert', 'batch', 'merge3', 'undo'].includes(args?.action) ||
       exec.name === 'str_replace_editor' && ['str_replace', 'insert'].includes(args?.command)) &&
      isInheritedTool(exec, tools, scopeParentOf)) raw = args.path;
  if (state.write && file?.signature && typeof raw === 'string' && isAbsolute(raw)
    && !raw.split(/[\\/]/).some(s => s === '.' || s === '..') && normalize(raw) === file.path) {
    try {
      if (sign(session, file.path) === file.signature && realpathSync.native(raw) === file.path) return;
    } catch { /* Missing or retargeted file. */ }
  }
  const generalExecution = ['pwsh', 'bash', 'run_code', 'workflow', 'terminal_send'].includes(exec.name);
  const reason = generalExecution
    ? '引用期间，通用脚本可能改写其他文件。检查磁盘编码、换行、标题、表格分隔行和代码围栏请用 markdown(action="inspect", path=文件绝对路径)。读取或检索正文可用 read、glob、grep。使用仅支持 run_code 的预设时，可在原生工具预设中执行这些检查。'
    : scopeNotice(state);
  return { reason: 'MarkPilot 已拦截这次工具操作。' + reason, info: { name: 'MarkPilotReferenceError', code: 'MP_REFERENCE_SCOPE' } };
}

async function diagnoseHeadingReplacement(exec, readDocument) {
  const args = exec.arguments || {};
  const native = exec.name === 'edit';
  if (!native && !(exec.name === 'markdown' && args.action === 'edit')) return;
  const path = native ? args.file_path : args.path;
  const old = native ? args.old_string : args.oldString;
  const next = native ? args.new_string : args.newString;
  if (!/\.(?:md|markdown|mdown|mkd)$/i.test(path || '') || typeof old !== 'string' || typeof next !== 'string') return;
  const title = /^ {0,3}(#{1,6})[ \t]+[^\r\n]+$/.exec(old);
  if (!title || !next.startsWith(title[1] + ' ') || !/\r?\n[\s\S]*\S/.test(next)
      || next.split(/\r\n|[\r\n]/).includes(old)) return;
  const result = await readDocument(path, exec);
  if (!result?.ok) return;
  const text = result.value.text;
  const at = text.indexOf(old);
  if (at < 0 || text.indexOf(old, at + 1) >= 0 || !parseDocumentBlocks(text).some(block =>
    block.kind === 'heading' && block.from === at && /^(?:\r\n|[\r\n]|$)/.test(text.slice(at + old.length)))) return;
  return {
    reason: '这次替换会移除原章节标题。新增内容请直接调用 markdown(action="insert", position="after", heading=原标题, newString=新增正文, path=同一文件)。如需重命名并增加内容，可分别改标题、插入正文。',
    info: { name: 'MarkPilotHeadingReplacement', code: 'MP_HEADING_REPLACEMENT' },
  };
}

// A write request described in the tool's own terms. `null` means "this call
// does not modify the bound document", so it never reaches the section check.
// Only the tools that already pass the reference guard are described here.
function sectionRequestOf(exec) {
  const args = exec.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (exec.name === 'edit' || exec.name === 'write') {
    const path = typeof args.file_path === 'string' ? args.file_path : args.path;
    if (typeof path !== 'string') return null;
    const old = typeof args.old_string === 'string' ? args.old_string : args.oldString;
    const next = typeof args.new_string === 'string' ? args.new_string : args.newString;
    const all = args.replace_all === true || args.replaceAll === true;
    // The native writer's own argument spelling is accepted as-is; an edit
    // request it can express is planned and checked here, never rewritten.
    if (typeof old === 'string' && typeof next === 'string')
      return { path, request: { kind: 'literal', oldString: old, newString: next, replaceAll: all } };
    if (Array.isArray(args.edits)) return { path, request: { kind: 'offsets', edits: args.edits } };
    if (typeof args.content === 'string') return { path, request: { kind: 'unsupported', reason:
      '写入整个文件会改到你要求不要动的章节，本次未写入。请在当前章节内用 markdown(action="insert", position="after", heading="该节完整标题", newString=新增正文, path=同一文件) 或 markdown(action="edit", oldString=该节内唯一原文, newString=新文本)。' } };
    return null;
  }
  if (exec.name === 'str_replace_editor') {
    if (typeof args.path !== 'string') return null;
    if (args.command === 'str_replace') return { path: args.path, request: {
      kind: 'literal', oldString: args.old_str, newString: args.new_str, replaceAll: false,
    } };
    if (args.command === 'insert') return { path: args.path, request: { kind: 'unsupported', reason:
      '按行号插入无法证明落在目标小节内，本次未写入。请改用 markdown(action="insert", position="after", heading="该节完整标题", newString=新增正文, path=同一文件) 或该节内唯一的 anchorText。' } };
    if (args.command === 'create') return { path: args.path, request: { kind: 'unsupported', reason:
      '整文件创建会覆盖引用文档，本次未写入。请在「只改 M 节」范围内用 markdown 的 insert/edit。' } };
    return null;
  }
  if (exec.name !== 'markdown') return null;
  const path = typeof args.path === 'string' ? args.path : '';
  if (args.action === 'edit') {
    if (args.selectionId) return null;
    if (args.fromLine !== undefined || args.toLine !== undefined) return { path, request: {
      kind: 'line', fromLine: args.fromLine, toLine: args.toLine, newString: args.newString,
    } };
    if (args.blockId !== undefined) return { path, request: {
      kind: 'block', blockId: args.blockId, newString: args.newString,
    } };
    return { path, request: {
      kind: 'literal', oldString: args.oldString, newString: args.newString, replaceAll: args.replaceAll === true,
    } };
  }
  if (args.action === 'batch') return { path, request: { kind: 'offsets', edits: args.edits } };
  // A selection-bound insert is the trusted editor capture; it never reaches the
  // section check because the guard already lets it through unchanged.
  if (args.action === 'insert') {
    if (args.selectionId) return null;
    return { path, request: { kind: 'insert', arguments: {
      position: args.position, heading: args.heading, anchorText: args.anchorText, newString: args.newString,
    } } };
  }
  if (args.action === 'merge3') return { path, request: { kind: 'unsupported', reason:
    '三方合并会整篇写入，无法证明只落在目标小节内，本次未写入。请在该节内用 markdown(action="edit", oldString=该节内唯一原文, newString=合并后的文本)。' } };
  return null;
}

// Enforce the user's section intent for one write call. The document is read at
// this moment and every plan is computed from that exact text, so a stale
// projected range can never be applied to a newer version. A fresh validation
// also replaces the old token after a real reload, which is what lets a
// legitimate retry proceed — no extra confirmation is involved.
async function enforceSectionScope(exec, service, refState, intent, log) {
  if (!intentMatchesFile(intent, refState.files[refState.chosen])) return null;
  const described = sectionRequestOf(exec);
  if (!described) return null;
  let result;
  try { result = await service.readDocument(described.path, exec); }
  catch (error) {
    return { kind: 'deny', reason: 'MarkPilot 已拦截这次工具操作。读取当前正文失败（'
      + String(error?.message || error) + '），无法确认修改是否落在「' + describeSectionIntent(intent)
      + '」内，本次未写入；请先 read 该文件再重试。',
    info: { name: 'MarkPilotSectionScope', code: 'MP_SECTION_READ' } };
  }
  if (result?.ok !== true) {
    return { kind: 'deny', reason: 'MarkPilot 已拦截这次工具操作。无法读取当前正文（'
      + String(result?.error?.code || 'read failed') + '），无法确认修改是否落在「'
      + describeSectionIntent(intent) + '」内，本次未写入；请先 read 该文件再重试。',
    info: { name: 'MarkPilotSectionScope', code: 'MP_SECTION_READ' } };
  }
  const text = String(result.value.text ?? '');
  const verdict = enforceSectionWrite({ text, intent, request: described.request });
  if (verdict.ok !== true) {
    log?.info?.('%s: section scope refused %s (%s)', 'MarkPilot', String(exec.name), String(verdict.code || ''));
    return { kind: 'deny', reason: verdict.reason,
      info: { name: 'MarkPilotSectionScope', code: String(verdict.code || 'MP_SECTION_SCOPE') } };
  }
  // The write itself is committed at tools/execute against this same revision;
  // the tool's own arguments are frozen, so nothing is attached here.
  return null;
}

// The native edit tool writes inside its own body and takes no revision token.
// This gate runs immediately before that body: it re-reads the file and re-proves
// the literal span is still inside the named section, so a change made by another
// editor between policy and dispatch cannot drag the edit elsewhere.
// A version token is usable only when it is non-empty; an empty read token
// must fail closed instead of turning the write into an unconditional commit.
function nonEmptyToken(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return '';
}

// The host builds the native diff card from the two whole-document strings in
// the tool value. They are derived from the same authoritative read the CAS
// write is bound to; re-reading after the commit could observe a later version.
function appliedDocumentText(text, changes) {
  if (typeof text !== 'string' || !Array.isArray(changes)) return null;
  let output = '';
  let cursor = 0;
  for (const change of changes) {
    if (!change || !Number.isInteger(change.from) || !Number.isInteger(change.to)
      || typeof change.insert !== 'string' || change.from < cursor
      || change.to < change.from || change.to > text.length) return null;
    output += text.slice(cursor, change.from) + change.insert;
    cursor = change.to;
  }
  return output + text.slice(cursor);
}

// tools/execute results are serialized as lossless JSON by the host; an
// undefined property or array entry makes a successful write fail validation.
function losslessValue(value) {
  if (Array.isArray(value)) {
    return value.map(losslessValue).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = losslessValue(item);
    }
    return out;
  }
  return value;
}

// The host edit tool is identified from the same registered definition the
// pipeline would execute; a same-named tool registered elsewhere keeps its own
// commit path and is never taken over here.
function isNativeEditTool(exec, tools, scopeParentOf) {
  if (exec.name !== 'edit') return false;
  try {
    const definition = tools.get?.(exec.name, exec.agent, exec.toolSet)
      ?? tools.get?.(exec.name, scopeParentOf?.(exec.agent), exec.toolSet);
    const properties = definition?.parameters?.properties;
    return !!properties && !!(properties.file_path || properties.path)
      && !!properties.old_string && !!properties.new_string;
  } catch { return false; }
}

function deniedResult(reason, info) {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Error: ' + reason }],
    error: { message: reason, info },
  };
}

// Only this plugin's markdown tool (action/position/anchorText selector shape)
// may be intercepted; another tool of the same name keeps its own behaviour.
function isOurMarkdownTool(exec, tools, scopeParentOf) {
  try {
    const definition = tools.get?.(exec.name, exec.agent, exec.toolSet)
      ?? tools.get?.(exec.name, scopeParentOf?.(exec.agent), exec.toolSet);
    const properties = definition?.parameters?.properties;
    return !!properties && !!(properties.action && properties.anchorText && properties.edits);
  } catch { return false; }
}

// The markdown tool's own args are deep-frozen by the pipeline, so a validated
// base revision cannot be attached to them. For a bound file with a section
// constraint the write therefore runs through the same documents service here,
// with the revision it was just proven against — the real commit entry, not a
// prediction of one.
async function runMarkdownWrite(exec, service, intent, log) {
  const args = exec.arguments;
  const sectioned = sectionRequestOf(exec);
  if (!sectioned) return null;
  if (typeof intent?.path !== 'string' || !intent.path
      || typeof sectioned.path !== 'string'
      || normalize(sectioned.path) !== intent.path) {
    return deniedResult('这次编辑的目标文件与引用文件不一致，本次未写入；请先 read 目标文件再重试。',
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_TARGET' });
  }
  const targetPath = intent.path;
  if (sectioned.request.kind === 'unsupported') {
    return deniedResult(sectioned.request.reason,
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_UNSUPPORTED' });
  }
  let current;
  try { current = await service.readDocument(targetPath, exec); }
  catch (error) {
    return deniedResult('读取当前正文失败（' + String(error?.message || error) + '），本次未写入；请先 read 该文件再重试。',
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_READ' });
  }
  if (current?.ok !== true) {
    return deniedResult('无法读取当前正文（' + String(current?.error?.code || 'read failed') + '），本次未写入；请先 read 该文件再重试。',
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_READ' });
  }
  const before = current.value.text;
  if (typeof before !== 'string') {
    return deniedResult('没有拿到完整正文，本次未写入；请先 read 该文件再重试。',
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_READ' });
  }
  const verdict = enforceSectionWrite({ text: before, intent, request: sectioned.request });
  if (verdict.ok !== true) {
    log?.info?.('%s: section scope refused markdown.%s (%s)', 'MarkPilot', String(args.action), String(verdict.code || ''));
    return deniedResult(verdict.reason, { name: 'MarkPilotSectionScope', code: String(verdict.code || 'MP_SECTION_SCOPE') });
  }
  let after;
  if (exec.name !== 'markdown') {
    const applied = appliedDocumentText(before, verdict.changes);
    const planned = typeof verdict.newText === 'string' ? verdict.newText : applied;
    if (applied === null || typeof planned !== 'string' || planned !== applied) {
      return deniedResult('章节校验结果无法与当前正文对应，本次未写入；请重新 read 后再试。',
        { name: 'MarkPilotSectionScope', code: 'MP_SECTION_PLAN' });
    }
    after = planned;
  }
  const requestedBase = exec.name === 'markdown'
    ? (typeof args.baseRevisionId === 'string' && args.baseRevisionId
      ? { field: 'baseRevisionId', token: args.baseRevisionId }
      : (typeof args.baseVersion === 'string' && args.baseVersion
        ? { field: 'baseVersion', token: args.baseVersion } : null))
    : null;
  const readRevision = nonEmptyToken(current.value.revisionId);
  const readVersion = nonEmptyToken(current.value.version);
  if (!readRevision && !readVersion) {
    return deniedResult('没有拿到当前正文的版本标识，无法确认写入基准，本次未写入；请先 read 该文件再重试。',
      { name: 'MarkPilotSectionScope', code: 'MP_SECTION_VERSION' });
  }
  const payload = { path: targetPath, cwd: args.cwd };
  if (exec.name !== 'markdown') {
    if (sectioned.request.kind === 'offsets') payload.edits = sectioned.request.edits;
    else {
      payload.oldString = sectioned.request.oldString;
      payload.newString = sectioned.request.newString;
      payload.replaceAll = sectioned.request.replaceAll === true;
    }
  } else if (args.action === 'insert') Object.assign(payload, {
    position: args.position, heading: args.heading, anchorText: args.anchorText, newString: args.newString,
  });
  else if (args.action === 'batch') Object.assign(payload, { edits: args.edits });
  else Object.assign(payload, {
    ...(args.fromLine !== undefined || args.toLine !== undefined
      ? { fromLine: args.fromLine, toLine: args.toLine } : {}),
    ...(args.blockId !== undefined ? { blockId: args.blockId } : {}),
    ...(args.blockId === undefined && !(args.fromLine !== undefined || args.toLine !== undefined)
      ? { oldString: args.oldString, replaceAll: args.replaceAll === true } : {}),
    newString: args.newString,
  });
  if (requestedBase) payload[requestedBase.field] = requestedBase.token;
  else if (readRevision) payload.baseRevisionId = readRevision;
  else payload.baseVersion = readVersion;
  let result;
  try { result = service.apply ? await service.apply(payload, exec)
    : await service.applyEdits(payload, exec); }
  catch (error) {
    return deniedResult(String(error?.message || error),
      { name: 'MarkPilotSectionScope', code: String(error?.code || 'MP_SECTION_WRITE') });
  }
  if (result?.ok !== true) {
    const error = result?.error || {};
    return deniedResult(String(error.message || error.code || '写入失败'),
      { name: 'MarkPilotSectionScope', code: String(error.code || 'MP_SECTION_WRITE') });
  }
  const value = result.value || {};
  if (exec.name !== 'markdown') {
    // The native edit contract is exactly { path, before, after }. A text-only
    // content result leaves the host without a value, which surfaces as
    // INVALID_TOOL_OUTPUT and makes the agent retry a committed edit.
    return { value: { path: targetPath, before, after } };
  }
  return {
    isError: false,
    value: losslessValue({
      ok: true, action: args.action === 'batch' ? 'batch' : args.action,
      version: value.version, revisionId: value.revisionId, readToken: value.version,
      displayPath: value.displayPath, changed: value.changed, source: value.source,
      dirty: value.dirty === true, saved: value.saved === true,
      ...(value.applied ? { applied: value.applied } : {}),
      ...(value.lineEdit === true ? { lineEdit: true, fromLine: value.fromLine, toLine: value.toLine,
        newFromLine: value.newFromLine, newToLine: value.newToLine, removedLineCount: value.removedLineCount,
        insertedLineCount: value.insertedLineCount, newTotalLines: value.newTotalLines,
        trailingEol: value.trailingEol, eol: value.eol } : {}),
      ...(value.groupId ? { groupId: value.groupId } : {}),
      ...(value.groupPersisted === false ? { groupPersisted: false, groupError: value.groupError } : {}),
      ...(value.checkpoint?.archivePath ? { checkpointPath: value.checkpoint.archivePath } : {}),
    }),
  };
}

// One projection step: the quoted-file scope and the user's section constraint
// advance together. admitMessage returns a file-scope shape only, so the
// section state is folded separately and re-attached — a plain spread would drop
// it on every turn boundary.
export function applyReferenceProjection(state, event) {
  const next = reduceReferenceEvent(state, event);
  // A chapter named without a fresh quote binds to the file the reference
  // scope actually selected, never to an implicit whole-file fallback.
  const selected = next.files?.[next.chosen]
    ?? (Array.isArray(next.files) && next.files.length === 1 ? next.files[0] : undefined);
  const section = reduceSectionEvent(state.section || emptySectionIntent(), event, selected);
  if (section === state.section && next === state) return state;
  return { ...next, section };
}

export function installReferenceScope(ctx, service, log) {
  if (!ctx.inject) return;
  ctx.inject(['tools', 'sessionProjections'], scope => {
    const tools = scope.tools, projections = scope.sessionProjections;
    if (typeof tools?.guard !== 'function' || !projections?.register) return;
    // The desktop ships Zod alongside the projection service. A package
    // installation can also supply it directly.
    let z;
    try { z = createRequire(import.meta.url)('zod').z; }
    catch {
      try { z = createRequire(process.argv[1])('zod').z; }
      catch { log.warn?.('MarkPilot 引用保护需要宿主的会话投影依赖'); return; }
    }
    // The parent bindings live in the host's own dsh-scope module instance.
    let scopeParentOf;
    try { ({ scopeParentOf } = createRequire(process.argv[1])('@deepseek-ai/dsh-scope')); }
    catch { /* Older hosts can still expose globally registered tools. */ }
    scope.effect(() => {
      let handle, disposed = false;
      const file = z.object({ path: z.string(), signature: z.string() });
      const candidate = z.object({ file, userSeq: z.number(), answerSeq: z.number(), messageId: z.string() });
      const ready = projections.register({
        key: 'markPilotReferenceScope', stateVersion: 4,
        stateSchema: z.object({ files: z.array(file), chosen: z.number().int(), write: z.boolean(), receivedReferences: z.boolean(),
          turn: z.number(), pending: candidate.nullable(), offers: z.array(candidate.extend({ turn: z.number(), endSeq: z.number() })),
          // The user's own section constraint, kept as selectors bound to one
          // quoted file signature. Offsets are never stored: a changed document
          // re-resolves them, and an ambiguous or missing title refuses the write.
          section: z.object({
            path: z.string(), signature: z.string(), targets: z.array(z.string()), exclusions: z.array(z.string()),
            invalid: z.boolean(), note: z.string(),
          }) }),
        init: () => ({ ...emptyScope(), turn: -1, pending: null, offers: [], section: emptySectionIntent() }),
        apply: applyReferenceProjection,
      });
      service.resolveAnswer = (session, key) => {
        if (!handle || !session) return null;
        const state = handle.stateOf(session), file = state.files[state.chosen];
        const offer = state.offers.find(o => o.turn === key.turn && o.answerSeq === key.answerSeq && o.endSeq === key.endSeq);
        if (!offer || !file?.signature || offer.file.signature !== file.signature || offer.file.path !== file.path ||
            service.sign(key.sessionId, file.path) !== file.signature || !session.isOwnSeq(offer.userSeq) || !session.isOwnSeq(offer.answerSeq) ||
            !session.surface.nodes.includes(offer.answerSeq) || !session.surface.nodes.includes(offer.userSeq)) return null;
        if (realpathSync.native(file.path) !== file.path) return null;
        const msg = session.deriveMessages().find(m => m.id === offer.messageId && m.role === 'assistant' && m.source?.kind === 'model');
        const body = msg?.content.filter(b => b.type === 'text').map(b => b.text).join('');
        return body?.trim() ? { path: file.path, body } : null;
      };
      // During hot activation a tool can already be on the way. Reconstruct
      // conservatively until the official projection has caught up.
      const read = session => handle ? handle.stateOf(session)
        : { ...session.deriveMessages().reduce(admitMessage, emptyScope()), write: false, section: emptySectionIntent() };
      const removeGuard = tools.guard(exec => {
        if (!exec.agent?.session || service.trustedSelection(exec)) return;
        return authorizeReference(read(exec.agent.session), exec.agent.id, exec, service.sign, tools, scopeParentOf);
      });
      // Native edit and markdown share one write path: the same read, the same
      // "改此处" binding, and one file guard. Tool names are mapped in
      // sectionRequestOf; no path check is re-implemented here.
      const removeHeadingCheck = scope.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision.kind !== 'allow' || !exec.agent?.session || exec.signal?.aborted) return decision;
        const state = read(exec.agent.session);
        if (authorizeReference(state, exec.agent.id, exec, service.sign, tools, scopeParentOf)) return decision;
        // A user-named section is a per-write constraint, not a one-time parse:
        // every write is re-checked against the text as it is right now.
        if (!service.trustedSelection(exec)) {
          const sectioned = await enforceSectionScope(exec, service, state, state.section, log);
          if (sectioned) return sectioned;
        }
        if (exec.name !== 'edit' && !(exec.name === 'markdown' && exec.arguments?.action === 'edit')) return decision;
        const denied = await diagnoseHeadingReplacement(exec, service.readDocument);
        return denied ? { kind: 'deny', ...denied } : decision;
      });
      // Once every guard has allowed the call, this is the last point where a
      // validated revision can still be compared with what the body will write.
      // Native edit has no token parameter, so it is re-proven here; the
      // markdown write is committed here through the same documents service with
      // the revision it was just proven against (its own args are frozen).
      const removeDispatch = scope.on('tools/execute', async (exec, next) => {
        const args = exec.arguments;
        if (!args || typeof args !== 'object' || exec.signal?.aborted) return next();
        if (!['edit', 'markdown', 'write', 'str_replace_editor'].includes(exec.name)) return next();
        const state = read(exec.agent.session);
        const intent = state.section;
        if (!intentMatchesFile(intent, state.files[state.chosen])) return next();
        const path = exec.name === 'edit' || exec.name === 'write' ? args.file_path : args.path;
        if (typeof path !== 'string' || normalize(path) !== intent.path) return next();
        if (service.trustedSelection(exec)) return next();
        if (exec.name === 'edit') {
          // Only the inherited host edit is taken over; a same-named tool from
          // another registration keeps its own commit path.
          if (!isNativeEditTool(exec, tools, scopeParentOf)) return next();
          const reason = await enforceSectionScope(exec, service,
            { files: [{ path: intent.path, signature: intent.signature }], chosen: 0 }, intent, log);
          if (reason) return deniedResult(reason.reason, reason.info);
          // The commit goes through the same documents.applyEdits entry the
          // markdown tool uses, with the revision from its authoritative read
          // as the compare-and-swap token. A save between the read and this
          // commit fails closed; there is no automatic retry against the newer
          // version.
          const done = await runMarkdownWrite(exec, service, intent, log);
          return done || deniedResult('这次编辑无法映射到当前章节，本次未写入；请先 read 目标文件再重试。',
            { name: 'MarkPilotSectionScope', code: 'MP_SECTION_TARGET' });
        }
        if (exec.name === 'markdown' && ['edit', 'insert', 'batch'].includes(args.action)
            && isOurMarkdownTool(exec, tools, scopeParentOf)) {
          const done = await runMarkdownWrite(exec, service, intent, log);
          return done || next();
        }
        return next();
      });
      const removeNotice = scope.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind !== 'enter' || !payload.agent?.session || !decision.messages.some(human)) return decision;
        const base = read(payload.agent.session);
        const state = decision.messages.reduce(admitMessage, base);
        if (!state.files.length) return decision;
        // The section intent lives in the projection, not in admitMessage's
        // file-scope shape. Re-fold this step's messages over it so the notice
        // describes what this very turn will enforce, without a second parse.
        const section = decision.messages.reduce(reduceSectionEvent,
          base.section || emptySectionIntent());
        const note = scopeNotice({ ...state, section })
          + '\n查询可继续使用宿主的读取、检索、提问与文件展示工具。检查磁盘文件的编码、行数、换行与 Markdown 结构请直接用 markdown(action="inspect", path=文件绝对路径)。';
        return { ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user',
          source: { kind: 'markpilot-reference', form: 'notice', summary: note.split('\n')[0].slice(0, 120) },
          content: [{ type: 'text', text: note }] }] };
      });
      void ready.then(value => {
        if (disposed) return;
        handle = value;
        service.ready = true;
      }, error => log.warn?.('MarkPilot 引用保护初始化失败：%s', String(error.message || error)));
      return () => { disposed = true; service.ready = false; removeDispatch(); removeNotice(); removeHeadingCheck(); removeGuard(); };
    }, 'MarkPilot 引用目标');
  });
}
