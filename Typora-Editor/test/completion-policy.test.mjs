import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completionPayload, sourceKind, intentOf, aiDelay, shouldSuggest, cleanSuggestion, remainingSuggestion, suggestionCache} from '../extension-src/render/js/completion-policy.mjs';

test('Real-note suffix overrun is trimmed locally without changing existing math', () => {
  const context={kind:'prose',before:'必然存在',after:' $\\gamma_t$, 使得:\n$K_t=K_0+\\int_0^t\\gamma_s dW_s$。'};
  assert.equal(cleanSuggestion('一个可测过程 $\\gamma_t$ 满足 $K_t = K_0 + \\int_0^t \\gamma_s dW_s$。',context),'一个可测过程');
  assert.equal(cleanSuggestion('可逆向归纳。',{kind:'prose',after:'.\n下一段'}),'可逆向归纳');
  assert.equal(cleanSuggestion('。',{kind:'prose',after:'.\n下一段'}),'');
  const valid='与 $\\gamma_t$ 对比，$K_t$ 满足条件';
  assert.equal(cleanSuggestion(valid,{kind:'prose',after:'在不同的时刻继续。'}),valid);
  assert.equal(cleanSuggestion('先展开 $a+已有足够长的相同右侧文字之后还有项$ 再解释',{kind:'prose',after:'已有足够长的相同右侧文字之后还有项$'}),'先展开 $a+已有足够长的相同右侧文字之后还有项$ 再解释');
});

test('Local math detection ignores escaped dollars and Markdown code', () => {
  assert.equal(sourceKind('价格 \\$20，普通文本').kind, 'prose');
  assert.equal(sourceKind('`$x=1$` 后文').kind, 'prose');
  assert.equal(sourceKind('```tex\n$x=1$\n').kind, 'code');
  assert.equal(sourceKind('```tex\n$x=1$\n```\n数学 $f(x)=').kind, 'math');
  assert.equal(sourceKind('上文\n\n$$\n\\frac{').mathBefore, '\n\\frac{');
  assert.equal(sourceKind('$a$ 后文').kind, 'prose');
});

test('Cursor triggers use local intent with a longer dwell than typing', () => {
  const math={kind:'math', before:'定义 f(x)=x^2\n\n$f\'(x)=',after:'$',mathBefore:"f'(x)=",mathAfter:''};
  assert.equal(intentOf(math),'derivation');assert.equal(shouldSuggest(math,'cursor'),true);
  assert.equal(shouldSuggest({...math,mathBefore:'2x'},'cursor'),false);
  assert.equal(shouldSuggest({...math,mathBefore:'\\frac{',mathAfter:'}{y}'},'cursor'),true);
  assert.equal(shouldSuggest({...math,kind:'code'},'input'),false);
  assert.equal(shouldSuggest({kind:'prose',before:'一段完整的句子。',after:'\n\n下一段'},'cursor'),false);
  assert.equal(shouldSuggest({kind:'prose',before:'由此可知：',after:''},'cursor'),true);
  assert.ok(aiDelay({delay:650},math,'cursor')>aiDelay({delay:650},math,'input'));
  assert.ok(aiDelay({delay:650},math,'input')<aiDelay({delay:650},{kind:'prose'},'input'));
});

test('One bounded payload carries both sides, section and math intent', () => {
  const value=completionPayload({before:'b'.repeat(9000),after:'a'.repeat(9000),heading:'h'.repeat(9000),nearby:'n'.repeat(9000),kind:'math',mathBefore:'m'.repeat(9000),mathAfter:'r'.repeat(9000),intent:'argument',apiKey:'secret'});
  assert.equal(value.before.length,4000);assert.equal(value.after.length,1000);assert.equal(value.nearby.length,1800);
  assert.equal(value.heading.length,200);assert.equal(value.mathBefore.length,1800);assert.equal(value.mathAfter.length,1200);
  assert.equal(value.intent,'argument');assert.ok(!JSON.stringify(value).includes('secret'));
});

test('Math cleanup preserves nested arguments and removes only excess closers', () => {
  const context={kind:'math',mathBefore:'\\sqrt{',mathAfter:'}',after:'}$'};
  assert.equal(cleanSuggestion('\\frac{a}{b}',context),'\\frac{a}{b}');
  assert.equal(cleanSuggestion('\\frac{a}{b}$',context),'\\frac{a}{b}');
  assert.equal(cleanSuggestion('x}',context),'x');
  assert.equal(cleanSuggestion('$2x$',{kind:'math',before:"$f'(x)=",after:'$',mathBefore:"f'(x)=",mathAfter:''}),'2x');
  assert.equal(cleanSuggestion('```latex\n2x\n```',context),'');
  assert.equal(cleanSuggestion('解释：求导得到',context),'');
});

test('Math overrun retains the useful expression and discards added prose', () => {
  const context={kind:'math',mathBefore:'\\boxed{F=',mathAfter:'}',after:'}$, 本节讨论离散时间。'};
  assert.equal(cleanSuggestion('\\sum_{t=S}^{T}f_t}$, 其中 $f_t$ 为即时贡献;',context),'\\sum_{t=S}^{T}f_t');
  assert.equal(cleanSuggestion('\\text{cost \\$5}',context),'\\text{cost \\$5}');
});

test('Prose cannot borrow an existing formula opener to close a broken suggestion', () => {
  const context={kind:'prose',before:'仍是随机的，',after:' $dW$。'};
  assert.equal(cleanSuggestion('因为含有随机项 $\\sigma',context),'');
  assert.equal(cleanSuggestion('因为 $dx=gdt+\\sigma dW$ 依赖于布朗运动',context),'因为 $dx=gdt+\\sigma dW$ 依赖于布朗运动');
  assert.equal(cleanSuggestion('价格是 \\$20，且由',context),'价格是 \\$20，且由');
});

test('Typed-through suggestions reuse the remainder only with matching context', () => {
  const context=completionPayload({before:'由此可知，',after:'下一句',kind:'prose',heading:'微分',nearby:'定义'});
  const prior={context,text:'函数可导',time:Date.now()};
  assert.equal(remainingSuggestion(prior,context),'函数可导');
  assert.equal(remainingSuggestion(prior,{...context,before:context.before+'函数'}),'可导');
  assert.equal(remainingSuggestion(prior,{...context,before:context.before+'改变'}),null);
  assert.equal(remainingSuggestion(prior,{...context,after:'其他下文'}),null);
  assert.equal(remainingSuggestion(prior,{...context,heading:'积分'}),null);
});

test('Suggestion cache bounds memory, reuses empty results, and can be cleared', () => {
  const cache=suggestionCache(2);cache.set('first','x');cache.set('empty','');
  assert.equal(cache.get('empty'),'');assert.equal(cache.get('first'),'x');
  cache.set('third','z');assert.equal(cache.get('empty'),undefined);assert.equal(cache.get('first'),'x');
  cache.clear();assert.equal(cache.get('third'),undefined);
});
