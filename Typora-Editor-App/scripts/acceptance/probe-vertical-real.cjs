/** 真实文档上的**全篇**纵向行走（用户 2026-09-18："全篇性测试 不要就这几行 随机起点 然后走全篇"）。
 *
 *  判据（**不用**行走前数好的固定行梯：行走中公式会展开/收回，后面的行整体位移，
 *  拿旧行梯去对每一步必然误报——上一版探针就是这么把好读数报成失败的）：
 *    ① 不落到隐形位置：每一步光标都要有可见矩形（0×0 就是用户说的"光标没了"）；
 *    ② 逐行性：从最上一行走到最下一行的**按键次数**和"行走后数出来的可见行数"对得上
 *       （允许 ±2：首/末行与空行边界）；
 *    ③ 左右稳定性：落点 x 与目标列之差 ≤ 该行字号（CJK 只能停字符边界），或贴在该行行首/行尾
 *       （短行、空行的自然钳制）。
 *  随机起点、随机目标列，种子固定可复现；文档用**副本**，原件只读。
 *
 *  用法：node scripts/acceptance/probe-vertical-real.cjs [--walks=6] [--seed=20260918]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-vertical-real');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';
const SOURCE = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09/新建 Markdown 文档-副本.md';

const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const rng = seed => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** 光标能落在哪几条行带上（逐 2px 探 y，取有高度的落点，按 y 去重）。 */
const LADDER = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  if (!surface) return {ok: false, error: '没有编辑面'};
  const box = surface.getBoundingClientRect();
  const seen = new Map();
  for (let y = Math.round(box.top) + 2; y < Math.round(box.bottom) - 2; y += 2) {
    const hit = d.caretRangeFromPoint(60, y);
    if (!hit) continue;
    const r = hit.getBoundingClientRect ? hit.getBoundingClientRect() : null;
    if (!r || !r.height) continue;
    const key = Math.round(r.top / 4);
    if (!seen.has(key)) seen.set(key, {top: Math.round(r.top), bottom: Math.round(r.bottom)});
  }
  const lines = [...seen.values()].sort((a, b) => a.top - b.top);
  return {ok: true, 行数: lines.length, 首行: lines[0] ? lines[0].top : null, 末行: lines.length ? lines[lines.length - 1].top : null}; })()`;

const READ = `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  const blocks = [...surface.children];
  const s = w.getSelection();
  if (!s.rangeCount) return {none: true};
  const r = s.getRangeAt(0);
  const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const block = at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote') || at;
  const box = r.getBoundingClientRect();
  return {块: blocks.indexOf(block), 文本: String(block.textContent || '').replace(/\\s+/g, ' ').slice(0, 18),
    层: at.closest('code[data-type]') ? '源码' : at.closest('.vditor-ir__preview') ? '预览' : at.closest('[data-type$="-marker"]') ? '围栏' : '正文',
    x: Math.round(box.left), y: Math.round(box.top), 高: Math.round(box.height), 可见: box.height > 0,
    行右缘: block.getBoundingClientRect ? Math.round(block.getBoundingClientRect().right) : null}; })()`;

const seek = (x, y) => `(() => { const w = ${IF}, d = w.document;
  const surface = d.querySelector(${JSON.stringify(SURFACE)});
  surface.focus();
  let hit = d.caretRangeFromPoint(${x}, ${y});
  const ok = candidate => {
    if (!candidate) return false;
    const at = candidate.startContainer.nodeType === 3 ? candidate.startContainer.parentElement : candidate.startContainer;
    if (at?.closest?.('.vditor-ir__preview,.vditor-ir__marker,[data-type$="-marker"]')) return false;
    const box = candidate.getBoundingClientRect ? candidate.getBoundingClientRect() : null;
    return !!(box && box.height);
  };
  if (!ok(hit)) hit = d.caretRangeFromPoint(60, ${y});
  if (!ok(hit)) return {ok: false, error: '没有可编辑落点'};
  const s = w.getSelection(); s.removeAllRanges(); s.addRange(hit);
  return {ok: true}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const source = argOf('file', SOURCE);
  if (!fs.existsSync(source)) { console.error('找不到真实文档：' + source); process.exit(2); }
  const doc = path.join(OUT, 'real-copy.md');
  fs.copyFileSync(source, doc);
  const originalSha = harness.fileSha(source);
  const walks = Number(argOf('walks', '6'));
  const seed0 = Number(argOf('seed', '20260918'));
  const next = rng(seed0);
  const session = await harness.launch({
    exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
    appArgs: [path.join(project, 'app/main/main.js')],
    label: 'probe-vertical-real', outDir: OUT, args: [doc], timeout: 900000, inspect: true,
  });
  const key = async (name, vk) => { await session.key({key: name, code: name, vk}); await sleep(280); return session.js(READ); };
  const summary = [];
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${JSON.stringify(SURFACE)})); })()`,
      {timeout: 140000, interval: 80});
    await sleep(1800);
    const ladder0 = await session.js(LADDER);
    console.log(`文档：${path.basename(source)}（副本 ${doc}）`);
    console.log(`行走前可见行数 ${ladder0.行数}（首行 y=${ladder0.首行} → 末行 y=${ladder0.末行}）；${walks} 轮随机起点，seed=${seed0}\n`);
    for (let round = 1; round <= walks; round++) {
      const startY = Math.round(ladder0.首行 + next() * Math.max(1, ladder0.末行 - ladder0.首行));
      const startX = Math.round(46 + next() * 600);
      const placed = await session.js(seek(startX, startY + 8));
      if (!placed.ok) { console.log(`第 ${round} 轮：起点 (${startX},${startY}) 放不进去，换一轮`); continue; }
      await sleep(260);
      const start = await session.js(READ);
      const goal = start.x;
      let invisible = 0, downPresses = 0, upPresses = 0, columnOff = 0;
      const worst = [];
      let last = start;
      let stuck = 0;
      for (let step = 0; step < 200; step++) {
        const now = await key('ArrowDown', 40);
        if (!now.可见) { invisible += 1; if (++stuck >= 3) break; continue; }
        stuck = 0;            // 隐形读数不记账：它的 y=0 会让下一拍立即 break
        if (now.y <= last.y + 1) break;
        downPresses += 1;
        if (Math.abs(now.x - goal) > Math.max(18, now.高) && !(now.行右缘 && now.行右缘 - now.x <= Math.max(24, now.高 * 1.5))) {
          columnOff += 1;
          if (worst.length < 4) worst.push({步: step + 1, 行y: now.y, x: now.x, 目标列: goal, 层: now.层, 文本: now.文本});
        }
        last = now;
      }
      const bottom = last;
      let top = bottom;
      stuck = 0;
      for (let step = 0; step < 200; step++) {
        const now = await key('ArrowUp', 38);
        if (!now.可见) { invisible += 1; if (++stuck >= 3) break; continue; }
        stuck = 0;            // 同上：隐形读数不吃掉这一拍
        if (now.y >= top.y - 1) break;
        upPresses += 1;
        if (Math.abs(now.x - goal) > Math.max(18, now.高) && !(now.行右缘 && now.行右缘 - now.x <= Math.max(24, now.高 * 1.5))) {
          columnOff += 1;
          if (worst.length < 4) worst.push({步: '↑' + (step + 1), 行y: now.y, x: now.x, 目标列: goal, 层: now.层, 文本: now.文本});
        }
        top = now;
      }
      const pl = await session.js(`(() => { const w = ${IF}; return (w.__pl || []).slice(-10); })()`);
      console.log('    三拍对照（目标列 → 同一拍读回 → 下一拍读回）：' + JSON.stringify(pl));
      await session.js(`(() => { const w = ${IF}; w.__pl = []; return 1; })()`);
      summary.push({轮: round, 起点: {x: start.x, y: start.y, 文本: start.文本}, 下移按键: downPresses, 上移按键: upPresses,
        隐形落点: invisible, 列偏离次数: columnOff, 到最底: bottom.y, 回到最顶: top.y, 样例: worst});
      console.log(`第 ${round} 轮：起点 y=${start.y} 列${start.x}「${start.文本}」→ ↓${downPresses} 次到 y=${bottom.y}，↑${upPresses} 次回到 y=${top.y}；` +
        `隐形落点 ${invisible} 次、列偏离 ${columnOff} 次`);
      for (const item of worst) console.log(`    · 偏离样例 ${JSON.stringify(item)}`);
    }
    const after = await session.js(LADDER);
    const badInvisible = summary.filter(row => row.隐形落点 > 0).length;
    const badColumn = summary.filter(row => row.列偏离次数 > 0).length;
    console.log(`\n行走后可见行数 ${after.行数}（行走前 ${ladder0.行数}）`);
    console.log(`汇总：${summary.length} 轮；出现隐形落点的 ${badInvisible} 轮；出现列偏离的 ${badColumn} 轮；` +
      `下/上按键次数 ${summary.map(row => row.下移按键 + '/' + row.上移按键).join('、')}`);
    const np = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
    console.log('走完全篇后文档长度 ' + String(np).length + ' 字符；副本与原件是否一致：' + (harness.fileSha(doc) === originalSha ? '一致 ✓（只读）' : '副本被改（原文未动）'));
  } finally {
    await session.close();
  }
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
