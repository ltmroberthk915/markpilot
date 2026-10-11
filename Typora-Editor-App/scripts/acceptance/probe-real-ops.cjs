/** 真实文档上的**大规模真实编辑操作**电池（用户 2026-09-18："使用植树内容的 md 和重识概率论 md 这两个
 *  真实样本，进行大规模测试，先解决文本、inline 和 block 在真实的键盘/鼠标/组合键/键鼠配合/拖拽操作下的
 *  所有 bug；验收规则尽量以 Typora 使用习惯为准，符合人类视觉手感逻辑"）。
 *
 *  判据全部是**用户能看见的性质**，不是"处理器被调用了"：
 *    纵向 V1 光标可见（0×0 就是"光标没了"）／V2 按了要动／V3 逐行（不跳行）／V4 列稳定／V5 上下往返闭合；
 *    横向 H1 光标可见／H2 不卡死／H3 左右往返一致／H4 不跳行；
 *    选中 S1 选区非空／S2 shift+方向键选区单调伸缩／S3 跨块公式选中（源码并入选区）；
 *    鼠标 M1 点击落点行与列对得上／M2 双击选词／M3 三击选段／M4 拖拽起点终点对得上／M5 点公式不丢光标；
 *    键鼠 C1 shift+点击 = 从锚点到点击处的选区／C2 拖拽后 shift+箭头能续选／C3 拖选后打字是替换；
 *    编辑 E1 打字进得去／E2 撤销后逐字节还原（磁盘 + getValue 双通道）。
 *
 *  列稳定的判据（修正上一版）：目标列 goalX 若落在**这一行可编辑范围**内，落点必须贴住 goalX
 *  （容差 = 一个字宽）；若 goalX 超出这一行最右可编辑位置，落在**该行最右位置**即为正确（短行钳制）。
 *  上一版把段落的盒子右缘当"行右缘"（段落盒子横跨整栏），短行的正常钳制被算成偏离——探针自己造的误报。
 *
 *  随机起点、随机目标列、种子固定可复现；两份文档都用**副本**，原件只读不动。
 *  用法：node scripts/acceptance/probe-real-ops.cjs [--doc=a|b|both] [--section=all|vertical,horizontal,...]
 *        [--rounds=6] [--presses=24] [--seed=20260918]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness.cjs');
const sleep = harness.sleep;
const project = harness.project;
const MOD = harness.MOD;
let OUT = path.join(project, '.perf/real-ops');
const IF = `document.getElementById('editor').contentWindow`;
const SURFACE = JSON.stringify('.vditor-ir .vditor-reset');
const DIR = 'D:/Users/ltmroberthk/xwechat_files2/xwechat_files/wxid_7ocfaaqz2s3422_2db2/msg/file/2026-09';
const DOCS = {
  a: {name: '植树', file: path.join(DIR, '新建 Markdown 文档-副本.md')},
  b: {name: '重识概率论', file: path.join(DIR, '1-重识概率论.md')},
};
const argOf = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => process.argv.includes('--' + name);
const rng = seed => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** 页内工具：可编辑判定、光标读数、按行列反查、落点、随机点。 */
const HELPERS = `window.__pr = (() => {
  const ok = candidate => {
    if (!candidate) return false;
    const at = candidate.startContainer && candidate.startContainer.nodeType === 3
      ? candidate.startContainer.parentElement : candidate.startContainer;
    if (at && at.closest && at.closest('.vditor-ir__preview,.vditor-ir__marker,[data-type$="-marker"]')) return false;
    // 应用自己浮在公式边上的小按钮（缩放徽标）也会被命中测试返回，它不是文本行上的落点：
    // 实测块公式那一行扫出"左缘 866"的假期望列，就是它（BUTTON.typora-zoom-badge）。
    if (at && at.closest && at.closest('button')) return false;
    const box = candidate.getBoundingClientRect ? candidate.getBoundingClientRect() : null;
    return !!(box && box.height);
  };
  const layer = at => !at ? '?' : at.closest && at.closest('code[data-type]') ? '源码'
    : at.closest && at.closest('.vditor-ir__preview') ? '预览'
    : at.closest && at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
  const nodeAt = (container, offset) => {
    const box = document.createRange();
    box.setStart(container, offset); box.setEnd(container, offset);
    return box.getBoundingClientRect();
  };
  const surface = () => document.querySelector(${SURFACE});
  /** 这一行**可编辑光标的 x 跨度**：必须只算"光标自己那一行"的命中——同一 y 带里
   *  可能叠着上一行的尾巴（实测块公式源码行 y=683 时扫到 top=679 的命中），
   *  不按行顶过滤就会把别的行算进来，量出"左缘 866 / 右缘 897"这种自相矛盾的读数。 */
  const lineSpan = (y, top) => {
    const box = surface() && surface().getBoundingClientRect();
    if (!box) return {左: null, 右: null};
    let 左 = null, 右 = null;
    for (let x = Math.round(box.left); x <= Math.round(box.right - 4); x += 3) {
      const hit = document.caretRangeFromPoint(x, y);
      if (!ok(hit)) continue;
      const r = hit.getBoundingClientRect();
      if (top !== null && Math.abs(Math.round(r.top) - top) > 3) continue;
      if (左 === null) 左 = Math.round(r.left);
      右 = Math.round(r.left);
    }
    return {左, 右};
  };
  const lineRight = y => {
    const box = surface() && surface().getBoundingClientRect();
    if (!box) return null;
    for (let x = Math.round(box.right - 6); x >= Math.round(box.left); x -= 3) {
      const hit = document.caretRangeFromPoint(x, y);
      if (ok(hit)) { const r = hit.getBoundingClientRect(); return Math.round(r.left); }
    }
    return null;
  };
  const lineLeft = y => {
    const box = surface() && surface().getBoundingClientRect();
    if (!box) return null;
    for (let x = Math.round(box.left); x <= Math.round(box.right - 6); x += 3) {
      const hit = document.caretRangeFromPoint(x, y);
      if (ok(hit)) { const r = hit.getBoundingClientRect(); return Math.round(r.left); }
    }
    return null;
  };
  /** y1→y2 之间**还能放光标的行**有几条（按行顶去重）：这就是"跳行"的判据——
   *  段落间距、行高差都会让 y 间隔忽大忽小，只有"中间还有一条能落光标的行"才是真跳行。 */
  const linesBetween = (y1, y2) => {
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    const keys = new Set();
    for (let y = Math.ceil(top); y <= Math.floor(bottom); y += 2) {
      for (const x of [60, 24, 120, 8]) {
        const hit = document.caretRangeFromPoint(x, y);
        if (!ok(hit)) continue;
        const r = hit.getBoundingClientRect();
        const key = Math.round(r.top / 4) * 4;
        keys.add(key);
        break;
      }
    }
    return [...keys];
  };
  return {
    ok, layer, surface, lineRight, lineLeft, linesBetween,
    /** 画标记：CDP 抓帧**拍不到合成的光标**（实测：折叠光标在截图里完全不出现），
     *  所以验收图里用标记把"浏览器自报的光标矩形"画出来——红实线＝光标落点，
     *  琥珀虚线＝本次连续移动的目标列，青虚线＝这一行应有的钳制列。
     *  标记只画在 iframe 文档里，截图后立刻清掉；它证明的是"几何与周围文字对得上"。
     *  光标真的隐形（0×0）时标记也画不出来——那正是"光标没了"的视觉证据。 */
    mark(list) {
      const old = document.getElementById('__pr_marks');
      if (old) old.remove();
      if (!list || !list.length) return 0;
      const layerNode = document.createElement('div');
      layerNode.id = '__pr_marks';
      // **fixed**：光标的矩形是**视口坐标**，fixed 定位的包含块也是视口，两者同一套坐标，
      // 滚动、body 边距都不掺进来（实测校准图：fixed 标记与选中高亮起点逐像素对齐）。
      layerNode.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      let drawn = 0;
      for (const item of list) {
        if (!item) continue;
        const line = document.createElement('div');
        const height = Math.max(2, item.h || 18);
        line.style.cssText = 'position:fixed;pointer-events:none;'
          + 'left:' + Math.round(item.x) + 'px;top:' + (Math.round(item.y) - (item.extend || 0) / 2) + 'px;'
          + 'width:' + (item.dash ? 0 : 2) + 'px;height:' + (height + (item.extend || 0)) + 'px;'
          + 'border-left:' + (item.dash ? '1.5px dashed ' + item.color : '2px solid ' + item.color) + ';'
          + 'background:' + (item.dash ? 'none' : item.color) + ';';
        layerNode.appendChild(line);
        drawn += 1;
        if (item.label) {
          const tag = document.createElement('div');
          tag.textContent = item.label;
          tag.style.cssText = 'position:fixed;pointer-events:none;font:11px/1.2 monospace;white-space:nowrap;'
            + 'left:' + (Math.round(item.x) + 3) + 'px;top:' + (Math.round(item.y) - 15) + 'px;color:' + item.color + ';';
          layerNode.appendChild(tag);
        }
      }
      document.body.appendChild(layerNode);
      return drawn;
    },
    unmark() { const old = document.getElementById('__pr_marks'); if (old) old.remove(); return 1; },
    /** 内容**已经滚过去了多少**（像素）。
     *  **不能用 window.scrollY**：这个编辑器的滚动容器在外壳那一层（iframe 自己的 window
     *  永远不滚，实测 scrollY 恒为 0），早先按 scrollY 写的判据全是空操作。
     *  改用"正文根元素相对视口的偏移"当尺子——它与是谁在滚无关。 */
    scrollY() { const box = surface() && surface().getBoundingClientRect(); return box ? -Math.round(box.top) : 0; },
    /** 滚动到某一行并把它放到视口中间（截图前用，保证目标行在画面里）。
     *  **必须用 scrollIntoView**：跨帧的滚动容器只有它带得动（实测 window.scrollBy 纹丝不动）。 */
    focusLine(y) { const box = surface() && surface().getBoundingClientRect(); if (!box) return 0;
      const 目标视口Y = Math.max(20, Math.min(window.innerHeight - 40, y));
      const 当前视口Y = box.top + y;
      const 需要 = 当前视口Y - 目标视口Y;
      if (Math.abs(需要) < 2) return this.scrollY();
      // 找一行落在目标位置附近的元素，交给 scrollIntoView 跨帧滚动
      const step = 需要 > 0 ? 需要 : -需要;
      const el = document.elementFromPoint(60, Math.max(10, Math.min(window.innerHeight - 10, 当前视口Y + (需要 > 0 ? step : -step))));
      const 目标 = el && el.closest ? (el.closest('p,li,h1,h2,h3,h4,h5,h6,.vditor-ir__node,blockquote,tr') || el) : null;
      if (目标) 目标.scrollIntoView({block: 需要 > 0 ? 'start' : 'end'});
      return this.scrollY(); },
    /** 这个方向**还有能放光标的行吗**（用来区分"该动不动=缺陷"与"到顶/到底不动=正确"）。 */
    hasLineBeyond(y, forward) {
      const box = surface() && surface().getBoundingClientRect();
      if (!box) return false;
      const 面顶 = Math.max(box.top, 0), 面底 = Math.min(box.bottom, window.innerHeight);
      const start = forward ? y + 4 : y - 4;
      for (let step = 0; step <= 400; step++) {
        const yy = forward ? start + step * 2 : start - step * 2;
        if (yy < 面顶 || yy > 面底) return false;
        for (const x of [60, 24, 120, 8, 200]) {
          const hit = document.caretRangeFromPoint(x, yy);
          if (!ok(hit)) continue;
          const r = hit.getBoundingClientRect();
          if (Math.abs(r.top - y) <= 4) continue;
          return true;
        }
      }
      return false;
    },
    /** 这一行上**离目标列最近的、真的能放光标的位置**（按行顶过滤，只算这一行）。
     *  为什么不能拿"目标列本身"当期望：光标一进标题行，Vditor 就把标题标记（三个井号）显示出来、整行右移
     *  （实测同一行 y=125：光标不在这一行时行尾 x=200，光标进来后行尾 x=242），字符边界跟着挪，
     *  目标列在新布局里可能根本不是一个边界——这时的正解是"新布局里离目标列最近的那个边界"。 */
    nearestOnLine(y, target) {
      const box = surface() && surface().getBoundingClientRect();
      if (!box) return null;
      let best = null;
      for (let x = Math.round(box.left); x <= Math.round(box.right - 4); x += 3) {
        const hit = document.caretRangeFromPoint(x, y);
        if (!ok(hit)) continue;
        const rect = hit.getBoundingClientRect();
        // **必须真的盖住 y**：同一 y 带里可能叠着别的行/别的元素的落点（实测块公式源码行会扫出
        // 左缘 866 这种来自别处的命中），不按 y 盖住过滤就会量出一个根本不存在的"期望列"。
        if (!(y >= rect.top - 2 && y <= rect.bottom + 2)) continue;
        const left = Math.round(rect.left);
        if (!best || Math.abs(left - target) < Math.abs(best - target)) best = left;
      }
      return best;
    },
    /** 把某一 y 上**每一个不同的落点**全列出来（同 left/top 归一组，记下产生它的 x 范围）。
     *  用来判"这一行到底哪儿能放光标"：产品说 x=242 只能落 200，探针扫出 242——谁对靠这张表。 */
    scanLine(y) {
      const box = surface().getBoundingClientRect();
      const groups = new Map();
      for (let x = Math.round(box.left); x <= Math.round(box.right - 4); x += 3) {
        const hit = document.caretRangeFromPoint(x, y);
        const at = hit && hit.startContainer && hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit && hit.startContainer;
        const rect = hit && hit.getBoundingClientRect ? hit.getBoundingClientRect() : null;
        const key = rect ? Math.round(rect.left) + '@' + Math.round(rect.top) : '无';
        const row = groups.get(key) || {左: rect ? Math.round(rect.left) : null, 顶: rect ? Math.round(rect.top) : null,
          高: rect ? Math.round(rect.height) : null, 可用: ok(hit), 层: layer(at),
          节点: at && at.tagName ? at.tagName + '.' + String(at.className || '').split(' ')[0] : null,
          数据类型: at && at.getAttribute ? at.getAttribute('data-type') : null, x最小: x, x最大: x};
        row.x最小 = Math.min(row.x最小, x); row.x最大 = Math.max(row.x最大, x);
        groups.set(key, row);
      }
      return [...groups.values()].sort((a, b) => (a.左 || 0) - (b.左 || 0));
    },
    /** 诊断：把光标所在那一行**逐点扫一遍**，看"这一行到底能放光标在哪几个 x"。 */
    diagnose() {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return {无选区: true};
      const range = selection.getRangeAt(0);
      const box = range.getBoundingClientRect();
      const 中线 = Math.round(box.top + box.height / 2);
      const 命中 = [];
      const 面 = surface().getBoundingClientRect();
      for (let x = Math.round(面.left); x <= Math.round(面.right - 4); x += 6) {
        const hit = document.caretRangeFromPoint(x, 中线);
        if (!ok(hit)) continue;
        const r = hit.getBoundingClientRect();
        const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
        命中.push({x, left: Math.round(r.left), top: Math.round(r.top), 高: Math.round(r.height), 层: layer(at)});
      }
      const 行顶 = new Map();
      for (const item of 命中) { const key = Math.round(item.top / 4); if (!行顶.has(key)) 行顶.set(key, item); }
      return {光标: {x: Math.round(box.left), y: Math.round(box.top), 高: Math.round(box.height), 层: layer(range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer)},
        中线, 面: {左: Math.round(面.left), 右: Math.round(面.right)},
        命中数: 命中.length, 有效x范围: 命中.length ? [命中[0].x, 命中[命中.length - 1].x] : null,
        这一行: 命中.length ? {左: Math.min(...命中.map(item => item.left)), 右: Math.max(...命中.map(item => item.left))} : null,
        相邻行: [...行顶.values()].slice(0, 6)};
    },
    state() {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return {无选区: true, 可见: false};
      const range = selection.getRangeAt(0);
      const at = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
      const box = range.getBoundingClientRect();
      const 可见 = !!(box && box.height > 0);
      const block = at && at.closest ? (at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre') || at) : at;
      const 代理 = document.querySelector("[data-typora-caret-proxy]");
      const 代理显示 = !!(代理 && 代理.style.display === "block");
      const 代理框 = 代理显示 ? (() => { const r = 代理.getBoundingClientRect();
        return {x: Math.round(r.left), y: Math.round(r.top), 高: Math.round(r.height)}; })() : null;
      const out = {可见: 可见 || 代理显示, 合成光标: 代理显示, 代理框, x: 代理显示 ? 代理框.x : Math.round(box.left),
        y: 代理显示 ? 代理框.y : Math.round(box.top), 右: Math.round(box.right),
        高: 代理显示 ? 代理框.高 : Math.round(box.height), 层: layer(at), 折叠: range.collapsed,
        选区长度: range.collapsed ? 0 : range.toString().length,
        选区文本: range.collapsed ? '' : range.toString().replace(/\\s+/g, ' ').slice(0, 40),
        文本: String(block && block.textContent || '').replace(/\\s+/g, ' ').slice(0, 20)};
      if (可见) {
        const 中线 = Math.round(box.top + box.height / 2);
        const 跨度 = lineSpan(中线, Math.round(box.top));
        out.行右缘 = 跨度.右;
        out.行左缘 = 跨度.左;
        if (!range.collapsed) {
          const a = nodeAt(range.startContainer, range.startOffset);
          const b = nodeAt(range.endContainer, range.endOffset);
          out.起点 = {x: Math.round(a.left), y: Math.round(a.top)};
          out.终点 = {x: Math.round(b.left), y: Math.round(b.top)};
        }
      }
      return out;
    },
    /** 把一个可编辑落点写进选区（**不点击**，用于键盘段的前置定位）。 */
    place(x, y) {
      for (const tryX of [x, x - 6, x + 6, 0, 24, 48, 80, 120]) {
        const hit = document.caretRangeFromPoint(tryX, y);
        if (!ok(hit)) continue;
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(hit);
        return {ok: true};
      }
      return {ok: false};
    },
    /** 视口内随机取一个可编辑点（随机数由调用方给，保证可复现）。 */
    editPoint(r1, r2) {
      const box = surface() && surface().getBoundingClientRect();
      if (!box) return {fail: '没有编辑面'};
      const top = Math.max(box.top, 0) + 10, bottom = Math.min(box.bottom, window.innerHeight) - 10;
      if (bottom <= top + 4) return {fail: '编辑面不在视口里', 面: {上: Math.round(box.top), 下: Math.round(box.bottom)}, 视口高: window.innerHeight};
      const y = Math.round(top + r1 * (bottom - top));
      const x = Math.round(box.left + 30 + r2 * Math.max(1, box.width - 60));
      const tried = [];
      for (const tryX of [x, x - 8, x + 8, 0, 24, 48, 80, 120, 160]) {
        const hit = document.caretRangeFromPoint(tryX, y);
        if (!ok(hit)) {
          const at = hit && hit.startContainer && hit.startContainer.nodeType === 3
            ? hit.startContainer.parentElement : hit && hit.startContainer;
          tried.push({x: tryX, 层: layer(at), 高: hit && hit.getBoundingClientRect ? Math.round(hit.getBoundingClientRect().height) : null});
          continue;
        }
        const r = hit.getBoundingClientRect();
        const at = hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer;
        // 表格有自己的交互模型（单元格内的选区由浏览器按 cell 约束），本轮测的是正文/行内/块公式，
        // 随机起点**避开表格**，免得把"表格语义"混进来（表格另有 50/70 等确定性场景）。
        if (at && at.closest && at.closest('table')) { tried.push({x: tryX, 层: '表格'}); continue; }
        if (at && at.closest && at.closest('button')) { tried.push({x: tryX, 层: '按钮'}); continue; }
        return {x: tryX, y: Math.round(r.top + r.height / 2), 层: layer(at)};
      }
      return {fail: '这一带没有可编辑落点', y, 试过: tried.slice(0, 4)};
    },
    /** 滚到文档的某个比例位置。**不能用 window.scrollTo**（见 scrollY 的说明：滚动容器在外壳层），
     *  改成"取该比例处的那一块，scrollIntoView 到视口顶"，跨帧也有效。
     *  返回 {max, 实际}: 实际＝滚过去的内容像素（新尺子）。 */
    scroll(fraction) {
      const root = surface();
      if (!root) return {max: 0, 实际: 0};
      const height = Math.max(root.scrollHeight, document.documentElement.scrollHeight);
      const max = Math.max(0, height - window.innerHeight);
      const 文档目标 = Math.round(fraction * max);
      // 从正文根出发按文档坐标找承载块：取 offsetTop 不超过目标的最深块
      const 块 = [...root.querySelectorAll(':scope > *')];
      let 选 = 块[0] || null;
      for (const el of 块) { if (el.offsetTop <= 文档目标) 选 = el; else break; }
      if (选) 选.scrollIntoView({block: 'start'});
      return {max, 实际: this.scrollY(), 文档目标};
    },
  };
})()`;

const INIT = `(() => { const w = ${IF}; if (!w || !w.document.querySelector(${SURFACE})) return null;
  return {helpers: (() => { const script = w.document.createElement('script');
      script.textContent = ${JSON.stringify('')}; return true; })()}; })()`;

/** 在编辑器 iframe 里装工具（iframe 是独立文档，工具必须装在它里面）。 */
const INSTALL = `(() => { const w = ${IF};
  if (!w || !w.document.querySelector(${SURFACE})) return {ok: false};
  if (!w.__pr) { w.eval(${JSON.stringify(HELPERS)}); }
  w.__vertTraceOn = true;          // 探针在跑：把补丁的决策轨迹开起来（产品默认零开销）
  return {ok: !!w.__pr}; })()`;
const EVAL_IN = expression => `(() => { const w = ${IF}; return w.eval(${JSON.stringify(expression)}); })()`;

const state = session => session.js(EVAL_IN('window.__pr.state()'));
/** iframe 在**顶层视口**里的位置：CDP 的鼠标坐标是顶层坐标，必须换算。 */
const frame = session => session.js(`(() => { const f = document.getElementById('editor');
  if (!f) return {x: 0, y: 0}; const r = f.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y)}; })()`);
/** 取一个随机可编辑点；取不到时把**页内给的理由**打出来（不吃哑巴亏）。 */
const pointOf = async (session, next, tag) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const point = await session.js(EVAL_IN(`window.__pr.editPoint(${next().toFixed(3)}, ${next().toFixed(3)})`));
    if (point && !point.fail) return point;
    if (attempt === 3) console.log(`  [${tag}] 取不到可编辑点：${JSON.stringify(point)}`);
  }
  return null;
};
const install = async session => {
  const first = await session.js(INSTALL);
  return first && first.ok;
};

/** 计数器 + 失败样例（按节分组）。 */
function makeRecorder() {
  const counters = new Map();
  const samples = [];
  const bump = (key, bad, detail) => {
    const row = counters.get(key) || {检查: key, 次数: 0, 失败: 0, 提示: 0};
    row.次数 += 1;
    if (bad) {
      row.失败 += 1;
      if (samples.filter(item => item.检查 === key).length < 5) samples.push({检查: key, 详情: detail});
    }
    counters.set(key, row);
  };
  /** 只记录不当失败（例如"这一行量不出左右边界"——探针的量法限制，不是产品缺陷）。 */
  const note = (key, detail) => {
    const row = counters.get(key) || {检查: key, 次数: 0, 失败: 0, 提示: 0};
    row.提示 += 1;
    if (samples.filter(item => item.检查 === key).length < 5) samples.push({检查: key, 详情: detail, 提示: true});
    counters.set(key, row);
  };
  return {bump, note, counters, samples};
}

const ARROW = {ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35};
const press = async (session, key, modifiers = 0, wait = 260) => {
  await session.key({key, code: key, vk: ARROW[key], modifiers});
  await sleep(wait);
  return state(session);
};

const 字宽 = now => Math.max(14, now.高 || 18);

/** 纵向：随机起点走 N 步下去、再 N 步上来。 */
async function vertical(session, rec, next, rounds, presses) {
  for (let round = 1; round <= rounds; round++) {
    const scrolled = await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(220);
    const point = await pointOf(session, next, '点');
    if (!point) { console.log(`  [纵向 ${round}] 视口内没找到可编辑点，跳过`); continue; }
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(320);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const start = await state(session);
    if (!start.可见) { rec.bump('V1 光标可见', true, {轮: round, 起点: point, 读数: start}); continue; }
    const goal = start.x;
    let last = start;
    const walk = async (key, steps) => {
      for (let step = 0; step < steps; step++) {
        const now = await press(session, key);
        const tag = `${key === 'ArrowDown' ? '↓' : '↑'}${step + 1}`;
        rec.bump('V1 光标可见', !now.可见, {轮: round, 步: tag, 目标列: goal, 读数: now});
        if (!now.可见) { last = {可见: false, y: last.y, x: last.x, 高: 18}; continue; }
        const gap = key === 'ArrowDown' ? now.y - last.y : last.y - now.y;
        if (gap <= 1) {
          const 还有 = await session.js(EVAL_IN(`window.__pr.hasLineBeyond(${last.y}, ${key === 'ArrowDown'})`));
          rec.bump('V2 按了要动', !!还有, {轮: round, 步: tag, 上一行y: last.y, 现在y: now.y, 这一方向还有行: !!还有, 层: now.层, 文本: now.文本});
        }
        if (gap > 1) {
          // 跳行 = 两次落点之间**还有能放光标的行**（段落间距造成的 y 间隔不算）
          const between = await session.js(EVAL_IN(`window.__pr.linesBetween(${last.y}, ${now.y})`));
          const 中间 = (between || []).filter(top => top > Math.min(last.y, now.y) + 3 && top < Math.max(last.y, now.y) - 3);
          if (中间.length) {
            const trace = await session.js(EVAL_IN('(window.__vtrace || []).slice(-8)'));
            rec.bump('V3 逐行不跳', true,
              {轮: round, 步: tag, 方向: key === 'ArrowDown' ? '↓' : '↑', 间隔: gap, 夹在中间的行: 中间,
                上一行: [last.y, last.文本], 这一行: [now.y, now.文本], 轨迹: trace});
          } else rec.bump('V3 逐行不跳', false, null);
          const 期望 = await session.js(EVAL_IN(`window.__pr.nearestOnLine(${Math.round(now.y + (now.高 || 18) / 2)}, ${Math.round(goal)})`));
          if (期望 === null) rec.note('V4 列可测量（量不出就不判）', {轮: round, 步: tag, 层: now.层, 文本: now.文本});
          else if (Math.abs(now.x - goal) > Math.abs(期望 - goal) + 8) {
            const trace = await session.js(EVAL_IN('(window.__vtrace || []).slice(-8)'));
            rec.bump('V4 列稳定', true,
              {轮: round, 步: tag, 方向: key === 'ArrowDown' ? '↓' : '↑', 目标列: goal, 最近可用列: 期望, 实际列: now.x,
                行左缘: now.行左缘, 行右缘: now.行右缘, 层: now.层, 高: now.高, 文本: now.文本, 轨迹: trace});
          } else rec.bump('V4 列稳定', false, null);
        }
        last = now;
      }
      return last;
    };
    const bottom = await walk('ArrowDown', presses);
    const top = await walk('ArrowUp', presses);
    if (top.可见 && bottom.可见) {
      const between = await session.js(EVAL_IN(`window.__pr.linesBetween(${start.y}, ${top.y})`));
      const 夹层 = (between || []).filter(top_ => top_ > Math.min(start.y, top.y) + 3 && top_ < Math.max(start.y, top.y) - 3);
      if (夹层.length) {
        // 上行走到了起点之上（这一轮下行已经到底，上行越过了起点）：闭合无从谈起，只记一笔
        rec.note('V5 往返闭合（越过了起点，不判）', {轮: round, 起点y: start.y, 回来y: top.y, 夹层});
      } else {
        const 期望 = await session.js(EVAL_IN(`window.__pr.nearestOnLine(${Math.round(top.y + (top.高 || 18) / 2)}, ${Math.round(goal)})`));
        期望 === null
          ? rec.note('V5 往返闭合（量不出就不判）', {轮: round, 起点y: start.y, 回来y: top.y})
          : rec.bump('V5 往返闭合', Math.abs(top.x - goal) > Math.abs(期望 - goal) + 8,
            {轮: round, 起点: [start.x, start.y], 回来: [top.x, top.y], 期望列: 期望});
      }
    }
    console.log(`  [纵向 ${round}] 起点 y=${start.y} x=${start.x}「${start.文本}」 → ↓到 y=${bottom.y} → ↑回到 y=${top.y} x=${top.x}`);
  }
}

/** 横向：随机起点连续 → 再连续 ←。 */
async function horizontal(session, rec, next, rounds, presses) {
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(220);
    if (has('trace')) console.log('  选区埋点：' + await session.js(EVAL_IN(装选区埋点)));
    const point = await pointOf(session, next, '点');
    if (!point) { console.log(`  [横向 ${round}] 没找到可编辑点，跳过`); continue; }
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(320);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const start = await state(session);
    if (!start.可见) { rec.bump('H1 光标可见', true, {轮: round, 起点: point, 读数: start}); continue; }
    let last = start;
    let 连续不动 = 0;
    const run = async (key, steps) => {
      for (let step = 0; step < steps; step++) {
        // --trace：把"这一按是谁改的选区"记下来（塌陷/跳行时连栈打出来，见 H4 分支）
        if (has('trace')) await session.js(EVAL_IN("(() => { const t = window.__selTrace; if (t) { t.acts.length = 0; t.log.length = 0; } return 1; })()"));
        const now = await press(session, key);
        if (!now.可见) {
          const 兜底 = await session.js(EVAL_IN('window.__caretRescued || 0'));
          rec.bump('H1 光标可见', true, {轮: round, 键: key, 步: step + 1, 光标兜底次数: 兜底, 读数: now});
        } else rec.bump('H1 光标可见', false, null);
        if (has('trace')) {
          const 逐行 = await session.js(EVAL_IN('(window.__typoraLineSteps || []).slice(-2)'));
          console.log(`      [逐行] 轮 ${round} ${key} 步 ${step + 1}：${JSON.stringify(逐行)}`);
        }
        if (!now.可见) { last = now; continue; }
        const 前进 = key === 'ArrowRight' ? now.x - last.x : last.x - now.x;
        const 换行 = key === 'ArrowRight' ? now.y > last.y : now.y < last.y;
        // 单次不动可能是边界上的正确行为（或"光标消失兜底"把它放回原位），**连续 3 次**才叫卡死
        if (!换行 && 前进 <= 1 && Math.abs(now.y - last.y) <= 1) 连续不动 += 1; else 连续不动 = 0;
        rec.bump('H2 不卡死', 连续不动 >= 3,
          {轮: round, 键: key, 步: step + 1, 连续不动, 上一: {x: last.x, y: last.y}, 现在: {x: now.x, y: now.y, 文本: now.文本}});
        if (换行) {
          // 一次 ←/→ 最远只能走到相邻行的行首/行尾；判据同 V3：中间不许还有能落光标的行
          const between = await session.js(EVAL_IN(`window.__pr.linesBetween(${last.y}, ${now.y})`));
          const 中间 = (between || []).filter(top => top > Math.min(last.y, now.y) + 3 && top < Math.max(last.y, now.y) - 3);
          // 失败时把那一行的**身份**一起记下来（层：正文/预览/围栏/源码/表格 + 文本 + 那一带有没有公式）——
          // 只有 y 的样例事后没法判"是产品跳行还是测量口径"，这一轮就卡在这里（probe-repro-hline 用同款清单才查清）。
          const 详情 = {轮: round, 键: key, 步: step + 1, 上一y: last.y, 现在y: now.y, 夹在中间: 中间};
          if (中间.length) {
            详情.被跳过那一行 = await session.js(EVAL_IN(`(() => { const y = ${中间[0]};
              const hit = document.caretRangeFromPoint(200, y) || document.caretRangeFromPoint(520, y);
              const at = hit && (hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer);
              const 层 = at?.closest?.('.vditor-ir__preview') ? '预览' : at?.closest?.('[data-type$="-marker"]') ? '围栏'
                : at?.closest?.('code[data-type]') ? '源码' : at?.closest?.('table') ? '表格' : at ? '正文' : null;
              const 块 = at?.closest?.('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th');
              const box = at?.getBoundingClientRect?.();
              return {层, 文本: at ? String(at.textContent || '').replace(/\\s+/g, ' ').slice(0, 26) : null,
                块文本: 块 ? String(块.textContent || '').replace(/\\s+/g, ' ').slice(0, 26) : null,
                块里的公式数: 块 ? 块.querySelectorAll('.vditor-ir__node[data-type="inline-node"]').length : null,
                光标所在的块文本: null, box: box ? {y: Math.round(box.top), h: Math.round(box.height)} : null}; })()`));
            详情.现在记录 = {层: now.层, 文本: now.文本};
            详情.上一记录 = {层: last.层, 文本: last.文本, x: last.x, y: last.y};
            详情.逐行校正 = await session.js(EVAL_IN("window.__typoraLineStep || null"));
            // 被跳过那一行是不是落在 content-visibility 被跳过的子树里（那一段用户根本看不见，
            // 原生移动跳过它就不算"跳行"）。顺带把这一带的块序列打出来。
            详情.被跳过那一行.可见性 = await session.js(EVAL_IN(`(() => {
              const y = ${中间[0]};
              const el = document.elementFromPoint(200, y);
              const 链 = []; let cur = el;
              while (cur && 链.length < 6) {
                const s = getComputedStyle(cur);
                if (s.contentVisibility && s.contentVisibility !== 'visible') 链.push({标签: cur.tagName + '.' + String(cur.className).split(' ').slice(0, 2).join('.'), contentVisibility: s.contentVisibility});
                cur = cur.parentElement; }
              return {命中元素: el ? el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.') : null, 被跳过子树: 链}; })()`));
            if (has('trace')) {
              const 轨 = await session.js(EVAL_IN("(() => { const t = window.__selTrace; return t ? {acts: t.acts.slice(0, 10), log: t.log.slice(0, 14)} : null; })()"));
              console.log(`     [trace] 轮 ${round} 步 ${step + 1} 这一按的选区写入口：`);
              for (const 项 of (轨?.acts || [])) console.log('        ' + JSON.stringify(项));
              console.log('     [trace] selectionchange 时间线：' + JSON.stringify(轨?.log || []));
            }
            详情.块序列 = await session.js(EVAL_IN(`(() => { const 块 = [...document.querySelectorAll('.vditor-ir .vditor-reset > *')];
              const 看 = b => { const r = b.getBoundingClientRect(); return {y: Math.round(r.top), bottom: Math.round(r.bottom),
                标签: b.tagName + (b.dataset?.type ? '[' + b.dataset.type + ']' : ''), 文本: String(b.textContent || '').replace(/\\s+/g, ' ').slice(0, 18),
                可编辑: b.isContentEditable}; };
              const 起点 = 块.findIndex(b => { const r = b.getBoundingClientRect(); return r.top <= ${last.y} && r.bottom >= ${last.y}; });
              return {起点块: 起点 >= 0 ? 看(块[起点]) : null,
                被跳过那一块: (() => { const i = 块.findIndex(b => { const r = b.getBoundingClientRect(); return r.top <= ${中间[0]} && r.bottom >= ${中间[0]}; });
                  return i >= 0 ? {...看(块[i]), 可编辑: 块[i].isContentEditable, 命中可编辑: (() => { const hit = document.caretRangeFromPoint(200, ${中间[0]});
                    const at = hit && (hit.startContainer.nodeType === 3 ? hit.startContainer.parentElement : hit.startContainer);
                    return at ? {标签: at.tagName + '.' + String(at.className).split(' ').slice(0, 2).join('.'), 可编辑: at.isContentEditable,
                      被禁用的祖先: (() => { let cur = at; while (cur) { if (cur.isContentEditable === false) return cur.tagName + '.' + String(cur.className).split(' ').slice(0, 2).join('.'); cur = cur.parentElement; } return null; })()} : null; })()} : null; })()}; })()`));
          }
          rec.bump('H4 不跳行', 中间.length > 0, 详情);
        }
        last = now;
      }
      return last;
    };
    const right = await run('ArrowRight', presses);
    const back = await run('ArrowLeft', presses);
    if (right.可见 && back.可见) {
      rec.bump('H3 左右往返一致', Math.abs(back.y - start.y) > Math.max(start.高 || 18, 18) * 1.6 + 6,
        {轮: round, 起点: {x: start.x, y: start.y}, 前进后: {x: right.x, y: right.y}, 回来: {x: back.x, y: back.y}});
    }
    console.log(`  [横向 ${round}] 起点 y=${start.y} x=${start.x} → →到 y=${right.y} x=${right.x} → ←回到 y=${back.y} x=${back.x}`);
  }
}

/** shift+方向键：选区必须非空且单调伸缩。 */
async function select(session, rec, next, rounds, presses) {
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(220);
    const point = await pointOf(session, next, '点');
    if (!point) continue;
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(300);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    let last = await state(session);
    if (!last.可见) continue;
    // 判据是"**按住 shift 连按方向键，选区必须真的出现**"，不是"每一步都非空"：
    // 行尾/块边界上偶尔会出现一次"未折叠但零长度"的瞬间（终点落在折叠公式源码那种隐形位置上），
    // 用户当拍看不到高亮，但下一拍就出来了——只有**一次都没出来**才算缺陷。
    let peak = 0;
    let 零长连击 = 0;
    for (let step = 0; step < presses; step++) {
      const now = await press(session, 'ArrowRight', MOD.shift);
      rec.bump('S2 选区只增不减', now.选区长度 < peak,
        {轮: round, 本轮起点: point, 步: step + 1, 上一长度: peak, 现在长度: now.选区长度, 文本: now.选区文本,
          层: now.层, 起点: now.起点, 终点: now.终点, 行文本: now.文本});
      if (now.选区长度 === 0) {
        // 文档末尾：右边已经没有内容可选，收不起来不算缺陷（文档中段收起来才算）
        const 还有 = await session.js(EVAL_IN('window.__pr.hasLineBeyond(' + Math.round(now.y) + ', true)'));
        if (peak > 0 && !还有) rec.note('S2 选区（到文档末尾，右边没有内容，不判）', {轮: round, 步: step + 1, 上一长度: peak});
        零长连击 += 1; last = now; continue;
      }
      零长连击 = 0;
      peak = Math.max(peak, now.选区长度);
      last = now;
    }
    rec.bump('S1 选区非空', peak === 0, {轮: round, 起点: {x: point.x, y: point.y}, 按了几次: presses, 峰值: peak});
    for (let step = 0; step < presses; step++) {
      const now = await press(session, 'ArrowLeft', MOD.shift);
      if (now.选区长度 !== 0 && now.选区长度 > peak) {
        rec.bump('S2 选区只增不减', true, {轮: round, 相位: '收缩', 步: step + 1, 长度: now.选区长度, 峰值: peak,
          起点: now.起点, 终点: now.终点, 层: now.层, 行文本: now.文本});
        // --trace：收缩相位反而变长 = 锚点/焦点被翻转（遗留 #3 的形态），把这一拍的写入口连栈打出来
        if (has('trace')) {
          const 轨 = await session.js(EVAL_IN("(() => { const t = window.__selTrace; return t ? {acts: t.acts.slice(0, 8), log: t.log.slice(0, 10)} : null; })()"));
          for (const 项 of (轨?.acts || [])) console.log('        [S2-trace] ' + JSON.stringify(项).slice(0, 300));
          console.log('        [S2-trace] 时间线 ' + JSON.stringify(轨?.log || []));
        }
      }
      if (now.选区长度 === 0) break;
      peak = now.选区长度;
    }
    console.log(`  [选中 ${round}] 起点 y=${point.y}：shift+→ 峰值 ${peak} 字符`);
  }
}

/** 鼠标：单击落点、双击选词、三击选段、拖拽选区、点公式。 */
async function mouse(session, rec, next, rounds) {
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(220);
    const point = await pointOf(session, next, '点');
    if (!point) continue;
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(300);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const landed = await state(session);
    rec.bump('M1 点击落到点到的行', !landed.可见, {轮: round, 点: point, 读数: landed});
    if (landed.可见) {
      const 左 = landed.行左缘, 右 = landed.行右缘;
      const 期望 = Math.max(左 === null ? -Infinity : 左, Math.min(point.x, 右 === null ? Infinity : 右));
      // 标题行特殊：点下去之后 Vditor 才把 `###` 标记显示出来，整行右移，光标跟着挪
      // （视觉实测：点 x=180 落点 227，图上就是"点的那两个字附近"）。这类行容差放宽到 2.5 字。
      const 容差 = /^#{1,6}\s/.test(String(landed.文本 || '')) ? 字宽(landed) * 2.5 : 字宽(landed);
      rec.bump('M1 点击落到点到的列', Math.abs(landed.x - point.x) > Math.abs(期望 - point.x) + 容差,
        {轮: round, 点x: point.x, 期望列: Math.round(期望), 落点x: landed.x, 容差: Math.round(容差), 行左缘: 左, 行右缘: 右, 层: landed.层, 文本: landed.文本});
      rec.bump('M2 单击不该选中', !landed.折叠, {轮: round, 选区: landed.选区文本});
    }
    const 行尾 = landed.行右缘;
    const 点在文本内 = 行尾 === null || point.x <= 行尾 + 2;
    await session.click(box.x + point.x, box.y + point.y, {clickCount: 2});
    await sleep(300);
    const twice = await state(session);
    if (点在文本内) rec.bump('M3 双击选中词', twice.选区长度 === 0, {轮: round, 点: point, 读数: twice});
    else rec.note('M3 双击（点在文本之外，不判）', {轮: round, 点: point});
    await session.click(box.x + point.x, box.y + point.y, {clickCount: 3});
    await sleep(300);
    const thrice = await state(session);
    if (点在文本内) rec.bump('M3 三击选中段', thrice.选区长度 < 2, {轮: round, 点: point, 长度: thrice.选区长度, 文本: thrice.选区文本});
    else rec.note('M3 三击（点在文本之外，不判）', {轮: round, 点: point});
    console.log(`  [鼠标 ${round}] 点 (${point.x},${point.y}) → 光标 x=${landed.x} y=${landed.y}；双击选 ${twice.选区长度} 字；三击选 ${thrice.选区长度} 字`);
  }
  // 拖拽：同屏两点之间真实按下—移动—抬起
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(240);
    const a = await pointOf(session, next, '点A');
    const b = await pointOf(session, next, '点B');
    if (!a || !b) continue;
    const box = await frame(session);
    const 滚动前 = await session.js(EVAL_IN('window.__pr.scrollY()'));
    const from = {x: box.x + a.x, y: box.y + a.y}, to = {x: box.x + b.x, y: box.y + b.y};
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x, y: from.y, buttons: 0});
    await sleep(60);
    await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1});
    await sleep(70);
    for (let i = 1; i <= 6; i++) {
      await session.send('Input.dispatchMouseEvent'
        + '', {type: 'mouseMoved', x: Math.round(from.x + (to.x - from.x) * i / 6), y: Math.round(from.y + (to.y - from.y) * i / 6), button: 'left', buttons: 1});
      await sleep(45);
    }
    await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1});
    await sleep(360);
    const dragged = await state(session);
    const 滚动后 = await session.js(EVAL_IN('window.__pr.scrollY()'));
    const 滚差 = 滚动后 - 滚动前;      // 拖拽期间文档滚了多少（编辑器把落点滚进视野是正常的）
    const 位移 = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (位移 < 14) rec.note('M4 原地按下抬起（不产生选区，不判）', {轮: round, 从: a, 到: b});
    else rec.bump('M4 拖拽选中非空', dragged.选区长度 === 0, {轮: round, 从: a, 到: b, 读数: dragged});
    if (dragged.选区长度 > 0 && dragged.起点 && dragged.终点) {
      // 判据：**拖过的范围要被选上**——选区在竖直方向要盖住"按下→抬起"这一段。
      // 不再拿起点 x 硬比：拖拽按下落在块边界/公式上时，选区的起点是那一块的左缘
      // （实测按下 x=58 → 选区起点 x=230、y 更靠上），语义上仍然盖住了按下点；
      // 覆盖是否正确已由 `probe-real-ops --section=visualclick` 的截图逐张确认过。
      if (滚差 !== 0) rec.note('M4 拖拽（期间滚动过，视口尺子不同，不判起点终点）', {轮: round, 滚动: 滚差});
      else {
        const 上 = Math.min(dragged.起点.y, dragged.终点.y);
        const 下 = Math.max(dragged.起点.y, dragged.终点.y);
        const 期望上 = Math.min(a.y, b.y), 期望下 = Math.max(a.y, b.y);
        rec.bump('M4 拖拽覆盖按下到抬起', 上 > 期望上 + 14 || 下 < 期望下 - 14,
          {轮: round, 按下: a, 抬起: b, 选区上缘: 上, 选区下缘: 下, 期望: [期望上, 期望下], 长度: dragged.选区长度});
      }
    }
    console.log(`  [拖拽 ${round}] (${a.x},${a.y}) → (${b.x},${b.y}) 选中 ${dragged.选区长度} 字「${String(dragged.选区文本).slice(0, 20)}」`);
    // 拖拽之后再 shift+← ：选区应当收缩而不是清空
    const shrunk = await press(session, 'ArrowLeft', MOD.shift);
    rec.bump('C2 拖拽后 shift+← 不空', shrunk.选区长度 === 0, {轮: round, 拖拽长度: dragged.选区长度, 收缩后: shrunk.选区长度});
  }
}

/** 键鼠配合：shift+点击、拖选后打字替换。 */
async function combo(session, rec, next, rounds) {
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(220);
    const a = await pointOf(session, next, '点A');
    const b = await pointOf(session, next, '点B');
    if (!a || !b) continue;
    const box = await frame(session);
    await session.click(box.x + a.x, box.y + a.y);
    await sleep(280);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const anchor = await state(session);
    if (!anchor.可见) continue;
    await session.click(box.x + b.x, box.y + b.y, {modifiers: MOD.shift});
    await sleep(320);
    const extended = await state(session);
    const 锚位 = await session.js(EVAL_IN(`window.__pr.nearestOnLine(${Math.round(anchor.y + 8)}, ${anchor.x})`));
    const 到线 = await session.js(EVAL_IN(`window.__pr.nearestOnLine(${Math.round(b.y + 8)}, ${b.x})`));
    if (锚位 !== null && 到线 !== null && 锚位 === 到线) rec.note('C1 shift+点击（两次都吸附到同一落点，空选区是对的）', {轮: round, 锚点: a, 到: b, 同一落点: 锚位});
    else rec.bump('C1 shift+点击扩展选区', extended.选区长度 === 0, {轮: round, 锚点: a, 到: b, 锚位, 到线, 读数: extended});
    if (extended.选区长度 > 0 && extended.起点 && extended.终点) {
      const 锚期 = await session.js(EVAL_IN(`window.__pr.nearestOnLine(${Math.round(anchor.y + 8)}, ${anchor.x})`));
      const 端点距 = Math.min(Math.abs(extended.起点.x - anchor.x),
        extended.终点 ? Math.abs(extended.终点.x - anchor.x) : Number.POSITIVE_INFINITY);
      rec.bump('C1 shift+点击锚点对得上', 锚期 !== null && 端点距 > Math.abs(锚期 - anchor.x) + 8,
        {轮: round, 锚点x: anchor.x, 最近可用列: 锚期, 起点: extended.起点, 终点: extended.终点});
    }
    console.log(`  [键鼠 ${round}] 点(${a.x},${a.y}) + shift 点(${b.x},${b.y}) → 选中 ${extended.选区长度} 字「${String(extended.选区文本).slice(0, 20)}」`);
  }
}

/** 编辑 + 撤销：打字要进得去，撤销要逐字节还原。 */
async function edit(session, rec, next, rounds) {
  const before = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
  const round = Math.max(1, Math.min(rounds, 4));
  for (let index = 1; index <= round; index++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(240);
    const point = await pointOf(session, next, '点');
    if (!point) continue;
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(300);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const at = await state(session);
    if (!at.可见) continue;
    const 标记 = '甲' + index;
    await session.type(标记);
    await sleep(420);
    const typed = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
    rec.bump('E1 打字进得去', !String(typed).includes(标记), {轮: index, 点: point, 层: at.层, 文本: at.文本});
    const afterType = await state(session);
    rec.bump('E1 打字后光标可见', !afterType.可见, {轮: index, 读数: afterType});
    await session.key({key: 'z', code: 'KeyZ', vk: 90, modifiers: MOD.ctrl});
    await sleep(600);
    const undone = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
    rec.bump('E2 撤销逐字节还原', String(undone) !== String(before),
      {轮: index, 还原后长度: String(undone).length, 原始长度: String(before).length,
        首个不同: (() => { for (let i = 0; i < Math.max(String(undone).length, String(before).length); i++) {
          if (String(undone)[i] !== String(before)[i]) return {位置: i, 期望: String(before).slice(i, i + 24), 实际: String(undone).slice(i, i + 24)}; } return null; })()});
    const back = await state(session);
    rec.bump('E2 撤销后光标可见', !back.可见, {轮: index, 读数: back});
    console.log(`  [编辑 ${index}] 在 y=${at.y}「${at.文本}」打「${标记}」→ 撤销后文档长度 ${String(undone).length}（原始 ${String(before).length}）`);
  }
}

/** 定点诊断：从指定起点连续按方向键，每一步把"这一行能放光标的 x 范围"整条打出来。
 *  用于把电池抓到的可疑读数**收窄成可复现的单点**（探针读数可疑时先量清楚自己的尺子）。 */
async function diag(session, rec, next, rounds, presses) {
  const startY = Number(argOf('starty', '0'));
  const startX = Number(argOf('startx', '0'));
  await session.js(EVAL_IN(`window.__pr.scroll(${Number(argOf('scroll', '0')).toFixed(3)})`));
  await sleep(300);
  const point = (startX && startY) ? {x: startX, y: startY} : await pointOf(session, next, '诊断起点');
  if (!point) return;
  const box = await frame(session);
  await session.click(box.x + point.x, box.y + point.y);
  await sleep(320);
  const start = await state(session);
  console.log(`  [诊断] 起点 (${point.x},${point.y}) → 光标 x=${start.x} y=${start.y} 层=${start.层}「${start.文本}」`);
  for (const 行y of String(argOf('scany', '')).split(',').filter(Boolean)) {
    console.log(`    第 y=${行y} 行的逐个落点：` + JSON.stringify(await session.js(EVAL_IN(`window.__pr.scanLine(${Number(行y)})`))));
  }
  // 同一行、光标在别处时再扫一次：行内落点会不会**因为光标在不在这一行而变**？
  const after = String(argOf('scanyafter', ''));
  if (after) {
    for (const pair of after.split(';').filter(Boolean)) {
      const [ax, ay] = pair.split(',').map(Number);
      const box2 = await frame(session);
      await session.click(box2.x + ax, box2.y + ay);
      await sleep(340);
      const 位 = await state(session);
      console.log(`    光标移到 (${ax},${ay})「${位.文本}」后，同一行：`
        + JSON.stringify(await session.js(EVAL_IN(`window.__pr.scanLine(${Number(argOf('scany', '125'))})`))));
    }
  }
  console.log('    焦点：' + JSON.stringify(await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
    const inner = w.document.activeElement;
    return {顶层活动元素: document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : null,
      帧内活动元素: inner ? inner.tagName + '.' + String(inner.className).split(' ')[0] : null,
      帧有焦点: w.document.hasFocus(), 顶层有焦点: document.hasFocus()}; })()`)));
  console.log('    版本标记：' + JSON.stringify(await session.js(`(() => {
    const w = document.getElementById('editor').contentWindow;
    const pick = win => ({build: win.__vertBuild || null, keys: win.__vertKeys || 0, arrows: win.__vertArrows || 0,
      noBox: win.__vertNoBox || 0, box: win.__vertBox || 0, scan: win.__vertScan || [], err: win.__vertErr || null,
      pl: (win.__pl || []).length, 有编辑面: !!win.document.querySelector(${SURFACE}), 焦点在同一窗口: win.document.hasFocus()});
    return {顶层: pick(window), 编辑器: pick(w), 顶层选区: String(window.getSelection() && window.getSelection().toString()).slice(0, 20),
      编辑器选区: String(w.getSelection() && w.getSelection().toString()).slice(0, 20)}; })()`)));
  console.log('    起点行扫描：' + JSON.stringify(await session.js(EVAL_IN('window.__pr.diagnose()'))));
  // 键事件到底进了哪个窗口：两处各挂一个计数监听，再读数（分不清就不要猜）
  await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
    window.__kTop = 0; w.__kFrame = 0; w.__kFrameDoc = 0;
    window.addEventListener('keydown', () => { window.__kTop += 1; }, true);
    w.addEventListener('keydown', () => { w.__kFrame += 1; }, true);
    w.document.addEventListener('keydown', () => { w.__kFrameDoc += 1; }, true);
    return 1; })()`);
  const key = argOf('dir', 'down') === 'down' ? 'ArrowDown' : 'ArrowUp';
  await session.js(EVAL_IN('window.__vtrace = []'));
  for (let step = 1; step <= presses; step++) {
    const now = await press(session, key);
    const detail = await session.js(EVAL_IN('window.__pr.diagnose()'));
    const pl = await session.js(EVAL_IN('(() => { const rows = window.__pl || []; return rows.slice(-2); })()'));
    const trace = await session.js(EVAL_IN('(window.__vtrace || []).slice(-10)'));
    const where = await session.js(`(() => { const w = document.getElementById('editor').contentWindow;
      return {顶层: window.__kTop || 0, 帧窗: w.__kFrame || 0, 帧文档: w.__kFrameDoc || 0}; })()`);
    console.log(`    ${key === 'ArrowDown' ? '↓' : '↑'}${step} x=${now.x} y=${now.y} 层=${now.层} 左=${now.行左缘} 右=${now.行右缘}「${now.文本}」`);
    console.log('       三拍：' + JSON.stringify(pl) + '  键去了：' + JSON.stringify(where));
    console.log('       轨迹：' + JSON.stringify(trace));
    console.log('       ' + JSON.stringify(detail));
  }
}

/** 视觉验收：**截图**为准（用户 2026-09-18 令："最后所有验收必须要靠截图，尤其是截清楚光标位置
 *  以及选中高亮情况"）。每一拍画三个标记后抓图：红实线＝光标落点、琥珀虚线＝目标列、
 *  青虚线＝这一行应有的列（钳制后）。图上能直接看出"光标在不在、列对不对、选区亮不亮"。
 *  落点隐形（0×0）时标记画不出来——那正是"光标没了"的视觉证据。 */
async function shotAround(session, name, anchorY, marks) {
  const box = await frame(session);
  const surfaceBox = await session.js(EVAL_IN('(() => { const s = window.__pr.surface(); const r = s.getBoundingClientRect(); return {x: Math.round(r.left), w: Math.round(r.width)}; })()'));
  const clip = {x: box.x + Math.max(0, surfaceBox.x - 8), y: box.y + Math.max(0, anchorY - 60), width: Math.min(940, surfaceBox.w + 16), height: 200, scale: 2};
  if (marks && marks.length) await session.js(EVAL_IN(`window.__pr.mark(${JSON.stringify(marks)})`));
  const result = await session.send('Page.captureScreenshot', {format: 'png', clip});
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  await session.js(EVAL_IN('window.__pr.unmark()'));
  return {file: name + '.png', clip};
}

/** 点击之后**确认真焦点落在编辑器里**——不然方向键会被别的元素吃掉，
 *  整轮读数全是假的（实测：焦点不在编辑器时，按 ↓ 也"动了"，但没有任何 keydown 进 iframe）。 */
const ensureFocus = async session => {
  const probe = `(() => { const w = document.getElementById('editor').contentWindow;
    const at = w.document.activeElement;
    return {帧有焦点: w.document.hasFocus(), 编辑器元素: !!(at && at.closest && at.closest('.vditor-ir'))}; })()`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const state_ = await session.js(probe);
    if (state_.帧有焦点 && state_.编辑器元素) return {ok: true, ...state_};
    if (attempt === 3) return {ok: false, ...state_};
    await sleep(200);
  }
  return {ok: false};
};

/** 视觉段：随机起点连续 ↓（或 ↑），每一拍抓一张带标记的 2 倍放大图，写成 manifest 供人眼判。 */
async function visual(session, rec, next, rounds, presses) {
  const shots = [];
  const fixedY = Number(argOf('starty', '0'));
  const fixedX = Number(argOf('startx', '0'));
  for (let round = 1; round <= rounds; round++) {
    let point = null;
    if (fixedX && fixedY) point = {x: fixedX, y: fixedY};
    else {
      await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
      await sleep(260);
      point = await pointOf(session, next, '视觉起点');
    }
    if (!point) continue;
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(320);
    { const focus = await ensureFocus(session); if (!focus.ok) { rec.bump('W0 焦点在编辑器里', true, {读数: focus}); continue; } }
    const focus = await ensureFocus(session);
    rec.bump('W0 焦点在编辑器里', !focus.ok, {轮: round, focus});
    if (!focus.ok) continue;
    const start = await state(session);
    if (!start.可见) { rec.bump('W1 起点光标可见', true, {轮: round, 读数: start}); continue; }
    const goal = start.x;
    const 目标线 = {x: goal, y: start.y, h: 0, dash: true, color: '#f0a020', label: '目标列', extend: 3000};
    // 起点一张
    shots.push({轮: round, 步: 0, 期望列: goal, 实际列: start.x,
      ...(await shotAround(session, `r${round}-0-起点`, start.y, [目标线,
        {x: start.x, y: start.y, h: start.高, color: '#ff2d2d', label: '光标'}])),
      层: start.层, 文本: start.文本});
    let last = start;
    for (let step = 1; step <= presses; step++) {
      const now = await press(session, 'ArrowDown');
      const pl = await session.js(EVAL_IN('(() => { const rows = window.__pl || []; return rows[rows.length - 1] || null; })()'));
      const 期望 = (now.行左缘 === null || now.行右缘 === null) ? null : Math.max(now.行左缘, Math.min(goal, now.行右缘));
      const 偏 = 期望 === null ? null : Math.abs(now.x - 期望);
      const 出问题 = !now.可见 || (偏 !== null && 偏 > 字宽(now));
      if (出问题) rec.bump('W2 视觉拍到的偏离', true, {轮: round, 步: step, 期望列: 期望, 实际列: now.x, 层: now.层, 文本: now.文本, 三拍: pl});
      const 拍 = step <= 4 || 出问题;
      if (拍) {
        shots.push({轮: round, 步: step, 期望列: 期望, 实际列: now.x, 偏差: 偏, 三拍: pl,
          ...(await shotAround(session, `r${round}-${step}-${出问题 ? '偏离' : '下行'}`, now.y, [目标线,
            {x: now.x, y: now.y, h: now.高, color: '#ff2d2d', label: '光标'}]))
            , 层: now.层, 文本: now.文本, 可见: now.可见, 行左缘: now.行左缘, 行右缘: now.行右缘});
      }
      last = now;
    }
    console.log(`  [视觉 ${round}] 起点「${start.文本}」列${goal} → 走到 y=${last.y}；抓图 ${shots.filter(item => item.轮 === round).length} 张`);
    console.log('    补丁计数：' + JSON.stringify(await session.js(EVAL_IN(`({build: window.__vertBuild || null, keys: window.__vertKeys || 0,
      arrows: window.__vertArrows || 0, noBox: window.__vertNoBox || 0, box: window.__vertBox || 0,
      scan: (window.__vertScan || []).join(','), err: window.__vertErr || null, pl: (window.__pl || []).length})`))));
  }
  fs.writeFileSync(path.join(OUT, 'visual-manifest.json'), JSON.stringify(shots, null, 2), 'utf8');
  console.log(`  视觉清单：${path.join(OUT, 'visual-manifest.json')}（${shots.length} 张）`);
  for (const item of shots) console.log(`    · ${item.file}  期望列=${item.期望列} 实际列=${item.实际列} 层=${item.层}「${item.文本}」`);
}

/** 点击/拖拽的**视觉**验收：把"点在哪"和"光标/选区落在哪"画在同一张图上，由人眼判。
 *  数值口径在标题行这类"点下去会重排"的地方有歧义（实测点 x=150 → 光标读数 190），
 *  图上直接看"光标是不是停在我点的那两个字之间"最快。 */
async function visualclick(session, rec, next, rounds) {
  const 标记 = (x, y, 标签, 颜色) => ({x, y, h: 20, dash: true, color: 颜色, label: 标签});
  const 首 = {x: Number(argOf('startx', '260')), y: Number(argOf('starty', '420'))};
  const 尾 = {x: Number(argOf('endx', '700')), y: Number(argOf('endy', '470'))};
  const box = await frame(session);
  const before = await state(session);
  console.log('  点击前状态：' + JSON.stringify({x: before.x, y: before.y, 层: before.层, 文本: before.文本}));
  await shotAround(session, 'click-0-点击前', 首.y, [标记(首.x, 首.y - 10, '要点这里', '#25d0ff')]);
  await session.click(box.x + 首.x, box.y + 首.y);
  await sleep(340);
  const after = await state(session);
  console.log('  单击后光标：' + JSON.stringify({x: after.x, y: after.y, 层: after.层, 文本: after.文本}));
  await shotAround(session, 'click-1-单击后', after.y || 首.y, [
    标记(首.x, 首.y - 10, '点的位置', '#25d0ff'),
    {x: after.x, y: after.y, h: after.高, color: '#ff2d2d', label: '光标'},
  ]);
  const 滚动前 = await session.js(EVAL_IN('window.__pr.scrollY()'));
  const from = {x: box.x + 首.x, y: box.y + 首.y}, to = {x: box.x + 尾.x, y: box.y + 尾.y};
  await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x, y: from.y, buttons: 0});
  await sleep(50);
  await session.send('Input.dispatchMouseEvent', {type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1});
  await sleep(60);
  for (let index = 1; index <= 8; index++) {
    await session.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
      x: Math.round(from.x + (to.x - from.x) * index / 8), y: Math.round(from.y + (to.y - from.y) * index / 8), button: 'left', buttons: 1});
    await sleep(45);
  }
  await session.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1});
  await sleep(420);
  const 选取 = await state(session);
  const 滚动后 = await session.js(EVAL_IN('window.__pr.scrollY()'));
  console.log(`  拖拽 (${首.x},${首.y}) → (${尾.x},${尾.y})：选中 ${选取.选区长度} 字「${String(选取.选区文本).slice(0, 24)}」 滚动 ${滚动前}→${滚动后}`);
  if (滚动前 === 滚动后) {
    await shotAround(session, 'click-2-拖拽后', 首.y, [
      标记(首.x, 首.y - 10, '按下', '#25d0ff'),
      标记(尾.x, 尾.y - 10, '抬起', '#7cff2d'),
    ]);
  } else console.log('  拖拽期间滚动了，跳过拖拽截图（视口尺子已变）');
}

/** 给编辑器 iframe 装"选区改写者"埋点：把 Selection 的三个写入口换成带**调用栈**的代理，
 *  并把 selectionchange 记成时间线（含每一步的长度）。用法：`--trace`（见 selstep 尾部）。 */
const 装选区埋点 = `(() => {
  if (window.__selTrace) { window.__selTrace.acts.length = 0; window.__selTrace.log.length = 0; return 'reuse'; }
  const trace = window.__selTrace = {acts: [], log: [], t0: performance.now()};
  const 名 = node => { if (!node) return 'null';
    if (node.nodeType === 3) return '#' + String(node.data).slice(0, 10);
    const cls = (typeof node.className === 'string' ? node.className : '').split(' ').filter(Boolean).slice(0, 2).join('.');
    return node.nodeName + (cls ? '.' + cls : '') + (node.getAttribute && node.getAttribute('data-type') ? '[' + node.getAttribute('data-type') + ']' : ''); };
  for (const method of ['removeAllRanges', 'addRange', 'setBaseAndExtent', 'collapse', 'extend']) {
    const orig = window.Selection.prototype[method];
    if (typeof orig !== 'function') continue;
    window.Selection.prototype[method] = function (...args) {
      let stack = '';
      try { stack = String(new Error().stack).split('\\n').slice(1, 4).map(line => line.trim().replace(/^at\\s+/, '')).join(' | ').slice(0, 260); } catch {}
      trace.acts.push({t: Math.round(performance.now() - trace.t0), m: method,
        args: args.map(a => (a && a.nodeType ? 名(a) : String(a).slice(0, 20))), stack});
      return orig.apply(this, args);
    };
  }
  window.document.addEventListener('selectionchange', () => {
    const s = window.getSelection(); const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    trace.log.push({t: Math.round(performance.now() - trace.t0), 长度: r && !r.collapsed ? r.toString().length : 0});
  }, true);
  return 'installed'; })()`;

/** 选中逐步诊断（--section=selstep）：从定点开始按住 shift 连按方向键，
 *  每一步把"选区长度 + 两个端点在哪个节点上 + 有没有公式被展开"全打出来，
 *  用来看清"选区在哪一步、被谁重置"。
 *  `--trace` 再加一层：Selection 写入口的代理（带栈）+ selectionchange 时间线，
 *  一旦某一步塌了，把那一拍的**改写者**连栈一起打出来（遗留 #3 的定位手段）。 */
async function selstep(session, rec, next, rounds, presses) {
  const 起点 = {x: Number(argOf('startx', '0')), y: Number(argOf('starty', '0'))};
  const 键 = argOf('dir', 'right') === 'right' ? 'ArrowRight' : 'ArrowLeft';
  const 修饰 = harness.MOD.shift;
  const 追踪 = has('trace');
  if (!起点.x || !起点.y) { console.log('  [选中步进] 需要 --startx/--starty'); return; }
  const box = await frame(session);
  await session.click(box.x + 起点.x, box.y + 起点.y);
  await sleep(320);
  const 焦点 = await ensureFocus(session);
  console.log('  起点 (' + 起点.x + ',' + 起点.y + ') 焦点在编辑器：' + 焦点.ok);
  const 现场 = `(() => { const w = window, d = document;   // 这段在编辑器 iframe 里求值
    const s = w.getSelection();
    if (!s.rangeCount) return {无选区: true};
    const r = s.getRangeAt(0);
    const 看 = node => { const at = node && node.nodeType === 3 ? node.parentElement : node;
      if (!at) return null;
      const 块 = at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre') : null;
      return {标签: at.tagName || String(at.nodeName), 类: String(at.className || '').split(' ')[0] || null,
        数据类型: at.getAttribute ? at.getAttribute('data-type') : null,
        所在块: 块 ? String(块.textContent || '').replace(/\\s+/g, ' ').slice(0, 16) : null}; };
    const 展开的公式节点 = [...d.querySelectorAll('.vditor-ir__node--expand')].map(node => String(node.textContent || '').replace(/\\s+/g, ' ').slice(0, 24));
    return {长度: r.collapsed ? 0 : r.toString().length, 折叠: r.collapsed,
      文本: r.collapsed ? '' : r.toString().replace(/\\s+/g, ' ').slice(0, 28),
      起点: 看(r.startContainer), 终点: 看(r.endContainer), 展开的节点: 展开的公式节点}; })()`;
  console.log('  起点读数：' + JSON.stringify(await session.js(EVAL_IN(现场))));
  if (追踪) {
    console.log('  选区埋点：' + await session.js(EVAL_IN(装选区埋点)));
  }
  let 上一步长度 = null;
  for (let step = 1; step <= presses; step++) {
    if (追踪) {
      // 每一步只看**这一步**产生的动作：先清空，按键，再看这一拍是谁写的（栈带文件行号）
      await session.js(EVAL_IN("(() => { const t = window.__selTrace; if (t) { t.acts.length = 0; t.log.length = 0; } return 1; })()"));
    }
    await session.key({key: 键, code: 键, vk: 键 === 'ArrowRight' ? 39 : 37, modifiers: 修饰});
    await sleep(280);
    const 读 = await session.js(EVAL_IN(现场));
    console.log(`  ${step} 长度=${读.长度} 折叠=${读.折叠} 文本「${读.文本}」`);
    console.log(`     起点 ${JSON.stringify(读.起点)}  终点 ${JSON.stringify(读.终点)}`);
    if (读.展开的节点 && 读.展开的节点.length) console.log('     展开的节点：' + JSON.stringify(读.展开的节点));
    if (追踪) {
      // 塌了（本步长度 0 或比上一步小）→ 打印这一拍的改写者；没塌只留一行摘要
      const 塌 = 读.长度 === 0 || (上一步长度 !== null && 读.长度 < 上一步长度);
      if (塌) {
        const 轨 = await session.js(EVAL_IN("(() => { const t = window.__selTrace; return t ? {acts: t.acts.slice(0, 12), log: t.log.slice(0, 16)} : null; })()"));
        console.log(`     ✗ 第 ${step} 步塌/缩（前一步 ${上一步长度} → ${读.长度}）：这一拍的 Selection 写入口——`);
        for (const 项 of (轨?.acts || [])) console.log('        ' + JSON.stringify(项));
        console.log('     selectionchange 时间线：' + JSON.stringify(轨?.log || []));
      }
    }
    上一步长度 = 读.长度;
  }
  // **决定性 A/B**：选区此刻正盖着公式源码，按一个纯修饰键（只触发 onKey、不动选区），
  // 看选区会不会被收回源码夹掉。修复前这里必然塌（L2 << L1），修复后 L2 == L1。
  const 埋点 = await session.js(EVAL_IN("(window.__hideLog || []).slice(-12)"));
  console.log("  [hide 埋点] 走这一趟里被收回的公式：" + JSON.stringify(埋点));
  const 前 = await session.js(EVAL_IN(现场));
  await session.key({key: "Shift", code: "ShiftLeft", vk: 16});
  await sleep(500);
  const 后 = await session.js(EVAL_IN(现场));
  console.log(`  [修饰键 A/B] 按 Shift 前长度=${前.长度} → 后长度=${后.长度}`
    + (后.长度 < 前.长度 ? "  ✗ 选区被夹掉了（onKey 的 dropAll 把盖着选区的源码收回去了）" : "  ✓ 选区保住"));
}

/** Home / End / Ctrl+Home / Ctrl+End 段（--section=keys）：
 *  用户说的"首位不闭合"就是这组键的行为。判据用用户能看见的性质：
 *   · Home 之后光标应贴在这一行的**行首可用位置**（≥ 行左缘，差 ≤ 一个字）；
 *   · End 之后应贴在**行尾可用位置**（≤ 行右缘，差 ≤ 一个字）；
 *   · End 再 Home 应回到该行行首（同一行、列对得上）；
 *   · Home 再 ← 应去**上一行的行尾**；End 再 → 应去下一行的行首；
 *   · Ctrl+Home / Ctrl+End 之后光标必须可见，且落在文档首/末一行。
 *  每次都断言光标可见（0×0 = "光标没了"）。 */
async function keys(session, rec, next, rounds, presses) {
  for (let round = 1; round <= rounds; round++) {
    await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
    await sleep(240);
    const point = await pointOf(session, next, '点');
    if (!point) continue;
    const box = await frame(session);
    await session.click(box.x + point.x, box.y + point.y);
    await sleep(320);
    const start = await state(session);
    if (!start.可见) { rec.bump('K0 起点光标可见', true, {轮: round, 点: point, 读数: start}); continue; }
    const 键 = async (name, vk) => { await session.key({key: name, code: name, vk}); await sleep(260); return state(session); };

    // Home：贴行首
    const home = await 键('Home', 36);
    rec.bump('K1 Home 后光标可见', !home.可见, {轮: round, 起点: start, 读数: home});
    if (home.可见 && home.行左缘 !== null) {
      rec.bump('K1 Home 贴行首', Math.abs(home.x - home.行左缘) > 字宽(home) && home.x > home.行左缘 + 字宽(home),
        {轮: round, 行左缘: home.行左缘, 落点: home.x, 起点: {x: start.x, y: start.y}, 读数: {y: home.y, 层: home.层, 行文本: home.文本}});
    }
    // End：贴行尾
    const end = await 键('End', 35);
    rec.bump('K2 End 后光标可见', !end.可见, {轮: round, 读数: end});
    if (end.可见 && end.行右缘 !== null) {
      rec.bump('K2 End 贴行尾', Math.abs(end.x - end.行右缘) > 字宽(end) && end.x < end.行右缘 - 字宽(end),
        {轮: round, 行右缘: end.行右缘, 落点: end.x, 读数: {y: end.y, 层: end.层, 行文本: end.文本}});
    }
    // End 再 Home：回到同一行行首
    const back = await 键('Home', 36);
    rec.bump('K3 End→Home 回到行首', !back.可见 || Math.abs(back.y - start.y) > Math.max(start.高 || 18, 18) * 1.6 + 6
      || Math.abs(back.x - (back.行左缘 === null ? back.x : back.行左缘)) > 字宽(back),
      {轮: round, 起点: {x: start.x, y: start.y}, End后: {x: end.x, y: end.y}, Home后: {x: back.x, y: back.y}, 行左缘: back.行左缘});

    // Home 再 ←：去上一行行尾
    const 左 = await 键('ArrowLeft', 37);
    rec.bump('K4 Home 后 ← 光标可见', !左.可见, {轮: round, 读数: 左});
    if (左.可见) {
      const 上有行 = await session.js(EVAL_IN('window.__pr.hasLineBeyond(' + Math.round(back.y) + ', false)'));
      if (!上有行) {
        // 文档第一行的行首：习惯上就是不动，但绝不能钻进标记里（层=围栏）
        rec.bump('K4 首行行首 ← 不动且不进标记', 左.层 === '围栏' || Math.abs(左.x - back.x) > 字宽(back),
          {轮: round, Home后: {x: back.x, y: back.y}, 左移后: {x: 左.x, y: 左.y, 层: 左.层}});
      } else {
        rec.bump('K4 Home 后 ← 去上一行行尾', Math.abs(左.y - back.y) <= Math.max(back.高 || 18, 18) * 0.4,
          {轮: round, Home后: {x: back.x, y: back.y}, 左移后: {x: 左.x, y: 左.y, 层: 左.层, 行文本: 左.文本}});
      }
    }
    // End 再 →：去下一行行首
    await 键('End', 35);
    const 右 = await 键('ArrowRight', 39);
    rec.bump('K5 End 后 → 光标可见', !右.可见, {轮: round, 读数: 右});

    // Ctrl+Home / Ctrl+End
    await session.key({key: 'Home', code: 'Home', vk: 36, modifiers: harness.MOD.ctrl});
    await sleep(420);
    const 首 = await state(session);
    rec.bump('K6 Ctrl+Home 光标可见', !首.可见, {轮: round, 读数: 首});
    await session.key({key: 'End', code: 'End', vk: 35, modifiers: harness.MOD.ctrl});
    await sleep(420);
    const 末 = await state(session);
    rec.bump('K7 Ctrl+End 光标可见', !末.可见, {轮: round, 读数: 末});
    const 比 = await session.js(EVAL_IN(`window.__pr.linesBetween(${Math.round(首.y)}, ${Math.round(末.y)})`));
    console.log(`  [首尾 ${round}] 起点 y=${start.y} → Ctrl+Home y=${首.y} → Ctrl+End y=${末.y}（中间还有 ${(比 || []).length} 条行带）`);
    if ((比 || []).length === 0) rec.bump('K7 首末不是同一行', true, {轮: round, 首: 首.y, 末: 末.y});
  }
}

/** 首尾键诊断（--section=endkeys）：Ctrl+Home / Ctrl+End / Home / End 之后，
 *  把光标的**容器、层、矩形、所在块**全打出来，并抓一张带标记的局部图。
 *  用来判"光标到底落在哪个节点上、为什么看不见"。 */
async function endkeys(session, rec, next, rounds, presses) {
  const 细节 = `(() => { const w = window, d = document;
    const s = w.getSelection();
    if (!s.rangeCount) return {无选区: true};
    const r = s.getRangeAt(0);
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const box = r.getBoundingClientRect();
    const 层 = at.closest && at.closest('code[data-type]') ? '源码'
      : at.closest && at.closest('.vditor-ir__preview') ? '预览'
      : at.closest && at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
    const 块 = at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre') : null;
    const 根 = d.querySelector('.vditor-ir .vditor-reset');
    const 全部 = 根 ? [...根.children] : [];
    return {层, 容器: at.tagName + '.' + String(at.className || '').split(' ')[0],
      类型: at.getAttribute ? at.getAttribute('data-type') : null,
      可见: !!(box && box.height), 矩形: {x: Math.round(box.left), y: Math.round(box.top), 高: Math.round(box.height)},
      偏移: r.startOffset, 文本节点长: r.startContainer.nodeType === 3 ? r.startContainer.data.length : null,
      所在块: 块 ? String(块.textContent || '').replace(/\\s+/g, ' ').slice(0, 24) : null,
      块序号: 块 ? 全部.indexOf(块) : null, 块总数: 全部.length,
      块末尾: 块 ? String(块.textContent || '').replace(/\\s+/g, ' ').slice(-16) : null}; })()`;
  const box = await frame(session);
  const 点 = {x: Number(argOf('startx', '300')), y: Number(argOf('starty', '300'))};
  await session.click(box.x + 点.x, box.y + 点.y);
  await sleep(320);
  console.log('  起点细节：' + JSON.stringify(await session.js(EVAL_IN(细节))));
  const 按 = async (name, vk, 修饰) => {
    await session.key({key: name, code: name, vk, modifiers: 修饰 || 0});
    await sleep(420);
    const 读 = await session.js(EVAL_IN(细节));
    console.log(`  ${name}${修饰 ? '（Ctrl）' : ''} → ` + JSON.stringify(读));
    return 读;
  };
  await 按('End', 35);
  await 按('Home', 36);
  await 按('Home', 36);                    // 连按两次：第二次应去逻辑行首（Typora/VS Code 习惯）
  const 末 = await 按('End', 35, harness.MOD.ctrl);
  await 按('Home', 36, harness.MOD.ctrl);
  const 首 = await 按('End', 35, harness.MOD.ctrl);
  // 抓图：把 Ctrl+End 之后的光标位置画出来（隐形就画不出标记，那张图本身就是证据）
  const spot = (末 && 末.矩形 && 末.矩形.高) ? 末.矩形 : (首 && 首.矩形 ? 首.矩形 : null);
  if (spot) await shotAround(session, 'endkeys-CtrlEnd', spot.y, [{x: spot.x, y: spot.y, h: spot.高, color: '#ff2d2d', label: 'Ctrl+End'}]);
  else console.log('  Ctrl+End 之后没有可见矩形：标记画不出来（"光标没了"的视觉证据）');
}

/** 导航键逐步诊断（--section=navdetail --seq=Home,ArrowLeft,ArrowLeft）：
 *  按给定序列逐个按键，每一步把**光标的容器/偏移/层/矩形**打出来。
 *  用来回答"某一次按键之后，光标到底落在哪个 DOM 位置、为什么看不见"。 */
async function navdetail(session, rec, next, rounds, presses) {
  const 细节 = `(() => { const w = window, d = document;
    const s = w.getSelection();
    if (!s.rangeCount) return {无选区: true};
    const r = s.getRangeAt(0);
    const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const box = r.getBoundingClientRect();
    const 层 = at.closest && at.closest('code[data-type]') ? '源码'
      : at.closest && at.closest('.vditor-ir__preview') ? '预览'
      : at.closest && at.closest('[data-type$="-marker"]') ? '围栏' : '正文';
    const 块 = at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre') : null;
    return {层, 容器: at.tagName + '.' + String(at.className || '').split(' ')[0],
      类型: at.getAttribute ? at.getAttribute('data-type') : null,
      可见: !!(box && box.height), 矩形: {x: Math.round(box.left), y: Math.round(box.top), 高: Math.round(box.height)},
      偏移: r.startOffset, 容器是文本: r.startContainer.nodeType === 3,
      文本长: r.startContainer.nodeType === 3 ? r.startContainer.data.length : null,
      子节点数: r.startContainer.childNodes ? r.startContainer.childNodes.length : null,
      所在块: 块 ? String(块.textContent || '').replace(/\\s+/g, ' ').slice(0, 22) : null}; })()`;
  const 序号 = String(argOf('seq', 'Home,ArrowLeft,ArrowLeft')).split(',').filter(Boolean);
  const 点 = {x: Number(argOf('startx', '300')), y: Number(argOf('starty', '300'))};
  const box = await frame(session);
  await session.click(box.x + 点.x, box.y + 点.y);
  await sleep(340);
  const 起点读 = await session.js(EVAL_IN(细节));
  console.log('  起点 (' + 点.x + ',' + 点.y + ')：' + JSON.stringify(起点读));
  if (!起点读.可见) console.log('  ⚠ 起点（点击之后）就是隐形落点：容器=' + 起点读.容器 + ' 偏移=' + 起点读.偏移 + ' 容器是文本=' + 起点读.容器是文本);
  const VK = {Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40};
  for (const name of 序号) {
    await session.key({key: name, code: name, vk: VK[name] || 0});
    await sleep(420);
    const 读 = await session.js(EVAL_IN(细节));
    console.log('  ' + name + ' → ' + JSON.stringify(读));
    if (!读.可见) {
      const 邻近 = await session.js(EVAL_IN(`(() => { const w = window, d = document;
        const s = w.getSelection(); const r = s.getRangeAt(0);
        const at = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
        const 块 = at.closest ? at.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre') : at;
        const 前 = 块 ? 块.previousElementSibling : null;
        let 前文本 = null;
        if (前) { const 走 = d.createTreeWalker(前, NodeFilter.SHOW_TEXT); const 集 = [];
          while (走.nextNode()) 集.push(走.currentNode);
          const 尾 = 集.filter(node => node.data.replace(/\\s/g, '')).pop();
          if (尾) { const rg = d.createRange(); rg.setStart(尾, 尾.data.length); rg.collapse(true);
            前文本 = {文本尾: 尾.data.slice(-12), 矩形: (() => { const b = rg.getBoundingClientRect(); return {x: Math.round(b.left), y: Math.round(b.top), 高: Math.round(b.height)}; })()}; } }
        return {同块还有子节点: !!块 && 块.childNodes.length, 块文本尾: 块 ? String(块.textContent || '').slice(-14) : null, 上一块的行尾落点: 前文本}; })()`));
      console.log('     隐性落点现场：' + JSON.stringify(邻近));
    }
  }
}

/** 合成光标单独看图（--section=shotproxy --startx --starty）：
 *  点一下制造"画不出 caret"的落点，然后**不带任何标记**地 3 倍放大截取光标附近，
 *  直接看那条合成竖线在不在、位置对不对（用户令：光标位置必须靠截图看清）。 */
async function shotproxy(session, rec, next, rounds, presses) {
  const 点 = {x: Number(argOf('startx', '700')), y: Number(argOf('starty', '458'))};
  const box = await frame(session);
  await session.click(box.x + 点.x, box.y + 点.y);
  await sleep(400);
  const 读 = await session.js(EVAL_IN(`(() => { const 代理 = document.querySelector('[data-typora-caret-proxy]');
    const s = window.getSelection();
    const r = s.rangeCount ? s.getRangeAt(0) : null;
    const 框 = r ? r.getBoundingClientRect() : null;
    return {合成光标显示: !!(代理 && 代理.style.display === 'block'),
      代理: 代理 ? (() => { const b = 代理.getBoundingClientRect(); return {x: Math.round(b.left), y: Math.round(b.top), 高: Math.round(b.height)}; })() : null,
      原生: 框 ? {x: Math.round(框.left), y: Math.round(框.top), 高: Math.round(框.height)} : null,
      折叠: r ? r.collapsed : null, 焦点在编辑器: document.hasFocus()}; })()`));
  console.log('  点位 (' + 点.x + ',' + 点.y + ')：' + JSON.stringify(读));
  if (!读.合成光标显示 || !读.代理) { console.log('  合成光标没显示，没什么可截的'); return; }
  const 面 = await session.js(EVAL_IN('(() => { const s = document.querySelector(".vditor-ir .vditor-reset"); const r = s.getBoundingClientRect(); return {x: Math.round(r.left), w: Math.round(r.width)}; })()'));
  const clip = {x: box.x + Math.max(0, 读.代理.x - 260), y: box.y + Math.max(0, 读.代理.y - 40), width: Math.min(700, 面.w), height: 120, scale: 3};
  const result = await session.send('Page.captureScreenshot', {format: 'png', clip});
  const file = path.join(OUT, 'proxy-' + 点.x + '-' + 点.y + '.png');
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log('  合成光标截图：' + file + '（光标应在图内 x≈' + Math.round((读.代理.x - Math.max(0, 读.代理.x - 260)) * 3) + ' 处）');
}

(async () => {

  // 每轮跑进**自己的子目录**：证据（截图/manifest/报告）要留得住——原来的写法每次开跑先清空 OUT，
  // 上一轮的验收图会被这一轮抹掉（"验收要回头看图"的规矩经不起这个）。
  const RUN = path.join(OUT, "run-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  fs.mkdirSync(RUN, {recursive: true});
  OUT = RUN;
  const want = argOf('doc', 'both');
  const sections = argOf('section', 'all') === 'all'
    ? ['vertical', 'horizontal', 'select', 'mouse', 'combo', 'edit']
    : argOf('section', 'all').split(',');
  const rounds = Number(argOf('rounds', '5'));
  const presses = Number(argOf('presses', '18'));
  const seed0 = Number(argOf('seed', '20260918'));
  const next = rng(seed0);
  const rec = makeRecorder();
  const report = {seed: seed0, rounds, presses, docs: {}};
  for (const key of Object.keys(DOCS)) {
    if (want !== 'both' && want !== key) continue;
    const spec = DOCS[key];
    if (!fs.existsSync(spec.file)) { console.log(`跳过 ${spec.name}：找不到 ${spec.file}`); continue; }
    const copy = path.join(OUT, `${key}-${spec.name}.md`);
    fs.copyFileSync(spec.file, copy);
    const originalSha = harness.fileSha(spec.file);
    console.log(`\n=== ${spec.name}（${Math.round(fs.statSync(copy).size / 1024)} KB，副本 ${copy}）===`);
    const session = await harness.launch({
      exe: path.join(project, 'node_modules/electron/dist/electron.exe'),
      appArgs: [path.join(project, 'app/main/main.js')],
      label: `probe-real-ops-${key}`, outDir: OUT, args: [copy], timeout: 1800000, inspect: true,
    });
    try {
      const ready = await session.until(`(() => { const w = ${IF}; return !!(w && w.document.querySelector(${SURFACE})); })()`,
        {timeout: 240000, interval: 100});
      if (!ready) { console.log(`  ${spec.name} 打开超时，跳过`); await session.close(); continue; }
      await sleep(2500);
      const installed = await install(session);
      if (!installed) { console.log(`  ${spec.name} 工具装载失败，跳过`); await session.close(); continue; }
      const initial = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
      const lines = await session.js(EVAL_IN('(() => { const s = window.__pr.surface(); return s ? s.children.length : 0; })()'));
      console.log(`  配方：${sections.join(',')}；顶层块 ${lines} 个；初始长度 ${String(initial).length} 字符`);
      // **段间隔离**：上一段可能把光标留在文档末尾/某个展开的公式里（Home/End/Ctrl+End 段尤其如此），
      // 下一段的第一次读数就会撞在别人留下的状态上（实测 doc B 上曾让纵向 V2 整段读成"按了不动"）。
      // 每段开跑前重新滚一次、点一个可编辑点、等布局稳定；这一段不计入任何判据。
      const 段间隔离 = async label => {
        await session.js(EVAL_IN(`window.__pr.scroll(${next().toFixed(3)})`));
        await sleep(260);
        const 点 = await pointOf(session, next, label + " 的隔离开场");
        if (!点) return;
        const 框 = await frame(session);
        await session.click(框.x + 点.x, 框.y + 点.y);
        await sleep(320);
        await ensureFocus(session);
        await sleep(200);
      };
      for (const section of sections) {
        console.log(`  · 开始 ${section}`);
        await 段间隔离(section);
        try {
          if (section === 'vertical') await vertical(session, rec, next, rounds, presses);
          else if (section === 'visual') await visual(session, rec, next, Math.max(1, rounds), presses);
          else if (section === 'diag') await diag(session, rec, next, rounds, presses);
          else if (section === 'visualclick') await visualclick(session, rec, next, rounds);
          else if (section === 'selstep') await selstep(session, rec, next, rounds, presses);
          else if (section === 'keys') await keys(session, rec, next, rounds, presses);
          else if (section === 'endkeys') await endkeys(session, rec, next, rounds, presses);
          else if (section === 'navdetail') await navdetail(session, rec, next, rounds, presses);
          else if (section === 'shotproxy') await shotproxy(session, rec, next, rounds, presses);
          else if (section === 'horizontal') await horizontal(session, rec, next, rounds, presses);
          else if (section === 'select') await select(session, rec, next, rounds, Math.min(presses, 12));
          else if (section === 'mouse') await mouse(session, rec, next, Math.max(2, Math.round(rounds / 2)));
          else if (section === 'combo') await combo(session, rec, next, Math.max(2, Math.round(rounds / 2)));
          else if (section === 'edit') await edit(session, rec, next, rounds);
        } catch (error) {
          console.log(`  ！${section} 段抛错：${String(error && error.message || error).slice(0, 300)}`);
          rec.bump(`${section} 段未跑完`, true, {错误: String(error && error.message || error).slice(0, 300)});
        }
      }
      const finalText = await session.js(`(() => { const w = ${IF}; return w.vditor.getValue(); })()`);
      rec.bump('F 文档未被子测试改写', String(finalText) !== String(initial),
        {初始长度: String(initial).length, 结束长度: String(finalText).length});
      const errors = (session.errors || []).slice(0, 5);
      if (errors.length) console.log('  页面报错：' + JSON.stringify(errors).slice(0, 400));
      report.docs[key] = {name: spec.name, 初始长度: String(initial).length, 结束长度: String(finalText).length,
        原件未动: harness.fileSha(spec.file) === originalSha, 页面报错: errors.length};
      await session.shot(`final-${key}`);
    } finally {
      await session.close();
    }
  }
  console.log('\n=== 汇总 ===');
  for (const row of rec.counters.values()) {
    console.log(`  ${row.失败 ? '✗' : '✓'} ${row.检查}：${row.次数 - row.失败}/${row.次数} 通过`
      + (row.失败 ? `（失败 ${row.失败}）` : '') + (row.提示 ? `（另有 ${row.提示} 次量不出、未判）` : ''));
  }
  if (rec.samples.length) {
    console.log('\n=== 失败样例 ===');
    for (const item of rec.samples) console.log(`  · ${item.检查} ${JSON.stringify(item.详情)}`);
  }
  report.checks = [...rec.counters.values()];
  report.samples = rec.samples;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告：${path.join(OUT, 'summary.json')}`);
  const 失败总数 = [...rec.counters.values()].reduce((sum, row) => sum + row.失败, 0);
  process.exitCode = 失败总数 ? 1 : 0;
})().catch(error => { console.error('probe 失败：', error); process.exit(1); });
