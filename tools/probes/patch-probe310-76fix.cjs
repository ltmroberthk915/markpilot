/** 补丁 14（Lead 2026-10-09 指示）：
 *  ① 修 `codeExportNoNumbers` 的 `r is not defined`（把 7.1 快照提到外层变量 snap7）；
 *  ② **改 §7.6 判据**：原生文件选择器 = "**本进程**新增顶层窗口 + 类名 `#32770`"，采样 ≥3 次、以落定后裸 Win32 枚举为准；
 *     并把按钮自身状态（disabled / is-todo / title）读出来 —— 禁用占位 ⇒ 判"入口无行为（能力缺入口）"。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
let n = 0;

/* ① snap7 提到外层 */
if (!t.includes('let snap7 = null;')) {
  const anchor = "    if (!res7.ok) {";
  if (t.includes(anchor)) { t = t.replace(anchor, "    let snap7 = null;   /* 7.1 的同快照读数（导出检查要用，别再二次读盘/二次读 DOM） */\n" + anchor); n++; }
}
if (t.includes('let r = await read7();') && !t.includes('snap7 = r;')) {
  t = t.replace('let r = await read7();', 'let r = await read7();\n    snap7 = r;');
  const loopTail = "      await sleep(400); r = await read7();\n    }";
  if (t.includes(loopTail)) { t = t.replace(loopTail, "      await sleep(400); r = await read7(); snap7 = r;\n    }"); n++; }
}
if (t.includes("const md4 = (typeof r.block1Text === 'string' && r.block1Text) ? r.block1Text : null;")) {
  t = t.replace("const md4 = (typeof r.block1Text === 'string' && r.block1Text) ? r.block1Text : null;",
    "const md4 = (snap7 && typeof snap7.block1Text === 'string' && snap7.block1Text) ? snap7.block1Text : null;");
  n++;
}

/* ② §7.6 判据改写 */
const old76 = /      \/\* 同产物 A\/B 实测"时通时不通"[\s\S]*?attempts\.push\(fresh\.length\);[\s\S]*?\n      \}/;
if (old76.test(t)) {
  const neu76 = `      /* Lead 2026-10-09 固化判据：原生文件选择器 = **本进程**新增顶层窗口 + 类名 \`#32770\`；
         采样 ≥3 次、以落定后的裸 Win32 枚举为准。**不用**标题字符串、**不用**全桌面窗口数差（会被别的进程干扰）。 */
      const btnState = await ev(([id]) => {
        const b = document.querySelector('.mp-toolbar .mp-tb-item[data-mp-id="' + id + '"]') || [...document.querySelectorAll('.mp-toolbar .mp-tb-item')].find((x) => /upload|图片/.test((x.getAttribute('data-mp-id') || '') + (x.title || '')));
        return b ? { id: b.getAttribute('data-mp-id'), disabled: !!b.disabled, cls: String(b.className), title: (b.title || '').slice(0, 80), aria: b.getAttribute('aria-disabled') } : null;
      }, ['upload']);
      const procNew = [];
      let dlg = null, winsIn = [];
      for (let k = 0; k < 3 && !dlg; k++) {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(2200);
        winsIn = listWindows().filter((w) => !w.err);
        const added = winsIn.filter((w) => !winsBefore.includes(w.hwnd));
        procNew.push(added.length);
        dlg = added.find((w) => /^#32770$/.test(w.cls)) || null;
        if (!dlg) { await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); }
      }
      const fresh = dlg ? [dlg] : [];`;
  t = t.replace(old76, neu76);
  n++;
}
/* 7.6 判定文本：带上按钮状态与"本进程"口径 */
t = t.replace("`点了「${btn.id || btn.title}」后：重试记录=${JSON.stringify(attempts)}；最后一次全桌面新出现窗口 ${fresh.length} 个",
  "`按钮状态=${JSON.stringify(btnState)}｜本进程可见顶层窗口 ${winsBefore.length}→${winsIn.length}；3 次采样新增数=${JSON.stringify(procNew)}；命中 #32770 的=${dlg ? 'hwnd ' + dlg.hwnd : '无'}");
/* 判定：按钮是禁用占位 ⇒ 入口无行为（红，归 task-3 的 C2）；按钮可用 ⇒ 必须有 #32770 */
t = t.replace("judge('7.6', 'imageButtonOnlyDialog', !!dlg,", "judge('7.6', 'imageButtonOnlyDialog', btnState && btnState.disabled ? false : !!dlg,");
t = t.replace("（对话框还开着时内容本就该不变；关掉后复测）", "（按钮为禁用占位时本条只说明「点了没动作」；关掉对话框后复测）");

fs.writeFileSync(p, t, 'utf8');
console.log(`✓ 应用了 ${n} 处补丁`);
