# 3.2.0 待办：图片能力对标 2.x + 文件多开

> 状态：**未完成**。本文件是下一轮的施工图（含证据与判据），不是"已完成"记录。

## 一、图片对齐 / 尺寸：全量对标 2.x（真源 `Typora-Editor-App/app/renderer/js/media-tools.js`）

### 2.x 的真实机制（读源码所得，非推测）

| 能力 | 2.x 的落法 | 源码位置 |
|---|---|---|
| 对齐 left/center/right | 文档里写 **HTML `<img>`**，用属性 `data-typora-align="center"`；渲染交给 CSS | `media-tools.js:187 imageHtml()`、`:214-216 setImageAlign()` |
| 缩放（5%～400%） | 写 `width="<px>"`；百分比基准 = **当前屏上尺寸**（`prevScale`/`prevWidth` 换算，考虑 `max-width:100%` 钳制） | `media-tools.js:194-206` |
| 缩放时保留对齐 | `imageHtml(img,{width,scale,align})` 统一重建标签 | `:187-191` |
| 未加载/断链 | `naturalWidth=0` 时明确报错（"图片尚未加载完成"），不瞎算 | `:195`、`:219` |
| 行内图缩放 | 保持行内，不拆段；独占段图两侧补 `\n\n` | 文件头注释 `:99-125` |

生成的标签形状：
```html
<img src="…" alt="…" [title="…"] [data-typora-align="center"] width="480">
```

### CM6 侧要做的三块

1. **渲染**：CM6 现在只解析 `![alt](src)`；需要支持行内 HTML `<img …>`（含 `width` / `data-typora-align`）——
   在 `src-cm6/main.js` 的行内标记扫描里加一个 `<img>` 分支，属性解析后用同一个图片 widget 渲染，
   对齐用 CSS（`[data-typora-align=center]{display:block;margin:0 auto}` 等）。
2. **命令**：`setImageAlign(align)` / `setImageScale(percent)`，写回 HTML 标签形式（与 2.x **逐字符同构**，
   这样同一个文档在两条线之间来回打开都认）。规则直接照抄 2.x：5～400%、基准取当前 width/scale、
   `naturalWidth=0` 时报错不写入。
3. **入口**：图片右键菜单加「对齐 ▸ 左/中/右」「缩放…（百分比输入框）」，与现有
   `复制图片 / 另存为图片… / 抽出到 assets / 删除图片` 并列。

### 判据（写进探针，直读文档源码）

| 用例 | 期望 |
|---|---|
| 右键图 → 居中对齐 | 文档出现 `data-typora-align="center"`；屏幕截图里图片水平居中 |
| 右键图 → 缩放 150% | 出现 `width="…"`，数值 = `round(基准×1.5)`；再次缩放 150% 时基准取上一次的 width |
| 缩放 3% / 500% | 拒绝并提示 5～400%，文档不变 |
| 断链图（src 指向不存在文件）缩放 | 报"尚未加载完成"，**不写文档** |
| 行内图缩放 | 不拆段（前后不新增空行） |
| 回归 | 对齐/缩放后：`Ctrl+Z` 一次回到原样（单一事务） |

## 二、文件多开（未动工）

现状：壳层 `requestSingleInstanceLock()` + `second-instance` 把新文件的打开请求**转发进现有窗口**
⇒ 用户看到的是"打开新文件把当前窗口的文件换掉"。

施工图：
1. `MarkPilot-CM6/main.js`：把全局 `state` 改成**每窗口会话**（`sessions: Map<webContents.id, session>`），
   所有 `handle(...)` 里改成从 `BrowserWindow.fromWebContents(e.sender)` 取会话；
2. `openPath(p)`：调用窗口已有文档且 `p !== 当前路径` 时 **新建 BrowserWindow**（同进程、独立会话）；
3. 菜单/最近文件/脏标记/标题/自动保存全部按会话取；
4. 验收：连开 3 个文件 ⇒ 3 个窗口、各自标题/内容/脏标记独立；在 A 窗口保存不影响 B；关闭一个不影响其余；
   `second-instance` 转发路径也改成"新开窗口"。

## 三、3.2.0 发布收尾清单

- [x] 上面两块落地（图片对齐/大小对标 2.x 已完成；文件多开核心 + 关窗生命周期已完成）
- [x] 全量验收 80/80（在 3.2.0 便携版上跑，含多窗口全部改动）
- [x] `docs/RELEASE-3.2.0.md`（产品口吻、禁用词 0 命中）
- [x] `.perf` 旧快照删除的补提交（需先 `git config core.longpaths true`，否则 Windows 路径过长会拒绝暂存）
- [x] 推送 3.2.0 + 服务器端 sha 回读核验（v3.2.0，两个资产 digest 与本地逐字节一致）

---

## 四、文件多开的分步改造清单（2026-10-10 实测清点，已全部完成）

`MarkPilot-CM6/main.js` 里 `handle(...)` 共 **46** 个，其中 **33** 个在附近引用了全局 `state`。

### 设计区分（关键，做错会串台）

| 类别 | 例子 | 多窗口下 |
|---|---|---|
| **文档级** | `filePath` / `dirty` / `savedText` / `diskMtime` / `outside-change` / 导出目标 | **按会话** |
| **应用级** | 主题、缩放、界面透明度、快捷键、Typora 主题 | **保持全局**（改主题应影响所有窗口） |
| **共享资源** | 剪贴板、`shell:showItem`、`edit:paste` | 全局，但**目标用发起窗口的会话解析** |
| **诊断** | `debug:sessions`、`app:health` | 全局只读 |

### 实际执行顺序（每批改完跑一次零回归再提交）

1. **批 A**（只读）：`doc:current` / `doc:ready`（推送改发发起窗口）/ `doc:info` ✅
2. **批 B0**：`syncPathUi(S = state, W = win)` / `updateTitle(S = state, W = win)` 参数化 ✅
3. **批 B1**（写入）：`doc:path` / `doc:dirty` / `doc:saved` / `doc:outside-change` ✅
4. **批 B2**：`readDoc(p, S)` / `writeDoc(p, t, S)` / `openPath(p, target)` ✅
5. **3a**：`createWindow(session = state)` 参数化（区块内 `win.`→局部 `W.`，末尾 `win = W; return W;`）✅
   ⚠️ 教训：区块起止锚点要取准（当时取到 `app.whenReady`，把区块外的 `second-instance` 也改了 ⇒ `W` 未定义，第二次启动抛错）——见 AGENTS 错-9
6. **3b**：`newSession()` + `openInNewWindow()` + IPC/preload ✅
7. **3c**：关窗按会话；并修两处：关窗后全局 `win` 重指仍存活窗口、按关窗前捕获的 id 注销会话 ✅
8. **3d**：`second-instance` ⇒ 新窗口打开（用户报的"打开文件把当前窗口换掉"就是这条路径）✅
9. **批 C/D（评估后：无需改动）**：`exportWriters` 按 writer id 键控 ⇒ 多窗口并发「导出为文件夹/HTML」互不干扰；
   `export:pdf` 有**全局单飞闸门**（`if (pdfActive) return { ok:false, error:'已有一个 PDF 导出在进行中' }`）⇒
   第二个窗口得到明确错误，不会串用别人的 staging 目录。共享资源（剪贴板 / `showItem` / `edit:paste`）
   的**目标**都已由发起窗口的会话解析（批 B1/B2 已覆盖）。⇒ 这一批不需要额外改动。

### 验收（四条，已全绿）

1. 连开 3 个文件 ⇒ 3 窗口 3 会话（实测 2 窗口版：`[{mine:1,A.md},{mine:2,B.md}]`、`total=2`）✅
2. A 窗口编辑并保存 ⇒ 只有 A 的文件变化，B 的 mtime 不变 ✅
3. 关闭一个窗口 ⇒ 其余窗口仍在（`win:closed {remaining:1}`）✅
4. 关窗后会话注销（`total` 回落为 1）✅

