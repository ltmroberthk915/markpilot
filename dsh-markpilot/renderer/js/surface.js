/** Shared translucent-surface preferences (v2.0.3).
 * One global popup opacity (default 66%) and an independent toolbar opacity
 * (default fully opaque), applied as CSS custom properties on the document
 * root so every surface — completion candidates, context menus, image
 * settings, the toolbar — follows the same live value. Also owns the
 * debounced identity-filter repaint that clears stale compositor tiles left
 * by translucent popups moving over reflowing text (Chromium iframe trail
 * bug, observed in the desktop shell's editor iframe). */
import {dialogSlotFree, closeDialog} from './util.js';
const STORAGE = 'typora-surface-prefs';
const clamp = percent => {
  const value = Math.round(Number(percent));
  return Number.isFinite(value) && String(percent).trim() !== '' ? Math.min(100, Math.max(10, value)) : null;
};
export const DEFAULT_SURFACE = {popups: 66, toolbar: 100};
const read = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    return {popups: clamp(saved?.popups) ?? DEFAULT_SURFACE.popups, toolbar: clamp(saved?.toolbar) ?? DEFAULT_SURFACE.toolbar};
  } catch { return {...DEFAULT_SURFACE}; }
};
let preferences = read();
export function surfacePreferences() { return {...preferences}; }
function apply(value) {
  const style = document.documentElement.style;
  style.setProperty('--typora-surface-opacity', (value.popups / 100).toFixed(3));
  style.setProperty('--typora-toolbar-opacity', (value.toolbar / 100).toFixed(3));
}
/** Apply (and by default persist) surface preferences. Invalid values keep
 * the current setting for that field, so a half-typed number in the dialog
 * never blanks a surface. */
export function applySurfacePreferences(value = {}, {persist = true} = {}) {
  const popups = clamp(value.popups) ?? preferences.popups;
  const toolbar = clamp(value.toolbar) ?? preferences.toolbar;
  preferences = {popups, toolbar};
  if (persist) { try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch {/* host state may outlive localStorage */} }
  apply(preferences);
  return {...preferences};
}
export function installSurfacePreferences() {
  apply(preferences);
  // Debug/test hook: the desktop residue gate drives the real cleanup from
  // the host side (same pattern as __typoraMathStats).
  window.__typoraSurfaceCleanup = scheduleSurfaceCleanup;
}

let cleanupTimer = 0;
/** Ask the compositor for a full re-raster after translucent popups moved
 * over edited text: an identity filter on the root for one frame repaints
 * every tile without any visual change. Debounced so one typing burst pays
 * at most a single extra raster after it settles. */
export function scheduleSurfaceCleanup(delay = 450) {
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    const root = document.documentElement;
    root.style.filter = 'contrast(1)';
    requestAnimationFrame(() => requestAnimationFrame(() => { root.style.filter = ''; }));
  }, Math.max(0, delay));
}

export function showSurfaceSettings() {
  if (!dialogSlotFree('typora-surface-settings')) return;
  const previousFocus = document.activeElement;
  const selection = getSelection();
  const savedRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  let committed = {...preferences};
  const dialog = document.createElement('dialog');
  dialog.id = 'typora-surface-settings';
  dialog.className = 'typora-media-dialog';
  dialog.setAttribute('aria-labelledby', 'surface-title');
  dialog.innerHTML = '<form method="dialog"><h3 id="surface-title">界面透明度</h3>'
    + '<p>弹窗与菜单表面不透明度（右键菜单、补全候选框、图片设置等）。工具栏单独设置，与弹窗互不影响。</p>'
    + '<label class="surface-row">弹窗 / 菜单 <input name="popups" type="number" min="10" max="100" step="1"> %</label>'
    + '<label class="surface-row">工具栏 <input name="toolbar" type="number" min="10" max="100" step="1"> %</label>'
    + '<p class="surface-error" role="alert"></p>'
    + '<div class="media-actions"><button type="button" data-action="reset">恢复默认</button><span></span>'
    + '<button value="cancel">取消</button><button type="button" data-action="save">保存</button></div></form>';
  const values = {...preferences};
  const inputs = {popups: dialog.querySelector('[name=popups]'), toolbar: dialog.querySelector('[name=toolbar]')};
  const error = dialog.querySelector('.surface-error');
  const save = dialog.querySelector('[data-action=save]');
  const paint = () => { for (const [name, input] of Object.entries(inputs)) input.value = values[name]; };
  const validate = () => {
    const invalid = Object.values(values).some(value => clamp(value) === null);
    error.textContent = invalid ? '不透明度需为 10～100 的整数。' : '';
    save.disabled = invalid;
  };
  for (const input of Object.values(inputs)) {
    input.addEventListener('input', () => {
      values[input.name] = clamp(input.value) ?? input.value;
      validate();
      // Live preview without persisting: cancel restores the saved values.
      if (clamp(values[input.name]) !== null) applySurfacePreferences(values, {persist: false});
    });
  }
  paint();
  validate();
  dialog.querySelector('[data-action=reset]').onclick = () => {
    Object.assign(values, DEFAULT_SURFACE);
    applySurfacePreferences(values, {persist: false});
    paint();
    validate();
  };
  save.onclick = () => {
    validate();
    if (save.disabled) return;
    committed = applySurfacePreferences(values);
    closeDialog(dialog, finish);
  };
  const finish = () => {
    dialog.remove();
    applySurfacePreferences(committed);
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    if (savedRange?.startContainer.isConnected && savedRange.endContainer.isConnected) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
  };
  dialog.addEventListener('close', finish, {once: true});
  // 隐藏文档里 close 事件可能永远不派发（见 util.js 的说明），所以「取消」按钮自己收尾
  dialog.querySelector('[value="cancel"]').addEventListener('click', () => closeDialog(dialog, finish));
  document.body.append(dialog);
  dialog.showModal();
  inputs.popups.focus();
  inputs.popups.select();
}
