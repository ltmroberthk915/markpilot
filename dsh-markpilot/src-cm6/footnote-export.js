/* footnote-export.js — 脚注导出投影（纯函数；不碰 DOM / CM6）。
 *
 * 与编辑器共用 `footnotes.cjs` 这一份语法真源：本模块**只做区间替换**，不再解析 Markdown。
 *   · 引用 → `<sup><a id=refId href="#noteId">[n]</a></sup>`；
 *   · 定义整段从正文移除（保留换行），文末统一生成 `role="doc-endnotes"` 区块；
 *   · 每个出现处一条独立回链（href="#refId"）；重复引用共用 noteId、各自 refId；
 *   · 越界/重复 id/落在代码·数学·链接·围栏里的引用保持原文，不生成活链接；
 *   · 没有被引用的定义原样留在正文，不静默删用户内容。
 *
 * 输出里的 token 只在本趟投影内有效；`expand()` 用正则把 token 换成锚点 HTML。
 * 这样行内 Markdown（强调/公式/图片）仍由原有 inlineMd 一次渲染，不会被引用边界切断。
 */
'use strict';

import { analyzePublic } from './public-markdown.js';
import { inlineCodeSpans, inlineMathSpans, inlineLinkSpans } from './inline-format.js';
import { inlineImageAtoms } from './resource-images.js';
import { markdownLanguage } from '@codemirror/lang-markdown';
import * as footnoteApi from './footnotes.cjs';

const FOOTNOTE_ID = /^[A-Za-z][A-Za-z0-9:_.-]{0,80}$/;
/* 与编辑端同一个已配置 parser（@codemirror/lang-markdown 的 markdownLanguage，
   GFM + Subscript/Superscript/Emoji）；只把 parser 本体交给 footnotes.cjs 取
   InlineCode / CodeBlock 区间，绝不在这里另建第二份 Markdown 解析器。 */
const FOOTNOTE_CODE_PARSER = markdownLanguage.parser;
const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} md 原始 Markdown（UTF-16 offsets 与 footnotes.cjs 一致）
 * @returns {null | {body:string, used:any[],
 *   expand:(html:string)=>string,
 *   endnote:(renderText:(text:string)=>string)=>string}}
 */
export function footnoteExportPlan(md) {
  const collect = footnoteApi && (footnoteApi.collectFootnotes
    || (footnoteApi.default && footnoteApi.default.collectFootnotes));
  if (typeof collect !== 'function') return null;
  // 外层先看有没有脚注语法：没有 "[^" 就不构建语法树（collectFootnotes 内部也会早退）。
  if (md.indexOf('[^') === -1) return null;

  /* 共享 opaque 真源：围栏只信 Lezer `FencedCode`（容器隐式闭合 / 反缩进 / CRLF 都对；
     scanFenceLines 不认注释、CRLF 下 0 block，不能再当第二真源）。有真 HTML 注释时
     同时传 analyzePublic 的 comments/code，注释与代码都由同一趟解析给出。 */
  let input = { parser: FOOTNOTE_CODE_PARSER, authoritative: true };
  if (md.indexOf('<!--') !== -1) {
    try {
      const analysis = analyzePublic(md);
      const comments = [...(analysis.comments || [])].map(c => ({
        from: c.from, to: c.to, block: !!c.block, closed: c.closed !== false,
      }));
      input = { code: [...(analysis.code || [])], comments, authoritative: true };
    } catch { /* 注释分析失败：退回 parser 的 FencedCode/CommentBlock，不信任空 comments */ }
  }
  let raw;
  try { raw = collect(md, input); } catch { return null; }
  if (!raw || !Array.isArray(raw.refs) || !Array.isArray(raw.notes)) return null;

  const starts = [0];
  for (let i = 0; i < md.length; i++) if (md.charCodeAt(i) === 10) starts.push(i + 1);
  const lineAt = (offset) => {
    let low = 0, high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid + 1; else high = mid;
    }
    return low - 1;
  };
  const lineText = (index) => md.slice(starts[index],
    index + 1 < starts.length ? starts[index + 1] - 1 : md.length);

  const notes = [], noteById = new Map();
  for (const note of raw.notes) {
    if (!note || !Number.isInteger(note.from) || !Number.isInteger(note.to)) continue;
    if (note.from < 0 || note.to > md.length || note.from >= note.to) continue;
    if (typeof note.noteId !== 'string' || !FOOTNOTE_ID.test(note.noteId) || noteById.has(note.noteId)) continue;
    const number = Number.isInteger(note.number) && note.number > 0 ? note.number : notes.length + 1;
    const row = { noteId: note.noteId, number, from: note.from, to: note.to,
      text: typeof note.text === 'string' ? note.text : '', refs: [] };
    notes.push(row); noteById.set(row.noteId, row);
  }
  if (!notes.length) return null;

  const refs = [], refIds = new Set();
  for (const ref of raw.refs) {
    if (!ref || !Number.isInteger(ref.from) || !Number.isInteger(ref.to)) continue;
    if (ref.from < 0 || ref.to > md.length || ref.from >= ref.to) continue;
    if (typeof ref.refId !== 'string' || !FOOTNOTE_ID.test(ref.refId) || refIds.has(ref.refId)) continue;
    if (typeof ref.noteId !== 'string' || !noteById.has(ref.noteId)) continue;   // 未解析引用保持原文
    if (notes.some((note) => ref.from < note.to && ref.to > note.from)) continue;
    const line = lineAt(ref.from);
    if (line < 0 || line >= starts.length || lineAt(ref.to - 1) !== line) continue;
    const text = lineText(line), base = starts[line], from = ref.from - base, to = ref.to - base;
    if (inlineCodeSpans(text).some((span) => from >= span.from && to <= span.to)) continue;
    if (inlineMathSpans(text).some((span) => from >= span.from && to <= span.to)) continue;
    if (inlineLinkSpans(text).some((span) => from >= span.from && to <= span.to)) continue;
    const images = inlineImageAtoms();
    let imageHit = false;
    for (let match; (match = images.exec(text));) {
      if (from >= match.index && to <= match.index + match[0].length) { imageHit = true; break; }
    }
    if (imageHit) continue;
    const row = { from: ref.from, to: ref.to, refId: ref.refId, noteId: ref.noteId };
    refs.push(row); refIds.add(ref.refId); noteById.get(ref.noteId).refs.push(row);
  }

  const used = notes.filter((note) => note.refs.length);
  if (!used.length) return null;
  used.sort((a, b) => (a.number - b.number) || (a.from - b.from));
  for (const note of used) note.refs.sort((a, b) => a.from - b.from);

  let tokenPrefix;
  do { tokenPrefix = '\u0000MPFN' + Math.random().toString(36).slice(2, 10); } while (md.includes(tokenPrefix));
  const tokenHtml = new Map(), edits = [];
  for (const note of used) {
    note.refs.forEach((ref, index) => {
      const token = tokenPrefix + note.number + ':' + index + '\u0000';
      tokenHtml.set(token, `<sup class="mp-fn-ref"><a id="${attrEsc(ref.refId)}" href="#${attrEsc(ref.noteId)}"`
        + ` class="mp-fn-ref-link" role="doc-noteref">[${note.number}]</a></sup>`);
      edits.push({ from: ref.from, to: ref.to, text: token });
    });
    edits.push({ from: note.from, to: note.to, text: md.slice(note.from, note.to).replace(/[^\n]/g, ' ') });
  }
  edits.sort((a, b) => b.from - a.from);
  let body = md;
  for (const edit of edits) body = body.slice(0, edit.from) + edit.text + body.slice(edit.to);

  const tokenRe = new RegExp(escapeRe(tokenPrefix) + '[^\\u0000]*\\u0000', 'g');
  return {
    body,
    used,
    expand: (html) => String(html).indexOf(tokenPrefix) < 0
      ? String(html)
      : String(html).replace(tokenRe, (token) => tokenHtml.get(token) || ''),
    endnote: (renderText) => {
      const items = used.map((note) => {
        const text = renderText(String(note.text || '').replace(/\r\n?/g, '\n').split('\n').join(' '));
        const backs = note.refs.map((ref, index) => `<a class="mp-fn-back" href="#${attrEsc(ref.refId)}"`
          + ` role="doc-backlink" aria-label="返回第 ${index + 1} 处引用">↩</a>`).join(' ');
        return `<li id="${attrEsc(note.noteId)}" value="${note.number}"><span class="mp-fn-text">${text}</span>`
          + (backs ? ' ' + backs : '') + '</li>';
      }).join('\n');
      return '<section class="mp-footnotes" role="doc-endnotes" aria-label="脚注">\n'
        + '<hr class="mp-footnotes-sep">\n<ol class="mp-footnotes-list">\n' + items + '\n</ol>\n</section>';
    },
  };
}
