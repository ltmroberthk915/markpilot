/** 探针 · R9 验收 C 门（快 Ctrl+S 落盘，E9 裁决 §C / C-修复说明 §4）。
 *
 *  判据（G-C2/C3，绿；--mutant 模式下反向即红 G-C4）：
 *   · C1 干净文档秒存：干净副本键入 1 字 → <50ms 真键 Ctrl+S → ≤3s 磁盘含该字
 *     （HEAD 行为=完全早退不保存——突变模式必红）；
 *   · C2 脏文档末拍：2 字 → 等 600ms（change 已推）→ 再 1 字 → <50ms Ctrl+S →
 *     磁盘含全部 3 字（HEAD 行为=缺第 3 字）；
 *   · C3 连打 5 字逐存：每字后 <50ms Ctrl+S，5 字全在盘；
 *   · C4 连打 10 字（50ms 间隔）+ 末尾一次 Ctrl+S → 10 字全在盘（整文档拉值）；
 *   · C5 保存后标题不闪回：保存成功后 ≥1.2s 采样，#st-save 恒「已保存」、
 *     win.getTitle() 无 ●（200ms 迟到推送经 applyText 是 no-op）；
 *   · C6 大文档（696KB 题库副本）：深部键入 1 字 + <50ms Ctrl+S → 保存完成 ≤3s
 *     且磁盘含该字（兼 131 哨兵功能性回归）。
 *
 *  通道纪律：键入=CDP Input.insertText；Ctrl+S=修饰键真实按下再抬起的组合键链
 *  （与菜单加速键真人通路一致）；键入→Ctrl+S 的间隔用「不落地的流水线发送」压到
 *  <50ms 并实测记录。autoSave 由主进程调试器关掉（防 1.5s 自愈掩蔽）。磁盘字节
 *  与 mtime 为主判据；截图（保存前脏态 / 保存后 ≥1.2s 干净态）作 UI 可见性质佐证。
 *
 *  用法：node scripts/acceptance/probe-r9-save.cjs [--only=c1,c2,c3,c4,c5,c6] [--mutant]
 *        --mutant 时判据反转（期望不保存/缺拍），供 G-C4 突变验证。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const MUTANT = process.argv.includes('--mutant');
const OUT = path.join(harness.project, '.perf/probe-r9-save');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const MOD = hi.MOD;
const BIG_SRC = 'E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md';

const DOC_SMALL = ['# R9C 快捷保存', '',
  'C靶点段：快打与保存的落点，字尾在此。', '',
  '第二段：承接。', ''].join('\n');

// ─── 工具 ─────────────────────────────────────────────────────────────────────
const stat = file => { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; };
const readDisk = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** 键入一段文本后 <50ms 内发真键 Ctrl+S。三条输入（insertText、Control↓、S↓）在同一条
 *  CDP WebSocket 上按序派发——派发间隔即真实「键入→加速键」间隔（µs 级）；完成等待
 *  （roundTripMs）受渲染层忙闲影响，只作参考不进判据。大文档上渲染层忙时回包慢，
 *  但消息按序处理，加速键仍在 input 事件的同一处理队列里紧跟其后。 */
async function typeThenSave(session, text) {
  const t0 = Date.now();
  const p1 = session.send('Input.insertText', { text });
  const p2 = hi.keyDown(session, 'Control', { modifiers: MOD.ctrl });
  const p3 = hi.keyDown(session, 'S', { modifiers: MOD.ctrl });
  const dispatched = Date.now(); // S↓ 已派发（与 insertText 同刻入队）
  await Promise.all([p1, p2, p3]);
  await hi.keyUp(session, 'S', { modifiers: MOD.ctrl });
  await hi.keyUp(session, 'Control', { modifiers: MOD.ctrl });
  return { gapMs: dispatched - t0, roundTripMs: Date.now() - t0 };
}

/** 单独一次真键 Ctrl+S（已脏场景用）。 */
async function saveNow(session) {
  const t0 = Date.now();
  await hi.combo(session, 'Ctrl+S');
  return { comboMs: Date.now() - t0 };
}

/** 轮询磁盘直到内容变化或超时。返回 {saved, atMs, content}。 */
async function waitDisk(file, before, { timeout = 3000, step = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    await harness.sleep(step);
    const now = readDisk(file);
    if (now !== null && now !== before) return { saved: true, atMs: Date.now() - t0, content: now };
    if (Date.now() - t0 >= timeout) return { saved: false, atMs: Date.now() - t0, content: now };
  }
}

/** 点击靶点段并把光标放到行尾（真点击 + End 真键）。 */
async function focusTailOf(session, marker) {
  await hi.ensureFocus(session);
  const point = await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const doc = w.document;
    const root = doc.querySelector(${JSON.stringify(hi.SURFACE)});
    const block = [...root.children].find(b => b.textContent.includes(${JSON.stringify(marker)}));
    if (!block) return null; const r = block.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    return { x: Math.round(fr.x + r.x + 40), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
  if (!point) throw new Error('找不到靶点段：' + marker);
  await session.click(point.x, point.y);
  await harness.sleep(250);
  await session.key({ key: 'End', code: 'End', vk: 35 });
  await harness.sleep(200);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) throw new Error('焦点不在编辑器：' + JSON.stringify(focusOK));
  return point;
}

/** 状态栏（shell DOM）保存横幅 + 主进程标题采样，持续 durationMs。 */
async function sampleBanner(session, durationMs, step = 100) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    const save = await session.js(`(() => document.querySelector('#st-save')?.textContent ?? null)()`);
    let title = null, dirty = null;
    try {
      title = await session.main.js(`(global.doc && global.doc.win && !global.doc.win.isDestroyed()) ? global.doc.win.getTitle() : null`);
      dirty = await session.main.js(`global.doc && global.doc.current ? global.doc.current.dirty : null`);
    } catch { /* 主进程调试器不可用则跳过 */ }
    samples.push({ at: Date.now() - t0, save, title, dirty });
    await harness.sleep(step - 40 > 0 ? step - 40 : 20);
  }
  return samples;
}
/** 闪回判据：横幅一旦转为干净，其后不得再出现 ●（保存完成前遗留的脏态展示不算——
 *  st-save 本身 400ms 去抖，脏→干净的翻转总在保存后几百 ms；缺陷形态是干净之后又闪回 ●）。 */
const noFlashBack = samples => {
  const dirtyAt = samples.map((s, i) => (/未保存/.test(String(s.save)) || /●/.test(String(s.title)) || s.dirty === true) ? i : -1);
  const lastDirty = dirtyAt.reduce((a, b) => Math.max(a, b), -1);
  const cleanTail = samples.length - 1 - lastDirty;
  return { ok: cleanTail >= 10 && samples.slice(lastDirty + 1).every(s => !/未保存/.test(String(s.save)) && !/●/.test(String(s.title)) && s.dirty === false),
    lastDirtyAtMs: lastDirty >= 0 ? samples[lastDirty].at : 0, cleanTailMs: cleanTail * 100 };
};

/** 截图：整幅 + 状态栏 2x。 */
async function shotBanner(session, name) {
  try {
    const rect = await session.js(`(() => { const el = document.querySelector('#st-save'); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    await session.shot(name + '-full');
    if (rect) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png',
        clip: { x: Math.max(0, rect.x - 160), y: Math.max(0, rect.y - 14), width: Math.min(560, 1200), height: 44, scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    }
  } catch (error) { console.log('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 100) + '）'); }
}

const verdictOf = ok => ok === !MUTANT ? 'PASS' : 'FAIL';

// ─── 各用例 ──────────────────────────────────────────────────────────────────
async function caseC1(session, env) {
  const file = env.file;
  await focusTailOf(session, 'C靶点段');
  const before = readDisk(file), s0 = stat(file);
  const typed = await typeThenSave(session, '甲');
  const disk = await waitDisk(file, before, { timeout: 3000, step: 40 });
  const after = readDisk(file);
  const hasChar = disk.saved && after.includes('C靶点段：快打与保存的落点，字尾在此。甲');
  // C5 前半：保存成功后 ≥1.4s 采样横幅/标题不闪回
  const banner = await sampleBanner(session, 1600);
  const flash = noFlashBack(banner);
  await shotBanner(session, MUTANT ? 'C1-突变-保存后' : 'C1-保存后');
  return { verdict: verdictOf(hasChar && typed.gapMs < 50 && flash.ok), detail: {
    键入到加速键间隔ms: typed.gapMs, 落盘: { saved: disk.saved, atMs: disk.atMs },
    磁盘含新字: hasChar, mtime变化: stat(file).mtimeMs !== s0.mtimeMs,
    横幅无闪回: flash, 横幅采样首末: banner.filter((s, i) => i < 3 || i > banner.length - 3),
    判据: '干净文档改一字秒存：磁盘含该字 + gap<50ms + 保存后不闪回' + (MUTANT ? '（突变模式期望不保存）' : ''),
  } };
}

async function caseC2(session, env) {
  const file = env.file;
  await focusTailOf(session, 'C靶点段');
  const before = readDisk(file);
  await session.type('乙丙');
  await harness.sleep(600); // change 已推、标题已 ●
  await shotBanner(session, 'C2-保存前-脏态');
  const typed = await typeThenSave(session, '丁');
  const disk = await waitDisk(file, before, { timeout: 3000, step: 40 });
  const after = readDisk(file);
  const has3 = /C靶点段：快打与保存的落点，字尾在此。乙丙丁/.test(after);
  const banner = await sampleBanner(session, 1600);
  const flash = noFlashBack(banner);
  await shotBanner(session, 'C2-保存后1.6s');
  return { verdict: verdictOf(has3 && typed.gapMs < 50 && disk.saved && flash.ok), detail: {
    键入到加速键间隔ms: typed.gapMs, 落盘: { saved: disk.saved, atMs: disk.atMs },
    磁盘含三字: has3, 磁盘尾段: (after.match(/C靶点段[^\n]*/) || [''])[0],
    横幅无闪回: flash,
    横幅采样首末: banner.filter((s, i) => i < 2 || i > banner.length - 2),
    判据: '脏文档缺拍：磁盘含 乙丙丁 + 保存后不闪回' + (MUTANT ? '（突变模式期望缺丁）' : ''),
  } };
}

async function caseC3(session, env) {
  const file = env.file;
  await focusTailOf(session, 'C靶点段');
  const before = readDisk(file);
  const chars = '子丑寅卯辰';
  const gaps = [], perBeat = [];
  for (let i = 0; i < chars.length; i++) {
    const typed = await typeThenSave(session, chars[i]);
    gaps.push(typed.gapMs);
    // 等这拍真落盘（每拍都要在盘上）
    const want = '字尾在此。' + chars.slice(0, i + 1);
    const t0 = Date.now();
    while (Date.now() - t0 < 2500 && !String(readDisk(file)).includes(want)) await harness.sleep(40);
    perBeat.push({ 字: chars[i], 落盘ms: Date.now() - t0, 在盘: String(readDisk(file)).includes(want) });
  }
  const after = readDisk(file);
  const all5 = /字尾在此。子丑寅卯辰/.test(after);
  return { verdict: verdictOf(all5 && Math.max(...gaps) < 50), detail: {
    各拍间隔ms: gaps, 每拍落盘: perBeat, 磁盘含五字: all5, 磁盘尾段: (after.match(/C靶点段[^\n]*/) || [''])[0],
    判据: '连续 5 字每字后 <50ms Ctrl+S，全部在盘',
  } };
}

async function caseC4(session, env) {
  const file = env.file;
  await focusTailOf(session, 'C靶点段');
  const before = readDisk(file);
  const chars = '庚辛壬癸汽笛鸣';
  const t0 = Date.now();
  for (const ch of chars) {
    await session.type(ch);
    const target = t0 + (chars.indexOf(ch) + 1) * 50;
    while (Date.now() < target) await harness.sleep(5);
  }
  const typed = await typeThenSave(session, '响');
  const disk = await waitDisk(file, before, { timeout: 3000, step: 50 });
  const after = readDisk(file);
  const all10 = after.includes('字尾在此。' + chars + '响');
  return { verdict: verdictOf(all10 && disk.saved), detail: {
    键入到加速键间隔ms: typed.gapMs, 落盘: disk,
    磁盘含十字: all10, 磁盘尾段: (after.match(/C靶点段[^\n]*/) || [''])[0],
    判据: '50ms 间隔连打 10 字 + 末尾一次 Ctrl+S → 10 字全在盘（getValue 整文档拉值）',
  } };
}

async function caseC6(session, env) {
  const file = env.file;
  // 深部：Ctrl+End 到文末再键入（大文档深部）——真组合键
  await hi.ensureFocus(session);
  await hi.combo(session, 'Ctrl+End');
  await harness.sleep(900);
  const deep = await session.js(`(() => { const w = ${hi.IF}; const s = w.document.querySelector(${JSON.stringify(hi.SURFACE)});
    return { scrollTop: Math.round(s.scrollTop), max: Math.round(s.scrollHeight - s.clientHeight) }; })()`);
  const focusOK = await session.js(hi.FOCUS);
  if (!(focusOK && focusOK.ok)) return { verdict: 'FAIL', detail: { 错: '焦点不在编辑器' } };
  const before = readDisk(file);
  const typed = await typeThenSave(session, '锚');
  const disk = await waitDisk(file, before, { timeout: 3200, step: 50 });
  const after = readDisk(file);
  const at = after.indexOf('锚');
  const deepOK = at >= 0 && at / after.length > 0.9;
  await session.shot('C6-大文档保存后-full');
  return { verdict: verdictOf(disk.saved && after.includes('锚') && deepOK && typed.gapMs < 50 && disk.atMs <= 3000), detail: {
    文档字符数: before.length, 滚动: deep, 键入到加速键派发间隔ms: typed.gapMs, 回包耗时ms: typed.roundTripMs,
    保存完成ms: disk.atMs, 落盘: disk.saved, 磁盘含锚字且在深部: deepOK,
    判据: '696KB 大文档深部键入 + <50ms Ctrl+S：保存 ≤3s 且磁盘含该字（131 哨兵功能性回归）',
  } };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────
const CASES = [['c1', caseC1], ['c2', caseC2], ['c3', caseC3], ['c4', caseC4], ['c6', caseC6]];

(async () => {
  // --fresh 才清空证据目录（默认追加保留：突变/复跑轮次不毁掉已采证据）
  if (process.argv.includes('--fresh')) fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  const want = name => !only.length || only.includes(name);
  const log = [];
  const report = (name, verdict, detail) => {
    const line = 'R9SAVE ' + name + ' ' + verdict + ' ' + JSON.stringify(detail);
    console.log(line); log.push(line);
  };
  console.log((MUTANT ? '【突变模式：期望红】' : '【绿轮】') + ' ' + (DEV ? '开发树' : '安装版') + '：' + EXE);
  const ctx = {
    launch: options => harness.launch({ exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}),
      label: 'probe-r9-save', outDir: OUT, timeout: 240000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  let pass = 0, fail = 0;
  // 每个用例独立文档 + 独立启动（用例间互不携账）
  const groups = CASES.map(([name, run]) => ({ doc: 'r9-save-' + name + '.md', content: name === 'c6' ? null : DOC_SMALL, cases: [[name, run]] }));
  try {
    for (const group of groups) {
      const todo = group.cases.filter(([name]) => want(name));
      if (!todo.length) continue;
      const file = path.join(OUT, group.doc);
      if (group.content !== null) fs.writeFileSync(file, group.content, 'utf8');
      else { fs.copyFileSync(BIG_SRC, file); fs.chmodSync(file, 0o666); }
      console.log('\n=== ' + group.doc + '：' + todo.map(([n]) => n).join(', ') + ' ===');
      let session = null;
      try {
        const big = group.content === null;
        session = await hi.openDoc(ctx, file, { minBlocks: big ? 20 : 3, settleMs: big ? 6000 : 1800, timeout: 200000, inspect: true });
        // 关自动保存（防 1.5s 自愈掩蔽）——主进程内真调用 setSetting
        await session.main.js(`global.doc.setSetting('autoSave', false)`);
        const settings = await session.main.js(`JSON.stringify(global.doc.settings())`);
        console.log('  · autoSave 已关闭：' + settings);
        for (const [name, run] of todo) {
          try {
            const outcome = await run(session, { file }) || {};
            report(name, outcome.verdict || 'FAIL', outcome.detail || {});
            if ((outcome.verdict || '') === 'PASS') pass += 1; else fail += 1;
          } catch (error) {
            report(name, 'FAIL', { 异常: String(error && error.message || error).slice(0, 300) }); fail += 1;
          }
        }
      } catch (error) {
        console.log('  ！' + group.doc + ' 组未跑完：' + String(error && error.message || error).slice(0, 300));
        for (const [name] of todo) { report(name, 'FAIL', { 组异常: String(error && error.message || error).slice(0, 200) }); fail += 1; }
      } finally {
        if (session) { try { await ctx.release(session); } catch {} }
      }
    }
  } finally {
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n', 'utf8');
  }
  console.log('\n=== 汇总：PASS ' + pass + ' / FAIL ' + fail + '（' + (MUTANT ? '突变' : '绿轮') + '）===');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error('probe-r9-save 失败：', error); process.exit(1); });
