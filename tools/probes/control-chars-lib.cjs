/** family=control-chars · 探针共用库（错-4：同一件事只许有一份实现）
 *
 *  为什么要这一个文件：本族的判据是**磁盘字节**（BOM / CRLF / CR / NUL / ESC / BEL），
 *  与"渲染侧读数"分属两把尺子；两把尺子都只在这里实现一次，探针之间 require 同一份。
 *
 *  复用链（错-14：先找已有且已验证的通道，不自搓第二支）：
 *   · 启动范式 / 找页 / 收尾 → `file-ops-real-lib.cjs`
 *     （spawn(夹具 + --remote-debugging-port=随机 + --user-data-dir=独立) + MP_DEBUG=1
 *      + delete ELECTRON_RUN_AS_NODE + playwright-core connectOverCDP；findPage 会**断言**
 *        docInfo().filePath 命中本次夹具 ⇒ 拿到的不是默认回退值）
 *   · 尺子卡 / 产物 sha 断言 → `_probe-common.cjs`
 *   · 系统剪贴板 → 沿用 `undo-redo-chain-paste2.cjs` 的 base64↔独立 pwsh 进程通道
 *     （不走控制台代码页、不走 stdout 原样字符串 ⇒ 无 CP936 与行尾伪影）；
 *     并按错-13 补齐四步：装弹 → 独立进程回读 → 按键 → 再回读。
 */
'use strict';
/* ── 自适应头（公开快照专用，自动注入 ✓）──────────────────────────────────
   开发态：本文件在 <repo>/.mp-verify/checklist/；公开快照：<repo>/tools/probes/ ✓
   ⇒ 两种情况下"上溯两级"都是仓库根 ✓，工作目录若不存在就建在**系统临时目录**里 ✓
   （这样别人 clone 下来能直接跑，不会写进仓库 ✗）。可用 MP_WORK / MP_EXE 覆盖 ✓。 */
const __MP_OS = require('node:os');
const __MP_REPO = path.resolve(__dirname, '..', '..');
const __MP_WORK = process.env.MP_WORK || path.join(__MP_OS.tmpdir(), 'markpilot-verify');
const __MP_EXE = process.env.MP_EXE || path.join(__MP_REPO, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
try { require('node:fs').mkdirSync(__MP_WORK, { recursive: true }); } catch { /* 建不了就由调用方报错 */ }
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const F = require(path.join(__dirname, 'file-ops-real-lib.cjs'));
const RULER = require(path.join(__dirname, '_probe-common.cjs'));

const ROOT = path.join(__MP_WORK, 'control-chars');
const EXE = F.EXE_DEFAULT;
const sleep = F.sleep;
const T = F.T;
const statOf = F.statOf;
const shellLog = F.shellLog;

/** 尺子卡 + 产物 sha16 断言（期望值 MP_EXPECT_EXE，不设则不拦） */
function ruler(probe, exe) { return F.ruler(probe, exe || EXE); }
function sha16(p) { return RULER.sha16(p); }

/* ══ 尺子 A：磁盘字节（本族主判据）═══════════════════════════════════════════
 *  逐字节数行尾与控制字符。不靠正则数"看起来像"的片段：
 *  CRLF 计成一对（i 跳过 0x0A），lone CR / lone LF 分开数 —— CR-only 老文件与混合行尾才分辨得开。 */
function bytesInfo(p) {
  let b = null;
  try { b = fs.readFileSync(p); } catch (e) { return { err: String((e && e.message) || e).slice(0, 90) }; }
  let crlf = 0, lfOnly = 0, crOnly = 0, nul = 0, esc = 0, bel = 0, otherCtrl = 0;
  const nulOffsets = [];
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (x === 0x0d) { if (b[i + 1] === 0x0a) { crlf++; i++; } else crOnly++; }
    else if (x === 0x0a) lfOnly++;
    else if (x === 0x00) { nul++; if (nulOffsets.length < 8) nulOffsets.push(i); }
    else if (x === 0x1b) esc++;
    else if (x === 0x07) bel++;
    else if (x < 0x09 || (x > 0x0d && x < 0x20)) otherCtrl++;
  }
  return {
    size: b.length, sha16: sha16(p),
    headHex: b.subarray(0, 12).toString('hex'),
    bom: b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf,
    crlf, lfOnly, crOnly, nul, esc, bel, otherCtrl, nulOffsets,
    tailHex: b.subarray(Math.max(0, b.length - 12)).toString('hex'),
  };
}
/** 夹具按**精确字节**写（BOM / CR / 混合行尾都靠它，绝不经过字符串归一化） */
function writeBytes(p, buf) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return bytesInfo(p); }
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = (s) => Buffer.from(s, 'utf8');

/** 等磁盘字节变化（mtime 或 sha 变）。返回 {changed, ms, mtimeMs, sha16} */
async function waitDisk(p, prev, ms = 3500) {
  const t0 = Date.now();
  const prevSha = prev && prev.sha16;
  while (Date.now() - t0 < ms) {
    const s = statOf(p);
    if (s && (s.mtimeMs !== (prev && prev.mtimeMs) || (prevSha && sha16(p) !== prevSha))) {
      return { changed: true, ms: Date.now() - t0, mtimeMs: s.mtimeMs, sha16: sha16(p), info: bytesInfo(p) };
    }
    await sleep(50);
  }
  const s = statOf(p);
  return { changed: false, ms, mtimeMs: s ? s.mtimeMs : null, sha16: sha16(p), info: bytesInfo(p) };
}

/** 磁盘观察窗：定时采 mtime/sha/size。**必须给 baseline**（＝窗口开始前的状态）。
 *
 *  【为什么】本轮踩过：窗口内"自己跟自己比"⇒ 落盘发生在**第一个采样点之前**时，
 *  首帧就已经是新状态 ⇒ 变化次数记成 0，而 mtime 明明变了（P5 的 段3/段4 就是这样漏数的，
 *  壳层 `file:save` 时间戳反而把它抓了出来）。所以：与 baseline 比 + 与上一采样比，两者取或。
 *  原始采样全量保留，便于事后核对。 */
async function watchDisk(p, ms, { step = 400, baseline = null } = {}) {
  const t0 = Date.now();
  const samples = [];
  let changes = 0, firstChangeMs = null;
  let last = baseline ? { mtimeMs: baseline.mtimeMs, sha16: baseline.sha16, size: baseline.size } : null;
  while (Date.now() - t0 < ms) {
    const st = statOf(p) || {};
    const s = { mtimeMs: st.mtimeMs, size: st.size, sha16: sha16(p) };
    samples.push({ t: Date.now() - t0, mtimeMs: Math.round(s.mtimeMs || 0), size: s.size, sha16: s.sha16 });
    if (last && (last.mtimeMs !== s.mtimeMs || last.sha16 !== s.sha16)) { changes++; if (firstChangeMs === null) firstChangeMs = Date.now() - t0; }
    last = s;
    await sleep(step);
  }
  return { 变化次数: changes, 首次变化ms: firstChangeMs, 末次: last || samples[samples.length - 1], 采样: samples };
}
const nowDisk = (p) => { const st = statOf(p) || {}; return { mtimeMs: st.mtimeMs, size: st.size, sha16: sha16(p) }; };

/* ══ 尺子 B：渲染侧一次拿全（错-7①：一组相关读数不许跨 evaluate 拼装）══════════
 *  控制字符按 **UTF-16 码元**计数（NUL/ESC/BEL/U+FEFF 都在这一张表里），
 *  行类读**引擎已经渲染到行上的类**（错-15：不自己推断上下文）。 */
async function snapCC(page) {
  return await T(page.evaluate(async () => {
    const out = { engine: !!(window.mpEngine && window.mpHost) };
    let v = null;
    try { v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null; } catch { }
    const doc = v ? v.state.doc : null;
    const text = doc ? doc.toString() : null;
    out.docLen = text === null ? null : text.length;
    out.docLines = doc ? doc.lines : null;
    out.docText = text;
    const cc = {};
    for (let i = 0; i < (text || '').length; i++) {
      const c = text.charCodeAt(i);
      if (c < 32 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0xfeff) cc[c] = (cc[c] || 0) + 1;
    }
    out.ctrlCounts = cc;
    out.head16 = text === null ? null : Array.from(text.slice(0, 16)).map((c) => c.charCodeAt(0));
    out.tail16 = text === null ? null : Array.from(text.slice(-16)).map((c) => c.charCodeAt(0));
    out.sel = v ? { a: v.state.selection.main.anchor, h: v.state.selection.main.head } : null;
    out.viewFocus = v ? !!v.hasFocus : null;
    out.frameFocus = document.hasFocus();
    out.activeEl = document.activeElement ? (document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).slice(0, 40) : '')) : null;
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    out.renderedLines = lines.length;
    out.lineClasses = lines.slice(0, 8).map((e) => e.className);
    out.lineCodes = lines.slice(0, 8).map((e) => Array.from(String(e.textContent || '').slice(0, 24)).map((c) => c.charCodeAt(0)));
    const al = document.querySelector('.cm-line.cm-activeLine');
    out.activeLineClass = al ? al.className : null;
    const b = document.getElementById('mp-banner');
    out.banner = b ? { display: b.style.display, shown: b.style.display !== 'none', text: String(b.textContent || '').slice(0, 160), buttons: Array.from(b.querySelectorAll('button')).map((x) => x.textContent) } : null;
    out.bodyText = String(document.body.innerText || '').slice(0, 260);
    out.title = document.title;
    /* paste 见证器：按键那一刻浏览器交给编辑器的剪贴板内容（与文档状态同一次 evaluate 取全） */
    out.pasteWitness = (window.__ccPaste || []).slice(-2);
    let info = null;
    try { info = await window.mpHost.docInfo(); } catch (e) { info = { err: String((e && e.message) || e).slice(0, 60) }; }
    out.host = info;
    return out;
  }), 9000, 'snapCC');
}

/** 真实鼠标点进正文某一行 + End（打字前"人先点一下"；file-ops-real-lib 的同一实现） */
const clickBody = F.clickBody;

/* ══ 尺子 C：系统剪贴板（错-13 四步）═════════════════════════════════════════
 *  写：独立 pwsh 进程 Set-Clipboard，载荷经 base64 过命令行（不落文件、不碰代码页）。
 *  读：独立 pwsh 进程 Get-Clipboard -Raw → base64 → stdout（单行 ASCII，无行尾伪影）。 */
function psRun(script, timeout = 15000) {
  return String(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true }));
}
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
function clipLoad(payload) {
  try {
    const r = psRun('$ProgressPreference="SilentlyContinue"\nSet-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64(payload) + '\')))\n"SET-OK"', 20000);
    return { ok: /SET-OK/.test(r), raw: r.replace(/\s+/g, ' ').slice(0, 60) };
  } catch (e) { return { ok: false, raw: 'ERR ' + String((e && e.stderr) || (e && e.message) || e).replace(/\s+/g, ' ').slice(0, 120) }; }
}
function clipRead() {
  try {
    const r = psRun('$ProgressPreference="SilentlyContinue"\n$t = Get-Clipboard -Raw\nif ($null -eq $t) { $t = "" }\n[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t))', 20000);
    const line = r.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
    return { ok: true, text: Buffer.from(line, 'base64').toString('utf8') };
  } catch (e) { return { ok: false, text: null, err: String((e && e.stderr) || (e && e.message) || e).replace(/\s+/g, ' ').slice(0, 120) }; }
}
const codes = (s, n = 48) => Array.from(String(s == null ? '' : s)).slice(0, n).map((c) => c.charCodeAt(0));
/** 归一化比对口径：只抹平行尾（CRLF/尾换行），控制字符一个都不许抹 */
const normEol = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
/** 装弹 + 独立进程回读（四步的①②），**带抢占重试**。
 *
 *  为什么必须带重试：本机多族并行，"装弹 → 回读"之间约 1 秒的窗口里别的腿会写走这块共享剪贴板
 *  （错-13：实测 6 秒 24 次采样出现 7 个不同值）。自证体检首轮就撞上：ascii 载荷回读成 `R1`。
 *  判据：回读逐字符等于**本次载荷**（NUL 载荷按 CF_UNICODETEXT 的截断口径给 expect）才算装弹成功；
 *  否则记一次 attempt 并重装重读，attempts 全量落盘 ⇒ 报告里能看出"被抢占了几次"。
 *  @param payload 要写进剪贴板的载荷
 *  @param expect  期望的回读值（默认＝payload；内嵌 NUL 时必须显式给截断后的前缀） */
async function clipArm(payload, { expect = null, tries = 4 } = {}) {
  const want = expect === null ? payload : expect;
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    const w = clipLoad(payload);
    const back = clipRead();
    const ok = !!back.ok && normEol(back.text) === normEol(want);
    attempts.push({ i, armed: w.ok, writeRaw: w.raw, readOk: back.ok, readErr: back.err || null, back: back.text, match: ok, backCodes: codes(back.text) });
    if (ok) return { ok: true, tries: i + 1, attempts, back: back.text, backCodes: codes(back.text), expectCodes: codes(want), armed: w.ok };
    if (i < tries - 1) await sleep(350);
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, tries, attempts, back: last.back, backCodes: last.backCodes, expectCodes: codes(want), armed: last.armed };
}
/** 四步的④：按键之后再回读一次，证明这一次 Ctrl+V 拿到的确实是本载荷（没被抢占） */
function clipRecheck(expect) {
  const back = clipRead();
  return { readOk: back.ok, readErr: back.err || null, back: back.text, stillMine: !!back.ok && normEol(back.text) === normEol(expect), backCodes: codes(back.text) };
}
/** 四步的③：真实 Ctrl+V（按前先断言焦点在编辑面内），并**装好 paste 事件见证器**。
 *
 *  为什么要见证器：本机多族并行时，按键**之后**再起的独立回读进程（第④步）几乎必被别的腿抢占
 *  （实测回读到 `MP-WC-SENT-70576-1-chzz`、`xy`、`V1\\nV2…`）。paste 事件里的 clipboardData
 *  就是**浏览器在按键那一刻交给编辑器的内容**——同一时刻、零竞态，且是本仓既有探针用过的通道
 *  （code-fence 族：注入后回读校验 + paste 事件载荷即按键那一刻真实内容）。第④步照旧做、照旧记账。 */
async function installPasteWitness(page) {
  return await page.evaluate(() => {
    if (window.__ccPasteHook) return 'already';
    window.__ccPasteHook = true;
    window.__ccPaste = [];
    document.addEventListener('paste', (e) => {
      let t = null;
      try { t = e.clipboardData ? e.clipboardData.getData('text/plain') : null; } catch { }
      window.__ccPaste.push({ plain: t, len: t === null ? null : t.length, codes: t === null ? null : Array.from(t).slice(0, 120).map((c) => c.charCodeAt(0)), ts: Date.now() });
    }, true);
    return 'installed';
  });
}
async function realPaste(page) {
  const s = await snapCC(page);
  if (!(s.viewFocus && s.frameFocus && String(s.activeEl || '').startsWith('DIV.cm-'))) {
    return { pressed: false, why: '焦点不在编辑面内', viewFocus: s.viewFocus, frameFocus: s.frameFocus, activeEl: s.activeEl };
  }
  await installPasteWitness(page);
  await page.keyboard.press('Control+v');
  await sleep(180);
  return { pressed: true, focusAtPress: { viewFocus: s.viewFocus, frameFocus: s.frameFocus, activeEl: s.activeEl } };
}

/* ══ 其它小工具 ═════════════════════════════════════════════════════════════ */
/** CDP 端口：每次不同（固定端口若被残留实例占着会连到别人窗口），并先确认真的空闲 */
function pickPort(base = 15100) {
  let out = '';
  try { out = String(execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 20000, windowsHide: true })); } catch { }
  const used = new Set();
  for (const m of out.matchAll(/:(\d+)\s/g)) used.add(Number(m[1]));
  for (let i = 0; i < 400; i++) {
    const p = base + ((process.pid + i * 7) % 700);
    if (!used.has(p)) return p;
  }
  return base + 1;
}
function jsonDump(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8'); console.log('[落盘] ' + p); }
/** 进程存活（主进程事实，不是渲染侧超时反推） */
function alive(pid) { return F.alive(pid); }
function tasklistMarkpilot() {
  try { return String(execFileSync('tasklist', ['/FI', 'IMAGENAME eq MarkPilot.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })).trim().split(/\r?\n/).filter((l) => /MarkPilot/i.test(l)).length; }
  catch { return -1; }
}
/** 收集 pageerror / crash（判断"崩溃"那一栏） */
function wireErrors(page, bag) {
  try { page.on('pageerror', (e) => bag.push('pageerror: ' + String((e && e.message) || e).slice(0, 220))); } catch { }
  try { page.on('crash', () => bag.push('PAGE_CRASH')); } catch { }
}

module.exports = {
  ROOT, EXE, F, RULER, sleep, T, statOf, shellLog, ruler, sha16,
  bytesInfo, writeBytes, BOM, utf8, waitDisk, watchDisk, nowDisk, snapCC, clickBody,
  psRun, clipLoad, clipRead, clipArm, clipRecheck, realPaste, installPasteWitness, codes, normEol,
  pickPort, jsonDump, alive, tasklistMarkpilot, wireErrors,
};
