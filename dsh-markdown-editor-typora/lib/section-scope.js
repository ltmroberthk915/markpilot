// Section-scoped writes for a bound reference.
//
// A bound reference proves one thing: the model may touch this file. It does not
// prove that a particular edit lands in the section the user named. This module
// keeps the user's section intent as a selector ("M 节", "附录 M：…") and
// resolves it against the authoritative text immediately before each write.
// Nothing here stores offsets: a changed document re-resolves, and a target that
// is no longer unique refuses the write instead of applying an old projection.
//
// The intent is only ever read from the user's own message text (never from the
// assistant, never from the quoted selection block). That parsing lives in
// `reduceSectionEvent`; the write checks are pure and shared by the native edit
// bridge and the markdown tool.

import {
  applyChanges, countDocumentLines, findDocumentBlock, normalizeEol,
  parseDocumentBlocks, planDocumentInsertion, planLineEdit, replaceExact, validateEdits,
} from './documents-service.js';

const REFERENCE_HEADER = /^> 只读引用：(.+?) · (?:第 \d+(?:[–-]\d+)? 行|文件)(?: 【MP引用 ([\w-]{43})】)?$/u;
const RPC_EDIT = 'mp-edit:';
const CANCEL_TEXT = /(?:结束引用|取消引用|取消|算了|只讨论|仅讨论|先给我看|只给我看|不要改了?|别改了?|不用改了?|不要写了?|别写了?|不写了?|不要落地|不落盘)/u;
const TARGET_SWITCH = /^(?:选择目标|修改目标)/u;
const NEGATIVE_TARGET = /(?:不要|不用|不必|别|不得|不许|不准|先不|不需要)(?:再|去)?\s*(?:改|修改|动|碰|调整|写|更新|替换|补|插入|加)(?:到|进|入)?\s*([^，,。；;！!？?\n]{1,60})/gu;
const LEADING_POLITE = /^(?:(?:请你?|您|你|麻烦你?|帮我|给我|先|再|直接|现在|那就|也|都)\s*)+/u;
const QUESTION = /什么|哪里|哪儿|哪些|怎样|怎么|如何|会不会|好不好|你觉得|能否|是否|要不要|能不能|可不可以|[?？]|[吗呢]\s*$/u;

const DESIGNATOR = '(?:[A-Za-z]|[0-9]+(?:\\.[0-9]+)*|[一二三四五六七八九十百]+|[甲乙丙丁戊己庚辛壬癸])';
const TITLE_TAIL = '(?:\\s*[:：]\\s*[^\\n，,。；;!?！？]{1,40})?';
// A section token: 附录 M：… / 第 3 节 / M 节 / 3.2 节 / M：标题. A bare multi-letter
// word can never be a token ("更新 README" names a file, not a section); the
// bare single-letter form ("改 J") is handled by SHORT_TARGET below.
const TOKEN = '(?:#{1,6}\\s*)?(?:附录\\s*' + DESIGNATOR + TITLE_TAIL
  + '|第\\s*' + DESIGNATOR + '\\s*[节章]'
  + '|' + DESIGNATOR + '\\s*[节章]'
  + '|' + DESIGNATOR + '\\s*[：:]\\s*[^\\n，,。；;!?！？]{1,40})';

// "改 J" / "换 J" / "换到 J": a single Latin letter standing alone. This form
// has no 节/章 marker, so it must stay narrow: a letter that starts a file name
// ("改 A.md 的错别字") names a file, not section A.
const SHORT_TARGET = /^(?:那?就?)?(?:只|仅)?\s*(?:改|修改|调整|更新|修订|重写|换(?:成|到)?|替换成|改到|转到|改用|补到|加到)\s*([A-Za-z])(?![A-Za-z0-9])(?![.。][A-Za-z0-9])/u;

const POSITIVE_PATTERNS = [
  // 把这个加到 M 节 / 补到附录 M / 插入 3.2 节
  new RegExp('^(?:(?:把|将)[^，,。；;]{1,120}?)?(?:加到|加进|加至|补到|补入|补进|补至|放到|放进|放入|插入到?|插入至|追加到?|写进|写入|添加(?:到|至|入)?|新增到?|移至|移到|挪到|贴到|附到|放至|更新到)\\s*(' + TOKEN + ')', 'u'),
  // 只改 M 节 / 修改附录 M / 调整 3.2 节
  new RegExp('^(?:只|仅|请|再|先|直接|帮我|麻烦)?\\s*(?:把|将)?\\s*(?:改|修改|调整|更新|修订|重写|替换|动|处理|完善|补充|补写)\\s*(?:一下|下|好|成)?\\s*(' + TOKEN + ')', 'u'),
  // 把 M 节改一下 / 在 M 节里加 / 对 M 节调整
  new RegExp('^(?:把|将|在|对|往)\\s*(' + TOKEN + ')\\s*(?:这一?[节章]|这段|这里|里面|里|中|内|的|正文)?\\s*(?:的)?(?:合适位置|适当位置|合适的地方)?\\s*(?:改|修改|调整|更新|修订|重写|替换|补充|插入|加|动|处理)', 'u'),
  // 换 J / 换到 J 节 / 改到附录 M
  new RegExp('^(?:换(?:成|到)?|替换成|改到|转到|改用)\\s*(' + TOKEN + ')', 'u'),
];

const EXCLUDED_RANGE_REASON = '这次修改会碰到你要求不要动的';
const ONE_LINE = text => String(text).replace(/\s*\n\s*/gu, ' ').trim();

// A heading token ends where the heading line's own title ends: "## M 节" and
// "## 附录 M：…" are both allowed to follow the designator.
const SEPARATOR_AFTER_TITLE = /^[：:\-—–·、,，.。!?！？)\]）】节章\s]/u;

function blocked(code, reason) {
  return { ok: false, code, reason: ONE_LINE(reason) };
}

export const emptySectionIntent = () => ({
  path: '', signature: '', targets: [], exclusions: [], invalid: false, note: '',
});

export function stripScopeNegations(text) {
  return String(text ?? '').replace(NEGATIVE_TARGET, ' ');
}

function splitExclusionList(raw) {  const parts = String(raw || '')
    .split(/[、,，;；]+|(?:以及|和|及|与)/u)
    .map(part => part.replace(/[「」“”"]/gu, '').trim().replace(/[了了吧哦啊呀吧呢。.!！]+$/u, '').trim())
    .filter(Boolean);
  // "别动 J 节" splits to ["J", "节"] on the space; rejoin a lone Latin letter
  // with a following 节/章 so the exclusion keeps the shape the user typed.
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (/^[A-Za-z]$/u.test(part) && /^[节章]/u.test(parts[index + 1] || '')) {
      out.push(part + parts[index + 1]);
      index += 1;
      continue;
    }
    out.push(part);
  }
  return out;
}

function normalizeToken(token) {
  return String(token ?? '').normalize('NFKC').replace(/^#{1,6}\s*/u, '').replace(/[「」“”"]/gu, '')
    .replace(/\s+/gu, '').toLowerCase();
}

function uniqueByKey(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = normalizeToken(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(item).trim());
  }
  return out;
}

function isQuestion(clause) {
  return QUESTION.test(clause.trim());
}

/**
 * Read a section directive out of the user's own message text. Negative list
 * items ("别动 J、架构图和目录") become exclusions and are removed before the
 * positive clauses are scanned, so an exclusion is not mistaken for a refusal
 * to edit and is not promoted to a target.
 */
export function readSectionDirective(body) {
  const source = String(body ?? '').replace(/[「」“”"]/gu, ' ');
  if (!source.trim()) return null;
  const exclusions = [];
  const stripped = source.replace(NEGATIVE_TARGET, (_match, list) => {
    for (const token of splitExclusionList(list.replace(/(?:然后|接着|另外|同时|并且|顺带).*$/u, ''))) exclusions.push(token);
    return ' ';
  });
  const targets = [];
  for (const clause of stripped.split(/[，,。；;！!？?\n]+/u)) {
    const core = clause.trim().replace(LEADING_POLITE, '');
    if (!core || isQuestion(core)) continue;
    let hit = null;
    for (const pattern of POSITIVE_PATTERNS) {
      hit = pattern.exec(core);
      if (hit && hit[1]) break;
      hit = null;
    }
    if (!hit) hit = SHORT_TARGET.exec(core);
    if (hit && hit[1]) targets.push(hit[1].trim());
  }
  const cleanTargets = uniqueByKey(targets);
  const cleanExclusions = uniqueByKey(exclusions);
  if (!cleanTargets.length && !cleanExclusions.length) return null;
  const targetKeys = new Set(cleanTargets.map(sectionKeyOf));
  const conflict = cleanExclusions.find(token => targetKeys.has(sectionKeyOf(token)));
  if (conflict) {
    return {
      targets: [], exclusions: [], conflict: true,
      note: '你同时要求修改和不要修改「' + conflict + '」，本次未写入；请明确最终要改哪一节。',
    };
  }
  return { targets: cleanTargets, exclusions: cleanExclusions, conflict: false, note: '' };
}

export function reduceSectionEvent(state, event, selectedFile) {
  if (event.type !== 'user/message') return state;
  const message = event.data;
  if (!message || message.role !== 'user' || message.source?.kind !== 'user') return state;
  if (String(message.source?.rpcId || '').startsWith(RPC_EDIT)) return state;
  const content = (Array.isArray(message.content) ? message.content : [])
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
  const quoted = [];
  const own = [];
  // Same quote fence as admitMessage: a header opens the quoted block and the
  // first line without the quote marker closes it. Quoted body text (a
  // selection that happens to say "只改 M 节") never reaches the directive
  // reader, so neither the document nor the assistant can grant scope.
  let inQuote = false;
  for (const line of content.split(/\r?\n/u)) {
    const legacy = !line.startsWith('>') && line.startsWith('只读引用：');
    if (line.startsWith('>') || legacy) {
      if (!inQuote) {
        const match = REFERENCE_HEADER.exec(legacy ? '> ' + line : line);
        if (match) quoted.push({ path: match[1], signature: match[2] || '' });
      }
      inQuote = true;
      continue;
    }
    inQuote = false;
    own.push(line);
  }
  const body = own.join('\n').trim();
  let next = state;
  if (quoted.length) {
    const file = quoted[quoted.length - 1];
    // A fresh quote of another file, a changed file revision, or a multi-file
    // selection revokes the old section intent. The same quote keeps it. With
    // several quoted files the binding follows the file the scope selected
    // rather than guessing from the last header.
    const bound = quoted.length === 1
      ? file
      : (selectedFile && typeof selectedFile.path === 'string' ? selectedFile : file);
    const same = quoted.length === 1 && state.path === file.path && state.signature === file.signature;
    next = same ? state : { ...emptySectionIntent(), path: bound.path,
      signature: typeof bound.signature === 'string' ? bound.signature : '' };
  }
  const directive = readSectionDirective(body);
  const paused = (note) => {
    const selected = selectedFile && typeof selectedFile.path === 'string' ? selectedFile : null;
    const path = next.path || selected?.path || '';
    const signature = selected && selected.path === path
      ? (typeof selected.signature === 'string' ? selected.signature : '')
      : (typeof next.signature === 'string' ? next.signature : '');
    return {
      ...emptySectionIntent(),
      ...(path ? { path, signature } : { blocked: true }),
      exclusions: Array.isArray(next.exclusions) ? next.exclusions : [],
      invalid: true,
      note,
    };
  };
  // Ending the reference or changing files is the only thing that clears the
  // bound file. A discussion turn keeps that file identity but is not a write
  // permission, so a later native edit cannot fall back to whole-file scope.
  if (!directive?.targets?.length
      && /(?:结束|取消|解除|清空|关闭|关掉|退出|不用|不要|不再|别)(?:再)?(?:这段|这个|该|对|本次)?(?:引用|引述)/u.test(body))
    return emptySectionIntent();
  const negatedWrite = /(?:别|不要|不用|无需|不需要|先不|暂不|勿|禁止|停止|取消)(?:再)?(?:改|写|编辑|修改|动|碰|更新|替换|删除|插入)/gu;
  const writeVerb = /(?:改|写|编辑|修改|替换|插入|删除|移除|重写|润色|调整|更新|加上|加到|追加|移动|合并)/u;
  const discussion = /(?:只|先|请|帮我|我们|咱们|再)?(?:讨论|解释|说明|分析|讲解|介绍|总结|梳理|评价|看看|看一下|读一下|讲讲|聊|为什么|怎么理解)/u;
  if (discussion.test(body) && !writeVerb.test(body.replace(negatedWrite, '')))
    return paused('本轮只讨论，未授权写入；请明确说明要修改的章节。');
  // '只改 M 节，别改 J' contains 别改 but names where to write, so the cancel
  // words must not decide anything while a target is explicit. Only a message
  // with no target can be a stop ('先不要改', '算了').
  if (TARGET_SWITCH.test(body)) return emptySectionIntent();
  if (!directive?.targets?.length && CANCEL_TEXT.test(body))
    return paused('本轮未授权写入；引用文件保留，请明确要修改的章节。');
  if (!directive) return next;
  if (directive.conflict) {
    const selected = selectedFile && typeof selectedFile.path === 'string' ? selectedFile : null;
    const path = next.path || selected?.path || '';
    const signature = selected && selected.path === path
      ? (typeof selected.signature === 'string' ? selected.signature : '')
      : (typeof next.signature === 'string' ? next.signature : '');
    return {
      ...emptySectionIntent(),
      ...(path ? { path, signature } : {}),
      invalid: true,
      note: directive.note,
    };
  }
  // A new explicit target lifts the discussion pause; it must not carry the old
  // invalid flag forward.
  if (next.invalid === true || next.blocked === true) {
    next = { ...next };
    delete next.invalid;
    delete next.note;
    delete next.blocked;
  }
  // A chapter named explicitly belongs to the file the user actually selected;
  // rebinding the file and its revision keeps an old projection from widening
  // the scope to the whole document.
  if (selectedFile && typeof selectedFile.path === 'string') {
    next = { ...next, path: selectedFile.path,
      signature: typeof selectedFile.signature === 'string' ? selectedFile.signature : '' };
  }
  if (!next.path) {
    return {
      ...emptySectionIntent(),
      targets: Array.isArray(next.targets) ? next.targets : [],
      exclusions: Array.isArray(next.exclusions) ? next.exclusions : [],
      invalid: true,
      blocked: true,
      note: '没有已选文件可绑定该章节，本轮不可写入；请先引用目标文件并指明章节。',
    };
  }
  // A new explicit target replaces the previous one ("换 J" switches). A new
  // negative list adds to the old one, because "别动 J" is a standing limit
  // rather than a replacement. Naming a target explicitly lifts an older
  // exclusion of that same target, so "明确换 J 可以换" stays possible.
  const targets = directive.targets.length ? directive.targets : next.targets;
  const named = new Set(directive.targets.map(sectionKeyOf));
  // Only an exclusion left over from an earlier turn is lifted. A limit stated
  // in this same message (只改 J 节，别动 J) is appended untouched below, so a
  // later grant can never filter out the exclusion the user just repeated.
  const inherited = next.exclusions.filter(token => !named.has(sectionKeyOf(token)));
  const exclusions = uniqueByKey([...inherited, ...directive.exclusions]);
  return { ...next, targets, exclusions, invalid: false, note: '' };
}

export function intentMatchesFile(intent, file) {
  return !!intent && !!file && !!file.signature && intent.path === file.path
    && intent.signature === file.signature
    && (intent.targets.length > 0 || intent.exclusions.length > 0);
}

export function describeSectionIntent(intent) {
  const quote = list => list.map(token => '「' + token + '」').join('、');
  const targets = Array.isArray(intent?.targets) ? intent.targets : [];
  const exclusions = Array.isArray(intent?.exclusions) ? intent.exclusions : [];
  if (targets.length) return '只改' + quote(targets) + (exclusions.length ? '（不动' + quote(exclusions) + '）' : '');
  if (exclusions.length) return '不动' + quote(exclusions);
  return '';
}

// ── heading parsing helpers ─────────────────────────────────────────────────

function nextLineStart(text, from) {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) return index + 1;
    if (code === 13) return text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
  }
  return text.length;
}

function lineBreakIndex(text, from) {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) return index;
  }
  return text.length;
}

// ATX headings own one line; setext headings own the title line and the
// underline line. Either way the section body starts on the next line.
function headingBodyStart(text, block) {
  const firstEnd = lineBreakIndex(text, block.from);
  const firstLine = text.slice(block.from, firstEnd);
  const afterFirst = nextLineStart(text, block.from);
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/u.test(firstLine)) return afterFirst;
  return nextLineStart(text, afterFirst);
}

function buildSpans(text, blocks) {
  return blocks.map((block, index) => {
    let end = text.length;
    for (let next = index + 1; next < blocks.length; next += 1) {
      if (blocks[next].level <= block.level) { end = blocks[next].from; break; }
    }
    return {
      title: block.title, level: block.level,
      headingFrom: block.from, bodyFrom: headingBodyStart(text, block), end,
    };
  });
}

function chineseNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  let total = 0, current = 0;
  for (const char of String(value)) {
    if (char === '百') { total += (current || 1) * 100; current = 0; }
    else if (char === '十') { total += (current || 1) * 10; current = 0; }
    else if (digits[char] !== undefined) current = current * 10 + digits[char];
    else return null;
  }
  return total + current;
}

function canonicalCode(code) {
  const value = String(code || '').toLowerCase();
  if (/^[0-9]+(?:\.[0-9]+)*$/u.test(value)) return value.replace(/^0+(?=\d)/u, '');
  if (/^[一二三四五六七八九十百]+$/u.test(value)) {
    const number = chineseNumber(value);
    return number === null ? value : String(number);
  }
  return value;
}

// One section identity: the designator plus its dotted numbering, so M, M.6 and
// 附录 M share "m" while M.6 keeps "m.6" and can never be mistaken for the
// main section. The 附录/第/节 spelling is presentation, not identity: users
// say "M 节" for a heading that reads "## 附录 M：担保品管理详解".
function numberKeyOf(text) {
  const key = normalizeToken(text).replace(/^附录\s*/u, '').replace(/^第\s*/u, '');
  const match = /^([a-z]|[0-9]+|[甲乙丙丁戊己庚辛壬癸]|[一二三四五六七八九十百]+)((?:[.．][0-9]+)*)/u.exec(key);
  if (!match) return null;
  const dots = match[2].replace(/．/gu, '.');
  return canonicalCode(match[1]) + dots;
}

// Section identity for scope bookkeeping: J, J 节 and 附录 J are one section;
// J.3 and J.4 each keep their dotted code and never collapse into J. A token
// with no designator (架构图, 目录, README, J 节点) keeps a literal key, so a
// standing exclusion is never widened by accident.
function sectionKeyOf(text) {
  const key = normalizeToken(text);
  const numbered = numberKeyOf(key);
  const designator = /^(?:附录\s*)?(?:第\s*)?(?:[a-z]|[0-9]+|[甲乙丙丁戊己庚辛壬癸]|[一二三四五六七八九十百]+)(?:[.．][0-9]+)*(?:[节章])?(?:[：:]|$)/u;
  if (!numbered || !designator.test(key)) return key;
  return numbered;
}

function titleTailOf(text) {
  const key = normalizeToken(text);
  const stripped = key.replace(/^附录\s*/u, '').replace(/^第\s*/u, '')
    .replace(/^([a-z]|[0-9]+|[甲乙丙丁戊己庚辛壬癸]|[一二三四五六七八九十百]+)([.．][0-9]+)*\s*(?:[节章])?/u, '');
  return stripped.replace(/^[：:\-—–·、,，.。!?！？)\]）】]+/u, '');
}

function headingMatches(token, title) {
  const wanted = normalizeToken(token);
  const actual = normalizeToken(title);
  if (!wanted || !actual) return false;
  if (actual === wanted) return true;
  if (actual.startsWith(wanted) && SEPARATOR_AFTER_TITLE.test(actual.charAt(wanted.length))) return true;
  const want = numberKeyOf(wanted);
  const have = numberKeyOf(actual);
  if (!want || !have || want !== have) return false;
  // Same designator: an explicit title tail ("M：数据字典") must also match.
  const tail = titleTailOf(wanted);
  if (!tail) return true;
  return titleTailOf(actual).startsWith(tail) || actual.includes(tail);
}

// The user spelled this exact title (or its prefix before a separator), so it
// wins over a merely equivalent designator elsewhere in the document.
function literalMatch(token, title) {
  const wanted = normalizeToken(token);
  const actual = normalizeToken(title);
  if (!wanted) return false;
  if (actual === wanted) return true;
  return actual.startsWith(wanted) && SEPARATOR_AFTER_TITLE.test(actual.charAt(wanted.length));
}

function lineOf(text, offset) {
  const at = Math.max(0, Math.min(Number(offset) || 0, text.length));
  return countDocumentLines(text.slice(0, at));
}

/**
 * Resolve the stored selectors against one exact revision. Duplicate or missing
 * titles refuse the whole write: the user's "M 节" must identify exactly one
 * real parser heading, not a TOC link and not a fenced pseudo heading.
 */
export function resolveSectionIntent(text, intent) {
  const src = String(text ?? '');
  let blocks, spans;
  try {
    blocks = parseDocumentBlocks(src).filter(block => block.kind === 'heading');
    spans = buildSpans(src, blocks);
  } catch {
    return blocked('MP_SECTION_PARSE', '无法解析当前正文的章节结构，本次未写入。');
  }
  const sections = [];
  const seen = new Set();
  for (const token of Array.isArray(intent?.targets) ? intent.targets : []) {
    const hits = [];
    const literal = [];
    for (let index = 0; index < blocks.length; index += 1) {
      if (!headingMatches(token, blocks[index].title)) continue;
      hits.push(spans[index]);
      // A literal spelling ("附录 M", "M 节") outranks designator equivalence:
      // the document may have both "## 附录 M：…" and "## M 节", and the user's
      // own words already pick one. Only same-rank duplicates are ambiguous.
      if (literalMatch(token, blocks[index].title)) literal.push(spans[index]);
    }
    const ranked = literal.length ? literal : hits;
    if (!ranked.length) {
      return blocked('MP_SECTION_NOT_FOUND',
        '没有找到标题「' + token + '」，本次未写入；请先用 blocks 核对真实标题。');
    }
    if (ranked.length > 1) {
      const listed = ranked.slice(0, 3)
        .map(hit => '第 ' + lineOf(src, hit.headingFrom) + ' 行「' + hit.title + '」').join('、');
      return blocked('MP_SECTION_AMBIGUOUS',
        '标题「' + token + '」不唯一（' + listed + (ranked.length > 3 ? ' 等' : '') + '），本次未写入；请改用完整标题。');
    }
    if (!seen.has(ranked[0].headingFrom)) {
      seen.add(ranked[0].headingFrom);
      sections.push(ranked[0]);
    }
  }
  const excluded = [];
  for (const token of Array.isArray(intent?.exclusions) ? intent.exclusions : []) {
    for (let index = 0; index < blocks.length; index += 1) {
      if (headingMatches(token, blocks[index].title)) excluded.push(spans[index]);
    }
  }
  for (const section of sections) {
    for (const hidden of excluded) {
      if (hidden.headingFrom <= section.headingFrom && section.end <= hidden.end) {
        return blocked('MP_SECTION_CONFLICT',
          '你要求只改「' + section.title + '」，同时又要求不要动包含它的「' + hidden.title + '」，本次未写入。');
      }
    }
  }
  return { ok: true, sections, excluded, blocks, spans };
}

// ── write planning and validation ──────────────────────────────────────────

function planFailure(error, resolved) {
  const code = String(error?.code || '');
  const exact = resolved?.sections?.[0]?.title;
  if (code === 'FS_EDIT_NOT_FOUND') {
    return blocked(code, '没有在当前正文里找到替换原文，本次未写入；请先 read，再在该节内重试。');
  }
  if (code === 'FS_AMBIGUOUS_EDIT') {
    return blocked(code, '替换原文出现多次，本次未写入；请带上前后文，让它在全文中唯一。');
  }
  if (code === 'MP_INSERT_NOT_FOUND' || code === 'MP_INSERT_AMBIGUOUS') {
    return blocked(code, 'insert 未能唯一定位标题，本次未写入；请用 position:"after", heading:'
      + JSON.stringify(exact || '该节完整标题') + '，或该节内唯一的 anchorText。');
  }
  if (code === 'MP_INSERT_INVALID' || code === 'MP_SECTION_EDIT_INVALID') {
    return blocked(code, 'insert 需要 position 和该节完整标题，本次未写入；请用 position:"after", heading:'
      + JSON.stringify(exact || '该节完整标题') + ', newString=新增正文，或改用该节内唯一 anchorText。');
  }
  if (code === 'MP_BLOCK_NOT_FOUND') {
    return blocked(code, '块 ID 已失效，本次未写入；请重新 blocks 后在该节内重试。');
  }
  if (code === 'MP_LINE_RANGE') {
    return blocked(code, '行号超出当前正文，本次未写入；请重新 read 后再在该节内按行修改。');
  }
  return blocked(code || 'MP_SECTION_PLAN', '无法规划这次修改，本次未写入。');
}

function planRequest(text, request, resolved) {
  try {
    if (request.kind === 'literal') {
      if (typeof request.oldString !== 'string' || request.oldString === ''
          || typeof request.newString !== 'string') {
        return blocked('MP_SECTION_EDIT_INVALID', '替换原文或替换结果为空，本次未写入。');
      }
      const exact = replaceExact(text, request.oldString, request.newString, request.replaceAll === true);
      return { ok: true, changes: exact.changes, newText: exact.newText };
    }
    if (request.kind === 'line') {
      const plan = planLineEdit(text, {
        fromLine: request.fromLine, toLine: request.toLine, newString: request.newString,
      });
      return { ok: true, changes: plan.changes, newText: plan.newText };
    }
    if (request.kind === 'block') {
      const block = findDocumentBlock(text, request.blockId);
      if (!block) return blocked('MP_BLOCK_NOT_FOUND', '块 ID 已失效，本次未写入；请重新 blocks 后在该节内重试。');
      let insert = normalizeEol(String(request.newString ?? ''));
      if (block.to < text.length && !insert.endsWith('\n')) insert += '\n';
      const changes = [{ from: block.from, to: block.to, insert }];
      return { ok: true, changes, newText: applyChanges(text, changes) };
    }
    if (request.kind === 'insert') {
      const change = planDocumentInsertion(text, request.arguments, undefined);
      const changes = [change];
      return { ok: true, changes, newText: applyChanges(text, changes) };
    }
    if (request.kind === 'offsets') {
      const changes = validateEdits(text, request.edits, { allowCr: true });
      return { ok: true, changes, newText: applyChanges(text, changes) };
    }
    return blocked('MP_SECTION_UNSUPPORTED', '带章节限定时不支持这种修改形式，本次未写入。');
  } catch (error) {
    return planFailure(error, resolved);
  }
}

function touchesRange(change, from, to) {
  if (change.from === change.to) return change.from > from && change.from < to;
  return change.from < to && change.to > from;
}

function shiftBefore(changes, offset) {
  let delta = 0;
  for (const change of changes) {
    if (change.to <= offset) delta += change.insert.length - (change.to - change.from);
    else break;
  }
  return delta;
}

// Headings that are really introduced *inside* the inserted slice. A heading
// that starts mid-line is not a heading, so the probe is prefixed with a line
// break and that first fake start is discarded unless the insert really begins
// at a line start in the document.
function insertedHeadings(text, change) {
  if (!change.insert) return [];
  const probe = '\n' + change.insert;
  const atLineStart = change.from === 0 || /[\r\n]/u.test(text.charAt(change.from - 1));
  const headings = [];
  for (const block of parseDocumentBlocks(probe)) {
    if (block.kind !== 'heading') continue;
    if (block.from > 1 || (block.from === 1 && atLineStart)) {
      headings.push({ level: block.level, title: block.title });
    }
  }
  return headings;
}

function validatePlan(text, plan, resolved) {
  const { sections, excluded, blocks, spans } = resolved;
  const changes = [...plan.changes].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const change of changes) {
    if (sections.length) {
      const holder = sections.find(section => change.from >= section.bodyFrom && change.to <= section.end);
      if (!holder) {
        const names = sections.map(section => '「' + section.title + '」（第 '
          + lineOf(text, section.bodyFrom) + ' 行起）').join('、');
        return blocked('MP_SECTION_OUTSIDE',
          '这次修改不在' + names + '的正文内，本次未写入；只能在该节正文里替换或新增，不能改标题或越到别的节。');
      }
    }
    for (const hidden of excluded) {
      if (touchesRange(change, hidden.headingFrom, hidden.end)) {
        return blocked('MP_SECTION_EXCLUDED', EXCLUDED_RANGE_REASON + '「' + hidden.title + '」，本次未写入。');
      }
    }
  }
  if (!sections.length) return { ok: true, changes, sections, newText: plan.newText };

  let newBlocks;
  try {
    newBlocks = parseDocumentBlocks(plan.newText).filter(block => block.kind === 'heading');
  } catch {
    return blocked('MP_SECTION_PARSE', '修改后的正文无法解析章节结构，本次未写入。');
  }
  const exactKeys = new Set(newBlocks.map(block => block.level + ':' + normalizeToken(block.title)));
  const numberKeys = new Map();
  for (const block of newBlocks) {
    const key = numberKeyOf(block.title);
    if (key) numberKeys.set(key + '@' + block.level, (numberKeys.get(key + '@' + block.level) || 0) + 1);
  }

  // A heading line inside the section may be renamed — that is a normal edit to
  // the section's own text. What may not happen is a heading quietly vanishing
  // (its body hoisted into the parent) or its number changing to another one.
  // Headings outside the section must survive byte-for-byte: gluing text onto
  // the next heading line would otherwise delete that whole following section.
  for (let index = 0; index < blocks.length; index += 1) {
    const span = spans[index];
    const block = blocks[index];
    const insideTarget = sections.some(section => span.headingFrom >= section.bodyFrom && span.headingFrom < section.end);
    const touched = changes.some(change => touchesRange(change, span.headingFrom, span.bodyFrom));
    if (!touched) {
      // Not part of this edit: any disappearance is collateral damage.
      if (!exactKeys.has(block.level + ':' + normalizeToken(block.title))) {
        return blocked('MP_SECTION_ESCAPE',
          '这次修改会消掉另一节的标题「' + block.title + '」，本次未写入；请在插入文字后保留换行，避免与后面的标题粘在一起。');
      }
      continue;
    }
    if (!insideTarget) continue;
    if (exactKeys.has(block.level + ':' + normalizeToken(block.title))) continue;
    const number = numberKeyOf(block.title);
    if (number && (numberKeys.get(number + '@' + block.level) || 0) > 0) continue;
    if (!number) {
      // An unnumbered subheading may be retitled at the same level; it may not
      // disappear or change level.
      const sameLevel = newBlocks.filter(candidate => candidate.level === block.level).length;
      const before = blocks.filter(candidate => candidate.level === block.level).length;
      if (sameLevel >= before) continue;
    }
    return blocked('MP_SECTION_SUBHEADING',
      '这次替换会改掉或删掉本章原有子标题「' + block.title + '」，本次未写入；请保留该标题行（可改标题文字，保持编号与层级）。');
  }

  for (const change of changes) {
    const holder = sections.find(section => change.from >= section.bodyFrom && change.to <= section.end);
    if (!holder) continue;
    let headings = [];
    try { headings = insertedHeadings(text, change); } catch { headings = []; }
    for (const heading of headings) {
      if (heading.level <= holder.level) {
        return blocked('MP_SECTION_ESCAPE',
          '新增内容里有同级或更高级标题「' + heading.title + '」，会越出「' + holder.title + '」，本次未写入。');
      }
    }
  }

  // Inserting a line break mid-line can turn the following text into a heading
  // without the inserted slice itself containing one. Detect that composition.
  for (const change of changes) {
    const atLineStart = change.from === 0 || /[\r\n]/u.test(text.charAt(change.from - 1));
    if (atLineStart || !/(?:\r\n|[\r\n])$/u.test(change.insert)) continue;
    const holder = sections.find(section => change.from >= section.bodyFrom && change.to <= section.end);
    if (!holder) continue;
    const endNew = change.from + shiftBefore(changes, change.from) + change.insert.length;
    for (const block of newBlocks) {
      if (block.from === endNew && block.level <= holder.level) {
        return blocked('MP_SECTION_ESCAPE',
          '插入的换行把后面的文字变成了「' + block.title + '」标题，会越出「' + holder.title + '」，本次未写入。');
      }
    }
  }
  return { ok: true, changes, sections, newText: plan.newText };
}

/**
 * Validate one write request against the user's section intent on the current
 * authoritative text. Every request is planned whole; a batch with one
 * out-of-scope item writes nothing.
 *
 * request kinds: literal | line | block | insert | offsets | unsupported
 */
export function enforceSectionWrite({ text, intent, request }) {
  // An invalid (self-contradictory) directive refuses before any length check:
  // "targets=[]" is also what a conflict produces, and reading that as "no
  // constraint" would turn a refused constraint into a whole-file grant.
  if (intent?.invalid) {
    return blocked('MP_SECTION_INVALID', intent.note || '章节约束不明确，本次未写入；请明确要改哪一节。');
  }
  if (!intent || (!intent.targets?.length && !intent.exclusions?.length)) {
    return { ok: true, changes: [], sections: [] };
  }
  const resolved = resolveSectionIntent(text, intent);
  if (resolved.ok !== true) return resolved;
  if (request?.kind === 'unsupported') {
    return blocked('MP_SECTION_UNSUPPORTED', request.reason || '带章节限定时不支持这种修改形式，本次未写入。');
  }
  const plan = planRequest(text, request || {}, resolved);
  if (plan.ok !== true) return plan;
  return validatePlan(text, plan, resolved);
}
