/** 复制图片到系统剪贴板验收（打包产物 + 真实鼠标键盘 + 独立进程读回 CF_HDROP）。
 *
 *  这是本轮用户实测失败过的那条路：开发树上一切正常，装到用户机器上报
 *  "复制图片失败：无法写入系统剪贴板 / -File …app.asar…"——媒体宿主把 PowerShell 脚本的
 *  路径拼成了 app.asar 里的虚拟路径，外部进程打不开。所以这条验收必须
 *  ① 跑在打包产物上，② 用独立进程读回真实剪贴板，③ 断言错误面上没有乱码/路径泄漏。
 *
 *  两种多选顺序都要成立（用户反馈的瑕疵）：
 *    A 先按 Ctrl 点第一张 → 再 Ctrl 点后续（原有）
 *    B 先普通点第一张 → 再按住 Ctrl 点第二张（新增：单选那张要被"迁移"进多选集合）
 *  判据是看得见的样式：单选 = 实线框，多选 = 虚线框（`outline-style` solid/dashed）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');

const IMG_RECTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc ? doc.querySelector('.vditor-ir .vditor-reset') : null;
  if (!surface) return {ok: false, error: '找不到编辑面'};
  const frameRect = frame.getBoundingClientRect();
  const images = [...surface.querySelectorAll('img')].filter(img => !img.closest('.katex,.emoji'));
  return {ok: true, frameRect: {x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height},
    images: images.map(img => {
      const rect = img.getBoundingClientRect();
      return {src: String(img.getAttribute('src') || '').split('/').pop(), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        classes: img.className, outline: w.getComputedStyle(img).outlineStyle, loaded: img.complete && img.naturalWidth > 0};
    })};
})()`;

/** 选区状态：类名 + computed outline（"看得见"的判据，而不是只看类名）。 */
const STATE = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc ? doc.querySelector('.vditor-ir .vditor-reset') : null;
  const images = surface ? [...surface.querySelectorAll('img')] : [];
  const describe = img => ({name: String(img.getAttribute('src') || '').split('/').pop(),
    multi: img.classList.contains('typora-img-multi-selected'), single: img.classList.contains('typora-img-selected'),
    outline: w.getComputedStyle(img).outlineStyle});
  return {images: images.map(describe),
    multiCount: images.filter(img => img.classList.contains('typora-img-multi-selected')).length,
    singleCount: images.filter(img => img.classList.contains('typora-img-selected')).length};
})()`;

// 提示气泡只活 2.2s，事后再查会读到 null（第一版就因此把"有错误提示"漏成"没有提示"）。
// 所以先挂观测器把气泡文本与 copy 事件逐条记下来。copy 监听挂在 window 上：
// 产品自己的监听在 document 捕获阶段就 stopImmediatePropagation，挂 document 会被它挡掉。
const WATCH = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  if (!w.__toastObserver) {
    w.__toastObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('typora-context-toast')) w.__toasts.push(node.textContent);
      }
    });
    w.__toastObserver.observe(doc.body, { childList: true });
  }
  if (!w.__copyListener) {
    w.__copyListener = event => w.__copylog.push({prevented: event.defaultPrevented, types: event.clipboardData ? [...event.clipboardData.types] : null});
    w.addEventListener('copy', w.__copyListener, true);
  }
  w.__toasts = []; w.__copylog = [];
  return true;
})()`;

const WATCHED = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  return {toasts: w.__toasts || [], copylog: w.__copylog || [], iframeFocused: w.document.hasFocus()};
})()`;

const FOCUS_EDITOR = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w.document;
  const surface = doc.querySelector('.vditor-ir .vditor-reset');
  const paragraph = [...surface.children].find(block => block.textContent.length > 20 && !block.querySelector('img'));
  if (!paragraph) return null;
  const rect = paragraph.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  return {x: Math.round(frameRect.x + rect.x + 12), y: Math.round(frameRect.y + rect.y + 8)};
})()`;

const errorsOf = text => {
  const problems = [];
  if (!text) return problems;
  if (/\uFFFD/.test(text)) problems.push('含替换字符（编码解码坏了）');
  if (/-File\s/.test(text)) problems.push('含 PowerShell 用法文本');
  if (/app\.asar/i.test(text)) problems.push('含 app.asar 虚拟路径');
  if (/无法写入系统剪贴板|失败/.test(text)) problems.push('含失败提示');
  return problems;
};

const center = (geometry, index) => ({
  x: Math.round(geometry.frameRect.x + geometry.images[index].x + geometry.images[index].width / 2),
  y: Math.round(geometry.frameRect.y + geometry.images[index].y + geometry.images[index].height / 2),
});

module.exports = {
  id: '20-copy-images',
  title: '多选两种顺序 → Ctrl+C → 系统剪贴板（独立进程读回）',
  async run(ctx) {
    const scene = fixtures.images();
    const expected = scene.images.map(file => ({name: path.basename(file), sha: harness.fileSha(file), bytes: fs.statSync(file).size}));
    ctx.witness('磁盘素材（要复制的三张图）', { files: expected.map(item => item.name), bytes: expected.map(item => item.bytes) });
    const clipboardDir = path.join(ctx.outDir, '20-copy-images');
    fs.mkdirSync(clipboardDir, { recursive: true });
    const saved = harness.saveClipboard(clipboardDir);
    ctx.witness('跑前保存用户剪贴板', { hasText: saved.hasText, hasImage: saved.hasImage, hasFiles: saved.hasFiles, files: (saved.files || []).length });
    const session = await ctx.launch({ args: [scene.markdown] });
    try {
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
        return !!(surface && [...surface.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth > 0).length >= 3);
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('三张图片都真的加载出来了（naturalWidth>0）', ready, `ready=${ready}`);
      if (!ready) return;
      const geometry = await session.js(IMG_RECTS);
      ctx.log('图片几何：' + JSON.stringify(geometry.images?.map(img => ({src: img.src, loaded: img.loaded}))));
      ctx.assert('找到三张可点击的图片', geometry.ok && geometry.images.length >= 3, JSON.stringify(geometry.images?.map(img => img.src)));

      // 先把焦点交给编辑器 iframe：真实用户是先点进正文再按快捷键的；CDP 注入的
      // Ctrl+C 到不了浏览器加速器时 copy 事件根本不派发（本轮踩过）。
      const focusPoint = await session.js(FOCUS_EDITOR);
      ctx.assert('找到可以点进去的正文块（把焦点交给编辑器 iframe）', !!focusPoint, JSON.stringify(focusPoint));
      if (!focusPoint) return;
      await session.click(focusPoint.x, focusPoint.y);
      await harness.sleep(150);

      for (const order of [
        { name: 'ctrl-first', title: '先 Ctrl 点第一张 → 再 Ctrl 点后续', clicks: [['ctrl', 0], ['ctrl', 1], ['ctrl', 2]] },
        { name: 'plain-first', title: '先普通点第一张 → 再 Ctrl 点第二张（本轮修复）', clicks: [['plain', 0], ['ctrl', 1], ['ctrl', 2]], checkMigration: true },
      ]) {
        // 每一轮开始前清空选择（Esc 是产品自己的清空手势），并自证清空了。
        await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
        await harness.sleep(200);
        const clean = await session.js(STATE);
        ctx.assert(`${order.name}：起始选择状态已清空`, clean.multiCount === 0 && clean.singleCount === 0, JSON.stringify(clean));

        for (const [mode, index] of order.clicks) {
          const point = center(geometry, index);
          await session.click(point.x, point.y, mode === 'ctrl' ? { modifiers: harness.MOD.ctrl } : {});
          await harness.sleep(140);
          if (order.checkMigration && mode === 'ctrl' && index === 1) {
            // 迁移的自证：普通点击那张（0 号）必须从"实线单选"变成"虚线多选"，
            // 且不再有任何图片处于单选态。
            const mid = await session.js(STATE);
            ctx.log('迁移瞬间：' + JSON.stringify(mid));
            ctx.assert('plain-first：先前单选的那张被迁移进多选集合（实线→虚线，不再有单选高亮）',
              mid.multiCount === 2 && mid.singleCount === 0 && mid.images[0].outline === 'dashed',
              JSON.stringify(mid));
          }
        }
        const selected = await session.js(STATE);
        const dashed = selected.images.filter(img => img.outline === 'dashed').length;
        ctx.assert(`${order.name}：三张图都进入多选（虚线框，不是只看类名）`, selected.multiCount === 3 && dashed === 3,
          `multi=${selected.multiCount} dashed=${dashed} single=${selected.singleCount}`);
        const shotSelected = await session.shot(`copy-images-${order.name}-selected`);

        await session.js(WATCH);
        await session.chord('c', 'KeyC', 67);
        await harness.sleep(900);
        let watched = await session.js(WATCHED);
        let trigger = 'Ctrl+C（真实键盘）';
        if (!watched.copylog.length) {
          await session.js(`(() => { const w = document.getElementById('editor').contentWindow; w.__copylog = []; w.__toasts = []; return true; })()`);
          await session.jsSoft(`(() => { const w = document.getElementById('editor').contentWindow; return w.document.execCommand('copy'); })()`);
          trigger = '编辑器内 copy 编辑命令（CDP 的 Ctrl+C 到不了浏览器加速器）';
          await harness.sleep(900);
          watched = await session.js(WATCHED);
        }
        await harness.sleep(1400);
        const stateAfter = await session.js(STATE);
        const shotAfter = await session.shot(`copy-images-${order.name}-after-copy`);
        const toasts = [...(watched.toasts || [])];
        const problems = toasts.map(errorsOf).flat();
        ctx.witness(`${order.name}：复制动作与界面提示`, { trigger, copyEvents: watched.copylog, toasts, problems, screenshot: shotAfter });
        ctx.log(`${order.name} 触发：${trigger}，copy 事件=${JSON.stringify(watched.copylog)}，提示=${JSON.stringify(toasts)}`);

        const read = harness.readClipboard(clipboardDir);
        const names = (read.files || []).map(file => path.basename(file));
        const hashesMatch = expected.every(item => (read.fileHashes || []).includes(item.sha));
        ctx.witness(`${order.name}：系统剪贴板读回（独立进程）`, { formats: read.formats, fileCount: read.fileCount, files: names,
          hashesMatch, hasPng: read.hasPng, hasBitmap: read.hasBitmap, imageSize: [read.imageWidth, read.imageHeight] });

        ctx.assert(`${order.name}：编辑器收到了 copy 事件（功能真的被触发）`, watched.copylog.length >= 1, JSON.stringify(watched.copylog));
        ctx.assert(`${order.name}：界面没有报错提示（乱码 / -File / app.asar / 失败）`, problems.length === 0,
          `提示=${JSON.stringify(toasts)} 问题=${JSON.stringify(problems)}`);
        ctx.assert(`${order.name}：剪贴板里是三张真实图片文件（文件名与 SHA256 对得上磁盘素材）`,
          read.fileCount === 3 && hashesMatch, `文件 ${JSON.stringify(names)}，哈希匹配 ${hashesMatch}`);
        ctx.assert(`${order.name}：剪贴板带文件拖放格式（微信 / 资源管理器 / 网页粘贴读的就是它）`,
          (read.formats || []).some(format => /FileDrop/i.test(format)) && (read.formats || []).some(format => /PNG/i.test(format)),
          JSON.stringify(read.formats));
        ctx.metric(`copyImages.${order.name}.clipboardFiles`, read.fileCount, { unit: '张', direction: 'equal', tolerance: 0 });
        ctx.log(`${order.name} 选中态截图 ${shotSelected}`);
      }
    } finally {
      await ctx.release(session);
      try {
        const restore = harness.restoreClipboard(clipboardDir, saved.__file);
        ctx.log('剪贴板已还原：' + JSON.stringify({ restored: restore.restored }));
      } catch (error) {
        ctx.assert('跑完把用户剪贴板还原回去', false, String(error.message));
      }
    }
  },
};
