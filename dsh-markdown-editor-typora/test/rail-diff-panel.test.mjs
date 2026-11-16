// 定向回归：「查看差异」面板的偏冷近黑磨砂只作用于 diff 态。
// 配色/阴影/模糊由 .mp-rail-popover-diff 与 CSS @supports 守卫决定，
// 普通通知 / 共享恢复独开时的内联半透明底、位置、滚动、按钮、尺寸适配保持原样。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/client-save-status.cjs';

const { make } = fixture;
const nodes = (n) => (!n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]);
const text = (n) => (typeof n === 'string' ? n : !n || typeof n !== 'object' ? '' : (n.children || []).map(text).join(''));
const byClassToken = (tree, token) => nodes(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes(token));
const popover = (tree) => nodes(tree).find((n) => /^mp-rail-popover( mp-rail-popover-diff)?$/.test(String(n.props?.className || '')));
const cssText = (tree) => {
  const style = nodes(tree).find((n) => n?.type === 'style');
  return String(style?.children?.[0] ?? '');
};
function cssRule(css, selector) {
  const index = css.indexOf(selector + '{');
  assert.ok(index >= 0, `expected a CSS rule for ${selector}`);
  return css.slice(index, css.indexOf('}', index) + 1);
}
function cssBlock(css, start) {
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return null;
}

const SUPPORTS_HEAD = '@supports (backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px)){';

test('near-black frosted chrome appears only when review diff items exist', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    phase: 'review',
    detail: '1 组',
    railOpen: true,
    notices: [{ id: 1, text: 'NOTICE-WITH-DIFF', kind: 'info', ts: 1, actions: [] }],
    reviewDiff: [{ group: 1, from: 0, to: 3, removed: 'old', insert: 'new' }],
  });
  const tree = h.render();
  const panel = popover(tree);
  assert(panel, 'diff popover present');
  assert.equal(panel.props.className, 'mp-rail-popover mp-rail-popover-diff');
  assert.equal(panel.props['aria-label'], 'AI 修改差异');

  // 位置、滚动、尺寸适配契约原样保留。
  assert.equal(panel.props.style.position, 'absolute');
  assert.equal(panel.props.style.top, 'auto');
  assert.equal(panel.props.style.bottom, 56);
  assert.equal(panel.props.style.left, 8);
  assert.equal(panel.props.style.right, 8);
  assert.equal(panel.props.style.maxHeight, 'calc(100% - 108px)');
  assert.equal(panel.props.style.overflow, 'auto');
  assert.equal(panel.props.style.overflowX, 'hidden');
  assert.equal(panel.props.style.display, 'block');
  assert.equal(panel.props.style.width, undefined, 'panel keeps the shared left/right sizing');
  assert.equal(panel.props.style.height, undefined, 'panel keeps the shared max-height sizing');

  // 主题完全交给 CSS 类：diff 态不再生成内联背景/边/阴影/文字色/模糊。
  for (const key of ['background', 'border', 'boxShadow', 'color', 'backdropFilter', 'WebkitBackdropFilter', 'opacity']) {
    assert.equal(panel.props.style[key], undefined, `${key} is owned by .mp-rail-popover-diff`);
  }

  // 按钮和 −/+ 提示都还在，正文与标题可读。
  const labels = nodes(tree).filter((n) => n.type === 'button').map(text);
  assert.ok(labels.includes('收起'));
  assert.ok(labels.includes('定位'));
  assert.ok(labels.includes('清除'), 'notices sharing the panel keep their buttons');
  assert.ok(text(tree).includes('- old'));
  assert.ok(text(tree).includes('+ new'));
  assert.ok(text(tree).includes('AI 修改差异'));

  const removed = byClassToken(tree, 'mp-rail-diff-del').find((n) => n.type === 'pre');
  const added = byClassToken(tree, 'mp-rail-diff-add').find((n) => n.type === 'pre');
  assert.equal(removed.children[0], '- old');
  assert.equal(added.children[0], '+ new');

  const css = cssText(tree);
  const base = cssRule(css, '.mp-rail-popover-diff');
  assert.match(base, /background:#181b20/, 'base fills opaque before @supports applies');
  assert.match(base, /border:1px solid rgba\(244,245,247,\.16\)/);
  assert.match(base, /box-shadow:0 8px 22px rgba\(0,0,0,\.42\),inset 0 0 0 1px rgba\(255,255,255,\.07\)/);
  assert.match(base, /color:#f4f5f7/);
  assert.match(base, /color-scheme:dark/);
  assert.ok(!base.includes('backdrop-filter'), 'base panel must stay opaque without backdrop-filter');

  // 行级配色/边线/行距与按钮悬停、键盘焦点都在 CSS 契约里。
  assert.match(cssRule(css, '.mp-rail-diff-meta'), /color:#b9c0cb/);
  assert.match(cssRule(css, '.mp-rail-diff-line'), /line-height:1\.5/);
  assert.match(cssRule(css, '.mp-rail-diff-line'), /color:#fff/);
  assert.match(cssRule(css, '.mp-rail-diff-del'), /background:#3a2026/);
  assert.match(cssRule(css, '.mp-rail-diff-del'), /border-color:#6d3a43/);
  assert.match(cssRule(css, '.mp-rail-diff-add'), /background:#1c3128/);
  assert.match(cssRule(css, '.mp-rail-diff-add'), /border-color:#315b47/);
  assert.match(cssRule(css, '.mp-rail-popover-diff .mp-rail-btn:hover'), /background:rgba\(244,245,247,\.16\)/);
  assert.match(cssRule(css, '.mp-rail-popover-diff .mp-rail-btn:focus-visible'), /outline:2px solid #a9c8ff/);
  assert.match(cssRule(css, '.mp-rail-popover'), /bottom:52px !important/, 'narrow-container fit still overrides the popover box');

  // 「收起」仍然收面板并清掉差异。
  const close = nodes(tree).find((n) => n.type === 'button' && text(n) === '收起');
  close.props.onClick();
  assert.equal(h.ui().reviewDiff, null);
  assert.equal(h.ui().railOpen, false);
  h.cleanup();
});

test('notice-only and recovery-only popovers keep the original inline chrome', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    railOpen: true,
    reviewDiff: null,
    notices: [{ id: 1, text: 'NOTICE-ONLY', kind: 'info', ts: 1, actions: [] }],
  });
  let rendered = h.render();
  let panel = popover(rendered);
  assert(panel, 'notice popover present');
  assert.equal(panel.props.className, 'mp-rail-popover');
  assert.equal(panel.props['aria-label'], '通知与共享会话恢复的草稿副本');
  assert.equal(panel.props.style.background, 'color-mix(in srgb, currentColor 8%, transparent)');
  assert.equal(panel.props.style.backdropFilter, 'blur(12px)');
  assert.equal(panel.props.style.color, 'inherit');
  assert.equal(byClassToken(rendered, 'mp-rail-popover-diff').length, 0);

  h.setUiForRender({
    railOpen: true,
    notices: [],
    recovered: [{ recoveryPath: 'D:/probe/recovered.md', at: 1 }],
  });
  rendered = h.render();
  panel = popover(rendered);
  assert(panel, 'recovered popover present');
  assert.equal(panel.props.className, 'mp-rail-popover');
  assert.equal(panel.props['aria-label'], '通知与共享会话恢复的草稿副本');
  assert.equal(panel.props.style.background, 'color-mix(in srgb, currentColor 8%, transparent)');
  assert.equal(panel.props.style.backdropFilter, 'blur(12px)');
  assert.equal(byClassToken(rendered, 'mp-rail-popover-diff').length, 0);

  // 同一实例里差异被收起后，面板与标签都恢复普通通知样式（不是残留深色）。
  h.setUiForRender({
    railOpen: true,
    recovered: [],
    notices: [{ id: 2, text: 'NOTICE-AFTER-DIFF', kind: 'info', ts: 2, actions: [] }],
    reviewDiff: [{ group: 1, from: 0, to: 1, removed: 'x', insert: 'y' }],
  });
  assert.equal(byClassToken(h.render(), 'mp-rail-popover-diff').length, 1);
  h.setUiForRender({ reviewDiff: null });
  rendered = h.render();
  panel = popover(rendered);
  assert(panel);
  assert.equal(panel.props.className, 'mp-rail-popover');
  assert.equal(panel.props['aria-label'], '通知与共享会话恢复的草稿副本');
  assert.equal(panel.props.style.background, 'color-mix(in srgb, currentColor 8%, transparent)');
  h.cleanup();
});

test('backdrop blur is gated by a CSS @supports block instead of per-render detection', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    railOpen: true,
    reviewDiff: [{ group: 1, from: 0, to: 0, removed: '', insert: 'new' }],
  });
  const tree = h.render();
  const css = cssText(tree);
  const supportsAt = css.indexOf(SUPPORTS_HEAD);
  assert.ok(supportsAt >= 0, 'expected the CSS @supports guard');
  const block = cssBlock(css, supportsAt);
  assert.ok(block, 'expected a balanced @supports block');
  assert.match(block, /\.mp-rail-popover-diff\{background:rgba\(21,24,29,\.95\);/);
  assert.match(block, /-webkit-backdrop-filter:blur\(14px\)/);
  assert.match(block, /backdrop-filter:blur\(14px\)/);
  const match = block.match(/rgba\(21,24,29,\.(\d+)\)/);
  assert.ok(match, 'expected the near-black translucent fill');
  const alpha = Number('0.' + match[1]);
  assert.ok(alpha >= 0.94, `blur fallback must stay near-opaque, got alpha ${alpha}`);
  assert.equal(popover(tree).props.style.backdropFilter, undefined, 'no per-render capability check');
  h.cleanup();
});

test('forced-colors and higher-contrast overrides come after the @supports block', async () => {
  const h = make();
  await h.boot();
  h.setUiForRender({
    railOpen: true,
    reviewDiff: [{ group: 1, from: 0, to: 1, removed: 'x', insert: 'y' }],
  });
  const css = cssText(h.render());
  const supportsAt = css.indexOf(SUPPORTS_HEAD);
  const contrastAt = css.indexOf('@media (prefers-contrast:more){');
  const forcedAt = css.indexOf('@media (forced-colors:active){');
  assert.ok(supportsAt >= 0 && contrastAt > supportsAt && forcedAt > contrastAt, 'higher-contrast overrides follow the @supports block');

  const contrast = cssBlock(css, contrastAt);
  assert.ok(contrast);
  assert.match(contrast, /background:#111318 !important/);
  assert.match(contrast, /backdrop-filter:none !important/);

  const forced = cssBlock(css, forcedAt);
  assert.ok(forced);
  assert.match(forced, /\.mp-rail-popover-diff\{background:Canvas !important/);
  assert.match(forced, /backdrop-filter:none !important/);
  assert.match(forced, /\.mp-rail-diff-line\{background:Canvas;border-color:CanvasText;color:CanvasText\}/);
  h.cleanup();
});
