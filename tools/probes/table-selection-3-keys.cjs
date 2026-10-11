/** table-selection 族 · 探针 3：**层级态下的按键**（Tab / 方向键 / 打字 / Enter / Esc）
 *
 *  关注两件事（都在族范围内）：
 *   ① "Tab 与方向键在层级间切换" —— 层级态按这些键，最终状态（光标/高亮/文档）到底变成什么；
 *   ② "层级态下打字是否被拦" —— 打字会不会把表结构改坏（tableSelInputGuard 的职责）。
 *
 *  用例：
 *   K1 行层级 Tab / K2 Shift+Tab
 *   K3 行层级 方向键（→ ×2、↓ ×2）
 *   K4 列层级 方向键（→、↓）
 *   K5 整表层级 ↓（表尾出路）—— 光标出表后高亮还在不在
 *   K6 行层级打字 x / K7 列层级打字 y / K8 整表层级打字 z（**打字是否被拦**：字落进哪一格、表结构有没有坏）
 *   K9 行层级 Backspace（与 C7 同根因：userEvent 不是 input ⇒ 守卫不生效）
 *   K10 行层级 Enter
 *   K11 行层级 Esc（有没有"退出层级"的键）
 *
 *  用法：node table-selection-3-keys.cjs "<exe>"
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
const ROW_A1 = '| a1 | b1 | c1 |';

(async () => {
  const S = await L.boot({ probe: 'table-selection-3-keys.cjs', dir: 'p3-keys', exe: EXE, docText: DOC });
  const add = (id, o) => L.log(id, o);

  try {
    const base = await S.assertFixture({ line: '| 甲 | 乙 | 丙 |', minRows: 3 });
    const doc0 = base.doc;
    add('K0 夹具与产物', { 产物SHA16: R.sha16(EXE), 夹具SHA16: R.sha16(S.DOC), 文档: doc0, 渲染行数: base.rowCount });

    async function pristine(why) {
      const s = await S.snap();
      if (s.doc === doc0) return { ok: true };
      await S.key('Control+z', 600);
      const u = await S.snap();
      if (u.doc === doc0) return { ok: true, 复位: '一次撤销' };
      await S.reboot('用例 ' + why + ' 后文档没回到 pristine');
      return { ok: (await S.snap()).doc === doc0, 复位: 'reboot' };
    }
    const st = (s) => ({
      层级: L.levelOf(s), 选区: [s.selFrom, s.selTo], 选区文本: s.selText.slice(0, 20),
      高亮: { 行: s.hl.row, 列: s.hl.col, 整表: s.hl.table },
      光标: { 行: s.headLine, 列: s.headCol, 在表行: s.headIsTable }, 焦点: s.focus,
      覆盖层: s.overlay.visible, 活动格: s.activeCellDom && { 行: s.activeCellDom.rowFrom, 列: s.activeCellDom.col },
      提示: s.toasts,
    });

    /* K1 行层级 Tab */
    await S.guard('K1', async () => {
      const r = await S.toLevel('row');
      const before = r.s;
      await S.key('Tab', 600);
      const s = await S.snap();
      await S.key('Tab', 600);
      const s2 = await S.snap();
      add('K1 行层级按 Tab ×2', {
        按键前: st(before), 第一拍: st(s), 第二拍: st(s2),
        文档: { 未变: s2.doc === doc0, 变了吗: s2.doc !== doc0 },
        判据_层级有没有跟着走: `第一拍层级=${L.levelOf(s)} 第二拍层级=${L.levelOf(s2)}`,
        判据_高亮跟不跟光标: { 高亮行文本: s2.hl.rowText, 光标行号: s2.headLine },
      });
      add('K1b 截图', { 图: await S.shot('k1-row-tab', '.mp-table-wrap') });
      add('K1c 复位', await pristine('K1'));
    });

    /* K2 行层级 Shift+Tab */
    await S.guard('K2', async () => {
      const r = await S.toLevel('row');
      await S.key('Shift+Tab', 600);
      const s = await S.snap();
      add('K2 行层级按 Shift+Tab', { 按键前: st(r.s), 按键后: st(s), 文档未变: s.doc === doc0 });
      add('K2b 复位', await pristine('K2'));
    });

    /* K3 行层级方向键 */
    await S.guard('K3', async () => {
      const r = await S.toLevel('row');
      const trail = [];
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowUp']) {
        await S.key(k, 420);
        trail.push({ 键: k, ...st(await S.snap()) });
      }
      const s = await S.snap();
      add('K3 行层级方向键序列 →,→,↓,↓,↑', {
        按键前: st(r.s), 轨迹: trail,
        判据_文档未变: s.doc === doc0,
        判据_层级是否退出: L.levelOf(s),
        判据_高亮是否还在但光标已走: { 行高亮: s.hl.row, 高亮行文本: s.hl.rowText, 光标行: s.headLine, 光标列: s.headCol },
      });
      add('K3b 复位', await pristine('K3'));
    });

    /* K4 列层级方向键 */
    await S.guard('K4', async () => {
      const r = await S.toLevel('col');
      await S.key('ArrowRight', 450);
      const a = await S.snap();
      await S.key('ArrowDown', 450);
      const b = await S.snap();
      add('K4 列层级方向键 →,↓', {
        按键前: st(r.s), 一: st(a), 二: st(b),
        判据_文档未变: b.doc === doc0,
        判据_列高亮是否还在: { 列高亮格数: b.hl.col, 光标: { 行: b.headLine, 列: b.headCol } },
      });
      add('K4b 复位', await pristine('K4'));
    });

    /* K5 整表层级 ↓（表尾出路） */
    await S.guard('K5', async () => {
      const r = await S.toLevel('table');
      await S.key('ArrowDown', 600);
      const s = await S.snap();
      add('K5 整表层级按 ↓（表尾出路）', {
        按键前: st(r.s), 按键后: st(s),
        判据_光标出表: !s.headIsTable,
        判据_文档未变: s.doc === doc0,
        判据_整表高亮是否还亮着: s.hl.table,
      });
      add('K5b 截图', { 图: await S.shot('k5-table-arrowdown', '.cm-content') });
      add('K5c 复位', await pristine('K5'));
    });

    /* K6/K7/K8 层级态打字 */
    for (const [id, kind, ch] of [['K6', 'row', 'x'], ['K7', 'col', 'y'], ['K8', 'table', 'z']]) {
      await S.guard(id, async () => {
        const r = await S.toLevel(kind);
        await S.type(ch, 700);
        const s = await S.snap();
        const want = doc0.replace('| a1 | b1 | c1 |', '| a1 | ' + ch + 'b1 | c1 |');
        add(id + ' ' + kind + ' 层级打字 "' + ch + '"', {
          打字前: st(r.s),
          打字后: st(s), 打字后文档: s.doc,
          判据_字落进当前格b1: s.doc === want,
          判据_表结构没被改坏: s.tables === 1 && s.rowCount === 3,
          判据_层级是否收场: L.levelOf(s),
          判据_覆盖层是否接管: s.overlay.visible,
        });
        add(id + 'b 复位', await pristine(id));
      });
    }

    /* K9 行层级 Backspace（与 C7 同根因） */
    await S.guard('K9', async () => {
      const r = await S.toLevel('row');
      await S.key('Backspace', 700);
      const s = await S.snap();
      add('K9 行层级按 Backspace（"打字被拦"的反例）', {
        按键前: st(r.s), 按键后: st(s), 按键后文档: s.doc,
        判据_该行被清空: s.doc.split('\n')[6] === '',
        判据_整行干净删除: s.doc === doc0.split('\n').filter((l) => l !== ROW_A1).join('\n'),
        判据_表还在: s.tables > 0 && s.rowCount >= 2,
      });
      add('K9b 复位', await pristine('K9'));
    });

    /* K10 行层级 Enter */
    await S.guard('K10', async () => {
      const r = await S.toLevel('row');
      await S.key('Enter', 700);
      const s = await S.snap();
      add('K10 行层级按 Enter', {
        按键前: st(r.s), 按键后: st(s),
        判据_文档未变: s.doc === doc0,
        判据_表格结构: { 表格数: s.tables, 渲染行数: s.rowCount },
        提示: s.toasts,
      });
      add('K10b 复位', await pristine('K10'));
    });

    /* K11 行层级 Esc */
    await S.guard('K11', async () => {
      const r = await S.toLevel('row');
      await S.key('Escape', 600);
      const s = await S.snap();
      await S.page.mouse.click(5, 5);            // 再点空白（不落格）看会不会收场
      await S.sleep(400);
      const s2 = await S.snap();
      add('K11 行层级按 Esc（+ 点空白）', {
        按键前: st(r.s), Esc后: st(s), 再点空白后: st(s2),
        判据_Esc能否退出层级: L.levelOf(s),
        判据_文档未变: s.doc === doc0,
      });
      add('K11b 复位', await pristine('K11'));
    });

    add('K99 收尾', { pageerror: S.errs.slice(0, 8), consoleError: S.cerrs.slice(0, 8), 启动次数: S.boots, 外部中断: S.log.filter((x) => x.case === 'REBOOT').length });
  } catch (e) {
    add('K-EXC', { 异常: String((e && e.message) || e).slice(0, 400), 栈: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ') });
    await S.finish(3);
    return;
  }
  await S.finish(0);
})();
