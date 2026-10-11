function debounce(fn, delay = 1000) {
    let timer = null;
    return function (...args) {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }

        timer = setTimeout(() => {
            fn.apply(this, args);
        }, delay);
    };
}


export const imageParser = () => {
    var observer = new MutationObserver(mutationList => {
        for (var mutation of mutationList) {
            for (var node of mutation.addedNodes) {
                if (!node.querySelector) { continue; }
                const imgs = [...node.querySelectorAll('img')];
                if (node.matches?.('img')) imgs.push(node);
                for (const img of imgs) {
                    const url = img.src;
                    if (url.startsWith("http")) { continue; }
                    if (url.startsWith("vscode-webview-resource") || url.includes("file:///")) {
                        img.src = `https://file+.vscode-resource.vscode-cdn.net/${url.split("file:///")[1]}`;
                    }
                }
            }
        }
    });
    observer.observe(document, {
        childList: true,
        subtree: true
    });
};

/** 阅读位置记忆：像素值 + 块锚点。
 *
 *  只记像素值在含图片（以及大公式）的文档里必然落偏：重开时图片还没占位、公式还没渲成最终
 *  高度，内容比记录时矮，浏览器会把 scrollTo 夹到当时的 scrollHeight−clientHeight；等图片
 *  陆续加载把内容撑高，视口就停在偏上的位置，偏移量与还原点上方所有图片的高度同阶。
 *  这里改成：① 记"顶部块序号 + 块内偏移 + 该块开头文本"；② 重开时按块还原；③ 在图片加载、
 *  字体就绪、公式队列清空、根元素尺寸变化时**重贴**，直到连续两次测量稳定或到达兜底时限；
 *  ④ 用户一自己滚动/点击/输入就立刻停手，绝不在读者手里抢滚动条。
 *  `localStorage.scrollRestore='pixel'` 回退到旧的纯像素行为（探针 A/B 与应急开关）。
 */
const ANCHOR_SETTLE_MS = 400;   // 高度与位置在这个窗口内不再变化即认为稳定
const ANCHOR_GIVE_UP_MS = 6000; // 兜底：再久也不再重贴

export function scrollEditor(top, anchor) {
    // 三种还原策略：
    //   anchor（默认）＝ 按块锚点还原 + 持续重贴
    //   pixel        ＝ 只用像素值，但仍持续重贴（图片到位后能自我纠正）
    //   legacy       ＝ 改动前的行为：只贴一次像素值，之后不管（探针对照用）
    let restoreMode = "anchor";
    try { restoreMode = localStorage.getItem("scrollRestore") || "anchor"; } catch { /* no storage */ }
    const legacy = restoreMode === "legacy";
    const anchorEnabled = restoreMode === "anchor";
    // 容器可能还没挂上（旧实现用 10ms 轮询等它），保留一个有界重试，避免静默失效。
    let waited = 0;
    const boot = () => {
        const root = document.querySelector(".vditor-ir .vditor-reset");
        if (!root) { if ((waited += 20) < 1500) setTimeout(boot, 20); return; }
        install(root);
    };
    boot();

    function install(root) {
        const anchorOf = () => {
            // 顶部块 = 第一个 bottom 越过视口上沿的顶层块；head 用于块序号漂移时找回。
            const view = root.getBoundingClientRect();
            const blocks = root.children;
            for (let i = 0; i < blocks.length; i++) {
                const rect = blocks[i].getBoundingClientRect();
                if (rect.bottom <= view.top + 1) continue;
                return {index: i, delta: Math.round(view.top - rect.top),
                    head: (blocks[i].textContent || "").replace(/\s+/g, " ").trim().slice(0, 60), total: blocks.length};
            }
            return null;
        };
        // 锚点始终记录（一次防抖滚动只多一次几何读），恢复策略才受 scrollRestore 影响：
        // 这样任何新版本都能用上旧版本写下的锚点。
        const commit = () => handler.emit("scroll", {scrollTop: root.scrollTop, anchor: anchorOf()});
        // 切换/关闭文档时 iframe 会被换掉，防抖里那一次就永远发不出去（实测最多丢 200ms）。
        // 页面隐藏/卸载时立刻补发一次。
        const flush = () => { if (root.isConnected) commit(); };
        addEventListener("pagehide", flush);
        addEventListener("beforeunload", flush);
        document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
        root.addEventListener("scroll", debounce(commit, 200));

        let cancelled = false;
        // 我们自己贴上去的位置记在这里：任何一次"不是我们造成的"滚动都说明读者（或大纲跳转、
        // 查找、分屏同步等别的子系统）接管了视口，立刻停手——否则重贴会把人家的位置抢回来。
        let expected = root.scrollTop;
        root.addEventListener("scroll", () => {
            if (Math.abs(root.scrollTop - expected) > 2) { cancelled = true; debug.cancelled = true; debug.reason = "foreign-scroll " + Math.round(root.scrollTop - expected); }
        });
        for (const type of ["wheel", "pointerdown", "keydown", "compositionstart"]) {
            addEventListener(type, () => { cancelled = true; }, {capture: true, passive: true, once: true});
        }
        const anchorBlock = () => {
            if (!(anchorEnabled && anchor && anchor.total)) return null;
            const blocks = root.children;
            if (!blocks.length) return null;
            const wanted = (anchor.head || "").slice(0, 24);
            const block = blocks[Math.min(Math.max(anchor.index, 0), blocks.length - 1)];
            if (wanted && headOf(block) !== wanted) return [...blocks].find(candidate => headOf(candidate) === wanted) || block;
            return block;
        };
        const apply = () => {
            if (cancelled || !root.isConnected) return;
            const block = anchorBlock();
            let target = top;
            if (block) {
                const rect = block.getBoundingClientRect();
                const view = root.getBoundingClientRect();
                // delta 记录的是 view.top − block.top，所以要让 block 回到原处，滚动量里是 +delta。
                target = Math.max(0, root.scrollTop + rect.top - view.top + anchor.delta);
                debug.head = headOf(block);
            }
            // 差不到 1px 就不写：写 scrollTop 会打断浏览器自己的滚动锚定，在图片/表格陆续
            // 到位的那段时间里表现成画面反复小幅跳动。expected 照记，位置仍然算"我们的"。
            if (Math.abs(target - root.scrollTop) >= 1) root.scrollTop = target;
            expected = root.scrollTop;
            debug.applies++; debug.at = Math.round(root.scrollTop); debug.error = Math.round(anchorError());
        };
        const headOf = candidate => (candidate?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
        // 锚点是否已经贴准（±2px）。收尾判据必须用它，不能只看"高度和位置没变化"：
        // 图片解码完成时浏览器自己的滚动锚定会改 scrollTop，正好落在一个 tick 的末尾，
        // 下一个 tick 看到的就是"没变化"，于是带着 30px 级残差收工（实测就是这个 35px）。
        //
        // 口径必须和 apply 完全一致：apply 的滚动量是 `scrollTop + (block.top − view.top) + delta`，
        // 所以"还差多少"就是这个量本身 = |(block.top − view.top) + delta|。这里原先把两项相减的
        // 顺序写反了，算出来是 **2×delta**：位置其实已经贴准时它会报 2×delta（实测 delta=1 时报 2、
        // delta=−11 时报 22），永远越不过 ±2px 这条线，于是"已经贴准就收工"从来没生效过——
        // 每次打开文档都会把滚动位置每 120ms 重写一次、一直写到 6 秒兜底为止（实测 applies=76，
        // 而正常情况下应当 1 秒内收工）；这 6 秒里任何一次布局变化都会被它重新"粘"一次，
        // 用户看到的就是"打开时画面抖一阵才停"。修正后 delta=0 的稳定状态误差为 0。
        const anchorError = () => {
            const block = anchorBlock();
            if (!block) return 0;
            return Math.abs((block.getBoundingClientRect().top - root.getBoundingClientRect().top) + anchor.delta);
        };
        const debug = window.__typoraScrollRestore = {mode: anchorEnabled ? "anchor" : "pixel",
            anchored: !!(anchor && anchor.total), applies: 0, at: null, head: null, cancelled: false, settled: false};
        window.__typoraScrollRestoreCancel = () => { cancelled = true; debug.cancelled = true; };
        const watchImages = () => {
            for (const image of root.querySelectorAll("img")) {
                if (image.complete) continue;
                image.addEventListener("load", apply, {once: true});
                image.addEventListener("error", apply, {once: true});
            }
        };

        const images = new MutationObserver(() => { if (!cancelled) watchImages(); });
        images.observe(root, {childList: true, subtree: true});
        const resize = new ResizeObserver(() => apply());
        resize.observe(root);
        let poll = 0;
        let ticker = 0;
        const finish = () => {
            clearTimeout(ticker); clearInterval(poll); images.disconnect(); resize.disconnect();
            apply();   // 收尾再贴一次：稳定判据可能刚好落在浏览器滚动锚定之后
            debug.settled = true; debug.error = Math.round(anchorError());
        };

        requestAnimationFrame(() => requestAnimationFrame(() => {
            apply();
            // legacy：贴一次就结束（改动前的行为，仅探针对照用）。
            if (legacy) return finish();
            watchImages();
            document.fonts?.ready?.then(() => apply());
            // 公式补渲染、图片陆续到位都会改变锚点上方的高度：在有界窗口内持续重贴。
            poll = setInterval(() => { watchImages(); if (!window.__typoraMathStats?.pending) apply(); }, 250);
            const started = performance.now();
            let lastHeight = -1, stableSince = 0, accurateSince = 0;
            const tick = () => {
                if (cancelled || !root.isConnected) return finish();
                const height = root.scrollHeight;
                // 判据：高度稳定 ANCHOR_SETTLE_MS 且锚点贴准（±2px，无锚点时误差恒为 0）
                if (height === lastHeight && anchorError() <= 2) { if (!stableSince) stableSince = performance.now(); }
                else stableSince = 0;
                lastHeight = height;
                if (anchorError() <= 2) { if (!accurateSince) accurateSince = performance.now(); } else accurateSince = 0;
                if ((stableSince && !window.__typoraCvPending && performance.now() - stableSince > ANCHOR_SETTLE_MS) ||
                    (accurateSince && performance.now() - accurateSince > 800) ||
                    performance.now() - started > ANCHOR_GIVE_UP_MS) return finish();
                apply();
                ticker = setTimeout(tick, 120);
            };
            ticker = setTimeout(tick, 120);
        }));
    }
}


/**
 * 文内锚点（`[跳到第二节](#第二节)`）：在主进程那条路上是被**明确忽略**的
 * （doc.js 的 openLink 一上来就 `if (uri.startsWith('#')) return`），而渲染层也不管，
 * 于是点文档里的锚点链接**什么都不会发生**（实测 probe-anchor.cjs：滚动量 0→0，
 * 外部程序也没被调用）。锚点只能在渲染层解决——只有这里有 DOM 可以找标题。
 * 匹配顺序：先按 `id`（Vditor 给标题分配的 id），再按标题文字完全相等，
 * 最后按"去空白/小写的 slug"比对（GitHub 风格的 `#标题` 写法）。
 * 找到就滚到视口顶部并短暂高亮，让用户看见落在哪一节。
 */
export const scrollToAnchor = fragment => {
    let name = String(fragment || '').replace(/^#/, '');
    try { name = decodeURIComponent(name); } catch { /* 原样比对 */ }
    if (!name) return false;
    const root = document.querySelector('.vditor-ir .vditor-reset') || document.querySelector('.vditor-wysiwyg .vditor-reset');
    if (!root) return false;
    const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    // IR 模式下标题元素里连着源码标记：`<h3>` 的 textContent 是 `### 第三节`（实测
    // probe-anchor-steps.cjs：拿 '第三节' 去逐字比对全部落空，于是点锚点什么都没发生）。
    // 比较前先把 `#` 标记与前后空白剥掉；同时保留按 id 匹配（VSIX/渲染器给的 id）。
    const label = node => node.textContent.replace(/^\s*#+\s*/, '').trim();
    const slug = value => value.trim().toLowerCase().replace(/[\s\u3000]+/g, '-');
    const wanted = name.trim();
    const heading = headings.find(node => label(node) === wanted)
        || headings.find(node => label(node).toLowerCase() === wanted.toLowerCase())
        || headings.find(node => slug(label(node)) === slug(wanted))
        || root.querySelector('#' + (window.CSS?.escape ? CSS.escape(name) : name));
    if (!heading) return false;
    heading.scrollIntoView({block: 'start', behavior: 'smooth'});
    heading.classList.add('typora-anchor-target');
    setTimeout(() => heading.classList.remove('typora-anchor-target'), 1600);
    return true;
};

/**
 * 针对wysiwyg和ir两种模式对超链接做不同的处理
 */
export const openLink = () => {
    // 以 # 开头的链接是文内锚点：自己滚过去，别问宿主（宿主明确忽略它）。
    const anchor = href => typeof href === 'string' && href.trim().startsWith('#');
    const clickCallback = e => {
        let ele = e.target;
        e.stopPropagation();
        const isSpecial = ['dblclick', 'auxclick'].includes(e.type);
        if (!isCompose(e) && !isSpecial) {
            return;
        }
        if (ele.tagName === 'A') {
            if (anchor(ele.getAttribute('href'))) { scrollToAnchor(ele.getAttribute('href')); return; }
            handler.emit("openLink", ele.href);
        } else if (ele.tagName === 'IMG') {
            const parent = ele.parentElement;
            if (parent?.tagName === 'A' && parent.href) {
                if (anchor(parent.getAttribute('href'))) { scrollToAnchor(parent.getAttribute('href')); return; }
                handler.emit("openLink", parent.href);
                return;
            }
            const src = ele.src;
            if (src?.match(/http/)) {
                handler.emit("openLink", src);
            }
        }
    };
    const content = document.querySelector(".vditor-wysiwyg");
    if (content) {
        content.addEventListener('dblclick', clickCallback);
        content.addEventListener('click', clickCallback);
        content.addEventListener('auxclick', clickCallback);
    }
    document.querySelector(".vditor-ir").addEventListener('click', e => {
        let ele = e.target;
        if (ele.classList.contains('vditor-ir__link')) {
            ele = e.target.nextElementSibling?.nextElementSibling?.nextElementSibling;
        }
        if (ele.classList.contains('vditor-ir__marker--link')) {
            const target = ele.textContent.trim();
            if (anchor(target)) { scrollToAnchor(target); return; }
            handler.emit("openLink", target);
        }
    });
};

/**
 * 鼠标侧键（X1/X2）在 Chromium 里等价于「后退 / 前进」。编辑面把每份文档都装进
 * iframe，而每次 f.src = url 都会压一条会话历史，于是「后退」会把编辑面导航到上一个
 * 文档甚至空白页——用户实测表现为「整个页面消失，按前进才拉回来」。桌面版已在主进程
 * 用 app-command 吞掉这个命令（还会拦 Alt+←/→）；这里再兜一层，防止鼠标驱动把侧键
 * 当成普通鼠标事件直接送进页面。button 3 = X1（后退），4 = X2（前进）；中键(1)和
 * 右键(2)必须原样放行，链接中键打开与右键菜单都依赖它们。
 */
export const installBrowserNavigationGuard = () => {
    const block = (event) => {
        if (event.button < 3) return;
        event.preventDefault();
        event.stopPropagation();
    };
    document.addEventListener('mousedown', block, true);
    document.addEventListener('auxclick', block, true);
};

/**
 * 弹窗收尾的两个小工具。
 *
 * 背景：隐藏文档（窗口被别的窗口完全遮挡、VS Code 里不可见的 webview）下，<dialog>
 * 的 close 事件可能永远不派发——Chromium 既有行为，实测多窗口时新建一个 dialog、
 * showModal() 再 close()，close 事件就是不触发。而各个弹窗都按 id 判重，只靠 close
 * 事件收尾会把这个节点永久留在 DOM 里，于是「关于」「快捷键设置」这些再也打不开。
 * 所以：判重时顺手清掉已经关掉的残留节点；主动关闭时自己收尾，close 事件只作兜底。
 */

/** 返回 true 表示可以新建弹窗；false 表示同一个弹窗已经开着，不要重复弹。 */
export const dialogSlotFree = (id) => {
    const existing = document.getElementById(id);
    if (!existing) return true;
    if (existing.open) return false;
    existing.remove();
    return true;
};

/** 关闭弹窗并立刻收尾，不依赖 close 事件是否派发。 */
export const closeDialog = (dialog, finish) => {
    try { if (dialog.open) dialog.close(); } catch { /* 已经关了 */ }
    try { finish?.(); } catch { /* 收尾出错不能挡住关闭 */ }
};
