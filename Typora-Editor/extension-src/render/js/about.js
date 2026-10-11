// 关于 / 帮助。Vditor 自带的同名两项讲的是 Vditor 这个开源库本身（面板里挂着
// b3log.org、ld246.com 的外链），与本产品无关，v2.0.19 起替换为自有内容：
// 关于 = 产品信息 + 版本 + 仓库；帮助 = 只放 GitHub 仓库链接（其余以后再补）。
import {dialogSlotFree, closeDialog} from './util.js';
const REPO = 'https://github.com/ltmroberthk915/markpilot';
const PUBLISHER = 'Jinxi';
// 渲染内核的开源声明。MIT 许可要求保留署名，故不随「去 Vditor 化」一并删除。
const KERNEL = 'Vditor 3.11.1（MIT 许可，渲染内核）';

async function openExternal(url) {
  try {
    // VSIX（第 5 轮 B7）：webview 没开 allow-popups，window.open 会被拦；也不能
    // 依赖宿主侧 hostApi（旧版没有 shim 时这里是 undefined，GitHub 链接点了没
    // 反应）。扩展宿主的 openLink 分支自带 openExternal 出口，直接走它。
    if (window.__vscodeHost) { window.handler.emit('openLink', url); return true; }
    if (window.hostApi?.invoke) { await window.hostApi.invoke('open-external', {url}); return true; }
  } catch { /* 宿主没有这个通道时退回 window.open */ }
  try { window.open(url, '_blank', 'noopener'); return true; } catch { return false; }
}

// 版本号只向宿主取。取不到就整行不显示——界面上绝不写死会过期的数字。
async function hostInfo() {
  try { return (await window.hostApi?.invoke?.('app-info')) || {}; } catch { return {}; }
}

// 与 surface.js / themes.js 同一套弹窗生命周期：只允许一个实例、关掉即移除、
// 关闭后把焦点和选区还给正文。
function openDialog(id, title) {
  if (!dialogSlotFree(id)) return null;
  const previousFocus = document.activeElement;
  const selection = getSelection();
  const savedRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = 'typora-media-dialog typora-about-dialog';
  dialog.setAttribute('aria-labelledby', id + '-title');
  dialog.innerHTML = '<form method="dialog"><h3 id="' + id + '-title">' + title + '</h3>'
    + '<div class="typora-about-body"></div>'
    + '<div class="media-actions"><span></span><button value="ok">确定</button></div></form>';
  const finish = () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    if (savedRange?.startContainer.isConnected && savedRange.endContainer.isConnected) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
  };
  dialog.addEventListener('close', finish, {once: true});
  // 隐藏文档里 close 事件可能永远不派发（见 util.js 的说明），所以点「确定」时自己收尾
  dialog.querySelector('[value=ok]').addEventListener('click', () => closeDialog(dialog, finish));
  // 弹窗里的链接一律交给系统浏览器，绝不让 iframe 自己跳走。
  dialog.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    openExternal(link.href);
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));

export async function showAbout() {
  const dialog = openDialog('typora-about-dialog', '关于 MarkPilot');
  if (!dialog) return;
  const body = dialog.querySelector('.typora-about-body');
  body.innerHTML = '<p class="typora-about-name">MarkPilot</p>'
    + '<p>面向中文写作的 Markdown 编辑器：中西文混排、公式与源码双向定位、超大文档不卡。<br>'
    + 'Windows 桌面版与 VS Code / Trae 扩展共用同一套渲染层。</p>'
    + '<p class="typora-about-version"></p>'
    + '<p>发布者：' + escapeHtml(PUBLISHER) + '<br>仓库：<a href="' + REPO + '" rel="noreferrer">' + REPO + '</a></p>'
    + '<p class="typora-about-kernel">开源组件：' + escapeHtml(KERNEL) + '</p>';
  const info = await hostInfo();
  const version = dialog.querySelector('.typora-about-version');
  if (info.version) version.textContent = '版本 ' + info.version + (info.channel ? '（' + info.channel + '）' : '');
  else version.remove();
  dialog.querySelector('[value=ok]').focus();
}

export async function showHelp() {
  const dialog = openDialog('typora-help-dialog', '帮助');
  if (!dialog) return;
  const body = dialog.querySelector('.typora-about-body');
  body.innerHTML = '<p>使用问题、故障反馈和版本更新都在 GitHub 仓库，请到这里查看或提交：</p>'
    + '<p><a href="' + REPO + '" rel="noreferrer">' + REPO + '</a></p>'
    + '<p>仓库里的 README 列出了全部功能和已知问题；反馈问题时请附上「关于」里显示的版本号。</p>'
    + '<p>更详细的帮助内容以后再补充。</p>';
  dialog.querySelector('[value=ok]').focus();
}
