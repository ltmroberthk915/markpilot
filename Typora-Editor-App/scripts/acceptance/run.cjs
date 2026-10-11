/** 打包产物验收运行器。
 *
 *  用法：
 *    node scripts/acceptance/run.cjs --app=installed --label=2.0.16
 *    node scripts/acceptance/run.cjs --app=dev --label=dev-check --only=open-latency
 *    node scripts/acceptance/run.cjs --app=dist-2.0.15/win-unpacked/MarkPilot.exe --label=2.0.15
 *  台账：
 *    .perf/acceptance/<label>.json        本次全部证据与数字
 *    .perf/acceptance/baseline.json       上一次"被接受"的数字（用 --accept 更新）
 *
 *  反假通过（结构上强制，不靠自觉）：
 *    1. 场景没有独立证人 → 失败。证人只认代码之外的通道：系统剪贴板读回、磁盘
 *       文件、独立进程、几何量测。
 *    2. 场景必须至少断言一条"用户看得见的效果"（对 <2.0.16 的做法：只断言处理器
 *       被调用过是不算的）。
 *    3. 场景结束时会话里出现任何 console 错误 / 未捕获异常 / 错误提示元素 → 失败。
 *    4. 数字进台账，和 baseline 按容差比对，退化即失败。
 *    5. 场景清单固定：少跑一个也算失败（--only 只用于排查，不产出"通过"结论）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');

const project = harness.project;
const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => process.argv.includes('--' + name);

/* ── dsh-web 目标层（r20 移植设计 §4.3）─────────────────────────────────────────
 *  --target=dsh-web 时启用：场景目录 scenarios-cm6/、baseline-cm6.json（从零起建）、
 *  台账 <label>-cm6/；ctx.launch 改走 harness-web（Playwright 管目标 + CDP Input 真输入）。
 *  缺省（不带 --target 或 =electron）时下面所有分支都不生效，2.x Electron 路径零漂移。 */
const target = argOf('target', 'electron');
const isWeb = target === 'dsh-web';
if (target !== 'electron' && !isWeb) throw new Error('未知 --target=' + target + '（支持 electron | dsh-web）');
const webHarness = isWeb ? require('./harness-cm6/harness-web.cjs') : null;
const webOpts = isWeb ? { tier: Number(argOf('tier', '1')), engine: argOf('engine', 'cm6'), base: argOf('base', 'http://127.0.0.1:4177') } : null;

/** 真正在产品之外的见证通道：磁盘字节 / 系统剪贴板 / 独立进程 / 几何量测。
 *  `dom` 只是产品自己渲染出来的东西，不算独立；`self` 是产品自报，明确不算。 */
const INDEPENDENT_CHANNELS = ['disk', 'clipboard', 'process', 'geometry'];

const INSTALLED = 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const resolveApp = value => {
  if (!value || value === 'installed') return { exe: INSTALLED, kind: 'installed' };
  if (value === 'dev') return { exe: path.join(project, 'node_modules/electron/dist/electron.exe'), kind: 'dev', appArgs: [path.join(project, 'app/main/main.js')] };
  const exe = path.isAbsolute(value) ? value : path.join(project, value);
  return { exe, kind: 'packaged' };
};

const baselineFile = path.join(project, '.perf/acceptance', isWeb ? 'baseline-cm6.json' : 'baseline.json');
const readBaseline = () => { try { return JSON.parse(fs.readFileSync(baselineFile, 'utf8')); } catch { return { metrics: {} }; } };

function compareMetrics(metrics, baseline) {
  const rows = [];
  // 相对容差在毫秒级小指标上没有意义（3ms→4ms 会被算成 +33% 的"退化"）。所以再加一条
  // 绝对下限：差值必须同时超过相对容差与下限才算退化。单位是 ms 的默认下限 20ms，
  // 计数类（张/行/字符）不设下限。
  const floorOf = metric => {
    if (Number.isFinite(metric.floor)) return metric.floor;
    return (metric.unit || '') === 'ms' ? 20 : 0;
  };
  for (const [name, metric] of Object.entries(metrics)) {
    const base = baseline.metrics[name];
    if (!base) { rows.push({ name, value: metric.value, status: 'new' }); continue; }
    const tolerance = metric.tolerance ?? base.tolerance ?? 0.15;
    const direction = metric.direction || base.direction || 'lower';
    const floor = floorOf(metric);
    const delta = metric.value - base.value;
    const ratio = base.value ? delta / base.value : 0;
    const beyond = Math.abs(delta) > Math.max(floor, Math.abs(base.value) * tolerance);
    let status = 'ok';
    if (direction === 'lower' && delta > 0 && beyond) status = 'regressed';
    if (direction === 'higher' && -delta > 0 && beyond) status = 'regressed';
    if (direction === 'equal' && Math.abs(delta) > Math.max(floor, Math.abs(base.value) * tolerance)) status = 'regressed';
    if (status === 'ok' && beyond && direction === 'lower' && ratio < 0) status = 'improved';
    if (status === 'ok' && beyond && direction === 'higher' && ratio > 0) status = 'improved';
    rows.push({ name, value: metric.value, base: base.value, delta, ratio: +ratio.toFixed(4), floor, status, unit: metric.unit || base.unit || '' });
  }
  return rows;
}

const scenariosDir = path.join(__dirname, isWeb ? 'scenarios-cm6' : 'scenarios');
const allScenarios = fs.readdirSync(scenariosDir).filter(name => name.endsWith('.cjs')).sort();

// 已知噪声白名单：每一条都必须写清"为什么无害"，并且只匹配这一种形态。
// 目的不是把错误藏起来，而是让**新出现的**错误立刻变成红灯——打包产物在启动时
// 本来就会打这两条（沙箱预加载在编辑器 iframe 里的 Electron 内部报错，实测与
// CDP 附加、启动参数都无关，且不影响任何用户可见行为）。
const KNOWN_CONSOLE_NOISE = [
  { pattern: /Electron sandboxed_renderer\.bundle\.js script failed to run/, why: 'Electron 沙箱预加载在 iframe 里的内部告警，2.0.15 安装版同样存在，行为无影响' },
  { pattern: /Cannot destructure property 'preloadScripts' of 'binding\.startupData'/, why: '同上一条的后续堆栈' },
];
const classifyNoise = message => KNOWN_CONSOLE_NOISE.find(entry => entry.pattern.test(message));

const runScenario = async (file, context) => {
  const scenario = require(path.join(scenariosDir, file));
  const result = { id: scenario.id, title: scenario.title, file, pass: true, checks: [], witnesses: [], metrics: {}, notes: [], durationMs: 0, error: null };
  // 只对打包产物/壳档成立的场景（比如 asar 审计、守卫保存）：对应目标跑不了，也不能算
  // 通过，更不能算失败——单独标成"不适用"，并且**不**计入通过数。
  if (scenario.packagedOnly && (isWeb ? webOpts.tier !== 2 : context.appKind === 'dev')) {
    result.applicable = false;
    result.notes.push(isWeb ? `不适用：壳档（tier 2）专属场景，本轮 tier=${webOpts.tier}` : '不适用：开发树没有 app.asar（本轮结论必须来自打包产物）');
    return result;
  }
  const started = Date.now();
  const sessions = [];
  const closed = new Set();
  // 会话必须"用完即还"：产品内部 HTTP 服务占一个固定端口，同一时刻只能有一个实例。
  // 场景里下一个 launch 之前一定要 release 上一个，否则第二个实例会撞端口直接崩。
  const release = async session => {
    if (!session || closed.has(session)) return;
    closed.add(session);
    // 错误面断言：任何**不在白名单里**的 console 错误 / 未捕获异常都算失败。
    const unknown = session.errors.filter(message => !classifyNoise(message));
    const known = session.errors.filter(classifyNoise);
    if (unknown.length) result.checks.push({ label: '会话无新增 console 错误 / 异常', pass: false, evidence: unknown.slice(0, 5).join(' | ') });
    else result.checks.push({ label: '会话无新增 console 错误 / 异常', pass: true, evidence: known.length ? `0 条新增（已知噪声 ${known.length} 条）` : '0 条' });
    result.consoleNoise = (result.consoleNoise || 0) + known.length;
    result.consoleErrors = (result.consoleErrors || []).concat(unknown.slice(0, 5));
    result.consoleWarnings = (result.consoleWarnings || []).concat(session.warnings.slice(0, 10));
    await session.close();
  };
  const ctx = {
    ...context,
    log: message => { result.notes.push(message); },
    assert(label, pass, evidence) {
      result.checks.push({ label, pass: !!pass, evidence });
      return !!pass;
    },
    witness(kind, data, channel) { result.witnesses.push(channel ? { kind, data, channel } : { kind, data }); },
    metric(name, value, options = {}) {
      if (!Number.isFinite(value)) { result.checks.push({ label: '指标 ' + name + ' 必须是有限数', pass: false, evidence: String(value) }); return; }
      const entry = { value: Math.round(value * 100) / 100, ...options };
      // 延迟类指标取样本里的**最小值**进台账：单次冷启动的抖动可达数倍（本机实测
      // 1.5s–5.3s），用中位数会在噪声大的时候误判退化；最小值是"这台机器能做到多快"，
      // 真退化会把它一起抬上去。中位数与全样本仍然写进报告，供人复盘。
      if (Array.isArray(options.values) && options.values.length) {
        const clean = options.values.filter(item => Number.isFinite(item));
        entry.samples = clean.slice();
        entry.min = Math.min(...clean);
        entry.max = Math.max(...clean);
        entry.medianOfSamples = clean.slice().sort((a, b) => a - b)[Math.floor(clean.length / 2)];
        if ((options.direction || 'lower') === 'lower') entry.value = Math.round(entry.min * 100) / 100;
      }
      result.metrics[name] = entry;
    },
    async launch(options = {}) {
      // dsh-web：场景代码里的 launch 调用形态不变，目标层换 harness-web（Playwright
      // 管 4177/宿主页，CDP Input 真输入）。2.x Electron 分支保持原样。
      if (context.web) {
        const session = await webHarness.launch({ label: context.label, outDir: path.join(context.outDir, scenario.id), ...context.web, ...options });
        sessions.push(session);
        return session;
      }
      const merged = { ...context.app, ...options, appArgs: context.app.appArgs || [], args: options.args || [] };
      const session = await harness.launch({ label: context.label, outDir: path.join(context.outDir, scenario.id), ...merged });
      sessions.push(session);
      return session;
    },
    release,
  };
  try {
    await scenario.run(ctx);
  } catch (error) {
    // 收尾竞态（关闭会话时仍在飞行的 CDP 请求被拒）：断言已全过的情况下，这是验收工具自己的
    // 收尾问题，不该冒充产品失败——但不静默，记成 note 写进报告与台账。
    const text = String((error && error.message) || error);
    if (text.includes(harness.TEARDOWN_REJECT) && result.checks.length && result.checks.every(check => check.pass)) {
      result.notes.push('收尾竞态（不计为产品失败）：' + text);
    } else {
      result.error = String((error && error.stack) || error).slice(0, 2000);
    }
  } finally {
    for (const session of sessions) await release(session);
    result.durationMs = Date.now() - started;
  }
  // 结构闸门
  if (!result.checks.length) { result.checks.push({ label: '场景至少有一条断言', pass: false, evidence: '0 条' }); }
  if (!result.witnesses.length) { result.checks.push({ label: '独立证人（代码之外的通道）', pass: false, evidence: '0 条——只靠产品自报不算通过' }); }
  else if (!result.witnesses.some(witness => witness.kind !== 'self')) { result.checks.push({ label: '独立证人（代码之外的通道）', pass: false, evidence: '只有 self 证人' }); }
  else {
    // 上面那条判据（`kind !== 'self'`）**实际上是空的**：全部调用点传的都是一句中文描述，
    // 条件恒真、永远不会触发。独立通道于是只剩"人工约定"，没人能自动拦住。
    // 现在改成机器可判：场景**声明了**通道（witness 的第三个参数）时，其中至少一条必须是
    // 真正在产品之外的通道。没有声明通道的旧场景不在此列（加法迁移，不破坏现状），
    // 但它们会进"待补通道"清单，每一轮都打印出来，不至于被忘掉。
    const declared = result.witnesses.filter(witness => witness.channel);
    result.declaredChannels = declared.map(witness => witness.channel);
    if (declared.length && !declared.some(witness => INDEPENDENT_CHANNELS.includes(witness.channel))) {
      result.checks.push({ label: '独立见证通道（声明的通道里至少一条在产品之外）', pass: false,
        evidence: JSON.stringify(result.declaredChannels) });
    }
  }
  result.pass = !result.error && result.checks.every(check => check.pass);
  return result;
}

async function main() {
  const appSpec = resolveApp(argOf('app', 'installed'));
  const label = argOf('label', isWeb ? 'dsh-web' : (appSpec.kind === 'installed' ? 'installed' : path.basename(path.dirname(appSpec.exe))));
  const only = (argOf('only', '') || '').split(',').filter(Boolean);
  const pack = argOf('pack', '');
  const outDir = path.join(project, '.perf/acceptance', label + (isWeb ? '-cm6' : ''));
  fs.mkdirSync(outDir, { recursive: true });
  const files = only.length ? allScenarios.filter(name => only.some(prefix => name.includes(prefix))) : allScenarios;
  const context = { app: { exe: appSpec.exe, args: appSpec.args, appArgs: appSpec.appArgs }, appKind: appSpec.kind, label, outDir, web: webOpts };
  const report = { label, app: appSpec, startedAt: new Date().toISOString(), scenarios: [], metrics: {}, passed: 0, failed: 0, skipped: 0 };
  if (isWeb) {
    // 被测真身指纹进报告（设计 §7.7：不许连热载目录还自称验收）。
    report.target = { kind: 'dsh-web', ...webOpts, bundle: webHarness.bundleFingerprint(), scenariosDir: 'scenarios-cm6' };
  }
  console.log(`验收：${label}（${appSpec.kind}）→ ${outDir}`);
  for (const file of files) {
    if (pack) { // 包过滤（设计 §6.4）：场景声明 packs，缺省视为 core；pack 跑不算全场景结论
      const scenarioModule = require(path.join(scenariosDir, file));
      const packs = Array.isArray(scenarioModule.packs) ? scenarioModule.packs : ['core'];
      if (!packs.includes(pack)) { console.log(`SKIP  ${path.basename(file)}（pack=${pack} 之外）`); continue; }
    }
    const result = await runScenario(file, context);
    report.scenarios.push(result);
    for (const [name, metric] of Object.entries(result.metrics)) report.metrics[name] = metric;
    if (result.applicable === false) report.skipped += 1;
    else if (result.pass) report.passed += 1; else report.failed += 1;
    const bad = result.checks.filter(check => !check.pass);
    console.log(`${result.applicable === false ? 'N/A ' : result.pass ? 'PASS' : 'FAIL'}  ${path.basename(file, '.cjs').padEnd(22)} ${result.durationMs}ms  ` +
      `${result.checks.length - bad.length}/${result.checks.length} 断言，${result.witnesses.length} 证人` +
      (result.error ? `  异常：${result.error.split('\n')[0]}` : ''));
    for (const check of bad) console.log(`        ✗ ${check.label} — ${check.evidence}`);
    for (const note of result.notes) console.log(`        · ${note}`);
  }
  // 待补通道清单：加法迁移的可视化。每一轮都打印，"还有哪些场景的独立性只是人工约定"一目了然。
  const undeclared = report.scenarios.filter(scenario => scenario.applicable !== false && !(scenario.declaredChannels || []).length);
  if (undeclared.length) {
    console.log('\n待补见证通道（' + undeclared.length + ' 个场景尚未声明通道，加法迁移中）：' + undeclared.map(s => s.id).join(' '));
  }
  const applicable = report.scenarios.filter(scenario => scenario.applicable !== false).length;
  const complete = !only.length && applicable === allScenarios.length;
  const rows = compareMetrics(report.metrics, readBaseline());
  report.ledger = rows;
  const regressions = rows.filter(row => row.status === 'regressed');
  if (regressions.length) report.failed += 1;
  // 合并写入：用 --only 跑单场景时不能把同一 label 里其它场景的数字抹掉
  //（上一轮就这么丢过一次台账基线）。同名场景以本次为准。
  const reportFile = path.join(outDir, 'report.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { previous = null; }
  if (previous) {
    report.metrics = { ...previous.metrics, ...report.metrics };
    const byId = new Map((report.scenarios || []).map(item => [item.id, item]));
    for (const item of previous.scenarios || []) if (!byId.has(item.id)) report.scenarios.push(item);
  }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log('\n数字台账（对上一次被接受的版本）：');
  for (const row of rows) {
    const suffix = row.status === 'new' ? '（新）' : row.status === 'improved' ? '（改善）' : row.status === 'regressed' ? '（退化）' : '';
    console.log(`  ${row.status === 'regressed' ? '✗' : ' '} ${row.name.padEnd(34)} ${String(row.value).padStart(10)} ${row.unit}` +
      (row.base !== undefined ? `  基准 ${row.base}  差 ${row.delta > 0 ? '+' : ''}${row.delta}` : '') + ` ${suffix}`);
  }
  if (has('accept')) {
    // 基准只接受**全场景通过**的一轮。此前这里是无条件写盘：一次红的跑——或者一次 --only 的
    // 局部跑——就能把基准覆盖掉，退化从此无人拦。这是整套闸门里最危险的洞。
    if (report.failed || !complete) {
      console.log('\n拒绝写入基准：本轮 ' + report.failed + ' 个失败、' + (complete ? '已跑全场景' : '未跑全场景') + '。');
      console.log('基准只接受"全场景通过"的一轮——否则一次红的跑就会把基准覆盖，退化从此无人拦。');
      process.exitCode = 1;
    } else {
      fs.writeFileSync(baselineFile, JSON.stringify({ label, acceptedAt: new Date().toISOString(), metrics: report.metrics }, null, 2));
      console.log('\n已把本次数字写入基准：' + baselineFile);
    }
  }
  const verdict = report.failed === 0 && complete;
  console.log(`\n结论：${report.passed} 通过 / ${report.failed} 失败 / ${report.skipped} 不适用${complete ? '' : '（未跑全场景，不算通过）'} → ${verdict ? 'ACCEPT' : 'REJECT'}`);
  if (!verdict) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
