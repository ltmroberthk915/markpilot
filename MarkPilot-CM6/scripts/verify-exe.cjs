/** 装机产物验收：直接跑**打包后的 portable EXE**（不是开发态），CDP 接入做真实输入与落盘验证。
 *  判据与开发态一致：① 引擎 boot 且文档载入 ② 内存/磁盘一致 ③ 真实键盘输入 → 防抖落盘 ④ 0 错误
 *  用法：node verify-exe.cjs [exe路径]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');

const APP = path.resolve(__dirname, '..');
const EXE = process.argv[2] || path.join(APP, 'dist', 'markpilot-3.0.0-portable.exe');
const DOC = path.resolve(APP, '..', '.mp-verify', 'exe-smoke.md');
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  fs.writeFileSync(DOC, '# 装机冒烟\n\n打包产物原始一行。\n', 'utf8');
  if (!fs.existsSync(EXE)) { log('找不到 EXE:', EXE); process.exit(2); }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [DOC, `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdio = '';
  child.stdout.on('data', (d) => { stdio += d.toString(); });
  child.stderr.on('data', (d) => { stdio += d.toString(); });

  let browser = null;
  try {
    for (let i = 0; i < 60; i++) { // portable 每次要解包，启动慢
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break; } catch { await sleep(1000); }
    }
    if (!browser) throw new Error('CDP 连接失败');
    const ctx = browser.contexts()[0];
    let page = null;
    for (let i = 0; i < 30 && !page; i++) { page = ctx.pages().find((p) => !p.url().startsWith('devtools://')); if (!page) await sleep(500); }
    if (!page) throw new Error('没找到窗口');
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 160)));

    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      const ok = await page.evaluate(() => { const v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null; return !!(v && v.state.doc.length > 0); }).catch(() => false);
      if (ok) break; await sleep(500);
    }
    const bootMs = Date.now() - t0;
    const boot = await page.evaluate(() => { const v = window.mpEngine._view(); return { doc: v.state.doc.toString(), lines: v.state.doc.lines, title: document.title, ua: navigator.userAgent }; });
    log('① 引擎+文档:', boot.lines > 0 ? `OK（握手耗时 ≈${bootMs}ms）` : '失败');
    log('   文档:', JSON.stringify(boot.doc));
    log('   标题:', JSON.stringify(boot.title));
    log('   运行时:', boot.ua.replace(/^Mozilla\/5\.0 /, '').slice(0, 90));

    const disk0 = fs.readFileSync(DOC, 'utf8');
    log('② 磁盘/内存一致:', disk0.trim() === boot.doc.trim() ? '✅' : '❌');

    await page.evaluate(() => { try { window.mpEngine.focus(); } catch { } });
    await page.click('#editor .cm-content', { position: { x: 60, y: 10 }, delay: 35 }).catch(() => { });
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('装机版键入：中文与公式 $e^{i\\pi}+1=0$。', { delay: 30 });
    await sleep(1800);
    const disk1 = fs.readFileSync(DOC, 'utf8');
    const ok2 = disk1.includes('装机版键入：中文与公式');
    log('③ 真实输入 → 落盘:', ok2 ? '✅' : '❌');
    log('   磁盘尾:', JSON.stringify(disk1.slice(-70)));
    log('④ console error:', errs.length, errs.slice(0, 3));

    const all = boot.lines > 0 && disk0.trim() === boot.doc.trim() && ok2 && errs.length === 0;
    log('总判定:', all ? '✅ 装机产物全绿' : '❌ 有红项');
    await browser.close().catch(() => { });
    child.kill();
    await sleep(600);
    process.exit(all ? 0 : 1);
  } catch (e) {
    log('FATAL', String(e && e.stack || e).slice(0, 300));
    try { await browser?.close(); } catch { }
    child.kill();
    log('stdio:', stdio.slice(-300));
    process.exit(2);
  }
})();
