import { quoteLead, structuralContextAt } from './markdown-context.js';

// Quote depth is a prefix property. Comparisons in prose, TeX and code never
// contribute. Consumers share this semantic record rather than infer DOM classes.
export function containerContext(doc, pos, code = null, baseVersion = 0, structure = null) {
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, pos)));
  const lead = quoteLead(line.text, code?.depth ?? Infinity);
  const record = structuralContextAt(structure,pos);
  if (record) {
    const path = record.path.map(p=>({id:p.id,kind:p.kind,from:p.from,to:p.to,width:p.width,parentId:p.parent?.id || null}));
    const depth = path.filter(p=>p.kind==='quote').length, indent=path.filter(p=>p.kind==='list').reduce((n,p)=>n+p.width,0);
    return { depth, lead:record.lead, indent, from:line.from,to:line.to,path,
      key: `${path.map(p=>p.id+':'+p.kind+':'+p.width).join('/')}:${baseVersion}` };
  }
  const body = line.text.slice(lead.off);
  const list = !code && /^(\s*)(?:[-+*]|\d{1,9}[.)])\s+/.exec(body);
  const indent = list ? list[0].length : 0;
  const depth = code?.depth ?? lead.depth;
  return { depth, lead: lead.off, indent, from: line.from, to: line.to,
    path: [...(depth ? [{ kind: 'quote', depth }] : []), ...(indent ? [{ kind: 'list', indent }] : [])],
    key: `${depth}:${indent}:${baseVersion}` };
}

// A collector reads one immutable document/structure. Inline regions on the
// same physical row share its descriptor; caches never survive that collection.
export function createContainerContextReader(doc, structure = null) {
  const rows = new Map();
  return (pos, code = null, baseVersion = 0) => {
    const line = doc.lineAt(Math.max(0, Math.min(doc.length, pos)));
    const key = `${line.from}:${code == null ? 'none' : code.depth ?? 'unset'}:${baseVersion}`;
    let context = rows.get(key);
    if (!context) {
      context = containerContext(doc,pos,code,baseVersion,structure);
      rows.set(key,context);
    }
    return context;
  };
}

export function bindContainer(element, context, block = true) {
  const depth = context?.depth || 0;
  element.dataset.mpQuoteDepth = String(depth);
  element.dataset.mpQuoteLevel = String(Math.min(3, depth));
  element.dataset.mpContext = context?.key || '0:0:0';
  element.classList.toggle('mp-region-container', block);
  element.classList.toggle('mp-container-quote', block && depth > 0);
  if (block) element.style.setProperty('--mp-region-depth', String(Math.max(0, Math.min(3, depth) - 1)));
  if (block) element.style.setProperty('--mp-region-indent', `${context?.indent || 0}ch`);
  return element;
}
