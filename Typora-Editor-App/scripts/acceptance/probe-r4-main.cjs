/** R4 第 4 轮 · MW 多窗口域主进程修复验收（harness dev，跑开发树：electron.exe + app/main/main.js）。
 *
 *  覆盖（round4-findings.md MW 节，MW4/MW5 已否决不在本轮）：
 *    MW1  A 窗在文件树里重命名 B 窗正开着的文件 → 主进程对**全部窗口**广播 onFileRenamed，
 *         B 的 doc.file 跟随新路径（旧代码只通知发起窗口：B 把文档当"外部失联"，
 *         Ctrl+S 会在旧路径重建一份陈旧副本）。
 *    MW2  另存为的目标 = 另一窗口已打开的文件 → 落盘前拦下 + 聚焦那个窗口
 *         （主进程 dialog 替身留痕：'save' 询问 + 'message' 拦截框）；
 *         另含 restoreWindows 对会话里重复文件条目的去重（MW2b）。
 *    MW3  关窗后退订工作区递归 watch（tree.js watchHub 引用计数，最后一个退订才关
 *         watcher）。独立证人 = 主进程 FSWatcher 句柄数；半途还验证**没有过度退订**
 *         （剩下的窗口照常收 tree-changed 刷新）。
 *    MW6  文档切换（文件 → 在此窗口打开文件…）后状态栏立即显示新文档统计，
 *         不再残影 400ms+（旧代码只排 400ms 去抖，期间亮的是上一份文档的字数/保存横幅）。
 *
 *  探针纪律：
 *    · 一次启动给 3 个文件 = 3 个窗口（openPaths：一文件一窗），attachWindow 逐窗接管
 *      → **双窗场景真实可达**，不需要退化为纯单元断言；
 *    · 真实输入：CDP Input（右键菜单点"重命名"、insertText、Enter、Ctrl+W、Ctrl+Shift+S），
 *      系统对话框（另存为/打开）走主进程 dialog 替身——只顶替"用户选了什么"，其后全是真产品代码；
 *    · **全程不碰剪贴板**（无 clipboardWitness / writeClipboard 调用）；
 *    · 每用例输出「R4MW <名> PASS/FAIL/EVIDENCE — …」+ 截图（.perf/r4-main/shots*.png）。
 *
 *  红条件（旧代码必须 FAIL）与突变点见文件末尾「突变验证」注释块。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('./harness.cjs');
const { computeStats } = require(path.join(harness.project, 'app', 'main', 'text-stats.js'));

const DEV = !process.argv.includes('--exe');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_ARGS = DEV ? [path.join(harness.project, 'app/main/main.js')] : [];
const OUT = path.join(harness.project, '.perf/r4-main');
const sleep = harness.sleep;
const say = v => console.log(typeof v === 'string' ? v : JSON.stringify(v));
const eqFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha256file = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const results = [];
function verdict(name, pass, detail) {
  const tag = pass === null ? 'EVIDENCE' : pass ? 'PASS' : 'FAIL';
  results.push({ name, tag });
  console.log(`R4MW ${name} ${tag} — ${detail}`);
  return pass;
}

// ---------- 素材（探针自建目录，不触碰受保护素材） ----------
const DIR = path.join(OUT, 'material');    // 窗口 A、B 的工作区（共享 watchHub 根）
const DIR2 = path.join(OUT, 'material2');  // 窗口 C 的工作区：让关掉 A/B 后应用仍活着，X 的 watcher 才能被真正关掉
const A = path.join(DIR, '甲.md');         // 窗口 A 的文档
const B = path.join(DIR, '乙.md');         // 窗口 B 的文档（MW1 里被改名）
const C = path.join(DIR2, '戊.md');        // 窗口 C 的文档（托底窗口）
const D6 = path.join(DIR, '丁.md');        // MW6 用：不在任何窗口打开，供"在此窗口打开文件…"切换
const B2 = path.join(DIR, '丙.md');        // MW1 重命名后的新路径

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(DIR2, { recursive: true });
  const textA = '甲'.repeat(30) + '\n';
  const textB = '乙'.repeat(20) + '\n';
  const textD6 = '丁'.repeat(12) + ' hello world foo bar baz\n';
  fs.writeFileSync(A, textA, 'utf8');
  fs.writeFileSync(B, textB, 'utf8');
  fs.writeFileSync(C, '戊'.repeat(5) + '\n', 'utf8');
  fs.writeFileSync(D6, textD6, 'utf8');
  const wordsA = computeStats(textA).words;    // 30
  const wordsD6 = computeStats(textD6).words;  // 12 中文 + 5 英文词

  // ================= 会话一：三窗（A/B/C） =================
  const session = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
    outDir: path.join(OUT, 'shots'), args: [A, B, C], timeout: 120000 });
  try {
    await session.until(`!!document.getElementById('editor')`, { timeout: 60000 });
    let recs = [];
    for (let i = 0; i < 100; i++) {
      recs = (await session.recs()) || [];
      if (recs.filter(r => r.file).length === 3) break;
      await sleep(200);
    }
    const recA = recs.find(r => eqFile(r.file, A));
    const recB = recs.find(r => eqFile(r.file, B));
    const recC = recs.find(r => eqFile(r.file, C));
    if (!recA || !recB || !recC) throw new Error('三窗没有就位：' + JSON.stringify(recs.map(r => r.file)));
    const wA = await session.attachWindow(recA.id);
    const wB = await session.attachWindow(recB.id);
    const wC = await session.attachWindow(recC.id);
    await wB.until(`!!document.getElementById('editor')`, { timeout: 30000 });
    say(`R4MW ENV EVIDENCE — dev 多窗可达：一次启动 3 文件=3 窗（A=${path.basename(A)}/B=${path.basename(B)}/C=${path.basename(C)}），attachWindow 已逐窗接管；产物=${DEV ? 'electron.exe+app/main/main.js' : EXE}`);
    const errBase = session.errors.length;
    const newErrors = () => session.errors.slice(errBase).filter(e => !/completion|补全/.test(e));

    // ---------------- MW1：A 窗改名 B 的文件 → B 的 doc.file 跟随 ----------------
    {
      await session.main.js(`global.__r4capB = global.windows.find(x => x.id === ${recB.id}) || null; true`);
      // GUI 主路径：右键 B 那一行（右键=选中+菜单，不像左键会把文件打开）→ 菜单"重命名（F2）"
      // → 内联输入框自动全选主名 → insertText 顶替 → Enter 提交。全程真实输入。
      let mode = 'gui';
      const rowReady = await wA.until(`!![...document.querySelectorAll('#tree .row')].find(r => r.dataset.path === ${JSON.stringify(B)})`, { timeout: 8000 });
      const row = rowReady ? await wA.js(`(() => {
        const el = [...document.querySelectorAll('#tree .row')].find(r => r.dataset.path === ${JSON.stringify(B)});
        const rect = el.getBoundingClientRect();
        return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)};
      })()`) : null;
      if (!row) mode = 'ipc:norow';
      else {
        await wA.click(row.x, row.y, { button: 'right' });
        const menuUp = await wA.until(`(() => { const m = document.getElementById('ctxmenu'); return m && m.style.display !== 'none' && [...m.querySelectorAll('.mi')].some(i => i.textContent.includes('重命名')); })()`, { timeout: 5000 });
        if (!menuUp) mode = 'ipc:nomenu';
        else {
          const item = await wA.js(`(() => { const m = document.getElementById('ctxmenu'); const el = [...m.querySelectorAll('.mi')].find(i => i.textContent.includes('重命名')); const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
          await wA.click(item.x, item.y);
          const hasInput = await wA.until(`(() => { const i = document.querySelector('#tree .row input'); return !!i && document.activeElement === i; })()`, { timeout: 5000 });
          if (!hasInput) mode = 'ipc:noinput';
          else {
            await wA.type('丙');
            const val = await wA.js(`document.querySelector('#tree .row input') ? document.querySelector('#tree .row input').value : null`);
            if (val !== '丙.md') mode = 'ipc:badvalue:' + val;
            else await wA.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
          }
        }
      }
      if (mode !== 'gui') {
        // 兜底①：仍是真实产品通道（外壳 → 主进程 IPC tree-rename），只跳过树的内联输入框
        await wA.js(`window.hostApi.invoke('tree-rename', { from: ${JSON.stringify(B)}, name: '丙' })`);
        say(`R4MW MW1 EVIDENCE — GUI 树重命名未走通（${mode}），已退到 hostApi.invoke('tree-rename') 真实 IPC 通道`);
      }
      let follow = null;
      for (let i = 0; i < 100 && !follow; i++) {
        const list = (await session.recs()) || [];
        follow = list.find(r => eqFile(r.file, B2)) || null;
        if (!follow) await sleep(100);
      }
      // iframe src 的跟随是 doc-load → 外壳改 src 的异步链路，可能晚 recs 一拍：轮询 3s。
      let bSrc = '';
      for (let i = 0; i < 30; i++) {
        bSrc = await wB.js(`document.getElementById('editor') ? (document.getElementById('editor').getAttribute('src') || '') : ''`);
        if (bSrc.includes(encodeURIComponent('丙.md'))) break;
        await sleep(100);
      }
      const bState = JSON.parse(await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${recB.id}); if (!r || !r.doc.current) return 'null'; return JSON.stringify({file: r.doc.current.file, deleted: !!r.doc.current.deleted, externalConflict: !!r.doc.current.externalConflict, saveError: r.doc.current.saveError || null}); })()`) || 'null');
      const diskOk = fs.existsSync(B2) && !fs.existsSync(B) && fs.readFileSync(B2, 'utf8') === textB;
      const srcFollowed = bSrc.includes(encodeURIComponent('丙.md'));
      await wB.shot('mw1-b-followed');
      await wA.shot('mw1-a-tree');
      verdict('MW1', !!follow && follow.id === recB.id && srcFollowed && !!bState && eqFile(bState.file, B2)
        && bState.deleted === false && bState.externalConflict === false && !bState.saveError && diskOk,
        `改名 ${path.basename(B)}→丙.md 由 A 窗发起；B 窗 doc.file=${follow ? follow.file : '(未跟随)'}（窗口${follow ? follow.id : '?'}，期望 ${recB.id}）`
        + `；B 页 iframe src 跟随=${srcFollowed}；B 文档态(deleted/externalConflict/saveError)=${bState ? [bState.deleted, bState.externalConflict, bState.saveError].join('/') : 'n/a'}`
        + `；磁盘 丙.md 在/乙.md 消失=${diskOk}；路径=${mode === 'gui' ? 'GUI 树右键菜单+insertText+Enter' : 'IPC 兜底'}；新增页面错误 ${newErrors().length} 条`);
    }

    // ---------------- MW2：B 窗另存为 → 目标=A 窗已开文件 → 拦下+聚焦 A ----------------
    {
      await session.main.clearCalls();
      const shaA0 = sha256file(A);
      await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${recB.id}); if (r && !r.win.isDestroyed()) r.win.focus(); return true; })()`);
      let bFocused = false;
      for (let i = 0; i < 20 && !bFocused; i++) {
        bFocused = !!(await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); return !!w && w.webContents.id === ${recB.id}; })()`));
        if (!bFocused) await sleep(100);
      }
      await session.main.script([
        { dialog: 'save', file: A },           // 替身：用户在另存为框里填了 A 的路径
        { dialog: 'message', response: 0 },    // 替身：拦截框上按「聚焦该窗口」（默认钮）——
      ]);                                      // 不脚本化时替身按 cancelId=1 自动选「取消」，聚焦分支永远走不到
      await wB.key({ key: 'S', code: 'KeyS', vk: 83, modifiers: harness.MOD.ctrl | harness.MOD.shift });
      const saveAskedPoll = async ms => { for (let i = 0; i < ms / 100; i++) {
        if ((await session.main.calls()).some(c => c.kind === 'save')) return true; await sleep(100); } return false; };
      let saveAsked = await saveAskedPoll(3000);
      if (!saveAsked) { // 键盘加速键没触发时退到真实菜单项（同为用户入口）
        await session.main.clickMenu('文件 > 另存为…');
        say('R4MW MW2 EVIDENCE — Ctrl+Shift+S 未触发另存为，已退到菜单「文件 > 另存为…」');
        saveAsked = await saveAskedPoll(3000);   // 菜单路径同样要在替身上留下 save 询问的痕
      }
      let block = null;
      for (let i = 0; i < 40 && !block; i++) {
        block = (await session.main.calls()).find(c => c.kind === 'message' && /已经在另一个窗口打开/.test((c.options || {}).message || '')) || null;
        if (!block) await sleep(100);
      }
      let aFocused = false;
      for (let i = 0; i < 20 && !aFocused; i++) {
        aFocused = !!(await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); return !!w && w.webContents.id === ${recA.id}; })()`));
        if (!aFocused) await sleep(100);
      }
      const list = (await session.recs()) || [];
      const bNow = list.find(r => r.id === recB.id);
      const shaA1 = sha256file(A);
      await wA.shot('mw2-a-focused');
      await wB.shot('mw2-b-still');
      verdict('MW2', !!saveAsked && !!block && aFocused && !!bNow && eqFile(bNow.file, B2) && shaA0 === shaA1,
        `B 窗另存为目标=${path.basename(A)}：另存为框请求=${!!saveAsked}（dialog 替身留痕）；拦截提示=${block ? '已弹「' + block.options.message + '」' : '未出现'}`
        + `；按默认钮后聚焦 A 窗=${aFocused}；B 的文档未迁移=${bNow ? bNow.file : '?'}（期望仍 ${B2}）；A 磁盘内容未被覆盖=${shaA0 === shaA1}`);
    }

    // ---------------- MW6：同窗切换文档 → 状态栏立即更新（不残影 400ms） ----------------
    {
      await wA.until(`document.getElementById('st-words').textContent.includes('${wordsA}')`, { timeout: 15000 });
      await wA.js(`(() => {
        window.__mw6 = { docLoad: null, wordsChanges: [] };
        const frame = document.getElementById('editor');
        new MutationObserver(() => { if (window.__mw6.docLoad === null) window.__mw6.docLoad = performance.now(); })
          .observe(frame, { attributes: true, attributeFilter: ['src'] });
        const words = document.getElementById('st-words');
        new MutationObserver(() => window.__mw6.wordsChanges.push({ t: performance.now(), text: words.textContent }))
          .observe(words, { childList: true });
        return true;
      })()`);
      await session.main.script([{ dialog: 'open', files: [D6] }]); // 替身：用户在"打开文件"框里选了 丁.md
      await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${recA.id}); if (r && !r.win.isDestroyed()) r.win.focus(); return true; })()`);
      const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
      const switched = await wA.until(`document.getElementById('st-words').textContent.includes('${wordsD6}')`, { timeout: 15000 });
      await sleep(300);
      const mw6 = await wA.js(`window.__mw6`);
      const finalText = await wA.js(`document.getElementById('st-words').textContent`);
      const t0 = mw6 && mw6.docLoad;
      // lag 见证修正：取"第一次出现**新文档字数**"的变更时刻，不再加 c.t >= t0 前置——
      // iframe src 的 MutationObserver 与 st-words 的 MutationObserver 同一微任务队列，
      // 时序上 words 那条可能先于 src 那条落（首轮实测 dt=0 却被 >=t0 过滤掉，lag 读成
      // 未捕获）。负值按 0 截断（同拍到达就是 0ms 残影）。
      const firstCorrect = mw6 && mw6.wordsChanges.filter(c => c.text.includes(String(wordsD6)))[0] || null;
      const lag = t0 && firstCorrect ? Math.max(0, Math.round(firstCorrect.t - t0)) : null;
      await wA.shot('mw6-statusbar');
      verdict('MW6', String(clicked).startsWith('CLICKED') && switched && lag !== null && lag < 350,
        `切换 甲.md→丁.md（字数 ${wordsA}→${wordsD6}）：doc-load 时刻 T0=${t0 ? Math.round(t0) : '?'}ms，`
        + `状态栏首次出现新字数 lag=${lag === null ? '未捕获' : lag + 'ms'}（阈值 350ms，旧代码 400ms 去抖必超）；`
        + `最终显示=${JSON.stringify(finalText)}；菜单点击=${clicked}`);
      say('R4MW MW6 EVIDENCE — st-words 变更时间线：' + JSON.stringify((mw6 && mw6.wordsChanges || []).map(c => ({ dt: t0 ? Math.round(c.t - t0) : null, text: c.text }))));
    }

    // ---------------- MW3：关窗退订工作区 watch（不泄漏、也不过度退订） ----------------
    {
      const countWatchers = () => session.main.js(`process._getActiveHandles().filter(h => h && h.constructor && h.constructor.name === 'FSWatcher').length`);
      // 关窗后 watcher 释放是异步落定的：'close' 处理器先把 rec 从注册表摘掉（recs 立刻
      // 看不见它），两个释放动作（文档 watcher / 工作区退订）都在其后的 'closed' 里。
      // 立刻读数会早退（首轮实测关 A 后 4→4，其实还没落地）——窗口期采样取最小值。
      const settleCount = async ms => { let min = Infinity, last = null;
        for (let i = 0; i < ms / 250; i++) { const n = await countWatchers();
          if (n < min) min = n; last = n; await sleep(250); } return { min, last }; };
      const n0 = await countWatchers();
      say(`R4MW MW3 EVIDENCE — 三窗全开时主进程 FSWatcher 句柄数 n0=${n0}（预期构成：3 个文档文件 watcher + 2 个工作区递归 watcher）`);
      await wA.js(`(() => { window.__treeChanged = 0; window.hostApi.onPush('tree-changed', () => { window.__treeChanged++; }); return true; })()`);
      const focusRec = async id => {
        await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${id}); if (r && !r.win.isDestroyed()) r.win.focus(); return true; })()`);
        for (let i = 0; i < 20; i++) {
          const hit = !!(await session.main.js(`(() => { const w = require('electron').BrowserWindow.getFocusedWindow(); return !!w && w.webContents.id === ${id}; })()`));
          if (hit) return true;
          await sleep(100);
        }
        return false;
      };
      // 关 B：先把焦点真放到 B（菜单加速键作用于**聚焦窗口**），再真实 Ctrl+W（文档干净，无确认框）
      await session.main.js(`global.__r4capA = global.windows.find(x => x.id === ${recA.id}) || null; true`);   // A 的 workspace 证人
      const focusedB = await focusRec(recB.id);
      await wB.key({ key: 'W', code: 'KeyW', vk: 87, modifiers: harness.MOD.ctrl });
      let bGone = false;
      for (let i = 0; i < 40 && !bGone; i++) {
        bGone = !((await session.recs()) || []).some(r => r.id === recB.id);
        if (!bGone) await sleep(150);
      }
      if (!bGone) {
        await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${recB.id}); if (r) r.win.close(); return true; })()`);
        say('R4MW MW3 EVIDENCE — Ctrl+W 未关掉 B 窗，已退到主进程 rec.win.close()（同一 close 处理链）');
        for (let i = 0; i < 20 && !bGone; i++) { bGone = !((await session.recs()) || []).some(r => r.id === recB.id); await sleep(150); }
      }
      const n1settle = await settleCount(2500);
      const n1 = n1settle.min;
      const capB = JSON.parse((await session.main.js(`global.__r4capB ? JSON.stringify({destroyed: global.__r4capB.win.isDestroyed(), unsubscribed: global.__r4capB.workspace._unsubscribe === null}) : 'null'`)) || 'null');
      // 未过度退订：A 还开着，X 的共享 watcher 必须继续给 A 报 tree-changed
      fs.writeFileSync(path.join(DIR, '巡.md'), '# 巡\n', 'utf8');
      let tick = 0;
      for (let i = 0; i < 30; i++) { tick = (await wA.js('window.__treeChanged || 0')) || 0; if (tick > 0) break; await sleep(150); }
      await wA.shot('mw3-a-alive');
      // 关 A（X 根的最后一个订阅者）→ A 的文档 watcher 与 X 的递归 watcher 都必须随之下线
      // （closeWatch 注掉的突变只释放前者：watcher 停在 n1-1 即红）。
      const focusedA = await focusRec(recA.id);
      await wA.key({ key: 'W', code: 'KeyW', vk: 87, modifiers: harness.MOD.ctrl });
      let aGone = false;
      for (let i = 0; i < 40 && !aGone; i++) {
        aGone = !((await session.recs()) || []).some(r => r.id === recA.id);
        if (!aGone) await sleep(150);
      }
      if (!aGone) {
        await session.main.js(`(() => { const r = global.windows.find(x => x.id === ${recA.id}); if (r) r.win.close(); return true; })()`);
        say('R4MW MW3 EVIDENCE — Ctrl+W 未关掉 A 窗，已退到主进程 rec.win.close()');
        for (let i = 0; i < 20 && !aGone; i++) { aGone = !((await session.recs()) || []).some(r => r.id === recA.id); await sleep(150); }
      }
      const n2settle = await settleCount(5000);
      const n2 = n2settle.min;
      const capA = JSON.parse((await session.main.js(`global.__r4capA ? JSON.stringify({destroyed: global.__r4capA.win.isDestroyed(), unsubscribed: global.__r4capA.workspace._unsubscribe === null}) : 'null'`)) || 'null');
      // X 已无任何窗口订阅：再动磁盘也不该有任何打点/报错；C 窗托底让应用活着
      fs.writeFileSync(path.join(DIR, '巡2.md'), '# 巡2\n', 'utf8');
      await sleep(900);
      const rest = (await session.recs()) || [];
      await wC.shot('mw3-c-remaining');
      const errs = newErrors();
      // 关 B 期望 -1（B 的文档 watcher；X 递归 watcher 仍被 A 订阅）；
      // 关 A 期望再 -2（A 的文档 watcher + X 递归 watcher 一起下线）→ 落到 n0-3。
      // 只到 n0-2（=n1-1）即 closeWatch 没退订：X 递归 watcher 泄漏 → 红。
      verdict('MW3', bGone && aGone && !!capB && capB.destroyed && capB.unsubscribed && n1 === n0 - 1 && tick > 0
        && !!capA && capA.destroyed && capA.unsubscribed && n2 <= n0 - 3 && rest.some(r => r.id === recC.id) && errs.length === 0,
        `关窗输入=Ctrl+W（聚焦确认 B=${focusedB}/A=${focusedA}，失败退主进程 close，同一处理链）；`
        + `关 B 后：watcher ${n0}→${n1}（settle 取最小，期望 -1，B 的文档 watcher；X 递归 watcher 仍被 A 订阅）、B 的 workspace 退订=${capB ? capB.unsubscribed : '?'}；`
        + `X 目录磁盘变更后 A 窗收到 tree-changed=${tick} 次（未过度退订）；`
        + `关 A 后：watcher ${n1}→${n2}（settle 最小值，期望 ≤ ${n0 - 3}：A 文档 watcher + X 递归 watcher 一起退；只到 ${n0 - 2} 即递归 watcher 泄漏）、A 的 workspace 退订=${capA ? capA.unsubscribed : '?'}；`
        + `无窗后磁盘变更 900ms：剩余窗口=${rest.map(r => r.id).join(',')}（C 托底存活）、新增页面错误 ${errs.length} 条${errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''}`);
    }
  } finally { await session.close(); }

  // ================= 会话二：MW2b restoreWindows 会话去重 =================
  {
    const profile2 = path.join(OUT, 'profile-dedup');
    fs.mkdirSync(profile2, { recursive: true });
    // 模拟历史坏会话：同一文件 A 出现两份 + B 一份（旧版本"另存为撞他窗已开文件"曾写出这种名单）
    fs.writeFileSync(path.join(profile2, 'state.json'), JSON.stringify({
      windows: [
        { file: A, ws: DIR, bounds: null, maximized: false },
        { file: A, ws: DIR, bounds: null, maximized: false },
        { file: B2, ws: DIR, bounds: null, maximized: false },
      ],
      settings: { autoSave: false, snapshots: false },
    }), 'utf8');
    const s2 = await harness.launch({ exe: EXE, appArgs: APP_ARGS, inspect: true,
      outDir: path.join(OUT, 'shots-dedup'), profile: profile2, keepProfile: true, timeout: 120000 });
    try {
      let r2 = [];
      for (let i = 0; i < 80; i++) { r2 = (await s2.recs()) || []; if (r2.length >= 2) break; await sleep(200); }
      await sleep(1500);
      r2 = (await s2.recs()) || [];
      const files = r2.map(r => r.file ? path.basename(r.file) : '(欢迎页)');
      const dupes = files.filter((f, i) => f !== '(欢迎页)' && files.indexOf(f) !== i);
      await s2.shot('mw2b-restore-dedup');
      verdict('MW2b', r2.length === 2 && dupes.length === 0,
        `坏会话 [甲,甲,丙] 恢复出 ${r2.length} 个窗口：${JSON.stringify(files)}；重复=${dupes.length ? dupes.join(',') : '无'}（旧代码 3 窗、甲 双开互相当外部变更）`);
    } finally { await s2.close(); }
  }

  const failed = results.filter(r => r.tag === 'FAIL');
  console.log(failed.length ? `\n★ R4-MW 汇总：${failed.map(r => r.name).join('、')} FAIL（${failed.length}/${results.length}）`
    : `\nR4-MW 汇总：全部 ${results.length} 项 PASS/EVIDENCE`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error('探针自身出错：', error); process.exitCode = 1; });

/** 突变验证（每条改回旧代码，本探针对应用例必须变红）：
 *  · MW1  main.js tree-rename/tree-delete 的两个 for(item of recs()) 改回只调 rec.doc.* →
 *         B 的 doc.file 永不跟随（follow=null）→ FAIL。
 *  · MW2  doc.js saveAs 里 clash 检查整段注掉 → 另存为直接落盘：A 磁盘 sha 变化 +
 *         无「已经在另一个窗口打开」message 留痕 → FAIL。
 *  · MW2b main.js restoreWindows 的 seenFiles 去重注掉 → 坏会话恢复出 3 窗 → FAIL。
 *  · MW3  main.js win.on('closed') 里的 rec.workspace.closeWatch() 注掉 →
 *         关 A 后 watcher 计数停在 n0-2（只释放 A 的文档 watcher，X 递归 watcher 泄漏）→ FAIL。
 *  · MW6  doc.js loadInShell 的 this.pushStats() 改回 this.scheduleStats() →
 *         首次出现新字数的 lag ≈ 400ms ≥ 350ms 阈值 → FAIL
 *         （注意判据必须取"首次出现**新文档**字数"的时刻：只看"第一次变化"会被
 *          shell.js 的清残影清空那次变更骗过——那不是新数据到齐）。
 */
