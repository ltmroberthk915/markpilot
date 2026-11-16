// 2.0.18 targeted regression: the restricted-edit payload, the read-only
// quote marker, and the busy-time delivery decision.
//
// The prompt is intentionally small. These tests pin the user-visible
// contract, not a prose style: intent first, one executable call per mode,
// the body exactly once, no translation special case, no outer fence around
// a selection that already contains one, and no cancel/retry in the send path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, "..", "lib", "client.js");
const CORE_FILE = join(HERE, "..", "renderer-cm6", "mp208-core.js");
const INDEX_FILE = join(HERE, "..", "lib", "index.js");
const PACKAGE_FILE = join(HERE, "..", "package.json");

async function loadClientFactory() {
  const source = await readFile(CLIENT_FILE, "utf8");
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
  vm.runInContext(source, sandbox, { filename: "client.js" });
  assert.ok(captured, "window.__ModuleLoader__.load was not called");
  const mod = captured.factory(() => null);
  assert.ok(mod.__test, "factory must expose __test helpers");
  return { source, test: mod.__test };
}

async function loadRendererCore() {
  const source = await readFile(CORE_FILE, "utf8");
  const sandbox = { window: {}, TextEncoder, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "mp208-core.js" });
  assert.ok(sandbox.window.__MP208, "mp208-core.js must publish __MP208");
  return sandbox.window.__MP208;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const FENCE_TEXT = "```js\nconst a = 1;\n```";

function makeInput(overrides) {
  const text = "第一段正文啊";
  return {
    path: "C:/notes/第2章.md",
    ranges: [{ from: 0, to: text.length, text: text }],
    text: text,
    docLength: text.length,
    lineStart: 3,
    lineEnd: 4,
    selectionId: "sel-218",
    intent: "压缩成两句话，保留结论",
    ...overrides,
  };
}

function multiInput(overrides) {
  const first = "第一段正文啊";
  const second = "第二段正文啊";
  return {
    path: "C:/notes/第2章.md",
    ranges: [
      { from: 0, to: first.length, text: first },
      { from: first.length + 2, to: first.length + 2 + second.length, text: second },
    ],
    text: first + "\n\n" + second,
    docLength: first.length + 2 + second.length,
    lineStart: 3,
    lineEnd: 5,
    selectionId: "sel-218-multi",
    intent: "两段都改成短句",
    ...overrides,
  };
}

function longInput(overrides) {
  const body = "LONG-".repeat(3600); // 18,000 chars: over the 16 KiB inline budget
  return {
    path: "C:/notes/long.md",
    ranges: [{ from: 0, to: body.length, text: body }],
    text: body,
    docLength: body.length,
    lineStart: 1,
    lineEnd: 1,
    selectionId: "sel-218-long",
    intent: "把这一段压缩",
    readSelection: true,
    ...overrides,
  };
}

/** Fixed prompt text after removing intent, path, selectionId, placeholder,
 *  line span and the selection body. Whitespace is ignored. */
function fixedChars(payload, input) {
  let value = payload;
  value = value.split(input.intent).join("");
  value = value.split(JSON.stringify(input.path)).join("");
  value = value.split(JSON.stringify(input.selectionId)).join("");
  value = value.split("修改后的完整选区").join("");
  for (const range of input.ranges) value = value.split(range.text).join("");
  value = value.replace(/第 \d+(?:–\d+)? 行/g, "");
  return value.replace(/\s+/g, "").length;
}

test("2.0.18: 短单段 —— 意图首行、一个 editSelection、原文一次、固定文字 <=130", async () => {
  const { test: T } = await loadClientFactory();
  const input = makeInput({});
  const payload = T.selection.editRequest(input);
  assert.equal(payload.ok, true);
  const lines = payload.text.split("\n");
  assert.equal(lines[0], input.intent, "用户修改要求必须是首行");
  assert.equal(lines[1], "选区已读，直接调用 markdown。");
  assert.equal(count(payload.text, 'markdown：action="editSelection"'), 1);
  assert.equal(count(payload.text, 'action="readSelection"'), 0);
  assert.doesNotMatch(payload.text, /不补答上轮|本条明确要求对照时除外|成功即结束/, "隔离已成立，不再靠历史/催促提醒");
  assert.equal(count(payload.text, input.text), 1, "原文只能出现一次");
  assert.match(payload.text, /path="C:\/notes\/第2章\.md"/);
  assert.match(payload.text, /selectionId="sel-218"/);
  assert.match(payload.text, /newString="修改后的完整选区"/);
  assert.doesNotMatch(payload.text, /replacements/);
  assert.doesNotMatch(payload.text, /不要|禁止|只读材料|仅此一次|上下文/, "不再堆叠操作手册");
  const fixed = fixedChars(payload.text, input);
  assert.ok(fixed <= 130, `固定文字 ${fixed} > 130`);
});

test("2.0.18: 短多段 —— 只给 replacements，按段标出原文", async () => {
  const { test: T } = await loadClientFactory();
  const input = multiInput({});
  const payload = T.selection.editRequest(input);
  assert.equal(payload.ok, true);
  assert.equal(count(payload.text, 'markdown：action="editSelection"'), 1);
  assert.match(payload.text, /replacements=\[每段替换后的文本\]（按原文段序，共 2 项）/);
  assert.doesNotMatch(payload.text, /newString/, "多段不得同时给 newString");
  assert.match(payload.text, /\[第1段\]\n第一段正文啊/);
  assert.match(payload.text, /\[第2段\]\n第二段正文啊/);
  assert.equal(count(payload.text, "第一段正文啊"), 1);
  assert.equal(count(payload.text, "第二段正文啊"), 1);
});

test("2.0.18: 原文自带 Markdown 围栏时不外加围栏、不截断", async () => {
  const { test: T } = await loadClientFactory();
  const input = makeInput({
    ranges: [{ from: 0, to: FENCE_TEXT.length, text: FENCE_TEXT }],
    text: FENCE_TEXT,
    docLength: FENCE_TEXT.length,
  });
  const payload = T.selection.editRequest(input);
  assert.equal(payload.ok, true);
  assert.equal(count(payload.text, FENCE_TEXT), 1);
  assert.equal(count(payload.text, "```"), 2, "只能有原文自带的两条围栏");
});

test("2.0.18: 长选区 —— readSelection 一次、再 editSelection 一次，原文不内联", async () => {
  const { test: T } = await loadClientFactory();
  const input = longInput({});
  const payload = T.selection.editRequest(input);
  assert.equal(payload.ok, true);
  assert.equal(count(payload.text, 'action="readSelection"'), 1);
  assert.equal(count(payload.text, 'action="editSelection"'), 1);
  assert.ok(payload.text.indexOf('action="readSelection"') < payload.text.indexOf('action="editSelection"'));
  assert.equal(payload.text.includes(input.text), false, "长选区不要把原文塞进消息");
  assert.match(payload.text, /原文未内联（18000 字符）/);
  assert.equal(count(payload.text, 'markdown：'), 2);
});

test("2.0.18: 长多段 —— 只给 replacements，且不生成逐段大占位", async () => {
  const { test: T } = await loadClientFactory();
  const half = "B".repeat(9000);
  const input = {
    path: "C:/notes/long-multi.md",
    ranges: [
      { from: 0, to: 9000, text: half },
      { from: 9002, to: 18002, text: half },
    ],
    text: half + "\n\n" + half,
    docLength: 18002,
    lineStart: 1,
    lineEnd: 2,
    selectionId: "sel-218-long-multi",
    intent: "两段都压缩",
    readSelection: true,
  };
  const payload = T.selection.editRequest(input);
  assert.equal(payload.ok, true);
  assert.match(payload.text, /replacements=\[每段替换后的文本\]（按原文段序，共 2 项）/);
  assert.doesNotMatch(payload.text, /newString/);
  assert.equal(count(payload.text, "[第1段]"), 0, "长选区不内联，也不生成段标目录");
});

test("2.0.18: 只读引用只留标识+出处+原文，绝不携带写指令", async () => {
  const { test: T } = await loadClientFactory();
  const input = makeInput({});
  const quote = T.selection.quote(input);
  assert.equal(quote.ok, true);
  assert.match(quote.text, /^只读引用：C:\/notes\/第2章\.md · 第 3–4 行\n\n第一段正文啊$/);
  assert.equal(quote.meta.kind, "readonly-quote");
  assert.doesNotMatch(quote.text, /editSelection|selectionId|newString|replacements/);
});

test("2.0.18: 不再做翻译关键词特判；意图原样即可", async () => {
  const { test: T } = await loadClientFactory();
  const input = makeInput({ intent: "译成英文，保留中文" });
  const payload = T.selection.editRequest(input);
  const afterIntent = payload.text.split("\n").slice(1).join("\n");
  assert.doesNotMatch(afterIntent, /翻译|双语|保留中文|固定.*模板/);
  assert.equal(payload.text.split("\n")[0], input.intent);
});

test("2.0.18: 客户端与渲染层载荷逐字一致", async () => {
  const { test: T } = await loadClientFactory();
  const core = await loadRendererCore();
  const cases = [makeInput({}), multiInput({}), longInput({})];
  for (const input of cases) {
    const client = T.selection.editRequest(input);
    const renderer = core.editRequest(input);
    assert.equal(renderer.ok, client.ok);
    assert.equal(renderer.message, client.text, `载荷漂移：${input.intent}`);
  }
});

test("2.0.18: 忙时派发尊重 busyEnter，空闲 queue，绝不 cancel/retry", async () => {
  const { test: T } = await loadClientFactory();
  const plan = T.selection.deliveryPlan;
  assert.equal(plan({ running: false, preferred: "steer" }).mode, "queue");
  assert.equal(plan({ running: true, preferred: "steer" }).mode, "steer");
  assert.equal(plan({ running: true, preferred: "queue" }).mode, "queue");
  assert.equal(plan({ running: true, preferred: "steer", steeringAvailable: false }).mode, "queue");
  assert.equal(plan({ running: true, preferred: "steer" }).cancel, false);
  assert.equal(plan({ running: true, preferred: "steer" }).retry, false);
  assert.equal(T.selection.normalizeBusyEnter("steer"), "steer");
  assert.equal(T.selection.normalizeBusyEnter("anything"), "queue");
});

test("2.0.18: 全局工具说明只在最前面补一句，且限定 UI 已内联原文", async () => {
  const index = await readFile(INDEX_FILE, "utf8");
  assert.match(index, /UI 已内联修改目标原文（消息中带 selectionId）时直接调用 editSelection；不要再 read\/readSelection。/);
  assert.ok(index.indexOf("UI 已内联修改目标原文") < index.indexOf("'读写 Markdown"), "这句要放在 read/edit 说明之前");
});

test("2.0.18: 源码契约 —— 宿主设置、单次发送、双击保障保留", async () => {
  const { source } = await loadClientFactory();
  assert.match(source, /busyEnter/);
  assert.match(source, /configForms/);
  assert.match(source, /uiSession/);
  assert.match(source, /mp208DeliveryFor\(targetSessionId\)/);
  assert.match(source, /sendViaHostSession\(targetSessionId, marker \+ editPayload\.text, delivery, rpcId\)/);
  assert.match(source, /先读取：markdown：action=/);
  assert.match(source, /再修改：markdown：action=/);
  assert.doesNotMatch(source, /只完成本条要求。/, "删除催办提醒");
  assert.match(source, /只读引用：/);
  assert.doesNotMatch(source, /wantsBilingualInsert|双语|翻译|译文/);
  const start = source.indexOf("async function sendViaHostSession");
  const end = source.indexOf("/* ── 浮层编辑器的兜底通道", start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /plan\.mode/);
  assert.doesNotMatch(block, /\.cancel\s*\(/);
  assert.doesNotMatch(block, /retry|resend/i);
  assert.match(source, /submitting = busy === true/);
  assert.match(source, /submit\.disabled = submitting \|\| input\.value\.trim\(\)\.length === 0/);
  const pkg = JSON.parse(await readFile(PACKAGE_FILE, "utf8"));
  assert.equal(pkg.version, "2.0.18");
});
