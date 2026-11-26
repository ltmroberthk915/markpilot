/* edition-view.js — 「书页 / 研报」在 CM6 编辑面的**投影**（契约来自 article-recipes.js）。
 *
 * 只做三件事，全部是投影（不动源码、不进撤销栈、不改标题源码偏移）：
 *   1. 把配方写到**根属性**上：`data-mp-article-recipe` / `data-mp-article-variant`
 *      （CSS 由此限定；换配方即换属性，摘掉属性即完全回到旧行为）；
 *   2. 研报的**章节编号**：按标题行顺序算一行号，挂在该行的行装饰上
 *      （`data-mp-edition-num`，内容由 CSS 的 attr() 画在既有 46px 悬挂位）；
 *      编号字符串由 article-edition 的 editionNumbering 给出，导出/复制用同一份实现；
 *   3. 注入配方 CSS（`articleEditorCss(recipe)`，两款 × 明暗各一份）。
 *
 * 设计纪律：
 *  · 行装饰只依赖 lineStylesField 与配方 —— 与光标/选区无关，不给逐键路径加扫描；
 *  · follow（跟随界面）不需要监听：配方属性写着"跟随"，颜色仍由现有主题写；
 *    显式明暗时只要属性值就是 light/dark，CSS 自带纸面色（不写内联 token、可整段摘掉）；
 *  · 未选择（plain）时不写任何属性、不注入编号 —— 旧文档零变化。
 */

import { EditorView, Decoration } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { normalizeEdition, editionActive, resolveEditionTone, editionNumbering } from './article-edition.js';
import { getArticleRecipe, articleEditorCss } from './article-recipes.js';

/** 当前配方（StateField 持有，供行装饰同步读取）。 */
export const setArticleEdition = StateEffect.define();

export const articleEditionField = StateField.define({
  create() { return normalizeEdition(null); },
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setArticleEdition)) return effect.value;
    return value;
  },
});

const numDecoration = (text) => Decoration.line({ attributes: { 'data-mp-edition-num': text } });

/**
 * 行装饰工厂：需要引擎的 lineStylesField（标题已由它扫好）——本模块不 import main.js，
 * 由装配处把字段传进来（无循环依赖、无需可变占位）。
 * 计数与导出/复制同一实现（editionNumbering）⇒ 编辑面与输出件编号逐字一致。
 */
export function createEditionHeadingDecorations(lineStylesField) {
  return EditorView.decorations.compute([articleEditionField, lineStylesField], (state) => {
    const edition = normalizeEdition(state.field(articleEditionField, false));
    if (edition.kind !== 'report') return Decoration.none;
    const styles = state.field(lineStylesField, false);
    if (!styles || !styles.headings || !styles.headings.length) return Decoration.none;
    const numbering = editionNumbering('report');
    const out = [];
    let lastLine = -1;
    for (const h of styles.headings) {
      const line = state.doc.lineAt(h.from);
      if (line.from === lastLine) continue;
      lastLine = line.from;
      const text = numbering.next(h.level || 1);
      if (text) out.push(numDecoration(text).range(line.from));
    }
    return Decoration.set(out, true);
  });
}

/** 编辑面 CSS 文本：两款 × 明暗各一份（属性限定，不泄漏到 plain）。 */
export function editionStylesText() {
  const out = [];
  for (const id of ['book', 'report']) {
    for (const variant of ['light', 'dark']) {
      out.push(articleEditorCss(getArticleRecipe(id, variant)));
    }
  }
  return out.join('\n');
}

export function installArticleEditionStyles(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || !d.createElement) return null;
  let style = d.getElementById('mp-edition-style');
  if (!style) {
    style = d.createElement('style');
    style.id = 'mp-edition-style';
    (d.head || d.documentElement).appendChild(style);
  }
  const text = editionStylesText();
  if (style.textContent !== text) style.textContent = text;
  return style;
}

/** 界面当前是否深色（读引擎写好的 data-mode，优先；兜底 prefers-color-scheme）。 */
export function interfaceIsDark(doc) {
  try {
    const html = (doc || (typeof document !== 'undefined' ? document : null) || {}).documentElement;
    if (html && html.dataset) {
      if (html.dataset.mode === 'dark') return true;
      if (html.dataset.mode === 'light') return false;
      if (html.dataset.mpDark === '1') return true;
    }
  } catch { /* 无 DOM */ }
  try {
    if (typeof matchMedia === 'function') return !!matchMedia('(prefers-color-scheme: dark)').matches;
  } catch { /* 忽略 */ }
  return false;
}

/**
 * 把配方写到根上（**唯一写者**）。返回快照（面板/探针回显同源）。
 *   · plain ⇒ 摘掉全部属性，回到旧行为；
 *   · book/report ⇒ 写 recipe/variant；follow 时 variant 写**解析后的**明暗（供 CSS 取色），
 *     同时用 data-mp-edition-variant-mode="follow" 记住"跟随"这个选择本身。
 */
export function applyArticleEdition(edition, options = {}) {
  const doc = options.doc || (typeof document !== 'undefined' ? document : null);
  const e = normalizeEdition(edition);
  const dark = typeof options.isDark === 'boolean' ? options.isDark : interfaceIsDark(doc);
  const tone = resolveEditionTone(e, dark);
  const html = doc && doc.documentElement;
  if (html && html.dataset) {
    if (!editionActive(e)) {
      delete html.dataset.mpArticleRecipe;
      delete html.dataset.mpArticleVariant;
      delete html.dataset.mpEdition;
      delete html.dataset.mpEditionMode;
    } else {
      html.dataset.mpArticleRecipe = e.kind;
      html.dataset.mpArticleVariant = tone;
      html.dataset.mpEditionMode = e.variant;
      html.dataset.mpEdition = e.kind;
    }
  }
  return {
    kind: e.kind, variant: e.variant, tone,
    active: editionActive(e),
    isDark: tone === 'dark',
    recipe: editionActive(e) ? getArticleRecipe(e.kind, tone) : null,
  };
}

/** 供 main.js 装配的扩展数组（字段 + 行编号装饰；不含 CSS 注入）。 */
export function articleEditionExtension(lineStylesField) {
  return [articleEditionField, createEditionHeadingDecorations(lineStylesField)];
}

export default {
  articleEditionField, setArticleEdition, articleEditionExtension,
  applyArticleEdition, installArticleEditionStyles, editionStylesText,
  interfaceIsDark, createEditionHeadingDecorations,
};
