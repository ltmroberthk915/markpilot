/** 小补丁 3：连上 CDP 后**先验证是不是我们的应用**（页面 URL 必须含 app.asar），
 *  否则立刻退出——实测固定端口被别的腿的 Typora 占着时，connectOverCDP 会连到 Typora，
 *  探针就会在别人的应用里找 window.mpEngine（永远找不到），更糟的是可能误驱动它。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const GUARD = `
  /* 【身份守门】连上的必须是我们的应用：页面 URL 含 app.asar（打包件）或 file:// 指向本仓库 renderer。
     否则说明端口被别的进程（实测：别的腿的 Typora）占着 ⇒ 立刻退出，绝不误驱动别人的应用。 */
  {
    let mine = false;
    for (let i = 0; i < 20 && !mine; i++) {
      for (const p of ctx.pages()) {
        const u = p.url() || '';
        if (u.includes('app.asar') || u.includes('/renderer/') || u.includes('renderer\\\\\\\\cm6')) { mine = true; break; }
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
`;
for (const f of ['probe-qoff.cjs', 'probe-lineno-counter.cjs']) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) { console.log('缺文件', f); continue; }
  let t = fs.readFileSync(p, 'utf8');
  if (t.includes('【身份守门】')) { console.log('· 已打过守门补丁', f); continue; }
  const anchor = "  const ctx = browser.contexts()[0];";
  if (!t.includes(anchor)) { console.log('✗ 没找到锚点', f); continue; }
  t = t.replace(anchor, anchor + '\n' + GUARD);
  fs.writeFileSync(p, t, 'utf8');
  console.log('✓ 已加身份守门', f);
}
