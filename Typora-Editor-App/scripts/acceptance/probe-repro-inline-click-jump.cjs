/** 现场：标题行里的长行内公式（`### 调拨比例问题：$S=\left[\frac{m}{n+m}甲-x\right]+\frac{n}{n+m}乙$`）。
 *  用户报告：鼠标点击想把光标放到 `\left[` 与 `\frac` 之间，**光标跳动**。
 *
 *  两段测量，每点都**先重读当前版面**再算坐标（上一版错在拿展开态的坐标去点折叠态）：
 *    A 折叠态：点渲染出来的公式（用户的第一下），看落点偏移与**渲染字形映射**是否一致；
 *    B 展开态：点源码文字里 `\left[` / `\frac` 的每个字符边界，看光标是否落在点的那一格、
 *      且**不再自己跑掉**（时间线：rAF / 60 / 200 / 600ms 的偏移）。
 *
 *  仪表：①事件末尾 + 定时采样光标（节点/偏移/层/矩形）②Selection 写入口带调用栈（谁挪的）。
 *  用法：node scripts/acceptance/probe-repro-inline-click-jump.cjs [--app=dev|installed|<exe>] [--file=<md>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-inline-click');
const IF = `document.getElementById('editor').contentWindow`;
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const SOURCE = ARG('file', 'C:/Users/ltmroberthk/Desktop/新建 Markdown 文档.md');

const 装表 = `(() => { const w = ${IF}; const d = w.document;
  if (!w.__jump) w.__jump = {ev: [], acts: [], t0: 0, hooked: false};
  const J = w.__jump; J.t0 = w.performance.now(); J.ev = []; J.acts = [];
  const 层 = el => el && el.closest ? (el.closest('code[data-type]') ? '源码' : el.closest('.vditor-ir__preview') ? '预览'
    : el.closest('[data-type$="-marker"]') ? '围栏' : el.closest('.vditor-ir__node[data-type^="math"]') ? '公式节点' : '正文') : null;
  J.记 = tag => { const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const n = r ? r.startContainer : null; const el = n ? (n.nodeType === 3 ? n.parentElement : n) : null;
    let rect = null;
    if (r) { const q = d.createRange(); q.setStart(n, r.startOffset); q.collapse(true);
      const b = q.getBoundingClientRect(); rect = [Math.round(b.left), Math.round(b.top), Math.round(b.height)]; }
    J.ev.push({t: Math.round(w.performance.now() - J.t0), tag,
      节点: n ? (n.nodeType === 3 ? 'TEXT(' + String(n.data).slice(0, 8) + '…' + String(n.data).length + ')' : n.nodeName) : null,
      偏移: r ? r.startOffset : null, 层: 层(el), rect, 选中: r ? r.toString().slice(0, 16) : ''}); };
  const P = w.Selection && w.Selection.prototype;
  if (P && !P.__jumpWrapped) { P.__jumpWrapped = true;
    for (const name of ['addRange', 'removeAllRanges', 'collapse', 'setBaseAndExtent', 'extend', 'empty']) {
      const orig = P[name]; if (typeof orig !== 'function') continue;
      P[name] = function (...a) { try { const st = String(new w.Error().stack || '').split('\\n').slice(1, 6).join(' <- ').replace(/\\s+/g, ' ');
          J.acts.push({t: Math.round(w.performance.now() - J.t0), 谁: name,
            参: a.map(v => v && v.nodeType ? (v.nodeType === 3 ? 'TEXT@' + String(v.data).length : v.nodeName) : String(v)).join(','), 栈: st.slice(0, 300)}); } catch (e) {}
        return orig.apply(this, a); };
    }
  }
  if (!J.hooked) { J.hooked = true;
    for (const type of ['mousedown', 'mouseup', 'click']) w.addEventListener(type, () => J.记(type), false);
    w.addEventListener('mouseup', () => { requestAnimationFrame(() => J.记('rAF'));
      for (const ms of [0, 16, 60, 200, 600]) setTimeout(() => J.记(ms + 'ms'), ms); }, false);
  }
  return 1; })()`;

const 读表 = `(() => { const J = ${IF}.__jump;
  if (!J) return null;
  const 去重 = []; let 上 = null;
  for (const e of J.ev) { const k = e.节点 + '|' + e.偏移 + '|' + e.层 + '|' + JSON.stringify(e.rect); if (k !== 上) { 去重.push(e); 上 = k; } }
  return {时间线: 去重, 写入: J.acts.map(a => ({t: a.t, 谁: a.谁, 参: a.参, 栈: a.栈.split(' <- ').slice(0, 3).join(' <- ')}))}; })()`;

/** 版面自述：折叠态给渲染字形（带源码区间），展开态给源码字符盒。 */
const 查状态 = `(() => { const w = ${IF}; const d = w.document;
  const box = b => b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null;
  const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
  if (!节点) return {没节点: true};
  const code = 节点.querySelector(':scope > code[data-type="math-inline"]') || 节点.querySelector('code[data-type="math-inline"]');
  const text = code && code.firstChild && code.firstChild.nodeType === 3 ? code.firstChild : null;
  const 预览 = 节点.querySelector(':scope > .vditor-ir__preview') || 节点.querySelector('.vditor-ir__preview');
  const 源码 = text ? String(text.data) : (code ? String(code.textContent) : null);
  const 字符盒 = [];
  if (text) for (let i = 0; i < 源码.length; i++) { let b = null;
    const r = d.createRange(); r.setStart(text, i); r.setEnd(text, i + 1);
    try { b = r.getBoundingClientRect(); } catch (e) {}
    字符盒.push(b && (b.width || b.height) ? box(b) : null); }
  const 字形 = [];
  if (预览) for (const el of 预览.querySelectorAll('[data-typora-source-start]')) {
    if (el.querySelector('[data-typora-source-start]')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    字形.push({起: Number(el.getAttribute('data-typora-source-start')), 止: Number(el.getAttribute('data-typora-source-end')),
      字: String(el.textContent).slice(0, 6), 盒: box(r)});
  }
  return {展开: 节点.classList.contains('vditor-ir__node--expand'), 源码, 字符盒, 字形,
    code框: code ? box(code.getBoundingClientRect()) : null, 节点框: box(节点.getBoundingClientRect()),
    预览框: 预览 ? box(预览.getBoundingClientRect()) : null,
    行框: box((节点.closest('h3,h2,h4,p') || 节点).getBoundingClientRect())}; })()`;

const 找下标 = (源码, 子串, 次) => { let from = 0, at = -1;
  for (let k = 0; k < 次; k++) { at = 源码.indexOf(子串, from); if (at < 0) return -1; from = at + 1; } return at; };

/** 折叠态"应该落哪"：字形盒包含点（面积最小）→ 命令取 `起+1`、右半边取 `止`、否则 `起`；缝隙取最近字形。 */
const 字形期望 = (字形, x, y) => {
  const 含 = 字形.filter(g => x >= g.盒[0] && x <= g.盒[0] + g.盒[2] && y >= g.盒[1] && y <= g.盒[1] + g.盒[3])
    .sort((a, b) => a.盒[2] * a.盒[3] - b.盒[2] * b.盒[3]);
  let 用 = 含[0] || null;
  if (!用) { let 近 = Infinity;
    for (const g of 字形) { const dx = x < g.盒[0] ? g.盒[0] - x : x > g.盒[0] + g.盒[2] ? x - g.盒[0] - g.盒[2] : 0;
      const dy = y < g.盒[1] ? g.盒[1] - y : y > g.盒[1] + g.盒[3] ? y - g.盒[1] - g.盒[3] : 0; const d = Math.hypot(dx, dy);
      if (d < 近) { 近 = d; 用 = g; } } }
  if (!用) return null;
  const 末 = 字形[字形.length - 1];
  const 源码 = String(用.字 || '');
  let 偏移 = 用.起;
  if (用 === 末) 偏移 = 用.止;
  else if (x >= 用.盒[0] + 用.盒[2] / 2) 偏移 = 用.止;
  return {偏移, 字形: 用.字, 起止: [用.起, 用.止], 末: 用 === 末};
};

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-inline-click', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 拍图 = async (名, clip) => {
    const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {...clip, scale: 2}});
    fs.writeFileSync(path.join(OUT, 名 + '.png'), Buffer.from(png.data, 'base64'));
  };
  const 打印 = (名, R, 期望) => {
    console.log('\n【' + 名 + '】期望偏移 ' + (期望 ? 期望.偏移 + '（字形「' + 期望.字形 + '」起止' + JSON.stringify(期望.起止) + '）' : '—'));
    if (!R) { console.log('   （无记录）'); return; }
    for (const e of R.时间线) console.log('   t=' + String(e.t).padStart(4) + 'ms ' + e.tag.padEnd(10) + ' ' + e.节点 + '@' + e.偏移
      + ' [' + e.层 + '] rect=' + JSON.stringify(e.rect) + (e.选中 ? ' <' + e.选中 + '>' : ''));
    for (const a of R.写入) console.log('   ✎ t=' + String(a.t).padStart(4) + 'ms ' + a.谁 + '(' + a.参 + ')  ' + a.栈);
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('app=' + APP + ' iframe=' + JSON.stringify(frame));

    for (let i = 0; i < 16; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
        if (!节点) return {没节点: true};
        const 行 = 节点.closest('h3,h2,h4,p') || 节点;
        const b = 行.getBoundingClientRect(); const 高 = w.innerHeight;
        if (b.top >= 140 && b.bottom <= 高 - 280) return {好了: true, 行: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]};
        const 目标 = b.top - Math.round(高 * 0.38);
        let 滚 = 节点.parentElement; let 推了 = null;
        while (滚) { const cs = w.getComputedStyle(滚);
          if (/(auto|scroll|overlay)/.test(cs.overflowY) && 滚.scrollHeight > 滚.clientHeight + 4) { 滚.scrollTop += 目标; 推了 = Math.round(滚.scrollTop); break; }
          滚 = 滚.parentElement; }
        if (!推了) { 行.scrollIntoView({block: 'center'}); 推了 = 'scrollIntoView'; }
        return {迭代: ${i}, 前top: Math.round(b.top), 推了}; })()`);
      if (r.好了 || r.没节点) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(200);
    }
    await sleep(400);

    // ============ A 折叠态：点渲染出来的公式 ============
    const A0 = await session.js(查状态);
    console.log('\n折叠态：展开=' + A0.展开 + ' 节点框=' + JSON.stringify(A0.节点框) + ' 预览框=' + JSON.stringify(A0.预览框));
    console.log('渲染字形数=' + (A0.字形 || []).length);
    const 复位 = async () => {   // 把光标放到标题文字里（同一行、公式左边），保持视口不动
      const S = await session.js(查状态);
      const 行 = S.行框;
      await session.click(frame.x + 行[0] + 24, frame.y + 行[1] + Math.round(行[3] / 2));
      await sleep(260);
    };
    let n = 0;
    for (const 比例 of [0.10, 0.22, 0.34, 0.5, 0.66, 0.82]) {
      await 复位();
      const S = await session.js(查状态);
      const 框 = S.预览框 || S.节点框;
      const x = 框[0] + Math.round(框[2] * 比例), y = 框[1] + Math.round(框[3] / 2);
      await session.js(装表);
      await session.click(frame.x + x, frame.y + y);
      await sleep(700);
      const R = await session.js(读表);
      n++;
      const 期望 = 字形期望(S.字形 || [], x, y);
      console.log('\n==================== A' + n + ' 折叠态点公式 ' + Math.round(比例 * 100) + '%  (点' + x + ',' + y + ') 展开前=' + S.展开);
      打印('A' + n, R, 期望);
      await 拍图('A' + n, {x: frame.x + Math.max(0, 框[0] - 30), y: frame.y + Math.max(20, 框[1] - 30), width: 820, height: 150});
    }

    // ============ B 展开态：点源码里的字符边界 ============
    // 先让公式展开（点渲染出来的公式正中），再把光标依次点到源码里的指定字符边界上
    const B0 = await session.js(查状态);
    if (!B0.展开) {
      const 框 = B0.预览框 || B0.节点框;
      await session.click(frame.x + 框[0] + Math.round(框[2] / 2), frame.y + 框[1] + Math.round(框[3] / 2));
      await sleep(800);
    }
    const B1 = await session.js(查状态);
    console.log('\n展开态：展开=' + B1.展开 + ' code框=' + JSON.stringify(B1.code框) + ' 预览框=' + JSON.stringify(B1.预览框));
    console.log('源码(' + (B1.源码 || '').length + ')：' + B1.源码);
    const 边界们 = [];
    for (const [名, idx] of [['\\left[ 之后', 找下标(B1.源码, '\\left[', 1) + 6], ['第1个 \\frac 之前', 找下标(B1.源码, '\\frac', 1)],
      ['\\frac{ 之后', 找下标(B1.源码, '\\frac', 1) + 6], ['甲 之前', 找下标(B1.源码, '甲', 1)],
      ['第2个 \\frac 之前', 找下标(B1.源码, '\\frac', 2)], ['源码末尾', B1.源码.length]]) {
      if (idx < 0) continue;
      const 盒 = B1.字符盒[idx];
      if (!盒 && idx < B1.源码.length) continue;
      const x = 盒 ? 盒[0] : B1.code框[0] + B1.code框[2] - 2;
      const y = 盒 ? 盒[1] + Math.round(盒[3] / 2) : B1.code框[1] + Math.round(B1.code框[3] / 2);
      边界们.push({名, idx, x, y});
    }
    let m = 0;
    for (const 边界 of 边界们) {
      // 每次先重读版面（展开态下字符盒会随光标位置/回滚变化）
      const S = await session.js(查状态);
      if (!S.展开 || !S.字符盒 || !S.字符盒[边界.idx]) { console.log('\n跳过 ' + 边界.名 + '：展开=' + S.展开); continue; }
      const 盒 = S.字符盒[边界.idx];
      const x = 盒[0] + 1, y = 盒[1] + Math.round(盒[3] / 2);
      if (y < 4 || y > 709) { console.log('\n跳过 ' + 边界.名 + '：不在视口 y=' + y); continue; }
      await session.js(装表);
      await session.click(frame.x + x, frame.y + y);
      await sleep(700);
      const R = await session.js(读表);
      m++;
      console.log('\n==================== B' + m + ' 展开态点「' + 边界.名 + '」 目标偏移 ' + 边界.idx + '  (点' + x + ',' + y + ')');
      打印('B' + m, R, {偏移: 边界.idx, 字形: 边界.名, 起止: [边界.idx, 边界.idx]});
      const 图框 = (await session.js(查状态)).code框;
      await 拍图('B' + m, {x: frame.x + Math.max(0, 图框[0] - 40), y: frame.y + Math.max(20, 图框[1] - 30), width: 860, height: 150});
    }
    // ============ C 拖拽之后单击（REVEAL 态）：用户实际手势 ============
    // 拖拽选中会让我们给节点挂 `typora-ir-selected`；此时单击源码，看光标落到哪。
    const 拖 = async (x1, y1, x2, y2) => {
      await session.move(x1, y1); await sleep(50);
      await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1});
      const 步 = 6;
      for (let i = 1; i <= 步; i++) {
        const x = Math.round(x1 + (x2 - x1) * i / 步), y = Math.round(y1 + (y2 - y1) * i / 步);
        await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, buttons: 1});
        await sleep(25);
      }
      await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1});
      await sleep(300);
    };
    let k = 0;
    for (const [名, 起点idx, 终点idx, 点idx] of [['拖选 [ → 甲，再点 \\frac 之前', 7, 20, 8],
      ['拖选 m → 乙，再点 \\frac{ 之后', 14, 45, 14]]) {
      const S = await session.js(查状态);
      if (!S.展开) { console.log('\nC 跳过 ' + 名 + '：没展开'); continue; }
      const 起盒 = S.字符盒[起点idx], 终盒 = S.字符盒[终点idx], 点盒 = S.字符盒[点idx];
      if (!起盒 || !终盒 || !点盒) { console.log('\nC 跳过 ' + 名 + '：字符盒缺'); continue; }
      await 拖(frame.x + 起盒[0] + 2, frame.y + 起盒[1] + Math.round(起盒[3] / 2),
        frame.x + 终盒[0] + 2, frame.y + 终盒[1] + Math.round(终盒[3] / 2));
      const 选中 = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
        const sel = w.getSelection();
        return {类: 节点 ? String(节点.className) : null, 选中: String(sel.toString()).slice(0, 40), 塌: sel.isCollapsed}; })()`);
      console.log('\n已拖选：' + JSON.stringify(选中));
      await session.js(装表);
      await session.click(frame.x + 点盒[0] + 1, frame.y + 点盒[1] + Math.round(点盒[3] / 2));
      await sleep(700);
      k++;
      const R = await session.js(读表);
      console.log('\n==================== C' + k + ' ' + 名 + ' 目标偏移 ' + 点idx + ' (点' + (点盒[0] + 1) + ',' + (点盒[1] + Math.round(点盒[3] / 2)) + ')');
      打印('C' + k, R, {偏移: 点idx, 字形: 名, 起止: [点idx, 点idx]});
      const 图框 = (await session.js(查状态)).code框;
      await 拍图('C' + k, {x: frame.x + Math.max(0, 图框[0] - 40), y: frame.y + Math.max(20, 图框[1] - 30), width: 860, height: 160});
    }

    // ============ D 竖向扫：同一条边界上，从行顶到浮框内的不同高度各点一次 ============
    {
      const S0 = await session.js(查状态);
      if (!S0.展开 || !S0.字符盒 || !S0.字符盒[8]) console.log('\nD 跳过：没展开');
      else {
        const 盒 = S0.字符盒[8];
        const ys = [盒[1] + 2, 盒[1] + Math.round(盒[3] / 2), 盒[1] + 盒[3] - 2, 盒[1] + 盒[3] + 5, 盒[1] + 盒[3] + 10];
        let p = 0;
        for (const y of ys) {
          if (y < 4 || y > 709) continue;
          await session.js(装表);
          await session.click(frame.x + 盒[0] + 1, frame.y + y);
          await sleep(650);
          p++;
          const R = await session.js(读表);
          const 命中 = await session.js(`(() => { const w = ${IF}; const d = w.document;
            const el = d.elementFromPoint(${盒[0] + 1}, ${y});
            return el ? el.nodeName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')
              + (el.closest && el.closest('.vditor-ir__preview') ? '(预览)' : '') : null; })()`);
          console.log('\n==================== D' + p + ' 展开态点 y=' + y + '（字符盒 y ' + 盒[1] + '..' + (盒[1] + 盒[3]) + '，命中 ' + 命中 + '）目标偏移 8');
          打印('D' + p, R, {偏移: 8, 字形: '\\left[ 之后', 起止: [8, 8]});
        }
      }
    }

    // ============ E 拖拽终点落在渲染结果上（挂 typora-ir-selected）之后再点源码 ============
    {
      // ① 折叠：点标题文字把这条公式收回去
      const S = await session.js(查状态);
      const 行 = S.行框;
      await session.click(frame.x + 行[0] + 24, frame.y + 行[1] + Math.round(行[3] / 2));
      await sleep(400);
      const S1 = await session.js(查状态);
      console.log('\nE 起始：展开=' + S1.展开 + ' 预览框=' + JSON.stringify(S1.预览框));
      if (S1.预览框) {
        const 框 = S1.预览框;
        // ② 从标题文字拖到渲染结果里面（终点落在预览上）
        await 拖(frame.x + 框[0] - 60, frame.y + 框[1] + Math.round(框[3] / 2),
          frame.x + 框[0] + Math.round(框[2] * 0.7), frame.y + 框[1] + Math.round(框[3] / 2));
        const S2 = await session.js(查状态);
        const 类 = await session.js(`(() => { const w = ${IF}; const d = w.document;
          const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
          const sel = w.getSelection();
          return {类: 节点 ? String(节点.className) : null, 选中: String(sel.toString()).slice(0, 40), 塌: sel.isCollapsed,
            预览框: 节点 && 节点.querySelector('.vditor-ir__preview') ? (b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)])(节点.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null}; })()`);
        console.log('拖拽跨过渲染结果后：' + JSON.stringify(类) + ' 展开=' + S2.展开);
        const S3 = await session.js(查状态);
        if (S3.字符盒 && S3.字符盒[8]) {
          const 点盒 = S3.字符盒[8];
          await session.js(装表);
          await session.click(frame.x + 点盒[0] + 1, frame.y + 点盒[1] + Math.round(点盒[3] / 2));
          await sleep(700);
          const R = await session.js(读表);
          console.log('\n==================== E1 拖过渲染结果后点源码「\\left[ 之后」目标偏移 8');
          打印('E1', R, {偏移: 8, 字形: '\\left[ 之后', 起止: [8, 8]});
          console.log('   我们的标记：' + JSON.stringify(await session.js(`${IF}.__typoraInlineMathClick`)));
          await 拍图('E1', {x: frame.x + Math.max(0, S3.code框[0] - 40), y: frame.y + Math.max(20, S3.code框[1] - 30), width: 860, height: 160});
        } else console.log('E1 跳过：拖后拿不到字符盒（展开=' + S3.展开 + '）');
      }
    }

    // ============ F 验收图：拖选后点源码，按浏览器自报的光标矩形画标记（红实线＝光标落点） ============
    {
      const 画标记 = `(() => { const w = ${IF}; const d = w.document;
        let box = d.getElementById('__caretmark'); if (box) box.remove();
        const sel = w.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!r) return null;
        const q = d.createRange(); q.setStart(r.startContainer, r.startOffset); q.collapse(true);
        const rects = [...q.getClientRects()]; const b = rects.find(x => x.height > 0) || q.getBoundingClientRect();
        if (!b || !b.height) return null;
        const el = d.createElement('div'); el.id = '__caretmark';
        el.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;background:#e11;'
          + 'width:2px;border-radius:1px;left:' + Math.round(b.left - 1) + 'px;top:' + Math.round(b.top) + 'px;height:' + Math.round(b.height) + 'px;';
        d.body.appendChild(el);
        return {left: Math.round(b.left), top: Math.round(b.top), height: Math.round(b.height), 偏移: r.startOffset}; })()`;
      const 清标记 = `(() => { const d = ${IF}.d; return 1; })()`;
      const S = await session.js(查状态);
      const 盒 = S.字符盒 && S.字符盒[8];
      if (S.展开 && 盒) {
        // 手势：拖选跨过渲染结果（制造 REVEAL），再点 `\left[` 与 `\frac` 之间
        const 行 = S.行框;
        await session.click(frame.x + 行[0] + 24, frame.y + 行[1] + Math.round(行[3] / 2));
        await sleep(350);
        const S2 = await session.js(查状态);
        if (S2.预览框 && S2.预览框[2] > 0) {
          await 拖(frame.x + S2.预览框[0] - 60, frame.y + S2.预览框[1] + Math.round(S2.预览框[3] / 2),
            frame.x + S2.预览框[0] + Math.round(S2.预览框[2] * 0.7), frame.y + S2.预览框[1] + Math.round(S2.预览框[3] / 2));
        }
        const S3 = await session.js(查状态);
        const 点盒 = S3.字符盒 && S3.字符盒[8];
        if (点盒) {
          await session.click(frame.x + 点盒[0] + 1, frame.y + 点盒[1] + Math.round(点盒[3] / 2));
          await sleep(600);
          const 标记 = await session.js(画标记);
          const 图框 = {x: frame.x + Math.max(0, 点盒[0] - 150), y: frame.y + Math.max(0, 点盒[1] - 26), width: 470, height: 96};
          const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {...图框, scale: 2}});
          fs.writeFileSync(path.join(OUT, 'F-验收图.png'), Buffer.from(png.data, 'base64'));
          console.log('\n【F 验收图】REVEAL 态点源码 `\\left[` 与 `\\frac` 之间：标记=' + JSON.stringify(标记)
            + ' 目标偏移 8 → 图：' + path.join(OUT, 'F-验收图.png'));
          await session.js(`(() => { const d = ${IF}.document; const el = d.getElementById('__caretmark'); if (el) el.remove(); return 1; })()`);
        }
      } else console.log('\nF 跳过：展开=' + S.展开 + ' 盒=' + JSON.stringify(盒));
    }

    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
