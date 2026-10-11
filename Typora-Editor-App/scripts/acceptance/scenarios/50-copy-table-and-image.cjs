/** 复制表格 / 复制单图（打包产物 + 真实右键菜单点击 + 独立进程读回 CF_HTML 与位图）。
 *
 *  这两个动作与本轮修好的多图复制共用同一段宿主与同一个 PowerShell 脚本解析器，
 *  但它们的**载荷**完全不同，必须单独验字节：
 *    · copy-table → 剪贴板里要有 CF_HTML，且按 UTF-8 原始字节读回时表头偏移自洽、
 *      中文单元格没有被 ANSI 码页解坏（产品注释里写明 Excel 会拿 ANSI 猜字节）；
 *    · copy-image → 要有 CF_DIB 位图与 PNG 流，且尺寸等于磁盘上的原图。
 *  触发方式是真右键菜单：菜单是页面内的 DOM 菜单（不是原生菜单），所以能用真实鼠标点。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../harness.cjs');
const fixtures = require('../fixtures.cjs');

const MENU_ITEMS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const menu = doc ? doc.querySelector('.typora-editor-context-menu') : null;
  if (!menu) return {open: false};
  return {open: true, items: [...menu.querySelectorAll('button')].map(button => {
    const rect = button.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {action: button.dataset.action, label: button.textContent, x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)};
  })};
})()`;

const TARGETS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const surface = doc.querySelector('.vditor-ir .vditor-reset');
  const frameRect = frame.getBoundingClientRect();
  const center = node => { const rect = node.getBoundingClientRect(); return {x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)}; };
  const cell = surface.querySelector('table td, table th');
  const image = [...surface.querySelectorAll('img')].find(img => img.complete && img.naturalWidth > 0);
  const paragraph = [...surface.children].find(block => block.textContent.length > 20 && !block.querySelector('img,table'));
  return {cell: cell ? center(cell) : null, image: image ? center(image) : null, paragraph: paragraph ? center(paragraph) : null,
    imageSize: image ? [image.naturalWidth, image.naturalHeight] : null,
    cellText: cell ? cell.textContent.trim() : null,
    tableText: surface.querySelector('table') ? surface.querySelector('table').textContent.trim() : null};
})()`;

const DIALOG = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w && w.document;
  const dialog = doc.querySelector('#typora-image-settings');
  const error = dialog ? dialog.querySelector('.media-error') : null;
  const button = dialog ? dialog.querySelector('[data-action="copy-image"]') : null;
  const rect = button ? button.getBoundingClientRect() : null;
  const frameRect = frame.getBoundingClientRect();
  return {open: !!dialog, status: error ? error.textContent : null,
    button: button ? {x: Math.round(frameRect.x + rect.x + rect.width / 2), y: Math.round(frameRect.y + rect.y + rect.height / 2)} : null};
})()`;

const TOASTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const body = w && w.document ? w.document.body : null;
  const live = body ? [...body.querySelectorAll('.typora-context-toast, .media-error')].map(node => node.textContent) : [];
  return {live, recorded: w && w.__toasts ? w.__toasts.slice(-6) : []};
})()`;

const WATCH_TOASTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w.document;
  if (!w.__toastObserver) {
    w.__toasts = [];
    w.__toastObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1) {
          if (node.classList && node.classList.contains('typora-context-toast')) w.__toasts.push(node.textContent);
          else if (node.querySelectorAll) for (const hit of node.querySelectorAll('.typora-context-toast')) w.__toasts.push(hit.textContent);
        }
      }
    });
    w.__toastObserver.observe(doc.body, {childList: true, subtree: true});
  }
  w.__toasts = [];
  return true;
})()`;

const CLOSE_DIALOG = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const doc = w.document;
  const dialog = doc.querySelector('#typora-image-settings');
  if (!dialog) return {closed: true, wasOpen: false};
  const close = dialog.querySelector('[data-close], [data-action="close"], button[type="button"]:last-of-type');
  dialog.querySelectorAll('form button, [data-close]').forEach(button => { if (/关闭/.test(button.textContent)) button.click(); });
  if (dialog.open !== undefined) { try { dialog.close(); } catch {} }
  dialog.remove();
  return {closed: !doc.querySelector('#typora-image-settings'), wasOpen: true};
})()`;

const errorsOf = text => {
  const problems = [];
  if (!text) return problems;
  if (/\uFFFD/.test(text)) problems.push('含替换字符（编码解码坏了）');
  if (/-File\s/.test(text)) problems.push('含 PowerShell 用法文本');
  if (/app\.asar/i.test(text)) problems.push('含 app.asar 虚拟路径');
  if (/失败|错误/.test(text)) problems.push('含失败/错误提示');
  return problems;
};

const VIEWPORT = `(() => {
  const frame = document.getElementById('editor');
  const w = frame && frame.contentWindow;
  const surface = w && w.document ? w.document.querySelector('.vditor-ir .vditor-reset') : null;
  if (!surface) return null;
  const rect = surface.getBoundingClientRect();
  return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
    top: Math.round(rect.top), bottom: Math.round(rect.bottom)};
})()`;

/** 打开页面内右键菜单：先把目标滚进视口并悬停，再右键；失败重试（负载高时会漏）。
 *  返回最后一次读到的菜单状态，带 attempts 与每次尝试的坐标，便于复盘。 */
async function openMenu(session, kind, attempts = 3) {
  const tried = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const targets = await session.js(TARGETS);
    let point = targets[kind];
    const view = await session.js(VIEWPORT);
    if (point && view && (point.y < view.top + 20 || point.y > view.bottom - 20)) {
      await session.wheel(view.x, view.y, point.y < view.top ? -240 : 240);
      await harness.sleep(250);
      const again = await session.js(TARGETS);
      point = again[kind];
    }
    if (point) {
      await session.move(point.x, point.y);
      await harness.sleep(90);
      await session.click(point.x, point.y, { button: 'right' });
    }
    tried.push(point || null);
    for (let wait = 0; wait < 8; wait++) {
      await harness.sleep(120);
      const menu = await session.js(MENU_ITEMS);
      if (menu.open) return {...menu, attempts: attempt + 1, tried};
    }
    await session.key({ key: 'Escape', code: 'Escape', vk: 27 });
    await harness.sleep(120);
  }
  return {open: false, items: [], attempts, tried};
}

/** CF_HTML 头解析：偏移量必须自洽，片段里必须是完整的那张表。 */
const parseCfHtml = text => {
  if (typeof text !== 'string') return {ok: false, error: '没有拿到 CF_HTML 字符串'};
  const head = text.slice(0, Math.max(0, text.indexOf('<html')));
  const number = key => Number((new RegExp(key + ':(\\d+)').exec(head) || [])[1] ?? NaN);
  const start = number('StartFragment'), end = number('EndFragment');
  const startHtml = number('StartHTML'), endHtml = number('EndHTML');
  return {ok: true, version: /Version:1\.0/.test(head), start, end, startHtml, endHtml, length: text.length,
    fragment: Number.isFinite(start) && Number.isFinite(end) ? text.slice(start, end) : null};
};

module.exports = {
  id: '50-copy-table-and-image',
  title: '复制表格（CF_HTML）与复制单图（位图/PNG）——右键菜单真点击',
  async run(ctx) {
    const scene = fixtures.images();
    const firstImage = scene.images[0];
    const sourceBytes = fs.statSync(firstImage).size;
    const clipboardDir = path.join(ctx.outDir, '50-copy-table-and-image');
    fs.mkdirSync(clipboardDir, { recursive: true });
    const saved = harness.saveClipboard(clipboardDir);
    ctx.witness('跑前保存用户剪贴板', { hasText: saved.hasText, hasImage: saved.hasImage, hasFiles: saved.hasFiles });
    const session = await ctx.launch({ args: [scene.markdown] });
    try {
      // 就绪条件必须等**所有**图片都完成：素材里的图片没有写死宽高，加载完成前不占位，
      // 每加载一张就把下面的表格往下推一截。原先写的是 `.some(...)`（有一张加载好就往下走），
      // 于是"先量坐标、再右键"这两步之间表格还在移动，右键落到表格上方的段落上，菜单里自然
      // 没有表格那一组（复现时看到的正是"只有通用四项"）。判据是"右键点到的就是表格单元格"，
      // 所以这里必须等版面稳定下来再量坐标。
      const ready = await session.until(`(() => {
        const frame = document.getElementById('editor');
        const w = frame && frame.contentWindow;
        const surface = w && w.document && w.document.querySelector('.vditor-ir .vditor-reset');
        if (!surface || !surface.querySelector('table')) return false;
        const images = [...surface.querySelectorAll('img')];
        return images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0);
      })()`, { timeout: 90000, interval: 20 });
      ctx.assert('表格与图片都上屏了', ready, `ready=${ready}`);
      if (!ready) return;
      await harness.sleep(600);   // 图片到位后的那次重排落地再量坐标
      const targets = await session.js(TARGETS);
      ctx.log('目标：' + JSON.stringify(targets));
      ctx.assert('找到表格单元格 / 图片 / 正文块', !!targets.cell && !!targets.image && !!targets.paragraph, JSON.stringify(targets));
      if (!targets.cell) return;
      await session.js(WATCH_TOASTS);

      // --- 复制表格：真实右键 → 点菜单里的"复制表格到 Excel" -------------------
      // 右键在负载高时会漏（菜单没弹出来）；先悬停、把目标滚进视口，再重试，并如实记账重试次数。
      const menu = await openMenu(session, 'cell');
      ctx.assert('右键表格弹出了页面内菜单', menu.open === true, JSON.stringify({menu, attempts: menu.attempts}));
      const tableItem = (menu.items || []).find(item => item.action === 'copy-table');
      ctx.assert('菜单里有"复制表格到 Excel"', !!tableItem, JSON.stringify((menu.items || []).map(item => item.label)));
      if (!tableItem) return;
      await session.click(tableItem.x, tableItem.y);
      await harness.sleep(1800);
      const tableToasts = await session.js(TOASTS);
      const tableRead = harness.readClipboard(clipboardDir);
      const cfhtml = parseCfHtml(tableRead.htmlRawUtf8);
      ctx.witness('表格复制：系统剪贴板读回（独立进程）', { formats: tableRead.formats, hasHtml: tableRead.hasHtml, htmlBytes: tableRead.htmlRawBytes,
        cfhtml: {...cfhtml, fragment: cfhtml.fragment ? cfhtml.fragment.slice(0, 200) : null}, text: (tableRead.text || '').slice(0, 120), toasts: tableToasts });
      ctx.log('表格复制：' + JSON.stringify({toasts: tableToasts.recorded, formats: tableRead.formats, version: cfhtml.version, start: cfhtml.start, end: cfhtml.end, length: cfhtml.length, rawBytes: tableRead.htmlRawBytes, winRawError: tableRead.htmlRawError}));
      const tableProblems = [...(tableToasts.recorded || []), ...(tableToasts.live || [])].map(errorsOf).flat();
      ctx.assert('复制表格：界面没有报错提示（乱码 / -File / app.asar / 失败）', tableProblems.length === 0, JSON.stringify({tableProblems, toasts: tableToasts}));
      ctx.assert('复制表格：剪贴板里是 CF_HTML（版本头 + 片段偏移自洽）',
        !!tableRead.hasHtml && cfhtml.ok && cfhtml.version && cfhtml.fragment && cfhtml.start > 0 && cfhtml.end > cfhtml.start,
        JSON.stringify({hasHtml: tableRead.hasHtml, version: cfhtml.version, start: cfhtml.start, end: cfhtml.end, length: cfhtml.length}));
      ctx.assert('复制表格：片段里是完整表格且中文单元格没被 ANSI 解坏',
        !!cfhtml.fragment && /测度变换/.test(cfhtml.fragment) && /概率论/.test(cfhtml.fragment) && /e\^\{iπ\}|e\^\{i/.test(cfhtml.fragment),
        `片段片段=${JSON.stringify((cfhtml.fragment || '').slice(0, 160))}`);
      ctx.assert('复制表格：纯文本也是同一张表（TSV 或等价格式）',
        typeof tableRead.text === 'string' && /测度变换/.test(tableRead.text), JSON.stringify((tableRead.text || '').slice(0, 120)));

      // --- 复制单图：右键图片 → 图片设置… → 复制原图 ---------------------------
      const imageMenu = await openMenu(session, 'image');
      const settingsItem = (imageMenu.items || []).find(item => item.action === 'image-settings');
      ctx.assert('图片右键菜单里有"图片设置…"', !!settingsItem, JSON.stringify((imageMenu.items || []).map(item => item.label)));
      if (!settingsItem) return;
      await session.click(settingsItem.x, settingsItem.y);
      await harness.sleep(600);
      let dialog = await session.js(DIALOG);
      ctx.assert('图片设置对话框打开了，且有"复制原图"按钮', dialog.open && !!dialog.button, JSON.stringify(dialog));
      if (!dialog.button) return;
      await session.click(dialog.button.x, dialog.button.y);
      await harness.sleep(1800);
      dialog = await session.js(DIALOG);
      const imageRead = harness.readClipboard(clipboardDir);
      ctx.witness('单图复制：系统剪贴板读回（独立进程）', { formats: imageRead.formats, hasBitmap: imageRead.hasBitmap, hasPng: imageRead.hasPng,
        bitmapSize: [imageRead.imageWidth, imageRead.imageHeight], pngSize: [imageRead.pngWidth, imageRead.pngHeight],
        sourceFile: path.basename(firstImage), sourceBytes, dialogStatus: dialog.status });
      ctx.log('单图复制：' + JSON.stringify({status: dialog.status, formats: imageRead.formats, bitmap: [imageRead.imageWidth, imageRead.imageHeight], png: [imageRead.pngWidth, imageRead.pngHeight], expected: targets.imageSize}));
      const imageProblems = errorsOf(dialog.status);
      ctx.assert('复制单图：对话框状态没有报错（乱码 / -File / app.asar / 失败）', imageProblems.length === 0, JSON.stringify({status: dialog.status, imageProblems}));
      ctx.assert('复制单图：剪贴板里有位图与 PNG，且尺寸等于磁盘原图',
        imageRead.hasBitmap && imageRead.hasPng && imageRead.imageWidth === targets.imageSize[0] && imageRead.imageHeight === targets.imageSize[1],
        JSON.stringify({bitmap: [imageRead.imageWidth, imageRead.imageHeight], png: [imageRead.pngWidth, imageRead.pngHeight], expected: targets.imageSize}));
      ctx.assert('复制单图：对话框明确回报"已复制"', /已复制/.test(String(dialog.status || '')), JSON.stringify(dialog.status));
      ctx.metric('copyTable.htmlBytes', tableRead.htmlRawBytes || 0, { unit: '字节', direction: 'higher', tolerance: 0.2 });
      ctx.metric('copySingleImage.bitmapWidth', imageRead.imageWidth || 0, { unit: 'px', direction: 'equal', tolerance: 0 });
      await session.js(CLOSE_DIALOG);
      await session.shot('copy-table-and-image-final');
    } finally {
      await ctx.release(session);
      try { harness.restoreClipboard(clipboardDir, saved.__file); ctx.log('剪贴板已还原'); }
      catch (error) { ctx.assert('跑完把用户剪贴板还原回去', false, String(error.message)); }
    }
  },
};
