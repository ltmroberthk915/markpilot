// history-guard.mjs — 撤销历史保护（外部/远端改动 × 本地 undo/redo）
// 零运行时依赖：由 createHistoryGuard({ state, commands }) 注入 @codemirror/state 与
// @codemirror/commands 的公开成员；产品构建（esbuild）与公开仓 node --test 同一份实现。
//
// 机制（全部 CodeMirror 公开机制）：
//  · foreignSpans StateField 台账，含 remote generation 计数：
//    – bytes：外部写入且仍在文档中的字节区间 [from,to,gen]。本地/撤销/重做的一切事务按
//      切割规则把用户自己的字节剔除（在外部区间内部打字会把区间劈开，撤销后重新愈合）。
//    – zones：外部改动**替换/删除了既有字节**的覆盖区闭环 [from,to,gen]。纯插入不产生
//      zone（外部前缀追加旁的本地撤销必须照常）。zone 只随位置映射、不因本地编辑消失。
//  · 事件来源（provenance）判据——区分"远端写入**之前**创建的旧事件"与"其后用户自己的
//    新事件"：经公开 invertedEffects facet 给每个历史事件存 eventGen（创建时的台账
//    generation；undo/redo 搬运时从 tr.effects 续读原标记取 min，保证对侧孪生不洗白）。
//    危险条件 = 重插/删除落点命中台账区间 **且 eventGen < 该区间的 gen**（事件比覆盖它的
//    远端写入更老）。实测两个方向都有证据：旧事件重插（证明 AB / Key YA / aYX）必须拦；
//    新事件（远端写入后用户删了 Y 后面的空格再 Ctrl+Z）必须照常恢复，不得误挡。
//  · guardedHistory：先用 recorder-dispatch 模拟一步 undo/redo（命令是 {state,dispatch}
//    纯函数，不触碰视图、不发布任何更新）。安全 → 原样放行真命令（既有行为零改动）。
//  · 危险时：把 [模拟出的 undo/redo 交易, 补回外部字节的补偿交易] 作为数组交
//    view.dispatch([...]) —— 安装版 @codemirror/view dist/index.js:7970 的数组分支只产生
//    一次 dispatchTransactions/ViewUpdate；两段净 changes 为恒等 ⇒ ViewUpdate.docChanged
//    === false（dist:1742，!changes.empty），引擎的回声/发布/镜像通道整体不触发，
//    不存在"短暂错误文档"外泄给 autosave/实时对端/插件订阅者。
//  · 历史侧：undo 交易携带 fromHistory，把事件搬到对侧分支；补偿交易 addToHistory:false，
//    把它的纯删除孪生映射为空 ⇒ @codemirror/commands addMappingToBranch 原生丢弃该事件
//    （透明截断该段）。更旧的不相交事件与其后的新编辑照常撤销/重做。
export function createHistoryGuard({ state, commands }) {
  const { StateField, StateEffect, Transaction, EditorSelection } = state;
  const { undo, redo, undoDepth, invertedEffects } = commands;
  if (!StateField || !StateEffect || !Transaction || !EditorSelection || !undo || !redo || !undoDepth || !invertedEffects)
    throw new Error('createHistoryGuard: requires StateField/StateEffect/Transaction/EditorSelection and undo/redo/undoDepth/invertedEffects');

  /** 外部文本落编辑器时随最小 diff dispatch 附带：
   *  { from, to }        — 插入的外部字节（变更后坐标；纯删除时为空区间）
   *  { zoneTo }          — 覆盖区闭环终点（= from + 插入长度）；纯插入（未替换既有
   *                        字节）传 null：外部前缀追加旁的本地撤销必须照常放行。 */
  const foreignMark = StateEffect.define();

  /** 历史事件携带的来源代数（创建时的台账 generation）+ 锚点。仅由 invertedEffects
   *  写入、由危险判据读取；没有字段消费它，对状态零影响。
   *  map 规则：锚点落入后续映射的"替换/删除"区间（f <= pos < t 且 t>f） ⇒ 返回 null
   *  —— mapEffects（state dist L2169-2177）会丢弃它，使补偿交易既清空孪生变更集、
   *  也清掉本标记，事件得以被 addMappingToBranch 原生丢弃。纯插入（f==t）不杀标记：
   *  用户随后在锚点旁打字不影响远端 undo/redo 的来源判定。 */
  const eventGen = StateEffect.define({
    map(value, mapping) {
      let dead = false;
      mapping.iterChangedRanges((f, t) => { if (!dead && t > f && f <= value.pos && value.pos < t) dead = true; });
      return dead ? undefined : { gen: value.gen, pos: mapping.mapPos(value.pos, -1) };
    },
  });

  function gensFrom(effects) {
    let min = null;
    for (const e of effects) if (e.is(eventGen)) min = min === null ? e.value.gen : Math.min(min, e.value.gen);
    return min;
  }

  /** 事件来源代数：undo/redo 搬运时原标记随行（取 min 续存，锚点取本交易首个变更的
   *  插入起点）；全新用户事件取当下台账 gen。返回的是 effect 本身——facet 回调直接
   *  收进数组，不得再包一层 eventGen.of（双重包装会让 map 收到嵌套 effect）。 */
  function eventProvenance(tr) {
    const carried = gensFrom(tr.effects);
    const now = tr.startState.field(foreignSpans, false)?.gen ?? 0;
    const gen = carried === null ? now : Math.min(carried, now);
    let anchor = -1;
    tr.changes.iterChangedRanges((f, t, fb) => { if (anchor < 0) anchor = fb; });
    return eventGen.of({ gen, pos: anchor < 0 ? 0 : anchor });
  }

  const foreignSpans = StateField.define({
    create: () => ({ gen: 0, bytes: [], zones: [] }),
    update(value, tr) {
      let { gen = 0, bytes, zones } = value;
      if (tr.docChanged) {
        bytes = cutSpans(bytes, tr.changes);
        zones = mapZones(zones, tr.changes);
      }
      let marked = false;
      for (const e of tr.effects) {
        if (!e.is(foreignMark) || !e.value || !Number.isInteger(e.value.from) || !Number.isInteger(e.value.to)) continue;
        if (!marked) { gen += 1; marked = true; }            // 同一笔远端交易的所有区间共用一个 gen
        const { from, to, zoneTo } = e.value;
        if (to > from) bytes = addSpan(bytes, from, to, gen);
        if (Number.isInteger(zoneTo) && zoneTo >= from) zones = addSpan(zones, from, zoneTo, gen);
      }
      return bytes === value.bytes && zones === value.zones && gen === value.gen ? value : { gen, bytes, zones };
    },
  });

  /** 注册进 extensions（与 history() 并列）：台账字段 + 事件来源标记。
   *  纯选区/无文档变化的事务必须返回空数组——否则会让它们凭空生成历史事件。 */
  function historyGuard() {
    return [
      foreignSpans,
      invertedEffects.of(tr => tr.changes.empty ? [] : [eventProvenance(tr)]),
    ];
  }

  /** 任意外部变更集 → 标记 effect 数组（live.remote 应用远端多段改动时逐段用）。 */
  function marksForChanges(changes) {
    const marks = [];
    changes.iterChanges((from, to, fromB, toB) => {
      const end = fromB + (toB - fromB);
      marks.push(foreignMark.of({ from: fromB, to: toB, zoneTo: to > from ? end : null }));
    });
    return marks;
  }

  /* bytes 几何：逐个变更区间推进。左幸存段不动；右幸存段换算到变更后坐标；被替换
   * 删除的部分连同新插入文本一并剔除（新插入的是"这笔事务的作者"的字节，不属外部）。
   * 区间携带各自 gen；合并取 max（更晚的远端写入不洗白更早的覆盖）。iterChanges 升序 ⇒
   * 上一变更的后坐标恰为下一变更的前坐标。 */
  function cutSpans(spans, changes) {
    if (!spans.length) return spans;
    let pieces = spans.map(s => [s[0], s[1], s[2]]);
    changes.iterChanges((f, t, fb, tb) => {
      const delta = (tb - fb) - (t - f);
      const next = [];
      for (const [a, b, g] of pieces) {
        if (b <= f) next.push([a, b, g]);
        else if (a >= t) next.push([a + delta, b + delta, g]);
        else {
          if (a < f) next.push([a, f, g]);
          if (b > t) next.push([tb, b + delta, g]);
        }
      }
      pieces = next;
    });
    const out = [];
    for (const [a, b, g] of pieces) if (b > a) insertMerged(out, a, b, g);
    return out;
  }

  /* zones 几何：只随位置映射、不切割（覆盖区标记"来源被改写"，本地编辑不洗白它）。
   * 区间内部被替换时，端点塌缩到插入段边缘，zone 相应收缩；gen 随行。 */
  function mapZones(zones, changes) {
    if (!zones.length) return zones;
    let out = zones.map(z => [z[0], z[1], z[2]]);
    changes.iterChanges((f, t, fb, tb) => {
      const delta = (tb - fb) - (t - f);
      const next = [];
      for (const [a, b, g] of out) {
        const na = a <= f ? a : a >= t ? a + delta : fb;
        const nb = b < f ? b : b >= t ? b + delta : tb;
        if (nb >= na) next.push([na, nb, g]);
      }
      out = next;
    });
    return out === zones ? zones : out;
  }

  function addSpan(spans, from, to, gen) {
    const out = spans.map(s => [s[0], s[1], s[2]]);
    insertMerged(out, from, to, gen);
    return out;
  }

  function insertMerged(list, a, b, g) {
    let i = 0;
    while (i < list.length && list[i][1] < a) i++;
    let na = a, nb = b, ng = g;
    while (i < list.length && list[i][0] <= nb) {  // 相邻(==)或重叠都并：被用户字节劈开
      na = Math.min(na, list[i][0]);               // 的外部段在字节移除后重新相连
      nb = Math.max(nb, list[i][1]);
      ng = Math.max(ng, list[i][2]);               // 合并取较新 gen：不因并段放过旧事件
      list.splice(i, 1);
    }
    list.splice(i, 0, [na, nb, ng]);
  }

  /* 危险判据（模拟步 vs 台账，同坐标系；gen = 事件来源代数，缺失按最老 0 处理）：
   * reinsert：步含真实文本重插入，落点在外部字节区间内部/起点或覆盖区闭环内（含两端），
   *   且 eventGen < 该区间 gen（事件比覆盖它的远端写入更老）。
   *   —— 新事件（远端写入后用户自己的删除/输入）gen ≥ 区间 gen，照常放行。
   * delete：步的删除段与外部字节区间严格相交（贴边不算——same-span 的
   *   "undo 只删自己的 x、保住对方的 Q" 必须放行）。新事件的撤销删不到外部字节，
   *   此规则只可能命中被远端写入退化的旧事件，无需 gen。 */
  function stepDanger(step, ledger) {
    if (!ledger.bytes.length && !ledger.zones.length) return null;
    const gen = gensFrom(step.effects) ?? 0;
    let reason = null;
    step.changes.iterChanges((fromA, toA, fromB, toB) => {
      if (reason) return;
      const inserted = toB - fromB > 0, deleted = toA - fromA > 0;
      if (inserted) {
        for (const [sa, sb, sg] of ledger.bytes) {
          if (((fromA < sb && toA > sa) || toA === sa) && gen < sg) {
            reason = { kind: 'reinsert', from: fromA, to: toA, span: [sa, sb], gen, spanGen: sg }; return;
          }
        }
        for (const [za, zb, zg] of ledger.zones) {
          if (toA >= za && toA <= zb && gen < zg) {
            reason = { kind: 'reinsert', from: fromA, to: toA, span: [za, zb], gen, spanGen: zg }; return;
          }
        }
      }
      if (deleted) {
        for (const [sa, sb] of ledger.bytes) {
          if (fromA < sb && toA > sa) {
            reason = { kind: 'delete', from: fromA, to: toA, span: [sa, sb], gen }; return;
          }
        }
      }
    });
    return reason;
  }

  /* 守卫执行：安全放行；危险则单次数组 dispatch（undo 步 + 补偿），净文档逐字节不变。 */
  function guardedHistory(view, kind, opts = {}) {
    const command = kind === 'redo' ? redo : undo;
    const state0 = view.state;
    const ledger = state0.field(foreignSpans, false) || { gen: 0, bytes: [], zones: [] };
    let step = null;
    if (!command({ state: state0, dispatch: tr => { if (!step) step = tr; } })) return false;
    const why = stepDanger(step, ledger);
    if (!why) return command(view);
    const before = state0.doc.toString(), selection = state0.selection;
    const bad = step.state.doc.toString();
    if (bad !== before) {
      const comp = step.state.update(restoreSpec(bad, before, selection));
      view.dispatch([step, comp]);
    }
    if (opts.notify) { try { opts.notify(why); } catch { /* 提示通道绝不能反噬编辑 */ } }
    return true;
  }

  /** 与 command-context.js applySourceHistory 同形（含 undo 前选择记录），可直接替换其调用。 */
  function guardedSourceHistory(view, kind, opts = {}) {
    if (kind === 'undo' && undoDepth(view.state))
      view.dispatch(view.state.update({ selection: view.state.selection, userEvent: 'select' }));
    return guardedHistory(view, kind, opts);
  }

  /** 只读探针：此刻再按 undo/redo 是否会踩外部区间（reload/远端应用后主动提示用）。 */
  function pendingDanger(state) {
    const ledger = state.field(foreignSpans, false) || { gen: 0, bytes: [], zones: [] };
    const probe = command => {
      let tr = null;
      if (!command({ state, dispatch: t => { if (!tr) tr = t; } })) return null;
      return stepDanger(tr, ledger);
    };
    return { undo: probe(undo), redo: probe(redo) };
  }

  /** 补回外部字节的最小 diff 事务（addToHistory:false；端点落进替换区间塌缩到起点）。 */
  function restoreSpec(bad, target, selection) {
    const minLen = Math.min(bad.length, target.length);
    let start = 0;
    while (start < minLen && bad.charCodeAt(start) === target.charCodeAt(start)) start++;
    let endBad = bad.length, endNew = target.length;
    while (endBad > start && endNew > start && bad.charCodeAt(endBad - 1) === target.charCodeAt(endNew - 1)) { endBad--; endNew--; }
    const insert = target.slice(start, endNew);
    const dLen = insert.length - (endBad - start);
    const mapP = p => p <= start ? p : (p >= endBad ? p + dLen : start);
    return {
      changes: { from: start, to: endBad, insert },
      selection: EditorSelection.create(
        selection.ranges.map(r => EditorSelection.range(mapP(r.anchor), mapP(r.head))), selection.mainIndex),
      annotations: Transaction.addToHistory.of(false),
      scrollIntoView: false,
    };
  }

  return { foreignMark, foreignSpans, historyGuard, marksForChanges, guardedHistory, guardedSourceHistory, pendingDanger, restoreSpec };
}
