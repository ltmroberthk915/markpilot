const fs=require('node:fs');
const file=process.argv[2],text=fs.readFileSync(file,'utf8');
const names=[...new Set(text.match(/workbench\.action\.chat\.[\w.]+/g))];
console.log(JSON.stringify(names.filter(n=>/icube|focus|open/.test(n)),null,2));
for(const query of process.argv.slice(3)){
  let from=0,count=0;
  while(count<8){const at=text.indexOf(query,from);if(at<0)break;console.log('\n'+query+' #'+(++count)+' @'+at+'\n'+text.slice(Math.max(0,at-650),at+1500));from=at+query.length;}
}
