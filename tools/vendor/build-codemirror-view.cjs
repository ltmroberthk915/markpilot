'use strict';
// Reproducible maintained viewport budget; never mutate installed dependencies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'../..'),upstream=path.join(ROOT,'dsh-markpilot/node_modules/@codemirror/view'),output=path.join(ROOT,'dsh-markpilot/renderer/vendor/codemirror');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),expected='73339f0c64071b55fc2d24e69ad6527a37068c2465b1fec3a50726923f3b7ea5';
function generate(){
 const pkg=JSON.parse(fs.readFileSync(path.join(upstream,'package.json'),'utf8')),bytes=fs.readFileSync(path.join(upstream,'dist/index.js'));
 assert.equal(pkg.version,'6.43.14');assert.equal(sha(bytes),expected,'Pinned upstream view bytes');
 let text=bytes.toString('utf8');
 const begin=text.indexOf('    getViewport(bias, scrollTarget) {'),end=text.indexOf('    mapViewport(viewport, changes) {',begin);
 assert(begin>0&&end>begin);const original=text.slice(begin,end);assert.equal(original.split('1000 /* VP.Margin */').length-1,5);
 const patched=original.replace('    getViewport(bias, scrollTarget) {','    getViewport(bias, scrollTarget) {\n        const margin = this.state.facet(viewportMargin);').replaceAll('1000 /* VP.Margin */','margin');
 text=text.slice(0,begin)+patched+text.slice(end);
 const updateAnchor='        if (scrollTarget && (scrollTarget.range.head < viewport.from || scrollTarget.range.head > viewport.to) ||';
 assert.equal(text.split(updateAnchor).length-1,1);
 text=text.replace(updateAnchor,'        if (update.startState.facet(viewportMargin) !== this.state.facet(viewportMargin) ||\n            scrollTarget && (scrollTarget.range.head < viewport.from || scrollTarget.range.head > viewport.to) ||');
 // Keep the original 2000px excess-range tolerance for tall atomic blocks.
 // Only creation's requested buffer changes; selection viewports stay intact.
 const declaration='const viewportMargin = Facet.define({combine: values => values.length ? Math.max(300, Math.min(1000, ...values.filter(Number.isFinite))) : 1000});\n';
 const anchor='class ViewState {';assert.equal(text.split(anchor).length-1,1);text=text.replace(anchor,declaration+anchor);
 const publicAnchor='EditorView.scrollMargins =';assert.equal(text.split(publicAnchor).length-1,1);
 text=text.replace(publicAnchor,'EditorView.viewportMargin = viewportMargin;\n'+publicAnchor);
 return{pkg,text,license:fs.readFileSync(path.join(upstream,'LICENSE'))};
}
function main(){
 const {pkg,text,license}=generate();fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'view.js'),text);fs.writeFileSync(path.join(output,'LICENSE'),license);
 const manifest={schema:1,purpose:'codemirror-view-maintained-viewport-budget',upstreamVersion:pkg.version,upstreamSha256:expected,patch:'Five VP.Margin uses in getViewport become a public bounded Facet with immediate budget-change recalculation; excess-range tolerance, scroll targets and selection viewports retain upstream logic',defaultMargin:1000,minMargin:300,maxMargin:1000,sourceSha256:sha(text),licenseSha256:sha(license)};
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));return manifest;
}
if(require.main===module)main();
module.exports={generate,main};
