// 手动收纳工具栏（v2.1.28）。
//
// 与 toolbar-autohide.js 的分工：那条是"窗口太矮时自动临时收起、鼠标贴顶弹出"，是环境
// 推着我们做的；这条是用户按下的**持久**状态——收起来只留一个按钮，鼠标贴顶也不弹出，
// 重启后仍然收着（localStorage）。
//
// 摆放：按钮是工具栏自己的最后一项（js/toolbar.js 里的 `toolbar-fold`），不是另起一个
// 浮在编辑区上的元素。理由是"各种布局/缩放都不打架"这件事只有这一种摆法能保证：
//   · 收起前——它就是工具栏浮条的一个普通项，跟着浮条居中/换行走。任何窗口宽度都不会
//     跟浮条自己重叠（右上角、左上角放独立按钮都会在窄窗口被顶到 max-width 的浮条压住），
//     也不会撞大纲栏（大纲栏被 margin-top 推到工具栏带之下）、不会撞右下角的缩放角标、
//     不会撞滚动条（在浮条内部，离右缘还有一圈内边距）。
//   · 收起后——浮条本身改贴右上角（left:auto; right:8px），按钮就落在工具栏带内的右上角：
//     大纲栏在它下面一层、缩放角标在右下角、状态栏在外壳里，谁也不占这块。
//   · 内容缩放（Ctrl+滚轮）只作用于 .vditor-content，工具栏与这个按钮不在其中，所以按钮的
//     大小与位置不随缩放变化。
//
// 动画：两次点击都只有 transform / opacity / visibility 在动，**不收放任何布局**。
//   · 收起：先让其余项与浮条底色淡出（JS 记下按钮此刻的视口位置），150ms 后把其余项
//     display:none、浮条改贴右上角，再把按钮用 FLIP（一次性平移补回去 + 2 帧内归零）
//     滑到新位置——整段是合成器上的平移，不触发重排。
//   · 展开：反过来，先恢复布局再 FLIP。
//   · 每次点击只量两次 getBoundingClientRect（强制两次布局），点击之外不量、不挂
//     mousemove、不挂 ResizeObserver。
const KEY = 'toolbar-collapsed';
const COLLAPSED = 'typora-toolbar-collapsed';   // 用户按下后的持久状态
const TIGHT = 'typora-toolbar-tight';           // 布局真正收拢的那一帧（淡出之后）
const NOANIM = 'typora-toolbar-noanim';         // 启动恢复时压掉动画，别让人看到一次回放
const SETTLE = 140;                             // 与 toolbar-collapse.css 里的淡出时长对齐
const LABEL = {open: '收起工具栏（只留这一个按钮）', shut: '展开工具栏'};

const root = () => document.documentElement;
// 用 data-type 找（vditor 按工具栏项的 name 写这个属性），不依赖 class 落在哪一层
const button = () => document.querySelector('button[data-type="toolbar-fold"]');
const isCollapsed = () => root().classList.contains(COLLAPSED);

/** 两次点击都可能落在上一次动画的半途：先把按钮自身的临时 transform 清干净，
 *  否则量到的是"飞到一半"的位置，FLIP 的起点就错了。 */
const settle = node => {
    if (!node.style.transform) return;
    node.style.transition = 'none';
    node.style.transform = '';
    node.getBoundingClientRect();
    node.style.transition = '';
};

const flip = (node, from) => {
    const to = node.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (!dx && !dy) return;
    node.style.transition = 'none';
    node.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    node.getBoundingClientRect();          // 让起点这一帧真的生效
    node.style.transition = '';            // 交回 CSS 的 .2s
    node.style.transform = '';             // 滑回零位
};

let timer = 0;

const sync = () => {
    const node = button();
    if (!node) return;
    const shut = isCollapsed();
    // 只写 aria：vditor 的 tooltip 是拿 aria-label 画出来的，再写 title 会多出一个原生提示框
    node.setAttribute('aria-expanded', String(!shut));
    node.setAttribute('aria-pressed', String(shut));
    node.setAttribute('aria-label', shut ? LABEL.shut : LABEL.open);
};

/** 唯一的状态入口。instant=true 用于启动恢复：一步到位，不放动画。 */
function apply(collapsed, instant) {
    const state = root();
    const node = button();
    // 两次点击可能落在上一次动画的半途：先把按钮自身的临时 transform 归零，量的才是布局位置
    settle(node);
    const from = instant ? null : node && node.getBoundingClientRect();
    clearTimeout(timer);
    if (instant) {
        state.classList.add(NOANIM);
        state.classList.toggle(COLLAPSED, collapsed);
        state.classList.toggle(TIGHT, collapsed);
        requestAnimationFrame(() => requestAnimationFrame(() => state.classList.remove(NOANIM)));
        sync();
        return;
    }
    if (collapsed) {
        state.classList.add(COLLAPSED);
        sync();
        timer = setTimeout(() => {
            state.classList.add(TIGHT);
            if (node) flip(node, from);
        }, SETTLE);
        return;
    }
    // 展开：布局立刻回来，按钮从角落滑回原位
    state.classList.remove(COLLAPSED, TIGHT);
    sync();
    if (node) flip(node, from);
}

export function toggleToolbarCollapse() {
    const collapsed = !isCollapsed();
    apply(collapsed, false);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* 无存储能力时只影响持久化 */ }
    // 收起后工具栏不高了，"窗口太矮自动收纳"那条自动规则要重新判定；它内部把
    // "已手动收起"当作不该启用，鼠标贴顶也就不会再把它弹回来。
    window.vditor?.__toolbarAutohide?.measure?.();
    return collapsed;
}

export function installToolbarCollapse(api) {
    if (!button()) return null;    // 工具栏项由 js/toolbar.js 声明，这里只负责状态
    let restored = false;
    try { restored = localStorage.getItem(KEY) === '1'; } catch { /* 同上 */ }
    apply(restored, true);
    const api2 = {toggle: toggleToolbarCollapse, apply: value => apply(!!value, false), isCollapsed, sync};
    if (api) api.__toolbarCollapse = api2;
    return api2;
}
