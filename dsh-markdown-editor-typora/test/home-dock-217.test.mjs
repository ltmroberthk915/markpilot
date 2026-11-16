// 2.0.17 targeted regression: home dock geometry, visible-composer quote
// routing, and the one-shot “修改此处 → 提交给对话” contract.
//
// These tests are deliberately host-free: the dynamic real-DSH probe lives in
// .mp-verify/composer-home-dock/qa-home-dock.cjs. Here we pin the pure geometry
// and session-boundary decisions plus the source contracts the probe relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, '..', 'lib', 'client.js');
const RENDERER_SELECTION = join(HERE, '..', 'renderer-cm6', 'dsh-selection.js');
const README_FILE = join(HERE, '..', 'README.md');
const PACKAGE_FILE = join(HERE, '..', 'package.json');

async function loadClientFactory() {
  const source = await readFile(CLIENT_FILE, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition; } } },
    console,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'window.__ModuleLoader__.load was not called');
  const mod = captured.factory(() => null);
  assert.ok(mod.__test, 'factory must expose __test helpers');
  return { source, test: mod.__test };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('2.0.17: 首页舞台只落在真实内容区，空间不足时明确失败', async () => {
  const { test: T } = await loadClientFactory();
  const fit = T.layout.fitStageRect({
    contentLeft: 280, contentTop: 40, contentRight: 1456, contentBottom: 900,
    sidebarRight: 280, headerBottom: 40, rightbarLeft: null,
    viewportWidth: 1456, viewportHeight: 900,
    editorWidth: 756, stageLeft: 280,
  });
  assert.equal(fit.ok, true);
  assert.deepEqual(plain(fit), { ok: true, left: 280, top: 40, width: 756, height: 860 });
  // 侧栏/标题栏即使内容区从 0,0 报上来也不能被盖住。
  const clamped = T.layout.fitStageRect({
    contentLeft: 0, contentTop: 0, contentRight: 1456, contentBottom: 900,
    sidebarRight: 280, headerBottom: 40, viewportWidth: 1456, viewportHeight: 900,
    editorWidth: 756, stageLeft: 0,
  });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.left, 280);
  assert.equal(clamped.top, 40);
  // 空间不足必须返回失败；调用方会收起舞台，而不是用 fixed 0,0 盖住界面。
  const tiny = T.layout.fitStageRect({
    contentLeft: 280, contentTop: 40, contentRight: 500, contentBottom: 900,
    sidebarRight: 280, headerBottom: 40, viewportWidth: 500, viewportHeight: 900,
    editorWidth: 180, stageLeft: 280,
  });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.reason, 'stage-no-room');
});

test('2.0.17: 舞台矩形与输入框的重叠判定是几何的、不是 z-index 掩盖', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.layout.rectsOverlap(
    { left: 280, top: 40, right: 1036, bottom: 900 },
    { left: 1036, top: 443, right: 1456, bottom: 557 },
  ), false, '相邻边界不算重叠');
  assert.equal(T.layout.rectsOverlap(
    { left: 280, top: 40, right: 1200, bottom: 900 },
    { left: 1036, top: 443, right: 1456, bottom: 557 },
  ), true, '真正覆盖输入框的区域必须拒绝');
});

test('2.0.17: 引用收件人只认可见当前会话，不用文档历史 owner 兜底', async () => {
  const { test: T } = await loadClientFactory();
  assert.equal(T.selection.quoteRecipient({ currentSessionId: 's-now', selectedSessionId: 's-now' }), 's-now');
  assert.equal(T.selection.quoteRecipient({ currentSessionId: '', selectedSessionId: 's-selected' }), 's-selected');
  // 这是主控指出的串会话边界：新首页没有可见会话时，即使文档历史 owner 是
  // s-old，也绝不能把引用送回 s-old。
  assert.equal(T.selection.quoteRecipient({ currentSessionId: '', selectedSessionId: '', docSessionId: 's-old' }), '');
  assert.equal(T.selection.quoteRecipient({ currentSessionId: 's-now', docSessionId: 's-old' }), 's-now');
});

test('2.0.17: 修改提交目标区分“本次创建”与“用户中途切换”', async () => {
  const { test: T } = await loadClientFactory();
  assert.deepEqual(plain(T.selection.editSubmitTarget({ capturedSessionId: 's1', currentSessionId: 's1' })),
    { ok: true, sessionId: 's1', create: false });
  assert.equal(T.selection.editSubmitTarget({ capturedSessionId: 's1', currentSessionId: 's2' }).ok, false);
  assert.equal(T.selection.editSubmitTarget({ capturedSessionId: 's1', currentSessionId: 's2' }).code, 'SESSION_SWITCHED');
  assert.equal(T.selection.editSubmitTarget({ capturedSessionId: 's1', currentSessionId: '' }).code, 'SESSION_GONE');
  assert.deepEqual(plain(T.selection.editSubmitTarget({ capturedSessionId: '', currentSessionId: '' })),
    { ok: true, sessionId: '', create: true });
  // 弹窗在空首页打开、用户中途手动选了任一已有会话：这不是本次操作创建的
  // 目标，必须拒绝，不能把请求投给用户切换后的会话。
  const switchedByUser = T.selection.editSubmitTarget({ capturedSessionId: '', currentSessionId: 's2' });
  assert.equal(switchedByUser.ok, false);
  assert.equal(switchedByUser.code, 'SESSION_SWITCHED_BY_USER');
});

test('2.0.17: 修改请求仍携带 path/行号/selectionId/意图，且只发送一种载荷', async () => {
  const { test: T } = await loadClientFactory();
  const edit = T.selection.editRequest({
    path: 'C:/notes/synthetic-未命名.md',
    ranges: [{ from: 0, to: 5, text: '第一段正文' }],
    text: '第一段正文',
    docLength: 5,
    lineStart: 3,
    lineEnd: 4,
    selectionId: 'sel-217',
    intent: '压缩成两句话，保留结论',
  });
  assert.equal(edit.ok, true);
  assert.match(edit.text, /C:\/notes\/synthetic-未命名\.md/);
  assert.match(edit.text, /selectionId="sel-217"/);
  assert.match(edit.text, /第 3–4 行/);
  assert.match(edit.text, /压缩成两句话，保留结论/);
  const quote = T.selection.quote({
    path: 'C:/notes/synthetic-未命名.md',
    ranges: [{ from: 0, to: 5, text: '第一段正文' }],
    text: '第一段正文',
    docLength: 5,
    lineStart: 3,
    lineEnd: 4,
  });
  assert.equal(quote.ok, true);
  assert.match(quote.text, /^只读引用：C:\/notes\/synthetic-未命名\.md · 第 3–4 行/);
});

test('2.0.17: 源码契约 —— hero 输入面、异步后复核、直接提交、首页舞台兜底', async () => {
  const { source } = await loadClientFactory();
  assert.match(source, /conversation\.input\.left/, 'hero composer 必须注册第二个输入面抓手');
  assert.match(source, /inputActionsFromUiSession/, '首页要能通过官方 uiSession 读取 inputActions');
  assert.match(source, /bindingSource/, 'uiSession 的会话绑定是官方读取路径');
  assert.match(source, /visibleSession\(\) !== targetSessionId/, '提交前必须再核对可见会话');
  assert.match(source, /currentConversationSessionId\(\) \|\| workspaceContext\(\)\.sessionId\) !== recipient/,
    '引用写入前必须再核对可见会话');
  assert.match(source, /sendViaHostSession\(targetSessionId, marker \+ editPayload\.text, delivery, rpcId\)/, '修改请求走宿主会话直发（带隔离标记）');
  assert.match(source, /prepareCapture\(false\)/, '提交前重新验证文档摘要/选区');
  assert.match(source, /documents\.editPrepare/, '提交前由宿主捕获选区并建立隔离记录');
  assert.match(source, /mp208ExplicitReference\(intent\)/, '显式引用必须在客户端判定');
  assert.match(source, /installLayoutSettingBridge/, '布局开关必须立即生效');
  assert.match(source, /width: 0, height: 0, zIndex: 19/, '舞台兜底必须是零面积');
  assert.doesNotMatch(source, /width: "62vw"/, '不得再用 62vw 盖住界面');
  assert.match(source, /composer-overlap/, '输入框重叠时要有明确回退');
  // 弹窗之后的主路径不得再退回 composer 插入/发送（旧语义）。
  const start = source.indexOf('const dialog = await mp208OpenIntentDialog');
  assert.ok(start > 0);
  const tail = source.slice(start, start + 6000);
  assert.doesNotMatch(tail, /mp208InsertNativeQuote|mp208InsertTextPreservingDraft|submitComposer/,
    '“修改此处”提交后不得再改/发送输入框草稿');
});

test('2.0.17: 帮助/aria/包内介绍同步为“提交给对话”', async () => {
  const { source } = await loadClientFactory();
  assert.match(source, /submit\.textContent = "提交给对话"/);
  assert.match(source, /默认只提交这段选区和这次说明；要沿用当前对话，可写「参考刚才的讨论」。输入框里已有的草稿和附件不会被发送/);
  const renderer = await readFile(RENDERER_SELECTION, 'utf8');
  assert.match(renderer, /提交给当前对话/);
  assert.doesNotMatch(renderer, /放入输入框/);
  const readme = await readFile(README_FILE, 'utf8');
  assert.match(readme, /提交给对话/);
  const pkg = JSON.parse(await readFile(PACKAGE_FILE, 'utf8'));
  assert.equal(pkg.version, '2.0.18');
});
