/** 探针1 结构重排 + 变量提升（幂等脚本；锚点唯一且先断言）
 *  ① page/browser/ctx 提升到模块作用域（ensurePage 在模块作用域里要用）
 *  ② 把「菜单2 打开…（原生框）」整块搬到「菜单5 保存」之后、「菜单6 另存为」之前
 *     —— 实测关掉原生框之后渲染侧会变成 closed，必须先做完所有纯渲染读数再动原生框
 *  ③ ready 行等待改成"日志字节数稳定"口径（原来固定 20×300ms 会撞上主进程还没写完）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, 'startup-and-menus-probe-1.cjs');
let s = fs.readFileSync(F, 'utf8');
const must = (needle, n = 1) => {
  const c = s.split(needle).length - 1;
  if (c !== n) { console.error(`✗ 锚点命中数不符：期望 ${n} 实际 ${c}\n  ${needle.slice(0, 90)}`); process.exit(1); }
  return true;
};

/* ① 变量提升 */
must('let MAIN_PID = null;');
s = s.replace('let MAIN_PID = null;', 'let MAIN_PID = null;\nlet page = null, browser = null, ctx = null;   // 模块作用域：ensurePage 要能换掉页对象');
must('let page = null, browser = null, ctx = null;');
must('  let { browser, ctx, page } = await L.connect(app);');
s = s.replace('  let { browser, ctx, page } = await L.connect(app);', '  ({ browser, ctx, page } = await L.connect(app));');

/* ③ ready 行等待：改成"日志大小连续两轮不变"再取 */
must(`  let ready0 = '';
  for (let i = 0; i < 20 && !/"ready"/.test(ready0); i++) {
    ready0 = (L.logAll(app).split(/\\r?\\n/).find((l) => l.includes('"ready"')) || '');
    if (!ready0) await sleep(300);
  }`);
s = s.replace(`  let ready0 = '';
  for (let i = 0; i < 20 && !/"ready"/.test(ready0); i++) {
    ready0 = (L.logAll(app).split(/\\r?\\n/).find((l) => l.includes('"ready"')) || '');
    if (!ready0) await sleep(300);
  }`, `  /* 主进程用 appendFileSync 逐行追加，探针读的是同一个文件 ⇒ 必须等"字节数连续两轮不变"再取，
     否则会撞上"ready 行还没落盘"的窗口（本轮实测：同一份日志一次读得到、一次读不到）。 */
  let ready0 = '', lastSz = -1;
  for (let i = 0; i < 40; i++) {
    const sz = L.logSize(app);
    ready0 = (L.logAll(app).split(/\\r?\\n/).find((l) => l.includes('"ready"')) || '');
    if (ready0 && sz === lastSz) break;
    lastSz = sz;
    await sleep(300);
  }`);

/* ② 抽走「菜单2 打开」整块 */
const startTag = '  /* ══ 菜单2 打开…（Ctrl+O，即该菜单项自己的加速键）⇒ 原生"打开 Markdown"框 ══';
const endTag = '  /* ══ 菜单3 最近打开';
const i0 = s.indexOf(startTag), i1 = s.indexOf(endTag);
if (i0 < 0 || i1 < 0 || i1 < i0) { console.error('✗ 取块失败'); process.exit(1); }
const block = s.slice(i0, i1);
s = s.slice(0, i0) + s.slice(i1);

/* 插到「菜单6 另存为」之前 */
const anchor6 = '  /* ══ 菜单6 另存为（真点击菜单项 click）⇒ 真原生框（本实例没设 MP_TEST_SAVE_AS）══';
must(anchor6);
s = s.replace(anchor6, block + anchor6.replace('菜单6', '菜单6') /* 原样 */);

/* 追加一句"为什么放这里"的说明到搬过来的块首 */
s = s.replace(startTag, startTag.replace('  /* ══ ', '  /* ══ 【位置说明】本块放在最后：关掉原生框之后渲染侧会变成 closed（实测），'
  + '所以所有纯渲染读数（菜单0/最近打开/保存）必须先做完。\n     菜单2 打开…（Ctrl+O，即该菜单项自己的加速键）⇒ 原生"打开 Markdown"框 ══ '));

fs.writeFileSync(F, s, 'utf8');
console.log('✓ 重排完成');
