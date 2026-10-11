/** 族：list-continuation 第四轮 —— Tab 缩进的**可见效果**（用户看得见的那一面）
 *
 *  第三轮已证：Tab/Shift+Tab 走 lists.js（app.js:292:194 / 292:466），源码确实插/删两个空位。
 *  但第一轮的 2 倍截图里，`- 甲` 与 `  - 乙` 两个项目符号**画在同一 x**（看不出层级）。
 *  本轮把"视觉层级"变成可测读数：同一次 evaluate 里同时取
 *    ① 每行的几何（.cm-line 的左边界、行内首个可见元素的左边界）
 *    ② 语法树节点链（解析器到底认不认这是嵌套列表）
 *    ③ 该行的计算样式（padding-left / text-indent / margin-left）
 *  再发一次真实 Tab，量 Δx —— 读数与截图对不上时，先用这两条腿分清"解析没嵌套"还是"渲染没缩进"。
 *
 *  用法：node list-continuation-4.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = require('./_probe-common.cjs');
const { launch, sleep } = require('./_probe-cdp-load.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'list-continuation-out');
const SHOTS = path.join(OUT, 'shots');
const RUN = path.join(OUT, 'run4-' + process.pid);
const DOC = path.join(RUN, 'list-continuation-夹具4.md');
const PORT = 12160 + (process.pid % 300);
const EXE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');
const FIXTURE = ['# 待办清单', '', '- 买牛奶', ''].join('\n');
let CHILD_PID = null;

/* 一次 evaluate 拿全：几何 + 语法树 + 计算样式（AGENTS 错-7①） */
const MEASURE = (lineNos) => {
  const v = window.mpEngine._view();
  const d = v.state.doc;
  const tree = window.mpSyntaxTree ? window.mpSyntaxTree(v.state) : null;
  const out = [];
  for (const no of lineNos) {
    const line = d.line(Math.min(no, d.lines));
    const el = [...v.contentDOM.querySelectorAll('.cm-line')].find((e) => {
      try { const p = v.posAtDOM(e, 0); return p >= line.from && p <= line.to; } catch { return false; }
    }) || null;
    let nodePath = null;
    if (tree) {
      try {
        const inner = tree.resolveInner(line.from + Math.min(2, line.text.length), 1);
        const names = []; let n = inner;
        while (n) { names.push(n.name); n = n.parent; }
        nodePath = names.join(' < ');
      } catch { nodePath = 'ERR'; }
    }
    const cs = el ? getComputedStyle(el) : null;
    const firstVisible = el ? [...el.querySelectorAll('*')].find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }) : null;
    out.push({
      no, text: line.text, lineLeft: el ? Math.round(el.getBoundingClientRect().left) : null,
      firstTag: firstVisible ? firstVisible.tagName + '.' + String(firstVisible.className).slice(0, 18) : null,
      firstLeft: firstVisible ? Math.round(firstVisible.getBoundingClientRect().left) : null,
      contentText: el ? (el.textContent || '').slice(0, 24) : null,
      padLeft: cs ? cs.paddingLeft : null, textIndent: cs ? cs.textIndent : null, marginLeft: cs ? cs.marginLeft : null,
      nodePath,
    });
  }
  return { doc: d.toString(), lines: out };
};

(async () => {
  if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的装机产物路径'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  R.rulerCard({ probe: 'list-continuation-4.cjs', exe: EXE, extra: { port: PORT } });
  R.assertExe(EXE);
  const h = await launch({ exe: EXE, doc: DOC, dir: RUN, port: PORT, profileName: 'profile', beforeSpawn: async () => { fs.writeFileSync(DOC, FIXTURE, 'utf8'); } });
  const page = h.page; CHILD_PID = h.child.pid;
  const cdp = await page.context().newCDPSession(page);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.bringToFront().catch(() => { });
  const boot = await ev(() => ({ hasMark: window.mpEngine._view().state.doc.toString().includes('# 待办清单'), hasTree: !!window.mpSyntaxTree }));
  if (!boot.hasMark) { console.error('✗ 串台 ⇒ 拒绝出数'); await h.closeAll(); process.exit(10); }
  /* 语法树门面：引擎没暴露就从 view 里拿（@codemirror/language 的 syntaxTree 挂在 bundle 里，
     这里用 CM6 公共 API 的替代：view.state.facet(language). 不可用 ⇒ 退化为 null，不硬编 */
  await ev(() => {
    try {
      const v = window.mpEngine._view();
      const anyWin = window;
      window.mpSyntaxTree = anyWin.mpSyntaxTree || null;
      void v;
    } catch { }
  });
  console.log('· 启动自检 =', JSON.stringify(boot));
  const g = await ev(() => { const v = window.mpEngine._view(); const els = [...v.contentDOM.querySelectorAll('.cm-line')]; const el = els[els.length - 1] || v.contentDOM; const b = el.getBoundingClientRect(); return { x: Math.min(window.innerWidth - 4, Math.round(b.right) + 10), y: Math.round(b.top + b.height / 2) }; });
  await page.mouse.click(g.x, g.y); await sleep(300);

  async function reset(text, head) {
    return ev(([t, hp]) => {
      const v = window.mpEngine._view();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: (hp == null || hp < 0) ? t.length : hp } });
      v.focus();
      return { applied: v.state.doc.toString() === t, head: v.state.selection.main.head, viewFocus: !!v.hasFocus };
    }, [text, head]);
  }
  async function shot(name) {
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
      await sleep(300);
      const rect = await ev(() => { const el = document.getElementById('editor') || window.mpEngine._view().dom; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; });
      await page.screenshot({ path: path.join(SHOTS, name + '.png'), clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(200, Math.min(860, rect.w)), height: Math.max(160, Math.min(420, rect.h)) }, timeout: 15000 });
      await cdp.send('Emulation.clearDeviceMetricsOverride'); await sleep(200);
      return path.join(SHOTS, name + '.png');
    } catch (e) { return 'SHOT-FAIL ' + String((e && e.message) || e).slice(0, 60); }
  }

  const out = { probe: 'list-continuation-4.cjs', exe: EXE, exeSha16: R.sha16(EXE), at: new Date().toISOString(), cases: [], pageErrors: [] };
  const VARIANTS = [
    { id: 'G0', name: '两个同级项 `- 甲` / `- 乙`', doc: '- 甲\n- 乙', lines: [1, 2] },
    { id: 'G1', name: '2 空格缩进 `- 甲` / `  - 乙`（Tab 插的就是这个）', doc: '- 甲\n  - 乙', lines: [1, 2] },
    { id: 'G2', name: '4 空格缩进 `- 甲` / `    - 乙`', doc: '- 甲\n    - 乙', lines: [1, 2] },
    { id: 'G3', name: '8 空格缩进 `- 甲` / `        - 乙`', doc: '- 甲\n        - 乙', lines: [1, 2] },
  ];
  for (const va of VARIANTS) {
    const st = await reset(va.doc, -1);
    await sleep(350);
    const m = await ev(MEASURE, va.lines);
    const rec = { id: va.id, name: va.name, setupApplied: st.applied, doc: m.doc, lines: m.lines };
    out.cases.push(rec);
    console.log(`\n— ${va.id} ${va.name}`);
    console.log(`   doc=${JSON.stringify(m.doc)}`);
    for (const L of m.lines) {
      console.log(`   行${L.no} ${JSON.stringify(L.text)}  lineLeft=${L.lineLeft} 首个可见=${L.firstTag}@${L.firstLeft} pad=${L.padLeft} indent=${L.textIndent} margin=${L.marginLeft}`);
      console.log(`        节点链 = ${L.nodePath}`);
    }
  }
  /* G4：真实 Tab 的 Δx（Tab 前后同尺子各量一次；不跨调用拼装——两次量的是同一组字段） */
  {
    const st = await reset('- 甲\n- 乙', -1);
    await sleep(300);
    const before = await ev(MEASURE, [1, 2]);
    await page.keyboard.press('Tab');
    await sleep(450);
    const after = await ev(MEASURE, [1, 2]);
    const rec = { id: 'G4', name: '真实 Tab 前后的几何（Δx）', setupApplied: st.applied, before, after };
    out.cases.push(rec);
    console.log('\n— G4 真实 Tab 前后');
    console.log(`   before doc=${JSON.stringify(before.doc)}`);
    for (const L of before.lines) console.log(`     行${L.no} ${JSON.stringify(L.text)} 首个可见@${L.firstLeft} 节点链=${L.nodePath}`);
    console.log(`   after  doc=${JSON.stringify(after.doc)}`);
    for (const L of after.lines) console.log(`     行${L.no} ${JSON.stringify(L.text)} 首个可见@${L.firstLeft} 节点链=${L.nodePath}`);
    rec.shotTabbed = await shot('G4-after-tab-2space');
  }
  /* G5：4 空格（两次 Tab）后 Δx */
  {
    await reset('- 甲\n- 乙', -1);
    await page.keyboard.press('Tab'); await sleep(250);
    await page.keyboard.press('Tab'); await sleep(400);
    const m = await ev(MEASURE, [1, 2]);
    out.cases.push({ id: 'G5', name: '连按两次 Tab（4 空格）', doc: m.doc, lines: m.lines });
    console.log('\n— G5 连按两次 Tab');
    console.log(`   doc=${JSON.stringify(m.doc)}`);
    for (const L of m.lines) console.log(`     行${L.no} ${JSON.stringify(L.text)} 首个可见@${L.firstLeft} 节点链=${L.nodePath}`);
    await shot('G5-after-tab-4space');
  }
  out.pageErrors = h.pageErrors.slice(0, 12);
  const file = path.join(OUT, 'list-continuation-report4.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  console.log('\n· 报告 =', file, '| pageerror =', JSON.stringify(out.pageErrors));
  await h.closeAll(); await sleep(700); process.exit(0);
})().catch(async (e) => {
  console.error('✗ 异常：', (e && e.stack) || e);
  if (CHILD_PID) { try { require('node:child_process').execFileSync('taskkill', ['/PID', String(CHILD_PID), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { } }
  process.exit(1);
});
