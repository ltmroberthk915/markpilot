/** 探针共用「启动 + 连 CDP + 等引擎页」——单一实现（AGENTS 错-4）
 *
 *  为什么抽出来：本轮多个族各写一份 spawn/connectOverCDP/等待判据，改一处忘一处。
 *  这里只做一件事：照既有范式起 MarkPilot.exe（真实产物）并交回 page。
 *
 *  用法：
 *    const { launch } = require('./_probe-cdp-load.cjs');
 *    const h = await launch({ exe: EXE, doc: DOC, dir: DIR, port: 9810, tag: 'probe-x' });
 *    // h = { page, child, kill, pageErrors, closeAll }
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { chromium } = require('C:/Windows/System32/node_modules/playwright-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起产物并连上引擎页。doc 可为 null（不传文档路径）。
 *  【2026-10-10 踩坑 1】doc 指向的文件**必须在 spawn 之前存在**：产物对缺失文档会弹原生
 *  「Error」对话框、引擎页永不就绪 ⇒ 探针卡死（实测卡了 7 分钟）。这里做前置断言。
 *  【2026-10-10 踩坑 2】本函数会 rmSync(dir) 清 profile。若探针自己先写夹具再调本函数，
 *  夹具会被这次清理**抹掉**（实测 main-debug.log 报 openPath:error ENOENT）。
 *  ⇒ 夹具一律用 beforeSpawn 回调解写，或在本函数返回后再写。 */
async function launch({ exe, doc = null, dir, port, profileName = 'profile', readyTimeoutMs = 90000, settleMs = 2500, keepProfile = false, beforeSpawn = null }) {
  if (!exe) throw new Error('launch: 缺 exe');
  if (!dir) throw new Error('launch: 缺 dir');
  if (!fs.existsSync(exe)) throw new Error('launch: 产物不存在: ' + exe);
  const PROFILE = path.join(dir, profileName);
  if (!keepProfile) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  /* 夹具在「清完目录之后、spawn 之前」落盘——顺序错了就是上面踩坑 2 */
  if (typeof beforeSpawn === 'function') await beforeSpawn({ dir, profile: PROFILE });
  if (doc && !fs.existsSync(doc)) throw new Error('launch: 文档不存在（产物会弹 Error 对话框）: ' + doc);
  const p = Number(port) || (9700 + (process.pid % 300));
  const env = { ...process.env, MP_DEBUG: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const argv = [];
  if (doc) argv.push(doc);
  argv.push(`--remote-debugging-port=${p}`, `--user-data-dir=${PROFILE}`);
  const child = spawn(exe, argv, { env, stdio: 'ignore' });
  const kill = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { } };
  const pageErrors = [];
  let browser = null;
  for (let i = 0; i < 45 && !browser; i++) { await sleep(1000); try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`); } catch { } }
  if (!browser) { kill(); throw new Error('CDP 连不上（port ' + p + '）'); }
  const ctx = browser.contexts()[0];
  let page = null;
  let shared = null;
  const deadline = Date.now() + readyTimeoutMs;
  while (!page && Date.now() < deadline) {
    for (const pg of ctx.pages().filter((x) => !x.url().startsWith('devtools://'))) {
      const ok = await pg.evaluate(() => { try { return !!(window.mpEngine && window.mpExtras); } catch { return false; } }).catch(() => false);
      if (ok) {
        page = pg;
        shared = await pg.evaluate(() => ({ hasHost: !!(window.mpHost && window.mpHost.openPath), hasHostGlobal: !!window.mpHost, engine: !!window.mpEngine }));
        break;
      }
    }
    if (!page) await sleep(500);
  }
  /* 【2026-10-10】等不到引擎页时必须**主动杀进程**再抛错：
     CDP 连接还挂着时 Electron 进程会拒绝退出，而 host（本探针父进程）会一直等 stdio ⇒ 卡死。 */
  if (!page) {
    await Promise.race([browser.close().catch(() => { }), sleep(4000)]);
    kill();
    throw new Error('找不到引擎页（window.mpEngine && window.mpExtras），已 taskkill ' + child.pid + '（常见原因：文档不存在 ⇒ 原生 Error 对话框）');
  }
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });
  await sleep(settleMs);
  return {
    page, child, kill, pageErrors, port: p, profile: PROFILE, shared,
    closeAll: async () => { await browser.close().catch(() => { }); kill(); },
  };
}

module.exports = { launch, sleep };
