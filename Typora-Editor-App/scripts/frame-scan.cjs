// Diff every screencast frame against the pre-operation baseline. Reports
// per frame: changed pixels and the bounding box of the change - a stretched
// absolutely-positioned preview shows as ink far below the text lines.
const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.whenReady().then(()=>{
  const dir=process.argv[2]||'.perf/bug204-current';
  const cast=path.join(dir,'cast');
  const files=fs.readdirSync(cast).filter(n=>n.endsWith('.png')).sort();
  // Same-pipeline baseline: the first screencast frame is the pre-op state.
  const base=nativeImage.createFromPath(path.join(cast,files[0]));
  const rows=[];
  const {width,height}=base.getSize();
  const b=base.toBitmap();
  for(const f of files){
    const cur=nativeImage.createFromPath(path.join(cast,f));
    const d=cur.toBitmap();
    let count=0,minY=1e9,maxY=-1,minX=1e9,maxX=-1;
    for(let y=0;y<height;y++){
      for(let x=0;x<width;x+=2){
        const i=(y*width+x)*4;
        if(Math.abs(d[i]-b[i])>24||Math.abs(d[i+1]-b[i+1])>24||Math.abs(d[i+2]-b[i+2])>24){
          count++;if(y<minY)minY=y;if(y>maxY)maxY=y;if(x<minX)minX=x;if(x>maxX)maxX=x;
        }
      }
    }
    rows.push({f,count,minY,maxY,minX,maxX,spanY:maxY-minY});
    process.stdout.write(rows.at(-1)?`${f} px=${count} y=[${minY}..${maxY}] x=[${minX}..${maxX}]\n`:'');
  }
  // Anomaly candidates: change regions that extend unusually far down or are
  // unusually tall compared with the median frame.
  const sorted=[...rows].sort((a,c)=>a.maxY-c.maxY);
  const medianMaxY=sorted[Math.floor(sorted.length/2)]?.maxY??0;
  const deep=rows.filter(r=>r.maxY>medianMaxY+60);
  const tall=rows.filter(r=>r.spanY>400);
  const report={frames:rows.length,medianMaxY,deep:deep.map(r=>[r.f,r.maxY,r.count]),tallRegions:tall.map(r=>[r.f,r.spanY,r.count])};
  fs.writeFileSync(path.join(dir,'cast-diff.json'),JSON.stringify(report,null,1));
  process.stdout.write('SUMMARY '+JSON.stringify(report)+'\n');
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
