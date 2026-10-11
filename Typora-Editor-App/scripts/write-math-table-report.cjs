const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const matrixRoot=path.join(project,'.perf/math-table-accepted-v2');
const matrix=read(path.join(matrixRoot,'results.json'));
assert.equal(matrix.failed,0);assert.equal(matrix.cases.length,68);
for(const name of ['fatal.txt','renderer-errors.log'])assert.ok(!fs.existsSync(path.join(matrixRoot,name))||fs.statSync(path.join(matrixRoot,name)).size===0,'Final matrix contains '+name);
const vsixRoot=path.resolve(process.argv[3]),vsix=read(path.join(vsixRoot,'results.json'));
assert.equal(vsix.version,'0.1.26-local');assert.ok(vsix.results.every(s=>s.startsWith('PASS ')));
assert.deepEqual(read(path.join(vsixRoot,'unhandled-errors.json')),[]);
const manualRoot=path.resolve(process.argv[2]),manual=read(path.join(manualRoot,'observer.json')),visual=read(path.join(manualRoot,'manual-verified.json'));
assert.equal(manual.exitCode,0);assert.equal(manual.runtimeErrorCount,0);assert.equal(visual.verified,true);
const coherence=read(path.join(project,'.perf/math-table-delivery/coherence.json'));assert.equal(coherence.verified,true);
assert.equal(visual.sha256,coherence.artifacts.find(a=>a.path.endsWith('app.asar')).sha256,'Manual run did not use the final ASAR');
assert.equal(path.resolve(matrix.application),path.join(project,'dist/release-1.0.16-private-final/win-unpacked/resources/app.asar'));
const href=p=>p.replaceAll('\\','/'),link=(label,p)=>`[${label}](${href(p)})`;
const artifacts=coherence.artifacts.map(a=>`| ${link(path.basename(a.path),a.path)} | ${a.modified.replace('T',' ').replace('Z',' UTC')} | ${a.bytes.toLocaleString('en-US')} | \`${a.sha256}\` |`).join('\n');
const allCases=matrix.cases.map(c=>`| ${c.name} | ${c.status} | ${c.steps} |`).join('\n');
const manualCases=visual.steps.map(s=>`| ${s.name} | ${s.observation} | ${link('截图',path.join(manualRoot,s.screenshot))} |`).join('\n');
const report=`# MarkPilot 私版 1.0.16 / VSIX 0.1.26-local：公式与表格验收

验收日期：2026-09-08。共用渲染源码来自 E:/MarkPilot/Typora-Editor/extension-src/render。本轮只更新私版。

## 修复结果

1. Ctrl+Shift+E 在当前公式内再次按下会移除公式边界、保留源码和本地光标。空公式、部分选中公式、重复内容以及源码视图都分别处理，消除了旧实现继续套美元符号和全局搜索光标的问题。
2. 表内行内公式键入、删除和粘贴通过局部编辑事务更新。未完成的 TeX 保持可编辑，普通 Markdown 的表格分隔处理不会接管公式输入。表内裸竖线保存为数学意义相同的 \\vert{}；粘贴的行内换行转为空格，以防 Markdown 重开时拆列、拆行或丢邻格。删空时立即清理浏览器遗留的 BR 并使用可序列化占位；再次 Backspace/Delete 会完整移除空公式，再键入和重开不会拆出新行。
3. 焦点或选区移动到同表其他单元格时，旧公式源码立即收起。无需离开整张表；撤销重做后仍保留可编辑源码与预览。
4. 单元格中的 \`<br />\` 保持换行，不再暴露 HTML 源码编辑组件。
5. 手工验收额外发现末行公式预览被表格裁切。现在表内编辑预览占用真实单元格高度，完整展示在源码下方；正文仍使用原有浮动预览。

跨单元格和跨段落选择保留原结构并作为一次操作撤销。字面行内代码、围栏代码保持代码边界。块级公式沿用既有输入路径，其历史、矩阵和引用/列表中的数学回归均已检查。

## 使用的真实文档

以用户指定概率论文件的固定副本作为基准，含四张表：6 列表、11 列多行表、含三个换行的两列表头，以及文末对照表。测试覆盖重复的 a、空单元格、空 \`$$\`、多行 \`<br />\` 和原有数学内容。

原文件 D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md 保持不变，SHA256：\`${coherence.noteSHA256}\`。原文已有不配对的美元符号，本轮没有自动改写用户内容；所有键入、保存和重开使用独立副本。

## 最终产物上的验证

| 环境 | 本轮结果 | 证据 |
| --- | --- | --- |
| 最终 EXE 内 app.asar，真实桌面主进程/preload/编辑器/保存链路 | **${matrix.cases.length}/${matrix.cases.length} 场景通过，${matrix.events} 次逐步检查** | ${link('逐项结果',path.join(matrixRoot,'results.json'))} |
| 最终 VSIX 解包后，真实隔离 VS Code 及 Webview | **${vsix.results.length}/${vsix.results.length} 检查通过**，包括 IR/WYSIWYG/SV、可信快捷键、TextDocument 保存重开 | ${link('VS Code 结果',path.join(vsixRoot,'results.json'))} |
| 最终便携 EXE，Computer Use 可见鼠标键盘操作 | **${visual.steps.length} 项可见检查通过**，从启动到关闭捕获的 JavaScript 异常为 0 | ${link('操作记录',path.join(manualRoot,'manual-verified.json'))}、${link('异常日志',path.join(manualRoot,'runtime-errors.json'))} |
| 共同源码、App 源码、最终 ASAR、最终 VSIX | **475 个渲染文件逐文件 SHA256 一致**；4 个公版产物和原笔记哈希不变 | ${link('完整哈希清单',path.join(project,'.perf/math-table-delivery/coherence.json'))} |

矩阵包含：空/已有公式、中文和 emoji、上下标、分式、矩阵、裸竖线、不完整 TeX、特殊标点、剪贴板及多行粘贴、表头和末行、Tab/Shift+Tab/上下键/Enter/Backspace、鼠标换格、连续 30 次开关、重复公式定位、部分选择取消、跨格和跨段选择、源码往返、保存重开、撤销重做，以及每种可视模式在同一副本上连续 24 轮交错编辑。

每次操作检查表结构、焦点与异常；保存重开场景比较所有单元格的源码内容，而非只比较行列数。连续编辑还检查所有未编辑单元格不变，并穿插撤销、重做和磁盘保存。原生键盘/鼠标承担输入和导航，复杂自动化选区用 DOM Range 定位；可见人工操作独立补充鼠标定位与实际画面检查。

## 最终便携版的可见操作证据

| 检查 | 实际观察 | 证据 |
| --- | --- | --- |
${manualCases}

## 开发回归和 JavaScript 诊断

修复过程中运行并通过了 13 组既有回归：features、math-history、math-colors、math-boundaries、regression、consistency、repairs、ui、table-context、table-context-host、table-input-host、source-toggle-host、shell；其中包含行内/块级/引用/列表公式历史、原生中文 IME、宏与化学公式、2,844 个公式的教材。数学 Markdown 单元测试 23/23 通过。最后的显示调整另用最终包完整矩阵和可见操作验收。

${link('回归日志索引',path.join(project,'.perf/math-table-regressions/results-math-history-math-colors-math-boundaries-regression-consistency-repairs-ui-table-context-table-context-host-table-input-host-source-toggle-host-shell.json'))}；${link('IME/宿主补充回归',path.join(project,'.perf/math-table-regressions/results-features-math-history-consistency-table-input-host.json'))}；${link('删空修复后的最终快捷键和历史回归',path.join(project,'.perf/math-table-regressions/results-features-math-history.json'))}。

旧版本基线在同一笔记副本上有 12 个场景、9 个失败，并捕获过 WYSIWYG 空公式序列化导致的 Lute 异常。本轮为空公式建立可序列化占位，首次真实输入及粘贴再建立公式节点。

测试启动器的 EPIPE 管道问题已改为持久日志与正确进程等待。本地前后对照还发现：在 Electron 空白页面尚未提交时开启 Runtime 调试会触发预加载 bootstrap 的 startupData 空值错误；加载完成后接入的对照测试通过。因此调试观察等待真实文档初始化，原生启动日志从进程创建开始独立保留。

VS Code 测试中的模拟补全服务曾在收到取消后的空请求时发生 JSON.parse 异常。已修复模拟服务的空请求和断连处理，并让未处理 Promise 异常直接阻断验收；最终 116 项检查的 ${link('未处理异常记录',path.join(vsixRoot,'unhandled-errors.json'))} 为空。

外部图片请求失败单独保留在 resource-errors.json，不计为 JavaScript 异常。测试不屏蔽编辑器的 error、unhandledrejection 或 preload 错误；这些错误会使验收失败。

## 私版文件

时间戳下表用 UTC，北京时间加 8 小时。

| 文件 | 生成时间 | 字节 | SHA256 |
| --- | --- | ---: | --- |
${artifacts}

本报告记录上述具体版本、笔记副本和交互范围的结果，不声称穷尽任意 Markdown、任意输入法或所有未来操作序列。

## 68 个最终场景

| 场景 | 结果 | 逐步检查 |
| --- | --- | ---: |
${allCases}
`;
const file=path.join(project,'docs/CHANGE-REPORT-PRIVATE-MATH-TABLE-1.0.16.md');fs.writeFileSync(file,report);
fs.writeFileSync(path.join(project,'.perf/math-table-delivery/accepted.json'),JSON.stringify({checkedAt:new Date().toISOString(),matrix:matrixRoot,vsix:vsixRoot,manual:manualRoot,report:file,artifacts:coherence.artifacts,verified:true},null,2));
console.log(file);
