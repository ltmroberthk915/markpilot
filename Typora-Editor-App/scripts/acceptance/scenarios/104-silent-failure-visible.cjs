/** 静默失败变可见 + 可诊断：保存失败常驻提示，并且用户手上有东西可以交出来。
 *
 *  修前状态（已核代码）：自动保存失败 / 外部冲突 / 文件被删，只在状态栏渲染成一个 "●" 小点，
 *  真正的错误文案塞在 `#st-save` 的 title 里——**要悬浮才看得到**。而全应用没有任何日志文件：
 *  没有 console 拦截、没有 uncaughtException / unhandledRejection / render-process-gone，
 *  18 处 console.error 全进 stderr；打包后的 Windows 用户既看不到、也交不出任何东西。
 *
 *  验收判据（用户看得见 + 独立通道证人）：
 *    ① **对照组**：保存成功时那条提示必须不出现（否则"永远显示提示条"也能蒙过去）
 *    ② 只读文件导致保存失败时：`#sb-save` 提示条真的显示出来，且文案是具体原因
 *    ③ 状态栏那格从含糊的"● 保存待处理"变成直白的"● 保存失败"
 *    ④ 日志文件真的落在磁盘上、含启动行（测试进程独立读字节，不读产品自报）
 *    ⑤ 剪贴板证人：菜单「帮助 → 复制诊断信息」把诊断内容交给系统剪贴板，
 *       由独立进程读回——这是"用户真的能把它交出去"的证明
 *
 *  用法（排查）：node scripts/acceptance/run.cjs --app=dev --only=104-silent-failure-visible
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const sleep = harness.sleep;

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;

/** 外壳页（顶层窗口）上的保存状态与提示条。 */
const SHELLSTATE = `(() => {
  const box = document.getElementById('sb-save'), text = document.getElementById('sb-save-text');
  const item = document.getElementById('st-save'), bar = document.getElementById('statusbar');
  return { saveBoxVisible: !!box && !box.hidden, saveText: text ? text.textContent : null,
    saveItemText: item ? item.textContent : null, saveItemTitle: item ? item.title : null,
    statusbarVisible: !!bar && bar.style.display !== 'none' }; })()`;

const caretToEnd = async session => {
  await session.js(`(() => { const w = ${IF}, d = w.document;
    const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return 0;
    surface.focus();
    const range = d.createRange(); range.selectNodeContents(surface); range.collapse(false);
    const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range); return 1; })()`);
  await sleep(350);
  await session.type('Z');
  await sleep(400);
};

module.exports = {
  id: '104-silent-failure-visible',
  title: '静默失败变可见：保存失败常驻提示 + 诊断日志可交出',
  async run(ctx) {
    const dir = path.join(harness.project, '.perf/repro-silent');
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    fs.mkdirSync(dir, {recursive: true});
    const writable = path.join(dir, '可写.md');
    const readonlyFile = path.join(dir, '只读.md');
    const body = '中文段落 $a$ 一二三\r\n';
    fs.writeFileSync(writable, body, 'utf8');
    fs.writeFileSync(readonlyFile, body, 'utf8');
    fs.chmodSync(readonlyFile, 0o444);           // Windows 上就是把只读属性置上
    const clipboardDir = path.join(dir, 'clip');
    fs.mkdirSync(clipboardDir, {recursive: true});

    // 剪贴板是全系统独占资源：先存后还（仓库里 70/73 场景同一做法）
    let savedClipboard = null;
    try { savedClipboard = harness.saveClipboard(clipboardDir); } catch { savedClipboard = null; }

    const session = await ctx.launch({args: [writable], inspect: true});
    try {
      await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
      await sleep(1800);

      // ══ ① 对照组：保存成功时不该有任何提示条 ═══════════════════════════════
      await caretToEnd(session);
      await sleep(3600);                          // 自动保存 1.5 秒去抖
      const good = await session.js(SHELLSTATE);
      ctx.witness('① 可写文件保存后：磁盘内容与外壳状态', {shell: good, disk: fs.readFileSync(writable, 'utf8')});
      ctx.log('可写文件保存后：' + JSON.stringify(good));
      ctx.assert('① 对照组：保存成功时提示条不显示', good.saveBoxVisible === false, JSON.stringify(good));
      ctx.assert('① 对照组：状态栏不显示"保存失败"', !/保存失败/.test(String(good.saveItemText)), JSON.stringify(good.saveItemText));
      ctx.assert('① 对照组：磁盘上确实写进了刚打的字（证明这次保存是真成功的）',
        fs.readFileSync(writable, 'utf8').includes('Z'), JSON.stringify(fs.readFileSync(writable, 'utf8')));

      // ══ ② ③ 只读文件 → 保存失败必须看得见 ═══════════════════════════════════
      await session.main.clearCalls();
      await session.main.script([{dialog: 'open', files: [readonlyFile]}]);
      await session.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(2600);
      await caretToEnd(session);
      await sleep(3600);
      const bad = await session.js(SHELLSTATE);
      const badDialogs = await session.main.js(`(() => {
        const calls = global.__accDialog ? global.__accDialog.calls : [];
        return calls.filter(call => call.kind === 'message').map(call => String(call.options && call.options.message || '')); })()`);
      ctx.witness('② 只读文件保存失败后：外壳状态与磁盘内容',
        {shell: bad, dialogs: badDialogs, disk: fs.readFileSync(readonlyFile, 'utf8'), readonly: true});
      ctx.log('只读文件保存后：' + JSON.stringify(bad));
      ctx.assert('② 保存失败时提示条真的显示出来（不再只藏在悬浮提示里）', bad.saveBoxVisible === true, JSON.stringify(bad));
      ctx.assert('② 提示条里有具体原因，不是一句空话',
        typeof bad.saveText === 'string' && bad.saveText.length >= 8 && /只读|保存|占用|替换/.test(bad.saveText), JSON.stringify(bad.saveText));
      ctx.assert('② 悬浮提示里同时留着完整原因（两处都能看到）',
        typeof bad.saveItemTitle === 'string' && bad.saveItemTitle.length >= 8, JSON.stringify(bad.saveItemTitle));
      ctx.assert('③ 状态栏那格直白地写"保存失败"，不再是含糊的"保存待处理"',
        /保存失败/.test(String(bad.saveItemText)), JSON.stringify(bad.saveItemText));
      ctx.assert('② 只读文件本身一个字节都没被改动（失败就是失败，不许写坏）',
        fs.readFileSync(readonlyFile, 'utf8') === body, JSON.stringify(fs.readFileSync(readonlyFile, 'utf8')));

      // ══ ④ 日志文件真的落在磁盘上（测试进程独立读） ═════════════════════════
      const logFile = path.join(session.profile, 'logs', 'markpilot.log');
      const logExists = fs.existsSync(logFile);
      const logText = logExists ? fs.readFileSync(logFile, 'utf8') : '';
      ctx.witness('④ 诊断日志：路径、字节数、前 300 字', {logFile, exists: logExists, bytes: logText.length, head: logText.slice(0, 300)});
      ctx.assert('④ 诊断日志落在磁盘上（用户有东西可以交出来）', logExists && logText.length > 0, JSON.stringify({logFile, bytes: logText.length}));
      ctx.assert('④ 日志里有启动记录（说明采集器真的装上了）',
        /diagnostics start/.test(logText), JSON.stringify(logText.slice(0, 200)));

      // ══ ⑤ 剪贴板证人：菜单能把诊断内容交出去 ═══════════════════════════════
      await session.main.clearCalls();
      const copied = await session.main.clickMenu('帮助 > 复制诊断信息');
      await sleep(600);
      let clip = null, clipError = null;
      try { clip = harness.readClipboard(clipboardDir); } catch (error) { clipError = error.message; }
      ctx.witness('⑤ 剪贴板独立进程读回（帮助 → 复制诊断信息）',
        {clicked: copied, text: clip ? String(clip.text).slice(0, 300) : null, error: clipError});
      ctx.assert('⑤ 菜单项点得动（「帮助 → 复制诊断信息」存在且可点）', String(copied).startsWith('CLICKED'), JSON.stringify(copied));
      ctx.assert('⑤ 系统剪贴板里确实拿到了诊断内容（独立进程读回）',
        !!clip && /MarkPilot 诊断信息/.test(String(clip.text)) && /版本/.test(String(clip.text)),
        JSON.stringify({text: clip ? String(clip.text).slice(0, 200) : null, error: clipError}));
    } finally {
      try { fs.chmodSync(readonlyFile, 0o666); } catch { /* 清目录时再兜底 */ }
      await ctx.release(session);
      if (savedClipboard) { try { harness.restoreClipboard(clipboardDir, savedClipboard.__file); } catch { /* 忽略 */ } }
      await sleep(300);
    }
  },
};
