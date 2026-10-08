import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { formatFileOperations, runTypedPipeline } from "../src/pipeline.ts";

const model = (provider, id, overrides = {}) => ({
  provider,
  id,
  contextWindow: 32_768,
  maxTokens: 4_096,
  ...overrides,
});

function usage(seed = 1) {
  return {
    input: seed,
    output: seed + 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: seed * 2 + 1,
    cost: { input: seed, output: seed + 1, cacheRead: 0, cacheWrite: 0, total: seed * 2 + 1 },
    reasoning: 0,
  };
}

function response(text = "stage checkpoint", overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: usage(),
    timestamp: 1,
    ...overrides,
  };
}

function messageEntry(id, message) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function linkedEntries(messages) {
  let parentId = null;
  return messages.map((message, index) => {
    const id = `entry-${index + 1}`;
    const entry = message.type === "context_edit"
      ? { ...message, id, parentId, timestamp: "2026-01-01T00:00:00.000Z" }
      : { ...messageEntry(id, message), parentId };
    parentId = entry.id;
    return entry;
  });
}

function makeEvent(branchEntries, firstKeptEntryId, overrides = {}) {
  const projectedEntries = buildSessionProjection(branchEntries).entries;
  const firstKeptIndex = projectedEntries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
  const previousCompactionIndex = projectedEntries.findIndex(
    (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
  );
  const boundaryStart = previousCompactionIndex >= 0 ? previousCompactionIndex + 1 : 0;
  const isSplitTurn = overrides.preparation?.isSplitTurn ?? false;
  let prefixStart = firstKeptIndex;
  if (isSplitTurn) {
    for (let index = firstKeptIndex; index >= boundaryStart; index--) {
      const projected = projectedEntries[index];
      if (projected.sourceEntry.type === "compaction") continue;
      if (projected.messages.some((message) => ["user", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(message.role))) {
        prefixStart = index;
        break;
      }
    }
  }
  const prepMessages = (start, end) => projectedEntries.slice(start, end)
    .filter((entry) => entry.sourceEntry.type !== "compaction")
    .flatMap((entry) => entry.messages.filter((message) => message.role !== "system"));
  return {
    type: "session_before_compact",
    branchEntries,
    preparation: {
      firstKeptEntryId,
      messagesToSummarize: firstKeptIndex < 0 ? [] : prepMessages(boundaryStart, isSplitTurn ? prefixStart : firstKeptIndex),
      turnPrefixMessages: firstKeptIndex < 0 || !isSplitTurn ? [] : prepMessages(prefixStart, firstKeptIndex),
      isSplitTurn: false,
      tokensBefore: 12_500,
      previousSummary: previousCompactionIndex >= 0 ? projectedEntries[previousCompactionIndex].sourceEntry.summary : undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
      ...overrides.preparation,
    },
    customInstructions: overrides.customInstructions,
    reason: "manual",
    willRetry: false,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function fakeContext({ currentModel = model("chat", "default"), models = [], answer = () => response() } = {}) {
  const catalog = new Map(models.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
  const calls = [];
  const activeSessionId = "active-chat-session";
  const ctx = {
    model: currentModel,
    sessionManager: { getSessionId: () => activeSessionId },
    modelRegistry: {
      find(provider, id) { return catalog.get(`${provider}/${id}`); },
      streamSimple(selectedModel, context, options) {
        calls.push({ model: selectedModel, context, options });
        const currentAnswer = answer(selectedModel, context, options, calls.length - 1);
        return { result: async () => currentAnswer };
      },
    },
  };
  return { ctx, calls };
}

function promptPayload(call) {
  const prompt = call.context.messages[0].content[0].text;
  const marker = "Typed stage payload (JSON data):\n";
  return { prompt, payload: JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) };
}

test("groups typed history, links tool IDs, routes models, shares capsule, preserves Pi boundary, and aggregates usage", async () => {
  const branch = linkedEntries([
    { role: "user", content: "Please inspect this carefully", timestamp: 1 },
    {
      role: "assistant", content: [{ type: "toolCall", id: "call-42", name: "read", arguments: { path: "src/a.ts" } }],
      api: "test", provider: "chat", model: "default", usage: usage(), stopReason: "toolUse", timestamp: 2,
    },
    {
      role: "toolResult", toolCallId: "call-42", toolName: "read", content: [{ type: "text", text: "const answer = 42;" }],
      isError: false, timestamp: 3,
    },
    { role: "user", content: "Split-turn prefix", timestamp: 4 },
    {
      role: "assistant", content: [{ type: "text", text: "retained suffix" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 5,
    },
  ]);
  const firstKeptEntryId = branch[4].id;
  const event = makeEvent(branch, firstKeptEntryId, {
    customInstructions: "Keep the exact API decision",
    preparation: {
      isSplitTurn: true,
      previousSummary: "Earlier work established the repository goal.",
      turnPrefixMessages: [branch[3].message],
      fileOps: { read: new Set(["src/a.ts", "src/read-only.ts"]), written: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]) },
    },
  });
  const fallback = model("summary", "fallback");
  const routedUser = model("summary", "user-v3");
  const routedToolResult = model("summary", "tools-v2");
  const { ctx, calls } = fakeContext({
    currentModel: model("chat", "unchanged-chat"),
    models: [fallback, routedUser, routedToolResult],
    answer: (selectedModel) => response(`checkpoint from ${selectedModel.id}`, { usage: usage(selectedModel.id === "fallback" ? 3 : 1) }),
  });

  const result = await runTypedPipeline(event, ctx, {
    model: "summary/fallback",
    routes: {
      user: { model: "summary/user-v3", prompt: "Focus on user commitments." },
      toolResult: { model: "summary/tools-v2" },
    },
  });

  assert.equal(result.firstKeptEntryId, firstKeptEntryId);
  assert.equal(result.tokensBefore, 12_500);
  assert.match(result.summary, /## User/);
  assert.match(result.summary, /## Tool Calls/);
  assert.match(result.summary, /## Tool Results/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.model.id), ["user-v3", "fallback", "tools-v2"]);
  assert.ok(calls.every((call) => call.options.cacheRetention === "none"));
  assert.ok(calls.every((call) => call.options.signal === event.signal));
  const sessionIds = calls.map((call) => call.options.sessionId);
  assert.ok(sessionIds.every((sessionId) => typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)), "every stage uses a UUIDv7 routing ID");
  assert.equal(new Set(sessionIds).size, calls.length, "every stage receives a fresh routing ID");
  assert.ok(sessionIds.every((sessionId) => sessionId !== ctx.sessionManager.getSessionId()), "no stage reuses the active chat session ID");
  assert.deepEqual(result.usage, {
    input: 5,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 13,
    cost: { input: 5, output: 8, cacheRead: 0, cacheWrite: 0, total: 13 },
    reasoning: 0,
  });

  for (const call of calls) {
    const { prompt, payload } = promptPayload(call);
    assert.match(prompt, /Keep the exact API decision/);
    assert.match(prompt, /Earlier work established the repository goal/);
    assert.match(prompt, /Split-turn prefix/);
    assert.ok(payload.shared.splitPrefix.length > 0);
    assert.equal(payload.shared.taskCapsule.text, "Split-turn prefix");
  }
  const callPayload = promptPayload(calls[1]).payload;
  assert.equal(callPayload.toolInteractions[0].toolCallId, "call-42");
  assert.equal(callPayload.toolInteractions[0].status, "complete");
  assert.equal(callPayload.toolInteractions[0].toolName, "read");
  assert.deepEqual(callPayload.toolInteractions[0].call, { ordinal: callPayload.items[0].ordinal });
  assert.equal(callPayload.toolInteractions[0].results[0].text, "const answer = 42;");
  // A tool result is sent once per request: in items for its own stage, linked by ordinal only.
  const resultCall = promptPayload(calls[2]);
  assert.equal(resultCall.prompt.split("const answer = 42;").length - 1, 1);
  assert.deepEqual(resultCall.payload.toolInteractions[0].results, [{ ordinal: resultCall.payload.items[0].ordinal }]);
  assert.match(resultCall.payload.toolInteractions[0].call.text, /src\/a\.ts/);

  const details = result.details.pipeline;
  assert.deepEqual(details.stages.map(({ provider, modelId }) => [provider, modelId]), [
    ["summary", "user-v3"], ["summary", "fallback"], ["summary", "tools-v2"],
  ]);
  assert.deepEqual(details.toolInteractions, [{ toolCallId: "call-42", status: "complete" }]);
  assert.deepEqual(result.details.readFiles, ["src/read-only.ts"]);
  assert.deepEqual(result.details.modifiedFiles, ["src/a.ts", "src/b.ts"]);
  assert.ok(result.summary.includes("<read-files>\nsrc/read-only.ts\n</read-files>"));
  assert.ok(result.summary.includes("<modified-files>\nsrc/a.ts\nsrc/b.ts\n</modified-files>"));
});

test("gives a toolResult stage the bounded canonical user task and keeps huge split-prefix sharing capped", async () => {
  const goal = `Goal: inspect the cache invalidation path. ${"retain relevant goal detail ".repeat(250)}`;
  const branch = linkedEntries([
    { role: "user", content: goal, timestamp: 1 },
    {
      role: "assistant", content: [{ type: "toolCall", id: "call-goal", name: "read", arguments: { path: "cache.ts" } }],
      api: "test", provider: "chat", model: "default", usage: usage(), stopReason: "toolUse", timestamp: 2,
    },
    {
      role: "toolResult", toolCallId: "call-goal", toolName: "read", content: [{ type: "text", text: "invalidation implementation" }],
      isError: false, timestamp: 3,
    },
    {
      role: "assistant", content: [{ type: "text", text: "retained suffix" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 4,
    },
  ]);
  const event = makeEvent(branch, branch[3].id, { preparation: { isSplitTurn: true } });
  const sharedModel = model("summary", "shared");
  const toolResultModel = model("summary", "tool-result");
  const { ctx, calls } = fakeContext({ models: [sharedModel, toolResultModel] });

  await runTypedPipeline(event, ctx, {
    model: "summary/shared",
    routes: { toolResult: { model: "summary/tool-result" } },
  });

  const toolResultCall = calls.find((call) => call.model.id === "tool-result");
  assert.ok(toolResultCall);
  const { payload } = promptPayload(toolResultCall);
  assert.equal(payload.kind, "toolResult");
  assert.equal(payload.items.length, 1);
  assert.match(payload.shared.taskCapsule.text, /Goal: inspect the cache invalidation path/);
  assert.equal(payload.shared.taskCapsule.entryId, branch[0].id);
  assert.equal(payload.shared.taskCapsule.truncated, true);
  assert.ok(payload.shared.taskCapsule.text.length <= 4_000);
  assert.ok(payload.shared.splitPrefix.length <= 4_000);
  assert.match(payload.shared.splitPrefix, /Shared split-prefix excerpt/);
});

test("uses canonical projected content edits and omissions instead of raw branch messages", async () => {
  const branch = linkedEntries([
    { role: "user", content: "PRIVATE omitted original", timestamp: 1 },
    { role: "user", content: "PRIVATE replaced original", timestamp: 2 },
    {
      role: "assistant", content: [{ type: "text", text: "Visible assistant fact" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 3,
    },
    { type: "context_edit", targetId: "entry-1", replacement: null },
    { type: "context_edit", targetId: "entry-2", replacement: { content: "REPLACED visible user fact" } },
    { role: "user", content: "retained", timestamp: 6 },
  ]);
  const event = makeEvent(branch, branch[5].id);
  assert.deepEqual(event.preparation.messagesToSummarize.map((message) => message.role), ["user", "assistant"]);
  assert.equal(event.preparation.messagesToSummarize[0].content, "REPLACED visible user fact");
  const { ctx, calls } = fakeContext();
  const result = await runTypedPipeline(event, ctx, {
    routes: { user: { reducer: "facts" }, assistant: { reducer: "facts" } },
  }, {
    facts: (input) => input.items.map((item) => item.text).join("\n"),
  });

  assert.equal(calls.length, 0);
  assert.match(result.summary, /Visible assistant fact/);
  assert.match(result.summary, /REPLACED visible user fact/);
  assert.doesNotMatch(result.summary, /PRIVATE omitted original|PRIVATE replaced original/);
  assert.equal(result.firstKeptEntryId, branch[5].id);
});

test("uses canonical visible turn starts for split prefixes after omitted raw user entries", async () => {
  const branch = linkedEntries([
    { role: "user", content: "Older visible request", timestamp: 1 },
    {
      role: "assistant", content: [{ type: "text", text: "Earlier visible progress" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 2,
    },
    { role: "user", content: "PRIVATE omitted split-turn start", timestamp: 3 },
    {
      role: "assistant", content: [{ type: "text", text: "Visible split context" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 4,
    },
    { type: "context_edit", targetId: "entry-3", replacement: null },
    {
      role: "assistant", content: [{ type: "text", text: "retained suffix" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 6,
    },
  ]);
  const event = makeEvent(branch, branch[5].id, { preparation: { isSplitTurn: true } });
  assert.equal(event.preparation.messagesToSummarize.length, 0);
  assert.deepEqual(event.preparation.turnPrefixMessages.map((message) => message.role), ["user", "assistant", "assistant"]);
  const { ctx, calls } = fakeContext();

  const result = await runTypedPipeline(event, ctx, {
    routes: { user: { reducer: "facts" }, assistant: { reducer: "facts" } },
  }, {
    facts: (input) => input.items.map((item) => item.text).join("\\n"),
  });

  assert.equal(calls.length, 0);
  assert.match(result.summary, /Older visible request/);
  assert.match(result.summary, /Visible split context/);
  assert.doesNotMatch(result.summary, /PRIVATE omitted split-turn start/);
});

test("keeps a tool result with an unresolved call ID after the call is context-edited away", async () => {
  const branch = linkedEntries([
    {
      role: "assistant", content: [{ type: "toolCall", id: "call-removed", name: "bash", arguments: { command: "secret" } }],
      api: "test", provider: "chat", model: "default", usage: usage(), stopReason: "toolUse", timestamp: 1,
    },
    {
      role: "toolResult", toolCallId: "call-removed", toolName: "bash", content: [{ type: "text", text: "result remains visible" }],
      isError: false, timestamp: 2,
    },
    { type: "context_edit", targetId: "entry-1", replacement: null },
    { role: "user", content: "retained", timestamp: 4 },
  ]);
  const event = makeEvent(branch, branch[3].id);
  const summaryModel = model("summary", "result-without-call");
  const { ctx, calls } = fakeContext({ models: [summaryModel] });

  const result = await runTypedPipeline(event, ctx, { model: "summary/result-without-call" });
  const { payload } = promptPayload(calls[0]);
  assert.equal(payload.kind, "toolResult");
  assert.equal(payload.items[0].toolCallId, "call-removed");
  assert.equal(payload.items[0].text, "result remains visible");
  assert.equal(payload.toolInteractions[0].status, "result-without-call");
  assert.equal(payload.toolInteractions[0].call, undefined);
  assert.match(result.summary, /## Tool Results/);
});

test("carries compaction file metadata forward across hook-generated summaries", async () => {
  const oldEntry = messageEntry("old", { role: "user", content: "already summarized", timestamp: 1 });
  const keptEntry = { ...messageEntry("kept", { role: "user", content: "still pending", timestamp: 2 }), parentId: oldEntry.id };
  const priorCompaction = {
    type: "compaction", id: "prior-compact", parentId: keptEntry.id, timestamp: "2026-01-01T00:00:01.000Z",
    summary: "previous checkpoint", firstKeptEntryId: keptEntry.id, tokensBefore: 8_000, fromHook: true,
    details: { readFiles: ["old-read.ts", "old-write.ts"], modifiedFiles: ["old-write.ts"] },
  };
  const freshEntry = {
    ...messageEntry("fresh", { role: "user", content: "new material", timestamp: 3 }), parentId: priorCompaction.id,
  };
  const retainedEntry = {
    ...messageEntry("retained", { role: "user", content: "kept tail", timestamp: 4 }), parentId: freshEntry.id,
  };
  const branch = [oldEntry, keptEntry, priorCompaction, freshEntry, retainedEntry];
  const event = makeEvent(branch, retainedEntry.id, {
    preparation: {
      previousSummary: "previous checkpoint",
      messagesToSummarize: [keptEntry.message, freshEntry.message],
      fileOps: { read: new Set(["new-read.ts"]), written: new Set(["new-write.ts"]), edited: new Set() },
    },
  });
  const { ctx, calls } = fakeContext();
  const result = await runTypedPipeline(event, ctx, { routes: { user: { reducer: "facts" } } }, {
    facts: (input) => input.items.map((item) => item.text).join("\n"),
  });

  assert.equal(calls.length, 0);
  assert.deepEqual(result.details.readFiles, ["new-read.ts", "old-read.ts"]);
  assert.deepEqual(result.details.modifiedFiles, ["new-write.ts", "old-write.ts"]);
  assert.ok(result.summary.includes(["<read-files>", "new-read.ts", "old-read.ts", "</read-files>"].join("\n")));
  assert.ok(result.summary.includes(["<modified-files>", "new-write.ts", "old-write.ts", "</modified-files>"].join("\n")));
});

test("can summarize a split-prefix-only span", async () => {
  const branch = linkedEntries([
    { role: "user", content: "oversized prefix", timestamp: 1 },
    {
      role: "assistant", content: [{ type: "text", text: "retained suffix" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 2,
    },
  ]);
  const event = makeEvent(branch, branch[1].id, { preparation: { isSplitTurn: true, turnPrefixMessages: [branch[0].message] } });
  const summaryModel = model("summary", "only-prefix");
  const { ctx, calls } = fakeContext({ models: [summaryModel] });

  const result = await runTypedPipeline(event, ctx, { model: "summary/only-prefix" });
  assert.equal(calls.length, 1);
  const { payload } = promptPayload(calls[0]);
  assert.equal(payload.kind, "user");
  assert.equal(payload.items[0].text, "oversized prefix");
  assert.match(result.summary, /## User/); // the pipeline produces one Pi summary; the provider owns stage wording
});

test("applies an explicitly configured thinking level to reasoning-capable LLM stages and leaves absent levels unchanged", async () => {
  const branch = linkedEntries([
    { role: "user", content: "summarize me", timestamp: 1 },
    {
      role: "assistant", content: [{ type: "text", text: "assistant fact" }], api: "test", provider: "chat",
      model: "default", usage: usage(), stopReason: "stop", timestamp: 2,
    },
    { role: "user", content: "retained", timestamp: 3 },
  ]);
  const event = makeEvent(branch, branch[2].id);
  const reasoningModel = model("summary", "reasoning-stage", { reasoning: true });
  const plainModel = model("summary", "plain-stage");

  const configured = fakeContext({ models: [reasoningModel, plainModel] });
  await runTypedPipeline(event, configured.ctx, {
    model: "summary/plain-stage",
    routes: { user: { model: "summary/reasoning-stage" } },
    thinkingLevel: "high",
  });
  assert.equal(configured.calls.find((call) => call.model.id === "reasoning-stage").options.reasoning, "high");
  assert.equal("reasoning" in configured.calls.find((call) => call.model.id === "plain-stage").options, false);

  const absent = fakeContext({ models: [reasoningModel] });
  await runTypedPipeline(event, absent.ctx, { model: "summary/reasoning-stage" });
  assert.equal(absent.calls.length, 2);
  assert.ok(absent.calls.every((call) => !("reasoning" in call.options)));

  const off = fakeContext({ models: [reasoningModel] });
  await runTypedPipeline(event, off.ctx, { model: "summary/reasoning-stage", thinkingLevel: "off" });
  assert.ok(off.calls.every((call) => !("reasoning" in call.options)));
});

test("fails clearly before any provider request when fixed request overhead exceeds the limit", async () => {
  const branch = linkedEntries([
    { role: "user", content: "x".repeat(600), timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const event = makeEvent(branch, branch[1].id);
  const summaryModel = model("summary", "bounded");
  const { ctx, calls } = fakeContext({ models: [summaryModel] });

  await assert.rejects(
    runTypedPipeline(event, ctx, { model: "summary/bounded", prompt: "p".repeat(600), maxInputChars: 500 }),
    /user LLM request overhead is .* configured\/model limit is 500/,
  );
  assert.equal(calls.length, 0);
});

test("splits an oversized stage into bounded parts with a running checkpoint", async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    role: "user", content: `record-${index} ${"y".repeat(300)}`, timestamp: index + 1,
  }));
  const branch = linkedEntries([...records, { role: "user", content: "retained", timestamp: 99 }]);
  const event = makeEvent(branch, branch[12].id);
  const summaryModel = model("summary", "parts");
  const { ctx, calls } = fakeContext({
    models: [summaryModel],
    answer: (_model, _context, _options, index) => response(`checkpoint after part ${index + 1}`),
  });

  const result = await runTypedPipeline(event, ctx, { model: "summary/parts", maxInputChars: 3_000 });
  assert.ok(calls.length > 1, "the stage is split into several requests");
  const payloads = calls.map((call) => promptPayload(call));
  for (const [index, { prompt, payload }] of payloads.entries()) {
    assert.ok(prompt.length <= 3_000, `part ${index + 1} fits the request limit`);
    assert.deepEqual(payload.part, { number: index + 1, of: calls.length });
    if (index === 0) assert.equal(payload.previousPartCheckpoint, undefined);
    else assert.equal(payload.previousPartCheckpoint, `checkpoint after part ${index}`);
  }
  // Every record is sent exactly once, in order.
  const sent = payloads.flatMap(({ payload }) => payload.items.map((item) => item.text.slice(0, 9)));
  assert.deepEqual(sent, records.map((record) => record.content.slice(0, 9)));
  assert.match(result.summary, new RegExp(`## User\\ncheckpoint after part ${calls.length}`));
  assert.equal(result.details.pipeline.stages[0].parts, calls.length);
  assert.equal(result.usage.totalTokens, calls.length * 3);
});

test("a running checkpoint full of quotes and newlines still fits every later part", async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    role: "user", content: `record-${index} ${"y".repeat(300)}`, timestamp: index + 1,
  }));
  const branch = linkedEntries([...records, { role: "user", content: "retained", timestamp: 99 }]);
  const event = makeEvent(branch, branch[12].id);
  const summaryModel = model("summary", "escaped");
  // JSON doubles every quote and newline, so a raw-length cap would overflow the reservation.
  const { ctx, calls } = fakeContext({ models: [summaryModel], answer: () => response('"\n'.repeat(2_000)) });

  await runTypedPipeline(event, ctx, { model: "summary/escaped", maxInputChars: 3_000, maxOutputChars: 200_000 })
    .catch((error) => assert.match(String(error), /output limit/));
  assert.ok(calls.length > 1);
  for (const call of calls) assert.ok(promptPayload(call).prompt.length <= 3_000, "every part fits its limit");
});

test("bounds a very long file list quickly", () => {
  const many = Array.from({ length: 20_000 }, (_, index) => `src/generated/file-${index}.ts`);
  const started = Date.now();
  const text = formatFileOperations(many, many.slice(0, 5_000), 8_000);
  assert.ok(Date.now() - started < 2_000, "bounding is not quadratic");
  assert.ok(text.length <= 8_000);
  assert.match(text, /\[\d+ more not shown\]/);
});

test("sends a single record larger than the request limit as a marked excerpt", async () => {
  const huge = `HEAD-MARK ${"z".repeat(10_000)} TAIL-MARK`;
  const branch = linkedEntries([
    { role: "user", content: huge, timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const event = makeEvent(branch, branch[1].id);
  const summaryModel = model("summary", "excerpt");
  const { ctx, calls } = fakeContext({ models: [summaryModel] });

  await runTypedPipeline(event, ctx, { model: "summary/excerpt", maxInputChars: 3_000 });
  assert.equal(calls.length, 1);
  const { prompt, payload } = promptPayload(calls[0]);
  assert.ok(prompt.length <= 3_000);
  assert.match(payload.items[0].text, /^HEAD-MARK/);
  assert.match(payload.items[0].text, /TAIL-MARK$/);
  assert.match(payload.items[0].text, /\[User record excerpt; 10020 characters total\]/);
});

test("bounds visible file tags before any provider request and keeps full lists in details", async () => {
  const branch = linkedEntries([
    { role: "user", content: "touch many files", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const many = Array.from({ length: 400 }, (_, index) => `src/generated/file-${String(index).padStart(3, "0")}.ts`);
  const event = makeEvent(branch, branch[1].id, {
    preparation: { fileOps: { read: new Set(), written: new Set(many), edited: new Set() } },
  });
  const summaryModel = model("summary", "files");
  const { ctx } = fakeContext({ models: [summaryModel] });

  const result = await runTypedPipeline(event, ctx, { model: "summary/files", maxOutputChars: 4_000 });
  assert.ok(result.summary.length <= 4_000);
  assert.match(result.summary, /<modified-files>\n[\s\S]*\[\d+ more not shown\]\n<\/modified-files>/);
  assert.equal(result.details.modifiedFiles.length, 400);
});

test("rejects invalid summarizer outcomes and never returns a partial checkpoint", async (t) => {
  const branch = linkedEntries([
    { role: "user", content: "summarize me", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const event = makeEvent(branch, branch[1].id);
  const summaryModel = model("summary", "invalid-response");
  const invalidResponses = [
    ["empty", response("  "), /empty summary/],
    ["length", response("partial", { stopReason: "length" }), /incomplete/],
    ["error", response("", { stopReason: "error" }), /provider error/],
    ["aborted", response("partial", { stopReason: "aborted" }), /was aborted/],
    ["toolUse", response("", { stopReason: "toolUse" }), /attempted to call a tool/],
    ["tool call block", response("", { content: [{ type: "toolCall", id: "x", name: "exec", arguments: {} }] }), /attempted to call a tool/],
  ];
  for (const [name, invalid, error] of invalidResponses) {
    await t.test(name, async () => {
      const { ctx } = fakeContext({ models: [summaryModel], answer: () => invalid });
      await assert.rejects(runTypedPipeline(event, ctx, { model: "summary/invalid-response" }), error);
    });
  }
});

test("rejects overlong stage output and malformed usage before returning a checkpoint", async (t) => {
  const branch = linkedEntries([
    { role: "user", content: "summarize me", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const event = makeEvent(branch, branch[1].id);
  const summaryModel = model("summary", "size-validation");

  await t.test("output characters", async () => {
    const { ctx } = fakeContext({ models: [summaryModel], answer: () => response("x".repeat(500)) });
    await assert.rejects(
      runTypedPipeline(event, ctx, { model: "summary/size-validation", maxOutputChars: 256 }),
      /output limit/,
    );
  });
  await t.test("usage numbers", async () => {
    const malformed = usage();
    malformed.totalTokens = Number.NaN;
    const { ctx } = fakeContext({ models: [summaryModel], answer: () => response("summary", { usage: malformed }) });
    await assert.rejects(runTypedPipeline(event, ctx, { model: "summary/size-validation" }), /invalid totalTokens usage/);
  });
});

test("cancellation after a provider response prevents returning a checkpoint", async () => {
  const branch = linkedEntries([
    { role: "user", content: "summarize me", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const controller = new AbortController();
  const event = makeEvent(branch, branch[1].id, { signal: controller.signal });
  const summaryModel = model("summary", "cancelled");
  const { ctx, calls } = fakeContext({
    models: [summaryModel],
    answer: (_model, _context, _options) => {
      controller.abort(new Error("test cancellation"));
      return response("must not be persisted");
    },
  });

  await assert.rejects(runTypedPipeline(event, ctx, { model: "summary/cancelled" }), /test cancellation/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("rejects invalid boundaries, unknown model routes, and unregistered reducers without fallback", async () => {
  const branch = linkedEntries([
    { role: "user", content: "summarize me", timestamp: 1 },
    { role: "user", content: "retained", timestamp: 2 },
  ]);
  const { ctx, calls } = fakeContext();
  await assert.rejects(runTypedPipeline(makeEvent(branch, "missing-id"), ctx, {}), /firstKeptEntryId/);
  await assert.rejects(
    runTypedPipeline(makeEvent(branch, branch[1].id), ctx, { model: "missing/model" }),
    /configured model 'missing\/model' is unavailable/,
  );
  await assert.rejects(
    runTypedPipeline(makeEvent(branch, branch[1].id), ctx, { routes: { user: { reducer: "not-loaded" } } }),
    /reducer 'not-loaded'.*not registered/,
  );
  // Inherited object members are never reducers, even with a plain-object registry.
  await assert.rejects(
    runTypedPipeline(makeEvent(branch, branch[1].id), ctx, { routes: { user: { reducer: "toString" } } }, {}),
    /reducer 'toString'.*not registered/,
  );
  assert.equal(calls.length, 0);
});
