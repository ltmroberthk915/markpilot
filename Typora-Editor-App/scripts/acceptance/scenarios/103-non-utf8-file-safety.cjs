/** 非 UTF-8 文件不再被静默损坏：不写回原文件，并且当场告诉用户。
 *
 *  用户可见的危害（本场景锁死的就是它）：打开一个 UTF-16 或 GBK 的 `.md`，程序按 UTF-8
 *  **有损**解码成一片乱码，默认开启的 1.5 秒自动保存再把乱码写回原文件——用户的文件当场
 *  永久损坏，全程没有任何提示。VSIX 侧走 VS Code 自己的编码处理，没有这个问题。
 *
 *  三个用例**各自独立启动一次**。第一版把三个用例串在同一个会话里，结果 GBK 文档带着未保存
 *  修改去开下一个文件，撞上"关闭前是否保存？"对话框，把脚本化的弹窗步骤整个吃掉——用例之间
 *  通过"文档脏不脏"耦合，读数就全是错的。独立性是这个场景的前提，不是洁癖。
 *
 *  验收判据（都必须是用户看得见的东西）：
 *    ① 打开非 UTF-8 文件时弹出**说明编码**的对话框（读主进程记录的弹窗原文）
 *    ② 用户选"仍然打开"后编辑器里真的有内容（UTF-16 能无损读出中文，不是乱码）
 *    ③ 真键盘打的字落进编辑区、文档变脏
 *    ④ **磁盘 sha256 与打开前逐字节相同**（独立证人：测试进程自己算哈希，不读产品自报）
 *    ⑤ 对照组：同样操作一个**正常 UTF-8** 文件，磁盘必须被写出并含新字符
 *       —— 没有这条，"磁盘没变"可能只是"保存整个坏掉了"，判据就是空的
 *
 *  反假通过：把 `writeCurrent` 开头那段 encoding 守卫注掉（临时改 app 侧产物，
 *  源码不动，跑完 `npm run sync` 还原）→ 用例甲/乙的 ④ 立刻变红。
 *
 *  用法（排查）：node scripts/acceptance/run.cjs --app=dev --only=103-non-utf8-file-safety
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sleep = require('../harness.cjs').sleep;

const SURFACE = '.vditor-ir .vditor-reset';
const IF = `document.getElementById('editor').contentWindow`;

/** 独立于产品的证人：直接读磁盘字节算哈希。 */
const diskHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 一份 GBK 的 Markdown（"中文" = D6 D0 CE C4，后面接纯 ASCII）。 */
const GBK = Buffer.concat([Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]), Buffer.from(' ABC $x$ 甲\r\n', 'utf8')]);
/** 一份 UTF-16LE（带 BOM）的 Markdown。 */
const UTF16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('中文段落 $a$ 一二三\r\n', 'utf16le')]);
/** 正常 UTF-8，三个用例共用的"启动文档"。 */
const UTF8 = Buffer.from('中文段落 $a$ 一二三\r\n', 'utf8');

const EDITOR = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  return surface ? surface.innerText.replace(/\\s+/g, ' ').trim() : null; })()`;
/** 主进程侧的文档状态：只作诊断，主判据不靠它。 */
const DOCSTATE = `(() => { const doc = global.doc; if (!doc || !doc.current) return null;
  return { dirty: !!doc.current.dirty, encoding: doc.current.encoding ? doc.current.encoding.name : null,
    writable: doc.current.encoding ? doc.current.encoding.writable : null, saveError: doc.current.saveError || null }; })()`;

const caretToEnd = async (session, text) => {
  await session.js(`(() => { const w = ${IF}, d = w.document;
    const surface = d.querySelector(${JSON.stringify(SURFACE)}); if (!surface) return 0;
    surface.focus();
    const range = d.createRange(); range.selectNodeContents(surface); range.collapse(false);
    const selection = w.getSelection(); selection.removeAllRanges(); selection.addRange(range); return 1; })()`);
  await sleep(350);
  await session.type(text);
  await sleep(400);
};

const messageDialogs = async session => (await session.main.calls())
  .filter(call => call.kind === 'message')
  .map(call => ({message: String(call.options?.message || ''), detail: String(call.options?.detail || ''),
    buttons: call.options?.buttons || []}));

/** 每个用例：启动干净会话 → 菜单打开目标 → 取证 → 打字 → 等足自动保存周期 → 比对磁盘。 */
const probe = async (ctx, {title, target, warned}) => {
  const before = diskHash(target);
  const bytesBefore = fs.statSync(target).size;
  const session = await ctx.launch({args: [ctx.plain], inspect: true});
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`, {timeout: 120000, interval: 80});
    await sleep(1600);
    await session.main.clearCalls();
    const steps = [{dialog: 'open', files: [target]}];
    if (warned) steps.push({dialog: 'message', response: 0});   // response 0 = 「仍然打开」
    await session.main.script(steps);
    const clicked = await session.main.clickMenu('文件 > 在此窗口打开文件…');
    await sleep(2600);

    const dialogs = await messageDialogs(session);
    const state = await session.main.js(DOCSTATE);
    const editor = await session.js(EDITOR);
    ctx.witness(`${title}：菜单点击 / 弹窗原文 / 文档状态 / 编辑器文本`, {clicked, dialogs, state, editor});
    ctx.log(`${title} 弹窗：` + JSON.stringify(dialogs));

    await caretToEnd(session, 'Z');
    const typed = await session.js(EDITOR);
    const dirty = await session.main.js(DOCSTATE);
    await sleep(3600);          // 自动保存是 1.5 秒去抖：等足两个周期再看磁盘
    const after = diskHash(target);
    ctx.witness(`${title}：打字后磁盘哈希（独立进程计算）`,
      {before, after, same: before === after, bytesBefore, bytesAfter: fs.statSync(target).size});
    return {dialogs, state, editor, typed, dirty, before, after, bytesBefore};
  } finally {
    await ctx.release(session);
    await sleep(300);
  }
};

module.exports = {
  id: '103-non-utf8-file-safety',
  title: '非 UTF-8 文件：不写回原文件、并当场告知用户',
  async run(ctx) {
    const dir = path.join(require('../harness.cjs').project, '.perf/repro-encoding');
    fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    fs.mkdirSync(dir, {recursive: true});
    const gbkFile = path.join(dir, 'gbk.md');
    const utf16File = path.join(dir, 'utf16le.md');
    const plain = path.join(dir, 'plain.md');
    fs.writeFileSync(gbkFile, GBK);
    fs.writeFileSync(utf16File, UTF16);
    fs.writeFileSync(plain, UTF8);
    ctx.plain = plain;
    ctx.witness('素材：三份文件的原始字节与哈希（测试进程独立写出并计算）', {
      gbk: {bytes: GBK.length, sha256: diskHash(gbkFile)},
      utf16le: {bytes: UTF16.length, sha256: diskHash(utf16File)},
      plain: {bytes: UTF8.length, sha256: diskHash(plain)},
    });

    // ══ 甲：GBK（非法 UTF-8）═══════════════════════════════════════════════
    const gbk = await probe(ctx, {title: '甲 GBK', target: gbkFile, warned: true});
    ctx.assert('甲 打开非 UTF-8 文件时弹出了对话框（不是静默处理）', gbk.dialogs.length >= 1, JSON.stringify(gbk.dialogs));
    ctx.assert('甲 对话框文案点明了编码问题，并说明不会写回原文件',
      gbk.dialogs.some(dialog => /非 UTF-8/.test(dialog.message) && /不会写回/.test(dialog.message + dialog.detail)),
      JSON.stringify(gbk.dialogs[0]));
    ctx.assert('甲 对话框给出的选择是"仍然打开 / 取消"',
      gbk.dialogs.some(dialog => JSON.stringify(dialog.buttons).includes('仍然打开')), JSON.stringify(gbk.dialogs[0]?.buttons));
    ctx.assert('甲 用户选"仍然打开"之后编辑器里确实有内容（文件真的打开了）',
      typeof gbk.editor === 'string' && gbk.editor.length > 0, JSON.stringify(gbk.editor));
    ctx.assert('甲 文档被识别为不可写', gbk.state && gbk.state.writable === false, JSON.stringify(gbk.state));
    ctx.assert('甲 真键盘打的字落进了编辑区（否则"磁盘没变"是空的）',
      typeof gbk.typed === 'string' && gbk.typed.includes('Z'), JSON.stringify(gbk.typed));
    ctx.assert('甲 文档确实变脏了（本该触发自动保存）', gbk.dirty && gbk.dirty.dirty === true, JSON.stringify(gbk.dirty));
    ctx.assert('甲 打完字等足自动保存周期，磁盘仍然逐字节未变',
      gbk.before === gbk.after, JSON.stringify({before: gbk.before, after: gbk.after, bytes: gbk.bytesBefore}));

    // ══ 乙：UTF-16LE（无损解码，同样不许写回）══════════════════════════════
    const utf16 = await probe(ctx, {title: '乙 UTF-16LE', target: utf16File, warned: true});
    ctx.assert('乙 对话框点明这是 UTF-16LE',
      utf16.dialogs.some(dialog => /UTF-16LE/.test(dialog.message)), JSON.stringify(utf16.dialogs[0]?.message));
    ctx.assert('乙 编辑器里是无损解码出来的**正确中文**，不是乱码',
      typeof utf16.editor === 'string' && utf16.editor.includes('中文段落') && !utf16.editor.includes('\uFFFD'),
      JSON.stringify(utf16.editor));
    ctx.assert('乙 文档被识别为不可写', utf16.state && utf16.state.writable === false, JSON.stringify(utf16.state));
    ctx.assert('乙 打完字等足自动保存周期，磁盘仍然逐字节未变',
      utf16.before === utf16.after, JSON.stringify({before: utf16.before, after: utf16.after}));

    // ══ 丙：对照组 —— 正常 UTF-8 必须照常保存 ═══════════════════════════════
    const plainCase = await probe(ctx, {title: '丙 UTF-8 对照', target: plain, warned: false});
    ctx.assert('丙 正常 UTF-8 文件不弹任何提示', plainCase.dialogs.length === 0, JSON.stringify(plainCase.dialogs));
    ctx.assert('丙 正常 UTF-8 文件被识别为可写', plainCase.state && plainCase.state.writable === true, JSON.stringify(plainCase.state));
    ctx.assert('丙 对照组：正常 UTF-8 文件的改动**写到了磁盘上**（证明写盘路径没坏）',
      plainCase.before !== plainCase.after, JSON.stringify({before: plainCase.before, after: plainCase.after}));
    ctx.assert('丙 对照组：磁盘上能读到刚打的字',
      fs.readFileSync(plain, 'utf8').includes('Z'), JSON.stringify(fs.readFileSync(plain, 'utf8')));
  },
};
