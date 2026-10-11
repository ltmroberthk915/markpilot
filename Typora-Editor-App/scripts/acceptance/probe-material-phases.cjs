/** 按阶段复现"76 在素材阶段把应用弄没"——哪一步杀死的。
 *
 *  已排除的事实（2026-09-17）：
 *   · 打开这份 305KB 素材后**静置 150 秒毫无问题**（`probe-material-open` / `probe-material-lifetime`：
 *     1 个页面目标、3 张图、134 块、进程不退出）；
 *   · 渲染进程没有崩（诊断日志无 `render-process-gone`）。
 *  所以凶手是场景对它做的**操作序列**。本探针按阶段推进，每阶段后检查存活状态，
 *  第一个让应用消失的阶段就是答案。
 *
 *  用法：node scripts/acceptance/probe-material-phases.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;

const MATERIAL = 'E:/MarkPilot/测试素材_每次使用需复制用后需删除试验副本/表格bug-富文本测试-重识概率论-副本.md';
const OUT = path.join(project, '.perf/repro-material-phases');
const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const LOOP = `(() => { const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const root = w && w.document && w.document.querySelector(${JSON.stringify(SURFACE)});
  return {imgs: root ? root.querySelectorAll('img').length : -1}; })()`;
const POINT = `(() => { const w = ${IF}, d = w.document;
  const frame = document.getElementById('editor');
  const fr = frame.getBoundingClientRect();
  const img = d.querySelectorAll(${JSON.stringify(SURFACE)} + ' img')[1];
  if (!img) return {ok: false, why: '没有第 2 张图'};
  const r = img.getBoundingClientRect();
  return {ok: true, x: Math.round(fr.x + r.left + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2),
    visible: r.top > 0 && r.bottom < fr.height}; })()`;

/** 一次"还活着吗"的三问：进程 / 页面目标 / 编辑器。 */
const aliveCheck = async (session, tag) => {
  const pages = await session.pages().catch(() => '读不到');
  if (session.child.exitCode !== null || session.child.signalCode) {
    console.log(`  ★★ [${tag}] 进程已退出 code=${session.child.exitCode} signal=${session.child.signalCode}`);
    return false;
  }
  let editor = null;
  try {
    const value = await session.send('Runtime.evaluate', {expression: LOOP, returnByValue: true}, 5000);
    editor = (value && value.result && value.result.value) || null;
  } catch (error) { editor = {error: String((error && error.message) || error).split('\n')[0]}; }
  console.log(`  [${tag}] 页面目标=${Array.isArray(pages) ? pages.length : pages} 编辑器=${JSON.stringify(editor)}`);
  return Array.isArray(pages) && pages.length > 0;
};

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const copy = path.join(OUT, 'material.md');
  fs.copyFileSync(MATERIAL, copy);
  fs.chmodSync(copy, 0o666);

  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-material-phases', outDir: OUT, args: [copy], timeout: 300000, inspect: true,
  });
  const started = Date.now();
  const at = () => ((Date.now() - started) / 1000).toFixed(1) + 's';
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 60});
    await sleep(1500);
    console.log('t=' + at() + ' 素材已就绪');
    await aliveCheck(session, '基线');

    // ── 阶段 A：真滚轮找第 2 张图（场景 76 里最多 160 次）──────────────────
    console.log('\n阶段 A：滚轮循环（最多 160 次 × wheel 900）');
    const centre = await session.js(`(() => { const rect = document.getElementById('editor').getBoundingClientRect();
      return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)}; })()`);
    let found = {ok: false};
    for (let step = 0; step < 160; step++) {
      found = await session.js(POINT).catch(error => ({ok: false, why: String(error.message).split('\n')[0]}));
      if (found.ok && found.visible) break;
      await session.wheel(centre.x, centre.y, 900);
      await sleep(70);
      if (step % 40 === 39) {
        console.log('  t=' + at() + ' 滚轮第 ' + (step + 1) + ' 次');
        if (!(await aliveCheck(session, 'A/滚轮'))) { console.log('  → 阶段 A 内退出'); return; }
      }
    }
    console.log('  t=' + at() + ' 找到第 2 张图：' + JSON.stringify(found));
    if (!(await aliveCheck(session, 'A 结束'))) return;

    // ── 阶段 B：右键图片 ────────────────────────────────────────────────
    console.log('\n阶段 B：右键图片');
    if (found.ok) { await session.click(found.x, found.y, {button: 'right'}); await sleep(1200); }
    if (!(await aliveCheck(session, 'B/右键'))) { console.log('  → 阶段 B 内退出'); return; }

    // ── 阶段 C：打字 + 保存 ─────────────────────────────────────────────
    console.log('\n阶段 C：打字 + 保存');
    await session.key({key: 'Q', code: 'KeyQ', vk: 81, text: 'Q'});
    await sleep(700);
    await session.chord('s', 'KeyS', 83);
    await sleep(1600);
    if (!(await aliveCheck(session, 'C/打字保存'))) { console.log('  → 阶段 C 内退出'); return; }

    // ── 阶段 D：连续截图（场景里截图很密）──────────────────────────────
    console.log('\n阶段 D：连续截图 × 6');
    for (let i = 0; i < 6; i++) {
      await session.shot('phase-d-' + i).catch(error => console.log('  截图失败：' + String(error.message).split('\n')[0]));
      if (!(await aliveCheck(session, 'D/截图 ' + (i + 1)))) { console.log('  → 阶段 D 内退出'); return; }
    }

    console.log('\n结论：走完 A–D 四个阶段，应用仍然活着（t=' + at() + '）');
  } finally {
    const logFile = path.join(session.profile, 'logs', 'markpilot.log');
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, 'utf8');
      console.log('--- 诊断日志里的事件 ---');
      console.log((text.split('\n').filter(line => /render-process-gone|unresponsive|fatal|error/.test(line)).slice(-8).join('\n')) || '（无异常记录）');
    }
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
