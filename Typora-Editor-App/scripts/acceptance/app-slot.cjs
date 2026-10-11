/** 应用启动闸（全局互斥）：产品内部 HTTP 服务占固定端口（harness.INTERNAL_PORT），
 *  同一时刻只能有一个实例在跑。多个 agent 并行做验收时，谁启动产品谁先取这把锁。
 *
 *  用法：
 *    node scripts/acceptance/app-slot.cjs -- node scripts/acceptance/run.cjs --app=dev --only=139
 *
 *  语义：
 *    · 锁 = 一个独占创建的锁文件（.perf/app-slot.lock），内容记 owner/pid/时间，便于事后追责；
 *    · 拿不到就按 5 秒一轮重试，并把"在等谁"打出来（长任务按 20 秒一轮看进展）；
 *    · 锁超过 15 分钟视为陈旧（进程崩了没来得及删）→ 直接接管，绝不永久卡死；
 *    · 子进程结束（含异常/Ctrl+C）一定释放锁。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const project = path.resolve(__dirname, '..', '..');
const lockFile = path.join(project, '.perf', 'app-slot.lock');
// 陈旧判据看**锁文件的 mtime**，不看锁里记的创建时间：持有者每 30 秒 touch 一次（心跳），
// 所以"mtime 超过 5 分钟没动"就一定是进程崩了没来得及删。**不要**改用创建时间——整轮全量
// 验收本来就要跑 30–60 分钟，按创建时间判会把正在合法持有锁的全量验收判成陈旧并抢走它，
// 于是两个 Electron 实例同时跑、读数互相污染（本轮实测踩过：74/76 两条场景因此假红）。
const STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const command = sep >= 0 ? argv.slice(sep + 1) : [];
if (!command.length) {
  console.error('用法：node scripts/acceptance/app-slot.cjs -- <命令> [参数...]');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquire() {
  for (let round = 1; ; round++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ owner: process.env.DSH_AGENT_NAME || process.env.USERNAME || 'unknown',
        pid: process.pid, at: new Date().toISOString(), command: command.join(' ') }, null, 2));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* 正在写入或已损坏 */ }
      let idleMs = Infinity;
      try { idleMs = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { idleMs = Infinity; }
      if (idleMs > STALE_MS) {
        console.log(`· 应用启动闸：锁已陈旧 ${Math.round(idleMs / 1000)}s 无心跳（持有者 ${holder ? holder.owner : '?'}）→ 接管`);
        try { fs.unlinkSync(lockFile); } catch { /* 别人先删了 */ }
        continue;
      }
      if (round === 1 || round % 20 === 0) {
        console.log(`· 应用启动闸：等待中（第 ${round} 轮，持有者 ${holder ? holder.owner + ' / ' + holder.command : '未知'}）`);
      }
      // 1s 轮询（原 5s）：多 agent 排队时"跑完立刻起下腿的进程"几乎必然抢过 5s 睡眠中的
      // 等待者（复核轮实测 188 轮≈16 分钟一次没抢到）——同一把锁同一套协议，只收紧重试间隔。
      await sleep(1000);
    }
  }
}

function release() { try { fs.unlinkSync(lockFile); } catch { /* 已被接管 */ } }

(async () => {
  await acquire();
  console.log(`· 应用启动闸：已取得（${command.join(' ')}）`);
  // 心跳：整轮全量验收要跑几十分钟，没有心跳的话"陈旧判据"会把合法持有者判死并抢锁。
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(lockFile, now, now); } catch { /* 已被接管 */ }
  }, HEARTBEAT_MS);
  beat.unref?.();
  const child = spawn(command[0], command.slice(1), { cwd: project, stdio: 'inherit', shell: process.platform === 'win32' });
  const forward = signal => { try { child.kill(signal); } catch { /* 已退出 */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  const done = code => { clearInterval(beat); release(); process.exit(code === null ? 1 : code); };
  child.on('exit', done);
  child.on('error', error => { clearInterval(beat); release(); console.error('启动失败：' + error.message); process.exit(1); });
})();
