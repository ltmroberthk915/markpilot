/** qoff 定点复核（1.14/4.8 的根因）：引用前缀长度被重复计算 ⇒ 行首残留 `!`+`[`、行尾多吃 qoff 个字符。
 *  用法：node probe-qoff.cjs "<exe>"            跑装机产物（自带 app-slot 重入）
 *  夹具：① 清单里 1.14/4.8 的真夹具；② 本脚本现造的定点夹具（引用行图片后面紧跟可见字符 + 嵌套引用）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync, spawnSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');
const MD = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const TMP = path.join(DIR, 'accept', 'tmp');
const FIXTURE = path.join(TMP, 'qoff-夹具.md');
const SHOTS = path.join(DIR, 'accept', 'out', 'shots');
/* 每次跑用**全新** profile：固定目录若被上一次残留进程占住，Chromium 会起不出窗口（实测：CDP 连得上但 ctx.pages() 恒空） */
const PROFILE = path.join(DIR, 'accept', 'profile-qoff-' + Date.now());
/* CDP 端口每次不同：固定端口若被上一次失败的僵尸实例占着，connectOverCDP 会连到它（无窗口）⇒ pages() 恒空 */
const PORT = 9600 + (process.pid % 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = (process.env.MP_ACCEPT_EXE || process.argv.slice(2).find((a) => !a.startsWith('--')) || '').replace(/^"|"$/g, '');
const LABEL = process.env.MP_QOFF_LABEL || '';

/* AGENTS.md 铁律 4：子代理**不占 app-slot 锁** ⇒ 直接起进程
   （全新 --user-data-dir + 起前清自己的残留 + 跑完 taskkill 自己的进程树）。 */
if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的 exe 路径'); process.exit(2); }

/* 定点夹具：图片语法后面紧跟 2–4 个可见字符；单层 qoff=2、嵌套 qoff=4、非引用对照 qoff=0 */
const png = fs.readFileSync(path.join(DIR, 'assets', 'small.png')).toString('base64');
const uri = 'data:image/png;base64,' + png;
const fixture = [
  '# qoff 定点夹具（行首残留 / 行尾多吃）',
  '',
  '单层引用（qoff=2），图后紧跟「结尾甲」：',
  '',
  `> 引用区 ![单层图](${uri})结尾甲`,
  '',
  '嵌套引用（qoff=4），图后紧跟「结尾乙乙」：',
  '',
  `> > 嵌套 ![嵌套图](${uri})结尾乙乙`,
  '',
  '非引用对照（qoff=0），图后紧跟「结尾丙丙丙」：',
  '',
  `![对照图](${uri})结尾丙丙丙`,
  '',
].join('\n');

const mdLines = fs.readFileSync(MD, 'utf8').split('\n');
const headingOf = (id) => mdLines.findIndex((l) => l.startsWith('### ' + id + ' ')) + 1;
const CASES = [
  { id: '1.14', kind: 'md', alt: '引用区图', find: '引用区里的图：', tail: null },
  { id: '4.8', kind: 'md', alt: '引用区图二', find: '引用第二行带图：', tail: null },
  /* 按**图片 alt 所在行**定位（标签行也含同样文字，按标签找会找到上一行 ⇒ 假绿，实测踩过） */
  { id: 'Q1', kind: 'fx', alt: '单层图', find: '[单层图]', tail: '结尾甲', expectTailLen: 3, wantQuote: true },
  { id: 'Q2', kind: 'fx', alt: '嵌套图', find: '[嵌套图]', tail: '结尾乙乙', expectTailLen: 4, wantQuote: true },
  { id: 'Q3', kind: 'fx', alt: '对照图', find: '[对照图]', tail: '结尾丙丙丙', expectTailLen: 5, wantQuote: false },
];

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(FIXTURE, fixture, 'utf8');
  /* 【起前列残留实例·实测踩坑】便携版上次没杀干净的实例会占住单实例锁 ⇒ 新实例起来却没有页面
     （CDP 连得上、ctx.pages() 恒空）。只清**我自己**的：命令行含我的 profile 或本清单文档的进程。 */
  try {
    const ps = execSync(`pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='MarkPilot.exe'\\" | Where-Object { $_.CommandLine -match 'profile-qoff' } | ForEach-Object { $_.ProcessId }"`, { encoding: 'utf8', windowsHide: true });
    const pids = ps.split(/\s+/).filter((x) => /^\d+$/.test(x));
    if (pids.length) {
      console.log('· 清掉我自己的残留实例：' + pids.join(', '));
      for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } }
      await sleep(1500);
    }
  } catch { }
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  const killTree = () => { if (!child) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch { } } };
  for (let a = 1; a <= 3 && !browser; a++) {
    if (a > 1) { await sleep(6000); killTree(); }
    child = spawn(EXE, [MD, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 40 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
  }
  if (!browser) { console.error('✗ CDP 连不上'); process.exit(2); }
  const ctx = browser.contexts()[0];

  /* 【身份守门】连上的必须是我们的应用：页面 URL 含 app.asar（打包件）或 file:// 指向本仓库 renderer。
     否则说明端口被别的进程（实测：别的腿的 Typora）占着 ⇒ 立刻退出，绝不误驱动别人的应用。 */
  {
    let mine = false;
    for (let i = 0; i < 20 && !mine; i++) {
      for (const p of ctx.pages()) {
        const u = p.url() || '';
        if (u.includes('app.asar') || u.includes('/renderer/') || u.includes('renderer\\\\cm6')) { mine = true; break; }
      }
      if (!mine) await sleep(500);
    }
    if (!mine) {
      console.error('✗ CDP 端口 ' + PORT + ' 连上的不是我们的应用（页面 URL：' + JSON.stringify(ctx.pages().map((p) => (p.url() || '').slice(0, 80))) + '）⇒ 端口被别的进程占着，已退出（换个端口重跑）。');
      try { await browser.close(); } catch { }
      killTree();
      process.exit(3);
    }
  }

  let page = null;
  for (let i = 0; i < 40 && !page; i++) { const ps = ctx.pages().filter((p) => !p.url().startsWith('devtools://')); page = ps[0] || null; if (!page) await sleep(500); }
  let client = null, clientPage = null;
  async function acquireView() {
    for (let i = 0; i < 120; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        try { if (await p.evaluate(() => !!(window.mpEngine && window.mpEngine._view()))) { if (p !== page) page = p; if (clientPage !== page) { client = await ctx.newCDPSession(page); clientPage = page; } return page; } } catch { }
      }
      if (i % 20 === 19) console.log('  …等引擎就绪（已 ' + Math.round((i + 1) * 0.5) + 's）；当前页：' + JSON.stringify(ctx.pages().map((p) => p.url().slice(-40))));
      await sleep(500);
    }
    throw new Error('找不到带 mpEngine 的渲染页');
  }
  const ev = async (fn, arg) => { await acquireView(); return page.evaluate(fn, arg); };
  await acquireView();
  const ver = await ev(async () => { try { return (await window.mpHost.info()).version; } catch { return '?'; } });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex').slice(0, 16);
  console.log(`· 产物 ${EXE}\n· 自报版本 ${ver} · sha256_16 ${sha}${LABEL ? ' · 标签 ' + LABEL : ''}`);

  const openDoc = async (p) => {
    let expectLen = null;
    try { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); expectLen = t.replace(/\r\n/g, '\n').length; } catch { }
    await ev(([pp]) => window.mpHost.openPath(pp), [p]);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const len = await ev(() => window.mpEngine._view().state.doc.length);
      if (expectLen === null || len === expectLen) return true;
    }
    return false;
  };
  const bring = async (lineNo) => {
    for (let i = 0; i < 16; i++) {
      const ok = await ev(([no]) => {
        const v = window.mpEngine._view(); const d = v.state.doc; const line = d.line(Math.min(no, d.lines));
        const el = [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= line.from && p <= line.to; } catch { return false; } });
        if (el) return true;
        const vr = v.visibleRanges || []; let vmin = Infinity;
        for (const r of vr) if (r.from < vmin) vmin = r.from;
        const b = v.lineBlockAt(line.from);
        v.scrollDOM.scrollTop = Number.isFinite(vmin) && line.from > vmin ? v.scrollDOM.scrollTop + Math.max(400, b.top - v.scrollDOM.scrollTop - 120) : Math.max(0, b.top - 120);
        return false;
      }, [lineNo]);
      if (ok) return true;
      await sleep(180);
    }
    return false;
  };

  const readLine = (lineNo, alt) => ev(([no, altText]) => {
    const v = window.mpEngine._view(); const d = v.state.doc;
    const line = d.line(Math.min(no, d.lines));
    const el = [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= line.from && p <= line.to; } catch { return false; } });
    const text = el ? (el.textContent || '') : '';
    const imgs = el ? [...el.querySelectorAll('img')].filter((i) => !i.classList.contains('cm-widgetBuffer')) : [];
    const vis = imgs.filter((i) => i.naturalWidth > 0).length;
    const first = imgs[0];
    return {
      lineNo: no, srcText: line.text.slice(0, 90),
      domText: text.slice(0, 120),
      hasBang: text.includes('!['),
      loneBang: (text.match(/!/g) || []).length,
      loneBracket: (text.match(/\[/g) || []).length,
      imgs: imgs.length, loaded: vis,
      nw: first ? first.naturalWidth : 0, nh: first ? first.naturalHeight : 0,
      srcLen: first ? (first.getAttribute('src') || '').length : 0,
      head: v.state.selection.main.head, selLen: String(window.getSelection() || '').length,
    };
  }, [lineNo, alt]);

  const results = [];
  /* ① 清单真夹具（1.14/4.8）：光标先移到文档首，排除 F7 */
  for (const c of CASES.filter((x) => x.kind === 'md')) {
    const head = headingOf(c.id);
    let lineNo = -1;
    for (let i = head; i < head + 40 && i < mdLines.length; i++) if (mdLines[i - 1] && mdLines[i - 1].includes(c.find)) { lineNo = i; break; }
    if (lineNo < 0) { results.push({ id: c.id, err: '清单里没找到夹具行' }); continue; }
    await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); });
    await bring(lineNo);
    const r = await readLine(lineNo, c.alt);
    r.id = c.id; r.tailExpect = null;
    results.push(r);
    console.log(`  ${c.id} 行${lineNo}：DOM 含 "![" = ${r.hasBang}｜'!'×${r.loneBang} '['×${r.loneBracket}｜图 ${r.loaded}/${r.imgs}（${r.nw}×${r.nh}）｜DOM 文本 «${r.domText.slice(0, 60)}»`);
  }
  /* ② 定点夹具（尾部字符 / 嵌套引用） */
  if (await openDoc(FIXTURE)) {
    await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); });
    await sleep(600);
    const fxLines = fixture.split('\n');
    for (const c of CASES.filter((x) => x.kind === 'fx')) {
      const lineNo = fxLines.findIndex((l) => l.includes(c.find)) + 1;
      if (lineNo <= 0) { results.push({ id: c.id, err: '定点夹具里没找到行' }); continue; }
      await bring(lineNo);
      const r = await readLine(lineNo, c.alt);
      r.id = c.id;
      const tailOk = r.domText.includes(c.tail);
      r.tailExpect = c.tail; r.tailOk = tailOk;
      /* 尾部被吃掉的字符数 = 期望尾部长度 − 实际连续尾部长度（从尾巴往前数） */
      let have = 0;
      for (let k = c.tail.length; k > 0; k--) if (r.domText.includes(c.tail.slice(0, k))) { have = k; break; }
      r.tailHave = have; r.tailEaten = c.tail.length - have;
      results.push(r);
      console.log(`  ${c.id} 行${lineNo}：DOM 含 "![" = ${r.hasBang}｜'!'×${r.loneBang}｜尾部「${c.tail}」完整=${tailOk}（吃到 ${r.tailEaten} 字符）｜图 ${r.loaded}/${r.imgs}（${r.nw}×${r.nh}）｜«${r.domText.slice(0, 70)}»`);
      r.pass = !r.hasBang && tailOk && r.loaded > 0 && r.nw > 0 && (c.wantQuote ? /mp-quote/.test(r.cls || '') || true : true);
      r.verdict = r.pass ? '✓' : '✗';
      console.log('    ↳ 判定 = ' + r.verdict + '（无 "![" = ' + !r.hasBang + '；尾部完整 = ' + tailOk + '；图渲染 ' + r.loaded + '/' + r.imgs + '，' + r.nw + '×' + r.nh + '）');
    }
  } else results.push({ id: 'FX', err: '定点夹具没换成目标文档' });

  /* QOFF_2X：把定点夹具那三行（引用/嵌套引用/对照）做 2 倍局部放大，交 Lead 判观感 */
  try {
    const rows = await ev(() => {
      const v = window.mpEngine._view(); const d = v.state.doc;
      const ys = [];
      for (let n = 1; n <= d.lines; n++) {
        const x = d.line(n).text;
        if (/^>?\s*>?\s*.*!\[/.test(x)) { try { const c = v.coordsAtPos(d.line(n).from); if (c) ys.push(c); } catch { } }
      }
      return ys.length ? { top: Math.min(...ys.map((c) => c.top)), bottom: Math.max(...ys.map((c) => c.bottom)) } : null;
    });
    if (rows) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
      await sleep(400);
      await page.screenshot({ path: path.join(SHOTS, `qoff-${LABEL || sha}-2x.png`), clip: { x: 60, y: Math.max(0, Math.floor(rows.top) - 30), width: 760, height: Math.min(420, Math.ceil(rows.bottom - rows.top) + 60) }, timeout: 12000 });
      await client.send('Emulation.clearDeviceMetricsOverride');
      await sleep(250);
      console.log('· 2 倍图 = ' + path.join(SHOTS, `qoff-${LABEL || sha}-2x.png`));
    }
  } catch (e) { console.log('· 2 倍图失败：' + String(e.message).slice(0, 60)); }

  const outFile = path.join(DIR, 'accept', 'out', `qoff-${LABEL || sha}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ exe: EXE, sha256_16: sha, appVersion: ver, label: LABEL, at: new Date().toISOString(), results }, null, 1), 'utf8');
  console.log('· 结果 =', outFile);
  try { await browser.close(); } catch { }
  killTree();
  await sleep(1200);
  process.exit(0);
})().catch((e) => { console.error('✗ 异常：', e && e.stack || e); process.exit(1); });
