/** 夹具自证：Windows 上"只读属性"到底拦不拦得住 writeFileSync / rename（不跑 app，纯 Node）
 *  错-14 口径：判据自身的自证先做出来，否则"只读配置"那一臂可能压根没进入只读路径。
 *  用法：node corrupt-config-fixture-selfcheck.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, 'corrupt-config-out');
fs.mkdirSync(OUT, { recursive: true });
const dir = path.join(OUT, '_fixture-selfcheck');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, 'settings.json');
const res = { at: new Date().toISOString(), file: f, steps: [] };
const step = (name, fn) => { try { res.steps.push({ name, ok: true, value: fn() }); } catch (e) { res.steps.push({ name, ok: false, error: String((e && e.code) || '') + ' ' + String(e && e.message).slice(0, 90) }); } };

fs.writeFileSync(f, '{"theme":"dark"}', 'utf8');
step('写入后 mode', () => (fs.statSync(f).mode & 0o777).toString(8));
step('写入后内容', () => fs.readFileSync(f, 'utf8'));
step('chmod 0444', () => { fs.chmodSync(f, 0o444); return (fs.statSync(f).mode & 0o777).toString(8); });
step('只读后 writeFileSync（期望失败）', () => { fs.writeFileSync(f, '{"theme":"light"}', 'utf8'); return 'UNEXPECTED-OK ' + fs.readFileSync(f, 'utf8'); });
step('只读后 appendFileSync（期望失败）', () => { fs.appendFileSync(f, 'x'); return 'UNEXPECTED-OK'; });
step('只读后 rmSync force（期望失败？）', () => { fs.rmSync(f, { force: true }); return fs.existsSync(f) ? 'still-exists' : 'removed'; });
/* recents.save 的路径：临时文件是**新文件**（能建），rename 覆盖只读目标是关键一步 */
const r = path.join(dir, 'recents.json');
fs.writeFileSync(r, '[]', 'utf8'); fs.chmodSync(r, 0o444);
step('只读目标：写 tmp 新文件', () => { const t = r + '.mp-tmp-1'; fs.writeFileSync(t, '[1]', 'utf8'); return { tmpCreated: fs.existsSync(t), bytes: fs.statSync(t).size }; });
step('只读目标：renameSync(tmp→目标)（期望失败）', () => { fs.renameSync(r + '.mp-tmp-1', r); return 'UNEXPECTED-OK ' + fs.readFileSync(r, 'utf8'); });
step('失败后残留的 tmp', () => fs.readdirSync(dir).filter((x) => x.includes('mp-tmp')));
/* 还原 + 清理自证 */
step('chmod 0666 还原', () => { try { fs.chmodSync(f, 0o666); } catch { } try { fs.chmodSync(r, 0o666); } catch { } return true; });
step('清理目录', () => { fs.rmSync(dir, { recursive: true, force: true }); return !fs.existsSync(dir); });
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(OUT, 'fixture-selfcheck.json'), JSON.stringify(res, null, 2), 'utf8');
