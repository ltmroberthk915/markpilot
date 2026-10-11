/** family=path-edge · 用例 e5：**提示条按钮的命中判定**（只读目标触发保存失败 → 提示条出现）
 *
 *  线索（e4 臂 D 的一线读数）：网络盘断开后点「重试」两次，文档反而 28→26→24 字，最后那次
 *  成功的自动保存把 **42 B（原始文本，用户敲的字全没了）** 写回磁盘。方向指向：
 *  「重试」按钮的坐标上真正被点到的不是它，而是**压在上面的工具栏**（第二波 F6 只到"看不清"，
 *  这里要问"点得到吗、点到的是什么"）。
 *
 *  取证口径（错-15：读浏览器**已经算好**的命中结果，不自己算 z-order）：
 *    · `document.elementFromPoint(cx, cy)` = 真实点击会命中的那个元素
 *    · 提示条与工具栏的 rect 一起读出（几何重叠是可复算的事实）
 *    · 真鼠标点击前/后各读一次**文档文本**（若点到的是"撤销"，文本会变）
 *  对照臂：把同样坐标的点击换成"未被遮挡的点"（若存在）以及文档文本变化量
 *
 *  用法：node path-edge-5-banner-hit.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e5-banner-hit';
const DIR = path.join(L.ROOT, CASE);
const R = { probe: 'path-edge-5-banner-hit.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), steps: [] };

/** 一次 evaluate：几何 + 命中元素 + 文档文本（错-7：一组读数一次拿全） */
async function hitMap(page) {
  return await L.T(page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; };
    const desc = (el) => {
      if (!el) return null;
      const b = el.closest ? el.closest('button') : null;
      return {
        tag: el.tagName, cls: String(el.className || '').slice(0, 60), id: el.id || null,
        text: String(el.textContent || '').trim().slice(0, 24),
        closestButton: b ? { title: b.title || null, aria: b.getAttribute('aria-label'), text: String(b.textContent || '').trim().slice(0, 20), cls: String(b.className || '').slice(0, 40) } : null,
      };
    };
    const banner = document.getElementById('mp-banner');
    const toolbar = document.querySelector('.mp-toolbar');
    const btns = banner ? [...banner.querySelectorAll('button')] : [];
    const tbtns = toolbar ? [...toolbar.querySelectorAll('button')] : [];
    let view = null, docText = null; try { view = window.mpEngine._view(); docText = view.state.doc.toString(); } catch { /* 忽略 */ }
    return {
      docLen: docText === null ? null : docText.length, docText,
      bannerRect: banner ? rect(banner) : null,
      toolbarRect: toolbar ? rect(toolbar) : null,
      bannerButtons: btns.map((b) => ({ label: String(b.textContent || '').trim(), ...rect(b), hit: desc(document.elementFromPoint(Math.round(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2), Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2))) })),
      toolbarButtons: tbtns.map((b) => ({ title: b.title || null, text: String(b.textContent || '').trim().slice(0, 12), cls: String(b.className || '').slice(0, 30), ...rect(b) })),
      /* 提示条上"没被工具栏盖住"的点（取提示条底部一行，工具栏下沿之下一段）*/
      bannerFreePoint: banner ? (() => { const r = banner.getBoundingClientRect(); const x = Math.round(r.left + r.width / 2); const y = Math.round(Math.min(r.bottom - 4, r.top + r.height - 4)); return { x, y, hit: desc(document.elementFromPoint(x, y)) }; })() : null,
      bannerShown: banner ? banner.style.display !== 'none' : false,
      bannerText: banner ? (banner.firstChild && banner.firstChild.nodeType === 3 ? banner.firstChild.data : banner.textContent) : null,
    };
  }), 20000, 'hitMap');
}

(async () => {
  L.rulerEdge('path-edge-5-banner-hit.cjs');
  L.freshDir(DIR);
  const FIX = path.join(DIR, 'fix');
  fs.mkdirSync(FIX, { recursive: true });
  const profile = path.join(DIR, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');

  const doc = path.join(FIX, '只读 文档.md');
  const ORIG = '# 只读 标题\n\nMARK-HIT。\n';
  fs.writeFileSync(doc, ORIG, 'utf8');
  fs.chmodSync(doc, 0o444);
  R.fixture = { doc, orig: ORIG, bytes: Buffer.byteLength(ORIG), readonly: (fs.statSync(doc).mode & 0o200) === 0 };

  const port = await L.pickPort();
  const app = await L.launch({ exe: L.EXE, args: [], port, profile });
  const errs = [];
  try {
    const page = await L.findPage(app.browser, {});
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
    await L.sleep(2200);
    R.open = await L.T(page.evaluate((p) => window.mpHost.openPath(p), doc), 30000, 'open');
    await L.sleep(1600);

    /* 打字 → 只读目标 ⇒ 自动保存失败 ⇒ 提示条（与第二波 C1 同一条路） */
    R.typed = await L.focusBodyAndType(page, null, 'X1');
    await L.sleep(3000);
    const h1 = await hitMap(page);
    R.steps.push({ name: '提示条出现后', hit: h1 });
    console.log('\n[几何] 提示条=' + JSON.stringify(h1.bannerRect) + '  工具栏=' + JSON.stringify(h1.toolbarRect) + '  shown=' + h1.bannerShown);
    console.log('  提示条文案=' + JSON.stringify(h1.bannerText));
    console.log('  提示条按钮：');
    for (const b of h1.bannerButtons) console.log('    「' + b.label + '」 rect=(' + b.x + ',' + b.y + ',' + b.w + 'x' + b.h + ') 中心=(' + b.cx + ',' + b.cy + ') 该点实际命中=' + JSON.stringify(b.hit));
    console.log('  未被遮挡点=' + JSON.stringify(h1.bannerFreePoint));
    console.log('  工具栏按钮（找 x≈' + (h1.bannerButtons[0] && h1.bannerButtons[0].cx) + ' 的那个）：');
    for (const b of h1.toolbarButtons) if (Math.abs(b.cx - (h1.bannerButtons[0] ? h1.bannerButtons[0].cx : 0)) < 40 || (b.cx <= 900 && b.cx >= 700)) console.log('    ' + JSON.stringify(b));
    console.log('  文档长度=' + h1.docLen + ' 文本=' + JSON.stringify(h1.docText));

    /* 真鼠标点「重试」中心 → 读文本是否变化（若点到"撤销"，文本会缩） */
    const retry = h1.bannerButtons.find((b) => b.label.includes('重试'));
    if (retry) {
      const before = h1.docLen;
      await page.mouse.click(retry.cx, retry.cy);
      await L.sleep(2600);
      const h2 = await hitMap(page);
      R.steps.push({ name: '第一次点重试后', clicked: { x: retry.cx, y: retry.cy }, hitBefore: retry.hit, hit: h2 });
      console.log('\n[点1] (' + retry.cx + ',' + retry.cy + ') 点击前命中=' + JSON.stringify(retry.hit && retry.hit.closestButton));
      console.log('  文档 ' + before + ' → ' + h2.docLen + '  文本=' + JSON.stringify(h2.docText));
      console.log('  提示条还在=' + h2.bannerShown + ' 文案=' + JSON.stringify(h2.bannerText));

      await page.mouse.click(retry.cx, retry.cy);
      await L.sleep(2600);
      const h3 = await hitMap(page);
      R.steps.push({ name: '第二次点重试后', clicked: { x: retry.cx, y: retry.cy }, hit: h3 });
      console.log('\n[点2] 文档 ' + h2.docLen + ' → ' + h3.docLen + '  文本=' + JSON.stringify(h3.docText));
      console.log('  提示条还在=' + h3.bannerShown + ' 文案=' + JSON.stringify(h3.bannerText));
    }

    /* 对照臂：点提示条上"未被遮挡"的点（若命中按钮才说明是坐标问题而不是整条不可点） */
    const free = h1.bannerFreePoint;
    if (free) {
      const hb = await hitMap(page);
      await page.mouse.click(free.x, free.y);
      await L.sleep(1800);
      const h4 = await hitMap(page);
      R.steps.push({ name: '对照·点未遮挡点', clicked: free, hitBefore: free.hit, hit: h4, docBefore: hb.docLen, docAfter: h4.docLen });
      console.log('\n[对照] 点 (' + free.x + ',' + free.y + ') 命中=' + JSON.stringify(free.hit && free.hit.closestButton) + ' 文档 ' + hb.docLen + ' → ' + h4.docLen);
    }

    R.shell = L.shellLog(profile, 'file:save|writeDoc|doc:dirty', 16);
    R.errs = errs;
    R.diskAfter = { bytes: fs.statSync(doc).size, content: (() => { try { return fs.readFileSync(doc, 'utf8'); } catch (e) { return e.code; } })() };
    await L.shot(page, CASE + '-banner-hit.png');
    console.log('\n[磁盘（只读，应未变）] ' + JSON.stringify(R.diskAfter));
    console.log('[pageerror] ' + JSON.stringify(errs));
  } finally {
    L.kill(app);
    try { fs.chmodSync(doc, 0o666); } catch { /* 尽力 */ }
  }
  L.writeReport('path-edge-5-banner-hit', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
