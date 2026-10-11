// 检查更新。EXE 桌面版的更新权威源是 GitHub Releases 的 latest（Open VSX 只发
// VSIX，不作为 EXE 的更新依据）。本机直连 github.com 网页会超时，但 api.github.com
// 可达（系统代理 127.0.0.1:7897），所以请求必须走 Electron 的 net.fetch（随系统
// 代理）而不是 Node 的 https（不吃系统代理）。
'use strict';
const { app, dialog, net, shell, Notification } = require('electron');

const API_LATEST = 'https://api.github.com/repos/ltmroberthk915/markpilot/releases/latest';
const RELEASES_PAGE = 'https://github.com/ltmroberthk915/markpilot/releases/latest';
// 静默检查不许拖住启动，也不许让「检查更新…」的用户干等：8 秒拿不到就算失败。
const FETCH_TIMEOUT_MS = 8000;

// 三段数字逐段比较（远端 tag 形如 v2.3.0）。发布 tag 一直是纯三段数字，自带十几行
// 比较就够，不引 semver 依赖。解析不了的段按 0 处理，两边同样对待不会误判大小。
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.');
  const pb = String(b || '').replace(/^v/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 本机基准版本。MP_FAKE_VERSION 仅供验收把基准压到旧版本，以截图「发现新版本」
// 分支；平时不设即为真实安装版本。
const currentVersion = () => process.env.MP_FAKE_VERSION || app.getVersion();

async function fetchLatest() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(API_LATEST, {
      signal: abort.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const tag = data && data.tag_name;
    if (!tag) throw new Error('latest 响应缺少 tag_name');
    return { version: String(tag).replace(/^v/, ''), page: data.html_url || RELEASES_PAGE };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查一次更新。
 * interactive=true 来自「帮助 → 检查更新…」：每个结果都要给用户交代，含失败。
 * interactive=false 是启动 3 秒后的静默检查：失败无声，仅有新版时用系统通知提醒
 * 一次（原生通知不打断输入；点通知直达下载页）。
 */
async function checkForUpdates(win, { interactive = true } = {}) {
  let latest = null;
  try {
    latest = await fetchLatest();
  } catch (error) {
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: '检查更新',
        message: '检查更新失败（网络）',
        detail: '未能从 GitHub 获取最新版本信息，请稍后再试。',
        buttons: ['确定'],
      });
    }
    return;
  }
  if (compareVersions(latest.version, currentVersion()) <= 0) {
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: '检查更新',
        message: '已是最新版本',
        detail: `MarkPilot v${currentVersion()} 已是 GitHub 上的最新发布。`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (interactive) {
    const pick = await dialog.showMessageBox(win, {
      type: 'info',
      title: '检查更新',
      message: `发现新版本 v${latest.version}（当前 v${currentVersion()}）`,
      detail: '打开下载页可获取新版安装包。',
      buttons: ['打开下载页', '以后再说'],
      defaultId: 0,
      cancelId: 1,
    });
    if (pick.response === 0) shell.openExternal(latest.page);
  } else if (Notification.isSupported()) {
    const note = new Notification({
      title: 'MarkPilot 有新版本',
      body: `v${latest.version} 已发布（当前 v${currentVersion()}），点击查看下载页。`,
    });
    note.on('click', () => shell.openExternal(latest.page));
    note.show();
  }
}

// 启动静默检查：窗口都建好之后再等 3 秒，避开启动期的磁盘与网络竞争；失败无声。
function scheduleStartupCheck(getWin) {
  setTimeout(() => {
    checkForUpdates(getWin ? getWin() : null, { interactive: false }).catch(() => {});
  }, 3000);
}

module.exports = { checkForUpdates, scheduleStartupCheck, compareVersions };
