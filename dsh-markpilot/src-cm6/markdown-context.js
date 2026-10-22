import { StateField } from '@codemirror/state';

// Fenced code has one owner. Commands, projections and exports use this index;
// none of them toggles an independent "inside fence" flag.
export function quoteLead(text, limit = Infinity) {
  let off = 0, depth = 0;
  while (depth < limit) {
    const m = /^ {0,3}>[ \t]?/.exec(text.slice(off));
    if (!m) break;
    off += m[0].length;
    depth++;
  }
  return { off, depth, q: text.slice(0, off) };
}

export function fenceAt(content) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(content || '');
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return null;
  return { fence: m[2], char: m[2][0], len: m[2].length, indent: m[1].length, info: m[3].trim() };
}
export const isFenceAt = content => fenceAt(content) !== null;
export const closesFence = (content, open) => {
  const f = fenceAt(content);
  return !!f && f.char === open.char && f.len >= open.len && !f.info;
};

const listPrefix = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/;
const paragraphLine = text => !!text.trim() && !/^(?: {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|>|(?:[-+*]|\d{1,9}[.)])\s)|\s*(?:-{3,}|\*{3,}|_{3,})\s*$|\s*\|)/.test(text);
function consumeContainers(text, parents, lazy = false) {
  let off = 0; const path = [], segments = [];
  for (const parent of parents) {
    const start = off, rest = text.slice(off);
    if (parent.kind === 'quote') {
      const lead = quoteLead(rest,1);
      if (lead.depth) { off += lead.off; segments.push({kind:'quote',from:start,to:off}); }
      else if (!lazy) break;
    } else {
      const spaces = /^ */.exec(rest)[0].length;
      if (spaces >= parent.width) off += parent.width;
      else if (!lazy && rest.trim()) break;
    }
    path.push(parent);
  }
  return { off, path, segments };
}
function lineContainers(text, pos, previous, lazy, containers) {
  const result = consumeContainers(text,previous,lazy && paragraphLine(text));
  for (;;) {
    const start = result.off, rest = text.slice(start), quote = quoteLead(rest,1), list = !quote.depth && listPrefix.exec(rest);
    if (!quote.depth && !list) break;
    const kind = quote.depth ? 'quote' : 'list', width = quote.depth ? quote.off : list[0].length;
    const parent = { kind, width, from: pos+start, to: pos+text.length, parent: result.path.at(-1) || null };
    result.path.push(parent); containers.push(parent); result.off += width;
    result.segments.push({kind,from:start,to:result.off});
  }
  for (const parent of result.path) parent.to = pos+text.length;
  return result;
}
// Fence ownership and semantic parent records share this single line pass.
export function scanFenceLines(lines, details = null) {
  const blocks = [];
  const records = [], containers = [];
  let open = null, pos = 0, number = 0, previousTo = 0, previousPath = [], lazy = false;
  for (const text of lines) {
    number++;
    const to = pos + text.length;
    let current = null;
    if (open) {
      current = consumeContainers(text, open.ownerPath);
      if (current.path.length < open.ownerPath.length) {
        blocks.push({ ...open, to: previousTo, endLine: number - 1, closeFrom: null });
        open = null; current = null; lazy = false;
      } else if (closesFence(text.slice(current.off), open)) {
        blocks.push({ ...open, to, endLine: number, closeFrom: pos });
        open = null;
        if (current.path.length) records.push({ from: pos, to, lead: current.off, path: current.path, segments: current.segments });
        for (const parent of current.path) parent.to = to;
        previousPath = current.path; lazy = false;
        previousTo = to; pos = to + 1;
        continue;
      }
    }
    if (!open) {
      current = lineContainers(text,pos,previousPath,lazy,containers);
      const fence = fenceAt(text.slice(current.off));
      if (fence) open = { ...fence, depth: current.path.filter(p=>p.kind==='quote').length,
        prefix: current.path.map(p=>({kind:p.kind,width:p.width})), ownerPath: current.path,
        from: pos, syntaxFrom: pos+current.off, openTo: to, bodyFrom: to + 1, startLine: number };
    }
    for (const parent of current.path) parent.to = to;
    if (current.path.length) records.push({ from:pos,to,lead:current.off,path:current.path,segments:current.segments });
    previousPath = current.path; lazy = !open && paragraphLine(text.slice(current.off));
    previousTo = to;
    pos = to + 1;
  }
  if (open) blocks.push({ ...open, to: previousTo, endLine: number, closeFrom: null });
  const result = blocks.map(({ownerPath,...b}) => ({ ...b, bodyFrom: Math.min(b.bodyFrom, b.to) }));
  if (details) Object.assign(details,{records,containers});
  return result;
}
export const scanFencedBlocks = doc => scanFenceLines(doc.iterLines());

export function blockAt(blocks, pos) {
  let low = 0, high = blocks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (blocks[mid].from <= pos) low = mid + 1; else high = mid;
  }
  const b = blocks[low - 1];
  return b && pos <= b.to ? b : null;
}

export function codeBody(text, block) {
  const lead = block.prefix ? consumeContainers(text,block.prefix) : quoteLead(text, block.depth);
  let off = lead.off, indent = 0;
  while (indent < block.indent && text[off] === ' ') { indent++; off++; }
  return { off, text: text.slice(off), q: text.slice(0, lead.off) };
}
let containerEpoch = 0;
function scanContext(doc, previous = null, changes = null) {
  const details = {}, blocks = scanFenceLines(doc.iterLines(),details), epoch = previous?.epoch || ++containerEpoch;
  let nextId = previous?.nextId || 0;
  const key = c=>`${c.kind}:${c.from}:${c.width}`, old = new Map((previous?.containers || []).map(c=>[key({...c,from:changes?changes.mapPos(c.from,1):c.from}),c]));
  for (const c of details.containers) c.id = old.get(key(c))?.id || `c${epoch}:${++nextId}`;
  return { ...details, blocks, epoch, nextId, rebuilt:true };
}
export const scanStructuralContext = doc => scanContext(doc);
const emptyPath = Object.freeze([]);
const emptyContext = Object.freeze({ lead:0, path:emptyPath, segments:emptyPath });
export function structuralContextAt(context,pos) {
  if (!context) return null;
  const rows=context?.records || [];let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].from<=pos)lo=mid+1;else hi=mid;}
  const record=rows[lo-1];
  return record && pos<=record.to ? record : emptyContext;
}

function needsScan(tr,value) {
  let scan = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (scan) return;
    if (/[`~>\n\r]/.test(tr.startState.doc.sliceString(fromA, toA)) || /[`~>\n\r]/.test(inserted.toString())) { scan = true; return; }
    const before=tr.startState.doc.lineAt(fromA).text,after=tr.state.doc.lineAt(fromB).text;
    const record=structuralContextAt(value,fromA),line=tr.startState.doc.lineAt(fromA);
    if (record?.lead && fromA <= line.from+record.lead || /^\s*/.exec(before)[0] !== /^\s*/.exec(after)[0]) { scan=true;return; }
    const signature=t=>{
      const prefix=lineContainers(t,0,[],false,[]);
      return { prefix:JSON.stringify(prefix.path.map(p=>[p.kind,p.width])), paragraph:paragraphLine(t.slice(prefix.off)) };
    };
    const oldSignature=signature(before),newSignature=signature(after);
    if(oldSignature.prefix!==newSignature.prefix){scan=true;return;}
    const previous=line.from ? structuralContextAt(value,line.from-1) : emptyContext;
    if(oldSignature.paragraph!==newSignature.paragraph && (record.path.length || previous.path.length)){scan=true;return;}
    if (quoteLead(tr.startState.doc.lineAt(fromA).text).depth !== quoteLead(tr.state.doc.lineAt(fromB).text).depth) { scan = true; return; }
    for (const [doc, from, to] of [[tr.startState.doc, fromA, toA], [tr.state.doc, fromB, toB]]) {
      const line = doc.lineAt(from), lead = quoteLead(line.text);
      // A closing fence followed by a letter is no longer a closing fence.
      // Prefix whitespace also matters (four spaces are not a fence).
      if (fenceAt(line.text.slice(lead.off)) || to > line.to) { scan = true; return; }
    }
  });
  return scan;
}

export const markdownContext = StateField.define({
  create(state) { return scanContext(state.doc); },
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (needsScan(tr,value)) return scanContext(tr.state.doc,value,tr.changes);
    const map = p => tr.changes.mapPos(p, 1);
    const parents=new Map(value.containers.map(c=>[c,{...c,from:map(c.from),to:map(c.to)}]));
    for(const [old,c] of parents)c.parent=parents.get(old.parent)||null;
    return { ...value, rebuilt: false, containers:[...parents.values()], records:value.records.map(r=>({...r,from:tr.changes.mapPos(r.from,-1),to:map(r.to),path:r.path.map(p=>parents.get(p))})), blocks: value.blocks.map(b => {
      const to = map(b.to), openTo = map(b.openTo);
      return { ...b, from: map(b.from), syntaxFrom: map(b.syntaxFrom), to, openTo, bodyFrom: Math.min(openTo + 1, to), closeFrom: b.closeFrom == null ? null : map(b.closeFrom) };
    }) };
  },
});

export const codeBlockAt = (state, pos) => blockAt(state.field(markdownContext, false)?.blocks || [], pos);

/** 【#41·2026-10-18】光标是否落在**开头那段 front-matter 块**内（与 imageModeOf 同一套正则，口径一致）。
 *  块级命令（toolbar/extras）与图片插入共用这一份判据，避免前缀/模板写进 YAML。 */
export function inFrontMatter(doc, pos) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(doc || ""));
  if (!m) return false;
  return typeof pos === "number" && pos <= m[0].length;
}

/** 【#45·2026-10-18】行首列表标记识别（任务 / 无序 / 有序），前缀命令互转时先剥旧标记。
 *  返回 { len, kind }；没有标记返回 null。toolbar 的 linePrefix 与 extras 的 toggleLinePrefix 共用。 */
export function listMarkerOf(text) {
  let m = /^[-*+]\s\[[ xX]\]\s/.exec(text);
  if (m) return { len: m[0].length, kind: 'task' };
  m = /^[-*+]\s/.exec(text);
  if (m) return { len: m[0].length, kind: 'bullet' };
  m = /^\d+\.\s/.exec(text);
  if (m) return { len: m[0].length, kind: 'ordered' };
  return null;
}

