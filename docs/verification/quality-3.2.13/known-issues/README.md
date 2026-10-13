# 已知未修：重新加载后编辑焦点丢失

此目录归档已执行的失败探针，未增加新的修复批次。源产物 3.2.13 的同一完整 ASAR 已确认真实“更多 → 重新加载”到达后焦点落到 BODY，立即输入未进入文档；该失败不计入 345 个通过用例，后续历史链未执行。正式打包仅改变 PE 品牌资源，归档报告明确区分两种 EXE 身份。

归档代码与实际执行的隔离副本仅有两条相对导入路径调整，解析到同一测试辅助模块；记录保留两份代码 SHA。此归档入口未另行执行。可针对指定版本复跑：

```powershell
$verifyExe = "C:\path\to\MarkPilot.exe"
$verifySha = (Get-FileHash -LiteralPath $verifyExe -Algorithm SHA256).Hash.ToLowerInvariant()
node docs/verification/quality-3.2.13/known-issues/cell-reload-workflows.cjs --exe "$verifyExe" --expected-sha256 "$verifySha" --out ".mp-verify/reload-known-red-recheck"
```

输出目录须为空。程序内部持锁，使用合成文件和隔离配置，不触碰原剪贴板；当前行为失败时返回非零。真实 Chromium 输入与菜单点击不代表物理操作系统菜单或输入法候选覆盖。
