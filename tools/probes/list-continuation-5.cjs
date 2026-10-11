/** 族：list-continuation 第五轮 —— 复选框点击"改错位置"的**真人路径**定点复现
 *
 *  第四/三轮读数（report3.json T17）：
 *    doc 已经是 `- 甲\n- [x] 乙`，屏幕上唯一的复选框 dataset 却是 `mpFrom=2 mpTo=5`
 *    （＝**上一个文档**里 `[ ]` 的源码区间）⇒ 点击后源码被改成 `- [x] [x] 乙`（"甲"和换行没了）。
 *  可疑成因（读 lists.js:14-27 的 eq）：`CheckboxWidget.eq(other){ return other.checked === this.checked }`
 *  只比 checked、**不比 from/to**，而 from/to 是烘进 DOM 的 `dataset`（toDOM 里写的）
 *  ⇒ CM6 认为两个 widget 等价、复用旧 DOM 节点 ⇒ 位置变了、dataset 没变。
 *  【但机制是推断】本轮的判据只认**现象**：全程只用真实键鼠（无 dispatch 造文档），
 *  看"勾选 → 文档位移 → 再点"这条真人路径下源码会不会被改坏。
 *
 *  用法：node list-continuation-5.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = require('./_probe-common.cjs');
const { launch, sleep } = require('./_probe-cdp-load.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'list-continuation-out');
const SHOTS = path.join(OUT, 'shots');
const RUN = path.join(OUT, 'run5-' + process.pid);
const DOC = path.join(RUN, 'list-continuation-夹具5.md');
const PORT = 12480 + (process.pid % 300);
const EXE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');
const FIXTURE = ['# 待办清单', '', '- 买牛奶', ''].join('\n');
let CHILD_PID = null;

/* 一次 evaluate 拿全：doc + 每个复选框的 dataset/checked/几何（AGENTS 错-7①） */
const CB = () => {
  const v = window.mpEngine._view();
  const d = v.state.doc;
  return {
    doc: d.toString(),
    boxes: [...document.querySelectorAll('.mp-cm6-check')].map((el) => {
      const b = el.getBoundingClientRect();
      return {
        checked: !!el.checked, from: Number(el.dataset.mpFrom), to: Number(el.dataset.mpTo),
        slice: d.sliceString(Number(el.dataset.mpFrom), Number(el.dataset.mpTo)),
        x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
      };
    }),
    head: v.state.selection.main.head,
    focus: { doc: document.hasFocus(), view: !!v.hasFocus },
  };
};

(async () => {
  if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的装机产物路径'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  R.rulerCard({ probe: 'list-continuation-5.cjs', exe: EXE, extra: { port: PORT } });
  R.assertExe(EXE);
  const h = await launch({ exe: EXE, doc: DOC, dir: RUN, port: PORT, profileName: 'profile', beforeSpawn: async () => { fs.writeFileSync(DOC, FIXTURE, 'utf8'); } });
  const page = h.page; CHILD_PID = h.child.pid;
  const cdp = await page.context().newCDPSession(page);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.bringToFront().catch(() => { });
  const boot = await ev(() => ({ hasMark: window.mpEngine._view().state.doc.toString().includes('# 待办清单') }));
  if (!boot.hasMark) { console.error('✗ 串台 ⇒ 拒绝出数'); await h.closeAll(); process.exit(10); }
  const g = await ev(() => { const v = window.mpEngine._view(); const els = [...v.contentDOM.querySelectorAll('.cm-line')]; const el = els[els.length - 1] || v.contentDOM; const b = el.getBoundingClientRect(); return { x: Math.min(window.innerWidth - 4, Math.round(b.right) + 10), y: Math.round(b.top + b.height / 2) }; });
  await page.mouse.click(g.x, g.y); await sleep(300);
  console.log('· 激活 =', JSON.stringify(await ev(() => { const v = window.mpEngine._view(); return { docFocus: document.hasFocus(), viewFocus: !!v.hasFocus }; })));

  const out = { probe: 'list-continuation-5.cjs', exe: EXE, exeSha16: R.sha16(EXE), at: new Date().toISOString(), cases: [], pageErrors: [] };
  async function shot(name) {
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
      await sleep(280);
      const rect = await ev(() => { const el = document.getElementById('editor') || window.mpEngine._view().dom; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; });
      await page.screenshot({ path: path.join(SHOTS, name + '.png'), clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(200, Math.min(860, rect.w)), height: Math.max(160, Math.min(420, rect.h)) }, timeout: 15000 });
      await cdp.send('Emulation.clearDeviceMetricsOverride'); await sleep(200);
      return path.join(SHOTS, name + '.png');
    } catch (e) { return 'SHOT-FAIL ' + String((e && e.message) || e).slice(0, 60); }
  }
  /** 全真实输入清空文档：Ctrl+A → Backspace */
  async function clearDoc() {
    await page.keyboard.press('Control+a'); await sleep(150);
    await page.keyboard.press('Backspace'); await sleep(350);
    const r = await ev(() => window.mpEngine._view().state.doc.toString());
    return r;
  }
  async function clickBox(idx) {
    const pre = await ev(CB);
    const el = pre.boxes[idx == null ? 0 : idx];
    if (!el) return { pre, clicked: null };
    await page.mouse.click(el.x, el.y);
    await sleep(400);
    const post = await ev(CB);
    return { pre, clicked: el, post };
  }
  function log(caseId, title, r) {
    console.log(`\n— ${caseId} ${title}`);
    console.log(`   点击前 doc=${JSON.stringify(r.pre.doc)}`);
    console.log(`   点击前复选框：` + JSON.stringify(r.pre.boxes));
    console.log(`   点到 = ${JSON.stringify(r.clicked)}`);
    console.log(`   点击后 doc=${JSON.stringify(r.post.doc)}`);
    console.log(`   点击后复选框：` + JSON.stringify(r.post.boxes));
  }

  /* R1：真人路径 —— 打一行待办 → 勾选 → 在上方插一行（文档位移）→ 再点同一个复选框 */
  {
    console.log('\n══ R1 全真实输入 ══');
    const cleared = await clearDoc();
    console.log('· 清空后 doc=' + JSON.stringify(cleared));
    await page.keyboard.insertText('- 甲'); await sleep(200);
    await page.keyboard.press('Enter'); await sleep(250);
    await page.keyboard.insertText('[ ] 交电费'); await sleep(350);
    const s1 = await ev(CB);
    console.log(`· 打字后 doc=${JSON.stringify(s1.doc)} 复选框=${JSON.stringify(s1.boxes)}`);
    const c1 = await clickBox(0); log('R1-①', '勾选（文档未位移，应正常勾上）', c1);
    /* 文档位移：真实 Ctrl+Home 回到文首 → 真实 Enter 拆行（整篇下移一行） */
    await page.keyboard.press('Control+Home'); await sleep(200);
    await page.keyboard.press('Enter'); await sleep(300);
    await page.keyboard.insertText('开头一行'); await sleep(350);
    const s2 = await ev(CB);
    console.log(`· 位移后 doc=${JSON.stringify(s2.doc)} 复选框=${JSON.stringify(s2.boxes)}`);
    const c2 = await clickBox(0); log('R1-②', '文档位移后再点同一个复选框（判据：只该把 [x] 翻成 [ ]）', c2);
    const rec = {
      id: 'R1', cleared, typed: s1, afterCheck: c1.post, afterShift: s2, secondClick: c2,
      verdict: c2.post.doc === c2.pre.doc.replace('[x]', '[ ]') ? 'OK-仅翻转' : 'DIFF-源码被改坏',
    };
    rec.shot = await shot('R1-after-second-click');
    out.cases.push(rec);
    console.log(`   ★ 判据：${rec.verdict}`);
    console.log(`     期望（仅翻转）= ${JSON.stringify(c2.pre.doc.replace('[x]', '[ ]'))}`);
    console.log(`     实得          = ${JSON.stringify(c2.post.doc)}`);
  }

  /* R2：对照臂 —— 勾选后**不**位移，再点一次（应正常翻回） */
  {
    console.log('\n══ R2 对照臂（不位移）══');
    await clearDoc();
    await page.keyboard.insertText('- [ ] 交电费'); await sleep(350);
    const c1 = await clickBox(0); log('R2-①', '未位移，第一次勾选', c1);
    const c2 = await clickBox(0); log('R2-②', '未位移，第二次点（翻回）', c2);
    out.cases.push({ id: 'R2', first: c1, second: c2, verdict: c2.post.doc === '- [ ] 交电费' ? 'OK' : 'DIFF' });
    console.log(`   ★ 判据：${out.cases[out.cases.length - 1].verdict}`);
  }

  /* R3：真人编辑位移（在待办项**前面**打字，不拆行）→ 再点 */
  {
    console.log('\n══ R3 前方插入字符后再点 ══');
    await clearDoc();
    await page.keyboard.insertText('- 甲'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(200);
    await page.keyboard.insertText('[ ] 交电费'); await sleep(300);
    const c1 = await clickBox(0); log('R3-①', '先勾上', c1);
    /* 真实 Home（行首）→ 在行首插字：`- 甲` → `X- 甲`（复选框整体右移 1） */
    await page.keyboard.press('Home'); await sleep(150);
    await page.keyboard.press('ArrowUp'); await sleep(150);
    await page.keyboard.press('Home'); await sleep(150);
    await page.keyboard.insertText('序'); await sleep(350);
    const s2 = await ev(CB);
    console.log(`· 位移后 doc=${JSON.stringify(s2.doc)} 复选框=${JSON.stringify(s2.boxes)}`);
    const c2 = await clickBox(0); log('R3-②', '位移后再点', c2);
    out.cases.push({ id: 'R3', afterCheck: c1.post, afterShift: s2, secondClick: c2 });
    console.log(`   ★ 实得 = ${JSON.stringify(c2.post.doc)}`);
  }

  /* R4：两个复选框，先勾第 1 个，再在中间插一行，然后点第 2 个 */
  {
    console.log('\n══ R4 两个复选框 + 位移 ══');
    await clearDoc();
    await page.keyboard.insertText('- [ ] 甲项'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(200);
    await page.keyboard.insertText('乙项'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(200);
    await page.keyboard.insertText('丙项'); await sleep(350);
    const s0 = await ev(CB);
    console.log(`· 打字后 doc=${JSON.stringify(s0.doc)} 复选框=${JSON.stringify(s0.boxes)}`);
    const c1 = await clickBox(0); log('R4-①', '勾第 1 个', c1);
    const c2 = await clickBox(1); log('R4-②', '勾第 2 个（无位移）', c2);
    out.cases.push({ id: 'R4', typed: s0, first: c1, second: c2 });
  }

  out.pageErrors = h.pageErrors.slice(0, 12);
  const file = path.join(OUT, 'list-continuation-report5.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  console.log('\n· 报告 =', file, '| pageerror =', JSON.stringify(out.pageErrors), '| 截图 =', SHOTS);
  await h.closeAll(); await sleep(700); process.exit(0);
})().catch(async (e) => {
  console.error('✗ 异常：', (e && e.stack) || e);
  if (CHILD_PID) { try { require('node:child_process').execFileSync('taskkill', ['/PID', String(CHILD_PID), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { } }
  process.exit(1);
});
