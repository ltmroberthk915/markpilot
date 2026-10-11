const {app,nativeImage}=require('electron');
app.whenReady().then(()=>{
  const [a,b,y0,y1]=process.argv.slice(2).map((v,i)=>i<2?v:Number(v));
  const A=nativeImage.createFromPath(a),B=nativeImage.createFromPath(b);
  const s=A.getSize();
  const da=A.toBitmap(),db=B.toBitmap();
  let count=0,sample='';
  for(let y=y0;y<Math.min(y1,s.height);y++)for(let x=0;x<s.width;x++){
    const i=(y*s.width+x)*4;
    if(Math.abs(da[i]-db[i])>24||Math.abs(da[i+1]-db[i+1])>24||Math.abs(da[i+2]-db[i+2])>24){count++;if(!sample&&x>100)sample=`first@(${x},${y}) rgb ${da[i]},${da[i+1]},${da[i+2]} -> ${db[i]},${db[i+1]},${db[i+2]}`;}
  }
  console.log(JSON.stringify({band:[y0,y1],height:s.height,width:s.width,diffPixels:count,sample}));
  app.exit(0);
});
