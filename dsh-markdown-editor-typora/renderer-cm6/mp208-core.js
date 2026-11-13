// mp208-core.js — MP208-UI pure selection / quote / edit / math payload layer.
//
// No DOM, no CodeMirror import: the caller passes the real CM6 Text object and
// the engine selection read at click time. Kept dependency-free so the same
// functions are used by the renderer and by node:test.
//
// The only authority for text/positions is the engine snapshot. This module
// never truncates a selection silently: a payload that exceeds its budget
// returns an explicit failure and the UI must refuse or ask for an on-demand read.
(function (root) {
  'use strict';

  var MAX_QUOTE_CHARS = 262144;   // native quote composer guard (256 KiB)
  var MAX_EDIT_INLINE = 16384;    // inline snapshot budget (UTF-8 bytes) for a restricted edit
  var MAX_EDIT_BYTES = 32768;     // host readSelection budget / UI hard stop
  var MAX_EDIT_INTENT = 2000;
  var MAX_MATH_BODY = 24000;      // math request body budget
  var MAX_MATH_CONTEXT = 4000;    // neighbour context budget
  var MAX_MATH_LINES = 3;         // neighbour lines on each side

  function byteLength(text) {
    try {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text)).length;
    } catch (error) { /* fall through */ }
    return String(text).length * 2;
  }

  function basename(file) {
    var s = String(file || '');
    var cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return cut >= 0 ? s.slice(cut + 1) : s;
  }

  function lineOf(doc, pos) {
    try { return doc.lineAt(pos); } catch (error) { return null; }
  }

  function lineSpan(doc, ranges, fallbackStart, fallbackEnd) {
    var l0 = Number.isSafeInteger(fallbackStart) ? fallbackStart : null;
    var l1 = Number.isSafeInteger(fallbackEnd) ? fallbackEnd : null;
    if (doc && ranges && ranges.length) {
      var first = lineOf(doc, ranges[0].from);
      var last = lineOf(doc, ranges[ranges.length - 1].to);
      if (first) l0 = first.number;
      if (last) l1 = last.number;
    }
    if (!Number.isSafeInteger(l0) || l0 < 1) l0 = 1;
    if (!Number.isSafeInteger(l1) || l1 < l0) l1 = l0;
    return { lineStart: l0, lineEnd: l1 };
  }

  /** Validate renderer-supplied ranges against the same snapshot length. */
  function normalizeRanges(ranges, docLength) {
    if (!Array.isArray(ranges) || ranges.length === 0) {
      return { ok: false, code: 'NO_SELECTION', message: '没有可引用的选区' };
    }
    if (ranges.length > 64) {
      return { ok: false, code: 'TOO_MANY_RANGES', message: '选区段数过多（最多 64 段）' };
    }
    var out = [];
    for (var i = 0; i < ranges.length; i += 1) {
      var item = ranges[i] || {};
      var from = Number(item.from);
      var to = Number(item.to);
      var text = typeof item.text === 'string' ? item.text : null;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
        return { ok: false, code: 'BAD_RANGE', message: '选区位置无效' };
      }
      if (Number.isSafeInteger(docLength) && to > docLength) {
        return { ok: false, code: 'RANGE_OUT_OF_DOC', message: '选区超出当前快照' };
      }
      if (text === null) text = '';
      if (text.length !== to - from) {
        return { ok: false, code: 'RANGE_TEXT_MISMATCH', message: '选区文本与位置长度不一致' };
      }
      if (out.length && from < out[out.length - 1].to) {
        return { ok: false, code: 'RANGE_OVERLAP', message: '选区段重叠' };
      }
      out.push({ from: from, to: to, text: text });
    }
    return { ok: true, ranges: out };
  }

  function envelopeFromView(view, nonce) {
    if (!view || !view.state || !view.state.doc) {
      return { ok: false, code: 'NO_VIEW', message: '编辑器快照不可用' };
    }
    var state = view.state;
    var ranges = [];
    var parts = [];
    var input = state.selection.ranges || [];
    for (var i = 0; i < input.length; i += 1) {
      var r = input[i];
      var from = Math.min(r.from, r.to);
      var to = Math.max(r.from, r.to);
      if (to <= from) continue;
      var text = state.doc.sliceString(from, to);
      ranges.push({ from: from, to: to, text: text });
      parts.push(text);
    }
    if (!ranges.length) return { ok: false, code: 'NO_SELECTION', message: '没有可引用的选区' };
    var span = lineSpan(state.doc, ranges);
    return {
      ok: true,
      text: parts.join('\n\n'),
      ranges: ranges,
      docLength: state.doc.length,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      lines: state.doc.lines,
      capturedAt: Date.now(),
      nonce: String(nonce || (Date.now().toString(36) + Math.random().toString(36).slice(2))),
    };
  }

  function quotePayload(input) {
    var opts = input || {};
    var rangeCheck = normalizeRanges(opts.ranges, opts.docLength);
    if (!rangeCheck.ok) return rangeCheck;
    var paths = String(opts.path || '').trim();
    var file = basename(paths) || '(未命名文档)';
    var span = lineSpan(opts.doc, rangeCheck.ranges, opts.lineStart, opts.lineEnd);
    var body = opts.text;
    if (typeof body !== 'string') {
      body = rangeCheck.ranges.map(function (r) { return r.text; }).join('\n\n');
    }
    var text;
    if (rangeCheck.ranges.length > 1) {
      text = rangeCheck.ranges.map(function (r, i) {
        return (i ? '\n\n---\n\n' : '') + r.text;
      }).join('');
    } else {
      text = body;
    }
    var sourceLine = '来源：' + (paths || '(未命名文档)') + ' · 第 ' + span.lineStart
      + (span.lineEnd !== span.lineStart ? '–' + span.lineEnd : '') + ' 行';
    var full = sourceLine + '\n\n' + text;
    if (full.length > MAX_QUOTE_CHARS) {
      return {
        ok: false,
        code: 'QUOTE_TOO_LARGE',
        message: '选区过大（' + Math.ceil(full.length / 1024) + ' KB），请缩小范围后再引用',
      };
    }
    var summary = {
      label: file + ' · 第 ' + span.lineStart + (span.lineEnd !== span.lineStart ? '–' + span.lineEnd : '') + ' 行',
      title: text.split(/\r?\n/).find(function (line) { return line.trim() !== ''; }) || file,
      detail: full.length + ' 字符 · ' + rangeCheck.ranges.length + ' 段',
    };
    if (summary.title.length > 120) summary.title = summary.title.slice(0, 117) + '…';
    return {
      ok: true,
      text: full,
      summary: summary,
      meta: {
        kind: 'readonly-quote',
        path: paths,
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        rangeCount: rangeCheck.ranges.length,
        chars: full.length,
        bytes: byteLength(full),
      },
    };
  }

  function editRequest(input) {
    var opts = input || {};
    var intent = String(opts.intent || '').trim();
    if (!intent) return { ok: false, code: 'EDIT_INTENT_REQUIRED', message: '请先填写修改意图' };
    if (intent.length > MAX_EDIT_INTENT) {
      return { ok: false, code: 'EDIT_INTENT_TOO_LARGE', message: '修改意图过长（最多 ' + MAX_EDIT_INTENT + ' 字符）' };
    }
    var rangeCheck = normalizeRanges(opts.ranges, opts.docLength);
    if (!rangeCheck.ok) return rangeCheck;
    var path = String(opts.path || '').trim();
    var selectionId = String(opts.selectionId || '').trim();
    if (!path || !selectionId) return { ok: false, code: 'EDIT_TARGET_MISSING', message: '修改目标缺少文件或选择标识' };
    var span = lineSpan(opts.doc, rangeCheck.ranges, opts.lineStart, opts.lineEnd);
    var text = typeof opts.text === 'string' ? opts.text : rangeCheck.ranges.map(function (r) { return r.text; }).join('\n\n');
    if (byteLength(text) > MAX_EDIT_BYTES) {
      return { ok: false, code: 'EDIT_SELECTION_TOO_LARGE', message: '选区超过 32 KiB，请缩小范围后再修改（模型单次按需读取上限为 32 KiB）' };
    }
    var inlineBudget = Number.isSafeInteger(opts.inlineBudget) ? opts.inlineBudget : MAX_EDIT_INLINE;
    var revision = opts.originRevision === undefined ? '' : (typeof opts.originRevision === 'string'
      ? opts.originRevision : JSON.stringify(opts.originRevision));
    var lines = [
      '【MarkPilot 选区修改】',
      '文件：' + path,
      '选区：第 ' + span.lineStart + (span.lineEnd !== span.lineStart ? '–' + span.lineEnd : '') + ' 行 · selectionId=' + selectionId,
      revision ? '来源版本：' + revision : '',
      '',
      '【用户意图】',
      intent,
      '',
    ];
    var mode;
    if (byteLength(text) <= inlineBudget) {
      mode = 'inline';
      lines.push('【选区原文 · 只读快照】', '```md', text, '```', '');
    } else if (opts.readSelection === true) {
      mode = 'read-on-demand';
      lines.push('选区超出内联预算（' + text.length + ' 字符），未内联原文。',
        '请先调用 markdown 工具 action="readSelection", path=' + JSON.stringify(path)
        + ', selectionId=' + JSON.stringify(selectionId) + ' 读取受限快照，再执行修改。', '');
    } else {
      return {
        ok: false,
        code: 'EDIT_SELECTION_TOO_LARGE',
        message: '选区过大（' + text.length + ' 字符），当前宿主不支持按需读取；请缩小范围后再修改',
      };
    }
    lines.push(
      '请只调用 markdown 工具修改这一处：',
      'action="editSelection"',
      'path=' + JSON.stringify(path),
      'selectionId=' + JSON.stringify(selectionId),
      'newString="<替换后的文本>"（多段用 replacements: ["<段1>", "<段2>"]）',
      '不要改选区之外的任何内容，不要用 write/str_replace 全文改写。',
    );
    var message = lines.join('\n');
    return {
      ok: true,
      mode: mode,
      message: message,
      path: path,
      selectionId: selectionId,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      summary: {
        label: basename(path) + ' · 第 ' + span.lineStart + (span.lineEnd !== span.lineStart ? '–' + span.lineEnd : '') + ' 行',
        title: intent.slice(0, 120),
        detail: mode === 'inline' ? ('内联 ' + text.length + ' 字符') : ('按需读取 · ' + text.length + ' 字符'),
      },
      meta: { kind: 'restricted-edit', mode: mode, chars: message.length, bytes: byteLength(message), selectionChars: text.length },
    };
  }

  function mathPayload(input) {
    var opts = input || {};
    var doc = opts.doc;
    if (!doc) return { ok: false, code: 'NO_VIEW', message: '编辑器快照不可用' };
    var from = Math.max(0, Math.min(Number(opts.from) || 0, doc.length));
    var to = Math.max(from, Math.min(Number(opts.to) || from, doc.length));
    var hasSelection = to > from;
    var end = hasSelection ? to : Math.min(doc.length, from + 400);
    var body = typeof opts.body === 'string' ? opts.body : doc.sliceString(from, end);
    var l0 = doc.lineAt(from).number;
    var l1 = doc.lineAt(end).number;
    var bodyBudget = Number.isSafeInteger(opts.bodyBudget) ? opts.bodyBudget : MAX_MATH_BODY;
    if (body.length > bodyBudget) {
      return {
        ok: false,
        code: 'MATH_SELECTION_TOO_LARGE',
        message: '选区过大（' + Math.ceil(body.length / 1024) + ' KB），数学 AI 暂不支持按需读取；请缩小范围',
      };
    }
    var ask = String(opts.ask || '').trim();
    if (!ask) return { ok: false, code: 'MATH_ASK_REQUIRED', message: '请先填写要问的数学问题' };
    // Neighbour context excludes every selected line, so the selected body can
    // never appear a second time through the context block.
    var before = [];
    var after = [];
    for (var n = l0 - 1; n >= Math.max(1, l0 - MAX_MATH_LINES); n -= 1) before.unshift(doc.line(n).text);
    for (var m = l1 + 1; m <= Math.min(doc.lines, l1 + MAX_MATH_LINES); m += 1) after.push(doc.line(m).text);
    var contextBudget = Number.isSafeInteger(opts.contextBudget) ? opts.contextBudget : MAX_MATH_CONTEXT;
    var context = before.concat(after);
    var used = context.join('\n');
    while (context.length > 0 && used.length > contextBudget) {
      if (before.length >= after.length) { before.shift(); } else { after.pop(); }
      context = before.concat(after);
      used = context.join('\n');
    }
    var header = '📐 数学请求 · ' + String(opts.intentLabel || '数学推理');
    var lines = [
      header,
      '位置：第 ' + l0 + '–' + l1 + ' 行' + (hasSelection ? '（已选中）' : '（光标处起 400 字）'),
      '',
      '【内容】',
      '````md',
      body,
      '````',
    ];
    if (context.length) {
      lines.push('', '【邻文，已排除选区行；第 ' + l0 + '–' + l1 + ' 行不在其中】', '````md', used, '````');
    }
    lines.push(
      '',
      '要求：' + ask,
      '',
      '（这是 MarkPilot 编辑器发出的数学推理请求：内容为 Markdown + LaTeX 源码，'
        + '公式用 $$…$$ 或 $…$。请保留 LaTeX 原样书写，不要在回答里改成图片或纯文本。）',
    );
    var text = lines.join('\n');
    return {
      ok: true,
      text: text,
      meta: {
        intent: String(opts.intent || ''),
        lineStart: l0,
        lineEnd: l1,
        hasSelection: hasSelection,
        bodyChars: body.length,
        contextChars: used.length,
        contextLines: context.length,
        totalChars: text.length,
        totalBytes: byteLength(text),
      },
    };
  }

  function formatQuoteLines(text) {
    return String(text || '').split(/\r?\n/).map(function (line) { return '> ' + line; }).join('\n');
  }

  var api = {
    MAX_QUOTE_CHARS: MAX_QUOTE_CHARS,
    MAX_EDIT_INLINE: MAX_EDIT_INLINE,
    MAX_EDIT_BYTES: MAX_EDIT_BYTES,
    MAX_EDIT_INTENT: MAX_EDIT_INTENT,
    MAX_MATH_BODY: MAX_MATH_BODY,
    MAX_MATH_CONTEXT: MAX_MATH_CONTEXT,
    byteLength: byteLength,
    basename: basename,
    normalizeRanges: normalizeRanges,
    lineSpan: lineSpan,
    envelopeFromView: envelopeFromView,
    quotePayload: quotePayload,
    editRequest: editRequest,
    mathPayload: mathPayload,
    formatQuoteLines: formatQuoteLines,
  };

  if (root) root.__MP208 = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
