/** 行号计数机制分诊：分清「data-mp-n 属性」与「CSS 计数器（屏幕上真正画出来的号）」。
 *  用法：node probe-lineno-counter.cjs "<exe>" [标签]
 *  产出：accept/out/lineno-counter-<标签>.json（含夹具路径/mtime、包 sha、每次读数时间戳）
 *        + accept/out/shots/lineno-counter-2x.png（**同一次运行、同一夹具**的 2 倍图）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync, spawnSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');
const TMP = path.join(DIR, 'accept', 'tmp');
const SHOTS = path.join(DIR, 'accept', 'out', 'shots');
const PROFILE = path.join(DIR, 'accept', 'profile-lineno');
const PORT = 9603;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = (process.env.MP_ACCEPT_EXE || process.argv.slice(2).find((a) => !a.startsWith('--')) || '').replace(/^"|"$/g, '');
const LABEL = process.argv.slice(2).filter((a) => !a.startsWith('--'))[1] || process.env.MP_LN_LABEL || 'run';

/* AGENTS.md 铁律 4：子代理**不占 app-slot 锁** ⇒ 直接起进程
   （全新 --user-data-dir + 起前清自己的残留 + 跑完 taskkill 自己的进程树）。 */
if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的 exe 路径'); process.exit(2); }

/* 夹具：两个互不相邻的围栏块 + 一个引用区围栏块（正是清单 7.1 的判据形态） */
const FX = [
  '# 行号计数分诊夹具',
  '',
  '第一块（期望 1/2/3）：',
  '',
  '```js',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '中间隔着普通段落，两块互不相邻。',
  '',
  '第二块（期望**也从 1 起**）：',
  '',
  '```js',
  'const c = 3;',
  'const d = 4;',
  '```',
  '',
  '第三块在引用区里（期望也从 1 起）：',
  '',
  '> ```js',
  '> const e = 5;',
  '> const f = 6;',
  '> ```',
  '',
].join('\n');

(async () => {
  fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
  const fxPath = path.join(TMP, 'lineno-counter-夹具.md');
  fs.writeFileSync(fxPath, FX, 'utf8');
  const fxStat = fs.statSync(fxPath);
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  const killTree = () => { if (!child) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { try { child.kill(); } catch { } } };
  for (let a = 1; a <= 3 && !browser; a++) {
    if (a > 1) { await sleep(6000); killTree(); }
    child = spawn(EXE, [fxPath, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
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

  let page = null, client = null, clientPage = null;
  async function acquireView() {
    for (let i = 0; i < 120; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        try { if (await p.evaluate(() => !!(window.mpEngine && window.mpEngine._view()))) { if (p !== page) page = p; if (clientPage !== page) { client = await ctx.newCDPSession(page); clientPage = page; } return page; } } catch { }
      }
      await sleep(500);
    }
    throw new Error('找不到带 mpEngine 的渲染页');
  }
  const ev = async (fn, arg) => { await acquireView(); return page.evaluate(fn, arg); };
  /* AGENTS.md 交互总规则·二：按键/点击类读数前先断言焦点在编辑面（焦点不在时读数全假） */
  const assertFocus = async () => {
    try {
      const f = await ev(() => ({ hasFocus: document.hasFocus(), inEditor: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-editor')) }));
      console.log(`· 焦点断言：document.hasFocus()=${f.hasFocus}，activeElement 在 .cm-editor 内=${f.inEditor}`);
      return f;
    } catch (e) { console.log('· 焦点断言失败：' + String(e.message).slice(0, 60)); return { hasFocus: false, inEditor: false }; }
  };
  await acquireView();
  await sleep(1200);
  await assertFocus();
  const sha = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex').slice(0, 16);
  const ver = await ev(async () => { try { return (await window.mpHost.info()).version; } catch { return '?'; } });
  const loaded = await ev(() => window.mpEngine._view().state.doc.length);

  const t1 = new Date().toISOString();
  const dump = await ev(() => {
    const v = window.mpEngine._view();
    const rows = [...v.contentDOM.children].map((el) => ({
      cls: String(el.className), n: el.getAttribute('data-mp-n'),
      text: (el.textContent || '').slice(0, 22),
      beforeContent: getComputedStyle(el, '::before').content,
      beforeAlign: getComputedStyle(el, '::before').textAlign,
      counterReset: getComputedStyle(el).counterReset,
      counterIncrement: getComputedStyle(el).counterIncrement,
    }));
    /* CSSOM：把所有提到 mp-code-line 的规则原样抓出来（看计数器在哪儿 reset/increment） */
    const rules = [];
    try {
      for (const ss of document.styleSheets) {
        let rs = [];
        try { rs = [...ss.cssRules]; } catch { continue; }
        for (const r of rs) {
          const t = r.cssText || '';
          if (t.includes('mp-code-line') || t.includes('data-mp-n')) rules.push(t.slice(0, 400));
        }
      }
    } catch { }
    /* 也找带 data-mp-n 的选择器规则 */
    return { rows, cssRules: rules.slice(0, 40), docLines: v.state.doc.lines };
  });
  const t2 = new Date().toISOString();
  console.log(`· 产物 ${path.basename(EXE)} sha16 ${sha} 版本 ${ver}；夹具 ${fxPath}（${fxStat.size} B，写于 ${fxStat.mtime.toISOString()}）；引擎实载 ${loaded} 字符`);
  console.log(`· dump 时间 ${t1}`);
  for (const r of dump.rows) {
    if (/mp-code|mp-fence/.test(r.cls)) console.log(`   ${r.n === null ? '—' : r.n}  ${r.cls.slice(0, 40).padEnd(40)} «${r.text}»  ::before=${r.beforeContent} reset=${r.counterReset} inc=${r.counterIncrement}`);
  }
  console.log('· CSS 规则里与行号相关的：');
  for (const r of dump.cssRules) console.log('   ' + r.replace(/\s+/g, ' ').slice(0, 220));
  /* 同一次运行、同一夹具：2 倍图 */
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, `lineno-counter-2x-${LABEL}.png`), timeout: 12000 });
  const t3 = new Date().toISOString();
  await client.send('Emulation.clearDeviceMetricsOverride');
  console.log(`· 2 倍图 ${path.join(SHOTS, `lineno-counter-2x-${LABEL}.png`)}（拍于 ${t3}，与上面 dump **同一次运行、同一夹具**）`);
  fs.writeFileSync(path.join(DIR, 'accept', 'out', `lineno-counter-${LABEL}.json`),
    JSON.stringify({ exe: EXE, sha256_16: sha, appVersion: ver, fixture: fxPath, fixtureMtime: fxStat.mtime.toISOString(), fixtureBytes: fxStat.size, loadedChars: loaded, dumpAt: t1, shotAt: t3, dump }, null, 1), 'utf8');
  try { await browser.close(); } catch { }
  killTree(); await sleep(1200);
  process.exit(0);
})().catch((e) => { console.error('✗ 异常：', e && e.stack || e); process.exit(1); });
