/** family=path-edge · 用例 e3：**路径形态普查**（超长 / emoji+引号+空格 / junction / UNC / 只读目录）
 *
 *  每个形态一支 runShapeCycle（同源同序列同尺子，只换路径形态）：
 *    ① 空文档 →「另存为…」到该形态目标（走真实写盘路，不受 diskMtime 守卫干扰）
 *    ② 再打一笔 → 自动保存应进该目标
 *    ③ 打开该形态的源文件 → 标题/文件位置/MRU
 *    ④ 再打一笔 → 自动保存应进源文件
 *  隔离：每个 profile 预置 settings.json + recents.json=[]（挡掉 main.js 的 CM6 目录迁移）
 *  用法：node path-edge-3-shapes.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require(path.join(__dirname, 'path-edge-lib.cjs'));

const CASE = 'e3-shapes';
const DIR = path.join(L.ROOT, CASE);
const R = { probe: 'path-edge-3-shapes.cjs', family: 'path-edge', case: CASE, at: new Date().toISOString(), shapes: [] };

/* ACL 解禁兜底：无论脚本怎么退出，都不给机器留下"某个目录写不进去"的状态 */
const ACL_DIRS = [];
process.on('exit', () => { for (const d of ACL_DIRS) { try { L.allowWriteDir(d); } catch { /* 尽力 */ } } });

const sum = (r) => {  const s = r.stages;
  const out = {
    形态: r.label,
    打开命中: r.openHit && r.openHit.equal, 打开耗时ms: r.openMs,
    另存为到该形态: s.saveAsOk, '另存后会话路径==目标': r.saveAsHostMatches, 再打字进目标: s.type2ToNew,
    自动保存进源文件: s.type3ToSource,
    标题_打开后: s.afterOpen && s.afterOpen.title,
    标题_另存后: s.afterSaveAs && s.afterSaveAs.title,
    文件位置_打开后: s.afterOpen && s.afterOpen.fileMenu && s.afterOpen.fileMenu.model && s.afterOpen.fileMenu.model.dir,
    文件位置显示: s.afterOpen && s.afterOpen.fileMenu && s.afterOpen.fileMenu.model && s.afterOpen.fileMenu.model.dirShown,
    提示条_另存后: s.afterSaveAs && s.afterSaveAs.banner && s.afterSaveAs.banner.text,
    MRU_打开后: (s.afterOpen && s.afterOpen.mru && s.afterOpen.mru.files || []).map((f) => f.path),
    docDir: s.afterOpen && s.afterOpen.docDir,
    基线URI: s.afterOpen && s.afterOpen.baseURI,
    errs: r.errs,
  };
  return out;
};

(async () => {
  L.rulerEdge('path-edge-3-shapes.cjs');
  L.freshDir(DIR);
  fs.mkdirSync(DIR, { recursive: true });
  console.log('[尺子] 用例目录 ' + DIR);

  /* ── S1 超长路径（>260）── */
  {
    const seg = (c, n) => c.repeat(n);
    const deep = path.join(DIR, 's1-long', seg('长', 40), seg('a', 40), seg('b', 40), seg('c', 40), seg('d', 40));
    const deep2 = path.join(DIR, 's1-long', seg('另', 40), seg('x', 40), seg('y', 40), seg('z', 40), seg('w', 40));
    fs.mkdirSync(deep, { recursive: true }); fs.mkdirSync(deep2, { recursive: true });
    const src = path.join(deep, '超长 源.md');
    const tgt = path.join(deep2, '超长 目标.md');
    fs.writeFileSync(src, '# 超长 标题\n\n超长 MARK-LONG。\n', 'utf8');
    const r = await L.runShapeCycle({ id: CASE + '-s1-long', label: 'S1 超长路径', shapeOpenDoc: src, shapeSaveAsTarget: tgt, dir: path.join(DIR, 'run-s1') });
    R.shapes.push({ id: 'S1', facts: r.pathFacts, summary: sum(r), raw: r });
    console.log('\n[S1 超长] 源 ' + src.length + ' 字符 / 目标 ' + tgt.length + ' 字符');
    console.log('  ' + JSON.stringify(sum(r), null, 1));
  }

  /* ── S2 emoji + 单引号 + 空格 目录 ── */
  {
    const d1 = path.join(DIR, 's2-emoji', "🚀 emoji '单引' 双 空格  目录");
    const d2 = path.join(DIR, 's2-emoji', '🎯 另一个 emoji 目录');
    fs.mkdirSync(d1, { recursive: true }); fs.mkdirSync(d2, { recursive: true });
    const src = path.join(d1, "源 '文件' 🚀.md");
    const tgt = path.join(d2, "目标 '文件' 🎯.md");
    fs.writeFileSync(src, '# emoji 标题\n\nemoji MARK-EMOJI。\n', 'utf8');
    const r = await L.runShapeCycle({ id: CASE + '-s2-emoji', label: 'S2 emoji+单引号+空格', shapeOpenDoc: src, shapeSaveAsTarget: tgt, dir: path.join(DIR, 'run-s2') });
    R.shapes.push({ id: 'S2', facts: r.pathFacts, summary: sum(r), raw: r });
    console.log('\n[S2 emoji] ' + src);
    console.log('  ' + JSON.stringify(sum(r), null, 1));
  }

  /* ── S3 junction（目录联接；符号链接要管理员，联接不需要）── */
  {
    const base = path.join(DIR, 's3-junction');
    const real = path.join(base, '真实 目录');
    const link = path.join(base, '联接 入口');
    fs.mkdirSync(real, { recursive: true });
    L.mkJunction(link, real);
    const src = path.join(link, '源 经联接.md');
    const tgt = path.join(link, '目标 经联接.md');
    fs.writeFileSync(path.join(real, '源 经联接.md'), '# 联接 标题\n\n联接 MARK-JUNC。\n', 'utf8');
    const r = await L.runShapeCycle({ id: CASE + '-s3-junction', label: 'S3 junction 联接', shapeOpenDoc: src, shapeSaveAsTarget: tgt, dir: path.join(DIR, 'run-s3') });
    R.shapes.push({ id: 'S3', facts: r.pathFacts, junction: { link, real, isReparse: L.isReparsePoint(link), readlink: fs.readlinkSync(link) }, summary: sum(r), raw: r });
    console.log('\n[S3 junction] link=' + link + ' → ' + fs.readlinkSync(link));
    console.log('  ' + JSON.stringify(sum(r), null, 1));
    /* 落盘后判"真身目录里有没有出现文件"（穿透联接的一手证据） */
    R.shapes[R.shapes.length - 1].realDirContents = fs.readdirSync(real);
    console.log('  真身目录内容=' + JSON.stringify(fs.readdirSync(real)));
  }

  /* ── S4 UNC（隔离后重测，拿干净的 MRU/标题读数）── */
  {
    const local = path.join(DIR, 's4-unc');
    const unc = '\\\\localhost\\E$\\MarkPilot\\.mp-verify\\path-edge\\e3-shapes\\s4-unc';
    fs.mkdirSync(local, { recursive: true });
    const src = path.join(unc, 'UNC 源.md');
    const tgt = path.join(unc, 'UNC 目标.md');
    fs.writeFileSync(src, '# UNC 标题\n\nUNC MARK-UNC2。\n', 'utf8');
    const r = await L.runShapeCycle({ id: CASE + '-s4-unc', label: 'S4 UNC', shapeOpenDoc: src, shapeSaveAsTarget: tgt, dir: path.join(DIR, 'run-s4') });
    R.shapes.push({ id: 'S4', facts: r.pathFacts, summary: sum(r), raw: r });
    console.log('\n[S4 UNC] ' + src);
    console.log('  ' + JSON.stringify(sum(r), null, 1));
  }

  /* ── S5 只读目录（ACL 拒绝写入）里另存为 ── */
  {
    const base = path.join(DIR, 's5-rodir');
    const srcDir = path.join(base, '源 目录');
    const roDir = path.join(base, '只读 目标 目录');
    fs.mkdirSync(srcDir, { recursive: true }); fs.mkdirSync(roDir, { recursive: true });
    const src = path.join(srcDir, '源.md');
    const tgt = path.join(roDir, '只读目标.md');
    fs.writeFileSync(src, '# 只读目录 标题\n\nMARK-RODIR。\n', 'utf8');
    const r = await L.runShapeCycle({
      id: CASE + '-s5-rodir', label: 'S5 只读目录里另存为', shapeOpenDoc: src, shapeSaveAsTarget: tgt, dir: path.join(DIR, 'run-s5'),
      preSaveAs: () => {
        ACL_DIRS.push(roDir);
        L.denyWriteDir(roDir);
        const proof = L.proveDirReadOnly(roDir);          // 自证"真写不进去"，判据不许只看 icacls 退出码
        return { dir: roDir, proof };
      },
    });
    L.allowWriteDir(roDir);                                // 立刻解禁，避免影响后续与清理
    R.shapes.push({ id: 'S5', facts: r.pathFacts, dirAcl: { roDir, released: true, proof: r.preSaveAs && r.preSaveAs.proof }, summary: sum(r), raw: r });
    console.log('\n[S5 只读目录] ' + roDir);
    console.log('  自证拒写=' + JSON.stringify(r.preSaveAs && r.preSaveAs.proof));
    console.log('  ' + JSON.stringify(sum(r), null, 1));
  }

  R.verdicts = R.shapes.map((s) => ({ id: s.id, 形态: s.summary.形态, 另存为: s.summary['另存为到该形态'], 打开: s.summary.打开命中, 自动保存: s.summary.自动保存进源文件, 提示条: s.summary.提示条_另存后 }));
  console.log('\n════ 形态总表 ════');
  console.log(JSON.stringify(R.verdicts, null, 1));
  console.log('[pageerror 合计] ' + JSON.stringify(R.shapes.flatMap((s) => s.summary.errs)));
  L.writeReport('path-edge-3-shapes', R);
})().catch((e) => { console.error('✗ 探针异常：' + ((e && e.stack) || e)); process.exit(2); });
