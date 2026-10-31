import { StateEffect, StateField } from '@codemirror/state';
import { regionsBetween } from './region-index.js';

export const activateRegion = StateEffect.define();
export const retireRegion = StateEffect.define();
export const expandRegionPayload = StateEffect.define();

// This is presentation intent. CM still owns every source byte, directed range,
// composition, and history entry; other region kinds retain their own policies.
export function createRegionSession(indexField) {
  /* IME composition at an inline formula's right edge starts an insertion at
     r.to, then replaces that composition range. CM6 deliberately keeps the
     composing text node while a composition is active; if the presentation
     flips editing→rendered on the first compose transaction, the replace
     widget is inserted while the source text survives ⇒ rendered formula and
     literal `$P$` are both visible (double caret / duplicated glyphs). Hold
     the old editing state for editing math regions through compose
     transactions; the explicit post-composition refresh then rebuilds them
     once the composition is fully over. */
  function composingMath(value,tr) {
    if(!value?.presentation?.size||!tr.isUserEvent('input.type.compose'))return null;
    /* Session-scoped: a real composition updates the preedit range many times
       (n → ni → nih → nihao). Holding only the region touched by this one
       change would drop the hold on updates that land one character to the
       right of r.to. Keep every math region that is editing when the
       composition starts; the refresh after compositionend releases them. */
    let held=null;
    for(const [id,p] of value.presentation){
      if(p.kind!=='math'||!p.editing)continue;
      (held||=new Set()).add(id);
    }
    return held;
  }
  function project(state,image,held) {
    const index=state.field(indexField),presentation=new Map(),main=state.selection.main;
    // A block replacement's right DOM edge belongs to the next line. Keep the
    // closing fence as text at its exact source endpoint so native input cannot
    // drift past the following LF. Inline tails retain their pointer policy.
    const ownsMathHead=(r,head)=>head>=r.from&&(head<r.to||
      (head===r.to&&(r.form==='display'||image.lastPointer===true)));
    for(const kind of ['math','code','mermaid','table','image']) for(const selection of state.selection.ranges) {
      for(const r of regionsBetween(index,selection.from,selection.to,kind)) {
        const current=presentation.get(r.id)||{id:r.id,kind,from:r.from,to:r.to,selected:false,editing:false,preview:false};
        current.selected=true;
        if(kind==='image')current.editing=r.id===image.imageId;
        else if(kind==='mermaid')current.editing=main.head>=r.from&&main.head<=r.to;
        else if(kind==='math')current.editing ||= ownsMathHead(r,selection.head);
        else current.editing ||= selection.head>=r.from&&selection.head<=r.to;
        current.preview=kind==='math'&&ownsMathHead(r,main.head) || kind==='image'&&current.editing;
        presentation.set(r.id,current);
      }
    }
    if(held)for(const id of held){
      const r=index.byId.get(id);if(!r||r.kind!=='math')continue;
      const p=presentation.get(id)||{id,kind:'math',from:r.from,to:r.to,selected:false,editing:false,preview:false};
      p.editing=true;p.preview=true;presentation.set(id,p);
    }
    const active=image.imageId&&index.byId.get(image.imageId);
    if(active&&!presentation.has(active.id))presentation.set(active.id,{id:active.id,kind:'image',from:active.from,to:active.to,selected:false,editing:true,preview:true});
    return {...image,epoch:index.epoch,presentation};
  }
  return StateField.define({
    create: state => project(state,{ imageId: null, expanded: false }),
    update(value, tr) {
      if(!tr.docChanged&&!tr.selection&&!tr.effects.some(e=>e.is(activateRegion)||e.is(retireRegion)||e.is(expandRegionPayload))&&tr.startState.field(indexField)===tr.state.field(indexField))return value;
      const held = composingMath(value,tr);
      let next = value;
      /* #31：记住这次事务的选择来源（点字形 = select.pointer），呈现判据据此分流。 */
      next = { ...next, lastPointer: tr.isUserEvent("select.pointer") };
      for (const e of tr.effects) {
        if (e.is(activateRegion) && next.imageId !== e.value.id) next = { imageId: e.value.id, expanded: false };
        if (e.is(retireRegion) && (!e.value?.id || e.value.id === next.imageId)) next = { imageId: null, expanded: false };
        if (e.is(expandRegionPayload) && e.value === next.imageId) next = { ...next, expanded: true };
      }
      if (!next.imageId) return project(tr.state,next,held);
      const r = tr.state.field(indexField).byId.get(next.imageId);
      if (!r || r.kind !== 'image') return project(tr.state,{ imageId: null, expanded: false },held);
      if (tr.selection && !tr.effects.some(e => e.is(activateRegion) || e.is(expandRegionPayload)) &&
          (tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('undo') || tr.isUserEvent('redo')) &&
          !tr.state.selection.ranges.some(s => s.head >= r.from && s.head <= r.to)) {
        return project(tr.state,{ imageId: null, expanded: false },held);
      }
      return project(tr.state,next,held);
    },
  });
}
