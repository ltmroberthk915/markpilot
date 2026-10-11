# 一、一阶逻辑简介

## 一、基本定义

### 1.1 Def 构建基础

> 称一组对象构成的集合称为**论域** $D$.

> **(1) Variable(变量)**
> **Variable(变量)** $x$ 是一个符号, 在 $D$ 中取值即 $x\in D$.
> $x$ 可以理解为一个待赋值占位符.
> 存在一类特殊占位符 $c$, 恒指向 $D$ 中固定元素, 称为constant(常量).

> **(2) Function函数**
> **Function(函数)** 定义为 $f:D^n\to D$.
> 可以通过对常量、变量进行复合, 而其结果仍留在论域 $D$ 中.

> **(3) Term项**
> Function 复合后的结果称为**Term(项)**.
> Term 要么是variable 或 constant不经function复合的直出结果, 本身而不可再分, 则 variable 和 constant 又可称为atomic term (原子项);  要么是variable 和 constant 经 function 复合表达的结果, 称为 composed term (复合项).
>
> 对于 Term, 只要其构造中存在variable, 则称为open term (开项), 反之为 closed term (闭项).
> 直觉: 如果某项恒由论域 $D$ 中固定元素复合而成, 则也指向论域 $D$ 某个固定元素, 则称其为 closed term; 反之若一个 term 的构成中还有待赋值要素, 则称为 open term.
>
> 注意, 单独给出一个 term 是**无法讨论其真假性**.  term 仅指代一个已赋值或待赋值的论域中的对象.

> **(4) Formula公式**
> 通过**谓词P**(表属于/属性的词), 直接组合 term 为 **Atomic Formula(原子公式)**.
> Atomic Formula 都是一个**能讨论真假**的‘“判断句”(或“陈述句”).
> 陈述句都可转换为判断句, 如: "$x$ 小于 $y$ " 等价于 "$(x,y)\in SmallerPairSet$."
>
> 使用逻辑连接词 $∧,∨,¬,→$ 和量词$∀,∃$,  由原子公式构建的**Composed formula(复合公式)**.
>
> Formula 中所有变量都被量词绑定后, 称为 Closed Formula(闭公式). 只有闭公式才能在给定论域下必然断言真假！
> 如复合公式 $P(x)∧¬Q(x)$ 无法判断真假, 无量词绑定, 为open formula;
> 而复合公式 $\forall x\in D\big(P(x)\big)$ 绑定考察所有论域中的元素 $x$, 为closed formula, 必然可以判断真假.

### 1.2 Def 蕴含式

> 两个formula $P,Q$ 通过逻辑连接词 $\to$ 链接, 构成的复合公式 $P\to Q$ 专称为一个**Implication(蕴含式)**. 其中 $P$ 为前件, $Q$ 为后件.

### 1.3 Prop 蕴含式及其否定的等价析取合取转换

> 对于**封闭的蕴含式**, 其真值规定:
> (1) 蕴含式为假: 当且仅当 $P真\to Q假$.  (即当且仅当直接违反条件P触发反馈Q的规则才矛盾!)
> 即定义封闭蕴含式的否定为：$\boxed{¬(A→B)\Leftrightarrow A∧¬B}$.
>
> (2) 蕴含式为真: 只要前件假或后件真就一定真 $\boxed{A\to B\,\Leftrightarrow\,\neg A\lor B}$
> 前件假: 假言使条件不触发, 则规则执行与否是永无法证伪的**虚真**. 事实上，假言可推出任何结论, 即**矛盾爆炸**;
> 后件真: 都执行反馈时, 若条件触发, 则吻合规则. 若条件未触发则回到虚真情况.
>
> 注意这与语义上的条件句不同, 蕴含式只关心真值关系，不要求 $P$ 与 $Q$ 之间有内容或因果联系. 条件句可能包含更多含义（如反事实、因果、相关性等），这些不一定能被实质蕴含完全捕捉. 比如下面这个荒谬的自然语句仍然可能为真.

### 1.3 Example

> 形式化拆解这句话的逻辑
> **"阳光公寓里，如果一个未成年人有棋友，那么他对门邻居家有宠物。"**
>
> 定义：
>
> **论域 D**：阳光公寓里所有的住户，
> **变量（Variables）**：`x`、`y`，代表阳光公寓里中某一住户，具体是谁虚位以待.
> 一元**函数** $oppo\_neigh(x)$：x 的对门邻居, 当下这个函数的结果是复合开项.
>
> 谓词：$Juvenile()$: 单个项是未成年人 $\in Junvenile$; $ChessMate(,)$: 两个项是棋友关系, 即 $(,)\in ChessMate$，HasPet(): 单个项是有宠物的人 $\in HasPet$
> 谓词构成的公式(判断句): $Juvenile(x)$ 表示 $x$ 为未成年人, $ChessMate(x,y)$ 表示 $x,y$ 为棋友.
>
> 则上述自然语言的形式化翻译为：
> $\forall x \in D \Big( \big(Juvenile(x) \land \exists y \, ChessMate(x, y) \big)\to HasPet\big(oppo\_neigh(x)\big)\Big)$
>
> 注意, 虽然 $Juvenile(x) \land \exists y ChessMate(x, y)$ 为开公式, 但由于 $x$ 被 $\forall x$ 赋值, $y$ 被 $\exists y$ 赋值, 所以整个复合公式所有变量都被量词绑定为closed, 可以断言真假.

## 二、逻辑蕴含的基本运算规则

注意, 在1.2中, 我们使用了 $\Leftrightarrow$ 表示两个闭公式的等价性. 一般地, $\Rightarrow$ 表示公式之间的逻辑蕴含, 注意与公式内的实质(语义)蕴涵 $\to$ 做区分.

### 2.1 Prop 量词的否定穿越翻转

> (1) $\neg\forall x  P(x)\Leftrightarrow \exists x  \neg P(x)$, 则证假 $\forall x  P(x)$ 等价于找反例 $\exists x  \neg P(x)$;
> (2) $\neg\exists  x  P(x)\Leftrightarrow \forall x  \neg P(x)$

### 2.2 Prop 量词换序

> 注意交换量词顺序, $\forall x\exists y$ 与 $\exists y\forall x$ 不等价:
> $\exists y\forall x\Rightarrow \forall x\exists y$ 但反之不成立: $\forall x\exists y$ 暗含第二位特称量词的量词变量 $y$ 依赖于第一位的全称量词的量词变量 $x$.

### 2.2 Prop 量词、析取合取的常用结论

> (1) 取特例与还原特例: $\exists x P(x)\Leftrightarrow P(a)$
> (2) 代入特例: $\forall x P(x)\Rightarrow P(a)$
> (3) 全称推特称: $\forall x P(x)\Rightarrow \exists x P(x)$ (由1和2显然)
>
> (3) 挑出合取: $P\land Q\Rightarrow P$
> (4) 引入析取: $P\Rightarrow P\lor Q$
>
> (5) 假言三段论: $P\to Q$, $Q\to R$ $\Rightarrow P\to R$
> (6) 析取三段论: $P\lor Q$, $\neg P$ $\Rightarrow Q$
>
> 显然有推论:
> (7) $\exists (P\land Q)$, $\forall (Q\land R)$ $\Rightarrow \exists (P\land R)$ (取特例, 代入特例, 假言三段论, 还原特例可得)
> (8) $\exists (P\to Q)$, $\forall (Q\to R)$ $\Rightarrow \exists (P\to R)$

> 例: 已知3个真命题 $\exists x (P(x)\land Q(x))$; $\forall x(Q(x)\to\neg R(x))$; $\forall x (S(x)\to R(x))$. 求证 $\exists x P(x)\land \neg S(x)$.
> 证:
> (i) $\exists x P(x)\land Q(x)$ 取特例 $\Rightarrow P(a)\land Q(a)$ 挑出合取 $\Rightarrow Q(a),P(a)$
> (ii) $\forall x Q(x)\to \neg R(x)$ 代特例 $\Rightarrow Q(a)\to \neg R(a)$.
> (iii) $\forall x S(x)\to R(x)$ 蕴含式逆否 $\Rightarrow \forall x \neg R(x)\to \neg S(x)$ 代特例 $\Rightarrow \neg R(a)\to \neg S(a)$.
>
> 结合 (ii) (iii) 假言三段论: $Q(a)\to \neg R(a), \Rightarrow \neg R(a)\to \neg S(a)\Rightarrow Q(a)\to \neg S(a)$
> 再结合 (i) 分离规则: $Q(a)$, $Q(a)\to \neg S(a)$ $\Rightarrow \neg S(a)$.
> 合取: $P(a)\land \neg S(a)$, 再还原特例得证: $\exists x P(x)\land \neg S(x)$.

### 2.4 Prop 受限量词及结论

> 受限量词的形式化翻译: 自然语言"有"
> (1) “对于**有些** $A$ 中 $x$, 有 $P(x)$"  这个命题等价于合取: $\exists x((x\in A)\land P(x))$,
> 在数学表达中，常被包装为语法糖: $\exists x\in A,有 P(x)$
> (2) “对于**所有** $A$ 中 $x$, 有 $P(x)$"  这个命题等价于蕴含式: $\forall x((x\in A)\to P(x))$
> 在数学表达中，常被包装为语法糖:  $\forall x\in A,有 P(x)$.

> 受限量词的否定: 范围不动, 翻量词否内核
> (1)
>
> $$
> \neg\,\exists x\in A, P(x)\;\Leftrightarrow\;\forall x\in A, \neg P(x)
> $$
>
> (2)
>
> $$
> \neg\,\forall x\in A, P(x)\;\Leftrightarrow\;\exists x\in A, \neg P(x)
> $$
>
> 证:
>
> (1)

> $$
> \neg\,\exists x\in A, P(x)\;\underset{\text{还原语法糖 }}{\Leftrightarrow}, \neg\exists x\big(x\in A\land P(x)\big)
> \;\underset{\text{否定穿越}}{\Leftrightarrow}\;\forall x\,\neg\big(x\in A\land P(x)\big)
> \;\underset{\text{德摩根}}{\Leftrightarrow}\;\forall x\big(x\notin A\lor\neg P(x)\big)
> \;\underset{\text{蕴含式的析取等价}}{\Leftrightarrow}\;\forall x\big(x\in A\to\neg P(x)\big)
> \;\underset{\text{语法糖}}{\Leftrightarrow}\;\forall x\in A, \neg P(x)
> $$

> (2)
>
> $$
> \neg\,\forall x\in A, P(x) \;\underset{\text{还原语法糖 }}{\Leftrightarrow}, \neg\forall x\big(x\in A\to P(x)\big)
> \;\underset{\text{否定穿越 }}{\Leftrightarrow}\;\exists x\,\neg\big(x\in A\to P(x)\big)
> \;\underset{\text{蕴含式否定}}{\Leftrightarrow}\;\exists x\big(x\in A\land\neg P(x)\big)
> \;\underset{\text{语法糖}}{\Leftrightarrow}\;\exists x\in A, \neg P(x)
> $$

## 三、一阶逻辑的规范化: 由一个例子引入

我们从一个具体问题讨论一阶逻辑.
怎么找下述语句的逆否命题?
$\exists x (\forall y P(x,y) \to \exists x Q(x,y))$

首先, 这个公式本身存在混淆, 我们逐步分析这个formula的语法树.

### 3.1 Def 量词: 辖域、约束变量、命题

> **量词变量**:
> 即 $\exists x、 \forall x$ 中的 $x$ 这个被量化的变量.
>
> 量词**辖域**:
> (1) 量词变量后若无括号，则量词辖域是紧随其后的最短合法公式;
> (2) 若量词变量后紧跟左括号“$($”，则其辖域延伸至与之匹配的右括号“$)$”内的整个子公式
>
> 例如, 量词 $\exists x$ 的辖域为整个蕴含式 $(\forall y P(x,y) \rightarrow \exists x Q(x,y))$. 其中
> 蕴含式前件 $∀y$ 的辖域为其后的 $P(x,y)$
> 蕴含式后件 $\exists x$ 的辖域为其后的 $Q(x,y)$

> **约束出现和自由出现**
> (1) 变量 $x$ 的某次出现位于单层量词辖域即 $∀x(\cdot)$ 或 $∃x(\cdot)$ 内, 且 $x$ 为该辖域量词变量, 则该次出现为**约束出现**. 有效约束范围为单层量词辖域.
> (2) 变量 $x$ 的某次出现, 同时位于多个嵌套的量词辖域内, 且某层辖域以 $x$ 为量词变量, 则该次出现也为**约束出现**. 有效约束范围仅为: 最内层(即最近)的以 $x$ 为量词变量的辖域, 不管外层辖域是否也以 $x$ 为量词变量, 如 $\forall x(...\forall x...(\forall x))$.
>
> (3) 若无上述两种情况, 则成为**自由出现**.
>
> 全称量词 $∀$ 有效约束范围内, 有一个为假都为假(真要求全真);
> 特称量词 $\exists$ 有效约束范围内, 有一个为真都为真(假要求全假),

> **约束变量和自由变量**
> 若变量 $x$ 在整个公式中的**所有出现**, 均在**某个(相互嵌套)辖域被约束**, 则称其为**约束变量**.
> 反之, 若变量 $y$ 在整个公式中存在**自由出现**, 即该出现不被任何(相互嵌套)辖域约束, 则称其为**自由变量**.
>
> 显然一个变量在公式中要么是自由变量要么是约束变量.
> 注意自由变量 $y$ 的其他出现可能在某个辖域内不自由.
>
> 例如, 原公式 $\exists x (\forall y P(x,y) \to \exists x Q(x,y))$ 中,
> $x$ 在前件的出现虽为被内层辖域约束, 但在辖域嵌套中, 被外层量词约束. 而在后件的出现被后件的量词辖域约束. 因此 $x$ 是约束变量;
> $y$ 在前件的出现被约束, 但 $y$ 在后件的嵌套量词辖域内不受约束, 因此后件中的 $y$ 是**自由出现**, 则由于整个公式中存在 $y$ 的自由出现，所以 $y$ 是该公式的一个**自由变量**.
>
> 事实上, 对于自由变量的某次约束出现, 可通过后面将要介绍的 $\alpha$-变换, 在换掉自由变量的约束出现的名称(即替换该辖域的量词变量), 使得自由变量的出现缩减, 仅保留其自由出现, 消除同名约束干扰, 实现自由变量在所有辖域都自由.
>
> (3) 对于无量词公式, 其内部的variable均为自由变量.

> 对于不存在自由变量的公式称为**闭公式（Closed Formula）**又称**命题(Statement)**, 只有两大类情况:
> (a) 不包含variable的原子公式: constant替换formula的所有variable, 如 $P(a)$
> (b) 所有变量都被量词约束的量词公式: 如 $\forall x P(x)$.
>
> 量词约束在逻辑连接后的独立延续性:
> 如果变量 $x$ 在公式 $S$ 中的**某次**出现是受量词约束的，那么在合取式 $S∧T$  中，$x$ 在 $S$ 内的**这次**出现仍然受 $S$ 中相同的量词约束. 但 $x$ 在 $T$  中的任何出现完全不受 $S$ 中量词的影响, 在 $T$ 中这些出现可能是自由的，也可能受 $T$ 中自身的量词约束（如果 $T$  中有绑定 $x$ 的量词）.
> $∨,→$ 同样如此.

再考察原公式: $\exists x (\forall y P(x,y) \to \exists x Q(x,y))$, 有两个问题:

(1) 由于外层量词 $\exists x$ 的辖域为整个蕴含式 $(\forall y P(x,y) \rightarrow \exists x Q(x,y))$, 而蕴含式后件 $\exists x$ 的辖域为其后的 $Q(x,y)$. 注意, 后件中 $x$ 的出现仅受后件辖域约束, 因此外层量词虽然在语法上辖域覆盖整个蕴含式，但由于内层 $∃x$ 的遮盖，其有效约束实际上仅作用于前件中的 $x$ 的出现, 这虽然在语法上是合法的, 但存在语义上的**变量遮盖（variable shadowing)**:
内层量词 $∃x$ 在后件中重新绑定了 $x$. 使得内层的 $x$ 是一个全新的局部变量，与外层的 $x$ 无关，外层绑定的 $x$ 被“遮盖”而无法访问, 这容易导致歧义! 同时造成变换困难：在进行逻辑等价变换（如求逆否命题）时，如果不先消除变量遮盖，可能导致量词作用域错误地扩展或收缩，从而改变公式的含义.

(2) $y$ 在后件的出现不被任何辖域约束, 因此其为自由变量, 而在前件辖域中 $y$ 被约束. 但相同的名称容易让人误解为它们指的是同一个对象, 而可能错误地认为后件中的 $y$ 与前件的 $y$ 存在某种联系而也被约束，但实际上后件 $y$ 完全不受任何量词限制.

因此我们要对变量重命名: $α$-变换.

### 3.2 Def  $α$-变换(重命名)

> 在公式中, **$α$-变换**是指:
> 在某个量词的有效约束范围内(辖域的子集), 将其中的所有约束出现, 系统替换为一个"全新的"未在**整个公式**其他任意地方出现过的变量名. 即新名字满足:
> (1) 既不和公式其他辖域的量词变量重名(否则造成变量遮盖),
> (2) 也不“意外捕获”公式中原本的自由变量, 以导致该自由变量被错误约束, 如 $∀x (P(x) ∧ Q(y))$ 中约束变量 $x$ 不可重命名为 $y$. 这导致自由变量 $y$ 的自由性被捕获.
>
> 总之, 约束变量在其被约束的辖域内就像一个临时代号, 只要在整个辖域内统一把这个代号换成另一个没被整个公式其他地方用过的代号, 整个语句表达的逻辑结构丝毫没有改变. 而自由变量则完全不同，它的含义因外部赋值不同而变化，不能随意更改. $α$-变换之后, 每个辖域就好比编程中的循环, 其紧跟的被约束的变量就好比迭代变量 $i,j,k$, 而自由变量类似全局变量, 不可被重命名破坏原义.
>
> 也由此可见，闭公式(语句)中约束变量的具体命名是无关紧要的(因为可任意 $α$-变换而不改含义)，但自由变量的名称承载着外部语义, 不可随意更改. 因此, 闭公式的逻辑结构(而非变量名)才是其语义的核心.
>
> 则公式规范化时，可对**所有需要变换的量词逐一执行 $α$-变换**(变换顺序无关紧要, 但实操中仍建议先从内层更换). 回到例子:

由此对于原公式 $\exists x (\forall y P(x,y) \to \exists x Q(x,y))$:
(1) 针对约束变量 $x$ 在后件 $\exists x Q(x,y)$ 的量词有效约束范围的约束出现, 替换为 $z$. 即 $\exists z Q(z,y)$.
则原命题澄清为: $\exists x (\forall y P(x,y) \to \exists z Q(z,y))$, 消除了变量遮盖的歧义.
(2) 针对前件 $∀yP(x,y)$ 中与后件自由变量 $y$ **同名**的约束出现, 将其量词变量 $y$ 替换为 $w$. 即 $\forall w P(x, w)$.
则原命题规范为: $\exists x (\forall w P(x, w) \to \exists z Q(z,y))$, 保证了自由变量的独立性.

此时原命题的逆否**仅需对蕴含式变换, 而最外面量词 $\exists x$ 结构保持不变**. $\exists x (\neg\exists z Q(z,y)\to \neg\forall w P(x,w) )\equiv\exists x (\forall z \neg Q(z,y)\to \exists w \neg P(x,w) )$

## 四、一阶逻辑的化简

### 4.1 Prop 前束范式化简

> 一般地, 对于命题的化简, 我们需要最终得到所有量词位于公式最外层，形成**前束范式（prenex normal form）**:$Q₁x₁ Q₂x₂ … Qₙxₙ M$，其中 $Qᵢ$ 为量词，$M$ 为不含量词的母式.
>
> 这依赖一系列等价变换规则, 将量词移出蕴含式或将逻辑连接符进入量词:

> **(1) 否定穿越变号规则**:
> $¬∀x P \Leftrightarrow  ∃x ¬P$
> $¬∃x P \Leftrightarrow  ∀x ¬P$
>
> **(2) 合取、析取的量词提取**:
> $(∀x P)∧Q\Leftrightarrow ∀x(P∧Q)$（若 $x$ 在 $Q$ 中没有自由出现）
> $(∃x P)∧Q\Leftrightarrow ∃x(P∧Q)$（若 $x$ 在 $Q$ 中没有自由出现）
> $(∀x P)\lor Q\Leftrightarrow ∀x(P\lor Q)$（若 $x$ 在 $Q$ 中没有自由出现）
> $(∃x P)\lor Q\Leftrightarrow ∃x(P\lor Q)$（若 $x$ 在 $Q$ 中没有自由出现）
>
> 注意:
> 若在被提取部分 $Q$ 中有 $x$ 的自由出现, 则提取量词会导致辖域扩张, 将自由出现错误地变为约束出现，改变公式含义. 此时必须先用 $α$-变换将 $P$ 中量词变量 $x$ 重命名为一个全新的、在当前公式中任何地方都未出现过的变量名 $x'$, 在确保 $x'$ 在 $Q$ 中没有自由出现后，再安全地应用量词提取规则:
> $(∀x' P(x'))∧Q(x)\Leftrightarrow ∀x'(P(x')∧Q(x))$
>
> **(3) 蕴含式的量词提取**:
> (3.1) 当量词在后件 $B$ 时, 直取量词：因为 $A$ 作为前提，量词提前，不改变连词 $\text{if}$ 与 $A$ 的相邻关系.
> $A→∀xB(x)\Leftrightarrow ∀x(A→B(x))$，条件：$x$ 在 $A$ 中没有自由出现
> $A→∃xB(x)\Leftrightarrow ∃x(A→B(x))$，条件：$x$ 在 $A$ 中没有自由出现
> (3.2) 当量词在前件 $A$ 时, 翻转量词：提取量词相当于推入句首连词 $\text{if}$, 使 $\text{if}$ 与 $A$ 不相邻.
> $∀xA→B\Leftrightarrow ∃x(A→B)$，条件：$x$ 在 $B$ 中没有自由出现
> $∃xA→B\Leftrightarrow ∀x(A→B)$，条件：$x$ 在 $B$ 中没有自由出现
> 推导:
> $∀xA→B:逆否\Leftrightarrow ¬B→¬∀xA:穿越量词翻转\Leftrightarrow ¬B→∃x¬A:直取后件量词\Leftrightarrow ∃x(¬B→¬A):逆否\Leftrightarrow ∃x(A→B)$
> 理解:
> "大家都做完作业，零食就到位" 等价于 ”只要有一个没做完的，零食没给就别怪我“)

> 重复上述规则直到：$Q₁x₁ Q₂x₂ … Qₙxₙ M$，其中 $Qᵢ$ 为量词，$M$ 为不含量词的母式.
> 母式 $M$ 里的所有变量, 在 $M$ 内都是自由出现（相对于整个公式而言，它们其实被前缀中的量词约束，但仅看 $M$ 本身， $M$ 内部没有任何量词会绑定）

由此, 对于原公式的逆否, 我们可以进一步提取量词:
$\exists x (\forall z \neg Q(z,y)\to \exists w \neg P(x,w) )$, 由于 $z$ 在后件中没有出现, 显然不会是自由出现; 同理 $w$ 没有在 前件中出现, 因此不是自由出现, 则有 $\Leftrightarrow \exists x (\exists z( \neg Q(z,y)\to \exists w \neg P(x,w)))\Leftrightarrow \exists x \exists z\exists w( \neg Q(z,y)\to  \neg P(x,w))$

### 4.2 Prop 量词蕴含式的否定、量词合析取式的否定

> **(1) 量词蕴含式的否定**:
> 否定蕴含式命题为 $¬(A→B)$ , 而非取其否命题 $¬A→¬B$.
>
> 考虑全称蕴含式：$∀x(P(x)→Q(x))$ 其否定为 $¬∀x(P(x)→Q(x))$
> 根据否定号穿越量词导致量词反转，等价于 $∃x¬(P(x)→Q(x))$
> 而由蕴含式的否定定义为：$¬(A→B)\Leftrightarrow A∧¬B$，所以有 $∃x(P(x)∧¬Q(x))$
>
> 同理有 $¬∃x(P(x)→Q(x))\Leftrightarrow ∀x(P(x)∧¬Q(x))$
>
> **(2) 合取析取式的量词等价变换**
> $\neg\Big(∀x(P(x)∧Q(x))\Big)\Leftrightarrow ∃x(¬P(x)∨¬Q(x))$
> $\neg\Big(∃x(P(x)∧Q(x))\Big)\Leftrightarrow ∀x(¬P(x)∨¬Q(x))$
> (即否定号直接穿越量词, 后面应用**德摩根律**)

### 4.3 Example 前后件均有量词的例子

> 原命题：$∀x(∀yP(x,y)→∃zQ(x,z))$
> 逆命题：$∀x(∃zQ(x,z)→∀yP(x,y))$
> 否命题：$∀x(¬∀yP(x,y)→¬∃zQ(x,z))\Leftrightarrow ∀x(∃y¬P(x,y)→∀z¬Q(x,z))$
> 逆否命题：$∀x(¬∃zQ(x,z)→¬∀yP(x,y))\Leftrightarrow ∀x(∀z¬Q(x,z)→∃y¬P(x,y))$
> 原命题的否定: Z$\neg∀x(∀yP(x,y)→∃zQ(x,z))\equiv∃x(∀yP(x,y)\land ∀z\neg Q(x,z))$
