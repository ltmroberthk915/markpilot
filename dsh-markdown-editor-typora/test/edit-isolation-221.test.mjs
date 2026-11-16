// 2.0.19 targeted regression: the isolated "修改此处" path.
//
// The parent session history must never reach the edit model call. The host
// consumes exactly one marked UI submission in agent/pre-step, runs a
// history-free ctx.llm.stream() request, executes the markdown tool through the
// official ctx.tools pipeline, persists a human-readable instruction/result in
// the parent conversation, and enters the turn with no messages so the parent
// model is not called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { createEditIsolation, EDIT_RPC_PREFIX } from "../lib/edit-isolation.js";
import { extractDiscussionExcerpt } from "../lib/discussion-excerpt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(HERE, "..", "lib", "client.js");
const INDEX_FILE = join(HERE, "..", "lib", "index.js");

const OLD_MARKER = "Cobaltwick-034b66f7";
const REASONING_MARKER = "REASONING-MUST-NOT-LEAK";
const TOOL_MARKER = "TOOL-OUTPUT-MUST-NOT-LEAK";

function userMessage(text, extra = {}) {
  return {
    id: extra.id || "user-" + Math.random().toString(16).slice(2),
    role: "user",
    source: { kind: "user", ...(extra.rpcId ? { rpcId: extra.rpcId } : {}) },
    content: [{ type: "text", text }],
  };
}

function markerMessage(nonce, payload) {
  return {
    id: "marker-" + nonce,
    role: "user",
    source: { kind: "user", rpcId: EDIT_RPC_PREFIX + nonce },
    content: [{ type: "text", text: "[[mp-edit:" + nonce + "]]\n" + payload }],
  };
}

function fakeAgent(messages) {
  const appended = [];
  const session = {
    id: "session-test",
    header: { id: "session-test", cwd: "C:/ws" },
    deriveMessages() {
      const out = messages.slice();
      for (const event of appended) {
        if (event.type === "user/message") out.push(event.data);
        else if (event.type === "assistant/message") out.push(event.data.message);
      }
      return out;
    },
    append(type, data, opts) {
      appended.push({ type, data, opts });
      return { seq: appended.length, type, data };
    },
  };
  return { id: "session-test", options: {}, session, appended };
}

function history() {
  return [
    { role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "PARENT-SYSTEM-PROMPT" }] },
    userMessage("请评审这段性能验收文档，编号 " + OLD_MARKER),
    {
      role: "assistant",
      source: { kind: "model", provider: "p", model: "m" },
      content: [
        { type: "reasoning", text: REASONING_MARKER },
        { type: "text", text: "评审意见：术语与口径按 " + OLD_MARKER + " 处理。" },
      ],
    },
    {
      role: "tool",
      source: { kind: "tool", callId: "tool-1" },
      toolCallId: "tool-1",
      content: [{ type: "text", text: TOOL_MARKER }],
    },
    {
      role: "user",
      source: { kind: "runtime-context", form: "snapshot", sections: [] },
      content: [{ type: "text", text: "<system-reminder>internal</system-reminder>" }],
    },
    userMessage("按前面的约定，术语继续沿用上一轮的写法。"),
    {
      role: "assistant",
      source: { kind: "model", provider: "p", model: "m" },
      content: [{ type: "text", text: "好的，继续按 " + OLD_MARKER + " 的口径。" }],
    },
  ];
}

function streamFrom(steps) {
  let call = 0;
  const calls = [];
  return {
    calls,
    stream(request) {
      calls.push(request);
      const step = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return (async function* () {
        if (request.signal?.aborted) {
          yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED" } } };
          return;
        }
        for (const chunk of step) yield chunk;
      })();
    },
  };
}

function toolCallStep(id, args, text) {
  const chunks = [
    { type: "block-end", index: 0, block: { type: "tool-call", id, name: "markdown", arguments: JSON.stringify(args) } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
  if (typeof text === "string") {
    chunks.unshift({ type: "block-end", index: 1, block: { type: "text", text } });
  }
  return chunks;
}

function fakeDocuments() {
  const calls = { captures: [] };
  return {
    calls,
    async captureSelection(payload) {
      calls.captures.push(payload);
      return { ok: true, value: { selectionId: "sel_test", sessionId: payload.sessionId } };
    },
  };
}

function fakeTools(options = {}) {
  const calls = { resolves: [], executes: [], disposed: 0 };
  const tools = {
    async resolve(context) {
      calls.resolves.push(context);
      return {
        dispose() { calls.disposed += 1; },
        view() { return new Map(); },
      };
    },
    get(name, agent, toolSet) {
      if (options.toolDisabled) return undefined;
      return { name };
    },
    async execute(input) {
      calls.executes.push(input);
      const call = input.calls[0];
      if (options.deny) {
        return { results: [{ callId: call.id, result: { isError: true, content: [{ type: "text", text: "denied by pre-execute" }] } }] };
      }
      if (options.hang) {
        await new Promise((resolve, reject) => {
          if (input.signal.aborted) { reject(new Error("aborted")); return; }
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      const args = JSON.parse(call.arguments || "{}");
      if (args.action === "readSelection") {
        return {
          results: [{
            callId: call.id,
            result: {
              isError: false,
              value: { ok: true, action: "readSelection", selectionId: "sel_test", version: "rev1:live:1:1:sha", ranges: [{ from: 0, to: 4, text: "原文", originFrom: 0, originTo: 4 }] },
              content: [{ type: "text", text: "选区读取：sel_test；1 段；version: rev1:live:1:1:sha\n[第1段]\n原文" }],
            },
          }],
        };
      }
      if (args.action === "editSelection") {
        return {
          results: [{
            callId: call.id,
            result: {
              isError: false,
              value: { ok: true, action: "editSelection", selectionId: "sel_test", version: "rev1:live:1:2:sha", changed: true, saved: false, ranges: [{ from: 0, to: 4 }] },
              content: [{ type: "text", text: "已替换捕获选区：sel_test；1 段；仅进入编辑器缓冲区，未写盘" }],
            },
          }],
        };
      }
      return {
        results: [{
          callId: call.id,
          result: {
            isError: false,
            value: { ok: false, action: args.action, error: { code: "MP_EDIT_TOOL_ACTION", message: "unsupported" } },
            content: [{ type: "text", text: "unsupported" }],
          },
        }],
      };
    },
  };
  return { tools, calls };
}

const PAYLOAD = [
  "把术语改成新写法。",
  "选区已读，直接调用 markdown。",
  'markdown：action="editSelection",path="C:/ws/a.md",selectionId="sel_test",newString="修改后的完整选区"',
  "原文（第 1 行）：",
  "原文",
].join("\n");

function makeIsolation({ llm, messages = history(), toolsOptions } = {}) {
  let sequence = 0;
  const agent = fakeAgent(messages);
  const documents = fakeDocuments();
  const fake = fakeTools(toolsOptions);
  const iso = createEditIsolation({
    ctx: {
      get(name) {
        if (name === "llm") return llm;
        if (name === "tools") return fake.tools;
        return undefined;
      },
      on() { return () => {}; },
    },
    documents,
    uuid: () => "nonce-" + (++sequence),
    log: { warn() {} },
  });
  return { iso, agent, documents, toolCalls: fake.calls };
}

async function armEdit(iso, { intent = "把术语改成新写法。", explicitReference = false, path = "C:/ws/a.md" } = {}) {
  const prepared = await iso.prepare({
    sessionId: "session-test",
    path,
    displayPath: "a.md",
    originRevision: "rev1:live:1:1:sha",
    ranges: [{ from: 0, to: 4, text: "原文" }],
    lineStart: 1,
    lineEnd: 1,
    intent,
    explicitReference,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const nonce = prepared.value.nonce;
  const armed = await iso.arm({ nonce, text: PAYLOAD, meta: { kind: "restricted-edit" } });
  assert.equal(armed.ok, true, JSON.stringify(armed));
  return { nonce, marker: markerMessage(nonce, PAYLOAD), prepared: prepared.value };
}

async function step(iso, agent, marker, { nextMessages, stepNumber = 1, turn = 1, signal } = {}) {
  const claimed = nextMessages || [marker];
  return iso.preStep(
    {
      agent,
      messages: claimed,
      turn,
      step: stepNumber,
      modelSelection: { provider: "p", model: "m", reasoningEffort: "high" },
      signal: signal || new AbortController().signal,
    },
    async () => ({ kind: "enter", messages: nextMessages || [marker] }),
  );
}

function persisted(agent, type) {
  return agent.appended.filter((event) => event.type === type);
}

test("2.0.19: 普通修改只发本次载荷，并把指令/结果持久写回原会话", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" }, "已完成术语替换。")]);
  const { iso, agent, toolCalls } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const decision = await step(iso, agent, marker);
  assert.deepEqual(decision.messages, [], "父模型不得进入本轮");
  assert.equal(llm.calls.length, 1);
  const request = llm.calls[0];
  assert.equal(request.messages.length, 1, "只发送本次修改载荷");
  const wire = JSON.stringify(request.messages);
  assert.doesNotMatch(wire, new RegExp(OLD_MARKER));
  assert.doesNotMatch(wire, /PARENT-SYSTEM-PROMPT/);
  assert.doesNotMatch(wire, new RegExp(REASONING_MARKER));
  assert.doesNotMatch(wire, new RegExp(TOOL_MARKER));
  assert.equal(request.reasoningEffort, "high", "必须保留用户选择的 effort");
  assert.equal(request.tools.length, 1, "只带必要的 markdown 工具");
  assert.equal(request.system, "Apply exactly one edit to the selected Markdown text with the markdown tool.");
  assert.doesNotMatch(request.system, /repeat|never answer|old discussion/i);
  assert.doesNotMatch(JSON.stringify(request.messages), /不补答上轮|本条明确要求对照时除外/);
  assert.equal(toolCalls.executes.length, 1, "必须走官方工具调度");
  assert.ok(toolCalls.executes[0].agent === agent);
  assert.equal(toolCalls.executes[0].log, undefined, "不得伪造父步骤的 tool 事件");
  assert.equal(toolCalls.disposed, 1, "toolSet 必须释放");
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "done");
  assert.equal(status.value.result.changed, true);
  const users = persisted(agent, "user/message");
  const assistants = persisted(agent, "assistant/message");
  assert.equal(users.length, 1);
  assert.equal(assistants.length, 1);
  assert.match(users[0].data.content[0].text, /修改此处：a\.md/);
  assert.match(users[0].data.content[0].text, /把术语改成新写法/);
  assert.doesNotMatch(users[0].data.content[0].text, /\[\[mp-edit:/, "指令必须是人可读的，不是裸 nonce");
  assert.match(users[0].data.source.rpcId, /^mp-edit:/);
  assert.match(assistants[0].data.message.content[0].text, /已完成术语替换/);
  assert.match(assistants[0].data.message.content[0].text, /编辑器缓冲区/);
  assert.equal(assistants[0].data.message.id, "mp-edit-assistant-nonce-1");
  assert.ok(Array.isArray(assistants[0].data.stream) && assistants[0].data.stream.length > 0);
});

test("2.0.19: 显式引用只加相干讨论，排除独立修改轮与思考/工具/内部提醒", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso, { intent: "参考刚才的讨论，把术语改成新写法。", explicitReference: true });
  const decision = await step(iso, agent, marker);
  assert.deepEqual(decision.messages, []);
  assert.equal(llm.calls.length, 1);
  const messages = llm.calls[0].messages;
  assert.equal(messages.length, 2, "引用材料 + 本次载荷");
  const excerpt = messages[0].content[0].text;
  assert.equal((excerpt.match(/【参考材料/g) || []).length, 1, "显式摘录只用一个材料标签");
  assert.match(excerpt, /^【参考材料：刚才的讨论（节选）】/);
  assert.doesNotMatch(excerpt, /不要回答|以本次修改要求为准/, "不再叠提示词");
  assert.match(excerpt, /用户：/);
  assert.match(excerpt, /助手：/);
  assert.match(excerpt, new RegExp(OLD_MARKER), "显式引用应能找到刚才的讨论");
  assert.doesNotMatch(excerpt, new RegExp(REASONING_MARKER), "不得带入思考");
  assert.doesNotMatch(excerpt, new RegExp(TOOL_MARKER), "不得带入工具输出");
  assert.doesNotMatch(excerpt, /system-reminder/, "不得带入内部运行时提醒");
  assert.doesNotMatch(excerpt, /修改此处：/, "不得把本轮独立修改当成讨论");
  assert.doesNotMatch(JSON.stringify(messages), /PARENT-SYSTEM-PROMPT/);
  assert.match(messages[1].content[0].text, /把术语改成新写法/);
  assert.equal(iso.status({ nonce }).value.status, "done");
});

test("2.0.19: 否定“不要参考上文”走普通隔离，不加入讨论", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso, { intent: "不要参考上文，只把术语改成新写法。", explicitReference: false });
  await step(iso, agent, marker);
  assert.equal(llm.calls[0].messages.length, 1);
  assert.doesNotMatch(JSON.stringify(llm.calls[0].messages), new RegExp(OLD_MARKER));
  assert.equal(iso.status({ nonce }).value.status, "done");
});

test("2.0.19: 多步工具 readSelection → editSelection 仍不继承历史且走工具调度", async () => {
  const llm = streamFrom([
    toolCallStep("call-read", { action: "readSelection" }),
    toolCallStep("call-edit", { action: "editSelection", newString: "改后" }),
  ]);
  const { iso, agent, toolCalls } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  await step(iso, agent, marker);
  assert.equal(llm.calls.length, 2);
  assert.equal(toolCalls.executes.length, 2);
  assert.equal(toolCalls.executes[0].calls[0].name, "markdown");
  assert.equal(toolCalls.executes[1].calls[0].name, "markdown");
  const second = llm.calls[1].messages;
  assert.equal(second.length, 3, "载荷 + 助手工具调用 + 工具结果");
  assert.match(second[2].content[0].text, /选区读取/);
  assert.doesNotMatch(JSON.stringify(second), new RegExp(OLD_MARKER));
  assert.equal(iso.status({ nonce }).value.status, "done");
});

test("2.0.19: 同一轮有普通消息时不误吞；只消费标记提交", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { marker } = await armEdit(iso);
  const normal = userMessage("这条普通消息必须留给父模型");
  const decision = await step(iso, agent, marker, { nextMessages: [normal, marker] });
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages[0].content[0].text, "这条普通消息必须留给父模型");
});

test("2.0.19: next() 已过滤的其他输入不得用 otherClaimed 复活", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { marker } = await armEdit(iso);
  const normal = userMessage("这条会被下游 pre-step 过滤");
  // payload.messages still contains the normal message, but next() (the
  // downstream chain) already removed it. The hook must respect that.
  const decision = await iso.preStep(
    {
      agent,
      messages: [normal, marker],
      turn: 1,
      step: 1,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "enter", messages: [marker] }),
  );
  assert.deepEqual(decision.messages, [], "不得复活被 next() 过滤的消息");
});

test("2.0.19: 权限/下游 pre-step 拒绝时不动模型，记录标为 blocked", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent, toolCalls } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const decision = await iso.preStep(
    {
      agent,
      messages: [marker],
      turn: 1,
      step: 1,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "reject" }),
  );
  assert.equal(decision.kind, "reject");
  assert.equal(llm.calls.length, 0);
  assert.equal(toolCalls.executes.length, 0);
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.equal(status.value.error.code, "MP_EDIT_BLOCKED");
});

test("2.0.19: 未知标记不进模型；空轮正常完成", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const unknown = markerMessage("missing-nonce", PAYLOAD);
  const decision = await step(iso, agent, unknown, { nextMessages: [unknown] });
  assert.deepEqual(decision.messages, []);
  assert.equal(llm.calls.length, 0);
});

test("2.0.19: 停止在启动前 → 记录 cancelled，模型不被调用", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  iso.abort({ nonce });
  const decision = await step(iso, agent, marker);
  assert.deepEqual(decision.messages, []);
  assert.equal(llm.calls.length, 0);
  assert.equal(iso.status({ nonce }).value.status, "cancelled");
});

test("2.0.19: 运行中停止 → 模型/工具请求被 abort，结果写明已停止", async () => {
  let started;
  const gate = new Promise((resolve) => { started = resolve; });
  const llm = {
    stream(request) {
      return (async function* () {
        started();
        await new Promise((resolve, reject) => {
          if (request.signal.aborted) { reject(new Error("aborted")); return; }
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield { type: "finish", reason: { kind: "aborted", failure: {} } };
      })();
    },
  };
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const run = step(iso, agent, marker);
  await gate;
  iso.abort({ nonce });
  await run;
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "cancelled");
  const assistants = persisted(agent, "assistant/message");
  assert.equal(assistants.length, 1);
  assert.match(assistants[0].data.message.content[0].text, /已停止修改/);
});

test("2.0.19: 同一会话只允许一个在途修改；prepare 返回 MP_EDIT_BUSY", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso } = makeIsolation({ llm });
  await armEdit(iso);
  const second = await iso.prepare({
    sessionId: "session-test",
    path: "C:/ws/a.md",
    originRevision: "rev1:live:1:1:sha",
    ranges: [{ from: 0, to: 4, text: "原文" }],
    intent: "再改一次",
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "MP_EDIT_BUSY");
});

test("2.0.19: 仅剩 runtimeContext 时不得唤醒父模型", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const context = {
    id: "ctx-1",
    role: "user",
    source: { kind: "runtime-context", form: "snapshot", sections: [] },
    content: [{ type: "text", text: "<system-reminder>fresh runtime context</system-reminder>" }],
  };
  const decision = await iso.preStep(
    {
      agent,
      messages: [marker],
      turn: 1,
      step: 1,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "enter", messages: [marker, context] }),
  );
  assert.deepEqual(decision.messages, [], "孤立 runtimeContext 不得触发主模型");
  assert.equal(llm.calls.length, 1, "只允许隔离修改自己的模型调用");
  assert.equal(iso.status({ nonce }).value.status, "done");
});

test("2.0.19: 有真实用户消息时保留其决策与上下文", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { marker } = await armEdit(iso);
  const normal = userMessage("这条普通消息必须留给父模型");
  const context = {
    id: "ctx-1",
    role: "user",
    source: { kind: "runtime-context", form: "snapshot", sections: [] },
    content: [{ type: "text", text: "<system-reminder>fresh runtime context</system-reminder>" }],
  };
  const decision = await iso.preStep(
    {
      agent,
      messages: [normal, marker],
      turn: 1,
      step: 1,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "enter", messages: [normal, marker, context] }),
  );
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[0].content[0].text, "这条普通消息必须留给父模型");
  assert.equal(decision.messages[1].source.kind, "runtime-context");
});

test("2.0.19: 伪造文本 marker 不消耗；伪造 rpc marker 安全丢弃", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const forged = {
    id: "forged-1",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "[[mp-edit:forged-nonce]]\n这是用户自己输入的文本" }],
  };
  const decision = await step(iso, agent, forged, { nextMessages: [forged] });
  assert.equal(decision.messages.length, 1, "没有持有记录的用户文本不能被当成 marker 吞掉");
  assert.equal(llm.calls.length, 0);

  const forgedRpc = {
    id: "forged-rpc-1",
    role: "user",
    source: { kind: "user", rpcId: "mp-edit:missing-nonce" },
    content: [{ type: "text", text: "[[mp-edit:missing-nonce]]\n伪造" }],
  };
  const dropped = await step(iso, agent, forgedRpc, { nextMessages: [forgedRpc] });
  assert.deepEqual(dropped.messages, [], "带本插件 rpc 前缀但无记录的提交必须 fail-safe 丢弃");
});

test("2.0.19: next() 移除 marker 时不执行修改，记录标为 filtered", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const decision = await iso.preStep(
    {
      agent,
      messages: [marker],
      turn: 1,
      step: 1,
      modelSelection: { provider: "p", model: "m" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.deepEqual(decision.messages, []);
  assert.equal(llm.calls.length, 0);
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.equal(status.value.error.code, "MP_EDIT_FILTERED");
});

test("2.0.19: 显式引用取不到有效讨论时不猜写，保留指令并说明", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm, messages: [userMessage("帮我查一下明天的天气")] });
  const { nonce, marker } = await armEdit(iso, { intent: "参考刚才的讨论，修改性能验收文档的术语", explicitReference: true });
  await step(iso, agent, marker);
  assert.equal(llm.calls.length, 0, "没有讨论材料时不得调用模型猜测");
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.equal(status.value.error.code, "MP_EDIT_REFERENCE_EMPTY");
  const users = persisted(agent, "user/message");
  assert.equal(users.length, 1, "指令必须保留在会话里");
  const assistants = persisted(agent, "assistant/message");
  assert.match(assistants[0].data.message.content[0].text, /没有找到.*最近讨论/);
});

test("2.0.19: 工具动作不合法时失败，不写编辑器，并持久写回失败结果", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "applyEdits", newString: "改后" })]);
  const { iso, agent, toolCalls } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  await step(iso, agent, marker);
  assert.equal(toolCalls.executes.length, 0, "不支持的动作必须在宿主调度前拒绝");
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.equal(status.value.error.code, "MP_EDIT_TOOL_ACTION");
  const assistants = persisted(agent, "assistant/message");
  assert.match(assistants[0].data.message.content[0].text, /修改失败/);
});

test("2.0.19: markdown 工具被禁用时失败，不绕过工具守卫", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent, toolCalls } = makeIsolation({ llm, toolsOptions: { toolDisabled: true } });
  const { nonce, marker } = await armEdit(iso);
  await step(iso, agent, marker);
  assert.equal(toolCalls.executes.length, 0);
  assert.equal(iso.status({ nonce }).value.error.code, "MP_EDIT_TOOL_DISABLED");
});

test("2.0.19: tools/pre-execute 拒绝时不写编辑器", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm, toolsOptions: { deny: true } });
  const { nonce, marker } = await armEdit(iso);
  await step(iso, agent, marker);
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.match(status.value.error.message, /denied by pre-execute/);
});

test("2.0.19: 首步 payload.step=1（agent-loop phase.step+1）正常执行", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const decision = await step(iso, agent, marker, { stepNumber: 1 });
  assert.deepEqual(decision.messages, []);
  assert.equal(llm.calls.length, 1, "真实首步编号是 1，不是 0");
  assert.equal(iso.status({ nonce }).value.status, "done");
});

test("2.0.19: 标记误入运行中轮次的后续 step（step>1）时不泄漏历史", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso, agent } = makeIsolation({ llm });
  const { nonce, marker } = await armEdit(iso);
  const decision = await step(iso, agent, marker, { stepNumber: 2 });
  assert.equal(decision.kind, "reject", "不能空消息进入 step>1 的模型请求");
  assert.equal(llm.calls.length, 0);
  const status = iso.status({ nonce });
  assert.equal(status.value.status, "failed");
  assert.equal(status.value.error.code, "MP_EDIT_ACTIVE_TURN");
});

test("2.0.19: arm 必须绑定本次 selectionId", async () => {
  const llm = streamFrom([toolCallStep("call-1", { action: "editSelection", newString: "改后" })]);
  const { iso } = makeIsolation({ llm });
  const prepared = await iso.prepare({
    sessionId: "session-test",
    path: "C:/ws/a.md",
    originRevision: "rev1:live:1:1:sha",
    ranges: [{ from: 0, to: 4, text: "原文" }],
    intent: "改一下",
  });
  const armed = await iso.arm({ nonce: prepared.value.nonce, text: "没有选区标识" });
  assert.equal(armed.ok, false);
  assert.equal(armed.error.code, "MP_EDIT_INVALID");
});

test("2.0.19: discussion excerpt 只取可见用户/助手文字并有界", () => {
  const excerpt = extractDiscussionExcerpt(history(), "参考刚才的讨论，性能验收文档的术语");
  assert.match(excerpt.text, new RegExp(OLD_MARKER));
  assert.doesNotMatch(excerpt.text, new RegExp(REASONING_MARKER));
  assert.doesNotMatch(excerpt.text, new RegExp(TOOL_MARKER));
  assert.doesNotMatch(excerpt.text, /system-reminder/);
  const huge = [];
  for (let i = 0; i < 40; i += 1) {
    huge.push(userMessage("用户消息 " + i + " ".repeat(400)));
    huge.push({ role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "助手回复 " + i + " ".repeat(400) }] });
  }
  const bounded = extractDiscussionExcerpt(huge, "参考刚才的讨论，用户消息");
  assert.ok(bounded.text.length <= 6000, "必须有界");
  assert.ok(bounded.count <= 8, "消息条数有界");
});

test("2.0.19: discussion excerpt 不连带之前无关任务", () => {
  const messages = [
    userMessage("请评审性能验收文档，编号 " + OLD_MARKER),
    { role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "性能验收意见：" + OLD_MARKER }] },
    userMessage("帮我查一下明天的天气"),
    { role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "明天晴，气温 20 度。" }] },
  ];
  const excerpt = extractDiscussionExcerpt(messages, "参考刚才的讨论，性能验收文档的术语");
  assert.match(excerpt.text, new RegExp(OLD_MARKER));
  assert.doesNotMatch(excerpt.text, /天气/);
  assert.doesNotMatch(excerpt.text, /气温/);
});

test("2.0.19: 显式引用判定（含否定）", async () => {
  const source = await readFile(CLIENT_FILE, "utf8");
  let captured = null;
  const sandbox = { window: { __ModuleLoader__: { load(definition) { captured = definition; } } }, console, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });
  assert.ok(captured);
  const mod = captured.factory(() => null);
  const detect = mod.__test.selection.explicitReference;
  assert.equal(detect("参考刚才的讨论，按之前的约定修改"), true);
  assert.equal(detect("按前面的约定来改"), true);
  assert.equal(detect("沿用上一轮的写法"), true);
  assert.equal(detect("结合上文改一下"), true);
  assert.equal(detect("把这段改成矩阵形式"), false);
  assert.equal(detect("不要参考上文，只按这次要求改"), false);
  assert.equal(detect("不用参考刚才的讨论，直接改"), false);
  assert.equal(detect("忽略前面的约定"), false);
  assert.equal(detect("参考刚才的讨论，但不要照搬"), true);
  // Quoted text after a change-to verb is content, not a reference instruction.
  assert.equal(detect("把这句话改成'参考刚才的讨论'"), false);
  assert.equal(detect("把这句话改成“按前面的约定”"), false);
  assert.equal(detect("把这句话改成「参考刚才的讨论」"), false);
  assert.equal(detect("参考刚才的讨论，把这句话改成'术语'"), true);
  assert.equal(detect("按「前面的约定」改"), true);
});

test("2.0.19: 宿主源码装配了 pre-step 消费端与四个编辑端点", async () => {
  const index = await readFile(INDEX_FILE, "utf8");
  for (const endpoint of ["documents.editPrepare", "documents.editArm", "documents.editStatus", "documents.editAbort"]) {
    assert.match(index, new RegExp(endpoint.replace(".", "\\.")));
  }
  assert.match(index, /createEditIsolation\(/);
  const iso = await readFile(join(HERE, "..", "lib", "edit-isolation.js"), "utf8");
  assert.match(iso, /agent\/pre-step/);
  assert.match(iso, /llm\.stream/);
  assert.match(iso, /tools\.execute/);
  assert.match(iso, /deriveMessages/);
  assert.match(iso, /assistant\/message/);
});
