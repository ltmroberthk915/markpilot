/** 补丁 13：7.6 的对话框检测**重试 3 次**（同产物 A/B 实测时通时不通 ⇒ 单次点击不能定案），
 *  并把每次尝试的"新窗口数"记进读数。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('attempts')) { console.log('· 已打过补丁'); process.exit(0); }
const old = `      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await sleep(1800);
      const wins = listWindowsAll();
      /* 判据：点完之后**全桌面新出现的顶层可见窗口**就是对话框（不限本进程——文件对话框常在别的进程里）；
         #32770 / 打开·选择 文案作交叉印证。 */
      const fresh = wins.filter((w) => !winsBefore.includes(w.hwnd));
      const dlgClassic = wins.find((w) => /^#32770$/.test(w.cls) || /打开|选择|Open|图片|另存/.test(w.title || ''));
      const dlg = fresh[0] || dlgClassic || null;`;
const neu = `      /* 同产物 A/B 实测"时通时不通"（preview5 两次跑一次 ✓ 一次 ✗）⇒ 必须重试，单次点击不能定案 */
      const attempts = [];
      let dlg = null, fresh = [], dlgClassic = null, wins = [];
      for (let k = 0; k < 3 && !dlg; k++) {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(2200);
        wins = listWindowsAll();
        /* 判据：点完之后**全桌面新出现的顶层可见窗口**就是对话框（不限本进程——文件对话框常在别的进程里）；
           #32770 / 打开·选择 文案作交叉印证。 */
        fresh = wins.filter((w) => !winsBefore.includes(w.hwnd));
        dlgClassic = wins.find((w) => /^#32770$/.test(w.cls) || /打开|选择|Open|图片|另存/.test(w.title || ''));
        dlg = fresh[0] || dlgClassic || null;
        attempts.push(fresh.length);
        if (!dlg) { await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); }
      }`;
if (!t.includes(old)) { console.log('✗ 没找到 7.6 点击块'); process.exit(1); }
t = t.replace(old, neu);
/* 读数里带上尝试记录 */
t = t.replace("`点了「${btn.id || btn.title}」后：全桌面新出现窗口 ${fresh.length} 个", "`点了「${btn.id || btn.title}」后：重试记录=${JSON.stringify(attempts)}；最后一次全桌面新出现窗口 ${fresh.length} 个");
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 7.6 已加 3 次重试并记录尝试');
