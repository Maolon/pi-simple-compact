import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
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
  usage,
} from "./offline-compaction-harness.ts";
import type {
  ExtensionAPI,
  InlineExtension,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { registerSimpleCompact } from "../src/index.ts";
import type { NonLlmReducer } from "../src/pipeline.ts";

function createSimpleCompactExtension(paths: { cwd: string; agentDir: string }, reducers?: Record<string, NonLlmReducer>) {
  return {
    name: "simple-compact-integration-test",
    hidden: true,
    factory(pi: ExtensionAPI) {
      registerSimpleCompact(pi, undefined, { agentDir: paths.agentDir, reducers });
    },
  } satisfies InlineExtension;
}

async function writeProjectProfile(harness: { cwd: string }, profile: unknown, settingsCompanion = true): Promise<void> {
  const piDir = join(harness.cwd, ".pi");
  await mkdir(piDir, { recursive: true });
  if (settingsCompanion) await writeFile(join(piDir, "settings.json"), "{}", "utf8");
  await writeFile(join(piDir, "pi-simple-compact.json"), JSON.stringify(profile), "utf8");
}

function appendToolCall(harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>, id: string, toolName: string, path: string): string {
  return harness.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: { path } }],
    api: harness.model.api,
    provider: harness.model.provider,
    model: harness.model.id,
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function appendToolResult(harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>, id: string, toolName: string): string {
  return harness.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: `offline ${toolName} result` }],
    isError: false,
    timestamp: Date.now(),
  });
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("role" in message)) return "";
  const candidate = message as { role: string; content?: unknown; summary?: string };
  if (candidate.role === "compactionSummary") return candidate.summary ?? "";
  if (!Array.isArray(candidate.content)) return typeof candidate.content === "string" ? candidate.content : "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text)
    .join("\n");
}

test("returning undefined delegates manual compaction and instructions to native Pi", async () => {
  let before: SessionBeforeCompactEvent | undefined;
  let completed: SessionCompactEvent | undefined;
  let requestSnapshot = "";
  const harness = await createOfflineCompactionHarness({
    extensions: [
      createCompactionContractExtension({
        beforeCompact(event) {
          before = event;
          return undefined;
        },
        compact(event) {
          completed = event;
        },
      }),
    ],
  });

  try {
    appendConversation(harness, [
      {
        user: "EARLY_USER_OBJECTIVE: preserve the release decision",
        assistant: "EARLY_ASSISTANT_DECISION: keep native compaction authoritative",
      },
      {
        user: "TAIL_USER_FACT: retain this recent constraint",
        assistant: "tail answer",
      },
    ]);
    harness.provider.setResponses([
      (context) => {
        requestSnapshot = JSON.stringify(context.messages);
        return fauxAssistantMessage("fake-provider native summary");
      },
    ]);

    const result = await harness.session.compact("Focus on the release constraint");

    assert.equal(before?.reason, "manual");
    assert.equal(before?.customInstructions, "Focus on the release constraint");
    assert.equal(before?.signal.aborted, false);
    assert.match(requestSnapshot, /The messages above are a conversation to summarize/);
    assert.match(requestSnapshot, /Additional focus: Focus on the release constraint/);
    assert.equal(harness.provider.state.callCount, 1, "undefined must let native Pi call the provider path");
    assert.equal(result.summary, "fake-provider native summary");
    assert.equal(completed?.fromExtension, false);
    assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, false);
  } finally {
    await harness.close();
  }
});

test("custom result persists metadata and retained boundary across repeated, split-turn compaction", async () => {
  const beforeEvents: SessionBeforeCompactEvent[] = [];
  const completedEvents: SessionCompactEvent[] = [];
  const durableFirstSummary = "Goal: preserve the release objective. Decision: keep the compatibility gate.";
  const latestTail = "LATEST_ASSISTANT_TAIL_MUST_REMAIN_VISIBLE";
  const harness = await createOfflineCompactionHarness({
    extensions: [
      createCompactionContractExtension({
        beforeCompact(event) {
          beforeEvents.push(event);
          const stage = beforeEvents.length;
          return {
            compaction: {
              summary:
                stage === 1
                  ? durableFirstSummary
                  : `${event.preparation.previousSummary}\nSplit-turn checkpoint: keep the release objective and compatibility gate.`,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              usage: stage === 1 ? usage(13, 5) : usage(8, 3),
              details: { contractFixture: true, stage },
            },
          };
        },
        compact(event) {
          completedEvents.push(event);
        },
      }),
    ],
  });

  try {
    const [oldUserId, , retainedUserId, retainedAssistantId] = appendConversation(harness, [
      {
        user: "EARLY_OBJECTIVE_AND_RELEASE_CONSTRAINTS_MUST_SURVIVE",
        assistant: "EARLY_DECISION_USE_A_COMPATIBILITY_GATE",
      },
      {
        user: "RETAINED_TAIL_USER_FACT_KEEP_THIS_CONSTRAINT",
        assistant: "retained answer.",
      },
    ]);

    const first = await harness.session.compact();
    const firstEntry = getCompactionEntries(harness).at(-1);
    assert.equal(first.firstKeptEntryId, retainedUserId);
    assert.equal(firstEntry?.firstKeptEntryId, retainedUserId);
    assert.equal(firstEntry?.summary, durableFirstSummary);
    assert.equal(firstEntry?.fromHook, true);
    assert.deepEqual(firstEntry?.details, { contractFixture: true, stage: 1 });
    assert.deepEqual(firstEntry?.usage, usage(13, 5));
    assert.equal(completedEvents.at(-1)?.fromExtension, true);

    appendAssistantMessage(harness, "MID_TURN_PREFIX_FACT_KEEP_THE_RELEASE_GATE");
    const latestTailId = appendAssistantMessage(harness, latestTail);
    const second = await harness.session.compact();
    const secondEvent = beforeEvents[1];
    const secondEntry = getCompactionEntries(harness).at(-1);

    assert.ok(secondEvent, "second compaction must reach the public hook");
    assert.equal(secondEvent.preparation.previousSummary, durableFirstSummary);
    assert.equal(secondEvent.preparation.isSplitTurn, true);
    assert.deepEqual(
      secondEvent.preparation.turnPrefixMessages.map((message) => message.role),
      ["user", "assistant", "assistant"],
    );
    assert.equal(secondEvent.preparation.turnPrefixMessages[0]?.role, "user");
    assert.equal(secondEvent.preparation.messagesToSummarize.length, 0);
    assert.equal(second.firstKeptEntryId, latestTailId);
    assert.equal(secondEntry?.firstKeptEntryId, latestTailId);
    assert.equal(secondEntry?.fromHook, true);
    assert.equal(secondEntry?.summary.includes(durableFirstSummary), true);
    assert.deepEqual(secondEntry?.details, { contractFixture: true, stage: 2 });
    assert.deepEqual(secondEntry?.usage, usage(8, 3));
    assert.equal(completedEvents.at(-1)?.fromExtension, true);

    const visibleContext = harness.sessionManager.buildSessionContext().messages;
    assert.equal(visibleContext[0]?.role, "compactionSummary");
    assert.equal(assistantText(visibleContext[0]), secondEntry?.summary);
    assert.ok(visibleContext.some((message) => assistantText(message).includes(latestTail)));
    assert.ok(!visibleContext.some((message) => assistantText(message).includes("EARLY_OBJECTIVE_AND_RELEASE")));
    assert.ok(!visibleContext.some((message) => assistantText(message).includes("MID_TURN_PREFIX_FACT")));
    assert.ok(
      harness.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.id === oldUserId),
      "compaction changes the context projection but leaves raw append-only history intact",
    );
    assert.ok(
      harness.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.id === retainedAssistantId),
      "entries inside the retained raw tail remain in the session tree",
    );
    assert.equal(harness.provider.state.callCount, 0, "custom results must not invoke the summary provider");
  } finally {
    await harness.close();
  }
});

test("an aborted in-flight hook result emits failure and writes no compaction entry", async () => {
  let announceEntered!: () => void;
  let resumeHook!: () => void;
  const entered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    resumeHook = resolve;
  });
  const failedEvents: SessionCompactFailedEvent[] = [];
  let hookSignal: AbortSignal | undefined;
  const harness = await createOfflineCompactionHarness({
    extensions: [
      createCompactionContractExtension({
        async beforeCompact(event) {
          hookSignal = event.signal;
          announceEntered();
          await blocked;
          return {
            compaction: {
              summary: "must not be persisted after abort",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        },
        compactFailed(event) {
          failedEvents.push(event);
        },
      }),
    ],
  });

  try {
    appendConversation(harness, [
      {
        user: "CANCEL_THIS_COMPACTION_REQUEST_WITHOUT_WRITING_A_CHECKPOINT",
        assistant: "A sufficiently long assistant message makes compaction preparable.",
      },
      { user: "recent user boundary facts", assistant: "recent assistant tail." },
    ]);
    const operation = harness.session.compact();
    await entered;
    harness.session.abortCompaction();
    resumeHook();

    await assert.rejects(operation, /Compaction cancelled/);
    assert.equal(hookSignal?.aborted, true);
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0]?.aborted, true);
    assert.equal(failedEvents[0]?.reason, "manual");
    assert.equal(getCompactionEntries(harness).length, 0);
    assert.equal(harness.provider.state.callCount, 0);
  } finally {
    resumeHook();
    await harness.close();
  }
});

test("a native length-truncated summary fails without appending a partial checkpoint", async () => {
  const failedEvents: SessionCompactFailedEvent[] = [];
  const harness = await createOfflineCompactionHarness({
    extensions: [
      createCompactionContractExtension({
        beforeCompact() {
          return undefined;
        },
        compactFailed(event) {
          failedEvents.push(event);
        },
      }),
    ],
    responses: [fauxAssistantMessage("partial summary", { stopReason: "length" })],
  });

  try {
    appendConversation(harness, [
      {
        user: "EARLY_CONTEXT_TO_SUMMARIZE_WITH_A_VALID_NATIVE_RESULT",
        assistant: "Old answer that requires a safe checkpoint.",
      },
      { user: "recent facts must stay", assistant: "recent answer." },
    ]);

    await assert.rejects(harness.session.compact(), /summary is incomplete/);
    assert.equal(harness.provider.state.callCount, 1);
    assert.equal(getCompactionEntries(harness).length, 0);
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0]?.aborted, false);
    assert.equal(failedEvents[0]?.fromExtension, false);
    assert.match(failedEvents[0]?.errorMessage ?? "", /summary is incomplete/);
  } finally {
    await harness.close();
  }
});

test("manual preparation and custom result carry the exact retained boundary into context", async () => {
  let eventSeen: SessionBeforeCompactEvent | undefined;
  const harness = await createOfflineCompactionHarness({
    extensions: [
      createCompactionContractExtension({
        beforeCompact(event) {
          eventSeen = event;
          return {
            compaction: {
              summary: "contract checkpoint with explicit retained boundary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: { retainedBoundary: event.preparation.firstKeptEntryId },
            },
          };
        },
      }),
    ],
  });

  try {
    const [summarizedUserId, summarizedAssistantId, retainedUserId, retainedAssistantId] = appendConversation(harness, [
      { user: "summarize this older user turn", assistant: "summarize its older assistant response" },
      { user: "retained user request remains available", assistant: "retained assistant answer." },
    ]);
    const result = await harness.session.compact();
    const entry = getCompactionEntries(harness).at(-1);
    const projectedIds = harness.sessionManager.buildSessionProjection().entries.map(({ sourceEntry }) => sourceEntry.id);

    assert.equal(eventSeen?.preparation.firstKeptEntryId, retainedUserId);
    assert.equal(result.firstKeptEntryId, retainedUserId);
    assert.equal(entry?.firstKeptEntryId, retainedUserId);
    assert.deepEqual(entry?.details, { retainedBoundary: retainedUserId });
    assert.ok(projectedIds.includes(retainedUserId));
    assert.ok(projectedIds.includes(retainedAssistantId));
    assert.ok(!projectedIds.includes(summarizedUserId));
    assert.ok(!projectedIds.includes(summarizedAssistantId));
    assert.equal(harness.provider.state.callCount, 0);
  } finally {
    await harness.close();
  }
});
