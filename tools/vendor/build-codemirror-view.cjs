'use strict';
// Reproducible viewport budget and long-line geometry; never mutate dependencies.
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
 // viewportLines are already in compressed DOM/client coordinates. The global
 // visibleTop/Bottom getters deliberately remain in height-map coordinates.
 const gapBegin=text.indexOf('    ensureLineGaps(current, mayMeasure) {'),gapEnd=text.indexOf('    gapSize(line, from, to, structure) {',gapBegin);
 assert(gapBegin>0&&gapEnd>gapBegin);
 const gapCode=text.slice(gapBegin,gapEnd);assert.equal((gapCode.match(/this\.visible(?:Top|Bottom)/g)||[]).length,4);
 text=text.slice(0,gapBegin)+gapCode.replaceAll('this.visibleTop','this.pixelViewport.top').replaceAll('this.visibleBottom','this.pixelViewport.bottom')+text.slice(gapEnd);
 // Measured gap lengths are client pixels, whereas inline style sizes are CSS
 // pixels. Preserve the former for height estimates, and convert only at DOM.
 const oldDraw='new LineGapWidget(this.displaySize * (wrapping ? viewState.scaleY : viewState.scaleX), wrapping)';
 assert.equal(text.split(oldDraw).length-1,1);
 text=text.replace(oldDraw,'new LineGapWidget(this.displaySize, wrapping, this.displaySize / (wrapping ? viewState.scaleY : viewState.scaleX))');
 const widgetBegin=text.indexOf('class LineGapWidget extends WidgetType {'),widgetEnd=text.indexOf('const viewportMargin =',widgetBegin);
 assert(widgetBegin>0&&widgetEnd>widgetBegin);
 let widget=text.slice(widgetBegin,widgetEnd);
 const replacements=[
  ['constructor(size, vertical) {','constructor(size, vertical, cssSize = size) {'],
  ['this.size = size;','this.size = size;\n        this.cssSize = cssSize;'],
  ['other.size == this.size && other.vertical == this.vertical','other.size == this.size && other.cssSize == this.cssSize && other.vertical == this.vertical'],
  ['elt.style.height = this.size + "px";','elt.style.height = this.cssSize + "px";'],
  ['elt.style.width = this.size + "px";','elt.style.width = this.cssSize + "px";'],
 ];
 for(const [from,to] of replacements){assert.equal(widget.split(from).length-1,1,from);widget=widget.replace(from,to);}
 text=text.slice(0,widgetBegin)+widget+text.slice(widgetEnd);
 return{pkg,text,license:fs.readFileSync(path.join(upstream,'LICENSE'))};
}
function main(){
 const {pkg,text,license}=generate();fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'view.js'),text);fs.writeFileSync(path.join(output,'LICENSE'),license);
 const manifest={schema:1,purpose:'codemirror-view-maintained-viewport-budget-and-long-line-geometry',upstreamVersion:pkg.version,upstreamSha256:expected,patch:'Public bounded viewport Facet; wrapped long-line gaps use compressed DOM coordinates and convert client lengths to CSS lengths without changing height estimates. Excess-range tolerance, scroll targets, selection viewports and BigScaler retain upstream logic',defaultMargin:1000,minMargin:300,maxMargin:1000,sourceSha256:sha(text),licenseSha256:sha(license)};
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest));return manifest;
}
if(require.main===module)main();
module.exports={generate,main};
