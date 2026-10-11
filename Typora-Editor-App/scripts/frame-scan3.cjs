const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.whenReady().then(()=>{
  const dir=process.argv[2];
  const files=fs.readdirSync(dir).filter(n=>/^bug204-A\d+-\d\.png$/.test(n)).sort();
  const base=nativeImage.createFromPath(path.join(dir,files[0]));
  const {width,height}=base.getSize();
  const b=base.toBitmap();
  const rows=[];
  for(const f of files){
    const cur=nativeImage.createFromPath(path.join(dir,f));
    const s=cur.getSize();
    if(s.width!==width||s.height!==height){rows.push({f,skip:'size '+s.width+'x'+s.height});continue;}
    const d=cur.toBitmap();
    let count=0,minY=1e9,maxY=-1,minX=1e9,maxX=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x+=2){
      const i=(y*width+x)*4;
      if(Math.abs(d[i]-b[i])>24||Math.abs(d[i+1]-b[i+1])>24||Math.abs(d[i+2]-b[i+2])>24){
        count++;if(y<minY)minY=y;if(y>maxY)maxY=y;if(x<minX)minX=x;if(x>maxX)maxX=x;
      }
    }
    rows.push({f,count,minY,maxY,minX,maxX});
    process.stdout.write(`${f} px=${count} y=[${minY}..${maxY}] x=[${minX}..${maxX}]\n`);
  }
  const big=rows.filter(r=>r.count&&!r.skip&&(r.count>2500||r.maxY-r.minY>350));
  process.stdout.write('ANOMALY '+JSON.stringify(big.map(r=>[r.f,r.count,r.maxY]))+'\n');
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
