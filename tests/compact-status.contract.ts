import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  appendConversation,
  createOfflineCompactionHarness,
  fauxAssistantMessage,
  getCompactionEntries,
  OFFLINE_MODEL_ID,
  OFFLINE_SUMMARIZER_MODEL_ID,
  OFFLINE_SUMMARIZER_PROVIDER_ID,
} from "./offline-compaction-harness.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerSimpleCompact } from "../src/index.ts";

function simpleCompactExtension(paths: { agentDir: string }): InlineExtension {
  return {
    name: "simple-compact-status-integrated",
    hidden: true,
    factory(pi: ExtensionAPI) {
      registerSimpleCompact(pi, undefined, { agentDir: paths.agentDir });
    },
  };
}

async function writeProfile(cwd: string, profile: unknown): Promise<void> {
  const piDir = join(cwd, ".pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(join(piDir, "settings.json"), "{}", "utf8");
  await writeFile(join(piDir, "pi-simple-compact.json"), JSON.stringify(profile), "utf8");
}

interface UICall {
  method: "setStatus" | "notify";
  args: unknown[];
}

/** Dialog-capable no-op UI that records footer status and notification calls. */
function recordingUI(): { ui: ExtensionUIContext; calls: UICall[] } {
  const calls: UICall[] = [];
  const ui = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (...args: unknown[]) => { calls.push({ method: "notify", args }); },
    onTerminalInput: () => () => undefined,
    setStatus: (...args: unknown[]) => { calls.push({ method: "setStatus", args }); },
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    get theme() { return {} as never; },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  } as unknown as ExtensionUIContext;
  return { ui, calls };
}

async function bindMode(harness: Awaited<ReturnType<typeof createOfflineCompactionHarness>>, mode: ExtensionContext["mode"]) {
  const { ui, calls } = recordingUI();
  await harness.session.bindExtensions({ uiContext: ui, mode });
  return { calls };
}

test("a real configured manual compact shows a TUI status only while running", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });
  try {
    await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } });
    const { calls } = await bindMode(harness, "tui");
    appendConversation(harness, [
      { user: "TUI_STATUS_EARLY_TASK_FACT_".repeat(3), assistant: "TUI_STATUS_EARLY_PROGRESS_FACT_".repeat(3) },
      { user: "retained recent input", assistant: "retained recent tail" },
    ]);
    harness.summarizerProvider.setResponses([
      () => fauxAssistantMessage("CONFIGURED_SUMMARIZER_HISTORY_SUMMARY"),
      () => fauxAssistantMessage("CONFIGURED_SUMMARIZER_SPLIT_PREFIX_SUMMARY"),
    ]);

    const result = await harness.session.compact();

    assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, true);
    assert.ok(result.summary.includes("CONFIGURED_SUMMARIZER_HISTORY_SUMMARY"));
    assert.deepEqual(calls, [
      { method: "setStatus", args: ["pi-simple-compact", `Manual compact (${OFFLINE_SUMMARIZER_MODEL_ID})`] },
      { method: "setStatus", args: ["pi-simple-compact", undefined] },
    ]);
  } finally {
    await harness.close();
  }
});

test("a native zero-config compact never shows an extension status, even in TUI mode", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });
  try {
    const { calls } = await bindMode(harness, "tui");
    appendConversation(harness, [
      { user: "NATIVE_TUI_PASSTHROUGH_FACT_".repeat(3), assistant: "old answer" },
      { user: "retained recent input", assistant: "retained recent tail" },
    ]);
    harness.provider.setResponses([() => fauxAssistantMessage("NATIVE_MODEL_SUMMARY")]);

    const result = await harness.session.compact();

    assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, false);
    assert.match(result.summary, /NATIVE_MODEL_SUMMARY/);
    assert.deepEqual(calls, []);
  } finally {
    await harness.close();
  }
});

test("noninteractive print mode runs the configured compaction without any TUI status", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });
  try {
    await writeProfile(harness.cwd, { default: { model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}` } });
    const { calls } = await bindMode(harness, "print");
    appendConversation(harness, [
      { user: "PRINT_MODE_STATUS_MUST_STAY_SILENT_".repeat(3), assistant: "old answer" },
      { user: "retained recent input", assistant: "retained recent tail" },
    ]);
    harness.summarizerProvider.setResponses([() => fauxAssistantMessage("PRINT_MODE_EXTENSION_SUMMARY")]);

    const result = await harness.session.compact();

    assert.equal(getCompactionEntries(harness).at(-1)?.fromHook, true);
    assert.match(result.summary, /PRINT_MODE_EXTENSION_SUMMARY/);
    assert.deepEqual(calls, []);
  } finally {
    await harness.close();
  }
});

test("a fail-closed configured failure clears the status without a success notice", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [simpleCompactExtension(paths)],
  });
  try {
    await writeProfile(harness.cwd, { default: { prompt: "summarize {{conversation}}" } });
    const { calls } = await bindMode(harness, "tui");
    appendConversation(harness, [
      { user: "FAIL_CLOSED_STATUS_TASK_FACT_".repeat(3), assistant: "old answer" },
      { user: "retained recent input", assistant: "retained recent tail" },
    ]);
    harness.provider.setResponses([() => fauxAssistantMessage("")]);

    await assert.rejects(harness.session.compact(), /Compaction cancelled/);
    assert.equal(getCompactionEntries(harness).length, 0);

    const statusCalls = calls.filter((call) => call.method === "setStatus");
    assert.deepEqual(statusCalls, [
      { method: "setStatus", args: ["pi-simple-compact", `Manual compact (${OFFLINE_MODEL_ID})`] },
      { method: "setStatus", args: ["pi-simple-compact", undefined] },
    ]);
    const notified = calls.filter((call) => call.method === "notify").map((call) => call.args.join(" "));
    assert.equal(notified.length, 1);
    assert.match(notified[0]!, /could not produce a summary/);
    assert.ok(!notified[0]!.includes("FAIL_CLOSED_STATUS_TASK_FACT"), "sanitized notice must not leak transcript text");
    assert.ok(!notified.some((line) => line.includes("complete")), "no success notice may appear");
  } finally {
    await harness.close();
  }
});
