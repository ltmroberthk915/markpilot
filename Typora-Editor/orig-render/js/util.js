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
                const imgs = node.querySelectorAll('img');
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

export function scrollEditor(top) {
    const scrollHack = setInterval(() => {
        const editorContainer = document.querySelector(".vditor-ir .vditor-reset");
        if (!editorContainer) { return; }
        editorContainer.scrollTo({ top });
        clearInterval(scrollHack);
    }, 10);

    document.querySelector(".vditor-ir .vditor-reset").addEventListener("scroll", debounce(e => {
        handler.emit("scroll", { scrollTop: e.target.scrollTop });
    }, 200));
}


/**
 * 针对wysiwyg和ir两种模式对超链接做不同的处理
 */
export const openLink = () => {
    const clickCallback = e => {
        let ele = e.target;
        e.stopPropagation();
        const isSpecial = ['dblclick', 'auxclick'].includes(e.type);
        if (!isCompose(e) && !isSpecial) {
            return;
        }
        if (ele.tagName === 'A') {
            handler.emit("openLink", ele.href);
        } else if (ele.tagName === 'IMG') {
            const parent = ele.parentElement;
            if (parent?.tagName === 'A' && parent.href) {
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
            handler.emit("openLink", ele.textContent);
        }
    });
};
