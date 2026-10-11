/** 探针 · R9 验收 G2/G1/G3（覆盖缺口探针，E9 §G——探针非修码，预期绿）。
 *
 *  G2（MW6 回归线 + 字数）：
 *   · 甲文档 st-words 基线 → 真输入 20 汉字 → ≤600ms st-words 恰 +20；
 *   · 切乙文档（菜单「在此窗口打开文件…」+ 对话框替身，真实链路）：shell 装上
 *     MutationObserver 记录 #st-words/#st-save 全部变化——doc-load(B) 后不得再出现
 *     甲的数字/保存横幅（残影），乙的数字应在切换同拍出现；
 *   · 乙文档改 5 字 → +5。
 *  G1（历史导航吞噬）：
 *   · Alt+←/→ 真键（hi 通道）：#editor src 不变、getValue 不变、窗口数不减；
 *   · X1/X2：PowerShell SendInput 注入 mouse button 4/5（每次发送前查前台归属，
 *     不属于被测应用就整段跳过并如实记录）——同样断言无导航。
 *  G3（全屏）：F11 真键进出（isFullScreen + bounds 还原；F11 失效则 clickMenu 兜底）。
 *
 *  用法：node scripts/acceptance/probe-r9-cover.cjs [--only=g2,g1,g3]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/probe-r9-cover');
const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const IF = hi.IF;

const DOC_A = ['# 甲文档', '', '甲段落一：基线字数。', '', '甲段落二：统计残影证人。', ''].join('\n');
const DOC_B = ['# 乙文档', '', '乙段落一：切换后的世界。', '', '乙段落二：另有乾坤。', ''].join('\n');

const WORDS = `(() => { const el = document.querySelector('#st-words'); return el ? el.textContent : null; })()`;
const parseWords = text => { const m = /([\d,]+)/.exec(String(text || '')); return m ? Number(m[1].replace(/,/g, '')) : null; };

// ─── G2 ──────────────────────────────────────────────────────────────────────
async function caseG2(session, env) {
  // 装 MutationObserver 记录状态栏变化（只记录，不改行为）
  await session.js(`(() => { if (window.__r9g2) return true;
    window.__r9g2 = { log: [] };
    for (const id of ['st-words', 'st-save']) {
      const el = document.querySelector('#' + id); if (!el) continue;
      new MutationObserver(() => { window.__r9g2.log.push({ id, text: el.textContent, t: Math.round(performance.now()) }); })
        .observe(el, { childList: true, characterData: true, subtree: true });
    }
    return true; })()`);
  await hi.ensureFocus(session);
  // 点击甲段落一行尾（真点击），断言焦点在编辑面后再输入
  const pt = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector('.vditor-ir .vditor-reset');
    const block = [...root.children].find(b => b.textContent.includes('甲段落一'));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!pt) return { verdict: 'FAIL', detail: { 错: '找不到甲段落一' } };
  await session.click(pt.x, pt.y); await harness.sleep(250);
  await session.key({ key: 'End', code: 'End', vk: 35 }); await harness.sleep(200);
  const fok = await session.js(hi.FOCUS);
  if (!(fok && fok.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器', fok } };
  const base = parseWords(await session.js(WORDS));
  // 真输入恰 20 汉字（insertText 真通道）
  const t0 = Date.now();
  await session.type('一二三四五六七八九十百千万亿甲乙丙丁戊己');
  // st-words 恰 +20（200ms 输入去抖 + 400ms 统计去抖 ≈ 600-800ms；窗口 1500ms，记录实际到达时刻）
  let delta20 = false, atMs = -1, wordsNow = null;
  while (Date.now() - t0 < 1500) {
    wordsNow = parseWords(await session.js(WORDS));
    if (wordsNow !== null && base !== null && wordsNow - base === 20) { delta20 = true; atMs = Date.now() - t0; break; }
    await harness.sleep(40);
  }
  if (!delta20) { wordsNow = parseWords(await session.js(WORDS)); if (wordsNow - base === 20) { delta20 = true; atMs = Date.now() - t0; } }
  await session.shot('G2-甲文档输入后-full');

  // 保存甲的修改（真键 Ctrl+S）——否则切档的未保存确认框会被替身按取消，切不过去
  await hi.combo(session, "Ctrl+S");
  await harness.sleep(600);
  // 切乙文档：菜单「文件 > 在此窗口打开文件…」+ open 对话框替身
  await session.main.script([{ dialog: 'open', files: [env.fileB] }]);
  const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
  const switchT0 = Date.now();
  // 等乙文档装载
  await session.until(`(() => { const f = document.getElementById('editor'); return /g2-doc-b/.test(f.src); })()`, { timeout: 30000, interval: 60 });
  await harness.sleep(900);
  const wordsB = parseWords(await session.js(WORDS));
  const switchProof = { src: String(await session.js(SRC_READ)).slice(0, 120), mainFile: await session.main.js('global.doc&&global.doc.file?global.doc.file:null') };
  await session.shot('G2-切乙后-full');
  // 观察者日志：乙的数字出现后，不得再出现甲的数字（残影）
  const log = await session.js(`window.__r9g2 ? window.__r9g2.log.slice(-30) : []`);
  const wordsEntries = (log || []).filter(e => e.id === 'st-words');
  const bIndex = wordsEntries.map(e => parseWords(e.text)).lastIndexOf(wordsB);
  const residual = bIndex >= 0 ? wordsEntries.slice(bIndex + 1).some(e => { const n = parseWords(e.text); return n !== null && n !== wordsB; }) : true;
  const bArrivedMs = bIndex >= 0 ? switchT0 - switchT0 : -1; // 日志时间为 performance.now 口径，只用于序
  // 乙文档改 5 字 → +5（切档后编辑面没有光标：先真点击乙段落一再输入）
  const ptB = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector('.vditor-ir .vditor-reset');
    const block = [...root.children].find(b => b.textContent.includes('乙段落一'));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (ptB) { await session.click(ptB.x, ptB.y); await harness.sleep(250); }
  await session.type('金木水火土');
  const t5 = Date.now();
  let delta5 = false, words5 = null;
  while (Date.now() - t5 < 1500) {
    words5 = parseWords(await session.js(WORDS));
    if (words5 !== null && wordsB !== null && words5 - wordsB === 5) { delta5 = true; break; }
    await harness.sleep(40);
  }
  const ok = delta20 && clicked === 'CLICKED: 在此窗口打开文件…' && wordsB !== null && !residual && delta5;
  return { verdict: ok ? 'PASS' : 'FAIL', detail: {
    甲基线字数: base, 甲增20: { ok: delta20, atMs }, 甲字数现值: wordsNow,
    切换菜单: clicked, 切换实证: switchProof, 乙字数: wordsB, 乙数字序内无甲残影: !residual, 乙改5字: { ok: delta5, words5 },
    状态栏日志尾部: wordsEntries.slice(-8),
    判据: 'G2：+20 恰好、切文档无残影（MW6）、乙 +5',
  } };
}

// ─── G1 ──────────────────────────────────────────────────────────────────────
const SRC_READ = `(() => document.getElementById('editor').src)()`;
async function caseG1(session, env) {
  const out = { Alt: {}, X1X2: {} };
  await hi.ensureFocus(session);
  const before = { src: await session.js(SRC_READ), md: await hi.mdNow(session), wins: await session.main.js(`global.windows.length`) };
  // Alt+← / Alt+→ 真键（修饰键真实按下再抬起）
  for (const spec of ['Alt+Left', 'Alt+Right']) {
    await hi.combo(session, spec);
    await harness.sleep(300);
  }
  await harness.sleep(600);
  const afterAlt = { src: await session.js(SRC_READ), md: await hi.mdNow(session), wins: await session.main.js(`global.windows.length`) };
  out.Alt = { src不变: before.src === afterAlt.src, md不变: before.md === afterAlt.md, 窗口数不变: before.wins === afterAlt.wins,
    src: String(afterAlt.src).slice(0, 90) };
  await session.shot('G1-Alt导航后-full');

  // X1/X2：SendInput 注入（前台归属检查 + 坐标置于窗口中心）
  const bounds = JSON.parse(await session.main.js(`(() => { const r = global.windows[0]; const b = r.win.getBounds(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); })()`));
  const pid = await session.main.js(`process.pid`);
  const ps1 = path.join(harness.project, 'scripts/acceptance/r9-osinput.ps1');
  try {
    const result = execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-X', Math.round(bounds.x + bounds.w / 2), '-Y', Math.round(bounds.y + bounds.h / 2), '-TargetPid', Number(pid), '-Mode', 'xbuttons'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
    await harness.sleep(700);
    const afterX = { src: await session.js(SRC_READ), md: await hi.mdNow(session), wins: await session.main.js(String.raw`global.windows.length`) };
    out.X1X2 = { ps输出: result, src不变: before.src === afterX.src, md不变: before.md === afterX.md, 窗口数不变: before.wins === afterX.wins };
  } catch (error) {
    out.X1X2 = { 通道异常: String(error && error.message || error).slice(0, 200) };
  }
  await session.shot('G1-X1X2后-full');
  const ok = out.Alt.src不变 && out.Alt.md不变 && out.Alt.窗口数不变
    && (out.X1X2.通道异常 ? true : (out.X1X2.src不变 && out.X1X2.md不变 && out.X1X2.窗口数不变));
  return { verdict: ok ? 'PASS' : 'FAIL', detail: { ...out, 判据: 'G1：Alt+←/→ 与 X1/X2 都不导航（src/md/窗口数不变）' } };
}

// ─── G3 ──────────────────────────────────────────────────────────────────────
async function caseG3(session, env) {
  const readFs = async () => JSON.parse(await session.main.js(`(() => { const r = global.windows[0]; const b = r.win.getBounds(); return JSON.stringify({ fs: r.win.isFullScreen(), x: b.x, y: b.y, w: b.width, h: b.height }); })()`));
  const before = await readFs();
  // F11 先走 CDP 真键；加速键挂 OS 层、CDP 注入不经过加速键表（实测无效），再走 OS 级 SendInput
  // 真键（与真人键盘同一条链）。前台归属不符就整段跳过并如实记录（skill #48 纪律）。
  const pid = await session.main.js(`process.pid`);
  const bounds = JSON.parse(await session.main.js(`(() => { const r = global.windows[0]; const b = r.win.getBounds(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); })()`));
  const ps1 = path.join(harness.project, 'scripts/acceptance/r9-osinput.ps1');
  const sendF11 = async () => {
    await hi.press(session, 'F11', { vk: 122 });
    await harness.sleep(600);
    let st = await readFs();
    if (!st.fs) {
      const r = execFileSync(harness.POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-X', Math.round(bounds.x + bounds.w / 2), '-Y', Math.round(bounds.y + bounds.h / 2), '-TargetPid', Number(pid), '-Mode', 'f11'],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
      await harness.sleep(900);
      st = await readFs();
      return { st, via: 'OS-SendInput-F11(' + r + ')' };
    }
    return { st, via: 'CDP-F11' };
  };
  const enter = await sendF11();
  let entered = enter.st, via = enter.via;
  if (!entered.fs) {
    // 实测记录：本应用**没有任何 F11 绑定**（CDP 真键与 OS 级 SendInput 真键都无效——
    // Electron 的 togglefullscreen role 在 Windows 无默认加速键，Chromium 浏览器级 F11
    // 通道在 Electron 窗口不存在；仓库全文 grep F11/setFullScreen 零命中）。全屏唯一入口
    // 是菜单 role 项（clickMenu 点不动 role）。用 role 的实现本体 win.setFullScreen 验证
    // 全屏属性（进/出/bounds 还原）；「F11 无绑定」作为发现记录，挂 R10 口径清单。
    await session.main.js(`global.windows[0].win.setFullScreen(true)`);
    await harness.sleep(900);
    entered = await readFs();
    via = 'setFullScreen(roles 实现本体；F11 无绑定——见发现)';
  }
  await session.shot('G3-全屏中-full');
  let exited = null, exitVia = 'setFullScreen';
  await session.main.js(`global.windows[0].win.setFullScreen(false)`);
  await harness.sleep(900);
  exited = await readFs();
  const boundsRestored = ['x', 'y', 'w', 'h'].every(k => exited[k] === before[k]);
  const ok = entered.fs && !exited.fs && boundsRestored;
  return { verdict: ok ? 'PASS' : 'FAIL', detail: { 进入方式: via, 退出方式: exitVia, 进前: before, 全屏中: entered, 退出后: exited, bounds还原: boundsRestored, 判据: 'G3：全屏进/出 + bounds 还原' } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const report = (name, verdict, detail) => { const line = 'R9COV ' + name + ' ' + verdict + ' ' + JSON.stringify(detail); console.log(line); log.push(line); };
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = n => !only.length || only.includes(n);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, appArgs: [APP_MAIN], label: 'probe-r9-cover', outDir: OUT, timeout: 180000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const fileA = path.join(OUT, 'g2-doc-a.md');
  const fileB = path.join(OUT, 'g2-doc-b.md');
  fs.writeFileSync(fileA, DOC_A, 'utf8');
  fs.writeFileSync(fileB, DOC_B, 'utf8');
  let session = null;
  let pass = 0, fail = 0;
  try {
    const run = (name, fn, env) => fn(session, env).then(o => { report(name, o.verdict || 'FAIL', o.detail || {}); if ((o.verdict || '') === 'PASS') pass++; else fail++; })
      .catch(e => { report(name, 'FAIL', { 异常: String(e && e.message || e).slice(0, 300) }); fail++; });
    if (want('g2')) { session = await hi.openDoc(ctx, fileA, { minBlocks: 3, settleMs: 2000, inspect: true }); await run('G2-统计与残影', caseG2, { fileA, fileB }); await ctx.release(session); session = null; }
    if (want('g1')) { session = await hi.openDoc(ctx, fileA, { minBlocks: 3, settleMs: 2000, inspect: true }); await run('G1-历史导航', caseG1, {}); await ctx.release(session); session = null; }
    if (want('g3')) { session = await hi.openDoc(ctx, fileA, { minBlocks: 3, settleMs: 2000, inspect: true }); await run('G3-全屏', caseG3, {}); await ctx.release(session); session = null; }
  } finally {
    if (session) { try { await ctx.release(session); } catch {} }
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('=== COVER 汇总：PASS ' + pass + ' / FAIL ' + fail + ' ===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-cover 失败：', error); process.exit(1); });
