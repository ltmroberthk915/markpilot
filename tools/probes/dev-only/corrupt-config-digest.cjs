/** 把 probe-1 / probe-2 的结果 JSON 摘要成一张表（报告用；不猜，只从读数里取字段）
 *  用法：node corrupt-config-digest.cjs 1     或   node corrupt-config-digest.cjs 2
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, 'corrupt-config-out');
const which = process.argv[2] || '1';
const j = JSON.parse(fs.readFileSync(path.join(OUT, `corrupt-config-${which}-result.json`), 'utf8'));
console.log(`# probe-${which}  sha16=${j.sha16}  at=${j.at}  臂数=${j.results.length}`);
for (const r of j.results) {
  const s = r.steps || {};
  console.log('\n════ ' + r.id + ' :: ' + r.verdict + '  ' + (r.kind || ''));
  if (r.fatal) { console.log('  FATAL ' + r.fatal.slice(0, 200)); continue; }
  const st = s.readings || s.firstFrame || {};
  const d = s.drill || {};
  console.log('  launch=' + JSON.stringify(s.launch && { ok: s.launch.ok, port: s.launch.port, err: s.launch.error }));
  console.log('  窗口(EnumWindows) appeared=' + (s.mainWindow && s.mainWindow.appeared) + ' wins=' + JSON.stringify((s.mainWindow && s.mainWindow.all || []).slice(0, 3)));
  console.log('  connect=' + JSON.stringify(s.connect));
  console.log('  log: kind=' + (s.log && s.log.settingsLoadKind) + ' json=' + JSON.stringify(s.log && (s.log.settingsLoadJson || s.log.settingsLoadFailedJson)) + ' restoreLast=' + JSON.stringify(s.log && s.log.restoreLastJson) + ' recents=' + (s.log && s.log.recentsLine));
  if (st.viewport) console.log('  渲染: outer=' + st.viewport.outerW + 'x' + st.viewport.outerH + ' cw=' + st.viewport.cw + ' cmLines=' + (st.rendered && st.rendered.cmLines) + ' contentW=' + (st.rendered && st.rendered.contentW));
  if (st.theme) console.log('  theme=' + JSON.stringify(st.theme) + ' restoreLast.api=' + st.restoreLast + ' toast=' + JSON.stringify(st.toast));
  if (st.recentList) console.log('  recentList=' + JSON.stringify(st.recentList.files));
  if (st.menuItems) console.log('  menu(真实菜单对象)=' + JSON.stringify(st.menuItems));
  if (s.shot) console.log('  截图 ' + s.shot.file + ' ' + JSON.stringify(s.shot.stats));
  console.log('  面板: ' + JSON.stringify(d.panel) + ' drag=' + JSON.stringify(d.drag) + ' cross=' + d.dragOkCross + ' readback=' + JSON.stringify(d.dragReadback) + ' toggle=' + JSON.stringify(d.toggle));
  console.log('  夹具 before=' + JSON.stringify({ size: r.fixture && r.fixture.before && r.fixture.before.bytes, mode: r.fixture && r.fixture.before && r.fixture.before.mode, text: r.fixture && r.fixture.before && r.fixture.before.text && r.fixture.before.text.replace(/\n/g, '\\n').slice(0, 90) }));
  if (r.fixture && r.fixture.recents) console.log('  recents夹具 before=' + JSON.stringify({ size: r.fixture.recents.bytes, mode: r.fixture.recents.mode, text: String(r.fixture.recents.text).replace(/\n/g, '\\n').slice(0, 90) }));
  console.log('  onDiskAfterDrill=' + JSON.stringify({ v: s.onDiskAfterDrill && s.onDiskAfterDrill.validJson, mode: s.onDiskAfterDrill && s.onDiskAfterDrill.mode, text: String(s.onDiskAfterDrill && s.onDiskAfterDrill.text).replace(/\n/g, '\\n').slice(0, 160) }));
  if (s.recentsOnDisk) console.log('  recentsOnDisk=' + JSON.stringify({ v: s.recentsOnDisk.validJson, ro: s.recentsOnDisk.readonly, mode: s.recentsOnDisk.mode, text: String(s.recentsOnDisk.text).replace(/\n/g, '\\n').slice(0, 120) }) + ' tmp=' + JSON.stringify(s.tmpLeftovers));
  console.log('  diskAfterClose=' + JSON.stringify({ v: s.diskAfterClose && s.diskAfterClose.validJson, mode: s.diskAfterClose && s.diskAfterClose.mode, text: String(s.diskAfterClose && s.diskAfterClose.text).replace(/\n/g, '\\n').slice(0, 200) }));
  if (s.recentsAfterClose) console.log('  recentsAfterClose=' + JSON.stringify({ v: s.recentsAfterClose.validJson, ro: s.recentsAfterClose.readonly, text: String(s.recentsAfterClose.text).replace(/\n/g, '\\n').slice(0, 120) }));
  if (s.log && s.log.saveFailed) console.log('  saveFailed=' + JSON.stringify(s.log.saveFailed) + ' skip=' + JSON.stringify(s.log.skipLines));
  console.log('  关窗: graceful=' + (s.close && s.close.exitedGracefully) + ' pidsAfter=' + JSON.stringify(s.close && s.close.pidsAfter) + ' pageErrors=' + JSON.stringify(s.pageErrors) + ' consoleErrors=' + JSON.stringify(s.consoleErrors) + ' badEvents=' + (s.log && s.log.badEvents));
  console.log('  日志尾: ' + JSON.stringify((s.log && s.log.tail || []).slice(-3)));
  const bad = (r.checks || []).filter((c) => !c.ok);
  if (bad.length) for (const c of bad) console.log('  ✗ ' + c.name + ' :: ' + JSON.stringify(c.got).slice(0, 260));
}
