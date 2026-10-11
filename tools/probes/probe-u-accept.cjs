/** 下划线投影·最终验收（重写版：修掉上一版探针的三处自伤）
 *  · 自伤① 量"节点宽"时读的是 parentElement（文本节点的父级就是整行 ⇒ 恒 822）✗
 *    ⇒ 改成用 Range 逐字量"首字左缘 → 末字右缘" ✓；
 *  · 自伤② 幻影判据"节点宽 − 推进和"对 CJK 天然差 7~14px（字形盒宽于步进）✗ ⇒ 不用它当判据 ✓，
 *    改用**跨节点接缝**（前段末字右缘 → 后段首字左缘，>1px 才是凭空空隙 ✓）；
 *  · 自伤③ "零宽元素"把 CM6 自带的空 `span[contenteditable=false]`（正常结构）算成污染 ✗
 *    ⇒ 只数**我关心的残留**（含 `<`/`u`/`>` 字面或宽度>0 的空元素 ✓）。
 *  用法：node probe-u-accept.cjs "<exe>"
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
/* 【路径自适应·2026-10-11】先前这里写死了本机绝对路径 ✗ ⇒ 被"可移植性判据"拦在公开清单之外 ✗
   （判据本身是对的 ✓，但结果是我最新这支探针进不了 `tools/probes/` ✗）。改成：
   · Playwright：按 **环境变量 → 常见安装位置** 依次找 ✓（任何一处命中即可 ✓）；
   · 被测产物：命令行给，或按**本文件相对位置**上溯到仓库根 ✓；
   · 运行目录：落在系统临时目录 ✓（不污染仓库、也不写死路径 ✓）。 */
const os = require('node:os');
function resolvePlaywright() {
  const cands = [
    process.env.MP_PLAYWRIGHT,                                   // 显式指定优先 ✓
    path.join(__dirname, 'node_modules', 'playwright-core'),
    'C:/Windows/System32/node_modules/playwright-core',          // 本机既有位置（可改 ✓）
    path.join(os.homedir(), 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const c of cands) { try { return require(c); } catch { /* 试下一个 */ } }
  console.error('✗ 找不到 playwright-core。装一个，或设 MP_PLAYWRIGHT=<路径>：npm i -D playwright-core');
  process.exit(3);
}
const { chromium } = resolvePlaywright();
const __RULER = require(path.join(__dirname, '_probe-common.cjs'));
/* 仓库根：本文件在 <repo>/.mp-verify/checklist/ 下 ⇒ 上溯两级 ✓（公开快照里在 <repo>/tools/probes/ ⇒ 上溯两级同样对 ✓）。 */
const REPO = path.resolve(__dirname, '..', '..');
const EXE = process.argv[2] || path.join(REPO, 'MarkPilot-CM6', 'dist', 'win-unpacked', 'MarkPilot.exe');
const DIR = path.join(os.tmpdir(), `mp-u-accept-${process.pid}`);
const PORT = 11200 + (process.pid % 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
__RULER.rulerCard({ probe: 'probe-u-accept.cjs', exe: EXE });

/* 夹具：行首 / 行中 / 行尾 / 行内两个 / 对照行（无标签）/ 转义不生效
 * 【★ 光标必须放在**第一行**】光标落在某条标记的区间里 ⇒ 按既有契约那条**显源码** ✓（正确行为 ✓），
 * 所以夹具首行特意用一条**不含 `<u>`** 的对照行 ✓ —— 否则探针会把"契约"读成"没渲染" ✗。 */
const DOC = [
  '对照行：2020年5月1号是周几',
  '甲词2020<u>年5月1号是</u>周几（周五）',
  '<u>整行都是下划线</u>',
  '前面有字<u>下划线在尾部</u>',
  '两个<u>甲</u>和<u>乙</u>都在',
  '转义显示源码：\\<u>不该有下划线</u>',
  /* 【重字退化形态·2026-10-11 采纳调研建议】内文与标签重字（`u` 是标签里的字 ✓）——
     用"搜内文"算区间会落进开标签 ✗；用"算长度"才对 ✓。这条臂专门盯它 ✓。 */
  '重字退化：<u>u</u>与<u>/u/</u>',
  /* 【带空格标签】`<u >…</u >` 也应认（开长按"到第一个 >"算 ✓）。 */
  '带空格标签：<u >宽标签也认</u >',
  '',
].join('\n');

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(path.join(DIR, 'profile'), { recursive: true });
  const MD = path.join(DIR, 'doc.md'); fs.writeFileSync(MD, DOC, 'utf8');
  const env = { ...process.env, MP_DEBUG: '1', MP_TEST_NO_DIALOG: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [MD, `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(DIR, 'profile')}`], { env, stdio: 'ignore' });
  const kill = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };
  let browser = null, page = null;
  for (let i = 0; i < 400 && !page; i++) {
    await sleep(80);
    if (!browser) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch { } }
    if (browser) for (const p of browser.contexts()[0].pages()) {
      if (p.url().startsWith('devtools://')) continue;
      if (await p.evaluate(() => { try { return !!window.mpEngine._view(); } catch { return false; } }).catch(() => false)) { page = p; break; }
    }
  }
  const out = { 产物: __RULER.sha16(EXE) };
  if (!page) { console.log(JSON.stringify({ ...out, 错误: '引擎页没起来' })); kill(); process.exit(4); }
  await sleep(2500);
  /* 把光标放到第 1 行行首（对照行，不含标记）⇒ 后面所有带标记的行都不在选区里 ⇒ 都走投影 ✓ */
  await page.evaluate(() => { const v = window.mpEngine._view(); v.dispatch({ selection: { anchor: 0 } }); v.focus(); });
  await sleep(400);

  out.逐行 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cm-content .cm-line')];
    return rows.map((row, i) => {
      const uSpans = [...row.querySelectorAll('[data-mpu]')];
      const segs = [];
      const walk = (n) => {
        for (const ch of n.childNodes) {
          if (ch.nodeType === 3 && ch.data) {
            const rg = document.createRange();
            rg.setStart(ch, 0); rg.setEnd(ch, ch.data.length);
            const b = rg.getBoundingClientRect();
            segs.push({ t: ch.data, 左: b.left, 右: b.right });
          } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
        }
      };
      walk(row);
      const seams = [];
      for (let k = 1; k < segs.length; k++) seams.push(+(segs[k].左 - segs[k - 1].右).toFixed(2));
      return {
        行号: i + 1,
        屏幕文本: row.textContent,
        下划线数: uSpans.length,
        下划线自报区间: uSpans.map((x) => x.getAttribute('data-mpu')),
        下划线文字: uSpans.map((x) => x.textContent),
        下划线样式: uSpans.map((x) => getComputedStyle(x).textDecorationLine),
        跨节点接缝: seams,
        残留字面: /[<>]/.test(row.textContent.replace(/[（(][^）)]*[）)]/g, '')) ? (/<u>|<\/u>/.test(row.textContent) ? '含 <u>/</u>' : '含裸尖括号') : '无',
        行高: +row.getBoundingClientRect().height.toFixed(2),
      };
    });
  }).catch((e) => ({ 错误: String(e.message) }));

  const rows = Array.isArray(out.逐行) ? out.逐行 : [];
  const 应投影 = [rows[1], rows[2], rows[3], rows[4]].filter(Boolean);   // 行 2~5
  out.判据 = {
    'U1 四处标签都不在屏幕上（无 <u>/</u> 字面）': 应投影.every((r) => r && !/<u>|<\/u>/.test(r.屏幕文本)),
    'U2 四处都真的带上下划线': 应投影.every((r) => r && r.下划线数 >= 1 && r.下划线样式.every((s) => s === 'underline')),
    'U3 下划线罩住的正是内文（不含标签字符）': 应投影.every((r) => r && r.下划线文字.every((t) => t && !/[<>]/.test(t))),
    'U4 行内两处下划线都各自成立（甲/乙）': !!rows[4] && rows[4].下划线数 === 2,
    'U5 跨节点接缝无凭空空隙（≤1px）': 应投影.every((r) => r && r.跨节点接缝.every((x) => x <= 1)),
    'U6 对照行（无标签）不被误套下划线': !!rows[0] && rows[0].下划线数 === 0,
    'U7 转义行按契约显示源码（不做投影）': !!rows[5] && rows[5].下划线数 === 0 && /\\<u>/.test(rows[5].屏幕文本),
    /* 【这两条来自调研建议·2026-10-11】重字形态与带空格标签 ✓（都是"算长度"才过得了的形态 ✓）。 */
    'U8 重字退化形态正常（u 与 /u/ 各自带下划线）': !!rows[6] && rows[6].下划线数 === 2 && rows[6].下划线文字.join('|') === 'u|/u/',
    'U9 带空格标签也认（<u >…</u >）': !!rows[7] && rows[7].下划线数 === 1 && !/<u|<\/u/.test(rows[7].屏幕文本),
    /* 【行高不变·调研实测 mark+width:0 会撑高 +29% ✗】我们的做法必须**行高与对照行一致** ✓。 */
    'U10 带标记行行高 = 对照行（±0.5px）': !!rows[0] && 应投影.every((r) => r && Math.abs(r.行高 - rows[0].行高) <= 0.5),
  };
  const bad = Object.entries(out.判据).filter(([, v]) => !v).map(([k]) => k);
  /* 【判据条数由数据生成·2026-10-11】先前这里写死"7 条" ✗（加了 U8~U10 后文案就不对了 ✗）——
     改成从判据表**自己数** ✓（与 §"判据不许内嵌期望值字面量"同一纪律 ✓）。 */
  out.结论 = bad.length ? (`✗ 未过 ${bad.length} 条：` + bad.join('；')) : `全部 ${Object.keys(out.判据).length} 条通过 ✓`;
  await page.screenshot({ path: path.join(DIR, 'u-look.png'), clip: { x: 0, y: 0, width: 820, height: 190 } }).catch(() => { });
  out.截图 = path.join(DIR, 'u-look.png');
  console.log(JSON.stringify(out, null, 1));
  try { await browser.close(); } catch { }
  kill();
  process.exit(bad.length ? 8 : 0);
})();
