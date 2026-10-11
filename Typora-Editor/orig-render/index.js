import { imageParser, scrollEditor, openLink } from "./js/util.js";
import { toolbar } from "./js/toolbar.js";
const init = () => {
  window.handler
    .on("open", ({ title, content, language, scrollTop, rootPath }) => {
      const isDark = window.localStorage.getItem("dark") !== "false";
      const editMode = window.localStorage.getItem("edit-mode") || "ir";
      // 是否显示大纲
      const showOutline = window.localStorage.getItem("outline") === 'true';

      let lastKeydown = "";
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
          theme: {
            current: isDark ? "dark" : "light",
            path: `${rootPath}/cdn/vditor/dist/css/content-theme`,
          },
          markdown: {
            toc: true,
            codeBlockPreview: true,
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
        keydown: (e) => {
          if (!isCompose(e)) {
            return;
          }
          // 修复剪切失效问题
          if (e.code === "KeyX" && lastKeydown === "MetaLeft") {
            setTimeout(() => {
              vditor.deleteValue();
            }, 10);
          }
          lastKeydown = e.code;
        },
        input(content) {
          window.handler.emit("change", content);
        },
        upload: {
          url: "/image",
          accept: "image/*",
          handler(files) {
            let reader = new FileReader();
            reader.readAsBinaryString(files[0]);
            reader.onloadend = () => {
              window.handler.emit("img", reader.result);
            };
          },
        },
        after: () => {
          openLink();
          scrollEditor(scrollTop);
          zoomElement(".vditor-content");
          // vditor create and init thing
          imageParser();
          window.handler.on("insertValue", (val) => {
            vditor.insertValue(val);
          });
          window.handler.on("setValue", (val) => {
            vditor.setValue(val);
          });
          // vditor.setTheme('dark', 'dark', 'native');
          // document.querySelector('body').style.backgroundColor='#2f363d';
        },
      });
      window.vditor = vditor;
    })
    .emit("init");
};
init();
