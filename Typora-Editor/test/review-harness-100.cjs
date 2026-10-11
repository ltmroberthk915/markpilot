// Offline semantic review and replay. This script makes zero network calls.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
(async()=>{
const root=path.resolve('test/.runs/harness-100-flash-0.1.18'),run=require(path.join(root,'results.json'));
const source=require(path.join(root,'source-info.json'));
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source.path)).digest('hex'),source.sha256,'Original note must remain unchanged');
const {cleanSuggestion}=await import('../extension-src/render/js/completion-policy.mjs');
const issues={
 M2:['C','Q 的任意当前控制 u(t) 被固定策略 π 的期望替代，丢失控制条件。'],
 M4:['C','矩阵扩散的 σσᵀ 被写成 σ²，一般不等价。'],
 M9:['C','展开历史后引入 0、1 起点，未遵循笔记的 S 起点及向量记号。'],
 M13:['C','缺失场景概率求和，且输出未闭合的 \\left[，整式无法渲染。'],
 M19:['C','把已定义遗赠函数 Φ 换成 g，终值条件符号错误。'],
 M25:['B','漂移项含义基本正确，但丢失最优策略星号并扩写整个生成元定义。'],
 M28:['C','应为 η_j μ_j，错误使用 η_i。'],
 M31:['C','状态维数应为 k；沿用了控制维数 n。'],
 M32:['C','删去了可行集合对历史控制的依赖。'],
 M37:['C','要求策略的定义域到值域映射，却输出可行集合。'],
 M42:['C','遗漏节点概率 P(n)，同时新造折现项和收益函数 r。'],
 M46:['B','需补回既有可行集合 u∈U。'],
 M48:['C','应补漂移链式项，却重复右侧已有扩散项。'],
 M60:['B','需把求值点恢复为最优态 u*、x*。'],
 M62:['C','给伴随方程的纯状态约束项额外乘了漂移 Jacobian。'],
 M64:['C','纯状态约束 b(x) 被直接对控制求导，丢失漂移链式项。'],
 M66:['C','用未在此处定义的 b_t 替代概率流 j_t，不能直接衔接随后 j_t 的定义。'],
 P1:['B','语义合理，需删除插入文本末尾与现有英文句点重复的中文句号。'],
 P5:['B','语义合理，但与右侧句点重叠。'],
 P6:['C','跨出加粗缺口继续写后半句，不能直接嵌回原句。'],
 P10:['C','把无总量冲击的确定性结论泛化为所有分布宏观模型。'],
 P17:['C','只输出句号，没有补写条件期望的含义。'],
 P18:['C','新造依赖控制的 p(u) 及乘积，没有给出笔记中的节点概率定义。'],
 P20:['C','在“定义最优反馈控制”处结束，未完成当前句子。'],
 P22:['C','越过加粗缺口，重复后文已有的折现回 0 时刻。'],
 P25:['C','重复右侧已有 γ_t 和整条表示式；还需明确适应性条件。'],
 P27:['B','风险解释基本相关，但明显超出当前短语缺口且重复句点。'],
 P28:['B','结论正确，但与紧随的加粗句高度重复，需要收短。'],
 P29:['C','方差解释混淆漂移、扩散平方比与曲率的关系。'],
 P30:['C','转置本身不能同时解出最优消费分布和值函数。'],
};
assert.equal(run.cases.length,100);assert.equal(run.cases.filter(c=>c.kind==='math').length,70);
assert.equal(new Set(run.cases.map(c=>c.start)).size,100);
assert.equal(run.cases.reduce((n,c)=>n+c.apiCalls,0),100);assert.ok(run.cases.every(c=>c.responseModel==='deepseek-v4-flash-vision-exp'&&c.httpStatus===200));
const reviewed=run.cases.map(c=>{
 const [grade,reason]=issues[c.id]||['A','可直接填入此上下文；允许数学等价表达、空格及不影响含义的格式差异。'];
 const start=performance.now(),cleaned=cleanSuggestion(c.rawSuggestion,c.payload),cleanupMs=performance.now()-start;
 const afterGrade=['P1','P5'].includes(c.id)?'A':c.id==='P25'?'B':c.id==='P17'?'D':grade;
 return {id:c.id,line:c.line,kind:c.kind,label:c.label,grade,reason,expected:c.expected,actual:c.suggestion,cleaned,afterGrade,cleanupMs,changed:cleaned!==c.suggestion,apiMs:c.apiMs,visibleMs:c.visibleMs,contextMs:c.contextMs,katexValid:c.katexValid};
});
const quantile=(a,p)=>a.slice().sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
const summaries={};
for(const group of ['all','math','prose']){
 const rows=reviewed.filter(c=>group==='all'||c.kind===group);
 summaries[group]={count:rows.length,grades:Object.fromEntries(['A','B','C','D'].map(g=>[g,rows.filter(c=>c.grade===g).length])),afterCleanup:Object.fromEntries(['A','B','C','D'].map(g=>[g,rows.filter(c=>c.afterGrade===g).length])),timings:Object.fromEntries(['apiMs','visibleMs','contextMs','cleanupMs'].map(key=>[key,{median:quantile(rows.map(c=>c[key]),.5),p95:quantile(rows.map(c=>c[key]),.95),max:Math.max(...rows.map(c=>c[key]))}]))};
}
const tokens=run.cases.reduce((s,c)=>{for(const k of ['input_tokens','cache_read_input_tokens','output_tokens'])s[k]=(s[k]||0)+(c.usage?.[k]||0);return s;},{});
const audit={source,model:'deepseek-v4-flash-vision-exp',apiCalls:100,extraLLMJudgeCalls:0,method:'100 个不同原文缺口各采样一次；Codex 逐条语义审阅，非独立盲评。后处理改进仅离线重放同一批响应。',summaries,tokens,reviewed};
fs.writeFileSync(path.join(root,'review.json'),JSON.stringify(audit,null,2));
const cell=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
const report=`# 真实数学笔记：100 次 Flash Vision Exp 补全实验\n\n`+
`样本来自桌面《动态规划教材（渲染修复副本）.md》，70 个数学、30 个文字缺口，100 个不同位置，每处 1 次，合计 **100 次真实生成调用**。全部返回 deepseek-v4-flash-vision-exp，HTTP 200；没有额外的 LLM 检查或评分调用。原文保持不变。40 个缺口来自既有样本，另新增 60 个；这些是离线挖空任务，不是用户接受率或打字日志。\n\n`+
`覆盖离散和随机 Bellman、场景树、HJB、伊藤展开、影子价格、约束控制、伴随方程及 KF 分布。原文有修订注记；按可见定义、上下文和插入后完整句式评分，接受等价公式，不使用逐字匹配充当质量分数。\n\n`+
`## 结果\n\nA=可直接使用；B=少量人工修订；C=含义错误或明显不适合当前缺口；D=无可用输出。以下为 Codex 逐条语义审阅，含主观判断，不是独立盲评。\n\n`+
`| 类别 | A | B | C | D | 请求到显示中位数 | P95 |\n|---|---:|---:|---:|---:|---:|---:|\n`+
['math','prose','all'].map(g=>{const s=summaries[g];return `| ${g} | ${s.grades.A} | ${s.grades.B} | ${s.grades.C} | ${s.grades.D} | ${s.timings.visibleMs.median} ms | ${s.timings.visibleMs.p95} ms |`;}).join('\n')+
`\n\n70 条数学中 **69 条语法可渲染**，但语义正确率明显低于语法通过率。全部 100 条返回非空，不能把返回率当作正确率。显示时间不包含自动触发的停顿等待；本地上下文提取中位数 4.4 ms、P95 11.5 ms。API 中位数 828 ms、P95 1611 ms。\n\n`+
`服务报告的 token 用量：未命中缓存输入 ${tokens.input_tokens}，缓存读取输入 ${tokens.cache_read_input_tokens}，输出 ${tokens.output_tokens}。重复访问同一教材带来服务端缓存，因此首次冷请求、其他笔记或其他时段的延迟可能不同。\n\n`+
`## 本次落地的优化\n\n只对现有响应增加本地后处理，不增加调用或 token：截断明确重复的右侧公式及其后续越界文本，删除重复的中英文句点，不展示纯标点建议。它改善 P1、P5 的直接可用性，P25 变成仍需修订的短语，P17 的无信息句号被隐藏。没有自动猜测或修改数学符号。\n\n`+
`同一批 100 个响应离线重放后：A ${summaries.all.afterCleanup.A}、B ${summaries.all.afterCleanup.B}、C ${summaries.all.afterCleanup.C}、D ${summaries.all.afterCleanup.D}。这是**后处理重放结果**，不是第二轮模型采样或泛化正确率证明。其本地 P95 开销 ${summaries.all.timings.cleanupMs.p95.toFixed(3)} ms。\n\n`+
`## 仍有优化空间\n\n1. 跨小节定义检索：M42 缺口上下文没有纳入前一小节完整的节点概率定义；M64 需要前文约束链式项。应增加有总长度上限的相关定义选取，避免一味扩大全文上下文。\n2. 符号和维度约束：σ²/σσᵀ、i/j、n/k、Φ/g 均出现错误；局部可检索已定义符号，但不能靠语法渲染证明正确。\n3. 文字缺口边界：尤其加粗短语，应加强“只补短语”的提示和正反例。仅用本地精确去重不能修复语义上的复述。\n4. 当前速度已接近 1 秒，建议保留本地优先、单次直接生成、650 ms 基础停顿、禁用推理、短输出及缓存。流式输出可改善首次可见时间，但尚无本次数据证明其对最终可接受时间的收益。\n\n未把尚未进行对照验证的检索或提示词调整直接设为新默认。严格保留用户要求的 100 次调用总数。每个缺口只抽 1 次，结果不代表模型稳定概率；后续若比较检索策略，应在同一批缺口上另做对照。\n\n`+
`## 逐条记录\n\n原始请求、响应、耗时、token 和上下文保存在 [results.json](../test/.runs/harness-100-flash-0.1.18/results.json)，逐条评分及后处理输出在 [review.json](../test/.runs/harness-100-flash-0.1.18/review.json)。\n\n`+
`| ID | 行 | 类别 | 原始评分 → 后处理 | 依据 |\n|---|---:|---|---|---|\n`+
reviewed.map(c=>`| ${c.id} | ${c.line} | ${c.kind} | ${c.grade} → ${c.afterGrade} | ${cell(c.reason)} |`).join('\n')+'\n';
fs.writeFileSync('docs/autocomplete-harness-100.md',report);
console.log(JSON.stringify({summaries,tokens,changed:reviewed.filter(c=>c.changed).map(c=>c.id)},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
