'use strict';
const {AUTH_HEADER} = require('./server');

function trustedPage(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && (url.pathname === '/shell' || url.pathname === '/shell/index.html' || url.pathname === '/shell/export.html' || url.pathname === '/render/office.html' || url.pathname.startsWith('/doc/'));
  } catch { return false; }
}

function authorizedRequest(details, origin, contents) {
  if (!contents.has(details.webContentsId)) return false;
  try { if (new URL(details.url).origin !== origin) return false; } catch { return false; }
  if (trustedPage(details.frame?.url, origin)) return true;
  // Initial navigation happens before the frame has its trusted URL.
  if (details.resourceType === 'mainFrame') return trustedPage(details.url, origin);
  return details.resourceType === 'subFrame' && trustedPage(details.url, origin) && trustedPage(details.frame?.parent?.url, origin);
}

function installResourceAuth(session, {port, token}) {
  const origin = `http://127.0.0.1:${port}`, contents = new Set();
  session.webRequest.onBeforeSendHeaders({urls: ['http://*/*', 'https://*/*']}, (details, callback) => {
    const headers = {...details.requestHeaders};
    // Redirects must never carry this capability to an external server.
    for (const name of Object.keys(headers)) if (name.toLowerCase() === AUTH_HEADER.toLowerCase()) delete headers[name];
    if (authorizedRequest(details, origin, contents)) headers[AUTH_HEADER] = token;
    callback({requestHeaders: headers});
  });
  return {
    origin,
    allow(webContents) {contents.add(webContents.id);webContents.once('destroyed', () => contents.delete(webContents.id));},
  };
}
module.exports = {installResourceAuth, authorizedRequest};
