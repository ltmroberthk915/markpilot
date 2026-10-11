// Minimal hold suite for visible manual spot-checks of a packaged app: opens
// the prepared note and returns immediately; SPLIT_NAV_HOLD=1 retains the
// desktop for Computer Use. Test tooling only.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({win,output})=>{
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const fe=code=>win.webContents.executeJavaScript('(()=>{const w=document.getElementById("editor")?.contentWindow;if(!w?.vditor?.vditor?.lute)return null;return w.eval('+JSON.stringify(code)+');})()',true);
  const wait=async code=>{for(let i=0;i<300;i++){if(await fe(code))return;await pause(40);}throw Error('Not ready: '+code);};
  const file=path.join(output,'manual-note.md');
  await global.doc.openFile(file,{confirmedDiscard:{current:global.doc.current,text:global.doc.current?.text}});
  await wait('vditor.getValue().includes("第一章")&&!!vditor.__splitNavigation');
  fs.writeFileSync(path.join(output,'manual-ready.json'),JSON.stringify({file,ready:true,at:new Date().toISOString()}));
  console.log('MANUAL_V6_READY '+file);
  return;
};
