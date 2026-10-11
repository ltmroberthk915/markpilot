/** 族：list-continuation 第三轮 —— 「谁在处理这个键」的定点 trace
 *
 *  第二轮 trace 已确认：空项回车那几支的 dispatch 来自 **lang-markdown 的 insertNewlineContinueMarkup**
 *  （app.js:30:24677，命令工厂 dispatch(state.update(...)) 形态）与 **CM6 默认 insertNewlineAndIndent**
 *  （app.js:30:47822），**没有一笔来自 lists.js 的 enterContinueList**。
 *  本轮把第一轮"通过"的那些用例也逐条 trace：看 Enter/Tab 到底进的是哪一支，
 *  以及 lists.js（产品自己的列表语义）在这份产物里究竟还有没有被调度。
 *
 *  用法：node list-continuation-3.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const R = require('./_probe-common.cjs');
const { launch, sleep } = require('./_probe-cdp-load.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'list-continuation-out');
const RUN = path.join(OUT, 'run3-' + process.pid);
const DOC = path.join(RUN, 'list-continuation-夹具3.md');
const PORT = 11840 + (process.pid % 300);
const EXE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');
const FIXTURE = ['# 待办清单', '', '- 买牛奶', ''].join('\n');
let CHILD_PID = null;

/* 站点指纹：第二轮实测定出来的两处 dispatch 调用点（line:col，列＝该行字符偏移） */
const SITE = {
  '30:24677': 'lang-markdown / insertNewlineContinueMarkup（命令工厂 dispatch(state.update())）',
  '30:47822': 'CM6 commands / insertNewlineAndIndent（默认键位）',
};

(async () => {
  if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的装机产物路径'); process.exit(2); }
  const h = await launch({ exe: EXE, doc: DOC, dir: RUN, port: PORT, profileName: 'profile', beforeSpawn: async () => { fs.writeFileSync(DOC, FIXTURE, 'utf8'); } });
  const page = h.page; CHILD_PID = h.child.pid;
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.bringToFront().catch(() => { });

  const boot = await ev(() => ({ hasMark: window.mpEngine._view().state.doc.toString().includes('# 待办清单') }));
  if (!boot.hasMark) { console.error('✗ 串台 ⇒ 拒绝出数'); await h.closeAll(); process.exit(10); }
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
  async function arm() {
    return ev(() => {
      const v = window.mpEngine._view();
      if (!window.__tr) window.__tr = { tx: [] };
      if (!v.__origDispatch) {
        v.__origDispatch = v.dispatch.bind(v);
        v.dispatch = function (...args) {
          const t = window.__tr;
          let raw = '?', stack = null;
          try { raw = JSON.stringify(args).slice(0, 900); } catch { raw = '<circular>'; }
          try {
            const st = String(new Error().stack || '').split('\n');
            stack = st.filter((l) => l.includes('app.js')).slice(0, 3).join(' | ').slice(0, 400);
          } catch { stack = null; }
          t.tx.push({ at: 'B', doc: v.state.doc.toString(), head: v.state.selection.main.head, raw, stack, kind: /"startState"/.test(raw) ? 'Transaction' : 'plain-spec' });
          const r = v.__origDispatch(...args);
          t.tx.push({ at: 'A', doc: v.state.doc.toString(), head: v.state.selection.main.head });
          return r;
        };
      }
      window.__tr.tx.length = 0;
      return true;
    });
  }
  const dump = () => ev(() => ({ tx: window.__tr.tx.slice(0, 20), doc: window.mpEngine._view().state.doc.toString() }));

  const CASES = [
    { id: 'T01', name: '- 甲 + Enter（续项）', doc: '- 甲', head: -1, keys: ['Enter'], expect: '- 甲\n- ' },
    { id: 'T02', name: '1. 甲 + Enter（有序续项）', doc: '1. 甲', head: -1, keys: ['Enter'], expect: '1. 甲\n2. ' },
    { id: 'T03', name: '9. 甲 + Enter（进位）', doc: '9. 甲', head: -1, keys: ['Enter'], expect: '9. 甲\n10. ' },
    { id: 'T04', name: '1) 甲 + Enter（右括号）', doc: '1) 甲', head: -1, keys: ['Enter'], expect: '1) 甲\n2) ' },
    { id: 'T05', name: '- [x] 交电费 + Enter（任务项续项）', doc: '- [x] 交电费', head: -1, keys: ['Enter'], expect: '- [x] 交电费\n- [ ] ' },
    { id: 'T06', name: '- 甲乙丙 光标在中间 + Enter（分裂）', doc: '- 甲乙丙', head: 3, keys: ['Enter'], expect: '- 甲\n- 乙丙' },
    { id: 'T07', name: '- 甲\\n  - 乙 + Enter（缩进子项续项）', doc: '- 甲\n  - 乙', head: -1, keys: ['Enter'], expect: '- 甲\n  - 乙\n  - ' },
    { id: 'T08', name: '- 甲\\n- 乙 光标在第 2 行 + Tab（缩进）', doc: '- 甲\n- 乙', head: -1, keys: ['Tab'], expect: '- 甲\n  - 乙' },
    { id: 'T09', name: '  - 乙 + Shift+Tab（反缩进）', doc: '  - 乙', head: -1, keys: ['Shift+Tab'], expect: '- 乙' },
    { id: 'T10', name: '- 甲\\n- [ ]  + Enter（空任务项）', doc: '- 甲\n- [ ] ', head: -1, keys: ['Enter'], expect: null },
    { id: 'T11', name: '- 甲\\n-   + Enter（空项，行尾）', doc: '- 甲\n- ', head: -1, keys: ['Enter'], expect: null },
    { id: 'T12', name: '- 甲\\n-   + Enter（空项，行首 head=4）', doc: '- 甲\n- ', head: 4, keys: ['Enter'], expect: null },
    { id: 'T13', name: 'x\\n-   + Enter（段落后的空项，行尾）', doc: 'x\n- ', head: -1, keys: ['Enter'], expect: null },
    { id: 'T14', name: '- 甲\\n- 乙 + Tab（多行选区）', doc: '- 甲\n- 乙', head: -1, sel: [0, 7], keys: ['Tab'], expect: null },
    { id: 'T15', name: '- 甲\\n- [ ] 交电费 + Enter（任务项在空项前）', doc: '- [ ] 甲\n- ', head: -1, keys: ['Enter'], expect: null },
    /* T16：复选框是 lists.js 的 domEventHandlers(mousedown) 干的活——本轮唯一没被 lang-markdown 抢走面子的那半，
       用真实鼠标点一次，看 dispatch 是不是 lists.js 那处（plain-spec）。 */
    { id: 'T16', name: '真实鼠标点复选框（勾选）', doc: '- [ ] 交电费', head: -1, keys: [], mouse: 'checkbox', expect: '- [x] 交电费' },
    { id: 'T17', name: '真实鼠标点复选框（第 2 行，取消勾选）', doc: '- 甲\n- [x] 乙', head: -1, keys: [], mouse: 'checkbox2', expect: '- 甲\n- [ ] 乙' },
  ];

  const out = { probe: 'list-continuation-3.cjs', exe: EXE, exeSha16: R.sha16(EXE), at: new Date().toISOString(), siteLegend: SITE, cases: [], pageErrors: [] };
  R.rulerCard({ probe: 'list-continuation-3.cjs', exe: EXE, extra: { port: PORT } });
  R.assertExe(EXE);

  for (const c of CASES) {
    const st = c.sel
      ? await ev(([t, a, b]) => { const v = window.mpEngine._view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: a, head: b } }); v.focus(); const s = v.state.selection.main; return { applied: v.state.doc.toString() === t, head: s.head, selFrom: s.from, selTo: s.to, viewFocus: !!v.hasFocus }; }, [c.doc, c.sel[0], c.sel[1]])
      : await reset(c.doc, c.head);
    await arm();
    let mousePre = null;
    if (c.mouse) {
      /* 【修正·2026-10-10 二】reset 与"读 widget"之间必须留出渲染时间：0ms 时读到的是**上一用例的陈旧
         widget**（dataset 的 from/to 属于旧文档）⇒ 点击会改错位置，读成"点复选框把文本改坏"。
         这里睡 600ms，并把 dataset(源码区间) 一起记下来当自证。 */
      await sleep(600);
      const pre = await ev((which) => {
        const v = window.mpEngine._view();
        const els = [...document.querySelectorAll('.mp-cm6-check')];
        const el = which === 'checkbox2' ? els[els.length - 1] : els[0];
        if (!el) return { n: els.length, x: null, y: null, doc: v.state.doc.toString() };
        const b = el.getBoundingClientRect();
        return {
          n: els.length, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
          checked: el.checked, from: el.dataset.mpFrom, to: el.dataset.mpTo,
          slice: v.state.sliceDoc(Number(el.dataset.mpFrom), Number(el.dataset.mpTo)),
          doc: v.state.doc.toString(),
        };
      }, c.mouse);
      mousePre = pre;
      if (pre.x != null) await page.mouse.click(pre.x, pre.y);
      await sleep(400);
    }
    for (const k of c.keys) { await page.keyboard.press(k); await sleep(320); }
    const d = await dump();
    const site = (d.tx.find((t) => t.at === 'B' && t.stack) || {}).stack || '';
    const m = /app\.js:(\d+):(\d+)/.exec(site.replace(/.*?app\.js/, 'app.js'));
    const key = m ? `${m[1]}:${m[2]}` : null;
    const b = d.tx.find((t) => t.at === 'B') || {};
    const rec = {
      id: c.id, name: c.name, setup: { doc: c.doc, head: c.head, sel: c.sel || null, applied: st.applied, headAfterSetup: st.head },
      keys: c.keys, expect: c.expect, after: d.doc, txCount: d.tx.length, mousePre,
      firstTx: b.kind ? { kind: b.kind, doc: b.doc, head: b.head, changeText: /"changes":(.*?),"selection"/.exec(b.raw || '') ? /"changes":(.*?),"selection"/.exec(b.raw)[1].slice(0, 160) : '?', stackTail: site } : null,
      siteKey: key, siteName: key ? (SITE[key] || '未知站点') : '（无 dispatch：键没被处理 / 或走了非 dispatch 路径）',
      ok: c.expect == null ? null : (d.doc === c.expect),
    };
    out.cases.push(rec);
    console.log(`\n— ${c.id} ${c.name}`);
    console.log(`   setup ${JSON.stringify(c.doc)} head=${c.head}${c.sel ? ' sel=' + JSON.stringify(c.sel) : ''} → ${c.keys.join('+')} → ${JSON.stringify(d.doc)}`);
    if (c.expect != null) console.log(`   期望 ${JSON.stringify(c.expect)}  ${rec.ok ? '✓ PASS' : '✗ DIFF'}`);
    console.log(`   事务 ${d.tx.length} 笔 | 首笔类型=${b.kind || '（无）'} | changes=${rec.firstTx ? rec.firstTx.changeText : '-'}`);
    console.log(`   ★ 处理者站点 = ${rec.siteKey || '无'} ⇒ ${rec.siteName}`);
    if (site) console.log(`     栈 = ${site.slice(0, 300)}`);
  }
  out.pageErrors = h.pageErrors.slice(0, 15);
  const file = path.join(OUT, 'list-continuation-report3.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  console.log('\n· 报告 =', file);
  console.log('· pageerror =', JSON.stringify(out.pageErrors));
  await h.closeAll(); await sleep(700); process.exit(0);
})().catch(async (e) => {
  console.error('✗ 异常：', (e && e.stack) || e);
  if (CHILD_PID) { try { require('node:child_process').execFileSync('taskkill', ['/PID', String(CHILD_PID), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { } }
  process.exit(1);
});
