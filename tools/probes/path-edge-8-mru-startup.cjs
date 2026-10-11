/** family=path-edge · 用例 e8：**死网络路径进 MRU 后的启动代价**（对照臂：MRU 里只有本地文件）
 *
 *  为什么单独量：主进程 `buildMenu()` → `recents.menuModel(list, isFile)` 对**每一条** MRU 做
 *  **同步** `fs.statSync`。对不可达 UNC，同步 stat 会等 SMB 超时 ⇒ 可能把主进程卡在启动路径上。
 *  e4 臂 C 只量到了"启动之后"的读数（2–3 ms），没量到**第一次** stat 的代价（它落在启动过程里）。
 *  本支用同一把尺子量两臂：从 spawn 到"引擎页可交互"的毫秒数。
 *
 *  用法：node path-edge-8-mru-startup.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e8-mru-startup';
const DIR = path.join(L.ROOT, CASE);
const DEAD = '\\\\192.0.2.1\\share\\pe-dead.md';
const R = { probe: 'path-edge-8-mru-startup.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), arms: [] };

async function run({ label, mru, dir }) {
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), JSON.stringify(mru, null, 2), 'utf8');
  const port = await L.pickPort();
  const t0 = Date.now();
  const app = await L.launch({ exe: L.EXE, args: [], port, profile });
  const tCdp = Date.now() - t0;
  const t1 = Date.now();
  let page = null, err = null;
  try { page = await L.findPage(app.browser, { timeoutMs: 90000 }); } catch (e) { err = String(e.message).slice(0, 120); }
  const tEngine = Date.now() - t1;
  const out = { label, mru, tCdpMs: tCdp, tEngineMs: tEngine, tTotalMs: Date.now() - t0, err };
  if (page) {
    await L.sleep(1200);
    const t2 = Date.now();
    const s = await L.peSnap(page, 60000);
    out.peSnapMs = Date.now() - t2;
    out.mruRead = (s.mru && s.mru.files || []).map((f) => ({ n: f.name, alive: f.alive }));
    out.title = s.title;
    /* 再量一次"用户点开最近打开"的读数成本（recentList 每条一个同步 statSync） */
    const t3 = Date.now();
    const again = await L.T(page.evaluate(() => window.mpHost.recentList()), 120000, 'recentList');
    out.recentListAgainMs = Date.now() - t3;
    out.recentListAgain = (again && again.files || []).map((f) => ({ n: f.name, alive: f.alive }));
  }
  L.kill(app);
  return out;
}

(async () => {
  L.rulerEdge('path-edge-8-mru-startup.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(DIR, { recursive: true });
  const local1 = path.join(DIR, 'load', '本地 甲.md');
  const local2 = path.join(DIR, 'load', '本地 乙.md');
  fs.mkdirSync(path.join(DIR, 'load'), { recursive: true });
  fs.writeFileSync(local1, '# 甲\n\nA。\n', 'utf8');
  fs.writeFileSync(local2, '# 乙\n\nB。\n', 'utf8');

  /* 对照臂：MRU 只有本地文件 */
  R.arms.push(await run({ label: '对照（MRU 两条本地）', mru: [local1, local2], dir: path.join(DIR, 'runCtrl') }));
  console.log('[对照] ' + JSON.stringify(R.arms[R.arms.length - 1]));
  /* 实验臂：MRU 首位放不可达 UNC */
  R.arms.push(await run({ label: '实验（MRU 首位=不可达 UNC）', mru: [DEAD, local1], dir: path.join(DIR, 'runDead') }));
  console.log('[实验] ' + JSON.stringify(R.arms[R.arms.length - 1]));

  const [c, d] = R.arms;
  R.verdict = {
    对照_引擎就绪ms: c.tEngineMs, 实验_引擎就绪ms: d.tEngineMs, 差ms: d.tEngineMs - c.tEngineMs,
    死条目被标灰: JSON.stringify(d.mruRead),
  };
  console.log('\n════ 结论 ════\n' + JSON.stringify(R.verdict, null, 1));
  L.writeReport('path-edge-8-mru-startup', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
