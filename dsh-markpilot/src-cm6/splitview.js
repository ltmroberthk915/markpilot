/* 双开（形态 B）：主视图＝现在的即时渲染编辑面；从视图＝**同一份文档**的只读源码。
 *
 * 为什么是"同一份文档"而不是"两套文档"：
 *   · md 是唯一真源 —— 零 doc↔md 转换层、零块锚表（v2.3.3 的锚表在 167k 就要 336ms/次）；
 *   · 主视图是唯一权威文档；初开/回退可共享不可变 Text，正常编辑按实际组合 ChangeSet
 *     更新从视图的派生 Text。两边 UTF-16 内容一致、pos 坐标逐位相同；引用同一性仅作诊断；
 *   · 从视图没有历史扩展 ⇒ 不存在第二套撤销栈（比 v2.3.3 好）。
 *
 * 四条能效约束（缺一条就会破坏当前架构，落地前必须逐条验）：
 *   ① 从视图**最小扩展集**：不带数学/表格/行内标记那套装饰 ⇒ 不重复跑每键 4 次全文扫描；
 *   ② 正常同步用从视图自身 state 的公开增量 update；断链/替换用 setState 回退，
 *      不转发主事务、选择和 effects；从视图无本地 dispatch、历史和 updateListener，不回写主文档；
 *   ③ **分屏关闭时零成本**：mirror() 第一行就返回（"不开就没有开销"，不是"开了稍微贵点"）；
 *   ④ 滚动同步**不依赖 rAF 存活**（事件驱动 + driver 标记 + 预期滚动登记 + visibilitychange 复位）
 *      ⇒ 最小化/遮挡恢复后不脱节；对齐用**内容坐标**（posAtCoords → lineBlockAt）⇒ 与缩放无关；
 *      O(log)，**不设降级档**。
 *
 * ⚠ 实现修正（2026-10-07，实测取证，设计不变）：
 *   字面写法 `new EditorView({ state: master.state, extensions: [最小集] })` **不可能**得到"最小扩展集"：
 *   CM6 的视图插件与装饰 facet **全部来自 state**（@codemirror/view dist/index.js:7950-7953
 *   `this.viewState = new ViewState(this, config.state || EditorState.create(config))` /
 *   `this.plugins = this.state.facet(viewPlugin)...`）——给了 `state` 时 `extensions` 被整条忽略。
 *   照字面写，从视图会把主视图的装饰（KaTeX 公式、表格、标题、行内标记）**再渲染一遍**，且
 *   `EditorView.editable.of(false)` 失效（从视图变成可编辑、编辑后走空 dispatch）。
 *   从视图持有自己的最小只读 state。C16 使用派生 Text 的公开增量更新，
 *   初开/断链/文档替换保留全量回退；关闭零成本与内容坐标对齐照旧。
 */
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";

const ANCHOR_RATIO = 0.30;   // 取主视图视口 30% 高度处的像素锚（Marijn 官方口径）

export function installSplit(deps) {
  const { getView, focusSelection } = deps;
  let pane = null, slave = null, driver = null, expectedScroll = -1, expectedMasterScroll = -1, hlLine = null, slaveDoc = null, slaveLocalDoc = null, correctTimer = null;

  const isOpen = () => !!slave;

  /** 从视图 state：最小扩展集（只读 + 换行 + 不挂任何装饰）＋主视图同一个 Text 引用 */
  function sourceState(doc) {
    return EditorState.create({
      doc,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping],
    });
  }

  // A mirrored source view is an output while its two CM height maps settle.
  // Every stage is bounded; a newer input retires it before it can realign.
  let mirrorPending = null, mirrorInputElement = null;
  const mirrorMeasureKeys = [{}, {}, {}, {}];
  const mirrorInputTypes = ['wheel', 'pointerdown', 'keydown', 'focusin'];
  function retireMirror(ticket = mirrorPending) {
    if (!ticket) return;
    ticket.active = false;
    if (mirrorPending === ticket) mirrorPending = null;
  }
  function ownsMirror(ticket) {
    return !!ticket && ticket.active && mirrorPending === ticket &&
      getView() === ticket.master && slave === ticket.source && slaveDoc === ticket.masterDoc && slaveLocalDoc === ticket.localDoc &&
      ticket.master.state.doc === ticket.masterDoc && ticket.source.state.doc === ticket.localDoc &&
      deps.intentSerial?.() === ticket.serial && ticket.master.dom.isConnected && ticket.source.dom.isConnected;
  }
  function sourceTakesOver(event) {
    if (!event.isTrusted) return;
    retireMirror();
    if (correctTimer) { correctTimer.clear(); correctTimer = null; }
    expectedScroll = expectedMasterScroll = -1;
  }
  function bindMirrorInput() {
    mirrorInputElement = slave.dom;
    for (const type of mirrorInputTypes) mirrorInputElement.addEventListener(type, sourceTakesOver, { capture: true, passive: true });
  }
  function unbindMirrorInput() {
    if (mirrorInputElement) for (const type of mirrorInputTypes) mirrorInputElement.removeEventListener(type, sourceTakesOver, true);
    mirrorInputElement = null;
    retireMirror();
  }
  function afterMirrorMeasure(ticket, target, stage, next) {
    target.requestMeasure({ key: mirrorMeasureKeys[stage],
      read: () => ownsMirror(ticket),
      write(ok) {
        if (!ok || !ownsMirror(ticket)) { retireMirror(ticket); return; }
        queueMicrotask(() => {
          if (!ownsMirror(ticket)) { retireMirror(ticket); return; }
          try { next(); } catch (error) { retireMirror(ticket); console.error('[split] mirror settlement', error); }
        });
      },
    });
  }
  function settleMirror(ticket) {
    afterMirrorMeasure(ticket, ticket.source, 0, () => {
      // Reading the master anchor can synchronously flush its measure. Queue an
      // explicit master tail first, so rollback's viewport microtask runs first.
      afterMirrorMeasure(ticket, ticket.master, 1, () => {
        alignSlaveToMaster();
        afterMirrorMeasure(ticket, ticket.source, 2, () => {
          alignSlaveToMaster();
          // The last alignment itself requests a source measure. Finish that
          // tail before registering its delivered scroll echo and releasing it.
          afterMirrorMeasure(ticket, ticket.source, 3, () => {
            expectedScroll = ticket.source.scrollDOM.scrollTop;
            retireMirror(ticket);
          });
        });
      });
    });
  }

  function onVisibility() {
    if (document.visibilityState !== 'visible' || !slave) return;
    alignSlaveToMaster();   // 后台/最小化期间几何失效：回到前台按内容坐标重新对齐（事件驱动，不用 rAF）
  }

  function open() {
    const a = getView();
    if (!a || slave) return false;
    const hostEl = a.dom.parentElement || document.body;
    hostEl.classList.add('mp-split-on');
    pane = document.createElement('div');
    pane.className = 'mp-split-pane';
    hostEl.appendChild(pane);

    slaveDoc = a.state.doc;
    slave = new EditorView({
      state: sourceState(slaveDoc),      // ① 最小扩展集 + 同一 Text 引用
      parent: pane,
      dispatch: () => { },               // 从视图由镜像 API 更新，禁止本地分发
    });
    /* 【C16】双引用：slaveDoc=上次成功镜像的 master Text；slaveLocalDoc=同次成功后
       实际 source.state.doc。初开两者同根；增量后 local 是同 changes 派生的只读根。 */
    slaveLocalDoc = slave.state.doc;
    slave.dom.classList.add('mp-split-source');
    bindMirrorInput();

    // ④-1 滚动：事件驱动，不用 rAF；用 driver 标记 + 预期值登记防回环
    a.scrollDOM.addEventListener('scroll', onMasterScroll, { passive: true });
    slave.scrollDOM.addEventListener('scroll', onSlaveScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    // 打开即对齐（两拍：新视图首帧高度图未就绪；timeout 在后台也会跑，不依赖 rAF）
    alignSlaveToMaster();
    scheduleCorrect(() => { if (slave) alignSlaveToMaster(); });
    // 点击从视图（源码）→ 主视图落位并聚焦
    slave.dom.addEventListener('mousedown', (e) => {
      // Context menus retain the master's range; only a primary click locates it.
      if (e.button !== 0) { e.preventDefault(); return; }
      let pos = null;
      try { pos = slave.posAtCoords({ x: e.clientX, y: e.clientY }); } catch { pos = null; }
      if (pos == null) return;
      e.preventDefault();
      driver = 'slave';
      if (deps.selectSource) deps.selectSource(pos);
      else { a.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); if (!focusSelection?.(a)) a.focus(); }
      alignSlaveToMaster(pos);
      highlightSlave(pos);
      driver = null;
    });
    // 点击主视图（渲染）→ 从视图落位（对齐到同一 pos）
    a.dom.addEventListener('mousedown', onMasterClick, true);
    return true;
  }

  function close() {
    unbindMirrorInput();
    const a = getView();
    if (a) { a.scrollDOM.removeEventListener('scroll', onMasterScroll); a.dom.removeEventListener('mousedown', onMasterClick, true); }
    document.removeEventListener('visibilitychange', onVisibility);
    if (slave) { slave.destroy(); slave = null; }
    if (pane) { pane.remove(); pane = null; }
    const hostEl = a && (a.dom.parentElement || document.body);
    if (hostEl) hostEl.classList.remove('mp-split-on');
    hlLine = null; driver = null; slaveDoc = null; slaveLocalDoc = null;
    expectedScroll = expectedMasterScroll = -1;
    if (correctTimer) { correctTimer.clear(); correctTimer = null; }
    return true;
  }

  const toggle = () => (isOpen() ? close() : open());

  /* 【C16】真实文档同步时使高亮派生态失效：仅当存在标记时清当前已有 marker，
     随后清缓存；无高亮的热路径不做任何 DOM 查询。 */
  function retireHighlightOnDocSync() {
    if (hlLine === null) return;
    hlLine = null;
    for (const el of slave.dom.querySelectorAll('.cm-line[data-mp-hl]')) el.removeAttribute('data-mp-hl');
  }
  /* 写入资格与自动对齐资格分开：source intent 可以取消对齐，但同 owner 的内容仍须同步。
     before 双缓存同时阻止已经完成并退役的新一代镜像被旧调用覆盖。 */
  function mirrorWriteCurrent(ticket) {
    return !!ticket && getView() === ticket.master && slave === ticket.source &&
      ticket.master.state.doc === ticket.masterDoc &&
      (ticket.source.state === ticket.beforeState || ticket.source.state === ticket.plannedState) &&
      slaveDoc === ticket.beforeMasterDoc && slaveLocalDoc === ticket.beforeLocalDoc &&
      (mirrorPending === ticket || (!ticket.active && mirrorPending === null)) &&
      ticket.master.dom.isConnected && ticket.source.dom.isConnected;
  }
  /* 原增量错误只允许一次 full；full 自己只关闭仍归本次写入所有的 pane。 */
  function mirrorFallback(state, master, ticket, error) {
    const owned = mirrorWriteCurrent(ticket);
    const realign = ticket.active && mirrorPending === ticket && deps.intentSerial?.() === ticket.serial;
    retireMirror(ticket);
    if (owned) {
      try { if (mirrorFull(state, master, ticket, realign)) return; }
      catch (fallbackError) { throw error; }
    }
    throw error;
  }
  /* ── ② 状态镜像：主视图每次更新后由宿主调用；关闭时**第一行返回**（约束③） ──
     【C16·公开增量】delta 仅由正常 !suppressChange 且分屏打开的 updateListener 传入；
     setValue/rollback/replaceDocument 不带 delta，保持整 state 路线。 */
  function mirror(state, delta) {
    if (!slave) return;
    const master = getView(); if (!master) return;
    const source = slave;
    /* 陈旧入参先于任何退役拒绝。 */
    if (state.doc !== master.state.doc) return;
    if (state.doc === slaveDoc && source.state.doc === slaveLocalDoc) return;
    const incremental = !!(delta && delta.from === slaveDoc && state.doc !== slaveDoc
      && source.state.doc === slaveLocalDoc
      && delta.changes && !delta.changes.empty
      && delta.changes.newLength === state.doc.length
      && delta.changes.length === delta.from.length);
    if (incremental) {
      retireMirror();
      if (correctTimer) { correctTimer.clear(); correctTimer = null; }
      expectedScroll = expectedMasterScroll = -1;
      retireHighlightOnDocSync();
      const ticket = mirrorPending = { active: true, master, source, masterDoc: state.doc, localDoc: null,
        beforeMasterDoc: slaveDoc, beforeLocalDoc: slaveLocalDoc, beforeState: source.state, plannedState: null, serial: deps.intentSerial?.() };
      const startState = ticket.beforeState;
      try {
        const tr = startState.update({ changes: delta.changes, selection: { anchor: 0 } });
        if (!mirrorWriteCurrent(ticket)) { retireMirror(ticket); return; }
        if (source.state !== startState) throw new Error('split source state changed during mirror preparation');
        ticket.plannedState = tr.state; ticket.localDoc = ticket.plannedState.doc; /* 真实计划 state/local 在 view 写入之前登记 */
        if (!mirrorWriteCurrent(ticket) || source.state !== startState) { retireMirror(ticket); return; }
        source.update([tr]);
        if (!mirrorWriteCurrent(ticket)) { retireMirror(ticket); return; }
        if (source.state.doc !== ticket.localDoc) throw new Error('split incremental mirror did not install its planned document');
      } catch (error) { return mirrorFallback(state, master, ticket, error); }
      slaveDoc = ticket.masterDoc; slaveLocalDoc = ticket.localDoc;
      if (ownsMirror(ticket)) {
        try { settleMirror(ticket); } catch (error) { retireMirror(ticket); throw error; }
      } else { retireMirror(ticket); }
      return;
    }
    mirrorFull(state, master);
  }
  function mirrorFull(state, master, prior = null, realign = true) {
    if (prior && !mirrorWriteCurrent(prior)) return false;
    const source = prior ? prior.source : slave;
    if (!source || getView() !== master || master.state.doc !== state.doc) return false;
    retireMirror(prior || mirrorPending);
    if (correctTimer) { correctTimer.clear(); correctTimer = null; }
    expectedScroll = expectedMasterScroll = -1;
    retireHighlightOnDocSync();
    const serial = deps.intentSerial?.();
    const ticket = mirrorPending = { active: realign && (!prior || serial === prior.serial), master, source,
      masterDoc: state.doc, localDoc: null, beforeMasterDoc: slaveDoc, beforeLocalDoc: slaveLocalDoc, beforeState: source.state, plannedState: null, serial };
    try {
      const fresh = sourceState(state.doc);
      if (!mirrorWriteCurrent(ticket)) { retireMirror(ticket); return false; }
      ticket.plannedState = fresh; ticket.localDoc = fresh.doc; /* setState 前绑定实际计划 state/local */
      if (!mirrorWriteCurrent(ticket)) { retireMirror(ticket); return false; }
      source.setState(fresh);
      if (!mirrorWriteCurrent(ticket)) { retireMirror(ticket); return false; }
      if (source.state.doc !== ticket.localDoc) throw new Error('split full mirror did not install its planned document');
    } catch (error) {
      const owned = mirrorWriteCurrent(ticket);
      retireMirror(ticket);
      if (owned) {
        slaveDoc = null; slaveLocalDoc = null;
        try { close(); } catch { /* 已尝试退役本 owned pane，原同步错误继续上抛 */ }
      }
      throw error;
    }
    slaveDoc = ticket.masterDoc; slaveLocalDoc = ticket.localDoc;
    if (ownsMirror(ticket)) {
      try { settleMirror(ticket); } catch (error) { retireMirror(ticket); throw error; }
    } else { retireMirror(ticket); }
    return true;
  }

  /* ── ④ 滚动对齐：内容坐标像素锚 ──
   * 【坐标空间修正·实测定标】CM6 的 `lineBlockAt(pos).top` 以**内容盒内顶**为原点，
   * 而 `scrollDOM.scrollTop` 以**滚动盒 padding box** 为原点，两者差一个常数
   * mapOffset() ＝（内容盒顶 − 滚动盒顶）+ 内容盒 padding-top（同一视图内恒定，可现场量）。
   * 不做这步定标就按 `block.top − 0.3H` 赋值，会得到一个**常数偏差**（本机实测：从视图 62px、
   * 主视图 75px）——两侧"同一内容"因此始终差小半屏，且与缩放/字号无关（纯坐标口径错）。
   * 定标后改用**增量**：目标行当前视口 y 与 30% 线的差就是本次要滚的量（一次到位，无迭代、无 rAF）。 */
  function mapOffset(view) {
    const sc = view.scrollDOM, ct = view.contentDOM;
    const s = zoomScale(view);
    const relCss = (ct.getBoundingClientRect().top - sc.getBoundingClientRect().top) / s;  // 视口像素 → CSS 像素
    const padTop = parseFloat(getComputedStyle(ct).paddingTop) || 0;                        // 已是 CSS 像素
    return relCss + padTop;
  }
  /** 视口像素 / CSS 像素。CSS `zoom`（Ctrl+滚轮 / 字号缩放）会让 getBoundingClientRect 走**视口像素**，
   *  而 scrollTop、lineBlockAt().top、clientHeight 走**CSS 像素**——直接相加就是两套尺子混算，
   *  实测 150% 时对齐偏差 ~300px（两条规则各自都对，混起来就错）。所有跨 DOM/高度图的换算都过这里。 */
  function zoomScale(view) {
    const sc = view.scrollDOM;
    const h = sc.getBoundingClientRect().height;
    const css = sc.offsetHeight || 0;
    const s = css > 0 ? h / css : 1;
    return Number.isFinite(s) && s > 0 ? s : 1;
  }
  /** 视口 30% 处的像素锚 → 文档 pos。
   *  【上游缺陷护栏】CM6 的 posAtCoords 在"该高度上的行块尚未渲染成 DOM"时会走到
   *  `docView.lineAt(from, -2)` 拿到 null，再进 InlineCoordsScan.scanTile(tile) 直接读
   *  `tile.length` → TypeError（@codemirror/view dist/index.js:3856-3859，无 null 检查）。
   *  从视图刚 setState 完时（DocView 重建、测量还没跑）正好落在这个窗口里，实测能打到。
   *  故此处 try/catch 兜底，并回退到**高度图口径**（lineBlockAtHeight，不依赖 DOM 渲染）。 */
  function anchorPos(view, ratio) {
    const sc = view.scrollDOM;
    const r = sc.getBoundingClientRect();
    const s = zoomScale(view);
    const y = r.top + sc.clientHeight * ratio * s;      // posAtCoords 要视口坐标
    let pos = null;
    try { pos = view.posAtCoords({ x: r.left + 4, y }); } catch { pos = null; }
    if (pos == null) {
      try { pos = view.lineBlockAtHeight(sc.scrollTop + sc.clientHeight * ratio - mapOffset(view)).from; } catch { pos = null; }
    }
    return { pos, y, scale: s };
  }
  /** 视口 y → 该视图里的"行内分数"（命中点在本行块中的相对高度） */
  function fracAt(view, y, pos, scale) {
    const r = view.scrollDOM.getBoundingClientRect();
    const b = view.lineBlockAt(pos);
    if (!(b.height > 0)) return 0;
    const yCss = (y - r.top) / (scale || 1);
    return Math.min(1, Math.max(0, (yCss - (b.top + mapOffset(view))) / b.height));
  }
  /** 把 view 滚到"pos 所在行落在视口 ANCHOR_RATIO 处"；返回是否真的动了（-1＝已在位）。
   *  【行内分数·实测定标】只按"行块顶"对齐，遇到**长段落**（一逻辑行折成十几屏行）会引入
   *  最多一整块高度的偏置：主视图命中 30% 的像素落在行块内部，而从视图却把行块顶对齐到 30%，
   *  两侧因此差 2–4 个屏行（实测 deltaRel 367px）。故对齐量用**行内分数 frac**（命中点在本行块
   *  里的相对位置）折算到对侧行块高度上——两侧"同一逻辑行的同一相对位置"落在同一屏幕高度。 */
  function scrollViewToAnchor(view, pos, frac) {
    const sc = view.scrollDOM;
    const scale = zoomScale(view);
    const rect = sc.getBoundingClientRect();
    // ① 目标行**已渲染**：直接用 DOM 实测几何（免高度图估计误差——程序化滚动后 CM6 要跑一次测量
    //    才把"估计高度"换成实测值，估计误差在这篇 5,563 行长文里实测可达数行 ~80px）。
    let yNow = null;
    const line = view.state.doc.lineAt(pos);
    for (const el of view.dom.querySelectorAll('.cm-line')) {
      let q = null;
      try { q = view.posAtDOM(el); } catch { q = null; }
      if (q != null && q >= line.from && q <= line.to) {
        const r = el.getBoundingClientRect();
        yNow = (r.top - rect.top) / scale + (frac > 0 ? (frac * r.height) / scale : 0);
        break;
      }
    }
    // ② 目标行尚未渲染（大跳）：退回高度图口径（mapOffset 已把两套坐标定标）
    if (yNow == null) {
      const b = view.lineBlockAt(pos);
      yNow = b.top + mapOffset(view) + (frac > 0 ? frac * b.height : 0);
    }
    const target = Math.max(0, sc.scrollTop + (yNow - sc.clientHeight * ANCHOR_RATIO));
    const before = sc.scrollTop;
    if (Math.abs(before - target) > 1) {
      sc.scrollTop = target;
      const actual = sc.scrollTop;
      view.requestMeasure();
      return Math.abs(actual - before) > 1 ? actual : -1;
    }
    return -1;
  }
  function onMasterScroll() {
    if (!slave || driver) return;
    const a = getView(); if (!a) return;
    const expected = expectedMasterScroll; expectedMasterScroll = -1; // 一次回声：读到即清
    // 程序化滚动回声：仅吞本次登记值；不匹配就是真实驱动
    if (expected >= 0 && Math.abs(a.scrollDOM.scrollTop - expected) <= 1) return;
    driver = 'master';
    alignSlaveToMaster();
    driver = null;
    scheduleCorrect(() => { if (!slave) return; driver = 'master'; alignSlaveToMaster(); driver = null; });
  }
  /** 从视图滚 → 主视图（同一内容坐标锚 + 行内分数）；抽出来供"补一拍"复用 */
  function syncFromSlave() {
    const a = getView(); if (!a || !slave) return;
    const ap = anchorPos(slave, ANCHOR_RATIO);
    if (ap.pos == null) return;
    const frac = fracAt(slave, ap.y, ap.pos, ap.scale);
    const t = scrollViewToAnchor(a, ap.pos, frac);
    if (t >= 0) expectedMasterScroll = t;   // 登记主视图预期位置，吞掉它随后补发的 scroll 回声（防两侧乒乓）
  }
  function onSlaveScroll() {
    if (!slave || driver) return;
    if (mirrorPending) {
      if (ownsMirror(mirrorPending)) { expectedScroll = -1; return; }
      retireMirror();
    }
    const expected = expectedScroll; expectedScroll = -1; // 一次回声：读到即清
    if (expected >= 0 && Math.abs(slave.scrollDOM.scrollTop - expected) <= 1) return; // 程序化滚动回声：吞掉
    if (!getView()) return;
    driver = 'slave';
    syncFromSlave();
    driver = null;
    scheduleCorrect(() => { if (!slave) return; driver = 'slave'; syncFromSlave(); driver = null; });
  }
  /** 补一拍（setTimeout 0，**不是 rAF**）：程序化赋 scrollTop 之后 CM6 还要跑一次测量，
   *  高度图里的估计值会被实测值替换，目标行的实际落点随之微移（实测主/从两向可达 ~80px）。
   *  同方向再对齐一次即收敛；隐藏标签页里 timer 仍会跑（只是被节流），不依赖 rAF 存活。 */
  const correctionKey = {};
  function scheduleCorrect(fn) {
    correctTimer?.clear();
    const master=getView(),source=slave,doc=master?.state.doc,serial=deps.intentSerial?.(),localDoc=source?source.state.doc:null;
    if(!master||!source)return;
    const ticket={active:true,clear(){this.active=false;}};correctTimer=ticket;
    master.requestMeasure({key:correctionKey,
      read:()=>ticket.active&&correctTimer===ticket&&getView()===master&&slave===source&&master.state.doc===doc&&source.state.doc===localDoc&&deps.intentSerial?.()===serial,
      write(ok){
        const current=ok&&ticket.active&&correctTimer===ticket&&getView()===master&&slave===source&&master.state.doc===doc&&source.state.doc===localDoc&&deps.intentSerial?.()===serial;
        ticket.active=false;if(correctTimer===ticket)correctTimer=null;
        if(current)try{fn();}catch{/* pane retired */}
      }
    });
  }
  function alignSlaveToMaster(posHint, yHint) {
    const a = getView(); if (!a || !slave) return;
    const ar = a.scrollDOM.getBoundingClientRect();
    const aScale = zoomScale(a);
    let pos = posHint, yA = (yHint != null) ? yHint : ar.top + a.scrollDOM.clientHeight * ANCHOR_RATIO * aScale;
    let scale = aScale;
    if (pos == null) { const ap = anchorPos(a, ANCHOR_RATIO); pos = ap.pos; yA = ap.y; scale = ap.scale; }
    if (pos == null) return;
    const frac = fracAt(a, yA, pos, scale);
    const t = scrollViewToAnchor(slave, pos, frac);
    if (t >= 0) expectedScroll = t;
  }

  /* ── 点击主视图（渲染侧）→ 从视图对齐同一 pos；v2.3.3 缺的"对侧当前块高亮"在这里补 ── */
  function onMasterClick(e) {
    if (!slave) return;
    const a = getView(); if (!a) return;
    let pos = null;
    try { pos = a.posAtCoords({ x: e.clientX, y: e.clientY }); } catch { pos = null; }
    if (pos == null) return;
    scheduleCorrect(() => { highlightSlave(pos); alignSlaveToMaster(pos, e.clientY); });
  }
  /** 对侧当前块高亮：给从视图里**对应那一行**的 DOM 行加 data-mp-hl（零扫描、零装饰、不改文档）。
   *  【实现修正】旧写法按 `.cm-line` 数组下标取行——CM6 只渲染视口内的行，下标 ≠ 行号（实测定点错行）。
   *  这里改用 posAtDOM 反查每一行 DOM 的文档坐标，落在目标行区间内的那一行才上色。 */
  function highlightSlave(pos) {
    if (!slave) return;
    const line = slave.state.doc.lineAt(pos);
    /* 【C13·镜像后同线高亮失效】slave.setState 镜像时整体重建从视图 DOM，旧标记
     * 元素随之退役；hlLine 缓存只有在「当前 slave DOM 上确实挂着已连接的
     * data-mp-hl 元素、且 posAtDOM 仍把它反查回目标行」时才允许快速返回。
     * 缺失/退役/错行/反查抛错都落到原有的清标记+视口内查找路径。 */
    if (hlLine === line.from) {
      const marks = slave.dom.querySelectorAll('.cm-line[data-mp-hl]');
      const el = marks.length === 1 ? marks[0] : null;
      let cp = null;
      if (el && el.isConnected && slave.dom.contains(el)) {
        try { cp = slave.posAtDOM(el); } catch { cp = null; }
      }
      if (cp != null && cp >= line.from && cp <= line.to) return;
    }
    /* 只有真实匹配的当前行被标记后才写缓存；重试前先清空，视口外/查找失败
     * 不会把脏值留给下一次点击。 */
    hlLine = null;
    const lines = slave.dom.querySelectorAll('.cm-line');
    for (const el of lines) el.removeAttribute('data-mp-hl');
    for (const el of lines) {
      let p = null;
      try { p = slave.posAtDOM(el); } catch { p = null; }
      if (p != null && p >= line.from && p <= line.to) { el.setAttribute('data-mp-hl', '1'); hlLine = line.from; return; }
    }
  }

  return { toggle, open, close, mirror, isOpen, alignSlaveToMaster, _slave: () => slave, _pane: () => pane };
}
