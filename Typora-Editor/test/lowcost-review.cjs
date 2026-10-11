'use strict';
// Reuse a locked semantic rating only for byte-identical output at the same
// gap. This is offline, still blind to the new arm, and never guesses a grade.
const fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(process.argv[2]),prior=path.resolve(__dirname,'.runs/heading-ab-2026-09-07');
const read=(root,n)=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const old=read(prior,'blind-review.json'),oldGrades=read(prior,'grades.json'),rows=read(dir,'blind-review.json');
const grades=fs.existsSync(path.join(dir,'grades.json'))?read(dir,'grades.json'):{},provenance={};
for(const row of rows){
  const previous=old.find(x=>x.id===row.id),g=grades[row.id]||={};
  for(const label of ['X','Y']){
    if(g[label])continue;
    const matching=['X','Y'].filter(k=>previous[k]===row[label]);
    if(matching.length&&new Set(matching.map(k=>oldGrades[row.id][k])).size===1){
      const key=matching[0],priorGrade=oldGrades[row.id];g[label]=priorGrade[key];g['reason'+label]=priorGrade['reason'+key]||priorGrade.reason;
      provenance[row.id+':'+label]='Same text at same gap as prior locked blind review';
    }else if(!row[label]){g[label]='D';g['reason'+label]='无可用输出';provenance[row.id+':'+label]='Empty output';}
  }
}
fs.writeFileSync(path.join(dir,'grades.json'),JSON.stringify(grades,null,2)+'\n');
fs.writeFileSync(path.join(dir,'grade-provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({pairs:rows.length,reused:Object.keys(provenance).length,remaining:rows.filter(r=>!grades[r.id].X||!grades[r.id].Y).map(r=>({id:r.id,missing:['X','Y'].filter(k=>!grades[r.id][k])}))},null,2));
