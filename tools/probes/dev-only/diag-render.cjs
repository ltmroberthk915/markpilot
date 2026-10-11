/** 定点诊断：某条夹具（默认 2.13）为什么"找不到容器"——把渲染窗口、容器清单、domAtPos 全打出来。
 *  用法：node app-slot.cjs -- node diag-render.cjs [条目id]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..', '..');
const EXE = process.env.MP_EXE || path.join(ROOT, 'MarkPilot-CM6', 'dist', 'markpilot-3.0.6-portable.exe');
const DOC = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const PROFILE = path.join(__dirname, 'profile-diag2');
const PORT = 9597;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARG = process.argv.slice(2).find((a) => !a.startsWith('--') && /^[0-9A-Za-z]/.test(a)) || '2.13';
const item = /^\d+$/.test(ARG)
  ? { id: 'line:' + ARG, from: Number(ARG), to: Number(ARG), kind: '(直接给行号)' }
  : JSON.parse(fs.readFileSync(path.join(__dirname, 'items.json'), 'utf8')).items.find((x) => x.id === ARG);

(async () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch { }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child = null, browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    if (a > 1) { await sleep(6000); try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } }
    child = spawn(EXE, [DOC, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 30 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
  }
  if (!browser) { console.log('✗ 连不上'); process.exit(2); }
  const page = browser.contexts()[0].pages()[0];
  for (let i = 0; i < 60; i++) { const ok = await page.evaluate(() => !!(window.mpEngine && window.mpEngine._view())).catch(() => false); if (ok) break; await sleep(500); }
  await sleep(1200);

  console.log(`· 目标 ${item.id} 夹具行 ${item.from}–${item.to}，kind=${item.kind}`);
  const dump = await page.evaluate(([from, to]) => {
    const v = window.mpEngine._view();
    const doc = v.state.doc;
    const a = doc.line(from).from, b = doc.line(to).to;
    const blk = v.lineBlockAt(a);
    v.scrollDOM.scrollTop = Math.max(0, blk.top - 120);
    const out = { a, b, blkTop: blk.top, blkH: blk.height, scrollTop: v.scrollDOM.scrollTop,
      sh: v.scrollDOM.scrollHeight, ch: v.scrollDOM.clientHeight,
      srcText: doc.sliceString(a, Math.min(b, a + 200)),
      visibleRanges: v.visibleRanges.map((r) => [r.from, r.to]) };
    return out;
  }, [item.from, item.to]);
  console.log('· 落点 =', JSON.stringify(dump, null, 1));
  await sleep(600);
  const after = await page.evaluate(([from, to]) => {
    const v = window.mpEngine._view();
    const doc = v.state.doc;
    const a = doc.line(from).from;
    const kids = [...v.contentDOM.children].map((el) => {
      let p = null, q = null;
      try { p = v.posAtDOM(el, 0); } catch (e) { p = 'ERR'; }
      try { q = v.posAtDOM(el, el.childNodes.length); } catch (e) { q = 'ERR'; }
      return { cls: String(el.className).slice(0, 40), p, q, txt: (el.textContent || '').slice(0, 22) };
    });
    let domInfo = null;
    try {
      const d = v.domAtPos(a);
      let el = d.node && d.node.nodeType === 1 ? d.node : (d.node ? d.node.parentElement : null);
      const chain = [];
      while (el && chain.length < 6) { chain.push(String(el.className || el.nodeName).slice(0, 30)); el = el.parentElement; }
      domInfo = { nodeType: d.node && d.node.nodeType, chain };
    } catch (e) { domInfo = { err: String(e.message) }; }
    return { scrollTop: v.scrollDOM.scrollTop, kids, domInfo, hasSrc: v.contentDOM.textContent.includes(doc.sliceString(a, a + 24)) };
  }, [item.from, item.to]);
  console.log('· 渲染后 scrollTop =', after.scrollTop, ' 目标文本在 DOM 里 =', after.hasSrc);
  console.log('· domAtPos(目标) =', JSON.stringify(after.domInfo));
  console.log('· 容器清单（共 ' + after.kids.length + '）：');
  for (const k of after.kids) console.log(`   p=${k.p} q=${k.q} [${k.cls}] «${k.txt}»`);
  try { await browser.close(); } catch { }
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(800);
  process.exit(0);
})();
