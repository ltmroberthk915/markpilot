// 超小窗口下的工具栏自动收纳（v2.1.0）。
//
// 现象：窗口很矮时工具栏换行后会占掉很大一块高度（用户实测一屏的 35% 以上），正文几乎
// 没地方。做法：工具栏布局高度占视口高度 RATIO 以上时启用自动收纳——平时收上去，鼠标
// 贴近顶部才滑出来，离开再收回。
//
// 为什么用 document 上的 mousemove 而不是加一层覆盖元素：覆盖层会挡住正常高度的窗口里
// 那几像素的点击，而这里只需要「指针位置」这一个信息。键盘用户聚焦工具栏按钮时同样弹出。
// 阈值以下的窗口完全不介入，正常行为一个像素都不变。
const RATIO = 0.35;
const EDGE_PX = 4;       // 顶部触发带高度
const PAD = 6;           // 判定「还在工具栏上」的宽容边距
const HIDE_DELAY = 420;  // 离开后延迟收回：擦边而过不该立刻收起来
const ROOT_CLASS = 'typora-toolbar-autohide';
const OPEN_CLASS = 'typora-toolbar-revealed';
const COLLAPSED_CLASS = 'typora-toolbar-collapsed';

export function installToolbarAutohide(api) {
    const toolbar = api?.vditor?.toolbar?.element || document.querySelector('.vditor > .vditor-toolbar');
    if (!toolbar) return null;
    const root = document.documentElement;
    let timer = 0;
    let enabled = false;
    // 用户手动收起了工具栏（见 js/toolbar-collapse.js）时，这条自动规则整体让位：
    // 工具栏本来就不高了，也没有「贴顶弹出」这回事——否则鼠标一靠顶就把它弹回来。
    const collapsed = () => root.classList.contains(COLLAPSED_CLASS);

    const panelOpen = () => {
        for (const selector of ['.vditor-hint', '.vditor-panel', '.vditor-emojis', '.vditor-tip']) {
            const node = toolbar.querySelector(selector);
            if (node && node.getBoundingClientRect().height > 0) return true;
        }
        return false;
    };
    const reveal = () => {
        clearTimeout(timer);
        if (!enabled || collapsed() || root.classList.contains(OPEN_CLASS)) return;
        root.classList.add(OPEN_CLASS);
    };
    const scheduleHide = () => {
        if (!enabled) return;
        clearTimeout(timer);
        timer = setTimeout(() => root.classList.remove(OPEN_CLASS), HIDE_DELAY);
    };
    const measure = () => {
        const height = toolbar.getBoundingClientRect().height;
        const viewport = document.documentElement.clientHeight || window.innerHeight || 1;
        const should = !collapsed() && height > 0 && height / viewport >= RATIO;
        if (should === enabled) return;
        enabled = should;
        root.classList.toggle(ROOT_CLASS, enabled);
        if (!enabled) { clearTimeout(timer); root.classList.remove(OPEN_CLASS); }
    };
    const onMove = event => {
        if (!enabled || collapsed()) return;
        if (panelOpen()) { reveal(); return; }
        const rect = toolbar.getBoundingClientRect();
        if (event.clientY <= EDGE_PX) { reveal(); return; }                                  // 贴近顶部
        if (event.clientY >= rect.top - PAD && event.clientY <= rect.bottom + PAD) { reveal(); return; }  // 还在工具栏上
        scheduleHide();
    };
    // 把「换行后的工具栏高度」连同量它的那个视口高度一起报给宿主。桌面版据此限制窗口最小
    // 高度，从根上消掉「工具栏比正文还高」的极端窗口（实测占到 116% 那种）。带上视口是因为
    // 宿主只能量到窗口外框，量不到状态栏占掉的那一条，换算会偏松；这里直接给比值所用的分母，
    // 宿主侧就能精确对齐到「工具栏 ≤ 视口 80%」这条线。宿主没有这个能力（IDE 的 webview
    // 面板尺寸不由我们定）就什么都不做。
    // 只在数值真的变了才报，避免每帧一次 IPC；宽度变化导致换行时高度会变，所以宽度也算在内。
    let reportedHeight = -1, reportedViewport = -1;
    const reportHeight = () => {
        const height = Math.round(toolbar.getBoundingClientRect().height);
        const viewport = Math.round(document.documentElement.clientHeight || window.innerHeight || 0);
        if (height <= 0 || viewport <= 0) return;
        if (Math.abs(height - reportedHeight) <= 2 && Math.abs(viewport - reportedViewport) <= 2) return;
        reportedHeight = height;
        reportedViewport = viewport;
        try { window.hostApi?.invoke?.('toolbar-height', {height, viewport}); } catch { /* 非桌面宿主 */ }
    };

    document.addEventListener('mousemove', onMove, {passive: true});
    document.addEventListener('mouseleave', scheduleHide);
    toolbar.addEventListener('mouseenter', reveal);
    toolbar.addEventListener('mouseleave', scheduleHide);
    toolbar.addEventListener('focusin', reveal);
    toolbar.addEventListener('focusout', scheduleHide);
    window.addEventListener('resize', measure, {passive: true});
    try { new ResizeObserver(measure).observe(toolbar); } catch { /* 老环境不做宽度自适应重算 */ }
    measure();
    reportHeight();
    window.addEventListener('resize', reportHeight, {passive: true});
    try { new ResizeObserver(reportHeight).observe(toolbar); } catch { /* 同上 */ }

    // 供自动化测试与调试观察内部状态
    api.__toolbarAutohide = {measure, reveal, scheduleHide, panelOpen, isEnabled: () => enabled, ratio: RATIO};
    return api.__toolbarAutohide;
}
