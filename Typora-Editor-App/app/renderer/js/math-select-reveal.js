import {sourceOffsetAtPoint} from './math-source-map.js';

/** 鼠标拖拽选中压在公式上时的手感（照 Typora）。
 *
 *  用户报告（2026-09-13）：含公式的段落"按住鼠标拖拽整体选中"做不到；拖拽时"只有文字有
 *  蓝色底纹、公式区没效果"；光标放末尾往前选整段，复制出来是空白。要的是 Typora 的手感。
 *
 *  实测把这事拆成三件独立的小事：
 *    1. 从**文字**上按下、拖过公式：本来就能选中，跨过的公式底纹照常有（不用改）；
 *    2. 从**公式**上按下再拖：一点反应都没有。两个原因叠在一起——
 *       a) 折叠公式的 mousedown 被 preventDefault 掉了，Chromium 不把这次按下当成"可以起
 *          选区"（math-source-map.js 已改成放行）；
 *       b) 渲染结果带着 `contenteditable="false"`，原生拖拽被关在这条公式内部（实测：从
 *          公式上往段尾拖，选区只能到公式内部十来个字符）——见 onDown 里那一帧做的事。
 *    3. 松手之后照 Typora：拖拽过程中跨过的公式保持渲染态，只把"选区端点切进去的那几条"
 *       翻成源码，并把该端吸到整条公式（Typora 的 includeTrailMeta：绝不留下半个 $）。
 *
 *  为什么不干脆把渲染结果改成 user-select:text（那样天然可选、天然能拖进去）：实测会牵动
 *  一大片既有语义——光标会落进 katex 子树、行尾点一下又弹出预渲染框（math-caret 套件当场
 *  变红），而且拖拽中一旦展开公式，Chromium 会握着"落点在预览里"的锚点却找不到盒子、把刚
 *  建起来的选区当场打塌。摘掉 contenteditable 只解除"围栏"，其余行为一字不改。
 */

const REVEAL = 'typora-ir-selected';
/** 鼠标按着（含拖拽）期间挂在编辑器根上的类：见 index.css 末尾"按下期间一律保持渲染态"。
 *  用户报告（2026-09-14，第 2 条）：向上拖拽时"可编辑公式区域抽搐频繁抖动"，向下拖没有。
 *  实测真凶是 Vditor 自己的 `vditor-ir__node--expand`：拖拽中端点走进哪条公式，它就把那条
 *  公式**原地换成源码**（行宽/行高都变）——指针下的文字随之位移，端点又落到另一条公式上，
 *  于是翻开/收回来回打转：第 3、4 条公式的 top 在 226↔247 之间反复横跳（60px 的段落抖 20px，
 *  12 次 class 变动）。方向不对称是因为往上拖时"翻开的公式"正好把还没经过的内容顶走。
 *  按下期间把这套展开**只从视觉上**压回去（DOM 状态不动，松手立刻恢复 Vditor 自己的态），
 *  拖拽中就不再有任何布局变化——实测 class 变动 0 次、四条公式的 top 一动不动。 */
const POINTER = 'typora-ir-pointer';
/** 按下那一刻**已经展开**的行内公式（用户 2026-09-15 第二轮：「是 inline math 新改的预渲染框
 *  出现了闪烁，修法和前几轮 block math 类似」）。上面的 POINTER 那组 CSS 会在整个按下期间把
 *  展开态**只从视觉上**压回渲染态——源码藏起来、浮框摊回行内，段落当场重排、浮框消失，松手又
 *  弹回来：**一次点击闪一下**。实测（scripts/acceptance/probe-inline-wrap-and-press.cjs，逐帧
 *  记录 computed style）：按住 250ms 的 43 帧里，源码 `display:none` 的帧 16 帧、浮框
 *  `position:static` 的帧 16 帧（类一直没变、KaTeX 一次没重建——所以只看类是看不见这次闪烁的）。
 *  那组 CSS 是第 7 轮治拖拽抖动的（拖拽经过的**别的**公式不许翻），但用户主动按住的这一条不是
 *  "拖拽经过"——它正是正在编辑的那条，压回去就是闪。所以按下时给它挂 PRESSED，CSS 里用
 *  `:not(...)` 把它排除在外（与第 12 轮块公式"按下期间冻住已展开的那条"同一条思路）。 */
const PRESSED = 'typora-ir-pressed';
const NODE = '.vditor-ir__node';
const PREVIEW = '.vditor-ir__preview';
/** 这条节点**自己**的公式源码（行内是直接子元素，块公式在 pre 里）。 */
const OWN_CODE = ':scope > code[data-type="math-inline"], :scope > pre > code[data-type="math-block"]';

/* 行内公式（data-type="inline-node"）与**块公式**（data-type="math-block"）都认。
   块公式在第一版里被排除过（"点击进入编辑走 Vditor 自己的 rawblock 路径，别把那条路带坏"），
   但那样一来"鼠标拖拽跨过块公式"整块选不进来：实测（probe-vertical-roundtrip.cjs 的 F）
   从上一段末尾拖到下一段，选区只有 `"\n下段"`——块公式的源码一个字都没进来，块也没翻成源码。
   用户 2026-09-18 报的"光标/长按shift键+方向键拖拽选中 block math 仍然失败"就是这一条。
   收进来之后：按下落在块公式的渲染结果上会摘掉那条预览的 contenteditable（解除原生拖拽的围栏），
   松手时端点吸到整条源码、并挂 REVEAL 把源码显示出来（index.css 里块公式那两条规则早就写好了）。 */
const hostOf = element => {
  const host = element?.closest?.(NODE);
  if (!host || !host.querySelector(OWN_CODE)) return null;
  const type = host.dataset.type;
  return type === 'inline-node' || type === 'math-block' ? host : null;
};

export const installMathSelectionReveal = root => {
  const revealed = new Set();
  let pointer = null;      // 按下中的指针位置
  let dragging = false;    // 这一次按下已经拖出超过 3px
  let byPointer = false;   // 当前选区是不是鼠标手势造出来的
  let pressed = null;      // 这一次按下的落点（任何位置都记）
  let grabbed = null;      // 按下落在折叠公式上时记下的 {host, preview, code, event, x, y}
  let shiftGrab = null;    // Shift+点公式渲染区时记下的扩选手势 {host, anchorNode, anchorOffset}（B2 返工）
  let swallowClick = false; // B2 扩选刚收尾的那一次 click 要吞掉（见 onClick 的注释）
  let last = null;         // 拖拽期间最后一次指针位置
  let unconfined = null;   // 这次按下期间被临时摘掉 contenteditable 的预览
  let released = null;     // 松手那一点的指针位置（落点标记照它算）
  let frozenHost = null;   // 按下期间被排除在"视觉上压回渲染态"之外的那条展开态公式（见 PRESSED）
  let frame = 0;

  const unfreezePressed = () => { if (frozenHost) { frozenHost.classList.remove(PRESSED); frozenHost = null; } };
  // 落点标记：挂在 iframe 的 body 上、position:fixed（用视口坐标），不参与编辑器布局。
  const endpoint = root.ownerDocument.createElement('div');
  endpoint.className = 'typora-selection-endpoint';
  endpoint.setAttribute('aria-hidden', 'true');
  endpoint.hidden = true;
  root.ownerDocument.body.appendChild(endpoint);

  const show = node => {
    if (!node.classList.contains(REVEAL)) node.classList.add(REVEAL);
    revealed.add(node);
  };
  const hide = node => {
    node.classList.remove(REVEAL);
    revealed.delete(node);
  };
  const dropAll = () => { for (const node of [...revealed]) hide(node); };

  /** 选区两端各自落在哪条公式里（端点落在渲染结果或源码里都算）。 */
  const endpointNodes = range => {
    const out = new Set();
    for (const container of [range.startContainer, range.endContainer]) {
      const element = container.nodeType === 1 ? container : container.parentElement;
      const host = hostOf(element);
      if (host) out.add(host);
    }
    return out;
  };

  /** 松手落点的可见标记（用户报告 2026-09-14 第 4 条："这个最终松手位置得有 caret 闪烁吧"）。
   *  选区本身没有光标——拖完只剩一片蓝色，落点在哪要靠眼力去猜（尤其从下往上拖、选区起点
   *  落在词中间时）。这里在选区的**焦点端**画一根 2px 的闪烁竖线：位置固定（fixed，跟着
   *  视口算），不参与布局、不吃事件，键盘一介入或选区一塌就撤掉。
   *  它只在"鼠标拖出来的选区"上出现（byPointer），键盘/程序建的选区不动——那两种情形用户
   *  手里的光标本来就在编辑器里，再加一根会变成两根。 */
  const showEndpoint = point => {
    const doc = root.ownerDocument;
    const at = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(point.x, point.y) : null;
    if (!at) return hideEndpoint();
    let box = at.getBoundingClientRect();
    if (!box || !box.height) {
      const rects = at.getClientRects();
      box = rects.length ? rects[0] : null;
    }
    if (!box || !box.height) return hideEndpoint();
    endpoint.style.left = box.left + 'px';
    endpoint.style.top = box.top + 'px';
    endpoint.style.height = box.height + 'px';
    endpoint.hidden = false;
  };
  const hideEndpoint = () => { endpoint.hidden = true; };

  const sync = () => {
    frame = 0;
    const selection = getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || range.collapsed) { dropAll(); hideEndpoint(); return; }
    if (!byPointer) { hideEndpoint(); return; }   // 键盘/程序建立的选区不碰
    // **拖拽期间只收不开**（用户报告 2026-09-14：从下往上拖时公式区"抽搐频繁抖动"）。
    // 翻开的公式会把那一行换成源码（行高/行宽都变），端点每变动一次就把整段文字的位置
    // 推来推去；指针还压在原地，于是下一帧又落在另一条公式上——翻、收、翻、收地打转，
    // 实测向上拖时第 3、4 条公式的 top 在 226 ↔ 247 之间反复横跳（60px 段落里抖 20px），
    // 向下拖几乎不动。Typora 的做法正是"拖拽中公式保持渲染态、松手才展开"（见
    // settleEndpoints），所以这里不再新增翻开，只把过期的那几条收回去；拖拽中跨过的公式
    // 靠原生选区拿蓝色底纹（预览已是 user-select:text）。
    const keep = endpointNodes(range);
    // 块公式被**整条选进**选区时，选区端点落在它前后的正文里（不在它内部），只按"端点所在
    // 的 owner"收回会把它的源码收掉——源码一收，浏览器随即把落在里面的选区收窄，于是
    // "选中的块公式 + REVEAL 一起消失"（实测 probe-vertical-roundtrip 的 F：刚建好 11 字符
    // 的选区、源码盒 10×122，一拍之后类没了、选区缩回 `\n下段`）。所以还要保住
    // "源码被选区盖住"的那些块。
    // W1（第 2 轮判决 2026-10-02）：keep 判据扩成 "端点在 owner **或** owner 被选区完整
    // 包住"，保底循环同时收进行内公式——原来只保块公式，行内公式整条被选、两端点都停在
    // 两侧正文时它的 REVEAL 会被误收（掉进同一个"源码一收→选区被浏览器收窄"的坑）；
    // 端点吸到 host 边界（B3/B2）之后"完整包住"正好接住边界相切的情形（端点在 host 外、
    // 选区端点与 host 首尾等位，intersectsNode 之外的最后一道保）。
    const covered = node => {
      try {
        return range.comparePoint(node, 0) <= 0 && range.comparePoint(node, node.childNodes.length) >= 0;
      } catch { return false; }
    };
    for (const node of root.querySelectorAll('.vditor-ir__node[data-type="math-block"], .vditor-ir__node[data-type="inline-node"]')) {
      const code = node.querySelector(OWN_CODE);
      if (code && (range.intersectsNode(node) || covered(node))) keep.add(node);
    }
    for (const node of [...revealed]) if (!keep.has(node) || !node.isConnected) hide(node);
    if (pointer) hideEndpoint();                 // 还按着：落点还没定下来
    else if (released) showEndpoint(released);    // 用**松手那一点**，不是文档序的末端
  };
  const queue = () => { if (!frame) frame = requestAnimationFrame(sync); };

  /** 选区任一端落在公式的渲染结果（preview）里——settleEndpoints 只认这个形状，
   *  这里用同一把尺子决定"要不要吸附"，避免两处判据漂移。 */
  const endpointsInPreview = () => {
    const selection = getSelection();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return false;
    for (const node of [range.startContainer, range.endContainer]) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (element?.closest?.(PREVIEW) && hostOf(element)) return true;
    }
    return false;
  };

  /** 松手之后把"端点切进去的公式"翻成源码，并把这一端吸到整条公式上。 */
  const settleEndpoints = () => {
    const selection = getSelection();
    if (!selection || !selection.rangeCount) return;
    let range = selection.getRangeAt(0);
    if (range.collapsed) return;
    for (const atEnd of [false, true]) {
      const container = atEnd ? range.endContainer : range.startContainer;
      const offset = atEnd ? range.endOffset : range.startOffset;
      const element = container.nodeType === 1 ? container : container.parentElement;
      const host = element?.closest?.(PREVIEW) ? hostOf(element) : null;
      if (!host) continue;
      const code = host.querySelector(OWN_CODE);
      if (!code || !code.firstChild) continue;
      show(host);
      const next = root.ownerDocument.createRange();
      // B3（第 1 轮判决 2026-10-02）：端点吸到 **owner 整条**（host 前后边界），不再只吸到
      // code 边界。块公式的 code 只是公式体，闭 `$$` 围栏与渲染结果是 host 里的兄弟节点——
      // 端点停在 code 边界时它们留在选区外，随后替换/删除就会在源码里剩半截 `$$`；行内公式
      // 的预览同理被留在选区外（替换后残留孤立 `$`）。整条并入才符合"围栏当普通字符、
      // 公式整块参与选中"的既有契约（场景 110④ 的同一口径）。
      if (atEnd) { next.setStart(range.startContainer, range.startOffset); next.setEndAfter(host); }
      else { next.setStartBefore(host); next.setEnd(range.endContainer, range.endOffset); }
      if (next.collapsed) continue;
      selection.removeAllRanges();
      selection.addRange(next);
      range = next;
    }
  };

  const onDown = event => {
    if (event.button !== 0) return;
    swallowClick = false;                   // 新手势开始：上一次扩选若没产生 click，别误吞这次
root.classList.add(POINTER);            // 按下期间冻结公式的展开/收回（见 POINTER 注释）
    // 按下**已经展开**的那条行内公式（源码或它的浮框都算）：把它排除在 POINTER 那组
    // "视觉上压回渲染态"的 CSS 之外，否则按下期间它当场折起来、松手再弹回来（见 PRESSED 注释）。
    // 只认"按下那一刻就已经展开"的：折叠态公式按下去会被展开（第 2 轮到第 7 轮的手感依赖那组
    // CSS 在拖拽期间把它压住），那种情形照旧压。
    const under = event.target instanceof Element ? event.target.closest(NODE) : null;
    if (under && under !== frozenHost && under.classList.contains('vditor-ir__node--expand') && under.querySelector(OWN_CODE)) {
      unfreezePressed();
      under.classList.add(PRESSED);
      frozenHost = under;
    }
    pointer = {x: event.clientX, y: event.clientY};
    last = {x: event.clientX, y: event.clientY};
    pressed = {x: event.clientX, y: event.clientY};
    dragging = false;
    byPointer = true;
    grabbed = null;
    // B2 返工（第 2 轮判决 2026-10-02）：Shift+左键落在公式渲染结果上（折叠 preview / 展开
    // 浮框 / 块公式渲染区都算）——原生的 shift+mousedown 没有 Typora 的"整条并入"语义，
    // 实测把 9 字正文选区当场塌成 len=0、端点塞进源码，退格只删掉公式首字符；mouseup 之后
    // 再 settle 已经救不回来（端点早就不在 preview 里，第 1 轮的 else-if 判据永远不满足）。
    // 所以在捕获层就接管：**有既有选区才管**（纯点击无选区退回单击语义不动），
    // preventDefault 挡掉原生塌选区，把锚点记下来，mouseup 时用 setBaseAndExtent 把整条
    // owner 并进来 + 走摊开（与拖拽松手同一套 REVEAL 收尾）。
    if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.detail === 1) {
      const target = event.target instanceof Element ? event.target : null;
      const host = target?.closest?.(PREVIEW) ? hostOf(target) : null;
      if (host) {
        const selection = getSelection();
        const had = !!(selection && selection.rangeCount && !selection.getRangeAt(0).collapsed
          && selection.anchorNode && root.contains(selection.anchorNode));
        if (had) {
          event.preventDefault();
          shiftGrab = {host, anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset};
          return;   // 这次按下是"扩选"，不走下面折叠公式摘 contenteditable 的起拖逻辑
        }
      }
    }
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.detail > 1) return;
    // （R2·W2 突变不红+运行时无红，撤销，不落地）
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest?.(PREVIEW) ? hostOf(target) : null;
    if (!host || host.classList.contains('vditor-ir__node--expand')) return;
    const preview = host.querySelector(':scope > ' + PREVIEW);
    // 按在折叠公式的渲染结果上：**只摘掉这条预览的 contenteditable**（松手还原）。
    // 那个属性把原生拖拽**关在这条公式内部**（实测：不摘，从公式上拖到段尾也只选中公式内
    // 十来个字符）；而"翻成源码"必须等**松手**（settleEndpoints）——渲染结果从这一版起
    // 本身可选（index.css 的 user-select:text），按下就已经能起选区；如果按下这一帧就把
    // 源码顶上去，Chromium 刚解析好的锚点（原本落在 katex 里）会随预览一起失效，横向拖拽
    // 当场塌成空选区（实测：左拖/右拖长度 0，上拖/下拖侥幸还能用）。
    // 全局摘 contenteditable 也不行：行尾点一下会把光标解进隐藏源码、公式当场展开
    // （math-caret 的 v2.1.1 断言），所以只在按下这一帧、只对那一条预览摘。
    grabbed = {host, preview, code: host.querySelector(OWN_CODE), event, x: event.clientX, y: event.clientY};
    unconfined = preview && preview.getAttribute('contenteditable') !== null ? preview : null;
    if (unconfined) unconfined.removeAttribute('contenteditable');
  };
  const onMove = event => {
    if (!pointer) return;
    if (!(event.buttons & 1)) { pointer = null; return; }
    if (!dragging && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 3) dragging = true;
    // Shift+点公式之后如果又拖起来了，这次手势就不是"点击扩选"——放弃 mousedown 层的
    // 接管（原生选区已被 preventDefault 挡掉，剩下的事交给下面的拖拽兜底 recover，它的
    // pressed 分支本来就会处理"按下点落在公式渲染结果里"的情形）。
    if (dragging && shiftGrab) shiftGrab = null;
    pointer = {x: event.clientX, y: event.clientY};
    last = {x: event.clientX, y: event.clientY};
  };
  const onUp = event => {
    const wasDrag = dragging;
    const at = last;
    pointer = null;
    dragging = false;
    released = at;                          // 落点标记照"松手那一点"画
    root.classList.remove(POINTER);         // 先让 Vditor 自己的展开态回来，再收尾
    unfreezePressed();                      // 被按住的展开态公式照旧恢复成 Vditor 自己的态
    // B2 返工（第 2 轮判决）：Shift+点公式渲染区的扩选收尾——锚点不动，焦点端并到整条
    // owner 的边界上（锚在 owner 之前 → owner 之后；锚在 owner 之后（往回扩）→ owner 之前），
    // 并把这条公式摊开（REVEAL + 源码显示），与拖拽松手同一套语义。端点用"宿主父节点 +
    // 子偏移"表达，与 settleEndpoints 的 setEndAfter(host) 是同一条边界；先逼一次布局再
    // setBaseAndExtent，端点落在刚摊开的源码侧才不会被 Chromium 判成无效悄悄回滚。
    if (shiftGrab) {
      const grab = shiftGrab;
      shiftGrab = null;
      const selection = getSelection();
      const code = grab.host.querySelector(OWN_CODE);
      const parent = grab.host.parentElement;
      const index = parent ? [...parent.children].indexOf(grab.host) : -1;
      if (selection && code && parent && index >= 0) {
        show(grab.host);
        void code.getBoundingClientRect();
        const precedes = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (precedes(grab.anchorNode, grab.host)) selection.setBaseAndExtent(grab.anchorNode, grab.anchorOffset, parent, index + 1);
        else selection.setBaseAndExtent(parent, index, grab.anchorNode, grab.anchorOffset);
        // 插桩实测（2026-10-02 B2 端到端调试）：setBaseAndExtent 同一毫秒内被
        // vditor/index.min.js 挂在块公式 pre 上的监听（HTMLPreElement.<anonymous>，
        // 203140/203848 两处）removeAllRanges+addRange 重写成"光标进源码"的塌选区——
        // 我们在 document 捕获层先跑，拦不住**之后**的目标相监听。所以这次手势的 mouseup
        // 到此为止（stopPropagation，别再往 pre 上送），随后的 click 也吞掉（swallowClick），
        // 让 Vditor 把它当"点进公式编辑"的那条路根本收不到事件。
        event.stopPropagation();
        swallowClick = true;
      }
    }
    // 原生拖拽"没做出来"时兜底（见 recover 的注释：横向拖拽会被 Chromium 判成空选区）。
    if (wasDrag && at) recover(at);
    if (wasDrag) settleEndpoints();
    // B2（第 1 轮判决 2026-10-02）：Shift+点公式渲染区不是拖拽（dragging=false），原来
    // 不走 settleEndpoints——焦点端留在预览子树中间，整条公式既不并入选区也不摊开源码，
    // 接着打字/退格会被 math-source-map 的兜底拦死（预览里没有可编辑落点）。只要松手时
    // 选区端点切进了渲染结果，就照拖拽同一套"整条并入 + 吸到边界"收尾，不分拖没拖。
    else if (endpointsInPreview()) settleEndpoints();
    if (unconfined && unconfined.isConnected) unconfined.setAttribute('contenteditable', 'false');
    unconfined = null;
    grabbed = null;
    queue();
  };
  /** 兜底：原生拖拽整条手势做完了，选区还是塌的——那就按"按下点 + 最后落点"自己建一个。
   *  实测 Chromium 对"按下点在公式渲染结果里、往同一行左右方向拖"会给出空选区（上下拖、
   *  跨行拖都正常），而用户最常用的恰恰是"光标点到段尾、往回拉到段首"。这一步只在前面的
   *  原生路径确实没结果时才动手（有非塌选区就直接返回），所以不会跟它抢，
   *  也不会把已经好用的手势改坏。 */
  /** 按下点到松手点之间夹着哪条**块公式**（几何判断：块的盒子落在两点的纵向区间里，
   *  横向也落在两点的横向区间里），而且它的源码**不在**当前选区里。
   *  为什么需要：原生拖拽跨过块公式时，整条块会被跳过（实测选区只剩下一小段正文），
   *  用户报的"拖拽选中 block math 仍然失败"就是它。 */
  const skippedBlocks = (from, to, selection) => {
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    const top = Math.min(from.y, to.y), bottom = Math.max(from.y, to.y);
    const left = Math.min(from.x, to.x), right = Math.max(from.x, to.x);
    return [...root.querySelectorAll('.vditor-ir__node[data-type="math-block"]')].filter(node => {
      const box = node.getBoundingClientRect();
      if (box.bottom < top || box.top > bottom) return false;
      if (box.right < left - 6 || box.left > right + 6) return false;
      if (range && !range.collapsed && (range.intersectsNode(node) || range.intersectsNode(node.querySelector(OWN_CODE) || node))) return false;
      return !!node.querySelector(OWN_CODE);
    });
  };
  /** 把夹在中间的块公式整条并进选区（摊开源码 + 端点吸到 owner 整条边界）。 */
  const includeBlocks = (blocks, selection) => {
    if (!blocks.length || !selection.rangeCount) return;
    let anchorNode = selection.anchorNode, anchorOffset = selection.anchorOffset;
    let focusNode = selection.focusNode, focusOffset = selection.focusOffset;
    const precedes = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (const node of blocks) {
      const code = node.querySelector(OWN_CODE);
      if (!code || !code.firstChild) continue;
      show(node);
      // 挂上 REVEAL 之后**先逼一次样式/布局**再把选区端点落到源码里：Chromium 的样式是惰性
      // 计算的，同一拍里 code 还是 display:none，那一刻设进去的选区端点会被判成无效、随后被
      // 它悄悄换回上一版选区——实测（probe-vertical-roundtrip F）表现为"刚建好的选区 700ms
      // 后又缩回 `\n下段`"。读一次布局盒就把样式刷出来了。
      void code.getBoundingClientRect();
      // B3B 返工（第 2 轮判决 2026-10-02）：端点吸 **owner 整条**（host 前后边界），与
      // settleEndpoints 的 setStartBefore/setEndAfter(host) 同一条边界——原来吸的是 code 文本
      // 两头，闭 `$$` marker 与渲染结果留在选区外，替换输入后留下空 `$$` 壳（绿轮实测：拖到
      // 块公式松手，终点链 code[math-block]、含闭 marker false，替换后第一个 math 块源码变
      // ""）。比较基准必须从"code 文本"换成 host 本身：包含关系会让 compareDocumentPosition
      // 把 FOLLOWING 一起置位，旧判据会把刚被 settle 吸到 host 边界的端点又搬回 code 文本尾
      // （这就是绿轮 B3B 与红轮读数逐字相同的机制）。
      const parent = node.parentElement;
      const index = parent ? [...parent.children].indexOf(node) : -1;
      if (index < 0) continue;
      const inside = (a, b) => a === b || !!(b.contains && b.contains(a));
      // 锚在 owner 里/之后 → 推到 owner 之前；焦点在 owner 里/之前 → 推到 owner 之后。
      // inside 补的是"端点还停在 owner 子树里"的病态（preview 文本、code 文本都被算进来）。
      if (inside(anchorNode, node) || precedes(node, anchorNode)) { anchorNode = parent; anchorOffset = index; }
      if (inside(focusNode, node) || precedes(focusNode, node)) { focusNode = parent; focusOffset = index + 1; }
    }
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  };
  const recover = at => {
    const note = {at, grabbed: !!grabbed, why: null, done: false};
    window.__typoraMathRecover = note;
    const selection = getSelection();
    if (!selection) { note.why = 'no-selection'; return; }
    // 按下点到松手点之间夹着的块公式：**先算出来**。它不能只在"原生给过非塌选区"那条分支里
    // 生效——实测拖过块公式时原生给的是一段只盖住下方正文的选区（甚至塌选区），块整个被跳过。
    const crossed = skippedBlocks(pressed, at, selection);
    note.crossed = crossed.length;
    const native = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (native && !native.collapsed && !crossed.length) {
      // 原生拖拽确实做出了选区——但如果它被关在这条公式内部（按下落在公式上、指针已经
      // 走远，结果整条选区还在同一条公式里），那正是 contenteditable 围栏留下的症状，
      // 用我们自己的选区替掉它；拖得近、本来就选在公式里（选词那种）就保持原生。
      const far = Math.hypot(at.x - pressed.x, at.y - pressed.y) > 24;
      const inside = grabbed?.host
        ? grabbed.host.contains(native.startContainer) && grabbed.host.contains(native.endContainer) : false;
      if (!far || !inside) { note.why = 'native-ok'; return; }
      note.why = 'native-confined';
    }
    const doc = root.ownerDocument;
    const focus = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(at.x, at.y) : null;
    note.focus = focus ? {node: focus.startContainer.nodeType === 3 ? 'text' : focus.startContainer.tagName, offset: focus.startOffset, inRoot: root.contains(focus.startContainer)} : null;
    if (!focus || !root.contains(focus.startContainer)) { note.why = 'no-focus'; return; }
    let anchorNode = null, anchorOffset = 0;
    try {
    if (grabbed?.code) {
      // 按下落在公式上：锚点映射到源码里的对应字符，顺便把这条翻成源码（拖拽已结束，
      // 这时候再顶掉渲染结果不会让锚点失效）。
      show(grabbed.host);
      const code = grabbed.host.querySelector(OWN_CODE) || grabbed.code;
      const text = code.firstChild?.nodeType === 3 ? code.firstChild : code;
      const offset = sourceOffsetAtPoint(grabbed.preview, code, grabbed.event);
      anchorNode = text;
      anchorOffset = Math.max(0, Math.min(offset === null ? 0 : offset,
        text.nodeType === 3 ? text.length : text.childNodes.length));
    } else if (pressed) {
      // 按下落在正文里（用户的手势常常是光标点到段尾、往回拉到段首，那个落点在文字上）：
      // 锚点用落点解析出来的位置；若它落进了某条公式的渲染结果，就吸到那条公式的源码上。
      const back = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(pressed.x, pressed.y) : null;
      if (back && root.contains(back.startContainer)) {
        const element = back.startContainer.nodeType === 1 ? back.startContainer : back.startContainer.parentElement;
        const host = element?.closest?.(PREVIEW) ? hostOf(element) : null;
        if (host) {
          show(host);
          const code = host.querySelector(OWN_CODE);
          const text = code?.firstChild?.nodeType === 3 ? code.firstChild : code;
          const offset = sourceOffsetAtPoint(host.querySelector(":scope > " + PREVIEW), code, pressed);
          if (text) { anchorNode = text; anchorOffset = Math.max(0, Math.min(offset === null ? 0 : offset,
            text.nodeType === 3 ? text.length : text.childNodes.length)); }
        } else { anchorNode = back.startContainer; anchorOffset = back.startOffset; }
      }
    }
    } catch (error) { note.why = 'error:' + String(error && error.message).slice(0, 80); return; }
    if (!anchorNode) { note.why = 'no-anchor'; return; }
    note.anchor = {offset: anchorOffset};
    // 用 setBaseAndExtent：它会自己处理锚点在前还是在后。用 Range.setStart/setEnd 时，
    // 若终点在起点之前，规范要求把起点挪到终点（= 直接收塌），实测从段尾往回拉就死在这。
    // 直接 setBaseAndExtent，让 Selection 自己处理方向；**不要**先用 Range 试一遍：
    // 终点在起点之前时，规范要求 setEnd 把那一段收塌，于是从段尾往回拉永远被判成
    // 空选区、兜底也就永远不生效（实测：anchor 在源码 offset 15、focus 在段首，全被收塌）。
    selection.setBaseAndExtent(anchorNode, anchorOffset, focus.startContainer, focus.startOffset);
    // 夹在中间的块公式整条并进来（端点吸到源码两端 + 翻成源码显示）。**推迟一拍**：浏览器
    // 自己的 mouseup 选区处理跑在我们的捕获监听之后，当场设进去的选区会被它盖掉（实测
    // ：建好的 11 字符选区 700ms 后又缩回 `\n下段`，而且过程中没有任何 Selection API 调用）。
    if (crossed.length) {
      const blocks = crossed;
      note.blocks = blocks.length;
      note.why = 'blocks-included';
      note.done = true;
      setTimeout(() => {
        if (!root.isConnected) return;
        includeBlocks(blocks, getSelection());
        note.text = String(getSelection()?.toString() || '').slice(0, 60);
      }, 0);
      note.text = String(selection.toString()).slice(0, 60);
      return;
    }
    note.text = String(selection.toString()).slice(0, 60);
    if (selection.isCollapsed) { note.why = 'still-collapsed'; return; }
    note.done = true;
    note.why = 'built';
  };
  // 键盘一介入（含 Ctrl+Z 撤销/重做）就不再算"鼠标选中态"：把翻开过的公式收回去，
  // 让产品自己的展开态（源码 + 浮出的预渲染框）说话。留着会让预览一直不显示
  // （math-history 的 ir list redo 断言：重做之后源码与预览都要看得见）。
  const onKey = () => { byPointer = false; root.classList.remove(POINTER); unfreezePressed(); dropAll(); hideEndpoint(); queue(); };
  const onBlur = () => { pointer = null; dragging = false; shiftGrab = null; swallowClick = false; root.classList.remove(POINTER); unfreezePressed(); dropAll(); hideEndpoint(); };
  /** B2 扩选刚收尾的那一次 click：吞掉（捕获层 stopPropagation）。Vditor 挂在块公式 pre 上的
   *  click 处理会把刚扩好的选区重设成"光标进源码"（插桩栈：vditor index.min.js 203140/203848），
   *  这次手势的语义已被我们完整接管（扩选 + 摊开），Vditor 不该再把它当"点进公式编辑"。
   *  只吞一次、只在这一个手势上，普通点击/拖拽的 click 照常通行。 */
  const onClick = event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
  };
  root.addEventListener('mousedown', onDown, true);
  root.addEventListener('mousemove', onMove, true);
  root.ownerDocument.addEventListener('mouseup', onUp, true);
  // （R2·D1 CDP 无法触达原生 dragend，红不可复现，缓议不落地——真原生拖放通道可用后再启）
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKey, true);
  root.addEventListener('beforeinput', onKey, true);
  root.ownerDocument.addEventListener('selectionchange', queue);
  // B5（第 1 轮判决 2026-10-02）：滚动即收落点标记。标记是 position:fixed 照**松手那一刻的
  // 视口坐标**画的，滚动之后那组坐标已经失效——原先挂 queue 会让 sync 拿老坐标再画一遍，
  // 标记看起来钉在视口老位置上不跟内容走（用户看到的"端点闪烁标记漂移"）。视口坐标失效
  // 就不画；键盘一介入本来也会收回（onKey）。
  root.ownerDocument.addEventListener('scroll', hideEndpoint, true);
  window.addEventListener('blur', onBlur);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    dropAll();
    endpoint.remove();
    root.removeEventListener('mousedown', onDown, true);
    root.removeEventListener('mousemove', onMove, true);
    root.ownerDocument.removeEventListener('mouseup', onUp, true);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('keydown', onKey, true);
    root.removeEventListener('beforeinput', onKey, true);
    root.ownerDocument.removeEventListener('selectionchange', queue);
    root.ownerDocument.removeEventListener('scroll', hideEndpoint, true);
    window.removeEventListener('blur', onBlur);
  };
};
