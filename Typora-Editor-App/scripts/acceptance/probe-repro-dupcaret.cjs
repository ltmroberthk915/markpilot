/** 双重光标判定器：对一组落到"隐形位置"的点击，**藏起我们的合成线连拍 6 帧**——
 *  帧里出现光标 = Blink 其实画了（我们重复画 = 双重光标）；一帧都没有 = Blink 真没画（我们才该画）。
 *  同时测第二件事：点**已渲染的行内公式**，看它展不展开、光标落在哪一层。
 *  用法：node scripts/acceptance/probe-repro-dupcaret.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-dupcaret');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const IF = `document.getElementById('editor').contentWindow`;
const PARA = ARG('para', '路边等间隔种树');
const P = JSON.stringify(PARA);
const APP = ARG('app', 'dev');
const SOURCE = ARG('file', '') ? path.resolve(ARG('file', '')) : path.join(DIR, '新建 Markdown 文档-副本.md');

const 读数 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const 链 = node => { const out = []; let cur = node;
    while (cur && out.length < 5) { out.push(cur.nodeName + (cur.getAttribute && cur.getAttribute('data-type') ? '[' + cur.getAttribute('data-type') + ']' : '')
      + (cur.nodeType === 3 ? '(len' + String(cur.data).length + ')' : (typeof cur.className === 'string' && cur.className ? '.' + cur.className.split(' ')[0] : ''))); cur = cur.parentNode; }
    return out.join(' < '); };
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const 层 = n => { if (!n) return null; const el = n.nodeType === 3 ? n.parentElement : n;
    return el && el.closest ? (el.closest('.vditor-ir__preview') ? '预览' : el.closest('[data-type$="-marker"]') ? '围栏'
      : el.closest('code[data-type]') ? '源码' : '正文') : null; };
  return {光标: at ? {链: 链(at.startContainer), 偏移: at.startOffset, 层: 层(at.startContainer),
      rect: box((() => { const q = d.createRange(); q.setStart(at.startContainer, at.startOffset); q.collapse(true); return q.getBoundingClientRect(); })())} : null,
    线: bar ? {显示: bar.style.display, rect: box(bar.getBoundingClientRect())} : null}; })()`;

const 藏线 = `(() => { const w = ${IF}; const d = w.document;
  let st = d.getElementById('__hidebar');
  if (!st) { st = d.createElement('style'); st.id = '__hidebar'; st.textContent = '[data-typora-caret-proxy]{display:none !important}'; d.head.appendChild(st); }
  return 1; })()`;
const 显线 = `(() => { const w = ${IF}; const d = w.document; const st = d.getElementById('__hidebar'); if (st) st.remove(); return 1; })()`;

/** 在 PNG 里找"单色窄竖条"（光标特征）：整列连续 ≥12 行、列内颜色种类 ≤3、且两侧邻列是背景。 */
function 找光标(png) {
  const {execFileSync} = require('node:child_process');
  const py = 'D:/Users/ltmroberthk/anaconda3/python.exe';
  const code = `
from PIL import Image
im = Image.open(r"${png}").convert("RGB"); px = im.load(); w,h = im.size
bg = px[2,2]
def d(p): return max(abs(p[0]-bg[0]), abs(p[1]-bg[1]), abs(p[2]-bg[2]))
out = []
for x in range(w):
    ys = [y for y in range(h) if d(px[x,y]) > 55]
    if len(ys) < 12: continue
    s = ys[0]; prev = ys[0]; segs = []
    for y in ys[1:]:
        if y-prev > 1: segs.append((s,prev)); s = y
        prev = y
    segs.append((s,prev))
    for a,b in segs:
        if b-a < 12: continue
        cols = {px[x,y] for y in range(a,b+1)}
        if len(cols) > 3: continue
        left = d(px[x-2, (a+b)//2]) if x >= 2 else 0
        right = d(px[x+2, (a+b)//2]) if x+2 < w else 0
        if left < 30 and right < 30:
            out.append((x, a, b, list(cols)[0]))
print(" ".join(f"{x}:{a}-{b}:{c}" for x,a,b,c in out))`;
  try { return execFileSync(py, ['-c', code], {encoding: 'utf8'}).trim(); } catch (e) { return 'ERR ' + String(e).slice(0, 80); }
}

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-dupcaret', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 连拍判断 = async (名, frame, clip) => {
    await session.js(藏线);
    const 帧 = [];
    for (let i = 0; i < 6; i++) {
      const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {...clip, scale: 2}});
      const file = path.join(OUT, `${名}-藏线-${i}.png`);
      fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
      帧.push({file, 命中: 找光标(file)});
      await sleep(170);
    }
    await session.js(显线);
    const 有 = 帧.filter(f => f.命中 && !f.命中.startsWith('ERR'));
    return {有线帧数: 有.length, 命中示例: 有.length ? 有[0].命中 : null};
  };
  const 测一点 = async (名, frame, clip, x, y) => {
    await session.js(显线);
    await session.click(frame.x + x, frame.y + y);
    await sleep(600);
    const S = await session.js(读数);
    const 改 = await session.js(`(() => { const w = ${IF}; return w.__typoraInlineMathClick || null; })()`);
    const 无 = await 连拍判断(名, frame, clip);
    if (改) console.log('  我们的精确定位：' + JSON.stringify(改));
    const 展 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const 全部 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')];
      return {展开数: 全部.filter(n => n.classList.contains('vditor-ir__node--expand')).length, 共: 全部.length}; })()`);
    console.log('  行内公式展开情况：' + JSON.stringify(展));
    const 有线 = (() => { const r = S.线 && S.线.显示 !== 'none' ? S.线.rect : null; return r; })();
    console.log(`\n【${名}】点(${x},${y})`);
    console.log('  光标：' + JSON.stringify(S.光标));
    console.log('  我们的线：' + JSON.stringify(有线));
    console.log('  藏线后 6 帧里有光标的帧数：' + 无.有线帧数 + (无.命中示例 ? '   例：' + 无.命中示例 : ''));
    return {名, 光标: S.光标, 线: 有线, 藏线后命中帧: 无.有线帧数};
  };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(2500);
    const frame = await session.js(`(() => { const f = document.getElementById('editor');
      const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    console.log('app=' + APP + ' iframe=' + JSON.stringify(frame));
    for (let i = 0; i < 12; i++) {
      const r = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
        if (!p) return {没段: true};
        const b = p.getBoundingClientRect(); const 视口高 = w.innerHeight;
        if (b.top >= 80 && b.bottom <= 视口高 - 200) return {好了: true};
        const 点y = b.top > 视口高 / 2 ? Math.min(视口高 - 20, 视口高 - 60) : 60;
        const el = d.elementFromPoint(400, 点y);
        const 锚 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
        if (!锚) return {没锚: true};
        锚.scrollIntoView({block: b.top > 视口高 / 2 ? 'end' : 'start'});
        return {迭代: ${i}, top: Math.round(b.top)}; })()`);
      if (r.好了 || r.没锚 || r.没段) { console.log('滚动：' + JSON.stringify(r)); break; }
      await sleep(250);
    }
    await sleep(300);
    // 目标段内的关键位置：段首、行内公式左右缘、公式内部、段末（末尾若是公式就再往左）
    const 位 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
      const 公式 = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].map(n => ({框: box(n.getBoundingClientRect()),
        预览: n.querySelector('.vditor-ir__preview') ? box(n.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null,
        文本: String(n.textContent).slice(0, 12), 展开: n.classList.contains('vditor-ir__node--expand')}));
      const 行 = [...p.getClientRects()].map(box);
      return {段: box(p.getBoundingClientRect()), 行, 公式}; })()`);
    console.log('段与公式：' + JSON.stringify(位, null, 1));
    const 行0 = 位.行[0];
    const clip = {x: frame.x + Math.max(0, 行0.x - 20), y: frame.y + Math.max(20, 行0.y - 10), width: Math.min(880, frame.w), height: Math.min(150, 行0.h * 2 + 20)};
    const 结果 = [];
    // 先点"内联运行"（<em>/<strong>）的边界——用户那段有 *一个大型养老院需* 这样的斜体运行
    const 运行们 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
      if (!p) return [];
      return [...p.querySelectorAll('em,strong,i,b')].map(el => ({标签: el.tagName, 框: box(el.getBoundingClientRect()), 文本: String(el.textContent).slice(0, 12)})); })()`);
    console.log('段内内联运行：' + JSON.stringify(运行们));
    for (const 运 of (运行们 || [])) {
      const y = 运.框.y + Math.round(运.框.h / 2);
      for (const [标签, x] of [['左外1', 运.框.x - 1], ['左内1', 运.框.x + 1], ['右内1', 运.框.x + 运.框.w - 2], ['右外1', 运.框.x + 运.框.w + 1]]) {
        if (y - frame.y > 680) continue;
        结果.push(await 测一点(`${运.标签}-${标签}`, frame, clip, x, y));
      }
    }
    // 网格扫描：段内两行 × 多个 x，专挑"我们的线会被画出来"的状态，并用藏线连拍核对 Blink 是否也画
    const 行们 = 位.行.slice(0, 2);
    const 记 = [];
    for (const 行 of 行们) {
      const ys = 行.y + Math.round(行.h / 2);
      for (const x of [行.x + 4, 行.x + 200, 行.x + 400, 行.x + 520, 行.x + 560, 行.x + 600, 行.x + 660, 行.x + 700, 行.x + 行.w - 8]) {
        if (ys - frame.y > 680) continue;
        const 名 = `网格-${行.y}-${x}`;
        const r = await 测一点(名, frame, clip, Math.round(x), Math.round(ys));
        记.push(r);
        // 只对"我们的线画出来了"或"藏线后拍到光标"的状态保留截图关注点
      }
    }
    // 键盘路径：End / Ctrl+End / 方向键（这些以前出现过"落进元素级位置、光标隐形"的状态）
    for (const [名, 键, vk, mods] of [['End', 'End', 35, 0], ['Ctrl+End', 'End', 35, harness.MOD.ctrl], ['→×3', 'ArrowRight', 39, 0]]) {
      await session.js(显线);
      for (let i = 0; i < (名 === '→×3' ? 3 : 1); i++) await session.key({key: 键, code: 键, vk, modifiers: mods});
      await sleep(500);
      const S = await session.js(读数);
      const 无 = await 连拍判断(名, frame, clip);
      console.log(`
【${名}】光标：` + JSON.stringify(S.光标) + '  我们的线：' + JSON.stringify(S.线 && S.线.显示 !== 'none' ? S.线.rect : null)
        + '  藏线后命中帧：' + 无.有线帧数);
      记.push({名, 光标: S.光标, 线: S.线 && S.线.显示 !== 'none' ? S.线.rect : null, 藏线后命中帧: 无.有线帧数});
    }
    for (const r of 记) 结果.push(r);
    console.log('\n汇总：');
    for (const r of 结果) console.log('  ' + JSON.stringify(r));
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 2)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
