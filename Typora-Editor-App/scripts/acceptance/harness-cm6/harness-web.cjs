/** dsh-web 验收目标层（r20 移植设计 §4）。
 *
 *  裁决（设计 §4.1）：**Playwright 管目标，CDP 管输入**。
 *    · Playwright 负责 chromium 启动、页面/帧管理、console 收集；
 *    · 真实输入仍走裸 CDP（newCDPSession → Input.dispatchKeyEvent/dispatchMouseEvent/
 *      insertText）——与 2.x harness.cjs 同一通道，hi.cjs 的键鼠原语（只用
 *      session.send('Input.*')）**零改动复用**；截图也走 CDP Page.captureScreenshot。
 *
 *  会话门面与 2.x makePage 同形子集：js / jsSoft / until / send / type / click /
 *  move / wheel / shot / errors / warnings / close；另有 engineFrameExpr()（引擎帧
 *  window 的求值表达式，交给 probe.cjs 用）。
 *
 *  双档（设计 §4.2）：
 *    tier 1（引擎档）：file:// 宿主页 host/index.html + 产品 renderer iframe，
 *      --allow-file-access-from-files 下父页与 iframe 同源（已实测），免登录可并行。
 *      磁盘类断言此档只读不写盘（无保存链）。
 *    tier 2（壳档）：连 http://127.0.0.1:4177 真身（app-slot 纪律由场景层负责）。
 *
 *  台账指纹：launch 时记录 renderer-cm6/app.js 的 sha256 前 16 位（设计 §7.7——
 *  被测真身必须可指认）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const project = path.resolve(__dirname, '..', '..', '..'); // harness-cm6 → acceptance → scripts → Typora-Editor-App
const HOST_PAGE = path.join(__dirname, 'host', 'index.html');
const DSH_MARKPILOT = path.resolve(project, '..', 'dsh-markpilot');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** playwright 解析：优先可指认的本地安装，且要求默认浏览器可执行文件真实存在
 *  （本机实测：npx 缓存的 playwright 1.59.1 要 chromium-1217，缓存里只有 1208/1243，
 *  直接用会在 launch 时才炸；System32 的 playwright-core 1.58.2 ↔ chromium-1208 匹配）。 */
function resolvePlaywright() {
  const candidates = [
    process.env.DSH_ACCEPTANCE_PLAYWRIGHT,
    'playwright', 'playwright-core',
    'C:/Windows/System32/node_modules/playwright-core',
    'C:/Users/ltmroberthk/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright',
  ].filter(Boolean);
  const failures = [];
  for (const spec of candidates) {
    try {
      const mod = require(spec);
      const exe = mod.chromium && mod.chromium.executablePath && mod.chromium.executablePath();
      if (exe && fs.existsSync(exe)) return mod;
      failures.push(`${spec}（浏览器缺失：${exe || '无 executablePath'}）`);
    } catch (error) {
      failures.push(`${spec}（${String(error.message).split('\n')[0].slice(0, 80)}）`);
    }
  }
  throw new Error('找不到「浏览器齐」的 playwright：\n  ' + failures.join('\n  '));
}

/** 被测真身指纹：renderer-cm6/app.js sha256 前 16 位。 */
function bundleFingerprint() {
  try {
    const file = path.join(DSH_MARKPILOT, 'renderer-cm6', 'app.js');
    const stat = fs.statSync(file);
    return { appJsSha16: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16), appJsBytes: stat.size, appJsMtime: stat.mtime.toISOString() };
  } catch (error) {
    return { error: String(error.message) };
  }
}

const fileUrl = file => 'file:///' + String(file).replace(/\\/g, '/');

/** 顶层页求值外壳（与 2.x makePage.evaluate 同语义：异常→抛，soft→{ok,error}）。 */
function makeEvaluate(send) {
  return async function evaluate(expression, options = {}) {
    let message;
    try {
      message = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    } catch (error) {
      if (options.soft) return { ok: false, error: String(error.message).split('\n')[0], value: null };
      throw error;
    }
    const result = message || {};
    if (result.exceptionDetails) {
      const text = String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '').split('\n')[0];
      if (options.soft) return { ok: false, error: text.slice(0, 400), value: null };
      throw new Error('页面内报错：' + text.slice(0, 400) + ' ← ' + String(expression).slice(0, 160));
    }
    return { ok: true, error: null, value: result.result?.value ?? null };
  };
}

/** 启动 dsh-web 会话。options：{ tier=1, engine='cm6', base, text, url, headless=true,
 *  label, outDir }。返回与 2.x 同形子集的 session。 */
async function launch(options = {}) {
  const pw = resolvePlaywright();
  const tier = Number(options.tier || 1);
  const engine = options.engine || 'cm6';
  const outDir = options.outDir || path.join(project, '.perf/acceptance', (options.label || 'dsh-web') + '-cm6');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'launch-web.json'), JSON.stringify({
    tier, engine, base: options.base || null, headless: options.headless !== false,
    hostPage: HOST_PAGE, bundle: bundleFingerprint(), at: new Date().toISOString(),
  }, null, 2));

  // --allow-file-access-from-files：file:// 宿主页与产品 iframe 同源的关键开关
  // （实测：不带则父页直穿 contentWindow 被 opaque origin 拦截）。
  const browser = await pw.chromium.launch({
    headless: options.headless !== false,
    args: ['--allow-file-access-from-files', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  // 初始化脚本（对子帧也生效）：取证用——从帧诞生第一毫秒记录桥消息。
  if (options.initScript) await page.addInitScript(options.initScript);

  const errors = [];
  const warnings = [];
  // console 收集按 frame 全覆盖（Playwright 的 page console 事件含 iframe 消息）。
  page.on('console', message => {
    const text = String(message.text() || '').slice(0, 300);
    const type = message.type();
    if (type === 'error') errors.push('console:' + text);
    else if (type === 'warning') warnings.push('console:' + text);
  });
  page.on('pageerror', error => errors.push('exception:' + String(error && error.message || error).slice(0, 400)));

  const url = options.url
    || (tier === 1
      ? fileUrl(HOST_PAGE) + '?engine=' + encodeURIComponent(engine) + (options.text != null ? '&text=' + encodeURIComponent(options.text) : '')
      : (options.base || 'http://127.0.0.1:4177'));
  const navigationStart = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: options.gotoTimeout || 30000 });
  } catch (error) {
    await browser.close().catch(() => {});
    throw new Error('目标页打不开（' + url + '）：' + String(error.message).split('\n')[0]);
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const send = (method, params = {}, timeoutMs = 30000) => Promise.race([
    cdp.send(method, params),
    sleep(timeoutMs).then(() => { throw new Error(`CDP 无响应（${method}，${timeoutMs}ms）：目标可能已关闭`); }),
  ]).catch(error => {
    if (/Target closed|Session closed/.test(String(error.message))) throw new Error(`CDP 无响应（${method}）：目标可能已关闭`);
    throw error;
  });

  const evaluate = makeEvaluate(send);

  const session = {
    label: options.label || 'dsh-web',
    targetKind: 'dsh-web', tier, engine, url,
    navigationMs: Date.now() - navigationStart,
    bundle: bundleFingerprint(),
    errors, warnings, outDir,
    /** 顶层（宿主页）求值。 */
    async js(expression, options2) { return (await evaluate(expression, options2)).value; },
    async jsSoft(expression) { return evaluate(expression, { soft: true }); },
    send,
    /** 引擎帧 window 的求值表达式——probe.cjs 的唯一入口。 */
    engineFrameExpr() {
      if (tier !== 1) throw new Error('tier 2 的帧入口由场景指定（DSH 壳页里 iframe src*=renderer）');
      return `document.getElementById('mp-frame').contentWindow`;
    },
    async until(expression, options2 = {}) {
      const stop = Date.now() + (options2.timeout || 30000);
      let transportErrors = 0;
      let lastError = '';
      while (Date.now() < stop) {
        let hit;
        try { hit = await this.jsSoft(expression); }
        catch (error) {
          // 传输层错误不冒泡、也不放弃：整段预算里一次都没成功过才判失败（2.x 的忙等教训）。
          transportErrors++;
          lastError = String((error && error.message) || error).split('\n')[0];
          if (transportErrors === 1) warnings.push('until 轮询遇到传输错误（继续等，不放弃）：' + lastError);
          await sleep(Math.max(options2.interval || 40, 400));
          continue;
        }
        if (hit.ok && hit.value) return true;
        await sleep(options2.interval || 40);
      }
      if (transportErrors) warnings.push(`until 等待期间有 ${transportErrors} 次传输错误、一次都没读到就绪（最后一条：${lastError}）`);
      return false;
    },
    async type(text) { await send('Input.insertText', { text }); },
    async click(x, y, options2 = {}) {
      const common = { x, y, button: options2.button || 'left', buttons: options2.button === 'right' ? 2 : 1, clickCount: options2.clickCount || 1, modifiers: options2.modifiers || 0 };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 });
    },
    async move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }); },
    async wheel(x, y, deltaY) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }); },
    async shot(name) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
    /** 观测器：web 档不注入 Electron SHIM（无主进程替身需求）；保留接口同形。 */
    async instrument() { return true; },
    async close() {
      try { await browser.close(); } catch { /* 已关 */ }
      await sleep(60);
    },
  };
  return session;
}

module.exports = { launch, bundleFingerprint, resolvePlaywright, HOST_PAGE, project, sleep };
