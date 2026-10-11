const text=require('node:fs').readFileSync(process.argv[2],'utf8');
const at=text.indexOf('var Mti=class');console.log(text.slice(at+1900,at+9500));
