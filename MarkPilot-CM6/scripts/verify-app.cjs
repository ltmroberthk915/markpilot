/** MarkPilot 桌面版冒烟验收（开发态，CDP 接进 Electron）：
 *  ① 应用能起来，引擎 boot 成功（window.mpEngine._view() 可用）
 *  ② 打开传入的 markdown 副本：文档内容与磁盘一致
 *  ③ **真实键盘**打一段中文 + 公式，等防抖保存 → **回读磁盘**必须含新内容（端到端落盘）
 *  ④ 标题脏标出现/消失、无错误条、0 console error
 *  ⑤ 关闭应用（自动化收尾，避免残留进程）
 *  用法：node verify-app.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');

const APP = path.resolve(__dirname, '..');
const DOC = path.resolve(APP, '..', '.mp-verify', 'app-smoke.md');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.writeFileSync(DOC, '# 冒烟\n\n原始一行。\n', 'utf8');

  // 关键：本机开发环境带 ELECTRON_RUN_AS_NODE=1（DSH 宿主设的），
  // 不清掉的话 electron.exe 会以纯 Node 模式启动，require('electron') 只拿到二进制路径。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', DOC, `--remote-debugging-port=${PORT}`], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdio = '';
  child.stdout.on('data', (d) => { stdio += d.toString(); });
  child.stderr.on('data', (d) => { stdio += d.toString(); });

  let browser = null;
  try {
    for (let i = 0; i < 30; i++) { // 等 CDP 端口
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); break; } catch { await sleep(1000); }
    }
    if (!browser) throw new Error('CDP 连接失败（应用没起来？）');
    const ctx = browser.contexts()[0];
    let page = null;
    for (let i = 0; i < 20 && !page; i++) { page = ctx.pages().find((p) => !p.url().startsWith('devtools://')); if (!page) await sleep(500); }
    if (!page) throw new Error('没有找到应用窗口');
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errs.push('pageerror:' + String(e).slice(0, 160)));

    for (let i = 0; i < 30; i++) { // 等引擎 boot **且**文档握手完成（boot 与 pull 是两步）
      const ok = await page.evaluate(() => {
        const v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null;
        return !!(v && v.state.doc.length > 0);
      }).catch(() => false);
      if (ok) break; await sleep(500);
    }
    const boot = await page.evaluate(() => {
      const v = window.mpEngine && window.mpEngine._view ? window.mpEngine._view() : null;
      return v ? { doc: v.state.doc.toString(), lines: v.state.doc.lines, title: document.title } : null;
    });
    log('① boot:', boot ? `OK lines=${boot.lines}` : '失败');
    log('   文档:', JSON.stringify(boot && boot.doc));
    log('   标题:', JSON.stringify(boot && boot.title));
    const diag = await page.evaluate(async () => ({
      dbg: window.__mpDbg || null,
      pull: await window.mpHost.currentDoc().catch((e) => 'ERR:' + e.message),
      ready: await window.mpHost.docReady().catch((e) => 'ERR:' + e.message),
    }));
    log('   诊断:', JSON.stringify(diag).slice(0, 400));
    await sleep(400);
    const after = await page.evaluate(() => { const v = window.mpEngine._view(); return { doc: v.state.doc.toString(), dbg: window.__mpDbg || null }; });
    log('   握手后文档:', JSON.stringify(after.doc), 'dbg:', JSON.stringify(after.dbg));

    const disk0 = fs.readFileSync(DOC, 'utf8');
    log('② 磁盘/内存一致:', disk0.trim() === (boot.doc || '').trim() ? '✅' : `❌ 磁盘=${JSON.stringify(disk0)}`);

    // ③ 真实键盘输入（中文 + 行内公式 + 块公式）
    //    先把焦点交给编辑面（等价于真人点一下编辑区），随后全部走真实键盘。
    await page.evaluate(() => { try { window.mpEngine.focus(); } catch { } });
    await page.click('#editor .cm-content', { position: { x: 60, y: 10 }, delay: 35 }).catch(() => { });
    await page.evaluate(() => { try { window.mpEngine.focus(); } catch { } });
    await sleep(200);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新增一行：中文与公式 $a^2+b^2=c^2$。', { delay: 30 });
    await sleep(1800); // 等 500ms 防抖 + 落盘

    const disk1 = fs.readFileSync(DOC, 'utf8');
    const hasMarker = disk1.includes('新增一行：中文与公式');
    const hasFormula = disk1.includes('$a^2+b^2=c^2$');
    const ups = await page.evaluate(() => (window.__mpDbg && window.__mpDbg.ups) || []);
    log('③ 落盘含新内容:', hasMarker && hasFormula ? '✅' : `❌ marker=${hasMarker} formula=${hasFormula}`);
    log('   上行事件:', JSON.stringify(ups));
    log('   磁盘尾:', JSON.stringify(disk1.slice(-90)));
    const title1 = await page.title();
    log('④ 标题:', JSON.stringify(title1));
    const banner = await page.evaluate(() => { const b = document.getElementById('mp-banner'); return b && b.style.display !== 'none' ? b.textContent : null; });
    log('   错误条:', banner === null ? '无 ✅' : JSON.stringify(banner));
    log('   console error:', errs.length, errs.slice(0, 3));

    // ⑤ 关窗
    const okAll = !!boot && disk0.trim() === (boot.doc || '').trim() && hasMarker && hasFormula && errs.length === 0 && banner === null;
    log('总判定:', okAll ? '✅ 全绿' : '❌ 有红项');
    await browser.close().catch(() => { });
    child.kill();
    await sleep(800);
    log('应用已退出, stdio 尾:', JSON.stringify(stdio.slice(-200)));
    process.exit(okAll ? 0 : 1);
  } catch (e) {
    log('FATAL', String(e && e.stack || e).slice(0, 400));
    try { await browser?.close(); } catch { }
    child.kill();
    log('stdio:', stdio.slice(-400));
    process.exit(2);
  }
})();
