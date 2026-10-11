# marcopilot 公开版 1.0.15 / VSIX 0.1.25-local

公开版与自用版平行交付，作者/发布者为 `Jinxi`。自用版继续保留原有“用户自行配置 API”的补全能力；公开版使用独立标识，不读取、不保存、不发送个人远程补全 API 信息。

## 发布边界

- 公开 App ID：`app.personal.marcopilot.public`
- 公开桌面产品名：`marcopilot Public`
- 公开 VSIX：`Jinxi.marcopilot`
- 公开版补全：仅本地规则/模板/路径补全与宿主候选补全
- 已从公开包移除：`completion-vault.js`、`profiles.cjs`、`structure.cjs`、私有补全 `core/host`、API Key/模型命令
- 公开包的安全承诺针对本项目部署的个人 AI 补全 API；宿主 VS Code/Trae 自身的网络、登录、遥测和远程图片能力不由扩展控制

公开运行时补全文件仅包含 `core.cjs`、`host.cjs` 和 `build-flavor.cjs`；渲染层也单独替换为本地/宿主实现。实包审计确认公开补全链路没有个人端点、`fetch()`、SecretStorage、API Key 标识或 `requestAI`。

## 产物

| 文件 | 大小 | SHA256 |
| --- | ---: | --- |
| `D:\BuyKey\Typora-Editor-App\dist\public-release-1.0.15\marcopilot-public-Setup-1.0.15.exe` | 116,110,364 B | `31062b6e3869de145796ba04d4c93dd2004b8f68a8f67bb97e39363982582cff` |
| `D:\BuyKey\Typora-Editor-App\dist\public-release-1.0.15\marcopilot-public-v1.0.15-portable.exe` | 115,882,824 B | `028390b8ba02adeee7e108f0eba9dfe5019162620a8166603dddfb40037eee5f` |
| `D:\BuyKey\Typora-Editor-App\dist\public-release-1.0.15\win-unpacked\resources\app.asar` | 23,073,390 B | `13eaa14f278b2ade214871dd44ee94a3c7970527dbbaefaf80dd09f42c8e5efa` |
| `D:\BuyKey\Typora-Editor\dist\Jinxi.marcopilot-0.1.25-local.vsix` | 6,179,996 B | `103890bd54629cc7a8fcef119dc1ebce4ffed389e7e0b55ffd49c1720b623d00` |

## 验收证据

- API-free app.asar 静态审计：11/11，`D:\BuyKey\Typora-Editor-App\.perf\public-release-audit-1788795526761\results.json`
- 公开 App 真机启动、Unicode 文件、单实例、Jump List、编辑保存：6/6，`D:\BuyKey\Typora-Editor-App\.perf\exe-launch-1788795004189\results.json`
- 公开 VSIX 真 VS Code 1.134.0 宿主/Webview：51/51，`D:\BuyKey\Typora-Editor\test\.runs\vscode-1788795018757\results.json`
- 公开 VSIX 实包静态审计：10/10，`D:\BuyKey\Typora-Editor\test\.runs\public-vsix-audit-20260907234800\results.json`
- Trae：本轮公开包复跑停在隔离 profile 首启登录/初始化页，未输入或提交账号凭据；自用版既有 Trae 1.107.1 105/105 不作为公开包证据

## 发布状态

本轮已生成并验收 Jinxi 公开产物，但尚未向第三方市场上传：本机未登录 Azure DevOps/VS Code Marketplace 或 Open VSX，也没有可用发布 token。用户提供的 GitHub Copilot 链接是 GitHub 登录/订阅入口，不是 VS Code Marketplace 发布入口。

完成对应账号认证后，只使用公开 VSIX 执行发布：

```powershell
# VS Code Marketplace：VSCE_PAT 只放在当前进程环境，不写入仓库
$env:VSCE_PAT = '<你的 Azure DevOps Marketplace 发布令牌>'
npx --yes @vscode/vsce publish --packagePath 'D:\BuyKey\Typora-Editor\dist\Jinxi.marcopilot-0.1.25-local.vsix' -p $env:VSCE_PAT

# Open VSX：先在 Open VSX/Eclipse 账户中创建或认领 Jinxi namespace
$env:OVSX_TOKEN = '<你的 Open VSX 发布令牌>'
npx --yes ovsx publish 'D:\BuyKey\Typora-Editor\dist\Jinxi.marcopilot-0.1.25-local.vsix' -p $env:OVSX_TOKEN
```

Trae 采用 VSIX 本地安装/导入公开包；它不是本次 VS Code Marketplace/Open VSX 的上传目标，且本轮公开包复跑仍受 Trae 首次登录门控阻塞。

## 重建命令

```powershell
# App 仓库
npm run sync
npm run dist:public
node scripts/audit-public-release.cjs

# VSIX 仓库
python pack.py --public
python test/audit-public-vsix.py
```

上述命令的公开输出不会覆盖自用版 `dist/release-1.0.15-final` 或 `dist/marcopilot-0.1.25-local.vsix`。
