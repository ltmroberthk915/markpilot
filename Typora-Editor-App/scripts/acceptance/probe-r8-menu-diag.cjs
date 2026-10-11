/** R8 菜单诊断：为什么 export-menu 的原生菜单不出现？
 *  1. 正确 await hostApi.invoke('export-menu')，读结果/rejection；
 *  2. 若 IPC 正常但菜单不显示，用主进程直接 Menu.popup（同一份 exportMenuItems 模板，
 *     带 x/y 坐标弹在工具栏下方）+ 全屏截图差分；
 *  3. 捕获窗口 console 错误。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const harness = require('./harness.cjs');

const EXE = path.join(harness.project, 'node_modules/electron/dist/electron.exe');
const APP_ARGS = [path.join(harness.project, 'app/main/main.js')];
const OUT = path.join(harness.project, '.perf/probe-r8-export');
const DOC = 'E:/MarkPilot/.zcode-tmp/r8-export/doc/银行笔试题库-重排版.md';
const PS = harness.POWERSHELL;
const sleep = harness.sleep;
const PS_SHOT = path.join(OUT, 'screen-capture.ps1');
const shot = name => execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', PS_SHOT, '-X', '0', '-Y', '0', '-W', '0', '-H', '0', '-OutPath', path.join(OUT, name)],
  { windowsHide: true, encoding: 'utf8', timeout: 20000 });
const size = name => fs.existsSync(path.join(OUT, name)) ? fs.statSync(path.join(OUT, name)).size : 0;

(async () => {
  const session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
    outDir: OUT, args: [DOC], timeout: 120000, label: 'r8menu2' });
  try {
    await session.until(`(() => { const f = document.getElementById('editor'); const w = f && f.contentWindow;
      const root = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
      return !!(root && root.textContent.includes('银行笔试题库')); })()`, { timeout: 240000, interval: 250 });
    // 最小化→还原拿前台
    await session.main.js(`(() => { const r = global.windows[0]; const w = r.win; if (!w.isDestroyed()) { w.minimize(); setTimeout(() => { w.restore(); w.focus(); }, 250); } return true; })()`);
    await sleep(900);
    shot('menu2-0-baseline.png');
    // ① 正确 await IPC
    const r1 = await session.js(`window.hostApi.invoke('export-menu').then(v => 'OK:' + JSON.stringify(v)).catch(e => 'ERR:' + (e && e.message || e))`);
    console.log('① hostApi.invoke(export-menu) =', r1);
    await sleep(600);
    shot('menu2-1-after-ipc.png');
    console.log('   IPC 后全屏差', size('menu2-1-after-ipc.png') - size('menu2-0-baseline.png'));
    // ② 主进程直接弹（用菜单树转储的产品导出项重建模板；坐标=工具栏导出按钮下方）
    const menuDump = await session.main.menu();
    const exportItems = menuDump.filter(i => i.path.startsWith('文件 > 导出 >')).map(i => i.label.replace(/…$/, ''));
    const r3 = await session.main.js(`(() => {
      const { Menu } = require('electron');
      const rec = global.windows[0];
      const items = ${JSON.stringify(exportItems)}.map(label => ({ label: label + '…', click: () => {} }));
      Menu.buildFromTemplate(items).popup({ window: rec.win, x: 220, y: 96 });
      return 'popped:' + items.length;
    })()`);
    console.log('② 主进程直接 popup =', r3, '（菜单项：' + exportItems.join(' / ') + '）');
    await sleep(600);
    shot('menu2-2-direct-popup.png');
    console.log('   直接弹后全屏差', size('menu2-2-direct-popup.png') - size('menu2-0-baseline.png'));
    // 关菜单：blur + 二次最小化还原（必关）
    await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); if (w) w.blur(); return 'ok'; })()`);
    await sleep(300);
    shot('menu2-3-after-blur.png');
    console.log('   blur 后全屏差', size('menu2-3-after-blur.png') - size('menu2-0-baseline.png'));
  } finally { await session.close(); console.log('诊断会话已收尾'); }
})().catch(error => { console.error('诊断出错：', error && error.stack || error); process.exitCode = 1; });
