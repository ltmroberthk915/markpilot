import { imageParser, scrollEditor, openLink, installBrowserNavigationGuard } from "./js/util.js";
import { toolbar } from "./js/toolbar.js";
import { applyTyporaPatches, prepareTyporaMath } from "./js/typora-patches.js";
import { configureShortcuts, showShortcutSettings } from './js/edit-shortcuts.js';
import {uploadImages, installImageReplies} from './js/images.js';
import {applyTheme,preferredTheme,showThemeSettings} from './js/themes.js';
import {applyPalette,preferredPalette} from './js/reading-palette.js';
import {prepareMathMarkdown} from './js/math-markdown.js';
import {installMediaTools} from './js/media-tools.js';
import {installOfficeClient} from './js/office-client.js';
import {installSurfacePreferences} from './js/surface.js';
import {installToolbarAutohide} from './js/toolbar-autohide.js';
import {installToolbarCollapse} from './js/toolbar-collapse.js';
import {sourceText, selectRange} from './js/source-text.js';
import {captureHistorySelection, restoreHistorySelection} from './js/history-selection.js';
const init = () => {
  installOfficeClient();
  installBrowserNavigationGuard();
  prepareMathMarkdown();
  prepareTyporaMath();
  installSurfacePreferences();
  window.handler
    .on('shortcuts-changed', configureShortcuts)
    .on('shortcut-settings', () => showShortcutSettings())
    .on('theme-changed', theme => applyTheme(window.vditor,theme))
    .on('theme-settings', showThemeSettings)
    .on('palette-changed', palette => applyPalette(window.vditor,palette))
    .on('find', replacing => window.vditor?.__typoraFind.open(replacing))
    .on("open", ({ title, content, language, scrollTop, scrollAnchor, rootPath, shortcuts, theme, palette, completion, nativeChat }) => {
      if (shortcuts !== undefined) configureShortcuts(shortcuts);
      const chosenTheme=applyTheme(null,theme||preferredTheme());
      const chosenPalette=applyPalette(null,palette||preferredPalette());
      const isDark = chosenTheme.endsWith('dark');
      const editMode = window.localStorage.getItem("edit-mode") || "ir";
      // 是否显示大纲
      const showOutline = window.localStorage.getItem("outline") === 'true';

      // 大文档预判：内容长度阈值（实测 34.8 万字符 ≈ 2576 顶层块，约 135 字符/块）。
      // 这里只按长度预判，真正的门槛（≥1500 顶层块）由 large-doc.js 在首屏后复核，
      // 不够就把预置类摘掉。这样"插入后的第一次排版"不必排整篇。
      // localStorage.cvFirst = "off" 可退回"首屏之后才启用跳过"的旧行为（A/B 与应急开关）。
      let cvFirst = true;
      try { cvFirst = localStorage.getItem("cvFirst") !== "off"; } catch { /* 无存储 */ }
      const largeDoc = cvFirst && typeof content === "string" && content.length >= 200000;
      try { document.documentElement.classList.toggle("typora-cv-pre", largeDoc); } catch { /* 无 DOM 时忽略 */ }
      const vditor = new Vditor("vditor", {
        value: content,
        toolbar,
        cdn: `${rootPath}/cdn/vditor`,
        height: "100%",
        lang: language === "zh-cn" ? "zh_CN" : "en_US",
        width: "100%",
        cache: {
          enable: false,
        },
        undoDelay: 200,
        icon: "material",
        tab: "  ",
        mode: editMode,
        theme: isDark ? "dark" : "light",
        preview: {
          // v2.0.6:版心 1280px。vditor 的 K() 居中逻辑会按 preview.maxWidth 给
          // IR reset 写内联 padding（默认 800 → (W-800)/2 的巨量留白）。默认值
          // 与 telari 主题的 1280px 版心 CSS 一致，内联与样式表不再打架；
          // 编辑后 style-stripper 剥掉内联时，CSS(!important) 仍然兜底。
          maxWidth: 1280,
          theme: {
            current: isDark ? "dark" : "light",
            path: `${rootPath}/cdn/vditor/dist/css/content-theme`,
          },
          markdown: {
            toc: true,
            codeBlockPreview: true,
            // `mark` 不是"要不要支持 ==高亮== 这个口味"的问题，而是 Lute 解析器的一个开关：
            // 关着的时候，一行里出现**两个 `=`** 之后，后面的强调（`**粗**` / `*斜*` / `__粗__`）
            // 全都不再解析，星号当字面量显示。实测（Node 里直接跑打包的 lute.min.js，
            // scripts/acceptance/probe-lute-node.cjs）：`甲=乙。丙=**丁**` 关时输出
            // `<p>甲=乙。丙=**丁**</p>`，开时输出 `<p>甲=乙。丙=<strong>丁</strong></p>`。
            // 单个 `=` 和 `====` 的渲染不受影响，`==…==` 变成 <mark>（这正是该语法本身），
            // 存回磁盘的 markdown 逐字节不变（round-trip 实测同前）。用户 2026-09-23 报的
            // "快捷键加粗后不渲染"就是这条：那一行里 `=` 出现了两次以上。
            // Vditor 用这个选项调 lute.SetMark。
            mark: true,
          },
          hljs: {
            lineNumber: true,
            style: isDark ? "github-dark" : "github",
          },
          extPath: rootPath,
          math: {
            engine: "KaTeX",
            inlineDigit: true,
          },
        },
        extPath: rootPath,
        hint: {},
        outline: {
          enable: showOutline
        },
        input(content) {
          // R10 confirmDiscard：这一拍=200ms 去抖到点、把已见输入随 change/completion-change
          // 全部交给主进程。__mpInputSeen 从「见过输入」收窄为「输入在飞行中」——否则标志
          // 粘性为真，主进程关窗/切档前的 flushEditorText 会在异步渲染（KaTeX 补渲染、虚拟化
          // 挂载）后 getValue 漂移的文档上把干净文档误置脏（72 场景实测：切档弹假确认框）。
          // composingLock 吞拍时不进这里，标志保持真（该输入确实未推送）。
          window.__mpInputSeen = false;
          if (vditor.__completion) vditor.__completion.changed(content);
          else window.handler.emit("change", content);
        },
        upload: {
          url: "/image",
          accept: "image/*",
          handler(files) {
            return uploadImages(Array.from(files));
          },
        },
        after: async () => {
          applyTyporaPatches(vditor);
          applyTheme(vditor,chosenTheme);
          applyPalette(vditor,chosenPalette);
          // 【R9-C】渲染层「接过真实输入」的同步标记：主进程手动保存（Ctrl+S）拉活值前用来
          // 区分「未编辑文档的 Lute 归一化漂移」与「真有新文本」（app/main/doc.js
          // flushEditorText 的 R9 补充注释）。input 事件在每次真实键入/粘贴/拖放文本的同一拍
          // 同步触发，先于 vditor 的 200ms 去抖推送——快 Ctrl+S 正是抢在这个窗口里。文档切换
          // 会整帧重载，标记天然归零。
          try { document.addEventListener("input", () => { window.__mpInputSeen = true; }, true); } catch {}
          openLink();
          scrollEditor(scrollTop, scrollAnchor);
          {const {installContentZoom}=await import('./js/zoom.js');installContentZoom();}
          // vditor create and init thing
          imageParser();
          installImageReplies(vditor);
          installMediaTools(vditor);
          // 超小窗口（工具栏高占比过大）时自动收纳工具栏，鼠标贴近顶部才弹出
          installToolbarAutohide(vditor);
          // 手动收纳：右下角一个按钮，按一下把工具栏收起来（持久，重启仍在）
          installToolbarCollapse(vditor);
          window.handler.on("setValue", (val) => {
            // R10 confirmDiscard：整篇被主进程替换后，旧输入标记不再有意义（那拍输入已
            // 不存在于文档），收窄口径防漂移误判。
            window.__mpInputSeen = false;
            // F1'（外部修改 + 本地未改的静默重载保光标/滚动）：主进程 checkFile 检测到外部
            // 更新后会整篇 setValue，DOM 重建把 Range 与滚动全部归零，光标无声消失。替换前
            // 按"源码文本偏移"（与 source-text.js 的可编辑文本同一口径）记下光标与 scrollTop，
            // 替换后把光标放回同一偏移——外部只改了一处时未触及的块被 preserveIR 原样保留，
            // 偏移即精确回位；光标落在预览/元素边界上取不到偏移时，退回撤销链用的块路由还原；
            // 两种锚都失败时至少把滚动位置贴回去，不丢视野。
            const state = vditor.vditor;
            const root = state?.[state.currentMode]?.element;
            const selection = getSelection();
            let saved = null;
            if (root && selection?.rangeCount && root.contains(selection.focusNode)) {
              let offset = null, route = null;
              try {
                const model = sourceText(root);
                const span = model.spans.find(item => item.node === selection.focusNode);
                if (span) offset = span.start + Math.min(selection.focusOffset, span.node.length);
                else route = captureHistorySelection(root);
              } catch { /* 取锚失败不挡重载 */ }
              saved = {offset, route, scrollTop: root.scrollTop};
            }
            vditor.__completion?.externalChange();
            vditor.setValue(val);
            if (!saved) return;
            const restore = () => {
              const live = vditor.vditor?.[vditor.vditor.currentMode]?.element;
              if (!live || !live.isConnected) return;
              try {
                if (saved.offset != null) {
                  const next = sourceText(live);
                  if (next.spans.length) {
                    const at = Math.min(saved.offset, next.text.length);
                    selectRange(live, next.range(at, at));
                  }
                } else if (saved.route) {
                  restoreHistorySelection(live, saved.route);
                }
              } catch { /* 还原失败不挡重载 */ }
              // 光标复位后把视口贴回原位：异步收尾（公式重排/outline）可能又挪动过它。
              live.scrollTop = saved.scrollTop;
            };
            restore();
            setTimeout(restore, 0);
            setTimeout(restore, 200);
          });
          if (completion) {
            const {installCompletion} = await import('./js/completion.js');
            installCompletion(vditor, completion);
          }
          if(nativeChat){
            const {installNativeChat}=await import('./js/native-chat.js');
            installNativeChat(vditor);
          }
          // vditor.setTheme('dark', 'dark', 'native');
          // document.querySelector('body').style.backgroundColor='#2f363d';
        },
      });
      window.vditor = vditor;
    })
    .emit("init");
};
init();
