/** 族：list-continuation 第二轮 —— 两件事的定点取证
 *
 *  ① 空列表项回车"退出列表"的异常：第一轮读数显示 doc 变成 "- 甲\n\n- "（在 line.from 处多插了一个 \n、
 *     marker 没被删）。现象与代码推断矛盾 ⇒ 按 AGENTS 错-8 上**页内事务 trace**（运行时包 v.dispatch，
 *     不改产品文件），看 Enter 到底进了哪个处理器、产生了几笔事务。
 *  ② 粘贴多行进列表"没反应"：第一轮剪贴板两条通道回读都是空串 ⇒ 读数无效。这轮改用**主机侧系统剪贴板**
 *     做地面真值（写 UTF-8 文件 → Set-Clipboard → Get-Clipboard 回读校验），再发真实 Ctrl+V；
 *     另加"右键菜单 → 粘贴"这条产品自己的通道做差分。
 *
 *  用法：node list-continuation-2.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const R = require('./_probe-common.cjs');
const { launch, sleep } = require('./_probe-cdp-load.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'list-continuation-out');
const SHOTS = path.join(OUT, 'shots');
const RUN = path.join(OUT, 'run2-' + process.pid);
const DOC = path.join(RUN, 'list-continuation-夹具2.md');
const PORT = 11520 + (process.pid % 300);
const EXE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');
const FIXTURE = ['# 待办清单', '', '- 买牛奶', '- [ ] 交电费', '', '1. 第一件事', ''].join('\n');

/* ── 主机侧系统剪贴板（地面真值，独立于被测页面） ──
   【2026-10-10 实测】本会话的剪贴板**根本不可用**：WinForms Clipboard.SetText 抛
   「所请求的剪贴板操作失败」(CLIPBRD_E_CANT_OPEN)，Set-Clipboard 后 Get-Clipboard -Raw 回读为空。
   ⇒ 粘贴类用例在本环境**无法验证**，读数只能说"未验证"，不许说"产品没反应"。 */
function clipProbe() {
  const ps = path.join(RUN, 'clip-probe.ps1');
  const o = path.join(RUN, 'clip-probe.txt').replace(/\\/g, '/');
  fs.writeFileSync(ps, [
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  [System.Windows.Forms.Clipboard]::SetText("MPCLIP-PROBE")',
    '  Start-Sleep -Milliseconds 150',
    `  [IO.File]::WriteAllText("${o}", [System.Windows.Forms.Clipboard]::GetText())`,
    '} catch {',
    `  [IO.File]::WriteAllText("${o}", "SETFAIL:" + $_.Exception.Message)`,
    '}',
  ].join('\n'), 'utf8');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { windowsHide: true });
    const t = fs.readFileSync(path.join(RUN, 'clip-probe.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
    return { usable: t === 'MPCLIP-PROBE', readBack: t };
  } catch (e) { return { usable: false, readBack: 'ERR ' + String((e && e.message) || e).slice(0, 80) }; }
}
function setClip(text) {
  const f = path.join(RUN, 'clip-in.txt');
  fs.writeFileSync(f, text, 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Set-Clipboard -Value ([IO.File]::ReadAllText('${f.replace(/\\/g, '/')}', [Text.Encoding]::UTF8))`], { windowsHide: true });
}
function getClip() {
  const o = path.join(RUN, 'clip-out.txt');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `[IO.File]::WriteAllText('${o.replace(/\\/g, '/')}', (Get-Clipboard -Raw), (New-Object Text.UTF8Encoding($false)))`], { windowsHide: true });
  } catch { return ''; }
  let t = '';
  try { t = fs.readFileSync(o, 'utf8'); } catch { t = ''; }
  /* 【2026-10-10 复跑修正】原版用 [Text.Encoding]::UTF8 写回读文件 ⇒ .NET 会写 UTF-8 **BOM**，
     fs 读到的串带 U+FEFF ⇒ `back === PASTE` 恒为 false ⇒ 剪贴板明明可用却被判 ENV-UNAVAILABLE、
     PB1..PB6 被整段跳过（探针自身坏了，不是环境阻断）。修法：写侧换无 BOM 编码 + 读侧仍剥 BOM（双保险）。 */
  return t.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
}
const safeStr = (v) => { try { return JSON.stringify(v); } catch { return '<circular>'; } };
/* 子进程句柄存模块级：catch 分支也要能 taskkill 掉自己起的应用（防残留） */
let CHILD_PID = null;

const READ = () => {
  const v = window.mpEngine._view();
  const d = v.state.doc;
  const text = d.toString();
  const sel = v.state.selection.main;
  const line = d.lineAt(sel.head);
  const boxes = [...document.querySelectorAll('.mp-cm6-check')].map((el) => ({ checked: !!el.checked, from: Number(el.dataset.mpFrom) }));
  const toasts = [...document.querySelectorAll('[class*=toast],[id*=toast]')].map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 3);
  const overlays = [...document.querySelectorAll('[class*=mp-pop]')].map((e) => (e.textContent || '').trim().slice(0, 60)).slice(0, 4);
  return {
    text, len: text.length, head: sel.head, selFrom: sel.from, selTo: sel.to, empty: sel.empty,
    lineNo: line.number, col: sel.head - line.from, lineText: line.text,
    docFocus: document.hasFocus(), viewFocus: !!v.hasFocus, boxes, toasts, overlays,
    dom: (v.contentDOM.innerText || '').replace(/\u200b/g, '·').slice(0, 240),
  };
};

(async () => {
  if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的装机产物路径'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(RUN, { recursive: true });
  R.rulerCard({ probe: 'list-continuation-2.cjs', exe: EXE, extra: { port: PORT, run: RUN } });
  R.assertExe(EXE);

  const h = await launch({ exe: EXE, doc: DOC, dir: RUN, port: PORT, profileName: 'profile', beforeSpawn: async () => { fs.writeFileSync(DOC, FIXTURE, 'utf8'); } });
  const page = h.page;
  CHILD_PID = h.child.pid;
  const cdp = await page.context().newCDPSession(page);
  await page.bringToFront().catch(() => { });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const readAll = () => ev(READ);

  const boot = await ev(() => { const d = window.mpEngine._view().state.doc.toString(); return { hasMark: d.includes('# 待办清单'), len: d.length }; });
  if (!boot.hasMark) { console.error('✗ 串台：连到的不是本次夹具 ⇒ 拒绝出数'); await h.closeAll(); process.exit(10); }
  console.log('· 启动自检 =', JSON.stringify(boot));

  /* 真实鼠标激活（末行右侧） */
  const g = await ev(() => { const v = window.mpEngine._view(); const els = [...v.contentDOM.querySelectorAll('.cm-line')]; const el = els[els.length - 1] || v.contentDOM; const b = el.getBoundingClientRect(); return { x: Math.min(window.innerWidth - 4, Math.round(b.right) + 10), y: Math.round(b.top + b.height / 2) }; });
  await page.mouse.click(g.x, g.y); await sleep(300);
  console.log('· 激活 =', JSON.stringify(await ev(() => { const v = window.mpEngine._view(); return { docFocus: document.hasFocus(), viewFocus: !!v.hasFocus }; })));

  async function reset(text, head) {
    return ev(([t, hp]) => {
      const v = window.mpEngine._view();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: (hp == null || hp < 0) ? t.length : hp } });
      v.focus();
      return { applied: v.state.doc.toString() === t, head: v.state.selection.main.head, docFocus: document.hasFocus(), viewFocus: !!v.hasFocus };
    }, [text, head]);
  }
  async function installTracer() {
    return ev(() => {
      const v = window.mpEngine._view();
      if (!window.__tr) window.__tr = { tx: [], ev: [] };
      if (!v.__origDispatch) {
        v.__origDispatch = v.dispatch.bind(v);
        v.dispatch = function (...args) {
          const t = window.__tr;
          let spec = '?', stack = null;
          try { spec = JSON.stringify(args).slice(0, 1400); } catch { spec = '<circular>'; }
          try { stack = String(new Error().stack || '').split('\n').slice(1, 7).join(' | ').slice(0, 700); } catch { stack = null; }
          t.tx.push({ at: 'B', doc: v.state.doc.toString(), head: v.state.selection.main.head, spec, stack });
          const r = v.__origDispatch(...args);
          t.tx.push({ at: 'A', doc: v.state.doc.toString(), head: v.state.selection.main.head });
          return r;
        };
      }
      if (!window.__trHooked) {
        window.__trHooked = true;
        const rec = (ph) => (e) => {
          window.__tr.ev.push({
            t: e.type, ph, key: e.key, inputType: e.inputType || null,
            data: e.data == null ? null : String(e.data).slice(0, 16), dp: e.defaultPrevented,
            cls: e.target && e.target.className ? String(e.target.className).slice(0, 22) : '',
          });
        };
        for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']) {
          document.addEventListener(t, rec('cap'), true);
          document.addEventListener(t, rec('bub'), false);
        }
      }
      window.__tr.tx.length = 0; window.__tr.ev.length = 0;
      return { hooked: true, hasOrig: !!v.__origDispatch };
    });
  }
  const dumpTrace = () => ev(() => ({ tx: window.__tr.tx.slice(0, 24), ev: window.__tr.ev.slice(0, 40), finalDoc: window.mpEngine._view().state.doc.toString() }));

  const out = { probe: 'list-continuation-2.cjs', probeVersion: 'rerun-paste-r2 (getClip BOM fix)', exe: EXE, exeSha16: R.sha16(EXE), at: new Date().toISOString(), trace: [], paste: [], extra: {}, pageErrors: [] };
  console.log('· 探针版本 = ' + out.probeVersion);
  const esc = (s) => JSON.stringify(String(s));

  /* ══════════ ① 回车事务 trace：四种落点 ══════════ */
  const VARIANTS = [
    { id: 'TR1', name: '整篇只有一行 `- `（第一轮 PASS 的那支）', doc: '- ', head: 2 },
    { id: 'TR2', name: '`- 甲\\n- `（第一轮 DIFF 的那支）', doc: '- 甲\n- ', head: 6 },
    { id: 'TR3', name: '`x\\n- `（空项前面是普通段落）', doc: 'x\n- ', head: 4 },
    { id: 'TR4', name: '`- \\n- 乙`（空项在首行，后面还有一项）', doc: '- \n- 乙', head: 2 },
    { id: 'TR5', name: '`x\\n- 甲\\n- `（空项在第 3 行）', doc: 'x\n- 甲\n- ', head: 8 },
    { id: 'TR6', name: '`- 甲\\n- ` 光标在**行首**（head=4，不是行尾）', doc: '- 甲\n- ', head: 4 },
    { id: 'TR7', name: '`- 甲\\n- ` 光标在 marker 中间（head=5）', doc: '- 甲\n- ', head: 5 },
    { id: 'TR8', name: '`- 甲\\n  - `（缩进的空子项）', doc: '- 甲\n  - ', head: 8 },
  ];
  for (const v of VARIANTS) {
    const st = await reset(v.doc, v.head);
    if (!st.applied) { out.trace.push({ ...v, err: 'setup-fail' }); continue; }
    await installTracer();
    await page.keyboard.press('Enter');
    await sleep(400);
    const tr = await dumpTrace();
    const rd = await readAll();
    const rec = { ...v, setupHead: st.head, after: rd.text, head: rd.head, lineNo: rd.lineNo, col: rd.col, trace: tr };
    out.trace.push(rec);
    console.log(`\n— ${v.id} ${v.name}`);
    console.log(`   setup ${esc(v.doc)} head=${st.head}  →  Enter  →  ${esc(rd.text)} head=${rd.head} 行=${rd.lineNo}`);
    console.log(`   事务 ${tr.tx.length} 笔：`);
    for (const t of tr.tx) {
      console.log(`     [${t.at}] doc=${esc(t.doc)} head=${t.head}`);
      if (t.spec) {
        const ann = /"annotations":\[(.*?)\],"effects"/.exec(t.spec);
        const chg = /"changes":(.*?),"selection"/.exec(t.spec);
        console.log(`          changes=${chg ? chg[1].slice(0, 200) : '?'}  annotations=${ann ? ann[1].slice(0, 200) : '?'}`);
      }
      if (t.stack) console.log(`          调用栈 = ${t.stack}`);
    }
    console.log(`   DOM 事件 ${tr.ev.length} 条：`);
    for (const e of tr.ev.slice(0, 12)) console.log(`     ${e.t}/${e.ph} key=${e.key} inputType=${e.inputType} data=${esc(e.data)} defaultPrevented=${e.dp} target=${e.cls}`);
  }

  /* ══════════ ② 剪贴板地面真值 + 粘贴通道 ══════════ */
  const clipPage = () => ev(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 50); } });
  const PASTE = '乙\n丙\n丁';
  out.extra.clipboardProbe = clipProbe();
  console.log('\n— 剪贴板可用性（主机侧 WinForms 往返）');
  console.log('   ' + JSON.stringify(out.extra.clipboardProbe));
  let clipUsable = !!out.extra.clipboardProbe.usable;
  if (clipUsable) {
    out.extra.hostSetClip = (() => { try { setClip(PASTE); return { back: getClip() }; } catch (e) { return { err: String((e && e.message) || e).slice(0, 120) }; } })();
    console.log('   主机 Set-Clipboard → Get-Clipboard = ' + JSON.stringify(out.extra.hostSetClip));
    clipUsable = !!(out.extra.hostSetClip && out.extra.hostSetClip.back === PASTE);
  }
  out.extra.pageReadTextWithHostClip = await clipPage();
  console.log('   页内 navigator.clipboard.readText() = ' + esc(out.extra.pageReadTextWithHostClip));

  /* PB0：页面能否看见主机剪贴板（既有 readText 的定性） */
  /* PB1：最简单的单行粘贴（对照臂：先证明"粘贴通道是否存在"） */
  async function doPaste(id, name, doc, head, seq) {
    const clipBefore = getClip();
    const st = await reset(doc, head);
    const pre = await readAll();
    const f = await ev(() => { const v = window.mpEngine._view(); return { docFocus: document.hasFocus(), viewFocus: !!v.hasFocus }; });
    await page.keyboard.press(seq);
    await sleep(600);
    const post = await readAll();
    const clipAfter = getClip();
    const rec = { id, name, doc, head, seq, clipBefore, clipAfter, focus: f, before: pre.text, after: post.text, headAfter: post.head, lineNo: post.lineNo, toasts: post.toasts, changed: pre.text !== post.text };
    out.paste.push(rec);
    console.log(`\n— ${id} ${name}`);
    console.log(`   setup ${esc(doc)} head=${head} | 剪贴板(主机)=${esc(clipBefore)} | 按键 ${seq}`);
    console.log(`   ${esc(pre.text)}  →  ${esc(post.text)}  ${rec.changed ? '✓ 有变化' : '✗ 没反应'}  (head=${post.head} 行=${post.lineNo}${post.toasts.length ? ' toast=' + esc(post.toasts.join('|')) : ''})`);
    console.log(`   粘贴后剪贴板(主机)=${esc(clipAfter)}${clipAfter !== clipBefore ? ' ⚠被改过（有别的进程在抢剪贴板）' : ''}`);
    return rec;
  }

  if (!clipUsable) {
    out.pasteSkipped = 'ENV-CLIPBOARD-UNAVAILABLE：本会话系统剪贴板不可用（WinForms Clipboard.SetText 抛 CLIPBRD_E_CANT_OPEN，'
      + 'Set-Clipboard 后 Get-Clipboard 回读为空；页内 navigator.clipboard.readText() 亦为空）⇒ 粘贴类用例**未验证**，'
      + '第一轮"Ctrl+V 没反应"的读数不能归因于产品（应用与探针同一会话，剪贴板同样不可用）。';
    console.log('\n· 剪贴板不可用 ⇒ 跳过 PB1..PB6 与 Ctrl+C 反向验证（记为未验证，不出"没反应"结论）');
  } else {
    await doPaste('PB1', '单行粘贴进空列表项（通道对照臂）', '- 甲\n- ', -1, 'Control+v');
    await doPaste('PB2', '多行粘贴进空列表项', '- 甲\n- ', -1, 'Control+v');
    await doPaste('PB3', '多行粘贴进非空列表项末尾', '- 甲', -1, 'Control+v');
    await doPaste('PB4', 'Ctrl+Shift+V（纯文本粘贴）进空列表项', '- 甲\n- ', -1, 'Control+Shift+v');

    /* PB5：右键菜单 → 粘贴（产品自己的通道，mpHost.paste） */
    {
      const clipBefore = () => getClip();
      const st = await reset('- 甲\n- ', -1);
      const pre = await readAll();
      const pt = await ev(() => {
        const v = window.mpEngine._view();
        const c = v.coordsAtPos(v.state.selection.main.head);
        const r = v.contentDOM.getBoundingClientRect();
        return { x: Math.round(c ? (c.left + c.right) / 2 : r.left + 60), y: Math.round(c ? c.top + 6 : r.top + 30) };
      });
      await page.mouse.click(pt.x, pt.y, { button: 'right' });
      await sleep(700);
      const menu = await ev(() => {
        const pops = [...document.querySelectorAll('[class*=mp-pop]')];
        const items = pops.flatMap((p) => [...p.querySelectorAll('*')]).filter((e) => !e.children.length && (e.textContent || '').trim())
          .map((e) => { const b = e.getBoundingClientRect(); return { txt: (e.textContent || '').trim().slice(0, 16), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width) }; });
        return { pops: pops.length, items: items.slice(0, 30) };
      });
      const pasteItem = (menu.items || []).find((i) => i.txt === '粘贴' || i.txt.startsWith('粘贴'));
      let clicked = null;
      if (pasteItem && pasteItem.w > 0) { await page.mouse.click(pasteItem.x, pasteItem.y); clicked = pasteItem; }
      await sleep(700);
      const post = await readAll();
      const rec = { id: 'PB5', name: '右键菜单 → 粘贴（mpHost.paste 通道）', clipBefore: clipBefore(), menu: { pops: menu.pops, items: (menu.items || []).map((i) => i.txt) }, clicked, before: pre.text, after: post.text, changed: pre.text !== post.text, overlays: post.overlays };
      out.paste.push(rec);
      console.log('\n— PB5 右键菜单 → 粘贴');
      console.log(`   菜单项 = ${JSON.stringify(rec.menu.items)} | 点到 = ${JSON.stringify(clicked)}`);
      console.log(`   ${esc(pre.text)}  →  ${esc(post.text)}  ${rec.changed ? '✓ 有变化' : '✗ 没反应'} | 残留浮层=${JSON.stringify(post.overlays)}`);
      /* 关掉可能残留的浮层（真实 Escape） */
      await page.keyboard.press('Escape'); await sleep(300);
    }

    /* PB6：`|` 起手多行（建表启发式） */
    out.extra.pipeSet = (() => { try { setClip('| a | b |\n| c | d |'); return { back: getClip() }; } catch (e) { return { err: String((e && e.message) || e).slice(0, 100) }; } })();
    console.log('\n— 剪贴板换成 `|` 起手多行：' + JSON.stringify(out.extra.pipeSet));
    await doPaste('PB6', '粘贴 `|` 起手多行（会不会被建表启发式转换）', '- 甲\n- ', -1, 'Control+v');

    /* ══════════ ③ 反向验证：app 自己的 Ctrl+C 到底写没写进系统剪贴板 ══════════ */
    const stc = await reset('甲乙丙', -1);
    await page.keyboard.press('Control+a'); await sleep(200);
    const preClip = getClip();
    await page.keyboard.press('Control+c'); await sleep(800);
    const postClip = getClip();
    const pageText = await clipPage();
    out.extra.appCopy = { selApplied: stc.applied, preClip, postClip, pageText };
    console.log('\n— app 内 Ctrl+A / Ctrl+C 是否写进系统剪贴板');
    console.log(`   复制前剪贴板=${esc(preClip)}  复制后=${esc(postClip)}  页内 readText=${esc(pageText)}`);
  }

  out.pageErrors = h.pageErrors.slice(0, 15);
  try {
    const log = path.join(RUN, 'profile', 'main-debug.log');
    out.extra.mainDebugLog = fs.existsSync(log) ? { bytes: fs.statSync(log).size, errors: fs.readFileSync(log, 'utf8').split('\n').filter((l) => /error|Error|异常/.test(l)).slice(-8) } : '缺失';
  } catch (e) { out.extra.mainDebugLog = 'ERR'; }

  const file = path.join(OUT, 'list-continuation-report2.rerun-paste.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  console.log('\n· 报告 =', file);
  console.log('· pageerror =', JSON.stringify(out.pageErrors));
  await h.closeAll();
  await sleep(800);
  process.exit(0);
})().catch(async (e) => {
  console.error('✗ 异常：', (e && e.stack) || e);
  if (CHILD_PID) { try { execFileSync('taskkill', ['/PID', String(CHILD_PID), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); console.error('· 已 taskkill ' + CHILD_PID); } catch { } }
  process.exit(1);
});
