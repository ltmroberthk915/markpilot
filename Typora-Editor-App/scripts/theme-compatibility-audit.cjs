// Read-only CSSOM audit of the bundled upstream Typora themes. Stylesheets are
// detached: no imports, fonts, scripts or external resources are loaded.
const fs=require('node:fs'),path=require('node:path');
exports.run=async({output,renderer})=>{
  const {BrowserWindow}=require('electron');
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  try{
    await win.loadURL('about:blank');
    const reports=[];
    for(const name of ['konayuki-light','konayuki-dark']){
      const file=path.join(renderer,'themes/konayuki',name+'.css'),source=fs.readFileSync(file,'utf8');
      const report=await win.webContents.executeJavaScript(`(()=>{
        const source=${JSON.stringify(source)},sheet=new CSSStyleSheet();sheet.replaceSync(source);
        const report={styleRules:0,selectors:0,writingSelectors:0,portableWritingSelectors:0,codeMirrorSelectors:0,typoraUISelectors:0,mathJaxSelectors:0,atRules:[],examples:{portable:[],codeMirror:[],ui:[],mathJax:[]}};
        const add=(kind,s)=>{if(report.examples[kind].length<5)report.examples[kind].push(s);};
        const walk=rules=>{for(const rule of rules){
          if(rule.selectorText){report.styleRules++;for(const s of rule.selectorText.split(/,(?![^()]*\\))/).map(s=>s.trim())){
            report.selectors++;
            if(s.includes('#write'))report.writingSelectors++;
            const cm=/\\.cm-|CodeMirror/.test(s),ui=/#(?:typora|sidebar|file-library|megamenu)|\\.(?:sidebar|file-node|outline-|md-(?:tooltip|fences|meta|rawblock|focus))/.test(s),math=/MathJax|mathjax|mjx-|md-math/.test(s);
            if(cm){report.codeMirrorSelectors++;add('codeMirror',s);}
            if(ui){report.typoraUISelectors++;add('ui',s);}
            if(math){report.mathJaxSelectors++;add('mathJax',s);}
            if(s.startsWith('#write ')&&!cm&&!ui&&!math&&!s.includes(':has(')){report.portableWritingSelectors++;add('portable',s);}
          }}else report.atRules.push(rule.cssText.slice(0,100));
          if(rule.cssRules)walk(rule.cssRules);
        }};walk(sheet.cssRules);return report;
      })()`);
      reports.push({name,bytes:Buffer.byteLength(source),...report});
    }
    fs.writeFileSync(path.join(output,'theme-compatibility.json'),JSON.stringify({note:'Two bundled upstream themes only; selector counts overlap and do not measure visual compatibility. No stylesheet was applied or network request made.',reports},null,2));
    console.log(JSON.stringify(reports,null,2));
  }finally{win.destroy();}
};
