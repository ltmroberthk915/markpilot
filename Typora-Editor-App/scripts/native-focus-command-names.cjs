const fs=require('node:fs');const text=fs.readFileSync(process.argv[2],'utf8');
console.log(JSON.stringify([...new Set(text.match(/["'][\w.-]*(?:icube|aiChat)[\w.-]*(?:[Ff]ocus|[Ii]nput)[\w.-]*["']/g))],null,2));
for(const q of ['function wge(', 'id:"workbench.action.icube.aiChatSidebar', 'icube.ai-chat.focusInput']){const p=text.indexOf(q);if(p>=0)console.log(q+'\n'+text.slice(Math.max(0,p-100),p+1200));}
