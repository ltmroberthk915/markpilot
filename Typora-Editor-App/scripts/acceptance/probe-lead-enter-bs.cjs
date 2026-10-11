/** 定点探针：标题拆分后立刻退格（enter-bs 陷阱）会不会静默吃掉行内公式。
 *
 *  为什么要有它：139 号场景的 ⑧ 腿在两轮之间结果不一致（一轮 `$a+b=c$` 在盘上、一轮变成空格）。
 *  数据静默丢失是 P0 面，必须把"是哪条路、复现率多少、老路径是否也中招"钉死。
 *
 *  三条腿，同一会话内逐轮复位（每轮都重新置文 + 复位焦点）：
 *    A 新路：光标在标记**之后** → Enter（新契约：标记留原行、内容落下一行）→ 立刻 Backspace
 *    B 老路：光标在**标题内容末尾** → Enter（既有拆分支，2.3.1 就有）→ 立刻 Backspace
 *    C 老路：光标在标记**之前** → Enter（空行分支，2.3.1 就有）→ 立刻 Backspace
 *  每轮读三份：md（产品自报）、DOM 块序列、**Ctrl+S 之后磁盘逐字节**。
 *
 *  用法（必须过启动闸）：
 *    node scripts/acceptance/app-slot.cjs -- node scripts/acceptance/probe-lead-enter-bs.cjs 6 dev
 *    node scripts/acceptance/app-slot.cjs -- node scripts/acceptance/probe-lead-enter-bs.cjs 6 installed
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const project = harness.project;
const 轮数 = Number(process.argv[2] || 6);
const 目标 = (process.argv[3] || 'dev').toLowerCase();
const INSTALLED = 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const OUT = path.join(project, '.perf/probe-lead-enter-bs-' + 目标);
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = '.vditor-ir .vditor-reset';

const 置文 = md => `(() => { const w = ${IF}; w.vditor.setValue(${JSON.stringify(md)}); return true; })()`;
const 就绪 = `(() => { const w = ${IF}, d = w && w.document; const s = d && d.querySelector('${SURFACE}');
  if (!s) return { ok: false };
  s.focus();
  return { ok: w.document.hasFocus() && !!w.document.activeElement && !!w.document.activeElement.closest('.vditor-ir') }; })()`;
const 摆 = 位置 => `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  const h = s.querySelector('h1,h2,h3,h4,h5,h6'); if (!h) return { ok: false };
  let t = null;
  if (${JSON.stringify(位置)} === '内容末') t = [...h.childNodes].filter(n => n.nodeType === 3).pop() || null;
  else { const m = h.querySelector('[data-type="heading-marker"]'); t = m ? m.firstChild : null; }
  if (!t || t.nodeType !== 3) return { ok: false, why: 'no-text' };
  const off = ${JSON.stringify(位置)} === '标记前' ? 0 : t.data.length;
  const r = d.createRange(); r.setStart(t, off); r.collapse(true);
  const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  s.focus();
  return { ok: true, off, len: t.data.length, data: t.data }; })()`;
const 读块 = `(() => { const w = ${IF}, d = w.document; const s = d.querySelector('${SURFACE}');
  return [...s.children].map(b => b.tagName + '[' + (b.textContent || '').replace(/\\u200b/g, '<z>') + ']'); })()`;
const 读md = `(() => { const w = ${IF}; try { return w.vditor.getValue(); } catch (e) { return 'ERR:' + e.message; } })()`;

const MD = '### 标题甲 $a+b=c$ 收尾\n\n后文。\n';
const 腿 = {
  A: { 名: '新路 标记之后 Enter → 退格', 位置: '标记后' },
  B: { 名: '老路 内容末尾 Enter → 退格', 位置: '内容末' },
  C: { 名: '老路 标记之前 Enter → 退格', 位置: '标记前' },
};

async function 存盘(session) {
  await session.chord('s', 'KeyS', 83);
  for (let i = 0; i < 30; i++) { await harness.sleep(120); }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const doc = path.join(OUT, 'enter-bs.md');
  fs.writeFileSync(doc, MD, 'utf8');
  const 启动 = 目标 === 'installed'
    ? { exe: INSTALLED, label: 'probe-lead-enter-bs-installed', outDir: OUT, args: [doc], timeout: 240000, inspect: true }
    : { exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
        appArgs: [path.join(project, 'app/main/main.js')], label: 'probe-lead-enter-bs-dev', outDir: OUT,
        args: [doc], timeout: 240000, inspect: true };
  const session = await harness.launch(启动);
  const 结论 = { 目标, 轮数, 腿: {} };
  try {
    await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector('${SURFACE}')); })()`, { timeout: 120000, interval: 80 });
    await harness.sleep(1600);
    for (const [键, 腿定义] of Object.entries(腿)) {
      const 记 = { 名: 腿定义.名, 丢公式: 0, 轮: [] };
      for (let i = 1; i <= 轮数; i++) {
        await session.js(置文(MD));
        await harness.sleep(500);
        const 焦点 = await session.js(就绪);
        const 摆好 = await session.js(摆(腿定义.位置));
        await session.key({ key: 'Enter', code: 'Enter', vk: 13, text: '\r' });
        await harness.sleep(480);
        const 拆后 = await session.js(读块);
        await session.key({ key: 'Backspace', code: 'Backspace', vk: 8 });
        await harness.sleep(560);
        const 合后 = await session.js(读块);
        const md = await session.js(读md);
        await 存盘(session);
        const 盘 = fs.readFileSync(doc, 'utf8');
        const md活 = String(md).includes('$a+b=c$');
        const 盘活 = 盘.includes('$a+b=c$');
        if (!盘活) 记.丢公式 += 1;
        记.轮.push({ 轮: i, 焦点: 焦点.ok, 摆好: 摆好.ok, 拆后, 合后, md活, 盘活, 盘: 盘.replace(/\n/g, '\\n') });
        console.log(`[${键}] 第 ${i} 轮 焦点=${焦点.ok} 拆后=${JSON.stringify(拆后)} 合后=${JSON.stringify(合后)} md上公式=${md活} 盘上公式=${盘活} 盘=${JSON.stringify(盘.replace(/\n/g, '\\n'))}`);
      }
      console.log(`[${键}] ${腿定义.名} → 丢公式 ${记.丢公式}/${轮数}\n`);
      结论.腿[键] = 记;
    }
  } finally {
    await session.close();
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(结论, null, 2));
  console.log('结果：' + path.join(OUT, 'result.json'));
})().catch(error => { console.error(error); process.exitCode = 1; });
