// dsh-markdown-typora 客户端半边（DSH 0.2.1 契约版）：右侧栏 tab 类型 + iframe 编辑面壳。
//
// 架构（见 README.md）：引擎在 iframe 里跑构建好的 CM6 核心，
// 本文件只做 DSH 皮/桥：
//   · 一个 tab 类型（*.md / *.markdown，priority=extension）吃下 dsh-resource://file/ 资源；
//   · 一个 tab body（sidebar.right.pane.tab, key=dsh-markdown-typora/editor）承载 iframe；
//   · iframe 生命周期：bridge-ready/init 后先发 theme 再 open；文档身份=sessionId+path+generation，
//     过期回执直接丢弃；切 tab / 关 tab / path 变化时 abort 或置 dead；
//   · 保存：change{len} 脏标 → 1500ms 防抖 → requestText（2s 超时）拉全文 → 串行保存，
//     每次 save 必带 baseVersion（关 tab 的 keepalive flush 也一样）；FS_STALE_VERSION 只给
//     冲突横幅（重载磁盘版本 / 复制我的内容），绝不覆盖；
//   · SSE 外部变更：干净缓冲才 setValue 静默重载；脏/冲突只提示；SSE 断开降级 2s→6s 轮询，
//     页面隐藏/后台 tab 暂停轮询；
//   · 选中文段插入：只用 props.inputActions（captureInsertion + insertText，失败重 capture 一次），
//     不可用时 navigator.clipboard.writeText 兜底并提示 —— 不直接改 composer DOM（单权威）。
//
// 形态（dsh-client-modules 装载契约）：window.__ModuleLoader__.load({id, factory(require)})，
// factory 体是普通 CJS；require 只解析冻结平台表（本插件只用 react）与 dsh.client 申报过的包。
// 防御纪律：一个抛错的工厂会把整个 web shell 带崩（"entries did not activate" → 白屏），
// 所以每个服务种子独立 try，绝不上抛。
window.__ModuleLoader__.load({
  id: "dsh-markdown-typora",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react"); } catch (e) { React = null; }

    /* ───────────────────────── 常量 ───────────────────────── */
    const TAB_TYPE_ID = "dsh-markdown-typora/editor";
    const TAB_KIND = "markdown-editor";
    const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
    const API_BASE = "/dsh-markdown-typora/api/";
    const FRAME_SRC = "/dsh-markdown-typora/renderer-cm6/index.html";
    const SAVE_DEBOUNCE_MS = 1500;   // 与桌面壳 _autoSaveTimer 同拍
    const PULL_TIMEOUT_MS = 2000;    // requestText 超时：超时就不保存，绝不拿旧缓存盖新内容
    const FLUSH_WAIT_MS = 120;       // 关 tab 前等全文的窗口
    const RECOVERY_PREFIX = "dsh-markdown-typora:recovery:";
    const POLL_FAST_MS = 2000;       // SSE 断开后的首档轮询
    const POLL_SLOW_MS = 6000;       // 连续失败后的降频档
    const MAX_TEXT_CHARS = 512 * 1024; // 恢复槽上限：localStorage 5MB 配额，超限不写并告警

    /** 当前打开的文档登记表（@mp 候选源用）。key = sessionId + '\n' + absPath */
    const openDocs = new Map();

    /** sessions 服务旁路：apply 里写入取值器（每次 boot 现取，服务晚到也能拿到 cwd；不进 cordis inject） */
    const SessionsBridge = { getSessions: null };

    let generationCounter = 0;

    /* ───────────────────────── 纯函数（可测） ───────────────────────── */

    /** 解析 dsh-resource://file/…（session / absolute 两种 scope，与官方 workspace-path 同形）。 */
    function parseFileAddress(address) {
      try {
        if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
        const segments = body.split("/");
        const scope = segments.shift();
        if (scope === "session") {
          const id = segments.shift();
          if (!id || segments.length === 0) return undefined;
          return { scope: scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join("/") };
        }
        if (scope === "absolute") {
          const unc = segments[0] === "" && segments.length > 1;
          const parts = (unc ? segments.slice(1) : segments).map(decodeURIComponent);
          if (parts.length === 0 || parts[0] === "") return undefined;
          const path = unc
            ? "//" + parts.join("/")
            : (/^[A-Za-z]:$/.test(parts[0]) ? parts.join("/") : "/" + parts.join("/"));
          return { scope: scope, path: path };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    function basenameOf(p) {
      const parts = String(p == null ? "" : p).split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(p == null ? "" : p);
    }

    function directoryOf(p) {
      const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
      const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      return cut > 0 ? s.slice(0, cut) : ".";
    }

    function isAbsolutePath(p) {
      return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
    }

    /** 用 session cwd 把相对路径并成绝对路径（纯字符串运算，不碰 fs 服务）。 */
    function absolutePath(path, cwd) {
      if (isAbsolutePath(path) || !cwd) return String(path).replace(/\\/g, "/");
      const c = String(cwd).replace(/[\\/]+$/, "");
      return (c + "/" + path).replace(/\\/g, "/");
    }

    function encodeFileAddress(sessionId, path) {
      const enc = String(path == null ? "" : path).split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return FILE_ADDRESS_PREFIX + "session/" + encodeURIComponent(sessionId) + "/" + enc;
    }

    function normalizePathKey(p) {
      return String(p == null ? "" : p).replace(/\\/g, "/");
    }

    /** Windows 盘符路径大小写不敏感；POSIX 路径保持大小写敏感。 */
    function samePath(a, b) {
      const na = normalizePathKey(a);
      const nb = normalizePathKey(b);
      if (/^[A-Za-z]:/.test(na) || /^[A-Za-z]:/.test(nb)) return na.toLowerCase() === nb.toLowerCase();
      return na === nb;
    }

    /** 恢复槽键（要求口径）：dsh-markdown-typora:recovery:<path>。 */
    function recoveryKey(path) {
      return RECOVERY_PREFIX + String(path == null ? "" : path);
    }

    function storageOf(storage) {
      if (storage) return storage;
      try { return window.localStorage; } catch (e) { return null; }
    }

    function readRecoverySlot(storage, path) {
      const store = storageOf(storage);
      if (!store || typeof store.getItem !== "function") return null;
      try {
        const raw = store.getItem(recoveryKey(path));
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value.text !== "string" || value.path !== path) return null;
        return value;
      } catch (e) {
        return null;
      }
    }

    function writeRecoverySlot(storage, slot) {
      const store = storageOf(storage);
      if (!store || typeof store.setItem !== "function") return false;
      if (!slot || typeof slot.path !== "string" || typeof slot.text !== "string") return false;
      if (slot.text.length > MAX_TEXT_CHARS) return false;
      try {
        store.setItem(recoveryKey(slot.path), JSON.stringify(slot));
        return true;
      } catch (e) {
        return false;
      }
    }

    function clearRecoverySlot(storage, path) {
      const store = storageOf(storage);
      if (!store || typeof store.removeItem !== "function") return;
      try { store.removeItem(recoveryKey(path)); } catch (e) { /* 配额/权限失败忽略 */ }
    }

    /** 文档代际票：sessionId + path + generation。 */
    function ticketOf(sessionId, path, generation) {
      return {
        sessionId: String(sessionId == null ? "" : sessionId),
        path: String(path == null ? "" : path),
        generation: Number.isFinite(Number(generation)) ? Number(generation) : 0,
      };
    }

    function isCurrentTicket(ticket, current) {
      if (!ticket || !current) return false;
      return ticket.generation === current.generation
        && ticket.sessionId === current.sessionId
        && samePath(ticket.path, current.path);
    }

    /**
     * 保存闸门（纯函数）：
     *   skip  = dead / 未打开 / 干净；
     *   queue = 已有保存飞行（串行，不并发）；
     *   block = 缺 baseVersion —— 拒绝盲写，交给 UI 报错；
     *   save  = 可以发请求。
     */
    function saveGate(state) {
      const s = state || {};
      if (s.dead) return { action: "skip", reason: "dead" };
      if (!s.opened) return { action: "skip", reason: "not-open" };
      if (!s.dirty) return { action: "skip", reason: "clean" };
      if (s.saving) return { action: "queue", reason: "saving" };
      if (typeof s.baseVersion !== "string" || s.baseVersion.length === 0) {
        return { action: "block", reason: "missing-base-version", code: "missing-base-version" };
      }
      return { action: "save", reason: "dirty" };
    }

    /** 保存请求体：path/text/baseVersion 三者齐全才放行（baseVersion 永不省略）。 */
    function buildSaveRequest(payload) {
      const p = payload || {};
      if (typeof p.path !== "string" || p.path.length === 0) return { ok: false, reason: "missing-path" };
      if (typeof p.text !== "string") return { ok: false, reason: "missing-text" };
      if (typeof p.baseVersion !== "string" || p.baseVersion.length === 0) return { ok: false, reason: "missing-base-version" };
      return { ok: true, body: { path: p.path, text: p.text, baseVersion: p.baseVersion } };
    }

    /** 轮询档位：SSE 健康/页面隐藏/后台 tab 时返回 null（不调度）；断开首档 2s，三次后 6s。 */
    function nextPollDelay(state) {
      const s = state || {};
      if (s.hidden) return null;
      if (s.healthy) return null;
      return Number(s.failures) >= 3 ? POLL_SLOW_MS : POLL_FAST_MS;
    }

    /** 外部变更能否直接覆盖编辑面：只有干净、非冲突、无保存飞行、可见且页面在前台才行。 */
    function shouldAcceptExternal(state) {
      const s = state || {};
      if (s.dirty || s.conflict || s.saving) return false;
      if (s.hidden) return false;
      if (s.visible === false) return false;
      return true;
    }

    /**
     * 选中文段插入（纯逻辑，副作用全部通过参数注入）：
     *   1) inputActions 存在 → captureInsertion() + insertText(text, span)；
     *   2) 失败/版本变了 → 重新 capture 再试一次；
     *   3) 仍失败或 props 缺失 → clipboard.writeText(text) 兜底并通知。
     * 不直接改 composer DOM（单权威：输入框内容归 inputActions）。
     */
    async function insertSelectionToChat(inputActions, text, options) {
      const opts = options || {};
      const content = typeof text === "string" ? text : "";
      if (content.length === 0) return { ok: false, method: "none", reason: "empty-text" };
      let reason = "missing-input-actions";
      const canInsert = inputActions
        && typeof inputActions.captureInsertion === "function"
        && typeof inputActions.insertText === "function";
      if (canInsert) {
        reason = "insert-rejected";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          let span;
          try { span = inputActions.captureInsertion(); } catch (e) { span = undefined; }
          if (span === undefined || span === null) continue;
          let inserted = false;
          try { inserted = inputActions.insertText(content, span) === true; } catch (e) { inserted = false; }
          if (inserted) return { ok: true, method: "insert", attempts: attempt };
        }
      }
      let copied = false;
      let error;
      try {
        if (opts.clipboard && typeof opts.clipboard.writeText === "function") {
          await opts.clipboard.writeText(content);
          copied = true;
        }
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      if (typeof opts.notify === "function") {
        try { opts.notify(copied ? "copied" : "copy-failed", { reason: reason, error: error }); } catch (e) { /* 通知失败不影响结果 */ }
      }
      return {
        ok: false,
        method: copied ? "clipboard" : "clipboard-failed",
        reason: reason,
        ...(error ? { error: error } : {}),
      };
    }

    /** tab 类型定义（纯函数，便于测试 id/patterns/priority/keepMounted）。 */
    function buildTabDefinition() {
      return {
        id: TAB_TYPE_ID,
        kind: TAB_KIND,
        patterns: ["*.md", "*.markdown"],
        priority: "extension",
        canOpen: (address) => typeof address === "string" && address.startsWith(FILE_ADDRESS_PREFIX),
        title: (address) => {
          const parsed = parseFileAddress(address);
          return parsed ? basenameOf(parsed.path) : "Markdown";
        },
        keepMounted: true,
      };
    }

    function isDarkTheme() {
      try {
        return !!(typeof document !== "undefined" && document.body && document.body.hasAttribute("data-ds-dark-theme"));
      } catch (e) {
        return false;
      }
    }

    function isDocumentHidden() {
      try { return typeof document !== "undefined" && document.visibilityState === "hidden"; } catch (e) { return false; }
    }

    function currentCwd(sessionId) {
      try {
        const sessions = SessionsBridge.getSessions && SessionsBridge.getSessions();
        const byId = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot().byId;
        return byId && byId[sessionId] ? byId[sessionId].cwd : undefined;
      } catch (e) {
        return undefined;
      }
    }

    async function api(endpoint, payload) {
      const res = await fetch(API_BASE + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      if (!res.ok) throw new Error("api " + endpoint + ": HTTP " + res.status);
      return res.json();
    }

    /**
     * 上行消息判定（协议 v1 的两个信封）：
     *   __dshmd —— 插件桥 dsh-bridge.js 的 emit（init / bridge-ready / insert-to-chat …）；
     *   __dshmp —— 引擎自身的 shell 通道（change / text / openLink 直接 post 给父窗口）。
     * 两者都必须是 dir:"up" 且来自当前代 iframe；漏判 __dshmp 会让脏标与 requestText 回执全部丢失。
     */
    function isUpEnvelope(data) {
      if (!data || data.dir !== "up") return false;
      return data.__dshmd === true || data.__dshmp === true;
    }

    const __test = {
      constants: {
        TAB_TYPE_ID: TAB_TYPE_ID,
        FILE_ADDRESS_PREFIX: FILE_ADDRESS_PREFIX,
        RECOVERY_PREFIX: RECOVERY_PREFIX,
        SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
        PULL_TIMEOUT_MS: PULL_TIMEOUT_MS,
        FLUSH_WAIT_MS: FLUSH_WAIT_MS,
      },
      parseFileAddress: parseFileAddress,
      basenameOf: basenameOf,
      directoryOf: directoryOf,
      absolutePath: absolutePath,
      encodeFileAddress: encodeFileAddress,
      normalizePathKey: normalizePathKey,
      samePath: samePath,
      recoveryKey: recoveryKey,
      readRecoverySlot: readRecoverySlot,
      writeRecoverySlot: writeRecoverySlot,
      clearRecoverySlot: clearRecoverySlot,
      ticketOf: ticketOf,
      isCurrentTicket: isCurrentTicket,
      saveGate: saveGate,
      buildSaveRequest: buildSaveRequest,
      nextPollDelay: nextPollDelay,
      shouldAcceptExternal: shouldAcceptExternal,
      insertSelectionToChat: insertSelectionToChat,
      buildTabDefinition: buildTabDefinition,
      isDarkTheme: isDarkTheme,
      isUpEnvelope: isUpEnvelope,
    };

    /* ───────────────────────── 宿主能力（iframe host-invoke） ───────────────────────── */

    function clipboardOf() {
      try { return typeof navigator !== "undefined" ? navigator.clipboard : null; } catch (e) { return null; }
    }

    function handleHostInvoke(content, post) {
      const id = content && content.id;
      const done = (result) => post("host-result", { id: id, result: result });
      const fail = (error) => post("host-result", { id: id, error: String(error && error.message ? error.message : error) });
      try {
        const cmd = content && content.cmd;
        const args = (content && content.args) || {};
        if (cmd === "clipboard-write-text") {
          const clipboard = clipboardOf();
          if (!clipboard || typeof clipboard.writeText !== "function") { fail(new Error("clipboard unavailable")); return; }
          clipboard.writeText(String(args.text == null ? "" : args.text)).then(done, fail);
        } else if (cmd === "clipboard-read-text") {
          const clipboard = clipboardOf();
          if (!clipboard || typeof clipboard.readText !== "function") { fail(new Error("clipboard unavailable")); return; }
          clipboard.readText().then(done, fail);
        } else if (cmd === "open-external") {
          try { window.open(String(args.url == null ? "" : args.url), "_blank", "noopener"); } catch (e) { /* 拦截器拒绝 */ }
          done(true);
        } else {
          done(null);
        }
      } catch (error) {
        fail(error);
      }
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const bannerStyle = (warn) => ({
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "4px 10px", fontSize: 12, flex: "0 0 auto",
      background: warn ? "color-mix(in srgb, currentColor 10%, transparent)" : "color-mix(in srgb, currentColor 5%, transparent)",
      borderBottom: "1px solid color-mix(in srgb, currentColor " + (warn ? 25 : 14) + "%, transparent)",
    });
    const btnStyle = {
      fontSize: 12, padding: "1px 8px", border: "1px solid rgba(127,127,127,0.4)",
      borderRadius: 4, background: "transparent", cursor: "pointer",
    };
    const emptyStyle = { padding: 12, fontSize: 12, opacity: 0.7 };

    /* ───────────────────────── tab body ───────────────────────── */

    function EditorTabBody(props) {
      if (!React) return null;
      if (typeof props.useTabInfo !== "function") {
        return React.createElement("div", { style: emptyStyle }, "dsh-markdown-typora: useTabInfo unavailable");
      }
      return React.createElement(EditorTabBodyInner, props);
    }

    function EditorTabBodyInner(props) {
      const h = React.createElement;
      const tab = props.useTabInfo().tab;
      const address = tab && tab.contentId;
      const parsed = React.useMemo(() => parseFileAddress(address), [address]);
      const depKey = parsed ? [parsed.scope, parsed.sessionId || "", parsed.path].join("|") : null;
      const tabVisible = !(tab && tab.visible === false);
      const sessionIdFromProps = typeof props.sessionId === "string" ? props.sessionId : "";

      const frameRef = React.useRef(null);
      const st = React.useRef({ doc: null, actions: {} }).current;
      const inputActionsRef = React.useRef(props.inputActions);
      inputActionsRef.current = props.inputActions;

      const [ui, setUi] = React.useState({ phase: "loading", detail: "", notice: "", recovery: null });
      const setUiIfChanged = React.useCallback((next) => {
        setUi((prev) => {
          if (prev.phase === next.phase && prev.detail === next.detail && prev.notice === next.notice) return prev;
          return { ...prev, ...next };
        });
      }, []);

      /* ── 文档生命周期（每个 depKey 一代；异步回执都验票） ── */
      React.useEffect(() => {
        if (!parsed) return undefined;
        const doc = {
          gen: ++generationCounter,
          key: depKey,
          win: null,
          sessionId: parsed.sessionId || sessionIdFromProps || "",
          path: parsed.path,
          absPath: absolutePath(parsed.path, currentCwd(parsed.sessionId || sessionIdFromProps)),
          displayPath: "",
          size: 0,
          opened: false,
          dead: false,
          bridgeUp: false,
          editorReady: false,
          booting: false,
          lastVersion: null,
          dirty: false,
          conflict: false,
          saving: false,
          saveQueued: false,
          editSeq: 0,
          text: "",
          textFresh: false,
          recovery: null,
          saveTimer: null,
          pullResolve: null,
          pullTimer: null,
          flushResolve: null,
          flushTimer: null,
          flushed: false,
          es: null,
          esHealthy: false,
          pollTimer: null,
          pollFailures: 0,
          externalStale: false,
          staleNotified: false,
          tabVisible: tabVisible,
          notice: "",
          phase: "loading",
          reload: null,
          reloadDisk: null,
          copyMine: null,
        };
        st.doc = doc;
        setUiIfChanged({ phase: "loading", detail: "", notice: "", recovery: null });

        const ticket = ticketOf(doc.sessionId, doc.absPath, doc.gen);
        const alive = () => !doc.dead && st.doc === doc && ticket.generation === doc.gen;
        const cleanups = [];

        function refreshPath() {
          doc.absPath = absolutePath(parsed.path, currentCwd(doc.sessionId));
          doc.displayPath = doc.displayPath || doc.absPath;
          openDocs.set(doc.sessionId + "\n" + doc.absPath, {
            sessionId: doc.sessionId,
            path: doc.absPath,
            basename: basenameOf(doc.absPath),
          });
        }
        refreshPath();

        function currentFrameWin() {
          // 只在"还是当前代且未死"时回落到 ref：清理阶段 frameRef 可能已指向新文档的 iframe，
          // 拿它发 requestText 会把旧文档的全文当成新文档的回执（跨文档污染）。
          if (st.doc !== doc || doc.dead) return null;
          try { return frameRef.current ? frameRef.current.contentWindow : null; } catch (e) { return null; }
        }

        function post(type, content) {
          const win = doc.win || currentFrameWin();
          if (!win) return false;
          try {
            win.postMessage({ __dshmd: true, dir: "down", type: type, content: content }, "*");
            return true;
          } catch (e) {
            return false;
          }
        }

        function showPhase(phase, detail) {
          doc.phase = phase;
          doc.detail = detail || "";
          if (phase !== "ready" && phase !== "dirty") doc.notice = "";
          setUiIfChanged({ phase: phase, detail: detail || "", notice: doc.notice });
        }
        function showError(message) {
          showPhase("error", message);
        }
        function showNotice(message) {
          if (doc.dead) return; // 卸载/关闭后不再 setState（恢复槽超大等清理期提示）
          doc.notice = message;
          setUiIfChanged({ phase: doc.phase, detail: doc.detail || "", notice: message });
        }

        function sendKeepaliveSave(path, text, baseVersion) {
          try {
            const body = JSON.stringify({ path: path, text: text, baseVersion: baseVersion });
            fetch(API_BASE + "save", {
              method: "POST",
              keepalive: true,
              headers: { "content-type": "application/json" },
              body: body,
            }).catch(() => { /* keepalive 失败由恢复槽兜底 */ });
          } catch (e) { /* 已尽力 */ }
        }

        function writeRecovery(text, stale) {
          const slot = {
            text: typeof text === "string" ? text : doc.text,
            baseVersion: typeof doc.lastVersion === "string" ? doc.lastVersion : null,
            ts: Date.now(),
            path: doc.absPath,
            ...(stale ? { stale: true } : {}),
          };
          const ok = writeRecoverySlot(null, slot);
          if (!ok && typeof text === "string" && text.length > MAX_TEXT_CHARS) {
            showNotice("文档过大，关闭前恢复槽未写入；请先保存");
          }
        }

        /** 关 tab flush：requestText ≤120ms → keepalive save；拿不到全文只写恢复槽，绝不拿旧缓存写盘。 */
        function flushClose() {
          if (doc.flushed) return;
          doc.flushed = true;
          if (!doc.opened || !doc.dirty || !doc.absPath) return;
          const cached = doc.text;
          const done = (text, stale) => {
            if (typeof text === "string") { doc.text = text; doc.textFresh = true; }
            writeRecovery(typeof text === "string" ? text : cached, stale);
            if (!stale && typeof doc.lastVersion === "string" && doc.lastVersion) {
              sendKeepaliveSave(doc.absPath, typeof text === "string" ? text : cached, doc.lastVersion);
            }
          };
          if (!doc.textFresh) {
            doc.flushResolve = (text) => {
              doc.flushResolve = null;
              if (doc.flushTimer) { clearTimeout(doc.flushTimer); doc.flushTimer = null; }
              done(text, typeof text !== "string");
            };
            if (!post("requestText", {})) { done(undefined, true); return; }
            doc.flushTimer = setTimeout(() => {
              if (!doc.flushResolve) return;
              const resolve = doc.flushResolve;
              doc.flushResolve = null;
              doc.flushTimer = null;
              resolve(undefined);
            }, FLUSH_WAIT_MS);
          } else {
            done(cached, false);
          }
        }

        function onText(text) {
          doc.text = text;
          doc.textFresh = true;
          if (doc.pullResolve) {
            const resolve = doc.pullResolve;
            doc.pullResolve = null;
            if (doc.pullTimer) { clearTimeout(doc.pullTimer); doc.pullTimer = null; }
            resolve({ text: text, stale: false });
          }
          if (doc.flushResolve) {
            const resolve = doc.flushResolve;
            doc.flushResolve = null;
            if (doc.flushTimer) { clearTimeout(doc.flushTimer); doc.flushTimer = null; }
            resolve(text);
          }
        }

        function pullText() {
          if (doc.textFresh) return Promise.resolve({ text: doc.text, stale: false });
          return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (settled) return;
              settled = true;
              if (doc.pullResolve === finish) {
                doc.pullResolve = null;
                if (doc.pullTimer) { clearTimeout(doc.pullTimer); doc.pullTimer = null; }
              }
              resolve(value);
            };
            doc.pullResolve = finish;
            if (!post("requestText", {})) { finish({ text: doc.text, stale: true }); return; }
            doc.pullTimer = setTimeout(() => finish({ text: doc.text, stale: true }), PULL_TIMEOUT_MS);
          });
        }

        function scheduleSave(delay) {
          if (doc.dead) return;
          if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
          doc.saveTimer = setTimeout(() => {
            doc.saveTimer = null;
            void runSave();
          }, typeof delay === "number" ? Math.max(0, delay) : SAVE_DEBOUNCE_MS);
        }

        async function runSave() {
          if (doc.dead) return;
          const gate = saveGate({
            dirty: doc.dirty,
            saving: doc.saving,
            baseVersion: doc.lastVersion,
            opened: doc.opened,
            dead: doc.dead,
          });
          if (gate.action === "queue") { doc.saveQueued = true; return; }
          if (gate.action === "block") { showError("保存被拒绝：缺少基准版本（请重新打开文档）"); return; }
          if (gate.action !== "save") return;
          doc.saving = true;
          const saveSeq = doc.editSeq; // 保存飞行期间的新编辑靠它识别：宁可多存一轮，不许把脏标清掉
          if (doc.phase !== "dirty" && doc.phase !== "conflict") showPhase("saving", "保存中…");
          try {
            const pulled = await pullText();
            if (!alive()) return;
            if (pulled.stale) {
              showError("保存暂停：编辑器未在 " + PULL_TIMEOUT_MS + "ms 内返回全文（未写入磁盘，可继续编辑后重试）");
              return;
            }
            const request = buildSaveRequest({ path: doc.absPath, text: pulled.text, baseVersion: doc.lastVersion });
            if (!request.ok) { showError("保存被拒绝：" + request.reason); return; }
            const result = await api("save", request.body);
            if (!alive()) return;
            if (result.ok === true) {
              const editedDuringSave = doc.editSeq !== saveSeq;
              doc.lastVersion = result.value.version;
              if (!editedDuringSave) {
                doc.text = pulled.text;
                doc.textFresh = true;
                doc.dirty = false;
              } else {
                doc.dirty = true;
                doc.saveQueued = true;
              }
              doc.conflict = false;
              doc.externalStale = false;
              doc.staleNotified = false;
              showPhase(doc.dirty ? "dirty" : "ready", doc.dirty ? "编辑中…（上一轮已保存，继续保存新改动）" : "已保存");
              // 保存飞行期间可能被外部改过：落盘后 stat 对账（干净则静默重载，脏则只标记）。
              try {
                const stat = await api("stat", { path: doc.absPath });
                if (alive() && stat.ok === true && stat.value && stat.value.version !== doc.lastVersion) {
                  if (doc.dirty || doc.conflict) { doc.externalStale = true; }
                  else await loadFromDisk({ silent: true, reason: "save-reconcile" });
                }
              } catch (e) { /* 对账失败不阻塞保存结果 */ }
            } else if (result.error && result.error.code === "FS_STALE_VERSION") {
              doc.conflict = true;
              showPhase("conflict", "文件已在别处被修改（" + (result.error.message || "FS_STALE_VERSION") + "）；版本守卫拒绝覆盖");
            } else {
              showError("保存失败：" + (result.error && result.error.code ? result.error.code : "error") + " — " + (result.error && result.error.message ? result.error.message : ""));
            }
          } catch (error) {
            if (alive()) showError("保存失败：" + String(error && error.message ? error.message : error));
          } finally {
            doc.saving = false;
            if (doc.saveQueued && alive()) { doc.saveQueued = false; scheduleSave(0); }
          }
        }

        /** 首次打开 / 干净缓冲下的外部变更重载。silent=true 时失败不弹错误横幅。 */
        async function loadFromDisk(options) {
          const opts = options || {};
          if (doc.dead) return false;
          refreshPath();
          const editSeqAtStart = doc.editSeq;
          try {
            const result = await api("open", { path: doc.absPath });
            if (!alive()) return false;
            // 外部重载请求飞行期间用户又打字了：绝不 setValue 覆盖（脏缓冲只提示）。
            if (doc.opened && (doc.editSeq !== editSeqAtStart || doc.dirty || doc.conflict)) {
              doc.externalStale = true;
              return false;
            }
            if (result.ok !== true) {
              if (!opts.silent) showError("打开失败：" + (result.error && result.error.code ? result.error.code : "error") + " — " + (result.error && result.error.message ? result.error.message : ""));
              return false;
            }
            const value = result.value;
            const firstOpen = !doc.opened;
            doc.text = value.text;
            doc.textFresh = true;
            doc.lastVersion = value.version;
            doc.displayPath = value.displayPath || doc.absPath;
            doc.size = value.size;
            doc.dirty = false;
            doc.conflict = false;
            doc.externalStale = false;
            doc.staleNotified = false;
            doc.recovery = null;
            if (firstOpen) {
              doc.opened = true;
              // 顺序契约：先 theme，再 open（引擎可能按主题初始化编辑面）。
              post("theme", { dark: isDarkTheme() });
              post("open", {
                title: basenameOf(doc.absPath),
                content: doc.text,
                language: "zh-cn",
                rootPath: directoryOf(doc.absPath),
              });
              // 恢复槽只在"确实与磁盘不同"时提示；默认不落盘。
              const slot = readRecoverySlot(null, doc.absPath);
              if (slot && typeof slot.text === "string" && slot.text !== doc.text) {
                doc.recovery = slot;
                setUiIfChanged({ phase: "recovery", detail: "检测到上次关闭时未保存的内容", notice: "", recovery: slot });
                return true;
              }
              if (slot) clearRecoverySlot(null, doc.absPath);
              showPhase("ready", "");
            } else {
              post("setValue", doc.text);
              showPhase("ready", opts.reason === "sse" || opts.reason === "poll" ? "已同步磁盘更新" : "已重载磁盘版本");
            }
            return true;
          } catch (error) {
            if (!alive()) return false;
            if (!opts.silent) showError("打开失败：" + String(error && error.message ? error.message : error));
            return false;
          }
        }

        function maybeBoot() {
          if (!alive() || !doc.bridgeUp || !doc.editorReady || doc.opened || doc.booting) return;
          doc.booting = true;
          post("theme", { dark: isDarkTheme() });
          void loadFromDisk({}).finally(() => { doc.booting = false; });
        }

        function onDirty(content) {
          doc.dirty = true;
          doc.editSeq += 1;
          doc.textFresh = false;
          const len = content && typeof content === "object" && Number.isFinite(Number(content.len)) ? Number(content.len) : null;
          if (doc.phase !== "dirty" && doc.phase !== "conflict") {
            showPhase("dirty", len === null ? "编辑中…" : "编辑中…（" + len + " 字符）");
          } else if (doc.externalStale && !doc.staleNotified) {
            doc.staleNotified = true;
            showPhase("dirty", "编辑中…（磁盘已更新，保存时会冲突）");
          }
          scheduleSave(SAVE_DEBOUNCE_MS);
        }

        function onExternalEvent(event) {
          let data = {};
          try { data = JSON.parse(event.data) || {}; } catch (e) { data = {}; }
          if (data.path && doc.absPath && !samePath(data.path, doc.absPath)) return;
          if (!doc.opened) return; // 握手/首次 open 之前的事件没有落点（boot 自己会读磁盘）
          const version = data.version == null ? "" : String(data.version);
          const accepted = shouldAcceptExternal({
            dirty: doc.dirty,
            conflict: doc.conflict,
            saving: doc.saving,
            hidden: isDocumentHidden(),
            visible: doc.tabVisible,
          });
          if (!accepted) {
            if (!doc.externalStale) {
              doc.externalStale = true;
              if (doc.dirty && !doc.staleNotified) {
                doc.staleNotified = true;
                showPhase("dirty", "编辑中…（磁盘已更新，保存时会冲突）");
              }
            }
            return;
          }
          if (doc.phase === "conflict") { doc.externalStale = true; return; }
          if (doc.lastVersion && version && version === String(doc.lastVersion)) return;
          void loadFromDisk({ silent: true, reason: "sse" });
        }

        function clearPoll() {
          if (doc.pollTimer) { clearTimeout(doc.pollTimer); doc.pollTimer = null; }
        }

        function schedulePoll(delay) {
          clearPoll();
          if (doc.dead) return;
          const wait = typeof delay === "number"
            ? delay
            : nextPollDelay({ healthy: doc.esHealthy, failures: doc.pollFailures, hidden: isDocumentHidden() });
          if (wait === null) return;
          doc.pollTimer = setTimeout(pollOnce, wait);
        }

        function pollOnce() {
          doc.pollTimer = null;
          if (doc.dead) return;
          // 页面隐藏 = 暂停轮询（visibilitychange 恢复）；后台 tab = 降频，回到前台会立刻补一轮。
          if (isDocumentHidden()) return;
          if (doc.tabVisible === false) { schedulePoll(POLL_SLOW_MS); return; }
          if (doc.esHealthy) { schedulePoll(POLL_SLOW_MS); return; }
          if (doc.dirty || doc.conflict || doc.saving || !doc.opened || !doc.lastVersion) {
            doc.pollFailures = Math.min(3, doc.pollFailures + 1);
            schedulePoll(nextPollDelay({ healthy: false, failures: doc.pollFailures, hidden: false }));
            return;
          }
          api("stat", { path: doc.absPath }).then((result) => {
            if (doc.dead) return;
            if (result.ok === true && result.value && String(result.value.version) !== String(doc.lastVersion)) {
              void loadFromDisk({ silent: true, reason: "poll" });
            }
          }).catch(() => { /* 轮询失败静默，下轮重试 */ }).finally(() => {
            if (doc.dead) return;
            doc.pollFailures = Math.min(3, doc.pollFailures + 1);
            schedulePoll(nextPollDelay({ healthy: doc.esHealthy, failures: doc.pollFailures, hidden: isDocumentHidden() }));
          });
        }

        function startSse() {
          if (typeof EventSource !== "function") { schedulePoll(POLL_FAST_MS); return; }
          try {
            const es = new EventSource(API_BASE + "watch?path=" + encodeURIComponent(doc.absPath));
            doc.es = es;
            es.addEventListener("open", () => {
              if (doc.dead) return;
              doc.esHealthy = true;
              doc.pollFailures = 0;
              clearPoll();
            });
            es.addEventListener("change", (event) => {
              doc.esHealthy = true;
              doc.pollFailures = 0;
              onExternalEvent(event);
            });
            es.onerror = () => {
              if (doc.dead) return;
              doc.esHealthy = false;
              schedulePoll(POLL_FAST_MS);
            };
          } catch (e) {
            schedulePoll(POLL_FAST_MS);
          }
        }

        async function onInsertToChat(content) {
          const text = typeof content === "string"
            ? content
            : (content && typeof content.text === "string" ? content.text : "");
          if (!text) return;
          const outcome = await insertSelectionToChat(inputActionsRef.current, text, {
            clipboard: clipboardOf(),
          });
          if (!alive()) return;
          if (outcome.ok) {
            post("toast", "已插入到输入框");
            showNotice("已插入到输入框");
          } else if (outcome.method === "clipboard") {
            post("toast", "已复制，粘贴到输入框");
            showNotice("已复制，粘贴到输入框");
          } else {
            post("toast", "插入失败：编辑框不可用，复制也失败");
            showNotice("插入失败：编辑框不可用，复制也失败");
          }
        }

        function onMessage(event) {
          const data = event && event.data;
          if (!isUpEnvelope(data)) return;
          const liveWin = doc.win || currentFrameWin();
          if (!liveWin || event.source !== liveWin) return; // 只认当前代 iframe，旧 iframe 的晚到消息丢弃
          const type = data.type;
          // 已死代际只放行"关 tab flush 的 text 回执"（旧回执一律丢弃）。
          if (!alive() && !(type === "text" && doc.flushResolve)) return;
          if (type === "bridge-ready") {
            if (doc.bridgeUp) return;
            doc.bridgeUp = true;
            post("theme", { dark: isDarkTheme() });
            maybeBoot();
            return;
          }
          if (type === "init") {
            doc.editorReady = true;
            if (data.content && data.content.again === true && doc.opened) {
              // 引擎看门狗重发 init（说明它还没收到 open）：幂等重发，仍先 theme。
              post("theme", { dark: isDarkTheme() });
              post("open", {
                title: basenameOf(doc.absPath),
                content: doc.text,
                language: "zh-cn",
                rootPath: directoryOf(doc.absPath),
              });
              return;
            }
            maybeBoot();
            return;
          }
          if (type === "change") { onDirty(data.content); return; }
          if (type === "text") { onText(typeof data.content === "string" ? data.content : ""); return; }
          if (type === "insert-to-chat") { void onInsertToChat(data.content); return; }
          if (type === "host-invoke") { handleHostInvoke(data.content, post); return; }
          if (type === "openLink" && data.content) {
            try { window.open(String(data.content), "_blank", "noopener"); } catch (e) { /* 拦截器拒绝 */ }
            return;
          }
          // scroll / img / media-command 等：MVP 静默（协议 v1 无对应能力）。
        }

        function restoreRecovery() {
          const slot = doc.recovery;
          if (!slot || typeof slot.text !== "string") { void discardRecovery(); return; }
          doc.recovery = null;
          clearRecoverySlot(null, doc.absPath);
          doc.text = slot.text;
          doc.textFresh = true;
          doc.dirty = true;
          doc.editSeq += 1;
          doc.conflict = false;
          post("setValue", doc.text);
          setUiIfChanged({ phase: "dirty", detail: "已恢复未保存内容，正在保存…", notice: "", recovery: null });
          scheduleSave(0);
        }

        function discardRecovery() {
          doc.recovery = null;
          clearRecoverySlot(null, doc.absPath);
          setUiIfChanged({ phase: "ready", detail: "已丢弃恢复内容", notice: "", recovery: null });
          return Promise.resolve();
        }

        async function copyMine() {
          const pulled = await pullText();
          if (!alive()) return;
          const text = pulled.stale ? doc.text : pulled.text;
          try {
            const clipboard = clipboardOf();
            if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard unavailable");
            await clipboard.writeText(text);
            post("toast", "已复制当前编辑内容");
            showPhase("conflict", "已复制当前编辑内容；磁盘版本未覆盖");
          } catch (error) {
            post("toast", "复制失败：" + String(error && error.message ? error.message : error));
          }
        }

        function forceReload() {
          doc.conflict = false;
          doc.dirty = false;
          doc.externalStale = false;
          doc.recovery = null;
          setUiIfChanged({ phase: "loading", detail: "", notice: "", recovery: null });
          void loadFromDisk({ silent: false });
        }

        // 横幅按钮回调（渲染侧通过 st.actions 取当前代）。
        st.actions = {
          reloadDisk: forceReload,
          copyMine: copyMine,
          restoreRecovery: restoreRecovery,
          discardRecovery: discardRecovery,
          retry: () => { showPhase("loading", ""); void loadFromDisk({ silent: false }); },
        };
        doc.reload = (opts) => loadFromDisk(opts || {});
        doc.reloadDisk = forceReload;
        doc.copyMine = copyMine;

        window.addEventListener("message", onMessage);
        const disposeMessage = () => { try { window.removeEventListener("message", onMessage); } catch (e) { /* 忽略 */ } };

        // 主题：只观察 body 的 data-ds-dark-theme 属性（不做 DOM 树观察）。
        let themeObserver = null;
        try {
          if (typeof MutationObserver === "function" && document.body) {
            themeObserver = new MutationObserver(() => { post("theme", { dark: isDarkTheme() }); });
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
          }
        } catch (error) { themeObserver = null; }

        const onVisibilityChange = () => {
          if (doc.dead) return;
          if (isDocumentHidden()) { clearPoll(); return; }
          schedulePoll(0);
          if (doc.opened && doc.externalStale && !doc.dirty && !doc.conflict && !doc.saving && doc.tabVisible !== false) {
            doc.externalStale = false;
            void loadFromDisk({ silent: true, reason: "visible" });
          }
        };
        try {
          document.addEventListener("visibilitychange", onVisibilityChange);
          cleanups.push(() => { try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) { /* 忽略 */ } });
        } catch (e) { /* 无 document（测试环境） */ }

        // tab 关闭/替换：signal 在记录移除时 abort，比 React 卸载更早，留出 requestText 的窗口。
        const tabSignal = tab && tab.signal;
        try {
          if (tabSignal && typeof tabSignal.addEventListener === "function") {
            const onAbort = () => { try { flushClose(); } catch (e) { /* 最后一搏失败不阻塞关闭 */ } };
            tabSignal.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => { try { tabSignal.removeEventListener("abort", onAbort); } catch (e) { /* 忽略 */ } });
          }
        } catch (e) { /* 旧宿主无 signal */ }

        startSse();

        return () => {
          doc.dead = true;
          try { flushClose(); } catch (e) { /* 已尽力 */ }
          if (doc.saveTimer) { clearTimeout(doc.saveTimer); doc.saveTimer = null; }
          if (doc.pullTimer) { clearTimeout(doc.pullTimer); doc.pullTimer = null; }
          if (doc.pollTimer) { clearTimeout(doc.pollTimer); doc.pollTimer = null; }
          if (doc.flushTimer) { clearTimeout(doc.flushTimer); doc.flushTimer = null; }
          if (doc.es) { try { doc.es.close(); } catch (e) { /* 已断 */ } doc.es = null; }
          if (themeObserver) { try { themeObserver.disconnect(); } catch (e) { /* 已断 */ } }
          for (let i = 0; i < cleanups.length; i += 1) {
            try { cleanups[i](); } catch (e) { /* 忽略 */ }
          }
          // 先移除 message 监听再拉全文 = 永远拿不到回执（LOG-3.3.8 已知缺口）；这里留到 flush 结束。
          if (doc.flushResolve) setTimeout(disposeMessage, FLUSH_WAIT_MS + 80);
          else disposeMessage();
          openDocs.delete(doc.sessionId + "\n" + doc.absPath);
          if (st.doc === doc) st.doc = null;
          st.actions = {};
        };
      }, [depKey]);

      /* ── tab 可见性变化：后台期间暂停覆盖，回到前台再决定重载 ── */
      React.useEffect(() => {
        const doc = st.doc;
        if (!doc) return;
        doc.tabVisible = tabVisible;
        if (tabVisible && doc.externalStale && !doc.dirty && !doc.conflict && !doc.saving) {
          doc.externalStale = false;
          if (typeof doc.reload === "function") void doc.reload({ silent: true, reason: "visible" });
        }
      }, [tabVisible]);

      if (!parsed) {
        return h("div", { style: emptyStyle }, "dsh-markdown-typora: 无法解析文件地址 " + String(address == null ? "" : address));
      }

      let banner = null;
      if (ui.phase === "conflict") {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "⚠ " + ui.detail),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.reloadDisk && st.actions.reloadDisk(); } catch (e) { /* 忽略 */ } } }, "重载磁盘版本"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.copyMine && st.actions.copyMine(); } catch (e) { /* 忽略 */ } } }, "复制我的内容"));
      } else if (ui.phase === "recovery" && ui.recovery) {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "检测到上次关闭时未保存的内容（" + new Date(ui.recovery.ts || Date.now()).toLocaleString() + "）"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.restoreRecovery && st.actions.restoreRecovery(); } catch (e) { /* 忽略 */ } } }, "恢复"),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.discardRecovery && st.actions.discardRecovery(); } catch (e) { /* 忽略 */ } } }, "丢弃"));
      } else if (ui.phase === "error") {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "✗ " + ui.detail),
          h("button", { style: btnStyle, onClick: () => { try { st.actions.retry && st.actions.retry(); } catch (e) { /* 忽略 */ } } }, "重试"));
      } else if (ui.phase === "loading") {
        banner = h("div", { style: bannerStyle(false) }, "正在加载文档…");
      } else {
        banner = h("div", { style: { ...bannerStyle(false), minHeight: 22 } }, ui.notice || ui.detail || "");
      }

      const frameName = "dsh-markdown-typora-" + String((tab && (tab.id || tab.occurrenceId)) || "tab");
      return h("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } },
        banner,
        h("iframe", {
          key: depKey,
          ref: frameRef,
          name: frameName,
          src: FRAME_SRC,
          // 同源整装：内容是插件自带的可信 renderer（非第三方文档），需要 localStorage（主题/偏好）。
          sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
          onLoad: () => {
            const win = frameRef.current ? frameRef.current.contentWindow : null;
            const current = st.doc;
            // 只有"这一代的 iframe"才写入 doc.win：旧 iframe 的 load 晚到不得覆盖新文档的窗口。
            if (current && current.key === depKey) current.win = win;
            if (win) {
              try {
                win.postMessage({ __dshmd: true, dir: "down", type: "theme", content: { dark: isDarkTheme() } }, "*");
              } catch (e) { /* 尚未就绪 */ }
            }
          },
          style: { width: "100%", height: "100%", border: 0, flex: 1, background: "transparent" },
        }));
    }

    /* ───────────────────────── @mp 引用源（可失败，不阻塞主功能） ───────────────────────── */

    function registerMpSource(ctx, hooks) {
      const log = hooks.log;
      try {
        if (typeof ctx.inject !== "function") return;
        ctx.inject(["inputTriggers"], (scope) => {
          try {
            const triggers = scope.inputTriggers || (scope.get && scope.get("inputTriggers"));
            if (!triggers || typeof triggers.registerSource !== "function") {
              log.warn?.("dsh-markdown-typora: inputTriggers unavailable, @mp source not registered");
              return;
            }
            const sidebarRight = (() => { try { return scope.get ? scope.get("sidebarRight") : undefined; } catch (e) { return undefined; } })();
            const source = {
              trigger: "@",
              name: "mp",
              async candidates(_session, context) {
                const query = String((context && context.query) || "").toLowerCase();
                const rows = [];
                for (const item of openDocs.values()) {
                  if (query && item.basename.toLowerCase().indexOf(query) === -1 && item.path.toLowerCase().indexOf(query) === -1) continue;
                  rows.push({
                    label: item.basename,
                    name: "mp",
                    description: "Markdown 编辑面打开的文档",
                    value: JSON.stringify({ kind: "mp", path: item.path, sessionId: item.sessionId }),
                  });
                }
                return rows;
              },
              onPick({ candidate }) {
                let value = null;
                try { value = JSON.parse(candidate.value); } catch (e) { value = null; }
                if (!value || value.kind !== "mp") return undefined;
                return {
                  insert: {
                    source: "mp",
                    ref: '@mp "' + value.path + '"',
                    label: basenameOf(value.path),
                    appearance: "file",
                    clipboardText: value.path,
                  },
                };
              },
              openReference(session, refData) {
                try {
                  if (!sidebarRight) return false;
                  const ref = String((refData && refData.ref) || "");
                  const path = ref.replace(/^@mp\s*"?/, "").replace(/"$/, "");
                  if (!path) return false;
                  sidebarRight.openResource(encodeFileAddress(session.sessionId, path));
                  return true;
                } catch (e) {
                  return false;
                }
              },
            };
            if (typeof scope.effect === "function") scope.effect(() => triggers.registerSource(source), "dsh-markdown-typora: @mp source");
            else triggers.registerSource(source);
            try { if (window.__DSH_MARKDOWN__) window.__DSH_MARKDOWN__.mpSourceRegistered = true; } catch (e) { /* 诊断位 */ }
            log.info?.("dsh-markdown-typora: @mp source registered");
          } catch (error) {
            log.warn?.("dsh-markdown-typora: @mp source inner failed: %s", String(error && error.message ? error.message : error));
          }
        });
      } catch (error) {
        log.warn?.("dsh-markdown-typora: @mp source failed: %s", String(error && error.message ? error.message : error));
      }
    }

    /* ───────────────────────── 插件入口 ───────────────────────── */

    const inject = ["slots"];

    function apply(ctx) {
      const log = (() => {
        try { return typeof ctx.logger === "function" ? ctx.logger("dsh-markdown-typora") : console; } catch (e) { return console; }
      })();
      const get = (name) => {
        try { return ctx.get(name); } catch (e) { return undefined; }
      };
      const runEffect = (fn, label) => {
        try {
          if (typeof ctx.effect === "function") ctx.effect(fn, label);
          else fn();
        } catch (error) {
          log.warn?.("dsh-markdown-typora: effect failed (%s): %s", label, String(error && error.message ? error.message : error));
        }
      };

      let tabTypeRegistered = false;
      const registerTabType = (tabs) => {
        if (tabTypeRegistered) return;
        if (!tabs || typeof tabs.register !== "function") {
          log.warn?.("dsh-markdown-typora: sidebarRightTabs.register unavailable, tab type not registered");
          return;
        }
        try {
          runEffect(() => tabs.register(buildTabDefinition()), "dsh-markdown-typora: tab type");
          tabTypeRegistered = true;
          log.info?.("dsh-markdown-typora: tab type registered");
        } catch (error) {
          log.warn?.("dsh-markdown-typora: tab type failed: %s", String(error && error.message ? error.message : error));
        }
      };

      // ① tab 类型：服务可能晚于本插件 apply 注册 —— get 优先，缺失时用 ctx.inject 等待就绪。
      try {
        const tabs = get("sidebarRightTabs");
        if (tabs) {
          registerTabType(tabs);
        } else if (typeof ctx.inject === "function") {
          ctx.inject(["sidebarRightTabs"], (scope) => {
            try { registerTabType(scope.sidebarRightTabs || (scope.get && scope.get("sidebarRightTabs"))); }
            catch (error) { log.warn?.("dsh-markdown-typora: tab type late registration failed: %s", String(error && error.message ? error.message : error)); }
          });
        } else {
          log.warn?.("dsh-markdown-typora: sidebarRightTabs unavailable, tab type not registered");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: tab type seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ② tab body：只有这一个入口渲染 iframe（引擎在 iframe 内，宿主不订阅文档文本）。
      try {
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          runEffect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: TAB_TYPE_ID,
          }, EditorTabBody)), "dsh-markdown-typora: tab body");
        } else if (ctx.slots && typeof ctx.slots.register === "function") {
          runEffect(() => ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE_ID }, EditorTabBody), "dsh-markdown-typora: tab body");
        } else {
          log.warn?.("dsh-markdown-typora: slots service unavailable, tab body not registered");
        }
      } catch (error) {
        log.warn?.("dsh-markdown-typora: tab body seed failed: %s", String(error && error.message ? error.message : error));
      }

      // ③ sessions 旁路（cwd 解析用；服务晚到也没关系，每次 open 现取）。
      try { SessionsBridge.getSessions = () => get("sessions"); } catch (e) { /* 忽略 */ }

      // ④ @mp 引用源：全部 try/catch，失败只告警，不影响编辑/插入。
      registerMpSource(ctx, { log: log, get: get });

      /* ① 把持久化里 markpilot 相关的旧面板状态清掉（旧版本中间面板方案已撤回）。
       *    只动含 markpilot-main 的键，不碰其它插件/外壳状态。 */
      try {
        const dead = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key) continue;
          let value = "";
          try { value = String(localStorage.getItem(key) || ""); } catch (e) { value = ""; }
          if (key.indexOf("markpilot-main") !== -1 || value.indexOf("markpilot-main") !== -1) dead.push(key);
        }
        for (let i = 0; i < dead.length; i += 1) { try { localStorage.removeItem(dead[i]); } catch (e) { /* 忽略 */ } }
      } catch (e) { /* 无存储 */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-markdown-typora";
    exports.__test = __test;

    // 调试面（只读镜像，方便宿主/桌面工具观察；不影响渲染）。
    try { window.__DSH_MARKDOWN__ = { openDocs: openDocs, version: "0.3.2" }; } catch (e) { /* 沙箱环境 */ }

    return module.exports;
  },
});
