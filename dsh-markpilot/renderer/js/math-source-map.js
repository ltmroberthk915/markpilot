/** Read-only formula hit testing using locations emitted by our KaTeX build. */
const PREVIEW = ".vditor-ir__preview";
const LOCATION = "[data-typora-source-start]";
const elementAt = node => node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
const previewAt = node => elementAt(node)?.closest(PREVIEW);

const sourceFor = preview => {
  if (!preview?.querySelector(".language-math")) return null;
  const source = preview.previousElementSibling;
  return source?.tagName === "CODE" ? source : source?.querySelector("code");
};
const isExpanded = preview => preview?.parentElement.classList.contains("vditor-ir__node--expand");

const placeCaret = (root, code, offset) => {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let node;
  let last = null;
  while ((node = walker.nextNode())) {
    if (!node.length) continue;
    last = node;
    if (offset <= node.length) {
      root.focus({preventScroll: true});
      getSelection().collapse(node, offset);
      return;
    }
    offset -= node.length;
  }
  root.focus({preventScroll: true});
  getSelection().collapse(last || code, last ? last.length : 0);
};

/** 落点上的映射元素：`{node, after}`（after = 落在它的右半边，或它就是这条公式的最后一个字形）。
 *  判定分三级，顺序不能换：
 *    1. 落在某个**叶子字形**的盒子里。KaTeX 的隐形 vlist 行会压住分母、分数线会压住分子
 *       下方，所以取"包含它的、面积最小的"那个，而不是只看 event.target。
 *    2. 落在某个**映射元素的盒子**里，但那个元素自己没有映射。显示模式的 `\sum`/`\int`/`\lim`
 *       这类大运算符就是这个样子：KaTeX 把它包在 vlist 里，映射挂在外层 `mop` 上（实测
 *       scripts/acceptance/probe-math6.cjs：点 ∑ 字形本身，二级判定算出来的"最近字形"是
 *       下标里的 `=`，光标于是跑进 `\sum_{i=1}` 的第一个参数里——用户报告 2026-09-14 第 6 轮
 *       第 2 条）。落点既然真在某个映射元素的盒子里，就按**这个盒子**的映射算。
 *    3. 都没命中（点在字形的缝里、或行末那条空白带上）→ 取**最近的那个字形**。
 *  **行末**（用户 2026-09-14 第 7 轮把口径说明白了）："点在最后一个逗号及之后的任何本行元素处，
 *  光标都要落到逗号**之后**"。所以公式的**最后一个字形**整格（左右半边都算）连同它右侧的空白带
 *  一律给 `after`，`targetOffset` 因此返回这条公式源码的**末尾**。 */
const mappedMathLocationAtPoint = (preview, event) => {
  const element = elementAt(event.target);
  const direct = element?.closest(LOCATION);
  if (!event.clientX && !event.clientY) return direct ? {node: direct, after: false} : null;
  const containsPoint = rect => rect.width > 0 && rect.height > 0 &&
    event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  const half = rect => event.clientX >= rect.left + rect.width / 2;
  /** 渲染结果里最后一个**可见的**叶子字形（文档序）：行末判定的锚点 */
  const tail = (() => {
    let last = null;
    for (const node of preview.querySelectorAll(LOCATION)) {
      if (node.querySelector(LOCATION)) continue;
      for (const rect of node.getClientRects()) if (rect.width && rect.height) { last = node; break; }
    }
    return last;
  })();
  const at = (node, after) => ({node, after: after || node === tail, tail: node === tail});
  // KaTeX's invisible vlist rows overlap the denominator. Its fraction rule
  // also overlaps the font box below the numerator. Resolve against the boxes
  // that actually display a symbol/rule instead of trusting event.target alone.
  for (const rule of preview.querySelectorAll(".frac-line,.overline-line,.underline-line")) {
    const rect = rule.getBoundingClientRect();
    if (containsPoint(rect)) return at(rule.closest(LOCATION), false);
  }
  let closest = null;
  for (const node of preview.querySelectorAll(LOCATION)) {
    if (node.querySelector(LOCATION)) continue;
    for (const rect of node.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      if (containsPoint(rect) && (!closest || rect.width * rect.height < closest.rect.width * closest.rect.height)) {
        closest = {node, rect};
      }
    }
  }
  if (closest) return at(closest.node, half(closest.rect));
  // 只认"这一层自己就画着字"的元素（无子元素、文本非空）：KaTeX 的 vlist/strut 空壳会横向
  // 盖到相邻字形上（实测用户那条公式 y=398 处 x=410 这 1px），拿它当依据会把光标退回上一格。
  if (direct && element.children.length === 0 && (element.textContent || '').length) {
    const rect = direct.getBoundingClientRect();
    // 容器（外层 mop 之类）不给 after：它的 end 是一个**组**的右界，不是字形的右界。
    if (containsPoint(rect)) return at(direct, false);
  }
  // **字形缝隙**：KaTeX 的字形之间有空隙，上下还有 strut/vlist 留白，点在这些地方
  // 谁都不"包含"它。旧实现在这里返回 null，调用方只能把光标随便放——放的是
  // `placeCaret(code, 0)`，也就是**一律扔到这条公式源码的第 0 位**。实测（真产物、
  // 用户文档第 227 行的 `$f=f^+-f^-$`，scripts/acceptance/probe-paren9.cjs）：沿公式框
  // 每 4px 取一点、共 23 点，其中 6 点落进 offset 0，**右半也有 1 点**；光标偏移序列
  // [0,0,0,0,1,1,1,0,2,2,2,4,4,0,5,…] 有两次回退——点公式中段，光标跑到公式最前面。
  // 用户报告的"点在某个像素上，光标跑到最开始"就是这个形状，而且只有公式会这样
  //（正文里点哪儿是哪儿）。
  // 落点既然在公式的框里，就按**离它最近的那个字形**算：缝里点一下，光标停在缝边上
  // 那个字符。语义与浏览器"点空白处夹到最近位置"一致，也让"点哪儿光标在哪儿"单调。
  const box = preview.getBoundingClientRect();
  const insideBox = box.width > 0 && box.height > 0 &&
    event.clientX >= box.left - 1 && event.clientX <= box.right + 1 &&
    event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1;
  if (!insideBox) return direct ? {node: direct, after: false} : null;
  let nearest = null;
  let gap = Infinity;
  for (const node of preview.querySelectorAll(LOCATION)) {
    if (node.querySelector(LOCATION)) continue;
    for (const rect of node.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const dx = event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
      const dy = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
      const distance = dx || dy ? Math.hypot(dx, dy) : 0;
      if (distance < gap) {
        gap = distance;
        nearest = {node, rect};
      }
    }
  }
  // 缝隙里也要认"左半/右半"，否则光标会退一格：实测（probe-math9 用户那条公式的
  // y=298 行）`=` 右缘 584 与 `0` 左缘 589 之间那 5px 的缝里，落点离 `=` 更近，
  // 光标就回到 `=` 的起点（75），而紧挨着它的右边一格给的是 76——点着往右走，
  // 光标却在缝里往回跳一格。半格规则在缝里也必须连着，才是"点哪儿光标在哪儿"。
  // 行末空白带（最近的字形就是最后一个字形）由 at() 给 after → 光标落到源码末尾。
  return nearest ? at(nearest.node, half(nearest.rect)) : (direct ? {node: direct, after: false} : null);
};

/** 只要"点到了哪个映射元素"的调用方（方向键按符号跳转）用这个。 */
export const mappedMathNodeAtPoint = (preview, event) => mappedMathLocationAtPoint(preview, event)?.node || null;


const targetOffset = (preview, code, event) => {
  const hit = mappedMathLocationAtPoint(preview, event);
  const mapped = hit?.node;
  if (!mapped || !preview.contains(mapped)) return null;
  const rendered = preview.querySelector(".language-math").getAttribute("data-math");
  const source = code.textContent;
  // A preview can briefly lag behind a keystroke. Never use locations from an
  // older render to move the caret in newly edited source.
  let prefix = 0;
  if (rendered !== source) {
    if (!rendered || source.trim() !== rendered) return null;
    prefix = source.length - source.trimStart().length;
  }
  const start = Number(mapped.getAttribute("data-typora-source-start"));
  const end = Number(mapped.getAttribute("data-typora-source-end"));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > rendered.length) return null;
  // **行末**（用户 2026-09-14 第 7 轮把口径说明白了）："点在最后一个逗号及之后的任何本行
  // 元素处，光标都要落到逗号之后"。所以公式最后一个字形整格（左右半边都算）连同它右侧的
  // 空白带一律返回源码末尾。这条要排在命令规则**前面**：万一公式以命令结尾（如 `\alpha`），
  // 行末语义也要压过"进到反斜杠之后"。
  if (hit.tail) return prefix + end;
  // Ω -> \|Omega, fraction bar -> \|frac, ordinary a -> |a.
  // 命令（\sum/\int/\lim/\frac…）落在左半边右半边都一样：光标进到反斜杠之后。用户
  // 2026-09-14 第 6 轮第 2 条要的就是这个（点 ∑ 落在 `\` 和 `s` 之间），行内公式一直
  // 是这个语义，显示模式用同一条规则。
  if (rendered[start] === "\\" && end > start + 1) return prefix + start + 1;
  // 普通字形的右半边：光标落到这个字形之后。
  if (hit.after) return prefix + end;
  return prefix + start;
};

/** 落点 → 源码字符偏移 / 把光标放进源码：拖拽接管（math-select-reveal）要复用同一套映射，
 *  免得"点公式"和"从公式拖拽"两条路各算一遍、算得还不一样。 */
export const sourceOffsetAtPoint = (preview, code, event) => targetOffset(preview, code, event);
export const placeCaretInCode = (root, code, offset) => placeCaret(root, code, offset);

/** 公式自己的源码元素（行内是直接子元素，块公式在 pre 里）。 */
const SOURCE = 'code[data-type="math-inline"], code[data-type="math-block"]';

export const installMathSourceNavigation = root => {
  let pointer = null;
  let pressedInSource = false;
  /** 按下落在真源码里时，记下**按下那一刻**浏览器自己的命中结果（文本节点 + 偏移）。 */
  let pressedPoint = null;
  const selectionInPreview = () => {
    const selection = getSelection();
    return previewAt(selection.anchorNode) || previewAt(selection.focusNode);
  };
  root.addEventListener("mousedown", event => {
    const preview = previewAt(event.target);
    const element = elementAt(event.target);
    // 按下就落在**这条公式自己的源码**里：那是真文字，浏览器自己的命中测试点哪儿是哪儿，
    // 我们借渲染浮框几何算出来的映射不会更好（见 click 里的长注释）。
    pressedInSource = !preview && !!element?.closest?.(SOURCE);
    pointer = null;
    pressedPoint = null;
    if (pressedInSource && event.button === 0 && event.detail <= 1
      && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // 按下这一刻源码还看得见（REVEAL 或展开态），命中测试是准的；松手之后版面可能已经翻了
      // （见 click 里"按下为准"的说明），所以按下的偏移必须先记下来。
      const code = element.closest(SOURCE);
      const text = code && code.firstChild && code.firstChild.nodeType === 3 ? code.firstChild : null;
      const hit = root.ownerDocument.caretRangeFromPoint
        ? root.ownerDocument.caretRangeFromPoint(event.clientX, event.clientY) : null;
      if (text && hit && hit.startContainer === text) pressedPoint = {code, text, offset: hit.startOffset};
    }
    if (!preview || event.button !== 0) return;
    const code = sourceFor(preview);
    if (!code) return;
    const selection = getSelection();
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    pointer = {
      preview, x: event.clientX, y: event.clientY, dragged: false,
      // **按下这一刻**就把落点映射成源码偏移，click 时不再重算。原因（实测，见下）：
      // 按下之后 refreshMathEditing 会把这条公式翻成展开态（光标进了源码），渲染结果随即
      // 不可测——同一个点在 mousedown 时算出 offset=1，到 mouseup/click 时算出 null
      //（scripts/acceptance/probe-paren10.cjs 的同一事件序列取证）。旧实现只在 click 时算，
      // 于是经常算不出来、走兜底把光标扔到源码第 0 位：**点公式中段，光标跑到公式最前面**。
      // 落点本来就该按用户瞄准时的那个版面算，按下时算一次是最自然的位置。
      offset: targetOffset(preview, code, event),
      sourceRange: range && code.contains(range.startContainer) ? range.cloneRange() : null,
    };
    if (!isExpanded(preview)) {
      // 折叠公式上按下：不再 preventDefault——那会让 Chromium 不把这次按下当成"可以起
      // 选区"，用户按在公式上拖就一点反应都没有（报告原话："按住点不松手拖拽选中"做不到）。
      // 光标照旧不会落进渲染结果：它是 user-select:none，浏览器自己就会夹到最近的可选位置；
      // "渲染结果内部不许编辑"由下面的 beforeinput / 退格 / 粘贴守卫兜着。
      return;
    }
    // 展开态：浮出的预渲染框上按下，语义就是"在这条公式的源码里落光标"（用户 2026-09-15：
    // "能否在 inline math 的预渲染框也同样建立像素级到光标的映射链接"）。
    // 旧实现把落点让给浏览器自己夹，实测不行（scripts/acceptance/probe-inline-box-map.cjs，
    // 展开后沿浮框宽度取 5 个点）：点公式中段得到的是**源码偏移 0**——浏览器的光标解进了
    // katex 子树（预览是 user-select:text，折叠态的渲染结果也一样，那条路是靠 click 里的映射
    // 兜回来的）；点浮框的内边距更糟，光标被甩到框外的正文里，refreshMathEditing 当场把这条
    // 公式收回去（逐帧采到"展开=false"），松手后又弹回来，一次点击跳两下。
    // 这里与按下的语义对齐：按**按下那一刻**的版面算好偏移、把光标放进源码并吃掉这次按下。
    // 于是按下之后光标就在源码里，这条公式不会被收回去，click 里那次映射照旧跑、算出同一个
    // 偏移，是幂等的。多击（选词）与带修饰键的按下照旧留给浏览器；算不出映射的（预览不是
    // 我们这份 KaTeX 渲染的）也留给原生日志。
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
        event.detail <= 1 && pointer.offset !== null) {
      event.preventDefault();
      placeCaret(root, code, pointer.offset);
    }
  }, true);
  root.addEventListener("mousemove", event => {
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) pointer.dragged = true;
  }, true);
  /** 映射不出来时的最后手段：按落点落在这条公式的哪一半决定贴哪一边。
   *  量不到盒子就返回 null，由调用方把这次点击**原样还给浏览器**。
   *  旧实现把"盒子量不出来"当成"贴开头"（`box.width > 0 && ...` 恒假），于是展开态/REVEAL 态
   *  （浮框被 CSS 摊成 0×0）里点源码，光标一律跳到**公式源码第 0 位**——用户 2026-09-23 报的
   *  "点 `\left[` 与 `\frac` 之间光标跳动"就是这条（实测记事：
   *  scripts/acceptance/probe-repro-inline-click-jump.cjs 的 E1：拖选跨过渲染结果后点 offset 8，
   *  光标落到 0；同文件的 D1–D3 无选区时落点正确）。 */
  const 贴边偏移 = (preview, host, code, event) => {
    const 预览框 = preview.getBoundingClientRect();
    const box = 预览框.width > 0 ? 预览框 : host.getBoundingClientRect();
    if (!box.width) return null;
    return event.clientX > box.left + box.width / 2 ? code.textContent.length : 0;
  };
  root.addEventListener("click", event => {
    const gesture = pointer;
    const 起于源码 = pressedInSource;
    const 按下 = pressedPoint;
    pressedInSource = false;
    pressedPoint = null;
    pointer = null;
    // 拖拽收尾时浏览器还会补发一次 click（按下与松开在同一侧），那不是"单击"：
    // 放它过去，Vditor 会按选区落点把光标挪进源码、refreshMathEditing 跟着展开这条公式，
    // **刚从公式上拖出来的选区会当场被收掉**（实测：拖拽全程 collapsed=false，一到 click
    // 就变 collapsed=true）。所以这一次必须吃掉。
    if (gesture?.dragged) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest?.(".vditor-ir__node") || null;
    const own = host?.querySelector?.(':scope > code[data-type="math-inline"], :scope > pre > code[data-type="math-block"]');
    if (!host || !own) return;
    // 只接管"落在公式身上"的点击：预览里（渲染结果）或我们翻开的源码里（`.typora-ir-selected`
    // ——按下那一刻翻成源码之后，click 的落点就从预览变成了源码，这里必须一起认，否则
    // "点公式本体"会漏成普通点击、被浏览器把光标扔到行尾）。
    if (!previewAt(event.target) && !host.classList.contains("typora-ir-selected")) return;
    // **按下的那一刻就落在真源码文字里**：这次点击的权威是浏览器自己的命中测试——源码是
    // 真文字，点哪儿是哪儿；我们的像素映射只对**渲染结果**负责。这条闸门是 2026-09-23 补的：
    // 拖选跨过渲染结果会让节点带上 `typora-ir-selected`（REVEAL），于是这条"必须一起认"的
    // 分支把一个**源码点击**也接了过来，而映射在 REVEAL 态下必然算不出来（浮框被 CSS 摊成
    // 0×0），落到下面的贴边兜底 → 光标跳到源码第 0 位。实测 E1（见贴边偏移的注释）。
    //
    // 但"按下在源码里"还不够：按下这一下会让选区塌陷 → REVEAL 收起 → 源码藏回去、渲染结果
    // 顶回来；**松手快的时候 click 落在翻过之后的版面上**，浏览器按新版面解出来的落点就跑到
    // 别处（实测：点源码第 8 格，光标落到第 0 位；按下后停 120ms 再松手就没事——
    // scripts/acceptance/probe-repro-reveal-press-flip.cjs）。所以这里按**按下那一刻**的
    // 命中结果核对一次：对得上（±1 格）就不动，对不上就按按下时的偏移落点。
    if (起于源码) {
      const doc = root.ownerDocument;
      if (按下 && 按下.code.isConnected && 按下.text.isConnected) {
        const selection = getSelection();
        const 现在 = selection && selection.focusNode === 按下.text ? selection.focusOffset : null;
        if (现在 === null || Math.abs(现在 - 按下.offset) > 1) {
          const range = doc.createRange();
          range.setStart(按下.text, Math.min(Math.max(按下.offset, 0), 按下.text.length));
          range.collapse(true);
          event.preventDefault();
          event.stopImmediatePropagation();
          root.focus({preventScroll: true});
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      return;
    }
    // 块公式（$$…$$）只接"能算出源码偏移"的点击，算不出就把这次点击还给 Vditor 的
    // rawblock 路径——它的点击/退格语义（math-caret 的"块公式渲染结果正中按退格零改动"）
    // 依赖那条路。v2.1.11 之前这里是无条件 return（"只管行内公式"），代价是**块公式的
    // 渲染结果点了没反应**：光标停在原处，既不进源码也不展开（test/regression.js 的
    // "Display math preview locates its separate source block" 就是这么红的，实测量到
    // 偏移 0 != 9）。现在改成"映射成功才接管"，两边都要得。
    const blockMath = host.dataset.type !== "inline-node";
    const preview = host.querySelector(':scope > .vditor-ir__preview');
    if (!preview) return;
    const code = sourceFor(preview);
    if (!code) return;
    const selection = getSelection();
    if (event.shiftKey) return;
    const mapped = targetOffset(preview, code, event);
    if (blockMath && mapped === null) return;
    // 折叠态也走这里：mousedown 不再 preventDefault（那是拖拽能起选区的前提），浏览器
    // 会把光标落在"离落点最近的位置"，而落点常常正好压在公式上——于是"点公式本体"会把
    // 光标扔到行尾、公式反而不展开（math-caret v2.1.1 断言）。这里按落点把它映射回源码，
    // 展开交给随后的 refreshMathEditing（光标在源码里就算在编辑这条公式）。
    const 还原选区 = gesture?.sourceRange && code.contains(gesture.sourceRange.startContainer) ? gesture.sourceRange : null;
    const offset = mapped ?? gesture?.offset ?? 贴边偏移(preview, host, code, event);
    // 什么都定不下来（映射、按下时的映射、贴边都不成立，也没有可还原的选区）：**这次点击
    // 原样还给浏览器**——既不放走事件又不挪光标，是"吞掉点击"里最坏的一种（旧实现就是
    // 在 preventDefault 之后才走到这一步，于是光标只能停在原地）。
    if (offset === null && !还原选区) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!selection.isCollapsed && selectionInPreview()) return;
    if (offset !== null) {
      placeCaret(root, code, offset);
    } else {
      root.focus({preventScroll: true});
      selection.removeAllRanges();
      selection.addRange(还原选区);
    }
  }, true);
  for (const type of ["copy", "cut"]) {
    root.addEventListener(type, event => {
      if (!selectionInPreview() || getSelection().isCollapsed || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", getSelection().toString());
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  root.addEventListener("beforeinput", event => {
    // Drag selection is for reading/copying. It must never let browser editing
    // delete a rendered subtree or put typed text into KaTeX's generated DOM.
    if (selectionInPreview() && event.inputType !== "historyUndo" && event.inputType !== "historyRedo") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  root.addEventListener("keydown", event => {
    if (selectionInPreview() && (event.key === "Backspace" || event.key === "Delete")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
};
