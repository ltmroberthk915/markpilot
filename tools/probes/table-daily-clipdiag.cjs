/** table-daily 族 · 剪贴板通道判别（为什么"粘贴"用例全成了空粘贴）
 *
 *  背景：第一版 P1 正对照回读为空 ⇒ 粘贴用例全部记「未验证」。本探针把**写入通道**与**回读尺子**
 *  分开量，每条都配一个"真 Ctrl+V 落进文档"的端到端判据（不是只看回读）：
 *   ① 尺子自检：Node 起 pwsh 读系统剪贴板（能读吗）
 *   ② 壳层写：mpHost.writeClipboard({text}) → pwsh 回读 → 真 Ctrl+V 落地？
 *   ③ 系统写：PowerShell Set-Clipboard（UTF-8 文件 → 读文件内容） → 回读 → 真 Ctrl+V 落地？
 *   ④ 渲染侧写：navigator.clipboard.writeText → 回读 → 真 Ctrl+V 落地？
 *  用法：node table-daily-clipdiag.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const L = require('./table-daily-lib.cjs');
const EXE = process.argv[2];
const DOC = ['# 剪贴板通道', '', '甲段。', '', '乙段。', ''].join('\n');
const SENT = 'MPTD-SENT-甲乙-1';

(async () => {
  const S = await L.boot({ probe: 'table-daily-clipdiag.cjs', dir: 'clipdiag', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  /* ── ① Node → pwsh 读剪贴板：尺子自检 ── */
  const psReadFile = path.join(S.DIR, 'ps-read.txt');
  const psRead = () => {
    try {
      execSync(`pwsh -NoProfile -Command "[IO.File]::WriteAllText('${psReadFile.replace(/\\/g, '/')}', [string](Get-Clipboard -Raw))"`, { windowsHide: true, stdio: 'pipe' });
      return { ok: true, v: fs.readFileSync(psReadFile, 'utf8') };
    } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160), out: String((e && e.stdout) || '').slice(0, 120), errOut: String((e && e.stderr) || '').slice(0, 160) }; }
  };
  const psWrite = (text) => {
    const f = path.join(S.DIR, 'ps-write.txt');
    fs.writeFileSync(f, text, 'utf8');
    try {
      execSync(`pwsh -NoProfile -Command "Set-Clipboard -Value ([IO.File]::ReadAllText('${f.replace(/\\/g, '/')}', [Text.Encoding]::UTF8))"`, { windowsHide: true, stdio: 'pipe' });
      return { ok: true };
    } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160) }; }
  };

  try {
    await S.assertFixture({ line: '甲段。' });

    add('C1 pwsh 读剪贴板自检（写盘前）', psRead());

    /* 让文档里有可判定的落点：真实点第 3 行行尾 */
    const put = async () => { await S.clickDocLine(3); await S.key('End', 250); };
    const docNow = () => S.ev(() => window.mpEngine._view().state.doc.toString());
    const undoAll = async (n = 3) => { for (let i = 0; i < n; i++) await S.key('Control+z', 450); };

    /* ── ② 壳层写 → pwsh 回读 → 真 Ctrl+V ── */
    await S.guard('C2', async () => {
      const w = await S.ev((t) => window.mpHost.writeClipboard({ text: t }), SENT + '-HOST');
      await S.sleep(300);
      const r = psRead();
      add('C2a 壳层写 mpHost.writeClipboard', { 返回: w, pwsh回读: { ok: r.ok, 值: String(r.v || '').slice(0, 40), 长度: String(r.v || '').length }, 期望: SENT + '-HOST' });
      await put();
      await S.key('Control+v', 900);
      const doc = await docNow();
      add('C2b 真 Ctrl+V 落地', { 判据_落地: doc.includes(SENT + '-HOST'), 文档: doc.split('\n'), 粘贴事件: await S.pasteLog() });
      await undoAll();
    });

    /* ── ③ 系统写（PowerShell Set-Clipboard）→ pwsh 回读 → 真 Ctrl+V ── */
    await S.guard('C3', async () => {
      const w = psWrite(SENT + '-SYS');
      await S.sleep(300);
      const r = psRead();
      add('C3a PowerShell Set-Clipboard', { 返回: w, pwsh回读: { ok: r.ok, 值: String(r.v || '').slice(0, 40), 长度: String(r.v || '').length }, 期望: SENT + '-SYS' });
      await put();
      await S.key('Control+v', 900);
      const doc = await docNow();
      add('C3b 真 Ctrl+V 落地', { 判据_落地: doc.includes(SENT + '-SYS'), 文档: doc.split('\n'), 粘贴事件: await S.pasteLog() });
      await undoAll();
    });

    /* ── ④ 渲染侧写 → 回读 → 真 Ctrl+V ── */
    await S.guard('C4', async () => {
      const w = await S.ev(async (t) => {
        try { await navigator.clipboard.writeText(t); return { ok: true }; } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 80) }; }
      }, SENT + '-REND');
      await S.sleep(300);
      const r = psRead();
      const back = await S.ev(async () => String(await navigator.clipboard.readText().catch((e) => 'ERR:' + String((e && e.message) || e))).slice(0, 40));
      add('C4a navigator.clipboard.writeText', { 返回: w, pwsh回读: { ok: r.ok, 值: String(r.v || '').slice(0, 40) }, 渲染侧回读: back, 期望: SENT + '-REND' });
      await put();
      await S.key('Control+v', 900);
      const doc = await docNow();
      add('C4b 真 Ctrl+V 落地', { 判据_落地: doc.includes(SENT + '-REND'), 文档: doc.split('\n'), 粘贴事件: await S.pasteLog() });
      await undoAll();
    });

    /* ── ⑤ 结论：哪条通道能把哨兵送进真粘贴 ── */
    add('C5 判定', {
      说明: '只有"真 Ctrl+V 落地"为 true 的通道才能当 table-daily-paste 的装弹通道；pwsh 回读若自身 ok=false，则它不能当尺子',
      pageerror: S.errs.slice(0, 6), consoleError: S.cerrs.slice(0, 6),
    });
  } catch (e) {
    add('C-EXC', { 异常: String((e && e.message) || e).slice(0, 300) });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
