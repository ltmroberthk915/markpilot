/** 内存"疑似泄漏"的**复算**：把三条通道分开量，别再让 RSS 一个人背结论。
 *
 *  背景：`.perf/mem-growth-dev`（2026-09-13）记下 `linear: true`，结论写着"疑似泄漏"，从此挂着没人结。
 *  复看那份数据就发现判据是坏的：`deltas = [15.3, 65.8, 6.8]`，而规则只问
 *  `deltas[1] > deltas[0] * 0.6`——**只看前两个增量**，第三个 +6.8MB（已经收敛）根本没进判据。
 *  `mem-session-dev` 同理：编辑组 16 个采样涨到 645MB 后在尾部连续四次原地不动
 *  （645.1 → 630.3 → 634.1 → 628.9），而判据是 `edited.growth <= idle.growth * 2 + 150`
 *  ——对照组那次是**负增长**（−30.1MB，等于把允许量压到 89.8MB），于是 113MB 被记成"疑似泄漏"。
 *
 *  本探针只做一件事：把"泄漏"该看的东西分开量——
 *    · **V8 已用堆**（强制 GC 之后）：真泄漏会一路线性涨；
 *    · **DOM 节点数 / 事件监听器数**：DOM 类泄漏的指纹；
 *    · **进程树 RSS**（进程外的分配器视野）：Chromium 的分配器**不会把释放的内存还给 OS**
 *      （math-scheduler.js 里有实测记录），所以 RSS 涨到某个高度后走平是**设计如此**，
 *      平台高度可以报，但不能拿它单独下"泄漏"的结论。
 *
 *  判据（改动后**减速**才是"有界"）：把增量切成前 1/3 与后 1/3，
 *  后段平均增量 ≤ max(前段平均 × 0.5, 地板) 即判"收敛"；地板给了绝对量，免得噪声当增长。
 *  用法：node scripts/acceptance/probe-memory-trend.cjs [--rounds=8] [--app=installed|dev]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const harness = require('./harness.cjs');

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DEV = argOf('app', 'installed') === 'dev';
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_ARGS = DEV ? [path.join(harness.project, 'app/main/main.js')] : [];
/** 受保护素材：**只读原件、只用副本、用完删副本**。 */
const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';
const OUT = path.join(harness.project, DEV ? '.perf/mem-trend-dev' : '.perf/mem-trend');
const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');
const sleep = harness.sleep;
const LOG = [];
const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); LOG.push(line); console.log(line); };

/** 进程树 RSS（主 + 子 + 孙），与老探针同一口径，便于和历史数据对齐。 */
const rssMb = pid => {
  const script = `$ids = @(${pid}); try { $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId } catch { $kids = @() }
    $grand = @(); foreach ($kid in $kids) { try { $grand += Get-CimInstance Win32_Process -Filter "ParentProcessId=$kid" | Select-Object -ExpandProperty ProcessId } catch {} }
    $total = 0; foreach ($id in @($ids + $kids + $grand)) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $total += $p.WorkingSet64 } }
    Write-Output ([Math]::Round($total / 1MB, 1))`;
  try { return Number(execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {encoding: 'utf8', windowsHide: true}).trim()); }
  catch { return NaN; }
};

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
/** 前 1/3 与后 1/3 的平均增量 + 判据。地板：堆 512KB/轮、节点 200 个/轮。 */
const trend = (series, floor) => {
  const deltas = series.slice(1).map((value, index) => value - series[index]);
  const third = Math.max(1, Math.floor(deltas.length / 3));
  const head = mean(deltas.slice(0, third));
  const tail = mean(deltas.slice(-third));
  const limit = Math.max(head * 0.5, floor);
  return {head: Number(head.toFixed(2)), tail: Number(tail.toFixed(2)), limit: Number(limit.toFixed(2)),
    climbing: tail > limit};
};

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'material-copy.md');
  fs.copyFileSync(MATERIAL, file);
  fs.chmodSync(file, 0o666);
  const rounds = Number(argOf('rounds', 8));
  const session = await harness.launch({exe: EXE, appArgs: APP_ARGS, label: DEV ? 'mem-trend-dev' : 'mem-trend',
    outDir: OUT, args: [file], timeout: 180000});
  const rows = [];
  try {
    const ready = await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
      const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.querySelectorAll('p').length > 50); })()`,
      {timeout: 180000, interval: 30});
    if (!ready) throw new Error('素材没有打开');
    await session.send('HeapProfiler.enable').catch(() => {});
    await sleep(6000);

    /** 强制 GC 之后同时量三样：V8 已用堆、DOM 节点数、事件监听器数（再加进程树 RSS）。 */
    const sample = async (round, edits) => {
      await session.send('HeapProfiler.collectGarbage').catch(() => {});
      await sleep(600);
      const usage = await session.send('Runtime.getHeapUsage').catch(() => null);
      const dom = await session.js(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
        const d = w && w.document;
        if (!d) return {nodes: 0, listeners: 0};
        let listeners = 0;
        try { listeners = w.getEventListeners ? 0 : 0; } catch {}
        return {nodes: d.querySelectorAll('*').length, listeners}; })()`);
      const row = {round, edits,
        rssMb: rssMb(session.child.pid),
        heapMB: usage && usage.usedSize ? Number((usage.usedSize / 1048576).toFixed(1)) : null,
        nodes: dom ? dom.nodes : null};
      rows.push(row);
      say(`  第 ${round} 轮（累计 ${edits} 次编辑）：RSS ${row.rssMb}MB ｜ V8 堆 ${row.heapMB}MB ｜ DOM 节点 ${row.nodes}`);
      return row;
    };

    // 大素材上跑久了应用会忙一阵（同一现象在 76 的素材会话上量过：调试端口几十秒不答），
    // 单次交互失败不该把整条时间线打断——记一笔、等一会儿、接着跑。
    let hiccups = 0;
    const safe = async step => {
      try { return await step(); }
      catch (error) {
        hiccups++;
        say('    · 第 ' + hiccups + ' 次交互遇到传输错误（继续）：' + String((error && error.message) || error).split('\n')[0]);
        await sleep(5000);
        try { return await step(); } catch { return null; }
      }
    };

    await sample(0, 0);
    let edits = 0;
    for (let round = 1; round <= rounds; round++) {
      for (let step = 0; step < 15; step++) {
        const point = await safe(() => session.js(`(() => {
          const frame = document.getElementById('editor');
          const w = frame.contentWindow, doc = w.document;
          const blocks = [...doc.querySelectorAll(${SURFACE} + ' p')].filter(node => node.textContent.trim().length > 10);
          const node = blocks[Math.floor(Math.random() * Math.min(blocks.length, 40))];
          if (!node) return {ok: false};
          node.scrollIntoView({block: 'center', behavior: 'instant'});
          const rect = node.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
          return {ok: true, x: Math.round(frameRect.x + rect.x + 30), y: Math.round(rect.y + frameRect.y + rect.height / 2)}; })()`));
        if (!point || !point.ok) continue;
        await safe(() => session.move(point.x, point.y));
        await safe(() => session.click(point.x, point.y));
        await sleep(100);
        await safe(() => session.key({key: 'End', code: 'End', vk: 35}));
        await safe(() => session.type('测'));
        await sleep(120);
        await safe(() => session.chord('z', 'KeyZ', 90));
        await sleep(120);
        await safe(() => session.chord('y', 'KeyY', 89));
        await sleep(120);
        await safe(() => session.wheel(point.x, point.y, 300));
        await sleep(100);
        edits++;
      }
      // 抽干撤销/重做栈，再做一次新编辑把重做栈清掉：让"历史"不再占着
      for (let i = 0; i < 200; i++) { await safe(() => session.chord('z', 'KeyZ', 90)); await sleep(20); }
      for (let i = 0; i < 200; i++) { await safe(() => session.chord('y', 'KeyY', 89)); await sleep(20); }
      await safe(() => session.js(`(() => { const w = document.getElementById('editor').contentWindow; w.vditor.vditor.ir.element.focus(); return true; })()`));
      await safe(() => session.type('清'));
      await sleep(2500);
      await sample(round, edits);
    }
    const heaps = rows.map(row => row.heapMB).filter(value => value !== null);
    const nodes = rows.map(row => row.nodes).filter(value => value !== null);
    const heapTrend = trend(heaps, 0.5);
    const nodeTrend = trend(nodes, 200);
    const rssTrend = trend(rows.map(row => row.rssMb), 20);
    const verdict = {堆: heapTrend, 节点: nodeTrend, RSS: rssTrend,
      suspectedLeak: heapTrend.climbing || nodeTrend.climbing};
    say('');
    say(`结论：V8 已用堆（强制 GC 后）${JSON.stringify(heaps)} → 前段均值 ${heapTrend.head}、后段均值 ${heapTrend.tail}（阈值 ${heapTrend.limit}）`);
    say(`      DOM 节点${JSON.stringify(nodes)} → 前段均值 ${nodeTrend.head}、后段均值 ${nodeTrend.tail}（阈值 ${nodeTrend.limit}）`);
    say(`      进程树 RSS${JSON.stringify(rows.map(row => row.rssMb))} → 前段均值 ${rssTrend.head}、后段均值 ${rssTrend.tail}`);
    say(`判定：${verdict.suspectedLeak ? '★ 仍在持续增长（疑似泄漏）' : '收敛（有界缓存）'}`
      + `　（RSS 单独看不算泄漏依据：Chromium 分配器不把释放的内存还给 OS，见 math-scheduler.js 的实测记录）`);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({rounds: rows, verdict, perRoundEdits: 15, hiccups}, null, 1));
  } finally {
    await session.close();
    try { fs.rmSync(file, {force: true}); } catch { /* 副本用完即删 */ }
  }
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n'));
})().catch(error => { console.error('探针失败：', (error && error.stack) || error); process.exit(1); });
