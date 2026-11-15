/* 脚注 2/3 的耐久回归（单文件，可放在 R/dsh-markpilot/test 或 R/tools/quality/tests）。
 *
 * 覆盖三条用户可见性质，不重复平台/headless 条目：
 *   1. 顶层未闭合 HTML 注释：文末插入必须拒绝，且不产生任何 changes；
 *   2. 引用内未闭合围栏随引用结束：插入应成功，并成为真正可导出的脚注；
 *   3. 导出真实锚点：endnote/ref 的 id/href 必须与 footnotes.cjs 的约定一致。
 *
 * 只 import 产品纯模块（planner + export plan），不启动 app、不碰 DOM。
 * 路径从本文件向上找仓库根，因此放到上述两个目录都能跑：
 *   node --test footnotes-durable.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot() {
  let dir = HERE;
  for (;;) {
    const marker = path.join(dir, 'dsh-markpilot', 'src-cm6', 'footnotes-view.js');
    if (fs.existsSync(marker)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('未找到仓库根（缺少 dsh-markpilot/src-cm6/footnotes-view.js）');
    dir = parent;
  }
}

const ROOT = findRepoRoot();
const load = relative => import(pathToFileURL(path.join(ROOT, relative)).href);
const { planFootnoteInsertion } = await load('dsh-markpilot/src-cm6/footnotes-view.js');
const { footnoteExportPlan } = await load('dsh-markpilot/src-cm6/footnote-export.js');

function applyChanges(text, changes) {
  let out = text;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.from);
  }
  return out;
}

const UNCLOSED_COMMENT = 'Sample text\n\n<!-- secret\n';

test('顶层未闭合 HTML 注释：插入拒绝，源码与 changes 都不动', () => {
  const before = UNCLOSED_COMMENT;
  const plan = planFootnoteInsertion(before, 0, '1');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'def-hidden');
  assert.equal(plan.changes, undefined);
  assert.equal(before, UNCLOSED_COMMENT, 'planner 不得修改传入文本');
});

test('引用内未闭合围栏随引用结束：插入成功并成为可导出脚注', () => {
  const md = '> ```\n> quoted code\n\nParagraph\n';
  const head = md.indexOf('Paragraph') + 'Paragraph'.length;
  const plan = planFootnoteInsertion(md, head, '1');
  assert.equal(plan.ok, true, plan.reason);
  const post = applyChanges(md, plan.changes);
  assert.match(post, /Paragraph\[\^1\]\n\n\[\^1\]: /);
  assert.equal(post, md.replace('Paragraph', 'Paragraph[^1]') + '\n[^1]: ');
});

test('导出真实锚点：ref/endnote 的 id 与 href 指向同一 noteId', () => {
  const md = '> ```\n> quoted code\n\nParagraph\n';
  const head = md.indexOf('Paragraph') + 'Paragraph'.length;
  const plan = planFootnoteInsertion(md, head, '1');
  assert.equal(plan.ok, true, plan.reason);
  const post = applyChanges(md, plan.changes);

  const exported = footnoteExportPlan(post);
  assert.ok(exported, '应有导出计划');
  assert.equal(exported.used.length, 1);
  const note = exported.used[0];
  assert.equal(note.noteId, 'mp-fn-note-1');
  assert.equal(note.refs.length, 1);
  assert.equal(note.refs[0].refId, 'mp-fn-ref-1-1');

  const endnote = exported.endnote(text => text);
  assert.match(endnote, /id="mp-fn-note-1"/);
  assert.match(endnote, /href="#mp-fn-ref-1-1"/);

  const html = exported.expand(exported.body);
  assert.match(html, /id="mp-fn-ref-1-1"/);
  assert.match(html, /href="#mp-fn-note-1"/);
});
