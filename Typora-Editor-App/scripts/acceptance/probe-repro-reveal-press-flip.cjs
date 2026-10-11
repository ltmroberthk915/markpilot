/** 追一条与用户报告同族的病：**拖选翻开（REVEAL）但没挂 --expand** 的公式，按下去的那一帧选区塌陷
 *  → REVEAL 被撤 → 源码藏回去、渲染结果顶回来 → 这一枪落在"翻过之后的版面"上，光标跑到源码第 0 位。
 *
 *  逐事件取证：按下前的版面与类名 → mousedown 后（帧内）的类名/target → mouseup/click → rAF/60/200ms
 *  的类名与光标。命中测试 + 光标矩形都用**页坐标**打印，方便直接复跑。
 *
 *  用法：node scripts/acceptance/probe-repro-reveal-press-flip.cjs [--app=dev|installed|<exe>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const lab = require('./caret-lab.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-reveal-press');
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');

/** 选择区的写入口（带调用栈）：谁把光标挪走的。 */
const 装表 = `(() => { const w = ${lab.IF}; const d = w.document;
  if (!w.__tr) w.__tr = {acts: [], t0: 0};
  const T = w.__tr; T.acts = []; T.t0 = w.performance.now();
  const P = w.Selection && w.Selection.prototype;
  if (P && !P.__trWrapped) { P.__trWrapped = true;
    for (const name of ["addRange", "removeAllRanges", "collapse", "setBaseAndExtent", "extend", "empty"]) {
      const orig = P[name]; if (typeof orig !== "function") continue;
      P[name] = function (...a) { try { const st = String(new w.Error().stack || "").split(String.fromCharCode(10)).slice(1, 5).join(" <- ").replace(new RegExp("\\s+", "g"), " ");
          T.acts.push({t: Math.round(w.performance.now() - T.t0), 谁: name, 栈: st.slice(0, 200)}); } catch (e) {}
        return orig.apply(this, a); };
    }
  }
  return 1; })()`;
const 读表 = `(() => { const T = ${lab.IF}.__tr; return T ? T.acts : null; })()`;

const 夹具 = [
  '# 按下时版面翻转',
  '',
  '正文段甲：句中公式 $S=\\left[\\frac{m}{n+m}甲-x\\right]+\\frac{n}{n+m}乙$ 后面还有字。',
  '',
  '行尾公式：收尾 $y=2$',
  '',
  '正文段乙收尾。',
].join('\n') + '\n';

/** 关键事实：节点类名、当前命中层、光标偏移、源码框、光标盒（全部页坐标）。 */
const 事实 = `(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const d = w.document;
  const fr = frame.getBoundingClientRect();
  const 页 = b => b ? [Math.round(fr.x + b.left), Math.round(fr.y + b.top), Math.round(b.width), Math.round(b.height)] : null;
  const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(n => String(n.textContent).includes('\\\\left['));
  if (!节点) return {没节点: true};
  const code = 节点.querySelector('code[data-type="math-inline"]');
  const text = code && code.firstChild && code.firstChild.nodeType === 3 ? code.firstChild : null;
  const sel = w.getSelection();
  const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  let 光标 = null;
  if (at) { const n = at.startContainer; const q = d.createRange(); q.setStart(n, at.startOffset); q.collapse(true);
    const b = q.getBoundingClientRect();
    光标 = {在源码文本: n === text, 偏移: n === text ? at.startOffset : null, 塌: at.collapsed,
      选中: at.toString().slice(0, 24), 盒: b && b.height ? 页(b) : null}; }
  return {类: String(节点.className), 源码: text ? String(text.data) : null, 光标,
    code框: code ? 页(code.getBoundingClientRect()) : null, 节点框: 页(节点.getBoundingClientRect()),
    预览框: 节点.querySelector('.vditor-ir__preview') ? 页(节点.querySelector('.vditor-ir__preview').getBoundingClientRect()) : null}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.writeFileSync(doc, 夹具);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-reveal-press', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  try {
    await session.until(`(() => { const w = ${lab.IF}; return !!(w && w.document.querySelector('.vditor-ir .vditor-reset')); })()`,
      {timeout: 220000, interval: 120});
    await sleep(2500);
    const 读 = () => session.js(事实);

    // 造 "REVEAL 但没 --expand"：从正文拖选跨过渲染结果，落在预览里
    const S0 = await 读();
    const 框 = S0.预览框 || S0.节点框;
    const 起点 = {x: 框[0] - 60, y: 框[1] + Math.round(框[3] / 2)};
    const 终点 = {x: 框[0] + Math.round(框[2] * 0.7), y: 框[1] + Math.round(框[3] / 2)};
    await session.move(起点.x, 起点.y); await sleep(40);
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 起点.x, y: 起点.y, button: 'left', buttons: 1, clickCount: 1});
    for (let i = 1; i <= 6; i++) {
      await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
        x: Math.round(起点.x + (终点.x - 起点.x) * i / 6), y: 起点.y, buttons: 1});
      await sleep(25);
    }
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 终点.x, y: 终点.y, button: 'left', buttons: 0, clickCount: 1});
    await sleep(500);
    const S1 = await 读();
    console.log('拖选之后：类=' + S1.类 + ' code框=' + JSON.stringify(S1.code框) + ' 预览框=' + JSON.stringify(S1.预览框));
    const 字符盒 = (await session.js(lab.STATE)).字符盒 || [];
    const 目标 = 字符盒[8] || 字符盒.find(Boolean);
    const 目标索引 = 字符盒[8] ? 8 : 字符盒.findIndex(Boolean);
    if (!目标) { console.log('读不到源码几何，退出'); return; }
    const 枪 = {x: 目标[0] + 1, y: 目标[1] + Math.round(目标[3] / 2)};
    console.log('目标：源码第 ' + 目标索引 + ' 格 ' + JSON.stringify(枪) + ' 命中=' + JSON.stringify(await lab.命中(session, 枪.x, 枪.y)));

    console.log('按下点 caretRangeFromPoint=' + JSON.stringify(await session.js(`(() => { const frame = document.getElementById('editor'); const w = frame.contentWindow; const d = w.document; const fr = frame.getBoundingClientRect();
      const r = d.caretRangeFromPoint(${枪.x} - Math.round(fr.x), ${枪.y} - Math.round(fr.y));
      if (!r) return null;
      const 节点 = [...d.querySelectorAll('.vditor-ir__node[data-type=\\"inline-node\\"]')].find(n => String(n.textContent).includes('\\left['));
      const code = 节点 && 节点.querySelector('code[data-type=\\"math-inline\\"]');
      const text = code && code.firstChild;
      return {容器: r.startContainer.nodeType === 3 ? 'TEXT' : r.startContainer.nodeName, 偏移: r.startOffset,
        是目标文本: r.startContainer === text, 是目标code: r.startContainer === code}; })()`)));

    // 与场景 112 同一条路：harness.click（按下与抬起连着发，中间没有停顿）
    await session.js(装表);
    await session.click(枪.x, 枪.y);
    await sleep(60);
    console.log('点后 60ms：' + JSON.stringify((await 读()).光标));
    await sleep(200);
    console.log('点后 260ms：' + JSON.stringify((await 读()).光标));
    await sleep(440);
    const 终 = await 读();
    console.log('抬起 660ms：类=' + 终.类 + ' 光标=' + JSON.stringify(终.光标));
    console.log('写入口：'); for (const a of (await session.js(读表)) || []) console.log('   ✎ t=' + a.t + 'ms ' + a.谁 + '  ' + a.栈);
    console.log('期望：偏移 ' + 目标索引 + '（点的那一格）');
    const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {
      x: Math.max(0, (终.code框 ? 终.code框[0] : 200) - 60), y: Math.max(0, (终.code框 ? 终.code框[1] : 200) - 30), width: 700, height: 130, scale: 2}});
    fs.writeFileSync(path.join(OUT, '现场.png'), Buffer.from(png.data, 'base64'));
    console.log('console 错误：' + JSON.stringify(session.errors.slice(0, 3)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });

/** 关键事实：节点类名、当前命中层、光标偏移、源码框、光标盒（全部页坐标）。 */
