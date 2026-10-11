/** 诊断日志的写入开销：几千条重复警告不许把进程拖住，也不许把日志撑爆。
 *
 *  为什么单独立一条测试（2026-09-17 实测的教训）：公式里的 CJK 会让 KaTeX 一条一条地报
 *  `unicodeTextInMathMode`（受保护素材 295 条公式报了成千上万条），每一条都经
 *  `console-message` 进来。旧实现每行 `statSync` + `appendFileSync`，几千条 = 几万次同步
 *  FS —— **主进程被淹掉，整个应用连调试端口一起几十秒不答**：打包版打不开大素材就是这么红的
 *  （`probe-target-timeline.cjs` 的时间线：t=1.0s 文档已载入、t=2.5s 起调试端口全超时），
 *  而 2.1.29（没有这套日志）同一份素材 1 秒渲染完。
 *
 *  这条测试是**回归闸门**：既断言行为（重复折叠计数、不同消息各留一条），
 *  也断言开销（几千条要在很短时间里处理完）。诊断设施本身绝不能成为产品的性能问题。
 *
 *  用法：node scripts/diagnostics.test.cjs
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('../app/main/diagnostics.js');

const dir = path.join(os.tmpdir(), 'markpilot-diagnostics-test-' + process.pid);
fs.rmSync(dir, {recursive: true, force: true});
fs.mkdirSync(dir, {recursive: true});

let pass = 0, fail = 0;
const check = (label, ok, evidence) => {
  if (ok) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('✗FAIL ' + label + '  → ' + evidence); }
};

(async () => {

// 安装前先把真实的 warn/error 静音：模块会把消息透传给它捕获到的"原始 console"，
// 而这里要打 5000 条，不该把测试输出淹掉（被测的是**日志侧**的行为与开销）。
const quiet = () => {};
console.warn = quiet;
console.error = quiet;
diagnostics.install({userData: dir});
const file = diagnostics.file();
check('日志文件落在 userData/logs 下', !!file && file.includes('logs'), String(file));

// ── ① 几千条**同一条**警告：必须被折叠成一条（带计数），且很快处理完 ──────────────
const started = Date.now();
for (let i = 0; i < 5000; i++) console.warn('LaTeX-incompatible input and strict mode is set to \'warn\': Unicode text character "甲" used in math mode [unicodeTextInMathMode]');
const elapsed = Date.now() - started;
check('5000 条相同警告的处理耗时 < 500ms（旧实现是每行 4 次同步 FS，这里正是被它拖死的）',
  elapsed < 500, `实际 ${elapsed}ms`);

// ── ② 不同消息各自留一条 ────────────────────────────────────────────────────
console.warn('第一条不同的消息');
console.error(new Error('第二条不同的消息'));
console.warn('重复的甲');
console.warn('重复的甲');
console.warn('重复的甲');

// 攒批是 400ms 一轮；等足够久再读盘。**必须让出事件循环**——落盘走的是定时器，
// 用 Atomics.wait 同步阻塞轮询会把定时器饿死，读到的永远是空文件（这条测试第一版就栽在这）。
const waitFor = async (predicate, timeout = 3000) => {
  const stop = Date.now() + timeout;
  let text = '';
  while (Date.now() < stop) {
    await new Promise(resolve => setTimeout(resolve, 60));
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (predicate(text)) return text;
  }
  return text;
};
const text = await waitFor(value => value.includes('重复的甲'));
const lines = text.split('\n').filter(Boolean);

check('日志里有"启动"一行', /diagnostics start/.test(text), text.slice(0, 200));
check('5000 条相同警告折叠成一条并带计数（不是 5000 行）',
  (text.match(/unicodeTextInMathMode/g) || []).length === 1 && /同样的消息重复 5000 次/.test(text),
  JSON.stringify({命中次数: (text.match(/unicodeTextInMathMode/g) || []).length, 尾部: lines.slice(-4)}));
check('不同的消息各自留一条（第一条不同的消息 / 第二条不同的消息 都在）',
  text.includes('第一条不同的消息') && text.includes('第二条不同的消息'), JSON.stringify(lines.slice(-4)));
check('连着重复三条的会合并计数', /重复的甲（同样的消息重复 3 次）/.test(text), JSON.stringify(lines.slice(-3)));
// 只数"日志行"（以时间戳开头的那些）；Error 的 stack 会跟着占几行，那是应有内容
const logLines = lines.filter(value => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[/.test(value));
check('日志行数远小于消息条数（5000+ 条压到十条以内）', logLines.length < 10,
  `日志行 ${logLines.length} / 含 stack 共 ${lines.length} 行`);

const size = fs.statSync(file).size;
check('日志体积没有失控（5000 条相同消息不许撑出一份大日志）', size < 8000, `${size} 字节`);
check('日志是 UTF-8 可读文本（中文没乱码）', text.includes('重复的甲') && !text.includes('\uFFFD'), String(size));

fs.rmSync(dir, {recursive: true, force: true});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
})();
