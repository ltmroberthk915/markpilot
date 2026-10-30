# dsh-markdown-typora 0.3.1（更名收据）

内部记录，不进入 README / Release 说明。

## 更名

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-markdown` | `dsh-markdown-typora` |
| 目录 | `dsh-markdown/` | `dsh-markdown-typora/` |
| bundle id / patch name | `dsh-markdown` | `dsh-markdown-typora` |
| 宿主路由前缀 | `/dsh-markdown` | `/dsh-markdown-typora` |
| 右侧栏 tab 类型 | `dsh-markdown/editor` | `dsh-markdown-typora/editor` |
| 恢复槽键前缀 | `dsh-markdown:recovery:` | `dsh-markdown-typora:recovery:` |
| 版本 | 0.3.0 | 0.3.1 |

更名原因：`dsh-markdown` 在 npm 上已被他人占用，插件与市场条目需要一个独立名字，并点明 Typora 式体验。

## 载荷

- 源码目录：`dsh-markdown-typora/`（136 个文件，含 `assets/screenshots/` 8 张）
- 内核：MarkPilot CM6 3.6.6，`core.json` 124 文件，`coreHash d6df048c976e5517a33c99393f6eb548bc1340a3d393b9ded00f06c839a4b7b4`（与更名前一致）
- `node scripts/sync-core.mjs --check` → `CHECK_OK 124 files, 7294308 bytes`
- `node --test test/client.test.mjs test/host.test.mjs` → 26/26 pass（路由、tab、恢复槽按新名断言）
- 打包：`npm pack` → `dsh-markdown-typora-0.3.1.tgz`，2,522,787 B
  - sha256 `3109032c1ced298c3971f5d0655d03dacce78199ef800b15a424eb019444ed2b`
  - 解包复核：package.json `name=dsh-markdown-typora version=0.3.1`；136 文件 7,452,525 B；core.json 同哈希
  - 首轮打包 `dcaaeba6…` 漏改了 `window.__DSH_MARKDOWN__.version`（仍是 0.3.0），已在 `lib/client.js` 修正后重打

## 装后验证（沙箱宿主，非用户宿主）

沙箱：`DSH_HOME=D:\BuyKey\.mp-verify\dsh-shot-home`，宿主为解包的 DSH 0.2.1-rc.3。
沙箱 profile 装入 tgz 后重启，用带 token 的真实 Web 界面驱动：

- 路由：`GET /dsh-markdown-typora/core.json` → 200，`version 3.6.6`，124 文件，`coreHash d6df048c…`；`GET /dsh-markdown/core.json` → **404**（旧路由已移除）
- 壳页：`index.html` 标题 `dsh-markdown-typora · CM6 皮`
- 客户端：`window.__DSH_MARKDOWN__ = { version: "0.3.1", mpSourceRegistered: true }`
- 真实界面：打开 `demo.md` 后 iframe 为 `/dsh-markdown-typora/renderer-cm6/index.html`，文档 543 字符正常渲染（标题/公式/Mermaid/表格），`pageerror` 0
- 截图：`.mp-verify/dsh-plugin-366/probe/rename/rename-ui.png`

## 本机 profile

- 备份：`D:\BuyKey\dsh-backup-20261030-2246`（`profiles/*/package.json`、`pnpm-lock.yaml`、`*.yaml`；`.dsh` 全量 5.9 GB，只备份清单）
- web：`dsh plugin --profile web remove dsh-markdown` + `add link:D:/BuyKey/markpilot-public/dsh-markdown-typora`（pnpm 11.22.0，7.5 s），bundles 同步为 `dsh-markdown-typora`
- desktop：该 profile 由 Electron 独占管理，CLI 拒绝；改为按同一结构更新 `package.json`（依赖键与 bundles）并把 `node_modules/dsh-markdown` junction 换成 `dsh-markdown-typora`。desktop 的 `pnpm-lock.yaml` 本来就没有这个 link 依赖（应用是直接写 package.json + junction 的），无需改锁文件
  - 期间在 desktop 跑过一次 `pnpm install`，5 分钟无任何输出/无 node_modules 变更，已中止；随后手工换 junction，未再跑 pnpm
- 生效条件：宿主重启后客户端 bundle 才会以新包名重建（当前会话宿主未重启）

## 市场条目（未完成）

- 条目名由仓库路径派生：`ltmroberthk915/markpilot#dsh-markdown` → 需要上游条目文件改名为 `ltmroberthk915__markpilot--dsh-markdown-typora.yml` 并更新 `url`/`name`/`tarball`
- 新条目内容已备好：`D:\BuyKey\_publish\entry-dsh-markdown-typora.yml`
- 阻塞：fork `ltmroberthk915/awesome-dsh-plugin` 落后上游 5441 提交，`merge-upstream` 与 push 均被 `workflow` scope 拒绝；在 fork 内用上游 commit 建 ref 返回 404（对象不在 fork 网络内）。需要先在上游仓库页点一次 **Sync fork → Update branch**，之后即可提 PR

## 安装

- web / desktop profile：`dsh plugin --profile <pf> add <tgz 或目录>`
- 装后需重启宿主，客户端 bundle 才会以新包名重建
- 旧包 `dsh-markdown` 不再保留：目录已改名，profile 依赖与 bundles 一并替换

## 兼容性说明

- 旧 tab 地址（`dsh-resource://file/...`）不变，文件地址协议未改
- 旧恢复槽键 `dsh-markdown:recovery:*` 不再读取；未保存草稿如需迁移，可在旧 profile 的存储里按新前缀改名
- 市场条目：条目名由仓库路径派生（`markpilot#dsh-markdown`），更名后需要同步更新，见文末
