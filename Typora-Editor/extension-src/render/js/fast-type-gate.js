/**
 * fast-type-gate.js —— 纯文本按键的 At-only 快道（R13-S1 乙案：产品侧 preventInput 闸）
 *
 * 机制（vendored index.min.js 实码取证，R13-E 复核）：
 *  - IR 的 input 监听（@202285，冒泡）开头自带 t.preventInput 分支（@202407）：旗真 →
 *    复位 → At(e,{enableAddUndoStack/enableHint/enableInput:!0})，跳过 P 全身（整块序列化
 *    → Spin WASM → outerHTML 重建 → 6 次全文扫）。上游自用三处：粘贴 @71733、checkbox
 *    @202812、insertValue @283057。
 *  - 派发序：whatwg DOM 两遍算法——即使事件 target 就是 root 自身（contenteditable 的
 *    input/beforeinput target=编辑宿主=pre.vditor-reset，每键如此），capture 监听也在
 *    capture 方向那一遍执行，恒先于 vditor 的冒泡监听（jsdom 实证，2026-10-02）。
 *    ⚠ 禁止加「target===root 就放弃」守卫——那会让闸每键空转（R13-E 修订 1）。
 *  - 本闸不抑制事件、不碰 DOM、只置旗：undo 前置记录（patchHistory input 捕获
 *    receivedInput）、数学调度、预览翻转、__mpInputSeen、软换行脚手架清理全部照跑。
 *
 * 谓词两段式：beforeinput 预判（预态）+ input 复核（后态）。任何拿不准的形态一律不置旗
 * → vditor 照旧跑 P → 退化为现状性能，不会错。
 *
 * 回落语义要点（R13-E 实验定谳，Node 跑 vendored lute）：
 *  - 行首 marker-字母表前缀（SYNTAX∪{'.' ' ' '\t'}∪数字，含相邻文本节点回扫）内打任何
 *    字符都回落："- "/"1. "#" "/"# "+首字符在 stock 同一拍物化列表/标题；正文打字（前缀
 *    含普通字符）不受影响。"." 必须在内：DOM2Md 会剥尾空格，"1. "过闸存盘成 "1." 列表
 *    意图即坏（实锤，修订 2）。
 *  - 纯空白/ZWSP 文本节（空段零宽锚点等）内退格回落（修订 3）：该键 stock 走 P 的空块
 *    早退，两路同拍；不让闸去押「Blink 删空块自动补 <br>」的未验假设。
 *
 * 开关：localStorage.mpFastText = 'off'（不装，A/B 与应急）| 'trace'（每键判定环形日志
 * 写 __mpFastTypeGateLog，供验收探针回溯）| 其它（默认启用）。
 * 热路径监听准入单：fast-type-gate beforeinput+input capture ×1，早期退出 =
 * mode/inputType/isComposing 三连 + 一次 closest，标注成本 <0.1ms/键。
 */
export const installFastTypeGate = (api) => {
  if (globalThis.localStorage?.getItem('mpFastText') === 'off') return;   // 单变量开关（A/B 探针用）
  const editor = api.vditor;                 // 内部 IVditor（currentMode 等）
  const ir = editor.ir;                      // IR 实例（.element/.preventInput/.composingLock）
  const root = ir.element;                   // pre.vditor-reset
  if (!root) return;
  const trace = globalThis.localStorage?.getItem('mpFastText') === 'trace';
  const log = trace ? [] : null;
  if (trace) globalThis.__mpFastTypeGateLog = log;   // 探针只读，勿写
  const note = (kind, ev, extra) => {
    if (!log) return;
    log.push({ t: globalThis.performance.now(), kind, type: ev.inputType, data: ev.data ?? null, ...(extra || {}) });
    if (log.length > 64) log.shift();
  };

  // 行首 marker-字母表：SYNTAX ∪ '.' ' ' '\t' ∪ 数字（JS \s 覆盖 U+3000/U+00A0，
  // 全角空格/NBSP 实验定谳：不补全任何语法，归入前缀空白是保守安全向）
  const SYNTAX = new Set('*~$`#>-+=_[]()!<>|{}\\/ \t\n\r');
  const MARKER_CHAR = /[+*>#=|~`_^$!{}()[\]<>\\\/. \t0-9-]/;
  const DEPENDENT_BLOCK = /^(footnotes|link-ref|yaml-front-matter|toc-block)/;
  const FORBIDDEN_HOST = '.vditor-ir__marker,.vditor-ir__preview,code';

  /** 从光标回扫到行首（含相邻文本节点）：前缀非空且全为 marker-字母表字符 → true（回落） */
  const markerOnlyPrefix = (node, off) => {
    let saw = 0;
    let at = node;
    let i = off;
    while (at) {
      const data = at.data;
      while (i > 0) {
        const ch = data[i - 1];
        if (ch === '\n') return saw > 0;      // 行首到：整行前缀全 marker → 回落
        if (!MARKER_CHAR.test(ch)) return false;   // 途中普通字符（含 U+3000/NBSP 之外的正文）
        saw++; i--;                                // ——正文打字在这里快速失败，成本 O(1)
      }
      const prev = at.previousSibling;
      if (prev && prev.nodeType === 3) { at = prev; i = at.length; continue; }   // undo 恢复的相邻文本节点
      break;                                  // 元素/块首 = 行首边界
    }
    return saw > 0;
  };

  /** beforeinput 预判（预态）。返回 armed 记录或 null；任何异常一律 null（失败方向=现状）。 */
  const fastTextArmed = (event, sel) => {
    try {
      if (editor.currentMode !== 'ir' || ir.composingLock || event.isComposing) return null;
      const type = event.inputType;
      if (type !== 'insertText' && type !== 'deleteContentBackward') return null;
      if (!sel || !sel.rangeCount) return null;
      if (!sel.isCollapsed) return null;
      const node = sel.focusNode;
      if (!node || node.nodeType !== 3 || !node.parentElement || !root.contains(node)) return null;
      if (node.parentElement.closest(FORBIDDEN_HOST)) return null;
      let block = node.parentElement;
      while (block.parentNode && block.parentNode !== root) block = block.parentNode;
      if (!block.parentNode || block.parentNode !== root) return null;
      if (/^H[1-6]$/.test(block.nodeName)) return null;                    // outline/ToC 新鲜度
      if (DEPENDENT_BLOCK.test(block.getAttribute?.('data-type') || '')) return null;  // 全文语义块
      const off = sel.focusOffset, len = node.data.length;
      if (type === 'insertText') {
        const data = event.data;
        if (typeof data !== 'string' || Array.from(data).length !== 1) return null;
        if (SYNTAX.has(data)) return null;                                 // 语法字符交给 P/键处理器
        if (markerOnlyPrefix(node, off)) return null;                      // 修订 2：marker 起手回落
        if (off === 0 && node.previousSibling?.nodeType === 1) return null;   // 贴界回落（前邻元素=marker/node 边界）
        if (off === len && node.nextSibling?.nodeType === 1) return null;     // 同上，后邻
        return { inputType: type, data };
      }
      // deleteContentBackward：必须在预态判（后态无法区分块内删/块首跨块合并）
      if (off < 1) return null;                                            // 跨节点/跨块删除回落
      if (!node.data.replace(/[\s\u200b]/g, '')) return null;              // 修订 3：纯空白/ZWSP 节（空段锚点）
      return { inputType: type };
    } catch { return null; }
  };

  /** input 复核（后态，便宜）。通过才置旗。 */
  const fastTextHolds = (event, sel, armed) => {
    try {
      if (editor.currentMode !== 'ir' || ir.composingLock || event.isComposing) return false;
      if (event.inputType !== armed.inputType) return false;
      if (armed.data !== undefined && event.data !== armed.data) return false;   // 修订 4：防 stale armed 配错键
      const node = sel?.focusNode;
      if (!node || node.nodeType !== 3 || !node.parentElement || !root.contains(node)) return false;
      if (node.parentElement.closest(FORBIDDEN_HOST)) return false;   // 删除实际跨进 marker：焦点已在 marker 内 → 回落，vditor 照跑 P 正确处理
      if (armed.inputType === 'insertText') {
        const off = sel.focusOffset;
        return off >= 1 && off <= node.data.length && node.data[off - 1] === armed.data;
      }
      return true;   // 预态 off>=1 已保证删除不跨界；焦点仍在文本节点即可
    } catch { return false; }
  };

  let armed = null;
  root.addEventListener('beforeinput', (event) => {
    armed = null;
    if (event.defaultPrevented || event.isComposing) return;   // 已被拦截的键/组字不碰
    armed = fastTextArmed(event, getSelection());
    if (log && armed) note('armed', event);
  }, true);
  // 注意：不判 event.target===root（target 恒为 root，两遍派发保证捕获恒先于 vditor 冒泡监听）
  root.addEventListener('input', (event) => {
    const a = armed;
    armed = null;
    if (!a) return;
    const sel = getSelection();
    if (fastTextHolds(event, sel, a)) {
      ir.preventInput = true;        // vditor 冒泡监听将走 At-only 分支（@202407）
      note('gated', event, { armed: a });
    } else {
      note('released', event, { armed: a });
    }
  }, true);
};
