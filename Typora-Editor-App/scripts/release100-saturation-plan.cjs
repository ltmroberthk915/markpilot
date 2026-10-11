// Planning and local-file validation only. This script never starts a GUI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..');
const groups=[
  {
    area:'文档与路径',variants:'私版 EXE、VS Code、Trae；空白、中文/空格/emoji 路径；全程使用副本。',
    entryPoints:['scripts/file-open.test.cjs','scripts/new-document.test.cjs','scripts/run-file-launch-tests.mjs','../Typora-Editor/test/vscode-smoke.cjs'],
    cases:[
      ['新建、输入正文、保存后重开。','文件与正文一致，标题和脏标记正确，能够继续输入。'],
      ['分别通过最近文件、文件关联和 IDE 重开中文及空格路径的同名文件。','打开正确的完整路径，已有编辑不被另一份同名文档覆盖。'],
      ['在测试副本未保存时尝试切换文件，分别取消、保存和放弃。','各分支符合选择；取消保留编辑；不存在隐式覆盖。'],
      ['从最近文件打开已移动/删除的副本，再打开正常文件。','错误可见且能够恢复；列表和当前文档状态不串线。']
    ]
  },
  {
    area:'保存、恢复和外部刷新',variants:'正文、表格和数学源码；IR/WYS/SV；自动保存开启/关闭。',
    entryPoints:['scripts/autosave.test.cjs','scripts/snapshots.test.cjs','scripts/desktop-protection.cjs','scripts/viewflow-suite.cjs'],
    cases:[
      ['编辑正文和单元格，等待自动保存，再手动保存并重开。','磁盘、宿主及编辑器内容一致，保存后脏标记清除。'],
      ['快速编辑、撤销、重做并切换文件，使保存任务连续排队。','旧任务不能覆盖较新的正文，撤销与重做内容可恢复。'],
      ['在隔离副本模拟不可写、短暂写入失败，再恢复写入。','失败不被显示成成功，编辑内容仍在，可重试并恢复快照。'],
      ['分屏保留旧位置后外部更新测试副本，再点击别处输入中文和公式。','刷新后旧锚点释放，新输入留在实际光标处；冲突分支不静默丢字。']
    ]
  },
  {
    area:'正文格式与编辑历史',variants:'IR/WYS/SV；中文、emoji、组合字符；正向/反向选区。',
    entryPoints:['scripts/shell-features.cjs','scripts/shell-repairs.cjs','scripts/math-history.cjs','../Typora-Editor/test/vscode-smoke.cjs'],
    cases:[
      ['应用加粗、斜体、删除线、下划线及行内代码，保存重开。','格式与正文正确，标记成对，快捷键不串用。'],
      ['在嵌套格式的开头、结尾和相邻格式边界输入、删除、撤销。','格式边界不吞字，撤销恢复整个操作，邻段内容保留。'],
      ['跨段正向/反向选择含 emoji 的文本，再格式化并往返切换编辑模式。','选区映射正确，不产生半个字符或重复正文。'],
      ['中文输入法组词过程中触发格式键和模式切换，再提交/取消组词。','没有重复提交或丢字；组合输入期间不误执行编辑快捷键。']
    ]
  },
  {
    area:'标题、列表、引用和导航',variants:'重复标题、多级列表、任务列表、引用套列表；与表格/公式相邻。',
    entryPoints:['scripts/shell-features.cjs','scripts/reading-experience.cjs','scripts/viewflow-suite.cjs','scripts/markdown-locations.test.cjs'],
    cases:[
      ['创建标题、列表和引用，通过目录跳转并继续编辑。','层级和跳转位置对应正确，继续输入不返回旧位置。'],
      ['在同名标题下放置重复段落，用目录及源码定位最后一次出现。','不跳到首次出现的同名内容，滚动与光标一致。'],
      ['在多层引用/列表边界使用 Enter、Backspace、Tab 与撤销。','缩进和层级符合操作，邻近表格和公式保持完整。'],
      ['搜索重复的中文/emoji/公式文本，查找替换后立即输入并撤销。','替换范围准确，旧定位不抢光标，撤销恢复原文。']
    ]
  },
  {
    area:'表格结构',variants:'原笔记历史复杂表格、最新快照、窄表、宽表；IR/WYS；表头/中间/末行。',
    entryPoints:['scripts/math-table-matrix.cjs','scripts/desktop-table-context.cjs','scripts/desktop-table-input.cjs'],
    cases:[
      ['创建表格、填入文字，增加和删除一行/一列，再保存重开。','行列数和单元格内容符合操作，不退回原始 Markdown 表格。'],
      ['在第一/末行及第一/末列执行增删，包含空单元格。','边界索引正确；存活单元格内容和可继续输入的光标正确。'],
      ['对带 br 换行、转义竖线、链接、代码和公式的单元格做结构操作。','换行不暴露 HTML 源码；竖线不意外增加列，公式内容不丢失。'],
      ['在宽表横向滚动到末列后打开菜单、改变列宽并撤销结构操作。','菜单作用于目标单元格；撤销恢复表形，源内容未串列。']
    ]
  },
  {
    area:'表格内导航与粘贴',variants:'IR/WYS；表头、空格、换行、重复单元格、最后一格；隔离剪贴板测试留待桌面恢复。',
    entryPoints:['scripts/math-table-matrix.cjs','scripts/desktop-table-input.cjs','scripts/desktop-media-office.cjs'],
    cases:[
      ['用鼠标、Tab、Shift+Tab 和上下方向键移动，再在目标格输入。','焦点及输入留在目标格，已有表格结构保持正确。'],
      ['在内容相同的多个单元格之间来回点击并反向选择文本。','按实际单元格身份定位，不误选相同文字的另一格。'],
      ['粘贴含制表符、换行、Markdown 竖线和 Office 内容的片段，再撤销。','目标区域可预测，未选择的邻格不被改写，撤销完整。'],
      ['在末格/空格/多行格连续执行导航、退格、删除及撤销重做。','无卡死、越界或丢格；必要的新行只创建一次。']
    ]
  },
  {
    area:'数学快捷键往返',variants:'Ctrl+Shift+E；IR/WYS；正文、表格、引用和列表；空选区/完整/局部/反向选区。',
    entryPoints:['scripts/math-table-matrix.cjs','scripts/math-boundaries.cjs','scripts/math-history.cjs','scripts/math-markdown.test.cjs'],
    cases:[
      ['选中普通内容，按 Ctrl+Shift+E 包裹，再按一次取消。','往返后的 Markdown 与基线一致，光标留在原内容处。'],
      ['在已有公式、空公式和公式边界执行取消，再输入及退格。','移除对应定界符，不嵌套额外美元符号，不吞邻接文本。'],
      ['输入分式、矩阵、竖线、转义美元、反引号和未完成 TeX，再取消。','TeX 字符保存正确；未完成表达式可继续编辑，不触发 JS 异常。'],
      ['对同一选区以快慢交替节奏执行至少 30 次快捷键，再撤销、重做、保存重开。','每次完整往返可逆，无延迟光标跳转、历史错乱或后续正文被包入。']
    ]
  },
  {
    area:'嵌套格式中的数学预览',variants:'原 RN 导数段及无加粗、斜体、删除线、三重强调、链接变体；正文/表格；IR/WYS。',
    entryPoints:['scripts/nested-math-suite.cjs','scripts/math-colors.cjs','../Typora-Editor/test/katex-source-map.test.cjs'],
    cases:[
      ['打开一条渲染公式并再次点击其预览，再点击普通文字。','只展开当前公式；离开后恢复渲染，正文未被编辑。'],
      ['依次打开同一加粗行内的第一、第二、第三条公式，再回到第一条。','相邻公式持续渲染，不连带打开源码或出现黑色遮挡。'],
      ['去掉加粗或替换为多层强调/链接，在段落及单元格重复预览点击。','修复不依赖加粗特征；各公式按自身焦点独立显示。'],
      ['在公式之间的普通格式文本处点击并执行快捷键往返，切换明暗主题。','不会激活容器中第一条公式；其他公式的 TeX、可读颜色及显示状态不变。']
    ]
  },
  {
    area:'公式与表格连续交互',variants:'原复杂表格及新快照；IR/WYS；普通格、空格、末行、相同公式多次出现。',
    entryPoints:['scripts/math-table-matrix.cjs','scripts/desktop-table-input.cjs','scripts/desktop-user-file.cjs'],
    cases:[
      ['在单元格插入公式并输入，再直接点击同一表格另一单元格。','离开该公式即收起源码与编辑预览，无须离开整个表格。'],
      ['公式尚未输入完成时用 Tab、Shift+Tab、上下方向键和鼠标退出。','旧公式随实际焦点收起，目标格可继续输入，表格不退回源码。'],
      ['在末行窄格输入长分式/矩阵，滚动并改变窗口宽度，然后点击另一格。','预览处于可见区域，不遮蔽后续行；定界符与焦点不脱离目标格。'],
      ['在多格连续进行插入、输入、预览、取消、导航、撤销重做和保存，固定操作种子，至少 50 轮。','逐轮核对表形和未操作单元格；无随机丢格、源码回退、焦点漂移或 JS 异常。']
    ]
  },
  {
    area:'源码与渲染位置对应',variants:'IR/WYS 到 SV 往返；重复文字、表格、行内/块公式、代码块、实体和内嵌图片。',
    entryPoints:['scripts/split-navigation-suite.cjs','scripts/viewflow-suite.cjs','scripts/chat-selection-suite.cjs','scripts/markdown-locations.test.cjs'],
    cases:[
      ['在可见正文中定位光标，切入源码，再从源码定位回渲染侧。','位置对应同一字或相同语义边界，切换不修改正文。'],
      ['从重复表格内容、公式内部、代码第二行和图片后的文字切换。','按源偏移定位到目标实例，不跳到同文首项或代码块开头。'],
      ['把旧光标滚出屏幕后切换源码；再分别操作空格、空单元格和文档末尾。','采用当前阅读锚点或有效边界，不突然拉回旧光标。'],
      ['定位后查找替换、中文输入、撤销、外部刷新及再次切换，测试延迟回调交错。','新编辑位置优先，过期锚点不把输入拉回行首或其他单元格。']
    ]
  },
  {
    area:'分屏、滚动和窗口布局',variants:'IR/WYS/SV；左右不同高度；IDE AI 侧栏打开/关闭；窄窗与宽窗。',
    entryPoints:['scripts/viewflow-suite.cjs','scripts/viewflow-performance-suite.cjs','scripts/split-resize.test.cjs'],
    cases:[
      ['拖动分隔条、双向滚动并重新进入分屏。','左右位置相符，比例被记住，拖动后内容重新排版。'],
      ['快速改变 AI 侧栏宽度和主窗口尺寸，再恢复正常宽度。','最终比例稳定，无 ResizeObserver 循环错误及持续布局震荡。'],
      ['拖动中切换模式或关闭文档；使用方向键、Shift+方向键和双击复位。','已退出模式不再收到宽度写入，控件行为和存储比例正确。'],
      ['极窄窗口、末行长公式和大表格并存，交替滚动两边后停止操作。','列宽有界，预览可读，停止后没有互相驱动的滚动循环。']
    ]
  },
  {
    area:'IDE 原生 AI 选区与焦点',variants:'VS Code 和 Trae；IR/WYS/SV；仅加附件及编辑草稿，不提交消息。',
    entryPoints:['../Typora-Editor/test/native-focus-matrix.cjs','scripts/native-chat-platform.test.cjs','scripts/native-chat-renderer.test.cjs','scripts/chat-selection-suite.cjs'],
    cases:[
      ['选中正文或表格文本，Alt+U 后立即输入本轮唯一标记。','只添加一次正确文件范围，键入进入 AI 草稿，正文和磁盘不变。'],
      ['用反向、重复单元格、跨段、数学和代码选区调用，再关闭侧栏后用无扫描码输入重开。','范围映射准确，草稿保留，焦点进入实际可编辑输入框。'],
      ['制造重复范围消息、同步失败、超时、迟到/空消息、请求替换以及编辑版本改变。','失败被处理，重复消息不重复添加；陈旧范围不能加入，恢复后可以重试。'],
      ['在异步同步、命令发现、添加附件各阶段切换/关闭编辑器；组合输入和长按 Alt+U。','不向已离开的文档发起操作，不抢回焦点，不产生未处理异常或重复附件。']
    ]
  },
  {
    area:'补全与输入竞争',variants:'IR/WYS/SV；正文、表格、数学；使用本地模拟提供商，不请求真实 AI 服务。',
    entryPoints:['scripts/completion-platform.test.cjs','scripts/desktop-completion.cjs','../Typora-Editor/test/completion-core.test.cjs','../Typora-Editor/test/completion-structure.test.cjs'],
    cases:[
      ['输入、展示补全、接受及撤销，再保存。','补全只插入目标位置；接受和撤销不重复正文。'],
      ['在请求未返回时编辑、移动光标、切模式或外部刷新。','旧补全不覆盖新状态，过期请求能够取消或安全丢弃。'],
      ['在表格公式中触发补全，含美元、竖线、矩阵和未完成 TeX。','返回内容留在当前语法范围，定界符和表形不被破坏。'],
      ['模拟超时、断开、畸形响应、超长内容和中文组合输入。','错误可恢复，组词不被打断，无持续请求、重复插入或凭据日志。']
    ]
  },
  {
    area:'媒体、粘贴和导出',variants:'本地图片、内嵌图片、Office 公式；中文路径；HTML/PDF/Word 支持的导出入口。',
    entryPoints:['scripts/media-core.test.cjs','scripts/desktop-media-office.cjs','scripts/desktop-media-lifecycle.cjs','scripts/desktop-export.cjs','scripts/desktop-export-large.cjs','scripts/export-assets.test.cjs'],
    cases:[
      ['插入图片和公式，保存重开，再分别导出受支持格式。','媒体和公式可见，导出文件打开后内容及资源完整。'],
      ['粘贴含 Office 公式、特殊字符及图片的表格，撤销后再次粘贴。','公式转义/私用字符处理正确，不重复附加资源或破坏表格。'],
      ['删除/撤销/移动带图片的内容，保存到新路径后重开。','仍被引用的资源不误删，相对路径有效，选区映射不受图片压缩偏移影响。'],
      ['导出长表、跨页公式、宽代码和缺失资源；模拟资源读取失败。','失败可见且正文保留；成功导出无截断、遮挡及资源越界读取。']
    ]
  },
  {
    area:'主题、字体和阅读',variants:'明亮、暗色、米色阅读背景；字体/字号；公式、代码、表格及阅读模式。',
    entryPoints:['scripts/math-colors.cjs','scripts/reading-experience.cjs','scripts/ui-refinements.cjs','scripts/theme-compatibility-audit.cjs'],
    cases:[
      ['切换主题、字号和阅读模式，打开公式预览再返回编辑。','文字和公式清晰，编辑入口及焦点可用，正文不变。'],
      ['在嵌套格式公式展开期间连续切换明暗和阅读背景。','没有黑块、透明到不可读的文字或相邻公式源码泄漏。'],
      ['大字号、窄窗、长 TeX 和宽表组合，滚动并调整分屏。','控件及预览可访问，无遮盖导致的误点击或不可编辑区域。'],
      ['隐藏/显示目录、进入/退出阅读模式、定位再继续中文输入。','旧视图状态不抢焦点，主题和宽度设置恢复正确。']
    ]
  },
  {
    area:'性能、异常与私版产物',variants:'最终 EXE 与提取的 VSIX；共享源哈希；普通文件、接近/跨越 150000 与 900000 字符阈值。',
    entryPoints:['scripts/release100-mapping-benchmark.cjs','scripts/release100-quality-boundaries.cjs','scripts/run-release100-background.mjs','scripts/verify-release100-private.cjs'],
    cases:[
      ['对普通笔记执行打开、编辑、分屏、保存及原生选区协作，记录耗时和异常。','关键路径可用，实际输入及预览正常；本轮捕获的未处理 JS 异常为零。'],
      ['对基准的三种内容各跑 IR/WYS 两种定位状态；预热后重复七次，核对源偏移。','前后夹具哈希和锚点一致，报告映射耗时；不把局部耗时当作整机性能。'],
      ['在大文件降级阈值上下切换、滚动、修改尾部并重建映射，连续操作后停留。','块/比例降级符合阈值，无重复全文解析或持续活动；输入、保存及目标位置正确。'],
      ['源码全量通过后更新私版版本到 1.0.0，再打包并按最终 EXE/VSIX 重跑与人工复核。','manifest、宿主和全部共享文件与验收源码一致；公版哈希不变；产物证据完整才交付。']
    ]
  }
];
module.exports={groups};

if(require.main===module){
  assert.equal(groups.length,16);
  const cases=groups.flatMap((g,i)=>{
    assert.equal(g.cases.length,4);
    for(const file of g.entryPoints)assert.ok(fs.statSync(path.resolve(project,file)).isFile(),file);
    return g.cases.map(([steps,expected],j)=>({
      id:j===0?'B'+String(i+1).padStart(2,'0'):'E'+String(i*3+j).padStart(2,'0'),
      kind:j===0?'basic':'edge',area:g.area,variants:g.variants,steps,expected,
      evidenceCandidates:g.entryPoints,executionStatus:'pending',evidence:[]
    }));
  });
  const basic=cases.filter(c=>c.kind==='basic').length,edge=cases.length-basic;
  assert.equal(basic,16);assert.equal(edge,48);assert.equal(new Set(cases.map(c=>c.id)).size,64);
  const plan={schemaVersion:1,target:'1.0.0 private EXE and VSIX',status:'source regression in progress; final artifact acceptance pending',
    countingUnit:'workflow scenario; expanded mode/content/platform runs and assertion counts must be reported separately',
    counts:{total:cases.length,basic,edge,basicPercent:25,edgePercent:75},
    acceptance:'No case is accepted by this plan. Entry points are candidate evidence sources, not proof that a complete workflow is already automated or has passed.',
    cases};
  const docs=path.join(project,'docs'),json=path.join(docs,'RELEASE100-SATURATED-PLAN.json'),markdown=path.join(docs,'RELEASE100-SATURATED-PLAN.md');
  const lines=[
    '# 私版 1.0.0 饱和测试计划',
    '',
    '状态：已按用户“继续后续任务，若我有打断就暂停”恢复桌面执行；源码全量回归进行中，最终包验收尚未完成。64 个工作流程中，16 个基础（25%）、48 个边缘（75%）。比例以工作流程为计数单位；模式、内容、平台的展开执行数及断言数另报，不用局部 Alt+U 矩阵代表全应用验收。',
    '',
    '本文件是计划目录，不启动应用，也不根据测试脚本存在就宣称通过。当前执行证据记录在 .perf/release100-source 各任务目录；每项工作流程须核对实际步骤后单独映射，最终包复核另记。收到用户打断立即停止当前测试，不自动串联下一组桌面任务。',
    '',
    '夹具使用 .backups 中的原笔记复杂表格、较新笔记快照和本轮 user-note-start.md；另加小型边界夹具。恢复时已读取最新笔记，生成 user-note-resumed-1788864957504.md（19246 字节，SHA256 6e19e6614db98052cc09341738d2a0654cc5a2913482d3ddc5b0df0ce21105f7），包含三张表共 28 格。只修改隔离副本，不把快照覆盖回用户原文件。',
    '',
    '每项执行记录须包含案例 ID、实际模式/平台/夹具哈希、操作与可观察结果、源码/产物哈希、异常日志路径和通过/失败状态。公式/表格断言包含行列结构、未操作单元格内容、光标所属格、每条公式源码可见性、磁盘及脏标记；视觉异常另留截图。故意输入不完整 TeX 的可预期渲染提示与未处理 JS 异常分别记录。',
    '',
    '每组列出的脚本只是可复用的证据入口，未声称它们已经自动覆盖该组所有步骤。人工步骤和脚本缺口须补齐后逐项验收；旧版本报告不能作为当前版本通过证据。',
    '',
    '先完成当前源码全量回归，再将私版版本改为 1.0.0 并构建；最终包仍须运行复核。旧 verify-viewflow-private.cjs 和 run-viewflow-* 脚本硬编码旧版本，不能直接用于签收新包。',
    ''
  ];
  for(const g of groups){
    lines.push('## '+g.area,'',g.variants,'','| ID / 类型 | 操作 | 通过条件 |','|---|---|---|');
    for(const c of cases.filter(c=>c.area===g.area))lines.push(`| ${c.id} / ${c.kind==='basic'?'基础':'边缘'} | ${c.steps} | ${c.expected} |`);
    lines.push('','证据入口（待逐项映射）：'+g.entryPoints.map(file=>`[${path.basename(file)}](${path.resolve(project,file).replaceAll('\\','/')})`).join('；')+'。','');
  }
  if(process.argv.includes('--write')){fs.writeFileSync(json,JSON.stringify(plan,null,2)+'\n');fs.writeFileSync(markdown,lines.join('\n'));}
  console.log(JSON.stringify({counts:plan.counts,status:plan.status,allEvidenceEntryPointsExist:true,wrote:process.argv.includes('--write')?[json,markdown]:[]},null,2));
}
