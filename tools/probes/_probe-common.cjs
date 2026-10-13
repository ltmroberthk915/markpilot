/** 探针共用尺子卡（AGENTS 错-1 / 错-4 的机械落地）
 *
 *  为什么有这个小文件：
 *   · 错-1：探针必须**断言**自己在量哪份产物，而不是"记录一下"——本轮出现过"拿旧包量出新读数"。
 *   · 错-4：同一件事（按键序列、sha 计算、断言口径）不许有第二份实现。
 *
 *  用法（三行接入任何探针）：
 *    const R = require('./_probe-common.cjs');
 *    R.rulerCard({ probe: 'probe-xxx', exe: EXE, doc: DOC });        // 打印尺子卡（含 sha16）
 *    R.assertExe(EXE);                                               // 期望值来自 MP_EXPECT_EXE
 *    R.assertDoc(DOC);                                               // 期望值来自 MP_EXPECT_DOC
 *
 *  期望值从环境变量来（`MP_EXPECT_EXE=ee13fa05013171e3` / `MP_EXPECT_DOC=c53e9dafa37ddc1b`），
 *  这样"锁定产物跑验收"是一句命令行的事；不设期望值时不拦（只打印读数），方便探索阶段。
 *  不匹配 ⇒ 打印 ✗ 并 **exit(9)**：宁可不出数，也不出"对不上号的数"。
 */
'use strict';
const path = require('node:path');
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
const crypto = require('node:crypto');

/** 文件 sha256 前 16 位（本项目所有读数都用 16 位口径对齐） */
function sha16(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); }
  catch (e) { return 'unreadable:' + String((e && e.message) || e).slice(0, 30); }
}
const size = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const tag = (p) => `${path.basename(p)} ${size(p)} B sha16=${sha16(p)}`;

/** 打印"这次到底在量什么"——每条读数都能追到产物与夹具 */
function rulerCard({ probe = '?', exe, doc, extra } = {}) {
  const card = { probe, at: new Date().toISOString(), exe: exe ? tag(exe) : null, doc: doc ? tag(doc) : null, node: process.version, ...(extra || {}) };
  console.log('[尺子卡] ' + JSON.stringify(card));
  return card;
}

function check(kind, file, expect) {
  const got = sha16(file);
  const ok = !expect || got === expect;
  console.log(`[尺子卡·${kind}] ${ok ? '✓' : '✗'} ${path.basename(file)} sha16=${got}${expect ? ` 期望=${expect}` : '（未设期望值，不拦）'}`);
  if (!ok) {
    console.error(`\n✗ ${kind} 与期望不符 ⇒ 本探针拒绝出数（避免"尺子与对象对不上"的假读数）。\n  文件：${file}\n  实际 sha16=${got}  期望=${expect}\n  提示：换产物后请同时更新 MP_EXPECT_${kind.toUpperCase()}，或在命令行显式覆盖。`);
    process.exit(9);
  }
  return got;
}
/** 产物（exe）一致性断言 */
const assertExe = (exe, expect) => check('exe', exe, expect || process.env.MP_EXPECT_EXE || null);
/** 夹具（doc）一致性断言 */
const assertDoc = (doc, expect) => check('doc', doc, expect || process.env.MP_EXPECT_DOC || null);

/** 夹具自愈（本轮 §7.8 踩过的坑：跑动中夹具被写成小残件 ⇒ 读数无效）：
 *  尺寸与预期不符时从 pristine 源拷回，并报一行。返回 {healed, size}。 */
function healFixture(doc, pristine, expectBytes) {
  const s = size(doc);
  if (expectBytes && s !== expectBytes && pristine && fs.existsSync(pristine)) {
    fs.copyFileSync(pristine, doc);
    console.log(`[尺子卡·夹具自愈] ${path.basename(doc)} ${s} B → ${size(doc)} B（源 ${path.basename(pristine)}）`);
    return { healed: true, size: size(doc) };
  }
  return { healed: false, size: s };
}

module.exports = { sha16, size, tag, rulerCard, assertExe, assertDoc, healFixture };
