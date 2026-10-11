/** 定点复核：1.14「图片在引用区里」/ 4.8「引用里含图片」的"行内残留字面图片源码"。
 *  要排掉的是 F7 假红：**光标落在图片标记内、且 src ≤ 512 ⇒ 露出源码是既定行为**。
 *  做法：同一行在两种光标状态下各读一次 DOM（含 `![` 吗、字面源码实占尺寸、有无选区），并各截一张 **2 倍**图交 Lead 判。
 *  用法：node app-slot.cjs -- node probe-cursor-state.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync, spawnSync } = require('node:child_process');
const { chromium } = require('../quality/dependencies.cjs').playwright();

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');
const MD = path.join(ROOT, '.mp-verify', 'demo', '验收清单.md');
const SHOTS = path.join(DIR, 'accept', 'out', 'shots');
const PROFILE = path.join(DIR, 'accept', 'profile-cursor');
const PORT = 9599;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || process.env.MP_ACCEPT_EXE || '').replace(/^"|"$/g, '');

/* AGENTS.md 铁律 4：子代理**不占 app-slot 锁** ⇒ 直接起进程
   （全新 --user-data-dir + 起前清自己的残留 + 跑完 taskkill 自己的进程树）。 */
if (!EXE || !fs.existsSync(EXE)) { console.error('✗ 给个存在的装机产物路径'); process.exit(2); }

/* 目标：清单里 1.14 / 4.8 的夹具行（用 src 里的 alt 定位 mark） */
const CASES = [
  { id: '1.14', alt: '引用区图', find: '引用区里的图：' },
  { id: '4.8', alt: '引用区图二', find: '引用第二行带图：' },
];

const mdLines = fs.readFileSync(MD, 'utf8').split('\n');
const headingOf = (id) => mdLines.findIndex((l) => l.startsWith('### ' + id + ' ')) + 1;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
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
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { const ps = ctx.pages().filter((p) => !p.url().startsWith('devtools://')); page = ps[0] || null; if (!page) await sleep(500); }
  let client = null, clientPage = null;
  async function acquireView() {
    for (let i = 0; i < 30; i++) {
      for (const p of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
        try { if (await p.evaluate(() => !!(window.mpEngine && window.mpEngine._view()))) { if (p !== page) page = p; if (clientPage !== page) { client = await ctx.newCDPSession(page); clientPage = page; } return page; } } catch { }
      }
      await sleep(500);
    }
    throw new Error('找不到带 mpEngine 的渲染页');
  }
  const ev = async (fn, arg) => { await acquireView(); return page.evaluate(fn, arg); };
  await acquireView();
  console.log('· 产物 =', EXE, '| 自报版本 =', await ev(async () => { try { return (await window.mpHost.info()).version; } catch { return '?'; } }));

  const out = [];
  for (const c of CASES) {
    const head = headingOf(c.id);
    const fixtureLine = (() => { for (let i = head; i < head + 40 && i < mdLines.length; i++) if (mdLines[i - 1] && mdLines[i - 1].includes(c.find)) return i; return -1; })();
    if (fixtureLine < 0) { out.push({ id: c.id, err: '没在清单里找到夹具行' }); continue; }
    // 1) 滚到该行（收敛式）
    for (let i = 0; i < 14; i++) {
      const done = await ev(([no]) => {
        const v = window.mpEngine._view(); const d = v.state.doc;
        const target = d.line(Math.min(no, d.lines)).from;
        let rendered = false;
        for (const el of v.contentDOM.children) { try { const p = v.posAtDOM(el, 0); if (p >= target && p <= d.line(Math.min(no, d.lines)).to) { rendered = true; break; } } catch { } }
        if (!rendered) { const vr = v.visibleRanges || []; let vmin = Infinity, vmax = -Infinity; for (const r of vr) { if (r.from < vmin) vmin = r.from; if (r.to > vmax) vmax = r.to; } const b = v.lineBlockAt(target); v.scrollDOM.scrollTop = (!Number.isFinite(vmin) || target < vmin) ? Math.max(0, b.top - 120) : v.scrollDOM.scrollTop + Math.max(400, b.top - v.scrollDOM.scrollTop - 120); }
        return rendered;
      }, [fixtureLine]);
      if (done) break;
      await sleep(200);
    }
    const probe = async (mode) => ev(([no, altText, mode]) => {
      const v = window.mpEngine._view(); const d = v.state.doc; const docStr = d.toString();
      const headPos = v.state.selection.main.head;
      const line = d.line(Math.min(no, d.lines));
      // 找该行里图片 mark 的源码区间
      const lineText = line.text;
      const bang = lineText.indexOf('![');
      const markFrom = bang >= 0 ? line.from + bang : -1;
      // 该行 DOM 容器
      const el = v.contentDOM.children.length ? [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= line.from && p <= line.to; } catch { return false; } }) : null;
      const text = el ? (el.textContent || '') : '';
      const imgs = el ? [...el.querySelectorAll('img')].filter((i) => !i.classList.contains('cm-widgetBuffer')) : [];
      // 字面源码实占尺寸
      const rects = [];
      if (el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const s = n.nodeValue || ''; const i = s.indexOf('![');
          if (i < 0) continue;
          const r = document.createRange(); r.setStart(n, i); r.setEnd(n, Math.min(s.length, i + 2));
          const b = r.getBoundingClientRect(); rects.push({ w: Math.round(b.width), h: Math.round(b.height) });
        }
      }
      return {
        mode, line: no, hasBang: text.includes('!['), textHead: text.slice(0, 80),
        literalRects: rects.slice(0, 4),
        selLen: (() => { try { return String(window.getSelection() || '').length; } catch { return -1; } })(),
        head, headInMark: markFrom >= 0 && headPos >= markFrom - 1 && headPos <= markFrom + lineText.length,
        srcLen: imgs.length ? (imgs[0].getAttribute('src') || '').length : 0,
        srcHead: imgs.length ? (imgs[0].getAttribute('src') || '').slice(0, 30) : '',
        nw: imgs.length ? imgs[0].naturalWidth : 0,
        headLineText: d.lineAt(Math.max(0, Math.min(headPos, d.length))).text.slice(0, 30),
      };
    }, [fixtureLine, c.alt, mode]);

    // 状态 A：光标放到图片标记内部（F7 预期会露源码）
    await ev(([no]) => {
      const v = window.mpEngine._view(); const d = v.state.doc; const line = d.line(Math.min(no, d.lines));
      const bang = line.text.indexOf('![');
      v.dispatch({ selection: { anchor: bang >= 0 ? line.from + bang + 2 : line.from } });
      v.focus();
    }, [fixtureLine]);
    await sleep(400);
    const A = await probe('A-光标在图片标记内');

    // 状态 B：光标移到文档首行首（离开该 mark）
    await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); });
    await sleep(400);
    const B = await probe('B-光标移开(文档首)');

    // 2 倍图两张（Emulation deviceScaleFactor=2）
    const shot2x = async (name, lineNo) => {
      await client.send('Emulation.setDeviceMetricsOverride', { width: 1166, height: 757, deviceScaleFactor: 2, mobile: false });
      await sleep(300);
      const rect = await ev(([no]) => {
        const v = window.mpEngine._view(); const d = v.state.doc; const line = d.line(Math.min(no, d.lines));
        const el = [...v.contentDOM.children].find((x) => { try { const p = v.posAtDOM(x, 0); return p >= line.from && p <= line.to; } catch { return false; } });
        const b = el ? el.getBoundingClientRect() : null;
        return b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
      }, [lineNo]);
      if (rect) {
        const clip = { x: Math.max(0, Math.floor(rect.x - 20)), y: Math.max(0, Math.floor(rect.y - 20)), width: Math.min(600, Math.ceil(rect.w + 40)), height: Math.min(300, Math.ceil(rect.h + 40)) };
        try { await page.screenshot({ path: path.join(SHOTS, name), clip, timeout: 10000 }); } catch (e) { console.log('  截图失败', name, String(e.message).slice(0, 50)); }
      }
      await client.send('Emulation.clearDeviceMetricsOverride');
      await sleep(200);
    };
    // A 态截完再切 B 态截图（顺序：A 态 → 截图 → B 态 → 截图）
    await ev(([no]) => { const v = window.mpEngine._view(); const d = v.state.doc; const line = d.line(Math.min(no, d.lines)); const bang = line.text.indexOf('!['); v.dispatch({ selection: { anchor: bang >= 0 ? line.from + bang + 2 : line.from } }); v.focus(); }, [fixtureLine]);
    await sleep(350);
    await shot2x(`${c.id}-cursor-in-2x.png`, fixtureLine);
    await ev(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 }, scrollIntoView: false }); });
    await sleep(350);
    await shot2x(`${c.id}-cursor-away-2x.png`, fixtureLine);

    out.push({ id: c.id, fixtureLine, alt: c.alt, A, B,
      verdictHint: (!A.hasBang && !B.hasBang) ? '两态都没有字面源码 ⇒ 之前的红是读数时机问题'
        : (A.hasBang && !B.hasBang) ? '光标在标记内才露源码 ⇒ **F7 正确行为（假红）**'
          : '光标移开后仍有字面源码 ⇒ **真缺陷候选**' });
    console.log(`\n— ${c.id}（md 行 ${fixtureLine}）`);
    console.log('  A 光标在标记内：', JSON.stringify(A));
    console.log('  B 光标移开：    ', JSON.stringify(B));
    console.log('  判定提示：', out[out.length - 1].verdictHint);
  }
  fs.writeFileSync(path.join(DIR, 'accept', 'out', 'cursor-state.json'), JSON.stringify({ exe: EXE, at: new Date().toISOString(), cases: out }, null, 1), 'utf8');
  console.log('\n· 结果 =', path.join(DIR, 'accept', 'out', 'cursor-state.json'));
  console.log('· 2 倍图 =', SHOTS);
  try { await browser.close(); } catch { }
  killTree();
  await sleep(1200);
  process.exit(0);
})().catch((e) => { console.error('✗ 异常：', e && e.stack || e); process.exit(1); });
