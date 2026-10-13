'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { playwright } = require('./dependencies.cjs');
const ROOT = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function acquireSlot(root = ROOT) {
  const dir = path.join(root, '.mp-verify'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'quality-app-slot.json'), token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })); fs.closeSync(fd);
      return () => { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); if (owner.token !== token) throw new Error('App-slot ownership changed'); fs.unlinkSync(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(owner.pid) || alive(owner.pid)) throw new Error('Another quality run owns the app slot: ' + owner.pid);
      fs.unlinkSync(file);
    }
  }
  throw new Error('Could not acquire app slot');
}
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; if (!['--exe','--electron','--app','--out','--expected-sha256'].includes(k) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown/incomplete argument: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if (!o.exe && !(o.electron && o.app)) throw new Error('Use --exe <published executable> or --electron <runtime> --app <source app>');
  if (o.exe && (o.electron || o.app)) throw new Error('Choose one launch mode');
  return o;
}
async function launch(o, doc, runDir, extraEnv = {}) {
  const exe = path.resolve(o.exe || o.electron);
  const hash = sha256(exe);
  if (o['expected-sha256'] && hash !== o['expected-sha256']) throw new Error('Executable SHA256 mismatch');
  const profile = path.join(runDir, 'profile-' + crypto.randomUUID()); fs.mkdirSync(profile);
  // These legacy workflow fixtures explicitly exercise automatic disk writes.
  // Product defaults remain manual; default-policy probes use a seed without
  // these opt-in keys and verify the actual upgrade/default path separately.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ restoreLast: false, theme: 'light', autosaveEnabled: true, autosaveIntervalMs: 1000, winBounds: { width: 1100, height: 800, x: 50, y: 50 } }));
  const env = { ...process.env, MP_TEST_NO_DIALOG: '1', MP_TEST_HOOKS: '1', MP_DEBUG: '1', MP_MIGRATE_FROM: path.join(runDir, 'absent-legacy-profile'), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const argv = [...(o.app ? [path.resolve(o.app)] : []), doc, '--remote-debugging-port=0', '--user-data-dir=' + profile, '--enable-logging=stderr'];
  const child = spawn(exe, argv, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchLog = '', spawnError = null;
  child.on('error', e => { spawnError = e; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { launchLog = (launchLog + d.toString()).slice(-200000); });
  let browser, cleanupTask;
  const signalHandlers=new Map();
  const cleanup = () => cleanupTask ||= (async () => {
    for(const [sig,handler] of signalHandlers)process.removeListener(sig,handler);
    await browser?.close().catch(() => {});
    const ownedPids = new Set(child.pid ? [child.pid] : []);
    if (process.platform === 'win32') {
      // Only processes named after this run's executable and containing its unique profile.
      const quotedProfile = profile.replaceAll("'", "''");
      const name = (o.exe ? 'MarkPilot.exe' : path.basename(exe)).replaceAll("'", "''");
      try {
        const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '" + name + "' -and $_.CommandLine -and $_.CommandLine.Contains('" + quotedProfile + "') } | ForEach-Object { $_.ProcessId }";
        const lines = execFileSync(process.env.MP_PWSH || 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        for (const line of lines.trim().split(/\s+/)) if (/^\d+$/.test(line)) ownedPids.add(Number(line));
      } catch { /* Parent tree remains the fallback. */ }
      for (const pid of ownedPids) try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch { }
    } else if (child.pid) { try { child.kill('SIGTERM'); } catch { } }
    await sleep(500);
    fs.writeFileSync(path.join(runDir, 'launch-' + path.basename(profile) + '.log'), launchLog);
    const sourceLog = path.join(profile, 'main-debug.log');
    if (fs.existsSync(sourceLog)) fs.copyFileSync(sourceLog, path.join(runDir, 'main-' + path.basename(profile) + '.log'));
    const residual = [...ownedPids].filter(alive);
    if (!residual.length && fs.existsSync(profile)) {
      const actualRoot=fs.realpathSync(runDir),actualTarget=fs.realpathSync(profile);
      if(path.dirname(actualTarget)!==actualRoot || path.basename(actualTarget)!==path.basename(profile))throw new Error('Profile escaped its owned output directory');
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
    return { residual };
  })();
  for(const [sig,code] of [['SIGINT',130],['SIGTERM',143]]) {
    const handler=()=>{void cleanup().finally(()=>process.exit(code));};signalHandlers.set(sig,handler);process.once(sig,handler);
  }
  try {
    const started = performance.now(), limit = Date.now() + 60000;
    let port;
    while (Date.now() < limit) {
      if (spawnError) throw spawnError;
      if (child.exitCode != null && !o.exe) throw new Error('Electron exited: ' + child.exitCode);
      try {
        port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
        const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(700) });
        if (r.ok) break;
      } catch { }
      await sleep(200);
    }
    if (!port || Date.now() >= limit) throw new Error('CDP startup timed out');
    browser = await playwright().chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10000 });
    let page;
    while (Date.now() < limit && !page) {
      for (const p of browser.contexts().flatMap(c => c.pages())) {
        if (p.url().startsWith('devtools:')) continue;
        if (await p.evaluate(() => !!window.mpEngine?._view?.()).catch(() => false)) { page = p; break; }
      }
      if (!page) await sleep(100);
    }
    if (!page) throw new Error('Editor did not boot');
    await page.waitForFunction(() => window.mpEngine._view().state.doc.length > 0, null, { timeout: 15000 });
    const info = await page.evaluate(() => window.mpHost.info());
    const artifactFiles=[];
    for(const name of require('./artifact-files.cjs')) {
      const bytes=await page.evaluate(async name=>{
        const u=new URL('../'+name,location.href);
        const p=decodeURIComponent(u.pathname).replace(/^\/(?=[A-Za-z]:\/)/,'');
        const r=await window.mpHost.readFileBase64(p);return r?.ok ? r.base64 : null;
      },name);
      const source=path.join(ROOT,'MarkPilot-CM6',name);
      artifactFiles.push({file:name,sha256:bytes ? crypto.createHash('sha256').update(Buffer.from(bytes,'base64')).digest('hex') : null,sourceSha256:fs.existsSync(source)?sha256(source):null});
    }
    // A portable wrapper extracts a different running executable. Resolve the
    // archive from the actual editor page, rather than guessing beside wrapper.
    const artifactRoot=path.resolve(require('node:url').fileURLToPath(new URL('../',page.url())));
    const asarPath=o.app?null:artifactRoot,resourcesPath=o.app?path.join(path.dirname(exe),'resources'):path.dirname(asarPath);
    const asarSha256=asarPath&&fs.existsSync(asarPath)?sha256(asarPath):null;
    const runtimeExecutablePath=o.app?exe:path.join(path.dirname(resourcesPath),'MarkPilot.exe');
    const runtimeExecutableSha256=fs.existsSync(runtimeExecutablePath)?sha256(runtimeExecutablePath):null;
    return { browser, page, child, profile, cleanup, metadata: { executable: path.basename(exe), executablePath:exe, exeSha256: hash, runtimeExecutablePath,runtimeExecutableSha256, artifactRoot,app: info, sourceMode: !!o.app, resourcesPath, asarPath, asarSha256, bootMs: Math.round(performance.now() - started), node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, ramGiB: Math.round(os.totalmem()/1073741824), engineBundleSha256: o.app ? sha256(path.join(o.app, 'renderer/cm6/app.js')) : null,artifactFiles } };
  } catch (e) { await cleanup(); throw new Error(e.message + '\n' + launchLog.slice(-1200)); }
}
module.exports = { ROOT, sleep, sha256, acquireSlot, args, launch };
