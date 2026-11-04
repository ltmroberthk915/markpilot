// Delete complete graphemes across every selection in a single transaction.
import { EditorSelection, findClusterBreak, countColumn } from '@codemirror/state';
import { getIndentUnit } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
function customBoundary(state,range,forward){
  if(!range.empty)return null;
  const line=state.doc.lineAt(range.head),rel=range.head-line.from;
  if(forward?rel===line.length:rel===0)return null;
  const cluster=segmenter.segment(line.text).containing(forward?rel:rel-1);
  if(!cluster || (forward?cluster.index!==rel:cluster.index+cluster.segment.length!==rel) || cluster.segment.length<=1)return null;
  return line.from+(forward?cluster.index+cluster.segment.length:cluster.index);
}
// Mirrored from installed @codemirror/commands deleteByChar. Only used when
// another range needs custom grapheme handling, preserving mixed selections.
function ordinaryBoundary(state,range,forward){
  let pos=range.head;const line=state.doc.lineAt(pos);let before,targetPos;
  if(!forward&&pos>line.from&&pos<line.from+200&&!/[^ \t]/.test(before=line.text.slice(0,pos-line.from))){
    if(before[before.length-1]==='\t')return pos-1;
    const col=countColumn(before,state.tabSize),drop=col%getIndentUnit(state)||getIndentUnit(state);
    for(let i=0;i<drop&&before[before.length-1-i]===' ';i++)pos--;
    targetPos=pos;
  }else{
    targetPos=line.from+findClusterBreak(line.text,pos-line.from,forward,forward);
    if(targetPos===pos&&line.number!==(forward?state.doc.lines:1))targetPos+=forward?1:-1;
    else if(!forward&&/[\ufe00-\ufe0f]/.test(line.text.slice(targetPos-line.from,pos-line.from)))targetPos=line.from+findClusterBreak(line.text,targetPos-line.from,false,false);
  }
  return targetPos;
}
export function deleteGrapheme(dir){return view=>{
  const state=view.state,forward=dir>0;
  if(state.readOnly||view.composing)return false;
  const custom=state.selection.ranges.map(r=>customBoundary(state,r,forward));
  if(custom.every(p=>p==null))return false;
  const atomic=state.facet(EditorView.atomicRanges).map(read=>read(view));
  const skipAtomic=(position,forward)=>{for(const ranges of atomic)ranges.between(position,position,(from,to)=>{if(from<position&&to>position)position=forward?to:from;});return position;};
  let i=0,event='delete.selection';
  const spec=state.changeByRange(range=>{
    const special=custom[i++];let from=range.from,to=range.to;
    if(range.empty){let towards=special??ordinaryBoundary(state,range,forward);if(towards<from){event='delete.backward';towards=skipAtomic(towards,false);}else if(towards>from){event='delete.forward';towards=skipAtomic(towards,true);}from=Math.min(from,towards);to=Math.max(to,towards);}
    else{from=skipAtomic(from,false);to=skipAtomic(to,true);}
    return from===to?{range}:{changes:{from,to},range:EditorSelection.cursor(from,from<range.head?-1:1)};
  });
  if(spec.changes.empty)return false;
  view.dispatch({...spec,userEvent:event,scrollIntoView:true});return true;
};}
