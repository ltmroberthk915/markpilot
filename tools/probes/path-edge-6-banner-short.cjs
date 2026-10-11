/** family=path-edge · 用例 e6：**提示条按钮"点得到吗"的配对实验**（同一按钮、只换消息长度）
 *
 *  线索链：
 *   · e4 臂 D（真映射网络盘断开）：点两次「重试」，文档 28→26→24 字，重连后那次自动保存
 *     把 **42 B（原始文本，用户敲的 N1/N2 全没了）** 写回磁盘。
 *   · e5（长消息提示条，EPERM rename）：按钮中心 y=42 **在工具栏下沿(37)之下**，命中判定就是按钮本身，
 *     点两次文本不变（说明点到了、只是重试又失败）。
 *   ⇒ 假设：提示条是**一行内联流**，消息短时按钮落在**第一行**（y≈8..34）——正好压在工具栏(6..37)里。
 *
 *  配对（同源同类，只换消息长度；消息长度由**路径长度**决定）：
 *   · 臂 S：短路径（~31 字符）的 20k 字文档 ⇒ 缩水守卫提示条消息短 ⇒ 1 行
 *   · 臂 L：长路径（~200 字符）的 20k 字文档 ⇒ 同一条提示条消息长 ⇒ 2 行
 *  两臂都：Ctrl+A + Delete（真实键盘）→ 触发「自动保存被拦下」提示条 → 读几何/命中 → 真鼠标点
 *  **第二个按钮「放弃这次自动保存」**（它的唯一效果是 hideBanner ⇒ "提示条消失"就是"按钮真的被点到了"的干净判据）
 *
 *  用法：node path-edge-6-banner-short.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e6-banner-short';
const DIR = path.join(L.ROOT, CASE);
const R = { probe: 'path-edge-6-banner-short.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), arms: [] };

/** 20k+ 字文档（过 SHRINK_MIN=20000 门槛），内容可辨 */
function bigDoc(tag) {
  const lines = [];
  for (let i = 0; i < 700; i++) lines.push('- ' + tag + ' 第 ' + i + ' 行 ' + 'x'.repeat(30));
  return '# ' + tag + ' 大文档\n\n' + lines.join('\n') + '\n';
}

async function arm({ label, docPath, dir, mark }) {
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: 'system', recent: [], recentFiles: [], winBounds: null, restoreLast: false }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profile, 'recents.json'), '[]', 'utf8');
  const port = await L.pickPort();
  const app = await L.launch({ exe: L.EXE, args: [], port, profile });
  const out = { label, docPath, pathChars: docPath.length };
  const errs = [];
  try {
    const page = await L.findPage(app.browser, {});
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
    await L.sleep(2200);
    out.open = await L.T(page.evaluate((p) => window.mpHost.openPath(p), docPath), 30000, 'open');
    await L.sleep(1800);

    /* 真实键盘：Ctrl+A 全选 → Delete 删空 ⇒ 去抖保存撞上缩水守卫 */
    await L.clickBody(page, null);
    await page.keyboard.press('Control+a');
    await L.sleep(200);
    await page.keyboard.press('Delete');
    await L.sleep(3000);
    const h1 = await L.hitMap(page);
    out.afterTrigger = h1;
    console.log('\n[' + label + '] 路径 ' + docPath.length + ' 字符');
    console.log('  提示条 rect=' + JSON.stringify(h1.bannerRect) + ' 工具栏 rect=' + JSON.stringify(h1.toolbarRect));
    console.log('  消息（前 60）=' + JSON.stringify(String(h1.bannerText || '').slice(0, 60)));
    console.log('  文档长度=' + h1.docLen);
    for (const b of h1.bannerButtons) console.log('   「' + b.label + '」中心=(' + b.cx + ',' + b.cy + ') 实际命中=' + JSON.stringify(b.hit && (b.hit.closestButton ? ('BUTTON:' + (b.hit.closestButton.title || b.hit.closestButton.text)) : (b.hit.tag + '.' + b.hit.cls))));

    /* 点第二个按钮（放弃这次自动保存 ⇒ 唯一效果是 hideBanner） */
    const b2 = h1.bannerButtons[1] || h1.bannerButtons[0];
    const docBefore = h1.docLen;
    if (b2) {
      out.clicked = { label: b2.label, x: b2.cx, y: b2.cy, hitBefore: b2.hit };
      await page.mouse.click(b2.cx, b2.cy);
      await L.sleep(2200);
      const h2 = await L.hitMap(page);
      out.afterClick = h2;
      out.verdict = {
        按钮被点到: !h2.bannerShown,                      // 点到了 ⇒ hideBanner ⇒ 提示条消失
        点击前命中的是不是按钮: !!(b2.hit && b2.hit.closestButton),
        点击前命中: b2.hit && (b2.hit.closestButton ? ('BUTTON:' + (b2.hit.closestButton.title || b2.hit.closestButton.text)) : (b2.hit.tag + '.' + b2.hit.cls)),
        文档变化: docBefore + '→' + h2.docLen,
      };
      console.log('  ▸ 点「' + b2.label + '」后：提示条还在=' + h2.bannerShown + ' 文档 ' + docBefore + '→' + h2.docLen);
      console.log('  ▸ 判定=' + JSON.stringify(out.verdict));
    }
    await L.shot(page, CASE + '-' + mark + '.png');
    out.shell = L.shellLog(profile, 'file:save|writeDoc', 10);
  } catch (e) { errs.push('THROW: ' + String((e && e.stack) || e).slice(0, 240)); }
  finally { L.kill(app); }
  out.errs = errs;
  return out;
}

(async () => {
  L.rulerEdge('path-edge-6-banner-short.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(DIR, { recursive: true });

  /* 臂 S：短路径 */
  const shortDir = path.join(DIR, 'pe-s');
  fs.mkdirSync(shortDir, { recursive: true });
  const sDoc = path.join(shortDir, 's.md');
  fs.writeFileSync(sDoc, bigDoc('短'), 'utf8');
  R.arms.push(await arm({ label: 'S 短消息', docPath: sDoc, dir: path.join(DIR, 'runS'), mark: 'short' }));
  fs.writeFileSync(sDoc, bigDoc('短'), 'utf8');   // 下一臂重开同一份内容

  /* 臂 L：长路径（同一份内容，只把路径拉长） */
  const longDir = path.join(DIR, 'pe-l', '长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccccccccccc');
  fs.mkdirSync(longDir, { recursive: true });
  const lDoc = path.join(longDir, 'l.md');
  fs.writeFileSync(lDoc, bigDoc('长'), 'utf8');
  R.arms.push(await arm({ label: 'L 长消息', docPath: lDoc, dir: path.join(DIR, 'runL'), mark: 'long' }));

  R.table = R.arms.map((a) => ({
    臂: a.label, 路径字符数: a.pathChars,
    提示条高度: a.afterTrigger && a.afterTrigger.bannerRect && a.afterTrigger.bannerRect.h,
    按钮中心y: a.afterTrigger && a.afterTrigger.bannerButtons[1] && a.afterTrigger.bannerButtons[1].cy,
    工具栏下沿: a.afterTrigger && a.afterTrigger.toolbarRect && (a.afterTrigger.toolbarRect.y + a.afterTrigger.toolbarRect.h),
    点击前命中: a.verdict && a.verdict.点击前命中,
    点到按钮了: a.verdict && a.verdict.按钮被点到,
    文档变化: a.verdict && a.verdict.文档变化,
  }));
  console.log('\n════ 配对总表 ════');
  console.log(JSON.stringify(R.table, null, 1));
  console.log('[pageerror] ' + JSON.stringify(R.arms.map((a) => a.errs)));
  L.writeReport('path-edge-6-banner-short', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
