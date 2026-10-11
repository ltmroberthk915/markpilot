/** 补丁 15（Lead 2026-10-09 小口径）：「更多」菜单同时给**两个数**并写明选择器
 *  - items    = `.mp-pop-item, .mp-pop-title`（直接子元素口径）
 *  - allNodes = 含嵌套的所有叶子文本节点（我原来用的口径）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = path.join(__dirname, 'probe-310.cjs');
let t = fs.readFileSync(p, 'utf8');
let n = 0;
const oldTail = `      const items = await ev(() => { const pop = document.querySelector('.mp-pop'); return pop ? [...pop.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()).map((el) => (el.textContent || '').trim()).slice(0, 120) : []; });
      if (items.length) { return { exists: true, items }; }`;
const newTail = `      const probe = await ev(() => {
        const pop = document.querySelector('.mp-pop');
        if (!pop) return { exists: false, items: [], allNodes: [], sel: '' };
        /* 两种口径都算，并写明选择器（Lead：同一事实两个数并存时必须写清各自口径） */
        const direct = [...pop.querySelectorAll(':scope > .mp-pop-item, :scope > .mp-pop-title')].map((el) => (el.textContent || '').trim()).filter(Boolean);
        const all = [...pop.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()).map((el) => (el.textContent || '').trim());
        return {
          exists: true,
          items: all.slice(0, 160),                       // 含嵌套叶子（旧口径）
          allNodes: all.slice(0, 160),
          directItems: direct.slice(0, 160),              // 直接子元素（.mp-pop-item/.mp-pop-title）
          sel: '.mp-pop-item, .mp-pop-title（:scope 直接子元素）/ 含嵌套叶子节点',
        };
      });
      if (probe.items.length || probe.directItems.length) return probe;`;
if (t.includes(oldTail)) { t = t.replace(oldTail, newTail); n++; }
/* 判定文本里把两个数与选择器打出来 */
t = t.replace("「更多」菜单 ${more.items.length} 条文本，含「重新加载」=${more.items.some((x) => x.includes('重新加载'))}；菜单文本：${more.items.join(' / ')}",
  "「更多」菜单 ${more.allNodes ? more.allNodes.length : more.items.length} 条（含嵌套叶子节点）/ ${more.directItems ? more.directItems.length : '?'} 条（.mp-pop-item/.mp-pop-title 直接子元素）；选择器=${more.sel || '(未记录)'}；含「重新加载」=${more.items.some((x) => x.includes('重新加载'))}；文本：${more.items.join(' / ')}");
fs.writeFileSync(p, t, 'utf8');
console.log(`✓ 应用了 ${n} 处补丁`);
