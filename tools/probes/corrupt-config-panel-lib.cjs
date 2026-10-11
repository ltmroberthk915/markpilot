/** corrupt-config 族 · 共用尺子：设置面板的真实鼠标交互 + 一次 evaluate 拿全的读数
 *
 *  为什么单独一个文件（AGENTS 错-4：「同一件事不许有第二份实现」）：
 *  本族有 settings.json 与 recents.json 两支探针，都要"真实打开面板 → 真实拖动 → 真实点击"。
 *  若各抄一份，"改了 A 忘了 B"就会让两支探针量到不同的东西。这里只留一份。
 *
 *  来源：reveal / clickSel / setRange / clickToolbar / openMore / clickMoreItem / openSettings
 *  **逐字抄自已验收的 first-run-settings-probe-1.cjs**（那一族在 2026-10-10 用它跑过 6 次启动、75 条判据）；
 *  READ_ALL 的结构沿用它的口径，并按**本产物**的侦察读数
 *  （corrupt-config-recon.cjs：11 滑杆 / 2 复选 / 7 单选 / 4 按钮）改断言，
 *  不引用别族报告里的旧结构（AGENTS 错-3：结论要带时间范围，不许把历史结论当现状）。
 */
'use strict';

const SEL = {
  more: '.mp-tb-item[data-mp-id="more"]',
  outlineBtn: '.mp-tb-item[data-mp-id="outline"]',
  dlg: '.mp-dlg',
  dlgClose: '.mp-dlg .close',
  reset: '.mp-dlg button[data-act="reset"]',
  keysBtn: '.mp-dlg button[data-act="keys"]',
  restoreLast: '#mp-restore-last',
  statusbar: '#mp-pref-statusbar',
  sv: (k, i) => `input.mp-rng[data-s="${k}"][data-i="${i}"]`,
  pv: (p) => `input.mp-rng[data-p="${p}"]`,
  radio: (n, v) => `input[name="${n}"][value="${v}"]`,
};

/** 把目标滚进对话框可视区（**真实滚轮**；设置面板比窗口高，半数组件在卷动区外） */
async function reveal(page, sel, maxSteps = 30) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < maxSteps; i++) {
    const st = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return { ok: false };
      const dlg = document.querySelector('.mp-dlg');
      const r = el.getBoundingClientRect();
      const inside = !!(dlg && dlg.contains(el));
      const d = dlg && inside ? dlg.getBoundingClientRect() : null;
      const inVp = r.top >= 6 && r.bottom <= innerHeight - 6;
      const inDlg = !d || (r.top >= d.top - 1 && r.bottom <= d.bottom + 1);
      return { ok: true, visible: inVp && inDlg, r: { x: r.x, y: r.y, w: r.width, h: r.height }, d: d ? { x: d.x, y: d.y, w: d.width, h: d.height } : null };
    }, sel);
    if (!st.ok) return { ok: false, reason: 'missing:' + sel };
    if (st.visible) return st;
    const cx = st.d ? st.d.x + st.d.w / 2 : 600, cy = st.d ? st.d.y + st.d.h / 2 : 360;
    await page.mouse.move(cx, cy);
    const want = st.r.y - (st.d ? st.d.y + st.d.h / 2 : 360);
    await page.mouse.wheel(0, Math.max(-240, Math.min(240, Math.round(want))));
    await sleep(130);
  }
  return { ok: false, reason: 'unrevealed:' + sel };
}
async function clickSel(page, sel, { settle = 200 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rv = await reveal(page, sel);
  if (!rv.ok) throw new Error('clickSel reveal 失败 ' + sel + ' ' + JSON.stringify(rv));
  const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
  await page.mouse.move(r.x, r.y); await sleep(60);
  await page.mouse.down(); await sleep(45); await page.mouse.up();
  await sleep(settle);
  return r;
}
/** 真实拖动到目标比例；拖不到（没抓住滑块）退化为**真实点击轨道**，如实记通道 */
async function setRange(page, sel, frac) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rv = await reveal(page, sel);
  if (!rv.ok) throw new Error('setRange reveal 失败 ' + sel + ' ' + JSON.stringify(rv));
  const g = await page.evaluate((s) => { const el = document.querySelector(s); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, min: Number(el.min), max: Number(el.max), value: Number(el.value) }; }, sel);
  const cy = g.y + g.h / 2;
  const xAt = (v) => g.x + 8 + ((v - g.min) / (g.max - g.min)) * (g.w - 16);
  const targetX = g.x + 8 + frac * (g.w - 16);
  const thumbX = xAt(g.value);
  await page.mouse.move(thumbX, cy); await sleep(60);
  await page.mouse.down(); await sleep(60);
  for (let i = 1; i <= 10; i++) { await page.mouse.move(thumbX + (targetX - thumbX) * i / 10, cy); await sleep(16); }
  await page.mouse.up(); await sleep(150);
  let v1 = await page.evaluate((s) => Number(document.querySelector(s).value), sel);
  if (v1 !== g.value) return { channel: 'drag', from: g.value, to: v1 };
  await page.mouse.move(targetX, cy); await sleep(60);
  await page.mouse.down(); await sleep(45); await page.mouse.up(); await sleep(170);
  v1 = await page.evaluate((s) => Number(document.querySelector(s).value), sel);
  return { channel: 'drag-miss->click', from: g.value, to: v1 };
}
/** 真实点击工具栏按钮（mousedown 触发） */
async function clickToolbar(page, sel, settle = 420) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rv = await reveal(page, sel);
  if (!rv.ok) throw new Error('clickToolbar 找不到 ' + sel);
  const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
  await page.mouse.move(r.x, r.y); await sleep(60);
  await page.mouse.down(); await sleep(45); await page.mouse.up();
  await sleep(settle);
  return r;
}
async function openMore(page) {
  await clickToolbar(page, SEL.more, 420);
  return page.evaluate(() => {
    const p = document.querySelector('.mp-pop:not(.mp-pop-menu)');
    if (!p) return null;
    const pr = p.getBoundingClientRect();
    return { rect: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, inView: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
      items: [...p.querySelectorAll('.mp-pop-item')].map((d) => { const r = d.getBoundingClientRect(); return { text: (d.textContent || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }) };
  });
}
async function clickMoreItem(page, text) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pop = await openMore(page);
  if (!pop) throw new Error('更多菜单没打开');
  const it = pop.items.find((x) => x.text === text || x.text.startsWith(text));
  if (!it) throw new Error(`更多菜单里没有「${text}」：` + JSON.stringify(pop.items.map((x) => x.text)));
  await page.mouse.move(it.x, it.y); await sleep(70);
  await page.mouse.down(); await sleep(45); await page.mouse.up();
  await sleep(500);
  return { pop, clicked: it.text };
}
async function openSettings(page) {
  const r = await clickMoreItem(page, '设置');
  await page.waitForSelector('.mp-dlg', { timeout: 5000 }).catch(() => { });
  return r;
}
async function closeSettings(page) { if (await page.$('.mp-dlg')) await clickSel(page, SEL.dlgClose, { settle: 220 }); }

/* ══ 一次 evaluate 拿全（禁止跨调用拼装：AGENTS 错-7①）══════════════════════════ */
const READ_ALL = async () => {
  const out = { ok: false };
  try {
    const v = window.mpEngine && window.mpEngine._view && window.mpEngine._view();
    const root = document.documentElement;
    const cs = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el) : null; };
    const rect = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
    const vars = {}; for (const k of ['--mp-page-width', '--mp-zoom', '--mp-island-scale', '--mp-surface-alpha', '--mp-surface-blur', '--mp-float-alpha', '--mp-outline-alpha', '--mp-table-bar-alpha', '--mp-context-menu-alpha']) vars[k] = root.style.getPropertyValue(k);
    const dlg = document.querySelector('.mp-dlg');
    const d = dlg ? (() => {
      const qa = (s) => [...dlg.querySelectorAll(s)];
      return {
        title: (dlg.querySelector('h3') || {}).textContent, scrollTop: Math.round(dlg.scrollTop), scrollH: dlg.scrollHeight, clientH: dlg.clientHeight,
        ranges: qa('input.mp-rng').map((el) => ({ s: el.dataset.s || null, i: el.dataset.i || null, p: el.dataset.p || null, min: el.min, max: el.max, value: el.value, num: (el.parentElement.querySelector('.mp-num') || {}).textContent })),
        checks: qa('input[type=checkbox]').map((el) => ({ id: el.id, checked: el.checked })),
        radios: qa('input[type=radio]').map((el) => ({ name: el.name, value: el.value, checked: el.checked })),
        buttons: qa('button').map((el) => ({ id: el.id, act: el.dataset.act || '', text: (el.textContent || '').trim(), disabled: !!el.disabled })),
        nums: qa('.mp-num').map((el) => ({ key: el.dataset.n || el.dataset.pn, tag: el.tagName, text: el.textContent })),
      };
    })() : null;
    const theme = await window.mpHost.themeGet();
    const rl = await window.mpHost.settingGet('restoreLast');
    const info = await window.mpHost.info();
    out.ok = !!v;
    out.engineView = !!v;
    out.docLen = v ? v.state.doc.length : -1;
    out.docHead = v ? v.state.doc.toString().slice(0, 60) : null;
    out.hasFocus = document.hasFocus();
    out.active = document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null;
    out.viewport = { innerW: innerWidth, innerH: innerHeight, outerW: outerWidth, outerH: outerHeight, cw: root.clientWidth };
    /* 窗口尺寸的第二把尺子：screen/dpr。本机 DPR=1.75、可用高 775 ⇒ 默认 1180×820 的**高**会被屏幕钳到 775，
       所以"回退默认"的判据只能拿**宽**当硬指标（宽度不被钳），并把钳制事实一起记下来（错-3：尺子要写清楚）。 */
    out.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: devicePixelRatio };
    out.rendered = { cmEditor: !!document.querySelector('.cm-editor'), cmLines: document.querySelectorAll('.cm-line').length, editorRect: rect('.cm-editor'), contentW: (rect('.cm-content') || {}).w ?? null, bodyBg: cs('body') && cs('body').backgroundColor, statusbar: (cs('.mp-statusbar') || {}).display || null };
    out.title = document.title;
    out.theme = theme;                 /* 壳层算好的结果（mode/dark）——错-15：不自己推断主题 */
    out.restoreLast = rl && rl.value;
    out.appInfo = info && { name: info.name, version: info.version };
    out.ls = ls; out.vars = vars; out.dlg = d;
    out.toast = (() => { const t = document.querySelector('.mp-toast'); return t && getComputedStyle(t).display !== 'none' ? (t.textContent || '').slice(0, 120) : null; })();
  } catch (e) { out.err = String((e && e.message) || e); }
  return out;
};

/** 面板自证：期望值来自**本产物**的侦察读数，不是别族的旧报告 */
function assertPanelAlive(st, where) {
  if (!st || !st.ok) throw new Error(`${where}: READ_ALL 失败 ${st && st.err}`);
  if (!st.dlg) throw new Error(`${where}: 设置面板不在（.mp-dlg 缺失）⇒ 读数会全体落空`);
  if (st.dlg.title !== '设置') throw new Error(`${where}: 面板标题不是「设置」：${st.dlg.title}`);
  if (st.dlg.ranges.length !== 11) throw new Error(`${where}: 期望 11 条滑杆，实得 ${st.dlg.ranges.length}`);
  if (st.dlg.checks.length !== 2) throw new Error(`${where}: 期望 2 个复选框，实得 ${st.dlg.checks.length}`);
  return true;
}

/** 标准"面板仍可用"取证：真实打开 → 真实拖页面宽度 → 真实点「打开上次的文件」。
 *  返回逐项读数；任一环节失败都如实记 error，不吞。
 *
 *  【本轮踩到的坑·写进尺子】拖动目标用"比例"给，若滑杆**已经在那个比例上**，真实拖动不会改变值，
 *  于是"值没变"被误判成"面板不好使"（A7b 复用 A7 的 profile，pageWidth 存的是 67 = 0.45 档 ⇒ 正好撞上）。
 *  现在按 fracs 依次试，直到读到一个**真的变了**的值；试了几次都记在 dragAttempts 里。 */
async function drillPanel(page, { fracs = [0.45, 0.62, 0.30, 0.80] } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const drill = { open: null, opened: false, dragAttempts: [] };
  try {
    drill.open = await openSettings(page);
    drill.opened = true;
    const st1 = await page.evaluate(READ_ALL);
    assertPanelAlive(st1, '打开面板');
    drill.panel = { title: st1.dlg.title, ranges: st1.dlg.ranges.length, checks: st1.dlg.checks.map((c) => c.id + '=' + c.checked), radios: st1.dlg.radios.length, buttons: st1.dlg.buttons.map((b) => b.text), scrollH: st1.dlg.scrollH, clientH: st1.dlg.clientH };
    drill.pageWidthBefore = st1.dlg.ranges.find((r) => r.p === 'pageWidth');
    drill.varBefore = st1.vars['--mp-page-width'];
    drill.restoreLastBefore = { api: st1.restoreLast, checkbox: (st1.dlg.checks.find((c) => c.id === 'mp-restore-last') || {}).checked };
    const before0 = Number(drill.pageWidthBefore.value);
    let st2 = null, row = null;
    for (const f of fracs) {
      const run = await setRange(page, SEL.pv('pageWidth'), f);
      await sleep(180);
      const stA = await page.evaluate(READ_ALL);
      assertPanelAlive(stA, '拖动后');
      const rowA = stA.dlg.ranges.find((r) => r.p === 'pageWidth');
      drill.dragAttempts.push({ frac: f, channel: run.channel, from: run.from, to: run.to, value: rowA.value });
      if (Number(rowA.value) !== before0) { drill.drag = run; st2 = stA; row = rowA; break; }
    }
    if (!st2) { drill.drag = { failed: '所有 fracs 都没让值变化', attempts: drill.dragAttempts }; throw new Error('页面宽度滑杆拖不动（值一直是 ' + before0 + '）'); }
    drill.dragReadback = { value: row.value, label: row.num, cssVar: st2.vars['--mp-page-width'], contentW: st2.rendered.contentW, ls: st2.ls['mp-pref-pageWidth'] ?? null };
    drill.dragOk = Number(row.value) !== before0;
    /* 【尺子口径·2026-10-10 本轮修正】pageWidth 的 :root 变量**不是**百分数而是 px：
     *  引擎把 "N%" 算成 min(round(客户区宽 × N/100), 1240) 写进 `--mp-page-width`。
     *  证据：诊断两次独立启动 1167×0.74=864px、889×0.74=658px 都与读数逐位相同。
     *  所以判"消费者生效"要比**引擎算出来的那个 px**，不能拿 '67%' 去比 '596px'（那是探针自己的错，
     *  第一版就把它读成了"拖动无效"）。 */
    drill.dragExpectedPx = Math.min(Math.round((st2.viewport.cw || 0) * Number(row.value) / 100), 1240);
    drill.dragOkCross = drill.dragOk === true
      && row.num === row.value + '%'
      && Number(st2.ls['mp-pref-pageWidth']) === Number(row.value)
      && Math.abs(parseFloat(st2.vars['--mp-page-width']) - drill.dragExpectedPx) <= 2
      && Math.abs((st2.rendered.contentW || 0) - drill.dragExpectedPx) <= 2;
    await clickSel(page, SEL.restoreLast, { settle: 320 });
    await sleep(320);
    const st3 = await page.evaluate(READ_ALL);
    assertPanelAlive(st3, '点复选框后');
    drill.toggle = { checkbox: (st3.dlg.checks.find((c) => c.id === 'mp-restore-last') || {}).checked, api: st3.restoreLast, toast: st3.toast };
    drill.panelAfter = { ranges: st3.dlg.ranges.length, checks: st3.dlg.checks.map((c) => c.id + '=' + c.checked) };
    drill.after = st3;
  } catch (e) { drill.error = String((e && e.message) || e).slice(0, 300); }
  return drill;
}

module.exports = { SEL, reveal, clickSel, setRange, clickToolbar, openMore, clickMoreItem, openSettings, closeSettings, READ_ALL, assertPanelAlive, drillPanel };
