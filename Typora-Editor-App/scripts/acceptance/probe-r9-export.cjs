/** 探针 · R9 验收 D+E 门（printToPDF 竞速洞 + 导出进度最小 UX）+ K1 图入 PDF。
 *
 *  判据：
 *   · e1 计时走字+打印提示（G-E-1/2）：中型文档（非超大路径）导出 PDF——
 *     #export-elapsed 存在且 ≥1.5s 两拍数字不同（截图 ×2 同框「正在打印 PDF…」）；
 *     消息序列出现「正在打印 PDF…」→ done 后 elapsed 清除、按钮变「完成」；
 *   · e2 取消+再导出（G-D-1）：大文档（696KB，超大兼容路径）导出中等「正在打印」
 *     出现 → +1s 点对话框「取消」→ ≤5s 收到「已取消导出」终态；目标目录无半成品；
 *     **紧接着第二次导出不被「已有导出任务正在进行」拒绝且成功**（job 泄漏根治）；
 *   · e3 小文档字节基线（G-D-2 前半）+ HTML 分支（无「正在打印」文案）；
 *   · k1pdf（G-K1-2④）：K1 归档文档导出 PDF，产物含图片 XObject。
 *
 *  通道：菜单经主进程调试器真点（clickMenu）；保存对话框走已验证的替身通道；
 *  取消按真实 DOM 点击（#export-dialog 的取消按钮）；截图走 CDP。
 *
 *  用法：node scripts/acceptance/probe-r9-export.cjs [--only=e1,e2,e3,k1pdf] [--mutant]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const MUTANT = process.argv.includes('--mutant');
const OUT = path.join(harness.project, '.perf/probe-r9-export');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const BIG_SRC = 'E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md';
const K1_DOC = path.join(harness.project, '.perf/probe-r9-k1/r9-k1-main.md');

// 中型文档：~700 块 + 行内公式（非超大路径：块 <1800、源 <300KB）
function mediumDoc() {
  const parts = ['# R9E 中型导出文档', ''];
  for (let i = 0; i < 700; i++) {
    parts.push('第' + i + '段：导出计时的行走需要足够的页数撑起打印窗口，行内公式 $a_' + i + '+b_' + i + '=c_' + i + '$ 随段分布。');
  }
  parts.push('');
  return parts.join('\n');
}

const DIALOG_READ = `(() => { const d = document.querySelector('#export-dialog'); if (!d) return null;
  return { open: d.open,
    message: (d.querySelector('#export-message')?.textContent || '').slice(0, 160),
    elapsedHidden: d.querySelector('#export-elapsed').hidden,
    elapsed: d.querySelector('#export-elapsed').textContent,
    按钮文: d.querySelector('[data-action=close]').textContent,
    按钮禁用: d.querySelector('[data-action=close]').disabled }; })()`;
const readDialog = session => session.js(DIALOG_READ);

/** 发起导出：脚本保存对话框 → 真点菜单。 */
async function startExport(session, format, target) {
  await session.main.script([{ dialog: 'save', file: target }]);
  const clicked = await session.main.clickMenu('文件 > 导出 > ' + (format === 'pdf' ? 'PDF 文档…' : format === 'html' ? 'HTML（独立网页）…' : ''));
  return clicked;
}

/** 轮询对话框直到谓词命中。 */
async function waitDialog(session, predicate, { timeout = 60000, step = 150 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await readDialog(session);
    if (last && predicate(last)) return { hit: true, at: Date.now() - t0, last };
    await harness.sleep(step);
  }
  return { hit: false, at: Date.now() - t0, last };
}

/** 真点「取消/完成」按钮（DOM 坐标真鼠标）。 */
async function clickDialogButton(session) {
  const rect = await session.js(`(() => { const b = document.querySelector('#export-dialog [data-action=close]'); if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!rect) throw new Error('找不到导出对话框按钮');
  await session.click(rect.x, rect.y);
}

// ─── e1 ──────────────────────────────────────────────────────────────────────
async function caseE1(session, env) {
  const target = path.join(OUT, 'e1-medium.pdf');
  await startExport(session, 'pdf', target);
  // 等「正在打印 PDF…」出现（非超大路径的新阶段消息）
  const printing = await waitDialog(session, d => /正在打印 PDF/.test(d.message), { timeout: 90000 });
  const shot1 = await readDialog(session);
  await session.shot('E1-打印中-A-full');
  await harness.sleep(1800);
  const shot2 = await readDialog(session);
  await session.shot('E1-打印中-B-full');
  const elapsedWalk = !shot1.elapsedHidden && !shot2.elapsedHidden && shot1.elapsed !== shot2.elapsed;
  const done = await waitDialog(session, d => d.按钮文 === '完成' && /已导出/.test(d.message), { timeout: 120000 });
  const doneDialog = await readDialog(session);
  const fileOK = fs.existsSync(target) && fs.statSync(target).size > 10 * 1024;
  // done 后 elapsed 清除（无残留行）
  const elapsedCleared = doneDialog.elapsedHidden && !doneDialog.elapsed;
  const ok = printing.hit && elapsedWalk && done.hit && fileOK && elapsedCleared;
  return { verdict: ok === !MUTANT ? 'PASS' : 'FAIL', detail: {
    打印消息出现: printing.hit, 打印消息: printing.last && printing.last.message,
    计时A: { hidden: shot1.elapsedHidden, text: shot1.elapsed }, 计时B: { hidden: shot2.elapsedHidden, text: shot2.elapsed },
    计时跳秒: elapsedWalk, 完成: done.hit, 完成消息: (doneDialog.message || '').slice(0, 80),
    产物大小: fs.existsSync(target) ? fs.statSync(target).size : 0, elapsed终态清除: elapsedCleared,
  } };
}

// ─── e2 ──────────────────────────────────────────────────────────────────────
async function caseE2(session, env) {
  const target = path.join(OUT, 'e2-big.pdf');
  const target2 = path.join(OUT, 'e2-big-2nd.pdf');
  // 第一轮：导出 → 打印阶段 +1s → 真点取消
  await startExport(session, 'pdf', target);
  const printing = await waitDialog(session, d => /正在打印|正在嵌入图片/.test(d.message), { timeout: 120000 });
  await harness.sleep(1000);
  const cancelAt = Date.now();
  await clickDialogButton(session);
  const canceled = await waitDialog(session, d => d.按钮文 === '完成' && /已取消导出/.test(d.message), { timeout: 5000 });
  const cancelMs = canceled.hit ? Date.now() - cancelAt : -1;
  await session.shot('E2-取消后-full');
  const noPartial = !fs.existsSync(target);
  // 第二轮：同一窗口立刻再导出（不被「已有导出任务正在进行」拒绝 = job 泄漏根治）
  await startExport(session, 'pdf', target2);
  const rejected = await waitDialog(session, d => /已有导出任务正在进行/.test(d.message), { timeout: 4000 });
  const done2 = await waitDialog(session, d => d.按钮文 === '完成' && /已导出/.test(d.message), { timeout: 180000 });
  const file2OK = fs.existsSync(target2) && fs.statSync(target2).size > 100 * 1024;
  const ok = canceled.hit && cancelMs >= 0 && cancelMs <= 5000 && noPartial && !rejected.hit && done2.hit && file2OK;
  return { verdict: ok === !MUTANT ? 'PASS' : 'FAIL', detail: {
    打印消息出现: printing.hit, 取消终态: canceled.hit, 取消耗时ms: cancelMs,
    无半成品: noPartial, 二次被拒: rejected.hit, 二次完成: done2.hit, 二次产物KB: file2OK ? Math.round(fs.statSync(target2).size / 1024) : 0,
    判据: '取消≤5s终态 + 无半成品 + 再导出成功（job 不泄漏）',
  } };
}

// ─── e3 ──────────────────────────────────────────────────────────────────────
async function caseE3(session, env) {
  const out = {};
  // PDF 小文档
  const t1 = path.join(OUT, 'e3-small.pdf');
  await startExport(session, 'pdf', t1);
  const done1 = await waitDialog(session, d => d.按钮文 === '完成' && /已导出/.test(d.message), { timeout: 60000 });
  out.pdf = { 完成: done1.hit, sha: fs.existsSync(t1) ? harness.fileSha(t1) : null };
  await clickDialogButton(session);  // 关掉上一轮的「已导出」对话框，避免残影干扰下一轮读数
  await harness.sleep(400);
  // HTML 分支：无「正在打印」文案（等消息换成 html 路径再进入监控）
  const t2 = path.join(OUT, 'e3-small.html');
  await startExport(session, 'html', t2);
  const msgs = [];
  const t0 = Date.now();
  let sawPrint = false, sawHtmlDone = false;
  while (Date.now() - t0 < 60000) {
    const d = await readDialog(session);
    if (d && d.open && !msgs.includes(d.message)) msgs.push(d.message);
    if (d && /正在打印 PDF/.test(d.message)) sawPrint = true;
    if (d && /e3-small\.html/.test(d.message) && d.按钮文 === '完成') { sawHtmlDone = true; break; }
    await harness.sleep(120);
  }
  out.html = { 消息序列: msgs, 无打印文案: !sawPrint, 完成含html路径: sawHtmlDone, 产物存在: fs.existsSync(t2) };
  const ok = done1.hit && fs.existsSync(t1) && sawHtmlDone && fs.existsSync(t2) && !sawPrint;
  return { verdict: ok === !MUTANT ? 'PASS' : 'FAIL', detail: out };
}

// ─── k1pdf ───────────────────────────────────────────────────────────────────
async function caseK1pdf(session, env) {
  const target = path.join(OUT, 'k1-archived.pdf');
  await startExport(session, 'pdf', target);
  const done = await waitDialog(session, d => d.按钮文 === '完成' && /已导出/.test(d.message), { timeout: 60000 });
  const bytes = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
  const hasImage = bytes.length > 0 && (bytes.includes(Buffer.from('/Subtype /Image')) || bytes.includes(Buffer.from('/Image')));
  const ok = done.hit && hasImage;
  return { verdict: ok === !MUTANT ? 'PASS' : 'FAIL', detail: {
    完成: done.hit, 产物KB: Math.round(bytes.length / 1024), 含图片XObject: hasImage,
    判据: 'G-K1-2④：归档图片导出 PDF 嵌入成功',
  } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => { const line = 'R9EXP ' + name + ' ' + verdict + ' ' + JSON.stringify(detail); console.log(line); log.push(line); };
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = n => !only.length || only.includes(n);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r9-export', outDir: OUT, timeout: 240000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const groups = [
    ['e1', caseE1, 'r9-e1-medium.md', mediumDoc(), { minBlocks: 50, settleMs: 5000 }],
    ['e2', caseE2, 'r9-e2-big.md', null, { minBlocks: 20, settleMs: 6000 }],
    ['e3', caseE3, 'r9-e3-small.md', '# R9E 小导出\n\n小文档正文一段，导出基线。\n', { minBlocks: 2, settleMs: 1800 }],
    ['k1pdf', caseK1pdf, K1_DOC, null, { minBlocks: 3, settleMs: 2500 }],
  ];
  let pass = 0, fail = 0;
  try {
    for (const [name, run, docPath, content, openOpts] of groups) {
      if (!want(name)) continue;
      let file = docPath;
      if (content !== null) { file = path.join(OUT, docPath); fs.writeFileSync(file, content, 'utf8'); }
      else if (name === 'e2') { file = path.join(OUT, docPath); fs.copyFileSync(BIG_SRC, file); fs.chmodSync(file, 0o666); }
      else if (name === 'k1pdf') { file = docPath; if (!fs.existsSync(file)) { report(name, 'FAIL', { 错: 'K1 文档不存在，先跑 K1 门' }); fail += 1; continue; } }
      let session = null;
      try {
        session = await hi.openDoc(ctx, file, { ...openOpts, timeout: 200000, inspect: true });
        const outcome = await run(session, { file }) || {};
        report(name, outcome.verdict || 'FAIL', outcome.detail || {});
        if ((outcome.verdict || '') === 'PASS') pass += 1; else fail += 1;
      } catch (error) {
        report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) }); fail += 1;
      } finally {
        if (session) { try { await ctx.release(session); } catch {} }
      }
    }
  } finally {
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('=== EXPORT 汇总：PASS ' + pass + ' / FAIL ' + fail + (MUTANT ? '（突变）' : '（绿轮）') + ' ===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-export 失败：', error); process.exit(1); });
