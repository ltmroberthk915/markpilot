/** 拟人输入补充套件（human-input）专用运行器。
 *
 *  与 scripts/acceptance/run.cjs 的关系：**平行的独立入口**——只扫描本目录的
 *  scenarios/，报告写 .perf/human-input/<label>/，不写验收的台账/基线/报告，
 *  从而不与主验收流程（DeepSeek 会话负责 2.2.12 交付）抢任何文件。
 *  场景契约与 run.cjs 完全一致（id/title/run + ctx.assert/witness/metric/launch/release
 *  + 反假通过闸门），将来某场景稳定后，把文件挪进 scripts/acceptance/scenarios/
 *  即可直接成为正式 gate，一行不用改。
 *
 *  用法：
 *    node scripts/human-input/runner.cjs --app=dev --label=human-input
 *    node scripts/human-input/runner.cjs --app=dev --only=hi-format
 *    node scripts/human-input/runner.cjs --list
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('../acceptance/harness.cjs');

const project = harness.project;
const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const INDEPENDENT_CHANNELS = ['disk', 'clipboard', 'process', 'geometry'];
const INSTALLED = 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const resolveApp = value => {
  if (!value || value === 'installed') return { exe: INSTALLED, kind: 'installed' };
  if (value === 'dev') return { exe: path.join(project, 'node_modules/electron/dist/electron.exe'), kind: 'dev', appArgs: [path.join(project, 'app/main/main.js')] };
  const exe = path.isAbsolute(value) ? value : path.join(project, value);
  return { exe, kind: 'packaged' };
};

// 与主验收相同的两条已知噪声（Electron 沙箱预加载在 iframe 里的内部告警）。
const KNOWN_CONSOLE_NOISE = [
  { pattern: /Electron sandboxed_renderer\.bundle\.js script failed to run/, why: 'Electron 沙箱预加载在 iframe 里的内部告警，主验收白名单同款' },
  { pattern: /Cannot destructure property 'preloadScripts' of 'binding\.startupData'/, why: '同上一条的后续堆栈' },
];
const classifyNoise = message => KNOWN_CONSOLE_NOISE.find(entry => entry.pattern.test(message));

const scenariosDir = path.join(__dirname, 'scenarios');
const allScenarios = fs.existsSync(scenariosDir)
  ? fs.readdirSync(scenariosDir).filter(name => name.endsWith('.cjs')).sort() : [];

/** 把两仓的 git 状态记进报告：复现记录必须知道被测代码是哪棵树。 */
function gitSnapshot() {
  const run = (repo, args) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };
  const repos = [project, path.join(path.dirname(project), 'Typora-Editor')];
  return repos.map(repo => ({
    repo: path.basename(repo),
    head: run(repo, ['rev-parse', 'HEAD']),
    branch: run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: (run(repo, ['status', '--porcelain']) || '').split('\n').filter(Boolean).slice(0, 40),
  }));
}

const runScenario = async (file, context) => {
  const scenario = require(path.join(scenariosDir, file));
  const result = { id: scenario.id, title: scenario.title, file, pass: true, checks: [], witnesses: [], metrics: {}, notes: [], durationMs: 0, error: null };
  const started = Date.now();
  const sessions = [];
  const closed = new Set();
  const release = async session => {
    if (!session || closed.has(session)) return;
    closed.add(session);
    const unknown = session.errors.filter(message => !classifyNoise(message));
    const known = session.errors.filter(classifyNoise);
    if (unknown.length) result.checks.push({ label: '会话无新增 console 错误 / 异常', pass: false, evidence: unknown.slice(0, 5).join(' | ') });
    else result.checks.push({ label: '会话无新增 console 错误 / 异常', pass: true, evidence: known.length ? `0 条新增（已知噪声 ${known.length} 条）` : '0 条' });
    result.consoleErrors = (result.consoleErrors || []).concat(unknown.slice(0, 8));
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
      result.metrics[name] = { value: Math.round(value * 100) / 100, ...options };
    },
    async launch(options = {}) {
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
    const text = String((error && error.message) || error);
    if (text.includes(harness.TEARDOWN_REJECT) && result.checks.length && result.checks.every(check => check.pass)) {
      result.notes.push('收尾竞态（不计为产品失败）：' + text);
    } else {
      result.error = String((error && error.stack) || error).slice(0, 2400);
    }
  } finally {
    for (const session of sessions) await release(session);
    result.durationMs = Date.now() - started;
  }
  if (!result.checks.length) result.checks.push({ label: '场景至少有一条断言', pass: false, evidence: '0 条' });
  if (!result.witnesses.length) result.checks.push({ label: '独立证人（代码之外的通道）', pass: false, evidence: '0 条——只靠产品自报不算通过' });
  else if (!result.witnesses.some(witness => witness.kind !== 'self')) result.checks.push({ label: '独立证人（代码之外的通道）', pass: false, evidence: '只有 self 证人' });
  else {
    const declared = result.witnesses.filter(witness => witness.channel);
    result.declaredChannels = declared.map(witness => witness.channel);
    if (declared.length && !declared.some(witness => INDEPENDENT_CHANNELS.includes(witness.channel))) {
      result.checks.push({ label: '独立见证通道（声明的通道里至少一条在产品之外）', pass: false, evidence: JSON.stringify(result.declaredChannels) });
    }
  }
  result.pass = !result.error && result.checks.every(check => check.pass);
  return result;
};

async function main() {
  if (process.argv.includes('--list')) {
    for (const file of allScenarios) {
      const scenario = require(path.join(scenariosDir, file));
      console.log(`${file.padEnd(46)} ${scenario.id}  ${scenario.title}`);
    }
    return;
  }
  const appSpec = resolveApp(argOf('app', 'dev'));
  const label = argOf('label', 'human-input');
  const only = (argOf('only', '') || '').split(',').filter(Boolean);
  const outDir = path.join(project, '.perf/human-input', label);
  fs.mkdirSync(outDir, { recursive: true });
  const files = only.length ? allScenarios.filter(name => only.some(prefix => name.includes(prefix))) : allScenarios;
  if (!files.length) { console.error('没有匹配的场景（--only=' + only.join(',') + '）'); process.exitCode = 1; return; }
  const context = { app: { exe: appSpec.exe, args: appSpec.args, appArgs: appSpec.appArgs }, appKind: appSpec.kind, label, outDir };
  const report = { label, app: appSpec, startedAt: new Date().toISOString(), git: gitSnapshot(), argv: process.argv.slice(2), scenarios: [], passed: 0, failed: 0 };
  console.log(`[human-input] 验收：${label}（${appSpec.kind}）→ ${outDir}`);
  for (const repo of report.git) console.log(`  · ${repo.repo}@${String(repo.head).slice(0, 8)}（${repo.branch}）脏文件 ${repo.dirty.length} 个`);
  for (const file of files) {
    const result = await runScenario(file, context);
    report.scenarios.push(result);
    if (result.pass) report.passed += 1; else report.failed += 1;
    const bad = result.checks.filter(check => !check.pass);
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${path.basename(file, '.cjs').padEnd(34)} ${result.durationMs}ms  ${result.checks.length - bad.length}/${result.checks.length} 断言，${result.witnesses.length} 证人`
      + (result.error ? `  异常：${result.error.split('\n')[0].slice(0, 160)}` : ''));
    for (const check of bad) console.log(`        ✗ ${check.label} — ${String(check.evidence).slice(0, 220)}`);
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n[human-input] 结论：${report.passed} 通过 / ${report.failed} 失败 → ${report.failed === 0 ? 'ACCEPT' : 'REJECT'}（报告：${path.join(outDir, 'report.json')}）`);
  if (report.failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
