// test/settings.test.mjs — 设置存储（官方设置页 section 的数据源）
//
// 覆盖：默认值、旧键兼容、新键覆盖、写入后布局三字段同步回旧键、
//       数值钳制、坏存档不抛、文档字段往返。
// 不覆盖：React 组件渲染与设置页视觉（属六步流程第 5 步，实机验证）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');
const LEGACY_KEY = 'dsh.markpilot.layout.v1';
const SETTINGS_KEY = 'dsh.markpilot.settings.v1';

let cached = null;

async function getLayout() {
  if (cached) return cached;
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { captured = def; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, '未捕获到 ModuleLoader 定义');
  const mod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  assert.ok(mod.__test && mod.__test.layout, '__test.layout 未暴露');
  cached = mod.__test.layout;
  return cached;
}


let cachedMod = null;
async function getModule() {
  if (cachedMod) return { mod: cachedMod };
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { captured = def; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  cachedMod = captured.factory((name) => {
    if (name === 'react') return null;
    throw new Error('unexpected require: ' + name);
  });
  return { mod: cachedMod };
}

/** 最小 Storage 替身 */
function makeStorage(init) {
  const map = new Map(init || []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: (k) => (map.has(k) ? map.get(k) : null),
  };
}

test('设置：空存储返回默认值（首次打开默认居中开启）', async () => {
  const L = await getLayout();
  const s = L.readSettings(makeStorage());
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'center');
  assert.equal(s.chatWidth, 420);
  assert.equal(s.docsFolder, '');
  assert.equal(s.docsTemplate, '# {title}\n\n');
  assert.equal(L.layoutEnabled(makeStorage()), true);
});

test('设置：只保存过其他设置或旧键缺字段时仍默认居中开启', async () => {
  const L = await getLayout();
  // 2.0.20 的设置页只要保存过任意一项，就会把整份默认值写进新键。
  const otherOnly = makeStorage([[SETTINGS_KEY, JSON.stringify({ docsFolder: 'D:\\Notes', compactChrome: false })]]);
  const s1 = L.readSettings(otherOnly);
  assert.equal(s1.enabled, true, '只保存其他设置不得关掉默认启用');
  assert.equal(s1.mode, 'center');
  assert.equal(s1.docsFolder, 'D:\\Notes');

  const legacyPartial = makeStorage([[LEGACY_KEY, JSON.stringify({ chatWidth: 500 })]]);
  const s2 = L.readSettings(legacyPartial);
  assert.equal(s2.enabled, true, '旧键缺 enabled 按默认开启');
  assert.equal(s2.mode, 'center');
  assert.equal(s2.chatWidth, 500);
});

test('设置：旧版自动物化的 center+false 按新默认开启并一次性迁移', async () => {
  const L = await getLayout();
  const st = makeStorage([
    [LEGACY_KEY, JSON.stringify({ enabled: false, mode: 'center', chatWidth: 420 })],
    [SETTINGS_KEY, JSON.stringify({ enabled: false, mode: 'center', docsFolder: 'D:\\Keep' })],
  ]);
  const before = L.readSettings(st);
  assert.equal(before.enabled, true, '没有意图标记的 center+false 视为从未选择');
  assert.equal(before.mode, 'center');
  assert.equal(before.docsFolder, 'D:\\Keep', '读取不得丢掉其它设置');
  assert.equal(L.layoutEnabled(st), true);
  assert.equal(L.readLayoutConfig(st).enabled, true, '引擎读取口必须与实际生效判断一致');

  assert.equal(L.migrateLayoutDefaults(st), true);
  const after = L.readSettings(st);
  assert.equal(after.enabled, true);
  assert.equal(JSON.parse(st.raw(SETTINGS_KEY)).enabled, true, '新键应落盘为开启');
  assert.equal(JSON.parse(st.raw(LEGACY_KEY)).enabled, true, '旧键镜像同步为开启');
  assert.equal(after.docsFolder, 'D:\\Keep', '迁移保留其它设置');
  assert.equal(L.migrateLayoutDefaults(st), false, '迁移只跑一次');
});

test('设置：旧键 mode=right + 新键缺 mode 时保留 right，不得迁移成 true', async () => {
  const L = await getLayout();
  const st = makeStorage([
    [LEGACY_KEY, JSON.stringify({ enabled: false, mode: 'right', chatWidth: 500 })],
    [SETTINGS_KEY, JSON.stringify({ enabled: false, docsFolder: 'W' })],
  ]);
  // 迁移前：字段合并后是 false/right，不能按新键缺 mode 推成 center。
  assert.equal(L.readLayoutConfig(st).enabled, false, '迁移前应为 false/right');
  assert.equal(L.readLayoutConfig(st).mode, 'right');
  assert.equal(L.readSettings(st).enabled, false);
  assert.equal(L.readSettings(st).mode, 'right');

  assert.equal(L.migrateLayoutDefaults(st), false, '非 center 布局不得迁移');
  assert.equal(JSON.parse(st.raw(SETTINGS_KEY)).enabled, false, '迁移不得改写新键');
  const after = L.readSettings(st);
  assert.equal(after.enabled, false);
  assert.equal(after.mode, 'right');
  assert.equal(after.chatWidth, 500, '旧键的 chatWidth 仍被继承');
  assert.equal(after.docsFolder, 'W', '新键的文档字段保留');
});

test('设置：带意图标记的显式关闭跨读取保留，且不会被迁移翻回', async () => {
  const L = await getLayout();
  const st = makeStorage([[SETTINGS_KEY, JSON.stringify({ enabled: true, mode: 'center', docsFolder: 'D:\\A' })]]);
  L.writeSettings(st, { enabled: false });
  const raw = JSON.parse(st.raw(SETTINGS_KEY));
  assert.equal(raw.enabled, false);
  assert.equal(raw.enabledExplicit, true, '写开关必须记录意图');

  // 新读取器 = 重新打开应用
  assert.equal(L.readSettings(st).enabled, false);
  assert.equal(L.layoutEnabled(st), false);
  assert.equal(L.migrateLayoutDefaults(st), false, '显式关闭不能被迁移翻回开启');

  // 改其他设置不得冲掉关闭决定
  L.writeSettings(st, { docsFolder: 'D:\\B' });
  assert.equal(L.readSettings(st).enabled, false);
  assert.equal(JSON.parse(st.raw(SETTINGS_KEY)).enabledExplicit, true);

  // 再次显式开启后仍可往返
  L.writeSettings(st, { enabled: true });
  assert.equal(L.readSettings(st).enabled, true);
  assert.equal(L.layoutEnabled(st), true);
});

test('设置：非默认布局不被迁移改写', async () => {
  const L = await getLayout();
  for (const mode of ['right', 'dock', 'focus']) {
    const st = makeStorage([[SETTINGS_KEY, JSON.stringify({ enabled: false, mode })]]);
    assert.equal(L.readSettings(st).enabled, false, mode + ' 是人为布局，保持关闭');
    assert.equal(L.readLayoutConfig(st).enabled, false);
    assert.equal(L.migrateLayoutDefaults(st), false);
    assert.equal(L.readSettings(st).mode, mode);
  }
});

test('设置：layoutEnabled 与新键一致，不再只读旧键', async () => {
  const L = await getLayout();
  const onlyNew = makeStorage([[SETTINGS_KEY, JSON.stringify({ enabled: true, mode: 'center' })]]);
  assert.equal(L.layoutEnabled(onlyNew), true, '只有新键 enabled:true 也必须生效');
  const onlyNewOff = makeStorage([[SETTINGS_KEY, JSON.stringify({ enabled: false, mode: 'center', enabledExplicit: true })]]);
  assert.equal(L.layoutEnabled(onlyNewOff), false);
  assert.equal(L.layoutEnabled(makeStorage()), true, '首次打开默认开启');
});

test('设置：旧布局键被继承（用户已有配置不丢）', async () => {
  const L = await getLayout();
  const st = makeStorage([[LEGACY_KEY, JSON.stringify({ enabled: true, mode: 'center', chatWidth: 500 })]]);
  const s = L.readSettings(st);
  assert.equal(s.enabled, true);
  assert.equal(s.chatWidth, 500);
});

test('设置：新键覆盖旧键', async () => {
  const L = await getLayout();
  const st = makeStorage([
    [LEGACY_KEY, JSON.stringify({ enabled: true, mode: 'center', chatWidth: 500 })],
    [SETTINGS_KEY, JSON.stringify({ enabled: false, mode: 'right', chatWidth: 360, docsFolder: 'D:\\Notes' })],
  ]);
  const s = L.readSettings(st);
  assert.equal(s.enabled, false);
  assert.equal(s.mode, 'right');
  assert.equal(s.chatWidth, 360);
  assert.equal(s.docsFolder, 'D:\\Notes');
});

test('设置：写入后布局三字段同步回旧键（引擎与既有测试读旧键）', async () => {
  const L = await getLayout();
  const st = makeStorage();
  const out = L.writeSettings(st, { enabled: true, chatWidth: 480, docsFolder: 'D:\\Docs' });
  assert.equal(out.enabled, true);
  const legacy = JSON.parse(st.raw(LEGACY_KEY));
  assert.equal(legacy.enabled, true, '旧键必须同步 enabled');
  assert.equal(legacy.chatWidth, 480, '旧键必须同步 chatWidth');
  assert.equal(JSON.parse(st.raw(SETTINGS_KEY)).docsFolder, 'D:\\Docs', '文档字段只在新键');
});

test('设置：对话宽被钳制在 220–900', async () => {
  const L = await getLayout();
  const st = makeStorage();
  assert.equal(L.writeSettings(st, { chatWidth: 100 }).chatWidth, 220);
  assert.equal(L.writeSettings(st, { chatWidth: 99999 }).chatWidth, 900);
  assert.equal(L.writeSettings(st, { chatWidth: 660 }).chatWidth, 660);
});

test('设置：非法 mode 落回 center', async () => {
  const L = await getLayout();
  const st = makeStorage();
  assert.equal(L.writeSettings(st, { mode: 'nowhere' }).mode, 'center');
});

test('设置：坏存档不抛，回默认', async () => {
  const L = await getLayout();
  const st = makeStorage([[SETTINGS_KEY, '{not json']]);
  assert.doesNotThrow(() => L.readSettings(st));
  const s = L.readSettings(st);
  assert.equal(s.enabled, true);
  assert.equal(s.chatWidth, 420);
});

test('设置：文档字段可往返', async () => {
  const L = await getLayout();
  const st = makeStorage();
  L.writeSettings(st, { docsFolder: 'D:\\A', docsTemplate: '## {title}\n' });
  const s = L.readSettings(st);
  assert.equal(s.docsFolder, 'D:\\A');
  assert.equal(s.docsTemplate, '## {title}\n');
});

test('设置：storage 不可用时 read 回默认、write 返回 null', async () => {
  const L = await getLayout();
  assert.equal(L.readSettings(null).chatWidth, 420);
  assert.equal(L.writeSettings(null, { enabled: true }), null);
});


/* ── 文档地址构造（文档中心「新建/最近」都靠它）────────────────── */

test('地址：Windows 原生路径 → dsh-resource 绝对地址', async () => {
  const L = await getLayout();
  assert.equal(
    L.absoluteFileAddress('D:\\Notes\\a b.md'),
    'dsh-resource://file/absolute/D%3A/Notes/a%20b.md',
  );
});

test('地址：能被 __test 的 parseFileAddress 解析回来', async () => {
  const { mod } = await getModule();
  const parse = mod.__test.parseFileAddress;
  assert.equal(typeof parse, 'function', 'parseFileAddress 必须暴露在 __test 上');
  const addr = mod.__test.layout.absoluteFileAddress('D:\\Notes\\章节.md');
  const parsed = parse(addr);
  assert.ok(parsed, '必须能解析回来');
  assert.equal(parsed.scope, 'absolute');
  assert.equal(parsed.path, 'D:/Notes/章节.md');
});

test('地址：空输入返回空串', async () => {
  const L = await getLayout();
  assert.equal(L.absoluteFileAddress(''), '');
  assert.equal(L.absoluteFileAddress(null), '');
});


/* ── 编辑区透明（宿主设置里的开关）──────────────────────────────── */

test('透明：默认开启，可关闭并可往返', async () => {
  const L = await getLayout();
  const st = makeStorage();
  assert.equal(L.readSettings(st).transparent, true, '默认应开启透明');
  L.writeSettings(st, { transparent: false });
  assert.equal(L.readSettings(st).transparent, false);
  L.writeSettings(st, { transparent: true });
  assert.equal(L.readSettings(st).transparent, true);
});

test('透明：非布尔值一律回落为开启', async () => {
  const L = await getLayout();
  const st = makeStorage();
  L.writeSettings(st, { transparent: 'no' });
  assert.equal(L.readSettings(st).transparent, true);
});
