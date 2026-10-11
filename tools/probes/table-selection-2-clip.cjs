/** table-selection 族 · 探针 2：**选中之后能干什么**（复制/剪切/删除/粘贴）
 *
 *  两条剪贴板尺子**必须分开写**（不许混成一句"复制通过"）：
 *   ① 事件层：copy/cut 事件里的 clipboardData（本页自己的对象）＝ **产品给了什么**；真输入 Ctrl+C/X 触发。
 *   ② 系统剪贴板：跨进程，本机锁屏 ⇒ 已证不可用 ⇒ 凡"落到别的程序里"的用例一律判**环境阻断**。
 *
 *  用例：
 *   C1 行层级 Ctrl+C  → 载荷是不是该行源码
 *   C2 整表层级 Ctrl+C → 载荷是不是 TSV + HTML `<table>`（"可粘 Excel"）
 *   C3 列层级 Ctrl+C  → 载荷是"整列"还是"当前格源码"
 *   C4 格层级 Ctrl+C  → 产品接不接管（prevented）
 *   C5 行层级 Ctrl+X  → 文档里那一行是否**干净消失**（走 row-delete 而非 replaceSelection）
 *   C6 行层级 Delete / C7 Backspace → ⚠ 重点怀疑：这两键不被 tableSelInputGuard 拦（userEvent 不是 input）
 *   C8 整表层级 Delete → 表整体消失 + 可撤销
 *   C9 列层级 Delete  → 只删该格文本，表结构仍在
 *   C10 真 Ctrl+V（层级态）→ 环境阻断取证
 *  每个破坏性用例后用 Ctrl+Z 复位；复位失败就 reboot（夹具重写 + 重启），保证下一条用例的夹具是 pristine。
 *
 *  用法：node table-selection-2-clip.cjs "<exe>"
 */
'use strict';
const L = require('./table-selection-lib.cjs');
const R = require('./_probe-common.cjs');
const EXE = process.argv[2];
const DOC = [
  '# 表格选择层级',
  '',
  '前置段落。',
  '',
  '| 甲 | 乙 | 丙 |',
  '| --- | --- | --- |',
  '| a1 | b1 | c1 |',
  '| a2 | b2 | c2 |',
  '',
  '末尾段落。',
  '',
].join('\n');

(async () => {
  const S = await L.boot({ probe: 'table-selection-2-clip.cjs', dir: 'p2-clip', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);
  const P = R.sha16(S.DOC);

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const doc0 = base.doc;
    add('C0 夹具与产物', { 产物SHA16: R.sha16(EXE), 夹具SHA16: P, 文档: doc0, 渲染行数: base.rowCount });

    /** 复位：先 Ctrl+Z；一次撤销回不到 pristine 就 reboot（并记一行读数） */
    async function pristine(why) {
      const s = await S.snap();
      if (s.doc === doc0) return { ok: true };
      await S.key('Control+z', 600);
      const u = await S.snap();
      if (u.doc === doc0) return { ok: true, 复位: '一次撤销即回 pristine' };
      await S.reboot('用例 ' + why + ' 后 Ctrl+Z 没回到 pristine');
      const r = await S.snap();
      return { ok: r.doc === doc0, 复位: 'reboot（夹具重写 + 重启）', 复位后文档: r.doc };
    }

    /* C1 行层级 Ctrl+C */
    await S.guard('C1', async () => {
      const r = await S.toLevel('row');
      const before = r.s;
      await S.key('Control+c', 600);
      const log = await S.copyLog();
      const s = await S.snap();
      add('C1 行层级（选中 a1 整行）Ctrl+C', {
        选中时: { 选区: [before.selFrom, before.selTo], 选区文本: before.selText, 行高亮: before.hl.row, 行高亮文本: before.hl.rowText, 焦点: before.focus, 焦点在编辑面: before.focusInEditor },
        事件层载荷: log,
        复制后: { 文档未变: s.doc === doc0, 层级: L.levelOf(s), 行高亮: s.hl.row, 选区: [s.selFrom, s.selTo] },
        判据_载荷是该行源码: log.length === 1 && log[0].plain === '| a1 | b1 | c1 |',
        判据_系统剪贴板: '环境阻断（跨进程不可读，见 C0/S0b 自检）',
      });
    });

    /* C2 整表层级 Ctrl+C */
    await S.guard('C2', async () => {
      const r = await S.toLevel('table');
      const before = r.s;
      await S.key('Control+c', 600);
      const log = await S.copyLog();
      const s = await S.snap();
      const plain = log[0] ? String(log[0].plain) : '';
      const html = log[0] ? String(log[0].html) : '';
      add('C2 整表层级 Ctrl+C', {
        选中时: { 选区: [before.selFrom, before.selTo], 整表高亮: before.hl.table, 描边: before.hl.tableOutline, 焦点: before.focus },
        事件层载荷: { prevented: log[0] && log[0].prevented, types: log[0] && log[0].types, plain, plain长度: plain.length, html前80: html.slice(0, 80), html长度: html.length },
        判据_TSV制表符: plain.includes('\t'),
        判据_含表头与两数据行: plain.split('\n').length === 3 && plain.includes('甲') && plain.includes('a2'),
        判据_HTML是真表格: html.includes('<table>') && html.includes('<th>'),
        复制后: { 文档未变: s.doc === doc0, 层级: L.levelOf(s), 整表高亮: s.hl.table },
      });
    });

    /* C3 列层级 Ctrl+C */
    await S.guard('C3', async () => {
      const r = await S.toLevel('col');
      const before = r.s;
      await S.key('Control+c', 600);
      const log = await S.copyLog();
      const s = await S.snap();
      add('C3 列层级（第 2 列，锚点格 b1）Ctrl+C', {
        选中时: { 选区: [before.selFrom, before.selTo], 选区文本: before.selText, 列高亮格数: before.hl.col, 首格文本: before.hl.colText, 焦点: before.focus },
        事件层载荷: log,
        判据_给的是当前格源码: log[0] && log[0].plain === 'b1',
        判据_有没有整列出口: log[0] && String(log[0].plain).includes('\n'),
        复制后: { 文档未变: s.doc === doc0, 列高亮: s.hl.col },
      });
    });

    /* C4 格层级 Ctrl+C */
    await S.guard('C4', async () => {
      const r = await S.toLevel('cell');
      const before = r.s;
      await S.key('Control+c', 600);
      const log = await S.copyLog();
      const diag = await S.ev(() => { try { return window.mpEngine.cellCopyDiag(); } catch (e) { return { err: String(e).slice(0, 40) }; } });
      const s = await S.snap();
      add('C4 格层级（b1 格内全选）Ctrl+C', {
        选中时: { DOM选区: before.domSel && before.domSel.text, 在覆盖层内: before.domSel && before.domSel.inOverlay, 覆盖层可见: before.overlay.visible },
        事件层载荷: log,
        覆盖层计数器: diag,
        判据_产品不接管交浏览器默认: log.length === 1 && log[0].prevented === false,
        复制后: { 文档未变: s.doc === doc0, 覆盖层: s.overlay.visible },
        判据_系统剪贴板: '环境阻断：浏览器默认路径要写系统剪贴板，本机不可读 ⇒ 格内复制"落到别处"未验证',
      });
    });

    /* C5 行层级 Ctrl+X */
    await S.guard('C5', async () => {
      const r = await S.toLevel('row');
      await S.key('Control+x', 700);
      const log = await S.copyLog();
      const s = await S.snap();
      const want = doc0.split('\n').filter((l) => l !== '| a1 | b1 | c1 |').join('\n');
      add('C5 行层级 Ctrl+X（剪切 a1 行）', {
        事件层载荷: log,
        剪切后文档: s.doc, 渲染行数: s.rowCount, 层级: L.levelOf(s), 行高亮数: s.hl.row, 行高亮文本: s.hl.rowText,
        判据_那一行干净消失: s.doc === want,
        判据_表还在: s.rowCount === 2,
        判据_剪切后层级是否收场: L.levelOf(s) === 'none' || L.levelOf(s) === 'row',
        提示: s.toasts,
      });
      add('C5b 复位', await pristine('C5'));
    });

    /* C6 行层级 Delete（重点怀疑） */
    await S.guard('C6', async () => {
      const r = await S.toLevel('row');
      const before = r.s;
      await S.key('Delete', 700);
      const s = await S.snap();
      const lines = s.doc.split('\n');
      add('C6 行层级（选中 a1 整行）按 Delete', {
        选中时: { 选区: [before.selFrom, before.selTo], 选区文本: before.selText, 层级: r.level, 行高亮: before.hl.row },
        按键后文档: s.doc, 文档行数: s.docLines, 渲染行数: s.rowCount, 表格数: s.tables,
        被选那行的最终文本: lines[6], 下一行文本: lines[7],
        层级: L.levelOf(s), 提示: s.toasts,
        判据_那一行文本被清空: lines[6] === '',
        判据_整行干净删除: s.doc === doc0.split('\n').filter((l) => l !== '| a1 | b1 | c1 |').join('\n'),
        判据_表格结构是否还在: s.tables > 0 && s.rowCount >= 2,
      });
      add('C6b 截图（看表格最后长什么样）', { 图: await S.shot('c6-row-delete', '.cm-content') });
      add('C6c 复位', await pristine('C6'));
    });

    /* C7 行层级 Backspace */
    await S.guard('C7', async () => {
      const r = await S.toLevel('row');
      await S.key('Backspace', 700);
      const s = await S.snap();
      const lines = s.doc.split('\n');
      add('C7 行层级按 Backspace', {
        选中时: { 选区: [r.s.selFrom, r.s.selTo], 选区文本: r.s.selText, 层级: r.level },
        按键后文档: s.doc, 渲染行数: s.rowCount, 表格数: s.tables, 被选那行: lines[6],
        判据_与Delete同形态: lines[6] === '' && s.tables > 0,
      });
      add('C7b 复位', await pristine('C7'));
    });

    /* C8 整表层级 Delete */
    await S.guard('C8', async () => {
      const r = await S.toLevel('table');
      await S.key('Delete', 800);
      const s = await S.snap();
      add('C8 整表层级按 Delete', {
        选中时: { 选区: [r.s.selFrom, r.s.selTo], 整表高亮: r.s.hl.table },
        按键后文档: s.doc, 表格数: s.tables, 渲染行数: s.rowCount, 提示: s.toasts,
        判据_表整体消失: !s.doc.includes('| a1 |') && !s.doc.includes('| 甲 |'),
        判据_文档剩下的行: s.doc.split('\n'),
      });
      await S.key('Control+z', 700);
      const u = await S.snap();
      add('C8b 一次撤销', { 文档回pristine: u.doc === doc0, 撤销后文档: u.doc });
      add('C8c 复位', await pristine('C8'));
    });

    /* C9 列层级 Delete */
    await S.guard('C9', async () => {
      const r = await S.toLevel('col');
      await S.key('Delete', 700);
      const s = await S.snap();
      add('C9 列层级按 Delete', {
        选中时: { 选区: [r.s.selFrom, r.s.selTo], 选区文本: r.s.selText, 列高亮格数: r.s.hl.col },
        按键后文档: s.doc, 表格数: s.tables, 渲染行数: s.rowCount,
        判据_只有该格文本没了: s.doc.includes('| a1 |  | c1 |') && s.doc.includes('| a2 | b2 | c2 |'),
        判据_表结构还在: s.tables === 1 && s.rowCount === 3,
      });
      add('C9b 复位', await pristine('C9'));
    });

    /* C10 层级态粘贴：环境阻断取证 */
    await S.guard('C10', async () => {
      const cd = S.clipDiag();
      const r = await S.toLevel('row');
      await S.key('Control+v', 800);
      const plog = await S.pasteLog();
      const s = await S.snap();
      add('C10 行层级真 Ctrl+V（环境阻断取证）', {
        系统剪贴板自检: { Set返回: cd.set, Get是否成功: cd.read_ok, 读回长度: cd.read_len, clipexe退出码: cd.clipexe_exit },
        粘贴事件: plog,
        文档未变: s.doc === doc0, 层级: L.levelOf(s),
        判定: '环境阻断：系统剪贴板对所有进程不可用（Get-Clipboard 读回长度 0、clip.exe 退出码非 0）⇒ 粘贴落地与"层级态粘贴是否被拦"本机**无法验证**（不写通过也不写失败）',
      });
    });

    add('C99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 外部中断: S.log.filter((x) => x.case === 'REBOOT').length });
  } catch (e) {
    add('C-EXC', { 异常: String((e && e.message) || e).slice(0, 400), 栈: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ') });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
