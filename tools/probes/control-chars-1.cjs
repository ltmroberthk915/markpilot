/** 族=control-chars · P1：含 NUL / ESC / BEL 的文本**粘贴**（真实 Ctrl+V）与落盘字节
 *
 *  用例：
 *   CC-0 打开夹具的基线（断言 docInfo 命中夹具 ⇒ 不是默认回退值；空转 1.6s 不改盘）
 *   CC-1 ESC+BEL 载荷：装弹 → 独立进程回读 → 真实 Ctrl+V → 再回读 → 落盘 → 磁盘字节
 *   CC-2 内嵌 NUL 载荷（系统剪贴板通道）：四步齐 + 落盘字节（平台是否投递得了 NUL）
 *   CC-3 内嵌 NUL（CDP Input.insertText 通道，**非剪贴板**，本仓口径的真实输入通道）：落盘字节
 *
 *  "保存后还能不能打开"是另一支（control-chars-3.cjs）：那条路要弹原生框，必须单独收尾。
 *
 *  用法：node control-chars-1.cjs [EXE]
 *  期望产物 sha16 由 MP_EXPECT_EXE 断言（不设则只打印）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'control-chars-lib.cjs'));

const EXE = process.argv[2] || L.EXE;
const DIR = path.join(L.ROOT, 'p1');
const DOC = path.join(DIR, 'cc-paste.md');
const BASE_TEXT = '# 控制字符粘贴\n\nAA\n';
const PAY_ESC_BEL = 'MPCC-A\u001bB\u0007C-END';
const PAY_NUL = 'MPCC2-NUL[\u0000]-END';
const PAY_NUL_INSERT = 'MPCC3[\u0000]END';
const out = { probe: 'control-chars-1.cjs', exe: EXE, at: new Date().toISOString(), cases: {}, pageErrors: [], shots: [] };
const diskNow = (p) => ({ ...L.bytesInfo(p), mtimeMs: ((L.statOf(p) || {}).mtimeMs) });
const J = (o) => JSON.stringify(o);
/** 文档**末尾**（忽略结尾那个换行）是否逐字符等于某载荷 —— 归属证明：
 *  只有本载荷含 MPCC 哨兵 + ESC/BEL，别的族的哨兵串不可能长这样。 */
const docEndsWith = (text, payload) => String(text || '').replace(/\n$/, '').endsWith(payload);
/** paste 见证器里最后一条（＝按键那一刻浏览器交给编辑器的剪贴板内容） */
const witnessOf = (s) => { const w = (s.pasteWitness || []).slice(-1)[0] || null; return w; };

async function main() {
  L.ruler('control-chars-1.cjs', EXE);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  out.fixture0 = L.writeBytes(DOC, L.utf8(BASE_TEXT));

  const PORT = L.pickPort(15100);
  out.port = PORT;
  const app = await L.F.launch({ exe: EXE, args: [DOC], port: PORT, profile: path.join(DIR, 'profile') });
  const page = await L.F.findPage(app.browser, { expectFile: 'cc-paste.md' });
  L.wireErrors(page, out.pageErrors);
  await L.sleep(1600);

  /* ── CC-0 基线 ───────────────────────────────────────────── */
  {
    const s = await L.snapCC(page);
    const hit = String((s.host || {}).filePath || '').replace(/\\/g, '/').toLowerCase().endsWith('cc-paste.md');
    const d0 = diskNow(DOC);
    await L.sleep(1600);
    const d1 = diskNow(DOC);
    out.cases['CC-0'] = {
      断言命中夹具: hit, host: s.host,
      文档逐字符等于夹具: s.docText === BASE_TEXT, docText: J(s.docText), docLen: s.docLen, docLines: s.docLines,
      viewFocus: s.viewFocus, frameFocus: s.frameFocus, activeEl: s.activeEl, renderedLines: s.renderedLines,
      空转1_6秒后磁盘: { 变了: d1.sha16 !== d0.sha16 || d1.mtimeMs !== d0.mtimeMs, before: d0, after: d1 },
    };
    if (!hit || s.docText !== BASE_TEXT) throw new Error('CC-0 前置不成立：没打开夹具或文档不是夹具内容 ⇒ 后面读数无意义');
    console.log('[CC-0] ' + J(out.cases['CC-0']));
  }

  /* ── CC-1 ESC + BEL 经真实 Ctrl+V ───────────────────────── */
  {
    const box = await L.clickBody(page, 'AA');
    const attempts = [];
    let picked = null;
    for (let k = 0; k < 2 && !picked; k++) {
      if (k > 0) { await page.keyboard.press('Control+z'); await L.sleep(300); }   // 上一次粘进去的先撤销，重来一遍
      const arm = await L.clipArm(PAY_ESC_BEL);
      const before = await L.snapCC(page);
      const press = await L.realPaste(page);
      const recheck = L.clipRecheck(PAY_ESC_BEL);           // 第④步：按键之后立刻再回读（越早越不易被别的腿抢占）
      const sn = await L.snapCC(page);
      const w = witnessOf(sn);
      const rec = {
        第几次: k + 1,
        装弹: { 成功: arm.ok, 尝试: arm.tries, 回读: J(arm.back), 回读字符码: arm.backCodes, 被抢占: arm.attempts.filter((a) => !a.match).map((a) => String(a.back).slice(0, 40)) },
        按键: press,
        paste见证: w ? { 长度: w.len, 字符码: w.codes, 等于本载荷: w.plain === PAY_ESC_BEL, 原文: J(w.plain) } : null,
        按后回读: { 仍是本载荷: recheck.stillMine, 回读: J(recheck.back), 回读字符码: recheck.backCodes },
        文档侧归属: { Δ长度: sn.docLen - before.docLen, 期望Δ: PAY_ESC_BEL.length, 文档末尾逐字符等于载荷: docEndsWith(sn.docText, PAY_ESC_BEL), 文档里含完整载荷: String(sn.docText || '').includes(PAY_ESC_BEL) },
        文档: { ESC个数: sn.ctrlCounts[27] || 0, BEL个数: sn.ctrlCounts[7] || 0, docLen: sn.docLen, 行数: sn.docLines, 渲染行数: sn.renderedLines, 行类: sn.lineClasses, 活动行类: sn.activeLineClass },
        提示条: sn.banner, _snap: sn,
      };
      attempts.push(rec);
      const attrib = docEndsWith(sn.docText, PAY_ESC_BEL) && sn.ctrlCounts[27] === 1 && sn.ctrlCounts[7] === 1 && !!w && w.plain === PAY_ESC_BEL;
      if (arm.ok && press.pressed && attrib) picked = rec;
    }
    const use = picked || attempts[attempts.length - 1];
    const s = use._snap;
    const shotLine = await page.evaluate(() => {
      const el = document.querySelector('.cm-line.cm-activeLine') || document.querySelector('.cm-line');
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.left - 20)), y: Math.max(0, Math.round(r.top - 8)), width: Math.min(900, Math.round(r.width + 40)), height: Math.max(28, Math.round(r.height + 16)) };
    });
    if (shotLine) { const f = path.join(DIR, 'shots', 'CC-1-esc-bel-line.png'); fs.mkdirSync(path.dirname(f), { recursive: true }); await page.screenshot({ path: f, clip: shotLine }); out.shots.push(f); }
    const dPaste = diskNow(DOC);
    await page.keyboard.press('Control+s');
    const saved = await L.waitDisk(DOC, { mtimeMs: dPaste.mtimeMs, sha16: dPaste.sha16 });
    out.cases['CC-1'] = {
      载荷: J(PAY_ESC_BEL), 载荷字符码: L.codes(PAY_ESC_BEL), 点击行: box,
      四步齐的尝试: !!picked, 尝试次数: attempts.length,
      尝试明细: attempts.map((a) => ({ ...a, _snap: undefined })),
      采用: { 第几次: use.第几次, 装弹: use.装弹, paste见证: use.paste见证, 按后回读: use.按后回读, 文档侧归属: use.文档侧归属, 文档: use.文档, 提示条: use.提示条 },
      收尾时文档: { docText: J(s.docText), docLen: s.docLen, ESC个数: s.ctrlCounts[27] || 0, BEL个数: s.ctrlCounts[7] || 0 },
      落盘: { 等待: { 变了: saved.changed, 用时ms: saved.ms }, 磁盘: saved.info, 磁盘含ESC: (saved.info.esc || 0) >= 1, 磁盘含BEL: (saved.info.bel || 0) >= 1 },
    };
    console.log('[CC-1] ' + J(out.cases['CC-1']));
  }

  /* ── CC-2 内嵌 NUL：系统剪贴板通道 ───────────────────────── */
  {
    const expectTrunc = PAY_NUL.slice(0, PAY_NUL.indexOf('\u0000'));   // CF_UNICODETEXT 在首个 NUL 处截断
    const arm = await L.clipArm(PAY_NUL, { expect: expectTrunc });
    const before = await L.snapCC(page);
    const press = await L.realPaste(page);
    const recheck = L.clipRecheck(expectTrunc);
    const s = await L.snapCC(page);
    const w2 = witnessOf(s);
    const dPaste = diskNow(DOC);
    await page.keyboard.press('Control+s');
    const saved = await L.waitDisk(DOC, { mtimeMs: dPaste.mtimeMs, sha16: dPaste.sha16 });
    out.cases['CC-2'] = {
      载荷: J(PAY_NUL), 载荷字符码: L.codes(PAY_NUL), 平台期望回读: J(expectTrunc),
      装弹: { 成功: arm.ok, 尝试: arm.tries, 回读: J(arm.back), 回读字符码: arm.backCodes, 首NUL即截断: arm.back === expectTrunc },
      按键: press,
      paste见证: w2 ? { 长度: w2.len, 字符码: w2.codes, 等于平台截断值: w2.plain === expectTrunc, 原文: J(w2.plain) } : null,
      按后回读: { 仍是本载荷: recheck.stillMine, 回读: J(recheck.back) },
      文档: { NUL个数: s.ctrlCounts[0] || 0, docLenBefore: before.docLen, docLenAfter: s.docLen, Δ长度: s.docLen - before.docLen, 期望Δ: expectTrunc.length, 文档末尾逐字符等于截断载荷: docEndsWith(s.docText, expectTrunc), 尾16码: s.tail16 },
      落盘: { 磁盘: saved.info, 磁盘NUL个数: saved.info.nul || 0 },
    };
    console.log('[CC-2] ' + J(out.cases['CC-2']));
  }

  /* ── CC-3 内嵌 NUL：CDP Input.insertText（**非剪贴板**，标注清楚）── */
  {
    await page.evaluate(() => { const v = window.mpEngine._view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
    const before = await L.snapCC(page);
    await page.keyboard.insertText(PAY_NUL_INSERT);
    await L.sleep(200);
    const s = await L.snapCC(page);
    const dPaste = diskNow(DOC);
    await page.keyboard.press('Control+s');
    const saved = await L.waitDisk(DOC, { mtimeMs: dPaste.mtimeMs, sha16: dPaste.sha16 });
    out.cases['CC-3'] = {
      通道: 'CDP Input.insertText（本仓口径的真实输入通道；**不经过系统剪贴板** ⇒ 不代表"用户能粘进 NUL"）',
      载荷: J(PAY_NUL_INSERT), 载荷字符码: L.codes(PAY_NUL_INSERT),
      文档: { NUL个数: s.ctrlCounts[0] || 0, docLenBefore: before.docLen, docLenAfter: s.docLen, Δ长度: s.docLen - before.docLen, 文档末尾逐字符等于载荷: docEndsWith(s.docText, PAY_NUL_INSERT), 尾16码: s.tail16 },
      落盘: { 磁盘: saved.info, 磁盘NUL个数: saved.info.nul || 0, NUL偏移: saved.info.nulOffsets, 首NUL在嗅探窗口内: (saved.info.nulOffsets || []).some((o) => o < 4096) },
      提示条: s.banner,
    };
    console.log('[CC-3] ' + J(out.cases['CC-3']));
  }

  /* 收尾：杀进程 → 复核没有本族残进程 */
  L.F.kill(app);
  await L.sleep(1200);
  out.cleanup = { MarkPilot进程总数: L.tasklistMarkpilot(), 本进程还在: L.alive(app.pid), 最终磁盘: diskNow(DOC) };

  /* ── 判据汇总 ─────────────────────────────────────────── */
  const c1 = out.cases['CC-1'], c2 = out.cases['CC-2'], c3 = out.cases['CC-3'];
  out.verdicts = {
    'CC-1 第②步 装弹后独立进程回读=本载荷': c1.采用.装弹.成功,
    'CC-1 第③步 paste 见证=本载荷（按键那一刻）': !!(c1.采用.paste见证 && c1.采用.paste见证.等于本载荷),
    'CC-1 第④步 按键后独立回读仍是本载荷（本机多族抢占，多半为 false）': c1.采用.按后回读.仍是本载荷,
    'CC-1 最终状态：文档末尾逐字符等于载荷': c1.采用.文档侧归属.文档末尾逐字符等于载荷,
    'CC-1 ESC/BEL 落盘（磁盘字节 0x1B / 0x07 各一）': (c1.落盘.磁盘含ESC && c1.落盘.磁盘含BEL),
    'CC-2 第③步 paste 见证=平台截断值': !!(c2.paste见证 && c2.paste见证.等于平台截断值),
    'CC-2 NUL 经系统剪贴板投递到文档': ((c2.文档.NUL个数 || 0) > 0),
    'CC-2 平台在首个 NUL 处截断（现状读数）': c2.装弹.首NUL即截断,
    'CC-3 insertText 的 NUL 进文档': ((c3.文档.NUL个数 || 0) > 0),
    'CC-3 NUL 落盘': ((c3.落盘.磁盘NUL个数 || 0) > 0),
    'CC-3 首NUL落在嗅探窗口(4096B)内': c3.落盘.首NUL在嗅探窗口内,
  };
  L.jsonDump(path.join(DIR, 'control-chars-1.json'), out);
  console.log('\n=== 判据 ===');
  console.log(J(out.verdicts));
  console.log('pageErrors: ' + J(out.pageErrors));
  console.log('cleanup: ' + J(out.cleanup));
}

main().catch((e) => { console.error('探针异常：' + ((e && e.stack) || e)); process.exitCode = 1; });
