const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const output=path.join(project,'.perf/split-navigation-delivery');
const matrixRoot=path.join(project,'.perf/split-navigation-accepted-v3'),matrix=read(path.join(matrixRoot,'results.json'));
const mathRoot=path.join(project,'.perf/split-navigation-math-regression-v2'),math=read(path.join(mathRoot,'results.json'));
const vsixRoot=path.resolve(process.argv[3]),vsix=read(path.join(vsixRoot,'results.json'));
const manualRoot=path.resolve(process.argv[2]),manual=read(path.join(manualRoot,'observer.json')),visual=read(path.join(manualRoot,'manual-verified.json'));
const coherence=read(path.join(output,'coherence.json'));
const regressionRoot=path.join(project,'.perf/split-navigation-regressions'),regressions=read(path.join(regressionRoot,'results.json'));
for(const [root,result,count] of [[matrixRoot,matrix,63],[mathRoot,math,68]]){
  assert.equal(result.failed,0);assert.equal(result.cases.length,count);assert.ok(result.cases.every(c=>c.status==='PASS'));
  assert.equal(path.resolve(result.application),path.join(project,'dist/release-1.0.17-private-final/win-unpacked/resources/app.asar'));
  for(const name of ['fatal.txt','renderer-errors.log'])assert.ok(!fs.existsSync(path.join(root,name))||fs.statSync(path.join(root,name)).size===0,root+' contains '+name);
}
assert.equal(vsix.version,'0.1.27-local');assert.equal(vsix.results.length,130);assert.ok(vsix.results.every(s=>s.startsWith('PASS ')));
assert.deepEqual(read(path.join(vsixRoot,'webview-errors.json')),[]);assert.deepEqual(read(path.join(vsixRoot,'unhandled-errors.json')),[]);
assert.equal(read(path.join(vsixRoot,'split-navigation-verified.json')).verified,true);
assert.equal(regressions.length,3);assert.ok(regressions.every(r=>r.code===0));
assert.equal(manual.exitCode,0);assert.equal(manual.runtimeErrorCount,0);assert.equal(visual.verified,true);assert.ok(visual.steps.length>=4);
assert.deepEqual(read(path.join(manualRoot,'runtime-errors.json')),[]);
assert.equal(coherence.verified,true);assert.equal(coherence.rendererFiles,477);
assert.equal(visual.sha256,coherence.artifacts.find(a=>a.path.endsWith('app.asar')).sha256,'The manual portable EXE is not the final build');
for(const step of visual.steps)assert.ok(fs.existsSync(path.join(manualRoot,step.screenshot)),step.name+' screenshot missing');
const href=p=>p.replaceAll('\\','/'),link=(label,p)=>`[${label}](${href(p)})`;
const artifacts=coherence.artifacts.map(a=>`| ${link(path.basename(a.path),a.path)} | ${new Date(a.modified).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})} | ${a.bytes.toLocaleString('en-US')} | \`${a.sha256}\` |`).join('\n');
const manualCases=visual.steps.map(s=>`| ${s.name} | ${s.observation} | ${link('截图',path.join(manualRoot,s.screenshot))} |`).join('\n');
const report=`# MarkPilot 私版 1.0.17 / VSIX 0.1.27-local：源码双屏双向定位

验收日期：2026-09-08。仅更新私版；共同渲染源码为 E:/MarkPilot/Typora-Editor/extension-src/render。

## 使用行为

- 右侧单击渲染文字、表格单元格或公式符号，左侧真实编辑光标移到对应源码；重复文本按原来的段落、行、单元格分别定位。
- 左侧单击、移动光标或输入，右侧对应文字或公式符号自动滚动到与光标中心相同的水平线。首段、末段、窗口缩窄及公式异步渲染后继续对齐。源码分隔标记、空格等没有可见字形的位置使用相应内容或单元格定位。
- 右侧滚轮和拖选可继续阅读、复制；左侧再次操作后恢复跟随。右侧普通单击链接/图片执行源码定位，带修饰键的单击保留原有处理。
- 输入后预览尚未更新时，点击旧画面仍转换到当前源码位置；导航本身不会改写 Markdown、制造保存脏标记或插入定位标记。

## 最终产物验证

| 环境 | 结果 | 证据 |
| --- | --- | --- |
| 最终 app.asar，真实桌面主进程、preload、iframe | **${matrix.cases.length}/${matrix.cases.length} 双屏场景通过** | ${link('逐项结果',path.join(matrixRoot,'results.json'))} |
| 同一最终 app.asar，上一轮公式和表格矩阵 | **${math.cases.length}/${math.cases.length} 场景、${math.events} 次逐步检查通过** | ${link('公式表格回归',path.join(mathRoot,'results.json'))} |
| 最终 VSIX 解包，真实隔离 VS Code 与 Webview | **${vsix.results.length}/${vsix.results.length} 检查通过**，含双向原生点击及保存不变 | ${link('VS Code 结果',path.join(vsixRoot,'results.json'))} |
| 源位置解析、源码切换与公式历史 | **9 项解析测试及 2 组既有回归通过** | ${link('回归日志索引',path.join(regressionRoot,'results.json'))} |
| 最终 portable EXE，可见鼠标键盘操作 | **${visual.steps.length} 项复核通过**，捕获的 JavaScript 异常 0 | ${link('操作记录',path.join(manualRoot,'manual-verified.json'))} |
| 共同源码、App 源码、最终 ASAR、最终 VSIX | **477 个渲染文件逐文件 SHA256 一致** | ${link('完整哈希清单',path.join(output,'coherence.json'))} |

双屏矩阵覆盖正文、加粗、实体、转义、Unicode、列表、引用、链接、脚注、HTML、代码、分式、上下标和积分符号、重复表格内容与空格、首尾连续定位、同一光标位置重复点击 12 次、原生滚轮/拖选、旧预览点击、输入/撤销/重做/保存、模式往返及窗口缩窄。水平对齐由独立 DOM 字形测量验收，阈值为 4 CSS 像素；原生鼠标点击负责移动真实光标，测试定位 Range 用于查找屏幕上的目标。

公式表格回归包括 Ctrl+Shift+E 开关、逐字符 TeX、未完成公式、中文和 emoji、裸竖线/换行粘贴、空公式删除、同表换格收起预览、重复格、保存重开及连续交错编辑，保留上一轮修复。

## 当前概率论笔记及人工复核

本轮以用户 12:09:34 更新后的概率论笔记副本验收，包含 11 列表格与文末对照表；所有编辑发生在隔离副本。原文件 ${link('1-重识概率论.md','D:/Users/Ming/Desktop/实用经济与金融理论/1-重识概率论.md')} 的 SHA256 为 \`${coherence.noteSHA256}\`，与本轮取样时一致。4 个公版产物哈希不变。

| 操作 | 实际观察 | 证据 |
| --- | --- | --- |
${manualCases}

## JavaScript 问题与实现

可见人工复核还发现了单靠连续自动化点击漏掉的首次焦点问题：窗口恢复焦点时，浏览器可能将光标放在编辑区容器边界；旧逻辑取整个面板中心，造成右侧目标在鼠标点击前移动。现在只有实际源码操作或导航才启动跟随，并把容器边界转换到对应的文字位置。修复前后的同一回归分别出现 80 像素跳动和保持原位，最终矩阵包含新会话中先点击右侧及真实笔记上的首次反向定位。

${link('修复前的失败对照',path.join(project,'.perf/split-navigation-activation-before-v2/results.json'))} 与 ${link('人工复现记录',path.join(project,'.perf/split-navigation-manual-exe-1788844943511/first-click-reproduction.json'))} 保留供复核。

验收额外发现 Vditor 在已预加载 material 图标后，仍尝试同步 XMLHttpRequest；VS Code 的资源加载路径可能拒绝该请求并产生未处理 Promise 异常。现为已加载脚本设置 Vditor 自身识别的 ID，阻止重复同步请求；没有吞掉异常。最终 VSIX 同时验证单次图标加载、启动异常和未处理 Promise。

${link('最终 Webview 异常记录',path.join(vsixRoot,'webview-errors.json'))}、${link('扩展宿主未处理异常',path.join(vsixRoot,'unhandled-errors.json'))}、${link('portable JavaScript 记录',path.join(manualRoot,'runtime-errors.json'))} 均为空。桌面矩阵从窗口创建起监听 console/preload 错误，调试 Runtime 在真实页面提交后接入；便携版另保留整个进程启动日志。外部图片网络请求与编辑器 JavaScript 异常分开记录。

原笔记中的一张 Wikimedia 外链图片在手工会话中连接失败，保留于 ${link('资源请求记录',path.join(manualRoot,'resource-errors.json'))}，未影响本次双屏定位操作。

位置映射复用 Lute AST 与现有 KaTeX 符号位置。双屏模块独立管理滚动、异步刷新与退出清理；首尾对齐空间由 CSS 伪元素提供，不写入文档。相关源码为 ${link('markdown-locations.js','E:/MarkPilot/Typora-Editor/extension-src/render/js/markdown-locations.js')}、${link('split-navigation.js','E:/MarkPilot/Typora-Editor/extension-src/render/js/split-navigation.js')} 和 ${link('index.html','E:/MarkPilot/Typora-Editor/extension-src/render/index.html')}。

## 私版文件

以下生成时间均为北京时间。

| 文件 | 生成时间 | 字节 | SHA256 |
| --- | --- | ---: | --- |
${artifacts}
`;
const reportPath=path.join(project,'docs/CHANGE-REPORT-PRIVATE-SPLIT-NAVIGATION-1.0.17.md');fs.writeFileSync(reportPath,report);
fs.writeFileSync(path.join(output,'accepted.json'),JSON.stringify({verified:true,verifiedAt:new Date().toISOString(),report:reportPath,matrixRoot,mathRoot,vsixRoot,manualRoot,regressionRoot,checks:{split:matrix.cases.length,math:math.cases.length,mathSteps:math.events,vsix:vsix.results.length,manual:visual.steps.length,rendererFiles:coherence.rendererFiles},artifacts:coherence.artifacts},null,2));
console.log('PASS final acceptance: '+reportPath);
