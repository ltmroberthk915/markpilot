// Pure local policy shared by the Webview and host. No model call is used to
// decide whether to request a completion or to classify the editing context.
const tail = (value, limit) => String(value || '').slice(-limit);
const head = (value, limit) => String(value || '').slice(0, limit);
export function completionPayload(context) {
  return {
    before: tail(context.before, 4000), after: head(context.after, 1000),
    kind: ['math', 'code'].includes(context.kind) ? context.kind : 'prose',
    heading: head(context.heading, 200), nearby: head(context.nearby, 1800),
    sectionContext: head(context.sectionContext, 1200),
    mathBefore: tail(context.mathBefore, 1800), mathAfter: head(context.mathAfter, 1200),
    intent: ['formula', 'argument', 'derivation', 'continuation', 'code'].includes(context.intent) ? context.intent : 'continuation',
  };
}

// Used for source mode and incomplete $... formulas that Lute has not yet
// turned into a math DOM node. Escaped dollars and inline/fenced code are skipped.
export function sourceKind(before) {
  const text = tail(before, 12000);let math = '', start = 0, fence = '', inline = 0;
  for (let i = 0; i < text.length;) {
    const atLine = i === 0 || text[i - 1] === '\n';
    const block = atLine ? text.slice(i).match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/) : null;
    if (block && !math) {
      if (!fence) fence = block[1];
      else if (block[1][0] === fence[0] && block[1].length >= fence.length) fence = '';
      i += block[0].length;continue;
    }
    if (fence) {i++;continue;}
    if (text[i] === '\\') {i += 2;continue;}
    if (text[i] === '`' && !math) {const run = text.slice(i).match(/^`+/)[0].length;inline = inline === run ? 0 : inline || run;i += run;continue;}
    if (!inline && text[i] === '$') {
      const delimiter = text[i + 1] === '$' ? '$$' : '$';
      if (!math) {math = delimiter;start = i + delimiter.length;}
      else if (math === delimiter) math = '';
      i += delimiter.length;continue;
    }
    i++;
  }
  return {kind: math ? 'math' : fence || inline ? 'code' : 'prose', delimiter: math, mathBefore: math ? text.slice(start) : ''};
}

export function intentOf(context) {
  if (context.kind === 'code') return 'code';
  if (context.kind !== 'math') return 'continuation';
  const before = context.mathBefore || '';
  if (/=\s*$|\\(?:implies|Rightarrow|iff)\s*$/.test(before)) return 'derivation';
  if (/[{_^]\s*$/.test(before)) return 'argument';
  return 'formula';
}

export function aiDelay(config, context, trigger) {
  const base = Math.max(400, Math.min(3000, Number(config.delay) || 650));
  const input = context.kind === 'math' ? Math.max(400, base - 150) : Math.max(650, base + 100);
  return trigger === 'cursor' ? Math.max(context.kind === 'math' ? 900 : 1200, input + 300) : input;
}

export function shouldSuggest(context, trigger = 'input') {
  if (trigger === 'manual') return true;
  if (context.kind === 'code' || context.kind !== 'math' && /^[/@!#]/.test(context.prefix || '')) return false;
  if (context.kind === 'math') {
    if ((context.prefix || '') === '\\') return false;
    if (trigger !== 'cursor') return !!(context.before.trim() || context.after.trim());
    const left = (context.mathBefore || '').trimEnd(), right = (context.mathAfter || '').trimStart();
    // Navigation into a blank argument, an unfinished RHS, or an expression
    // gap is useful. Merely clicking the end of a complete equation is quiet.
    return !left || /[=+\-*/^_({,;:]$|\\[A-Za-z]+$/.test(left) || !!right;
  }
  if (!(context.before.trim() || context.after.trim())) return false;
  if (trigger !== 'cursor') return true;
  const line = context.before.split('\n').at(-1).trim();
  return !line || /[：:,，=]$/.test(line) || !!context.after.trim() && !/[。！？.!?]$/.test(line);
}

export const payloadKey = context => JSON.stringify(completionPayload(context));

// Only remove exact overlaps. No LLM "review" request, formula rewriting, or
// guessed replacement ranges. Existing text to the right is never overwritten.
export function cleanSuggestion(value, context) {
  let text = typeof value === 'string' ? value.slice(0, 4000) : '';
  if (context.kind !== 'code' && /^\s*```/.test(text)) return '';
  if (context.kind === 'math') {
    text = text.trim();
    if (/^\$\$[\s\S]*\$\$$/.test(text)) text = text.slice(2, -2).trim();
    else if (/^\$[^$]*\$$/.test(text)) text = text.slice(1, -1).trim();
    // A provider may finish the surrounding Markdown formula and then carry
    // on with prose. Keep its useful math prefix; existing delimiters stay in
    // the document and the extra prose must not enter the formula source.
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\') {i++;continue;}
      if (text[i] === '$') {text = text.slice(0, i).trimEnd();break;}
    }
    if ((context.after || '').includes('$')) text = text.replace(/\${1,2}$/, '');
    // Reject obvious explanations in a math gap; \text{...} remains valid.
    if (/^(?:答案|解释|说明|建议|Here|The answer)[：:\s]/i.test(text)) return '';
  }
  const after = String(context.after || '');
  for (let n = Math.min(text.length, after.length, 1000); n > 0; n--) {
    const overlap = after.slice(0, n);
    if (!text.endsWith(overlap)) continue;
    if (context.kind === 'math' && /^[}\])]+$/.test(overlap)) {
      const balance = (value, open, close) => {
        let count = 0;for (let i = 0; i < value.length; i++) {if (value[i] === '\\') {i++;continue;}if (value[i] === open) count++;if (value[i] === close) count--;}return count;
      };
      const original = context.mathBefore + context.mathAfter;
      const inserted = context.mathBefore + text + context.mathAfter;
      if (![['{','}'],['(',')'],['[',']']].some(([open, close]) => balance(inserted, open, close) < Math.min(0, balance(original, open, close)))) continue;
    } else if (context.kind === 'math' && n === 1 && !/[$]/.test(overlap) && text.length > 1) continue;
    text = text.slice(0, -n);break;
  }
  if (context.kind === 'prose') {
    // Some responses reproduce the existing next formula and then continue
    // writing beyond it. Tail-only overlap removal cannot catch that echo.
    // Cut only a long exact prefix, or a complete matching math expression;
    // short words and partial formulas are deliberately left untouched.
    const prefix = after.slice(0, 1000), anchor = prefix.slice(0, 8);
    if (anchor.length === 8) for (let at = text.indexOf(anchor); at >= 0; at = text.indexOf(anchor, at + 1)) {
      let n = anchor.length;while (n < prefix.length && text[at + n] === prefix[n]) n++;
      const overlap = prefix.slice(0, n);
      const formula = /^\s*\$[^$\n]+\$\s*$/.test(overlap) && sourceKind(overlap).kind === 'prose';
      if ((n >= 16 || formula) && sourceKind(text.slice(0, at)).kind === 'prose') {text = text.slice(0, at);break;}
    }
    // A Chinese sentence stop before an existing English stop would produce
    // “。.”. Retain the user's punctuation and drop punctuation-only answers.
    let followingStop=/^[。.]\s*(?:\n|$)/.test(after);
    const close=after.match(/^(\*\*|__)[。.]\s*(?:\n|$)/);
    if(close){
      const marker=close[1],before=String(context.before||'');let count=0;
      for(let i=0;i<before.length;i++){
        if(before[i]==='\\'){i++;continue;}
        if(before.slice(i,i+2)===marker){
          const inWord=marker==='__'&&/[\p{L}\p{N}]/u.test(before[i-1]||'')&&/[\p{L}\p{N}]/u.test(before[i+2]||'');
          if(!inWord&&sourceKind(before.slice(0,i)).kind==='prose')count++;
          i++;
        }
      }
      // Only look through a confirmed closing bold marker. Never consume
      // delimiters from a new span, a formula, or the user's untouched suffix.
      followingStop ||= count%2===1&&sourceKind(before).kind==='prose';
    }
    if (followingStop && /[。.]$/.test(text) && sourceKind(text).kind==='prose') text = text.slice(0, -1);
    if (/^[\s。，、；：！？,.!?;:]*$/.test(text)) return '';
    // A prose insertion cannot leave a new $... or $$... formula open. The
    // untouched suffix may already start its own formula; treating that opener
    // as a closer would damage the user's existing Markdown.
    if (sourceKind(text).kind === 'math') return '';
  }
  return text;
}

// Reuse the remaining completion when the user types its beginning. Compare
// both sides and the semantic context, including the section and nearby notes.
export function remainingSuggestion(previous, context) {
  if (!previous || Date.now() - previous.time > 90000) return null;
  const old = previous.context, next = completionPayload(context);
  for (const key of ['kind', 'heading', 'nearby', 'after', 'mathAfter', 'sectionContext']) if (old[key] !== next[key]) return null;
  for (let typed = 0; typed <= Math.min(previous.text.length, 512); typed++) {
    if ((old.before + previous.text.slice(0, typed)).slice(-4000) === next.before) return previous.text.slice(typed);
  }
  return null;
}

export function suggestionCache(limit = 24, ttl = 120000) {
  const entries = new Map();
  return {
    get(key) {const value = entries.get(key);if (!value || Date.now() > value.expires) {entries.delete(key);return undefined;}entries.delete(key);entries.set(key, value);return value.text;},
    set(key, text) {entries.delete(key);entries.set(key, {text, expires: Date.now() + (text ? ttl : 20000)});while (entries.size > limit) entries.delete(entries.keys().next().value);},
    clear() {entries.clear();},
  };
}
