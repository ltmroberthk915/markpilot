// Render a frame (or a crop) as ASCII luminance art so anomaly regions can be
// inspected without an image viewer. Usage: electron frame-ascii.cjs <png> [x0 y0 x1 y1]
const {app,nativeImage}=require('electron');
app.whenReady().then(()=>{
  const file=process.argv[2];
  const img=nativeImage.createFromPath(file);
  const {width,height}=img.getSize();
  const d=img.toBitmap();
  const x0=Number(process.argv[3]||0),y0=Number(process.argv[4]||0);
  const x1=Math.min(width,Number(process.argv[5]||width)),y1=Math.min(height,Number(process.argv[6]||height));
  const cols=Number(process.argv[7]||100);
  const rows=Math.max(4,Math.round(cols*(y1-y0)/(x1-x0)/2.1));
  const chars=' .:-=+*#%@';
  let out='';
  for(let r=0;r<rows;r++){
    const y=Math.round(y0+(r+0.5)*(y1-y0)/rows);
    for(let c=0;c<cols;c++){
      const x=Math.round(x0+(c+0.5)*(x1-x0)/cols);
      const i=(y*width+x)*4;
      const lum=(d[i]*0.3+d[i+1]*0.6+d[i+2]*0.1)/255;
      out+=chars[Math.min(9,Math.round((1-lum)*9))];
    }
    out+='\n';
  }
  process.stdout.write(`${file} [${x0},${y0}..${x1},${y1}] ${width}x${height}\n`+out);
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
