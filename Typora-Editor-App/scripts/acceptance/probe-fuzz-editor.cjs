/** 结构模糊测试：**随机但可复现**的日用按键序列，专抓"手工用例想不到"的结构损坏。
 *
 *  为什么换这套：到这一轮为止，手工设计的日用动作（文件/窗口/快照/查找替换/表格/列表/图片/
 *  源模式/WYSIWYG/工具栏 15 个按钮…）基本全绿，说明缺陷在"组合"里而不在单个动作里。
 *
 *  预言机（每条都能机械判定，且都能指名道姓地回放）：
 *    O1 **中性操作不许改文档**：方向键 / Home / End / Escape / Shift+Enter（软换行会改，排除）→
 *       值必须逐字节不变；Ctrl+Z/Ctrl+Y 允许改（历史），但要能对得上"上一步的值"。
 *    O2 **随时可解析**：任何时刻 `lute.Md2VditorIRDOM(value)` 不抛异常。
 *    O3 **表格永远是矩形**：每行列数一致（被拆坏的表立刻现形）。
 *    O4 **无 console 报错 / 未捕获异常**。
 *    O5 **每步有响应**：单步往返 < 3s（卡死即失败）。
 *  失败时输出 seed + 完整操作序列，可直接回放定位。
 *  用法：node scripts/acceptance/probe-fuzz-editor.cjs [--dev] [--steps=300] [--seed=20260913]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');

const DEV = process.argv.includes('--dev');
const argOf = (name, fallback) => { const hit = process.argv.find(v => v.startsWith('--' + name + '=')); return hit ? hit.slice(name.length + 3) : fallback; };
const STEPS = Number(argOf('steps', 300));
const SEED = Number(argOf('seed', 20260913));
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_ARGS = DEV ? [path.join(harness.project, 'app/main/main.js')] : [];
const OUT = path.join(harness.project, DEV ? '.perf/fuzz-editor-dev' : '.perf/fuzz-editor');
const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');
const sleep = harness.sleep;
const LOG = [];
const say = value => { const line = typeof value === 'string' ? value : JSON.stringify(value); LOG.push(line); console.log(line); };

// 确定性随机（mulberry32）：同一个 seed 一定能复现同一条序列
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

const FIXTURE = [
  '# 模糊夹具', '',
  '第一段有 **粗体**、`行内代码`、行内公式 $a+b$ 与 [链接](https://example.com)。', '',
  '第二段是普通文字，用来承受各种按键。', '',
  '## 小节一', '',
  '- 列表甲', '- 列表乙', '  - 嵌套甲', '',
  '1. 有序甲', '2. 有序乙', '',
  '> 引用一行。', '',
  '```js', 'const a = 1;', '```', '',
  '| 甲 | 乙 |', '| --- | --- |', '| 一 | 二 |', '| 三 | 四 |', '',
  '$$', 'x+y=z', '$$', '',
  '结尾段。', '',
].join('\n');

const STATE = `(() => {
  const w = document.getElementById('editor').contentWindow, doc = w.document;
  const root = doc.querySelector(${SURFACE});
  const value = w.vditor.getValue();
  let parseError = null;
  try { w.vditor.vditor.lute.Md2VditorIRDOM(value); } catch (error) { parseError = String(error.message || error).slice(0, 120); }
  return {value, parseError,
    domText: root ? String(root.textContent).replace(/\s+/g, ' ').slice(0, 4000) : null,
    blockCount: root ? root.children.length : null,
    tables: root ? [...root.querySelectorAll('table')].map(t => [...t.querySelectorAll('tr')].map(r => r.children.length)) : null,
    errors: (w.__acc && w.__acc.errors) || [],
    mode: w.vditor.getCurrentMode()};
})()`;

const BLOCK_POINTS = `(() => {
  const frame = document.getElementById('editor');
  const w = frame.contentWindow, doc = w.document;
  const root = doc.querySelector(${SURFACE});
  if (!root) return [];
  const frameRect = frame.getBoundingClientRect();
  const pool = [...root.children, ...root.querySelectorAll('li, td, code, blockquote')];
  return pool.map((node, index) => {
    const rect = node.getBoundingClientRect();
    return {index, tag: node.tagName + (node.parentElement && node.parentElement !== root ? '(嵌套)' : ''), x: Math.round(frameRect.x + rect.x + Math.min(rect.width / 2, 80)),
      y: Math.round(frameRect.y + Math.max(50, Math.min(rect.y + rect.height / 2, w.innerHeight - 40))),
      visible: rect.height > 0 && rect.bottom > 40 && rect.top < w.innerHeight - 40};
  }).filter(item => item.visible);
})()`;

async function main() {
  try { fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}); } catch { say('旧目录删不掉'); }
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(OUT, 'fuzz.md');
  fs.writeFileSync(file, FIXTURE);
  const random = rng(SEED);
  const pick = list => list[Math.floor(random() * list.length)];
  const oplog = [];
  const findings = [];

  const session = await harness.launch({exe: EXE, appArgs: APP_ARGS, label: DEV ? 'fuzz-dev' : 'fuzz',
    outDir: path.join(OUT, 'shots'), args: [file], timeout: 120000});
  try {
    await session.until(`(() => { const w = document.getElementById('editor') && document.getElementById('editor').contentWindow;
      const root = w && w.document && w.document.querySelector(${SURFACE}); return !!(root && root.querySelector('table')); })()`,
      {timeout: 120000, interval: 30});
    await sleep(2200);
    await session.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false}).catch(() => {});
    await sleep(900);

    const NEUTRAL = [
      {name: 'ArrowLeft', run: s => s.key({key: 'ArrowLeft', code: 'ArrowLeft', vk: 37})},
      {name: 'ArrowRight', run: s => s.key({key: 'ArrowRight', code: 'ArrowRight', vk: 39})},
      {name: 'ArrowUp', run: s => s.key({key: 'ArrowUp', code: 'ArrowUp', vk: 38})},
      {name: 'ArrowDown', run: s => s.key({key: 'ArrowDown', code: 'ArrowDown', vk: 40})},
      {name: 'Home', run: s => s.key({key: 'Home', code: 'Home', vk: 36})},
      {name: 'End', run: s => s.key({key: 'End', code: 'End', vk: 35})},
      {name: 'Escape', run: s => s.key({key: 'Escape', code: 'Escape', vk: 27})},
    ];
    const MUTATING = [
      {name: 'Backspace', run: s => s.key({key: 'Backspace', code: 'Backspace', vk: 8})},
      {name: 'Delete', run: s => s.key({key: 'Delete', code: 'Delete', vk: 46})},
      {name: 'Enter', run: s => s.enter()},
      {name: 'ShiftEnter', run: s => s.enter(true)},
      {name: 'Tab', run: s => s.key({key: 'Tab', code: 'Tab', vk: 9})},
      {name: 'ShiftTab', run: s => s.key({key: 'Tab', code: 'Tab', vk: 9, modifiers: harness.MOD.shift})},
      {name: 'type汉字', run: s => s.type('测')},
      {name: 'type美元', run: s => s.type('$')},
      {name: 'type星号', run: s => s.type('*')},
      {name: 'type反引号', run: s => s.type('`')},
      {name: 'type竖线', run: s => s.type('|')},
      {name: 'type井号', run: s => s.type('#')},
      {name: 'type短横', run: s => s.type('-')},
      {name: 'Undo', run: s => s.chord('z', 'KeyZ', 90)},
      {name: 'Redo', run: s => s.chord('y', 'KeyY', 89)},
      {name: 'CtrlB', run: s => s.chord('b', 'KeyB', 66)},
    ];

    let previousValue = (await session.js(STATE)).value;
    for (let step = 1; step <= STEPS; step++) {
      // 先把光标放回某个可见块（随机），模拟"人点到某处再按键"
      const points = await session.js(BLOCK_POINTS);
      if (!points.length) { say('  第 ' + step + ' 步：没有可见块，停'); break; }
      const spot = pick(points);
      await session.move(spot.x, spot.y);
      await session.click(spot.x, spot.y);
      await sleep(120);

      const neutral = random() < 0.30;
      const op = neutral ? pick(NEUTRAL) : pick(MUTATING);
      const before = await session.js(STATE);
      const started = Date.now();
      await op.run(session);
      await sleep(180);
      const after = await session.js(STATE);
      const elapsed = Date.now() - started;
      oplog.push({step, block: spot.tag + '#' + spot.index, op: op.name});

      const problems = [];
      if (after.parseError) problems.push('解析失败：' + after.parseError);
      const shapes = after.tables || [];
      const rectangular = shapes.every(rows => rows.length > 0 && rows.every(count => count === rows[0]));
      if (!rectangular) problems.push('表格不矩形：' + JSON.stringify(shapes));
      const errors = (after.errors || []).filter(text => !/Electron sandboxed_renderer|preloadScripts/.test(text));
      if (errors.length) problems.push('console 报错：' + errors.slice(0, 2).join(' | '));
      if (neutral && (after.domText !== before.domText || after.blockCount !== before.blockCount)) {
        problems.push('中性操作改了文档（DOM 层）：' + JSON.stringify({op: op.name, domChanged: after.domText !== before.domText, blocks: [before.blockCount, after.blockCount],
          domBefore: String(before.domText).slice(0, 80), domAfter: String(after.domText).slice(0, 80)}));
      }
      if (elapsed > 3000) problems.push('单步卡顿 ' + elapsed + 'ms');
      if (after.value.length === 0 && before.value.length > 20) problems.push('文档突然空了');

      if (problems.length) {
        findings.push({step, block: spot.tag + '#' + spot.index, op: op.name, problems, ops: oplog.slice(-12)});
        say('  ★ 第 ' + step + ' 步 [' + spot.tag + '#' + spot.index + '] ' + op.name + ' → ' + JSON.stringify(problems));
        say('      最近 12 步：' + oplog.slice(-12).map(item => item.op).join(' → '));
        fs.writeFileSync(path.join(OUT, 'finding-' + step + '.json'), JSON.stringify({seed: SEED, step, block: spot, op: op.name, problems, before: before.value, after: after.value, oplog}, null, 1));
        await session.shot('finding-' + step);
        if (findings.length >= 5) break;
      }
      if (step % 40 === 0) {
        const snapshot = await session.js(STATE);
        await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
          const root = w.document.querySelector(${SURFACE}); if (root) root.focus({preventScroll: true}); return true; })()`);
        await session.chord('a', 'KeyA', 65);
        await sleep(250);
        await session.type('检');
        await sleep(500);
        const wiped = await session.js(STATE);
        const clean = wiped.value.replace(/\s/g, '') === '检';
        await session.chord('z', 'KeyZ', 90);
        await sleep(800);
        const restored = await session.js(STATE);
        const okRestore = restored.value === snapshot.value;
        oplog.push({step, op: 'checkpoint(全选→打字→撤销)'});
        if (!clean || !okRestore) {
          const problems = [];
          if (!clean) problems.push('全选后打字结果不是单个字：' + JSON.stringify(wiped.value.slice(0, 60)));
          if (!okRestore) problems.push('撤销没有逐字节还原');
          findings.push({step, op: 'checkpoint', problems, ops: oplog.slice(-12)});
          say('  ★ 第 ' + step + ' 步 checkpoint → ' + JSON.stringify({clean, okRestore, wiped: wiped.value.slice(0, 60)}));
          fs.writeFileSync(path.join(OUT, 'finding-checkpoint-' + step + '.json'), JSON.stringify({seed: SEED, step, problems, wiped: wiped.value, snapshot: snapshot.value, restored: restored.value, oplog}, null, 1));
          await session.shot('finding-checkpoint-' + step);
          if (findings.length >= 5) break;
        } else {
          say('  · 检查点通过（第 ' + step + ' 步）：全选打字后文档恰好是一个字，撤销逐字节还原');
        }
      }
      previousValue = after.value;
      if (step % 50 === 0) say('  · 已完成 ' + step + ' 步（当前 ' + after.value.length + ' 字符，表格 ' + JSON.stringify(shapes) + '）');
      void previousValue;
    }

    say('模糊测试结束：seed=' + SEED + '，步数=' + oplog.length + '，发现=' + findings.length);
    fs.writeFileSync(path.join(OUT, 'oplog.json'), JSON.stringify({seed: SEED, steps: STEPS, findings, oplog}, null, 1));
  } finally {
    await session.close();
  }
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n'));
}

main().catch(error => {
  console.error('探针失败：', error && error.stack || error);
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'run.log'), LOG.join('\n') + '\n探针失败：' + String(error && error.stack || error));
  process.exit(1);
});
