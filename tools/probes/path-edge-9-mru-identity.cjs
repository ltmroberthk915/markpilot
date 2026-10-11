/** family=path-edge · 用例 e9：**同一个文件的不同路径形态，在 MRU 里算一条还是多条**
 *
 *  形态：真身路径 / junction 路径 / UNC 路径 / 大小写不同的盘符路径 —— 同一个文件。
 *  `recents.key` 只做小写化（shell/recents.js:10），所以"大小写不同"应当合并、
 *  "联接路径 vs 真身路径"与"UNC vs 盘符"是**不同字符串** ⇒ 预期各算一条。
 *  本支把这三个预期都变成读数（含「最近打开」菜单里真正显示的标签）。
 *
 *  用法：node path-edge-9-mru-identity.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e9-mru-identity';
const DIR = path.join(L.ROOT, CASE);
const R = { probe: 'path-edge-9-mru-identity.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), steps: [] };

(async () => {
  L.rulerEdge('path-edge-9-mru-identity.cjs');
  L.freshDir(DIR);
  const base = path.join(DIR, 'fix');
  const real = path.join(base, '真身 目录');
  const link = path.join(base, '联接 目录');
  fs.mkdirSync(real, { recursive: true });
  L.mkJunction(link, real);

  const realFile = path.join(real, '同一份.md');
  fs.writeFileSync(realFile, '# 同一份\n\nMARK-ID。\n', 'utf8');
  const viaLink = path.join(link, '同一份.md');
  const viaUnc = '\\\\localhost\\E$\\MarkPilot\\.mp-verify\\path-edge\\e9-mru-identity\\fix\\真身 目录\\同一份.md';
  const viaUpper = path.join(base.toUpperCase(), '真身 目录', '同一份.md');
  const forms = { 真身: realFile, junction: viaLink, UNC: viaUnc, 大写盘符: viaUpper };
  R.forms = Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, { path: v, exists: fs.existsSync(v), facts: L.pathFacts(v) }]));
  console.log('[形态] ' + JSON.stringify(Object.fromEntries(Object.entries(R.forms).map(([k, v]) => [k, v.exists + ' ' + v.path]))));

  const profile = path.join(DIR, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');
  const port = await L.pickPort();
  const app = await L.launch({ exe: L.EXE, args: [], port, profile });
  const errs = [];
  try {
    const page = await L.findPage(app.browser, {});
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
    await L.sleep(2200);

    const snapMru = async () => {
      const s = await L.peSnap(page);
      return { count: (s.mru && s.mru.files || []).length, 条目: (s.mru && s.mru.files || []).map((f) => f.path), 菜单: (s.mruMenu && s.mruMenu.items || []).filter((i) => i.id && String(i.id).startsWith('recent-file-')).map((i) => i.label), host: s.host && s.host.filePath, title: s.title };
    };

    for (const [name, p] of Object.entries(forms)) {
      const res = await L.T(page.evaluate((x) => window.mpHost.openPath(x), p), 60000, 'openPath');
      await L.sleep(1500);
      const m = await snapMru();
      R.steps.push({ 开了哪一形态: name, 路径: p, openResult: res, MRU条数: m.count, MRU条目: m.条目, 菜单标签: m.菜单, host回显: m.host, 标题: m.title });
      console.log('\n[开 ' + name + '] ' + res.ok + '  host回显=' + JSON.stringify(m.host) + '  MRU 条数=' + m.count);
      for (const e of m.条目) console.log('    · ' + e);
      console.log('    菜单标签=' + JSON.stringify(m.菜单));
    }
    R.shell = L.shellLog(profile, 'recent|openPath:loaded', 14);
    R.errs = errs;
    console.log('\n[pageerror] ' + JSON.stringify(errs));
  } catch (e) { R.errs = errs.concat('THROW: ' + String((e && e.stack) || e).slice(0, 240)); }
  finally { L.kill(app); }
  L.writeReport('path-edge-9-mru-identity', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
