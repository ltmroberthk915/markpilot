// dsh-markpilot 客户端半边：右侧栏 tab 类型 + iframe 编辑面壳 + 防抖守卫保存 + @mp 引用源。
//
// 形态（dsh-client-modules 装载契约）：window.__ModuleLoader__.load({id, factory(require)})，
// factory 体是普通 CJS；require 只解析冻结平台表（react 等）与 dsh.client.inject 申报过的包。
// 防御纪律（照抄 dsh-dream-skin 的教训）：一个抛错的工厂会把整个 web shell 带崩
// （"entries did not activate" → 白屏），所以每个宿主服务种子都独立 try，任一缺失只丢对应
// 面板功能，绝不向上抛。
window.__ModuleLoader__.load({
  id: "dsh-markpilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react"); } catch (e) { React = null; }

    const TAB_TYPE_ID = "dsh-markpilot/editor";
    const FILE_ADDRESS_PREFIX = "dsh-resource://file/session/";
    const API_BASE = "/dsh-markpilot/api/";
    const SAVE_DEBOUNCE_MS = 1500;   // 与 Typora-Editor-App 主进程同拍（doc.js _autoSaveTimer）
    const POLL_MS = 1500;            // 外部/Agent 变更的可见延迟上界

    /** 当前打开的文档登记表（@mp 候选源用）。key = sessionId + '\n' + absPath */
    const openDocs = new Map();

    /** sessions 服务旁路：apply 里写入取值器（每次 boot 现取，服务晚到也能拿到 cwd；不进 cordis inject） */
    const SessionsBridge = { getSessions: null };

    function currentCwd(sessionId) {
      try {
        const sessions = SessionsBridge.getSessions && SessionsBridge.getSessions();
        const byId = sessions?.list?.getSnapshot?.().byId;
        return byId && byId[sessionId] ? byId[sessionId].cwd : undefined;
      } catch { return undefined; }
    }

    function basenameOf(p) {
      const parts = String(p ?? "").split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(p ?? "");
    }

    /** 解析 dsh-resource://file/session/<sessionId>/<path>；段级 decode，保留前导斜杠。 */
    function parseFileAddress(address) {
      if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
      const rest = address.slice(FILE_ADDRESS_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash <= 0) return undefined;
      let sessionId = rest.slice(0, slash);
      let path = rest.slice(slash + 1);
      try { sessionId = decodeURIComponent(sessionId); } catch { /* 原样 */ }
      path = path.split("/").map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } }).join("/");
      if (!path) return undefined;
      return { sessionId, path };
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
      const enc = String(path ?? "").split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return FILE_ADDRESS_PREFIX + encodeURIComponent(sessionId) + "/" + enc;
    }

    async function api(endpoint, payload, signal) {
      const res = await fetch(API_BASE + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal,
      });
      if (!res.ok) throw new Error(`api ${endpoint}: HTTP ${res.status}`);
      return res.json();
    }

    const h = React ? React.createElement : null;

    function handleHostInvoke(content, post) {
      const id = content && content.id;
      const done = (result) => post("host-result", { id, result });
      const fail = (error) => post("host-result", { id, error: String(error?.message ?? error) });
      try {
        const cmd = content.cmd;
        if (cmd === "clipboard-write-text") {
          navigator.clipboard.writeText(String(content.args?.text ?? "")).then(done, fail);
        } else if (cmd === "clipboard-read-text") {
          navigator.clipboard.readText().then(done, fail);
        } else if (cmd === "open-external") {
          window.open(String(content.args?.url ?? ""), "_blank", "noopener");
          done(true);
        } else {
          done(null);
        }
      } catch (error) { fail(error); }
    }

    // 主题自适应横幅：随宿主 currentColor 调色（亮/暗主题自动跟随，dream-skin 的 token 基调），
    // 不再硬编码灰阶（视觉轮指出浅色横幅在深色编辑面上反差生硬）。
    const bannerStyle = (warn) => ({
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      padding: "4px 10px", fontSize: 12,
      background: warn ? "color-mix(in srgb, currentColor 10%, transparent)" : "color-mix(in srgb, currentColor 5%, transparent)",
      borderBottom: `1px solid color-mix(in srgb, currentColor ${warn ? 25 : 14}%, transparent)`,
    });
    const btnStyle = {
      fontSize: 12, padding: "1px 8px", border: "1px solid rgba(127,127,127,0.4)",
      borderRadius: 4, background: "transparent", cursor: "pointer",
    };

    /* ───────────────────────── 编辑面 tab body ───────────────────────── */

    function EditorTabBody(props) {
      const useTabInfo = props && props.useTabInfo;
      if (!React || !h) return null;
      if (typeof useTabInfo !== "function") return h("div", { style: { padding: 12, fontSize: 12, opacity: 0.7 } }, "MarkPilot: useTabInfo unavailable");
      const { tab } = useTabInfo();

      const frameRef = React.useRef(null);
      const st = React.useRef({
        opened: false, pendingLoad: false, text: "", lastVersion: null, dirty: false, conflict: false,
        saving: false, saveQueued: false, saveTimer: null, pollTimer: null, dead: false,
        absPath: null, sessionId: null,
      }).current;
      const [ui, setUi] = React.useState({ state: "loading", detail: "" });
      // v3 双引擎：vditor（v0.1 整装）⇄ cm6（v3 竖切原型）。桥契约同形，壳无感。
      const [engine, setEngine] = React.useState(() => {
        try { return window.localStorage.getItem("mp-engine") === "vditor" ? "vditor" : "cm6"; } catch { return "cm6"; }
      });
      const switchEngine = (next) => {
        if (next === engine) return;
        try { window.localStorage.setItem("mp-engine", next); } catch { /* 无存储 */ }
        st.opened = false; st.text = ""; st.dirty = false; st.conflict = false;
        st.bridgeUp = false; st.editorReady = false; st.lastVersion = null;
        setUi({ state: "loading", detail: "" });
        setEngine(next);
      };

      const address = tab && tab.contentId;
      const parsed = React.useMemo(() => parseFileAddress(address), [address]);
      const depKey = parsed ? parsed.sessionId + "|" + parsed.path : null;

      React.useEffect(() => {
        if (!parsed) return undefined;
        st.sessionId = parsed.sessionId;
        // cwd 每次 boot 现取（sessions 服务可能晚于挂载才注册——一次性快照会留相对路径，
        // 只靠进程 cwd 碰巧兜底是定时炸弹）。注册表键随之在首次成功 boot 时刷新。
        const refreshPath = () => {
          st.absPath = absolutePath(parsed.path, currentCwd(parsed.sessionId));
          const key = st.sessionId + "\n" + st.absPath;
          openDocs.set(key, { sessionId: st.sessionId, path: st.absPath, basename: basenameOf(st.absPath) });
          return key;
        };
        refreshPath();

        const post = (type, content) => {
          const win = frameRef.current && frameRef.current.contentWindow;
          if (win) { try { win.postMessage({ __dshmp: true, dir: "down", type, content }, "*"); } catch { /* 未挂载 */ } }
        };

        const loadFromDisk = async () => {
          if (st.dead) return;
          refreshPath(); // 每次落盘读前刷新绝对路径（cwd 可能此刻才可用）
          try {
            const result = await api("open", { sessionId: st.sessionId, path: st.absPath });
            if (st.dead) return;
            if (result.ok !== true) { setUi({ state: "error", detail: result.error?.message ?? "read failed" }); return; }
            st.text = result.value.text;
            st.lastVersion = result.value.version;
            st.dirty = false;
            st.conflict = false;
            if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
            if (st.opened) {
              // 干净缓冲下的外部/Agent 变更：整篇重载（iframe 侧 setValue 自带光标/滚动还原）。
              post("setValue", st.text);
            } else {
              st.opened = true;
              post("open", {
                title: basenameOf(st.absPath),
                content: st.text,
                language: "zh-cn",
                rootPath: ".",
              });
            }
            setUi({ state: "ready", detail: "" });
          } catch (error) {
            if (!st.dead) setUi({ state: "error", detail: String(error?.message ?? error) });
          }
        };

        const doSave = async (force) => {
          if (st.dead || !st.opened) return;
          if (st.saving) { st.saveQueued = true; return; }
          st.saving = true;
          try {
            // 轻量脏标协议：引擎每键只报 {len}；保存到点拉全文（一次往返/防抖周期）。
            const text = await new Promise((resolve) => {
              if (typeof st.text !== "string" || st.textNeedsPull) {
                st.pullResolve = resolve;
                st.textNeedsPull = false;
                post("requestText", {});
                st.pullTimer = setTimeout(() => { if (st.pullResolve === resolve) { st.pullResolve = null; resolve(st.text ?? ""); } }, 2000);
              } else {
                resolve(st.text);
              }
            });
            if (st.pullTimer) { clearTimeout(st.pullTimer); st.pullTimer = null; }
            st.text = text;
            const result = await api("save", {
              path: st.absPath,
              text: st.text,
              ...(force !== true && st.lastVersion ? { baseVersion: st.lastVersion } : {}),
            });
            if (st.dead) return;
            if (result.ok === true) {
              st.lastVersion = result.value.version;
              // 保存飞行期间若有外部变更（SSE 事件被 dirty/saving 窗口吞掉），落盘后补一次对账。
              if (st.saveTimer === null) {
                st.dirty = false;
                st.conflict = false;
                api("stat", { path: st.absPath }).then((stat) => {
                  if (st.dead || st.dirty || st.conflict || st.saving) return;
                  if (stat.ok === true && stat.value && stat.value.version !== st.lastVersion) loadFromDisk();
                }).catch(() => { /* 对账失败静默，兜底轮询仍在 */ });
              }
              setUi({ state: "ready", detail: st.dirty ? "编辑中…" : "已保存" });
            } else if (result.error && result.error.code === "FS_STALE_VERSION") {
              st.conflict = true;
              const d = st.pendingDelta;
              const hint = d
                ? `AI 刚改了这里——旧：「${d.oldString.slice(0, 60)}${d.oldString.length > 60 ? "…" : ""}」→ 新：「${d.newString.slice(0, 60)}${d.newString.length > 60 ? "…" : ""}」`
                : "文件已在别处被修改（人或 Agent）";
              setUi({ state: "conflict", detail: `${hint}；版本守卫拒绝覆盖` });
            } else {
              setUi({ state: "error", detail: result.error?.message ?? "save failed" });
            }
          } catch (error) {
            if (!st.dead) setUi({ state: "error", detail: String(error?.message ?? error) });
          } finally {
            st.saving = false;
            if (st.saveQueued && !st.dead) { st.saveQueued = false; doSave(false); }
          }
        };

        // 横幅按钮的回调桥（重试/覆盖保存/重载磁盘版本）。
        st.reload = loadFromDisk;
        st.forceSave = doSave;

        const st2 = st; // 别名：boot 握手状态
        st2.bridgeUp = false;
        st2.editorReady = false;
        st2.booting = false;

        const maybeBoot = () => {
          // 握手时序（与桌面主进程同构）：index.js 注册完 open 监听后才 emit("init")；
          // 必须等 init 到了才能投 open，否则 open 消息早于监听注册而被丢弃（实测坑）。
          if (!st2.bridgeUp || !st2.editorReady || st2.opened || st2.booting || st2.dead) return;
          st2.booting = true;
          loadFromDisk().finally(() => { st2.booting = false; });
        };

        const onMessage = (event) => {
          const data = event.data;
          if (!data || data.__dshmp !== true || data.dir !== "up") return;
          // 来源过滤（架构级）：只认当前引擎 iframe——旧 iframe 卸载后窗口仍存活，
          // 其残留发射（scroll/晚到的 init）不得污染本引擎的握手与状态。
          const liveWin = frameRef.current && frameRef.current.contentWindow;
          if (liveWin && event.source !== liveWin) return;
          try { window.__DSH_MARKPILOT__.diag = window.__DSH_MARKPILOT__.diag || { up: 0 }; window.__DSH_MARKPILOT__.diag.up += 1; } catch { /* 诊断位 */ }
          const type = data.type;
          if (type === "bridge-ready") {
            st2.bridgeUp = true;
            try { window.__DSH_MARKPILOT__.diag = window.__DSH_MARKPILOT__.diag || {}; window.__DSH_MARKPILOT__.diag.bridgeUp = true; } catch { /* 诊断位 */ }
            maybeBoot();
            return;
          }
          if (type === "init") {
            st2.editorReady = true;
            // 看门狗应答：引擎重发 init（{again:true}）说明它还没收到 open——幂等重发。
            // 引擎侧 boot() 对重复 open 天然幂等；这把「注册前窗口丢 open」类竞态彻底闭环。
            if (data.content && data.content.again === true && st2.opened && st2.text) {
              post("open", { title: basenameOf(st2.absPath), content: st2.text, language: "zh-cn", rootPath: "." });
              return;
            }
            maybeBoot();
            return;
          }
          if (type === "change") {
            // 轻量脏标：{len}（旧协议 string 仍兼容——vditor 引擎发全文）。
            st.text = typeof data.content === "string" ? data.content : st.text;
            st.textNeedsPull = typeof data.content !== "string";
            st.dirty = true;
            setUi({ state: "ready", detail: "编辑中…" });
            if (st.saveTimer) clearTimeout(st.saveTimer);
            st.saveTimer = setTimeout(() => { st.saveTimer = null; doSave(false); }, SAVE_DEBOUNCE_MS);
            // 静默预取已撤：人类打字每 400ms+ 停顿都会触发 250KB 克隆风暴（实测更卡的根因）。
            // 全文拉取只发生在保存到点（防抖周期一次）与关 tab 微等待（见卸载清理）。
            return;
          }
          if (type === "text") {
            // requestText 的应答：挂起的保存/关tab冲洗拿全文继续；顺手刷新缓存。
            st.text = typeof data.content === "string" ? data.content : st.text;
            st.textNeedsPull = false;
            if (st.pullResolve) { const r = st.pullResolve; st.pullResolve = null; r(st.text); }
            if (st.flushResolve) { const f = st.flushResolve; st.flushResolve = null; f(st.text); }
            return;
          }
          if (type === "host-invoke") { handleHostInvoke(data.content, post); return; }
          if (type === "openLink" && data.content) {
            try { window.open(String(data.content), "_blank", "noopener"); } catch { /* 拦截器拒绝 */ }
          }
          // scroll / office-export / media-command / img 等：MVP 静默。
        };
        window.addEventListener("message", onMessage);

        // ── 宪法 v3 第一刀：SSE 事件推替代 1.5s 轮询；断流自动降级回轮询 ──
        let es = null;
        let esHealthy = false;
        const startWatch = () => {
          try {
            es = new EventSource(API_BASE + 'watch?path=' + encodeURIComponent(st.absPath));
            es.addEventListener('change', (ev) => {
              esHealthy = true;
              let data = {};
              try { data = JSON.parse(ev.data) || {}; } catch { /* 保底空对象 */ }
              const version = data.version ?? '';
              if (data.delta) st.pendingDelta = data.delta; // 协议 v0 可见性：AI 改了什么，冲突时给人看
              if (st.dead || st.dirty || st.conflict || st.saving) return;
              if (st.lastVersion && version && version === st.lastVersion) return; // 自己的保存回声
              if (tab && tab.visible === false) return;
              loadFromDisk(); // 干净缓冲 → 整篇重载（iframe setValue 自带光标/滚动还原）
            });
            es.onerror = () => { esHealthy = false; /* EventSource 自动重连；轮询兜底仍在线 */ };
          } catch (error) { /* 无 EventSource（极老环境）→ 轮询兜底 */ }
        };
        startWatch();

        st.pollTimer = setInterval(() => {
          // 兜底轮询：SSE 健康时降频到 6s 一查（防连接假死），断流时保持 1.5s。
          if (esHealthy && (st.pollTick = (st.pollTick ?? 0) + 1) % 4 !== 0) return;
          if (st.dead || !st.opened || st.dirty || st.conflict || st.saving || !st.lastVersion) return;
          if (tab && tab.visible === false) return;
          api("stat", { path: st.absPath }).then((result) => {
            if (st.dead || st.dirty || st.conflict || st.saving) return;
            if (result.ok === true && result.value && result.value.version !== st.lastVersion) {
              loadFromDisk();
            }
          }).catch(() => { /* 轮询失败静默 */ });
        }, POLL_MS);

        return () => {
          st.dead = true;
          window.removeEventListener("message", onMessage);
          if (es) { try { es.close(); } catch { /* 已断 */ } es = null; }
          if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; }
          if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
          openDocs.delete(st.sessionId + "\n" + st.absPath);
          if (st.dirty && st.opened && st.absPath) {
            // 关 tab 前最后一把。轻量协议下缓存可能落后：先 requestText 微等待（≤80ms，
            // 实测往返 <20ms）拿到全文再 keepalive 发送；拿不到就用现有缓存尽力。
            const flush = (text) => {
              try {
                fetch(API_BASE + "save", {
                  method: "POST", keepalive: true,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ path: st.absPath, text }),
                });
              } catch { /* 已尽力 */ }
            };
            if (st.textNeedsPull) {
              st.flushResolve = (text) => flush(typeof text === "string" ? text : st.text);
              try { post("requestText", {}); } catch { flush(st.text); }
              setTimeout(() => { if (st.flushResolve) { const f = st.flushResolve; st.flushResolve = null; f(st.text); } }, 80);
            } else {
              flush(st.text);
            }
          }
        };
      }, [depKey]);

      if (!parsed) {
        return h("div", { style: { padding: 12, fontSize: 12, opacity: 0.7 } },
          `MarkPilot: 无法解析地址 ${String(address ?? "")}`);
      }

      let banner = null;
      const engineChip = h("button", {
        style: {
          marginLeft: "auto", fontSize: 11, padding: "1px 8px", border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
          borderRadius: 999, background: "transparent", cursor: "pointer", opacity: 0.85,
        },
        title: "切换编辑引擎（vditor 整装版 ⇄ CM6 v3 原型）",
        onClick: () => switchEngine(engine === "vditor" ? "cm6" : "vditor"),
      }, engine === "vditor" ? "引擎 vditor ⇄" : "引擎 cm6 ⇄");
      if (ui.state === "conflict") {
        banner = h("div", { style: bannerStyle(true) },
          h("span", null, "⚠ ", ui.detail),
          h("button", { style: btnStyle, onClick: () => { st.conflict = false; doSaveWrap(st, true); } }, "覆盖保存"),
          h("button", { style: btnStyle, onClick: () => { st.conflict = false; st.dirty = false; st.reload && st.reload(); } }, "重载磁盘版本"),
          engineChip);
      } else if (ui.state === "error") {
        banner = h("div", { style: bannerStyle(true) },
          `✗ ${ui.detail}`,
          h("button", { style: btnStyle, onClick: () => { setUi({ state: "loading", detail: "" }); st.reload && st.reload(); } }, "重试"),
          engineChip);
      } else if (ui.state === "loading") {
        banner = h("div", { style: bannerStyle(false) }, "正在加载文档…", engineChip);
      } else {
        banner = h("div", { style: { ...bannerStyle(false), minHeight: 22 } }, ui.detail || "", engineChip);
      }

      const tabId = (tab && (tab.id || tab.occurrenceId)) || "tab";
      const frameSrc = engine === "cm6" ? "/dsh-markpilot/renderer-cm6/index.html" : "/dsh-markpilot/renderer/index.html";
      return h("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column" } },
        banner,
        h("iframe", {
          key: engine,
          ref: frameRef,
          name: `dsh-markpilot-${String(tabId)}`,
          src: frameSrc,
          // 同源整装：内容是自带的可信 renderer（非第三方文档），需要 localStorage（主题/编辑模式偏好）。
          sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
          style: { width: "100%", height: "100%", border: 0, flex: 1, background: "transparent" },
        }));
    }

    /** effect 闭包外的按钮回调桥（st.reload / st.forceSave 由 effect 写入）。 */
    function doSaveWrap(st, force) { if (typeof st.forceSave === "function") st.forceSave(force); }

    /* ───────────────────────── 插件入口 ───────────────────────── */

    const inject = ["slots", "layout"];

    function apply(ctx) {
      const log = (() => { try { return typeof ctx.logger === "function" ? ctx.logger("dsh-markpilot") : console; } catch { return console; } })();
      const get = (name) => { try { return ctx.get(name); } catch { return undefined; } };

      // 资产预取（轴1 工程项）：两引擎壳提前入 HTTP 缓存——首次开 tab / 切换引擎免冷取。
      try {
        for (const href of ["/dsh-markpilot/renderer/index.html", "/dsh-markpilot/renderer-cm6/index.html"]) {
          const link = document.createElement("link");
          link.rel = "prefetch";
          link.href = href;
          document.head.appendChild(link);
        }
      } catch { /* 预取失败无害 */ }

      // ① tab 类型：吃下 .md / .markdown（extension 带默认最高，压过内置文本预览）。
      try {
        const tabs = get("sidebarRightTabs");
        if (tabs && typeof tabs.register === "function") {
          ctx.effect(() => tabs.register({
            id: TAB_TYPE_ID,
            kind: "markpilot-editor",
            patterns: ["*.md", "*.markdown"],
            priority: "extension",
            canOpen: (address) => typeof address === "string" && address.startsWith(FILE_ADDRESS_PREFIX),
            title: (address) => {
              const p = parseFileAddress(address);
              return p ? basenameOf(p.path) : "MarkPilot";
            },
            keepMounted: true,
          }), "dsh-markpilot: tab type");
          log.info?.("dsh-markpilot: tab type registered");
        } else {
          log.warn?.("dsh-markpilot: sidebarRightTabs unavailable, tab type not registered");
        }
      } catch (error) { log.warn?.("dsh-markpilot: tab type failed: %s", String(error)); }

      // ② body：薄壳 iframe（renderer 原样整装）。
      try {
        ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: TAB_TYPE_ID,
        }, EditorTabBody)), "dsh-markpilot: tab body");
      } catch (error) { log.warn?.("dsh-markpilot: tab body failed: %s", String(error)); }


      // 【一次性自愈·可删】中间面板方案已撤回（外壳未给 main 面板渲染槽位的能力，
      // 见 deepseek-harness discussions/9077）。但外壳会把"上次选中的面板"持久化下来，
      // 而那个面板已经不存在 ⇒ 每次加载都会把中间列渲染成空白。两件事一起做：
      //   ① 把持久化里的 markpilot-main 抹掉（只动我们自己那个 id）；
      //   ② 把主面板选回 `null` —— **必须是 null**：外壳的右栏可见性判定就是
      //      `visible = (activePanelId === null)`；传 "conversation" 会让它以为"选中了某个全局面板"，
      //      于是整列会话面隐藏、头部那个"打开右栏"按钮直接不再渲染（实测踩到）。
      //      布局渲染那边是 `entryKey: activePanelId ?? "conversation"` ⇒ null 正好回落到对话。
      try {
        const dead = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          let v = '';
          try { v = String(localStorage.getItem(k) || ''); } catch { /* 忽略 */ }
          if (k.includes("markpilot-main") || v.includes("markpilot-main")) dead.push(k);
        }
        for (const k of dead) { try { localStorage.removeItem(k); } catch { /* 忽略 */ } }
        if (dead.length) log.info?.("dsh-markpilot: cleared stale panel state (%d keys)", dead.length);
      } catch { /* 忽略 */ }
      try {
        const layout = get("layout");
        if (layout && typeof layout.selectPanel === "function") {
          for (const delay of [500, 1500, 3000, 6000]) {
            setTimeout(() => {
              try { layout.selectPanel(null); } catch { /* 忽略 */ }
            }, delay);
          }
        }
      } catch { /* 忽略 */ }

      // ③ @mp 引用源：composer 里输入 @mp 列出 MarkPilot 打开的文档。
      // cordis 纪律：服务可能晚于本插件 apply 才注册（实测 inputTriggers 就是），
      // 用 ctx.inject(['inputTriggers'], …) 等服务就绪再注册；服务永不到场就静默降级。
      try {
        SessionsBridge.getSessions = () => get("sessions");
        ctx.inject(["inputTriggers"], (sctx) => {
          try {
            const triggers = sctx.get("inputTriggers");
            if (!triggers || typeof triggers.registerSource !== "function") {
              log.warn?.("dsh-markpilot: inputTriggers unavailable, @mp source not registered");
              return;
            }
            const sidebarRight = (() => { try { return sctx.get("sidebarRight"); } catch { return undefined; } })();
          const source = {
            trigger: "@",
            name: "mp",
            async candidates(_session, { query } = {}) {
              const q = String(query ?? "").toLowerCase();
              const rows = [];
              for (const item of openDocs.values()) {
                const label = item.basename;
                if (q && !label.toLowerCase().includes(q) && !item.path.toLowerCase().includes(q)) continue;
                rows.push({
                  label,
                  name: "mp",
                  description: "MarkPilot 打开的文档",
                  value: JSON.stringify({ kind: "mp", path: item.path, sessionId: item.sessionId }),
                });
              }
              return rows;
            },
            onPick({ candidate }) {
              let value = null;
              try { value = JSON.parse(candidate.value); } catch { value = null; }
              if (!value || value.kind !== "mp") return undefined;
              return {
                insert: {
                  source: "mp",
                  ref: `@mp "${value.path}"`,
                  label: basenameOf(value.path),
                  appearance: "file",
                  clipboardText: value.path,
                },
              };
            },
            openReference(session, refData) {
              try {
                if (!sidebarRight) return false;
                const ref = String(refData?.ref ?? "");
                const path = ref.replace(/^@mp\s*"?/, "").replace(/"$/, "");
                if (!path) return false;
                sidebarRight.openResource(encodeFileAddress(session.sessionId, path));
                return true;
              } catch { return false; }
            },
          };
          sctx.effect(() => triggers.registerSource(source), "dsh-markpilot: @mp source");
          try { window.__DSH_MARKPILOT__.mpSourceRegistered = true; } catch { /* 调试位 */ }
          log.info?.("dsh-markpilot: @mp source registered");
          } catch (innerError) {
            log.warn?.("dsh-markpilot: @mp source inner failed: %s", String(innerError));
          }
        });
      } catch (error) { log.warn?.("dsh-markpilot: @mp source failed: %s", String(error)); }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-markpilot";
    // 调试面（只读镜像，方便宿主/桌面工具观察；不影响渲染）。
    try { window.__DSH_MARKPILOT__ = { openDocs }; } catch { /* 沙箱环境 */ }

    return module.exports;
  },
});
