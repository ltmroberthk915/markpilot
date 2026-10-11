/** 记号与光标的两条边界规则。
 *
 *  ── 一、行内记号（`**bold**`、``code`` 的记号字符）不该接住"随手一点"的光标 ──
 *
 *  用户报告（2026-09-14，第 1 条）：在"…Nikodym 导数**。"这句里点"数"和"。"之间，
 *  预期光标插在句号之前；实际常常落进收尾的 `**` 记号里（同一个毛病 2.1.8 就有，不是
 *  这一版带出来的）。落进去的后果不只是"位置看起来怪"：
 *    · 退格会**吃掉记号里的一个星号**，`导数**。` 当场变成 `导数*。`（实测）；
 *    · Shift+← 选到记号再打字，会插出 `*X*`（斜体），Markdown 被改坏。
 *  再点一次"数"里面是好的，所以这属于"偶尔中招"的那类（用户原话："大概率"）。
 *
 *  **按下那一帧不许读几何**（这条是实测撞出来的，写在最前面免得后人再踩）：
 *  最初的实现是在捕获阶段的 mousedown 里量每个记号的可视性（`getComputedStyle` +
 *  `getBoundingClientRect`），用它判断"用户瞄不瞄得到这个记号"。结果"行尾点一下"这个既有
 *  用例直接红了：光标从"段尾"跑到"段首"（`desktop-math-caret.cjs` 的"行尾输入落在公式之后"）。
 *  对照实验：同一份代码里只把 `armed` 改成 false（照旧读、但不做任何动作）——一样红；
 *  把读取整段去掉就恢复正常。也就是说，**问题出在按下这一帧强制布局**：Chromium/Vditor 对
 *  "点在没有文字的空处"该落哪儿的光标判定，跟这次刷新发生在 Vditor 的处理器之前有关。
 *  所以现在按下时什么都不读、什么都不改，只置一个 armed 标记；判断推迟到光标真的落进
 *  记号之后再做（`fix()` 里读几何是安全的：那一帧光标已经定下来了）。
 *
 *  判断放在 selectionchange（按下之后的落点就是它产生的）：光标落在 `.vditor-ir__marker`
 *  里就把光标请回这条行内节点的正文边界（前记号→内容开头，后记号→内容结尾）。
 *  只认文字格式节点（加粗/斜体/行内代码/链接…）：行内公式与图片（`data-type="inline-node"`）
 *  走 math-source-map.js 那套，实测它们的 `$` 记号不会接住光标（点公式右侧 +1px 退格只删
 *  空格），不在这条规则范围里。
 *  · 键盘一介入就解除武装：**键盘把光标挪进记号是用户故意的**（改 `**` 成 `*` 这类编辑），
 *    那条路要保持可用；只有"点一下就把光标吸进记号"才纠正。
 *  · 拖拽（按下不松手）不纠正：拖拽中光标落在哪儿由选区端点决定，翻开的公式还会动几何，
 *    这里插手会把 math-select-reveal 的拖拽端点搞乱。
 *
 *  ── 二、块首的**结构记号**（标题的 `# `）反过来：光标该留在井号之前 ──
 *
 *  用户报告（2026-09-15，重识.md，第 1 条）：点开标题露出 `# 一、事件与集合` 之后，
 *  **点井号左侧，光标却跑到井号右边**；只有"点井号右侧 + 按左方向键"才能走到井号之前。
 *
 *  实测（scripts/acceptance/probe-heading-marker-left2.cjs，安装版 2.1.24，真鼠标＋真 DOM）：
 *  · 浏览器自己的命中测试 `caretRangeFromPoint` 在井号左边 8px 处给的就是
 *    `(# 文本节点, 0)`，也就是**井号之前**——原生行为本来就是用户想要的那样；
 *  · 而真实点击同一批坐标之后，光标全都落在正文开头（`一、事件与集合` 的 offset 0），
 *    并且每次都留下 `window.__typoraMarkerCaret = {moved:true, atStart:true, …}`：
 *    **是上面第一条规则把它请过去的**。
 *
 *  两者的区别在"记号左边有没有正文"：
 *  · 行内 `**`：左边是正文（`导数`），光标进记号是**陷阱**（退格吃星号），必须请走；
 *  · 标题 `# `：它是块的首个子节点，左边什么都没有，"光标在井号之前"就是**块首**，
 *    是用户看得见、方向键也走得到的正常位置（`probe-heading-marker-left8` 实测：
 *    在井号之前打字，字会进正文，不会插坏 `#`），所以该留着。
 *  只有块首这一种以"块是展开的（记号真的画出来了）"为准：记号被收起时它是个看不见的坑
 *  （光标落在里面画不出来、退格还会偷偷吃掉 `#`），照旧请到正文起点。
 *
 *  ── 三、块首退格：`# ` 之前按退格是"块首删除"，不是"删掉井号" ──
 *
 *  用户报告（2026-09-15，重识.md，第 2 条）："光标出现在最左侧之后点退格键……使得井号键被
 *  删除了，这个非常奇怪错误的逻辑"——光标明明在井号**之前**，删掉的却是它**右边**的字符。
 *
 *  实测（scripts/acceptance/probe-heading-marker-left6.cjs，2.1.24，五种落点 × 两种上文）：
 *  · 上一块是**普通段落**：块首退格 = 合并到上一段（`上一段文字。目标标题`），井号随正文一起
 *    并进上一段——这是各家编辑器的标准"块首删除"，留着；
 *  · 上一块是**表格**（用户文档就是这种）：Chromium 的"向后合并"合并不进表格，**退化成向前删**
 *    ——`#` 被吃掉、标题降级，还把标题和**后面**那一段并成一行
 *    （`目标标题标题后的正文。`）。这就是用户说的"奇怪错误的逻辑"。
 *  拦住 Vditor（在 window 捕获阶段 `stopImmediatePropagation`）之后现象一模一样，所以这不是
 *  Vditor 干的，是浏览器默认动作；要改就必须自己接管这一按。
 *
 *  规则：光标在块首结构记号之前时按退格——
 *    · 上一块是**能吞下正文的块**（段落 / 标题 / 引用）→ 不插手，交给浏览器合并（保持现状）；
 *    · 其余（表格、代码块、公式块、HTML 块、文档第一个块）→ `preventDefault()`，这一按什么
 *      也不做。**宁可什么都不发生，也不能悄悄删掉标题的语法字符**（用户报了"井号被删"，
 *      "没反应"是可解释、可撤销的，后者不是）。
 *
 *  这条只管**块首**（井号之前 / 块元素 offset 0）。光标在正文起点（`# ` 之后）时按退格仍是
 *  Vditor 原来的"去掉标题级别"，那条手势有用（点正文起点再按退格＝把标题降级），不动它。
 */

const MARKER = '.vditor-ir__marker';
const NODE = '.vditor-ir__node';
/** 挨得住"块首合并"的上一块：正文类块。列表项刻意不算——把标题并进 `<li>` 会把列表结构搅坏，
 *  那种情况宁可什么都不发生。 */
const MERGEABLE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DD', 'DT']);

const isMarker = node => node.nodeType === 1 && node.classList.contains('vditor-ir__marker');
/** 记号 vs 内容：Vditor IR 里**公式源码的 code 元素也带 marker 类**（vditor-ir__marker--pre）。
 *  它是要编辑的正文，不是记号——块公式点击后光标就该落在 code 里
 *  （desktop-math-caret 的点击块公式后光标落在源码里断言）。所以 code 一律按内容算。 */
const isCode = node => node.nodeType === 1 && node.tagName === 'CODE';
/** 块首的结构记号：宿主是标题（或记号自己声明是 heading-marker），而且是宿主的首个子节点。
 *  块首记号左边没有正文，不存在"记号洞"陷阱，见文件头第二节。 */
const isBlockMarker = (marker, host) =>
  marker === host.firstElementChild && (marker.dataset.type === 'heading-marker' || /^H[1-6]$/.test(host.tagName));
/** 正文边界：跳过记号，取这条行内节点里第一个/最后一个真正的内容字符位置。 */
const contentAt = (node, atStart) => {
  const kids = [...node.childNodes].filter(child =>
    !isMarker(child) && !(child.nodeType === 3 && !child.data.length));
  // 行内公式的源码 code 也带 marker 类（vditor-ir__marker--pre），所以"没有内容"时
  // 直接放弃纠正——公式那条路本来就不归这里管。
  const pick = atStart ? kids[0] : kids[kids.length - 1];
  if (!pick) return null;
  if (pick.nodeType === 3) return {node: pick, offset: atStart ? 0 : pick.data.length};
  const walker = node.ownerDocument.createTreeWalker(pick, NodeFilter.SHOW_TEXT);
  let text = null;
  let last = null;
  while ((text = walker.nextNode())) { if (!text.data.length) continue; last = text; if (atStart) break; }
  if (!last) return null;
  return {node: last, offset: atStart ? 0 : last.data.length};
};
/** 记号**画出来**的左边界；记号被收起（`display:none` 一类）时给 null。
 *  只在 fix() 那一帧调用——按下那一帧读几何会把既有用例弄红，原因见文件头。 */
const paintedLeft = marker => {
  const text = marker.firstChild;
  if (!text || text.nodeType !== 3 || !text.length) return null;
  const range = marker.ownerDocument.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  const box = range.getBoundingClientRect();
  return box.width > 0 ? box.left : null;
};
/** 上一块（跳过 Vditor 会插在块之间的小元素）。 */
const previousBlock = block => {
  let node = block.previousElementSibling;
  while (node && /^(WBR|BR)$/.test(node.tagName)) node = node.previousElementSibling;
  return node;
};
/** 光标是不是停在"块首结构记号之前"（记号 offset 0，或块元素 offset 0）。
 *
 *  **第三种形状：块首的正文 offset 0**（`# ` **右侧**、正文最前面那个位置）。
 *  实测（scripts/acceptance/probe-repro-headbackspace.cjs，2026-09-20）：点标题正文再按 ←
 *  落到这里（文本节点 offset 0、不在记号里），此时按退格**会把 `#` 吃掉**——正是用户
 *  2026-09-15 报的那个"非常奇怪错误的逻辑"，只是换了个落点形状（原来只认"记号里 offset 0"）。
 *  所以这里把它也算作块首：能不能合并交给上层原逻辑（能合并就走浏览器、不能就拦下）。 */
const atBlockStart = range => {
  const start = range.startContainer;
  if (start.nodeType === 1) {
    const marker = start.firstElementChild;
    return marker && marker.matches(MARKER) && isBlockMarker(marker, start) && range.startOffset === 0
      ? {marker, block: start} : null;
  }
  if (range.startOffset !== 0) return null;
  const marker = start.parentElement?.closest?.(MARKER);
  if (marker && !isCode(marker)) {
    const block = marker.closest(NODE);
    return block && isBlockMarker(marker, block) ? {marker, block} : null;
  }
  // 正文 offset 0：必须是这个块的**第一个正文位置**（`contentAt` 跳过记号后的那一个），
  // 否则"加粗段开头"之类块中间的 offset 0 也会被当成块首。
  const block = start.parentElement?.closest?.(NODE);
  if (!block) return null;
  const head = block.firstElementChild;
  if (!head || !head.matches(MARKER) || !isBlockMarker(head, block)) return null;
  const spot = contentAt(block, true);
  return spot && spot.node === start && spot.offset === 0 ? {marker: head, block, atContent: true} : null;
};

export const installMarkerCaretGuard = root => {
  let armed = false;      // 光标是"鼠标点出来的"，还允许纠正一次
  let down = false;       // 手指还按着
  let timer = 0;
  let clickX = null;      // 那次按下的横坐标（不是几何量测，只是把事件里的数字记下来）

  const note = (extra) => {
    window.__typoraMarkerCaret = {moved: false, ...extra};
  };
  const fix = () => {
    timer = 0;
    if (!armed || down) return;
    const selection = getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const marker = element?.closest?.(MARKER) || null;
    if (!marker || isCode(marker)) return;                 // 源码 code 是内容，不动
    const host = marker.closest(NODE);
    if (!host || host.dataset.type === 'inline-node' || host.dataset.type === 'math-block') return;
    const atStart = marker === host.firstElementChild;

    if (isBlockMarker(marker, host)) {
      const left = paintedLeft(marker);
      const drop = () => { armed = false; root.focus({preventScroll: true}); };
      if (left !== null && clickX !== null && clickX <= left + 2) {
        // 点在（或点到了）井号左侧：块首就是井号之前，光标留在那儿。
        const spot = marker.firstChild;
        if (spot && !(range.startContainer === spot && range.startOffset === 0)) {
          drop();
          selection.collapse(spot, 0);
          note({moved: true, mode: 'block-start', marker: String(marker.className).slice(0, 40), type: String(host.dataset.type), clickX: Math.round(clickX), markerLeft: Math.round(left)});
          return;
        }
        armed = false;                                     // 已经在块首：这一按到此为止
        note({moved: false, mode: 'block-start-kept', marker: String(marker.className).slice(0, 40), type: String(host.dataset.type), clickX: Math.round(clickX), markerLeft: Math.round(left)});
        return;
      }
      if (left !== null) {
        // 点的是画出来的记号自己（`#` 的右半边、那个空格）或块内正文：浏览器给的落点
        // 都是能编辑的正常位置，不再插手。
        armed = false;
        note({moved: false, mode: 'block-marker-kept', marker: String(marker.className).slice(0, 40), type: String(host.dataset.type)});
        return;
      }
      // 记号被收起（块没展开）：它是个看不见的坑，照旧请到正文起点。
    }

    const spot = contentAt(host, atStart);
    if (!spot) return;
    armed = false;
    if (range.startContainer === spot.node && range.startOffset === spot.offset) return;   // 已经在边界上
    // 先解除武装再动光标：我们这次 collapse 会再触发一次 selectionchange。
    root.focus({preventScroll: true});
    selection.collapse(spot.node, spot.offset);
    window.__typoraMarkerCaret = {moved: true, atStart, marker: String(marker.className).slice(0, 40), type: String(host.dataset.type)};
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(fix, 0);
    requestAnimationFrame(() => { if (armed && !down) fix(); });
  };

  const onDown = event => {
    armed = false;
    // 这里**不读几何**（原因见文件头）。只认"单键单击"，其余手势不纠正。
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.detail > 1) return;
    down = true;
    armed = true;
    clickX = event.clientX;
  };
  const onUp = () => {
    down = false;
    if (armed) schedule();
  };
  const onSelectionChange = () => {
    if (!armed || down) return;
    schedule();
  };
  const disarm = () => { armed = false; down = false; };

  /** 块首退格（见文件头第三节）。挂在捕获阶段：Vditor 的同名按键处理在冒泡阶段，先到先得。 */
  const onKeyDown = event => {
    if (event.key !== 'Backspace' || event.isComposing || event.defaultPrevented) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const selection = getSelection();
    if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
    const found = atBlockStart(selection.getRangeAt(0));
    if (!found) return;
    const previous = previousBlock(found.block);
    if (previous && MERGEABLE.has(previous.tagName)) {
      // 能合并：交给浏览器。**但从"正文 offset 0"那形状进来时要先把光标挪到记号之前**——
      // Chromium 在正文 offset 0 上按退格是"删左边一个字符"，删掉的正是 `#`（实测
      // probe-repro-headbackspace.cjs：一次退格 `# ` 就没了；而落在记号之前时它会正常合并进上一段）。
      if (found.atContent) {
        const spot = found.marker.firstChild;
        if (spot) selection.collapse(spot, 0);
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__typoraBlockStartBackspace = {blocked: true, prev: previous ? previous.tagName : null};
  };

  root.addEventListener('mousedown', onDown, true);
  root.ownerDocument.addEventListener('mouseup', onUp, true);
  root.ownerDocument.addEventListener('selectionchange', onSelectionChange);
  // 键盘/输入法一介入就不再纠正：把光标挪进记号是用户故意的编辑动作。
  root.addEventListener('keydown', disarm, true);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('beforeinput', disarm, true);
  root.addEventListener('mousemove', event => { if (down && (event.buttons & 1)) armed = false; }, true);  // 拖拽不纠正
  window.addEventListener('blur', disarm);

  return () => {
    if (timer) clearTimeout(timer);
    root.removeEventListener('mousedown', onDown, true);
    root.ownerDocument.removeEventListener('mouseup', onUp, true);
    root.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    root.removeEventListener('keydown', disarm, true);
    root.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('beforeinput', disarm, true);
    window.removeEventListener('blur', disarm);
  };
};
