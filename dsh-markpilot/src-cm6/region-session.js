import { StateEffect, StateField } from '@codemirror/state';
import { regionsBetween } from './region-index.js';

export const activateRegion = StateEffect.define();
export const retireRegion = StateEffect.define();
export const expandRegionPayload = StateEffect.define();

// This is presentation intent. CM still owns every source byte, directed range,
// composition, and history entry; other region kinds retain their own policies.
export function createRegionSession(indexField) {
  function project(state,image) {
    const index=state.field(indexField),presentation=new Map(),main=state.selection.main;
    for(const kind of ['math','code','mermaid','table','image']) for(const selection of state.selection.ranges) {
      for(const r of regionsBetween(index,selection.from,selection.to,kind)) {
        const current=presentation.get(r.id)||{id:r.id,kind,from:r.from,to:r.to,selected:false,editing:false,preview:false};
        current.selected=true;
        if(kind==='image')current.editing=r.id===image.imageId;
        else if(kind==='mermaid')current.editing=main.head>=r.from&&main.head<=r.to;
        else current.editing ||= selection.head>=r.from&&selection.head<=r.to;
        current.preview=kind==='math'&&main.head>=r.from&&main.head<=r.to || kind==='image'&&current.editing;
        presentation.set(r.id,current);
      }
    }
    const active=image.imageId&&index.byId.get(image.imageId);
    if(active&&!presentation.has(active.id))presentation.set(active.id,{id:active.id,kind:'image',from:active.from,to:active.to,selected:false,editing:true,preview:true});
    return {...image,epoch:index.epoch,presentation};
  }
  return StateField.define({
    create: state => project(state,{ imageId: null, expanded: false }),
    update(value, tr) {
      if(!tr.docChanged&&!tr.selection&&!tr.effects.some(e=>e.is(activateRegion)||e.is(retireRegion)||e.is(expandRegionPayload))&&tr.startState.field(indexField)===tr.state.field(indexField))return value;
      let next = value;
      for (const e of tr.effects) {
        if (e.is(activateRegion) && next.imageId !== e.value.id) next = { imageId: e.value.id, expanded: false };
        if (e.is(retireRegion) && (!e.value?.id || e.value.id === next.imageId)) next = { imageId: null, expanded: false };
        if (e.is(expandRegionPayload) && e.value === next.imageId) next = { ...next, expanded: true };
      }
      if (!next.imageId) return project(tr.state,next);
      const r = tr.state.field(indexField).byId.get(next.imageId);
      if (!r || r.kind !== 'image') return project(tr.state,{ imageId: null, expanded: false });
      if (tr.selection && !tr.effects.some(e => e.is(activateRegion) || e.is(expandRegionPayload)) &&
          (tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('undo') || tr.isUserEvent('redo')) &&
          !tr.state.selection.ranges.some(s => s.head >= r.from && s.head <= r.to)) {
        return project(tr.state,{ imageId: null, expanded: false });
      }
      return project(tr.state,next);
    },
  });
}
