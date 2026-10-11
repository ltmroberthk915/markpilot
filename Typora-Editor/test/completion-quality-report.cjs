'use strict';
// Explicit per-case review notes. Syntax validity is evidence, never a proxy
// for mathematical correctness. No model or paid grading API is called here.
const fs=require('node:fs'),path=require('node:path');
const runs=path.join(__dirname,'.runs');
const read=n=>JSON.parse(fs.readFileSync(path.join(runs,n,'results.json'),'utf8'));
const models=['glm-5.3-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro'];
const notes={
  json:{
    'glm-5.3-flash':{
      M6:['C','矩阵迹项缺少转置，不能按本页约定相乘。'],M9:['B','改用了初值、控制与冲击的展开历史；信息可等价，但需统一元组记法。'],M11:['B','展开成链式导数，需核对梯度及 Jacobian 的行列约定。'],M13:['C','将解释和推敲过程写进公式，且 LaTeX 不合法。'],M15:['B','把扩散函数参数由 (u,x) 改为 (t,x,u)，需统一符号。'],M19:['C','终值应为遗赠函数 Φ 的梯度，却写成 h。'],
      P1:['C','接入原句后“即通过……最优解，表示……”缺少合理主语。'],P2:['B','解释本身有用，但重复了右侧已经存在的 dW 和句号。'],P3:['C','把任何宏观量限定为消费政策 c* 的加总，范围过窄。'],P4:['C','错误宣称消去状态后是无约束优化，原可行约束仍在。'],P6:['C','将状态扩充称为时间变换，并重复右侧“转化”。'],P9:['B','边际解释可用，但需删去粗体边界前的多余句号。'],P10:['C','把异质个体的确定性分布解释为代表性个体的极限，混淆概念。'],P11:['C','无界纯扩散没有“直到完全混合”的归一化均匀极限。'],
    },
    'deepseek-v4-pro':{
      M9:['C','z(t) 只有当前冲击，丢掉了本讲 z_t 的完整冲击历史。'],M13:['D','模型主动返回空字符串。'],M19:['C','遗赠函数梯度前凭空增加系数 2。'],M25:['C','使用未定义的漂移 b_t，未沿用 g_t*。'],
      P3:['B','“分布对政策函数的积分”主客体颠倒，需改写为按分布积分。'],P4:['C','句子停在“目标函数值仅依赖于”，插入后仍不完整。'],P5:['B','含义正确，但重复了光标之前已经说完的原因。'],P6:['C','续写了下文末尾“其贝”为“尔曼方程”，没有补光标处。'],P9:['C','停在“瞬时提升幅”，词语未完整输出。'],
    },
    'deepseek-v4-flash-vision-exp':{
      M13:['C','只生成期望的左括号，没有闭合且无法直接插入。'],
      P1:['C','把最优选择本身与子问题最优值相加，混淆控制和收益。'],P3:['B','“对分布的所有样本积分”未说明被加总的函数。'],P5:['B','几乎重述整个前句，需删去重复部分。'],P6:['C','续写了下文末尾“其贝”为“尔曼方程”，并重复公式。'],P7:['C','结尾留下“即”，与已有句号不能组成完整句子。'],P8:['C','误补“一阶导数项）”，且越过原有括号边界。'],P9:['C','重复小标题与前句，另有双反斜杠。'],P11:['B','含义可用，但插入末尾分号与已有句号冲突。'],
    },
  },
  literal:{
    'glm-5.3-flash':{
      M9:['C','u(t-1) 和 z(t) 不能代替本讲的完整控制、冲击历史。'],M11:['B','展开为链式导数，需核对梯度及 Jacobian 的行列约定。'],M13:['C','仍输出推敲文字与未闭合的期望。'],M19:['C','把遗赠函数 Φ 错写为漂移函数 g。'],M25:['B','需要将未定义的 g_t(x) 统一为策略诱导漂移 g_t*(x)。'],
      P9:['C','在插入中间又输出 **，破坏既有粗体边界。'],
    },
    'deepseek-v4-pro':{
      M13:['C','只有期望左括号，现有后文不能闭合。'],M17:['C','值函数参数缺少右圆括号；KaTeX 不报错仍非完整表达式。'],M19:['C','遗赠函数参数缺少右圆括号；KaTeX 不报错仍非完整表达式。'],M21:['B','省略策略星号，需要统一为 σ_t*(x)。'],M25:['B','省略策略星号，需要统一为 g_t*(x)。'],
      P3:['B','只写“对谁在什么状态加权平均”，需要明确被积函数。'],P6:['C','泄漏 </response> 标记，不应写进笔记。'],P7:['B','使用 \\(t\\)；本编辑器需沿用 $t$ 行内公式语法。'],
    },
    'deepseek-v4-flash-vision-exp':{
      M4:['C','把矩阵协方差 σσᵀ 写成 σ²。'],M9:['C','擅自从 0、1 起展开历史，混用本讲时间起点 S 及列记法。'],M25:['B','额外插入生成元极限定义，并将 g_t* 改为 g_t；需收短并统一记法。'],M28:['C','来自 j 状态的流入应是 η_j μ_j，输出了 η_i μ_j。'],
      P3:['B','只写“对 μ_t 的加权平均”，未说清被加总的状态函数。'],P9:['B','边际解释有用但偏长，需去掉粗体内的重复句末标点。'],P12:['B','把平稳分布定义混入“收敛后保持不变”，需区分平稳与收敛。'],
    },
  },
};
const repeatNotes={
  json:{
    'glm-5.3-flash':{
      'M28:3':['C','将流入强度 η_j 改成 η_i。'],
      'P3:2':['C','把所有宏观量限定为消费政策的平均。'],'P3:3':['C','把所有宏观量限定为消费政策的积分。'],
      'P11:2':['A','高斯扩散摊宽、质心不动，含义及句子衔接正确。'],'P11:3':['A','峰处下降、低处上升，摊宽的描述正确。'],
    },
    'deepseek-v4-pro':{
      'P3:2':['B','对行动积分未交代人口分布的权重。'],'P3:3':['B','“分布的函数”正确但过于宽泛，不能替代加总关系。'],
      'P7:2':['B','采用 \\(t\\)，需换为编辑器已有 $t$ 语法。'],'P7:3':['B','采用 \\(t\\)，需换为编辑器已有 $t$ 语法。'],
    },
    'deepseek-v4-flash-vision-exp':{
      'M24:2':['C','重复输出转义序列直到上限，没有有效公式。'],'M28:2':['A','流入强度与来源状态 j 一致。'],
      'P3:2':['C','正文公式仍有双反斜杠，且重复原有解释。'],'P3:3':['B','状态的加权平均未说明一般宏观量的被积函数。'],
      'P7:2':['A','相同历史必须作相同决策，衔接完整。'],'P7:3':['C','补充等式仍有双反斜杠，不能直接采用。'],
      'P11:2':['C','声称形状趋于均匀，无界扩散缺少这样的归一化极限。'],'P11:3':['B','末尾逗号与现有句号冲突。'],
    },
  },
  literal:{
    'glm-5.3-flash':{
      'M5:3':['C','partial 缺少反斜杠，会显示为普通字母。'],'M28:3':['C','两状态流入项被改成对 j 求和，包含了未排除的自身流。'],
      'P3:2':['C','将所有宏观量限为 c* 或 u* 的积分，范围过窄。'],'P3:3':['C','状态 x 的平均不是任何宏观量的一般表达式。'],
      'P7:2':['B','将决策误称为“效用或行动”，需去掉“效用”。'],'P11:3':['C','无界扩散不存在文中宣称的最终均匀分布。'],
    },
    'deepseek-v4-pro':{
      'P3:2':['B','未明确被积函数及分布权重。'],'P3:3':['B','状态的积分未明确一般宏观量的状态函数。'],
      'P7:2':['A','控制决策必须相同，完整且简洁。'],'P7:3':['B','决策不应称为观测量，需删去括号插语。'],
    },
    'deepseek-v4-flash-vision-exp':{
      'P3:2':['B','未明确被积函数。'],'P3:3':['A','补充了个体选择按人口密度加总的含义。'],
    },
  },
};
const result={method:{distinctCases:40,math:28,prose:12,repeatedIds:['M2','M5','M8','M12','M18','M24','M28','P3','P7','P11'],trialsForRepeated:3,categories:{A:'可直接采用：数学/语义成立、记法一致、插入边界完整',B:'有用但需调整：记法、冗余、表述或格式需编辑',C:'不能直接采用：数学错误、未完成、错位、格式损坏',D:'空建议或服务失败'},review:'逐条核查插入后语义；不是字面命中率。等价公式可通过；KaTeX 通过不等于数学正确。'},phases:{}};
for(const phase of ['json','literal']){
  const suffix=phase==='literal'?'-literal':'';
  const glm=read('quality-dp-40-glm'+suffix),ds=read('quality-dp-40-deepseek'+suffix);
  const data=[...[...glm.cases,...glm.repeats].map(r=>({...r,model:models[0]})),...ds.cases.map(r=>({...r,model:r.requestedModel}))];
  const rows=data.map(r=>{
    let note=repeatNotes[phase][r.model]?.[r.id+':'+r.trial]||notes[phase][r.model]?.[r.id]||['A',r.kind==='math'?'与参考表达式等价，符号及插入边界可直接使用。':'插入后语义成立、句法完整。'];
    if(!r.suggestion)note=['D',r.error||r.testError||'模型返回空字符串。'];
    else if(r.kind==='math'&&/\\\\[A-Za-z]/.test(r.suggestion))note=['C','双反斜杠把 LaTeX 命令变成换行或普通字母。'];
    return {model:r.model,id:r.id,trial:r.trial,kind:r.kind,group:r.group,line:r.line,label:r.label,expected:r.expected,suggestion:r.suggestion,grade:note[0],review:note[1],katexValid:r.katexValid,apiMs:r.apiMs,usage:r.usage,thinking:r.contentBlocks?.some(b=>b.type==='thinking'&&b.characters>0)||false};
  });
  const stats=models.map(model=>{
    const all=rows.filter(r=>r.model===model),first=all.filter(r=>r.trial===1),timings=first.map(r=>r.apiMs).sort((a,b)=>a-b);
    const count={A:0,B:0,C:0,D:0};for(const r of first)count[r.grade]++;
    const sum=k=>all.reduce((s,r)=>s+(r.usage?.[k]||0),0);
    const repeated=Object.fromEntries(result.method.repeatedIds.map(id=>[id,all.filter(r=>r.id===id).map(r=>r.grade)]));
    return {model,firstDraw:count,mathDirect:first.filter(r=>r.kind==='math'&&r.grade==='A').length,proseDirect:first.filter(r=>r.kind==='prose'&&r.grade==='A').length,medianMs:(timings[19]+timings[20])/2,p95Ms:timings[37],maxMs:timings[39],calls:all.length,inputTokens:sum('input_tokens'),cachedInputTokens:sum('cache_read_input_tokens'),outputTokens:sum('output_tokens'),thinkingResponses:all.filter(r=>r.thinking).length,repeated,stableMath:Object.entries(repeated).filter(([id,grades])=>id.startsWith('M')&&grades.length===3&&grades.every(g=>g==='A')).length,stableProse:Object.entries(repeated).filter(([id,grades])=>id.startsWith('P')&&grades.length===3&&grades.every(g=>g==='A')).length};
  });
  result.phases[phase]={stats,rows};
}
const output=path.join(runs,'quality-dp-model-review.json');fs.writeFileSync(output,JSON.stringify(result,null,2));
for(const [phase,value]of Object.entries(result.phases))for(const s of value.stats)console.log(JSON.stringify({phase,...s}));
console.log(output);
const absolute=p=>path.join(__dirname,'..',p).replaceAll('\\','/');
const link=(label,p)=>'['+label+']('+absolute(p)+')';
const name=m=>m===models[0]?'GLM 5.3 Flash':m===models[1]?'DeepSeek V4 Flash Vision Exp':'DeepSeek V4 Pro';
const old=result.phases.json.stats,current=result.phases.literal.stats;
const source=read('quality-dp-40-glm').source;
const total=current.concat(old).reduce((a,s)=>({calls:a.calls+s.calls,input:a.input+s.inputTokens,cached:a.cached+s.cachedInputTokens,output:a.output+s.outputTokens}),{calls:0,input:0,cached:0,output:0});
const lines=[
  '**动态规划教材补全质量对照 · 0.1.17-local · 2026-09-06**',
  '',
  '本轮结论：输入格式和模型都会影响结果。把源文本再次编码为 JSON，容易让模型复制双反斜杠；把长下文放在输入末尾，容易让模型续写下文末尾。改为原样源文本，并把明确的光标缺口放在最后，收益比直接更换模型更明显。新格式已经合入插件。',
  '',
  '修复后首轮成绩相近，不能据 1–2 个样本的差距判定总体能力。公式重复测试中 Pro 最稳定，Flash 响应最快；各模型仍有数学或插入边界错误。若优先自动补全速度，可以试 Flash；若优先这份数学笔记的公式稳定性，可以试 Pro。这里是本次小样本观察，不是跨任务模型排行榜。现有 API 设置不因临时测试而自动切换。',
  '',
  '**样本与方法**',
  '',
  '使用 [桌面教材](C:/Users/Ming/Desktop/动态规划教材（渲染修复副本）.md)，原文件 '+source.bytes+' 字节、'+source.characters+' 个 UTF-16 字符；SHA-256：`'+source.sha256+'`。原文件保持不变。',
  '固定 40 个不同缺口：28 个公式、12 个文字，覆盖离散动态规划、随机 Bellman、伊藤展开、矩阵求导、状态变分、约束、协方差与 KF 方程。10 个来自之前的小样本调试，30 个在本轮首次使用；两种输入格式都使用相同缺口，不能把格式调整后的成绩称为独立盲测。',
  '',
  '每个模型先测 40 个不同缺口，再对预先指定的 M2、M5、M8、M12、M18、M24、M28、P3、P7、P11 各追加两次，共 60 次。3 个模型 × 2 种输入格式 × 60 = 360 次成功返回的模型调用。重复调用刻意绕过本地建议缓存；没有挑最好的一次算分。另有 2 次有效连通验证和 2 次环境旧凭据的 HTTP 401，不纳入成绩。',
  '',
  '从真实 Trae 编辑器提取上下文，基线调用走完整插件链路，并检查接受、撤销。随后重放完全相同的上下文和生产 requestAI：不修改原文、不更改保存的 API 设置。模型只看到移除缺口后的局部上下文；参考答案只保存在本地，但相同定义可能自然出现在其他邻近段落。新旧两种格式保持同样的上下文字段、模型、思考设置与输出上限（数学 256 tokens、文字 160 tokens）；变化是呈现格式、字段顺序及末尾明确的缺口视图。所有模型均通过 Anthropic 兼容接口调用，不使用独立的 LLM 判断或评分请求。',
  '',
  'DeepSeek 返回的模型名称均与请求一致：deepseek-v4-flash-vision-exp 和 deepseek-v4-pro；请求前去掉 [1M] 客户端后缀。[DeepSeek 兼容接口说明](https://api-docs.deepseek.com/guides/anthropic_api/) 提到其他模型名可能映射到默认模型，因此测试记录了实际返回名称。',
  '',
  '逐项核查插入后的语义、符号和句法：A = 可直接采用；B = 有用但需调整；C = 不能直接采用；D = 空建议/调用失败。等价公式也可得 A，例如在本段明确定义的策略 π 下，E_t^π[·|h_t] 与给定 u(t), h_t 的条件期望等价。KaTeX 通过不等于数学正确；“正确但需改符号/格式”也不算直接采用。',
  '',
  '**40 个缺口的首轮结果**',
  '',
  '| 模型 | 原 JSON 格式可直接采用 | 新格式可直接采用 | 新格式公式 | 新格式文字 | 新格式需调整 B | 新格式错误/空 C+D |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...current.map((s,i)=>`| ${name(s.model)} | ${old[i].firstDraw.A}/40 | ${s.firstDraw.A}/40 | ${s.mathDirect}/28 | ${s.proseDirect}/12 | ${s.firstDraw.B} | ${s.firstDraw.C+s.firstDraw.D} |`),
  '',
  'Flash 的首轮 28 个公式中，原格式有 20 个输出包含错误的双反斜杠命令，新格式为 0。三个模型在新格式下首轮都没有这个问题。Flash 新格式的 28 个公式全部通过 KaTeX，但只有 24 个可直接采用：这正说明单看渲染结果会高估质量。',
  '',
  '**固定缺口连续三次的稳定性**',
  '',
  '| 模型 | 7 个公式中三次均为 A | 3 个文字中三次均为 A |',
  '| --- | ---: | ---: |',
  ...current.map(s=>`| ${name(s.model)} | ${s.stableMath}/7 | ${s.stableProse}/3 |`),
  '',
  '三次并不足以估计长期错误率，但足以暴露本轮的波动。新格式下，Flash 对 M28 连续三次把来源 j 的流入强度写成 η_i；Pro 对该缺口三次均为 η_j。GLM 在第三次 M5 中漏掉 partial 的反斜杠，第三次 M28 又多加了求和。稳定地错和偶发地错应分别处理，不能靠重复抽取后选最好的一次掩盖。',
  '',
  '**延迟与 token**',
  '',
  '| 模型 | 新格式 API 中位数 | P95 | 最大值 |',
  '| --- | ---: | ---: | ---: |',
  ...current.map(s=>`| ${name(s.model)} | ${(s.medianMs/1000).toFixed(2)} s | ${(s.p95Ms/1000).toFixed(2)} s | ${(s.maxMs/1000).toFixed(2)} s |`),
  '',
  '延迟取新格式首轮 40 次的网络请求至完整响应，不包含输入停顿、光标停留或 UI 展示时间。重复调用可能命中服务端输入缓存；格式轮次有先后、网络和服务负载也在变动，不能把延迟变化全部归因于格式。',
  '',
  '| 格式 | 模型 | 调用数 | 未缓存输入 tokens | 缓存输入 tokens | 输出 tokens |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...['json','literal'].flatMap(phase=>result.phases[phase].stats.map(s=>`| ${phase==='json'?'原格式':'新格式'} | ${name(s.model)} | ${s.calls} | ${s.inputTokens} | ${s.cachedInputTokens} | ${s.outputTokens} |`)),
  '',
  `这 360 次合计未缓存输入 ${total.input}、缓存输入 ${total.cached}、输出 ${total.output} tokens，总计 ${total.input+total.cached+total.output}。以各服务返回的 usage 字段为准，不同服务 tokenizer 不同，不能把 token 数直接当作质量或金额。有效连通验证及之前小样本调试另计。`,
  '',
  '新格式增加了末尾局部缺口视图，输入 tokens 比原格式约增加 8%，交换到更可靠的定位和转义。每次仍只有一次生成请求，前端触发判断为本地 JS，不消耗 API tokens。不能为了“已有输入成本”强行采用有数学错误的输出。',
  '',
  `GLM 在新格式的 60 次调用中有 ${current[0].thinkingResponses} 次返回了 thinking 内容块，DeepSeek 两个模型均为 0。测试已发送 thinking.disabled；数学 GLM 请求另有 reasoning_effort=none。服务返回行为仍需实测，不能承诺关闭参数必然让所有兼容端点完全不思考。[GLM 思考参数说明](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)，[DeepSeek 思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)。这些是同一请求内部的内容，不是插件另外发出的“检查上下文”请求。`,
  '',
  '**还存在什么问题**',
  '',
  '- 模型能力：Flash 的 M4 将矩阵协方差写成 σ²，M28 连续混淆 η_i/η_j；GLM 有时把终值函数 Φ 写成 g。',
  '- 输出边界：Pro 偶尔缺右圆括号，或带出 </response>；GLM 偶尔在已有粗体内部多输出 **。这些不能靠 KaTeX 是否抛错发现。',
  '- 上下文范围：这套实现有固定局部预算，并不读取整本教材。跨章节符号定义可能缺失，例如策略漂移的星号和终值符号。后续可用本地符号检索补足；本轮为了归因没有同时更改提取范围。',
  '- 评阅边界：这是一本教材上的固定补缺任务，不等同于用户自然输入时的接受率；分数包含对简洁程度和插入边界的判断。原文自身也存在勘误，评阅按数学含义及上下文核对，未用字面命中率替代质量。',
  '',
  '**逐题首轮评级（新格式）**',
  '',
  '| ID | 类型/考点 | GLM | Flash | Pro |',
  '| --- | --- | --- | --- | --- |',
  ...result.phases.literal.rows.filter(r=>r.model===models[0]&&r.trial===1).map(r=>`| ${r.id} | ${r.label} | ${models.map(m=>result.phases.literal.rows.find(x=>x.model===m&&x.id===r.id&&x.trial===1).grade).join(' | ')} |`),
  '',
  '每次的输出、评级理由和 token 记录见 '+link('完整评阅 JSON','test/.runs/quality-dp-model-review.json')+'；原始报文不含请求头或密钥。',
  '',
  '原始结果：'+link('GLM 原格式','test/.runs/quality-dp-40-glm/results.json')+'、'+link('DeepSeek 原格式','test/.runs/quality-dp-40-deepseek/results.json')+'、'+link('GLM 新格式','test/.runs/quality-dp-40-glm-literal/results.json')+'、'+link('DeepSeek 新格式','test/.runs/quality-dp-40-deepseek-literal/results.json')+'。',
  '',
  '复现实验脚本：'+link('40 个固定样本','test/completion-quality-cases.cjs')+'、'+link('真实编辑器/GLM 测试','test/completion-quality.cjs')+'、'+link('DeepSeek 对照','test/completion-model-compare.cjs')+'、'+link('格式变体与核查','test/completion-request-variants.cjs')+'、'+link('评阅及本报告生成','test/completion-quality-report.cjs')+'。真实 API 测试需显式准备自己的凭据，不属于普通单元测试。',
];
fs.writeFileSync(absolute('docs/QUALITY-DP-MODELS-0.1.17.md'),lines.join('\n')+'\n');
