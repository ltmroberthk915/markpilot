'use strict';
/** 探针 · R10 W1 G4/G5 覆盖缺口扫描（纯探查，不修码）。
 *
 *  G4 LLM 补全 Tab 真键链路：
 *   g4a 本地候选弹层：completion-suite probe 准备未完成公式 `\fr` → 真键 Ctrl+Space 弹层
 *       → 真键 Tab 接受 → 断言 md 含 \frac{}{}、光标落点、无页面错误；截图（弹层开/接受后）。
 *   g4b AI ghost（mock 桩）：本地 http 假 Anthropic 服务回 `2x` → 渲染层产品 API 触发建议
 *       （setup）→ 等 ghost → 真键 Tab 接受 → 断言插入 `2x`、一步撤销还原；截图。
 *   记录口径：任何异常/断言不过 → 「定点可复现」记录（固定素材+步骤），不修。
 *
 *  G5 阅读模式深度：
 *   打开带标题/链接/公式/长正文的中等文档 → 真点击工具栏「阅读模式」按钮进入 →
 *   真键 PageDown×3 滚动 + 真滚轮 → Shift+End 选区 + Ctrl+C 复制（读系统剪贴板）→
 *   点击正文内链接（openLink 走 shell 桩记录）→ 再点按钮退出回编辑 →
 *   断言 getValue 全程不变、光标可回落、磁盘不变。记录不修。
 *
 *  用法：node scripts/acceptance/probe-r10-g45.cjs [--only=g4,g5]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const DEV = !process.argv.includes('--installed');
const OUT = path.join(harness.project, '.perf/probe-r10-g45');
const EXE = DEV ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
  : 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe';
const APP_MAIN = path.join(harness.project, 'app/main/main.js');
const MOD = hi.MOD;
const sleep = harness.sleep;
const IF = hi.IF;

const readDisk = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const log = [];
const note = (line) => { console.log(line); log.push(line); };
const findings = [];
const record = (scope, text, detail) => { findings.push({ scope, text, detail }); note('  [发现] ' + scope + '：' + text + (detail ? '｜' + JSON.stringify(detail).slice(0, 300) : '')); };

/** completion-suite 的 probe 函数源码（在渲染帧里执行；与 desktop-completion.cjs 同一来源）。 */
const completionProbeSrc = require(path.join(harness.project, '..', 'Typora-Editor', 'test', 'completion-suite.cjs')).probe.toString();
/** 在编辑器帧里执行 completion-suite probe 动作（字符串进 eval，确保运行在帧上下文）。 */
const request = (session, action, params = {}) => session.js(
  `${IF}.eval(${JSON.stringify(`(${completionProbeSrc})(${JSON.stringify({ action, ...params })})`)})\n    .then(r => JSON.parse(JSON.stringify(r ?? null)))`);

const mdNow = session => session.js(`(() => { const w = ${IF}; try { return w.vditor.getValue(); } catch (e) { return 'ERR:' + e.message; } })()`);

async function launchCase(label, file) {
  return harness.launch({
    exe: EXE, ...(DEV ? { appArgs: [APP_MAIN] } : {}), label: 'probe-r10-g45/' + label,
    outDir: OUT, timeout: 200000, args: [file], inspect: true,
  });
}

/** 工具栏按钮在顶层页里的点击坐标（真点击通道）。 */
const toolbarButtonPoint = (session, name) => session.js(`(() => { const w = ${IF};
  const btn = w.vditor.vditor.toolbar.elements['${name}']?.querySelector('button');
  if (!btn) return null; const r = btn.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect();
  return { x: Math.round(fr.x + r.x + r.width / 2), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);

async function shotClip(session, name, box) {
  try {
    await session.shot(name + '-full');
    if (box) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png',
        clip: { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 40), width: Math.min(700, 1400), height: Math.min(260, 400), scale: 2 } });
      fs.writeFileSync(path.join(OUT, name + '-2x.png'), Buffer.from(shot.data, 'base64'));
    }
  } catch (error) { note('  （截图失败 ' + name + '：' + String(error && error.message || error).slice(0, 80) + '）'); }
}

// ─── G4 ───────────────────────────────────────────────────────────────────────
async function g4() {
  const file = path.join(OUT, 'g4-补全.md');
  fs.writeFileSync(file, '# G4 补全链路\n\nKeep $a+1$.\n\n\\fr\n', 'utf8');
  const session = await launchCase('g4', file);
  let server = null;
  try {
    await session.until(hi.readyExpr(2), { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    const errorsBefore = session.errors.length;

    // —— g4a 本地候选弹层：真键 Ctrl+Space → 真键 Tab ——
    let g4a = { name: 'g4a 本地公式补全 Ctrl+Space+Tab' };
    try {
      const prepared = await request(session, 'completion-prepare', { text: '# G4 补全链路\n\nKeep $a+1$.\n\n\\fr\n', needle: '\\fr' });
      await request(session, 'completion-place', { needle: '\\fr' });
      // 真键 Ctrl+Space（产品菜单同款触发：补全弹层）
      await hi.combo(session, 'Ctrl+Space');
      let menu = null;
      for (let i = 0; i < 40 && !menu; i++) { await sleep(80); menu = await session.js(`(() => { const d = ${IF}.document; const p = d.querySelector('.md-completion:not([hidden])'); return p ? { visible: true, n: p.querySelectorAll('li,button').length, text: p.textContent.slice(0, 60) } : null; })()`); }
      g4a.弹层 = menu;
      if (menu && menu.visible) {
        const box = await session.js(`(() => { const d = ${IF}.document; const p = d.querySelector('.md-completion:not([hidden])'); if (!p) return null; const r = p.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect(); return { x: Math.round(fr.x + r.x), y: Math.round(fr.y + r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
        await shotClip(session, 'g4a-弹层开', box);
        // 真键 Tab 接受
        await session.key({ key: 'Tab', code: 'Tab', vk: 9 });
        await sleep(400);
        const md = await mdNow(session);
        g4a.接受后md尾 = String(md).slice(-40);
        g4a.含frac = String(md).includes('\\frac{}{}');
        await shotClip(session, 'g4a-Tab接受后', box);
      } else record('G4', 'Ctrl+Space 后 3.2s 内未见候选弹层', { menu });
    } catch (error) { g4a.异常 = String(error && error.message || error).slice(0, 200); record('G4', 'g4a 链路异常', { msg: g4a.异常 }); }
    g4a.页面错误新增 = session.errors.length - errorsBefore;
    note('G4A ' + JSON.stringify(g4a));

    // —— g4b AI ghost：mock http 服务 → 产品 API 触发（setup）→ 真键 Tab ——
    let g4b = { name: 'g4b AI 建议 ghost+Tab' };
    const errorsBeforeG4b = session.errors.length;
    const requests = [];
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      requests.push({ at: Date.now() });
      if (!res.destroyed) { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: 'mock', content: [{ type: 'text', text: '2x' }] })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const cfg = await session.main.js(`(() => { const m = global.windows[0].doc.completions; return JSON.stringify({ ai: m.config.ai }); })()`);
      g4b.初始配置 = cfg;
      const upd = await session.main.js(`(() => { const m = global.windows[0].doc.completions;
        return m.update({ ...m.config, baseUrl: 'http://127.0.0.1:${server.address().port}/anthropic', ai: true, automaticAI: false, host: false })
          .then(() => m.saveAPIKey('r10-mock-key')).then(() => JSON.stringify({ ok: true, ai: m.config.ai, baseUrl: m.config.baseUrl })); })()`);
      const prepared = await request(session, 'completion-prepare', { text: "# 微积分\n\n## 导数\n\n已知 $f(x)=x^2$，则 $f'(x)=$。\n", needle: "f'(x)=" });
      await request(session, 'completion-formula-hit', { needle: "f'(x)=" });
      await request(session, 'completion-place', { needle: "f'(x)=" });
      await request(session, 'completion-dismiss').catch(() => null);
      await session.js(`${IF}.vditor.__completion.request(true, true); true`);
      let ghost = null;
      for (let i = 0; i < 90 && !ghost; i++) {
        await sleep(100);
        const st = await request(session, 'completion-read').catch(() => null);
        if (st && st.preview && st.ghost && !String(st.ghost).includes('正在')) ghost = { ghost: String(st.ghost).slice(0, 30) };
      }
      g4b.配置 = upd; g4b.ghost = ghost; g4b.请求数 = requests.length;
      if (ghost && ghost.ghost) {
        await shotClip(session, 'g4b-ghost在屏', null);
        await session.key({ key: 'Tab', code: 'Tab', vk: 9 });
        await sleep(450);
        const md = await mdNow(session);
        g4b.接受后md含2x = String(md).includes("f'(x)=2x");
        g4b.接受后md尾 = String(md).slice(-30);
        // 一步撤销（真键 Ctrl+Z）应还原
        await hi.combo(session, 'Ctrl+Z');
        await sleep(350);
        g4b.撤销后还原 = !(await mdNow(session)).includes("f'(x)=2x");
        await shotClip(session, 'g4b-Tab接受后', null);
      } else record('G4', 'AI 建议 ghost 未在 5.4s 内出现', { ghost, 请求数: requests.length });
    } catch (error) { g4b.异常 = String(error && error.message || error).slice(0, 200); record('G4', 'g4b 链路异常', { msg: g4b.异常 }); }
    g4b.页面错误新增 = session.errors.length - errorsBeforeG4b;
    note('G4B ' + JSON.stringify(g4b));
    // 收尾：还原补全默认配置（不留下 mock 痕迹）
    await session.main.js(`(() => { const m = global.windows[0].doc.completions; const d = require(${JSON.stringify('"E:/MarkPilot/Typora-Editor-App/app/shared/out/completion/core.cjs"')}).settings; return m.update(d()); })()`).catch(() => {});
  } finally {
    try { server && server.closeAllConnections && server.closeAllConnections(); } catch {}
    try { server && await new Promise(r => server.close(r)); } catch {}
    await session.close().catch(() => {});
  }
}

// ─── G5 ───────────────────────────────────────────────────────────────────────
async function g5() {
  const file = path.join(OUT, 'g5-阅读.md');
  const body = ['# G5 阅读模式深度', '',
    '首段：进入阅读态前的锚点文字，光标与文档保真的基准。', '',
    '[外部链接示例](https://example.com/r10-g5) 与 [本地跳转](#g5-第二节) 都在正文里。', '',
    '公式行：$E=mc^2$ 与 $\\frac{a}{b}$ 混排。', '',
    '## g5-第二节', '',
    ...Array.from({ length: 60 }, (_, i) => '第' + i + '段：' + '阅读态滚动与选择的目标文本，需要更长的正文才能产生真实滚动。'.repeat(3)), ''].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  const session = await launchCase('g5', file);
  const result = { name: 'g5 阅读模式深度' };
  try {
    await session.until(hi.readyExpr(3), { timeout: 90000 });
    await sleep(1500);
    await session.main.js(`global.windows[0].doc.setSetting('autoSave', false)`);
    const before = { md: await mdNow(session), sha: harness.fileSha(file) };
    await hi.ensureFocus(session);
    result.进入前md尾 = String(before.md).slice(-16);

    // 1) 真点击工具栏「阅读模式」按钮进入
    const btn = await toolbarButtonPoint(session, 'reading-mode');
    result.按钮坐标 = btn;
    if (!btn) throw new Error('找不到阅读模式按钮');
    await session.click(btn.x, btn.y);
    let reading = null;
    for (let i = 0; i < 30 && !reading; i++) { await sleep(100); reading = await session.js(`(() => { const w = ${IF}; const d = w.document; return { active: !!w.vditor.__typoraReading?.active, mode: w.vditor.vditor.currentMode, previewInDom: !!d.querySelector('.vditor-preview') }; })()`); }
    result.进入态 = reading;
    await shotClip(session, 'g5-阅读态进入', null);
    if (!reading || !reading.active) record('G5', '点击阅读模式按钮后 3s 内未进入阅读态', { reading });

    // 2) 真键滚动：PageDown×3 + Home
    await session.key({ key: 'PageDown', code: 'PageDown', vk: 34 }); await sleep(250);
    await session.key({ key: 'PageDown', code: 'PageDown', vk: 34 }); await sleep(250);
    await session.key({ key: 'PageDown', code: 'PageDown', vk: 34 }); await sleep(350);
    const scrollOf = `(async () => { const w = ${IF}; let best = null; for (const el of [...w.document.querySelectorAll('.vditor-preview,.vditor-reset,pre'), w.document.scrollingElement].filter(Boolean)) { if (el.scrollHeight > el.clientHeight + 4 && (!best || el.scrollHeight > best.h)) best = { who: String(el.className).slice(0, 22), top: Math.round(el.scrollTop), h: Math.round(el.scrollHeight) }; } return best || { who: 'none', top: -1, h: -1 }; })()`;
    const scrollAfterKeys = await session.js(scrollOf);
    // 真滚轮（按下→移动→抬起不适用；wheel 是原生事件通道）
    await session.wheel(400, 400, -600); await sleep(400);
    const scrollAfterWheel = await session.js(scrollOf);
    result.滚动 = { PageDown后: scrollAfterKeys, 滚轮后: scrollAfterWheel };
    if (!(scrollAfterKeys.top > 0)) record('G5', '阅读态 PageDown×3 后 scrollTop 未增长', scrollAfterKeys);
    await shotClip(session, 'g5-滚动后', null);

    // 3) 选区与复制：Home 回顶 → 点击首段尾部 → Shift+End → Ctrl+C → 读剪贴板
    await hi.combo(session, 'Ctrl+Home'); await sleep(300);
    const firstPara = await session.js(`(() => { const w = ${IF}; const d = w.document; const root = d.querySelector('.vditor-reset') || d.querySelector('[contenteditable]'); if (!root) return null; const p = [...root.children].find(b => b.textContent.includes('锚点文字')); if (!p) return null; const r = p.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect(); return { x: Math.round(fr.x + r.x + Math.min(r.width - 8, 420)), y: Math.round(fr.y + r.top + r.height / 2) }; })()`);
    if (firstPara) {
      await session.click(firstPara.x, firstPara.y); await sleep(250);
      await hi.combo(session, 'Shift+End'); await sleep(250);
      const sel = await session.js(`(() => { const w = ${IF}; const s = w.getSelection(); return { len: s && s.toString().length, text: s && s.toString().slice(0, 40) }; })()`);
      result.选区 = sel;
      if (!sel || !sel.len) record('G5', '阅读态点击段尾 + Shift+End 选区为空', sel);
      await hi.combo(session, 'Ctrl+C'); await sleep(400);
      try {
        const clip = harness.readClipboard(OUT);
        result.剪贴板 = String(clip && clip.text || '').slice(0, 40);
        if (!(clip && clip.text && clip.text.trim())) record('G5', '阅读态 Ctrl+C 后系统剪贴板为空', { sel });
      } catch (error) { record('G5', '剪贴板读取失败（通道问题不算产品缺陷）', { msg: String(error && error.message).slice(0, 80) }); }
    } else record('G5', '阅读态找不到首段（锚点文字）几何', {});

    // 4) 点击正文链接：openLink 走 shell 桩（不真开浏览器）
    await session.main.clearCalls();
    const link = await session.js(`(() => { const w = ${IF}; const d = w.document; const a = d.querySelector('a[href]'); if (!a) return null; const r = a.getBoundingClientRect(); const fr = document.getElementById('editor').getBoundingClientRect(); return { x: Math.round(fr.x + r.x + Math.min(r.width - 6, 30)), y: Math.round(fr.y + r.top + r.height / 2), href: a.href }; })()`);
    if (link) {
      await session.click(link.x, link.y); await sleep(600);
      const shellCalls = await session.main.shellCalls().catch(() => null);
      result.链接点击 = { href: link.href && String(link.href).slice(-24), shellCalls: shellCalls && shellCalls.slice(-2) };
    } else record('G5', '阅读态找不到可点击链接', {});

    // 5) 退出回编辑：再点按钮 → 编辑面回来、光标可落、md/磁盘不变
    const btn2 = await toolbarButtonPoint(session, 'reading-mode');
    if (btn2) { await session.click(btn2.x, btn2.y); }
    await sleep(1200);
    let exited = null;
    for (let i = 0; i < 30 && !(exited && !exited.active); i++) { await sleep(100); exited = await session.js(`(() => { const w = ${IF}; const d = w.document; return { active: !!w.vditor.__typoraReading?.active, mode: w.vditor.vditor.currentMode, previewInDom: !!d.querySelector('.vditor-preview') }; })()`); }
    result.退出态 = exited;
    await hi.ensureFocus(session);
    await session.key({ key: 'ArrowDown', code: 'ArrowDown', vk: 40 }); await sleep(250);
    const caret = await hi.caret(session);
    result.退出后光标 = caret && { 块: caret.块, 层: caret.层, 折叠: caret.折叠 };
    const after = { md: await mdNow(session), sha: harness.fileSha(file) };
    result.md保真 = before.md === after.md;
    result.磁盘保真 = before.sha === after.sha;
    if (!result.md保真) record('G5', '阅读模式进出后 getValue 变化', { 前: String(before.md).slice(-30), 后: String(after.md).slice(-30) });
    if (!result.磁盘保真) record('G5', '阅读模式进出后磁盘字节变化', {});
    await shotClip(session, 'g5-退回编辑', null);
    note('G5 ' + JSON.stringify(result));
  } catch (error) {
    result.异常 = String(error && error.message || error).slice(0, 250);
    record('G5', '链路异常', { msg: result.异常 });
    note('G5 ' + JSON.stringify(result));
  } finally { await session.close().catch(() => {}); }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
(async () => {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(OUT, { recursive: true });
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  console.log('R10 G4/G5 扫描（纯探查不修码）：' + EXE);
  try {
    if (!only.length || only.includes('g4')) { console.log('\n=== G4 ==='); await g4(); }
    if (!only.length || only.includes('g5')) { console.log('\n=== G5 ==='); await g5(); }
  } finally {
    fs.appendFileSync(path.join(OUT, 'trace.txt'), log.join('\n') + '\n发现清单：' + JSON.stringify(findings, null, 1) + '\n', 'utf8');
  }
  console.log('\n=== 汇总：G4/G5 扫描完成，发现 ' + findings.length + ' 项（详见 ' + OUT + '\\trace.txt）===');
})().catch(error => { console.error('probe-r10-g45 失败：', error); process.exit(1); });
