/** 复现"展开编辑预渲染模式 + 点公式后面正文 → 高频闪烁"。
 *  做法：点开 `$33-1=32，33+8-1=40$`（展开态，浮出预览框）→ 点它后面"总长度"附近 →
 *  按 ~30ms 采样 3 秒，记录**每一个变化点**：浮出预览框的类名/矩形、公式节点展开态、
 *  合成光标、空白带/精确定位标记、以及 root 上的 mutation 计数（判"是谁在改 DOM"）。
 *  用法：node scripts/acceptance/probe-repro-flicker.cjs [--app=dev|installed|<exe>] [--file=<md>] [--para=路边等间隔种树]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const OUT = path.join(project, '.perf/repro-flicker');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const IF = `document.getElementById('editor').contentWindow`;
const APP = ARG('app', 'dev');
const SOURCE = ARG('file', '') ? path.resolve(ARG('file', '')) : path.join(DIR, '新建 Markdown 文档-副本.md');
const P = JSON.stringify(ARG('para', '路边等间隔种树'));

const 采样 = `(() => { const w = ${IF}; const d = w.document;
  const box = r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
  const 节点 = p ? [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')] : [];
  const 目标 = 节点.find(n => String(n.textContent).includes('33-1')) || 节点[0] || null;
  const 预览 = 目标 ? 目标.querySelector('.vditor-ir__preview') : null;
  const bar = d.querySelector('[data-typora-caret-proxy]');
  const sel = w.getSelection(); const at = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  return {展开: 目标 ? 目标.classList.contains('vditor-ir__node--expand') : null,
    类: 预览 ? String(预览.className) : null,
    框: 预览 ? box(预览.getBoundingClientRect()) : null,
    线: bar ? [bar.style.display, box(bar.getBoundingClientRect())] : null,
    光标: at ? [at.startContainer.nodeName + (at.startContainer.nodeType === 3 ? '(len' + String(at.startContainer.data).length + ')' : ''), at.startOffset] : null,
    mut: w.__mutCount || 0, 画: w.__caretProxyShown || 0}; })()`;

(async () => {
  fs.rmSync(OUT, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  fs.mkdirSync(OUT, {recursive: true});
  const doc = path.join(OUT, 'copy.md');
  fs.copyFileSync(SOURCE, doc);
  const exe = APP === 'dev' ? path.join(project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/markpilot/MarkPilot.exe' : APP;
  const session = await harness.launch({
    exe, appArgs: APP === 'dev' ? [path.join(project, 'app/main/main.js')] : [],
    label: 'probe-flicker', outDir: OUT, args: [doc], timeout: 300000, inspect: false,
  });
  const 轨 = async (标签, ms = 2600) => {
    const out = []; const t0 = Date.now();
    while (Date.now() - t0 < ms) { out.push([Date.now() - t0, await session.js(采样)]); await sleep(30); }
    let 上 = null; const 变 = [];
    for (const [t, s] of out) { const k = JSON.stringify(s); if (k === 上) continue; 上 = k; 变.push([t, s]); }
    console.log('\n--- ' + 标签 + '：' + ms + 'ms 内 ' + 变.length + ' 次变化 ---');
    for (const [t, s] of 变.slice(0, 24)) console.log(`  +${t}ms ` + JSON.stringify(s));
    return 变.length;
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
    // 装 mutation 计数
    await session.js(`(() => { const w = ${IF}; const d = w.document;
      const root = d.querySelector('.vditor-ir'); if (!w.__mutCount && root && typeof MutationObserver === 'function') {
        w.__mutCount = 0; new MutationObserver(list => { w.__mutCount += list.length; })
          .observe(root, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style']}); }
      return 1; })()`);
    const 位 = await session.js(`(() => { const w = ${IF}; const d = w.document;
      const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
      const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
      const n = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(x => String(x.textContent).includes('33-1'));
      const 预 = n.querySelector('.vditor-ir__preview');
      const tn = [...p.childNodes].find(x => x.nodeType === 3 && x.data.includes('总长度'));
      let 总 = null;
      if (tn) { const i = tn.data.indexOf('总长度'); const r = d.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 3); 总 = box(r.getBoundingClientRect()); }
      return {公式框: box(n.getBoundingClientRect()), 预览框: box(预.getBoundingClientRect()), 总长度框: 总, 行盒: [...p.getClientRects()].map(box)}; })()`);
    console.log('几何：' + JSON.stringify(位));
    // ① 点公式正中 → 展开（我们的新补丁会把源码展开并精确定位）
    const 点1 = [位.预览框.x + Math.round(位.预览框.w / 2), 位.预览框.y + Math.round(位.预览框.h / 2)];
    await session.click(frame.x + 点1[0], frame.y + 点1[1]);
    await sleep(700);
    console.log('① 点公式正中后：' + JSON.stringify(await session.js(采样)));
    await session.shot('01-展开态');
    await 轨('展开态静止（基线，看有没有自发抖动）', 1500);
    // ② 点公式后面"总长度"附近（用户动作）
    if (位.总长度框) {
      await session.click(frame.x + 位.总长度框.x + 6, frame.y + 位.总长度框.y + Math.round(位.总长度框.h / 2));
      await 轨('② 点"总长度"附近', 3000);
      await session.shot('02-点后');
      const 后 = await session.js(`(() => { const w = ${IF}; const d = w.document;
        const box = r => ({x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)});
        const p = [...d.querySelectorAll('.vditor-ir .vditor-reset > p')].find(x => String(x.textContent).includes(${P}));
        const n = [...p.querySelectorAll('.vditor-ir__node[data-type="inline-node"]')].find(x => String(x.textContent).includes('33-1'));
        return {展开: n.classList.contains('vditor-ir__node--expand'), 预览类: String(n.querySelector('.vditor-ir__preview').className),
          预览框: box(n.querySelector('.vditor-ir__preview').getBoundingClientRect())}; })()`);
      console.log('② 之后状态：' + JSON.stringify(后));
    }
    // ②b 扫一圈位置：先展开公式，再点它右缘附近的若干 x，每处连拍 10 帧数不同帧（闪烁会表现为帧反复变）
    const 帧前缀 = 'scan-';
    for (const dx of [-30, -10, -2, 2, 6, 12, 30, 60]) {
      await session.click(frame.x + 点1[0], frame.y + 点1[1]);          // 先点回公式（展开）
      await sleep(450);
      const x = frame.x + 位.公式框.x + 位.公式框.w + dx;
      const y = frame.y + 位.公式框.y + Math.round(位.公式框.h / 2);
      await session.click(x, y);
      const 帧 = [];
      for (let i = 0; i < 10; i++) {
        const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {x: frame.x, y: frame.y + 60, width: Math.min(880, frame.w), height: 200, scale: 1}});
        const buf = Buffer.from(png.data, 'base64');
        const crypto = require('node:crypto');
        帧.push(crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8));
        await sleep(110);
      }
      const 不同 = new Set(帧).size;
      const 状态 = await session.js(采样);
      console.log(`
[扫 dx=${dx}] 连拍 10 帧：不同帧 ${不同} 张${不同 >= 3 ? '  ⟵ 有闪动' : ''}`);
      console.log('   状态：' + JSON.stringify(状态));
      if (不同 >= 3) {
        fs.writeFileSync(path.join(OUT, 帧前缀 + dx + '.png'),
          Buffer.from((await session.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
        await 轨('闪烁位置 dx=' + dx, 1500);
      }
    }
    // ②c 定向观察：保持"展开 + 光标在源码里"的状态，看 DOM 是否在持续变更、以及藏掉我们的线后画面还动不动
    await session.click(frame.x + 点1[0], frame.y + 点1[1]);
    await sleep(500);
    await session.click(frame.x + 位.公式框.x + 位.公式框.w - 10, frame.y + 位.公式框.y + 8);   // dx=-10：保持展开
    await sleep(500);
    console.log('');
    console.log('=== 定向观察（展开态 + 光标在源码里）===');
    let 上 = await session.js(`(() => { const w = ${IF}; return w.__mutCount || 0; })()`);
    const 突变 = [];
    for (let i = 0; i < 12; i++) {
      await sleep(200);
      const 现 = await session.js(`(() => { const w = ${IF}; return w.__mutCount || 0; })()`);
      突变.push(现 - 上); 上 = 现;
    }
    console.log('每 200ms 的 DOM 变更条数：' + JSON.stringify(突变) + '（总和 ' + 突变.reduce((a, b) => a + b, 0) + '）');
    const 拍 = async (标签, 次数, 间隔) => {
      const 帧 = [];
      for (let i = 0; i < 次数; i++) {
        const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {x: frame.x, y: frame.y + 60, width: Math.min(880, frame.w), height: 200, scale: 1}});
        const crypto = require('node:crypto');
        帧.push(crypto.createHash('sha1').update(Buffer.from(png.data, 'base64')).digest('hex').slice(0, 6));
        await sleep(间隔);
      }
      console.log(`${标签}：连拍 ${次数} 帧（间隔 ${间隔}ms）→ 不同帧 ${new Set(帧).size} 张`);
      return 帧;
    };
    await 拍('有线', 16, 70);
    await session.js(`(() => { const w = ${IF}; const d = w.document;
      let st = d.getElementById('__hidebar'); if (!st) { st = d.createElement('style'); st.id = '__hidebar';
        st.textContent = '[data-typora-caret-proxy]{display:none !important}'; d.head.appendChild(st); } return 1; })()`);
    await 拍('藏线', 16, 70);
    await session.js(`(() => { const w = ${IF}; const d = w.document; const st = d.getElementById('__hidebar'); if (st) st.remove(); return 1; })()`);
    await 拍('恢复有线', 16, 70);
    console.log('②c 结束状态：' + JSON.stringify(await session.js(采样)));
    // ②d 三种"人味"变体：悬停 / 按下不放 / 从公式缓慢移到"总长度"
    const 帧差 = async (标签, 次数 = 14, 间隔 = 80) => {
      const 帧 = [];
      for (let i = 0; i < 次数; i++) {
        const png = await session.send('Page.captureScreenshot', {format: 'png', clip: {x: frame.x, y: frame.y + 60, width: Math.min(880, frame.w), height: 200, scale: 1}});
        const crypto = require('node:crypto');
        帧.push(crypto.createHash('sha1').update(Buffer.from(png.data, 'base64')).digest('hex').slice(0, 6));
        await sleep(间隔);
      }
      console.log(`${标签}：不同帧 ${new Set(帧).size} / ${次数}`);
      return new Set(帧).size;
    };
    const 展 = async () => { await session.click(frame.x + 点1[0], frame.y + 点1[1]); await sleep(450); };
    const 总 = [frame.x + 位.总长度框.x + 6, frame.y + 位.总长度框.y + Math.round(位.总长度框.h / 2)];
    await 展();
    await session.move(frame.x + 位.预览框.x + 40, frame.y + 位.预览框.y + 10);   // 悬停在展开后的浮框上
    await sleep(300);
    await 帧差('悬停在浮框上');
    await 展();
    await session.move(总[0], 总[1]); await sleep(200);
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: 总[0], y: 总[1], button: 'left', buttons: 1, clickCount: 1});
    await sleep(250);
    await 帧差('在"总长度"处按下不放');
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 总[0], y: 总[1], button: 'left', buttons: 0, clickCount: 1});
    await sleep(300);
    await 帧差('松开之后');
    await 展();
    const 起 = [frame.x + 位.公式框.x + 位.公式框.w - 10, frame.y + 位.公式框.y + 8];
    await session.move(起[0], 起[1]); await sleep(150);
    for (let i = 1; i <= 8; i++) {   // 从公式右缘缓慢移到"总长度"
      await session.move(Math.round(起[0] + (总[0] - 起[0]) * i / 8), Math.round(起[1] + (总[1] - 起[1]) * i / 8));
      await sleep(70);
    }
    await 帧差('从公式缓慢移到"总长度"之后');
    console.log('②d 结束状态：' + JSON.stringify(await session.js(采样)));
    // ③ 再来一次：点公式、再点后方（确认可重复）
    await session.click(frame.x + 点1[0], frame.y + 点1[1]);
    await sleep(600);
    await session.click(frame.x + 位.总长度框.x + 6, frame.y + 位.总长度框.y + Math.round(位.总长度框.h / 2));
    await 轨('③ 重复一次', 2000);
    console.log('\nconsole 错误：' + JSON.stringify(session.errors.slice(0, 3)));
    console.log('输出：' + OUT);
  } finally { await session.close(); }
})().catch(error => { console.error('探针失败：', error); process.exit(1); });
