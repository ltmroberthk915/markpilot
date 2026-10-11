// Local regression UI: exercises the same renderer and input bridge as the extension.
const panel = document.createElement("details");
panel.id = "regression";
panel.style.cssText = "position:fixed;left:8px;bottom:35px;z-index:100000;background:#fff;color:#111;padding:8px;max-width:90vw;font:12px monospace;max-height:45vh;overflow:auto";
panel.innerHTML = `<summary>编辑回归测试</summary>
  <textarea id="fixture" aria-label="测试 Markdown" rows="4" cols="70"># 标题文字\n\n正文 $\\Omega\\Omeg$ 与 $x+1$。\n\n$$\na^2+b^2\n$$\n</textarea><br>
  <button id="load-fixture">加载用例</button>
  <button id="run-regression">运行回归测试</button>
  <button id="caret-heading">光标放在 # 后</button>
  <button id="caret-before-heading">光标放在 # 前</button>
  <button id="load-mapping">加载公式定位用例</button>
  <button id="caret-math">光标放在公式尾部 $ 前</button>
  <button id="zoom-fixture">切换 200% 缩放</button>
  <pre id="regression-results"></pre><pre id="editor-state"></pre>`;
document.body.append(panel);

const getEditor = () => window.vditor.vditor;
const root = () => getEditor().ir.element;
const delay = (ms = 260) => new Promise(resolve => setTimeout(resolve, ms));
const caret = (node, offset = 0) => {
  root().focus();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
};
const selectText = (node, start, end) => {
  root().focus();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
};
const key = (key, options = {}) => root().dispatchEvent(new KeyboardEvent("keydown", {
  key, code: key.length === 1 ? "Key" + key.toUpperCase() : key,
  bubbles: true, cancelable: true, ...options,
}));
const state = () => {
  if (!window.vditor?.vditor?.ir) return;
  const sel = getSelection();
  const node = sel.focusNode;
  const el = node?.nodeType === 3 ? node.parentElement : node;
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  document.querySelector("#editor-state").textContent = JSON.stringify({
    markdown: window.vditor.getValue(),
    caret: {node: node?.nodeName, parent: el?.tagName, class: el?.className,
      text: node?.textContent?.slice(0, 80), offset: sel.focusOffset,
      selected: sel.toString(), inPreview: !!el?.closest?.(".vditor-ir__preview"),
      x: rect?.x, y: rect?.y, height: rect?.height},
    formulas: [...root().querySelectorAll(".vditor-ir__preview .language-math")].map(n => ({
      source: n.parentElement.previousElementSibling.textContent,
      rendered: n.getAttribute("data-math"), text: n.textContent,
      editable: n.isContentEditable,
    })),
    blocks: [...root().children].map(n => ({tag: n.tagName, text: n.textContent.slice(0, 80)})),
    history: {undo: getEditor().undo.ir.undoStack.length, redo: getEditor().undo.ir.redoStack.length},
  }, null, 2);
};
document.addEventListener("selectionchange", state);
document.addEventListener("keyup", state);
document.addEventListener("input", () => setTimeout(state, 280));
document.addEventListener("click", () => setTimeout(state, 0));
const load = async (markdown) => {
  window.vditor.setValue(markdown, true);
  await delay();
  state();
};
const mappingSource = String.raw`\frac{a}{b}+a+\Omega+\sqrt{x^2}`;
document.querySelector("#load-mapping").onclick = () => {
  const markdown = "# 公式定位测试\n\n点击公式：$" + mappingSource + "$\n";
  document.querySelector("#fixture").value = markdown;
  return load(markdown);
};
document.querySelector("#load-fixture").onclick = () => load(document.querySelector("#fixture").value);
document.querySelector("#caret-heading").onclick = () => {
  const heading = root().querySelector("h1,h2,h3,h4,h5,h6");
  heading.classList.add("vditor-ir__node--expand");
  caret(heading.querySelector('[data-type="heading-marker"]').firstChild, 1);
};
document.querySelector("#caret-before-heading").onclick = () => {
  const heading = root().querySelector("h1,h2,h3,h4,h5,h6");
  heading.classList.add("vditor-ir__node--expand");
  caret(heading.querySelector('[data-type="heading-marker"]').firstChild, 0);
};
document.querySelector("#caret-math").onclick = () => {
  const code = root().querySelector('code[data-type="math-inline"]');
  code.parentElement.classList.add("vditor-ir__node--expand");
  caret(code.parentElement.lastElementChild.firstChild, 0);
};
document.querySelector("#zoom-fixture").onclick = () => {
  const content = document.querySelector(".vditor-content");
  content.style.zoom = content.style.zoom === "200%" ? "100%" : "200%";
};

document.querySelector("#run-regression").onclick = async () => {
  const output = document.querySelector("#regression-results");
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const test = async (name, run) => {
    try { await run(); results.push("PASS " + name); }
    catch (error) { results.push("FAIL " + name + ": " + error.message); }
    output.textContent = results.join("\n");
  };
  const base = "# 标题文字\n\n正文 $\\Omega\\Omeg$ 与 $x+1$。\n\n$$\na^2+b^2\n$$\n";
  const formulasIntact = () => {
    const previews = [...root().querySelectorAll(".vditor-ir__preview .language-math")];
    assert(previews.length === 3, "公式数量变化");
    for (const preview of previews) {
      const source = preview.parentElement.previousElementSibling.textContent.trim();
      assert(preview.getAttribute("data-math")?.trim() === source && preview.textContent.length > 0,
        "公式预览丢失: " + source);
    }
  };
  await test("Enter splits after heading marker", async () => {
    await load(base);
    const heading = root().querySelector("h1");
    caret(heading.firstElementChild.firstChild, 1);
    key("Enter");
    await delay();
    assert(!root().querySelector("h1")?.textContent.includes("标题文字"), "标题文字仍在标题中");
    assert(root().children[0].textContent.trim() === "#", "# 未留在第一行");
    assert(root().children[1].textContent.trim() === "标题文字", "标题文字未移至下一行");
    key("z", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue() === base, "标题拆分撤销不完整");
    formulasIntact();
  });
  await test("Immediate body undo/redo preserves formulas", async () => {
    await load(base);
    const heading = root().querySelector("h1");
    caret(heading.lastChild, heading.lastChild.length);
    document.execCommand("insertText", false, "X");
    key("z", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue() === base, "200ms 内撤销丢失本次输入");
    formulasIntact();
    key("y", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue().startsWith("# 标题文字X\n"), "重做未恢复文字");
    formulasIntact();
  });
  await test("Native cut event copies body/formula source and undoes once", async () => {
    const cut = () => {
      const clipboardData = new DataTransfer();
      root().dispatchEvent(new ClipboardEvent("cut", {clipboardData, bubbles: true, cancelable: true}));
      return clipboardData.getData("text/plain");
    };
    const markdown = "普通 ALPHA 文本\n\n公式 $\\frac{alpha}{beta}$\n";
    await load(markdown);
    let paragraph = [...root().querySelectorAll("p")].find(node => node.textContent.includes("ALPHA"));
    let text = [...paragraph.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes("ALPHA"));
    let start = text.textContent.indexOf("ALPHA");
    selectText(text, start, start + 5);
    assert(cut() === "ALPHA", "正文剪切未写入正确剪贴板内容");
    await delay();
    assert(window.vditor.getValue() === markdown.replace("ALPHA", ""), "正文剪切没有准确删除选区");
    key("z", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue() === markdown, "正文剪切无法撤销");

    let code = root().querySelector('code[data-type="math-inline"]');
    // A person must open the rendered formula before selecting its source.
    // Selecting a display:none text node makes execCommand delete the nearest
    // visible caret boundary and does not model a possible mouse selection.
    code.nextElementSibling.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0}));
    await delay(60);
    code = root().querySelector('code[data-type="math-inline"]');
    assert(code.getClientRects().length>0&&getComputedStyle(code).display!=='none','公式未展开为可选择的源码');
    start = code.textContent.indexOf("alpha");
    selectText(code.firstChild, start, start + 5);
    assert(cut() === "alpha", "公式源码剪切未写入正确剪贴板内容");
    await delay();
    assert(window.vditor.getValue() === markdown.replace("alpha", ""), "公式源码剪切没有准确删除选区："+JSON.stringify({actual:window.vditor.getValue(),expected:markdown.replace("alpha", "")}));
    key("z", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue() === markdown, "公式源码剪切无法撤销");

    code = root().querySelector('code[data-type="math-inline"]');
    const preview = code.nextElementSibling;
    code.parentElement.classList.add("vditor-ir__node--expand");
    const rendered = preview.querySelector('[data-typora-source-start="6"]');
    const range = document.createRange();
    range.selectNodeContents(rendered);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const selected = getSelection().toString();
    assert(cut() === selected, "预览剪切没有按只读选区复制");
    await delay(50);
    assert(window.vditor.getValue() === markdown, "Ctrl+X 删除了只读公式预览");
  });
  await test("Editor shortcuts stay local; failed cut cannot delete on a timer", async () => {
    const markdown = "普通 ALPHA 文本\n";
    await load(markdown);
    const text = root().querySelector("p").firstChild;
    selectText(text, 3, 8);
    const forwarded = [];
    const host = event => {
      forwarded.push(event.key);
      // Simulate the Electron preload cancelling native clipboard defaults.
      if (event.ctrlKey && ["x", "c", "v"].includes(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", host);
    try {
      for (const modifier of [{ctrlKey: true}, {metaKey: true}]) {
        for (const letter of ["x", "c", "v"]) {
          const event = new KeyboardEvent("keydown", {key: letter, code: "Key" + letter.toUpperCase(),
            bubbles: true, cancelable: true, ...modifier});
          root().dispatchEvent(event);
          assert(!event.defaultPrevented, letter + " 的浏览器默认操作被取消");
        }
      }
      await delay(60);
      assert(!forwarded.length, "编辑区快捷键仍被转发给宿主");
      assert(window.vditor.getValue() === markdown, "没有 cut 事件仍被延迟删除");
      document.querySelector("#fixture").dispatchEvent(new KeyboardEvent("keydown", {
        key: "x", ctrlKey: true, bubbles: true, cancelable: true}));
      assert(forwarded.length === 1, "编辑区外的输入框快捷键被抢占");
      key("s", {ctrlKey: true});
      assert(forwarded.at(-1) === "s", "保存快捷键未保留给宿主");
    } finally {
      window.removeEventListener("keydown", host);
    }
  });
  await test("Native historyUndo/historyRedo use editor history", async () => {
    await load(base);
    const heading = root().querySelector("h1");
    caret(heading.lastChild, heading.lastChild.length);
    document.execCommand("insertText", false, "X"); await delay();
    const event = new InputEvent("beforeinput", {inputType: "historyUndo", bubbles: true, cancelable: true});
    root().dispatchEvent(event); await delay();
    assert(event.defaultPrevented, "宿主撤销仍进入浏览器 DOM 历史");
    assert(window.vditor.getValue() === base, "宿主撤销未恢复源码");
    formulasIntact();
    root().dispatchEvent(new InputEvent("beforeinput", {inputType: "historyRedo", bubbles: true, cancelable: true}));
    await delay();
    assert(window.vditor.getValue().startsWith("# 标题文字X\n"), "宿主重做未恢复文字");
    formulasIntact();
  });
  await test("Math snapshots survive pending rendering", async () => {
    await load(base);
    const editor = getEditor();
    // Recreate the interval between Lute producing source and async KaTeX finishing.
    const preview = root().querySelector(".vditor-ir__preview .language-math");
    const source = preview.parentElement.previousElementSibling.textContent;
    preview.textContent = source;
    preview.removeAttribute("data-math");
    const snapshot = document.createElement("div");
    snapshot.innerHTML = editor.undo.addCaret(editor);
    assert(snapshot.querySelector(".vditor-ir__preview .language-math").textContent === source,
      "待渲染源码被快照清空");
  });
  await test("Formula preview is outside editing path", async () => {
    await load(base);
    assert([...root().querySelectorAll(".vditor-ir__preview")].every(n => !n.isContentEditable),
      "预览内容仍可编辑");
  });
  await test("Heading levels and source boundary variants", async () => {
    for (const level of [1, 2, 6]) {
      const markdown = "#".repeat(level) + " 标题文字\n\n公式 $x+1$\n";
      for (const where of ["marker-end", "text-start", "middle", "end", "before-marker"]) {
        await load(markdown);
        const heading = root().querySelector("h" + level);
        const marker = heading.firstElementChild;
        const text = heading.lastChild;
        if (where === "marker-end") caret(marker.firstChild, marker.textContent.length);
        else if (where === "before-marker") caret(marker.firstChild, 0);
        else caret(text, where === "text-start" ? 0 : where === "middle" ? 2 : text.length);
        key("Enter"); await delay();
        const blocks = [...root().children];
        if (where === "marker-end" || where === "text-start") {
          assert(blocks[0].textContent.trim() === "#".repeat(level), level + ": " + where + " 标记未分开");
          assert(blocks[1].tagName === "P" && blocks[1].textContent.trim() === "标题文字", "标题内容未成为正文");
        } else if (where === "middle") {
          assert(blocks[0].tagName === "H" + level && blocks[0].textContent.endsWith("标题"), "左半标题内容错误");
          assert(blocks[1].tagName === "P" && blocks[1].textContent.trim() === "文字", "右半标题内容错误");
        } else if (where === "end") {
          assert(blocks[0].textContent.endsWith("标题文字") && !blocks[1].textContent.trim(), "标题末尾没有空段落");
        } else {
          assert(!blocks[0].textContent.trim() && blocks[1].tagName === "H" + level, "标题行首没有在上方插空行");
          const selection = getSelection();
          assert(blocks[1].contains(selection.focusNode), "回车后光标留在上方空行，未跟随标题下移");
          const prefix = document.createRange();
          prefix.selectNodeContents(blocks[1]);
          prefix.setEnd(selection.focusNode, selection.focusOffset);
          assert(!prefix.toString(), "回车后光标没有保持在 # 左侧");
          assert(selection.getRangeAt(0).getBoundingClientRect().height > 0, "历史快照后光标不可见");
        }
        key("z", {ctrlKey: true}); await delay();
        assert(window.vditor.getValue() === markdown, level + ": " + where + " 撤销不完整");
      }
    }
  });
  await test("Heading split preserves inline math and formatting", async () => {
    const markdown = "## 标题 **粗体** 和 $x+1$\n\n正文\n";
    await load(markdown);
    const heading = root().querySelector("h2");
    caret(heading.firstElementChild.firstChild, 3);
    key("Enter"); await delay();
    assert(window.vditor.getValue().includes("**粗体** 和 $x+1$"), "行内语法丢失");
    const math = root().querySelector(".language-math");
    assert(math?.getAttribute("data-math") === "x+1" && math.textContent, "标题内公式未渲染");
    key("z", {ctrlKey: true}); await delay();
    assert(window.vditor.getValue() === markdown, "带行内语法标题无法撤销");
  });
  await test("Arrow keys traverse source only, including Shift selection", async () => {
    await load(base);
    const code = root().querySelector('code[data-type="math-inline"]');
    const math = code.parentElement;
    math.classList.add("vditor-ir__node--expand");
    caret(math.lastElementChild.firstChild, 0);
    const expectedLength = code.textContent.length;
    for (let offset = expectedLength - 1; offset > 0; offset--) {
      key("ArrowLeft");
      assert(getSelection().focusNode.parentElement === code && getSelection().focusOffset === offset,
        "左移未逐字符移动: " + offset);
      assert(getSelection().getRangeAt(0).getBoundingClientRect().height > 0, "光标没有可见高度");
    }
    key("ArrowRight", {shiftKey: true});
    assert(getSelection().toString() === code.textContent.slice(1, 2), "Shift+方向键选区错误");
    assert(window.vditor.getValue() === base, "导航修改了正文");
  });
  const mathParts = () => {
    const code = root().querySelector('code[data-type="math-inline"]');
    code.parentElement.classList.add("vditor-ir__node--expand");
    return {code, preview: code.nextElementSibling};
  };
  const click = target => {
    assert(target, "没有生成源码位置标记");
    target.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
  };
  const assertSourceCaret = (code, expected) => {
    const selection = getSelection();
    assert(selection.isCollapsed && code.contains(selection.focusNode), "光标没有进入公式源码");
    const prefix = document.createRange();
    prefix.selectNodeContents(code);
    prefix.setEnd(selection.focusNode, selection.focusOffset);
    assert(prefix.toString().length === expected, "源码光标偏移错误: " + prefix.toString().length + " != " + expected);
  };
  await test("Preview click locates numerator, denominator, repeated a and commands", async () => {
    const markdown = "# 标题\n\n$" + mappingSource + "$\n";
    await load(markdown);
    const {code, preview} = mathParts();
    caret(code.firstChild, 0);
    const historySize = getEditor().undo.ir.undoStack.length;
    for (const offset of [6, 9, 12, mappingSource.indexOf("\\Omega"), mappingSource.indexOf("x"), mappingSource.indexOf("2")]) {
      click(preview.querySelector('[data-typora-source-start="' + offset + '"]'));
      assertSourceCaret(code, offset + (mappingSource[offset] === "\\" ? 1 : 0));
    }
    click(preview.querySelector(".frac-line"));
    assertSourceCaret(code, 1);
    click(preview.querySelector(".sqrt svg"));
    assertSourceCaret(code, mappingSource.indexOf("\\sqrt") + 1);
    await delay();
    assert(window.vditor.getValue() === markdown, "预览点击改变了 Markdown");
    assert(getEditor().undo.ir.undoStack.length === historySize, "预览点击污染了撤销历史");
  });
  await test("Preview mapping survives source edits, undo and redo", async () => {
    await load("$" + mappingSource + "$\n");
    let parts = mathParts();
    caret(parts.code.firstChild, 0);
    document.execCommand("insertText", false, "z"); await delay();
    parts = mathParts();
    const originalOffset = mappingSource.indexOf("\\Omega");
    click(parts.preview.querySelector('[data-typora-source-start="' + (originalOffset + 1) + '"]'));
    assertSourceCaret(parts.code, originalOffset + 2);
    key("z", {ctrlKey: true}); await delay();
    parts = mathParts();
    click(parts.preview.querySelector('[data-typora-source-start="' + originalOffset + '"]'));
    assertSourceCaret(parts.code, originalOffset + 1);
    key("y", {ctrlKey: true}); await delay();
    parts = mathParts();
    click(parts.preview.querySelector('[data-typora-source-start="' + (originalOffset + 1) + '"]'));
    assertSourceCaret(parts.code, originalOffset + 2);
  });
  await test("Display math preview locates its separate source block", async () => {
    const markdown = "$$\n" + mappingSource + "\n$$\n";
    await load(markdown);
    const preview = root().querySelector(".vditor-ir__preview");
    const code = preview.previousElementSibling.querySelector("code");
    preview.parentElement.classList.add("vditor-ir__node--expand");
    caret(code.firstChild, 0);
    click(preview.querySelector('[data-typora-source-start="9"]'));
    assertSourceCaret(code, code.textContent.indexOf("b"));
    click(preview.querySelector('[data-typora-source-start="14"]'));
    assertSourceCaret(code, code.textContent.indexOf("\\Omega") + 1);
    assert(window.vditor.getValue() === markdown, "块级公式定位改变了 Markdown");
  });
  await test("Fraction hit testing handles overlapping KaTeX layout boxes", async () => {
    await load("$" + mappingSource + "$\n");
    const {code, preview} = mathParts();
    caret(code.firstChild, 0);
    for (const [selector, expected] of [['[data-typora-source-start="9"]', 9], [".frac-line", 1]]) {
      const rect = preview.querySelector(selector).getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      document.elementFromPoint(x, y).dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }));
      assertSourceCaret(code, expected);
    }
  });
  await test("Selected preview text is copyable and remains read-only", async () => {
    const markdown = "$" + mappingSource + "$\n";
    await load(markdown);
    const {preview} = mathParts();
    const target = preview.querySelector('[data-typora-source-start="6"]');
    const range = document.createRange();
    range.selectNodeContents(target);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    assert(getSelection().toString() === "a", "不能选中分子");
    const clipboard = new DataTransfer();
    root().dispatchEvent(new ClipboardEvent("copy", {clipboardData: clipboard, bubbles: true, cancelable: true}));
    assert(clipboard.getData("text/plain") === "a", "预览复制不是所选文字");
    const input = new InputEvent("beforeinput", {inputType: "insertText", data: "X", bubbles: true, cancelable: true});
    root().dispatchEvent(input);
    assert(input.defaultPrevented, "预览选区仍可编辑");
    assert(key("Backspace") === false, "退格没有保护预览选区");
    assert(window.vditor.getValue() === markdown, "预览选区修改了 Markdown");
  });
  await test("Incomplete math maps both the rendered prefix and red command", async () => {
    const source = String.raw`\Omega\Omeg`;
    await load("$" + source + "$\n");
    const {code, preview} = mathParts();
    caret(code.firstChild, 0);
    click(preview.querySelector('[data-typora-source-start="0"]'));
    assertSourceCaret(code, 1);
    click(preview.querySelector('.vditor-math-error [data-typora-source-start="6"]'));
    assertSourceCaret(code, 7);
  });
  await load(base);
  state();
};
