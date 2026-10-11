/** 探针 · 含内嵌 base64 图片的真实文档：**打开 → 保存必须逐字节不变**。
 *
 *  背景（用户报告"图片变成超长代码"）：这份文件里 6 张图是内嵌 base64 data URI（每张约 78 KB，
 *  各占一整行）。编辑区里它们被 portable-images 掩码成短缓存 URL，所以"编辑区文本 ≠ 磁盘文本"——
 *  这一支就是钉住**保存路径把掩码原样展开回磁盘的原始字节**（含 base64 一个字符不动）。
 *
 *  用法：node scripts/acceptance/probe-img-base64-fidelity.cjs [--app=dev|installed]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = require('./harness.cjs');
const hi = require('../human-input/hi.cjs');

const OUT = path.join(harness.project, '.perf/repro-img-base64');
const ARG = (name, dflt) => { const hit = process.argv.slice(2).find(i => i.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt; };
const APP = ARG('app', 'dev');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const 原件 = 'E:/temp1/新建 Markdown 文档.md';
  const file = path.join(OUT, 'fidelity-copy.md');
  fs.copyFileSync(原件, file);
  const 前 = { sha: sha(file), 字节: fs.statSync(file).size };
  const exe = APP === 'dev' ? path.join(harness.project, 'node_modules/electron/dist/electron.exe')
    : APP === 'installed' ? 'D:/Users/ltmroberthk/AppData/Local/Programs/MarkPilot/MarkPilot.exe' : APP;
  const ctx = {
    launch: options => harness.launch({ exe, appArgs: APP === 'dev' ? [path.join(harness.project, 'app/main/main.js')] : [],
      label: 'probe-img-fidelity', outDir: OUT, timeout: 300000, ...options, args: options.args || [] }),
    release: async session => { await session.close(); },
  };
  const session = await hi.openDoc(ctx, file, { minBlocks: 8, settleMs: 2500 });
  const log = [];
  const say = line => { console.log(line); log.push(line); };
  try {
    await hi.ensureFocus(session);
    const saved = await hi.edge.saveAndWait(session, file, { timeout: 15000 });
    const 后 = { sha: sha(file), 字节: fs.statSync(file).size };
    say(`打开前：${前.字节} 字节  sha256=${前.sha}`);
    say(`保存后：${后.字节} 字节  sha256=${后.sha}`);
    say(`逐字节相同：${前.sha === 后.sha ? '是 ✓' : '否 ✗'}`);
    // 掩码回归：编辑区文本里应当**没有**原始 base64
    const 编辑区 = await session.js(`(() => { const w = ${hi.IF}, d = w.document; const s = d.querySelector('${hi.SURFACE}');
      const t = String(s.textContent || '');
      return { 含base64: /data:image\\//i.test(t), 含缓存URL: /vscode-resource\\.vscode-cdn\\.net/i.test(t), 文本长: t.length }; })()`);
    say(`编辑区文本：长 ${编辑区.文本长}，含原始 base64=${编辑区.含base64}，含短缓存 URL=${编辑区.含缓存URL}`);
  } finally {
    fs.writeFileSync(path.join(OUT, 'fidelity.txt'), log.join('\n'), 'utf8');
    await ctx.release(session);
  }
  console.log('（结果：' + path.join(OUT, 'fidelity.txt') + '）');
})().catch(error => { console.error('探针异常：', error); process.exit(1); });
