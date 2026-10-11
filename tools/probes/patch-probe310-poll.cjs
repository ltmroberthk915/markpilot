/** 补丁 9：清单内 7.1 读数加**轮询**（等属性应用完成），并把最终读数如实写清"DOM 里带号几条"。
 *  背景：大文档里 CM6 的分片渲染 + 装饰应用是异步的，读太早会得到"部分 null"（实测 [null,null,"2",null,null]）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
if (t.includes('let r = await read7()')) { console.log('· 已打过轮询补丁'); process.exit(0); }
const openOld = "    const r = await ev(([b1, b1e, q, qe, lb, lbe, inline]) => {";
const closeOld = "    }, [res7.block1[0], res7.block1[1], res7.quotedPair[0], res7.quotedPair[1], res7.longBlock[0], res7.longBlock[1], res7.inlineCodeLine]);";
if (!t.includes(openOld) || !t.includes(closeOld)) { console.log('✗ 没找到读数的起止行'); process.exit(1); }
t = t.replace(openOld, "    const read7 = () => ev(([b1, b1e, q, qe, lb, lbe, inline]) => {");
t = t.replace(closeOld, closeOld + `
    let r = await read7();
    /* 轮询：等到"块内内容行都带上号 + 引用块/长行块也齐"或超时（最多 ~4s），避免读到半应用的装饰 */
    for (let k = 0; k < 10; k++) {
      const cl = r.block1.filter((x) => /mp-code/.test(x.cls) && !/mp-fence/.test(x.cls));
      const qn = r.quoted.filter((x) => x.n).length, ln = r.longBlock.filter((x) => x.n).length;
      if (cl.length && cl.every((x) => x.n) && qn >= 3 && ln >= 3) break;
      await sleep(400); r = await read7();
    }`);
fs.writeFileSync(p, t, 'utf8');
console.log('✓ 已加轮询');
