/** weird-chars 读数汇总器：把 result.json 压成"每条判据 → 通过/未通过 + 关键码点"的短表。
 *  用法：node weird-chars-summary.cjs <result.json> [--full]
 */
'use strict';
const fs = require('node:fs');
const R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const FULL = process.argv.includes('--full');
const rows = R.log || [];
const out = [];
const push = (s) => { out.push(s); console.log(s); };
const J = (x) => (typeof x === 'string' ? x : JSON.stringify(x));

push('产物：' + (R.card && R.card.exe) + '   启动次数=' + R.boots + '  外部中断=' + R.外部中断次数);
push('pageerror=' + JSON.stringify(R.errs) + '  console.error=' + JSON.stringify(R.cerrs));
push('');
const fail = [];
for (const r of rows) {
  if (r.case === 'REBOOT' || r.case === 'PRE' || r.case === 'SHOTS') { push('[' + r.case + '] ' + J(r).slice(0, 240)); continue; }
  if (r.case === 'END') {
    push('[END] 盘上==引擎:' + r.盘上文本等于引擎文档 + ' 未通过行:' + JSON.stringify(r.未通过的行) + ' 盘上有UFFFD:' + r.盘上有UFFFD + ' 字节:' + r.盘上字节数);
    if (!r.盘上文本等于引擎文档) push('      差异:' + J(r.差异));
    continue;
  }
  if (r.case === 'ctrl-channel') {
    push('[ctrl-channel] ' + r.名称 + ' 载荷=' + r.码点);
    for (const a of (r.路径 || [])) {
      push('   · ' + a.臂 + ' | 装弹回读严格相等=' + a.装弹回读严格相等 + ' 回读长=' + a.装弹回读长度 + '/' + a.期望长度 +
        ' | 头部增量=' + a.头部增量 + '/' + a.期望 + ' 增量差=' + a.增量差 +
        ' | 目标行=' + J(a.目标行文本) + ' 目标行严格等于载荷=' + a.目标行严格等于载荷 +
        ' | 定长插入=' + J(a.定长插入码点) + ' 严格=' + a.定长插入严格等于载荷 +
        ' | paste事件数=' + a.本次paste事件数 + ' 事件=' + J(a.paste事件));
      if (a.目标行严格等于载荷 !== true) fail.push('ctrl-channel/' + a.臂 + ' → 目标行 ≠ 载荷（增量差 ' + a.增量差 + '）');
      if (a.装弹回读严格相等 !== true) fail.push('ctrl-channel/' + a.臂 + ' → 装弹未自证');
    }
    continue;
  }
  if (r.case === 'A载入' || r.case === 'B上下文' || r.case === 'C无改动保存' || r.case === 'D编辑往返' || r.case === 'D撤销回来' || r.case === 'E-BOM变体' || r.case === 'FATAL') {
    push('[' + r.case + '] ' + J(r).slice(0, 900));
    continue;
  }
  if (typeof r.id !== 'string') { push('[?] ' + J(r).slice(0, 200)); continue; }
  const B = r.B输入 || {}, C = r.C保存 || {}, D = r.D左移 || {}, DR = r.D右移回 || {}, E = r.E退格 || {}, U = r.E撤销 || {}, F = r.F复制 || {}, FS = r.F选区 || {}, G = r.G粘贴 || {};
  const rtl = (r.D方向上下文 || {}).head方向 === 'RTL';
  const verdicts = {
    输入逐码点相等: B.片段严格相等 === true,
    盘上行严格相等: C.盘上行严格相等 === true,
    盘上无UFFFD: C.盘上有UFFFD === false,
    左移次数等簇数: rtl ? '（RTL：方向键按视觉方向，不作判据）' : (D.实测穿越次数 != null && D.实测穿越次数 === D.期望次数),
    左移没改文档: D.文档未变 === true,
    退格只掉末簇: E.整簇删除 === true,
    退格后可撤销: U.还原到删前 === true,
    复制回读严格相等: F.可用发次 != null,
    粘贴逐码点相等: G.可用发次 != null && (G.定长插入严格等于载荷 === true || G.目标行严格等于载荷 === true),
    粘贴目标行等于载荷: G.目标行严格等于载荷 === true,
  };
  const bad = Object.entries(verdicts).filter(([, v]) => v === false).map(([k]) => k);
  const notes = [];
  if (F.方式 === '三连击整行') notes.push('精确选段未命中（该载荷两端 coordsAtPos 退化/点映射不中）⇒ 改用真三连击选整行取证，期望文本含行尾换行');
  if (FS.命中 === false && F.方式 !== '三连击整行') { bad.push('选段未命中(探针定位)'); notes.push('复制读数不可用：选段未命中'); }
  if (F.跳过) notes.push('F跳过：' + F.跳过);
  if (r.用例错误) bad.push('用例错误:' + r.用例错误);
  const line = '[' + r.id + '] ' + r.名称 + ' | ' + (bad.length ? '✗ ' + bad.join(' / ') : '✓ 全通过');
  push(line);
  push('   码点:' + r.码点 + '  UTF16=' + r.UTF16长度 + ' UTF8=' + r.UTF8字节 + ' UAX29簇=' + r.期望簇数 + ' 实测穿越=' + D.实测穿越次数 + ' 左移轨迹=' + J((D.序列 || []).map((x) => x.相对载荷起点)) + ' 方向=' + J(r.D方向上下文));
  push('   退格:' + (E.整簇删除 ? '整簇' : (E.只掉一个码点 ? '只掉一个码点' : '其它')) + ' 删掉单元=' + E.删掉单元数 + '/期望' + E.期望删掉单元数 + ' 删后=' + J(E.删后行文本码点) + ' 期望整簇=' + J(E.期望整簇删除后码点));
  if (F.尝试 && F.尝试.length) {
    const t = F.尝试[F.尝试.length - 1];
    push('   复制(' + F.方式 + '): 期望=' + J(F.期望复制文本码点) + ' 选区=' + J(FS.选区码点) + ' 命中=' + FS.命中 + ' | 回读码点=' + J(t.回读码点) + ' 长度=' + t.回读长度 + '/' + t.期望长度 + ' 严格=' + t.回读严格相等 + ' 事件载荷严格=' + (t.copy事件 ? t.copy事件.事件载荷严格相等 : null) + ' 事件=' + J(t.copy事件));
  }
  if (G.尝试 && G.尝试.length) {
    const t = G.尝试[G.尝试.length - 1];
    push('   粘贴: 目标行=' + J(t.目标行文本) + ' 增量=' + t.头部增量 + '/' + r.UTF16长度 + ' 定长插入=' + J(t.定长插入码点) + ' 严格=' + t.定长插入严格等于载荷 + ' 事件=' + J(t.paste事件));
  }
  push('   行类名=' + J(G.行类名) + ' dir=' + J(G.行dir));
  if (notes.length) push('   注记：' + notes.join('；'));
  if (FULL) push('   RAW ' + J(r));
  if (bad.length) fail.push(r.id + ' → ' + bad.join(' / '));
  if (r['ctrl-channel'] || r.id === 'ctrl-channel') { /* noop */ }
}
push('');
push('=== 未通过的用例 ===');
push(fail.length ? fail.join('\n') : '（无）');
