/** family=path-edge · 用例 e7：**网络盘断开时点「重试」到底发生了什么**（e4 臂 D 的数据丢失复现 + 命中取证）
 *
 *  e4 臂 D 的一线读数：网络盘断开 → 打字 → 点两次「重试」→ 文档 28→26→24 字 → 重连后那次自动保存
 *  把 **42 B（原始文本，用户敲的字全没了）** 写回磁盘。
 *  e6 已把机理量清：**一行高的提示条**（h=42）按钮在 y=21，落在工具栏带(6..37)里 ⇒ 点不到、且点到别的工具栏按钮。
 *  本支要做的是：在**网络盘这个真实场景**里，把"点到的是哪个工具栏按钮""文档怎么变""最后写回磁盘的是什么"
 *  三件事用**同一次运行**的读数串起来（而不是靠跨支推断）。
 *
 *  通道：映射/断开=net use（探针侧）；打开=mpHost.openPath；打字=真实鼠标+CDP 键盘；
 *        点提示条/菜单=真实鼠标 & 菜单项自身 click；文本读数=引擎 state.doc（一次 evaluate 拿全）
 *  用法：node path-edge-7-netdrive-hit.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e7-netdrive-hit';
const DIR = path.join(L.ROOT, CASE);
const DRIVE = 'R:';
const UNC_SHARE = '\\\\localhost\\E$';
const R = { probe: 'path-edge-7-netdrive-hit.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), steps: [] };
const cleanup = () => { try { L.netDelete(DRIVE); } catch { /* 尽力 */ } };
process.on('exit', cleanup);

(async () => {
  L.rulerEdge('path-edge-7-netdrive-hit.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(DIR, { recursive: true });
  const profile = path.join(DIR, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');

  L.netDelete(DRIVE);
  L.netUse(DRIVE, UNC_SHARE);
  const shareDir = 'R:\\MarkPilot\\.mp-verify\\path-edge\\e7-netdrive-hit\\share';
  fs.mkdirSync(shareDir, { recursive: true });
  const live = path.join(shareDir, '网盘 文档.md');
  const ORIG = '# 网盘 标题\n\nMARK-NET7。\n';
  fs.writeFileSync(live, ORIG, 'utf8');
  R.fixture = { drive: DRIVE, share: UNC_SHARE, doc: live, orig: ORIG, origBytes: Buffer.byteLength(ORIG) };
  console.log('[夹具] ' + live + '（' + R.fixture.origBytes + ' B，原始 ' + ORIG.length + ' 字）');

  const port = await L.pickPort();
  const app = await L.launch({ exe: L.EXE, args: [], port, profile });
  const errs = [];
  try {
    const page = await L.findPage(app.browser, {});
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
    await L.sleep(2200);
    const snap = async () => await L.hitMap(page);   // 几何 + 命中原素 + 文档文本，一次拿全
    const disk = () => { try { return fs.readFileSync(live, 'utf8'); } catch (e) { return { __err: e.code }; } };

    R.open = await L.T(page.evaluate((p) => window.mpHost.openPath(p), live), 30000, 'open');
    await L.sleep(1600);

    /* ① 打字 N1 → 应落盘 */
    await L.focusBodyAndType(page, null, 'N1');
    await L.sleep(2600);
    R.step1 = { docLen: (await snap()).docLen, disk: String(disk()).replace(/\n/g, '\\n'), 磁盘字节: fs.statSync(live).size };
    console.log('\n[① 打字 N1] ' + JSON.stringify(R.step1));

    /* ② 断开网络盘 → 打字 N2 → 等提示条 */
    L.netDelete(DRIVE);
    await L.sleep(1500);
    R.driveGone = !L.driveAlive(DRIVE);
    await L.focusBodyAndType(page, null, 'N2');
    await L.sleep(3400);
    const h2 = await snap();
    R.step2 = {
      盘符还在: !R.driveGone, docLen: h2.docLen, docText: h2.docText, bannerShown: h2.bannerShown, bannerText: h2.bannerText,
      bannerRect: h2.bannerRect, toolbarRect: h2.toolbarRect,
      buttons: h2.bannerButtons.map((b) => ({ label: b.label, cx: b.cx, cy: b.cy, hit: b.hit && (b.hit.closestButton ? 'BUTTON:' + (b.hit.closestButton.title || b.hit.closestButton.text) : b.hit.tag + '.' + b.hit.cls) })),
      disk: String(disk()).replace(/\n/g, '\\n'),
    };
    console.log('\n[② 断开后打字] 提示条 h=' + (h2.bannerRect && h2.bannerRect.h) + ' 工具栏下沿=' + (h2.toolbarRect && h2.toolbarRect.y + h2.toolbarRect.h));
    console.log('  文档=' + h2.docLen + ' 字 ' + JSON.stringify(h2.docText));
    console.log('  提示条=' + JSON.stringify(h2.bannerText));
    for (const b of R.step2.buttons) console.log('   「' + b.label + '」中心=(' + b.cx + ',' + b.cy + ') 命中=' + b.hit);

    /* ③ 真实鼠标点两次「重试」（用户在断网时会做的事）——记文档文本变化 */
    const retry = h2.bannerButtons.find((b) => b.label.includes('重试'));
    R.clicks = [];
    for (let i = 1; i <= 2 && retry; i++) {
      const before = await snap();
      await page.mouse.click(retry.cx, retry.cy);
      await L.sleep(2600);
      const after = await snap();
      R.clicks.push({ 第几次: i, 点: { x: retry.cx, y: retry.cy }, 点前命中: retry.hit && (retry.hit.closestButton ? 'BUTTON:' + (retry.hit.closestButton.title || retry.hit.closestButton.text) : null), 文档: before.docLen + '→' + after.docLen, 文本后: after.docText, 提示条还在: after.bannerShown });
      console.log('\n[③ 点第 ' + i + ' 次「重试」] 命中=' + R.clicks[i - 1].点前命中 + '  文档 ' + before.docLen + '→' + after.docLen + '  提示条还在=' + after.bannerShown);
      console.log('   文本=' + JSON.stringify(after.docText));
    }

    /* ④ 重连网络盘 → 再点一次「重试」（＝e4 里那一下）→ 看磁盘最终写回什么 */
    L.netUse(DRIVE, UNC_SHARE);
    await L.sleep(1600);
    const before4 = await snap();
    if (retry) { await page.mouse.click(retry.cx, retry.cy); }
    await L.sleep(3600);
    const after4 = await snap();
    R.step4 = {
      重连后盘上: String(disk()).replace(/\n/g, '\\n'), 磁盘字节: (() => { try { return fs.statSync(live).size; } catch (e) { return e.code; } })(),
      文档: before4.docLen + '→' + after4.docLen, 文本后: after4.docText, 提示条还在: after4.bannerShown,
      用户敲的字符还在盘上: typeof disk() === 'string' ? { N1: disk().includes('N1'), N2: disk().includes('N2') } : null,
    };
    console.log('\n[④ 重连后再点「重试」] 文档 ' + R.step4.文档 + ' 提示条还在=' + R.step4.提示条还在);
    console.log('   盘上=' + JSON.stringify(R.step4.重连后盘上) + '（' + R.step4.磁盘字节 + ' B，原始 ' + R.fixture.origBytes + ' B）');
    console.log('   用户敲的字还在盘上=' + JSON.stringify(R.step4.用户敲的字符还在盘上));

    /* ⑤ 对照臂：同样的处境，改走**菜单「保存」**（真实菜单项 click）——用户的另一条恢复路径 */
    await L.focusBodyAndType(page, null, 'N3');
    await L.sleep(600);
    R.step5_before = { docLen: (await snap()).docLen };
    R.step5_menuClick = await L.T(page.evaluate(() => window.mpHost.recentTestMenuClick('menu-save')), 20000, 'menu-save');
    await L.sleep(3000);
    const d5 = disk();
    R.step5 = { 菜单点击: R.step5_menuClick, 盘上含N3: typeof d5 === 'string' && d5.includes('N3'), 盘上: String(d5).replace(/\n/g, '\\n'), 磁盘字节: (() => { try { return fs.statSync(live).size; } catch (e) { return e.code; } })(), docLen: (await snap()).docLen };
    console.log('\n[⑤ 对照·菜单「保存」] ' + JSON.stringify(R.step5_menuClick) + ' 盘上含N3=' + R.step5.盘上含N3);
    console.log('   盘上=' + JSON.stringify(R.step5.盘上));

    R.shell = L.shellLog(profile, 'file:save|writeDoc|openPath', 20);
    R.errs = errs;
    await L.shot(page, CASE + '-final.png');
    console.log('\n[pageerror] ' + JSON.stringify(errs));
  } catch (e) { R.errs = (R.errs || []).concat('THROW: ' + String((e && e.stack) || e).slice(0, 300)); }
  finally { L.kill(app); L.netDelete(DRIVE); }
  L.writeReport('path-edge-7-netdrive-hit', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); cleanup(); process.exit(2); });
