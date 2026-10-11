/** huge-doc 族 · 读数汇总器：把 huge-doc-out 下的 JSON 读数压成一张表 + 一份摘要 JSON
 *  （只读既有读数，不重跑；避免手抄数字出错）
 *  用法：node huge-doc-summary.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, 'huge-doc-out');
const files = fs.readdirSync(OUT).filter((f) => /^huge-doc-.*\.json$/.test(f) && f !== 'manifest-before-sweep.json' && f !== 'huge-doc-digest.json');
const rows = [];
for (const f of files) {
  let o; try { o = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { continue; }
  if (!o.phases) continue;
  const sc = o.phases && o.phases.scroll ? o.phases.scroll : {};
  const w = sc.afterWheel || {};
  const te = sc.toEnd || {}, tt = sc.toTop || {};
  const ty = o.phases && o.phases.type ? o.phases.type : {};
  const ts = ty.summary || {};
  const tree = (o.treeFinal && o.treeFinal.procs) || [];
  const rend = tree.filter((p) => p.wsMB > 120).map((p) => p.wsMB);
  rows.push({
    at: o.at, file: f, kind: o.kind, fixture: o.fixture,
    chars: o.meta && o.meta.chars, lines: o.meta && o.meta.lines, bytes: o.meta && o.meta.bytes, fixSha16: o.meta && o.meta.sha16,
    exeSha16: o.exeSha16, readyMs: o.timeline && o.timeline.readyMs, cdpMs: o.timeline && o.timeline.cdpMs,
    diskReadMs: o.timeline && o.timeline.main ? o.timeline.main.diskRead_ms : null,
    docCurrentMs: o.timeline && o.timeline.main ? o.timeline.main.docCurrent_ms : null,
    wheelEvents: w.wheels, scrollTopAfterWheel: w.scrollTop, scrollHeight: w.scrollHeight,
    wheelFrameP50: (w.frames && w.frames.length) ? w.frames.slice().sort((a, b) => a - b)[Math.floor(w.frames.length / 2)] : null,
    wheelFrameMax: w.maxFrame, wheelLongtaskMax: w.longtaskMax,
    endSettledMs: te.settledMs, endAtBottom: te.atBottom, endFrameMax: te.frameMax, endLongtaskMax: te.longtaskMax,
    homeSettledMs: tt.settledMs, homeAtTop: tt.atTop, homeScrollTop: tt.finalScrollTop, homeFrameMax: tt.frameMax, homeFrameP50: tt.frameP50,
    typeLine: ts.targetLine, typeGotLine: ts.gotLine, typeN: ts.n, typeP50: ts.p50, typeP95: ts.p95, typeMax: ts.max,
    typeLanded: ts.landed, monotone: ts.monotone,
    docDelayP50: ts.docDelay ? ts.docDelay.p50 : null,
    eventRulerP50: ts.ruler2_event ? ts.ruler2_event.p50 : null,
    ltMax: ts.longtasks ? ts.longtasks.max : null, ltSum: ts.longtasks ? ts.longtasks.sum : null,
    wallPerKey: ts.wallPerKey,
    rssOpen: o.rss && o.rss.afterOpen, rssEnd: o.rss && o.rss.afterScrollToEnd, rssHome: o.rss && o.rss.afterScrollHome, rssTyped: o.rss && o.rss.afterTyping,
    rendererMB: rend.length ? rend[rend.length - 1] : null,
    heapMB: o.phases.final ? o.phases.final.heapMB : null,
    health: o.health ? o.health.afterAll : null,
    pageErrors: (o.events && o.events.pageErrors || []).length,
    consoleErrors: (o.events && o.events.consoleErrors || []).length,
    crashes: (o.events && o.events.crashes || []).length,
    cleanupLeft: o.cleanup ? o.cleanup.rssAfterKill : null,
    loadAtOpen: o.loadAtOpen ? o.loadAtOpen.count : null,
    notes: (o.events && o.events.notes) || [],
    imgStats: o.phases.open ? o.phases.open.imgStats : null,
  });
}
rows.sort((a, b) => (a.kind + a.typeLine).localeCompare(b.kind + b.typeLine));
const cols = ['kind', 'typeLine', 'chars', 'lines', 'readyMs', 'wheelEvents', 'wheelFrameMax', 'endSettledMs', 'endAtBottom', 'homeFrameMax', 'typeP50', 'typeP95', 'docDelayP50', 'ltMax', 'rssOpen', 'rssTyped', 'rendererMB', 'pageErrors', 'crashes', 'cleanupLeft'];
console.log('族=huge-doc  读数份数=' + rows.length);
console.log(cols.join('\t'));
for (const r of rows) console.log(cols.map((c) => (r[c] === undefined ? '—' : r[c])).join('\t'));
fs.writeFileSync(path.join(OUT, 'huge-doc-digest.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 1), 'utf8');
console.log('\n摘要 = ' + path.join(OUT, 'huge-doc-digest.json'));
