// Read only the isolated test application's newly written CustomDestinations
// file. Windows itself decodes each persisted Shell Link via Electron's API.
const {app,shell}=require('electron'),fs=require('node:fs'),path=require('node:path');
const [source,output]=process.argv.slice(2),directory=path.dirname(output);
fs.mkdirSync(directory,{recursive:true});app.setPath('userData',path.join(directory,'reader-profile'));
app.whenReady().then(()=>{
  const data=fs.readFileSync(source),header=Buffer.from('4c0000000114020000000000c000000000000046','hex'),starts=[];
  for(let at=data.indexOf(header);at>=0;at=data.indexOf(header,at+header.length))starts.push(at);
  const links=starts.map((start,i)=>{
    const file=path.join(directory,'item-'+i+'.lnk');fs.writeFileSync(file,data.subarray(start,starts[i+1]??data.length));
    try{return{index:i,...shell.readShortcutLink(file)};}catch(error){return{index:i,error:error.message};}
  });
  fs.writeFileSync(output,JSON.stringify({source,links},null,2)+'\n');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
