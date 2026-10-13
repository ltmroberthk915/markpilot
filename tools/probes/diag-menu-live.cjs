/** 只读定点：在装机件上量"页面实际加载的 app.js"（resource timing 的 decodedBodySize）与「更多」菜单的原始 HTML，
 *  用来判定"包里的新码 vs 运行时行为"是否一致。用法：node diag-menu-live.cjs "<exe>" [标签]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const DIR = __dirname, ROOT = path.resolve(DIR, '..', '..');
const MD = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const PORT = 9700 + (process.pid % 200);
const PROFILE = path.join(DIR, 'accept', 'profile-live-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = (process.env.MP_ACCEPT_EXE || process.argv.slice(2).find((a) => !a.startsWith('--')) || '').replace(/^"|"$/g, '');
const LABEL = process.argv.slice(2).filter((a) => !a.startsWith('--'))[1] || 'live';
if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的 exe 路径'); process.exit(2); }

(async () => {
  // 起前清自己的残留
  try {
    const ps = execSync(`pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='MarkPilot.exe'\\" | Where-Object { $_.CommandLine -match 'profile-live-' } | ForEach-Object { $_.ProcessId }"`, { encoding: 'utf8', windowsHide: true });
    for (const pid of ps.split(/\s+/).filter((x) => /^\d+$/.test(x))) { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } }
  } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  const killTree = () => { if (!child) return; try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };
  for (let a = 1; a <= 3 && !browser; a++) {
    if (a > 1) { await sleep(5000); killTree(); }
    child = spawn(EXE, [MD, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 40 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
  }
  if (!browser) { console.error('✗ CDP 连不上'); process.exit(2); }
  const ctx = browser.contexts()[0];
  let page = null, client = null, clientPage = null;
  const acquire = async () => {
    for (let i = 0; i < 120; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        try { if (await p.evaluate(() => !!(window.mpEngine && window.mpEngine._view()))) { if (p !== page) page = p; if (clientPage !== page) { client = await ctx.newCDPSession(page); clientPage = page; } return page; } } catch { }
      }
      await sleep(500);
    }
    throw new Error('找不到 mpEngine 页');
  };
  const ev = async (fn, arg) => { await acquire(); return page.evaluate(fn, arg); };
  await acquire();
  await sleep(1200);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex').slice(0, 16);
  const ver = await ev(async () => { try { return (await window.mpHost.info()).version; } catch { return '?'; } });
  const loaded = await ev(() => {
    const rs = performance.getEntriesByType('resource').filter((r) => /app\.js/.test(r.name)).map((r) => ({ name: r.name.slice(-60), decoded: r.decodedBodySize, transfer: r.transferSize, dur: Math.round(r.duration) }));
    return { resources: rs, url: location.href.slice(-70), mpHostReload: typeof (window.mpHost && window.mpHost.reload), mpHostPick: typeof (window.mpHost && window.mpHost.pickImages) };
  });
  console.log(`· 产物 ${path.basename(EXE)} sha16 ${sha} 版本 ${ver}`);
  console.log(`· 页面 ${loaded.url}`);
  console.log(`· mpHost.reload=${loaded.mpHostReload} / mpHost.pickImages=${loaded.mpHostPick}`);
  console.log(`· 实际加载的 app.js：${JSON.stringify(loaded.resources)}`);
  /* 打开「更多」菜单并 dump 原始 HTML 片段 */
  const pos = await ev(() => { const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="more"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
  if (!pos) { console.log('✗ 找不到 more 按钮'); } else {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(700);
    const info = await ev(() => {
      const pops = [...document.querySelectorAll('.mp-pop')];
      const first = pops[0];
      const items = first ? [...first.querySelectorAll(':scope > .mp-pop-item')].map((el) => (el.textContent || '').trim()) : [];
      return { popCount: pops.length, itemCount: items.length, items, hasReload: first ? (first.textContent || '').includes('重新加载') : null, html: first ? first.outerHTML.slice(0, 1200) : null };
    });
    console.log(`· .mp-pop 个数=${info.popCount}；直接子项 ${info.itemCount} 条：${JSON.stringify(info.items)}`);
    console.log(`· 弹层文本含「重新加载」=${info.hasReload}`);
    console.log(`· 原始 HTML 头 1200 字：\n${info.html}`);
  }
  fs.writeFileSync(path.join(DIR, 'accept', 'out', `live-menu-${LABEL}.json`), JSON.stringify({ exe: EXE, sha256_16: sha, appVersion: ver, loaded, info: null }, null, 1), 'utf8');
  try { await browser.close(); } catch { }
  killTree(); await sleep(1000);
  process.exit(0);
})().catch((e) => { console.error('✗ 异常：', e && e.stack || e); process.exit(1); });
