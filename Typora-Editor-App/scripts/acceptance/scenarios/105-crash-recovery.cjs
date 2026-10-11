/** 崩溃/异常退出的内容保护：未保存的内容可恢复，偏好损坏不再静默重置。
 *
 *  修前状态（已核代码）：
 *  · 脏文档的快照间隔是 **5 分钟**，硬崩最多丢 5 分钟输入；而且**没有任何启动恢复入口**——
 *    用户得自己知道去「文件 → 版本历史… → 恢复为副本」，否则根本不知道有东西可恢复。
 *  · `state.js` 用 `fs.writeFileSync` 非原子写 `state.json`；写到一半崩溃就截断成半截 JSON，
 *    下次启动解析失败被**整个吞掉**、静默重置全部偏好——连 autoSave / snapshots 都被悄悄翻回 true。
 *
 *  本场景怎么造出"崩溃残留"这个状态：不去等 60 秒的快照间隔，而是让**保存失败**
 *  （只读文件）触发一次 `save-failed` 快照——磁盘是旧内容、快照是新内容，这与崩溃遗留
 *  在判定上完全是同一件事（`offerRecovery` 只看"快照比文件新且内容不同"）。
 *  然后 `taskkill /F` 硬杀进程，再用**同一个 profile** 重启。
 *
 *  验收判据（用户看得见 + 独立通道证人）：
 *    ① 落盘前置条件：快照目录里真的有文件（没有它，"恢复"无从谈起）
 *    ② 重启后打开该文件 → 弹出「发现未保存的内容」；选"生成恢复副本"
 *    ③ 独立证人：恢复副本出现在文档旁边、内容含崩溃前敲的字；**原文件逐字节未变**
 *    ④ 对照组：正常保存过的文件**不**弹恢复提示（否则"每次都弹"也能过）
 *    ⑤ 偏好文件损坏：启动时弹出说明 + 磁盘上留下 `.corrupt-*.json` 备份且内容就是那份坏文件
 *
 *  用法（排查）：node scripts/acceptance/run.cjs --app=dev --only=105-crash-recovery
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const harness = require('../harness.cjs');
const sleep = harness.sleep;
const project = harness.project;

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;
const BODY = '中文段落 $a$ 一二三\r\n';
const diskHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const caretToEndAndType = async (session, text) => {
  await session.js(`(() => { const w = ${IF}, d = w.document;
    const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return 0;
    surface.focus();
    const range = d.createRange(); range.selectNodeContents(surface); range.collapse(false);
    const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range); return 1; })()`);
  await sleep(350);
  await session.type(text);
  await sleep(400);
};
const messages = async session => (await session.main.calls())
  .filter(call => call.kind === 'message')
  .map(call => ({message: String(call.options?.message || ''), detail: String(call.options?.detail || ''),
    buttons: call.options?.buttons || []}));

module.exports = {
  id: '105-crash-recovery',
  title: '崩溃保护：未保存内容可恢复 + 偏好损坏不再静默重置',
  async run(ctx) {
    const dir = path.join(project, '.perf/repro-crash');
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    fs.mkdirSync(dir, {recursive: true});
    const profile = path.join(dir, 'profile');
    const savedFile = path.join(dir, '已保存.md');
    const roFile = path.join(dir, '只读.md');
    fs.writeFileSync(savedFile, BODY, 'utf8');
    fs.writeFileSync(roFile, BODY, 'utf8');
    fs.chmodSync(roFile, 0o444);
    const roBefore = diskHash(roFile);

    // ══ 会话甲：造出「磁盘旧 / 快照新」，然后硬杀 ═══════════════════════════════
    const first = await ctx.launch({profile, args: [savedFile], inspect: true});
    let survived = true;
    try {
      await first.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
      await sleep(1800);
      await caretToEndAndType(first, 'A');
      await sleep(3600);                                  // 保存成功
      ctx.assert('会话甲：可写文件的改动正常落盘（对照组的基线）',
        fs.readFileSync(savedFile, 'utf8').includes('A'), JSON.stringify(fs.readFileSync(savedFile, 'utf8')));

      await first.main.clearCalls();
      await first.main.script([{dialog: 'open', files: [roFile]}]);
      await first.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(2600);
      await caretToEndAndType(first, 'B');
      await sleep(3600);                                  // 自动保存失败 → 落下 save-failed 快照

      const snapDir = await first.main.js(`global.doc.snapshots.directory(${JSON.stringify(roFile)})`);
      const snapFiles = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(name => name.endsWith('.md')) : [];
      ctx.witness('① 崩溃前：只读文档的快照目录内容（产品给路径，字节由测试进程读）',
        {snapDir, files: snapFiles, diskUnchanged: diskHash(roFile) === roBefore});
      ctx.assert('① 崩溃前磁盘上确实留下了"比文件更新"的快照（恢复的前提）',
        snapFiles.length >= 1, JSON.stringify({snapDir, files: snapFiles}));
      ctx.assert('① 只读原文件在保存失败后仍未被改动', diskHash(roFile) === roBefore, JSON.stringify({roBefore, now: diskHash(roFile)}));

      execFileSync('taskkill', ['/PID', String(first.child.pid), '/T', '/F'], {stdio: 'ignore'});
      survived = false;
      ctx.log('已硬杀会话甲进程（模拟崩溃，不走任何退出流程）');
    } finally {
      await ctx.release(first);
      await sleep(500);
    }
    ctx.assert('会话甲是被硬杀的（不是正常退出）', survived === false, JSON.stringify({survived}));

    // ══ 破坏 state.json：验证"不再静默重置" ═══════════════════════════════════
    const corruptBody = '{ 这不是 JSON';
    fs.writeFileSync(path.join(profile, 'state.json'), corruptBody, 'utf8');

    // ══ 会话乙：同一 profile 重启，走菜单打开（避开启动期对话框的时序问题） ═════
    const second = await ctx.launch({profile, keepProfile: true, inspect: true});
    try {
      await second.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
      await sleep(2200);

      // ══ ⑤ 偏好损坏不再静默 ═══════════════════════════════════════════════════
      const startup = await messages(second);
      const backups = fs.readdirSync(profile).filter(name => /^state\.corrupt-.*\.json$/.test(name));
      ctx.witness('⑤ 偏好损坏：启动弹窗与备份文件', {dialogs: startup, backups});
      ctx.log('启动弹窗：' + JSON.stringify(startup));
      ctx.assert('⑤ 偏好文件损坏时弹出说明（不再静默重置）',
        startup.some(dialog => /偏好设置/.test(dialog.message)), JSON.stringify(startup));
      ctx.assert('⑤ 磁盘上留下了损坏文件的备份，且内容就是那份坏文件',
        backups.length >= 1 && fs.readFileSync(path.join(profile, backups[0]), 'utf8') === corruptBody,
        JSON.stringify({backups, content: backups.length ? fs.readFileSync(path.join(profile, backups[0]), 'utf8') : null}));

      // ══ ④ 对照组：正常保存过的文件不弹恢复提示 ═══════════════════════════════
      await second.main.clearCalls();
      await second.main.script([{dialog: 'open', files: [savedFile]}]);
      await second.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(3000);
      const controlDialogs = await messages(second);
      ctx.witness('④ 对照组：打开"正常保存过"的文件时的弹窗', controlDialogs);
      ctx.assert('④ 对照组：正常保存过的文件不弹恢复提示（否则"每次都弹"也能过）',
        !controlDialogs.some(dialog => /未保存的修改|未保存的内容/.test(dialog.message + dialog.detail)),
        JSON.stringify(controlDialogs));

      // ══ ④b 对照组：**含内嵌图片 + mtime 很旧**的文件也不许弹恢复提示 ═══════════
      // 为什么单列这一条（2026-09-17 实测踩到）：快照里存的是**磁盘形态**（内嵌图片展开成
      // base64、行尾还原），而编辑区的 `cur.text` 是**视图形态**（内嵌图片被遮成引用）。
      // 拿视图形态去比磁盘形态，凡是含内嵌图片的文档都会被判成"有东西可恢复"，再叠上
      // "文件 mtime 比快照旧"（拷贝/同步/解压出来的文件几乎都是这样）就弹模态框——
      // 而那份内容是刚从磁盘读出来、一个字节都不差的。模态框还会把应用挡住（无人应答时是死等），
      // 打包版跑受保护素材就是这么整条失败的。
      const embeddedFile = path.join(dir, '内嵌图片.md');
      fs.writeFileSync(embeddedFile, [
        '# 内嵌图片验收', '',
        '这一段之后是一张内嵌图片（data URI，不走磁盘上的相对路径）。', '',
        '![小图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=)', '',
        '图片之后的正文：用来确认这个文件能被正常打开。', '',
      ].join('\n'), 'utf8');
      const old = new Date('2026-01-02T03:04:05Z');
      fs.utimesSync(embeddedFile, old, old);           // 拷贝/同步来的文件：mtime 很旧
      await second.main.clearCalls();
      await second.main.script([{dialog: 'open', files: [embeddedFile]}]);
      await second.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(3500);
      const embeddedDialogs = await messages(second);
      const embeddedState = await second.js(`(() => { const w = ${IF}, d = w.document;
        const surface = d.querySelector(${JSON.stringify(SURFACE)});
        return {ready: !!surface, text: surface ? surface.textContent.slice(0, 40) : null,
          images: surface ? surface.querySelectorAll('img').length : 0,
          展开的base64: surface ? /base64,/.test(surface.textContent) : null}; })()`);
      ctx.witness('④b 含内嵌图片且 mtime 很旧的文件：弹窗与打开状态',
        {dialogs: embeddedDialogs, state: embeddedState, mtime: fs.statSync(embeddedFile).mtime.toISOString()});
      ctx.assert('④b 含内嵌图片 + mtime 很旧的文件打开时**不**弹恢复提示（视图形态 ≠ 磁盘形态的误报）',
        !embeddedDialogs.some(dialog => /未保存的修改|未保存的内容/.test(dialog.message + dialog.detail)),
        JSON.stringify(embeddedDialogs));
      ctx.assert('④b 该文件正常打开（编辑面在、正文与图片都在）',
        embeddedState.ready && embeddedState.images >= 1 && /内嵌图片验收/.test(String(embeddedState.text)),
        JSON.stringify(embeddedState));

      // ══ ②③ 恢复：打开只读文件 → 应弹提示，选"生成恢复副本" ══════════════════
      await second.main.clearCalls();
      await second.main.script([
        {dialog: 'open', files: [roFile]},
        {dialog: 'message', response: 0},   // 发现未保存的内容 → 生成恢复副本
        {dialog: 'message', response: 2},   // 恢复副本已生成 → 关闭
      ]);
      await second.main.clickMenu('文件 > 在此窗口打开文件…');
      await sleep(4200);
      const recDialogs = await messages(second);
      const copies = fs.readdirSync(dir).filter(name => name.startsWith('只读-') && name.endsWith('.md'));
      const copyText = copies.length ? fs.readFileSync(path.join(dir, copies[0]), 'utf8') : null;
      ctx.witness('②③ 恢复：弹窗原文、恢复副本、原文件哈希',
        {dialogs: recDialogs, copies, copyText, roBefore, roAfter: diskHash(roFile)});
      ctx.log('恢复弹窗：' + JSON.stringify(recDialogs));
      ctx.assert('② 重启后打开该文件，弹出「发现未保存的内容」',
        recDialogs.some(dialog => /未保存的修改/.test(dialog.message)), JSON.stringify(recDialogs));
      ctx.assert('② 提示里说明了可以生成恢复副本、且原文件不会被动',
        recDialogs.some(dialog => /恢复副本/.test(dialog.detail) && /原文件不会被动|没有被改动/.test(dialog.detail)),
        JSON.stringify(recDialogs[0]));
      ctx.assert('③ 恢复副本真的生成在文档旁边', copies.length >= 1, JSON.stringify({copies, dir}));
      ctx.assert('③ 恢复副本里含崩溃前敲进去的那个字（内容真的是那份未保存的）',
        typeof copyText === 'string' && copyText.includes('B'), JSON.stringify(copyText));
      ctx.assert('③ 原文件从头到尾一个字节都没被动过（恢复只生成副本，绝不覆盖）',
        diskHash(roFile) === roBefore, JSON.stringify({roBefore, roAfter: diskHash(roFile)}));
    } finally {
      try { fs.chmodSync(roFile, 0o666); } catch { /* 清目录时再兜底 */ }
      await ctx.release(second);
      await sleep(300);
    }
  },
};
