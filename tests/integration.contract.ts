import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  appendAssistantMessage,
  appendConversation,
  appendUserMessage,
  createCompactionContractExtension,
  createOfflineCompactionHarness,
  emptyUsage,
  fauxAssistantMessage,
  getCompactionEntries,
  OFFLINE_SUMMARIZER_MODEL_ID,
  OFFLINE_SUMMARIZER_PROVIDER_ID,
} from "./offline-compaction-harness.ts";
import type {
  ExtensionAPI,
  FileEntry,
  InlineExtension,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { getSessionProfile } from "../src/config.ts";
import { registerSimpleCompact } from "../src/index.ts";
import type { NonLlmReducer } from "../src/pipeline.ts";

function simpleCompactExtension(paths: { cwd: string; agentDir: string }, reducers?: Record<string, NonLlmReducer>): InlineExtension {
  return {
    name: "simple-compact-integrated",
    hidden: true,
    factory(pi: ExtensionAPI) {
      registerSimpleCompact(pi, undefined, { agentDir: paths.agentDir, reducers });
    },
  };
}

async function writeProfile(cwd: string, profile: unknown, withSettingsCompanion = true): Promise<void> {
  const piDir = join(cwd, ".pi");
  await mkdir(piDir, { recursive: true });
  if (withSettingsCompanion) await writeFile(join(piDir, "settings.json"), "{}", "utf8");
  await writeFile(join(piDir, "pi-simple-compact.json"), JSON.stringify(profile), "utf8");
}

function appendToolCall(
  harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>,
  id: string,
  name: string,
  path: string,
): string {
  return harness.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path } }],
    api: harness.model.api,
    provider: harness.model.provider,
    model: harness.model.id,
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function appendToolResult(harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>, id: string, name: string): string {
  return harness.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: `offline ${name} result` }],
    isError: false,
    timestamp: Date.now(),
  });
}

function factsRoutes() {
  const reducer = { reducer: "deterministic-facts" };
  return {
    user: reducer,
    assistant: reducer,
    thinking: reducer,
    toolCall: reducer,
    toolResult: reducer,
    custom: reducer,
    bashExecution: reducer,
    branchSummary: reducer,
  };
}

function activeSessionProfile(harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>): string | undefined {
  const entries = harness.sessionManager.getBranch().filter((entry) => entry.type === "custom");
  return getSessionProfile(entries);
}

function visibleText(message: unknown): string {
  if (!message || typeof message !== "object" || !("role" in message)) return "";
  const candidate = message as { role: string; content?: unknown; summary?: string };
  if (candidate.role === "compactionSummary") return candidate.summary ?? "";
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text)
    .join("\n");
}

function registerCompactAndObserver(paths: { cwd: string; agentDir: string }, callbacks: {
  beforeCompact?: (event: SessionBeforeCompactEvent) => void;
  compact?: (event: SessionCompactEvent) => void;
  compactFailed?: (event: SessionCompactFailedEvent) => void;
}, reducers?: Record<string, NonLlmReducer>): InlineExtension[] {
  return [
    {
      name: "compact-observer",
      hidden: true,
      factory(pi: ExtensionAPI) {
        if (callbacks.beforeCompact) pi.on("session_before_compact", (event) => callbacks.beforeCompact!(event));
        if (callbacks.compact) pi.on("session_compact", callbacks.compact);
        if (callbacks.compactFailed) pi.on("session_compact_failed", callbacks.compactFailed);
      },
    },
    simpleCompactExtension(paths, reducers),
  ];
}

test("actual AgentSession.compact routes model-only summaries to a fake alternate provider, retaining chat model and tail", async () => {
  const before: SessionBeforeCompactEvent[] = [];
  const completed: SessionCompactEvent[] = [];
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => registerCompactAndObserver(paths, {
      beforeCompact: (event) => before.push(event),
      compact: (event) => completed.push(event),
    }),
  });

  try {
    await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } });
    const ids = appendConversation(harness, [
      { user: "EARLY_TASK_KEEP_THIS_REQUIREMENT_AND_DECISION_".repeat(3), assistant: "EARLY_PROGRESS_FACT_".repeat(3) },
      { user: "RETAINED_TAIL_USER_FACT_".repeat(3), assistant: "RETAINED_TAIL_ASSISTANT_FACT_".repeat(3) },
    ]);
    harness.summarizerProvider.setResponses([
      () => fauxAssistantMessage("ALTERNATE_PROVIDER_HISTORY_SUMMARY"),
      () => fauxAssistantMessage("ALTERNATE_PROVIDER_SPLIT_PREFIX_SUMMARY"),
    ]);
    const originalModel = harness.session.model;

    const result = await harness.session.compact("keep the manual compact focus");
    const entry = getCompactionEntries(harness).at(-1);
    const rebuilt = harness.sessionManager.buildSessionContext().messages;

    assert.equal(before[0]?.reason, "manual");
    assert.equal(before[0]?.customInstructions, "keep the manual compact focus");
    assert.equal(result.summary.includes("ALTERNATE_PROVIDER_HISTORY_SUMMARY"), true);
    assert.equal(result.summary.includes("ALTERNATE_PROVIDER_SPLIT_PREFIX_SUMMARY"), true);
    assert.match(result.summary, /\[HISTORY\].*before the split turn/);
    assert.match(result.summary, /\[TURN_PREFIX\].*earlier part of the split turn/);
    assert.match(result.summary, /not section order alone/);
    assert.equal(visibleText(rebuilt.find((message) => message.role === "compactionSummary")), result.summary);
    assert.equal(entry?.fromHook, true);
    assert.equal(result.firstKeptEntryId, before[0]?.preparation.firstKeptEntryId);
    assert.equal(harness.session.model, originalModel);
    assert.equal(harness.provider.state.callCount, 0, "native chat provider must not receive summary request");
    assert.equal(harness.summarizerProvider.state.callCount, 2);
    assert.equal(completed.at(-1)?.fromExtension, true);
    assert.ok(rebuilt.some((message) => visibleText(message).includes("RETAINED_TAIL_ASSISTANT_FACT_")));
    assert.ok(harness.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.id === ids[0]));
  } finally {
    await harness.close();
  }
});

test("two consecutive model-only split compactions keep source labels in Pi's visible checkpoint", async () => {
  const before: SessionBeforeCompactEvent[] = [];
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => registerCompactAndObserver(paths, { beforeCompact: (event) => before.push(event) }),
  });
  try {
    await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } });
    appendConversation(harness, [
      { user: "FIRST_OLD_TASK_".repeat(3), assistant: "FIRST_STATUS_PENDING_".repeat(3) },
      { user: "FIRST_RETAINED_REQUEST_".repeat(3), assistant: "FIRST_RETAINED_FACT_".repeat(3) },
    ]);
    harness.summarizerProvider.setResponses([
      () => fauxAssistantMessage("## Goal\nPreserve the task\n\n### In Progress\n- [ ] Run tests"),
      () => fauxAssistantMessage("## Progress So Far\n- Tests passed"),
    ]);
    const first = await harness.session.compact();
    assert.equal(before[0]?.preparation.isSplitTurn, true);
    assert.match(first.summary, /\[HISTORY\]/);
    assert.match(first.summary, /\[TURN_PREFIX\]/);

    appendConversation(harness, [
      { user: "SECOND_OLD_TASK_".repeat(3), assistant: "SECOND_STATUS_PENDING_".repeat(3) },
      { user: "SECOND_RETAINED_REQUEST_".repeat(3), assistant: "SECOND_RETAINED_FACT_".repeat(3) },
    ]);
    harness.summarizerProvider.setResponses([
      () => fauxAssistantMessage("## Goal\nPreserve the new task\n\n### In Progress\n- [ ] Review status"),
      () => fauxAssistantMessage("## Progress So Far\n- Status reviewed"),
    ]);
    const second = await harness.session.compact();
    const entry = getCompactionEntries(harness).at(-1);
    const projected = harness.sessionManager.buildSessionContext().messages;
    assert.equal(before[1]?.preparation.isSplitTurn, true);
    assert.equal(before[1]?.preparation.previousSummary, first.summary);
    assert.equal((second.summary.match(/\[HISTORY\]/g) ?? []).length, 1);
    assert.equal((second.summary.match(/\[TURN_PREFIX\]/g) ?? []).length, 1);
    assert.equal(second.summary.includes("prefer this section"), false);
    assert.equal(entry?.summary, second.summary);
    assert.equal(visibleText(projected.find((message) => message.role === "compactionSummary")), second.summary);
    assert.ok(projected.some((message) => visibleText(message).includes("SECOND_RETAINED_FACT_")));
    assert.equal(harness.provider.state.callCount, 0);
    assert.equal(harness.summarizerProvider.state.callCount, 4);
  } finally {
    await harness.close();
  }
});

test("a compact profile thinkingLevel reaches the fake alternate summarizer while chat thinking stays off", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });

  try {
    await writeProfile(harness.cwd, {
      default: {
        model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}`,
        thinkingLevel: "high",
      },
    });
    appendConversation(harness, [
      { user: "EARLY_COMPACT_ONLY_THINKING_TASK_".repeat(3), assistant: "EARLY_COMPACT_ONLY_FACT_".repeat(3) },
      { user: "RETAINED_TAIL_USER_FACT_".repeat(3), assistant: "RETAINED_TAIL_ASSISTANT_FACT_".repeat(3) },
    ]);
    const observedReasoning: Array<string | undefined> = [];
    harness.summarizerProvider.setResponses([
      (_context, options) => {
        observedReasoning.push(options?.reasoning);
        return fauxAssistantMessage("HIGH_THINKING_HISTORY_SUMMARY");
      },
      (_context, options) => {
        observedReasoning.push(options?.reasoning);
        return fauxAssistantMessage("HIGH_THINKING_SPLIT_PREFIX_SUMMARY");
      },
    ]);
    assert.equal(harness.session.thinkingLevel, "off", "chat session thinking must start off");

    const result = await harness.session.compact();

    assert.match(result.summary, /HIGH_THINKING_HISTORY_SUMMARY/);
    assert.match(result.summary, /HIGH_THINKING_SPLIT_PREFIX_SUMMARY/);
    assert.deepEqual(observedReasoning, ["high", "high"], "history and split-prefix summarizer requests both carry reasoning=high");
    assert.equal(harness.session.thinkingLevel, "off", "compact-only thinking must not alter the chat session thinking level");
    assert.equal(harness.provider.state.callCount, 0, "native chat provider must not receive the compact summary request");
  } finally {
    await harness.close();
  }
});

test("actual AgentSession ignores a lone project compact file and an untrusted project companion", async (t) => {
  await t.test("lone custom file does not opt itself into project trust", async () => {
    const harness = await createOfflineCompactionHarness({
      keepRecentTokens: 8,
      projectTrusted: true,
      createExtensions: (paths) => [simpleCompactExtension(paths)],
    });
    try {
      await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } }, false);
      appendConversation(harness, [
        { user: "LONE_FILE_PROJECT_PROFILE_MUST_BE_IGNORED_".repeat(3), assistant: "old answer" },
        { user: "retained recent input", assistant: "retained recent tail" },
      ]);
      harness.provider.setResponses([() => fauxAssistantMessage("NATIVE_CHAT_MODEL_SUMMARY")]);

      const result = await harness.session.compact();
      assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, false);
      assert.match(result.summary, /NATIVE_CHAT_MODEL_SUMMARY/);
      assert.equal(harness.provider.state.callCount, 1);
      assert.equal(harness.summarizerProvider.state.callCount, 0);
    } finally {
      await harness.close();
    }
  });

  await t.test("project file stays ignored when Pi explicitly marks the project untrusted", async () => {
    const harness = await createOfflineCompactionHarness({
      keepRecentTokens: 8,
      projectTrusted: false,
      createExtensions: (paths) => [simpleCompactExtension(paths)],
    });
    try {
      await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } }, true);
      appendConversation(harness, [
        { user: "UNTRUSTED_PROJECT_PROFILE_MUST_BE_IGNORED_".repeat(3), assistant: "old answer" },
        { user: "retained recent input", assistant: "retained recent tail" },
      ]);
      harness.provider.setResponses([() => fauxAssistantMessage("NATIVE_CHAT_MODEL_SUMMARY")]);

      const result = await harness.session.compact();
      assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, false);
      assert.match(result.summary, /NATIVE_CHAT_MODEL_SUMMARY/);
      assert.equal(harness.provider.state.callCount, 1);
      assert.equal(harness.summarizerProvider.state.callCount, 0);
    } finally {
      await harness.close();
    }
  });
});

test("actual typed pipeline supports repeated AgentSession compactions, previous capsule, files, raw history, and retained tail", async () => {
  const before: SessionBeforeCompactEvent[] = [];
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => registerCompactAndObserver(paths, {
      beforeCompact: (event) => before.push(event),
    }),
  });

  try {
    await writeProfile(harness.cwd, { default: { pipeline: { routes: factsRoutes() } } });
    const oldUserId = appendUserMessage(harness, "EARLY_TYPED_TASK_OBJECTIVE_PRESERVE_FILE_FACTS_".repeat(3));
    appendToolCall(harness, "read-old", "read", "prior-read.ts");
    appendToolResult(harness, "read-old", "read");
    appendAssistantMessage(harness, "The earlier read result informed the next step.");
    appendConversation(harness, [
      { user: "MIDDLE_DECISION_KEEP_API_SHAPE_".repeat(3), assistant: "MIDDLE_DECISION_FACT_".repeat(3) },
      { user: "FIRST_RETAINED_TAIL_REQUEST_".repeat(3), assistant: "FIRST_RETAINED_TAIL_".repeat(3) },
    ]);

    const firstResult = await harness.session.compact();
    const firstEntry = getCompactionEntries(harness).at(-1);
    assert.ok(firstEntry?.fromHook);
    assert.ok(firstEntry?.summary.includes("EARLY_TYPED_TASK_OBJECTIVE"));
    assert.ok(firstEntry?.details && typeof firstEntry.details === "object");
    assert.ok((firstEntry.details as { readFiles?: string[] }).readFiles?.includes("prior-read.ts"));
    assert.ok(firstResult.summary.includes("<read-files>\nprior-read.ts\n</read-files>"));
    assert.equal(harness.provider.state.callCount, 0);
    assert.equal(harness.summarizerProvider.state.callCount, 0);

    appendUserMessage(harness, "SECOND_COMPACTION_NEW_USER_TASK_".repeat(3));
    appendToolCall(harness, "write-new", "write", "later-written.ts");
    appendToolResult(harness, "write-new", "write");
    appendAssistantMessage(harness, "The later write completed.");
    appendConversation(harness, [
      { user: "SECOND_MIDDLE_DECISION_".repeat(3), assistant: "SECOND_MIDDLE_PROGRESS_".repeat(3) },
      { user: "SECOND_RETAINED_TAIL_REQUEST_".repeat(3), assistant: "SECOND_RETAINED_TAIL_".repeat(3) },
    ]);

    const secondResult = await harness.session.compact();
    const secondEntry = getCompactionEntries(harness).at(-1);
    assert.ok(secondEntry?.fromHook);
    assert.ok(before[1]?.preparation.previousSummary?.includes("EARLY_TYPED_TASK_OBJECTIVE"));
    assert.ok(secondEntry?.summary.includes("EARLY_TYPED_TASK_OBJECTIVE"));
    assert.ok(secondEntry?.summary.includes("SECOND_COMPACTION_NEW_USER_TASK"));
    const details = secondEntry?.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
    assert.ok(details?.readFiles?.includes("prior-read.ts"), "prior hook file detail is carried forward");
    assert.ok(details?.modifiedFiles?.includes("later-written.ts"));
    assert.ok(secondResult.summary.includes("<modified-files>\nlater-written.ts\n</modified-files>"));

    const rebuilt = harness.sessionManager.buildSessionContext().messages;
    assert.equal(rebuilt[0]?.role, "compactionSummary");
    assert.ok(rebuilt.some((message) => visibleText(message).includes("SECOND_RETAINED_TAIL_REQUEST")), JSON.stringify(rebuilt.map(visibleText)));
    assert.ok(rebuilt.some((message) => visibleText(message).includes("SECOND_RETAINED_TAIL_")));
    assert.ok(harness.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.id === oldUserId));
  } finally {
    await harness.close();
  }
});

test("a persisted session profile restores into a fresh AgentSession and its reset resumes inheritance", async () => {
  const original = await createOfflineCompactionHarness({
    projectTrusted: true,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });
  let restored: Awaited<ReturnType<typeof createOfflineCompactionHarness>> | undefined;
  try {
    await writeProfile(original.cwd, {
      default: { mode: "native" },
      profiles: { fast: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } },
    });
    const command = original.session.extensionRunner.getCommand("compact-profile");
    assert.ok(command);
    await command.handler("fast", original.session.extensionRunner.createCommandContext());
    const persisted = [original.sessionManager.getHeader()!, ...original.sessionManager.getEntries()] as FileEntry[];
    assert.equal(activeSessionProfile(original), "fast");

    restored = await createOfflineCompactionHarness({
      projectTrusted: true,
      sessionEntries: persisted,
      createExtensions: (paths) => [simpleCompactExtension(paths)],
    });
    await writeProfile(restored.cwd, {
      default: { mode: "native" },
      profiles: { fast: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } },
    });
    appendConversation(restored, [
      { user: "RESTORED_SESSION_OVERRIDE_MUST_SELECT_FAST_".repeat(3), assistant: "restored compact facts" },
      { user: "retained restored tail", assistant: "retained restored response" },
    ]);
    restored.summarizerProvider.setResponses([() => fauxAssistantMessage("RESTORED_FAST_PROFILE_SUMMARY")]);
    const result = await restored.session.compact();

    assert.match(result.summary, /RESTORED_FAST_PROFILE_SUMMARY/);
    assert.equal(restored.summarizerProvider.state.callCount, 1);
    assert.equal(restored.provider.state.callCount, 0);
    assert.equal(activeSessionProfile(restored), "fast");

    const restoredCommand = restored.session.extensionRunner.getCommand("compact-profile");
    assert.ok(restoredCommand);
    await restoredCommand.handler("reset", restored.session.extensionRunner.createCommandContext());
    assert.equal(activeSessionProfile(restored), undefined);
    appendConversation(restored, [
      { user: "RESET_MUST_RESTORE_INHERITED_NATIVE_PROFILE_".repeat(3), assistant: "new native history" },
      { user: "reset retained tail", assistant: "reset retained response" },
    ]);
    restored.provider.setResponses([() => fauxAssistantMessage("INHERITED_NATIVE_SUMMARY_AFTER_RESET")]);
    const afterReset = await restored.session.compact();
    assert.match(afterReset.summary, /INHERITED_NATIVE_SUMMARY_AFTER_RESET/);
    assert.equal(getCompactionEntries(restored).at(-1)?.fromHook, false);
    assert.equal(restored.summarizerProvider.state.callCount, 1);
    assert.equal(restored.provider.state.callCount, 1);
  } finally {
    await original.close();
    await restored?.close();
  }
});

test("typed pipeline failures fail closed through AgentSession and abort writes no partial compaction", async (t) => {
  await t.test("unknown configured reducer returns Pi cancellation instead of native fallback", async () => {
    const failed: SessionCompactFailedEvent[] = [];
    const originalError = console.error;
    const diagnostic: string[] = [];
    console.error = (...parts: unknown[]) => diagnostic.push(parts.join(" "));
    const harness = await createOfflineCompactionHarness({
      keepRecentTokens: 8,
      createExtensions: (paths) => registerCompactAndObserver(paths, {
        compactFailed: (event) => failed.push(event),
      }),
    });
    try {
      await writeProfile(harness.cwd, { default: { pipeline: { routes: { user: { reducer: "unregistered" } } } } });
      appendConversation(harness, [
        { user: "FAIL_CLOSED_PIPELINE_REQUEST_".repeat(3), assistant: "old answer" },
        { user: "retained tail", assistant: "retained response" },
      ]);

      await assert.rejects(harness.session.compact(), /Compaction cancelled/);
      assert.equal(getCompactionEntries(harness).length, 0);
      assert.equal(harness.provider.state.callCount, 0);
      assert.equal(harness.summarizerProvider.state.callCount, 0);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.aborted, true);
      assert.equal(failed[0]?.errorMessage, undefined);
      assert.ok(diagnostic.some((line) => line.includes("Configured compaction could not produce a summary")));
      assert.ok(diagnostic.every((line) => !line.includes("FAIL_CLOSED_PIPELINE_REQUEST")));
    } finally {
      console.error = originalError;
      await harness.close();
    }
  });

  await t.test("cancellation during a trusted reducer returns no checkpoint", async () => {
    let announceStarted!: () => void;
    let releaseReducer!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseReducer = resolve; });
    const failed: SessionCompactFailedEvent[] = [];
    const reducers: Record<string, NonLlmReducer> = {
      blocked: async (_input, _shared, _signal) => {
        announceStarted();
        await blocked;
        return "must not be checkpointed";
      },
    };
    const harness = await createOfflineCompactionHarness({
      keepRecentTokens: 8,
      createExtensions: (paths) => registerCompactAndObserver(paths, {
        compactFailed: (event) => failed.push(event),
      }, reducers),
    });
    try {
      await writeProfile(harness.cwd, {
        default: { pipeline: { routes: { user: { reducer: "blocked" }, assistant: { reducer: "deterministic-facts" } } } },
      });
      appendConversation(harness, [
        { user: "CANCELLED_REDUCER_TASK_".repeat(3), assistant: "old answer" },
        { user: "retained input", assistant: "retained response" },
      ]);
      const operation = harness.session.compact();
      await started;
      harness.session.abortCompaction();
      releaseReducer();

      await assert.rejects(operation, /Compaction cancelled/);
      assert.equal(getCompactionEntries(harness).length, 0);
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.aborted, true);
      assert.equal(failed[0]?.errorMessage, undefined);
      assert.equal(harness.provider.state.callCount, 0);
      assert.equal(harness.summarizerProvider.state.callCount, 0);
    } finally {
      releaseReducer();
      await harness.close();
    }
  });
});
