// Bounded whole-table width trials. Estimates propose; browser layout decides.
const groupsByView = new WeakMap();
const fontProps = ['font','fontKerning','fontFeatureSettings','fontVariant','letterSpacing','wordSpacing','whiteSpace','wordBreak','overflowWrap','lineBreak','textIndent','textTransform','boxSizing','webkitLineBreak','tabSize'];
const parityProps = [...fontProps, 'display','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','marginTop','marginRight','marginBottom','marginLeft','hyphens','tabSize','tableLayout','borderCollapse','borderSpacing','verticalAlign','position','float','writingMode','direction','minWidth','maxWidth'];
const allowed = new Set(['STRONG','EM','B','I','CODE','A','S','U']);
const finite = value => Number.isFinite(value) && value > 0;
function registry(view) {
  let groups = groupsByView.get(view);
  if (!groups) { groups = new Map(); groupsByView.set(view, groups); }
  return groups;
}
function abort(group) {
  group.token++;
  if (group.raf) cancelAnimationFrame(group.raf);
  group.raf = 0; group.pending = false;
  group.host?.remove(); group.host = null;
}
function liveMembers(group) {
  return [...group.members.values()].filter(m => m.valid() && m.table.isConnected).sort((a,b)=>a.ordinal-b.ordinal);
}
function members(group) { return liveMembers(group).filter(m => m.source() === group.signature); }
function inputKey(group) { return JSON.stringify([group.signature,group.generation,group.avail]); }
function current(group, token) {
  if (document.fonts?.status === "loading") return false;
  const rows = members(group);
  if (group.registry.get(group.key) !== group || group.token !== token || rows.length !== group.rowCount ||
      rows.some((m,i)=>m.ordinal!==i || m.active() || m.generation()!==group.generation || m.source()!==group.signature)) return false;
  return true;
}
function apply(group, vector, fallback = false) {
  for (const m of (fallback ? liveMembers(group) : members(group))) m.apply(vector);
}
export function cachedTableWidths(view,key,signature,width,generation,active) {
  const g=groupsByView.get(view)?.get(key), c=g?.current;
  return c && (width==null || c.width===width) && c.generation===generation && (c.signature===signature || active) ? c.vector : null;
}
export function registerTableWidths(view, options) {
  const map=registry(view);
  let g=map.get(options.key);
  if (!g) {
    g={registry:map,key:options.key,view,members:new Map(),token:0,raf:0,pending:false,current:null,avail:null,generation:null,signature:options.signature,rowCount:options.rowCount,attempted:null};
    map.set(options.key,g);
    while(map.size>64) { const key=map.keys().next().value, old=map.get(key); if(old.baseline) apply(old,old.baseline,true); abort(old); map.delete(key); }
  }
  if(g.signature!==options.signature || g.rowCount!==options.rowCount) {
    g.registration={active:options.active(),hadCurrent:!!g.current};
    abort(g); g.signature=options.signature; g.rowCount=options.rowCount; g.attempted=null;
  }
  if(g.current && g.current.signature!==options.signature && !options.active()) g.current=null;
  const member={...options,group:g};
  g.members.set(member.ordinal,member);
  return {
    fit(width,generation,baseline) {
      if(!finite(width) || !member.valid() || map.get(g.key)!==g) return false;
      const source=member.source();
      if(source!==g.signature) { abort(g); g.signature=source; g.attempted=null; }
      if(g.avail!==width || g.generation!==generation) {
        g.geometryReset={fromWidth:g.avail,toWidth:width,fromGeneration:g.generation,toGeneration:generation};
        abort(g); g.avail=width; g.generation=generation; g.current=null; g.attempted=null;
      }
      g.baseline=baseline;
      if(typeof source!=="string") { abort(g); g.current=null; apply(g,baseline,true); return true; }
      const frozen=liveMembers(g).some(m=>m.active());
      const cached=g.current && (g.current.signature===g.signature || frozen);
      if(!cached) g.current=null;
      apply(g,cached?g.current.vector:baseline,!cached);
      if(!frozen) request(g);
      return true;
    },
    dispose() {
      if(g.members.get(member.ordinal)===member) g.members.delete(member.ordinal);
      if(g.pending || g.raf) abort(g);
    },
  };
}
function request(g) {
  if(g.pending || g.raf || !finite(g.avail) || g.attempted===inputKey(g)) return;
  g.raf=requestAnimationFrame(()=>{
    g.raf=0;
    const token=g.token;
    if(!current(g,token) || document.fonts?.status==='loading') return;
    g.pending=true;
    g.view.requestMeasure({
      key:g,
      read:()=>current(g,token)?readRows(g):null,
      write:data=>{
        if(!data || !current(g,token)) { finish(g,token); return; }
        g.host=makeHost(data);
        const baselineRows=makeRows(data,g.host,g.baseline), nowrap=makeNowrap(data,g.host);
        g.view.requestMeasure({
          key:g,
          read:()=>{
            if(!current(g,token)) return null;
            const baseline=measureRows(baselineRows,data.scale);
            if(!sameLayoutStyles(data,baselineRows) || !equivalent(data.metrics,baseline)) return null;
            const content=nowrap.map(row=>row.map(el=>el.getBoundingClientRect().width/data.scale));
            const proposals=proposeTableWidths(data.widths,content,data.metrics.map(r=>r.map(m=>m.lines)),data.padding);
            return {baseline,proposals};
          },
          write:stage=>{
            if(!stage || !current(g,token)) { finish(g,token); return; }
            baselineRows.forEach(row=>row.remove()); nowrap.flat().forEach(el=>el.remove());
            const trials=stage.proposals.map(proposal=>({proposal,rows:makeRows(data,g.host,proposal.vector)}));
            g.view.requestMeasure({
              key:g,
              read:()=>{
                if(!current(g,token)) return null;
                // Width reads occur only in read phases; publication does not measure.
                if(members(g).some(m=>parseFloat(getComputedStyle(m.table).width)!==g.avail)) return null;
                let best=null;
                for(const trial of trials) {
                  if(!sameLayoutStyles(data,trial.rows)) continue;
                  const observed=measureRows(trial.rows,data.scale);
                  if(!safe(stage.baseline,observed) || !trial.proposal.targets.every(c=>observed.every(r=>r[c].lines<=1))) continue;
                  const score=observed.flat().reduce((sum,m,i)=>sum+stage.baseline.flat()[i].lines-m.lines,0);
                  if(!best || score>best.score) best={vector:trial.proposal.vector,score};
                }
                return best;
              },
              write:best=>{
                if(current(g,token)) {
                  g.attempted=inputKey(g);
                  if(best) {
                    g.current={vector:best.vector,width:g.avail,generation:g.generation,signature:g.signature};
                    apply(g,best.vector);
                  }
                }
                finish(g,token);
              },
            });
          },
        });
      },
    });
  });
}
function finish(g,token) {
  if(g.token!==token) return;
  g.host?.remove(); g.host=null; g.pending=false;
  // An unsupported measurement is a bounded fallback, never a retry loop.
  g.attempted=inputKey(g);
}
function copyStyle(from,to) {
  const originals=[from,...from.querySelectorAll('*')], copies=[to,...to.querySelectorAll('*')];
  originals.forEach((el,i)=>{const cs=getComputedStyle(el); for(const p of fontProps) copies[i].style[p]=cs[p];});
}
// Compare only layout inputs, never the widths/heights intentionally varied by a trial.
// Scoped theme rules outside the measurement host make that trial untrustworthy.
function layoutStyles(row) {
  return [row,...row.querySelectorAll('*')].map(el=>{
    const cs=getComputedStyle(el);
    return [el.tagName,el.className,el.childNodes.length,...parityProps.map(p=>cs[p])];
  });
}
function equalLayoutStyles(a,b) {
  const px = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)px$/;
  return a.length===b.length && a.every((node,i)=>node.length===b[i].length && node.every((value,p)=>
    value===b[i][p] || (p>=3 && px.test(value) && px.test(b[i][p]) && Number.isFinite(parseFloat(value)) && Number.isFinite(parseFloat(b[i][p])) && Math.abs(parseFloat(value)-parseFloat(b[i][p]))<=1e-4)));
}
function sameLayoutStyles(data,clones) {
  return data.rows.length===clones.length && data.rows.every((row,i)=> {
    const baseline=JSON.parse(data.styles[i]);
    return row.isConnected && equalLayoutStyles(layoutStyles(row),baseline) &&
      equalLayoutStyles(layoutStyles(clones[i]),baseline);
  });
}
function readRows(g) {
  const rows=members(g), scales=[], widths=[], padding=[], html=[];
  for(const m of rows) {
    if(parseFloat(getComputedStyle(m.table).width)!==g.avail) return null;
    const cells=[...m.table.querySelectorAll('th,td')];
    if(!cells.length || cells.some(cell=>cell.classList.contains('mp-cell-editing') ||
        [...cell.querySelectorAll('*')].some(el=>!allowed.has(el.tagName)))) return null;
    const scale=m.table.getBoundingClientRect().width/g.avail;
    if(!finite(scale)) return null;
    scales.push(scale);
    if(!widths.length) cells.forEach(c=>widths.push(c.getBoundingClientRect().width/scale));
    else if(cells.length!==widths.length || cells.some((c,i)=>Math.abs(c.getBoundingClientRect().width/scale-widths[i])>.5)) return null;
    padding.push(cells.map(c=>{const cs=getComputedStyle(c);return parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)+Math.max(parseFloat(cs.borderLeftWidth),parseFloat(cs.borderRightWidth));}));
    // Clone now, but never attach or read clone geometry in this read phase.
    const clone=m.table.cloneNode(true); copyStyle(m.table,clone); html.push(clone);
  }
  if(scales.some(scale=>Math.abs(scale-scales[0])>1e-6)) return null;
  return {rows:rows.map(m=>m.table),styles:rows.map(m=>JSON.stringify(layoutStyles(m.table))),templates:html,scale:scales[0],width:g.avail,widths,padding,metrics:rows.map((m,i)=>measureRow(m.table,scales[i]))};
}
function makeHost(data) {
  const host=document.createElement('div');
  host.setAttribute('aria-hidden','true'); host.inert=true; host.dataset.mpTableMeasure='1';
  Object.assign(host.style,{position:'fixed',left:'-30000px',top:'0',visibility:'hidden',pointerEvents:'none',zoom:String(data.scale),width:data.width+'px',contain:'layout style'});
  document.body.appendChild(host); return host;
}
function makeRows(data,host,vector) {
  const sum=vector.reduce((a,b)=>a+b,0);
  return data.templates.map(t=>{
    const row=t.cloneNode(true); row.style.width=data.width+'px';
    [...row.querySelectorAll('col')].forEach((col,i)=>col.style.width=(vector[i]/sum*100)+'%');
    host.appendChild(row); return row;
  });
}
function makeNowrap(data,host) {
  return data.templates.map(row=>[...row.querySelectorAll('th,td')].map(cell=>{
    const el=document.createElement('div'); el.innerHTML=cell.innerHTML;
    const nodes=[cell,...cell.querySelectorAll('*')], copies=[el,...el.querySelectorAll('*')];
    nodes.forEach((n,i)=>{for(const p of fontProps) copies[i].style[p]=n.style[p];});
    Object.assign(el.style,{display:'inline-block',width:'max-content',maxWidth:'none',whiteSpace:'nowrap',padding:'0',border:'0',margin:'0'});
    host.appendChild(el); return el;
  }));
}
function measureRow(row,scale) {
  return [...row.querySelectorAll('th,td')].map(cell=>{
    const cs=getComputedStyle(cell), bounds=cell.getBoundingClientRect(), rects=[], walk=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walk.nextNode())) {
      if(!node.textContent.trim()) continue;
      const r=document.createRange(); r.selectNodeContents(node);
      for(const b of r.getClientRects()) if(b.width>.1 && b.height>.1) rects.push(b);
    }
    const centers=[];
    for(const r of rects.slice().sort((a,b)=>(a.y+a.height/2)-(b.y+b.height/2))) {
      const mid=(r.y+r.height/2)/scale;
      if(!centers.some(y=>Math.abs(y-mid)<Math.max(2,r.height/scale*.35))) centers.push(mid);
    }
    const left=bounds.left/scale+parseFloat(cs.paddingLeft)+parseFloat(cs.borderLeftWidth)/2;
    const right=bounds.right/scale-parseFloat(cs.paddingRight)-parseFloat(cs.borderRightWidth)/2;
    const minX=rects.length?Math.min(...rects.map(r=>r.left/scale)):left;
    const maxX=rects.length?Math.max(...rects.map(r=>r.right/scale)):right;
    return {lines:centers.length,height:rects.length?(Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top)))/scale:0,overflow:Math.max(0,left-minX,maxX-right)};
  });
}
function measureRows(rows,scale) { return rows.map(row=>measureRow(row,scale)); }
function equivalent(a,b) {
  return a.length===b.length && a.every((r,i)=>r.length===b[i].length && r.every((m,c)=>m.lines===b[i][c].lines && Math.abs(m.height-b[i][c].height)<=.5 && Math.abs(m.overflow-b[i][c].overflow)<=.5));
}
function safe(base,next) {
  return base.length===next.length && base.every((r,i)=>r.every((m,c)=>next[i][c].lines<=m.lines && next[i][c].height<=m.height+.5 && next[i][c].overflow<=m.overflow+.5));
}
// All numbers are CSS px. This is a finite proposal generator, not a proof.
export function proposeTableWidths(widths,content,lines,padding) {
  const n=widths.length, cur=widths.slice(), targets=new Set(), proposals=[];
  const goals=widths.map((_,c)=>Math.max(...content.map((r,i)=>r[c]+padding[i][c]))+2);
  const floors=widths.map((_,c)=>Math.max(...content.map((r,i)=>r[c]/Math.max(1,lines[i][c])+padding[i][c]))+2);
  const candidates=goals.map((goal,c)=>({c,goal,need:goal-widths[c]})).filter(x=>x.need>0 && lines.some(r=>r[x.c]>1)).sort((a,b)=>a.goal-b.goal || a.need-b.need || a.c-b.c);
  const total=widths.reduce((a,b)=>a+b,0);
  for(const candidate of candidates) {
    const need=candidate.goal-cur[candidate.c];
    const donors=cur.map((w,c)=>({c,lend:c===candidate.c || targets.has(c)?0:Math.max(0,w-floors[c])})).sort((a,b)=>b.lend-a.lend || a.c-b.c);
    if(donors.reduce((sum,d)=>sum+d.lend,0)+1e-7<need) continue;
    let remaining=need;
    for(const donor of donors) {
      const take=Math.min(donor.lend,remaining); cur[donor.c]-=take;cur[candidate.c]+=take;remaining-=take;
      if(remaining<1e-7) break;
    }
    targets.add(candidate.c);
    proposals.push({vector:cur.map(w=>w/total*100),targets:[...targets]});
    if(proposals.length===3) break;
  }
  return proposals;
}

export function inspectTableWidths(view) { return [...(groupsByView.get(view)?.values() || [])].map(g=>({key:g.key,token:g.token,avail:g.avail,generation:g.generation,signatureLength:g.signature?.length,current:g.current&&{width:g.current.width,generation:g.current.generation,sourceMatches:g.current.signature===g.signature,vector:g.current.vector},pending:g.pending,memberCount:g.members.size,members:liveMembers(g).map(m=>({ordinal:m.ordinal,sourceMatches:m.source()===g.signature,active:m.active(),generation:m.generation()})),geometryReset:g.geometryReset,registration:g.registration})); }
