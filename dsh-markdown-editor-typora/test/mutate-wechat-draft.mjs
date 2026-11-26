// 突变验证：把 lib/wechat-draft.js 的关键判据逐条注掉，用同一条测试命令复跑，必须变红。
//
// 用法：
//   node test/mutate-wechat-draft.mjs           # 顺序跑全部突变（每条 on → 跑测 → off）
//   node test/mutate-wechat-draft.mjs list      # 只列突变
//
// 纪律（与仓库约定一致）：
//   · 突变只短暂存在；每条之后立刻还原并**回读比对 SHA256**，不一致即中止；
//   · 跑完再跑一次完整测试，确认还原后仍是绿的；
//   · 每条突变都写清"注掉后哪条判据该红"，两态都记录。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..');
const target = join(plugin, 'lib', 'wechat-draft.js');
const testFile = join(here, 'wechat-draft.test.mjs');
/* 日志放包根：被测进程退出时会清掉 test/.wx-test-tmp/，父进程就读不到了。 */
const logFile = join(here, '.wx-mutate-run.log');

const MUTATIONS = [
  {
    id: 'scope-required',
    expect: '缺可信 scope 必须拒（MP_WX_SCOPE）',
    from: `    const userKey = String(scope?.ownerId ?? '').trim();
    if (!userKey) return null;`,
    to: `    const userKey = String(scope?.ownerId ?? '').trim() || 'fallback-owner';
    if (!userKey) return null;`,
  },
  {
    id: 'no-path-input',
    expect: '文件路径必须被拒（MP_WX_IMAGE_PATH）',
    from: `    if (!/^data:/i.test(value)) {
      return { ok: false, code: 'MP_WX_IMAGE_PATH', error: '只接受随本次发送带入的图片数据（data:），不接受文件路径' };
    }`,
    to: `    if (!/^data:/i.test(value)) {
      return { ok: true, bytes: Buffer.from('x'), mime: 'image/png', name: 'mutant.png' };
    }`,
  },
  {
    id: 'no-remote-input',
    expect: '网络地址必须被拒（MP_WX_IMAGE_REMOTE）',
    from: `    if (/^(?:https?:)?\\/\\//i.test(value)) {
      return { ok: false, code: 'MP_WX_IMAGE_REMOTE', error: '不接受网络图片地址：请把图片放进正文后重新生成预览' };
    }`,
    to: `    if (/^(?:https?:)?\\/\\//i.test(value)) {
      return { ok: true, bytes: Buffer.from('x'), mime: 'image/png', name: 'mutant.png' };
    }`,
    /* 如实记录：发布路径上服务层（wechat-draft-service.js 的 putCover / preflight）已先拒
       http(s)，本层的同判据属纵深防御 ⇒ 注掉它不会让任何臂变红。这条**没有鉴别力**，
       不当作证据；真正的拦截证据在服务层的既有测试里（.mp-verify/edition-current/wx-tests）。 */
    redundantBy: 'wechat-draft-service.js putCover/preflight 已先拒 http(s)（纵深防御，无鉴别力）',
  },
  {
    id: 'memory-only-kept',
    expect: '无密钥库时必须只用内存（不能落盘）',
    from: `    const credentials = available
      ? credentialsModule.createWechatCredentials({ dir, safeStorage: protect })`,
    to: `    const credentials = false
      ? credentialsModule.createWechatCredentials({ dir, safeStorage: protect })`,
    skipWhen: 'invert-keystore',
  },
  {
    id: 'keystore-used',
    expect: '有密钥库时 secret 必须加密落盘（secretMode=safe-storage）',
    from: `        const probe = typeof protect.isEncryptionAvailable === 'function'
          ? protect.isEncryptionAvailable
          : protect.available;
        return typeof probe === 'function' && probe.call(protect) === true;`,
    to: `        return false;`,
  },
  {
    id: 'doc-switch-before',
    expect: '文档已切换必须在进服务前拦下（MP_WX_DOC_CHANGED，且 0 请求）',
    from: `          if (!isCurrent()) {
            return {
              ok: false, stage: 'owner', code: 'MP_WX_DOC_CHANGED',`,
    to: `          if (false) {
            return {
              ok: false, stage: 'owner', code: 'MP_WX_DOC_CHANGED',`,
  },
  {
    id: 'is-current-passed',
    expect: '服务内部建稿前再复核 isCurrent（上传期间切走要拦）',
    from: `            isCurrent,
          }, owner);`,
    to: `            isCurrent: null,
          }, owner);`,
  },
  {
    id: 'no-cover-size-guard',
    expect: '超大封面必须在解码前拒（MP_WX_COVER_LARGE）',
    from: `          if (dataUrl.length > MAX_DATA_URL_CHARS) {
            return { ok: false, code: 'MP_WX_COVER_LARGE', error: '封面图超过 10MB，请换一张' };
          }`,
    to: `          if (false) {
            return { ok: false, code: 'MP_WX_COVER_LARGE', error: '封面图超过 10MB，请换一张' };
          }`,
  },
  {
    id: 'cover-owner-isolation',
    expect: '封面必须按发起端隔离（别的 tab 用不了，MP_WX_COVER_FOREIGN）',
    from: `    const owner = { id: tabId, docDir: () => null, alive };`,
    to: `    const owner = { id: 'shared', docDir: () => null, alive };`,
  },
  {
    id: 'dispose-blocks',
    expect: 'dispose 后必须全拒（MP_WX_DISPOSED）',
    from: `    if (disposed) return { ok: false, code: 'MP_WX_DISPOSED', error: '公众号功能已卸载，请重开编辑器' };`,
    to: `    if (false) return { ok: false, code: 'MP_WX_DISPOSED', error: '公众号功能已卸载，请重开编辑器' };`,
  },
  {
    id: 'type-check-kept',
    expect: '伪类型必须拒（魔数与声明 MIME 不一致）',
    from: `    if (info.mime !== mime) {
      return { ok: false, code: 'MP_WX_IMAGE_TYPE', error: \`图片内容与声明的类型不一致（声明 \${mime}，实际 \${info.mime}）\` };
    }`,
    to: `    if (false) {
      return { ok: false, code: 'MP_WX_IMAGE_TYPE', error: \`图片内容与声明的类型不一致（声明 \${mime}，实际 \${info.mime}）\` };
    }`,
  },
];

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

function runTests() {
  /* 受限沙箱里 spawn 的 **管道 stdio** 会 EPERM（Node 不能开命名管道）⇒ 一律落文件 fd，
     再读回。这是本仓已记录的既有坑，不是产品行为。 */
  const fd = openSync(logFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [testFile], { cwd: plugin, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const out = readFileSync(logFile, 'utf8');
  const failedMatch = /^ℹ fail (\d+)$/m.exec(out);
  const failed = failedMatch ? Number(failedMatch[1])
    : (/fail (\d+)/.test(out) ? Number(/fail (\d+)/.exec(out)[1]) : (result.status === 0 ? 0 : 1));
  return { status: result.status, out, failed, error: result.error ? result.error.code : null };
}

if (process.argv[2] === 'list') {
  for (const mutation of MUTATIONS) console.log(mutation.id, '—', mutation.expect);
  process.exit(0);
}

const original = readFileSync(target);
const originalSha = sha(original);
const source = original.toString('utf8');
console.log(`baseline sha256=${originalSha.slice(0, 16)} bytes=${original.length}`);

const baseline = runTests();
console.log(`baseline: exit=${baseline.status} fail=${baseline.failed}`);
if (baseline.failed !== 0) {
  console.error('基线不是绿的，拒绝出数');
  process.exit(2);
}

const results = [];
try {
  for (const mutation of MUTATIONS) {
    if (!source.includes(mutation.from)) {
      results.push({ id: mutation.id, verdict: 'ANCHOR-MISS', expect: mutation.expect });
      console.log(`✗ ${mutation.id}: 锚点未命中（该条突变未验证）`);
      continue;
    }
    writeFileSync(target, source.replace(mutation.from, mutation.to), 'utf8');
    const mutated = sha(readFileSync(target));
    if (mutated === originalSha) {
      results.push({ id: mutation.id, verdict: 'NOT-APPLIED', expect: mutation.expect });
      console.log(`✗ ${mutation.id}: 突变没打上`);
      continue;
    }
    const run = runTests();
    results.push({ id: mutation.id, verdict: run.failed > 0 ? 'RED' : 'GREEN-NO-POWER', fail: run.failed, expect: mutation.expect });
    console.log(`${run.failed > 0 ? '✓' : '✗'} ${mutation.id}: fail=${run.failed} — ${mutation.expect}`);
    writeFileSync(target, source, 'utf8');
    const restored = sha(readFileSync(target));
    if (restored !== originalSha) {
      console.error(`还原失败：${mutation.id}（${restored.slice(0, 16)} ≠ ${originalSha.slice(0, 16)}）`);
      process.exit(3);
    }
  }
} finally {
  writeFileSync(target, source, 'utf8');
}

const finalSha = sha(readFileSync(target));
console.log(`restored sha256=${finalSha.slice(0, 16)} ${finalSha === originalSha ? 'OK' : 'MISMATCH'}`);
const again = runTests();
try { rmSync(logFile, { force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`after-restore: exit=${again.status} fail=${again.failed} ${again.failed === 0 ? 'OK' : 'NOT-GREEN'}`);

const powerless = results.filter((r) => r.verdict !== 'RED');
const declaredRedundant = MUTATIONS.filter((m) => m.redundantBy).map((m) => m.id);
const unexplained = powerless.filter((r) => !declaredRedundant.includes(r.id));
console.log(`\n鉴别力：${results.filter((r) => r.verdict === 'RED').length}/${results.length} 条有鉴别力`);
for (const item of powerless) {
  const mutation = MUTATIONS.find((m) => m.id === item.id);
  console.log(`  ${mutation?.redundantBy ? '已知无鉴别力' : '未验证'}：${item.id} (${item.verdict}) — ${item.expect}`);
  if (mutation?.redundantBy) console.log(`      原因：${mutation.redundantBy}`);
}
process.exit(finalSha === originalSha && again.failed === 0 && unexplained.length === 0 ? 0 : 1);
